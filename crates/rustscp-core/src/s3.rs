//! Amazon S3 and S3-compatible object storage driver (AWS Signature Version 4).
//!
//! Paths have the form `/{bucket}/{key}`. When a bucket is fixed (the Bucket
//! field of the login dialog, or a virtual-hosted endpoint such as
//! `my-bucket.s3.eu-west-1.amazonaws.com`), a leading `/{bucket}` segment is
//! stripped again, so the entry paths returned by `list_dir` round-trip.
//!
//! Every request checks the HTTP status. Non-2xx responses become errors that
//! carry the S3 `Code` and `Message`; an error body is never returned as file
//! content and a rejected upload never reports success.

use crate::types::{
    CoreError, CoreResult, FileEntry, FileSystemInfo, FileType, FindFileMatch, FindFileQuery,
    Permissions, Protocol,
};
use crate::vfs::VirtualFileSystem;
use async_trait::async_trait;
use bytes::Bytes;
use chrono::{DateTime, Utc};
use hex::encode as hex_encode;
use hmac::{Hmac, Mac};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::{Method, StatusCode};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;
use std::fmt::Write as _;
use std::sync::{Arc, RwLock};
use std::time::Duration;

type HmacSha256 = Hmac<Sha256>;

const DEFAULT_REGION: &str = "us-east-1";
/// SHA-256 of the empty string.
const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
/// Bodies above this size are uploaded with multipart upload.
const MULTIPART_THRESHOLD: usize = 64 * 1024 * 1024;
const MIN_PART_SIZE: usize = 16 * 1024 * 1024;
const MAX_PARTS: usize = 10_000;
/// CopyObject handles at most 5 GiB; larger objects use UploadPartCopy.
const MAX_SINGLE_COPY: u64 = 5 * 1024 * 1024 * 1024;
const MIN_COPY_PART_SIZE: u64 = 512 * 1024 * 1024;
const PARALLEL_UPLOADS: usize = 4;
const PARALLEL_DELETES: usize = 8;
/// Payloads larger than this are hashed on the blocking pool.
const HASH_IN_BLOCKING_THRESHOLD: usize = 1024 * 1024;
/// Upper bound on keys scanned by one search, so a huge bucket cannot run forever.
const MAX_SEARCH_SCAN: usize = 200_000;
/// Content search only downloads files up to this size.
pub(crate) const CONTENT_SEARCH_MAX_BYTES: u64 = 4 * 1024 * 1024;
/// Content search inspects at most this many candidate files.
pub(crate) const CONTENT_SEARCH_MAX_CANDIDATES: usize = 500;

#[derive(Clone)]
pub struct S3Config {
    pub endpoint: String,
    /// Signing region. Empty or `us-east-1` means "derive it from the endpoint"
    /// (`s3.<region>.amazonaws.com`, `<bucket>.s3.<region>.amazonaws.com`,
    /// `auto` for Cloudflare R2, otherwise `us-east-1`).
    pub region: String,
    pub access_key: String,
    pub secret_key: String,
    /// Fixed bucket, optionally followed by a start folder (`bucket/some/dir`).
    pub bucket: Option<String>,
}

impl fmt::Debug for S3Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("S3Config")
            .field("endpoint", &self.endpoint)
            .field("region", &self.region)
            .field("access_key", &self.access_key)
            .field("secret_key", &"<redacted>")
            .field("bucket", &self.bucket)
            .finish()
    }
}

/// An AWS S3 host name, parsed.
#[derive(Debug, Clone, PartialEq, Eq)]
struct AwsHost {
    /// Bucket encoded in a virtual-hosted host name.
    bucket: Option<String>,
    region: Option<String>,
    /// `amazonaws.com` or `amazonaws.com.cn`.
    suffix: String,
    dualstack: bool,
    /// The host can be rewritten to the regional `s3.<region>` form (false for
    /// accelerate, FIPS, access-point and other special endpoints).
    rewritable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Endpoint {
    scheme: String,
    /// Lower-case host (IPv6 literals keep their brackets).
    host: String,
    /// Explicit non-default port.
    port: Option<u16>,
    /// Path prefix of the endpoint without trailing slash ("" for none).
    base_path: String,
    aws: Option<AwsHost>,
}

#[derive(Clone)]
pub struct S3Driver {
    config: S3Config,
    client: reqwest::Client,
    endpoint: Result<Endpoint, String>,
    /// Fixed bucket (configured or encoded in the endpoint host).
    bucket: Option<String>,
    /// Folder inside the fixed bucket that the session opens first.
    start_prefix: String,
    /// The fixed bucket is addressed through the host name, not the path.
    virtual_hosted: bool,
    default_region: String,
    /// Regions learned from `x-amz-bucket-region`, per bucket.
    learned_regions: Arc<RwLock<HashMap<String, String>>>,
}

impl fmt::Debug for S3Driver {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("S3Driver")
            .field("config", &self.config)
            .field("bucket", &self.bucket)
            .field("virtual_hosted", &self.virtual_hosted)
            .field("default_region", &self.default_region)
            .finish()
    }
}

/// One S3 API request before signing.
struct S3Request<'a> {
    method: Method,
    bucket: &'a str,
    key: &'a str,
    /// Raw (unencoded) query parameters.
    query: Vec<(String, String)>,
    /// Extra headers (lower-case names); all of them are signed.
    headers: Vec<(String, String)>,
    body: Bytes,
}

impl<'a> S3Request<'a> {
    fn new(method: Method, bucket: &'a str, key: &'a str) -> Self {
        Self {
            method,
            bucket,
            key,
            query: Vec::new(),
            headers: Vec::new(),
            body: Bytes::new(),
        }
    }

    fn query(mut self, name: &str, value: impl Into<String>) -> Self {
        self.query.push((name.to_string(), value.into()));
        self
    }

    fn header(mut self, name: &str, value: impl Into<String>) -> Self {
        self.headers.push((name.to_ascii_lowercase(), value.into()));
        self
    }

    fn body(mut self, body: Bytes) -> Self {
        self.body = body;
        self
    }

    fn describe(&self) -> String {
        if self.bucket.is_empty() {
            format!("{} /", self.method)
        } else if self.key.is_empty() {
            format!("{} /{}", self.method, self.bucket)
        } else {
            format!("{} /{}/{}", self.method, self.bucket, self.key)
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
struct ObjectInfo {
    key: String,
    size: u64,
    last_modified: Option<DateTime<Utc>>,
}

#[derive(Debug, Default)]
struct ListPage {
    prefixes: Vec<String>,
    objects: Vec<ObjectInfo>,
    next_token: Option<String>,
}

impl S3Driver {
    pub fn new(config: S3Config) -> Self {
        let endpoint = parse_endpoint(&config.endpoint);

        let (cfg_bucket, cfg_prefix) = match config.bucket.as_deref().map(|b| b.trim_matches('/')) {
            Some(b) if !b.is_empty() => match b.split_once('/') {
                Some((bucket, rest)) => {
                    (Some(bucket.to_string()), rest.trim_matches('/').to_string())
                }
                None => (Some(b.to_string()), String::new()),
            },
            _ => (None, String::new()),
        };

        let host_bucket = endpoint
            .as_ref()
            .ok()
            .and_then(|ep| ep.aws.as_ref())
            .and_then(|aws| aws.bucket.clone());

        let (bucket, start_prefix, virtual_hosted) = match (host_bucket, cfg_bucket) {
            // The endpoint already names the bucket: a configured "bucket"
            // different from it can only be a folder inside it.
            (Some(hb), Some(cb)) if cb != hb => {
                let folder = if cfg_prefix.is_empty() {
                    cb
                } else {
                    format!("{cb}/{cfg_prefix}")
                };
                (Some(hb), folder, true)
            }
            (Some(hb), _) => (Some(hb), cfg_prefix, true),
            (None, Some(cb)) => {
                // `<bucket>.<provider host>`: the bucket is already in the
                // host name. Only known virtual-host providers count, so a
                // path-style server whose own name starts with the bucket
                // name (bucket `backup` on `backup.example.com`) keeps
                // `/bucket/key` paths.
                let vh = endpoint.as_ref().is_ok_and(|ep| {
                    ep.host.parse::<std::net::IpAddr>().is_err()
                        && ep
                            .host
                            .strip_prefix(&format!("{}.", cb.to_ascii_lowercase()))
                            .is_some_and(is_virtual_host_suffix)
                });
                (Some(cb), cfg_prefix, vh)
            }
            (None, None) => (None, String::new(), false),
        };

        let default_region = match &endpoint {
            Ok(ep) => derive_region(&config.region, ep),
            Err(_) => {
                let r = config.region.trim();
                if r.is_empty() {
                    DEFAULT_REGION.to_string()
                } else {
                    r.to_string()
                }
            }
        };

        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(120))
            .pool_idle_timeout(Duration::from_secs(90))
            // Redirects are handled explicitly (region discovery); following them
            // would resend signed headers to another host.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        Self {
            config,
            client,
            endpoint,
            bucket,
            start_prefix,
            virtual_hosted,
            default_region,
            learned_regions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    fn endpoint(&self) -> CoreResult<&Endpoint> {
        self.endpoint
            .as_ref()
            .map_err(|e| CoreError::ConnectionFailed(e.clone()))
    }

    /// Splits a VFS path into (bucket, key). The key keeps a trailing '/' when
    /// the path had one.
    fn split_path(&self, path: &str) -> (String, String) {
        let clean = path.trim_start_matches('/');
        if let Some(bucket) = &self.bucket {
            let key = if clean == bucket {
                ""
            } else if let Some(rest) = clean
                .strip_prefix(bucket.as_str())
                .and_then(|r| r.strip_prefix('/'))
            {
                rest
            } else {
                clean
            };
            (bucket.clone(), key.to_string())
        } else {
            match clean.split_once('/') {
                Some((bucket, key)) => (bucket.to_string(), key.to_string()),
                None => (clean.to_string(), String::new()),
            }
        }
    }

    fn region_for(&self, bucket: &str) -> String {
        if !bucket.is_empty() {
            if let Ok(map) = self.learned_regions.read() {
                if let Some(region) = map.get(bucket) {
                    return region.clone();
                }
            }
        }
        self.default_region.clone()
    }

    fn learn_region(&self, bucket: &str, region: &str) {
        if let Ok(mut map) = self.learned_regions.write() {
            map.insert(bucket.to_string(), region.to_string());
        }
    }

    /// `host[:port]` for a request. AWS endpoints are rewritten to the regional
    /// host when the bucket lives in another region than the endpoint names.
    fn authority(&self, ep: &Endpoint, region: &str) -> String {
        let mut host = ep.host.clone();
        if let Some(aws) = &ep.aws {
            let host_region = aws.region.as_deref().unwrap_or(DEFAULT_REGION);
            if aws.rewritable && region != host_region && looks_like_region(region) {
                let ds = if aws.dualstack { "dualstack." } else { "" };
                host = match (&aws.bucket, self.virtual_hosted) {
                    (Some(b), true) => format!("{b}.s3.{ds}{region}.{}", aws.suffix),
                    _ => format!("s3.{ds}{region}.{}", aws.suffix),
                };
            }
        }
        match ep.port {
            Some(p) => format!("{host}:{p}"),
            None => host,
        }
    }

    /// Returns (scheme, authority, canonical URI path) for a request.
    fn target(
        &self,
        bucket: &str,
        key: &str,
        region: &str,
    ) -> CoreResult<(String, String, String)> {
        let ep = self.endpoint()?;
        if bucket.contains('/') || bucket == "." || bucket == ".." {
            return Err(CoreError::InvalidPath(format!(
                "invalid S3 bucket name '{bucket}'"
            )));
        }
        if key.split('/').any(|seg| seg == "." || seg == "..") {
            return Err(CoreError::InvalidPath(format!(
                "S3 key '{key}' contains '.' or '..' segments, which cannot be addressed safely"
            )));
        }
        let mut path = ep.base_path.clone();
        path.push('/');
        if !bucket.is_empty() {
            let in_host = self.virtual_hosted && self.bucket.as_deref() == Some(bucket);
            if !in_host {
                path.push_str(&uri_encode(bucket, true));
                if !key.is_empty() {
                    path.push('/');
                }
            }
            path.push_str(&uri_encode(key, false));
        }
        Ok((ep.scheme.clone(), self.authority(ep, region), path))
    }

    /// Signs and sends a request and returns the response whatever its status,
    /// except that a wrong-region answer is retried once with the region S3
    /// reports for the bucket.
    async fn send_raw(&self, req: &S3Request<'_>) -> CoreResult<reqwest::Response> {
        let payload_hash = sha256_hex_async(&req.body).await?;
        let canonical_query = canonical_query_string(&req.query);
        let access_key = self.config.access_key.trim();
        let secret_key = self.config.secret_key.trim();
        let mut retried = false;

        loop {
            let region = self.region_for(req.bucket);
            let (scheme, authority, path) = self.target(req.bucket, req.key, &region)?;
            let mut url_str = format!("{scheme}://{authority}{path}");
            if !canonical_query.is_empty() {
                url_str.push('?');
                url_str.push_str(&canonical_query);
            }
            let url = reqwest::Url::parse(&url_str)
                .map_err(|e| CoreError::InvalidPath(format!("{url_str}: {e}")))?;
            if url.path() != path {
                return Err(CoreError::InvalidPath(format!(
                    "S3 key '{}' cannot be addressed exactly (URL normalised to '{}')",
                    req.key,
                    url.path()
                )));
            }

            let amz_date = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
            let mut signed: BTreeMap<String, String> = BTreeMap::new();
            signed.insert("host".into(), authority.clone());
            signed.insert("x-amz-content-sha256".into(), payload_hash.clone());
            signed.insert("x-amz-date".into(), amz_date.clone());
            for (name, value) in &req.headers {
                signed.insert(name.to_ascii_lowercase(), value.clone());
            }
            let authorization = sigv4_authorization(
                &SigningParams {
                    access_key,
                    secret_key,
                    region: &region,
                    service: "s3",
                    amz_date: &amz_date,
                },
                req.method.as_str(),
                &path,
                &canonical_query,
                &signed,
                &payload_hash,
            );

            let mut headers = HeaderMap::new();
            for (name, value) in &signed {
                insert_header(&mut headers, name, value)?;
            }
            insert_header(&mut headers, "authorization", &authorization)?;
            let has_body =
                !req.body.is_empty() || req.method == Method::PUT || req.method == Method::POST;
            if has_body {
                // S3 rejects chunked PUT/POST without Content-Length.
                headers.insert(
                    reqwest::header::CONTENT_LENGTH,
                    HeaderValue::from(req.body.len()),
                );
            }

            let mut builder = self
                .client
                .request(req.method.clone(), url)
                .headers(headers);
            if has_body {
                builder = builder.body(req.body.clone());
            }
            let res = builder.send().await.map_err(map_reqwest_error)?;
            let status = res.status();
            if status.is_success() || retried || req.bucket.is_empty() {
                return Ok(res);
            }

            let header_region = res
                .headers()
                .get("x-amz-bucket-region")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            let region_error = matches!(status.as_u16(), 301 | 307 | 400)
                || (status == StatusCode::FORBIDDEN && header_region.is_some());
            if !region_error {
                return Ok(res);
            }
            let body = res.text().await.unwrap_or_default();
            let hint = header_region
                .or_else(|| xml_first(&body, "Region").map(|r| r.trim().to_string()))
                .filter(|r| !r.is_empty() && *r != region);
            match hint {
                Some(found) => {
                    tracing::info!(
                        "S3 bucket '{}' is in region '{}' (signed for '{}'); retrying",
                        req.bucket,
                        found,
                        region
                    );
                    self.learn_region(req.bucket, &found);
                    retried = true;
                }
                None => return Err(s3_error(status, &body, &req.describe())),
            }
        }
    }

    /// Like `send_raw`, but every non-2xx status becomes an error.
    async fn send(&self, req: S3Request<'_>) -> CoreResult<reqwest::Response> {
        let res = self.send_raw(&req).await?;
        if res.status().is_success() {
            Ok(res)
        } else {
            Err(error_from_response(res, &req.describe()).await)
        }
    }

    async fn list_bucket_names(&self) -> CoreResult<Vec<String>> {
        let res = self.send(S3Request::new(Method::GET, "", "")).await?;
        let text = res.text().await.map_err(map_reqwest_error)?;
        parse_list_buckets(&text)
    }

    /// One ListObjectsV2 page.
    async fn list_page(
        &self,
        bucket: &str,
        prefix: &str,
        delimited: bool,
        token: Option<&str>,
        max_keys: usize,
    ) -> CoreResult<ListPage> {
        let mut req = S3Request::new(Method::GET, bucket, "")
            .query("list-type", "2")
            .query("encoding-type", "url")
            .query("max-keys", max_keys.clamp(1, 1000).to_string());
        if !prefix.is_empty() {
            req = req.query("prefix", prefix);
        }
        if delimited {
            req = req.query("delimiter", "/");
        }
        if let Some(t) = token {
            req = req.query("continuation-token", t);
        }
        let res = self.send(req).await?;
        let text = res.text().await.map_err(map_reqwest_error)?;
        parse_list_objects(&text)
    }

    /// All pages of a listing.
    async fn list_all(&self, bucket: &str, prefix: &str, delimited: bool) -> CoreResult<ListPage> {
        let mut all = ListPage::default();
        let mut token: Option<String> = None;
        loop {
            let page = self
                .list_page(bucket, prefix, delimited, token.as_deref(), 1000)
                .await?;
            all.prefixes.extend(page.prefixes);
            all.objects.extend(page.objects);
            match page.next_token {
                Some(next) => {
                    if token.as_deref() == Some(next.as_str()) {
                        return Err(CoreError::Protocol(
                            "S3 listing did not advance (repeated continuation token)".into(),
                        ));
                    }
                    token = Some(next);
                }
                None => break,
            }
        }
        Ok(all)
    }

    /// True when at least one object exists under `key/`.
    async fn prefix_exists(&self, bucket: &str, key: &str) -> CoreResult<bool> {
        let page = self
            .list_page(bucket, &dir_prefix(key), false, None, 1)
            .await?;
        Ok(!page.objects.is_empty() || !page.prefixes.is_empty())
    }

    async fn head_object(
        &self,
        bucket: &str,
        key: &str,
    ) -> CoreResult<(u64, Option<DateTime<Utc>>)> {
        let req = S3Request::new(Method::HEAD, bucket, key);
        let res = self.send_raw(&req).await?;
        let status = res.status();
        if !status.is_success() {
            return Err(s3_error(status, "", &req.describe()));
        }
        // `Response::content_length()` is the body size hint, which is 0 for
        // HEAD: read the header instead.
        let size = res
            .headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<u64>().ok())
            .unwrap_or(0);
        let modified = res
            .headers()
            .get(reqwest::header::LAST_MODIFIED)
            .and_then(|v| v.to_str().ok())
            .and_then(parse_http_date);
        Ok((size, modified))
    }

    async fn delete_object(&self, bucket: &str, key: &str) -> CoreResult<()> {
        self.send(S3Request::new(Method::DELETE, bucket, key))
            .await?;
        Ok(())
    }

    /// Deletes keys with bounded concurrency. Keys that are already gone are fine.
    async fn delete_keys(&self, bucket: &str, keys: Vec<String>) -> CoreResult<()> {
        let mut set = tokio::task::JoinSet::new();
        let mut pending = keys.into_iter();
        let mut first_err: Option<CoreError> = None;
        loop {
            while first_err.is_none() && set.len() < PARALLEL_DELETES {
                match pending.next() {
                    Some(key) => {
                        let driver = self.clone();
                        let bucket = bucket.to_string();
                        set.spawn(async move { driver.delete_object(&bucket, &key).await });
                    }
                    None => break,
                }
            }
            match set.join_next().await {
                Some(Ok(Ok(()))) | Some(Ok(Err(CoreError::NotFound(_)))) => {}
                Some(Ok(Err(e))) => {
                    if first_err.is_none() {
                        first_err = Some(e);
                    }
                }
                Some(Err(e)) => {
                    if first_err.is_none() {
                        first_err = Some(CoreError::General(e.to_string()));
                    }
                }
                None => break,
            }
        }
        match first_err {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }

    async fn create_multipart(&self, bucket: &str, key: &str) -> CoreResult<String> {
        let res = self
            .send(S3Request::new(Method::POST, bucket, key).query("uploads", ""))
            .await?;
        let text = res.text().await.map_err(map_reqwest_error)?;
        xml_first(&text, "UploadId")
            .map(|id| id.trim().to_string())
            .filter(|id| !id.is_empty())
            .ok_or_else(|| {
                CoreError::Protocol(format!(
                    "S3 did not return an UploadId for {key}: {}",
                    body_snippet(&text)
                ))
            })
    }

    async fn upload_part(
        &self,
        bucket: &str,
        key: &str,
        upload_id: &str,
        part_number: u32,
        chunk: Bytes,
    ) -> CoreResult<String> {
        let res = self
            .send(
                S3Request::new(Method::PUT, bucket, key)
                    .query("partNumber", part_number.to_string())
                    .query("uploadId", upload_id)
                    .body(chunk),
            )
            .await?;
        res.headers()
            .get(reqwest::header::ETAG)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string())
            .ok_or_else(|| {
                CoreError::Protocol(format!("S3 did not return an ETag for part {part_number}"))
            })
    }

    async fn upload_part_copy(
        &self,
        bucket: &str,
        key: &str,
        upload_id: &str,
        part_number: u32,
        copy_source: &str,
        range: (u64, u64),
    ) -> CoreResult<String> {
        let res = self
            .send(
                S3Request::new(Method::PUT, bucket, key)
                    .query("partNumber", part_number.to_string())
                    .query("uploadId", upload_id)
                    .header("x-amz-copy-source", copy_source)
                    .header(
                        "x-amz-copy-source-range",
                        format!("bytes={}-{}", range.0, range.1),
                    ),
            )
            .await?;
        let text = res.text().await.map_err(map_reqwest_error)?;
        check_embedded_error(&text, "UploadPartCopy")?;
        xml_first(&text, "ETag")
            .map(|e| e.trim().to_string())
            .filter(|e| !e.is_empty())
            .ok_or_else(|| {
                CoreError::Protocol(format!(
                    "S3 did not return an ETag for copied part {part_number}"
                ))
            })
    }

    async fn complete_multipart(
        &self,
        bucket: &str,
        key: &str,
        upload_id: &str,
        parts: &[(u32, String)],
    ) -> CoreResult<()> {
        let mut body = String::from("<CompleteMultipartUpload>");
        for (number, etag) in parts {
            let _ = write!(
                body,
                "<Part><PartNumber>{number}</PartNumber><ETag>{}</ETag></Part>",
                xml_escape(etag)
            );
        }
        body.push_str("</CompleteMultipartUpload>");
        let res = self
            .send(
                S3Request::new(Method::POST, bucket, key)
                    .query("uploadId", upload_id)
                    .header("content-type", "application/xml")
                    .body(Bytes::from(body)),
            )
            .await?;
        // CompleteMultipartUpload can fail after sending 200 OK.
        let text = res.text().await.map_err(map_reqwest_error)?;
        check_embedded_error(&text, "CompleteMultipartUpload")
    }

    async fn abort_multipart(&self, bucket: &str, key: &str, upload_id: &str) {
        if let Err(e) = self
            .send(S3Request::new(Method::DELETE, bucket, key).query("uploadId", upload_id))
            .await
        {
            tracing::warn!("S3: could not abort multipart upload {upload_id} for {key}: {e}");
        }
    }

    async fn multipart_upload(&self, bucket: &str, key: &str, data: Bytes) -> CoreResult<()> {
        let part_size = part_size_for(data.len());
        let upload_id = self.create_multipart(bucket, key).await?;
        let result = match self
            .upload_parts(bucket, key, &upload_id, &data, part_size)
            .await
        {
            Ok(parts) => {
                self.complete_multipart(bucket, key, &upload_id, &parts)
                    .await
            }
            Err(e) => Err(e),
        };
        if result.is_err() {
            self.abort_multipart(bucket, key, &upload_id).await;
        }
        result
    }

    async fn upload_parts(
        &self,
        bucket: &str,
        key: &str,
        upload_id: &str,
        data: &Bytes,
        part_size: usize,
    ) -> CoreResult<Vec<(u32, String)>> {
        let mut set = tokio::task::JoinSet::new();
        let mut parts = Vec::new();
        let mut offset = 0usize;
        let mut part_number = 1u32;
        let mut first_err: Option<CoreError> = None;
        loop {
            while first_err.is_none() && offset < data.len() && set.len() < PARALLEL_UPLOADS {
                let end = (offset + part_size).min(data.len());
                let chunk = data.slice(offset..end);
                let driver = self.clone();
                let (b, k, u, n) = (
                    bucket.to_string(),
                    key.to_string(),
                    upload_id.to_string(),
                    part_number,
                );
                set.spawn(async move {
                    driver
                        .upload_part(&b, &k, &u, n, chunk)
                        .await
                        .map(|etag| (n, etag))
                });
                offset = end;
                part_number += 1;
            }
            match set.join_next().await {
                Some(Ok(Ok(part))) => parts.push(part),
                Some(Ok(Err(e))) => {
                    if first_err.is_none() {
                        first_err = Some(e);
                    }
                }
                Some(Err(e)) => {
                    if first_err.is_none() {
                        first_err = Some(CoreError::General(e.to_string()));
                    }
                }
                None => break,
            }
        }
        if let Some(e) = first_err {
            return Err(e);
        }
        parts.sort_by_key(|p| p.0);
        Ok(parts)
    }

    /// Server-side copy (CopyObject, or UploadPartCopy above 5 GiB).
    async fn copy_object(
        &self,
        src_bucket: &str,
        src_key: &str,
        dst_bucket: &str,
        dst_key: &str,
        size: u64,
    ) -> CoreResult<()> {
        let source = format!(
            "/{}/{}",
            uri_encode(src_bucket, true),
            uri_encode(src_key, false)
        );
        if size <= MAX_SINGLE_COPY {
            let res = self
                .send(
                    S3Request::new(Method::PUT, dst_bucket, dst_key)
                        .header("x-amz-copy-source", source),
                )
                .await?;
            // CopyObject can fail after sending 200 OK.
            let text = res.text().await.map_err(map_reqwest_error)?;
            return check_embedded_error(&text, "CopyObject");
        }

        let part_size = MIN_COPY_PART_SIZE.max(size.div_ceil(MAX_PARTS as u64));
        let upload_id = self.create_multipart(dst_bucket, dst_key).await?;
        let mut parts = Vec::new();
        let mut start = 0u64;
        let mut number = 1u32;
        let mut result = Ok(());
        while start < size {
            let end = (start + part_size).min(size) - 1;
            match self
                .upload_part_copy(
                    dst_bucket,
                    dst_key,
                    &upload_id,
                    number,
                    &source,
                    (start, end),
                )
                .await
            {
                Ok(etag) => parts.push((number, etag)),
                Err(e) => {
                    result = Err(e);
                    break;
                }
            }
            start = end + 1;
            number += 1;
        }
        if result.is_ok() {
            result = self
                .complete_multipart(dst_bucket, dst_key, &upload_id, &parts)
                .await;
        }
        if result.is_err() {
            self.abort_multipart(dst_bucket, dst_key, &upload_id).await;
        }
        result
    }

    async fn prefix_size(&self, bucket: &str, prefix: &str) -> CoreResult<u64> {
        let mut total = 0u64;
        let mut token: Option<String> = None;
        loop {
            let page = self
                .list_page(bucket, prefix, false, token.as_deref(), 1000)
                .await?;
            total = page
                .objects
                .iter()
                .fold(total, |acc, o| acc.saturating_add(o.size));
            match page.next_token {
                Some(next) if token.as_deref() != Some(next.as_str()) => token = Some(next),
                Some(_) => {
                    return Err(CoreError::Protocol(
                        "S3 listing did not advance (repeated continuation token)".into(),
                    ))
                }
                None => break,
            }
        }
        Ok(total)
    }

    /// Recursive walk below `root` (flat listing without delimiter) that
    /// returns files and implied folders whose name satisfies `matches`.
    async fn walk_matching<F>(
        &self,
        root: &str,
        max_depth: Option<usize>,
        max_results: usize,
        matches: F,
    ) -> CoreResult<Vec<FileEntry>>
    where
        F: Fn(&str, bool) -> bool + Send + Sync,
    {
        let mut results = Vec::new();
        if max_results == 0 {
            return Ok(results);
        }
        let (bucket, key) = self.split_path(root);
        let (buckets, base_prefix) = if bucket.is_empty() {
            (self.list_bucket_names().await?, String::new())
        } else {
            (vec![bucket], dir_prefix(&key))
        };
        let mut seen_dirs: HashSet<(String, String)> = HashSet::new();
        let mut scanned = 0usize;

        'buckets: for b in &buckets {
            let mut token: Option<String> = None;
            loop {
                let page = self
                    .list_page(b, &base_prefix, false, token.as_deref(), 1000)
                    .await?;
                for obj in page.objects {
                    scanned += 1;
                    let Some(rel) = obj.key.strip_prefix(base_prefix.as_str()) else {
                        continue;
                    };
                    if rel.is_empty() {
                        continue;
                    }
                    let segments: Vec<&str> = rel.split('/').collect();
                    let dir_count = segments.len() - 1;
                    let mut acc = base_prefix.clone();
                    for (i, seg) in segments[..dir_count].iter().enumerate() {
                        acc.push_str(seg);
                        let depth = i + 1;
                        if !seg.is_empty()
                            && max_depth.is_none_or(|d| depth <= d)
                            && seen_dirs.insert((b.clone(), acc.clone()))
                            && matches(seg, true)
                        {
                            results.push(dir_entry(seg, entry_path(b, &acc)));
                            if results.len() >= max_results {
                                break 'buckets;
                            }
                        }
                        acc.push('/');
                    }
                    let name = segments[dir_count];
                    if name.is_empty() {
                        continue; // folder marker
                    }
                    if max_depth.is_none_or(|d| segments.len() <= d) && matches(name, false) {
                        results.push(file_entry(
                            name,
                            entry_path(b, &obj.key),
                            obj.size,
                            obj.last_modified,
                        ));
                        if results.len() >= max_results {
                            break 'buckets;
                        }
                    }
                }
                if scanned >= MAX_SEARCH_SCAN {
                    tracing::warn!(
                        "S3 search below '{root}' stopped after scanning {scanned} keys"
                    );
                    break 'buckets;
                }
                match page.next_token {
                    Some(next) if token.as_deref() != Some(next.as_str()) => token = Some(next),
                    _ => break,
                }
            }
        }
        Ok(results)
    }
}

/// Fails when a path names a bucket or folder instead of an object.
fn require_object(bucket: &str, key: &str, path: &str) -> CoreResult<()> {
    if bucket.is_empty() || key.is_empty() || key.ends_with('/') {
        Err(CoreError::InvalidPath(format!(
            "'{path}' is a bucket or folder, not an S3 object"
        )))
    } else {
        Ok(())
    }
}

#[async_trait]
impl VirtualFileSystem for S3Driver {
    fn protocol(&self) -> Protocol {
        Protocol::S3
    }

    async fn list_dir(&self, path: &str) -> CoreResult<Vec<FileEntry>> {
        let (bucket, key) = self.split_path(path);

        if bucket.is_empty() {
            return Ok(self
                .list_bucket_names()
                .await?
                .into_iter()
                .map(|name| {
                    let p = entry_path(&name, "");
                    dir_entry(&name, p)
                })
                .collect());
        }

        let prefix = dir_prefix(&key);
        let listing = self.list_all(&bucket, &prefix, true).await?;
        let mut entries = Vec::new();

        for p in &listing.prefixes {
            let Some(rel) = p.strip_prefix(prefix.as_str()) else {
                continue;
            };
            let name = rel.trim_end_matches('/');
            if name.is_empty() || name.contains('/') {
                continue;
            }
            entries.push(dir_entry(
                name,
                entry_path(&bucket, p.trim_end_matches('/')),
            ));
        }

        for obj in &listing.objects {
            if obj.key == prefix {
                continue; // the folder marker itself
            }
            let Some(name) = obj.key.strip_prefix(prefix.as_str()) else {
                continue;
            };
            if name.is_empty() || name.contains('/') {
                continue;
            }
            entries.push(file_entry(
                name,
                entry_path(&bucket, &obj.key),
                obj.size,
                obj.last_modified,
            ));
        }

        entries.sort_by(|a, b| match (a.is_dir(), b.is_dir()) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });

        Ok(entries)
    }

    async fn metadata(&self, path: &str) -> CoreResult<FileEntry> {
        let (bucket, key) = self.split_path(path);
        if bucket.is_empty() {
            return Ok(dir_entry("/", "/".to_string()));
        }
        if key.trim_end_matches('/').is_empty() {
            if self.bucket.is_none() {
                let req = S3Request::new(Method::HEAD, &bucket, "");
                let res = self.send_raw(&req).await?;
                if !res.status().is_success() {
                    return Err(s3_error(res.status(), "", &req.describe()));
                }
            }
            return Ok(dir_entry(&bucket, path.to_string()));
        }

        let name = key
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or_default()
            .to_string();

        let head_err = if key.ends_with('/') {
            None
        } else {
            match self.head_object(&bucket, &key).await {
                Ok((size, modified)) => {
                    return Ok(file_entry(&name, path.to_string(), size, modified));
                }
                // 403 is what S3 returns for a missing key without ListBucket
                // permission; a folder may still exist under the prefix.
                Err(e @ (CoreError::NotFound(_) | CoreError::PermissionDenied(_))) => Some(e),
                Err(e) => return Err(e),
            }
        };

        match self.prefix_exists(&bucket, &key).await {
            Ok(true) => Ok(dir_entry(&name, path.to_string())),
            Ok(false) => Err(head_err.unwrap_or_else(|| CoreError::NotFound(path.to_string()))),
            Err(e) => Err(head_err.unwrap_or(e)),
        }
    }

    async fn read_file(&self, path: &str) -> CoreResult<Bytes> {
        let (bucket, key) = self.split_path(path);
        require_object(&bucket, &key, path)?;
        let res = self
            .send(S3Request::new(Method::GET, &bucket, &key))
            .await?;
        res.bytes().await.map_err(map_reqwest_error)
    }

    async fn read_range(&self, path: &str, offset: u64, length: u64) -> CoreResult<Bytes> {
        if length == 0 {
            return Ok(Bytes::new());
        }
        let (bucket, key) = self.split_path(path);
        require_object(&bucket, &key, path)?;
        let end = offset
            .checked_add(length - 1)
            .ok_or_else(|| CoreError::InvalidPath(format!("invalid range {offset}+{length}")))?;
        let req = S3Request::new(Method::GET, &bucket, &key)
            .header("range", format!("bytes={offset}-{end}"));
        let res = self.send_raw(&req).await?;
        match res.status().as_u16() {
            206 => {
                let data = res.bytes().await.map_err(map_reqwest_error)?;
                if data.len() as u64 > length {
                    Ok(data.slice(..length as usize))
                } else {
                    Ok(data)
                }
            }
            200 => {
                // The server ignored Range and sent the whole object.
                let data = res.bytes().await.map_err(map_reqwest_error)?;
                let start = (offset.min(data.len() as u64)) as usize;
                let stop = (start as u64 + length).min(data.len() as u64) as usize;
                Ok(data.slice(start..stop))
            }
            // Range starts at or after the end of the object.
            416 => Ok(Bytes::new()),
            _ => Err(error_from_response(res, &req.describe()).await),
        }
    }

    async fn write_file(&self, path: &str, data: Bytes) -> CoreResult<()> {
        let (bucket, key) = self.split_path(path);
        require_object(&bucket, &key, path)?;
        if data.len() > MULTIPART_THRESHOLD {
            return self.multipart_upload(&bucket, &key, data).await;
        }
        self.send(S3Request::new(Method::PUT, &bucket, &key).body(data))
            .await?;
        Ok(())
    }

    async fn create_dir(&self, path: &str) -> CoreResult<()> {
        let (bucket, key) = self.split_path(path);
        if bucket.is_empty() {
            return Err(CoreError::InvalidPath(
                "a bucket name is required to create a folder".into(),
            ));
        }
        if key.trim_end_matches('/').is_empty() {
            if self.bucket.is_some() {
                return Ok(()); // the bucket root always exists
            }
            // New top-level folder in bucket-less mode: create the bucket.
            let region = self.region_for(&bucket);
            let mut req = S3Request::new(Method::PUT, &bucket, "");
            if region != DEFAULT_REGION && region != "auto" && self.endpoint()?.aws.is_some() {
                req = req.header("content-type", "application/xml").body(Bytes::from(format!(
                    "<CreateBucketConfiguration><LocationConstraint>{}</LocationConstraint></CreateBucketConfiguration>",
                    xml_escape(&region)
                )));
            }
            self.send(req).await?;
            return Ok(());
        }
        // Parents are implicit in S3: only the marker object is needed.
        let marker = dir_prefix(&key);
        self.send(S3Request::new(Method::PUT, &bucket, &marker))
            .await?;
        Ok(())
    }

    async fn remove_file(&self, path: &str) -> CoreResult<()> {
        let (bucket, key) = self.split_path(path);
        if bucket.is_empty() || key.is_empty() {
            return Err(CoreError::InvalidPath(format!(
                "'{path}' is a bucket, not an S3 object"
            )));
        }
        self.delete_object(&bucket, &key).await
    }

    async fn remove_dir(&self, path: &str, recursive: bool) -> CoreResult<()> {
        let (bucket, key) = self.split_path(path);
        if bucket.is_empty() || key.trim_end_matches('/').is_empty() {
            return Err(CoreError::Protocol(
                "Deleting a whole bucket is not supported; delete its contents here and remove the bucket in your provider's console".into(),
            ));
        }
        let prefix = dir_prefix(&key);

        if !recursive {
            let page = self.list_page(&bucket, &prefix, true, None, 2).await?;
            let has_children =
                !page.prefixes.is_empty() || page.objects.iter().any(|o| o.key != prefix);
            if has_children {
                return Err(CoreError::General(format!("Directory not empty: {path}")));
            }
            if page.objects.is_empty() {
                return Err(CoreError::NotFound(path.to_string()));
            }
            return self.delete_object(&bucket, &prefix).await;
        }

        let mut token: Option<String> = None;
        let mut deleted = 0usize;
        loop {
            let page = self
                .list_page(&bucket, &prefix, false, token.as_deref(), 1000)
                .await?;
            let keys: Vec<String> = page.objects.into_iter().map(|o| o.key).collect();
            deleted += keys.len();
            self.delete_keys(&bucket, keys).await?;
            match page.next_token {
                Some(next) if token.as_deref() != Some(next.as_str()) => token = Some(next),
                Some(_) => {
                    return Err(CoreError::Protocol(
                        "S3 listing did not advance (repeated continuation token)".into(),
                    ))
                }
                None => break,
            }
        }
        if deleted == 0 {
            return Err(CoreError::NotFound(path.to_string()));
        }
        Ok(())
    }

    async fn rename(&self, from: &str, to: &str) -> CoreResult<()> {
        let (src_bucket, src_key) = self.split_path(from);
        let (dst_bucket, dst_key) = self.split_path(to);
        let src_key_trim = src_key.trim_end_matches('/');
        let dst_key_trim = dst_key.trim_end_matches('/');
        if src_bucket.is_empty()
            || dst_bucket.is_empty()
            || src_key_trim.is_empty()
            || dst_key_trim.is_empty()
        {
            return Err(CoreError::Protocol("S3 buckets cannot be renamed".into()));
        }
        if src_bucket == dst_bucket && src_key_trim == dst_key_trim {
            return Ok(());
        }

        if !src_key.ends_with('/') {
            match self.head_object(&src_bucket, src_key_trim).await {
                Ok((size, _)) => {
                    self.copy_object(&src_bucket, src_key_trim, &dst_bucket, dst_key_trim, size)
                        .await?;
                    return self.delete_object(&src_bucket, src_key_trim).await;
                }
                Err(CoreError::NotFound(_)) => {} // maybe a folder
                Err(e) => return Err(e),
            }
        }

        // Folder: copy every object below the prefix, then delete the originals.
        let src_prefix = format!("{src_key_trim}/");
        let dst_prefix = format!("{dst_key_trim}/");
        if src_bucket == dst_bucket && dst_prefix.starts_with(&src_prefix) {
            return Err(CoreError::InvalidPath(format!(
                "cannot move '{from}' into itself"
            )));
        }
        let listing = self.list_all(&src_bucket, &src_prefix, false).await?;
        if listing.objects.is_empty() {
            return Err(CoreError::NotFound(from.to_string()));
        }
        for obj in &listing.objects {
            let Some(suffix) = obj.key.strip_prefix(src_prefix.as_str()) else {
                continue;
            };
            self.copy_object(
                &src_bucket,
                &obj.key,
                &dst_bucket,
                &format!("{dst_prefix}{suffix}"),
                obj.size,
            )
            .await?;
        }
        self.delete_keys(
            &src_bucket,
            listing.objects.into_iter().map(|o| o.key).collect(),
        )
        .await
    }

    async fn set_permissions(&self, path: &str, _mode: u32) -> CoreResult<()> {
        Err(CoreError::Protocol(format!(
            "S3 object storage has no Unix permissions (use bucket policies or ACLs): {path}"
        )))
    }

    async fn exists(&self, path: &str) -> CoreResult<bool> {
        match self.metadata(path).await {
            Ok(_) => Ok(true),
            Err(CoreError::NotFound(_)) => Ok(false),
            Err(e) => Err(e),
        }
    }

    async fn search(
        &self,
        root_path: &str,
        pattern: &str,
        max_results: usize,
    ) -> CoreResult<Vec<FileEntry>> {
        let pat_lower = pattern.to_lowercase();
        self.walk_matching(root_path, None, max_results, |name, _| {
            name.to_lowercase().contains(&pat_lower)
        })
        .await
    }

    async fn create_symlink(
        &self,
        _target: &str,
        _link_path: &str,
        _is_symbolic: bool,
    ) -> CoreResult<()> {
        Err(CoreError::General(
            "Object storage S3 does not support symbolic links".to_string(),
        ))
    }

    async fn get_filesystem_info(&self, path: &str) -> CoreResult<FileSystemInfo> {
        let (bucket, _) = self.split_path(path);
        let secure = self
            .endpoint
            .as_ref()
            .map(|ep| ep.scheme == "https")
            .unwrap_or(false);
        // Object storage has no fixed capacity: report 0 (unknown) instead of
        // invented numbers.
        Ok(FileSystemInfo {
            path: path.to_string(),
            total_bytes: 0,
            free_bytes: 0,
            available_bytes: 0,
            used_bytes: 0,
            total_inodes: None,
            free_inodes: None,
            protocol_name: "Amazon S3 / Compatible Object Storage".to_string(),
            protocol_version: format!("AWS SigV4 (region {})", self.region_for(&bucket)),
            host_key_fingerprint_sha256: None,
            host_key_fingerprint_md5: None,
            cipher_name: Some(if secure {
                "HTTPS (TLS)".to_string()
            } else {
                "None (plain HTTP, unencrypted)".to_string()
            }),
            compression_name: None,
        })
    }

    async fn calculate_size(&self, path: &str) -> CoreResult<u64> {
        let (bucket, key) = self.split_path(path);
        if bucket.is_empty() {
            let mut total = 0u64;
            for b in self.list_bucket_names().await? {
                total = total.saturating_add(self.prefix_size(&b, "").await?);
            }
            return Ok(total);
        }
        if !key.is_empty() && !key.ends_with('/') {
            if let Ok((size, _)) = self.head_object(&bucket, &key).await {
                return Ok(size);
            }
        }
        self.prefix_size(&bucket, &dir_prefix(&key)).await
    }

    async fn find_files(&self, query: &FindFileQuery) -> CoreResult<Vec<FindFileMatch>> {
        let mask = crate::file_masks::FileMaskFilter::new(&query.mask);
        let needle = query.contains_text.as_deref().filter(|t| !t.is_empty());
        let Some(needle) = needle else {
            return Ok(self
                .walk_matching(
                    &query.base_path,
                    query.max_depth,
                    query.max_results,
                    |n, d| mask.matches(n, d),
                )
                .await?
                .into_iter()
                .map(|entry| FindFileMatch {
                    entry,
                    matched_lines: vec![],
                })
                .collect());
        };

        let candidates = self
            .walk_matching(
                &query.base_path,
                query.max_depth,
                CONTENT_SEARCH_MAX_CANDIDATES,
                |n, d| !d && mask.matches(n, d),
            )
            .await?;
        let mut results = Vec::new();
        for entry in candidates {
            if results.len() >= query.max_results {
                break;
            }
            if entry.size > CONTENT_SEARCH_MAX_BYTES {
                continue;
            }
            let data = match self.read_file(&entry.path).await {
                Ok(d) => d,
                Err(e) => {
                    tracing::debug!("S3 content search skipped {}: {e}", entry.path);
                    continue;
                }
            };
            let lines = grep_content(&data, needle, query.case_sensitive);
            if !lines.is_empty() {
                results.push(FindFileMatch {
                    entry,
                    matched_lines: lines,
                });
            }
        }
        Ok(results)
    }

    async fn get_default_path(&self) -> CoreResult<String> {
        match &self.bucket {
            Some(b) => Ok(entry_path(b, &self.start_prefix)),
            None => Ok("/".to_string()),
        }
    }
}

// ---------------------------------------------------------------------------
// Paths and entries
// ---------------------------------------------------------------------------

fn entry_path(bucket: &str, key: &str) -> String {
    if key.is_empty() {
        format!("/{bucket}")
    } else {
        format!("/{bucket}/{key}")
    }
}

/// "" for the bucket root, otherwise the key with exactly one trailing '/'.
fn dir_prefix(key: &str) -> String {
    let trimmed = key.trim_end_matches('/');
    if trimmed.is_empty() {
        String::new()
    } else {
        format!("{trimmed}/")
    }
}

fn dir_entry(name: &str, path: String) -> FileEntry {
    FileEntry {
        name: name.to_string(),
        path,
        file_type: FileType::Directory,
        size: 0,
        modified_at: None,
        created_at: None,
        permissions: Permissions::default(),
        is_hidden: name.starts_with('.'),
    }
}

fn file_entry(name: &str, path: String, size: u64, modified: Option<DateTime<Utc>>) -> FileEntry {
    FileEntry {
        name: name.to_string(),
        path,
        file_type: FileType::File,
        size,
        modified_at: modified,
        created_at: None,
        permissions: Permissions::default(),
        is_hidden: name.starts_with('.'),
    }
}

fn parse_http_date(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc2822(value.trim())
        .ok()
        .map(|d| d.with_timezone(&Utc))
}

/// Lines of `data` that contain `needle`, formatted like the SFTP driver's
/// content search ("Line N: text"). Binary data yields no matches.
pub(crate) fn grep_content(data: &[u8], needle: &str, case_sensitive: bool) -> Vec<String> {
    if needle.is_empty() || data[..data.len().min(8192)].contains(&0) {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(data);
    let needle_cmp = if case_sensitive {
        needle.to_string()
    } else {
        needle.to_lowercase()
    };
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        let hit = if case_sensitive {
            line.contains(&needle_cmp)
        } else {
            line.to_lowercase().contains(&needle_cmp)
        };
        if hit {
            out.push(format!("Line {}: {}", i + 1, line.trim()));
            if out.len() >= 50 {
                break;
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Endpoint and region
// ---------------------------------------------------------------------------

fn parse_endpoint(raw: &str) -> Result<Endpoint, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("S3 endpoint is empty".into());
    }
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let url = reqwest::Url::parse(&with_scheme)
        .map_err(|e| format!("invalid S3 endpoint '{trimmed}': {e}"))?;
    let scheme = url.scheme().to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err(format!(
            "unsupported S3 endpoint scheme '{scheme}' (use http or https)"
        ));
    }
    let host = url
        .host_str()
        .filter(|h| !h.is_empty())
        .ok_or_else(|| format!("S3 endpoint '{trimmed}' has no host"))?
        .to_ascii_lowercase();
    let base_path = url.path().trim_end_matches('/').to_string();
    let aws = parse_aws_host(&host);
    Ok(Endpoint {
        scheme,
        host,
        port: url.port(),
        base_path,
        aws,
    })
}

/// Parses `s3.amazonaws.com`, `s3.<region>.amazonaws.com`,
/// `<bucket>.s3.<region>.amazonaws.com`, `s3-<region>.amazonaws.com`,
/// dual-stack and China (`.amazonaws.com.cn`) host names.
fn parse_aws_host(host: &str) -> Option<AwsHost> {
    let (rest, suffix) = if let Some(r) = host.strip_suffix(".amazonaws.com.cn") {
        (r, "amazonaws.com.cn")
    } else if let Some(r) = host.strip_suffix(".amazonaws.com") {
        (r, "amazonaws.com")
    } else {
        return None;
    };
    let labels: Vec<&str> = rest.split('.').collect();
    let idx = labels
        .iter()
        .rposition(|l| *l == "s3" || l.starts_with("s3-"))?;
    let mut region = None;
    let mut dualstack = false;
    let mut rewritable = true;
    if let Some(legacy) = labels[idx].strip_prefix("s3-") {
        if looks_like_region(legacy) {
            region = Some(legacy.to_string());
        } else if legacy != "external-1" {
            // s3-accelerate, s3-fips, s3-accesspoint, ...
            rewritable = false;
        }
    }
    for label in &labels[idx + 1..] {
        if *label == "dualstack" {
            dualstack = true;
        } else if looks_like_region(label) {
            region = Some(label.to_string());
        } else {
            rewritable = false;
        }
    }
    let bucket = if idx > 0 {
        Some(labels[..idx].join("."))
    } else {
        None
    };
    Some(AwsHost {
        bucket,
        region,
        suffix: suffix.to_string(),
        dualstack,
        rewritable,
    })
}

/// Whether `rest`, the endpoint host after `<bucket>.`, is the service host
/// of a provider whose virtual-hosted addressing puts the bucket in front of
/// it (`<bucket>.nyc3.digitaloceanspaces.com`, `<bucket>.s3.<region>.wasabisys.com`,
/// ...). Any `s3.<domain>` / `s3-<x>.<domain>` service host counts too.
/// Anything else is treated as a path-style server.
fn is_virtual_host_suffix(rest: &str) -> bool {
    const PROVIDER_DOMAINS: &[&str] = &[
        "digitaloceanspaces.com",
        "wasabisys.com",
        "backblazeb2.com",
        "linodeobjects.com",
        "r2.cloudflarestorage.com",
        "storage.googleapis.com",
        "aliyuncs.com",
        "scw.cloud",
        "vultrobjects.com",
        "your-objectstorage.com",
        "myqcloud.com",
        "exo.io",
    ];
    if PROVIDER_DOMAINS
        .iter()
        .any(|d| rest == *d || rest.strip_suffix(d).is_some_and(|head| head.ends_with('.')))
    {
        return true;
    }
    rest.strip_prefix("s3.")
        .or_else(|| rest.strip_prefix("s3-"))
        .is_some_and(|tail| tail.contains('.'))
}

/// `us-east-1`, `eu-central-2`, `us-gov-west-1`, `us-west-004` (Backblaze)...
fn looks_like_region(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    parts.len() >= 3
        && parts.iter().all(|p| {
            !p.is_empty()
                && p.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
        && parts[0].len() == 2
        && parts[0].bytes().all(|b| b.is_ascii_lowercase())
        && parts
            .last()
            .is_some_and(|p| p.bytes().all(|b| b.is_ascii_digit()))
}

/// The signing region: an explicit non-default region wins; otherwise it is
/// derived from the endpoint host, falling back to `us-east-1`.
fn derive_region(configured: &str, ep: &Endpoint) -> String {
    let configured = configured.trim();
    if !configured.is_empty() && configured != DEFAULT_REGION {
        return configured.to_string();
    }
    if let Some(aws) = &ep.aws {
        return aws
            .region
            .clone()
            .unwrap_or_else(|| DEFAULT_REGION.to_string());
    }
    let host = ep.host.as_str();
    if host == "r2.cloudflarestorage.com" || host.ends_with(".r2.cloudflarestorage.com") {
        return "auto".to_string();
    }
    for suffix in [".wasabisys.com", ".backblazeb2.com"] {
        if let Some(rest) = host.strip_suffix(suffix) {
            let labels: Vec<&str> = rest.split('.').collect();
            if let Some(idx) = labels.iter().rposition(|l| *l == "s3") {
                if let Some(region) = labels.get(idx + 1) {
                    if looks_like_region(region) {
                        return region.to_string();
                    }
                }
            }
        }
    }
    DEFAULT_REGION.to_string()
}

// ---------------------------------------------------------------------------
// Signature Version 4
// ---------------------------------------------------------------------------

struct SigningParams<'a> {
    access_key: &'a str,
    secret_key: &'a str,
    region: &'a str,
    service: &'a str,
    /// `YYYYMMDDTHHMMSSZ`
    amz_date: &'a str,
}

/// AWS URI encoding: every byte except `A-Z a-z 0-9 - _ . ~` is
/// percent-encoded (upper-case hex); '/' is kept unless `encode_slash`.
fn uri_encode(input: &str, encode_slash: bool) -> String {
    let mut out = String::with_capacity(input.len() * 3 / 2);
    for &b in input.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            b'/' if !encode_slash => out.push('/'),
            _ => {
                let _ = write!(out, "%{b:02X}");
            }
        }
    }
    out
}

/// Canonical query string: names and values URI-encoded, sorted by name then
/// value, `name=value` joined with '&' (empty values keep the '=').
fn canonical_query_string(params: &[(String, String)]) -> String {
    let mut encoded: Vec<(String, String)> = params
        .iter()
        .map(|(k, v)| (uri_encode(k, true), uri_encode(v, true)))
        .collect();
    encoded.sort();
    encoded
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&")
}

/// Returns (canonical request, signed header list). Header names must be lower-case.
fn canonical_request(
    method: &str,
    canonical_uri: &str,
    canonical_query: &str,
    headers: &BTreeMap<String, String>,
    payload_hash: &str,
) -> (String, String) {
    let mut canonical_headers = String::new();
    for (name, value) in headers {
        canonical_headers.push_str(name);
        canonical_headers.push(':');
        canonical_headers.push_str(&value.split_whitespace().collect::<Vec<_>>().join(" "));
        canonical_headers.push('\n');
    }
    let signed_headers = headers.keys().cloned().collect::<Vec<_>>().join(";");
    (
        format!(
            "{method}\n{canonical_uri}\n{canonical_query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
        ),
        signed_headers,
    )
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC-SHA256 accepts keys of any length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn signing_key(secret_key: &str, date_stamp: &str, region: &str, service: &str) -> Vec<u8> {
    let k_date = hmac_sha256(
        format!("AWS4{secret_key}").as_bytes(),
        date_stamp.as_bytes(),
    );
    let k_region = hmac_sha256(&k_date, region.as_bytes());
    let k_service = hmac_sha256(&k_region, service.as_bytes());
    hmac_sha256(&k_service, b"aws4_request")
}

fn string_to_sign(amz_date: &str, scope: &str, canonical_request: &str) -> String {
    format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        hex_encode(Sha256::digest(canonical_request.as_bytes()))
    )
}

/// The `Authorization` header value for a request.
fn sigv4_authorization(
    params: &SigningParams<'_>,
    method: &str,
    canonical_uri: &str,
    canonical_query: &str,
    headers: &BTreeMap<String, String>,
    payload_hash: &str,
) -> String {
    let date_stamp = params.amz_date.get(..8).unwrap_or(params.amz_date);
    let scope = format!(
        "{date_stamp}/{}/{}/aws4_request",
        params.region, params.service
    );
    let (creq, signed_headers) = canonical_request(
        method,
        canonical_uri,
        canonical_query,
        headers,
        payload_hash,
    );
    let sts = string_to_sign(params.amz_date, &scope, &creq);
    let key = signing_key(params.secret_key, date_stamp, params.region, params.service);
    let signature = hex_encode(hmac_sha256(&key, sts.as_bytes()));
    format!(
        "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
        params.access_key
    )
}

async fn sha256_hex_async(body: &Bytes) -> CoreResult<String> {
    if body.is_empty() {
        return Ok(EMPTY_SHA256.to_string());
    }
    if body.len() < HASH_IN_BLOCKING_THRESHOLD {
        return Ok(hex_encode(Sha256::digest(body)));
    }
    let data = body.clone();
    tokio::task::spawn_blocking(move || hex_encode(Sha256::digest(&data)))
        .await
        .map_err(|e| CoreError::General(e.to_string()))
}

fn insert_header(map: &mut HeaderMap, name: &str, value: &str) -> CoreResult<()> {
    let header_name = HeaderName::from_bytes(name.as_bytes())
        .map_err(|_| CoreError::InvalidPath(format!("invalid HTTP header name '{name}'")))?;
    let header_value = HeaderValue::from_str(value).map_err(|_| {
        CoreError::InvalidPath(format!(
            "S3 request header '{name}' contains invalid characters (check the access key, secret and endpoint for stray control characters)"
        ))
    })?;
    map.insert(header_name, header_value);
    Ok(())
}

fn part_size_for(len: usize) -> usize {
    const MIB: usize = 1024 * 1024;
    let min_for_count = len.div_ceil(MAX_PARTS);
    MIN_PART_SIZE.max(min_for_count.div_ceil(MIB) * MIB)
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

fn map_reqwest_error(e: reqwest::Error) -> CoreError {
    let mut msg = e.to_string();
    let mut source = std::error::Error::source(&e);
    while let Some(s) = source {
        let _ = write!(msg, ": {s}");
        source = s.source();
    }
    if e.is_timeout() {
        CoreError::Timeout(format!("S3 request timed out: {msg}"))
    } else {
        CoreError::ConnectionFailed(format!("S3 request failed: {msg}"))
    }
}

async fn error_from_response(res: reqwest::Response, context: &str) -> CoreError {
    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    s3_error(status, &body, context)
}

/// Maps an S3 error response (status + optional `<Error>` XML) to a CoreError
/// that carries the S3 Code and Message.
fn s3_error(status: StatusCode, body: &str, context: &str) -> CoreError {
    let code = xml_first(body, "Code").map(|c| c.trim().to_string());
    let message = xml_first(body, "Message").map(|m| m.trim().to_string());
    let mut detail = format!(
        "S3 {} {}",
        status.as_u16(),
        status.canonical_reason().unwrap_or("error")
    );
    if let Some(c) = &code {
        let _ = write!(detail, " [{c}]");
    }
    match &message {
        Some(m) => {
            let _ = write!(detail, ": {m}");
        }
        None if code.is_none() && !body.trim().is_empty() => {
            let _ = write!(detail, ": {}", body_snippet(body));
        }
        None => {}
    }
    let _ = write!(detail, " ({context})");

    match code.as_deref() {
        Some("NoSuchKey" | "NoSuchBucket" | "NoSuchUpload" | "NotFound") => {
            CoreError::NotFound(detail)
        }
        Some(
            "InvalidAccessKeyId"
            | "SignatureDoesNotMatch"
            | "AuthorizationHeaderMalformed"
            | "ExpiredToken"
            | "InvalidToken"
            | "TokenRefreshRequired"
            | "InvalidSecurity",
        ) => CoreError::AuthFailed(detail),
        Some("AccessDenied" | "AllAccessDisabled" | "AccountProblem") => {
            CoreError::PermissionDenied(detail)
        }
        _ => match status.as_u16() {
            404 => CoreError::NotFound(detail),
            401 => CoreError::AuthFailed(detail),
            403 => CoreError::PermissionDenied(detail),
            408 | 504 => CoreError::Timeout(detail),
            _ => CoreError::Protocol(detail),
        },
    }
}

/// Some S3 operations (CopyObject, UploadPartCopy, CompleteMultipartUpload)
/// report failure inside a 200 OK body.
fn check_embedded_error(body: &str, context: &str) -> CoreResult<()> {
    if body.contains("<Error>") {
        Err(s3_error(StatusCode::OK, body, context))
    } else {
        Ok(())
    }
}

fn body_snippet(body: &str) -> String {
    let flat = body.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > 200 {
        format!("{}...", flat.chars().take(200).collect::<String>())
    } else {
        flat
    }
}

// ---------------------------------------------------------------------------
// Minimal XML helpers for S3 responses
// ---------------------------------------------------------------------------

/// Raw inner text of every `<tag>...</tag>` (also `<tag attr="..">` and `<tag/>`).
fn xml_blocks<'a>(xml: &'a str, tag: &str) -> Vec<&'a str> {
    let open_plain = format!("<{tag}>");
    let open_attr = format!("<{tag} ");
    let empty = format!("<{tag}/>");
    let close = format!("</{tag}>");
    let mut out = Vec::new();
    let mut pos = 0;
    while pos < xml.len() {
        let rest = &xml[pos..];
        let plain = rest.find(&open_plain).map(|i| (i, open_plain.len(), false));
        let attr = rest.find(&open_attr).and_then(|i| {
            rest[i..]
                .find('>')
                .map(|j| (i, j + 1, rest[i..i + j].ends_with('/')))
        });
        let self_closing = rest.find(&empty).map(|i| (i, empty.len(), true));
        let Some((i, open_len, is_empty)) = [plain, attr, self_closing]
            .into_iter()
            .flatten()
            .min_by_key(|c| c.0)
        else {
            break;
        };
        let content_start = pos + i + open_len;
        if is_empty {
            out.push("");
            pos = content_start;
            continue;
        }
        match xml[content_start..].find(&close) {
            Some(j) => {
                out.push(&xml[content_start..content_start + j]);
                pos = content_start + j + close.len();
            }
            None => break,
        }
    }
    out
}

/// First `<tag>` text, XML-unescaped (not trimmed).
fn xml_first(xml: &str, tag: &str) -> Option<String> {
    xml_blocks(xml, tag).first().map(|s| xml_unescape(s))
}

fn xml_unescape(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        if let Some(end) = after.find(';').filter(|&e| e > 0 && e <= 10) {
            let entity = &after[..end];
            let decoded = match entity {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                _ => {
                    if let Some(hex) = entity
                        .strip_prefix("#x")
                        .or_else(|| entity.strip_prefix("#X"))
                    {
                        u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
                    } else if let Some(dec) = entity.strip_prefix('#') {
                        dec.parse::<u32>().ok().and_then(char::from_u32)
                    } else {
                        None
                    }
                }
            };
            if let Some(c) = decoded {
                out.push(c);
                rest = &after[end + 1..];
                continue;
            }
        }
        out.push('&');
        rest = after;
    }
    out.push_str(rest);
    out
}

fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

/// Decodes `encoding-type=url` values ('+' is a space, `%XX` a byte).
fn url_decode_plus(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
                match hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                    Some(b) => {
                        out.push(b);
                        i += 3;
                    }
                    None => {
                        out.push(b'%');
                        i += 1;
                    }
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8(out).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

fn parse_list_buckets(xml: &str) -> CoreResult<Vec<String>> {
    if !xml.contains("<ListAllMyBucketsResult") {
        return Err(CoreError::Protocol(format!(
            "unexpected S3 ListBuckets response: {}",
            body_snippet(xml)
        )));
    }
    Ok(xml_blocks(xml, "Bucket")
        .into_iter()
        .filter_map(|block| xml_first(block, "Name"))
        .filter(|name| !name.is_empty())
        .collect())
}

fn parse_list_objects(xml: &str) -> CoreResult<ListPage> {
    if !xml.contains("<ListBucketResult") {
        return Err(CoreError::Protocol(format!(
            "unexpected S3 listing response: {}",
            body_snippet(xml)
        )));
    }
    let url_encoded = xml_first(xml, "EncodingType")
        .map(|v| v.trim().eq_ignore_ascii_case("url"))
        .unwrap_or(false);
    let decode = |raw: &str| {
        let s = xml_unescape(raw);
        if url_encoded {
            url_decode_plus(&s)
        } else {
            s
        }
    };

    let mut page = ListPage::default();
    // Only CommonPrefixes/Prefix: the top-level <Prefix> is the folder itself.
    for block in xml_blocks(xml, "CommonPrefixes") {
        for p in xml_blocks(block, "Prefix") {
            page.prefixes.push(decode(p));
        }
    }
    for block in xml_blocks(xml, "Contents") {
        let Some(raw_key) = xml_blocks(block, "Key").into_iter().next() else {
            continue;
        };
        let size = xml_first(block, "Size")
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(0);
        let last_modified = xml_first(block, "LastModified")
            .and_then(|s| DateTime::parse_from_rfc3339(s.trim()).ok())
            .map(|d| d.with_timezone(&Utc));
        page.objects.push(ObjectInfo {
            key: decode(raw_key),
            size,
            last_modified,
        });
    }
    let truncated = xml_first(xml, "IsTruncated")
        .map(|v| v.trim().eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    if truncated {
        match xml_first(xml, "NextContinuationToken").filter(|t| !t.trim().is_empty()) {
            Some(token) => page.next_token = Some(token.trim().to_string()),
            None => {
                return Err(CoreError::Protocol(
                    "S3 listing is truncated but the server sent no NextContinuationToken".into(),
                ))
            }
        }
    }
    Ok(page)
}

#[cfg(test)]
mod tests {
    use super::*;

    const AWS_ACCESS_KEY: &str = "AKIAIOSFODNN7EXAMPLE";
    const AWS_SECRET_KEY: &str = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

    fn headers(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn signature_of(auth: &str) -> &str {
        auth.rsplit("Signature=").next().unwrap()
    }

    fn example_params() -> SigningParams<'static> {
        SigningParams {
            access_key: AWS_ACCESS_KEY,
            secret_key: AWS_SECRET_KEY,
            region: "us-east-1",
            service: "s3",
            amz_date: "20130524T000000Z",
        }
    }

    fn driver(endpoint: &str, bucket: Option<&str>) -> S3Driver {
        S3Driver::new(S3Config {
            endpoint: endpoint.to_string(),
            region: "us-east-1".to_string(),
            access_key: "AK".to_string(),
            secret_key: "SK".to_string(),
            bucket: bucket.map(|b| b.to_string()),
        })
    }

    // AWS documented example "GET Object" (sig-v4-header-based-auth).
    #[test]
    fn sigv4_get_object_example() {
        let h = headers(&[
            ("host", "examplebucket.s3.amazonaws.com"),
            ("range", "bytes=0-9"),
            ("x-amz-content-sha256", EMPTY_SHA256),
            ("x-amz-date", "20130524T000000Z"),
        ]);
        let (creq, signed) = canonical_request("GET", "/test.txt", "", &h, EMPTY_SHA256);
        assert_eq!(signed, "host;range;x-amz-content-sha256;x-amz-date");
        let sts = string_to_sign(
            "20130524T000000Z",
            "20130524/us-east-1/s3/aws4_request",
            &creq,
        );
        assert!(sts.ends_with("7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972"));
        let auth = sigv4_authorization(&example_params(), "GET", "/test.txt", "", &h, EMPTY_SHA256);
        assert_eq!(
            signature_of(&auth),
            "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
        );
        assert!(auth.starts_with(
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, "
        ));
    }

    // AWS documented example "PUT Object".
    #[test]
    fn sigv4_put_object_example() {
        let payload_hash = hex_encode(Sha256::digest(b"Welcome to Amazon S3."));
        assert_eq!(
            payload_hash,
            "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072"
        );
        let uri = format!("/{}", uri_encode("test$file.text", false));
        assert_eq!(uri, "/test%24file.text");
        let h = headers(&[
            ("date", "Fri, 24 May 2013 00:00:00 GMT"),
            ("host", "examplebucket.s3.amazonaws.com"),
            ("x-amz-content-sha256", &payload_hash),
            ("x-amz-date", "20130524T000000Z"),
            ("x-amz-storage-class", "REDUCED_REDUNDANCY"),
        ]);
        let (creq, _) = canonical_request("PUT", &uri, "", &h, &payload_hash);
        assert_eq!(
            hex_encode(Sha256::digest(creq.as_bytes())),
            "9e0e90d9c76de8fa5b200d8c849cd5b8dc7a3be3951ddb7f6a76b4158342019d"
        );
        let auth = sigv4_authorization(&example_params(), "PUT", &uri, "", &h, &payload_hash);
        assert_eq!(
            signature_of(&auth),
            "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd"
        );
    }

    // AWS documented example "GET Bucket Lifecycle" (empty query value).
    #[test]
    fn sigv4_get_bucket_lifecycle_example() {
        let query = canonical_query_string(&[("lifecycle".to_string(), String::new())]);
        assert_eq!(query, "lifecycle=");
        let h = headers(&[
            ("host", "examplebucket.s3.amazonaws.com"),
            ("x-amz-content-sha256", EMPTY_SHA256),
            ("x-amz-date", "20130524T000000Z"),
        ]);
        let auth = sigv4_authorization(&example_params(), "GET", "/", &query, &h, EMPTY_SHA256);
        assert_eq!(
            signature_of(&auth),
            "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543"
        );
    }

    // AWS documented example "Get Bucket (List Objects)".
    #[test]
    fn sigv4_list_objects_example() {
        let query = canonical_query_string(&[
            ("prefix".to_string(), "J".to_string()),
            ("max-keys".to_string(), "2".to_string()),
        ]);
        assert_eq!(query, "max-keys=2&prefix=J");
        let h = headers(&[
            ("host", "examplebucket.s3.amazonaws.com"),
            ("x-amz-content-sha256", EMPTY_SHA256),
            ("x-amz-date", "20130524T000000Z"),
        ]);
        let auth = sigv4_authorization(&example_params(), "GET", "/", &query, &h, EMPTY_SHA256);
        assert_eq!(
            signature_of(&auth),
            "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7"
        );
    }

    // AWS general SigV4 docs: derived signing key example (service iam).
    #[test]
    fn sigv4_signing_key_example() {
        let key = signing_key(
            "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
            "20120215",
            "us-east-1",
            "iam",
        );
        assert_eq!(
            hex_encode(key),
            "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d"
        );
    }

    #[test]
    fn canonical_query_is_sorted_and_encoded() {
        let q = canonical_query_string(&[
            ("list-type".to_string(), "2".to_string()),
            ("prefix".to_string(), "a b/c&d=e+ü".to_string()),
            ("delimiter".to_string(), "/".to_string()),
            ("encoding-type".to_string(), "url".to_string()),
        ]);
        assert_eq!(
            q,
            "delimiter=%2F&encoding-type=url&list-type=2&prefix=a%20b%2Fc%26d%3De%2B%C3%BC"
        );
    }

    #[test]
    fn uri_encode_follows_aws_rules() {
        assert_eq!(uri_encode("A-z_0.9~", false), "A-z_0.9~");
        assert_eq!(uri_encode("a b/c+d", false), "a%20b/c%2Bd");
        assert_eq!(uri_encode("a/b", true), "a%2Fb");
        assert_eq!(uri_encode("q?x#y%z=", false), "q%3Fx%23y%25z%3D");
        assert_eq!(uri_encode("ação", false), "a%C3%A7%C3%A3o");
    }

    #[test]
    fn region_is_derived_from_endpoint() {
        let region =
            |endpoint: &str| derive_region("us-east-1", &parse_endpoint(endpoint).unwrap());
        assert_eq!(region("https://s3.eu-west-1.amazonaws.com"), "eu-west-1");
        assert_eq!(
            region("https://my-bucket.s3.ap-southeast-2.amazonaws.com"),
            "ap-southeast-2"
        );
        assert_eq!(
            region("https://my.dotted.bucket.s3.us-west-2.amazonaws.com"),
            "us-west-2"
        );
        assert_eq!(region("https://s3-us-west-1.amazonaws.com"), "us-west-1");
        assert_eq!(
            region("https://s3.dualstack.eu-central-1.amazonaws.com"),
            "eu-central-1"
        );
        assert_eq!(
            region("https://s3.cn-north-1.amazonaws.com.cn"),
            "cn-north-1"
        );
        assert_eq!(region("https://s3.amazonaws.com"), "us-east-1");
        assert_eq!(region("https://abc123.r2.cloudflarestorage.com"), "auto");
        assert_eq!(
            region("https://s3.eu-central-1.wasabisys.com"),
            "eu-central-1"
        );
        assert_eq!(
            region("https://s3.us-west-004.backblazeb2.com"),
            "us-west-004"
        );
        assert_eq!(region("http://127.0.0.1:9000"), "us-east-1");
        assert_eq!(region("https://minio.example.com"), "us-east-1");
        // An explicit non-default region wins.
        let ep = parse_endpoint("https://s3.eu-west-1.amazonaws.com").unwrap();
        assert_eq!(derive_region("eu-north-1", &ep), "eu-north-1");
    }

    #[test]
    fn virtual_hosted_endpoint_fixes_bucket() {
        let d = driver("https://photos.s3.eu-west-1.amazonaws.com", None);
        assert_eq!(d.bucket.as_deref(), Some("photos"));
        assert!(d.virtual_hosted);
        assert_eq!(d.default_region, "eu-west-1");
        let (_, authority, path) = d.target("photos", "a b.txt", "eu-west-1").unwrap();
        assert_eq!(authority, "photos.s3.eu-west-1.amazonaws.com");
        assert_eq!(path, "/a%20b.txt");
    }

    #[test]
    fn host_starting_with_bucket_name_stays_path_style() {
        // Path-style servers (MinIO, ...) whose host name happens to start
        // with the bucket name keep the bucket in the path.
        for (endpoint, bucket) in [
            ("https://backup.example.com", "backup"),
            ("http://minio.lan:9000", "minio"),
            ("https://storage.example.com", "storage"),
            ("https://backup.s3.lan", "backup"),
        ] {
            let d = driver(endpoint, Some(bucket));
            assert!(!d.virtual_hosted, "{endpoint}");
            let (_, _, path) = d.target(bucket, "dir/f", "us-east-1").unwrap();
            assert_eq!(path, format!("/{bucket}/dir/f"), "{endpoint}");
            let (_, _, root) = d.target(bucket, "", "us-east-1").unwrap();
            assert_eq!(root, format!("/{bucket}"), "{endpoint}");
        }
        // Known virtual-host providers and `s3.` service hosts drop it.
        for endpoint in [
            "https://photos.nyc3.digitaloceanspaces.com",
            "https://photos.s3.eu-central-1.wasabisys.com",
            "https://photos.s3.us-west-004.backblazeb2.com",
            "https://photos.us-east-1.linodeobjects.com",
            "https://photos.abc123.r2.cloudflarestorage.com",
            "https://photos.storage.googleapis.com",
            "https://photos.oss-eu-central-1.aliyuncs.com",
            "https://photos.s3.example.com",
        ] {
            let d = driver(endpoint, Some("photos"));
            assert!(d.virtual_hosted, "{endpoint}");
            let (_, _, path) = d.target("photos", "dir/f", "us-east-1").unwrap();
            assert_eq!(path, "/dir/f", "{endpoint}");
        }
        // A look-alike domain is not a provider.
        assert!(!driver("https://photos.notwasabisys.com", Some("photos")).virtual_hosted);
        assert!(!driver("https://photos.example.com", Some("photos")).virtual_hosted);
    }

    #[test]
    fn target_encodes_key_and_keeps_port() {
        let d = driver("http://127.0.0.1:9000", None);
        let (scheme, authority, path) = d.target("bkt", "dir/a b?c#d.txt", "us-east-1").unwrap();
        assert_eq!(scheme, "http");
        assert_eq!(authority, "127.0.0.1:9000");
        assert_eq!(path, "/bkt/dir/a%20b%3Fc%23d.txt");
        let (_, _, root) = d.target("", "", "us-east-1").unwrap();
        assert_eq!(root, "/");
        let (_, _, bucket_root) = d.target("bkt", "", "us-east-1").unwrap();
        assert_eq!(bucket_root, "/bkt");
        assert!(d.target("bkt", "a/../b", "us-east-1").is_err());
        assert!(d.target("bkt", "./b", "us-east-1").is_err());
    }

    #[test]
    fn aws_global_endpoint_is_rewritten_for_other_regions() {
        let d = driver("https://s3.amazonaws.com", None);
        let ep = d.endpoint().unwrap().clone();
        assert_eq!(d.authority(&ep, "us-east-1"), "s3.amazonaws.com");
        assert_eq!(d.authority(&ep, "eu-west-1"), "s3.eu-west-1.amazonaws.com");
        let minio = driver("http://localhost:9000", None);
        let ep = minio.endpoint().unwrap().clone();
        assert_eq!(minio.authority(&ep, "eu-west-1"), "localhost:9000");
    }

    #[test]
    fn configured_bucket_paths_round_trip() {
        let d = driver("https://minio.example.com", Some("my-bucket"));
        assert!(!d.virtual_hosted);
        let default_path = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(d.get_default_path())
            .unwrap();
        assert_eq!(default_path, "/my-bucket");
        assert_eq!(d.split_path(&default_path), ("my-bucket".into(), "".into()));
        assert_eq!(d.split_path("/"), ("my-bucket".into(), "".into()));
        // list_dir builds entry paths with entry_path(): they must split back.
        let folder = entry_path("my-bucket", "photos");
        assert_eq!(folder, "/my-bucket/photos");
        assert_eq!(d.split_path(&folder), ("my-bucket".into(), "photos".into()));
        assert_eq!(dir_prefix(&d.split_path(&folder).1), "photos/");
        let file = entry_path("my-bucket", "photos/2024/a.jpg");
        assert_eq!(
            d.split_path(&file),
            ("my-bucket".into(), "photos/2024/a.jpg".into())
        );
        // A path without the bucket prefix is relative to the bucket.
        assert_eq!(
            d.split_path("/docs/x"),
            ("my-bucket".into(), "docs/x".into())
        );
    }

    #[test]
    fn configured_bucket_with_folder_opens_folder() {
        let d = driver("https://minio.example.com", Some("/data/projects/2024/"));
        assert_eq!(d.bucket.as_deref(), Some("data"));
        let default_path = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(d.get_default_path())
            .unwrap();
        assert_eq!(default_path, "/data/projects/2024");
        assert_eq!(
            d.split_path(&default_path),
            ("data".into(), "projects/2024".into())
        );
    }

    #[test]
    fn bucketless_paths_split_into_bucket_and_key() {
        let d = driver("https://minio.example.com", None);
        assert_eq!(d.split_path("/"), ("".into(), "".into()));
        assert_eq!(d.split_path("/b"), ("b".into(), "".into()));
        assert_eq!(d.split_path("/b/"), ("b".into(), "".into()));
        assert_eq!(d.split_path("/b/k/x.txt"), ("b".into(), "k/x.txt".into()));
        assert_eq!(d.split_path("/b//abs"), ("b".into(), "/abs".into()));
    }

    #[test]
    fn list_objects_parser_handles_prefixes_escaping_and_pagination() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>bkt</Name><Prefix>photos%2F</Prefix><KeyCount>4</KeyCount><MaxKeys>1000</MaxKeys>
  <Delimiter>%2F</Delimiter><EncodingType>url</EncodingType><IsTruncated>true</IsTruncated>
  <NextContinuationToken>1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=</NextContinuationToken>
  <Contents><Key>photos%2F</Key><LastModified>2024-01-02T03:04:05.000Z</LastModified><Size>0</Size></Contents>
  <Contents><Key>photos%2Fa+b%26c%2B1.txt</Key><LastModified>2024-01-02T03:04:05.000Z</LastModified><ETag>&quot;abc&quot;</ETag><Size>1234</Size><StorageClass>STANDARD</StorageClass></Contents>
  <CommonPrefixes><Prefix>photos%2F2024%2F</Prefix></CommonPrefixes>
  <CommonPrefixes><Prefix>photos%2F%C3%A1lbum%2F</Prefix></CommonPrefixes>
</ListBucketResult>"#;
        let page = parse_list_objects(xml).unwrap();
        assert_eq!(page.prefixes, vec!["photos/2024/", "photos/álbum/"]);
        assert_eq!(page.objects.len(), 2);
        assert_eq!(page.objects[0].key, "photos/");
        assert_eq!(page.objects[1].key, "photos/a b&c+1.txt");
        assert_eq!(page.objects[1].size, 1234);
        assert!(page.objects[1].last_modified.is_some());
        assert_eq!(
            page.next_token.as_deref(),
            Some("1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=")
        );
    }

    #[test]
    fn list_objects_parser_unescapes_xml_without_url_encoding() {
        let xml = "<ListBucketResult><Prefix></Prefix><IsTruncated>false</IsTruncated>\
                   <Contents><Key>a&amp;b &lt;1&gt;.txt</Key><Size>5</Size></Contents>\
                   <CommonPrefixes><Prefix>100%/</Prefix></CommonPrefixes></ListBucketResult>";
        let page = parse_list_objects(xml).unwrap();
        assert_eq!(page.objects[0].key, "a&b <1>.txt");
        assert_eq!(page.prefixes, vec!["100%/"]);
        assert!(page.next_token.is_none());
    }

    #[test]
    fn list_objects_parser_rejects_error_documents() {
        let xml = "<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>";
        assert!(parse_list_objects(xml).is_err());
        let truncated = "<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>";
        assert!(parse_list_objects(truncated).is_err());
    }

    #[test]
    fn list_buckets_parser() {
        let xml = "<ListAllMyBucketsResult><Owner><ID>x</ID></Owner><Buckets>\
                   <Bucket><Name>alpha</Name><CreationDate>2024-01-01T00:00:00.000Z</CreationDate></Bucket>\
                   <Bucket><Name>beta</Name></Bucket></Buckets></ListAllMyBucketsResult>";
        assert_eq!(parse_list_buckets(xml).unwrap(), vec!["alpha", "beta"]);
    }

    #[test]
    fn s3_errors_carry_code_and_message() {
        let body = "<?xml version=\"1.0\"?><Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message><Key>a.txt</Key></Error>";
        match s3_error(StatusCode::NOT_FOUND, body, "GET /b/a.txt") {
            CoreError::NotFound(msg) => {
                assert!(msg.contains("NoSuchKey"));
                assert!(msg.contains("The specified key does not exist."));
            }
            other => panic!("unexpected {other:?}"),
        }
        let denied = "<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>";
        assert!(matches!(
            s3_error(StatusCode::FORBIDDEN, denied, "PUT"),
            CoreError::PermissionDenied(_)
        ));
        let sig = "<Error><Code>SignatureDoesNotMatch</Code><Message>bad</Message></Error>";
        assert!(matches!(
            s3_error(StatusCode::FORBIDDEN, sig, "PUT"),
            CoreError::AuthFailed(_)
        ));
        assert!(matches!(
            s3_error(StatusCode::NOT_FOUND, "", "HEAD"),
            CoreError::NotFound(_)
        ));
        assert!(matches!(
            s3_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "<html>oops</html>",
                "GET"
            ),
            CoreError::Protocol(_)
        ));
        assert!(check_embedded_error(denied, "CopyObject").is_err());
        assert!(check_embedded_error(
            "<CopyObjectResult><ETag>x</ETag></CopyObjectResult>",
            "CopyObject"
        )
        .is_ok());
    }

    #[test]
    fn xml_helpers() {
        assert_eq!(
            xml_unescape("&lt;a&gt; &amp; &#38; &#x26; &quot;&apos; &bogus; &"),
            "<a> & & & \"' &bogus; &"
        );
        assert_eq!(xml_escape("<a&\"b\">"), "&lt;a&amp;&quot;b&quot;&gt;");
        assert_eq!(
            xml_first("<KeyCount>2</KeyCount><Key>k</Key>", "Key").as_deref(),
            Some("k")
        );
        assert_eq!(
            xml_blocks("<Prefix/><Prefix>x</Prefix>", "Prefix"),
            vec!["", "x"]
        );
        assert_eq!(url_decode_plus("a+b%2Bc%zz%C3%A9"), "a b+c%zzé");
    }

    #[test]
    fn multipart_part_size_respects_limits() {
        assert_eq!(part_size_for(100 * 1024 * 1024), MIN_PART_SIZE);
        let huge = 400usize * 1024 * 1024 * 1024; // 400 GiB
        let size = part_size_for(huge);
        assert!(huge.div_ceil(size) <= MAX_PARTS);
        assert_eq!(size % (1024 * 1024), 0);
    }

    #[test]
    fn grep_content_formats_lines_and_skips_binary() {
        let lines = grep_content(b"alpha\nBeta gamma\nbeta\n", "beta", false);
        assert_eq!(lines, vec!["Line 2: Beta gamma", "Line 3: beta"]);
        assert_eq!(
            grep_content(b"alpha\nBeta\n", "beta", true),
            Vec::<String>::new()
        );
        assert!(grep_content(b"beta\0binary", "beta", false).is_empty());
    }

    #[tokio::test]
    async fn zero_length_range_needs_no_request() {
        // The endpoint is unreachable: a request would fail.
        let d = driver("http://127.0.0.1:1", Some("b"));
        assert!(d.read_range("/b/x", 10, 0).await.unwrap().is_empty());
    }

    #[test]
    fn debug_output_redacts_secret() {
        let d = driver("https://s3.amazonaws.com", None);
        let dbg = format!("{d:?}");
        assert!(dbg.contains("<redacted>"));
        assert!(!dbg.contains("\"SK\""));
    }
}

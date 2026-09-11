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
use reqwest::header::{HeaderMap, HeaderValue};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone)]
pub struct S3Config {
    pub endpoint: String,
    pub region: String,
    pub access_key: String,
    pub secret_key: String,
    pub bucket: Option<String>,
}

#[derive(Debug, Clone)]
pub struct S3Driver {
    config: S3Config,
    client: reqwest::Client,
}

impl S3Driver {
    pub fn new(config: S3Config) -> Self {
        Self {
            config,
            client: reqwest::Client::new(),
        }
    }

    /// Signs an AWS SigV4 request
    fn sign_request(
        &self,
        method: &str,
        canonical_uri: &str,
        query_params: &str,
        headers: &mut HeaderMap,
        payload_hash: &str,
    ) -> CoreResult<()> {
        let now = Utc::now();
        let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
        let date_stamp = now.format("%Y%m%d").to_string();

        headers.insert("x-amz-date", HeaderValue::from_str(&amz_date).unwrap());
        headers.insert(
            "x-amz-content-sha256",
            HeaderValue::from_str(payload_hash).unwrap(),
        );

        let endpoint_url = reqwest::Url::parse(&self.config.endpoint)
            .map_err(|e| CoreError::InvalidPath(e.to_string()))?;
        let host = endpoint_url.host_str().unwrap_or("s3.amazonaws.com");
        headers.insert("host", HeaderValue::from_str(host).unwrap());

        let signed_headers = "host;x-amz-content-sha256;x-amz-date";
        let canonical_headers = format!(
            "host:{}\nx-amz-content-sha256:{}\nx-amz-date:{}\n",
            host, payload_hash, amz_date
        );

        let canonical_request = format!(
            "{}\n{}\n{}\n{}\n{}\n{}",
            method, canonical_uri, query_params, canonical_headers, signed_headers, payload_hash
        );

        let canonical_req_hash = hex_encode(Sha256::digest(canonical_request.as_bytes()));
        let credential_scope = format!("{}/{}/s3/aws4_request", date_stamp, self.config.region);
        let string_to_sign = format!(
            "AWS4-HMAC-SHA256\n{}\n{}\n{}",
            amz_date, credential_scope, canonical_req_hash
        );

        // Derive signing key
        let k_secret = Vec::from(format!("AWS4{}", self.config.secret_key).as_bytes());
        let mut mac = HmacSha256::new_from_slice(&k_secret).unwrap();
        mac.update(date_stamp.as_bytes());
        let k_date = mac.finalize().into_bytes();

        let mut mac = HmacSha256::new_from_slice(&k_date).unwrap();
        mac.update(self.config.region.as_bytes());
        let k_region = mac.finalize().into_bytes();

        let mut mac = HmacSha256::new_from_slice(&k_region).unwrap();
        mac.update(b"s3");
        let k_service = mac.finalize().into_bytes();

        let mut mac = HmacSha256::new_from_slice(&k_service).unwrap();
        mac.update(b"aws4_request");
        let k_signing = mac.finalize().into_bytes();

        let mut mac = HmacSha256::new_from_slice(&k_signing).unwrap();
        mac.update(string_to_sign.as_bytes());
        let signature = hex_encode(mac.finalize().into_bytes());

        let auth_header = format!(
            "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
            self.config.access_key, credential_scope, signed_headers, signature
        );

        headers.insert(
            "authorization",
            HeaderValue::from_str(&auth_header).unwrap(),
        );

        Ok(())
    }

    fn split_path(&self, path: &str) -> (String, String) {
        let clean = path.trim_start_matches('/');
        if let Some(bucket) = &self.config.bucket {
            (bucket.clone(), clean.to_string())
        } else {
            let mut parts = clean.splitn(2, '/');
            let bucket = parts.next().unwrap_or("").to_string();
            let key = parts.next().unwrap_or("").to_string();
            (bucket, key)
        }
    }
}

#[async_trait]
impl VirtualFileSystem for S3Driver {
    fn protocol(&self) -> Protocol {
        Protocol::S3
    }

    async fn list_dir(&self, path: &str) -> CoreResult<Vec<FileEntry>> {
        let (bucket, prefix) = self.split_path(path);

        if bucket.is_empty() {
            // List buckets at root
            let uri = "/";
            let mut headers = HeaderMap::new();
            let empty_hash = hex_encode(Sha256::digest(b""));
            self.sign_request("GET", uri, "", &mut headers, &empty_hash)?;

            let url = format!("{}/", self.config.endpoint);
            let res = self
                .client
                .get(&url)
                .headers(headers)
                .send()
                .await
                .map_err(|e| CoreError::ConnectionFailed(e.to_string()))?;

            let text = res.text().await.unwrap_or_default();
            let mut entries = Vec::new();

            // Simple XML tag parser for <Bucket><Name>...</Name></Bucket>
            for part in text.split("<Bucket>") {
                if let Some(name_start) = part.find("<Name>") {
                    if let Some(name_end) = part.find("</Name>") {
                        let name = &part[name_start + 6..name_end];
                        entries.push(FileEntry {
                            name: name.to_string(),
                            path: format!("/{}", name),
                            file_type: FileType::Directory,
                            size: 0,
                            modified_at: None,
                            created_at: None,
                            permissions: Permissions::default(),
                            is_hidden: false,
                        });
                    }
                }
            }
            return Ok(entries);
        }

        // List objects with prefix inside bucket
        let norm_prefix = if prefix.is_empty() || prefix.ends_with('/') {
            prefix.clone()
        } else {
            format!("{}/", prefix)
        };

        let query = format!(
            "list-type=2&delimiter=%2F&prefix={}",
            urlencoding(&norm_prefix)
        );
        let uri = format!("/{}", bucket);
        let mut headers = HeaderMap::new();
        let empty_hash = hex_encode(Sha256::digest(b""));
        self.sign_request("GET", &uri, &query, &mut headers, &empty_hash)?;

        let url = format!("{}/{}?{}", self.config.endpoint, bucket, query);
        let res = self
            .client
            .get(&url)
            .headers(headers)
            .send()
            .await
            .map_err(|e| CoreError::ConnectionFailed(e.to_string()))?;

        let text = res.text().await.unwrap_or_default();
        let mut entries = Vec::new();

        // Parse CommonPrefixes (Folders)
        for part in text.split("<CommonPrefixes>") {
            if let Some(p_start) = part.find("<Prefix>") {
                if let Some(p_end) = part.find("</Prefix>") {
                    let folder_prefix = &part[p_start + 8..p_end];
                    let folder_name = folder_prefix
                        .trim_end_matches('/')
                        .split('/')
                        .last()
                        .unwrap_or(folder_prefix);

                    entries.push(FileEntry {
                        name: folder_name.to_string(),
                        path: format!("/{}/{}", bucket, folder_prefix.trim_end_matches('/')),
                        file_type: FileType::Directory,
                        size: 0,
                        modified_at: None,
                        created_at: None,
                        permissions: Permissions::default(),
                        is_hidden: folder_name.starts_with('.'),
                    });
                }
            }
        }

        // Parse Contents (Files)
        for part in text.split("<Contents>") {
            if let Some(k_start) = part.find("<Key>") {
                if let Some(k_end) = part.find("</Key>") {
                    let key = &part[k_start + 5..k_end];
                    if key == norm_prefix {
                        continue; // Skip the directory placeholder itself
                    }
                    let filename = key.split('/').last().unwrap_or(key);

                    let size = if let Some(s_start) = part.find("<Size>") {
                        if let Some(s_end) = part.find("</Size>") {
                            part[s_start + 6..s_end].parse::<u64>().unwrap_or(0)
                        } else {
                            0
                        }
                    } else {
                        0
                    };

                    let modified_at = if let Some(m_start) = part.find("<LastModified>") {
                        if let Some(m_end) = part.find("</LastModified>") {
                            let date_str = &part[m_start + 14..m_end];
                            DateTime::parse_from_rfc3339(date_str)
                                .ok()
                                .map(|dt| dt.with_timezone(&Utc))
                        } else {
                            None
                        }
                    } else {
                        None
                    };

                    entries.push(FileEntry {
                        name: filename.to_string(),
                        path: format!("/{}/{}", bucket, key),
                        file_type: FileType::File,
                        size,
                        modified_at,
                        created_at: None,
                        permissions: Permissions::default(),
                        is_hidden: filename.starts_with('.'),
                    });
                }
            }
        }

        // Sort dirs first, then alphabetical
        entries.sort_by(|a, b| match (a.is_dir(), b.is_dir()) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });

        Ok(entries)
    }

    async fn metadata(&self, path: &str) -> CoreResult<FileEntry> {
        let (bucket, key) = self.split_path(path);
        let uri = format!("/{}/{}", bucket, key);
        let mut headers = HeaderMap::new();
        let empty_hash = hex_encode(Sha256::digest(b""));
        self.sign_request("HEAD", &uri, "", &mut headers, &empty_hash)?;

        let url = format!("{}{}", self.config.endpoint, uri);
        let res = self
            .client
            .head(&url)
            .headers(headers)
            .send()
            .await
            .map_err(|e| CoreError::NotFound(e.to_string()))?;

        let size = res.content_length().unwrap_or(0);
        let name = key.split('/').last().unwrap_or(&key).to_string();

        Ok(FileEntry {
            name,
            path: path.to_string(),
            file_type: FileType::File,
            size,
            modified_at: Some(Utc::now()),
            created_at: None,
            permissions: Permissions::default(),
            is_hidden: false,
        })
    }

    async fn read_file(&self, path: &str) -> CoreResult<Bytes> {
        let (bucket, key) = self.split_path(path);
        let uri = format!("/{}/{}", bucket, key);
        let mut headers = HeaderMap::new();
        let empty_hash = hex_encode(Sha256::digest(b""));
        self.sign_request("GET", &uri, "", &mut headers, &empty_hash)?;

        let url = format!("{}{}", self.config.endpoint, uri);
        let res = self
            .client
            .get(&url)
            .headers(headers)
            .send()
            .await
            .map_err(|e| CoreError::NotFound(e.to_string()))?;

        let data = res
            .bytes()
            .await
            .map_err(|e| CoreError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?;
        Ok(data)
    }

    async fn read_range(&self, path: &str, offset: u64, length: u64) -> CoreResult<Bytes> {
        let (bucket, key) = self.split_path(path);
        let uri = format!("/{}/{}", bucket, key);
        let mut headers = HeaderMap::new();
        let empty_hash = hex_encode(Sha256::digest(b""));

        let range_val = format!("bytes={}-{}", offset, offset + length - 1);
        headers.insert("range", HeaderValue::from_str(&range_val).unwrap());
        self.sign_request("GET", &uri, "", &mut headers, &empty_hash)?;

        let url = format!("{}{}", self.config.endpoint, uri);
        let res = self
            .client
            .get(&url)
            .headers(headers)
            .send()
            .await
            .map_err(|e| CoreError::NotFound(e.to_string()))?;

        let data = res
            .bytes()
            .await
            .map_err(|e| CoreError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?;
        Ok(data)
    }

    async fn write_file(&self, path: &str, data: Bytes) -> CoreResult<()> {
        let (bucket, key) = self.split_path(path);
        let uri = format!("/{}/{}", bucket, key);
        let mut headers = HeaderMap::new();
        let payload_hash = hex_encode(Sha256::digest(&data));
        headers.insert("content-length", HeaderValue::from(data.len()));
        self.sign_request("PUT", &uri, "", &mut headers, &payload_hash)?;

        let url = format!("{}{}", self.config.endpoint, uri);
        let _ = self
            .client
            .put(&url)
            .headers(headers)
            .body(data)
            .send()
            .await
            .map_err(|e| CoreError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?;

        Ok(())
    }

    async fn create_dir(&self, path: &str) -> CoreResult<()> {
        let (bucket, key) = self.split_path(path);
        let dir_key = if key.ends_with('/') {
            key
        } else {
            format!("{}/", key)
        };
        let uri = format!("/{}/{}", bucket, dir_key);
        let mut headers = HeaderMap::new();
        let empty_hash = hex_encode(Sha256::digest(b""));
        headers.insert("content-length", HeaderValue::from(0));
        self.sign_request("PUT", &uri, "", &mut headers, &empty_hash)?;

        let url = format!("{}{}", self.config.endpoint, uri);
        let _ = self
            .client
            .put(&url)
            .headers(headers)
            .send()
            .await
            .map_err(|e| CoreError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?;

        Ok(())
    }

    async fn remove_file(&self, path: &str) -> CoreResult<()> {
        let (bucket, key) = self.split_path(path);
        let uri = format!("/{}/{}", bucket, key);
        let mut headers = HeaderMap::new();
        let empty_hash = hex_encode(Sha256::digest(b""));
        self.sign_request("DELETE", &uri, "", &mut headers, &empty_hash)?;

        let url = format!("{}{}", self.config.endpoint, uri);
        let _ = self
            .client
            .delete(&url)
            .headers(headers)
            .send()
            .await
            .map_err(|e| CoreError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?;

        Ok(())
    }

    async fn remove_dir(&self, path: &str, _recursive: bool) -> CoreResult<()> {
        self.remove_file(path).await
    }

    async fn rename(&self, from: &str, to: &str) -> CoreResult<()> {
        // In S3, rename is CopyObject + DeleteObject
        let data = self.read_file(from).await?;
        self.write_file(to, data).await?;
        self.remove_file(from).await?;
        Ok(())
    }

    async fn set_permissions(&self, _path: &str, _mode: u32) -> CoreResult<()> {
        // S3 does not have Unix octal permissions (handled via ACL or Bucket Policies)
        Ok(())
    }

    async fn exists(&self, path: &str) -> CoreResult<bool> {
        Ok(self.metadata(path).await.is_ok())
    }

    async fn search(
        &self,
        root_path: &str,
        pattern: &str,
        max_results: usize,
    ) -> CoreResult<Vec<FileEntry>> {
        let files = self.list_dir(root_path).await?;
        let pat_lower = pattern.to_lowercase();
        Ok(files
            .into_iter()
            .filter(|f| f.name.to_lowercase().contains(&pat_lower))
            .take(max_results)
            .collect())
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
        Ok(FileSystemInfo {
            path: path.to_string(),
            total_bytes: 10_000_000_000_000,
            free_bytes: 10_000_000_000_000,
            available_bytes: 10_000_000_000_000,
            used_bytes: 0,
            total_inodes: None,
            free_inodes: None,
            protocol_name: "Amazon S3 / Compatible Object Storage".to_string(),
            protocol_version: "AWS SigV4".to_string(),
            host_key_fingerprint_sha256: None,
            host_key_fingerprint_md5: None,
            cipher_name: Some("TLS 1.3 / HTTPS".to_string()),
            compression_name: None,
        })
    }

    async fn calculate_size(&self, path: &str) -> CoreResult<u64> {
        let files = self.list_dir(path).await?;
        Ok(files.iter().map(|f| f.size).sum())
    }

    async fn find_files(&self, query: &FindFileQuery) -> CoreResult<Vec<FindFileMatch>> {
        let mask_filter = crate::file_masks::FileMaskFilter::new(&query.mask);
        let files = self.list_dir(&query.base_path).await?;
        let mut results = Vec::new();
        for f in files {
            if mask_filter.matches(&f.name, f.is_dir()) {
                results.push(FindFileMatch {
                    entry: f,
                    matched_lines: vec![],
                });
                if results.len() >= query.max_results {
                    break;
                }
            }
        }
        Ok(results)
    }

    async fn get_default_path(&self) -> CoreResult<String> {
        if let Some(b) = &self.config.bucket {
            return Ok(format!("/{}", b));
        }
        Ok("/".to_string())
    }
}

fn urlencoding(input: &str) -> String {
    input.replace('/', "%2F").replace(' ', "%20")
}

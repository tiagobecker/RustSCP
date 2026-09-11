use crate::disk_cache::ManagedDiskCache;
use crate::types::{CoreError, CoreResult, FileEntry};
use crate::vfs::VirtualFileSystem;
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VirtualDiskInfo {
    pub session_id: String,
    pub session_name: String,
    pub mount_point: String,
    pub mount_root: String,
    pub port: u16,
    pub is_mounted: bool,
    pub read_bytes: u64,
    pub write_bytes: u64,
    pub shortcut_path: Option<String>,
}

pub struct WebDavServer {
    session_id: String,
    session_name: String,
    mount_root: String,
    vfs: Arc<dyn VirtualFileSystem>,
    cache: Arc<ManagedDiskCache>,
    port: u16,
    is_running: Arc<AtomicBool>,
    cancel_tx: Option<broadcast::Sender<()>>,
    mount_point: Option<String>,
    shortcut_path: Option<String>,
    read_bytes: Arc<AtomicU64>,
    write_bytes: Arc<AtomicU64>,
}

impl WebDavServer {
    pub fn new(
        session_id: String,
        session_name: String,
        mount_root: String,
        vfs: Arc<dyn VirtualFileSystem>,
        cache: Arc<ManagedDiskCache>,
    ) -> Self {
        Self {
            session_id,
            session_name,
            mount_root,
            vfs,
            cache,
            port: 0,
            is_running: Arc::new(AtomicBool::new(false)),
            cancel_tx: None,
            mount_point: None,
            shortcut_path: None,
            read_bytes: Arc::new(AtomicU64::new(0)),
            write_bytes: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn is_active(&self) -> bool {
        self.is_running.load(Ordering::SeqCst)
    }

    pub fn mount_point(&self) -> Option<&String> {
        self.mount_point.as_ref()
    }

    pub fn shortcut_path(&self) -> Option<&String> {
        self.shortcut_path.as_ref()
    }

    pub fn mount_root(&self) -> &str {
        &self.mount_root
    }

    /// Starts the embedded WebDAV server on a local loopback port
    pub async fn start(&mut self) -> CoreResult<u16> {
        if self.is_active() {
            return Ok(self.port);
        }

        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| CoreError::General(format!("Failed to bind WebDAV listener: {}", e)))?;

        let local_addr = listener
            .local_addr()
            .map_err(|e| CoreError::General(format!("Failed to get local address: {}", e)))?;

        self.port = local_addr.port();
        let (cancel_tx, mut cancel_rx) = broadcast::channel::<()>(1);
        self.cancel_tx = Some(cancel_tx);
        self.is_running.store(true, Ordering::SeqCst);

        let vfs = self.vfs.clone();
        let cache = self.cache.clone();
        let is_running = self.is_running.clone();
        let session_id = self.session_id.clone();
        let mount_root = self.mount_root.clone();
        let read_bytes = self.read_bytes.clone();
        let write_bytes = self.write_bytes.clone();

        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = cancel_rx.recv() => {
                        break;
                    }
                    res = listener.accept() => {
                        match res {
                            Ok((stream, _)) => {
                                let vfs_clone = vfs.clone();
                                let cache_clone = cache.clone();
                                let sess_id_clone = session_id.clone();
                                let root_clone = mount_root.clone();
                                let r_bytes = read_bytes.clone();
                                let w_bytes = write_bytes.clone();
                                tokio::spawn(async move {
                                    let _ = handle_persistent_connection(
                                        stream,
                                        sess_id_clone,
                                        root_clone,
                                        vfs_clone,
                                        cache_clone,
                                        r_bytes,
                                        w_bytes,
                                    ).await;
                                });
                            }
                            Err(_) => {
                                if !is_running.load(Ordering::SeqCst) {
                                    break;
                                }
                            }
                        }
                    }
                }
            }
            is_running.store(false, Ordering::SeqCst);
        });

        Ok(self.port)
    }

    /// Mounts the WebDAV server as a native OS virtual disk with the connection name
    pub async fn mount_in_os(&mut self) -> CoreResult<String> {
        if !self.is_active() {
            self.start().await?;
        }

        let clean_name = self.session_name.replace(|c: char| !c.is_alphanumeric() && c != '_' && c != '-', "_");
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_else(|_| ".".to_string());
        let home_path = std::path::PathBuf::from(home);

        #[cfg(target_os = "macos")]
        {
            let base_disks = home_path.join(".rustscp").join("disks");
            let _ = tokio::fs::create_dir_all(&base_disks).await;
            let mnt_dir = base_disks.join(&clean_name);
            let mnt_str = mnt_dir.to_string_lossy().to_string();

            // Force unmount any stale mount at this path first
            let _ = tokio::process::Command::new("diskutil")
                .args(["unmount", "force", &mnt_str])
                .output()
                .await;

            let _ = tokio::fs::create_dir_all(&mnt_dir).await;

            let mount_url = format!("http://127.0.0.1:{}/", self.port);
            let out = tokio::process::Command::new("/sbin/mount_webdav")
                .args(["-v", &self.session_name, &mount_url, &mnt_str])
                .output()
                .await
                .map_err(|e| CoreError::General(format!("Failed to execute mount_webdav: {}", e)))?;

            if !out.status.success() {
                let stderr = String::from_utf8_lossy(&out.stderr);
                return Err(CoreError::General(format!(
                    "mount_webdav failed (exit code {:?}): {}",
                    out.status.code(),
                    stderr
                )));
            }

            self.mount_point = Some(mnt_str.clone());

            // Create Desktop Shortcut pointing to the mounted disk
            let desktop = home_path.join("Desktop");
            if tokio::fs::try_exists(&desktop).await.unwrap_or(false) {
                let shortcut = desktop.join(&self.session_name);
                let _ = tokio::fs::remove_file(&shortcut).await;
                #[cfg(unix)]
                {
                    if let Ok(_) = tokio::fs::symlink(&mnt_dir, &shortcut).await {
                        self.shortcut_path = Some(shortcut.to_string_lossy().to_string());
                    }
                }
            }

            return Ok(mnt_str);
        }

        #[cfg(target_os = "windows")]
        {
            let mount_url = format!("http://127.0.0.1:{}/", self.port);
            let out = tokio::process::Command::new("net")
                .args(["use", "*", &mount_url, "/persistent:no"])
                .output()
                .await
                .map_err(|e| CoreError::General(format!("Failed to mount on Windows: {}", e)))?;

            let stdout = String::from_utf8_lossy(&out.stdout);
            let drive = stdout
                .lines()
                .find(|l| l.contains("Drive") || l.contains("Unidade"))
                .and_then(|l| l.split_whitespace().last())
                .unwrap_or("Z:")
                .to_string();

            self.mount_point = Some(drive.clone());

            // Set label via PowerShell Shell.Application
            let ps_script = format!(
                "(New-Object -ComObject Shell.Application).NameSpace('{}\\\\').Self.Name = '{}'",
                drive.trim_end_matches('\\'),
                self.session_name
            );
            let _ = tokio::process::Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", &ps_script])
                .output()
                .await;

            // Desktop shortcut on Windows
            let desktop = home_path.join("Desktop");
            if tokio::fs::try_exists(&desktop).await.unwrap_or(false) {
                let shortcut_name = format!("{}.lnk", self.session_name);
                let shortcut_path = desktop.join(&shortcut_name);
                let ps_shortcut = format!(
                    "$WshShell = New-Object -ComObject WScript.Shell; $Shortcut = $WshShell.CreateShortcut('{}'); $Shortcut.TargetPath = '{}\\\\'; $Shortcut.Save()",
                    shortcut_path.to_string_lossy(),
                    drive.trim_end_matches('\\')
                );
                let _ = tokio::process::Command::new("powershell")
                    .args(["-NoProfile", "-NonInteractive", "-Command", &ps_shortcut])
                    .output()
                    .await;
                self.shortcut_path = Some(shortcut_path.to_string_lossy().to_string());
            }

            return Ok(drive);
        }

        #[cfg(target_os = "linux")]
        {
            let mount_url = format!("dav://127.0.0.1:{}/", self.port);
            let _ = tokio::process::Command::new("gio")
                .args(["mount", &mount_url])
                .output()
                .await;

            let path = format!("/run/user/{}/gvfs/dav:host=127.0.0.1,port={}", whoami_uid(), self.port);
            self.mount_point = Some(path.clone());

            // Desktop shortcut on Linux
            let desktop = home_path.join("Desktop");
            if tokio::fs::try_exists(&desktop).await.unwrap_or(false) {
                let shortcut = desktop.join(&self.session_name);
                let _ = tokio::fs::remove_file(&shortcut).await;
                #[cfg(unix)]
                {
                    if let Ok(_) = tokio::fs::symlink(&path, &shortcut).await {
                        self.shortcut_path = Some(shortcut.to_string_lossy().to_string());
                    }
                }
            }

            return Ok(path);
        }

        #[allow(unreachable_code)]
        Ok(format!("http://127.0.0.1:{}/", self.port))
    }

    /// Unmounts from OS, removes desktop shortcuts, and stops the WebDAV gateway
    pub async fn unmount_and_stop(&mut self) -> CoreResult<()> {
        if let Some(ref pt) = self.mount_point {
            #[cfg(target_os = "macos")]
            {
                let _ = tokio::process::Command::new("diskutil")
                    .args(["unmount", "force", pt])
                    .output()
                    .await;
                // Clean up directory if empty
                let _ = tokio::fs::remove_dir(pt).await;
            }
            #[cfg(target_os = "windows")]
            {
                let _ = tokio::process::Command::new("net")
                    .args(["use", pt, "/delete", "/y"])
                    .output()
                    .await;
            }
            #[cfg(target_os = "linux")]
            {
                let mount_url = format!("dav://127.0.0.1:{}/", self.port);
                let _ = tokio::process::Command::new("gio")
                    .args(["mount", "-u", &mount_url])
                    .output()
                    .await;
            }
        }

        // Clean up desktop shortcut
        if let Some(ref sc) = self.shortcut_path {
            let _ = tokio::fs::remove_file(sc).await;
        }

        if let Some(tx) = self.cancel_tx.take() {
            let _ = tx.send(());
        }
        self.is_running.store(false, Ordering::SeqCst);
        self.mount_point = None;
        self.shortcut_path = None;
        Ok(())
    }

    pub fn info(&self) -> VirtualDiskInfo {
        VirtualDiskInfo {
            session_id: self.session_id.clone(),
            session_name: self.session_name.clone(),
            mount_point: self
                .mount_point
                .clone()
                .unwrap_or_else(|| format!("http://127.0.0.1:{}/", self.port)),
            mount_root: self.mount_root.clone(),
            port: self.port,
            is_mounted: self.is_active() && self.mount_point.is_some(),
            read_bytes: self.read_bytes.load(Ordering::Relaxed),
            write_bytes: self.write_bytes.load(Ordering::Relaxed),
            shortcut_path: self.shortcut_path.clone(),
        }
    }
}

#[cfg(target_os = "linux")]
fn whoami_uid() -> u32 {
    unsafe { libc::getuid() }
}

// ---------------------- HTTP / WEBDAV PERSISTENT CONNECTION ----------------------

async fn handle_persistent_connection(
    mut stream: TcpStream,
    session_id: String,
    mount_root: String,
    vfs: Arc<dyn VirtualFileSystem>,
    cache: Arc<ManagedDiskCache>,
    read_bytes: Arc<AtomicU64>,
    write_bytes: Arc<AtomicU64>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut buffer = Vec::with_capacity(16384);
    let mut read_buf = [0u8; 8192];

    loop {
        // Find end of headers (\r\n\r\n) in existing buffer or read more
        let header_end = loop {
            if let Some(pos) = find_subsequence(&buffer, b"\r\n\r\n") {
                break Some(pos);
            }
            match tokio::time::timeout(Duration::from_secs(30), stream.read(&mut read_buf)).await {
                Ok(Ok(0)) => break None, // Connection closed by peer
                Ok(Ok(n)) => {
                    buffer.extend_from_slice(&read_buf[..n]);
                    if buffer.len() > 1024 * 1024 {
                        // Header too large
                        return Ok(());
                    }
                }
                Ok(Err(_)) | Err(_) => break None, // Read error or timeout
            }
        };

        let header_end = match header_end {
            Some(pos) => pos,
            None => break, // Exit loop when client disconnects or times out
        };

        let header_str = String::from_utf8_lossy(&buffer[..header_end]).into_owned();
        let mut lines = header_str.lines();
        let request_line = lines.next().unwrap_or("");
        let req_parts: Vec<&str> = request_line.split_whitespace().collect();

        if req_parts.len() < 2 {
            break;
        }

        let method = req_parts[0].to_uppercase();
        let raw_path = req_parts[1].to_string();
        let http_version = if req_parts.len() >= 3 { req_parts[2].to_string() } else { "HTTP/1.1".to_string() };

        let mut headers = HashMap::new();
        for line in lines {
            if let Some((k, v)) = line.split_once(':') {
                headers.insert(k.trim().to_lowercase(), v.trim().to_string());
            }
        }

        let content_length: usize = headers
            .get("content-length")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);

        let body_start = header_end + 4;

        // Read remaining body if needed
        while buffer.len() < body_start + content_length {
            match tokio::time::timeout(Duration::from_secs(30), stream.read(&mut read_buf)).await {
                Ok(Ok(0)) | Ok(Err(_)) | Err(_) => break,
                Ok(Ok(n)) => {
                    buffer.extend_from_slice(&read_buf[..n]);
                }
            }
        }

        let body = if buffer.len() >= body_start + content_length {
            Bytes::copy_from_slice(&buffer[body_start..body_start + content_length])
        } else {
            Bytes::copy_from_slice(&buffer[body_start..])
        };

        let next_req_start = (body_start + content_length).min(buffer.len());
        let _ = buffer.drain(..next_req_start);

        let webdav_path = decode_url_path(&raw_path);
        let remote_path = resolve_remote_path(&webdav_path, &mount_root);

        let client_wants_close = headers
            .get("connection")
            .map(|v| v.eq_ignore_ascii_case("close"))
            .unwrap_or_else(|| http_version == "HTTP/1.0");

        let should_close = handle_single_request(
            &mut stream,
            &method,
            &webdav_path,
            &remote_path,
            &headers,
            body,
            &session_id,
            &mount_root,
            &vfs,
            &cache,
            &read_bytes,
            &write_bytes,
            client_wants_close,
        )
        .await?;

        if should_close || client_wants_close {
            break;
        }
    }

    Ok(())
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Detect OS metadata probes (.DS_Store, ._AppleDouble, .metadata_never_index, Thumbs.db, etc.)
pub fn is_os_system_probe(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    name == ".DS_Store"
        || name.starts_with("._")
        || name == ".metadata_never_index_unless_rootfs"
        || name == ".metadata_never_index"
        || name == ".metadata_direct_scope_only"
        || name == ".Spotlight-V100"
        || name == ".Trashes"
        || name == ".fseventsd"
        || name == ".localized"
        || name == "Desktop DB"
        || name == "Desktop DF"
        || name == "Thumbs.db"
        || name == "desktop.ini"
        || name == "autorun.inf"
}

async fn handle_single_request(
    stream: &mut TcpStream,
    method: &str,
    webdav_path: &str,
    remote_path: &str,
    headers: &HashMap<String, String>,
    body: Bytes,
    session_id: &str,
    mount_root: &str,
    vfs: &Arc<dyn VirtualFileSystem>,
    cache: &Arc<ManagedDiskCache>,
    read_bytes: &Arc<AtomicU64>,
    write_bytes: &Arc<AtomicU64>,
    client_wants_close: bool,
) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
    let conn_header = if client_wants_close {
        "Connection: close"
    } else {
        "Connection: keep-alive"
    };

    // Instant 404 for OS internal probes to prevent freeze loops and avoid remote network calls
    if is_os_system_probe(webdav_path) {
        let resp = format!(
            "HTTP/1.1 404 Not Found\r\n\
            Content-Length: 0\r\n\
            {}\r\n\r\n",
            conn_header
        );
        stream.write_all(resp.as_bytes()).await?;
        return Ok(client_wants_close);
    }

    match method {
        "OPTIONS" => {
            let response = format!(
                "HTTP/1.1 200 OK\r\n\
                DAV: 1, 2\r\n\
                MS-Author-Via: DAV\r\n\
                Allow: OPTIONS, GET, HEAD, POST, PUT, DELETE, TRACE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK\r\n\
                Accept-Ranges: bytes\r\n\
                Content-Length: 0\r\n\
                {}\r\n\r\n",
                conn_header
            );
            stream.write_all(response.as_bytes()).await?;
        }

        "PROPFIND" => {
            let depth = headers.get("depth").map(|s| s.as_str()).unwrap_or("1");
            let is_root = webdav_path == "/" || remote_path == mount_root || remote_path == "/";

            // Check if entry exists (cache first, then VFS)
            let root_meta = if is_root {
                match cache.get_entry_metadata(session_id, remote_path).await {
                    Some(m) => m,
                    None => match vfs.metadata(remote_path).await {
                        Ok(m) => {
                            cache.put_entry_metadata(session_id, m.clone()).await;
                            m
                        }
                        Err(_) => FileEntry {
                            name: remote_path.rsplit('/').next().unwrap_or("").to_string(),
                            path: remote_path.to_string(),
                            file_type: crate::types::FileType::Directory,
                            size: 0,
                            modified_at: None,
                            created_at: None,
                            permissions: Default::default(),
                            is_hidden: false,
                        },
                    },
                }
            } else {
                match cache.get_entry_metadata(session_id, remote_path).await {
                    Some(m) => m,
                    None => match vfs.metadata(remote_path).await {
                        Ok(m) => {
                            cache.put_entry_metadata(session_id, m.clone()).await;
                            m
                        }
                        Err(_) => {
                            // RFC compliant: Return 404 for non-existent paths! Never fake directories.
                            let not_found = format!(
                                "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n{}\r\n\r\n",
                                conn_header
                            );
                            stream.write_all(not_found.as_bytes()).await?;
                            return Ok(client_wants_close);
                        }
                    },
                }
            };

            let xml = build_propfind_multistatus(
                session_id,
                mount_root,
                remote_path,
                depth,
                root_meta,
                vfs,
                cache,
            )
            .await;

            let response = format!(
                "HTTP/1.1 207 Multi-Status\r\n\
                Content-Type: text/xml; charset=utf-8\r\n\
                Content-Length: {}\r\n\
                {}\r\n\r\n{}",
                xml.len(),
                conn_header,
                xml
            );
            stream.write_all(response.as_bytes()).await?;
        }

        "GET" => {
            let data = match cache.get_file_content(session_id, remote_path).await {
                Some(cached) => cached,
                None => match vfs.read_file(remote_path).await {
                    Ok(downloaded) => {
                        let _ = cache.put_file_content(session_id, remote_path, &downloaded).await;
                        read_bytes.fetch_add(downloaded.len() as u64, Ordering::Relaxed);
                        downloaded
                    }
                    Err(_) => {
                        let not_found = format!(
                            "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n{}\r\n\r\n",
                            conn_header
                        );
                        stream.write_all(not_found.as_bytes()).await?;
                        return Ok(client_wants_close);
                    }
                },
            };

            let total_len = data.len();
            let mime = guess_mime_type(remote_path);

            // Handle HTTP Range requests (crucial for Finder quicklook, thumbnails, streaming)
            if let Some(range_val) = headers.get("range") {
                if let Some((start, end)) = parse_range_header(range_val, total_len) {
                    let slice = &data[start..=end];
                    let range_len = slice.len();
                    read_bytes.fetch_add(range_len as u64, Ordering::Relaxed);

                    let header = format!(
                        "HTTP/1.1 206 Partial Content\r\n\
                        Content-Type: {}\r\n\
                        Content-Range: bytes {}-{}/{}\r\n\
                        Content-Length: {}\r\n\
                        Accept-Ranges: bytes\r\n\
                        {}\r\n\r\n",
                        mime, start, end, total_len, range_len, conn_header
                    );
                    stream.write_all(header.as_bytes()).await?;
                    stream.write_all(slice).await?;
                    return Ok(client_wants_close);
                }
            }

            // Full content
            let header = format!(
                "HTTP/1.1 200 OK\r\n\
                Content-Type: {}\r\n\
                Content-Length: {}\r\n\
                Accept-Ranges: bytes\r\n\
                {}\r\n\r\n",
                mime, total_len, conn_header
            );
            stream.write_all(header.as_bytes()).await?;
            stream.write_all(&data).await?;
        }

        "HEAD" => {
            let meta = match cache.get_entry_metadata(session_id, remote_path).await {
                Some(m) => m,
                None => match vfs.metadata(remote_path).await {
                    Ok(m) => {
                        cache.put_entry_metadata(session_id, m.clone()).await;
                        m
                    }
                    Err(_) => {
                        let not_found = format!(
                            "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n{}\r\n\r\n",
                            conn_header
                        );
                        stream.write_all(not_found.as_bytes()).await?;
                        return Ok(client_wants_close);
                    }
                },
            };

            let mime = guess_mime_type(remote_path);
            let response = format!(
                "HTTP/1.1 200 OK\r\n\
                Content-Type: {}\r\n\
                Content-Length: {}\r\n\
                Accept-Ranges: bytes\r\n\
                ETag: \"{}-{}\"\r\n\
                {}\r\n\r\n",
                mime,
                meta.size,
                meta.size,
                meta.modified_at.map(|t| t.timestamp()).unwrap_or(0),
                conn_header
            );
            stream.write_all(response.as_bytes()).await?;
        }

        "PUT" => {
            let body_len = body.len() as u64;
            let _ = vfs.write_file(remote_path, body.clone()).await;
            let _ = cache.put_file_content(session_id, remote_path, &body).await;
            cache.invalidate_catalog(session_id, remote_path).await;
            write_bytes.fetch_add(body_len, Ordering::Relaxed);

            let response = format!(
                "HTTP/1.1 201 Created\r\nContent-Length: 0\r\n{}\r\n\r\n",
                conn_header
            );
            stream.write_all(response.as_bytes()).await?;
        }

        "MKCOL" => {
            let _ = vfs.create_dir(remote_path).await;
            cache.invalidate_catalog(session_id, remote_path).await;
            let response = format!(
                "HTTP/1.1 201 Created\r\nContent-Length: 0\r\n{}\r\n\r\n",
                conn_header
            );
            stream.write_all(response.as_bytes()).await?;
        }

        "DELETE" => {
            if let Ok(meta) = vfs.metadata(remote_path).await {
                if meta.is_dir() {
                    let _ = vfs.remove_dir(remote_path, true).await;
                } else {
                    let _ = vfs.remove_file(remote_path).await;
                }
            }
            cache.invalidate_catalog(session_id, remote_path).await;
            let response = format!(
                "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n{}\r\n\r\n",
                conn_header
            );
            stream.write_all(response.as_bytes()).await?;
        }

        "MOVE" => {
            let dest_header = headers.get("destination").map(|s| s.as_str()).unwrap_or("");
            let dest_webdav = decode_url_path(dest_header);
            let dest_remote = resolve_remote_path(&dest_webdav, mount_root);
            let _ = vfs.rename(remote_path, &dest_remote).await;
            cache.invalidate_catalog(session_id, remote_path).await;
            cache.invalidate_catalog(session_id, &dest_remote).await;
            let response = format!(
                "HTTP/1.1 201 Created\r\nContent-Length: 0\r\n{}\r\n\r\n",
                conn_header
            );
            stream.write_all(response.as_bytes()).await?;
        }

        "LOCK" => {
            let token = uuid::Uuid::new_v4().to_string();
            let xml = format!(
                "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n\
                <D:prop xmlns:D=\"DAV:\">\n\
                <D:lockdiscovery>\n\
                <D:activelock>\n\
                <D:locktype><D:write/></D:locktype>\n\
                <D:lockscope><D:exclusive/></D:lockscope>\n\
                <D:depth>Infinity</D:depth>\n\
                <D:timeout>Second-3600</D:timeout>\n\
                <D:locktoken><D:href>urn:uuid:{}</D:href></D:locktoken>\n\
                </D:activelock>\n\
                </D:lockdiscovery>\n\
                </D:prop>",
                token
            );
            let response = format!(
                "HTTP/1.1 200 OK\r\n\
                Lock-Token: <urn:uuid:{}>\r\n\
                Content-Type: text/xml; charset=utf-8\r\n\
                Content-Length: {}\r\n\
                {}\r\n\r\n{}",
                token,
                xml.len(),
                conn_header,
                xml
            );
            stream.write_all(response.as_bytes()).await?;
        }

        "UNLOCK" => {
            let response = format!(
                "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n{}\r\n\r\n",
                conn_header
            );
            stream.write_all(response.as_bytes()).await?;
        }

        "PROPPATCH" => {
            let href = to_webdav_href(remote_path, mount_root, false);
            let encoded_href = url_encode_path(&href);
            let xml = format!(
                "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n\
                <D:multistatus xmlns:D=\"DAV:\">\n\
                <D:response>\n\
                <D:href>{}</D:href>\n\
                <D:propstat>\n\
                <D:status>HTTP/1.1 200 OK</D:status>\n\
                </D:propstat>\n\
                </D:response>\n\
                </D:multistatus>",
                encoded_href
            );
            let response = format!(
                "HTTP/1.1 207 Multi-Status\r\n\
                Content-Type: text/xml; charset=utf-8\r\n\
                Content-Length: {}\r\n\
                {}\r\n\r\n{}",
                xml.len(),
                conn_header,
                xml
            );
            stream.write_all(response.as_bytes()).await?;
        }

        _ => {
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n{}\r\n\r\n",
                conn_header
            );
            stream.write_all(response.as_bytes()).await?;
        }
    }

    Ok(client_wants_close)
}

pub fn parse_range_header(header: &str, total_len: usize) -> Option<(usize, usize)> {
    if total_len == 0 {
        return None;
    }
    let s = header.trim();
    if !s.to_lowercase().starts_with("bytes=") {
        return None;
    }
    let range_part = &s[6..];
    let first_range = range_part.split(',').next()?.trim();
    let (start_str, end_str) = first_range.split_once('-')?;

    let (start, end) = if start_str.is_empty() {
        // Suffix bytes: e.g. -500 means last 500 bytes
        let suffix_len: usize = end_str.parse().ok()?;
        let s = total_len.saturating_sub(suffix_len);
        let e = total_len.saturating_sub(1);
        (s, e)
    } else if end_str.is_empty() {
        // From start to end of file: e.g. 500-
        let s: usize = start_str.parse().ok()?;
        let e = total_len.saturating_sub(1);
        (s, e)
    } else {
        // Explicit range: e.g. 0-499
        let s: usize = start_str.parse().ok()?;
        let e: usize = end_str.parse().ok()?;
        (s, e.min(total_len.saturating_sub(1)))
    };

    if start <= end && start < total_len {
        Some((start, end))
    } else {
        None
    }
}

pub fn resolve_remote_path(webdav_path: &str, mount_root: &str) -> String {
    let clean_root = mount_root.trim_end_matches('/');
    let clean_req = webdav_path.trim_matches('/');
    if clean_req.is_empty() {
        if clean_root.is_empty() {
            "/".to_string()
        } else {
            clean_root.to_string()
        }
    } else if clean_root.is_empty() {
        format!("/{}", clean_req)
    } else {
        format!("{}/{}", clean_root, clean_req)
    }
}

pub fn to_webdav_href(remote_path: &str, mount_root: &str, is_dir: bool) -> String {
    let clean_root = mount_root.trim_end_matches('/');
    let rel = if !clean_root.is_empty() && remote_path.starts_with(clean_root) {
        &remote_path[clean_root.len()..]
    } else {
        remote_path
    };
    let clean_rel = rel.trim_matches('/');
    let href = if clean_rel.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", clean_rel)
    };
    if is_dir && !href.ends_with('/') {
        format!("{}/", href)
    } else {
        href
    }
}

pub fn decode_url_path(raw: &str) -> String {
    let clean = if let Some(idx) = raw.find("://") {
        if let Some(p_idx) = raw[idx + 3..].find('/') {
            &raw[idx + 3 + p_idx..]
        } else {
            "/"
        }
    } else {
        raw
    };

    let path_part = clean.split('?').next().unwrap_or(clean);

    let unescaped = path_part
        .replace("%20", " ")
        .replace("%2F", "/")
        .replace("%2B", "+")
        .replace("%23", "#")
        .replace("%25", "%");

    if unescaped.is_empty() {
        "/".to_string()
    } else {
        unescaped
    }
}

pub fn url_encode_path(path: &str) -> String {
    let mut encoded = String::with_capacity(path.len());
    for b in path.bytes() {
        match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'/' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(b as char);
            }
            _ => {
                encoded.push_str(&format!("%{:02X}", b));
            }
        }
    }
    encoded
}

fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn guess_mime_type(filename: &str) -> &'static str {
    let ext = filename.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" => "application/javascript",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "tar" | "gz" | "tgz" => "application/gzip",
        "txt" | "log" | "md" | "sh" | "rs" | "go" | "py" | "c" | "cpp" | "java" => {
            "text/plain; charset=utf-8"
        }
        "xml" => "text/xml; charset=utf-8",
        _ => "application/octet-stream",
    }
}

async fn build_propfind_multistatus(
    session_id: &str,
    mount_root: &str,
    remote_path: &str,
    depth: &str,
    root_meta: FileEntry,
    vfs: &Arc<dyn VirtualFileSystem>,
    cache: &Arc<ManagedDiskCache>,
) -> String {
    let mut xml = String::from("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<D:multistatus xmlns:D=\"DAV:\">\n");

    let root_href = to_webdav_href(remote_path, mount_root, root_meta.is_dir());
    xml.push_str(&entry_to_webdav_xml(&root_meta, &root_href));

    // Children if depth != "0" and current target is a directory
    if depth != "0" && root_meta.is_dir() {
        let children = if let Some(cached) = cache.get_catalog(session_id, remote_path).await {
            cached
        } else {
            match vfs.list_dir(remote_path).await {
                Ok(entries) => {
                    // Filter out system probes from listings to keep the directory clean
                    let clean_entries: Vec<FileEntry> = entries
                        .into_iter()
                        .filter(|e| !is_os_system_probe(&e.name))
                        .collect();
                    cache
                        .put_catalog(session_id, remote_path, clean_entries.clone())
                        .await;
                    clean_entries
                }
                Err(_) => Vec::new(),
            }
        };

        for child in children {
            let child_href = to_webdav_href(&child.path, mount_root, child.is_dir());
            xml.push_str(&entry_to_webdav_xml(&child, &child_href));
        }
    }

    xml.push_str("</D:multistatus>");
    xml
}

fn entry_to_webdav_xml(entry: &FileEntry, href_path: &str) -> String {
    let is_dir = entry.is_dir();
    let res_type = if is_dir {
        "<D:resourcetype><D:collection/></D:resourcetype>"
    } else {
        "<D:resourcetype/>"
    };

    let clean_href = if is_dir && !href_path.ends_with('/') {
        format!("{}/", href_path)
    } else {
        href_path.to_string()
    };
    let encoded_href = url_encode_path(&clean_href);

    let mod_time = entry
        .modified_at
        .map(|t| t.to_rfc2822())
        .unwrap_or_else(|| "Mon, 01 Jan 2026 00:00:00 GMT".to_string());

    let creation_time = entry
        .created_at
        .or(entry.modified_at)
        .map(|t| t.to_rfc3339())
        .unwrap_or_else(|| "2026-01-01T00:00:00Z".to_string());

    let display_name = if entry.name.is_empty() {
        "root"
    } else {
        &entry.name
    };

    let etag = format!(
        "\"{}-{}\"",
        entry.size,
        entry.modified_at.map(|t| t.timestamp()).unwrap_or(0)
    );

    let content_props = if is_dir {
        // RFC 4918: Collections MUST NOT include getcontentlength
        String::new()
    } else {
        let mime = guess_mime_type(&entry.name);
        format!(
            "        <D:getcontentlength>{}</D:getcontentlength>\n\
            \x20       <D:getcontenttype>{}</D:getcontenttype>\n",
            entry.size, mime
        )
    };

    format!(
        "  <D:response>\n\
        \x20   <D:href>{}</D:href>\n\
        \x20   <D:propstat>\n\
        \x20     <D:prop>\n\
        \x20       <D:displayname>{}</D:displayname>\n\
        {}\
        \x20       <D:getlastmodified>{}</D:getlastmodified>\n\
        \x20       <D:creationdate>{}</D:creationdate>\n\
        \x20       <D:getetag>{}</D:getetag>\n\
        \x20       {}\n\
        \x20       <D:supportedlock>\n\
        \x20         <D:lockentry>\n\
        \x20           <D:lockscope><D:exclusive/></D:lockscope>\n\
        \x20           <D:locktype><D:write/></D:locktype>\n\
        \x20         </D:lockentry>\n\
        \x20       </D:supportedlock>\n\
        \x20     </D:prop>\n\
        \x20     <D:status>HTTP/1.1 200 OK</D:status>\n\
        \x20   </D:propstat>\n\
        \x20 </D:response>\n",
        encoded_href,
        escape_xml(display_name),
        content_props,
        mod_time,
        creation_time,
        etag,
        res_type
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_remote_path() {
        let mount_root = "/home/aquelelink.com.br";
        assert_eq!(resolve_remote_path("/", mount_root), "/home/aquelelink.com.br");
        assert_eq!(resolve_remote_path("/public_html", mount_root), "/home/aquelelink.com.br/public_html");
        assert_eq!(resolve_remote_path("/public_html/index.php", mount_root), "/home/aquelelink.com.br/public_html/index.php");

        // Root mount
        assert_eq!(resolve_remote_path("/", "/"), "/");
        assert_eq!(resolve_remote_path("/var/log", "/"), "/var/log");
    }

    #[test]
    fn test_to_webdav_href() {
        let mount_root = "/home/aquelelink.com.br";
        // Root directory
        assert_eq!(to_webdav_href("/home/aquelelink.com.br", mount_root, true), "/");
        // Subdirectory
        assert_eq!(to_webdav_href("/home/aquelelink.com.br/public_html", mount_root, true), "/public_html/");
        // File
        assert_eq!(to_webdav_href("/home/aquelelink.com.br/index.php", mount_root, false), "/index.php");
        assert_eq!(to_webdav_href("/home/aquelelink.com.br/public_html/style.css", mount_root, false), "/public_html/style.css");
    }

    #[test]
    fn test_decode_url_path() {
        assert_eq!(decode_url_path("/public%20html/test%231"), "/public html/test#1");
        assert_eq!(decode_url_path("http://127.0.0.1:8080/my%20folder"), "/my folder");
        assert_eq!(decode_url_path("/folder?depth=1"), "/folder");
    }

    #[test]
    fn test_is_os_system_probe() {
        assert!(is_os_system_probe("/.DS_Store"));
        assert!(is_os_system_probe("/folder/._index.html"));
        assert!(is_os_system_probe("/.metadata_never_index"));
        assert!(is_os_system_probe("/Thumbs.db"));
        assert!(!is_os_system_probe("/folder/index.html"));
        assert!(!is_os_system_probe("/public_html"));
    }

    #[test]
    fn test_parse_range_header() {
        assert_eq!(parse_range_header("bytes=0-499", 1000), Some((0, 499)));
        assert_eq!(parse_range_header("bytes=500-", 1000), Some((500, 999)));
        assert_eq!(parse_range_header("bytes=-200", 1000), Some((800, 999)));
        assert_eq!(parse_range_header("invalid", 1000), None);
    }

    #[tokio::test]
    async fn test_webdav_server_live_requests() {
        use crate::local::LocalFsDriver;

        let temp_dir = std::env::temp_dir().join(format!("rustscp_vfs_test_{}", uuid::Uuid::new_v4()));
        let _ = tokio::fs::create_dir_all(&temp_dir).await;
        let vfs = Arc::new(LocalFsDriver::new());
        let cache = Arc::new(ManagedDiskCache::new(Some(temp_dir.join("cache")), 10 * 1024 * 1024));

        let mut server = WebDavServer::new(
            "test_sess".to_string(),
            "MinhaConexao".to_string(),
            temp_dir.to_string_lossy().to_string(),
            vfs,
            cache,
        );

        let port = server.start().await.unwrap();
        assert!(port > 0);

        let mut stream = tokio::net::TcpStream::connect(format!("127.0.0.1:{}", port)).await.unwrap();

        // 1. Send OPTIONS
        stream.write_all(b"OPTIONS / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").await.unwrap();
        let mut buf = [0u8; 1024];
        let n = stream.read(&mut buf).await.unwrap();
        let resp = String::from_utf8_lossy(&buf[..n]);
        assert!(resp.contains("200 OK"));
        assert!(resp.contains("DAV: 1, 2"));
        assert!(resp.contains("keep-alive"));

        // 2. Send PROPFIND for .DS_Store (must return 404 immediately over same persistent stream)
        stream.write_all(b"PROPFIND /.DS_Store HTTP/1.1\r\nHost: 127.0.0.1\r\nDepth: 0\r\n\r\n").await.unwrap();
        let n = stream.read(&mut buf).await.unwrap();
        let resp2 = String::from_utf8_lossy(&buf[..n]);
        assert!(resp2.contains("404 Not Found"), "Response should be 404 for .DS_Store, got: {}", resp2);

        // 3. Send PROPFIND for root / (must return 207 Multi-Status)
        stream.write_all(b"PROPFIND / HTTP/1.1\r\nHost: 127.0.0.1\r\nDepth: 0\r\nConnection: close\r\n\r\n").await.unwrap();
        let n = stream.read(&mut buf).await.unwrap();
        let resp3 = String::from_utf8_lossy(&buf[..n]);
        assert!(resp3.contains("207 Multi-Status"), "Response should be 207 for root, got: {}", resp3);
        assert!(resp3.contains("<D:multistatus"));

        server.unmount_and_stop().await.unwrap();
        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    }
}

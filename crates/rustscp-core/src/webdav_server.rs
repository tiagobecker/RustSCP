//! Embedded WebDAV gateway that exposes one session as a native OS disk
//! (macOS `mount_webdav`, Windows `net use`, Linux `gio mount`).
//!
//! Security model: the listener binds 127.0.0.1 only; every request must carry
//! `Host: 127.0.0.1:<port>` or `Host: localhost:<port>` (defeats DNS rebinding), and
//! requests with a browser `Origin` (or cross-site `Sec-Fetch-Site`) header are
//! refused (no CSRF from web pages). By default every path also sits below a random
//! per-server token (`http://127.0.0.1:<port>/<token>/`, see
//! [`WebDavServer::mount_url`]), so a process that merely finds the port cannot
//! browse the session. The token is visible in the OS mount table, so it is a
//! defence in depth, not authentication against other local users.
//!
//! HTTP handling: bodies are framed by `Content-Length` or `Transfer-Encoding:
//! chunked` (macOS Finder uploads chunked). Uploads are streamed: drivers with
//! positional writes (Local, SFTP) receive the body chunk by chunk into a hidden temp
//! file next to the target that is renamed over it only once the whole body arrived,
//! so a dropped or short upload never truncates the existing file. Remote errors are
//! mapped to HTTP status codes (403/404/409/412/502/504/507) instead of fake successes.
//! Downloads never hold large files in memory: files above [`CACHE_MAX_FILE`] are
//! streamed with `read_range`, Range requests read only the requested bytes, and the
//! content cache is only used when its size/mtime stamp still matches the remote.

use crate::disk_cache::ManagedDiskCache;
use crate::types::{CoreError, CoreResult, FileEntry};
use crate::vfs::VirtualFileSystem;
use bytes::{Bytes, BytesMut};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{watch, Mutex};

/// Idle time allowed between two requests on a keep-alive connection.
const KEEP_ALIVE_IDLE: Duration = Duration::from_secs(30);
/// Idle time allowed while a request body is being received.
const BODY_IDLE: Duration = Duration::from_secs(120);
/// Maximum size of a request line plus headers.
const MAX_HEADER_BYTES: usize = 64 * 1024;
/// Maximum body of the XML methods (PROPFIND, PROPPATCH, LOCK...).
const MAX_SMALL_BODY: usize = 1024 * 1024;
/// Upload size limit for drivers without positional writes (S3, FTP), which need the
/// whole body in memory for a single `write_file`.
const MAX_BUFFERED_UPLOAD: u64 = 1024 * 1024 * 1024;
/// Remote read/write piece size while streaming.
const STREAM_CHUNK: u64 = 4 * 1024 * 1024;
/// Socket read size.
const READ_PIECE: usize = 256 * 1024;
/// Files up to this size are read whole and kept in the content cache; larger files
/// are streamed and never cached.
pub const CACHE_MAX_FILE: u64 = 32 * 1024 * 1024;
const MAX_CHUNK_LINE: usize = 4096;
const MAX_TRAILER_BYTES: usize = 16 * 1024;
/// OS metadata files written by Finder (AppleDouble `._*`, `.DS_Store`) are kept in
/// memory instead of on the server; per-file and total bounds.
const PROBE_FILE_MAX: usize = 1024 * 1024;
const PROBE_STORE_MAX: usize = 16 * 1024 * 1024;
/// Safety limit for recursive COPY.
const MAX_COPY_ENTRIES: usize = 100_000;
/// Symlinks resolved (one stat each) per PROPFIND listing.
const MAX_SYMLINK_RESOLVE: usize = 256;
/// Hidden names used for in-flight uploads and for the backup during a replace.
const UPLOAD_TEMP_PREFIX: &str = ".rustscp-upload-";
const REPLACED_TEMP_PREFIX: &str = ".rustscp-replaced-";

const ALLOW_METHODS: &str =
    "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK";

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
    /// Full WebDAV URL of the share (includes the secret path token).
    #[serde(default)]
    pub mount_url: String,
}

pub struct WebDavServer {
    session_id: String,
    session_name: String,
    mount_root: String,
    vfs: Arc<dyn VirtualFileSystem>,
    cache: Arc<ManagedDiskCache>,
    port: u16,
    is_running: Arc<AtomicBool>,
    /// Dropping or signalling this stops the accept loop and every open connection.
    shutdown_tx: Option<watch::Sender<bool>>,
    mount_point: Option<String>,
    shortcut_path: Option<String>,
    read_bytes: Arc<AtomicU64>,
    write_bytes: Arc<AtomicU64>,
    access_token: Option<String>,
    /// URL handed to the OS mounter (unmount uses the same one).
    os_mount_url: Option<String>,
}

fn generate_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn is_valid_token(token: &str) -> bool {
    (8..=128).contains(&token.len())
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
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
            shutdown_tx: None,
            mount_point: None,
            shortcut_path: None,
            read_bytes: Arc::new(AtomicU64::new(0)),
            write_bytes: Arc::new(AtomicU64::new(0)),
            access_token: Some(generate_token()),
            os_mount_url: None,
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

    /// Secret first path segment every request must start with (None = disabled).
    pub fn access_token(&self) -> Option<&str> {
        self.access_token.as_deref()
    }

    /// Replaces (or disables, with `None`) the secret path token. Only allowed while
    /// the server is stopped; tokens are 8-128 chars of `[A-Za-z0-9_-]`.
    pub fn set_access_token(&mut self, token: Option<String>) -> CoreResult<()> {
        if self.is_active() {
            return Err(CoreError::General(
                "Cannot change the WebDAV access token while the server is running".into(),
            ));
        }
        if let Some(t) = &token {
            if !is_valid_token(t) {
                return Err(CoreError::InvalidPath(
                    "WebDAV access token must be 8-128 characters of [A-Za-z0-9_-]".into(),
                ));
            }
        }
        self.access_token = token;
        Ok(())
    }

    /// Path prefix of the share: `/<token>/` or `/`.
    pub fn base_path(&self) -> String {
        match &self.access_token {
            Some(t) => format!("/{}/", t),
            None => "/".to_string(),
        }
    }

    /// Full URL of the share, including the secret token
    /// (`http://127.0.0.1:<port>/<token>/`). Use it to mount the disk manually.
    pub fn mount_url(&self) -> String {
        format!("http://127.0.0.1:{}{}", self.port, self.base_path())
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
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        self.shutdown_tx = Some(shutdown_tx);
        // A fresh flag per run: an earlier accept loop that is still winding down can
        // never mark this run as stopped.
        self.is_running = Arc::new(AtomicBool::new(true));

        let shared = Arc::new(Shared {
            session_id: self.session_id.clone(),
            mount_root: self.mount_root.clone(),
            token: self.access_token.clone(),
            port: self.port,
            vfs: self.vfs.clone(),
            cache: self.cache.clone(),
            read_bytes: self.read_bytes.clone(),
            write_bytes: self.write_bytes.clone(),
            stamps: Mutex::new(HashMap::new()),
            probes: Mutex::new(ProbeStore::default()),
        });
        let is_running = self.is_running.clone();

        tokio::spawn(async move {
            let mut accept_rx = shutdown_rx.clone();
            loop {
                tokio::select! {
                    _ = wait_for_shutdown(&mut accept_rx) => break,
                    res = listener.accept() => match res {
                        Ok((stream, peer)) => {
                            if !peer.ip().is_loopback() {
                                continue;
                            }
                            let _ = stream.set_nodelay(true);
                            let shared = shared.clone();
                            let mut conn_rx = shutdown_rx.clone();
                            tokio::spawn(async move {
                                // Unmount / drop closes keep-alive connections too.
                                tokio::select! {
                                    _ = serve_connection(stream, shared) => {}
                                    _ = wait_for_shutdown(&mut conn_rx) => {}
                                }
                            });
                        }
                        Err(_) => {
                            // e.g. too many open files: back off instead of spinning.
                            tokio::time::sleep(Duration::from_millis(50)).await;
                        }
                    }
                }
            }
            is_running.store(false, Ordering::SeqCst);
        });

        Ok(self.port)
    }

    fn stop_server(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(true);
        }
        self.is_running.store(false, Ordering::SeqCst);
    }

    /// Name shown for the volume / shortcut: no path separators, quotes or control
    /// characters.
    fn display_name(&self) -> String {
        sanitize_display_name(&self.session_name)
    }

    /// Mount folder name: sanitized name plus a short hash of the session id, so two
    /// sessions with the same name never share (and force-unmount) one folder.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn mount_dir_name(&self) -> String {
        let clean_name: String = self
            .display_name()
            .chars()
            .map(|c| {
                if c.is_alphanumeric() || c == '_' || c == '-' {
                    c
                } else {
                    '_'
                }
            })
            .take(64)
            .collect();
        use sha2::{Digest, Sha256};
        let hash = hex::encode(Sha256::digest(self.session_id.as_bytes()));
        format!("{}-{}", clean_name, &hash[..8])
    }

    /// Mounts the WebDAV server as a native OS virtual disk with the connection name
    pub async fn mount_in_os(&mut self) -> CoreResult<String> {
        if self.is_active() {
            if let Some(mp) = &self.mount_point {
                return Ok(mp.clone());
            }
        }
        let started_here = !self.is_active();
        if started_here {
            self.start().await?;
        }
        let result = self.mount_in_os_inner().await;
        if result.is_err() && started_here {
            self.stop_server();
        }
        result
    }

    async fn mount_in_os_inner(&mut self) -> CoreResult<String> {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_else(|_| ".".to_string());
        let home_path = std::path::PathBuf::from(home);

        #[cfg(target_os = "macos")]
        {
            return self.mount_macos(&home_path).await;
        }

        #[cfg(target_os = "windows")]
        {
            return self.mount_windows(&home_path).await;
        }

        #[cfg(target_os = "linux")]
        {
            return self.mount_linux(&home_path).await;
        }

        #[allow(unreachable_code)]
        {
            let _ = home_path;
            Ok(self.mount_url())
        }
    }

    #[cfg(unix)]
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    async fn mount_macos(&mut self, home_path: &Path) -> CoreResult<String> {
        let label = self.display_name();
        let base_disks = home_path.join(".rustscp").join("disks");
        let _ = tokio::fs::create_dir_all(&base_disks).await;
        let mnt_dir = base_disks.join(self.mount_dir_name());
        let mnt_str = mnt_dir.to_string_lossy().to_string();

        // Force unmount any stale mount of this session at this path first.
        let _ = tokio::process::Command::new("diskutil")
            .args(["unmount", "force", &mnt_str])
            .output()
            .await;

        let _ = tokio::fs::create_dir_all(&mnt_dir).await;

        let mount_url = self.mount_url();
        let out = tokio::process::Command::new("/sbin/mount_webdav")
            .args(["-v", &label, &mount_url, &mnt_str])
            .output()
            .await
            .map_err(|e| CoreError::General(format!("Failed to execute mount_webdav: {}", e)))?;

        if !out.status.success() {
            let _ = tokio::fs::remove_dir(&mnt_dir).await;
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(CoreError::General(format!(
                "mount_webdav failed (exit code {:?}): {}",
                out.status.code(),
                stderr.trim()
            )));
        }

        self.os_mount_url = Some(mount_url);
        self.mount_point = Some(mnt_str.clone());

        // Desktop shortcut pointing to the mounted disk (never replaces a user file).
        let desktop = home_path.join("Desktop");
        if tokio::fs::try_exists(&desktop).await.unwrap_or(false) {
            let managed = base_disks.to_string_lossy().to_string();
            if let Some(link) = create_desktop_link(&desktop, &label, &mnt_dir, &managed).await {
                self.shortcut_path = Some(link.to_string_lossy().to_string());
            }
        }

        Ok(mnt_str)
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    async fn mount_windows(&mut self, home_path: &Path) -> CoreResult<String> {
        let label = self.display_name();
        let mount_url = self.mount_url();

        // Pick a free letter ourselves instead of parsing localized `net use *` output,
        // so unmount only ever deletes the mapping this server created.
        let mut tried: Vec<char> = Vec::new();
        let mut drive: Option<String> = None;
        let mut last_err = String::new();
        for _ in 0..6 {
            let Some(letter) = pick_free_drive_letter(|c| {
                tried.contains(&c) || Path::new(&format!("{}:\\", c)).exists()
            }) else {
                break;
            };
            tried.push(letter);
            let candidate = format!("{}:", letter);
            let out = tokio::process::Command::new("net")
                .args(["use", &candidate, &mount_url, "/persistent:no"])
                .output()
                .await
                .map_err(|e| CoreError::General(format!("Failed to mount on Windows: {}", e)))?;
            if out.status.success() {
                drive = Some(candidate);
                break;
            }
            last_err = format!(
                "{} {}",
                String::from_utf8_lossy(&out.stdout).trim(),
                String::from_utf8_lossy(&out.stderr).trim()
            );
            // System error 85: the letter is already in use (e.g. a disconnected
            // mapping); try the next one. Anything else will not fix itself.
            if !last_err.contains(" 85") {
                break;
            }
        }
        let Some(drive) = drive else {
            return Err(CoreError::General(format!(
                "net use failed: {}",
                if last_err.is_empty() {
                    "no free drive letter".to_string()
                } else {
                    last_err
                }
            )));
        };

        self.os_mount_url = Some(mount_url);
        self.mount_point = Some(drive.clone());

        // Values reach PowerShell through environment variables, never through the
        // script text, so a name like "x'; iwr evil | iex; '" stays a plain string.
        let _ = tokio::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", PS_SET_LABEL])
            .env("RUSTSCP_DRIVE", &drive)
            .env("RUSTSCP_LABEL", &label)
            .output()
            .await;

        let desktop = home_path.join("Desktop");
        if tokio::fs::try_exists(&desktop).await.unwrap_or(false) {
            let mut chosen = None;
            for i in 0..20u32 {
                let candidate = desktop.join(format!("{}.lnk", numbered_name(&label, i)));
                if !tokio::fs::try_exists(&candidate).await.unwrap_or(true) {
                    chosen = Some(candidate);
                    break;
                }
            }
            if let Some(shortcut_path) = chosen {
                let out = tokio::process::Command::new("powershell")
                    .args([
                        "-NoProfile",
                        "-NonInteractive",
                        "-Command",
                        PS_CREATE_SHORTCUT,
                    ])
                    .env("RUSTSCP_LNK", shortcut_path.as_os_str())
                    .env("RUSTSCP_TARGET", format!("{}\\", drive))
                    .output()
                    .await;
                if matches!(out, Ok(ref o) if o.status.success()) {
                    self.shortcut_path = Some(shortcut_path.to_string_lossy().to_string());
                }
            }
        }

        Ok(drive)
    }

    #[cfg(unix)]
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    async fn mount_linux(&mut self, home_path: &Path) -> CoreResult<String> {
        let label = self.display_name();
        let token_part = self
            .access_token
            .as_deref()
            .map(|t| format!("{}/", t))
            .unwrap_or_default();
        let mount_url = format!("dav://127.0.0.1:{}/{}", self.port, token_part);
        let out = tokio::process::Command::new("gio")
            .args(["mount", &mount_url])
            .output()
            .await
            .map_err(|e| CoreError::General(format!("Failed to execute gio: {}", e)))?;
        if !out.status.success() {
            return Err(CoreError::General(format!(
                "gio mount failed (exit code {:?}): {}",
                out.status.code(),
                String::from_utf8_lossy(&out.stderr).trim()
            )));
        }
        self.os_mount_url = Some(mount_url);

        let gvfs = format!("/run/user/{}/gvfs", whoami_uid());
        let prefix = format!("dav:host=127.0.0.1,port={}", self.port);
        let mut found = None;
        if let Ok(mut rd) = tokio::fs::read_dir(&gvfs).await {
            while let Ok(Some(entry)) = rd.next_entry().await {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name == prefix || name.starts_with(&format!("{},", prefix)) {
                    found = Some(entry.path().to_string_lossy().into_owned());
                    break;
                }
            }
        }
        let path = found.unwrap_or_else(|| match &self.access_token {
            Some(t) => format!("{}/{},prefix=%2F{}", gvfs, prefix, t),
            None => format!("{}/{}", gvfs, prefix),
        });
        self.mount_point = Some(path.clone());

        let desktop = home_path.join("Desktop");
        if tokio::fs::try_exists(&desktop).await.unwrap_or(false) {
            let managed = format!("{}/dav:host=127.0.0.1,", gvfs);
            if let Some(link) =
                create_desktop_link(&desktop, &label, Path::new(&path), &managed).await
            {
                self.shortcut_path = Some(link.to_string_lossy().to_string());
            }
        }

        Ok(path)
    }

    /// Unmounts from OS, removes desktop shortcuts, and stops the WebDAV gateway
    pub async fn unmount_and_stop(&mut self) -> CoreResult<()> {
        if let Some(pt) = self.mount_point.clone() {
            #[cfg(target_os = "macos")]
            {
                let _ = tokio::process::Command::new("diskutil")
                    .args(["unmount", "force", &pt])
                    .output()
                    .await;
                // Clean up directory if empty
                let _ = tokio::fs::remove_dir(&pt).await;
            }
            #[cfg(target_os = "windows")]
            {
                // Only the exact letter this server mapped.
                let _ = tokio::process::Command::new("net")
                    .args(["use", &pt, "/delete", "/y"])
                    .output()
                    .await;
            }
            #[cfg(target_os = "linux")]
            {
                let mount_url = self.os_mount_url.clone().unwrap_or_else(|| {
                    format!("dav://127.0.0.1:{}{}", self.port, self.base_path())
                });
                let _ = tokio::process::Command::new("gio")
                    .args(["mount", "-u", &mount_url])
                    .output()
                    .await;
            }
            let _ = &pt;
        }

        // Clean up desktop shortcut (only if it is still our link).
        if let Some(sc) = self.shortcut_path.take() {
            remove_desktop_link(Path::new(&sc)).await;
        }

        self.stop_server();
        self.mount_point = None;
        self.os_mount_url = None;
        Ok(())
    }

    pub fn info(&self) -> VirtualDiskInfo {
        VirtualDiskInfo {
            session_id: self.session_id.clone(),
            session_name: self.session_name.clone(),
            mount_point: self.mount_point.clone().unwrap_or_else(|| self.mount_url()),
            mount_root: self.mount_root.clone(),
            port: self.port,
            is_mounted: self.is_active() && self.mount_point.is_some(),
            read_bytes: self.read_bytes.load(Ordering::Relaxed),
            write_bytes: self.write_bytes.load(Ordering::Relaxed),
            shortcut_path: self.shortcut_path.clone(),
            mount_url: self.mount_url(),
        }
    }
}

const PS_SET_LABEL: &str = "$ErrorActionPreference = 'SilentlyContinue'; \
(New-Object -ComObject Shell.Application).NameSpace($env:RUSTSCP_DRIVE + '\\').Self.Name = $env:RUSTSCP_LABEL";

const PS_CREATE_SHORTCUT: &str = "$ErrorActionPreference = 'Stop'; \
$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:RUSTSCP_LNK); \
$s.TargetPath = $env:RUSTSCP_TARGET; $s.Save()";

async fn wait_for_shutdown(rx: &mut watch::Receiver<bool>) {
    loop {
        if *rx.borrow() {
            return;
        }
        // The sender is dropped together with the server: stop as well.
        if rx.changed().await.is_err() {
            return;
        }
    }
}

#[cfg(unix)]
fn whoami_uid() -> u32 {
    unsafe { libc::getuid() }
}

/// Plain display/file name for a connection: no path separators, Windows-reserved
/// characters, quotes or control characters, no leading dots, at most 64 chars.
fn sanitize_display_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| {
            if c.is_control()
                || matches!(
                    c,
                    '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\'' | '`'
                )
            {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_start_matches('.').trim();
    let out: String = trimmed.chars().take(64).collect();
    let out = out.trim_end_matches(['.', ' ']).to_string();
    if out.is_empty() {
        "RustSCP".to_string()
    } else if is_windows_device_name(&out) {
        // `CON.lnk`, `nul` ... name devices on Windows, not files.
        format!("_{}", out)
    } else {
        out
    }
}

/// CON, PRN, AUX, NUL, COM1-9 and LPT1-9, with or without an extension.
fn is_windows_device_name(name: &str) -> bool {
    let stem = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_ascii_uppercase();
    match stem.as_str() {
        "CON" | "PRN" | "AUX" | "NUL" => true,
        s if s.len() == 4 && (s.starts_with("COM") || s.starts_with("LPT")) => {
            matches!(s.as_bytes()[3], b'1'..=b'9')
        }
        _ => false,
    }
}

fn numbered_name(base: &str, i: u32) -> String {
    match i {
        0 => base.to_string(),
        1 => format!("{} (RustSCP)", base),
        n => format!("{} (RustSCP {})", base, n),
    }
}

fn pick_free_drive_letter(in_use: impl Fn(char) -> bool) -> Option<char> {
    ('D'..='Z').rev().find(|c| !in_use(*c))
}

/// Creates `<desktop>/<name>` -> `target`. An existing entry is only replaced when it
/// is a symlink created by us (pointing to `target` or below `managed_prefix`);
/// otherwise a unique name (`Name (RustSCP)`, `Name (RustSCP 2)`, ...) is used.
#[cfg(unix)]
async fn create_desktop_link(
    desktop: &Path,
    base: &str,
    target: &Path,
    managed_prefix: &str,
) -> Option<std::path::PathBuf> {
    for i in 0..20u32 {
        let candidate = desktop.join(numbered_name(base, i));
        match tokio::fs::symlink_metadata(&candidate).await {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Ok(meta) if meta.file_type().is_symlink() => {
                let ours = match tokio::fs::read_link(&candidate).await {
                    Ok(t) => t == target || t.to_string_lossy().starts_with(managed_prefix),
                    Err(_) => false,
                };
                if !ours || tokio::fs::remove_file(&candidate).await.is_err() {
                    continue;
                }
            }
            _ => continue,
        }
        if tokio::fs::symlink(target, &candidate).await.is_ok() {
            return Some(candidate);
        }
    }
    None
}

/// Removes a shortcut created by [`create_desktop_link`] (or a Windows `.lnk`), but
/// never a regular file or folder the user put there since.
async fn remove_desktop_link(path: &Path) {
    let Ok(meta) = tokio::fs::symlink_metadata(path).await else {
        return;
    };
    let is_lnk = path
        .extension()
        .map(|e| e.eq_ignore_ascii_case("lnk"))
        .unwrap_or(false);
    if meta.file_type().is_symlink() || (is_lnk && meta.is_file()) {
        let _ = tokio::fs::remove_file(path).await;
    }
}

// ---------------------- SHARED CONNECTION STATE ----------------------

/// Size/mtime of a remote file at the moment its content was cached.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ContentStamp {
    size: u64,
    mtime: i64,
}

fn stamp_of(meta: &FileEntry) -> Option<ContentStamp> {
    meta.modified_at.map(|t| ContentStamp {
        size: meta.size,
        mtime: t.timestamp(),
    })
}

struct ProbeFile {
    data: Bytes,
    modified: DateTime<Utc>,
    tick: u64,
}

/// In-memory home of Finder's AppleDouble / .DS_Store files: writes succeed (so copies
/// with extended attributes do not fail) and reads return what was written, without
/// polluting the server.
#[derive(Default)]
struct ProbeStore {
    files: HashMap<String, ProbeFile>,
    total: usize,
    clock: u64,
}

impl ProbeStore {
    fn put(&mut self, key: String, data: Bytes) {
        self.remove(&key);
        if data.len() > PROBE_FILE_MAX {
            return;
        }
        while self.total + data.len() > PROBE_STORE_MAX && !self.files.is_empty() {
            let oldest = self
                .files
                .iter()
                .min_by_key(|(_, f)| f.tick)
                .map(|(k, _)| k.clone());
            match oldest {
                Some(k) => self.remove(&k),
                None => break,
            }
        }
        self.clock += 1;
        self.total += data.len();
        self.files.insert(
            key,
            ProbeFile {
                data,
                modified: Utc::now(),
                tick: self.clock,
            },
        );
    }

    fn get(&self, key: &str) -> Option<(Bytes, DateTime<Utc>)> {
        self.files.get(key).map(|f| (f.data.clone(), f.modified))
    }

    fn remove(&mut self, key: &str) {
        if let Some(f) = self.files.remove(key) {
            self.total = self.total.saturating_sub(f.data.len());
        }
    }
}

struct Shared {
    session_id: String,
    mount_root: String,
    token: Option<String>,
    port: u16,
    vfs: Arc<dyn VirtualFileSystem>,
    cache: Arc<ManagedDiskCache>,
    read_bytes: Arc<AtomicU64>,
    write_bytes: Arc<AtomicU64>,
    stamps: Mutex<HashMap<String, ContentStamp>>,
    probes: Mutex<ProbeStore>,
}

impl Shared {
    fn base_href(&self) -> String {
        match &self.token {
            Some(t) => format!("/{}/", t),
            None => "/".to_string(),
        }
    }

    fn remote_path(&self, segs: &[String]) -> String {
        join_remote(&self.mount_root, segs)
    }

    /// Percent-encoded href of a path inside the share.
    fn href(&self, segs: &[String], is_dir: bool) -> String {
        let mut out = self.base_href();
        if segs.is_empty() {
            return out;
        }
        let encoded: Vec<String> = segs.iter().map(|s| encode_segment(s)).collect();
        out.push_str(&encoded.join("/"));
        if is_dir {
            out.push('/');
        }
        out
    }

    /// Drops every cached listing, entry and content of `remote_path` (and below).
    async fn invalidate(&self, remote_path: &str) {
        self.cache
            .invalidate_catalog(&self.session_id, remote_path)
            .await;
        self.cache
            .invalidate_content(&self.session_id, remote_path)
            .await;
        let prefix = format!("{}/", remote_path.trim_end_matches('/'));
        self.stamps
            .lock()
            .await
            .retain(|k, _| k != remote_path && !k.starts_with(&prefix));
    }
}

fn join_remote(mount_root: &str, segs: &[String]) -> String {
    let clean_root = mount_root.trim_end_matches('/');
    if segs.is_empty() {
        if clean_root.is_empty() {
            "/".to_string()
        } else {
            clean_root.to_string()
        }
    } else {
        format!("{}/{}", clean_root, segs.join("/"))
    }
}

/// Hidden sibling name for an upload temp file / replace backup.
fn sibling_temp_path(path: &str, prefix: &str) -> String {
    let id = uuid::Uuid::new_v4().simple().to_string();
    match path.rfind('/') {
        Some(i) => format!("{}/{}{}", &path[..i], prefix, id),
        None => format!("{}{}", prefix, id),
    }
}

fn is_internal_temp_name(name: &str) -> bool {
    name.starts_with(UPLOAD_TEMP_PREFIX) || name.starts_with(REPLACED_TEMP_PREFIX)
}

fn is_listable_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !is_os_system_probe(name)
        && !is_internal_temp_name(name)
}

// ---------------------- HTTP PARSING ----------------------

#[derive(Debug)]
struct RequestHead {
    method: String,
    target: String,
    version: String,
    headers: HashMap<String, String>,
}

enum HeadResult {
    Request(RequestHead),
    Closed,
    TooLarge,
    Malformed,
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn parse_head(raw: &[u8]) -> Option<RequestHead> {
    let text = String::from_utf8_lossy(raw);
    let mut lines = text.split("\r\n");
    let request_line = lines.next()?;
    let parts: Vec<&str> = request_line.split_whitespace().collect();
    if parts.len() < 2 || parts.len() > 3 {
        return None;
    }
    let method = parts[0];
    if method.is_empty() || !method.bytes().all(|b| b.is_ascii_alphabetic() || b == b'-') {
        return None;
    }
    let version = parts
        .get(2)
        .copied()
        .unwrap_or("HTTP/1.1")
        .to_ascii_uppercase();
    let mut headers: HashMap<String, String> = HashMap::new();
    for line in lines {
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        let key = k.trim().to_ascii_lowercase();
        if key.is_empty() || key.contains(char::is_whitespace) {
            continue;
        }
        let value = v.trim().to_string();
        headers
            .entry(key)
            .and_modify(|existing| {
                existing.push_str(", ");
                existing.push_str(&value);
            })
            .or_insert(value);
    }
    Some(RequestHead {
        method: method.to_ascii_uppercase(),
        target: parts[1].to_string(),
        version,
        headers,
    })
}

async fn read_head<R: AsyncRead + Unpin>(
    io: &mut R,
    buf: &mut Vec<u8>,
    idle: Duration,
) -> HeadResult {
    loop {
        // Tolerate empty lines between pipelined requests (RFC 9112 2.2).
        while buf.starts_with(b"\r\n") {
            buf.drain(..2);
        }
        if let Some(pos) = find_subsequence(buf, b"\r\n\r\n") {
            let head = parse_head(&buf[..pos]);
            buf.drain(..pos + 4);
            return match head {
                Some(h) => HeadResult::Request(h),
                None => HeadResult::Malformed,
            };
        }
        if buf.len() > MAX_HEADER_BYTES {
            return HeadResult::TooLarge;
        }
        buf.reserve(16 * 1024);
        match tokio::time::timeout(idle, io.read_buf(buf)).await {
            Ok(Ok(0)) | Ok(Err(_)) | Err(_) => return HeadResult::Closed,
            Ok(Ok(_)) => {}
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Framing {
    Length(u64),
    Chunked,
}

impl Framing {
    fn has_body(self) -> bool {
        self != Framing::Length(0)
    }
}

/// Body framing of a request, or the status to answer when it cannot be handled.
fn body_framing(headers: &HashMap<String, String>) -> Result<Framing, u16> {
    if let Some(te) = headers.get("transfer-encoding") {
        let codings: Vec<String> = te
            .split(',')
            .map(|c| c.trim().to_ascii_lowercase())
            .filter(|c| !c.is_empty())
            .collect();
        let chunked_last = codings.last().map(|c| c == "chunked").unwrap_or(false);
        let only_known = codings.iter().all(|c| c == "chunked" || c == "identity");
        let chunked_once = codings.iter().filter(|c| *c == "chunked").count() == 1;
        if chunked_last && only_known && chunked_once {
            return Ok(Framing::Chunked);
        }
        if codings.iter().all(|c| c == "identity") {
            // `identity` alone means no transfer coding: fall through to Content-Length.
        } else {
            return Err(501);
        }
    }
    let Some(cl) = headers.get("content-length") else {
        return Ok(Framing::Length(0));
    };
    let mut value: Option<u64> = None;
    for part in cl.split(',') {
        let p = part.trim();
        if p.is_empty() || p.len() > 19 || !p.bytes().all(|b| b.is_ascii_digit()) {
            return Err(400);
        }
        let n: u64 = p.parse().map_err(|_| 400u16)?;
        if value.is_some_and(|prev| prev != n) {
            return Err(400);
        }
        value = Some(n);
    }
    Ok(Framing::Length(value.unwrap_or(0)))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BodyError {
    /// The client sent fewer bytes than announced, stalled, or disconnected.
    Truncated,
    /// Invalid chunked framing.
    Malformed,
    /// Larger than the limit for this request.
    TooLarge,
}

#[derive(Debug, Clone, Copy)]
enum BodyState {
    Length { remaining: u64 },
    Chunked { remaining: u64, need_crlf: bool },
    Done,
}

/// Reads exactly one request body (Content-Length or chunked) from `io`, using `buf`
/// for bytes already received. Bytes after the body stay in `buf` for the next
/// pipelined request.
struct BodyReader<'a, R> {
    io: &'a mut R,
    buf: &'a mut Vec<u8>,
    state: BodyState,
    idle: Duration,
}

fn parse_chunk_size(line: &[u8]) -> Option<u64> {
    let s = std::str::from_utf8(line).ok()?;
    let size = s.split(';').next()?.trim();
    if size.is_empty() || size.len() > 16 || !size.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    u64::from_str_radix(size, 16).ok()
}

impl<'a, R: AsyncRead + Unpin> BodyReader<'a, R> {
    fn new(io: &'a mut R, buf: &'a mut Vec<u8>, framing: Framing, idle: Duration) -> Self {
        let state = match framing {
            Framing::Length(0) => BodyState::Done,
            Framing::Length(n) => BodyState::Length { remaining: n },
            Framing::Chunked => BodyState::Chunked {
                remaining: 0,
                need_crlf: false,
            },
        };
        Self {
            io,
            buf,
            state,
            idle,
        }
    }

    fn is_done(&self) -> bool {
        matches!(self.state, BodyState::Done)
    }

    async fn fill(&mut self) -> Result<(), BodyError> {
        self.buf.reserve(READ_PIECE);
        match tokio::time::timeout(self.idle, self.io.read_buf(&mut *self.buf)).await {
            Ok(Ok(0)) | Ok(Err(_)) | Err(_) => Err(BodyError::Truncated),
            Ok(Ok(_)) => Ok(()),
        }
    }

    fn take(&mut self, n: usize) -> Bytes {
        let piece = Bytes::copy_from_slice(&self.buf[..n]);
        self.buf.drain(..n);
        piece
    }

    /// Next piece of body data (at most `max` bytes), or `None` once the body ended.
    async fn next_piece(&mut self, max: usize) -> Result<Option<Bytes>, BodyError> {
        loop {
            match self.state {
                BodyState::Done => return Ok(None),
                BodyState::Length { remaining } => {
                    if remaining == 0 {
                        self.state = BodyState::Done;
                        return Ok(None);
                    }
                    if self.buf.is_empty() {
                        self.fill().await?;
                        continue;
                    }
                    let n = (remaining.min(self.buf.len() as u64) as usize).min(max);
                    let piece = self.take(n);
                    let left = remaining - n as u64;
                    self.state = if left == 0 {
                        BodyState::Done
                    } else {
                        BodyState::Length { remaining: left }
                    };
                    return Ok(Some(piece));
                }
                BodyState::Chunked {
                    remaining,
                    need_crlf,
                } => {
                    if remaining > 0 {
                        if self.buf.is_empty() {
                            self.fill().await?;
                            continue;
                        }
                        let n = (remaining.min(self.buf.len() as u64) as usize).min(max);
                        let piece = self.take(n);
                        let left = remaining - n as u64;
                        self.state = BodyState::Chunked {
                            remaining: left,
                            need_crlf: left == 0,
                        };
                        return Ok(Some(piece));
                    }
                    if need_crlf {
                        if self.buf.len() < 2 {
                            self.fill().await?;
                            continue;
                        }
                        if &self.buf[..2] != b"\r\n" {
                            return Err(BodyError::Malformed);
                        }
                        self.buf.drain(..2);
                        self.state = BodyState::Chunked {
                            remaining: 0,
                            need_crlf: false,
                        };
                        continue;
                    }
                    let Some(pos) = find_subsequence(&self.buf[..], b"\r\n") else {
                        if self.buf.len() > MAX_CHUNK_LINE {
                            return Err(BodyError::Malformed);
                        }
                        self.fill().await?;
                        continue;
                    };
                    let size = parse_chunk_size(&self.buf[..pos]).ok_or(BodyError::Malformed)?;
                    self.buf.drain(..pos + 2);
                    if size == 0 {
                        self.read_trailers().await?;
                        self.state = BodyState::Done;
                        return Ok(None);
                    }
                    self.state = BodyState::Chunked {
                        remaining: size,
                        need_crlf: false,
                    };
                }
            }
        }
    }

    async fn read_trailers(&mut self) -> Result<(), BodyError> {
        let mut total = 0usize;
        loop {
            match find_subsequence(&self.buf[..], b"\r\n") {
                Some(0) => {
                    self.buf.drain(..2);
                    return Ok(());
                }
                Some(pos) => {
                    total += pos + 2;
                    if total > MAX_TRAILER_BYTES {
                        return Err(BodyError::Malformed);
                    }
                    self.buf.drain(..pos + 2);
                }
                None => {
                    if self.buf.len() > MAX_TRAILER_BYTES {
                        return Err(BodyError::Malformed);
                    }
                    self.fill().await?;
                }
            }
        }
    }

    async fn read_to_vec(&mut self, cap: usize) -> Result<Vec<u8>, BodyError> {
        let mut out = Vec::new();
        while let Some(p) = self.next_piece(READ_PIECE).await? {
            if out.len() + p.len() > cap {
                return Err(BodyError::TooLarge);
            }
            out.extend_from_slice(&p);
        }
        Ok(out)
    }
}

// ---------------------- SECURITY CHECKS ----------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Rejection {
    MissingHost,
    WrongHost,
    BrowserRequest,
}

fn is_allowed_host(host: &str, port: u16) -> bool {
    let h = host.trim().to_ascii_lowercase();
    h == format!("127.0.0.1:{}", port) || h == format!("localhost:{}", port)
}

/// DNS-rebinding / CSRF protection: only native WebDAV clients talking to
/// `127.0.0.1:<port>` / `localhost:<port>` are served; anything a browser sends with
/// an `Origin` (or a cross-site `Sec-Fetch-Site`) is refused.
fn check_request_headers(headers: &HashMap<String, String>, port: u16) -> Result<(), Rejection> {
    if headers.contains_key("origin") {
        return Err(Rejection::BrowserRequest);
    }
    if let Some(site) = headers.get("sec-fetch-site") {
        if !site.trim().eq_ignore_ascii_case("none") {
            return Err(Rejection::BrowserRequest);
        }
    }
    let host = headers.get("host").ok_or(Rejection::MissingHost)?;
    if is_allowed_host(host, port) {
        Ok(())
    } else {
        Err(Rejection::WrongHost)
    }
}

fn token_matches(given: &str, expected: &str) -> bool {
    let (a, b) = (given.as_bytes(), expected.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

// ---------------------- PATHS ----------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PathError {
    /// Malformed escape, invalid UTF-8, NUL or an encoded `/` inside a name.
    BadRequest,
    /// `..` above the share root.
    Forbidden,
    /// Outside the share (missing/wrong token or foreign authority).
    NotFound,
}

/// Splits a request target into `(authority, path)`: drops `scheme://authority`,
/// the query and the fragment.
fn split_target(raw: &str) -> (Option<&str>, &str) {
    let (authority, rest) = match raw.find("://") {
        Some(idx) => {
            let after = &raw[idx + 3..];
            match after.find('/') {
                Some(p) => (Some(&after[..p]), &after[p..]),
                None => (Some(after), "/"),
            }
        }
        None => (None, raw),
    };
    let path = rest.split(['?', '#']).next().unwrap_or(rest);
    (authority, path)
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Full percent-decoding to bytes. `strict` rejects malformed escapes (`%G1`, `%4`);
/// otherwise they are kept literally.
fn percent_decode_bytes(s: &str, strict: bool) -> Option<Vec<u8>> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hi = bytes.get(i + 1).copied().and_then(hex_val);
            let lo = bytes.get(i + 2).copied().and_then(hex_val);
            match (hi, lo) {
                (Some(h), Some(l)) => {
                    out.push(h * 16 + l);
                    i += 3;
                    continue;
                }
                _ if strict => return None,
                _ => {}
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    Some(out)
}

/// Decodes a URL path into normalized segments: every segment is fully
/// percent-decoded as UTF-8 (accents, spaces, parentheses, `&`, `'`...), empty and `.`
/// segments are dropped and `..` removes the previous one. An encoded `/` (`%2F`)
/// cannot become a separator: such names are rejected, as are NUL bytes and invalid
/// UTF-8. Going above the root is `Forbidden`.
fn decode_path_segments(path: &str) -> Result<Vec<String>, PathError> {
    let mut out: Vec<String> = Vec::new();
    for raw in path.split('/') {
        if raw.is_empty() {
            continue;
        }
        let bytes = percent_decode_bytes(raw, true).ok_or(PathError::BadRequest)?;
        let seg = String::from_utf8(bytes).map_err(|_| PathError::BadRequest)?;
        if seg.contains('\0') || seg.contains('/') {
            return Err(PathError::BadRequest);
        }
        // On Windows a backslash is a separator for local paths.
        if cfg!(windows) && seg.contains('\\') {
            return Err(PathError::BadRequest);
        }
        match seg.as_str() {
            "." => {}
            ".." => {
                if out.pop().is_none() {
                    return Err(PathError::Forbidden);
                }
            }
            _ => out.push(seg),
        }
    }
    Ok(out)
}

/// Request target -> segments inside the share (token removed).
fn parse_target(raw: &str, token: Option<&str>, port: u16) -> Result<Vec<String>, PathError> {
    let (authority, path) = split_target(raw);
    if let Some(auth) = authority {
        let host = auth.rsplit('@').next().unwrap_or(auth);
        if !is_allowed_host(host, port) {
            return Err(PathError::NotFound);
        }
    }
    let segs = decode_path_segments(path)?;
    match token {
        None => Ok(segs),
        Some(t) => match segs.first() {
            Some(first) if token_matches(first, t) => Ok(segs[1..].to_vec()),
            _ => Err(PathError::NotFound),
        },
    }
}

/// Destination header of MOVE/COPY -> segments inside the share, or the status code.
fn parse_destination(raw: &str, shared: &Shared) -> Result<Vec<String>, u16> {
    let raw = raw.trim();
    if let Some(idx) = raw.find("://") {
        if !raw[..idx].eq_ignore_ascii_case("http") {
            return Err(502);
        }
    } else if !raw.starts_with('/') {
        return Err(400);
    }
    match parse_target(raw, shared.token.as_deref(), shared.port) {
        Ok(segs) => Ok(segs),
        Err(PathError::BadRequest) => Err(400),
        Err(PathError::Forbidden) => Err(403),
        // Another server or outside the share.
        Err(PathError::NotFound) => Err(502),
    }
}

/// Percent-encodes one path segment (everything but unreserved characters).
fn encode_segment(seg: &str) -> String {
    let mut out = String::with_capacity(seg.len());
    for b in seg.bytes() {
        match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
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

/// Maps a WebDAV path onto the mount root. `.`/`..` segments are resolved and can
/// never climb above `mount_root`.
pub fn resolve_remote_path(webdav_path: &str, mount_root: &str) -> String {
    let mut segs: Vec<String> = Vec::new();
    for s in webdav_path.split('/') {
        match s {
            "" | "." => {}
            ".." => {
                segs.pop();
            }
            other => segs.push(other.to_string()),
        }
    }
    join_remote(mount_root, &segs)
}

pub fn to_webdav_href(remote_path: &str, mount_root: &str, is_dir: bool) -> String {
    let clean_root = mount_root.trim_end_matches('/');
    let under_root = !clean_root.is_empty()
        && remote_path.starts_with(clean_root)
        && (remote_path.len() == clean_root.len()
            || remote_path.as_bytes()[clean_root.len()] == b'/');
    let rel = if under_root {
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

/// Decodes the path of a request target or Destination header: strips
/// `scheme://authority`, query and fragment, then fully percent-decodes it as UTF-8
/// (`%C3%A7` -> `ç`, `%28` -> `(`...). Malformed escapes are kept literally and
/// invalid UTF-8 is replaced. Request handling uses the stricter segment decoder.
pub fn decode_url_path(raw: &str) -> String {
    let (_, path) = split_target(raw);
    let bytes = percent_decode_bytes(path, false).unwrap_or_else(|| path.as_bytes().to_vec());
    let decoded = match String::from_utf8(bytes) {
        Ok(s) => s,
        Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
    };
    if decoded.is_empty() {
        "/".to_string()
    } else {
        decoded
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

// ---------------------- RANGES ----------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RangeOutcome {
    /// Inclusive byte range inside the file.
    Satisfiable(u64, u64),
    /// Valid syntax but no byte of it exists (answer 416).
    Unsatisfiable,
    /// Not a byte range we understand: serve the whole file (RFC 9110 14.2).
    Ignore,
}

/// Parses a `Range` header against a file of `total` bytes. For a multi-range request
/// only the first range is served.
fn parse_range(header: &str, total: u64) -> RangeOutcome {
    let s = header.trim();
    if s.len() < 6 || !s[..6].eq_ignore_ascii_case("bytes=") {
        return RangeOutcome::Ignore;
    }
    let Some(first) = s[6..].split(',').map(str::trim).find(|r| !r.is_empty()) else {
        return RangeOutcome::Ignore;
    };
    let Some((a, b)) = first.split_once('-') else {
        return RangeOutcome::Ignore;
    };
    let (a, b) = (a.trim(), b.trim());
    let num = |v: &str| -> Option<u64> {
        if v.is_empty() || !v.bytes().all(|c| c.is_ascii_digit()) {
            None
        } else {
            v.parse().ok()
        }
    };
    if a.is_empty() {
        // Suffix: the last N bytes.
        let Some(n) = num(b) else {
            return RangeOutcome::Ignore;
        };
        if n == 0 || total == 0 {
            return RangeOutcome::Unsatisfiable;
        }
        return RangeOutcome::Satisfiable(total.saturating_sub(n), total - 1);
    }
    let Some(start) = num(a) else {
        return RangeOutcome::Ignore;
    };
    let end = if b.is_empty() {
        None
    } else {
        match num(b) {
            Some(e) if e >= start => Some(e),
            _ => return RangeOutcome::Ignore,
        }
    };
    if start >= total {
        return RangeOutcome::Unsatisfiable;
    }
    let last = total - 1;
    RangeOutcome::Satisfiable(start, end.map(|e| e.min(last)).unwrap_or(last))
}

pub fn parse_range_header(header: &str, total_len: usize) -> Option<(usize, usize)> {
    if total_len == 0 {
        return None;
    }
    match parse_range(header, total_len as u64) {
        RangeOutcome::Satisfiable(s, e) => Some((s as usize, e as usize)),
        _ => None,
    }
}

// ---------------------- RESPONSES ----------------------

fn reason(code: u16) -> &'static str {
    match code {
        100 => "Continue",
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        206 => "Partial Content",
        207 => "Multi-Status",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        411 => "Length Required",
        412 => "Precondition Failed",
        413 => "Content Too Large",
        415 => "Unsupported Media Type",
        416 => "Range Not Satisfiable",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        502 => "Bad Gateway",
        504 => "Gateway Timeout",
        507 => "Insufficient Storage",
        _ => "Unknown",
    }
}

fn head_block(code: u16, headers: &[(&str, String)], content_length: u64, close: bool) -> String {
    let mut out = format!("HTTP/1.1 {} {}\r\n", code, reason(code));
    for (k, v) in headers {
        out.push_str(k);
        out.push_str(": ");
        out.push_str(v);
        out.push_str("\r\n");
    }
    out.push_str(&format!("Content-Length: {}\r\n", content_length));
    out.push_str(if close {
        "Connection: close\r\n"
    } else {
        "Connection: keep-alive\r\n"
    });
    out.push_str("\r\n");
    out
}

async fn send_simple<W: AsyncWrite + Unpin>(
    w: &mut W,
    code: u16,
    headers: &[(&str, String)],
    body: &[u8],
    close: bool,
) -> std::io::Result<()> {
    let head = head_block(code, headers, body.len() as u64, close);
    if body.len() <= 64 * 1024 {
        let mut all = head.into_bytes();
        all.extend_from_slice(body);
        w.write_all(&all).await?;
    } else {
        w.write_all(head.as_bytes()).await?;
        w.write_all(body).await?;
    }
    w.flush().await
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Op {
    Read,
    Write,
}

fn status_from_message(msg: &str, not_found: u16) -> u16 {
    let m = msg.to_ascii_lowercase();
    if m.contains("no space") || m.contains("quota") || m.contains("disk full") {
        507
    } else if m.contains("permission denied") || m.contains("access denied") {
        403
    } else if m.contains("no such file") || m.contains("not found") || m.contains("does not exist")
    {
        not_found
    } else {
        502
    }
}

fn is_no_space(io: &std::io::Error) -> bool {
    #[cfg(unix)]
    {
        matches!(io.raw_os_error(), Some(code) if code == libc::ENOSPC || code == libc::EDQUOT)
    }
    #[cfg(windows)]
    {
        // ERROR_HANDLE_DISK_FULL, ERROR_DISK_FULL
        matches!(io.raw_os_error(), Some(39) | Some(112))
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = io;
        false
    }
}

/// HTTP status for a VFS error. For writes a missing path means a missing parent
/// (409 Conflict, RFC 4918), for reads it is 404.
fn error_status(e: &CoreError, op: Op) -> u16 {
    let not_found = if op == Op::Write { 409 } else { 404 };
    match e {
        CoreError::NotFound(_) => not_found,
        CoreError::PermissionDenied(_) | CoreError::PathTraversal(_) => 403,
        CoreError::InvalidPath(_) => 400,
        CoreError::Timeout(_) => 504,
        CoreError::ConnectionFailed(_)
        | CoreError::AuthFailed(_)
        | CoreError::HostKeyMismatch(_) => 502,
        CoreError::Io(io) => {
            if is_no_space(io) {
                return 507;
            }
            match io.kind() {
                std::io::ErrorKind::NotFound => not_found,
                std::io::ErrorKind::PermissionDenied => 403,
                std::io::ErrorKind::TimedOut => 504,
                _ => status_from_message(&io.to_string(), not_found),
            }
        }
        other => status_from_message(&other.to_string(), not_found),
    }
}

fn http_date(t: Option<DateTime<Utc>>) -> String {
    match t {
        Some(t) => t.format("%a, %d %b %Y %H:%M:%S GMT").to_string(),
        None => "Thu, 01 Jan 1970 00:00:00 GMT".to_string(),
    }
}

fn etag_for(entry: &FileEntry) -> String {
    format!(
        "\"{}-{}\"",
        entry.size,
        entry.modified_at.map(|t| t.timestamp()).unwrap_or(0)
    )
}

fn wants_close(head: &RequestHead) -> bool {
    match head.headers.get("connection") {
        Some(v) => {
            let tokens: Vec<String> = v
                .split(',')
                .map(|t| t.trim().to_ascii_lowercase())
                .collect();
            if tokens.iter().any(|t| t == "close") {
                true
            } else if head.version == "HTTP/1.0" {
                !tokens.iter().any(|t| t == "keep-alive")
            } else {
                false
            }
        }
        None => head.version == "HTTP/1.0",
    }
}

async fn maybe_continue(stream: &mut TcpStream, head: &RequestHead) -> std::io::Result<()> {
    let expects = head
        .headers
        .get("expect")
        .map(|v| v.trim().eq_ignore_ascii_case("100-continue"))
        .unwrap_or(false);
    if expects && head.version == "HTTP/1.1" {
        stream.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").await?;
        stream.flush().await?;
    }
    Ok(())
}

// ---------------------- CONNECTION LOOP ----------------------

async fn serve_connection(mut stream: TcpStream, shared: Arc<Shared>) {
    let mut buf: Vec<u8> = Vec::with_capacity(16 * 1024);
    loop {
        let head = match read_head(&mut stream, &mut buf, KEEP_ALIVE_IDLE).await {
            HeadResult::Request(h) => h,
            HeadResult::Closed => return,
            HeadResult::TooLarge => {
                let _ = send_simple(&mut stream, 431, &[], b"", true).await;
                return;
            }
            HeadResult::Malformed => {
                let _ = send_simple(&mut stream, 400, &[], b"", true).await;
                return;
            }
        };
        match handle_request(&mut stream, &mut buf, head, &shared).await {
            Ok(false) => continue,
            Ok(true) | Err(_) => {
                let _ = stream.shutdown().await;
                return;
            }
        }
    }
}

/// Handles one request. Returns `true` when the connection must be closed.
async fn handle_request(
    stream: &mut TcpStream,
    buf: &mut Vec<u8>,
    head: RequestHead,
    shared: &Shared,
) -> std::io::Result<bool> {
    let close = wants_close(&head);
    let method = head.method.clone();

    if let Err(rej) = check_request_headers(&head.headers, shared.port) {
        tracing::warn!("WebDAV: refused {} request ({:?})", method, rej);
        let code = if rej == Rejection::MissingHost {
            400
        } else {
            403
        };
        send_simple(stream, code, &[], b"", true).await?;
        return Ok(true);
    }

    let framing = match body_framing(&head.headers) {
        Ok(f) => f,
        Err(code) => {
            send_simple(stream, code, &[], b"", true).await?;
            return Ok(true);
        }
    };

    // OPTIONS exposes nothing and works on any path (Windows probes the server root).
    if method == "OPTIONS" {
        if framing.has_body() {
            maybe_continue(stream, &head).await?;
            let mut reader = BodyReader::new(&mut *stream, &mut *buf, framing, BODY_IDLE);
            if reader.read_to_vec(MAX_SMALL_BODY).await.is_err() {
                send_simple(stream, 400, &[], b"", true).await?;
                return Ok(true);
            }
        }
        let headers = [
            ("DAV", "1, 2".to_string()),
            ("MS-Author-Via", "DAV".to_string()),
            ("Allow", ALLOW_METHODS.to_string()),
            ("Accept-Ranges", "bytes".to_string()),
        ];
        send_simple(stream, 200, &headers, b"", close).await?;
        return Ok(close);
    }

    let segs = match parse_target(&head.target, shared.token.as_deref(), shared.port) {
        Ok(s) => s,
        Err(e) => {
            let code = match e {
                PathError::BadRequest => 400,
                PathError::Forbidden => 403,
                PathError::NotFound => 404,
            };
            let c = close || framing.has_body();
            send_simple(stream, code, &[], b"", c).await?;
            return Ok(c);
        }
    };
    let webdav_path = format!("/{}", segs.join("/"));
    let remote_path = shared.remote_path(&segs);
    let is_probe = !segs.is_empty() && is_os_system_probe(&webdav_path);

    if method == "PUT" && !is_probe {
        return handle_put(
            stream,
            buf,
            &head,
            framing,
            shared,
            &segs,
            &remote_path,
            close,
        )
        .await;
    }

    // Every other body is small XML (or a probe file kept in memory).
    let limit = if is_probe {
        PROBE_FILE_MAX
    } else {
        MAX_SMALL_BODY
    };
    let mut body = Vec::new();
    if framing.has_body() {
        maybe_continue(stream, &head).await?;
        let mut reader = BodyReader::new(&mut *stream, &mut *buf, framing, BODY_IDLE);
        match reader.read_to_vec(limit).await {
            Ok(v) => body = v,
            Err(BodyError::TooLarge) if is_probe && method == "PUT" => {
                // Oversized AppleDouble file: accept and discard it, then close since
                // the rest of the body was not read.
                send_simple(stream, 201, &[], b"", true).await?;
                return Ok(true);
            }
            Err(BodyError::TooLarge) => {
                send_simple(stream, 413, &[], b"", true).await?;
                return Ok(true);
            }
            Err(_) => {
                send_simple(stream, 400, &[], b"", true).await?;
                return Ok(true);
            }
        }
    }

    if is_probe {
        return handle_probe(
            stream,
            &method,
            &head,
            shared,
            &segs,
            &webdav_path,
            body,
            close,
        )
        .await;
    }

    match method.as_str() {
        "PROPFIND" => handle_propfind(stream, &head, shared, &segs, &remote_path, close).await,
        "GET" => handle_get(stream, &head, shared, &remote_path, false, close).await,
        "HEAD" => handle_get(stream, &head, shared, &remote_path, true, close).await,
        "MKCOL" => handle_mkcol(stream, shared, &segs, &remote_path, !body.is_empty(), close).await,
        "DELETE" => handle_delete(stream, shared, &segs, &remote_path, close).await,
        "MOVE" | "COPY" => {
            handle_move_copy(
                stream,
                &head,
                shared,
                &segs,
                &remote_path,
                method == "MOVE",
                close,
            )
            .await
        }
        "LOCK" => handle_lock(stream, shared, &segs, close).await,
        "UNLOCK" => {
            send_simple(stream, 204, &[], b"", close).await?;
            Ok(close)
        }
        "PROPPATCH" => handle_proppatch(stream, shared, &segs, close).await,
        _ => {
            send_simple(
                stream,
                405,
                &[("Allow", ALLOW_METHODS.to_string())],
                b"",
                close,
            )
            .await?;
            Ok(close)
        }
    }
}

/// Metadata of `remote_path` (symlinks resolved to what they point to). Cached entries
/// are used when `allow_cached`, except symlink entries from a directory listing,
/// which say nothing about whether the target is a file or a folder.
async fn fetch_metadata(
    shared: &Shared,
    remote_path: &str,
    allow_cached: bool,
) -> CoreResult<FileEntry> {
    if allow_cached {
        if let Some(m) = shared
            .cache
            .get_entry_metadata(&shared.session_id, remote_path)
            .await
        {
            if !m.is_symlink() {
                return Ok(m);
            }
        }
    }
    let m = shared.vfs.metadata(remote_path).await?;
    shared
        .cache
        .put_entry_metadata(&shared.session_id, m.clone())
        .await;
    Ok(m)
}

// ---------------------- PROPFIND / PROPPATCH / LOCK ----------------------

const XML_HEAD: &str =
    "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<D:multistatus xmlns:D=\"DAV:\">\n";

async fn handle_propfind(
    stream: &mut TcpStream,
    head: &RequestHead,
    shared: &Shared,
    segs: &[String],
    remote_path: &str,
    close: bool,
) -> std::io::Result<bool> {
    let depth_zero = head
        .headers
        .get("depth")
        .map(|d| d.trim() == "0")
        .unwrap_or(false);

    let meta = match fetch_metadata(shared, remote_path, true).await {
        Ok(m) => m,
        // Some backends (e.g. a bucket root) have no metadata for the share root.
        Err(_) if segs.is_empty() => FileEntry {
            name: remote_path.rsplit('/').next().unwrap_or("").to_string(),
            path: remote_path.to_string(),
            file_type: crate::types::FileType::Directory,
            size: 0,
            modified_at: None,
            created_at: None,
            permissions: Default::default(),
            is_hidden: false,
        },
        Err(e) => {
            send_simple(stream, error_status(&e, Op::Read), &[], b"", close).await?;
            return Ok(close);
        }
    };

    let self_href = shared.href(segs, meta.is_dir());
    let display = if meta.name.is_empty() {
        segs.last().cloned().unwrap_or_else(|| "root".to_string())
    } else {
        meta.name.clone()
    };
    let mut xml = String::from(XML_HEAD);
    xml.push_str(&entry_to_webdav_xml(&meta, &self_href, &display));

    if !depth_zero && meta.is_dir() {
        let children = match shared
            .cache
            .get_catalog(&shared.session_id, remote_path)
            .await
        {
            Some(cached) => cached,
            None => match shared.vfs.list_dir(remote_path).await {
                Ok(entries) => {
                    shared
                        .cache
                        .put_catalog(&shared.session_id, remote_path, entries.clone())
                        .await;
                    entries
                }
                Err(e) => {
                    // Never answer an unreadable folder with an empty listing.
                    tracing::warn!("WebDAV PROPFIND listing failed: {e}");
                    send_simple(stream, error_status(&e, Op::Read), &[], b"", close).await?;
                    return Ok(close);
                }
            },
        };
        let base = if self_href.ends_with('/') {
            self_href.clone()
        } else {
            format!("{}/", self_href)
        };
        let mut resolved_links = 0usize;
        for child in &children {
            if !is_listable_name(&child.name) {
                continue;
            }
            // Listings report symlinks as such; show what they point to (a linked
            // folder must be a collection or Finder cannot open it).
            let resolved;
            let entry = if child.is_symlink() && resolved_links < MAX_SYMLINK_RESOLVE {
                resolved_links += 1;
                match fetch_metadata(shared, &join_child(remote_path, &child.name), false).await {
                    Ok(mut m) => {
                        m.name = child.name.clone();
                        resolved = m;
                        &resolved
                    }
                    Err(_) => child,
                }
            } else {
                child
            };
            let href = format!(
                "{}{}{}",
                base,
                encode_segment(&entry.name),
                if entry.is_dir() { "/" } else { "" }
            );
            xml.push_str(&entry_to_webdav_xml(entry, &href, &entry.name));
        }
    }

    xml.push_str("</D:multistatus>");
    send_simple(
        stream,
        207,
        &[("Content-Type", "text/xml; charset=utf-8".to_string())],
        xml.as_bytes(),
        close,
    )
    .await?;
    Ok(close)
}

async fn handle_proppatch(
    stream: &mut TcpStream,
    shared: &Shared,
    segs: &[String],
    close: bool,
) -> std::io::Result<bool> {
    let href = shared.href(segs, false);
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
        href
    );
    send_simple(
        stream,
        207,
        &[("Content-Type", "text/xml; charset=utf-8".to_string())],
        xml.as_bytes(),
        close,
    )
    .await?;
    Ok(close)
}

/// Locks are advisory only (Finder needs class 2 to mount read-write): every LOCK is
/// granted with a fresh token.
async fn handle_lock(
    stream: &mut TcpStream,
    shared: &Shared,
    segs: &[String],
    close: bool,
) -> std::io::Result<bool> {
    let token = uuid::Uuid::new_v4().to_string();
    let href = shared.href(segs, false);
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
        <D:lockroot><D:href>{}</D:href></D:lockroot>\n\
        </D:activelock>\n\
        </D:lockdiscovery>\n\
        </D:prop>",
        token, href
    );
    send_simple(
        stream,
        200,
        &[
            ("Lock-Token", format!("<urn:uuid:{}>", token)),
            ("Content-Type", "text/xml; charset=utf-8".to_string()),
        ],
        xml.as_bytes(),
        close,
    )
    .await?;
    Ok(close)
}

// ---------------------- GET / HEAD ----------------------

async fn cached_if_fresh(shared: &Shared, remote_path: &str, meta: &FileEntry) -> Option<Bytes> {
    let current = stamp_of(meta)?;
    let recorded = shared.stamps.lock().await.get(remote_path).copied();
    match recorded {
        Some(s) if s == current => {
            let data = shared
                .cache
                .get_file_content(&shared.session_id, remote_path)
                .await?;
            if data.len() as u64 == meta.size {
                Some(data)
            } else {
                shared.invalidate(remote_path).await;
                None
            }
        }
        Some(_) => {
            // The remote file changed since it was cached.
            shared
                .cache
                .invalidate_content(&shared.session_id, remote_path)
                .await;
            shared.stamps.lock().await.remove(remote_path);
            None
        }
        // Cached by an earlier run (no stamp): cannot be trusted, refetch.
        None => None,
    }
}

async fn remember_content(shared: &Shared, remote_path: &str, meta: &FileEntry, data: &Bytes) {
    let Some(stamp) = stamp_of(meta) else {
        return;
    };
    if data.len() as u64 != meta.size {
        return;
    }
    if shared
        .cache
        .put_file_content(&shared.session_id, remote_path, data)
        .await
        .is_ok()
    {
        shared
            .stamps
            .lock()
            .await
            .insert(remote_path.to_string(), stamp);
    }
}

async fn handle_get(
    stream: &mut TcpStream,
    head: &RequestHead,
    shared: &Shared,
    remote_path: &str,
    head_only: bool,
    close: bool,
) -> std::io::Result<bool> {
    let has_range = head.headers.contains_key("range");
    // Full downloads re-stat the file so cached content is checked against the live
    // size/mtime; range reads (many per file) may use recent cached metadata.
    let mut meta = match fetch_metadata(shared, remote_path, head_only || has_range).await {
        Ok(m) => m,
        Err(e) => {
            send_simple(stream, error_status(&e, Op::Read), &[], b"", close).await?;
            return Ok(close);
        }
    };

    // Small files are read whole (and cached); before doing that without a fresh
    // cached copy, make sure the size is current, so a file that grew since it was
    // listed is streamed instead of loaded into memory.
    let mut cached = None;
    if !head_only && !meta.is_dir() && meta.size <= CACHE_MAX_FILE {
        cached = cached_if_fresh(shared, remote_path, &meta).await;
        if cached.is_none() && has_range {
            meta = match fetch_metadata(shared, remote_path, false).await {
                Ok(m) => m,
                Err(e) => {
                    send_simple(stream, error_status(&e, Op::Read), &[], b"", close).await?;
                    return Ok(close);
                }
            };
        }
    }

    if meta.is_dir() {
        if head_only {
            send_simple(
                stream,
                200,
                &[("Content-Type", "httpd/unix-directory".to_string())],
                b"",
                close,
            )
            .await?;
        } else {
            send_simple(
                stream,
                405,
                &[("Allow", ALLOW_METHODS.to_string())],
                b"",
                close,
            )
            .await?;
        }
        return Ok(close);
    }

    let etag = etag_for(&meta);
    let last_modified = http_date(meta.modified_at);
    let mut headers: Vec<(&str, String)> = vec![
        ("Content-Type", guess_mime_type(remote_path).to_string()),
        ("Accept-Ranges", "bytes".to_string()),
        ("ETag", etag.clone()),
        ("Last-Modified", last_modified.clone()),
    ];

    if head_only {
        let block = head_block(200, &headers, meta.size, close);
        stream.write_all(block.as_bytes()).await?;
        stream.flush().await?;
        return Ok(close);
    }

    let if_range_ok = match head.headers.get("if-range") {
        None => true,
        Some(v) => v.trim() == etag || v.trim() == last_modified,
    };
    let range_header = head.headers.get("range").filter(|_| if_range_ok).cloned();

    if meta.size <= CACHE_MAX_FILE {
        let data = match cached {
            Some(d) => d,
            None => match shared.vfs.read_file(remote_path).await {
                Ok(d) => {
                    remember_content(shared, remote_path, &meta, &d).await;
                    d
                }
                Err(e) => {
                    send_simple(stream, error_status(&e, Op::Read), &[], b"", close).await?;
                    return Ok(close);
                }
            },
        };
        let total = data.len() as u64;
        match range_header.as_deref().map(|r| parse_range(r, total)) {
            Some(RangeOutcome::Unsatisfiable) => {
                headers.push(("Content-Range", format!("bytes */{}", total)));
                send_simple(stream, 416, &headers, b"", close).await?;
            }
            Some(RangeOutcome::Satisfiable(s, e)) => {
                let slice = &data[s as usize..=e as usize];
                headers.push(("Content-Range", format!("bytes {}-{}/{}", s, e, total)));
                send_simple(stream, 206, &headers, slice, close).await?;
                shared
                    .read_bytes
                    .fetch_add(slice.len() as u64, Ordering::Relaxed);
            }
            _ => {
                send_simple(stream, 200, &headers, &data, close).await?;
                shared.read_bytes.fetch_add(total, Ordering::Relaxed);
            }
        }
        return Ok(close);
    }

    // Large file: stream exactly the requested bytes, never caching them.
    let total = meta.size;
    let (code, start, len) = match range_header.as_deref().map(|r| parse_range(r, total)) {
        Some(RangeOutcome::Unsatisfiable) => {
            headers.push(("Content-Range", format!("bytes */{}", total)));
            send_simple(stream, 416, &headers, b"", close).await?;
            return Ok(close);
        }
        Some(RangeOutcome::Satisfiable(s, e)) => {
            headers.push(("Content-Range", format!("bytes {}-{}/{}", s, e, total)));
            (206, s, e - s + 1)
        }
        _ => (200, 0, total),
    };
    stream_remote(
        stream,
        shared,
        remote_path,
        code,
        &headers,
        start,
        len,
        close,
    )
    .await
}

/// Streams `len` bytes from `start` with `read_range`, overlapping the socket write of
/// one piece with the remote read of the next. The first piece is read before the
/// headers so a remote error still gets a proper status; a later failure (or a file
/// that shrank) aborts the connection so the client never mistakes a short body for
/// the whole file.
#[allow(clippy::too_many_arguments)]
async fn stream_remote(
    stream: &mut TcpStream,
    shared: &Shared,
    remote_path: &str,
    code: u16,
    headers: &[(&str, String)],
    start: u64,
    len: u64,
    close: bool,
) -> std::io::Result<bool> {
    let first_len = len.min(STREAM_CHUNK);
    let mut piece = if first_len == 0 {
        Bytes::new()
    } else {
        match shared.vfs.read_range(remote_path, start, first_len).await {
            Ok(b) => b,
            Err(e) => {
                send_simple(stream, error_status(&e, Op::Read), &[], b"", close).await?;
                return Ok(close);
            }
        }
    };
    let block = head_block(code, headers, len, close);
    stream.write_all(block.as_bytes()).await?;

    let mut sent = 0u64;
    while sent < len {
        if piece.is_empty() {
            return Ok(true);
        }
        let take = (piece.len() as u64).min(len - sent) as usize;
        let after = sent + take as u64;
        let next_len = (len - after).min(STREAM_CHUNK);
        if next_len == 0 {
            stream.write_all(&piece[..take]).await?;
            shared.read_bytes.fetch_add(take as u64, Ordering::Relaxed);
            sent = after;
            break;
        }
        let (written, next) = tokio::join!(
            stream.write_all(&piece[..take]),
            shared.vfs.read_range(remote_path, start + after, next_len)
        );
        written?;
        shared.read_bytes.fetch_add(take as u64, Ordering::Relaxed);
        sent = after;
        piece = match next {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!("WebDAV GET aborted mid-stream: {e}");
                return Ok(true);
            }
        };
    }
    stream.flush().await?;
    Ok(close || sent < len)
}

// ---------------------- PUT ----------------------

enum UploadError {
    Body(BodyError),
    Remote { err: CoreError, body_done: bool },
}

fn is_permission_error(e: &CoreError) -> bool {
    match e {
        CoreError::PermissionDenied(_) => true,
        CoreError::Io(io) => io.kind() == std::io::ErrorKind::PermissionDenied,
        _ => false,
    }
}

/// Moves `src` over `dst`. When a plain rename cannot replace an existing file
/// (SFTP v3 refuses to overwrite), the old file is first renamed to a hidden backup,
/// restored if the second rename fails, and deleted after success: the target always
/// holds either the old or the new content. `upload` = `src` is our temp file (it is
/// deleted on failure, and the old file's permission bits are applied to it).
async fn replace_file(
    vfs: &Arc<dyn VirtualFileSystem>,
    src: &str,
    dst: &str,
    existing: Option<&FileEntry>,
    upload: bool,
) -> CoreResult<()> {
    if upload {
        if let Some(old) = existing {
            let mode = old.permissions.mode & 0o7777;
            if vfs.supports_permissions() && mode != 0 {
                let _ = vfs.set_permissions(src, mode).await;
            }
        }
    }
    let first = match vfs.rename(src, dst).await {
        Ok(()) => return Ok(()),
        Err(e) => e,
    };
    let dst_exists = existing.is_some() || vfs.exists(dst).await.unwrap_or(false);
    if !dst_exists {
        if upload {
            let _ = vfs.remove_file(src).await;
        }
        return Err(first);
    }
    let backup = sibling_temp_path(dst, REPLACED_TEMP_PREFIX);
    if let Err(e) = vfs.rename(dst, &backup).await {
        if upload {
            let _ = vfs.remove_file(src).await;
        }
        return Err(e);
    }
    match vfs.rename(src, dst).await {
        Ok(()) => {
            let _ = vfs.remove_file(&backup).await;
            Ok(())
        }
        Err(e) => {
            let _ = vfs.rename(&backup, dst).await;
            if upload {
                let _ = vfs.remove_file(src).await;
            }
            Err(e)
        }
    }
}

/// True when the parent listing shows `remote_path` as a symlink.
async fn is_symlink_entry(shared: &Shared, remote_path: &str) -> bool {
    let Some(idx) = remote_path.rfind('/') else {
        return false;
    };
    let parent = if idx == 0 { "/" } else { &remote_path[..idx] };
    let name = &remote_path[idx + 1..];
    let entries = match shared.cache.get_catalog(&shared.session_id, parent).await {
        Some(c) => c,
        None => match shared.vfs.list_dir(parent).await {
            Ok(e) => {
                shared
                    .cache
                    .put_catalog(&shared.session_id, parent, e.clone())
                    .await;
                e
            }
            Err(_) => return false,
        },
    };
    entries.iter().any(|e| e.name == name && e.is_symlink())
}

/// True when a freshly created file gets another owner or group than `old` has.
async fn owner_differs(vfs: &Arc<dyn VirtualFileSystem>, temp: &str, old: &FileEntry) -> bool {
    let Ok(t) = vfs.metadata(temp).await else {
        return false;
    };
    let differs =
        |a: &Option<String>, b: &Option<String>| matches!((a, b), (Some(x), Some(y)) if x != y);
    differs(&t.permissions.owner, &old.permissions.owner)
        || differs(&t.permissions.group, &old.permissions.group)
}

/// Streams the body into a hidden temp file next to the target (positional writes of
/// up to [`STREAM_CHUNK`]), then replaces the target. If the folder does not allow
/// creating new files, the body is collected in memory (bounded) and the target is
/// overwritten only once the body is complete.
async fn upload_streaming<R: AsyncRead + Unpin>(
    reader: &mut BodyReader<'_, R>,
    shared: &Shared,
    remote_path: &str,
    existing: Option<&FileEntry>,
    expected: Option<u64>,
) -> Result<u64, UploadError> {
    let vfs = &shared.vfs;
    let temp = sibling_temp_path(remote_path, UPLOAD_TEMP_PREFIX);
    let mut direct = false;
    let mut offset: u64 = 0;
    let mut started = false;
    let mut pending = BytesMut::new();

    loop {
        let piece = match reader.next_piece(READ_PIECE).await {
            Ok(p) => p,
            Err(e) => {
                if started {
                    let _ = vfs.remove_file(&temp).await;
                }
                return Err(UploadError::Body(e));
            }
        };
        let finished = piece.is_none();
        if let Some(p) = piece {
            if direct && pending.len() as u64 + p.len() as u64 > MAX_BUFFERED_UPLOAD {
                return Err(UploadError::Body(BodyError::TooLarge));
            }
            pending.extend_from_slice(&p);
        }
        let flush = !direct
            && (pending.len() as u64 >= STREAM_CHUNK
                || (finished && (!pending.is_empty() || !started)));
        if flush {
            let data = pending.split().freeze();
            let len = data.len() as u64;
            match vfs.write_at(&temp, offset, data.clone()).await {
                Ok(()) => {
                    started = true;
                    offset += len;
                }
                Err(e) if offset == 0 && is_permission_error(&e) => {
                    // Cannot create a new file in this folder: keep the body and write
                    // the target in place once it is complete.
                    direct = true;
                    pending.extend_from_slice(&data);
                }
                Err(e) => {
                    let _ = vfs.remove_file(&temp).await;
                    return Err(UploadError::Remote {
                        err: e,
                        body_done: finished,
                    });
                }
            }
        }
        if finished {
            break;
        }
    }

    if direct {
        let n = pending.len() as u64;
        if expected.is_some_and(|exp| exp != n) {
            return Err(UploadError::Body(BodyError::Truncated));
        }
        vfs.write_file(remote_path, pending.freeze())
            .await
            .map_err(|err| UploadError::Remote {
                err,
                body_done: true,
            })?;
        return Ok(n);
    }
    if let Some(exp) = expected {
        if exp != offset {
            let _ = vfs.remove_file(&temp).await;
            return Err(UploadError::Body(BodyError::Truncated));
        }
    }
    if let Some(old) = existing {
        if is_symlink_entry(shared, remote_path).await || owner_differs(vfs, &temp, old).await {
            // Renaming over a symlink would replace the link with a plain file, and over
            // a file owned by someone else would change its owner/group. Rewrite the
            // existing file in place from the complete temp copy instead.
            let res = copy_file(vfs, &temp, remote_path, None).await;
            let _ = vfs.remove_file(&temp).await;
            res.map_err(|err| UploadError::Remote {
                err,
                body_done: true,
            })?;
            return Ok(offset);
        }
    }
    replace_file(vfs, &temp, remote_path, existing, true)
        .await
        .map_err(|err| UploadError::Remote {
            err,
            body_done: true,
        })?;
    Ok(offset)
}

/// For drivers without positional writes: the complete body is received first, and
/// the remote is only touched once it is known to be whole.
async fn upload_buffered<R: AsyncRead + Unpin>(
    reader: &mut BodyReader<'_, R>,
    shared: &Shared,
    remote_path: &str,
    expected: Option<u64>,
) -> Result<u64, UploadError> {
    let mut data = BytesMut::new();
    loop {
        match reader.next_piece(READ_PIECE).await {
            Ok(Some(p)) => {
                if data.len() as u64 + p.len() as u64 > MAX_BUFFERED_UPLOAD {
                    return Err(UploadError::Body(BodyError::TooLarge));
                }
                data.extend_from_slice(&p);
            }
            Ok(None) => break,
            Err(e) => return Err(UploadError::Body(e)),
        }
    }
    let n = data.len() as u64;
    if expected.is_some_and(|exp| exp != n) {
        return Err(UploadError::Body(BodyError::Truncated));
    }
    shared
        .vfs
        .write_file(remote_path, data.freeze())
        .await
        .map_err(|err| UploadError::Remote {
            err,
            body_done: true,
        })?;
    Ok(n)
}

#[allow(clippy::too_many_arguments)]
async fn handle_put(
    stream: &mut TcpStream,
    buf: &mut Vec<u8>,
    head: &RequestHead,
    framing: Framing,
    shared: &Shared,
    segs: &[String],
    remote_path: &str,
    close: bool,
) -> std::io::Result<bool> {
    let body_close = close || framing.has_body();
    if segs.is_empty() {
        send_simple(
            stream,
            405,
            &[("Allow", ALLOW_METHODS.to_string())],
            b"",
            body_close,
        )
        .await?;
        return Ok(body_close);
    }
    let existing = shared.vfs.metadata(remote_path).await.ok();
    if existing.as_ref().is_some_and(|m| m.is_dir()) {
        send_simple(
            stream,
            405,
            &[("Allow", ALLOW_METHODS.to_string())],
            b"",
            body_close,
        )
        .await?;
        return Ok(body_close);
    }
    // macOS sends `X-Expected-Entity-Length` with chunked uploads.
    let expected = head
        .headers
        .get("x-expected-entity-length")
        .and_then(|v| v.trim().parse::<u64>().ok())
        .or(match framing {
            Framing::Length(n) => Some(n),
            Framing::Chunked => None,
        });
    let streaming = shared.vfs.supports_write_at();
    if !streaming && expected.is_some_and(|n| n > MAX_BUFFERED_UPLOAD) {
        send_simple(stream, 413, &[], b"", body_close).await?;
        return Ok(body_close);
    }

    maybe_continue(stream, head).await?;
    let (outcome, body_done) = {
        let mut reader = BodyReader::new(&mut *stream, &mut *buf, framing, BODY_IDLE);
        let res = if streaming {
            upload_streaming(
                &mut reader,
                shared,
                remote_path,
                existing.as_ref(),
                expected,
            )
            .await
        } else {
            upload_buffered(&mut reader, shared, remote_path, expected).await
        };
        (res, reader.is_done())
    };
    shared.invalidate(remote_path).await;

    match outcome {
        Ok(n) => {
            shared.write_bytes.fetch_add(n, Ordering::Relaxed);
            let code = if existing.is_some() { 204 } else { 201 };
            send_simple(stream, code, &[], b"", close).await?;
            Ok(close)
        }
        Err(UploadError::Body(e)) => {
            tracing::warn!("WebDAV PUT rejected: incomplete body ({e:?}); remote file untouched");
            let code = if e == BodyError::TooLarge { 413 } else { 400 };
            send_simple(stream, code, &[], b"", true).await?;
            Ok(true)
        }
        Err(UploadError::Remote {
            err,
            body_done: done,
        }) => {
            tracing::warn!("WebDAV PUT failed: {err}");
            let c = close || !(done || body_done);
            send_simple(stream, error_status(&err, Op::Write), &[], b"", c).await?;
            Ok(c)
        }
    }
}

// ---------------------- MKCOL / DELETE / MOVE / COPY ----------------------

async fn handle_mkcol(
    stream: &mut TcpStream,
    shared: &Shared,
    segs: &[String],
    remote_path: &str,
    has_body: bool,
    close: bool,
) -> std::io::Result<bool> {
    let code = if segs.is_empty() {
        405
    } else if has_body {
        415
    } else if shared.vfs.metadata(remote_path).await.is_ok() {
        405
    } else {
        match shared.vfs.create_dir(remote_path).await {
            Ok(()) => 201,
            Err(e) => {
                tracing::warn!("WebDAV MKCOL failed: {e}");
                error_status(&e, Op::Write)
            }
        }
    };
    shared.invalidate(remote_path).await;
    send_simple(stream, code, &[], b"", close).await?;
    Ok(close)
}

async fn handle_delete(
    stream: &mut TcpStream,
    shared: &Shared,
    segs: &[String],
    remote_path: &str,
    close: bool,
) -> std::io::Result<bool> {
    let code = if segs.is_empty() {
        // Never delete the share root.
        403
    } else {
        match shared.vfs.metadata(remote_path).await {
            Err(e) => error_status(&e, Op::Read),
            Ok(meta) => {
                let res = if meta.is_dir() {
                    shared.vfs.remove_dir(remote_path, true).await
                } else {
                    shared.vfs.remove_file(remote_path).await
                };
                match res {
                    Ok(()) => 204,
                    Err(e) => {
                        tracing::warn!("WebDAV DELETE failed: {e}");
                        error_status(&e, Op::Read)
                    }
                }
            }
        }
    };
    shared.invalidate(remote_path).await;
    send_simple(stream, code, &[], b"", close).await?;
    Ok(close)
}

async fn copy_file(
    vfs: &Arc<dyn VirtualFileSystem>,
    src: &str,
    dst: &str,
    mode: Option<u32>,
) -> CoreResult<()> {
    if vfs.supports_write_at() {
        let mut offset = 0u64;
        loop {
            let res = async {
                let piece = vfs.read_range(src, offset, STREAM_CHUNK).await?;
                let n = piece.len() as u64;
                if n > 0 || offset == 0 {
                    vfs.write_at(dst, offset, piece).await?;
                }
                Ok::<u64, CoreError>(n)
            }
            .await;
            match res {
                Ok(n) => {
                    offset += n;
                    if n < STREAM_CHUNK {
                        break;
                    }
                }
                Err(e) => {
                    if offset > 0 {
                        let _ = vfs.remove_file(dst).await;
                    }
                    return Err(e);
                }
            }
        }
    } else {
        let data = vfs.read_file(src).await?;
        if data.len() as u64 > MAX_BUFFERED_UPLOAD {
            return Err(CoreError::General(format!(
                "'{}' is too large to copy through the virtual disk",
                src
            )));
        }
        vfs.write_file(dst, data).await?;
    }
    if let Some(m) = mode {
        if vfs.supports_permissions() && m & 0o7777 != 0 {
            let _ = vfs.set_permissions(dst, m & 0o7777).await;
        }
    }
    Ok(())
}

fn join_child(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{}{}", dir, name)
    } else {
        format!("{}/{}", dir, name)
    }
}

/// COPY: a file, or a folder (recursively unless `Depth: 0`). Symlinked folders are
/// not followed, so link loops cannot recurse forever.
async fn copy_tree(
    vfs: &Arc<dyn VirtualFileSystem>,
    src_meta: &FileEntry,
    src: &str,
    dst: &str,
    recursive: bool,
) -> CoreResult<()> {
    if !src_meta.is_dir() {
        return copy_file(vfs, src, dst, Some(src_meta.permissions.mode)).await;
    }
    vfs.create_dir(dst).await?;
    if !recursive {
        return Ok(());
    }
    let mut stack = vec![(src.to_string(), dst.to_string())];
    let mut count = 0usize;
    while let Some((s, d)) = stack.pop() {
        for child in vfs.list_dir(&s).await? {
            if child.name.is_empty()
                || child.name == "."
                || child.name == ".."
                || child.name.contains('/')
                || is_internal_temp_name(&child.name)
            {
                continue;
            }
            count += 1;
            if count > MAX_COPY_ENTRIES {
                return Err(CoreError::General(format!(
                    "COPY stopped after {} entries",
                    MAX_COPY_ENTRIES
                )));
            }
            let cs = join_child(&s, &child.name);
            let cd = join_child(&d, &child.name);
            if child.is_dir() {
                vfs.create_dir(&cd).await?;
                stack.push((cs, cd));
            } else if child.is_symlink() {
                match vfs.metadata(&cs).await {
                    Ok(m) if m.is_dir() => continue,
                    Ok(_) => copy_file(vfs, &cs, &cd, None).await?,
                    Err(_) => continue,
                }
            } else {
                copy_file(vfs, &cs, &cd, Some(child.permissions.mode)).await?;
            }
        }
    }
    Ok(())
}

async fn handle_move_copy(
    stream: &mut TcpStream,
    head: &RequestHead,
    shared: &Shared,
    segs: &[String],
    remote_path: &str,
    is_move: bool,
    close: bool,
) -> std::io::Result<bool> {
    let Some(dest_raw) = head.headers.get("destination") else {
        send_simple(stream, 400, &[], b"", close).await?;
        return Ok(close);
    };
    let dest_segs = match parse_destination(dest_raw, shared) {
        Ok(s) => s,
        Err(code) => {
            send_simple(stream, code, &[], b"", close).await?;
            return Ok(close);
        }
    };
    if segs.is_empty()
        || dest_segs.is_empty()
        || dest_segs == segs
        || dest_segs.starts_with(segs)
        || is_os_system_probe(&format!("/{}", dest_segs.join("/")))
    {
        send_simple(stream, 403, &[], b"", close).await?;
        return Ok(close);
    }
    let dest_path = shared.remote_path(&dest_segs);
    let overwrite = head
        .headers
        .get("overwrite")
        .map(|v| !v.trim().eq_ignore_ascii_case("f"))
        .unwrap_or(true);
    let depth_zero = head
        .headers
        .get("depth")
        .map(|d| d.trim() == "0")
        .unwrap_or(false);

    let src_meta = match shared.vfs.metadata(remote_path).await {
        Ok(m) => m,
        Err(e) => {
            send_simple(stream, error_status(&e, Op::Read), &[], b"", close).await?;
            return Ok(close);
        }
    };
    // On a case-insensitive server "File.txt" and "file.txt" are the same entry:
    // deleting the "existing destination" would delete the source.
    let same_entry = dest_path.to_lowercase() == remote_path.to_lowercase();
    if same_entry && !is_move {
        send_simple(stream, 403, &[], b"", close).await?;
        return Ok(close);
    }
    let dest_meta = if same_entry {
        None
    } else {
        shared.vfs.metadata(&dest_path).await.ok()
    };
    if dest_meta.is_some() && !overwrite {
        send_simple(stream, 412, &[], b"", close).await?;
        return Ok(close);
    }

    let vfs = &shared.vfs;
    let result: CoreResult<()> = async {
        if is_move {
            match &dest_meta {
                Some(dm) if !dm.is_dir() && !src_meta.is_dir() => {
                    replace_file(vfs, remote_path, &dest_path, Some(dm), false).await
                }
                Some(dm) => {
                    if dm.is_dir() {
                        vfs.remove_dir(&dest_path, true).await?;
                    } else {
                        vfs.remove_file(&dest_path).await?;
                    }
                    vfs.rename(remote_path, &dest_path).await
                }
                None => vfs.rename(remote_path, &dest_path).await,
            }
        } else {
            if let Some(dm) = &dest_meta {
                if dm.is_dir() {
                    vfs.remove_dir(&dest_path, true).await?;
                } else {
                    vfs.remove_file(&dest_path).await?;
                }
            }
            copy_tree(vfs, &src_meta, remote_path, &dest_path, !depth_zero).await
        }
    }
    .await;

    if is_move {
        shared.invalidate(remote_path).await;
    }
    shared.invalidate(&dest_path).await;

    let code = match result {
        Ok(()) => {
            if dest_meta.is_some() {
                204
            } else {
                201
            }
        }
        Err(e) => {
            tracing::warn!(
                "WebDAV {} failed: {e}",
                if is_move { "MOVE" } else { "COPY" }
            );
            error_status(&e, Op::Write)
        }
    };
    send_simple(stream, code, &[], b"", close).await?;
    Ok(close)
}

// ---------------------- OS METADATA FILES ----------------------

/// `._*`, `.DS_Store`, `Thumbs.db`...: answered without touching the server. Writes
/// are kept in memory so the client can read back what it wrote (Finder aborts copies
/// when its AppleDouble writes fail).
#[allow(clippy::too_many_arguments)]
async fn handle_probe(
    stream: &mut TcpStream,
    method: &str,
    head: &RequestHead,
    shared: &Shared,
    segs: &[String],
    webdav_path: &str,
    body: Vec<u8>,
    close: bool,
) -> std::io::Result<bool> {
    match method {
        "GET" | "HEAD" => {
            let stored = shared.probes.lock().await.get(webdav_path);
            match stored {
                Some((data, modified)) => {
                    let headers = [
                        ("Content-Type", "application/octet-stream".to_string()),
                        ("Last-Modified", http_date(Some(modified))),
                    ];
                    if method == "HEAD" {
                        let block = head_block(200, &headers, data.len() as u64, close);
                        stream.write_all(block.as_bytes()).await?;
                        stream.flush().await?;
                    } else {
                        send_simple(stream, 200, &headers, &data, close).await?;
                    }
                }
                None => send_simple(stream, 404, &[], b"", close).await?,
            }
        }
        "PROPFIND" => {
            let stored = shared.probes.lock().await.get(webdav_path);
            match stored {
                Some((data, modified)) => {
                    let name = segs.last().cloned().unwrap_or_default();
                    let entry = FileEntry {
                        name: name.clone(),
                        path: webdav_path.to_string(),
                        file_type: crate::types::FileType::File,
                        size: data.len() as u64,
                        modified_at: Some(modified),
                        created_at: Some(modified),
                        permissions: Default::default(),
                        is_hidden: true,
                    };
                    let mut xml = String::from(XML_HEAD);
                    xml.push_str(&entry_to_webdav_xml(
                        &entry,
                        &shared.href(segs, false),
                        &name,
                    ));
                    xml.push_str("</D:multistatus>");
                    send_simple(
                        stream,
                        207,
                        &[("Content-Type", "text/xml; charset=utf-8".to_string())],
                        xml.as_bytes(),
                        close,
                    )
                    .await?;
                }
                None => send_simple(stream, 404, &[], b"", close).await?,
            }
        }
        "PUT" => {
            let existed = {
                let mut probes = shared.probes.lock().await;
                let existed = probes.files.contains_key(webdav_path);
                probes.put(webdav_path.to_string(), Bytes::from(body));
                existed
            };
            send_simple(stream, if existed { 204 } else { 201 }, &[], b"", close).await?;
        }
        "DELETE" => {
            shared.probes.lock().await.remove(webdav_path);
            send_simple(stream, 204, &[], b"", close).await?;
        }
        "MOVE" | "COPY" => {
            let dest_segs = match head.headers.get("destination") {
                Some(d) => parse_destination(d, shared),
                None => Err(400),
            };
            let code = match dest_segs {
                Err(code) => code,
                Ok(dest_segs) if dest_segs.is_empty() => 403,
                Ok(dest_segs) => {
                    let stored = shared.probes.lock().await.get(webdav_path);
                    match stored {
                        None => 404,
                        Some((data, _)) => {
                            let dest_webdav = format!("/{}", dest_segs.join("/"));
                            if is_os_system_probe(&dest_webdav) {
                                let mut probes = shared.probes.lock().await;
                                probes.put(dest_webdav, data);
                                if method == "MOVE" {
                                    probes.remove(webdav_path);
                                }
                                201
                            } else {
                                // Renamed to a real name: it becomes a real file.
                                let dest = shared.remote_path(&dest_segs);
                                let res = shared.vfs.write_file(&dest, data).await;
                                shared.invalidate(&dest).await;
                                match res {
                                    Ok(()) => {
                                        if method == "MOVE" {
                                            shared.probes.lock().await.remove(webdav_path);
                                        }
                                        201
                                    }
                                    Err(e) => error_status(&e, Op::Write),
                                }
                            }
                        }
                    }
                }
            };
            send_simple(stream, code, &[], b"", close).await?;
        }
        "LOCK" => return handle_lock(stream, shared, segs, close).await,
        "UNLOCK" => send_simple(stream, 204, &[], b"", close).await?,
        "PROPPATCH" => return handle_proppatch(stream, shared, segs, close).await,
        "MKCOL" => send_simple(stream, 403, &[], b"", close).await?,
        _ => send_simple(stream, 404, &[], b"", close).await?,
    }
    Ok(close)
}

// ---------------------- XML ----------------------

/// Escapes text for XML and replaces characters XML 1.0 cannot carry (control
/// characters in a file name would otherwise break the whole listing).
fn escape_xml(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            '\t' | '\n' | '\r' => out.push(c),
            c if (c as u32) < 0x20 || c == '\u{FFFE}' || c == '\u{FFFF}' => out.push('\u{FFFD}'),
            c => out.push(c),
        }
    }
    out
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
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "txt" | "log" | "md" | "sh" | "rs" | "go" | "py" | "c" | "cpp" | "java" => {
            "text/plain; charset=utf-8"
        }
        "xml" => "text/xml; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// One `<D:response>`; `href` must already be percent-encoded.
fn entry_to_webdav_xml(entry: &FileEntry, href: &str, display_name: &str) -> String {
    let is_dir = entry.is_dir();
    let res_type = if is_dir {
        "<D:resourcetype><D:collection/></D:resourcetype>"
    } else {
        "<D:resourcetype/>"
    };

    let mod_time = http_date(entry.modified_at);
    let creation_time = entry
        .created_at
        .or(entry.modified_at)
        .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .unwrap_or_else(|| "1970-01-01T00:00:00Z".to_string());

    let display_name = if display_name.is_empty() {
        "root"
    } else {
        display_name
    };

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
        escape_xml(href),
        escape_xml(display_name),
        content_props,
        mod_time,
        creation_time,
        etag_for(entry),
        res_type
    )
}

#[cfg(test)]
mod tests;

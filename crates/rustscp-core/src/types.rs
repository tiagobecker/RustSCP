use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fmt;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Path not found: {0}")]
    NotFound(String),

    #[error("Permission denied: {0}")]
    PermissionDenied(String),

    #[error("Invalid path: {0}")]
    InvalidPath(String),

    #[error("Path traversal detected: {0}")]
    PathTraversal(String),

    #[error("Connection failed: {0}")]
    ConnectionFailed(String),

    #[error("Authentication error: {0}")]
    AuthFailed(String),

    #[error("Protocol error: {0}")]
    Protocol(String),

    #[error("Operation timeout: {0}")]
    Timeout(String),

    #[error("General error: {0}")]
    General(String),
}

pub type CoreResult<T> = Result<T, CoreError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileType {
    File,
    Directory,
    Symlink,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Permissions {
    pub mode: u32,
    pub readonly: bool,
    pub owner: Option<String>,
    pub group: Option<String>,
}

impl Default for Permissions {
    fn default() -> Self {
        Self {
            mode: 0o644,
            readonly: false,
            owner: None,
            group: None,
        }
    }
}

impl Permissions {
    pub fn rwxrwxrwx(&self) -> String {
        let m = self.mode;
        let mut s = String::with_capacity(9);
        // Owner
        s.push(if m & 0o400 != 0 { 'r' } else { '-' });
        s.push(if m & 0o200 != 0 { 'w' } else { '-' });
        s.push(if m & 0o100 != 0 { 'x' } else { '-' });
        // Group
        s.push(if m & 0o040 != 0 { 'r' } else { '-' });
        s.push(if m & 0o020 != 0 { 'w' } else { '-' });
        s.push(if m & 0o010 != 0 { 'x' } else { '-' });
        // Others
        s.push(if m & 0o004 != 0 { 'r' } else { '-' });
        s.push(if m & 0o002 != 0 { 'w' } else { '-' });
        s.push(if m & 0o001 != 0 { 'x' } else { '-' });
        s
    }

    pub fn octal_string(&self) -> String {
        format!("{:04o}", self.mode & 0o7777)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub file_type: FileType,
    pub size: u64,
    pub modified_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub created_at: Option<DateTime<Utc>>,
    pub permissions: Permissions,
    pub is_hidden: bool,
}

impl FileEntry {
    pub fn is_dir(&self) -> bool {
        self.file_type == FileType::Directory
    }

    pub fn is_file(&self) -> bool {
        self.file_type == FileType::File
    }

    pub fn is_symlink(&self) -> bool {
        self.file_type == FileType::Symlink
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    Local,
    Sftp,
    S3,
    Ftp,
    WebDav,
}

impl fmt::Display for Protocol {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Local => write!(f, "local"),
            Self::Sftp => write!(f, "sftp"),
            Self::S3 => write!(f, "s3"),
            Self::Ftp => write!(f, "ftp"),
            Self::WebDav => write!(f, "webdav"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "value")]
pub enum AuthMethod {
    None,
    Password(String),
    PrivateKey {
        path: String,
        passphrase: Option<String>,
    },
    KeyringRef(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionConfig {
    pub id: String,
    pub name: String,
    pub protocol: Protocol,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    pub remote_root: String,
}

impl ConnectionConfig {
    pub fn local() -> Self {
        Self {
            id: "local".to_string(),
            name: "Local Machine".to_string(),
            protocol: Protocol::Local,
            host: "localhost".to_string(),
            port: 0,
            username: whoami(),
            auth: AuthMethod::None,
            remote_root: "/".to_string(),
        }
    }
}

fn whoami() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "user".to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferStatus {
    Queued,
    InProgress,
    Paused,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferItem {
    pub id: String,
    pub source_connection_id: String,
    pub dest_connection_id: String,
    pub source_path: String,
    pub dest_path: String,
    pub total_bytes: u64,
    pub transferred_bytes: u64,
    pub status: TransferStatus,
    pub speed_bps: u64,
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileSystemInfo {
    pub path: String,
    pub total_bytes: u64,
    pub free_bytes: u64,
    pub available_bytes: u64,
    pub used_bytes: u64,
    pub total_inodes: Option<u64>,
    pub free_inodes: Option<u64>,
    pub protocol_name: String,
    pub protocol_version: String,
    pub host_key_fingerprint_sha256: Option<String>,
    pub host_key_fingerprint_md5: Option<String>,
    pub cipher_name: Option<String>,
    pub compression_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FindFileQuery {
    pub base_path: String,
    pub mask: String,
    pub contains_text: Option<String>,
    pub case_sensitive: bool,
    pub max_depth: Option<usize>,
    pub max_results: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FindFileMatch {
    pub entry: FileEntry,
    pub matched_lines: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DirectoryDiffType {
    Identical,
    DifferentSize,
    DifferentTime,
    MissingInRemote,
    MissingInLocal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirectoryDiffItem {
    pub name: String,
    pub local_path: Option<String>,
    pub remote_path: Option<String>,
    pub local_entry: Option<FileEntry>,
    pub remote_entry: Option<FileEntry>,
    pub diff_type: DirectoryDiffType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BookmarkItem {
    pub id: String,
    pub name: String,
    pub path: String,
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteSystemInfo {
    pub os_name: String,
    pub distro_id: String,
    pub kernel: String,
    pub default_shell: String,
    pub package_manager: String,
    pub is_root: bool,
    pub has_sudo: bool,
    pub hostname: String,
    pub architecture: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteTrashItem {
    pub id: String,
    pub original_path: String,
    pub trash_path: String,
    pub filename: String,
    pub deletion_date: String,
    pub size: u64,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteTrashStatus {
    pub enabled: bool,
    pub initialized: bool,
    pub trash_dir: String,
    pub item_count: usize,
    pub total_size_bytes: u64,
}


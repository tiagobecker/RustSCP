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

    /// The SSH server presented a host key that differs from the one recorded
    /// in a known_hosts file (or a revoked key). No credentials were sent.
    #[error("Host key verification failed: {0}")]
    HostKeyMismatch(String),
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
    #[serde(default)]
    pub permissions: Permissions,
    #[serde(default)]
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

/// `Default` (SFTP, the app's primary protocol) is only used when an old saved
/// site has no `protocol` field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    Local,
    /// SFTP over SSH. The UI's "scp" option runs over the same SSH connection,
    /// so `"scp"` deserializes to this variant.
    #[default]
    #[serde(alias = "scp", alias = "ssh")]
    Sftp,
    S3,
    /// Plain FTP: user name, password and files travel unencrypted.
    Ftp,
    /// Explicit FTPS (FTP over TLS, RFC 4217): the same server port as FTP,
    /// upgraded with `AUTH TLS` before logging in.
    Ftps,
    WebDav,
}

impl fmt::Display for Protocol {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Local => write!(f, "local"),
            Self::Sftp => write!(f, "sftp"),
            Self::S3 => write!(f, "s3"),
            Self::Ftp => write!(f, "ftp"),
            Self::Ftps => write!(f, "ftps"),
            Self::WebDav => write!(f, "webdav"),
        }
    }
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(tag = "type", content = "value")]
pub enum AuthMethod {
    #[default]
    None,
    Password(String),
    PrivateKey {
        path: String,
        passphrase: Option<String>,
        /// The key file's contents (OpenSSH or PuTTY `.ppk`), for a site received in a
        /// `.rustscp` share: the key lives in the encrypted vault and `path` is empty.
        /// Used instead of `path` when set. Not written when unset, and older builds
        /// ignore it, so their vaults still load.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        key_data: Option<String>,
    },
    KeyringRef(String),
}

impl AuthMethod {
    /// The embedded key of a `PrivateKey` site, when it has a non-blank one.
    pub fn embedded_key(&self) -> Option<&str> {
        match self {
            Self::PrivateKey {
                key_data: Some(data),
                ..
            } if !data.trim().is_empty() => Some(data),
            _ => None,
        }
    }
}

/// Secrets are never printed: `{:?}` of a config may end up in logs or panics.
impl fmt::Debug for AuthMethod {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fn redact(s: &str) -> &'static str {
            if s.is_empty() {
                "\"\""
            } else {
                "\"***\""
            }
        }
        match self {
            Self::None => write!(f, "None"),
            Self::Password(p) => write!(f, "Password({})", redact(p)),
            Self::PrivateKey {
                path,
                passphrase,
                key_data,
            } => f
                .debug_struct("PrivateKey")
                .field("path", path)
                .field(
                    "passphrase",
                    &format_args!("{}", passphrase.as_deref().map(redact).unwrap_or("None")),
                )
                .field(
                    "key_data",
                    &format_args!("{}", key_data.as_deref().map(redact).unwrap_or("None")),
                )
                .finish(),
            Self::KeyringRef(r) => f.debug_tuple("KeyringRef").field(r).finish(),
        }
    }
}

/// How an SFTP site starts SFTP on the SSH connection.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SftpMode {
    /// The `sftp` subsystem; when the server refuses or breaks it, RustSCP starts
    /// `sftp-server` as a command instead and speaks SFTP over that channel
    /// (compatibility mode).
    #[default]
    Auto,
    /// The `sftp` subsystem only: never start `sftp-server` as a command.
    SubsystemOnly,
}

impl SftpMode {
    pub fn is_auto(&self) -> bool {
        *self == Self::Auto
    }
}

fn default_ssh_port() -> u16 {
    22
}

/// Every field has a serde default so sites saved by older versions (which
/// may lack newer fields) still load.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionConfig {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub protocol: Protocol,
    #[serde(default)]
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub auth: AuthMethod,
    #[serde(default)]
    pub remote_root: String,
    /// FTPS only: SHA-256 fingerprint of a server certificate trusted although
    /// the system does not trust it (a self-signed server). Not written when
    /// unset, so other sites serialize exactly as before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tls_fingerprint: Option<String>,
    /// SFTP only: whether RustSCP may start `sftp-server` as a command when the
    /// server refuses or breaks the SFTP subsystem. Not written when `Auto`, so
    /// other sites serialize exactly as before.
    #[serde(default, skip_serializing_if = "SftpMode::is_auto")]
    pub sftp_mode: SftpMode,
    /// Folder the site is filed under in the site list, as a `/`-separated path
    /// ("Production/Web"); `None` for sites at the top level. Vaults written before
    /// folders existed have no such field, and ungrouped sites do not write one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
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
            tls_fingerprint: None,
            sftp_mode: SftpMode::Auto,
            group: None,
        }
    }
}

/// Longest folder path a saved site keeps (in characters).
pub const MAX_SITE_GROUP_LEN: usize = 255;

/// Cleans a site folder path: segments are split on `/`, trimmed, stripped of control
/// characters and dropped when empty (`" A // B/ "` becomes `"A/B"`). Whole segments
/// beyond [`MAX_SITE_GROUP_LEN`] characters are dropped. `None` when nothing is left.
pub fn normalize_site_group(raw: &str) -> Option<String> {
    let mut out = String::new();
    let mut out_len = 0usize;
    for segment in raw.split('/') {
        let cleaned: String = segment.chars().filter(|c| !c.is_control()).collect();
        let cleaned = cleaned.trim();
        if cleaned.is_empty() {
            continue;
        }
        let seg_len = cleaned.chars().count();
        let needed = seg_len + usize::from(out_len > 0);
        if out_len + needed > MAX_SITE_GROUP_LEN {
            if out_len == 0 {
                // A single over-long folder name: keep its beginning.
                out = cleaned.chars().take(MAX_SITE_GROUP_LEN).collect();
                out = out.trim_end().to_string();
            }
            break;
        }
        if out_len > 0 {
            out.push('/');
        }
        out.push_str(cleaned);
        out_len += needed;
    }
    (!out.is_empty()).then_some(out)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scp_and_ssh_deserialize_to_sftp() {
        let p: Protocol = serde_json::from_str("\"scp\"").unwrap();
        assert_eq!(p, Protocol::Sftp);
        let p: Protocol = serde_json::from_str("\"ssh\"").unwrap();
        assert_eq!(p, Protocol::Sftp);
        assert_eq!(serde_json::to_string(&Protocol::Sftp).unwrap(), "\"sftp\"");
    }

    #[test]
    fn old_saved_sites_without_new_fields_still_load() {
        let cfg: ConnectionConfig =
            serde_json::from_str(r#"{"id":"a","name":"A","host":"h","username":"u"}"#).unwrap();
        assert_eq!(cfg.protocol, Protocol::Sftp);
        assert_eq!(cfg.port, 22);
        assert!(matches!(cfg.auth, AuthMethod::None));
        assert_eq!(cfg.remote_root, "");

        let entry: FileEntry = serde_json::from_str(
            r#"{"name":"f","path":"/f","file_type":"file","size":1,"modified_at":null}"#,
        )
        .unwrap();
        assert!(!entry.is_hidden);
        assert_eq!(entry.permissions, Permissions::default());
    }

    #[test]
    fn site_group_is_optional_and_only_written_when_set() {
        // Old vaults: no field at all.
        let old: ConnectionConfig =
            serde_json::from_str(r#"{"id":"a","name":"A","host":"h","username":"u"}"#).unwrap();
        assert_eq!(old.group, None);
        // Vaults written by the September build: an explicit null, or a folder.
        let null: ConnectionConfig =
            serde_json::from_str(r#"{"id":"a","host":"h","group":null}"#).unwrap();
        assert_eq!(null.group, None);
        let grouped: ConnectionConfig =
            serde_json::from_str(r#"{"id":"a","host":"h","group":"Production/Web"}"#).unwrap();
        assert_eq!(grouped.group.as_deref(), Some("Production/Web"));

        // Ungrouped sites serialize exactly as before; grouped ones keep the folder.
        let json = serde_json::to_string(&old).unwrap();
        assert!(!json.contains("group"), "{json}");
        let json = serde_json::to_string(&grouped).unwrap();
        let back: ConnectionConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.group.as_deref(), Some("Production/Web"));
        assert_eq!(ConnectionConfig::local().group, None);
    }

    #[test]
    fn sftp_mode_defaults_to_auto_and_is_only_written_when_set() {
        // Sites saved before the setting existed: no field, so Auto.
        let old: ConnectionConfig =
            serde_json::from_str(r#"{"id":"a","name":"A","host":"h","username":"u"}"#).unwrap();
        assert_eq!(old.sftp_mode, SftpMode::Auto);
        assert!(old.sftp_mode.is_auto());
        assert_eq!(ConnectionConfig::local().sftp_mode, SftpMode::Auto);

        // Auto sites serialize exactly as before.
        let json = serde_json::to_string(&old).unwrap();
        assert!(!json.contains("sftp_mode"), "{json}");

        // Subsystem only is written as snake_case and survives a round trip.
        let strict = ConnectionConfig {
            sftp_mode: SftpMode::SubsystemOnly,
            ..old
        };
        let json = serde_json::to_string(&strict).unwrap();
        assert!(json.contains(r#""sftp_mode":"subsystem_only""#), "{json}");
        let back: ConnectionConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.sftp_mode, SftpMode::SubsystemOnly);
        assert!(!back.sftp_mode.is_auto());

        // An explicit "auto" (the UI may send it) loads as Auto.
        let explicit: ConnectionConfig =
            serde_json::from_str(r#"{"id":"a","host":"h","sftp_mode":"auto"}"#).unwrap();
        assert_eq!(explicit.sftp_mode, SftpMode::Auto);
    }

    #[test]
    fn site_groups_are_normalized() {
        assert_eq!(normalize_site_group(""), None);
        assert_eq!(normalize_site_group(" / // "), None);
        assert_eq!(
            normalize_site_group(" Production // Web/ ").as_deref(),
            Some("Production/Web")
        );
        assert_eq!(
            normalize_site_group("A\u{0}B/\tC\n").as_deref(),
            Some("AB/C")
        );
        assert_eq!(
            normalize_site_group("Clientes/São Paulo").as_deref(),
            Some("Clientes/São Paulo")
        );
        let long = format!("{}/{}", "a".repeat(200), "b".repeat(100));
        assert_eq!(normalize_site_group(&long), Some("a".repeat(200)));
        let huge = "x".repeat(1000);
        assert_eq!(
            normalize_site_group(&huge).map(|g| g.chars().count()),
            Some(MAX_SITE_GROUP_LEN)
        );
    }

    #[test]
    fn debug_never_prints_secrets() {
        let pw = format!("{:?}", AuthMethod::Password("hunter2".into()));
        assert!(!pw.contains("hunter2"), "{pw}");
        let key = format!(
            "{:?}",
            AuthMethod::PrivateKey {
                path: "~/.ssh/id".into(),
                passphrase: Some("s3cret".into()),
                key_data: Some("-----BEGIN OPENSSH PRIVATE KEY-----".into()),
            }
        );
        assert!(
            !key.contains("s3cret") && key.contains("~/.ssh/id") && !key.contains("BEGIN"),
            "{key}"
        );
        // Serialization for the UI and the vault is unchanged.
        let json = serde_json::to_string(&AuthMethod::Password("hunter2".into())).unwrap();
        assert_eq!(json, r#"{"type":"Password","value":"hunter2"}"#);
    }
}

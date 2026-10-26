pub mod code_generator;
pub mod continuous_sync;
pub mod disk_cache;
pub mod embedded_key;
mod exec_sftp;
pub mod file_masks;
pub mod ftp;
pub mod known_hosts;
pub mod local;
pub mod ppk;
pub mod s3;
pub mod scripting;
pub mod sftp;
pub mod share;
pub mod shell;
pub mod site_layout;
pub mod sync;
pub mod terminal;
pub mod transfer_queue;
pub mod types;
pub mod vault;
pub mod vfs;
pub mod webdav_server;
pub mod winscp;

pub use code_generator::{CodeGenerator, CodeTargetLanguage};
pub use continuous_sync::{ContinuousSyncManager, ContinuousSyncWatcher, WatchEvent};
pub use disk_cache::{CacheStats, ManagedDiskCache, SiteCacheStats};
pub use file_masks::FileMaskFilter;
pub use ftp::{FtpConfig, FtpDriver};
pub use local::LocalFsDriver;
pub use ppk::{PpkError, PpkKey};
pub use s3::{S3Config, S3Driver};
pub use scripting::{ScriptCommandOutput, ScriptInterpreter};
pub use sftp::SftpDriver;
pub use share::{ShareError, SharePreview, SharedConnection};
pub use sync::{SyncActionType, SyncDirection, SyncEngine, SyncItem, SyncOptions};
pub use terminal::{
    shell_bootstrap, TerminalConnector, TerminalHandle, TerminalOptions, TerminalSink, TerminalSize,
};
pub use transfer_queue::{QueueTransferTask, TransferQueueManager};
pub use types::*;
pub use vault::{
    decrypt_bytes, decrypt_sites, encrypt_bytes, encrypt_sites, get_local_vault_path,
    get_rustscp_config_dir, load_local_vault, parse_vault_from_json, save_local_vault,
    serialize_vault_to_json, VaultEnvelope, VaultError, VaultSecurityInfo,
};
pub use vfs::VirtualFileSystem;
pub use webdav_server::{VirtualDiskInfo, WebDavServer};
pub use winscp::{
    decode_ini_bytes, decrypt_winscp_password, is_putty_private_key, normalize_key_path,
    parse_winscp_ini, parse_winscp_ini_file, url_decode_winscp, winscp_site_id, WinScpImportResult,
    MAX_WINSCP_INI_BYTES, MAX_WINSCP_SESSIONS,
};

use crate::types::{CoreResult, FileEntry, FileSystemInfo, FindFileMatch, FindFileQuery, Protocol};
use async_trait::async_trait;
use bytes::Bytes;
use std::fmt::Debug;

/// Universal Virtual File System Trait
/// Implemented by Local, SFTP, S3, FTP, WebDAV drivers.
#[async_trait]
pub trait VirtualFileSystem: Send + Sync + Debug {
    /// Return the protocol of this VFS instance
    fn protocol(&self) -> Protocol;

    /// List all items in a directory
    async fn list_dir(&self, path: &str) -> CoreResult<Vec<FileEntry>>;

    /// Get metadata for a specific path
    async fn metadata(&self, path: &str) -> CoreResult<FileEntry>;

    /// Read entire file content into memory
    async fn read_file(&self, path: &str) -> CoreResult<Bytes>;

    /// Read a specific byte range (essential for seekable streaming and chunk caching).
    /// Returns exactly `length` bytes unless the end of the file comes first.
    async fn read_range(&self, path: &str, offset: u64, length: u64) -> CoreResult<Bytes>;

    /// Write entire data buffer to file (creates or overwrites)
    async fn write_file(&self, path: &str, data: Bytes) -> CoreResult<()>;

    /// True when [`write_at`](Self::write_at) is implemented, so a file can be
    /// written chunk by chunk without holding it all in memory.
    fn supports_write_at(&self) -> bool {
        false
    }

    /// Positional write. `offset == 0` creates the file (or truncates an
    /// existing one) and writes `data` at the start; later calls write `data`
    /// at `offset` into the existing file. Callers write chunks in order.
    async fn write_at(&self, _path: &str, _offset: u64, _data: Bytes) -> CoreResult<()> {
        Err(crate::types::CoreError::Protocol(
            "positional write unsupported".to_string(),
        ))
    }

    /// Create directory (creates parents if missing)
    async fn create_dir(&self, path: &str) -> CoreResult<()>;

    /// Delete a single file
    async fn remove_file(&self, path: &str) -> CoreResult<()>;

    /// Delete a directory (optionally recursive)
    async fn remove_dir(&self, path: &str, recursive: bool) -> CoreResult<()>;

    /// Rename / move a file or folder
    async fn rename(&self, from: &str, to: &str) -> CoreResult<()>;

    /// Set Unix octal permissions (e.g. 0o755)
    async fn set_permissions(&self, path: &str, mode: u32) -> CoreResult<()>;

    /// Check if a path exists
    async fn exists(&self, path: &str) -> CoreResult<bool>;

    /// Search files matching pattern inside root_path
    async fn search(
        &self,
        root_path: &str,
        pattern: &str,
        max_results: usize,
    ) -> CoreResult<Vec<FileEntry>>;

    /// Create symbolic link or hard link
    async fn create_symlink(
        &self,
        target: &str,
        link_path: &str,
        is_symbolic: bool,
    ) -> CoreResult<()>;

    /// Query disk space and filesystem info
    async fn get_filesystem_info(&self, path: &str) -> CoreResult<FileSystemInfo>;

    /// Recursively calculate directory size in bytes
    async fn calculate_size(&self, path: &str) -> CoreResult<u64>;

    /// Advanced file finder with mask and optional content match (Shift+F7 in WinSCP)
    async fn find_files(&self, query: &FindFileQuery) -> CoreResult<Vec<FindFileMatch>>;

    /// Return the default/home directory for this session (e.g. user home ~)
    async fn get_default_path(&self) -> CoreResult<String> {
        Ok("/".to_string())
    }

    /// Execute command in this environment if supported (e.g. Local shell or remote SSH channel)
    async fn execute_command(&self, _cmd: &str) -> CoreResult<(i32, String, String)> {
        Err(crate::types::CoreError::Protocol(format!(
            "Command execution not supported by protocol '{}'",
            self.protocol()
        )))
    }

    /// [`execute_command`](Self::execute_command) with an explicit time limit. A command
    /// still running at the limit is an error, never a success. The default ignores the
    /// limit; drivers that can honor it (SFTP) override this.
    async fn execute_command_with_timeout(
        &self,
        cmd: &str,
        _timeout: std::time::Duration,
    ) -> CoreResult<(i32, String, String)> {
        self.execute_command(cmd).await
    }

    /// Check if protocol supports shell command execution
    fn supports_shell(&self) -> bool {
        matches!(self.protocol(), Protocol::Local | Protocol::Sftp)
    }

    /// Check if protocol supports Unix octal permissions chmod
    fn supports_permissions(&self) -> bool {
        matches!(self.protocol(), Protocol::Local | Protocol::Sftp)
    }

    /// Check if protocol supports symbolic and hard links
    fn supports_symlinks(&self) -> bool {
        matches!(self.protocol(), Protocol::Local | Protocol::Sftp)
    }
}

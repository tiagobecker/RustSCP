use crate::types::{
    CoreError, CoreResult, FileEntry, FileSystemInfo, FileType, FindFileMatch, FindFileQuery,
    Permissions, Protocol,
};
use crate::vfs::VirtualFileSystem;
use async_trait::async_trait;
use bytes::Bytes;
use chrono::{DateTime, Utc};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt, SeekFrom};

/// Upper bound for buffers allocated up front from a caller-supplied length.
const MAX_PREALLOC: u64 = 16 * 1024 * 1024;

/// Local shell commands that run longer than this are killed.
pub const LOCAL_EXEC_TIMEOUT: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone)]
pub struct LocalFsDriver {
    root_base: Option<PathBuf>,
}

impl Default for LocalFsDriver {
    fn default() -> Self {
        Self::new()
    }
}

impl LocalFsDriver {
    pub fn new() -> Self {
        Self { root_base: None }
    }

    pub fn with_root(root: impl Into<PathBuf>) -> Self {
        Self {
            root_base: Some(root.into()),
        }
    }

    /// Resolve virtual/client path against base root and sanitize against directory traversal
    pub fn resolve_path(&self, requested: &str) -> CoreResult<PathBuf> {
        let clean_path = if requested.is_empty() || requested == "/" {
            if let Some(base) = &self.root_base {
                return Ok(base.clone());
            } else {
                // The filesystem root (the current drive's root on Windows),
                // never the process working directory.
                return Ok(PathBuf::from("/"));
            }
        } else {
            requested
        };

        let candidate = Path::new(clean_path);
        let resolved = if let Some(base) = &self.root_base {
            // Strip leading slashes to prevent absolute breakout
            let relative = candidate.strip_prefix("/").unwrap_or(candidate);
            let mut full = base.clone();
            full.push(relative);
            full
        } else {
            candidate.to_path_buf()
        };

        // Normalize path
        let normalized = normalize_path(&resolved);

        // Security check: if root_base was set, ensure normalized starts with root_base
        if let Some(base) = &self.root_base {
            let norm_base = normalize_path(base);
            let escapes =
                !normalized.starts_with(&norm_base) || !Self::stays_inside(&normalized, base);
            if escapes {
                return Err(CoreError::PathTraversal(format!(
                    "Path '{}' escapes base root '{}'",
                    requested,
                    base.display()
                )));
            }
        }

        Ok(normalized)
    }

    /// The lexical check above is not enough for a jail: a symlink inside the
    /// root may point outside it. Resolve links (also dangling ones, which a
    /// write would follow) and compare real locations.
    fn stays_inside(path: &Path, base: &Path) -> bool {
        let real_base = std::fs::canonicalize(base).unwrap_or_else(|_| normalize_path(base));
        match Self::real_location(path, 0) {
            Some(real) => real.starts_with(&real_base),
            None => false,
        }
    }

    /// Where `path` really points after following symlinks; works for paths
    /// that do not exist yet. None for link loops.
    fn real_location(path: &Path, depth: u8) -> Option<PathBuf> {
        if depth > 16 {
            return None;
        }
        if let Ok(real) = std::fs::canonicalize(path) {
            return Some(real);
        }
        if let Ok(meta) = std::fs::symlink_metadata(path) {
            if meta.file_type().is_symlink() {
                let target = std::fs::read_link(path).ok()?;
                let joined = if target.is_absolute() {
                    target
                } else {
                    path.parent()?.join(target)
                };
                return Self::real_location(&normalize_path(&joined), depth + 1);
            }
            return Some(path.to_path_buf());
        }
        let name = path.file_name()?;
        match path.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => {
                Some(Self::real_location(parent, depth)?.join(name))
            }
            _ => Some(path.to_path_buf()),
        }
    }

    /// Entries of a rooted driver carry paths relative to the root (`/a/b`),
    /// the same form its methods accept.
    fn present(&self, mut entry: FileEntry) -> FileEntry {
        if let Some(base) = &self.root_base {
            if let Ok(rel) = Path::new(&entry.path).strip_prefix(normalize_path(base)) {
                let rel = rel.to_string_lossy().replace('\\', "/");
                entry.path = if rel.is_empty() {
                    "/".to_string()
                } else {
                    format!("/{}", rel)
                };
            }
        }
        entry
    }

    /// Entry for `path` itself (a symlink is reported as a symlink).
    pub async fn to_file_entry(&self, path: &Path) -> CoreResult<FileEntry> {
        let meta = fs::symlink_metadata(path)
            .await
            .map_err(|e| map_io_error(e, path))?;
        Ok(Self::entry_from_metadata(path, &meta))
    }

    /// Entry for what `path` points to: symlinks are followed (like SFTP
    /// `stat`), so a link to a folder is a directory and a link to a file has
    /// the target's size. Dangling links fall back to the link itself.
    pub async fn to_file_entry_followed(&self, path: &Path) -> CoreResult<FileEntry> {
        match fs::metadata(path).await {
            Ok(meta) => Ok(Self::entry_from_metadata(path, &meta)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => self.to_file_entry(path).await,
            Err(e) => Err(map_io_error(e, path)),
        }
    }

    fn entry_from_metadata(path: &Path, meta: &std::fs::Metadata) -> FileEntry {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "/".to_string());

        let is_hidden = name.starts_with('.') && name != "." && name != "..";

        let file_type = if meta.file_type().is_symlink() {
            FileType::Symlink
        } else if meta.file_type().is_dir() {
            FileType::Directory
        } else if meta.file_type().is_file() {
            FileType::File
        } else {
            FileType::Other
        };

        let modified_at = meta.modified().ok().map(DateTime::<Utc>::from);

        let created_at = meta.created().ok().map(DateTime::<Utc>::from);

        #[cfg(unix)]
        let (mode, owner, group) = {
            use std::os::unix::fs::MetadataExt;
            let mode = meta.mode();
            (
                mode,
                Some(meta.uid().to_string()),
                Some(meta.gid().to_string()),
            )
        };

        #[cfg(not(unix))]
        let (mode, owner, group) = {
            let readonly = meta.permissions().readonly();
            let mode = if readonly { 0o444 } else { 0o666 };
            (mode, None, None)
        };

        let permissions = Permissions {
            mode,
            readonly: meta.permissions().readonly(),
            owner,
            group,
        };

        FileEntry {
            name,
            path: path.to_string_lossy().to_string(),
            file_type,
            size: meta.len(),
            modified_at,
            created_at,
            permissions,
            is_hidden,
        }
    }
}

fn map_io_error(e: std::io::Error, path: &Path) -> CoreError {
    match e.kind() {
        std::io::ErrorKind::NotFound => CoreError::NotFound(path.display().to_string()),
        std::io::ErrorKind::PermissionDenied => {
            CoreError::PermissionDenied(path.display().to_string())
        }
        _ => CoreError::Io(e),
    }
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut components = Vec::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                components.pop();
            }
            c => components.push(c),
        }
    }
    components.into_iter().collect()
}

#[async_trait]
impl VirtualFileSystem for LocalFsDriver {
    fn protocol(&self) -> Protocol {
        Protocol::Local
    }

    async fn list_dir(&self, path: &str) -> CoreResult<Vec<FileEntry>> {
        let target = self.resolve_path(path)?;
        let requested = path.to_string();
        // One blocking task for the whole folder instead of one thread-pool
        // round trip per entry (large folders list much faster).
        let mut entries = tokio::task::spawn_blocking(move || -> CoreResult<Vec<FileEntry>> {
            let read_dir = std::fs::read_dir(&target).map_err(|e| match e.kind() {
                std::io::ErrorKind::NotFound => CoreError::NotFound(requested.clone()),
                std::io::ErrorKind::PermissionDenied => {
                    CoreError::PermissionDenied(requested.clone())
                }
                _ => CoreError::Io(e),
            })?;
            let mut entries = Vec::new();
            for item in read_dir {
                let item = item?;
                let item_path = item.path();
                // Like symlink_metadata: links are reported as links.
                let meta = match item.metadata() {
                    Ok(m) => m,
                    Err(_) => match std::fs::symlink_metadata(&item_path) {
                        Ok(m) => m,
                        Err(_) => continue,
                    },
                };
                entries.push(Self::entry_from_metadata(&item_path, &meta));
            }
            Ok(entries)
        })
        .await
        .map_err(|e| CoreError::General(e.to_string()))??;

        // Sort: directories first, then alphabetical case-insensitive
        entries.sort_by_cached_key(|e| (!e.is_dir(), e.name.to_lowercase()));

        Ok(entries.into_iter().map(|e| self.present(e)).collect())
    }

    async fn metadata(&self, path: &str) -> CoreResult<FileEntry> {
        let target = self.resolve_path(path)?;
        Ok(self.present(self.to_file_entry_followed(&target).await?))
    }

    async fn read_file(&self, path: &str) -> CoreResult<Bytes> {
        let target = self.resolve_path(path)?;
        let data = fs::read(&target).await?;
        Ok(Bytes::from(data))
    }

    async fn read_range(&self, path: &str, offset: u64, length: u64) -> CoreResult<Bytes> {
        let target = self.resolve_path(path)?;
        if length == 0 {
            return Ok(Bytes::new());
        }
        let mut file = fs::File::open(&target).await?;
        file.seek(SeekFrom::Start(offset)).await?;

        // A single read() may return less than asked (tokio caps each read),
        // so read until `length` bytes or end of file. The buffer grows with
        // the data instead of trusting a caller-supplied length up front.
        let mut buffer = Vec::with_capacity(length.min(MAX_PREALLOC) as usize);
        file.take(length).read_to_end(&mut buffer).await?;

        Ok(Bytes::from(buffer))
    }

    async fn write_file(&self, path: &str, data: Bytes) -> CoreResult<()> {
        let target = self.resolve_path(path)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).await?;
        }
        let mut file = fs::File::create(&target).await?;
        file.write_all(&data).await?;
        file.flush().await?;
        Ok(())
    }

    fn supports_write_at(&self) -> bool {
        true
    }

    async fn write_at(&self, path: &str, offset: u64, data: Bytes) -> CoreResult<()> {
        let target = self.resolve_path(path)?;
        let mut file = if offset == 0 {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).await?;
            }
            fs::File::create(&target).await?
        } else {
            let mut f = fs::OpenOptions::new().write(true).open(&target).await?;
            f.seek(SeekFrom::Start(offset)).await?;
            f
        };
        file.write_all(&data).await?;
        // tokio completes writes in the background; flush so the data is in
        // the file before we report success (and before a size check).
        file.flush().await?;
        Ok(())
    }

    async fn create_dir(&self, path: &str) -> CoreResult<()> {
        let target = self.resolve_path(path)?;
        fs::create_dir_all(&target).await?;
        Ok(())
    }

    async fn remove_file(&self, path: &str) -> CoreResult<()> {
        let target = self.resolve_path(path)?;
        fs::remove_file(&target).await.map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => CoreError::NotFound(path.to_string()),
            _ => CoreError::Io(e),
        })?;
        Ok(())
    }

    async fn remove_dir(&self, path: &str, recursive: bool) -> CoreResult<()> {
        let target = self.resolve_path(path)?;
        if recursive {
            fs::remove_dir_all(&target).await?;
        } else {
            fs::remove_dir(&target).await?;
        }
        Ok(())
    }

    async fn rename(&self, from: &str, to: &str) -> CoreResult<()> {
        let src = self.resolve_path(from)?;
        let dst = self.resolve_path(to)?;
        fs::rename(&src, &dst).await?;
        Ok(())
    }

    async fn set_permissions(&self, path: &str, mode: u32) -> CoreResult<()> {
        let target = self.resolve_path(path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&target, std::fs::Permissions::from_mode(mode)).await?;
        }
        #[cfg(not(unix))]
        {
            let readonly = (mode & 0o222) == 0;
            let mut perms = fs::metadata(&target).await?.permissions();
            perms.set_readonly(readonly);
            fs::set_permissions(&target, perms).await?;
        }
        Ok(())
    }

    async fn exists(&self, path: &str) -> CoreResult<bool> {
        let target = self.resolve_path(path)?;
        Ok(fs::try_exists(&target).await.unwrap_or(false))
    }

    async fn search(
        &self,
        root_path: &str,
        pattern: &str,
        max_results: usize,
    ) -> CoreResult<Vec<FileEntry>> {
        let target = self.resolve_path(root_path)?;
        let pat_lower = pattern.to_lowercase();
        let mut results = Vec::new();
        let mut queue = vec![target];

        while let Some(curr_dir) = queue.pop() {
            if results.len() >= max_results {
                break;
            }
            if let Ok(mut dir_reader) = fs::read_dir(&curr_dir).await {
                while let Ok(Some(entry)) = dir_reader.next_entry().await {
                    let entry_path = entry.path();
                    let file_name = entry.file_name().to_string_lossy().to_string();

                    if file_name.to_lowercase().contains(&pat_lower) {
                        if let Ok(fe) = self.to_file_entry(&entry_path).await {
                            results.push(self.present(fe));
                            if results.len() >= max_results {
                                break;
                            }
                        }
                    }

                    if let Ok(file_type) = entry.file_type().await {
                        if file_type.is_dir() {
                            queue.push(entry_path);
                        }
                    }
                }
            }
        }

        Ok(results)
    }

    async fn create_symlink(
        &self,
        target: &str,
        link_path: &str,
        is_symbolic: bool,
    ) -> CoreResult<()> {
        let link_dest = self.resolve_path(link_path)?;
        // A rooted driver must not hard-link a file from outside its root.
        // (Reads and writes through a symlink are checked by resolve_path.)
        let target_buf = if self.root_base.is_some() && !is_symbolic {
            self.resolve_path(target)?
        } else {
            PathBuf::from(target)
        };
        let target_path = target_buf.as_path();

        #[cfg(unix)]
        {
            if is_symbolic {
                tokio::fs::symlink(target_path, &link_dest).await?;
            } else {
                tokio::fs::hard_link(target_path, &link_dest).await?;
            }
        }
        #[cfg(windows)]
        {
            if is_symbolic {
                if target_path.is_dir() {
                    tokio::fs::symlink_dir(target_path, &link_dest).await?;
                } else {
                    tokio::fs::symlink_file(target_path, &link_dest).await?;
                }
            } else {
                tokio::fs::hard_link(target_path, &link_dest).await?;
            }
        }
        Ok(())
    }

    // statvfs field widths differ between platforms, so the casts are needed.
    #[allow(clippy::unnecessary_cast)]
    async fn get_filesystem_info(&self, path: &str) -> CoreResult<FileSystemInfo> {
        let target = self.resolve_path(path)?;

        #[cfg(unix)]
        {
            use std::ffi::CString;
            use std::mem::MaybeUninit;
            let c_path = CString::new(target.to_string_lossy().as_bytes())
                .map_err(|e| CoreError::General(e.to_string()))?;
            let mut stat: MaybeUninit<libc::statvfs> = MaybeUninit::uninit();
            let res = unsafe { libc::statvfs(c_path.as_ptr(), stat.as_mut_ptr()) };
            if res == 0 {
                let stat = unsafe { stat.assume_init() };
                let bsize = stat.f_frsize as u64;
                let total = stat.f_blocks as u64 * bsize;
                let free = stat.f_bfree as u64 * bsize;
                let avail = stat.f_bavail as u64 * bsize;
                let used = total.saturating_sub(free);
                return Ok(FileSystemInfo {
                    path: path.to_string(),
                    total_bytes: total,
                    free_bytes: free,
                    available_bytes: avail,
                    used_bytes: used,
                    total_inodes: Some(stat.f_files as u64),
                    free_inodes: Some(stat.f_ffree as u64),
                    protocol_name: "Local Filesystem".to_string(),
                    protocol_version: std::env::consts::OS.to_string(),
                    host_key_fingerprint_sha256: None,
                    host_key_fingerprint_md5: None,
                    cipher_name: None,
                    compression_name: None,
                });
            }
        }

        // Fallback for non-unix or statvfs failure
        Ok(FileSystemInfo {
            path: path.to_string(),
            total_bytes: 1_000_000_000_000,
            free_bytes: 500_000_000_000,
            available_bytes: 500_000_000_000,
            used_bytes: 500_000_000_000,
            total_inodes: None,
            free_inodes: None,
            protocol_name: "Local Filesystem".to_string(),
            protocol_version: std::env::consts::OS.to_string(),
            host_key_fingerprint_sha256: None,
            host_key_fingerprint_md5: None,
            cipher_name: None,
            compression_name: None,
        })
    }

    async fn calculate_size(&self, path: &str) -> CoreResult<u64> {
        let target = self.resolve_path(path)?;
        let mut total_size = 0u64;
        let mut queue = vec![target];

        while let Some(curr) = queue.pop() {
            if let Ok(meta) = fs::symlink_metadata(&curr).await {
                if meta.is_dir() {
                    if let Ok(mut dir_reader) = fs::read_dir(&curr).await {
                        while let Ok(Some(entry)) = dir_reader.next_entry().await {
                            queue.push(entry.path());
                        }
                    }
                } else {
                    total_size += meta.len();
                }
            }
        }
        Ok(total_size)
    }

    async fn find_files(&self, query: &FindFileQuery) -> CoreResult<Vec<FindFileMatch>> {
        let root = self.resolve_path(&query.base_path)?;
        let mask_filter = crate::file_masks::FileMaskFilter::new(&query.mask);
        let mut results = Vec::new();
        let mut queue = vec![(root, 0usize)];

        while let Some((curr_dir, depth)) = queue.pop() {
            if results.len() >= query.max_results {
                break;
            }
            if let Some(max_d) = query.max_depth {
                if depth > max_d {
                    continue;
                }
            }

            if let Ok(mut reader) = fs::read_dir(&curr_dir).await {
                while let Ok(Some(entry)) = reader.next_entry().await {
                    let entry_path = entry.path();
                    let file_name = entry.file_name().to_string_lossy().to_string();
                    let is_dir = entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false);

                    if is_dir {
                        queue.push((entry_path.clone(), depth + 1));
                    }

                    if mask_filter.matches(&file_name, is_dir) {
                        let mut matched_lines = Vec::new();
                        let mut is_content_match = true;

                        if let Some(ref text) = query.contains_text {
                            if !text.is_empty() && !is_dir {
                                is_content_match = false;
                                if let Ok(meta) = entry.metadata().await {
                                    if meta.len() <= 10 * 1024 * 1024 {
                                        if let Ok(content) = fs::read_to_string(&entry_path).await {
                                            for line in content.lines() {
                                                let found = if query.case_sensitive {
                                                    line.contains(text)
                                                } else {
                                                    line.to_lowercase()
                                                        .contains(&text.to_lowercase())
                                                };
                                                if found {
                                                    matched_lines.push(line.trim().to_string());
                                                    is_content_match = true;
                                                    if matched_lines.len() >= 5 {
                                                        break;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        if is_content_match {
                            if let Ok(fe) = self.to_file_entry(&entry_path).await {
                                results.push(FindFileMatch {
                                    entry: self.present(fe),
                                    matched_lines,
                                });
                                if results.len() >= query.max_results {
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }

        Ok(results)
    }

    async fn get_default_path(&self) -> CoreResult<String> {
        if let Ok(home) = std::env::var("HOME") {
            if !home.is_empty() {
                return Ok(home);
            }
        }
        if let Ok(userprofile) = std::env::var("USERPROFILE") {
            if !userprofile.is_empty() {
                return Ok(userprofile.replace('\\', "/"));
            }
        }
        Ok("/".to_string())
    }

    async fn execute_command(&self, cmd: &str) -> CoreResult<(i32, String, String)> {
        #[cfg(target_os = "windows")]
        let mut command = {
            // Do not flash a console window from the GUI app.
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let mut c = tokio::process::Command::new("cmd.exe");
            // cmd.exe does not use MSVC argument quoting: pass the command line as is.
            c.arg("/C").raw_arg(cmd).creation_flags(CREATE_NO_WINDOW);
            c
        };

        #[cfg(not(target_os = "windows"))]
        let mut command = {
            let mut c = tokio::process::Command::new("/bin/sh");
            c.arg("-c").arg(cmd);
            c
        };

        // A command that never ends (tail -f, ping) must not hang the caller
        // forever or leak the process.
        command
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true);
        let output = match tokio::time::timeout(LOCAL_EXEC_TIMEOUT, command.output()).await {
            Ok(res) => res.map_err(|e| {
                CoreError::General(format!("Failed to execute local command: {}", e))
            })?,
            Err(_) => {
                return Err(CoreError::Timeout(format!(
                    "Local command did not finish within {} s and was stopped",
                    LOCAL_EXEC_TIMEOUT.as_secs()
                )))
            }
        };

        Ok((
            output.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&output.stdout).to_string(),
            String::from_utf8_lossy(&output.stderr).to_string(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn test_local_vfs_basic_operations() {
        let temp = tempdir().unwrap();
        let driver = LocalFsDriver::with_root(temp.path());

        // Create dir
        driver.create_dir("test_dir").await.unwrap();
        assert!(driver.exists("test_dir").await.unwrap());

        // Write file
        let content = Bytes::from_static(b"Hello RustSCP VFS!");
        driver
            .write_file("test_dir/hello.txt", content.clone())
            .await
            .unwrap();
        assert!(driver.exists("test_dir/hello.txt").await.unwrap());

        // Read file
        let read_back = driver.read_file("test_dir/hello.txt").await.unwrap();
        assert_eq!(read_back, content);

        // Read range (e.g. "RustSCP")
        let range = driver.read_range("test_dir/hello.txt", 6, 7).await.unwrap();
        assert_eq!(range, Bytes::from_static(b"RustSCP"));

        // List directory
        let items = driver.list_dir("test_dir").await.unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].name, "hello.txt");
        assert_eq!(items[0].size, content.len() as u64);

        // Rename
        driver
            .rename("test_dir/hello.txt", "test_dir/renamed.txt")
            .await
            .unwrap();
        assert!(!driver.exists("test_dir/hello.txt").await.unwrap());
        assert!(driver.exists("test_dir/renamed.txt").await.unwrap());

        // Delete
        driver.remove_file("test_dir/renamed.txt").await.unwrap();
        assert!(!driver.exists("test_dir/renamed.txt").await.unwrap());
    }

    #[tokio::test]
    async fn test_unrooted_root_is_filesystem_root() {
        let driver = LocalFsDriver::new();
        assert_eq!(driver.resolve_path("/").unwrap(), PathBuf::from("/"));
        assert_eq!(driver.resolve_path("").unwrap(), PathBuf::from("/"));
    }

    #[tokio::test]
    async fn test_write_at_and_long_read_range() {
        let temp = tempdir().unwrap();
        let driver = LocalFsDriver::with_root(temp.path());
        assert!(driver.supports_write_at());
        let data: Vec<u8> = (0..5_000_000u32).map(|i| (i % 253) as u8).collect();
        let (a, b) = data.split_at(3_000_000);
        driver
            .write_at("x/big.bin", 0, Bytes::copy_from_slice(a))
            .await
            .unwrap();
        driver
            .write_at("x/big.bin", a.len() as u64, Bytes::copy_from_slice(b))
            .await
            .unwrap();
        // tokio caps a single read at 2 MiB: read_range must still return everything.
        let all = driver
            .read_range("x/big.bin", 0, data.len() as u64)
            .await
            .unwrap();
        assert_eq!(all.len(), data.len());
        assert_eq!(&all[..], &data[..]);
        let tail = driver
            .read_range("x/big.bin", 4_999_990, 1_000_000)
            .await
            .unwrap();
        assert_eq!(&tail[..], &data[4_999_990..]);
        // A huge requested length does not preallocate it.
        let tiny = driver
            .read_range("x/big.bin", 0, u64::MAX / 2)
            .await
            .unwrap();
        assert_eq!(tiny.len(), data.len());
        // offset 0 truncates.
        driver
            .write_at("x/big.bin", 0, Bytes::from_static(b"hi"))
            .await
            .unwrap();
        assert_eq!(
            driver.read_file("x/big.bin").await.unwrap(),
            Bytes::from_static(b"hi")
        );
    }

    #[tokio::test]
    async fn test_rooted_entries_use_root_relative_paths() {
        let temp = tempdir().unwrap();
        let driver = LocalFsDriver::with_root(temp.path());
        driver
            .write_file("dir/f.txt", Bytes::from_static(b"abc"))
            .await
            .unwrap();
        let items = driver.list_dir("/dir").await.unwrap();
        assert_eq!(items[0].path, "/dir/f.txt");
        let meta = driver.metadata(&items[0].path).await.unwrap();
        assert_eq!(meta.size, 3);
        assert_eq!(meta.path, "/dir/f.txt");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_symlinks_cannot_escape_root_and_metadata_follows_links() {
        let outside = tempdir().unwrap();
        std::fs::write(outside.path().join("secret"), b"top secret").unwrap();
        let temp = tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), temp.path().join("escape")).unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("new-file"),
            temp.path().join("dangling"),
        )
        .unwrap();
        std::fs::write(temp.path().join("inside.txt"), b"12345").unwrap();
        std::os::unix::fs::symlink(temp.path().join("inside.txt"), temp.path().join("link.txt"))
            .unwrap();

        let driver = LocalFsDriver::with_root(temp.path());
        assert!(matches!(
            driver.read_file("escape/secret").await,
            Err(CoreError::PathTraversal(_))
        ));
        assert!(matches!(
            driver
                .write_file("dangling", Bytes::from_static(b"x"))
                .await,
            Err(CoreError::PathTraversal(_))
        ));
        assert!(!outside.path().join("new-file").exists());
        assert!(driver
            .create_symlink("/../../etc/passwd", "hard", false)
            .await
            .is_err());

        // Links inside the root work; metadata reports the target.
        let meta = driver.metadata("link.txt").await.unwrap();
        assert_eq!(meta.file_type, FileType::File);
        assert_eq!(meta.size, 5);
        let listed = driver.list_dir("/").await.unwrap();
        let link = listed.iter().find(|e| e.name == "link.txt").unwrap();
        assert_eq!(link.file_type, FileType::Symlink);
    }

    #[tokio::test]
    async fn test_path_traversal_prevention() {
        let temp = tempdir().unwrap();
        let driver = LocalFsDriver::with_root(temp.path());

        let result = driver.resolve_path("../../etc/passwd");
        assert!(result.is_err());
        match result.unwrap_err() {
            CoreError::PathTraversal(_) => {}
            other => panic!("Expected PathTraversal error, got {:?}", other),
        }
    }
}

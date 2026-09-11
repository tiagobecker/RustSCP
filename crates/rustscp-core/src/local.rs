use crate::types::{
    CoreError, CoreResult, FileEntry, FileSystemInfo, FileType, FindFileMatch, FindFileQuery,
    Permissions, Protocol,
};
use crate::vfs::VirtualFileSystem;
use async_trait::async_trait;
use bytes::Bytes;
use chrono::{DateTime, Utc};
use std::path::{Path, PathBuf};
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt, SeekFrom};

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
                return Ok(std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")));
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
            if !normalized.starts_with(&norm_base) {
                return Err(CoreError::PathTraversal(format!(
                    "Path '{}' escapes base root '{}'",
                    requested,
                    base.display()
                )));
            }
        }

        Ok(normalized)
    }

    pub async fn to_file_entry(&self, path: &Path) -> CoreResult<FileEntry> {
        let meta = fs::symlink_metadata(path)
            .await
            .map_err(|e| match e.kind() {
                std::io::ErrorKind::NotFound => CoreError::NotFound(path.display().to_string()),
                std::io::ErrorKind::PermissionDenied => {
                    CoreError::PermissionDenied(path.display().to_string())
                }
                _ => CoreError::Io(e),
            })?;

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

        let modified_at = meta
            .modified()
            .ok()
            .map(|st| DateTime::<Utc>::from(st));

        let created_at = meta
            .created()
            .ok()
            .map(|st| DateTime::<Utc>::from(st));

        #[cfg(unix)]
        let (mode, owner, group) = {
            use std::os::unix::fs::MetadataExt;
            let mode = meta.mode();
            (mode, Some(meta.uid().to_string()), Some(meta.gid().to_string()))
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

        Ok(FileEntry {
            name,
            path: path.to_string_lossy().to_string(),
            file_type,
            size: meta.len(),
            modified_at,
            created_at,
            permissions,
            is_hidden,
        })
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
        let mut read_dir = fs::read_dir(&target).await.map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => CoreError::NotFound(path.to_string()),
            std::io::ErrorKind::PermissionDenied => CoreError::PermissionDenied(path.to_string()),
            _ => CoreError::Io(e),
        })?;

        let mut entries = Vec::new();
        while let Some(item) = read_dir.next_entry().await? {
            if let Ok(entry) = self.to_file_entry(&item.path()).await {
                entries.push(entry);
            }
        }

        // Sort: directories first, then alphabetical case-insensitive
        entries.sort_by(|a, b| {
            match (a.is_dir(), b.is_dir()) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
            }
        });

        Ok(entries)
    }

    async fn metadata(&self, path: &str) -> CoreResult<FileEntry> {
        let target = self.resolve_path(path)?;
        self.to_file_entry(&target).await
    }

    async fn read_file(&self, path: &str) -> CoreResult<Bytes> {
        let target = self.resolve_path(path)?;
        let data = fs::read(&target).await?;
        Ok(Bytes::from(data))
    }

    async fn read_range(&self, path: &str, offset: u64, length: u64) -> CoreResult<Bytes> {
        let target = self.resolve_path(path)?;
        let mut file = fs::File::open(&target).await?;
        file.seek(SeekFrom::Start(offset)).await?;

        let mut buffer = vec![0u8; length as usize];
        let bytes_read = file.read(&mut buffer).await?;
        buffer.truncate(bytes_read);

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

    async fn search(&self, root_path: &str, pattern: &str, max_results: usize) -> CoreResult<Vec<FileEntry>> {
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
                            results.push(fe);
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

    async fn create_symlink(&self, target: &str, link_path: &str, is_symbolic: bool) -> CoreResult<()> {
        let link_dest = self.resolve_path(link_path)?;
        let target_path = Path::new(target);

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
                                                    line.to_lowercase().contains(&text.to_lowercase())
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
                                    entry: fe,
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
        let output = tokio::process::Command::new("cmd.exe")
            .arg("/C")
            .arg(cmd)
            .output()
            .await
            .map_err(|e| CoreError::General(format!("Failed to execute local command: {}", e)))?;

        #[cfg(not(target_os = "windows"))]
        let output = tokio::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(cmd)
            .output()
            .await
            .map_err(|e| CoreError::General(format!("Failed to execute local command: {}", e)))?;

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
        driver.write_file("test_dir/hello.txt", content.clone()).await.unwrap();
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
        driver.rename("test_dir/hello.txt", "test_dir/renamed.txt").await.unwrap();
        assert!(!driver.exists("test_dir/hello.txt").await.unwrap());
        assert!(driver.exists("test_dir/renamed.txt").await.unwrap());

        // Delete
        driver.remove_file("test_dir/renamed.txt").await.unwrap();
        assert!(!driver.exists("test_dir/renamed.txt").await.unwrap());
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

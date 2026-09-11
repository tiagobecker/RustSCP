use crate::types::{CoreError, CoreResult, FileEntry};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::RwLock;

/// Information about local cache usage for a particular remote site/session
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SiteCacheStats {
    pub session_id: String,
    pub session_name: String,
    pub total_bytes: u64,
    pub file_count: usize,
    pub last_accessed: String,
}

/// Overall cache statistics across all sessions
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheStats {
    pub total_bytes: u64,
    pub max_bytes: u64,
    pub file_count: usize,
    pub catalog_folders_count: usize,
    pub catalog_items_count: usize,
    pub sites: Vec<SiteCacheStats>,
}

#[derive(Debug, Clone)]
pub struct CachedFileMetadata {
    pub local_path: PathBuf,
    pub remote_path: String,
    pub size: u64,
    pub last_accessed: DateTime<Utc>,
}

/// In-memory catalog entry for fast directory listing responses (PROPFIND)
#[derive(Debug, Clone)]
struct CatalogEntry {
    entries: Vec<FileEntry>,
    cached_at: std::time::Instant,
}

/// In-memory entry metadata for instant individual file/folder lookups (PROPFIND Depth: 0 / HEAD)
#[derive(Debug, Clone)]
struct CachedEntryMetadata {
    entry: FileEntry,
    cached_at: std::time::Instant,
}

/// Smart Manageable Local Disk & Catalog Cache Manager
/// - Sparse / Shadow virtual files: directory structure is loaded as shadow catalog metadata
/// - On-demand streaming: file content is only downloaded when read
/// - LRU storage eviction and automatic cleanup of inactive sites
pub struct ManagedDiskCache {
    base_dir: PathBuf,
    max_bytes: Arc<RwLock<u64>>,
    catalog_ttl_secs: AtomicU64,
    catalog: Arc<RwLock<HashMap<String, CatalogEntry>>>,
    entry_cache: Arc<RwLock<HashMap<String, CachedEntryMetadata>>>,
}

impl Default for ManagedDiskCache {
    fn default() -> Self {
        Self::new(None, 1024 * 1024 * 1024) // 1 GB default limit
    }
}

impl ManagedDiskCache {
    pub fn new(custom_dir: Option<PathBuf>, max_bytes: u64) -> Self {
        let base_dir = custom_dir.unwrap_or_else(|| {
            let home = std::env::var("HOME")
                .or_else(|_| std::env::var("USERPROFILE"))
                .unwrap_or_else(|_| ".".to_string());
            PathBuf::from(home).join(".rustscp").join("cache")
        });

        Self {
            base_dir,
            max_bytes: Arc::new(RwLock::new(max_bytes)),
            catalog_ttl_secs: AtomicU64::new(300), // 300s (5min) catalog cache for fast directory navigation
            catalog: Arc::new(RwLock::new(HashMap::new())),
            entry_cache: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn base_dir(&self) -> &Path {
        &self.base_dir
    }

    pub fn catalog_ttl(&self) -> std::time::Duration {
        std::time::Duration::from_secs(self.catalog_ttl_secs.load(Ordering::Relaxed))
    }

    pub fn set_catalog_ttl_secs(&self, secs: u64) {
        self.catalog_ttl_secs.store(secs, Ordering::Relaxed);
    }

    // ---------------------- CATALOG (SHADOW / SPARSE METADATA) ----------------------

    /// Get cached directory listing if still fresh
    pub async fn get_catalog(&self, session_id: &str, path: &str) -> Option<Vec<FileEntry>> {
        let clean_path = path.trim_end_matches('/');
        let key = format!(
            "{}:{}",
            session_id,
            if clean_path.is_empty() {
                "/"
            } else {
                clean_path
            }
        );
        let lock = self.catalog.read().await;
        if let Some(entry) = lock.get(&key) {
            if entry.cached_at.elapsed() < self.catalog_ttl() {
                return Some(entry.entries.clone());
            }
        }
        None
    }

    /// Store fresh directory listing in catalog cache and index all child entities
    pub async fn put_catalog(&self, session_id: &str, path: &str, entries: Vec<FileEntry>) {
        let clean_dir = path.trim_end_matches('/');
        let key = format!(
            "{}:{}",
            session_id,
            if clean_dir.is_empty() { "/" } else { clean_dir }
        );
        let now = std::time::Instant::now();

        {
            let mut lock = self.catalog.write().await;
            lock.insert(
                key,
                CatalogEntry {
                    entries: entries.clone(),
                    cached_at: now,
                },
            );
        }

        // Index each entry individually for instant Depth: 0 PROPFIND & HEAD lookups
        {
            let mut entry_lock = self.entry_cache.write().await;
            for entry in entries {
                let clean_entry_path = entry.path.trim_end_matches('/');
                let entry_key = format!(
                    "{}:{}",
                    session_id,
                    if clean_entry_path.is_empty() {
                        "/"
                    } else {
                        clean_entry_path
                    }
                );
                entry_lock.insert(
                    entry_key,
                    CachedEntryMetadata {
                        entry,
                        cached_at: now,
                    },
                );
            }
        }
    }

    /// Retrieve individual cached file/folder metadata if available and fresh
    pub async fn get_entry_metadata(&self, session_id: &str, path: &str) -> Option<FileEntry> {
        let clean_path = path.trim_end_matches('/');
        let key = format!(
            "{}:{}",
            session_id,
            if clean_path.is_empty() {
                "/"
            } else {
                clean_path
            }
        );
        let lock = self.entry_cache.read().await;
        if let Some(cached) = lock.get(&key) {
            if cached.cached_at.elapsed() < self.catalog_ttl() {
                return Some(cached.entry.clone());
            }
        }
        None
    }

    /// Store individual entry metadata in cache
    pub async fn put_entry_metadata(&self, session_id: &str, entry: FileEntry) {
        let clean_path = entry.path.trim_end_matches('/');
        let key = format!(
            "{}:{}",
            session_id,
            if clean_path.is_empty() {
                "/"
            } else {
                clean_path
            }
        );
        let mut lock = self.entry_cache.write().await;
        lock.insert(
            key,
            CachedEntryMetadata {
                entry,
                cached_at: std::time::Instant::now(),
            },
        );
    }

    /// Invalidate directory listing in catalog cache (e.g. after write, delete, rename)
    pub async fn invalidate_catalog(&self, session_id: &str, path: &str) {
        let prefix = format!("{}:", session_id);
        let clean_path = path.trim_end_matches('/');
        let parent = clean_path
            .rfind('/')
            .map(|i| &clean_path[..i])
            .unwrap_or("/");
        let exact_key = format!(
            "{}:{}",
            session_id,
            if clean_path.is_empty() {
                "/"
            } else {
                clean_path
            }
        );
        let parent_key = format!(
            "{}:{}",
            session_id,
            if parent.is_empty() { "/" } else { parent }
        );

        {
            let mut lock = self.catalog.write().await;
            lock.remove(&exact_key);
            lock.remove(&parent_key);
            if clean_path == "/" || clean_path.is_empty() {
                lock.retain(|k, _| !k.starts_with(&prefix));
            }
        }

        {
            let mut entry_lock = self.entry_cache.write().await;
            entry_lock.remove(&exact_key);
            let path_prefix = format!("{}:{}/", session_id, clean_path);
            entry_lock.retain(|k, _| !k.starts_with(&path_prefix));
            if clean_path == "/" || clean_path.is_empty() {
                entry_lock.retain(|k, _| !k.starts_with(&prefix));
            }
        }
    }

    // ---------------------- ON-DEMAND CONTENT CACHE ----------------------

    fn get_local_file_path(&self, session_id: &str, remote_path: &str) -> PathBuf {
        let clean = remote_path.trim_start_matches('/').replace("..", "_");
        self.base_dir.join(session_id).join(clean)
    }

    /// Read file content from local disk cache if available
    pub async fn get_file_content(
        &self,
        session_id: &str,
        remote_path: &str,
    ) -> Option<bytes::Bytes> {
        let local_path = self.get_local_file_path(session_id, remote_path);
        if tokio::fs::try_exists(&local_path).await.unwrap_or(false) {
            if let Ok(data) = tokio::fs::read(&local_path).await {
                // Update file access time (touch)
                let _ = tokio::fs::File::open(&local_path).await;
                return Some(bytes::Bytes::from(data));
            }
        }
        None
    }

    /// Store downloaded file content into local disk cache with LRU enforcement
    pub async fn put_file_content(
        &self,
        session_id: &str,
        remote_path: &str,
        data: &[u8],
    ) -> CoreResult<()> {
        let local_path = self.get_local_file_path(session_id, remote_path);
        if let Some(parent) = local_path.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }

        tokio::fs::write(&local_path, data)
            .await
            .map_err(|e| CoreError::General(format!("Failed to write to local cache: {}", e)))?;

        // Enforce max cache size limit via LRU eviction
        self.enforce_lru().await;

        Ok(())
    }

    /// Enforce LRU cache limits: deletes oldest files when total cache size exceeds max_bytes
    pub async fn enforce_lru(&self) {
        let max_limit = *self.max_bytes.read().await;
        let mut total_size: u64 = 0;
        let mut files: Vec<(PathBuf, u64, std::time::SystemTime)> = Vec::new();

        // Recursively inspect base_dir
        if let Ok(mut dir_reader) = tokio::fs::read_dir(&self.base_dir).await {
            let mut stack = Vec::new();
            while let Ok(Some(entry)) = dir_reader.next_entry().await {
                stack.push(entry.path());
            }

            while let Some(path) = stack.pop() {
                if let Ok(meta) = tokio::fs::metadata(&path).await {
                    if meta.is_dir() {
                        if let Ok(mut sub_reader) = tokio::fs::read_dir(&path).await {
                            while let Ok(Some(sub_entry)) = sub_reader.next_entry().await {
                                stack.push(sub_entry.path());
                            }
                        }
                    } else {
                        let size = meta.len();
                        total_size += size;
                        let accessed = meta
                            .accessed()
                            .or_else(|_| meta.modified())
                            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                        files.push((path, size, accessed));
                    }
                }
            }
        }

        if total_size > max_limit {
            // Sort by oldest accessed first
            files.sort_by_key(|(_, _, t)| *t);

            for (path, size, _) in files {
                if total_size <= max_limit {
                    break;
                }
                if tokio::fs::remove_file(&path).await.is_ok() {
                    total_size = total_size.saturating_sub(size);
                }
            }
        }
    }

    // ---------------------- CACHE MANAGEMENT & STATS ----------------------

    /// Calculate total bytes and file count for all sites
    pub async fn get_stats(&self, session_names: &HashMap<String, String>) -> CacheStats {
        let max_limit = *self.max_bytes.read().await;
        let mut site_map: HashMap<String, (u64, usize, std::time::SystemTime)> = HashMap::new();
        let mut total_bytes = 0;
        let mut total_files = 0;

        if let Ok(mut dir_reader) = tokio::fs::read_dir(&self.base_dir).await {
            while let Ok(Some(entry)) = dir_reader.next_entry().await {
                if let Ok(meta) = entry.metadata().await {
                    if meta.is_dir() {
                        let sess_id = entry.file_name().to_string_lossy().to_string();
                        let (bytes, count, last_t) = inspect_dir_size(&entry.path()).await;
                        total_bytes += bytes;
                        total_files += count;
                        site_map.insert(sess_id, (bytes, count, last_t));
                    }
                }
            }
        }

        let mut sites = Vec::new();
        for (sess_id, (bytes, count, last_t)) in site_map {
            let name = session_names
                .get(&sess_id)
                .cloned()
                .unwrap_or_else(|| sess_id.clone());
            let last_str = DateTime::<Utc>::from(last_t).to_rfc3339();
            sites.push(SiteCacheStats {
                session_id: sess_id,
                session_name: name,
                total_bytes: bytes,
                file_count: count,
                last_accessed: last_str,
            });
        }

        let catalog_folders = self.catalog.read().await.len();
        let catalog_items = self.entry_cache.read().await.len();

        CacheStats {
            total_bytes,
            max_bytes: max_limit,
            file_count: total_files,
            catalog_folders_count: catalog_folders,
            catalog_items_count: catalog_items,
            sites,
        }
    }

    /// Clear local cache for a single session/site
    pub async fn clear_session(&self, session_id: &str) -> CoreResult<()> {
        let site_dir = self.base_dir.join(session_id);
        if tokio::fs::try_exists(&site_dir).await.unwrap_or(false) {
            let _ = tokio::fs::remove_dir_all(&site_dir).await;
        }
        let prefix = format!("{}:", session_id);
        {
            let mut lock = self.catalog.write().await;
            lock.retain(|k, _| !k.starts_with(&prefix));
        }
        {
            let mut entry_lock = self.entry_cache.write().await;
            entry_lock.retain(|k, _| !k.starts_with(&prefix));
        }
        Ok(())
    }

    /// Clear all cached files across all sites
    pub async fn clear_all(&self) -> CoreResult<()> {
        if tokio::fs::try_exists(&self.base_dir).await.unwrap_or(false) {
            let _ = tokio::fs::remove_dir_all(&self.base_dir).await;
            let _ = tokio::fs::create_dir_all(&self.base_dir).await;
        }
        {
            let mut lock = self.catalog.write().await;
            lock.clear();
        }
        {
            let mut entry_lock = self.entry_cache.write().await;
            entry_lock.clear();
        }
        Ok(())
    }

    /// Set maximum storage quota in bytes
    pub async fn set_max_size(&self, bytes: u64) {
        let mut lock = self.max_bytes.write().await;
        *lock = bytes;
        drop(lock);
        self.enforce_lru().await;
    }

    /// Prune caches of sessions older than max_days
    pub async fn prune_stale(&self, max_days: i64) -> CoreResult<usize> {
        let cutoff = Utc::now() - chrono::Duration::days(max_days);
        let mut pruned = 0;

        if let Ok(mut dir_reader) = tokio::fs::read_dir(&self.base_dir).await {
            while let Ok(Some(entry)) = dir_reader.next_entry().await {
                if let Ok(meta) = entry.metadata().await {
                    if meta.is_dir() {
                        let (_, _, last_t) = inspect_dir_size(&entry.path()).await;
                        let dt: DateTime<Utc> = DateTime::from(last_t);
                        if dt < cutoff {
                            let _ = tokio::fs::remove_dir_all(entry.path()).await;
                            pruned += 1;
                        }
                    }
                }
            }
        }

        Ok(pruned)
    }
}

async fn inspect_dir_size(dir: &Path) -> (u64, usize, std::time::SystemTime) {
    let mut total_size = 0;
    let mut file_count = 0;
    let mut latest_time = std::time::SystemTime::UNIX_EPOCH;
    let mut stack = vec![dir.to_path_buf()];

    while let Some(current) = stack.pop() {
        if let Ok(mut reader) = tokio::fs::read_dir(&current).await {
            while let Ok(Some(entry)) = reader.next_entry().await {
                if let Ok(meta) = entry.metadata().await {
                    if meta.is_dir() {
                        stack.push(entry.path());
                    } else {
                        total_size += meta.len();
                        file_count += 1;
                        if let Ok(t) = meta.modified() {
                            if t > latest_time {
                                latest_time = t;
                            }
                        }
                    }
                }
            }
        }
    }

    (total_size, file_count, latest_time)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::FileType;

    #[tokio::test]
    async fn test_catalog_cache_put_get_invalidate() {
        let temp_dir =
            std::env::temp_dir().join(format!("rustscp_test_cache_{}", uuid::Uuid::new_v4()));
        let cache = ManagedDiskCache::new(Some(temp_dir.clone()), 1024 * 1024);

        let entries = vec![FileEntry {
            name: "index.html".to_string(),
            path: "/home/user/public_html/index.html".to_string(),
            file_type: FileType::File,
            size: 1200,
            modified_at: None,
            created_at: None,
            permissions: Default::default(),
            is_hidden: false,
        }];

        cache
            .put_catalog("sess1", "/home/user/public_html", entries.clone())
            .await;

        let retrieved = cache.get_catalog("sess1", "/home/user/public_html").await;
        assert!(retrieved.is_some());
        assert_eq!(retrieved.unwrap().len(), 1);

        let entry_meta = cache
            .get_entry_metadata("sess1", "/home/user/public_html/index.html")
            .await;
        assert!(entry_meta.is_some());
        assert_eq!(entry_meta.unwrap().name, "index.html");

        cache
            .invalidate_catalog("sess1", "/home/user/public_html")
            .await;
        assert!(cache
            .get_catalog("sess1", "/home/user/public_html")
            .await
            .is_none());
        assert!(cache
            .get_entry_metadata("sess1", "/home/user/public_html/index.html")
            .await
            .is_none());

        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    }

    #[tokio::test]
    async fn test_content_cache_put_get_and_lru() {
        let temp_dir =
            std::env::temp_dir().join(format!("rustscp_test_cache_{}", uuid::Uuid::new_v4()));
        // Set small quota of 50 bytes
        let cache = ManagedDiskCache::new(Some(temp_dir.clone()), 50);

        let file1_content = b"123456789012345678901234567890"; // 30 bytes
        let file2_content = b"abcdefghijklmnopqrstuvwxyz1234"; // 30 bytes

        cache
            .put_file_content("sess1", "/file1.txt", file1_content)
            .await
            .unwrap();
        let read1 = cache.get_file_content("sess1", "/file1.txt").await;
        assert_eq!(read1.as_deref(), Some(&file1_content[..]));

        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

        // Writing file2 will exceed 50 bytes (30 + 30 = 60), triggering LRU eviction of file1
        cache
            .put_file_content("sess1", "/file2.txt", file2_content)
            .await
            .unwrap();

        let mut names = HashMap::new();
        names.insert("sess1".to_string(), "Site 1".to_string());
        let stats = cache.get_stats(&names).await;
        assert!(
            stats.total_bytes <= 50,
            "Total bytes {} must be <= 50",
            stats.total_bytes
        );

        // Clear session
        cache.clear_session("sess1").await.unwrap();
        let stats_after = cache.get_stats(&names).await;
        assert_eq!(stats_after.total_bytes, 0);

        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    }

    #[tokio::test]
    async fn test_catalog_cache_ttl_and_parent_invalidation() {
        let temp_dir =
            std::env::temp_dir().join(format!("rustscp_test_cache_{}", uuid::Uuid::new_v4()));
        let cache = ManagedDiskCache::new(Some(temp_dir.clone()), 1024 * 1024);

        // Check default TTL is 300s
        assert_eq!(cache.catalog_ttl().as_secs(), 300);

        // Put catalog for /var/www and /var/www/site
        let entries_parent = vec![FileEntry {
            name: "site".to_string(),
            path: "/var/www/site".to_string(),
            file_type: FileType::Directory,
            size: 4096,
            modified_at: None,
            created_at: None,
            permissions: Default::default(),
            is_hidden: false,
        }];
        cache
            .put_catalog("remote1", "/var/www", entries_parent)
            .await;

        let entries_child = vec![FileEntry {
            name: "index.php".to_string(),
            path: "/var/www/site/index.php".to_string(),
            file_type: FileType::File,
            size: 2048,
            modified_at: None,
            created_at: None,
            permissions: Default::default(),
            is_hidden: false,
        }];
        cache
            .put_catalog("remote1", "/var/www/site", entries_child)
            .await;

        // Both should be cached
        assert!(cache.get_catalog("remote1", "/var/www").await.is_some());
        assert!(cache
            .get_catalog("remote1", "/var/www/site")
            .await
            .is_some());

        // Invalidating a child file /var/www/site/index.php should invalidate /var/www/site
        cache
            .invalidate_catalog("remote1", "/var/www/site/index.php")
            .await;
        assert!(cache
            .get_catalog("remote1", "/var/www/site")
            .await
            .is_none());
        // Parent /var/www still intact
        assert!(cache.get_catalog("remote1", "/var/www").await.is_some());

        // Test custom TTL
        cache.set_catalog_ttl_secs(1); // 1 sec
        tokio::time::sleep(tokio::time::Duration::from_millis(1100)).await;
        // /var/www now expired
        assert!(cache.get_catalog("remote1", "/var/www").await.is_none());

        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    }
}

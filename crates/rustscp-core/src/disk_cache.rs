use crate::types::{CoreError, CoreResult, FileEntry};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};

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

/// Catalog keys are `(session_id, normalized_path)`, so no session id or path can
/// collide with another one through a `:` separator.
type CatalogKey = (String, String);

/// File inside every site directory that records the original session id (the directory
/// itself is named after `hex(sha256(session_id))`).
const SESSION_ID_SIDECAR: &str = ".rustscp-session-id";
/// Prefix of the temp files used for atomic writes. Encoded cache names never start
/// with '.', so these names cannot collide with cached content.
const TEMP_PREFIX: &str = ".rustscp-tmp-";
/// Encoded path components longer than this are replaced by a hash.
const MAX_ENCODED_COMPONENT_LEN: usize = 200;
/// Files larger than `max_bytes / LARGE_FILE_DIVISOR` are not cached, so a single file
/// can never evict the whole cache.
const LARGE_FILE_DIVISOR: u64 = 4;
/// Expired catalog entries are purged every this many catalog inserts.
const CATALOG_PURGE_INTERVAL: u64 = 256;
/// Upper bounds on the in-memory catalogs; above them the oldest half is dropped.
const MAX_CATALOG_DIRS: usize = 20_000;
const MAX_CATALOG_ITEMS: usize = 250_000;

/// In-memory LRU index of the cached files: built once by scanning the cache directory,
/// then kept up to date on every put/get/remove so eviction never walks the tree.
#[derive(Default)]
struct ContentIndex {
    loaded: bool,
    total: u64,
    clock: u64,
    files: HashMap<PathBuf, (u64, u64)>,
    order: BTreeMap<u64, PathBuf>,
}

impl ContentIndex {
    fn insert(&mut self, path: PathBuf, size: u64) {
        self.remove(&path);
        self.clock += 1;
        self.files.insert(path.clone(), (size, self.clock));
        self.order.insert(self.clock, path);
        self.total += size;
    }

    fn touch(&mut self, path: &Path) {
        if let Some((_, tick)) = self.files.get_mut(path) {
            self.order.remove(tick);
            self.clock += 1;
            *tick = self.clock;
            self.order.insert(self.clock, path.to_path_buf());
        }
    }

    fn remove(&mut self, path: &Path) -> Option<u64> {
        let (size, tick) = self.files.remove(path)?;
        self.order.remove(&tick);
        self.total = self.total.saturating_sub(size);
        Some(size)
    }

    fn remove_prefix(&mut self, prefix: &Path) {
        let doomed: Vec<PathBuf> = self
            .files
            .keys()
            .filter(|p| p.starts_with(prefix))
            .cloned()
            .collect();
        for p in doomed {
            self.remove(&p);
        }
    }

    fn pop_oldest(&mut self) -> Option<(PathBuf, u64)> {
        let tick = *self.order.keys().next()?;
        let path = self.order.remove(&tick)?;
        let (size, _) = self.files.remove(&path)?;
        self.total = self.total.saturating_sub(size);
        Some((path, size))
    }

    fn reset(&mut self) {
        *self = ContentIndex::default();
    }
}

/// Smart Manageable Local Disk & Catalog Cache Manager
/// - Sparse / Shadow virtual files: directory structure is loaded as shadow catalog metadata
/// - On-demand streaming: file content is only downloaded when read
/// - LRU storage eviction and automatic cleanup of inactive sites
///
/// On-disk layout: `<base_dir>/<hex(sha256(session_id))>/<encoded>/<path>/<components>`.
/// Session ids never become path components, and every remote path component is
/// escaped (see [`encode_component`]), so nothing can escape `base_dir`, and distinct
/// remote paths never share a cache file (also on case-insensitive volumes).
/// Directories are created 0700 and files 0600 on Unix, and files are written
/// atomically (temp file + rename).
pub struct ManagedDiskCache {
    base_dir: PathBuf,
    max_bytes: Arc<RwLock<u64>>,
    catalog_ttl_secs: AtomicU64,
    catalog: Arc<RwLock<HashMap<CatalogKey, CatalogEntry>>>,
    entry_cache: Arc<RwLock<HashMap<CatalogKey, CachedEntryMetadata>>>,
    catalog_inserts: AtomicU64,
    content_index: Mutex<ContentIndex>,
}

impl Default for ManagedDiskCache {
    fn default() -> Self {
        Self::new(None, 1024 * 1024 * 1024) // 1 GB default limit
    }
}

fn catalog_path(path: &str) -> String {
    let clean = path.trim_end_matches('/');
    if clean.is_empty() {
        "/".to_string()
    } else {
        clean.to_string()
    }
}

fn catalog_key(session_id: &str, path: &str) -> CatalogKey {
    (session_id.to_string(), catalog_path(path))
}

/// Lower-case hex SHA-256 of `data` (also used for cache directory names).
pub fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

/// Directory name used for a session's cached content: `hex(sha256(session_id))`.
pub fn session_dir_name(session_id: &str) -> String {
    sha256_hex(session_id.as_bytes())
}

fn is_windows_reserved_stem(stem: &str) -> bool {
    matches!(stem, "con" | "prn" | "aux" | "nul")
        || ((stem.starts_with("com") || stem.starts_with("lpt"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit())
}

/// Escapes one remote path component into a portable, collision-free local file name.
///
/// Only `[a-z0-9_-]` and inner dots pass through. Everything else (upper-case letters,
/// leading/trailing dots, spaces, `%`, `\`, `:`, non-ASCII bytes...) becomes `%XX`, so
/// `.`/`..` can never appear, no encoded name starts with '.', and two different names
/// never map to names that differ only by case. Windows device names get their first
/// letter escaped, and very long results are replaced by `~<sha256>`.
pub fn encode_component(component: &str) -> String {
    let bytes = component.as_bytes();
    let last = bytes.len().saturating_sub(1);
    let mut out = String::with_capacity(bytes.len());
    for (i, &b) in bytes.iter().enumerate() {
        let plain = matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'_' | b'-')
            || (b == b'.' && i != 0 && i != last);
        if plain {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    let stem = out.split('.').next().unwrap_or("");
    if is_windows_reserved_stem(stem) {
        out = format!("%{:02X}{}", out.as_bytes()[0], &out[1..]);
    }
    if out.len() > MAX_ENCODED_COMPONENT_LEN {
        out = format!("~{}", sha256_hex(component.as_bytes()));
    }
    out
}

/// Encoded components of a remote path. Empty and `.` components are dropped; `..`
/// is kept as a literal (escaped) name, never resolved.
fn encoded_components(remote_path: &str) -> Vec<String> {
    remote_path
        .split('/')
        .filter(|c| !c.is_empty() && *c != ".")
        .map(encode_component)
        .collect()
}

/// A raw directory name accepted for a legacy (pre-hash) site directory.
fn is_safe_legacy_dir_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name != "."
        && name != ".."
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}

fn is_internal_file_name(name: &str) -> bool {
    name == SESSION_ID_SIDECAR || name.starts_with(TEMP_PREFIX)
}

/// Creates `dir` and its missing parents, private to the current user (0700 on Unix).
async fn create_private_dir_all(dir: &Path) -> std::io::Result<()> {
    let mut builder = tokio::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    builder.mode(0o700);
    builder.create(dir).await
}

async fn restrict_dir(dir: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = tokio::fs::metadata(dir).await {
            if meta.permissions().mode() & 0o077 != 0 {
                if let Err(e) =
                    tokio::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).await
                {
                    tracing::warn!("could not restrict cache dir {}: {e}", dir.display());
                }
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
    }
}

/// Writes `data` to `path` atomically: temp file in the same directory (0600 on Unix),
/// then rename. A failed write removes the temp file, so readers only ever see complete
/// files.
async fn write_private_atomic(path: &Path, data: &[u8]) -> std::io::Result<()> {
    use tokio::io::AsyncWriteExt;
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let tmp = dir.join(format!("{TEMP_PREFIX}{}", uuid::Uuid::new_v4().simple()));
    let result = async {
        let mut opts = tokio::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        opts.mode(0o600);
        let mut file = opts.open(&tmp).await?;
        file.write_all(data).await?;
        file.flush().await?;
        drop(file);
        tokio::fs::rename(&tmp, path).await
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&tmp).await;
    }
    result
}

async fn remove_path(path: &Path) -> std::io::Result<()> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(meta) if meta.is_dir() => tokio::fs::remove_dir_all(path).await,
        Ok(_) => tokio::fs::remove_file(path).await,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Scans the cache directory once (on a blocking thread) for the LRU index: every
/// regular file except internal sidecars/temp files, oldest access first.
fn scan_cached_files(base: &Path) -> Vec<(PathBuf, u64)> {
    let mut found: Vec<(PathBuf, u64, std::time::SystemTime)> = Vec::new();
    let mut stack = vec![base.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(reader) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in reader.flatten() {
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.is_dir() {
                stack.push(entry.path());
            } else if meta.is_file() {
                let name = entry.file_name();
                if is_internal_file_name(&name.to_string_lossy()) {
                    continue;
                }
                let t = meta
                    .accessed()
                    .or_else(|_| meta.modified())
                    .unwrap_or(std::time::UNIX_EPOCH);
                found.push((entry.path(), meta.len(), t));
            }
        }
    }
    found.sort_by_key(|(_, _, t)| *t);
    found.into_iter().map(|(p, s, _)| (p, s)).collect()
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
            catalog_inserts: AtomicU64::new(0),
            content_index: Mutex::new(ContentIndex::default()),
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
        let key = catalog_key(session_id, path);
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
        let key = catalog_key(session_id, path);
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
                let entry_key = catalog_key(session_id, &entry.path);
                entry_lock.insert(
                    entry_key,
                    CachedEntryMetadata {
                        entry,
                        cached_at: now,
                    },
                );
            }
        }

        self.maybe_purge_catalogs().await;
    }

    /// Retrieve individual cached file/folder metadata if available and fresh
    pub async fn get_entry_metadata(&self, session_id: &str, path: &str) -> Option<FileEntry> {
        let key = catalog_key(session_id, path);
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
        let key = catalog_key(session_id, &entry.path);
        {
            let mut lock = self.entry_cache.write().await;
            lock.insert(
                key,
                CachedEntryMetadata {
                    entry,
                    cached_at: std::time::Instant::now(),
                },
            );
        }
        self.maybe_purge_catalogs().await;
    }

    /// Drops expired catalog/metadata entries every `CATALOG_PURGE_INTERVAL` inserts and
    /// keeps both maps under their size caps, so long sessions do not grow memory forever.
    async fn maybe_purge_catalogs(&self) {
        let n = self.catalog_inserts.fetch_add(1, Ordering::Relaxed) + 1;
        let over_cap = self.catalog.read().await.len() > MAX_CATALOG_DIRS
            || self.entry_cache.read().await.len() > MAX_CATALOG_ITEMS;
        if !n.is_multiple_of(CATALOG_PURGE_INTERVAL) && !over_cap {
            return;
        }
        self.purge_expired_catalogs().await;
    }

    /// Removes every expired catalog and metadata entry (and the oldest half of a map that
    /// is still above its cap). Returns how many entries were dropped.
    pub async fn purge_expired_catalogs(&self) -> usize {
        let ttl = self.catalog_ttl();
        let mut dropped = 0;
        {
            let mut lock = self.catalog.write().await;
            let before = lock.len();
            lock.retain(|_, v| v.cached_at.elapsed() < ttl);
            if lock.len() > MAX_CATALOG_DIRS {
                drop_oldest_half(&mut lock, |v| v.cached_at);
            }
            dropped += before - lock.len();
        }
        {
            let mut lock = self.entry_cache.write().await;
            let before = lock.len();
            lock.retain(|_, v| v.cached_at.elapsed() < ttl);
            if lock.len() > MAX_CATALOG_ITEMS {
                drop_oldest_half(&mut lock, |v| v.cached_at);
            }
            dropped += before - lock.len();
        }
        dropped
    }

    /// Invalidate directory listing in catalog cache (e.g. after write, delete, rename).
    ///
    /// Drops the listing of `path`, of its parent, and every cached listing or entry below
    /// `path` (a deleted or renamed folder takes its subfolders with it). Cached file
    /// content is not touched; use [`ManagedDiskCache::invalidate_content`] for that.
    pub async fn invalidate_catalog(&self, session_id: &str, path: &str) {
        let clean_path = path.trim_end_matches('/');
        let is_root = clean_path.is_empty();
        let parent = clean_path
            .rfind('/')
            .map(|i| &clean_path[..i])
            .unwrap_or("/");
        let exact_key = catalog_key(session_id, clean_path);
        let parent_key = catalog_key(session_id, parent);
        let sub_prefix = format!("{clean_path}/");
        let is_below =
            |k: &CatalogKey| k.0 == session_id && (is_root || k.1.starts_with(&sub_prefix));

        {
            let mut lock = self.catalog.write().await;
            lock.remove(&exact_key);
            lock.remove(&parent_key);
            lock.retain(|k, _| !is_below(k));
        }

        {
            let mut entry_lock = self.entry_cache.write().await;
            entry_lock.remove(&exact_key);
            entry_lock.retain(|k, _| !is_below(k));
        }
    }

    // ---------------------- ON-DEMAND CONTENT CACHE ----------------------

    fn site_dir(&self, session_id: &str) -> PathBuf {
        self.base_dir.join(session_dir_name(session_id))
    }

    /// Local cache path of a remote file, or `None` for the root / an empty path.
    fn get_local_file_path(&self, session_id: &str, remote_path: &str) -> Option<PathBuf> {
        let components = encoded_components(remote_path);
        if components.is_empty() {
            return None;
        }
        let mut path = self.site_dir(session_id);
        for c in components {
            path.push(c);
        }
        Some(path)
    }

    /// Prepares the site directory (0700) with its session-id sidecar.
    async fn ensure_site_dir(&self, session_id: &str) -> std::io::Result<PathBuf> {
        if !tokio::fs::try_exists(&self.base_dir).await.unwrap_or(false) {
            create_private_dir_all(&self.base_dir).await?;
        }
        restrict_dir(&self.base_dir).await;
        let site = self.site_dir(session_id);
        create_private_dir_all(&site).await?;
        let sidecar = site.join(SESSION_ID_SIDECAR);
        if !tokio::fs::try_exists(&sidecar).await.unwrap_or(false) {
            let _ = write_private_atomic(&sidecar, session_id.as_bytes()).await;
        }
        Ok(site)
    }

    /// Creates the parent directories of a cache file. A stale cached *file* sitting where
    /// a directory is now needed (the remote path changed from file to folder) is removed.
    async fn ensure_parent_dirs(&self, site: &Path, local_path: &Path) -> std::io::Result<()> {
        let Some(parent) = local_path.parent() else {
            return Ok(());
        };
        if create_private_dir_all(parent).await.is_ok() {
            return Ok(());
        }
        let rel = parent.strip_prefix(site).unwrap_or(parent);
        let mut cur = site.to_path_buf();
        for comp in rel.components() {
            cur.push(comp);
            if let Ok(meta) = tokio::fs::symlink_metadata(&cur).await {
                if !meta.is_dir() {
                    tokio::fs::remove_file(&cur).await?;
                    self.content_index.lock().await.remove(&cur);
                }
            }
        }
        create_private_dir_all(parent).await
    }

    /// Read file content from local disk cache if available
    pub async fn get_file_content(
        &self,
        session_id: &str,
        remote_path: &str,
    ) -> Option<bytes::Bytes> {
        let local_path = self.get_local_file_path(session_id, remote_path)?;
        match tokio::fs::read(&local_path).await {
            Ok(data) => {
                // Mark as recently used in the LRU index.
                self.content_index.lock().await.touch(&local_path);
                Some(bytes::Bytes::from(data))
            }
            Err(_) => None,
        }
    }

    /// Store downloaded file content into local disk cache with LRU enforcement.
    ///
    /// The file is written atomically. Content larger than a quarter of the quota is not
    /// cached (any older cached copy of that path is dropped instead), so one big file
    /// cannot flush the whole cache.
    pub async fn put_file_content(
        &self,
        session_id: &str,
        remote_path: &str,
        data: &[u8],
    ) -> CoreResult<()> {
        let local_path = self.get_local_file_path(session_id, remote_path).ok_or_else(|| {
            CoreError::InvalidPath(format!("cannot cache content for '{remote_path}'"))
        })?;

        let max_limit = *self.max_bytes.read().await;
        if data.len() as u64 > max_limit / LARGE_FILE_DIVISOR {
            let _ = remove_path(&local_path).await;
            self.content_index.lock().await.remove_prefix(&local_path);
            return Ok(());
        }

        let io_err = |e: std::io::Error| {
            CoreError::General(format!("Failed to write to local cache: {}", e))
        };
        let site = self.ensure_site_dir(session_id).await.map_err(io_err)?;
        self.ensure_parent_dirs(&site, &local_path)
            .await
            .map_err(io_err)?;
        if let Ok(meta) = tokio::fs::symlink_metadata(&local_path).await {
            if meta.is_dir() {
                // The remote path changed from folder to file: drop the stale subtree.
                let _ = tokio::fs::remove_dir_all(&local_path).await;
                self.content_index.lock().await.remove_prefix(&local_path);
            }
        }
        write_private_atomic(&local_path, data)
            .await
            .map_err(io_err)?;

        let mut index = self.content_index.lock().await;
        self.ensure_index_loaded(&mut index).await;
        index.insert(local_path, data.len() as u64);
        self.evict_locked(&mut index, max_limit).await;
        Ok(())
    }

    /// Removes the cached content of `remote_path` (a file, or a whole folder subtree).
    /// Call it after the remote file was changed, deleted or renamed outside the cache.
    pub async fn invalidate_content(&self, session_id: &str, remote_path: &str) {
        let target = match self.get_local_file_path(session_id, remote_path) {
            Some(p) => p,
            None => self.site_dir(session_id),
        };
        let _ = remove_path(&target).await;
        self.content_index.lock().await.remove_prefix(&target);
    }

    async fn ensure_index_loaded(&self, index: &mut ContentIndex) {
        if index.loaded {
            return;
        }
        let base = self.base_dir.clone();
        let files = tokio::task::spawn_blocking(move || scan_cached_files(&base))
            .await
            .unwrap_or_default();
        index.reset();
        for (path, size) in files {
            index.insert(path, size);
        }
        index.loaded = true;
    }

    async fn evict_locked(&self, index: &mut ContentIndex, max_limit: u64) {
        let mut kept: Vec<(PathBuf, u64)> = Vec::new();
        while index.total > max_limit {
            let Some((path, size)) = index.pop_oldest() else {
                break;
            };
            match tokio::fs::remove_file(&path).await {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => kept.push((path, size)),
            }
        }
        // Files that could not be removed (e.g. open on Windows) stay accounted for.
        for (path, size) in kept {
            index.insert(path, size);
        }
    }

    /// Enforce LRU cache limits: deletes least recently used files while the total cache
    /// size exceeds max_bytes. Uses the in-memory index (one directory scan at first use).
    pub async fn enforce_lru(&self) {
        let max_limit = *self.max_bytes.read().await;
        let mut index = self.content_index.lock().await;
        self.ensure_index_loaded(&mut index).await;
        self.evict_locked(&mut index, max_limit).await;
    }

    // ---------------------- CACHE MANAGEMENT & STATS ----------------------

    /// Calculate total bytes and file count for all sites.
    ///
    /// `session_id` in each site entry is the original session id (read from the site
    /// directory's sidecar), or the directory name for legacy directories without one.
    pub async fn get_stats(&self, session_names: &HashMap<String, String>) -> CacheStats {
        let max_limit = *self.max_bytes.read().await;
        let mut site_map: HashMap<String, (u64, usize, std::time::SystemTime)> = HashMap::new();
        let mut total_bytes = 0;
        let mut total_files = 0;

        if let Ok(mut dir_reader) = tokio::fs::read_dir(&self.base_dir).await {
            while let Ok(Some(entry)) = dir_reader.next_entry().await {
                if let Ok(meta) = entry.metadata().await {
                    if meta.is_dir() {
                        let dir_name = entry.file_name().to_string_lossy().to_string();
                        let sess_id =
                            match tokio::fs::read_to_string(entry.path().join(SESSION_ID_SIDECAR))
                                .await
                            {
                                Ok(s) if !s.is_empty() => s,
                                _ => dir_name,
                            };
                        let (bytes, count, last_t) = inspect_dir_size(&entry.path()).await;
                        total_bytes += bytes;
                        total_files += count;
                        let slot = site_map.entry(sess_id).or_insert((
                            0,
                            0,
                            std::time::UNIX_EPOCH,
                        ));
                        slot.0 += bytes;
                        slot.1 += count;
                        if last_t > slot.2 {
                            slot.2 = last_t;
                        }
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
        sites.sort_by(|a, b| b.total_bytes.cmp(&a.total_bytes));

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

    /// Clear local cache for a single session/site.
    ///
    /// Removes `<base>/<hex(sha256(session_id))>` and, for caches written by older
    /// versions, `<base>/<session_id>` when the id is a plain directory name. Nothing
    /// outside the cache directory can be reached through the id.
    pub async fn clear_session(&self, session_id: &str) -> CoreResult<()> {
        let mut dirs = vec![self.site_dir(session_id)];
        if is_safe_legacy_dir_name(session_id) {
            dirs.push(self.base_dir.join(session_id));
        }
        {
            let mut index = self.content_index.lock().await;
            for dir in &dirs {
                if tokio::fs::try_exists(dir).await.unwrap_or(false) {
                    let _ = tokio::fs::remove_dir_all(dir).await;
                }
                index.remove_prefix(dir);
            }
        }
        {
            let mut lock = self.catalog.write().await;
            lock.retain(|k, _| k.0 != session_id);
        }
        {
            let mut entry_lock = self.entry_cache.write().await;
            entry_lock.retain(|k, _| k.0 != session_id);
        }
        Ok(())
    }

    /// Clear all cached files across all sites
    pub async fn clear_all(&self) -> CoreResult<()> {
        {
            let mut index = self.content_index.lock().await;
            if tokio::fs::try_exists(&self.base_dir).await.unwrap_or(false) {
                let _ = tokio::fs::remove_dir_all(&self.base_dir).await;
                let _ = create_private_dir_all(&self.base_dir).await;
            }
            index.reset();
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

        let mut index = self.content_index.lock().await;
        if let Ok(mut dir_reader) = tokio::fs::read_dir(&self.base_dir).await {
            while let Ok(Some(entry)) = dir_reader.next_entry().await {
                if let Ok(meta) = entry.metadata().await {
                    if meta.is_dir() {
                        let (_, _, last_t) = inspect_dir_size(&entry.path()).await;
                        let dt: DateTime<Utc> = DateTime::from(last_t);
                        if dt < cutoff {
                            let _ = tokio::fs::remove_dir_all(entry.path()).await;
                            index.remove_prefix(&entry.path());
                            pruned += 1;
                        }
                    }
                }
            }
        }

        Ok(pruned)
    }
}

fn drop_oldest_half<V>(
    map: &mut HashMap<CatalogKey, V>,
    cached_at: impl Fn(&V) -> std::time::Instant,
) {
    let mut times: Vec<std::time::Instant> = map.values().map(&cached_at).collect();
    if times.is_empty() {
        return;
    }
    let mid = times.len() / 2;
    let (_, cutoff, _) = times.select_nth_unstable(mid);
    let cutoff = *cutoff;
    map.retain(|_, v| cached_at(v) >= cutoff);
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
                        if is_internal_file_name(&entry.file_name().to_string_lossy()) {
                            continue;
                        }
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

    fn temp_cache_dir() -> PathBuf {
        std::env::temp_dir().join(format!("rustscp_test_cache_{}", uuid::Uuid::new_v4()))
    }

    fn file_entry(path: &str, file_type: FileType) -> FileEntry {
        FileEntry {
            name: path.rsplit('/').next().unwrap_or("").to_string(),
            path: path.to_string(),
            file_type,
            size: 1,
            modified_at: None,
            created_at: None,
            permissions: Default::default(),
            is_hidden: false,
        }
    }

    #[tokio::test]
    async fn test_catalog_cache_put_get_invalidate() {
        let temp_dir = temp_cache_dir();
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
        let temp_dir = temp_cache_dir();
        // Quota of 200 bytes: 40-byte files are cacheable (<= 200 / 4).
        let cache = ManagedDiskCache::new(Some(temp_dir.clone()), 200);

        let contents: Vec<Vec<u8>> = (0..6).map(|i| vec![b'a' + i as u8; 40]).collect();
        for (i, c) in contents.iter().enumerate().take(4) {
            cache
                .put_file_content("sess1", &format!("/file{i}.txt"), c)
                .await
                .unwrap();
        }
        let read0 = cache.get_file_content("sess1", "/file0.txt").await;
        assert_eq!(read0.as_deref(), Some(&contents[0][..]));

        // 4 * 40 = 160; two more files reach 240 > 200, evicting the least recently used
        // file (file1: file0 was just read, so it is no longer the oldest).
        cache
            .put_file_content("sess1", "/file4.txt", &contents[4])
            .await
            .unwrap();
        cache
            .put_file_content("sess1", "/file5.txt", &contents[5])
            .await
            .unwrap();

        assert!(cache.get_file_content("sess1", "/file0.txt").await.is_some());
        assert!(cache.get_file_content("sess1", "/file1.txt").await.is_none());
        assert!(cache.get_file_content("sess1", "/file5.txt").await.is_some());

        let mut names = HashMap::new();
        names.insert("sess1".to_string(), "Site 1".to_string());
        let stats = cache.get_stats(&names).await;
        assert!(
            stats.total_bytes <= 200,
            "Total bytes {} must be <= 200",
            stats.total_bytes
        );
        assert_eq!(stats.sites.len(), 1);
        assert_eq!(stats.sites[0].session_id, "sess1");
        assert_eq!(stats.sites[0].session_name, "Site 1");
        assert_eq!(stats.file_count, stats.sites[0].file_count);

        // Clear session
        cache.clear_session("sess1").await.unwrap();
        let stats_after = cache.get_stats(&names).await;
        assert_eq!(stats_after.total_bytes, 0);

        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    }

    #[tokio::test]
    async fn test_large_file_is_not_cached_and_drops_stale_copy() {
        let temp_dir = temp_cache_dir();
        let cache = ManagedDiskCache::new(Some(temp_dir.clone()), 100);
        cache
            .put_file_content("s", "/big.bin", b"small")
            .await
            .unwrap();
        assert!(cache.get_file_content("s", "/big.bin").await.is_some());

        // 30 bytes > 100 / 4: not cached, and the old small copy must not be served.
        cache
            .put_file_content("s", "/big.bin", &[7u8; 30])
            .await
            .unwrap();
        assert!(cache.get_file_content("s", "/big.bin").await.is_none());
        cache.put_file_content("s", "/other", b"x").await.unwrap();
        assert!(cache.get_file_content("s", "/other").await.is_some());

        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    }

    #[tokio::test]
    async fn test_session_ids_cannot_escape_the_cache_dir() {
        let root = temp_cache_dir();
        let base = root.join("cache");
        let victim = root.join("victim");
        tokio::fs::create_dir_all(&victim).await.unwrap();
        tokio::fs::write(victim.join("keep.txt"), b"precious")
            .await
            .unwrap();
        let cache = ManagedDiskCache::new(Some(base.clone()), 1024 * 1024);

        for evil in [
            "../victim",
            "..",
            ".",
            "",
            victim.to_str().unwrap(),
            "a/../../victim",
            "..\\victim",
        ] {
            cache
                .put_file_content(evil, "/../../victim/owned.txt", b"x")
                .await
                .unwrap();
            assert!(cache
                .get_file_content(evil, "/../../victim/owned.txt")
                .await
                .is_some());
            cache.clear_session(evil).await.unwrap();
        }

        assert!(!victim.join("owned.txt").exists());
        assert_eq!(
            tokio::fs::read(victim.join("keep.txt")).await.unwrap(),
            b"precious"
        );
        // Every site directory is a 64-hex hash, directly under base.
        assert_eq!(session_dir_name("../victim").len(), 64);
        assert!(cache.site_dir("/etc").starts_with(&base));

        let _ = tokio::fs::remove_dir_all(&root).await;
    }

    #[tokio::test]
    async fn test_distinct_remote_paths_never_share_a_cache_file() {
        let temp_dir = temp_cache_dir();
        let cache = ManagedDiskCache::new(Some(temp_dir.clone()), 1024 * 1024);
        let paths = [
            "/docs/v1..2.txt",
            "/docs/v1_2.txt",
            "/docs/A.txt",
            "/docs/a.txt",
            "/docs/a%41.txt",
            "/docs/a b",
            "/docs/..",
            "/docs/con.txt",
            "/docs/.hidden",
            "/docs/trailing.",
            "/docs/trailing",
        ];
        for (i, p) in paths.iter().enumerate() {
            cache
                .put_file_content("s", p, format!("content-{i}").as_bytes())
                .await
                .unwrap();
        }
        for (i, p) in paths.iter().enumerate() {
            let got = cache.get_file_content("s", p).await.unwrap();
            assert_eq!(&got[..], format!("content-{i}").as_bytes(), "path {p}");
        }
        let long = format!("/{}", "x".repeat(300));
        cache.put_file_content("s", &long, b"long").await.unwrap();
        assert_eq!(
            &cache.get_file_content("s", &long).await.unwrap()[..],
            b"long"
        );
        assert!(cache.put_file_content("s", "/", b"root").await.is_err());

        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    }

    #[test]
    fn test_encode_component_rules() {
        assert_eq!(encode_component("index.html"), "index.html");
        assert_eq!(encode_component(".."), "%2E%2E");
        assert_eq!(encode_component("."), "%2E");
        assert_eq!(encode_component("A"), "%41");
        assert_eq!(encode_component("a/b"), "a%2Fb");
        assert_eq!(encode_component("nul"), "%6Eul");
        assert!(!encode_component(".env").starts_with('.'));
        assert!(encode_component(&"é".repeat(200)).starts_with('~'));
    }

    #[tokio::test]
    async fn test_file_and_folder_changes_replace_stale_entries() {
        let temp_dir = temp_cache_dir();
        let cache = ManagedDiskCache::new(Some(temp_dir.clone()), 1024 * 1024);
        cache.put_file_content("s", "/a", b"file").await.unwrap();
        // "/a" became a folder.
        cache.put_file_content("s", "/a/b", b"child").await.unwrap();
        assert_eq!(&cache.get_file_content("s", "/a/b").await.unwrap()[..], b"child");
        assert!(cache.get_file_content("s", "/a").await.is_none());
        // ...and a file again.
        cache.put_file_content("s", "/a", b"file2").await.unwrap();
        assert_eq!(&cache.get_file_content("s", "/a").await.unwrap()[..], b"file2");
        assert!(cache.get_file_content("s", "/a/b").await.is_none());

        cache.put_file_content("s", "/dir/x", b"1").await.unwrap();
        cache.put_file_content("s", "/dir/sub/y", b"2").await.unwrap();
        cache.invalidate_content("s", "/dir").await;
        assert!(cache.get_file_content("s", "/dir/x").await.is_none());
        assert!(cache.get_file_content("s", "/dir/sub/y").await.is_none());
        assert!(cache.get_file_content("s", "/a").await.is_some());

        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    }

    #[tokio::test]
    async fn test_writes_are_atomic_and_private() {
        let temp_dir = temp_cache_dir();
        let cache = ManagedDiskCache::new(Some(temp_dir.clone()), 1024 * 1024);
        cache
            .put_file_content("s", "/secret/.env", b"DB_PASSWORD=x")
            .await
            .unwrap();
        cache
            .put_file_content("s", "/secret/.env", b"DB_PASSWORD=y")
            .await
            .unwrap();
        assert_eq!(
            &cache.get_file_content("s", "/secret/.env").await.unwrap()[..],
            b"DB_PASSWORD=y"
        );

        let local = cache.get_local_file_path("s", "/secret/.env").unwrap();
        let parent = local.parent().unwrap();
        let mut rd = tokio::fs::read_dir(parent).await.unwrap();
        while let Some(e) = rd.next_entry().await.unwrap() {
            assert!(
                !e.file_name().to_string_lossy().starts_with(TEMP_PREFIX),
                "temp file left behind"
            );
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&local).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
            for dir in [temp_dir.clone(), cache.site_dir("s"), parent.to_path_buf()] {
                let mode = std::fs::metadata(&dir).unwrap().permissions().mode();
                assert_eq!(mode & 0o077, 0, "{} must be private", dir.display());
            }
        }

        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    }

    #[tokio::test]
    async fn test_index_is_built_from_existing_files_and_legacy_dirs_are_cleared() {
        let temp_dir = temp_cache_dir();
        // A cache directory written by an older version: raw session id as dir name.
        let legacy = temp_dir.join("old-session");
        tokio::fs::create_dir_all(&legacy).await.unwrap();
        tokio::fs::write(legacy.join("old.bin"), vec![0u8; 60])
            .await
            .unwrap();

        let cache = ManagedDiskCache::new(Some(temp_dir.clone()), 400);
        let stats = cache.get_stats(&HashMap::new()).await;
        assert_eq!(stats.total_bytes, 60);
        assert_eq!(stats.sites[0].session_id, "old-session");

        // Lowering the quota evicts the pre-existing file through the index.
        cache.set_max_size(50).await;
        assert!(!legacy.join("old.bin").exists());

        tokio::fs::write(legacy.join("again.bin"), b"zz").await.unwrap();
        cache.clear_session("old-session").await.unwrap();
        assert!(!legacy.exists());

        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    }

    #[tokio::test]
    async fn test_catalog_cache_ttl_and_parent_invalidation() {
        let temp_dir = temp_cache_dir();
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

    #[tokio::test]
    async fn test_invalidating_a_folder_drops_cached_subfolder_listings() {
        let cache = ManagedDiskCache::new(Some(temp_cache_dir()), 1024);
        cache
            .put_catalog("s", "/var/www", vec![file_entry("/var/www/site", FileType::Directory)])
            .await;
        cache
            .put_catalog(
                "s",
                "/var/www/site/assets",
                vec![file_entry("/var/www/site/assets/a.css", FileType::File)],
            )
            .await;
        cache
            .put_catalog("s", "/var/www/sitemap", vec![file_entry("/var/www/sitemap/x", FileType::File)])
            .await;
        cache
            .put_catalog("other", "/var/www/site/assets", vec![])
            .await;

        cache.invalidate_catalog("s", "/var/www/site").await;
        assert!(cache.get_catalog("s", "/var/www/site/assets").await.is_none());
        assert!(cache
            .get_entry_metadata("s", "/var/www/site/assets/a.css")
            .await
            .is_none());
        assert!(cache.get_catalog("s", "/var/www").await.is_none(), "parent listing changed");
        // Siblings sharing a name prefix and other sessions are kept.
        assert!(cache.get_catalog("s", "/var/www/sitemap").await.is_some());
        assert!(cache.get_catalog("other", "/var/www/site/assets").await.is_some());

        cache.invalidate_catalog("s", "/").await;
        assert!(cache.get_catalog("s", "/var/www/sitemap").await.is_none());
        assert!(cache.get_catalog("other", "/var/www/site/assets").await.is_some());
    }

    #[tokio::test]
    async fn test_expired_catalog_entries_are_purged() {
        let cache = ManagedDiskCache::new(Some(temp_cache_dir()), 1024);
        cache.set_catalog_ttl_secs(0);
        for i in 0..10 {
            cache
                .put_catalog("s", &format!("/d{i}"), vec![file_entry(&format!("/d{i}/f"), FileType::File)])
                .await;
        }
        assert!(cache.purge_expired_catalogs().await >= 20);
        let stats = cache.get_stats(&HashMap::new()).await;
        assert_eq!(stats.catalog_folders_count, 0);
        assert_eq!(stats.catalog_items_count, 0);

        // Session ids containing ':' cannot collide with other sessions' keys.
        cache.set_catalog_ttl_secs(300);
        cache.put_catalog("a:b", "/x", vec![]).await;
        assert!(cache.get_catalog("a", "b:/x").await.is_none());
    }
}

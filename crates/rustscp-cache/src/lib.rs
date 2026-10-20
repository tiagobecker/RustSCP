use bytes::Bytes;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::RwLock;

pub const DEFAULT_CHUNK_SIZE: usize = 4 * 1024 * 1024; // 4MB
/// Default RAM budget for cached chunks (clean and dirty together).
pub const DEFAULT_MAX_MEMORY_BYTES: usize = 256 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ChunkKey {
    pub connection_id: String,
    pub file_path: String,
    pub chunk_index: u64,
}

impl ChunkKey {
    pub fn new(
        connection_id: impl Into<String>,
        file_path: impl Into<String>,
        chunk_index: u64,
    ) -> Self {
        Self {
            connection_id: connection_id.into(),
            file_path: file_path.into(),
            chunk_index,
        }
    }
}

#[derive(Debug, Clone)]
pub struct CacheChunk {
    pub data: Bytes,
    pub sha256: String,
    pub dirty: bool,
    pub last_accessed: DateTime<Utc>,
}

#[derive(Debug)]
struct Entry {
    chunk: CacheChunk,
    /// Logical access clock; updated under the read lock so readers never serialize.
    tick: AtomicU64,
}

#[derive(Debug, Default)]
struct Inner {
    map: HashMap<ChunkKey, Entry>,
    total_bytes: usize,
}

/// In-memory chunk cache with dirty (write-back) tracking.
///
/// Memory is bounded by both a chunk count and a byte budget: every insert evicts the
/// least recently used *clean* chunks until both limits hold. Dirty chunks are never
/// evicted; when they alone exceed the budget, [`put_chunk_checked`] returns `false`
/// and [`is_over_budget`] is true until the caller flushes them and calls
/// [`mark_clean`].
///
/// [`put_chunk_checked`]: ChunkCacheManager::put_chunk_checked
/// [`is_over_budget`]: ChunkCacheManager::is_over_budget
/// [`mark_clean`]: ChunkCacheManager::mark_clean
#[derive(Debug, Clone)]
pub struct ChunkCacheManager {
    chunk_size: usize,
    max_memory_chunks: usize,
    max_memory_bytes: usize,
    chunks: Arc<RwLock<Inner>>,
    clock: Arc<AtomicU64>,
}

impl Default for ChunkCacheManager {
    fn default() -> Self {
        // 512 chunks of 4MB, but never more than DEFAULT_MAX_MEMORY_BYTES in RAM.
        Self::with_memory_budget(DEFAULT_CHUNK_SIZE, 512, DEFAULT_MAX_MEMORY_BYTES)
    }
}

impl ChunkCacheManager {
    /// Cache bounded to `max_memory_chunks` chunks (byte budget: `chunk_size *
    /// max_memory_chunks`).
    pub fn new(chunk_size: usize, max_memory_chunks: usize) -> Self {
        Self::with_memory_budget(
            chunk_size,
            max_memory_chunks,
            chunk_size.saturating_mul(max_memory_chunks),
        )
    }

    /// Cache bounded to `max_memory_chunks` chunks and `max_memory_bytes` bytes.
    pub fn with_memory_budget(
        chunk_size: usize,
        max_memory_chunks: usize,
        max_memory_bytes: usize,
    ) -> Self {
        Self {
            chunk_size,
            max_memory_chunks,
            max_memory_bytes,
            chunks: Arc::new(RwLock::new(Inner::default())),
            clock: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn chunk_size(&self) -> usize {
        self.chunk_size
    }

    pub fn calculate_chunk_index(&self, offset: u64) -> u64 {
        offset / (self.chunk_size.max(1) as u64)
    }

    fn next_tick(&self) -> u64 {
        self.clock.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub async fn get_chunk(&self, key: &ChunkKey) -> Option<Bytes> {
        let lock = self.chunks.read().await;
        let entry = lock.map.get(key)?;
        entry.tick.store(self.next_tick(), Ordering::Relaxed);
        Some(entry.chunk.data.clone())
    }

    pub async fn put_chunk(&self, key: ChunkKey, data: Bytes, dirty: bool) {
        self.put_chunk_checked(key, data, dirty).await;
    }

    /// Inserts a chunk and evicts least recently used clean chunks until the cache is
    /// within budget. Returns `false` when dirty chunks alone keep it over budget (the
    /// caller should flush them).
    pub async fn put_chunk_checked(&self, key: ChunkKey, data: Bytes, dirty: bool) -> bool {
        let sha256 = format!("{:x}", Sha256::digest(&data));
        let size = data.len();
        let chunk = CacheChunk {
            data,
            sha256,
            dirty,
            last_accessed: Utc::now(),
        };
        let tick = self.next_tick();

        let mut lock = self.chunks.write().await;
        if let Some(old) = lock.map.insert(
            key.clone(),
            Entry {
                chunk,
                tick: AtomicU64::new(tick),
            },
        ) {
            lock.total_bytes = lock.total_bytes.saturating_sub(old.chunk.data.len());
        }
        lock.total_bytes += size;

        while lock.map.len() > self.max_memory_chunks || lock.total_bytes > self.max_memory_bytes
        {
            let victim = lock
                .map
                .iter()
                .filter(|(k, e)| !e.chunk.dirty && **k != key)
                .min_by_key(|(_, e)| e.tick.load(Ordering::Relaxed))
                .map(|(k, _)| k.clone());
            match victim {
                Some(k) => {
                    if let Some(e) = lock.map.remove(&k) {
                        lock.total_bytes = lock.total_bytes.saturating_sub(e.chunk.data.len());
                    }
                }
                None => break,
            }
        }

        // The new chunk itself is clean and still does not fit: do not keep it.
        if !dirty
            && (lock.map.len() > self.max_memory_chunks
                || lock.total_bytes > self.max_memory_bytes)
        {
            if let Some(e) = lock.map.remove(&key) {
                lock.total_bytes = lock.total_bytes.saturating_sub(e.chunk.data.len());
            }
        }

        lock.map.len() <= self.max_memory_chunks && lock.total_bytes <= self.max_memory_bytes
    }

    /// True when dirty chunks keep the cache above its chunk or byte budget.
    pub async fn is_over_budget(&self) -> bool {
        let lock = self.chunks.read().await;
        lock.map.len() > self.max_memory_chunks || lock.total_bytes > self.max_memory_bytes
    }

    /// (number of chunks, bytes) currently held in memory.
    pub async fn memory_usage(&self) -> (usize, usize) {
        let lock = self.chunks.read().await;
        (lock.map.len(), lock.total_bytes)
    }

    pub async fn get_dirty_chunks(&self) -> Vec<(ChunkKey, Bytes)> {
        let lock = self.chunks.read().await;
        lock.map
            .iter()
            .filter(|(_, e)| e.chunk.dirty)
            .map(|(k, e)| (k.clone(), e.chunk.data.clone()))
            .collect()
    }

    pub async fn mark_clean(&self, key: &ChunkKey) {
        let mut lock = self.chunks.write().await;
        if let Some(entry) = lock.map.get_mut(key) {
            entry.chunk.dirty = false;
        }
    }

    pub async fn invalidate_file(&self, connection_id: &str, file_path: &str) {
        let mut lock = self.chunks.write().await;
        let mut freed = 0;
        lock.map.retain(|k, e| {
            let keep = !(k.connection_id == connection_id && k.file_path == file_path);
            if !keep {
                freed += e.chunk.data.len();
            }
            keep
        });
        lock.total_bytes = lock.total_bytes.saturating_sub(freed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_chunk_cache_put_get() {
        let manager = ChunkCacheManager::new(1024, 10);
        let key = ChunkKey::new("sftp-1", "/var/log/app.log", 0);
        let data = Bytes::from_static(b"Log entry line 1... line 2...");

        // Miss
        assert!(manager.get_chunk(&key).await.is_none());

        // Put clean chunk
        manager.put_chunk(key.clone(), data.clone(), false).await;

        // Hit
        let retrieved = manager.get_chunk(&key).await.unwrap();
        assert_eq!(retrieved, data);

        // Put dirty chunk (write-back)
        let key2 = ChunkKey::new("sftp-1", "/var/log/app.log", 1);
        let data2 = Bytes::from_static(b"New unsaved buffer data");
        manager.put_chunk(key2.clone(), data2.clone(), true).await;

        let dirty = manager.get_dirty_chunks().await;
        assert_eq!(dirty.len(), 1);
        assert_eq!(dirty[0].0, key2);

        // Mark clean
        manager.mark_clean(&key2).await;
        let dirty_after = manager.get_dirty_chunks().await;
        assert!(dirty_after.is_empty());
    }

    fn key(i: u64) -> ChunkKey {
        ChunkKey::new("c", "/f", i)
    }

    #[tokio::test]
    async fn test_eviction_keeps_count_and_bytes_bounded_lru() {
        let m = ChunkCacheManager::with_memory_budget(10, 100, 30);
        for i in 0..3 {
            m.put_chunk(key(i), Bytes::from(vec![0u8; 10]), false).await;
        }
        // Touch chunk 0 so chunk 1 is the least recently used.
        assert!(m.get_chunk(&key(0)).await.is_some());
        assert!(m.put_chunk_checked(key(3), Bytes::from(vec![0u8; 10]), false).await);
        assert!(m.get_chunk(&key(1)).await.is_none());
        assert!(m.get_chunk(&key(0)).await.is_some());
        assert_eq!(m.memory_usage().await, (3, 30));

        // Many inserts never exceed the count limit either.
        let m = ChunkCacheManager::new(4, 5);
        for i in 0..50 {
            m.put_chunk(key(i), Bytes::from(vec![1u8; 4]), false).await;
        }
        assert_eq!(m.memory_usage().await, (5, 20));
    }

    #[tokio::test]
    async fn test_dirty_chunks_are_never_evicted_and_report_over_budget() {
        let m = ChunkCacheManager::with_memory_budget(10, 100, 20);
        assert!(m.put_chunk_checked(key(0), Bytes::from(vec![0u8; 10]), true).await);
        assert!(m.put_chunk_checked(key(1), Bytes::from(vec![0u8; 10]), true).await);
        assert!(!m.put_chunk_checked(key(2), Bytes::from(vec![0u8; 10]), true).await);
        assert!(m.is_over_budget().await);
        assert_eq!(m.get_dirty_chunks().await.len(), 3);

        // A clean chunk that does not fit is not kept.
        m.put_chunk(key(9), Bytes::from(vec![0u8; 10]), false).await;
        assert!(m.get_chunk(&key(9)).await.is_none());

        // After flushing, clean chunks become evictable again.
        for i in 0..3 {
            m.mark_clean(&key(i)).await;
        }
        m.put_chunk(key(3), Bytes::from(vec![0u8; 10]), false).await;
        assert!(!m.is_over_budget().await);
        assert_eq!(m.memory_usage().await.1, 20);

        m.invalidate_file("c", "/f").await;
        assert_eq!(m.memory_usage().await, (0, 0));
    }
}

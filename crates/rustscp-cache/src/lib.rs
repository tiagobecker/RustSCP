use bytes::Bytes;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

pub const DEFAULT_CHUNK_SIZE: usize = 4 * 1024 * 1024; // 4MB

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

#[derive(Debug, Clone)]
pub struct ChunkCacheManager {
    chunk_size: usize,
    max_memory_chunks: usize,
    chunks: Arc<RwLock<HashMap<ChunkKey, CacheChunk>>>,
}

impl Default for ChunkCacheManager {
    fn default() -> Self {
        Self::new(DEFAULT_CHUNK_SIZE, 512) // 512 chunks of 4MB = 2GB max RAM buffer
    }
}

impl ChunkCacheManager {
    pub fn new(chunk_size: usize, max_memory_chunks: usize) -> Self {
        Self {
            chunk_size,
            max_memory_chunks,
            chunks: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn chunk_size(&self) -> usize {
        self.chunk_size
    }

    pub fn calculate_chunk_index(&self, offset: u64) -> u64 {
        offset / (self.chunk_size as u64)
    }

    pub async fn get_chunk(&self, key: &ChunkKey) -> Option<Bytes> {
        let mut lock = self.chunks.write().await;
        if let Some(chunk) = lock.get_mut(key) {
            chunk.last_accessed = Utc::now();
            Some(chunk.data.clone())
        } else {
            None
        }
    }

    pub async fn put_chunk(&self, key: ChunkKey, data: Bytes, dirty: bool) {
        let mut hasher = Sha256::new();
        hasher.update(&data);
        let sha256 = format!("{:x}", hasher.finalize());

        let chunk = CacheChunk {
            data,
            sha256,
            dirty,
            last_accessed: Utc::now(),
        };

        let mut lock = self.chunks.write().await;
        // Eviction policy: if over capacity, remove non-dirty oldest chunk
        if lock.len() >= self.max_memory_chunks && !lock.contains_key(&key) {
            let oldest_clean_key = lock
                .iter()
                .filter(|(_, c)| !c.dirty)
                .min_by_key(|(_, c)| c.last_accessed)
                .map(|(k, _)| k.clone());

            if let Some(k) = oldest_clean_key {
                lock.remove(&k);
            }
        }

        lock.insert(key, chunk);
    }

    pub async fn get_dirty_chunks(&self) -> Vec<(ChunkKey, Bytes)> {
        let lock = self.chunks.read().await;
        lock.iter()
            .filter(|(_, c)| c.dirty)
            .map(|(k, c)| (k.clone(), c.data.clone()))
            .collect()
    }

    pub async fn mark_clean(&self, key: &ChunkKey) {
        let mut lock = self.chunks.write().await;
        if let Some(chunk) = lock.get_mut(key) {
            chunk.dirty = false;
        }
    }

    pub async fn invalidate_file(&self, connection_id: &str, file_path: &str) {
        let mut lock = self.chunks.write().await;
        lock.retain(|k, _| !(k.connection_id == connection_id && k.file_path == file_path));
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
}

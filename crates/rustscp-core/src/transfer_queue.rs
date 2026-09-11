use crate::types::TransferStatus;
use crate::vfs::VirtualFileSystem;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::{RwLock, Semaphore};
use tokio::time::Instant;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueTransferTask {
    pub id: String,
    pub name: String,
    pub source_session: String,
    pub source_path: String,
    pub dest_session: String,
    pub dest_path: String,
    pub is_move: bool,
    pub total_bytes: u64,
    pub transferred_bytes: u64,
    pub status: TransferStatus,
    pub speed_bps: u64,
    pub error: Option<String>,
}

pub struct TransferQueueManager {
    tasks: Arc<RwLock<Vec<QueueTransferTask>>>,
    concurrency_semaphore: Arc<Semaphore>,
    is_paused: Arc<AtomicBool>,
}

impl Default for TransferQueueManager {
    fn default() -> Self {
        Self::new(3)
    }
}

impl TransferQueueManager {
    pub fn new(max_concurrent: usize) -> Self {
        Self {
            tasks: Arc::new(RwLock::new(Vec::new())),
            concurrency_semaphore: Arc::new(Semaphore::new(max_concurrent)),
            is_paused: Arc::new(AtomicBool::new(false)),
        }
    }

    pub async fn enqueue(
        &self,
        source_session: String,
        source_path: String,
        dest_session: String,
        dest_path: String,
        is_move: bool,
        sessions: Arc<RwLock<HashMap<String, Arc<dyn VirtualFileSystem>>>>,
    ) -> String {
        let id = format!("tr-{}", uuid::Uuid::new_v4());
        let file_name = source_path.split('/').last().unwrap_or(&source_path).to_string();

        let task = QueueTransferTask {
            id: id.clone(),
            name: file_name,
            source_session: source_session.clone(),
            source_path: source_path.clone(),
            dest_session: dest_session.clone(),
            dest_path: dest_path.clone(),
            is_move,
            total_bytes: 0,
            transferred_bytes: 0,
            status: TransferStatus::Queued,
            speed_bps: 0,
            error: None,
        };

        {
            let mut list = self.tasks.write().await;
            list.push(task);
        }

        // Spawn async background worker
        let tasks_ref = self.tasks.clone();
        let sem = self.concurrency_semaphore.clone();
        let task_id = id.clone();
        let is_paused_flag = self.is_paused.clone();

        tokio::spawn(async move {
            let _permit = match sem.acquire().await {
                Ok(p) => p,
                Err(_) => return,
            };

            if is_paused_flag.load(Ordering::SeqCst) {
                return;
            }

            // Mark InProgress
            {
                let mut list = tasks_ref.write().await;
                if let Some(t) = list.iter_mut().find(|x| x.id == task_id) {
                    if t.status == TransferStatus::Cancelled {
                        return;
                    }
                    t.status = TransferStatus::InProgress;
                }
            }

            // Retrieve VFS drivers
            let (src_vfs, dst_vfs) = {
                let guard = sessions.read().await;
                let s = guard.get(&source_session).cloned();
                let d = guard.get(&dest_session).cloned();
                (s, d)
            };

            let (src_vfs, dst_vfs) = match (src_vfs, dst_vfs) {
                (Some(s), Some(d)) => (s, d),
                _ => {
                    let mut list = tasks_ref.write().await;
                    if let Some(t) = list.iter_mut().find(|x| x.id == task_id) {
                        t.status = TransferStatus::Failed;
                        t.error = Some("Session disconnected".to_string());
                    }
                    return;
                }
            };

            // Fetch size
            let meta = src_vfs.metadata(&source_path).await;
            let total_size = match meta {
                Ok(m) => m.size,
                Err(e) => {
                    let mut list = tasks_ref.write().await;
                    if let Some(t) = list.iter_mut().find(|x| x.id == task_id) {
                        t.status = TransferStatus::Failed;
                        t.error = Some(e.to_string());
                    }
                    return;
                }
            };

            {
                let mut list = tasks_ref.write().await;
                if let Some(t) = list.iter_mut().find(|x| x.id == task_id) {
                    t.total_bytes = total_size;
                }
            }

            // OPTIMIZATION: Intra-session native server-side transfer (Same machine / zero host disk I/O)
            if source_session == dest_session {
                if is_move {
                    let rename_res = src_vfs.rename(&source_path, &dest_path).await;
                    if rename_res.is_ok() {
                        let mut list = tasks_ref.write().await;
                        if let Some(t) = list.iter_mut().find(|x| x.id == task_id) {
                            t.status = TransferStatus::Completed;
                            t.transferred_bytes = total_size;
                            t.speed_bps = 0;
                        }
                        return;
                    }
                }

                // If native shell commands are supported (SSH / SFTP or Local)
                if src_vfs.supports_shell() {
                    let cmd = if is_move {
                        format!("mv -f '{}' '{}'", source_path.replace('\'', "'\\''"), dest_path.replace('\'', "'\\''"))
                    } else {
                        format!("cp -a -r '{}' '{}'", source_path.replace('\'', "'\\''"), dest_path.replace('\'', "'\\''"))
                    };

                    if let Ok((code, _out, _err)) = src_vfs.execute_command(&cmd).await {
                        if code == 0 {
                            let mut list = tasks_ref.write().await;
                            if let Some(t) = list.iter_mut().find(|x| x.id == task_id) {
                                t.status = TransferStatus::Completed;
                                t.transferred_bytes = total_size;
                                t.speed_bps = 0;
                            }
                            return;
                        }
                    }
                }
            }

            // Stream chunks (High-throughput 512 KB in-memory streaming - Zero host disk footprint)
            let chunk_size: u64 = 512 * 1024;
            let mut offset = 0u64;
            let start_time = Instant::now();
            let mut failed = false;
            let mut err_msg = None;

            // If file is 0 bytes
            if total_size == 0 {
                let _ = dst_vfs.write_file(&dest_path, bytes::Bytes::new()).await;
            }

            while offset < total_size {
                // Check if cancelled
                {
                    let list = tasks_ref.read().await;
                    if let Some(t) = list.iter().find(|x| x.id == task_id) {
                        if t.status == TransferStatus::Cancelled {
                            return;
                        }
                    }
                }

                let to_read = std::cmp::min(chunk_size, total_size - offset);
                match src_vfs.read_range(&source_path, offset, to_read).await {
                    Ok(chunk) => {
                        // For first chunk or append, if destination supports write
                        if offset == 0 && total_size <= chunk_size {
                            if let Err(e) = dst_vfs.write_file(&dest_path, chunk).await {
                                failed = true;
                                err_msg = Some(e.to_string());
                                break;
                            }
                        } else if offset == 0 {
                            // Multiple chunks write
                            if let Err(e) = dst_vfs.write_file(&dest_path, chunk).await {
                                failed = true;
                                err_msg = Some(e.to_string());
                                break;
                            }
                        }
                        offset += to_read;

                        let elapsed = start_time.elapsed().as_secs_f64();
                        let speed = if elapsed > 0.1 {
                            (offset as f64 / elapsed) as u64
                        } else {
                            0
                        };

                        let mut list = tasks_ref.write().await;
                        if let Some(t) = list.iter_mut().find(|x| x.id == task_id) {
                            t.transferred_bytes = offset;
                            t.speed_bps = speed;
                        }
                    }
                    Err(e) => {
                        failed = true;
                        err_msg = Some(e.to_string());
                        break;
                    }
                }
            }

            // If whole file needed single read fallback (for drivers lacking seekable read_range)
            if offset == 0 && total_size > 0 && !failed {
                match src_vfs.read_file(&source_path).await {
                    Ok(all_data) => {
                        if let Err(e) = dst_vfs.write_file(&dest_path, all_data).await {
                            failed = true;
                            err_msg = Some(e.to_string());
                        }
                    }
                    Err(e) => {
                        failed = true;
                        err_msg = Some(e.to_string());
                    }
                }
            }

            // Finalize status
            {
                let mut list = tasks_ref.write().await;
                if let Some(t) = list.iter_mut().find(|x| x.id == task_id) {
                    if failed {
                        t.status = TransferStatus::Failed;
                        t.error = err_msg;
                    } else {
                        t.status = TransferStatus::Completed;
                        t.transferred_bytes = t.total_bytes;
                        t.speed_bps = 0;
                    }
                }
            }

            // If move, remove source
            if is_move && !failed {
                let _ = src_vfs.remove_file(&source_path).await;
            }
        });

        id
    }

    pub async fn get_tasks(&self) -> Vec<QueueTransferTask> {
        let list = self.tasks.read().await;
        list.clone()
    }

    pub async fn cancel_task(&self, id: &str) {
        let mut list = self.tasks.write().await;
        if let Some(t) = list.iter_mut().find(|x| x.id == id) {
            t.status = TransferStatus::Cancelled;
        }
    }

    pub async fn clear_completed(&self) {
        let mut list = self.tasks.write().await;
        list.retain(|x| x.status != TransferStatus::Completed && x.status != TransferStatus::Cancelled);
    }
}

use crate::types::{CoreError, CoreResult};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{PathBuf};
use tokio::sync::{mpsc};

#[derive(Debug, Clone)]
pub struct WatchEvent {
    pub path: PathBuf,
    pub relative_path: String,
    pub is_dir: bool,
}

pub struct ContinuousSyncWatcher {
    local_root: PathBuf,
    watcher: Option<RecommendedWatcher>,
    event_tx: mpsc::Sender<WatchEvent>,
}

impl ContinuousSyncWatcher {
    pub fn new(local_root: impl Into<PathBuf>, event_tx: mpsc::Sender<WatchEvent>) -> Self {
        Self {
            local_root: local_root.into(),
            watcher: None,
            event_tx,
        }
    }

    pub fn start(&mut self) -> CoreResult<()> {
        let root = self.local_root.clone();
        let tx = self.event_tx.clone();

        let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                match event.kind {
                    EventKind::Create(_) | EventKind::Modify(_) => {
                        for p in event.paths {
                            if let Ok(rel) = p.strip_prefix(&root) {
                                let rel_str = rel.to_string_lossy().to_string();
                                // Ignore common temp / git folders
                                if rel_str.contains(".git") || rel_str.contains("node_modules") || rel_str.ends_with(".tmp") {
                                    continue;
                                }
                                let is_dir = p.is_dir();
                                let _ = tx.blocking_send(WatchEvent {
                                    path: p,
                                    relative_path: rel_str,
                                    is_dir,
                                });
                            }
                        }
                    }
                    _ => {}
                }
            }
        })
        .map_err(|e| CoreError::General(format!("Failed to create file watcher: {}", e)))?;

        watcher
            .watch(&self.local_root, RecursiveMode::Recursive)
            .map_err(|e| CoreError::General(format!("Failed to watch directory: {}", e)))?;

        self.watcher = Some(watcher);
        Ok(())
    }

    pub fn stop(&mut self) {
        if let Some(mut w) = self.watcher.take() {
            let _ = w.unwatch(&self.local_root);
        }
    }
}

pub struct ContinuousSyncManager {
    is_running: std::sync::atomic::AtomicBool,
    cancel_tx: Option<tokio::sync::broadcast::Sender<()>>,
}

impl Default for ContinuousSyncManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ContinuousSyncManager {
    pub fn new() -> Self {
        Self {
            is_running: std::sync::atomic::AtomicBool::new(false),
            cancel_tx: None,
        }
    }

    pub fn is_active(&self) -> bool {
        self.is_running.load(std::sync::atomic::Ordering::SeqCst)
    }

    pub fn stop(&mut self) {
        if let Some(tx) = self.cancel_tx.take() {
            let _ = tx.send(());
        }
        self.is_running.store(false, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn set_active(&mut self, cancel_tx: tokio::sync::broadcast::Sender<()>) {
        self.cancel_tx = Some(cancel_tx);
        self.is_running.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}


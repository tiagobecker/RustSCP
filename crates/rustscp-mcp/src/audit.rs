use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};
use uuid::Uuid;

/// Events kept in memory (oldest dropped first).
pub const MAX_IN_MEMORY_EVENTS: usize = 1000;
/// Size at which the on-disk audit log is rotated to `<file>.1`.
pub const MAX_LOG_FILE_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEvent {
    pub id: String,
    pub timestamp: DateTime<Utc>,
    pub agent_id: String,
    pub tool_name: String,
    pub connection_id: String,
    pub parameters_summary: String,
    pub status: String,
    pub diff: Option<String>,
}

/// Notified of every event as it is logged, so the app can show agent activity live (not
/// only on the next poll). Called from the logging task; it must not block.
pub type AuditObserver = Arc<dyn Fn(&AuditEvent) + Send + Sync>;

#[derive(Clone, Default)]
pub struct AuditLogger {
    events: Arc<RwLock<VecDeque<AuditEvent>>>,
    /// Optional append-only JSON-lines file (0600) that survives restarts.
    log_file: Option<Arc<PathBuf>>,
    file_lock: Arc<Mutex<()>>,
    /// Set by the app to mirror each event to the window as it happens.
    observer: Arc<std::sync::RwLock<Option<AuditObserver>>>,
}

impl std::fmt::Debug for AuditLogger {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuditLogger")
            .field("log_file", &self.log_file)
            .finish_non_exhaustive()
    }
}

impl AuditLogger {
    /// In-memory audit log (last [`MAX_IN_MEMORY_EVENTS`] events).
    pub fn new() -> Self {
        Self::default()
    }

    /// Audit log that also appends every event as one JSON line to `path` (created 0600
    /// on Unix, rotated to `<path>.1` at [`MAX_LOG_FILE_BYTES`]).
    pub fn with_log_file(path: impl Into<PathBuf>) -> Self {
        Self {
            log_file: Some(Arc::new(path.into())),
            ..Self::default()
        }
    }

    /// Path of the persistent log, when one is configured.
    pub fn log_file_path(&self) -> Option<&PathBuf> {
        self.log_file.as_deref()
    }

    /// Mirrors every event to `observer` as it is logged (the app emits it to the window).
    pub fn set_observer(&self, observer: AuditObserver) {
        match self.observer.write() {
            Ok(mut o) => *o = Some(observer),
            Err(e) => *e.into_inner() = Some(observer),
        }
    }

    pub async fn log(
        &self,
        agent_id: &str,
        tool_name: &str,
        connection_id: &str,
        parameters_summary: &str,
        status: &str,
        diff: Option<String>,
    ) {
        let event = AuditEvent {
            id: Uuid::new_v4().to_string(),
            timestamp: Utc::now(),
            agent_id: agent_id.to_string(),
            tool_name: tool_name.to_string(),
            connection_id: connection_id.to_string(),
            parameters_summary: parameters_summary.to_string(),
            status: status.to_string(),
            diff,
        };

        if let Some(path) = &self.log_file {
            if let Err(e) = self.append_to_file(path, &event).await {
                tracing::warn!("could not write MCP audit log {}: {e}", path.display());
            }
        }

        // Show it in the window right away (before the next poll), if the app is watching.
        let observer = match self.observer.read() {
            Ok(o) => o.clone(),
            Err(e) => e.into_inner().clone(),
        };
        if let Some(observer) = observer {
            observer(&event);
        }

        let mut lock = self.events.write().await;
        lock.push_back(event);
        while lock.len() > MAX_IN_MEMORY_EVENTS {
            lock.pop_front();
        }
    }

    async fn append_to_file(
        &self,
        path: &std::path::Path,
        event: &AuditEvent,
    ) -> std::io::Result<()> {
        use tokio::io::AsyncWriteExt;
        let _guard = self.file_lock.lock().await;
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                tokio::fs::create_dir_all(parent).await?;
            }
        }
        if let Ok(meta) = tokio::fs::metadata(path).await {
            if meta.len() >= MAX_LOG_FILE_BYTES {
                let mut rotated = path.as_os_str().to_owned();
                rotated.push(".1");
                tokio::fs::rename(path, PathBuf::from(rotated)).await?;
            }
        }
        let mut opts = tokio::fs::OpenOptions::new();
        opts.create(true).append(true);
        #[cfg(unix)]
        opts.mode(0o600);
        let mut file = opts.open(path).await?;
        let mut line = serde_json::to_string(event).map_err(std::io::Error::other)?;
        line.push('\n');
        file.write_all(line.as_bytes()).await?;
        file.flush().await
    }

    pub async fn get_recent_events(&self, limit: usize) -> Vec<AuditEvent> {
        let lock = self.events.read().await;
        lock.iter().rev().take(limit).cloned().collect()
    }

    /// Number of events currently held in memory.
    pub async fn event_count(&self) -> usize {
        self.events.read().await.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_ring_buffer_keeps_latest_events() {
        let logger = AuditLogger::new();
        for i in 0..(MAX_IN_MEMORY_EVENTS + 5) {
            logger
                .log("a", "t", "c", &i.to_string(), "success", None)
                .await;
        }
        assert_eq!(logger.event_count().await, MAX_IN_MEMORY_EVENTS);
        let recent = logger.get_recent_events(1).await;
        assert_eq!(
            recent[0].parameters_summary,
            (MAX_IN_MEMORY_EVENTS + 4).to_string()
        );
    }

    #[tokio::test]
    async fn test_events_are_persisted_as_private_json_lines() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audit").join("mcp-audit.log");
        let logger = AuditLogger::with_log_file(&path);
        logger
            .log(
                "agent",
                "fs_read_file",
                "local",
                "/etc/hosts",
                "success",
                None,
            )
            .await;
        logger
            .log(
                "agent",
                "fs_write_file",
                "local",
                "/tmp/x",
                "error: denied",
                None,
            )
            .await;

        let text = tokio::fs::read_to_string(&path).await.unwrap();
        let lines: Vec<AuditEvent> = text
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[1].status, "error: denied");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }
}

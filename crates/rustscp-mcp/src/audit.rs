use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::RwLock;
use uuid::Uuid;

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

#[derive(Debug, Clone, Default)]
pub struct AuditLogger {
    events: Arc<RwLock<Vec<AuditEvent>>>,
}

impl AuditLogger {
    pub fn new() -> Self {
        Self {
            events: Arc::new(RwLock::new(Vec::new())),
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

        let mut lock = self.events.write().await;
        lock.push(event);
        // Keep in-memory ring buffer of last 1000 events
        if lock.len() > 1000 {
            lock.remove(0);
        }
    }

    pub async fn get_recent_events(&self, limit: usize) -> Vec<AuditEvent> {
        let lock = self.events.read().await;
        lock.iter().rev().take(limit).cloned().collect()
    }
}

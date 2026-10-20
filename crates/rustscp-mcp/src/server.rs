use crate::audit::AuditLogger;
use crate::protocol::{JsonRpcResponse, McpContent, McpToolDefinition, McpToolResult};
use crate::rpc::{RpcSession, ToolBackend};
use async_trait::async_trait;
use bytes::Bytes;
use rustscp_actions::{ActionCatalog, ActionContext, ActionExecutor};
use rustscp_core::VirtualFileSystem;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

/// An MCP stdio transport ships with this build: `rustscp-desktop --mcp-stdio` (or the
/// `rustscp-mcp` binary) serves MCP on stdin/stdout and forwards tool calls to the
/// running app through [`crate::gateway`].
pub const MCP_TRANSPORT_AVAILABLE: bool = true;
/// MCP protocol revisions this server answers with (latest last).
pub const SUPPORTED_PROTOCOL_VERSIONS: &[&str] = &["2024-11-05", "2025-03-26", "2025-06-18"];
/// Agent id used by [`McpServer::handle_rpc`], which has no authenticated transport.
pub const DEFAULT_AGENT_ID: &str = "ai-agent";
/// Default and maximum number of bytes `fs_read_file` returns per call.
pub const DEFAULT_READ_BYTES: u64 = 65_536;
pub const MAX_READ_BYTES: u64 = 1024 * 1024;
/// Previous file contents up to this size are hashed for the write audit trail.
const MAX_HASHED_PREVIOUS_BYTES: u64 = 8 * 1024 * 1024;
/// Start of the new content shown to the person approving a write.
pub const APPROVAL_PREVIEW_BYTES: usize = 4096;
/// Audit status of a write whose call ended while it waited for approval.
const WITHDRAWN_STATUS: &str = "withdrawn: the agent cancelled or disconnected";

/// Tools that change data; each call waits for a person's approval (see [`ToolApprover`]).
pub fn tool_requires_approval(tool_name: &str) -> bool {
    matches!(tool_name, "fs_write_file")
}

/// What an agent sees about a registered connection. Never holds credentials.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ConnectionInfo {
    /// Display name (saved-site name).
    pub name: String,
    /// "sftp", "s3", "ftp", ...
    pub protocol: String,
    pub host: String,
}

/// A change an agent asked for, shown to the person who allows or denies it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalRequest {
    pub agent_id: String,
    pub tool_name: String,
    pub connection_id: String,
    pub connection_name: String,
    pub path: String,
    /// One-line description of the change.
    pub summary: String,
    pub new_size: u64,
    pub new_sha256: String,
    /// Size of the file being replaced (`None` for a new file).
    pub previous_size: Option<u64>,
    /// Start of the new content when it is UTF-8 text (at most [`APPROVAL_PREVIEW_BYTES`]).
    pub preview: Option<String>,
    pub preview_truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApprovalDecision {
    Approved,
    /// Denied, with the reason recorded in the audit log and told to the agent.
    Denied(String),
}

/// Asks a person whether a write may happen (the desktop app shows a dialog). Without an
/// approver every write is denied.
#[async_trait]
pub trait ToolApprover: Send + Sync {
    async fn approve(&self, request: ApprovalRequest) -> ApprovalDecision;
}

struct RegisteredConnection {
    info: ConnectionInfo,
    vfs: Arc<dyn VirtualFileSystem>,
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            B64[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

fn base64_decode(text: &str) -> Result<Vec<u8>, String> {
    let clean: Vec<u8> = text.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    if !clean.len().is_multiple_of(4) {
        return Err("base64 length must be a multiple of 4".into());
    }
    let val = |c: u8| -> Result<u32, String> {
        match c {
            b'A'..=b'Z' => Ok((c - b'A') as u32),
            b'a'..=b'z' => Ok((c - b'a' + 26) as u32),
            b'0'..=b'9' => Ok((c - b'0' + 52) as u32),
            b'+' | b'-' => Ok(62),
            b'/' | b'_' => Ok(63),
            _ => Err(format!("invalid base64 character '{}'", c as char)),
        }
    };
    let mut out = Vec::with_capacity(clean.len() / 4 * 3);
    let quads = clean.len() / 4;
    for (i, q) in clean.chunks(4).enumerate() {
        let pad = q.iter().rev().take_while(|&&c| c == b'=').count();
        if pad > 2 || (pad > 0 && i + 1 != quads) || q[..4 - pad].contains(&b'=') {
            return Err("invalid base64 padding".into());
        }
        let mut n = 0u32;
        for &c in &q[..4 - pad] {
            n = (n << 6) | val(c)?;
        }
        n <<= 6 * pad as u32;
        out.push((n >> 16) as u8);
        if pad < 2 {
            out.push((n >> 8) as u8);
        }
        if pad < 1 {
            out.push(n as u8);
        }
    }
    Ok(out)
}

/// Text for the agent: UTF-8 when the bytes are text (an incomplete character at the end
/// of a truncated chunk is held back), base64 otherwise. Returns (content, encoding,
/// number of bytes represented).
fn encode_for_agent(bytes: &[u8], truncated: bool) -> (String, &'static str, usize) {
    if !bytes.contains(&0) {
        match std::str::from_utf8(bytes) {
            Ok(s) => return (s.to_string(), "utf-8", bytes.len()),
            Err(e) if e.error_len().is_none() && truncated && e.valid_up_to() > 0 => {
                let valid = e.valid_up_to();
                let s = std::str::from_utf8(&bytes[..valid]).unwrap_or_default();
                return (s.to_string(), "utf-8", valid);
            }
            Err(_) => {}
        }
    }
    (base64_encode(bytes), "base64", bytes.len())
}

/// What the person approving an `fs_write_file` call is shown.
#[allow(clippy::too_many_arguments)]
fn write_approval_request(
    agent_id: &str,
    tool_name: &str,
    conn_id: &str,
    info: &ConnectionInfo,
    path: &str,
    data: &[u8],
    new_sha256: &str,
    previous_size: Option<u64>,
) -> ApprovalRequest {
    let head = &data[..data.len().min(APPROVAL_PREVIEW_BYTES)];
    let truncated = head.len() < data.len();
    let (text, encoding, used) = encode_for_agent(head, truncated);
    let preview = (encoding == "utf-8").then_some(text);
    let summary = match previous_size {
        Some(old) => format!("Replace {path} ({old} bytes) with {} bytes", data.len()),
        None => format!("Create {path} ({} bytes)", data.len()),
    };
    let connection_name = if info.name.is_empty() {
        conn_id.to_string()
    } else {
        info.name.clone()
    };
    ApprovalRequest {
        agent_id: agent_id.to_string(),
        tool_name: tool_name.to_string(),
        connection_id: conn_id.to_string(),
        connection_name,
        path: path.to_string(),
        summary,
        new_size: data.len() as u64,
        new_sha256: new_sha256.to_string(),
        previous_size,
        preview_truncated: preview.is_some() && used < data.len(),
        preview,
    }
}

/// Performs an approved write: records what it replaces (size and SHA-256), writes, and
/// audits the outcome.
#[allow(clippy::too_many_arguments)]
async fn write_and_audit(
    audit: AuditLogger,
    vfs: Arc<dyn VirtualFileSystem>,
    agent_id: String,
    tool_name: String,
    conn_id: String,
    path: String,
    data: Vec<u8>,
    new_sha256: String,
) -> McpToolResult {
    let previous = match vfs.metadata(&path).await {
        Ok(meta) if meta.is_dir() => {
            audit
                .log(
                    &agent_id,
                    &tool_name,
                    &conn_id,
                    &path,
                    "error: is a directory",
                    None,
                )
                .await;
            return McpToolResult::error_text(format!("{} is a directory", path));
        }
        Ok(meta) if meta.size <= MAX_HASHED_PREVIOUS_BYTES => match vfs.read_file(&path).await {
            Ok(old) => format!(
                "previous: {} bytes sha256={}",
                old.len(),
                rustscp_core::disk_cache::sha256_hex(&old)
            ),
            Err(_) => format!("previous: {} bytes", meta.size),
        },
        Ok(meta) => format!("previous: {} bytes (not hashed)", meta.size),
        Err(_) => "previous: none (new file)".to_string(),
    };
    let len = data.len();
    let diff = format!("{previous}; new: {len} bytes sha256={new_sha256}");

    match vfs.write_file(&path, Bytes::from(data)).await {
        Ok(_) => {
            audit
                .log(
                    &agent_id,
                    &tool_name,
                    &conn_id,
                    &path,
                    "success",
                    Some(diff),
                )
                .await;
            McpToolResult::success_text(format!(
                "File written successfully: {} ({} bytes)",
                path, len
            ))
        }
        Err(err) => {
            audit
                .log(
                    &agent_id,
                    &tool_name,
                    &conn_id,
                    &path,
                    &format!("error: {}", err),
                    Some(diff),
                )
                .await;
            McpToolResult::error_text(format!("Failed to write file: {}", err))
        }
    }
}

/// Audits a write as withdrawn when its call is dropped while waiting for approval (the
/// agent cancelled or disconnected, or the gateway was turned off). Disarmed once the
/// approver answers, so every write keeps a single entry.
struct WithdrawnWriteAudit {
    audit: AuditLogger,
    agent_id: String,
    tool_name: String,
    conn_id: String,
    path: String,
    diff: String,
    answered: bool,
}

impl Drop for WithdrawnWriteAudit {
    fn drop(&mut self) {
        if self.answered {
            return;
        }
        // `Drop` cannot await, so the entry is written by a task on the caller's runtime.
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            tracing::warn!(
                "MCP write to {} was withdrawn with no runtime to audit it",
                self.path
            );
            return;
        };
        let audit = self.audit.clone();
        let agent_id = std::mem::take(&mut self.agent_id);
        let tool_name = std::mem::take(&mut self.tool_name);
        let conn_id = std::mem::take(&mut self.conn_id);
        let path = std::mem::take(&mut self.path);
        let diff = std::mem::take(&mut self.diff);
        runtime.spawn(async move {
            audit
                .log(
                    &agent_id,
                    &tool_name,
                    &conn_id,
                    &path,
                    WITHDRAWN_STATUS,
                    Some(diff),
                )
                .await;
        });
    }
}

pub struct McpServer {
    audit_logger: AuditLogger,
    /// Sessions agents may use: id -> driver and display info. Starts empty: the
    /// unrestricted local filesystem is never registered by default.
    connections: Arc<RwLock<HashMap<String, RegisteredConnection>>>,
    approver: std::sync::RwLock<Option<Arc<dyn ToolApprover>>>,
}

impl McpServer {
    pub fn new(audit_logger: AuditLogger) -> Self {
        Self {
            audit_logger,
            connections: Arc::new(RwLock::new(HashMap::new())),
            approver: std::sync::RwLock::new(None),
        }
    }

    pub fn audit_logger(&self) -> &AuditLogger {
        &self.audit_logger
    }

    /// Whether an external MCP client can currently reach this server.
    pub fn transport_available(&self) -> bool {
        MCP_TRANSPORT_AVAILABLE
    }

    /// Sets who approves write tools. Until one is set every write is denied.
    pub fn set_approver(&self, approver: Arc<dyn ToolApprover>) {
        match self.approver.write() {
            Ok(mut a) => *a = Some(approver),
            Err(e) => *e.into_inner() = Some(approver),
        }
    }

    fn current_approver(&self) -> Option<Arc<dyn ToolApprover>> {
        match self.approver.read() {
            Ok(a) => a.clone(),
            Err(e) => e.into_inner().clone(),
        }
    }

    /// Registers a session under `id` with the id as its display name.
    pub async fn register_connection(&self, id: String, vfs: Arc<dyn VirtualFileSystem>) {
        let info = ConnectionInfo {
            name: id.clone(),
            ..ConnectionInfo::default()
        };
        self.register_session(id, info, vfs).await;
    }

    /// Makes a connected session available to agents under `id`.
    pub async fn register_session(
        &self,
        id: String,
        info: ConnectionInfo,
        vfs: Arc<dyn VirtualFileSystem>,
    ) {
        let mut conns = self.connections.write().await;
        conns.insert(id, RegisteredConnection { info, vfs });
    }

    /// Removes a connection (call it when the session is disconnected) so agents can no
    /// longer reach it and its driver can be dropped. Returns whether it was registered.
    pub async fn unregister_connection(&self, id: &str) -> bool {
        self.connections.write().await.remove(id).is_some()
    }

    /// Ids of the registered connections.
    pub async fn connection_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.connections.read().await.keys().cloned().collect();
        ids.sort();
        ids
    }

    /// Tools announced to agents.
    pub fn list_tools(&self) -> Vec<McpToolDefinition> {
        Self::tool_definitions()
    }

    /// Tool definitions (static; the bridge serves `tools/list` without the app).
    pub fn tool_definitions() -> Vec<McpToolDefinition> {
        let read_only = |title: &str| {
            Some(json!({ "title": title, "readOnlyHint": true, "destructiveHint": false }))
        };
        let smart_action_schema = json!({
            "type": "object",
            "required": ["connection_id", "action_id", "params"],
            "properties": {
                "connection_id": { "type": "string", "description": "Session ID" },
                "action_id": { "type": "string", "description": "Action ID (e.g. 'tar-compress', 'disk-usage')" },
                "current_dir": { "type": "string", "description": "Working directory" },
                "selected_paths": { "type": "array", "items": { "type": "string" } },
                "params": { "type": "object", "description": "Key-value arguments matching the action schema" }
            }
        });
        vec![
            McpToolDefinition {
                name: "session_list".to_string(),
                description: "List the server sessions connected in the RustSCP app (connection_id, name, protocol, host). Credentials are never exposed. Call this first: the other tools take one of these connection_id values.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {}
                }),
                annotations: read_only("List connected sessions"),
            },
            McpToolDefinition {
                name: "fs_list_dir".to_string(),
                description: "List directory contents from an active connection".to_string(),
                input_schema: json!({
                    "type": "object",
                    "required": ["connection_id", "path"],
                    "properties": {
                        "connection_id": { "type": "string", "description": "Session ID from session_list (e.g. 'prod-vps')" },
                        "path": { "type": "string", "description": "Remote directory path to list" }
                    }
                }),
                annotations: read_only("List a directory"),
            },
            McpToolDefinition {
                name: "fs_read_file".to_string(),
                description: format!(
                    "Read part of a file on a connected server. Returns at most `length` bytes (default {DEFAULT_READ_BYTES}, max {MAX_READ_BYTES}) from `offset`, as UTF-8 text or base64 for binary data; a second content item reports encoding, total size and whether more data follows."
                ),
                input_schema: json!({
                    "type": "object",
                    "required": ["connection_id", "path"],
                    "properties": {
                        "connection_id": { "type": "string", "description": "Session ID from session_list" },
                        "path": { "type": "string", "description": "File path to read" },
                        "offset": { "type": "integer", "description": "Optional byte offset (default 0)" },
                        "length": { "type": "integer", "description": format!("Optional max bytes to read (default {DEFAULT_READ_BYTES}, max {MAX_READ_BYTES})") }
                    }
                }),
                annotations: read_only("Read a file"),
            },
            McpToolDefinition {
                name: "fs_write_file".to_string(),
                description: "Write or replace a file on a connected server. The call waits until the user allows it in the RustSCP window (denied if nobody answers); every write is recorded in the audit log with the previous and new size and SHA-256.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "required": ["connection_id", "path", "content"],
                    "properties": {
                        "connection_id": { "type": "string", "description": "Session ID from session_list" },
                        "path": { "type": "string", "description": "File path to write" },
                        "content": { "type": "string", "description": "File content: text, or base64 when encoding is 'base64'" },
                        "encoding": { "type": "string", "enum": ["utf-8", "base64"], "description": "Encoding of content (default 'utf-8')" }
                    }
                }),
                annotations: Some(json!({
                    "title": "Write a file (needs approval)",
                    "readOnlyHint": false,
                    "destructiveHint": true,
                    "idempotentHint": true
                })),
            },
            McpToolDefinition {
                name: "fs_search".to_string(),
                description: "Search for files by pattern inside an active connection".to_string(),
                input_schema: json!({
                    "type": "object",
                    "required": ["connection_id", "pattern"],
                    "properties": {
                        "connection_id": { "type": "string", "description": "Session ID from session_list" },
                        "pattern": { "type": "string", "description": "Search pattern (e.g. 'config', '*.rs')" },
                        "root_path": { "type": "string", "description": "Starting directory (default '/')" }
                    }
                }),
                annotations: read_only("Search for files"),
            },
            McpToolDefinition {
                name: "render_smart_action".to_string(),
                description: "Validate parameters and render the shell command of a pre-vetted smart action (e.g. tar-compress, systemctl-manager, disk-usage). The command is returned for review; it is NOT executed.".to_string(),
                input_schema: smart_action_schema.clone(),
                annotations: read_only("Render a smart action"),
            },
            McpToolDefinition {
                name: "exec_smart_action".to_string(),
                description: "Deprecated alias of render_smart_action: renders the command for review and does NOT execute anything.".to_string(),
                input_schema: smart_action_schema,
                annotations: read_only("Render a smart action (deprecated name)"),
            },
        ]
    }

    async fn audit(
        &self,
        agent_id: &str,
        tool_name: &str,
        conn_id: &str,
        summary: &str,
        status: &str,
        diff: Option<String>,
    ) {
        self.audit_logger
            .log(agent_id, tool_name, conn_id, summary, status, diff)
            .await;
    }

    async fn connection(
        &self,
        conn_id: &str,
    ) -> Option<(Arc<dyn VirtualFileSystem>, ConnectionInfo)> {
        self.connections
            .read()
            .await
            .get(conn_id)
            .map(|c| (c.vfs.clone(), c.info.clone()))
    }

    /// Registered sessions as agents see them (sorted by id, no credentials).
    async fn session_summaries(&self) -> Vec<Value> {
        let conns = self.connections.read().await;
        let mut ids: Vec<&String> = conns.keys().collect();
        ids.sort();
        ids.into_iter()
            .map(|id| {
                let info = &conns[id].info;
                json!({
                    "connection_id": id,
                    "name": info.name,
                    "protocol": info.protocol,
                    "host": info.host,
                })
            })
            .collect()
    }

    pub async fn handle_tool_call(
        &self,
        agent_id: &str,
        tool_name: &str,
        arguments: &Value,
    ) -> McpToolResult {
        let str_arg = |key: &str| arguments.get(key).and_then(|v| v.as_str());
        let conn_arg = str_arg("connection_id");
        let conn_id = conn_arg.unwrap_or("none");

        let needs_connection = matches!(
            tool_name,
            "fs_list_dir" | "fs_read_file" | "fs_write_file" | "fs_search"
        );
        let (vfs, info) = if needs_connection {
            let summary = str_arg("path").or(str_arg("pattern")).unwrap_or("");
            let Some(requested) = conn_arg else {
                self.audit(
                    agent_id,
                    tool_name,
                    conn_id,
                    summary,
                    "error: missing connection_id",
                    None,
                )
                .await;
                return McpToolResult::error_text(
                    "connection_id is required: call session_list to get the ids of the connected sessions",
                );
            };
            match self.connection(requested).await {
                Some((v, i)) => (Some(v), i),
                None => {
                    self.audit(
                        agent_id,
                        tool_name,
                        conn_id,
                        summary,
                        "error: connection not found",
                        None,
                    )
                    .await;
                    return McpToolResult::error_text(format!(
                        "Connection '{}' not found or inactive (call session_list for the connected sessions)",
                        conn_id
                    ));
                }
            }
        } else {
            (None, ConnectionInfo::default())
        };

        match tool_name {
            "session_list" => {
                let sessions = self.session_summaries().await;
                let ids: Vec<&Value> = sessions.iter().map(|s| &s["connection_id"]).collect();
                self.audit(
                    agent_id,
                    tool_name,
                    "none",
                    "listing sessions",
                    "success",
                    None,
                )
                .await;
                let mut out = json!({ "sessions": sessions, "active_sessions": ids });
                if sessions.is_empty() {
                    out["note"] = json!(
                        "No server is connected in RustSCP right now. Ask the user to connect one in the RustSCP app, then call session_list again."
                    );
                }
                McpToolResult::success_text(out.to_string())
            }

            "fs_list_dir" => {
                let vfs = vfs.expect("connection checked");
                let path = str_arg("path").unwrap_or("/");
                match vfs.list_dir(path).await {
                    Ok(entries) => {
                        self.audit(agent_id, tool_name, conn_id, path, "success", None)
                            .await;
                        McpToolResult::success_text(json!({ "entries": entries }).to_string())
                    }
                    Err(err) => {
                        self.audit(
                            agent_id,
                            tool_name,
                            conn_id,
                            path,
                            &format!("error: {}", err),
                            None,
                        )
                        .await;
                        McpToolResult::error_text(format!("Failed to list directory: {}", err))
                    }
                }
            }

            "fs_read_file" => {
                let vfs = vfs.expect("connection checked");
                let path = str_arg("path").unwrap_or("");
                let offset = arguments
                    .get("offset")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let length = arguments
                    .get("length")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(DEFAULT_READ_BYTES)
                    .clamp(1, MAX_READ_BYTES);
                let summary = format!("{path} [offset {offset}, length {length}]");

                let total = match vfs.metadata(path).await {
                    Ok(meta) if meta.is_dir() => {
                        self.audit(
                            agent_id,
                            tool_name,
                            conn_id,
                            &summary,
                            "error: is a directory",
                            None,
                        )
                        .await;
                        return McpToolResult::error_text(format!("{} is a directory", path));
                    }
                    Ok(meta) => Some(meta.size),
                    Err(_) => None,
                };

                match vfs.read_range(path, offset, length).await {
                    Ok(bytes) => {
                        let end = offset + bytes.len() as u64;
                        let truncated = match total {
                            Some(t) => end < t,
                            None => bytes.len() as u64 == length,
                        };
                        let (content, encoding, used) = encode_for_agent(&bytes, truncated);
                        let used_end = offset + used as u64;
                        let truncated = truncated || used < bytes.len();
                        self.audit(agent_id, tool_name, conn_id, &summary, "success", None)
                            .await;
                        let meta = json!({
                            "path": path,
                            "offset": offset,
                            "bytes_returned": used,
                            "next_offset": used_end,
                            "total_size": total,
                            "truncated": truncated,
                            "encoding": encoding,
                        });
                        McpToolResult {
                            content: vec![
                                McpContent::Text { text: content },
                                McpContent::Text {
                                    text: meta.to_string(),
                                },
                            ],
                            is_error: false,
                        }
                    }
                    Err(err) => {
                        self.audit(
                            agent_id,
                            tool_name,
                            conn_id,
                            &summary,
                            &format!("error: {}", err),
                            None,
                        )
                        .await;
                        McpToolResult::error_text(format!("Failed to read file: {}", err))
                    }
                }
            }

            "fs_write_file" => {
                let vfs = vfs.expect("connection checked");
                let path = str_arg("path").unwrap_or("");
                let content = str_arg("content").unwrap_or("");
                let encoding = str_arg("encoding").unwrap_or("utf-8").to_ascii_lowercase();
                let data = match encoding.as_str() {
                    "utf-8" | "utf8" | "text" => content.as_bytes().to_vec(),
                    "base64" => match base64_decode(content) {
                        Ok(d) => d,
                        Err(e) => {
                            self.audit(
                                agent_id,
                                tool_name,
                                conn_id,
                                path,
                                &format!("error: {e}"),
                                None,
                            )
                            .await;
                            return McpToolResult::error_text(format!(
                                "Invalid base64 content: {e}"
                            ));
                        }
                    },
                    other => {
                        self.audit(
                            agent_id,
                            tool_name,
                            conn_id,
                            path,
                            "error: unsupported encoding",
                            None,
                        )
                        .await;
                        return McpToolResult::error_text(format!(
                            "Unsupported encoding '{other}' (use 'utf-8' or 'base64')"
                        ));
                    }
                };

                let previous_size = match vfs.metadata(path).await {
                    Ok(meta) if meta.is_dir() => {
                        self.audit(
                            agent_id,
                            tool_name,
                            conn_id,
                            path,
                            "error: is a directory",
                            None,
                        )
                        .await;
                        return McpToolResult::error_text(format!("{} is a directory", path));
                    }
                    Ok(meta) => Some(meta.size),
                    Err(_) => None,
                };
                let new_sha256 = rustscp_core::disk_cache::sha256_hex(&data);

                // A person allows or denies every write before anything is changed.
                let request = write_approval_request(
                    agent_id,
                    tool_name,
                    conn_id,
                    &info,
                    path,
                    &data,
                    &new_sha256,
                    previous_size,
                );
                let diff = format!("new: {} bytes sha256={new_sha256}", data.len());
                let decision = match self.current_approver() {
                    Some(approver) => {
                        let mut withdrawn = WithdrawnWriteAudit {
                            audit: self.audit_logger.clone(),
                            agent_id: agent_id.to_string(),
                            tool_name: tool_name.to_string(),
                            conn_id: conn_id.to_string(),
                            path: path.to_string(),
                            diff: diff.clone(),
                            answered: false,
                        };
                        let decision = approver.approve(request).await;
                        withdrawn.answered = true;
                        decision
                    }
                    None => ApprovalDecision::Denied(
                        "no RustSCP window is available to approve it".to_string(),
                    ),
                };
                if let ApprovalDecision::Denied(reason) = decision {
                    self.audit(
                        agent_id,
                        tool_name,
                        conn_id,
                        path,
                        &format!("denied: {reason}"),
                        Some(diff),
                    )
                    .await;
                    return McpToolResult::error_text(format!(
                        "The write to {path} was not allowed ({reason}). Nothing was changed."
                    ));
                }

                // The approved write runs as its own task, so an agent that disconnects
                // mid-call never leaves a half-written file or a missing audit entry.
                let task = tokio::spawn(write_and_audit(
                    self.audit_logger.clone(),
                    vfs,
                    agent_id.to_string(),
                    tool_name.to_string(),
                    conn_id.to_string(),
                    path.to_string(),
                    data,
                    new_sha256,
                ));
                match task.await {
                    Ok(result) => result,
                    Err(e) => McpToolResult::error_text(format!("Write task failed: {e}")),
                }
            }

            "fs_search" => {
                let vfs = vfs.expect("connection checked");
                let pattern = str_arg("pattern").unwrap_or("");
                let root = str_arg("root_path").unwrap_or("/");
                let summary = format!("{pattern} in {root}");
                match vfs.search(root, pattern, 50).await {
                    Ok(results) => {
                        self.audit(agent_id, tool_name, conn_id, &summary, "success", None)
                            .await;
                        McpToolResult::success_text(json!({ "matches": results }).to_string())
                    }
                    Err(err) => {
                        self.audit(
                            agent_id,
                            tool_name,
                            conn_id,
                            &summary,
                            &format!("error: {}", err),
                            None,
                        )
                        .await;
                        McpToolResult::error_text(format!("Search failed: {}", err))
                    }
                }
            }

            "render_smart_action" | "exec_smart_action" => {
                let action_id = str_arg("action_id").unwrap_or("");
                let current_dir = str_arg("current_dir").unwrap_or("/");
                let selected: Vec<String> = arguments
                    .get("selected_paths")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|x| x.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();

                let mut params_map = HashMap::new();
                if let Some(obj) = arguments.get("params").and_then(|v| v.as_object()) {
                    for (k, v) in obj {
                        if let Some(s) = v.as_str() {
                            params_map.insert(k.clone(), s.to_string());
                        } else {
                            params_map.insert(k.clone(), v.to_string());
                        }
                    }
                }

                let actions = ActionCatalog::builtin_actions();
                let Some(act) = actions.iter().find(|a| a.id == action_id) else {
                    self.audit(
                        agent_id,
                        tool_name,
                        conn_id,
                        action_id,
                        "error: unknown action",
                        None,
                    )
                    .await;
                    return McpToolResult::error_text(format!(
                        "Action '{}' not found in catalog",
                        action_id
                    ));
                };
                let ctx = ActionContext::new(current_dir, selected);
                match ActionExecutor::render_command(act, &ctx, &params_map) {
                    Ok(rendered_cmd) => {
                        self.audit(
                            agent_id,
                            tool_name,
                            conn_id,
                            &rendered_cmd,
                            "rendered_safe_command",
                            None,
                        )
                        .await;
                        McpToolResult::success_text(
                            json!({
                                "action": act.name.en_us,
                                "risk_level": act.risk_level,
                                "rendered_command": rendered_cmd,
                                "executed": false
                            })
                            .to_string(),
                        )
                    }
                    Err(err) => {
                        self.audit(
                            agent_id,
                            tool_name,
                            conn_id,
                            action_id,
                            &format!("error: {}", err),
                            None,
                        )
                        .await;
                        McpToolResult::error_text(format!("Action validation failed: {}", err))
                    }
                }
            }

            unknown => {
                self.audit(agent_id, unknown, conn_id, "", "error: unknown tool", None)
                    .await;
                McpToolResult::error_text(format!("Unknown tool: {}", unknown))
            }
        }
    }

    /// Process raw JSON-RPC request and produce JSON-RPC response.
    ///
    /// Without an authenticated transport the caller is recorded as [`DEFAULT_AGENT_ID`];
    /// an `agent_id` claimed in the request is only noted, never trusted.
    pub async fn handle_rpc(self: &Arc<Self>, raw_json: &str) -> Option<JsonRpcResponse> {
        self.handle_rpc_as(DEFAULT_AGENT_ID, raw_json).await
    }

    /// Like [`handle_rpc`](Self::handle_rpc), with the agent identity supplied by the
    /// transport. Notifications (requests without an `id`) never get a response. Stream
    /// transports keep one [`RpcSession`] per client instead (see [`crate::transport`]).
    pub async fn handle_rpc_as(
        self: &Arc<Self>,
        agent_id: &str,
        raw_json: &str,
    ) -> Option<JsonRpcResponse> {
        let message: Value = match serde_json::from_str(raw_json) {
            Ok(v) => v,
            Err(e) => {
                return Some(JsonRpcResponse::error(
                    Value::Null,
                    crate::rpc::PARSE_ERROR,
                    format!("Parse error: {}", e),
                ));
            }
        };
        RpcSession::new(self.clone(), agent_id, None)
            .handle_message(message)
            .await
    }
}

#[async_trait]
impl ToolBackend for McpServer {
    async fn call_tool(&self, agent_id: &str, name: &str, arguments: &Value) -> McpToolResult {
        self.handle_tool_call(agent_id, name, arguments).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustscp_core::LocalFsDriver;
    use std::sync::Mutex;

    /// Server with the local filesystem registered as "local" (tests only: the app never
    /// registers it).
    async fn local_server(audit: AuditLogger) -> Arc<McpServer> {
        let server = Arc::new(McpServer::new(audit));
        server
            .register_connection("local".into(), Arc::new(LocalFsDriver::new()))
            .await;
        server
    }

    /// Answers every approval with a fixed decision and keeps the requests.
    struct FixedApprover {
        decision: ApprovalDecision,
        seen: Mutex<Vec<ApprovalRequest>>,
    }

    impl FixedApprover {
        fn new(decision: ApprovalDecision) -> Arc<Self> {
            Arc::new(Self {
                decision,
                seen: Mutex::new(Vec::new()),
            })
        }
    }

    #[async_trait]
    impl ToolApprover for FixedApprover {
        async fn approve(&self, request: ApprovalRequest) -> ApprovalDecision {
            self.seen.lock().unwrap().push(request);
            self.decision.clone()
        }
    }

    /// Never answers, like a dialog nobody looks at; tells when it is asked.
    #[derive(Default)]
    struct SilentApprover {
        asked: tokio::sync::Notify,
    }

    #[async_trait]
    impl ToolApprover for SilentApprover {
        async fn approve(&self, _request: ApprovalRequest) -> ApprovalDecision {
            self.asked.notify_one();
            std::future::pending().await
        }
    }

    /// Audited `fs_write_file` calls, oldest first.
    async fn write_events(audit: &AuditLogger) -> Vec<crate::audit::AuditEvent> {
        let mut events = audit.get_recent_events(usize::MAX).await;
        events.retain(|e| e.tool_name == "fs_write_file");
        events.reverse();
        events
    }

    #[tokio::test]
    async fn test_mcp_initialize_and_tools_list() {
        let server = Arc::new(McpServer::new(AuditLogger::new()));

        // Test initialize
        let init_req = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#;
        let resp = server.handle_rpc(init_req).await.unwrap();
        assert!(resp.error.is_none());
        assert_eq!(
            resp.result.unwrap()["serverInfo"]["name"],
            "RustSCP MCP Gateway"
        );

        // Test tools/list
        let list_req = r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#;
        let resp2 = server.handle_rpc(list_req).await.unwrap();
        let tools = resp2.result.unwrap()["tools"].as_array().unwrap().clone();
        assert!(tools.len() >= 5);
        assert!(server.transport_available());
        assert!(crate::transport_available());
    }

    #[tokio::test]
    async fn test_notifications_get_no_response_and_version_is_negotiated() {
        let server = Arc::new(McpServer::new(AuditLogger::new()));
        assert!(server
            .handle_rpc(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#)
            .await
            .is_none());
        assert!(server
            .handle_rpc(r#"{"jsonrpc":"2.0","method":"unknown/thing"}"#)
            .await
            .is_none());

        let resp = server
            .handle_rpc(
                r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}"#,
            )
            .await
            .unwrap();
        assert_eq!(resp.result.unwrap()["protocolVersion"], "2025-03-26");
        let resp = server
            .handle_rpc(
                r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"1999-01-01"}}"#,
            )
            .await
            .unwrap();
        assert_eq!(
            resp.result.unwrap()["protocolVersion"],
            *SUPPORTED_PROTOCOL_VERSIONS.last().unwrap()
        );

        let resp = server
            .handle_rpc(r#"{"jsonrpc":"2.0","id":5,"method":"nope"}"#)
            .await
            .unwrap();
        assert_eq!(resp.error.unwrap().code, -32601);
    }

    fn text_of(res: &McpToolResult, i: usize) -> String {
        match &res.content[i] {
            McpContent::Text { text } => text.clone(),
        }
    }

    #[tokio::test]
    async fn test_local_filesystem_is_not_registered_by_default() {
        let server = McpServer::new(AuditLogger::new());
        assert!(server.connection_ids().await.is_empty());
        let res = server
            .handle_tool_call(
                "t",
                "fs_list_dir",
                &json!({ "connection_id": "local", "path": "/" }),
            )
            .await;
        assert!(res.is_error);
        let res = server
            .handle_tool_call("t", "fs_read_file", &json!({ "path": "/etc/hosts" }))
            .await;
        assert!(res.is_error);
        assert!(text_of(&res, 0).contains("connection_id is required"));
        let res = server
            .handle_tool_call("t", "session_list", &json!({}))
            .await;
        let v: Value = serde_json::from_str(&text_of(&res, 0)).unwrap();
        assert_eq!(v["sessions"], json!([]));
        assert!(v["note"].as_str().unwrap().contains("connect"));
    }

    #[tokio::test]
    async fn test_session_list_shows_names_but_no_credentials() {
        let server = McpServer::new(AuditLogger::new());
        server
            .register_session(
                "prod-1".into(),
                ConnectionInfo {
                    name: "Prod VPS".into(),
                    protocol: "sftp".into(),
                    host: "203.0.113.7".into(),
                },
                Arc::new(LocalFsDriver::new()),
            )
            .await;
        let res = server
            .handle_tool_call("t", "session_list", &json!({}))
            .await;
        let v: Value = serde_json::from_str(&text_of(&res, 0)).unwrap();
        assert_eq!(v["active_sessions"], json!(["prod-1"]));
        assert_eq!(v["sessions"][0]["name"], "Prod VPS");
        assert_eq!(v["sessions"][0]["protocol"], "sftp");
        let keys: Vec<&String> = v["sessions"][0].as_object().unwrap().keys().collect();
        assert_eq!(keys.len(), 4, "{keys:?}");
        assert!(v.get("note").is_none());
    }

    #[tokio::test]
    async fn test_read_file_is_bounded_and_binary_safe() {
        let dir = tempfile::tempdir().unwrap();
        let text_path = dir.path().join("big.log");
        std::fs::write(&text_path, "a".repeat(200_000)).unwrap();
        let bin_path = dir.path().join("img.bin");
        std::fs::write(&bin_path, [0u8, 159, 146, 150, 255]).unwrap();
        let server = local_server(AuditLogger::new()).await;

        let res = server
            .handle_tool_call(
                "t",
                "fs_read_file",
                &json!({ "connection_id": "local", "path": text_path.to_str().unwrap() }),
            )
            .await;
        assert!(!res.is_error);
        assert_eq!(text_of(&res, 0).len() as u64, DEFAULT_READ_BYTES);
        let meta: Value = serde_json::from_str(&text_of(&res, 1)).unwrap();
        assert_eq!(meta["truncated"], true);
        assert_eq!(meta["total_size"], 200_000);
        assert_eq!(meta["next_offset"], DEFAULT_READ_BYTES);

        let res = server
            .handle_tool_call(
                "t",
                "fs_read_file",
                &json!({ "connection_id": "local", "path": text_path.to_str().unwrap(), "offset": 0, "length": 50_000_000u64 }),
            )
            .await;
        assert_eq!(text_of(&res, 0).len() as u64, 200_000.min(MAX_READ_BYTES));

        let res = server
            .handle_tool_call(
                "t",
                "fs_read_file",
                &json!({ "connection_id": "local", "path": bin_path.to_str().unwrap() }),
            )
            .await;
        let meta: Value = serde_json::from_str(&text_of(&res, 1)).unwrap();
        assert_eq!(meta["encoding"], "base64");
        assert_eq!(
            base64_decode(&text_of(&res, 0)).unwrap(),
            vec![0u8, 159, 146, 150, 255]
        );
    }

    #[tokio::test]
    async fn test_utf8_chunk_boundary_is_not_mangled() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("utf8.txt");
        std::fs::write(&p, "aé").unwrap(); // 'é' is two bytes
        let server = local_server(AuditLogger::new()).await;
        let res = server
            .handle_tool_call(
                "t",
                "fs_read_file",
                &json!({ "connection_id": "local", "path": p.to_str().unwrap(), "length": 2 }),
            )
            .await;
        assert_eq!(text_of(&res, 0), "a");
        let meta: Value = serde_json::from_str(&text_of(&res, 1)).unwrap();
        assert_eq!(meta["encoding"], "utf-8");
        assert_eq!(meta["next_offset"], 1);
        assert_eq!(meta["truncated"], true);
    }

    #[tokio::test]
    async fn test_write_file_decodes_base64_and_audits_hashes() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("out.bin");
        std::fs::write(&p, b"old").unwrap();
        let audit = AuditLogger::new();
        let server = local_server(audit.clone()).await;
        let approver = FixedApprover::new(ApprovalDecision::Approved);
        server.set_approver(approver.clone());
        let res = server
            .handle_tool_call(
                "t",
                "fs_write_file",
                &json!({ "connection_id": "local", "path": p.to_str().unwrap(), "content": base64_encode(&[1, 2, 3, 0, 255]), "encoding": "base64" }),
            )
            .await;
        assert!(!res.is_error, "{}", text_of(&res, 0));
        assert_eq!(std::fs::read(&p).unwrap(), vec![1, 2, 3, 0, 255]);
        let ev = &audit.get_recent_events(1).await[0];
        let diff = ev.diff.clone().unwrap();
        assert!(diff.contains("previous: 3 bytes sha256="), "{diff}");
        assert!(diff.contains("new: 5 bytes"), "{diff}");
        {
            let seen = approver.seen.lock().unwrap();
            assert_eq!(seen.len(), 1);
            assert_eq!(seen[0].previous_size, Some(3));
            assert_eq!(seen[0].new_size, 5);
            assert!(
                seen[0].preview.is_none(),
                "binary content has no text preview"
            );
        }

        let res = server
            .handle_tool_call(
                "t",
                "fs_write_file",
                &json!({ "connection_id": "local", "path": p.to_str().unwrap(), "content": "!!", "encoding": "base64" }),
            )
            .await;
        assert!(res.is_error);
        assert_eq!(std::fs::read(&p).unwrap(), vec![1, 2, 3, 0, 255]);
        assert_eq!(
            approver.seen.lock().unwrap().len(),
            1,
            "invalid input is rejected before asking"
        );
    }

    #[tokio::test]
    async fn test_writes_need_approval() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("conf.txt");
        std::fs::write(&p, b"keep me").unwrap();
        let args =
            json!({ "connection_id": "local", "path": p.to_str().unwrap(), "content": "replaced" });
        let audit = AuditLogger::new();
        let server = local_server(audit.clone()).await;

        // Nobody to ask: denied.
        let res = server
            .handle_tool_call("agent", "fs_write_file", &args)
            .await;
        assert!(res.is_error);
        assert!(
            text_of(&res, 0).contains("not allowed"),
            "{}",
            text_of(&res, 0)
        );
        assert_eq!(std::fs::read(&p).unwrap(), b"keep me");
        let ev = &audit.get_recent_events(1).await[0];
        assert!(ev.status.starts_with("denied: "), "{}", ev.status);

        // The person says no.
        let approver = FixedApprover::new(ApprovalDecision::Denied("rejected by the user".into()));
        server.set_approver(approver.clone());
        let res = server
            .handle_tool_call("agent", "fs_write_file", &args)
            .await;
        assert!(res.is_error);
        assert_eq!(std::fs::read(&p).unwrap(), b"keep me");
        assert_eq!(
            audit.get_recent_events(1).await[0].status,
            "denied: rejected by the user"
        );
        let seen = approver.seen.lock().unwrap()[0].clone();
        assert_eq!(seen.agent_id, "agent");
        assert_eq!(seen.connection_id, "local");
        assert_eq!(seen.preview.as_deref(), Some("replaced"));
        assert!(seen.summary.starts_with("Replace "), "{}", seen.summary);

        // Every tool that is not read-only is gated.
        for tool in McpServer::tool_definitions() {
            let read_only = tool.annotations.as_ref().unwrap()["readOnlyHint"] == true;
            assert_eq!(
                tool_requires_approval(&tool.name),
                !read_only,
                "{}",
                tool.name
            );
        }
    }

    #[tokio::test]
    async fn test_a_write_dropped_while_waiting_for_approval_is_audited_once() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("conf.txt");
        std::fs::write(&p, b"keep me").unwrap();
        let args =
            json!({ "connection_id": "local", "path": p.to_str().unwrap(), "content": "replaced" });
        let audit = AuditLogger::new();
        let server = local_server(audit.clone()).await;
        let approver = Arc::new(SilentApprover::default());
        server.set_approver(approver.clone());

        // The call is dropped mid-approval, as when the agent cancels it.
        tokio::select! {
            _ = server.handle_tool_call("agent", "fs_write_file", &args) => {
                panic!("nobody answered the approval")
            }
            _ = approver.asked.notified() => {}
        }
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while write_events(&audit).await.is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the withdrawn write to be audited");
        assert_eq!(std::fs::read(&p).unwrap(), b"keep me");

        // Answered writes keep their single entry.
        server.set_approver(FixedApprover::new(ApprovalDecision::Denied(
            "rejected by the user".into(),
        )));
        server
            .handle_tool_call("agent", "fs_write_file", &args)
            .await;
        server.set_approver(FixedApprover::new(ApprovalDecision::Approved));
        server
            .handle_tool_call("agent", "fs_write_file", &args)
            .await;
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let events = write_events(&audit).await;
        let statuses: Vec<&str> = events.iter().map(|e| e.status.as_str()).collect();
        assert_eq!(
            statuses,
            [WITHDRAWN_STATUS, "denied: rejected by the user", "success"]
        );
        let new_sha256 = rustscp_core::disk_cache::sha256_hex(b"replaced");
        let expected = format!("new: 8 bytes sha256={new_sha256}");
        assert_eq!(events[0].diff.as_deref(), Some(expected.as_str()));
        assert_eq!(events[0].diff, events[1].diff);
        assert_eq!(events[0].agent_id, "agent");
        assert_eq!(events[0].connection_id, "local");
        assert_eq!(events[0].parameters_summary, p.to_str().unwrap());
    }

    #[test]
    fn test_approval_preview_is_bounded_text() {
        let info = ConnectionInfo::default();
        let big = "x".repeat(APPROVAL_PREVIEW_BYTES * 2);
        let req = write_approval_request(
            "a",
            "fs_write_file",
            "c",
            &info,
            "/f",
            big.as_bytes(),
            "h",
            None,
        );
        assert_eq!(req.preview.as_ref().unwrap().len(), APPROVAL_PREVIEW_BYTES);
        assert!(req.preview_truncated);
        assert_eq!(req.connection_name, "c");
        assert!(req.summary.starts_with("Create /f"));
        let small =
            write_approval_request("a", "fs_write_file", "c", &info, "/f", b"hi", "h", Some(1));
        assert_eq!(small.preview.as_deref(), Some("hi"));
        assert!(!small.preview_truncated);
    }

    #[tokio::test]
    async fn test_failures_are_audited_and_agent_id_is_not_spoofable() {
        let audit = AuditLogger::new();
        let server = Arc::new(McpServer::new(audit.clone()));
        let res = server
            .handle_tool_call(
                "t",
                "fs_list_dir",
                &json!({ "connection_id": "gone", "path": "/" }),
            )
            .await;
        assert!(res.is_error);
        assert_eq!(
            audit.get_recent_events(1).await[0].status,
            "error: connection not found"
        );

        server
            .handle_tool_call("t", "no_such_tool", &json!({}))
            .await;
        assert_eq!(
            audit.get_recent_events(1).await[0].status,
            "error: unknown tool"
        );

        server
            .handle_rpc(
                r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"session_list","agent_id":"admin"}}"#,
            )
            .await
            .unwrap();
        let ev = &audit.get_recent_events(1).await[0];
        assert_eq!(ev.agent_id, "ai-agent (claimed: admin)");
    }

    #[tokio::test]
    async fn test_unregister_connection_removes_access() {
        let server = McpServer::new(AuditLogger::new());
        server
            .register_connection("prod".into(), Arc::new(LocalFsDriver::new()))
            .await;
        assert!(server.connection_ids().await.contains(&"prod".to_string()));
        assert!(server.unregister_connection("prod").await);
        assert!(!server.unregister_connection("prod").await);
        let res = server
            .handle_tool_call(
                "t",
                "fs_list_dir",
                &json!({ "connection_id": "prod", "path": "/" }),
            )
            .await;
        assert!(res.is_error);
    }

    #[tokio::test]
    async fn test_smart_action_is_rendered_not_executed() {
        let server = McpServer::new(AuditLogger::new());
        for tool in ["render_smart_action", "exec_smart_action"] {
            let res = server
                .handle_tool_call(
                    "t",
                    tool,
                    &json!({ "action_id": "disk-usage", "current_dir": "/var", "params": { "limit": "10" } }),
                )
                .await;
            assert!(!res.is_error, "{}", text_of(&res, 0));
            let v: Value = serde_json::from_str(&text_of(&res, 0)).unwrap();
            assert_eq!(v["executed"], false);
        }
        let tools = server.list_tools();
        let exec = tools
            .iter()
            .find(|t| t.name == "exec_smart_action")
            .unwrap();
        assert!(exec.description.contains("NOT execute"));
    }

    #[test]
    fn test_base64_roundtrip() {
        for data in [&b""[..], b"f", b"fo", b"foo", b"foob", b"fooba", b"foobar"] {
            assert_eq!(base64_decode(&base64_encode(data)).unwrap(), data);
        }
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        assert!(base64_decode("Zm9=v").is_err());
        assert!(base64_decode("Zg==Zg==").is_err());
    }
}

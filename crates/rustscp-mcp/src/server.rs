use crate::audit::AuditLogger;
use crate::protocol::{
    JsonRpcRequest, JsonRpcResponse, McpContent, McpToolDefinition, McpToolResult,
};
use bytes::Bytes;
use rustscp_actions::{ActionCatalog, ActionContext, ActionExecutor};
use rustscp_core::{LocalFsDriver, VirtualFileSystem};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

/// No MCP transport (stdio, socket or HTTP listener) is wired into the app yet: nothing
/// outside the process can reach [`McpServer::handle_rpc`]. Status screens should report
/// the gateway as unavailable while this is `false`.
pub const MCP_TRANSPORT_AVAILABLE: bool = false;
/// MCP protocol revisions this server answers with (latest last).
pub const SUPPORTED_PROTOCOL_VERSIONS: &[&str] = &["2024-11-05", "2025-03-26", "2025-06-18"];
/// Agent id used by [`McpServer::handle_rpc`], which has no authenticated transport.
pub const DEFAULT_AGENT_ID: &str = "ai-agent";
/// Default and maximum number of bytes `fs_read_file` returns per call.
pub const DEFAULT_READ_BYTES: u64 = 65_536;
pub const MAX_READ_BYTES: u64 = 1024 * 1024;
/// Previous file contents up to this size are hashed for the write audit trail.
const MAX_HASHED_PREVIOUS_BYTES: u64 = 8 * 1024 * 1024;

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

pub struct McpServer {
    audit_logger: AuditLogger,
    // Connection registry: ID -> Arc<dyn VirtualFileSystem>
    connections: Arc<RwLock<HashMap<String, Arc<dyn VirtualFileSystem>>>>,
}

impl McpServer {
    pub fn new(audit_logger: AuditLogger) -> Self {
        let mut initial_conns: HashMap<String, Arc<dyn VirtualFileSystem>> = HashMap::new();
        // Default local workspace connection
        initial_conns.insert("local".to_string(), Arc::new(LocalFsDriver::new()));

        Self {
            audit_logger,
            connections: Arc::new(RwLock::new(initial_conns)),
        }
    }

    pub fn audit_logger(&self) -> &AuditLogger {
        &self.audit_logger
    }

    /// Whether an external MCP client can currently reach this server.
    pub fn transport_available(&self) -> bool {
        MCP_TRANSPORT_AVAILABLE
    }

    pub async fn register_connection(&self, id: String, vfs: Arc<dyn VirtualFileSystem>) {
        let mut conns = self.connections.write().await;
        conns.insert(id, vfs);
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

    pub fn list_tools(&self) -> Vec<McpToolDefinition> {
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
                description: "List all active, authenticated server sessions available to the AI agent (without exposing credentials)".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {}
                }),
            },
            McpToolDefinition {
                name: "fs_list_dir".to_string(),
                description: "List directory contents from an active connection".to_string(),
                input_schema: json!({
                    "type": "object",
                    "required": ["connection_id", "path"],
                    "properties": {
                        "connection_id": { "type": "string", "description": "Session ID (e.g. 'local', 'prod-vps')" },
                        "path": { "type": "string", "description": "Remote directory path to list" }
                    }
                }),
            },
            McpToolDefinition {
                name: "fs_read_file".to_string(),
                description: format!(
                    "Read part of a remote or local file. Returns at most `length` bytes (default {DEFAULT_READ_BYTES}, max {MAX_READ_BYTES}) from `offset`, as UTF-8 text or base64 for binary data; a second content item reports encoding, total size and whether more data follows."
                ),
                input_schema: json!({
                    "type": "object",
                    "required": ["connection_id", "path"],
                    "properties": {
                        "connection_id": { "type": "string", "description": "Session ID" },
                        "path": { "type": "string", "description": "File path to read" },
                        "offset": { "type": "integer", "description": "Optional byte offset (default 0)" },
                        "length": { "type": "integer", "description": format!("Optional max bytes to read (default {DEFAULT_READ_BYTES}, max {MAX_READ_BYTES})") }
                    }
                }),
            },
            McpToolDefinition {
                name: "fs_write_file".to_string(),
                description: "Write or replace a file on the target server; every write is recorded in the audit log with the previous and new size and SHA-256".to_string(),
                input_schema: json!({
                    "type": "object",
                    "required": ["connection_id", "path", "content"],
                    "properties": {
                        "connection_id": { "type": "string", "description": "Session ID" },
                        "path": { "type": "string", "description": "File path to write" },
                        "content": { "type": "string", "description": "File content: text, or base64 when encoding is 'base64'" },
                        "encoding": { "type": "string", "enum": ["utf-8", "base64"], "description": "Encoding of content (default 'utf-8')" }
                    }
                }),
            },
            McpToolDefinition {
                name: "fs_search".to_string(),
                description: "Search for files by pattern inside an active connection".to_string(),
                input_schema: json!({
                    "type": "object",
                    "required": ["connection_id", "pattern"],
                    "properties": {
                        "connection_id": { "type": "string", "description": "Session ID" },
                        "pattern": { "type": "string", "description": "Search pattern (e.g. 'config', '*.rs')" },
                        "root_path": { "type": "string", "description": "Starting directory (default '/')" }
                    }
                }),
            },
            McpToolDefinition {
                name: "render_smart_action".to_string(),
                description: "Validate parameters and render the shell command of a pre-vetted smart action (e.g. tar-compress, systemctl-manager, disk-usage). The command is returned for review; it is NOT executed.".to_string(),
                input_schema: smart_action_schema.clone(),
            },
            McpToolDefinition {
                name: "exec_smart_action".to_string(),
                description: "Deprecated alias of render_smart_action: renders the command for review and does NOT execute anything.".to_string(),
                input_schema: smart_action_schema,
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

    async fn connection(&self, conn_id: &str) -> Option<Arc<dyn VirtualFileSystem>> {
        self.connections.read().await.get(conn_id).cloned()
    }

    pub async fn handle_tool_call(
        &self,
        agent_id: &str,
        tool_name: &str,
        arguments: &Value,
    ) -> McpToolResult {
        let conn_id = arguments
            .get("connection_id")
            .and_then(|v| v.as_str())
            .unwrap_or("local");
        let str_arg = |key: &str| arguments.get(key).and_then(|v| v.as_str());

        let needs_connection = matches!(
            tool_name,
            "fs_list_dir" | "fs_read_file" | "fs_write_file" | "fs_search"
        );
        let vfs = if needs_connection {
            match self.connection(conn_id).await {
                Some(v) => Some(v),
                None => {
                    let summary = str_arg("path").or(str_arg("pattern")).unwrap_or("");
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
                        "Connection '{}' not found or inactive",
                        conn_id
                    ));
                }
            }
        } else {
            None
        };

        match tool_name {
            "session_list" => {
                let list = self.connection_ids().await;
                self.audit(agent_id, tool_name, "none", "listing sessions", "success", None)
                    .await;
                McpToolResult::success_text(json!({ "active_sessions": list }).to_string())
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
                        self.audit(agent_id, tool_name, conn_id, path, &format!("error: {}", err), None)
                            .await;
                        McpToolResult::error_text(format!("Failed to list directory: {}", err))
                    }
                }
            }

            "fs_read_file" => {
                let vfs = vfs.expect("connection checked");
                let path = str_arg("path").unwrap_or("");
                let offset = arguments.get("offset").and_then(|v| v.as_u64()).unwrap_or(0);
                let length = arguments
                    .get("length")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(DEFAULT_READ_BYTES)
                    .clamp(1, MAX_READ_BYTES);
                let summary = format!("{path} [offset {offset}, length {length}]");

                let total = match vfs.metadata(path).await {
                    Ok(meta) if meta.is_dir() => {
                        self.audit(agent_id, tool_name, conn_id, &summary, "error: is a directory", None)
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
                                McpContent::Text { text: meta.to_string() },
                            ],
                            is_error: false,
                        }
                    }
                    Err(err) => {
                        self.audit(agent_id, tool_name, conn_id, &summary, &format!("error: {}", err), None)
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
                            self.audit(agent_id, tool_name, conn_id, path, &format!("error: {e}"), None)
                                .await;
                            return McpToolResult::error_text(format!("Invalid base64 content: {e}"));
                        }
                    },
                    other => {
                        self.audit(agent_id, tool_name, conn_id, path, "error: unsupported encoding", None)
                            .await;
                        return McpToolResult::error_text(format!(
                            "Unsupported encoding '{other}' (use 'utf-8' or 'base64')"
                        ));
                    }
                };

                // Record what the write replaces, for the audit trail.
                let previous = match vfs.metadata(path).await {
                    Ok(meta) if meta.is_dir() => {
                        self.audit(agent_id, tool_name, conn_id, path, "error: is a directory", None)
                            .await;
                        return McpToolResult::error_text(format!("{} is a directory", path));
                    }
                    Ok(meta) if meta.size <= MAX_HASHED_PREVIOUS_BYTES => {
                        match vfs.read_file(path).await {
                            Ok(old) => format!(
                                "previous: {} bytes sha256={}",
                                old.len(),
                                rustscp_core::disk_cache::sha256_hex(&old)
                            ),
                            Err(_) => format!("previous: {} bytes", meta.size),
                        }
                    }
                    Ok(meta) => format!("previous: {} bytes (not hashed)", meta.size),
                    Err(_) => "previous: none (new file)".to_string(),
                };
                let diff = format!(
                    "{previous}; new: {} bytes sha256={}",
                    data.len(),
                    rustscp_core::disk_cache::sha256_hex(&data)
                );

                let len = data.len();
                match vfs.write_file(path, Bytes::from(data)).await {
                    Ok(_) => {
                        self.audit(agent_id, tool_name, conn_id, path, "success", Some(diff))
                            .await;
                        McpToolResult::success_text(format!(
                            "File written successfully: {} ({} bytes)",
                            path, len
                        ))
                    }
                    Err(err) => {
                        self.audit(agent_id, tool_name, conn_id, path, &format!("error: {}", err), Some(diff))
                            .await;
                        McpToolResult::error_text(format!("Failed to write file: {}", err))
                    }
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
                        self.audit(agent_id, tool_name, conn_id, &summary, &format!("error: {}", err), None)
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
                    self.audit(agent_id, tool_name, conn_id, action_id, "error: unknown action", None)
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
                        self.audit(agent_id, tool_name, conn_id, action_id, &format!("error: {}", err), None)
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
    pub async fn handle_rpc(&self, raw_json: &str) -> Option<JsonRpcResponse> {
        self.handle_rpc_as(DEFAULT_AGENT_ID, raw_json).await
    }

    /// Like [`handle_rpc`](Self::handle_rpc), with the agent identity supplied by the
    /// transport. Notifications (requests without an `id`) never get a response.
    pub async fn handle_rpc_as(&self, agent_id: &str, raw_json: &str) -> Option<JsonRpcResponse> {
        let req: JsonRpcRequest = match serde_json::from_str(raw_json) {
            Ok(r) => r,
            Err(e) => {
                return Some(JsonRpcResponse::error(
                    Value::Null,
                    -32700,
                    format!("Parse error: {}", e),
                ));
            }
        };

        let Some(req_id) = req.id.clone() else {
            // JSON-RPC 2.0 notification (e.g. "notifications/initialized"): handle known
            // ones (nothing to do yet) and never answer.
            return None;
        };

        if req.jsonrpc != "2.0" {
            return Some(JsonRpcResponse::error(
                req_id,
                -32600,
                "Invalid Request: jsonrpc must be \"2.0\"",
            ));
        }

        match req.method.as_str() {
            "initialize" => {
                let requested = req
                    .params
                    .as_ref()
                    .and_then(|p| p.get("protocolVersion"))
                    .and_then(|v| v.as_str());
                let version = match requested {
                    Some(v) if SUPPORTED_PROTOCOL_VERSIONS.contains(&v) => v,
                    _ => SUPPORTED_PROTOCOL_VERSIONS
                        .last()
                        .copied()
                        .unwrap_or("2024-11-05"),
                };
                Some(JsonRpcResponse::success(
                    req_id,
                    json!({
                        "protocolVersion": version,
                        "serverInfo": {
                            "name": "RustSCP MCP Gateway",
                            "version": env!("CARGO_PKG_VERSION")
                        },
                        "capabilities": {
                            "tools": {}
                        }
                    }),
                ))
            }

            "tools/list" => {
                let tools = self.list_tools();
                Some(JsonRpcResponse::success(req_id, json!({ "tools": tools })))
            }

            "tools/call" => {
                let params = req.params.unwrap_or(json!({}));
                let tool_name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let args = params.get("arguments").cloned().unwrap_or(json!({}));
                let recorded_agent = match params.get("agent_id").and_then(|v| v.as_str()) {
                    Some(claimed) if claimed != agent_id => {
                        format!("{agent_id} (claimed: {claimed})")
                    }
                    _ => agent_id.to_string(),
                };

                let result = self
                    .handle_tool_call(&recorded_agent, tool_name, &args)
                    .await;
                Some(JsonRpcResponse::success(req_id, json!(result)))
            }

            "ping" => Some(JsonRpcResponse::success(req_id, json!({}))),

            unknown => Some(JsonRpcResponse::error(
                req_id,
                -32601,
                format!("Method '{}' not found", unknown),
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_mcp_initialize_and_tools_list() {
        let server = McpServer::new(AuditLogger::new());

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
        assert_eq!(server.transport_available(), MCP_TRANSPORT_AVAILABLE);
    }

    #[tokio::test]
    async fn test_notifications_get_no_response_and_version_is_negotiated() {
        let server = McpServer::new(AuditLogger::new());
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
    async fn test_read_file_is_bounded_and_binary_safe() {
        let dir = tempfile::tempdir().unwrap();
        let text_path = dir.path().join("big.log");
        std::fs::write(&text_path, "a".repeat(200_000)).unwrap();
        let bin_path = dir.path().join("img.bin");
        std::fs::write(&bin_path, [0u8, 159, 146, 150, 255]).unwrap();
        let server = McpServer::new(AuditLogger::new());

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
                &json!({ "path": text_path.to_str().unwrap(), "offset": 0, "length": 50_000_000u64 }),
            )
            .await;
        assert_eq!(text_of(&res, 0).len() as u64, 200_000.min(MAX_READ_BYTES));

        let res = server
            .handle_tool_call("t", "fs_read_file", &json!({ "path": bin_path.to_str().unwrap() }))
            .await;
        let meta: Value = serde_json::from_str(&text_of(&res, 1)).unwrap();
        assert_eq!(meta["encoding"], "base64");
        assert_eq!(base64_decode(&text_of(&res, 0)).unwrap(), vec![0u8, 159, 146, 150, 255]);
    }

    #[tokio::test]
    async fn test_utf8_chunk_boundary_is_not_mangled() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("utf8.txt");
        std::fs::write(&p, "aé").unwrap(); // 'é' is two bytes
        let server = McpServer::new(AuditLogger::new());
        let res = server
            .handle_tool_call("t", "fs_read_file", &json!({ "path": p.to_str().unwrap(), "length": 2 }))
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
        let server = McpServer::new(audit.clone());
        let res = server
            .handle_tool_call(
                "t",
                "fs_write_file",
                &json!({ "path": p.to_str().unwrap(), "content": base64_encode(&[1, 2, 3, 0, 255]), "encoding": "base64" }),
            )
            .await;
        assert!(!res.is_error, "{}", text_of(&res, 0));
        assert_eq!(std::fs::read(&p).unwrap(), vec![1, 2, 3, 0, 255]);
        let ev = &audit.get_recent_events(1).await[0];
        let diff = ev.diff.clone().unwrap();
        assert!(diff.contains("previous: 3 bytes sha256="), "{diff}");
        assert!(diff.contains("new: 5 bytes"), "{diff}");

        let res = server
            .handle_tool_call(
                "t",
                "fs_write_file",
                &json!({ "path": p.to_str().unwrap(), "content": "!!", "encoding": "base64" }),
            )
            .await;
        assert!(res.is_error);
        assert_eq!(std::fs::read(&p).unwrap(), vec![1, 2, 3, 0, 255]);
    }

    #[tokio::test]
    async fn test_failures_are_audited_and_agent_id_is_not_spoofable() {
        let audit = AuditLogger::new();
        let server = McpServer::new(audit.clone());
        let res = server
            .handle_tool_call("t", "fs_list_dir", &json!({ "connection_id": "gone", "path": "/" }))
            .await;
        assert!(res.is_error);
        assert_eq!(audit.get_recent_events(1).await[0].status, "error: connection not found");

        server.handle_tool_call("t", "no_such_tool", &json!({})).await;
        assert_eq!(audit.get_recent_events(1).await[0].status, "error: unknown tool");

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
            .handle_tool_call("t", "fs_list_dir", &json!({ "connection_id": "prod", "path": "/" }))
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
        let exec = tools.iter().find(|t| t.name == "exec_smart_action").unwrap();
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

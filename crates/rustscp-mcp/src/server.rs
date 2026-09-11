use crate::audit::AuditLogger;
use crate::protocol::{JsonRpcRequest, JsonRpcResponse, McpToolDefinition, McpToolResult};
use bytes::Bytes;
use rustscp_actions::{ActionCatalog, ActionContext, ActionExecutor};
use rustscp_core::{LocalFsDriver, VirtualFileSystem};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

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

    pub async fn register_connection(&self, id: String, vfs: Arc<dyn VirtualFileSystem>) {
        let mut conns = self.connections.write().await;
        conns.insert(id, vfs);
    }

    pub fn list_tools(&self) -> Vec<McpToolDefinition> {
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
                description: "Safely read text or data from a remote or local file".to_string(),
                input_schema: json!({
                    "type": "object",
                    "required": ["connection_id", "path"],
                    "properties": {
                        "connection_id": { "type": "string", "description": "Session ID" },
                        "path": { "type": "string", "description": "File path to read" },
                        "offset": { "type": "integer", "description": "Optional byte offset" },
                        "length": { "type": "integer", "description": "Optional max bytes to read (default 65536)" }
                    }
                }),
            },
            McpToolDefinition {
                name: "fs_write_file".to_string(),
                description: "Safely write or update a file on the target server with automatic audit logging".to_string(),
                input_schema: json!({
                    "type": "object",
                    "required": ["connection_id", "path", "content"],
                    "properties": {
                        "connection_id": { "type": "string", "description": "Session ID" },
                        "path": { "type": "string", "description": "File path to write" },
                        "content": { "type": "string", "description": "Text or base64 file content" }
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
                name: "exec_smart_action".to_string(),
                description: "Execute a pre-vetted, safe smart command (e.g. tar-compress, systemctl, disk-usage) with parameter validation".to_string(),
                input_schema: json!({
                    "type": "object",
                    "required": ["connection_id", "action_id", "params"],
                    "properties": {
                        "connection_id": { "type": "string", "description": "Session ID" },
                        "action_id": { "type": "string", "description": "Action ID (e.g. 'tar-compress', 'disk-usage')" },
                        "current_dir": { "type": "string", "description": "Working directory" },
                        "selected_paths": { "type": "array", "items": { "type": "string" } },
                        "params": { "type": "object", "description": "Key-value arguments matching the action schema" }
                    }
                }),
            },
        ]
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

        match tool_name {
            "session_list" => {
                let conns = self.connections.read().await;
                let list: Vec<String> = conns.keys().cloned().collect();
                self.audit_logger
                    .log(
                        agent_id,
                        tool_name,
                        "none",
                        "listing sessions",
                        "success",
                        None,
                    )
                    .await;
                McpToolResult::success_text(json!({ "active_sessions": list }).to_string())
            }

            "fs_list_dir" => {
                let path = arguments
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or("/");
                let conns = self.connections.read().await;
                if let Some(vfs) = conns.get(conn_id) {
                    match vfs.list_dir(path).await {
                        Ok(entries) => {
                            self.audit_logger
                                .log(agent_id, tool_name, conn_id, path, "success", None)
                                .await;
                            McpToolResult::success_text(json!({ "entries": entries }).to_string())
                        }
                        Err(err) => {
                            self.audit_logger
                                .log(
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
                } else {
                    McpToolResult::error_text(format!(
                        "Connection '{}' not found or inactive",
                        conn_id
                    ))
                }
            }

            "fs_read_file" => {
                let path = arguments.get("path").and_then(|v| v.as_str()).unwrap_or("");
                let offset = arguments.get("offset").and_then(|v| v.as_u64());
                let length = arguments
                    .get("length")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(65536);

                let conns = self.connections.read().await;
                if let Some(vfs) = conns.get(conn_id) {
                    let res = if let Some(off) = offset {
                        vfs.read_range(path, off, length).await
                    } else {
                        vfs.read_file(path).await
                    };

                    match res {
                        Ok(bytes) => {
                            let text = String::from_utf8_lossy(&bytes).to_string();
                            self.audit_logger
                                .log(agent_id, tool_name, conn_id, path, "success", None)
                                .await;
                            McpToolResult::success_text(text)
                        }
                        Err(err) => {
                            self.audit_logger
                                .log(
                                    agent_id,
                                    tool_name,
                                    conn_id,
                                    path,
                                    &format!("error: {}", err),
                                    None,
                                )
                                .await;
                            McpToolResult::error_text(format!("Failed to read file: {}", err))
                        }
                    }
                } else {
                    McpToolResult::error_text(format!("Connection '{}' not found", conn_id))
                }
            }

            "fs_write_file" => {
                let path = arguments.get("path").and_then(|v| v.as_str()).unwrap_or("");
                let content = arguments
                    .get("content")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                let conns = self.connections.read().await;
                if let Some(vfs) = conns.get(conn_id) {
                    match vfs
                        .write_file(path, Bytes::from(content.as_bytes().to_vec()))
                        .await
                    {
                        Ok(_) => {
                            self.audit_logger
                                .log(
                                    agent_id,
                                    tool_name,
                                    conn_id,
                                    path,
                                    "success",
                                    Some(format!("Wrote {} bytes", content.len())),
                                )
                                .await;
                            McpToolResult::success_text(format!(
                                "File written successfully: {}",
                                path
                            ))
                        }
                        Err(err) => {
                            self.audit_logger
                                .log(
                                    agent_id,
                                    tool_name,
                                    conn_id,
                                    path,
                                    &format!("error: {}", err),
                                    None,
                                )
                                .await;
                            McpToolResult::error_text(format!("Failed to write file: {}", err))
                        }
                    }
                } else {
                    McpToolResult::error_text(format!("Connection '{}' not found", conn_id))
                }
            }

            "fs_search" => {
                let pattern = arguments
                    .get("pattern")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let root = arguments
                    .get("root_path")
                    .and_then(|v| v.as_str())
                    .unwrap_or("/");

                let conns = self.connections.read().await;
                if let Some(vfs) = conns.get(conn_id) {
                    match vfs.search(root, pattern, 50).await {
                        Ok(results) => {
                            self.audit_logger
                                .log(agent_id, tool_name, conn_id, pattern, "success", None)
                                .await;
                            McpToolResult::success_text(json!({ "matches": results }).to_string())
                        }
                        Err(err) => McpToolResult::error_text(format!("Search failed: {}", err)),
                    }
                } else {
                    McpToolResult::error_text(format!("Connection '{}' not found", conn_id))
                }
            }

            "exec_smart_action" => {
                let action_id = arguments
                    .get("action_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let current_dir = arguments
                    .get("current_dir")
                    .and_then(|v| v.as_str())
                    .unwrap_or("/");
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
                if let Some(act) = actions.iter().find(|a| a.id == action_id) {
                    let ctx = ActionContext::new(current_dir, selected);
                    match ActionExecutor::render_command(act, &ctx, &params_map) {
                        Ok(rendered_cmd) => {
                            self.audit_logger
                                .log(
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
                                    "rendered_command": rendered_cmd
                                })
                                .to_string(),
                            )
                        }
                        Err(err) => {
                            McpToolResult::error_text(format!("Action validation failed: {}", err))
                        }
                    }
                } else {
                    McpToolResult::error_text(format!(
                        "Action '{}' not found in catalog",
                        action_id
                    ))
                }
            }

            unknown => McpToolResult::error_text(format!("Unknown tool: {}", unknown)),
        }
    }

    /// Process raw JSON-RPC request and produce JSON-RPC response
    pub async fn handle_rpc(&self, raw_json: &str) -> Option<JsonRpcResponse> {
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

        let req_id = req.id.unwrap_or(Value::Null);

        match req.method.as_str() {
            "initialize" => Some(JsonRpcResponse::success(
                req_id,
                json!({
                    "protocolVersion": "2024-11-05",
                    "serverInfo": {
                        "name": "RustSCP MCP Gateway",
                        "version": "0.1.0"
                    },
                    "capabilities": {
                        "tools": {}
                    }
                }),
            )),

            "tools/list" => {
                let tools = self.list_tools();
                Some(JsonRpcResponse::success(req_id, json!({ "tools": tools })))
            }

            "tools/call" => {
                let params = req.params.unwrap_or(json!({}));
                let tool_name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let args = params.get("arguments").cloned().unwrap_or(json!({}));
                let agent_id = params
                    .get("agent_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("ai-agent");

                let result = self.handle_tool_call(agent_id, tool_name, &args).await;
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
    }
}

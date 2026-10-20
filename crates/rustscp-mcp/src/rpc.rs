//! MCP JSON-RPC 2.0 dispatch, independent of the transport and of where tools run.
//!
//! An [`RpcSession`] answers `initialize`, `ping` and `tools/list` itself and hands
//! `tools/call` to a [`ToolBackend`]: the [`McpServer`](crate::McpServer) inside the app,
//! or the bridge that forwards calls to the running app.

use crate::protocol::{JsonRpcRequest, JsonRpcResponse, McpToolDefinition, McpToolResult};
use crate::server::{McpServer, SUPPORTED_PROTOCOL_VERSIONS};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub const PARSE_ERROR: i32 = -32700;
pub const INVALID_REQUEST: i32 = -32600;
pub const METHOD_NOT_FOUND: i32 = -32601;
pub const INVALID_PARAMS: i32 = -32602;

/// Longest agent label kept from a client's `clientInfo.name`.
const MAX_CLIENT_NAME_CHARS: usize = 64;

/// Sent to clients in the `initialize` result (MCP `instructions`).
const SERVER_INSTRUCTIONS: &str = "RustSCP gives you the servers the user has connected in the RustSCP app (SFTP, S3, FTP). Call session_list first and pass one of its connection_id values to the other tools. Saved passwords and keys are never exposed. Every call is recorded in the RustSCP activity log, and fs_write_file waits until the user allows the change in the RustSCP window.";

/// Runs the `tools/call` requests of an [`RpcSession`].
#[async_trait]
pub trait ToolBackend: Send + Sync {
    /// Tools announced by `tools/list`.
    fn list_tools(&self) -> Vec<McpToolDefinition> {
        McpServer::tool_definitions()
    }

    async fn call_tool(&self, agent_id: &str, name: &str, arguments: &Value) -> McpToolResult;
}

/// State of one MCP client connection (one stdio stream).
pub struct RpcSession<B: ?Sized> {
    backend: Arc<B>,
    /// Name recorded in the audit log for this client's calls.
    agent_id: Mutex<String>,
    /// Transport name ("stdio"); when set, `initialize` relabels the agent after the
    /// client's `clientInfo.name`, e.g. "claude-code (stdio)".
    transport: Option<String>,
    /// Set once `initialize` has been answered.
    initialized: AtomicBool,
}

impl<B: ToolBackend + ?Sized> RpcSession<B> {
    pub fn new(backend: Arc<B>, agent_id: &str, transport: Option<&str>) -> Self {
        Self {
            backend,
            agent_id: Mutex::new(agent_id.to_string()),
            transport: transport.map(str::to_string),
            initialized: AtomicBool::new(false),
        }
    }

    /// Whether `initialize` has been answered. Until then a stream transport handles
    /// messages one at a time, so no call runs before the client is named.
    pub fn is_initialized(&self) -> bool {
        self.initialized.load(Ordering::SeqCst)
    }

    /// Agent name recorded for the next tool call.
    pub fn agent_id(&self) -> String {
        self.agent_id
            .lock()
            .map(|a| a.clone())
            .unwrap_or_else(|e| e.into_inner().clone())
    }

    /// One raw message (a request object or a batch array) to the serialized reply, or
    /// `None` when nothing must be sent back (notifications, client responses).
    pub async fn handle_line(&self, raw: &str) -> Option<String> {
        let raw = raw.trim();
        if raw.is_empty() {
            return None;
        }
        match parse_message(raw) {
            Ok(message) => self.handle_value(message).await,
            Err(reply) => Some(reply),
        }
    }

    /// [`handle_line`](Self::handle_line) for a message that is already parsed.
    pub async fn handle_value(&self, message: Value) -> Option<String> {
        match message {
            // JSON-RPC batch (MCP 2025-03-26).
            Value::Array(items) => {
                if items.is_empty() {
                    let err = JsonRpcResponse::error(
                        Value::Null,
                        INVALID_REQUEST,
                        "Invalid Request: empty batch",
                    );
                    return serde_json::to_string(&err).ok();
                }
                let mut replies = Vec::new();
                for item in items {
                    if let Some(reply) = self.handle_message(item).await {
                        replies.push(reply);
                    }
                }
                if replies.is_empty() {
                    None
                } else {
                    serde_json::to_string(&replies).ok()
                }
            }
            single => {
                let reply = self.handle_message(single).await?;
                serde_json::to_string(&reply).ok()
            }
        }
    }

    /// One JSON-RPC message to its response. Notifications (no `id`) and responses sent by
    /// the client never get one.
    pub async fn handle_message(&self, message: Value) -> Option<JsonRpcResponse> {
        let Some(obj) = message.as_object() else {
            return Some(JsonRpcResponse::error(
                Value::Null,
                INVALID_REQUEST,
                "Invalid Request: expected a JSON object",
            ));
        };
        let raw_id = obj.get("id").cloned();
        if !obj.contains_key("method") {
            // A response to a server-to-client request; this server never sends any.
            if obj.contains_key("result") || obj.contains_key("error") {
                return None;
            }
            return Some(JsonRpcResponse::error(
                raw_id.unwrap_or(Value::Null),
                INVALID_REQUEST,
                "Invalid Request: missing method",
            ));
        }
        if raw_id
            .as_ref()
            .is_some_and(|id| !(id.is_string() || id.is_number()))
        {
            return Some(JsonRpcResponse::error(
                Value::Null,
                INVALID_REQUEST,
                "Invalid Request: id must be a string or a number",
            ));
        }
        let req: JsonRpcRequest = match serde_json::from_value(message) {
            Ok(r) => r,
            Err(e) => {
                return Some(JsonRpcResponse::error(
                    raw_id.unwrap_or(Value::Null),
                    INVALID_REQUEST,
                    format!("Invalid Request: {e}"),
                ));
            }
        };

        let Some(req_id) = req.id.clone() else {
            // Notification ("notifications/initialized", ...): never answered. The transport,
            // which owns the running requests, acts on "notifications/cancelled".
            return None;
        };

        if req.jsonrpc != "2.0" {
            return Some(JsonRpcResponse::error(
                req_id,
                INVALID_REQUEST,
                "Invalid Request: jsonrpc must be \"2.0\"",
            ));
        }

        match req.method.as_str() {
            "initialize" => {
                let params = req.params.as_ref();
                let requested = params
                    .and_then(|p| p.get("protocolVersion"))
                    .and_then(|v| v.as_str());
                let version = match requested {
                    Some(v) if SUPPORTED_PROTOCOL_VERSIONS.contains(&v) => v,
                    _ => SUPPORTED_PROTOCOL_VERSIONS
                        .last()
                        .copied()
                        .unwrap_or("2024-11-05"),
                };
                if let Some(transport) = &self.transport {
                    let client = params
                        .and_then(|p| p.get("clientInfo"))
                        .and_then(|c| c.get("name"))
                        .and_then(|n| n.as_str())
                        .map(sanitize_client_name)
                        .filter(|n| !n.is_empty());
                    if let Some(client) = client {
                        let label = format!("{client} ({transport})");
                        match self.agent_id.lock() {
                            Ok(mut a) => *a = label,
                            Err(e) => *e.into_inner() = label,
                        }
                    }
                }
                self.initialized.store(true, Ordering::SeqCst);
                Some(JsonRpcResponse::success(
                    req_id,
                    json!({
                        "protocolVersion": version,
                        "serverInfo": {
                            "name": "RustSCP MCP Gateway",
                            "version": env!("CARGO_PKG_VERSION")
                        },
                        "capabilities": {
                            "tools": { "listChanged": false }
                        },
                        "instructions": SERVER_INSTRUCTIONS
                    }),
                ))
            }

            "tools/list" => {
                let tools = self.backend.list_tools();
                Some(JsonRpcResponse::success(req_id, json!({ "tools": tools })))
            }

            "tools/call" => {
                let params = req.params.unwrap_or_else(|| json!({}));
                let Some(tool_name) = params.get("name").and_then(|v| v.as_str()) else {
                    return Some(JsonRpcResponse::error(
                        req_id,
                        INVALID_PARAMS,
                        "Invalid params: tools/call needs a tool name",
                    ));
                };
                let args = match params.get("arguments") {
                    None | Some(Value::Null) => json!({}),
                    Some(v @ Value::Object(_)) => v.clone(),
                    Some(_) => {
                        return Some(JsonRpcResponse::error(
                            req_id,
                            INVALID_PARAMS,
                            "Invalid params: arguments must be an object",
                        ));
                    }
                };
                let agent_id = self.agent_id();
                // An agent id claimed in the request is only noted, never trusted.
                let recorded_agent = match params.get("agent_id").and_then(|v| v.as_str()) {
                    Some(claimed) if claimed != agent_id => {
                        format!("{agent_id} (claimed: {})", sanitize_client_name(claimed))
                    }
                    _ => agent_id,
                };

                let result = self
                    .backend
                    .call_tool(&recorded_agent, tool_name, &args)
                    .await;
                Some(JsonRpcResponse::success(req_id, json!(result)))
            }

            "ping" => Some(JsonRpcResponse::success(req_id, json!({}))),

            unknown => Some(JsonRpcResponse::error(
                req_id,
                METHOD_NOT_FOUND,
                format!("Method '{}' not found", unknown),
            )),
        }
    }
}

/// `raw` as JSON, or the serialized parse-error reply.
pub(crate) fn parse_message(raw: &str) -> Result<Value, String> {
    serde_json::from_str(raw).map_err(|e| {
        let err = JsonRpcResponse::error(Value::Null, PARSE_ERROR, format!("Parse error: {e}"));
        serde_json::to_string(&err).unwrap_or_default()
    })
}

/// Map key for a JSON-RPC request id (`1` and `"1"` stay distinct).
pub(crate) fn request_key(id: &Value) -> Option<String> {
    (id.is_string() || id.is_number()).then(|| id.to_string())
}

/// Id of the request a single message can be cancelled by, if it is one. Calls inside a
/// batch are answered together, so they run to completion.
pub(crate) fn cancellable_request(message: &Value) -> Option<String> {
    let obj = message.as_object()?;
    if !obj.get("method").is_some_and(Value::is_string) {
        return None;
    }
    request_key(obj.get("id")?)
}

/// Requests named by the `notifications/cancelled` messages in `message` (an object or a
/// batch).
pub(crate) fn cancelled_requests(message: &Value) -> Vec<String> {
    let requested = |m: &Value| {
        let obj = m.as_object()?;
        if obj.contains_key("id")
            || obj.get("method").and_then(Value::as_str) != Some("notifications/cancelled")
        {
            return None;
        }
        request_key(obj.get("params")?.get("requestId")?)
    };
    match message {
        Value::Array(items) => items.iter().filter_map(requested).collect(),
        single => requested(single).into_iter().collect(),
    }
}

/// Client-supplied names end up in the audit log and the approval dialog: printable
/// characters only, bounded length.
pub(crate) fn sanitize_client_name(name: &str) -> String {
    sanitize_label(name, MAX_CLIENT_NAME_CHARS)
}

/// `label` without control characters, at most `max_chars` long, trimmed.
pub(crate) fn sanitize_label(label: &str, max_chars: usize) -> String {
    label
        .chars()
        .filter(|c| !c.is_control())
        .take(max_chars)
        .collect::<String>()
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Records what reached the backend and echoes it back.
    #[derive(Default)]
    struct EchoBackend {
        calls: Mutex<Vec<(String, String, Value)>>,
    }

    #[async_trait]
    impl ToolBackend for EchoBackend {
        async fn call_tool(&self, agent_id: &str, name: &str, arguments: &Value) -> McpToolResult {
            self.calls.lock().unwrap().push((
                agent_id.to_string(),
                name.to_string(),
                arguments.clone(),
            ));
            McpToolResult::success_text(format!("{name} {arguments}"))
        }
    }

    fn session() -> (Arc<EchoBackend>, RpcSession<EchoBackend>) {
        let backend = Arc::new(EchoBackend::default());
        let session = RpcSession::new(backend.clone(), "mcp-stdio", Some("stdio"));
        (backend, session)
    }

    async fn reply(session: &RpcSession<EchoBackend>, raw: &str) -> Value {
        serde_json::from_str(&session.handle_line(raw).await.expect("a reply")).unwrap()
    }

    #[tokio::test]
    async fn initialize_negotiates_version_and_labels_the_agent() {
        let (backend, session) = session();
        let v = reply(
            &session,
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"claude-code","version":"2.0"}}}"#,
        )
        .await;
        assert_eq!(v["id"], 1);
        assert_eq!(v["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(v["result"]["capabilities"]["tools"]["listChanged"], false);
        assert!(v["result"]["instructions"]
            .as_str()
            .unwrap()
            .contains("session_list"));
        assert!(v.get("error").is_none());
        assert_eq!(session.agent_id(), "claude-code (stdio)");
        assert!(session.is_initialized());

        session
            .handle_line(r#"{"jsonrpc":"2.0","id":"a","method":"tools/call","params":{"name":"session_list"}}"#)
            .await
            .unwrap();
        assert_eq!(backend.calls.lock().unwrap()[0].0, "claude-code (stdio)");
    }

    #[tokio::test]
    async fn tools_call_routes_name_and_arguments_and_keeps_the_id() {
        let (backend, session) = session();
        let v = reply(
            &session,
            r#"{"jsonrpc":"2.0","id":"req-7","method":"tools/call","params":{"name":"fs_list_dir","arguments":{"connection_id":"prod","path":"/etc"}}}"#,
        )
        .await;
        assert_eq!(v["id"], "req-7");
        assert_eq!(v["result"]["isError"], false);
        assert_eq!(v["result"]["content"][0]["type"], "text");
        let calls = backend.calls.lock().unwrap();
        assert_eq!(calls[0].1, "fs_list_dir");
        assert_eq!(calls[0].2["path"], "/etc");
    }

    #[tokio::test]
    async fn tools_list_comes_from_the_backend() {
        let (_, session) = session();
        let v = reply(
            &session,
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"#,
        )
        .await;
        let names: Vec<&str> = v["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"session_list"));
        assert!(names.contains(&"fs_read_file"));
        assert!(v["result"]["tools"][0]["inputSchema"].is_object());
    }

    #[tokio::test]
    async fn malformed_messages_get_json_rpc_errors() {
        let (backend, session) = session();
        let v = reply(&session, "{not json").await;
        assert_eq!(v["error"]["code"], PARSE_ERROR);
        assert_eq!(v["id"], Value::Null);

        let v = reply(&session, r#"{"jsonrpc":"2.0","id":3}"#).await;
        assert_eq!(v["error"]["code"], INVALID_REQUEST);
        assert_eq!(v["id"], 3);

        let v = reply(&session, r#"{"jsonrpc":"2.0","id":null,"method":"ping"}"#).await;
        assert_eq!(v["error"]["code"], INVALID_REQUEST);

        let v = reply(&session, r#"{"jsonrpc":"1.0","id":4,"method":"ping"}"#).await;
        assert_eq!(v["error"]["code"], INVALID_REQUEST);

        let v = reply(&session, r#"{"jsonrpc":"2.0","id":5,"method":42}"#).await;
        assert_eq!(v["error"]["code"], INVALID_REQUEST);

        let v = reply(
            &session,
            r#"{"jsonrpc":"2.0","id":6,"method":"resources/list"}"#,
        )
        .await;
        assert_eq!(v["error"]["code"], METHOD_NOT_FOUND);

        let v = reply(
            &session,
            r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{}}"#,
        )
        .await;
        assert_eq!(v["error"]["code"], INVALID_PARAMS);
        let v = reply(
            &session,
            r#"{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"x","arguments":[1]}}"#,
        )
        .await;
        assert_eq!(v["error"]["code"], INVALID_PARAMS);

        let v = reply(&session, "[]").await;
        assert_eq!(v["error"]["code"], INVALID_REQUEST);
        assert!(backend.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn notifications_and_client_responses_are_never_answered() {
        let (_, session) = session();
        for raw in [
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
            r#"{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}"#,
            r#"{"jsonrpc":"2.0","method":"unknown/thing"}"#,
            r#"{"jsonrpc":"2.0","id":9,"result":{}}"#,
            "   ",
            r#"[{"jsonrpc":"2.0","method":"notifications/initialized"}]"#,
        ] {
            assert!(session.handle_line(raw).await.is_none(), "{raw}");
        }
    }

    #[test]
    fn cancellation_ids_come_from_single_requests_and_cancel_notifications() {
        let call = |id: Value| json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call" });
        assert_eq!(cancellable_request(&call(json!(7))).as_deref(), Some("7"));
        assert_eq!(
            cancellable_request(&call(json!("7"))).as_deref(),
            Some("\"7\"")
        );
        assert_eq!(cancellable_request(&call(Value::Null)), None);
        assert_eq!(cancellable_request(&json!([call(json!(1))])), None);
        assert_eq!(
            cancellable_request(
                &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })
            ),
            None
        );

        let cancel = |id: Value| json!({ "jsonrpc": "2.0", "method": "notifications/cancelled", "params": { "requestId": id, "reason": "user" } });
        assert_eq!(cancelled_requests(&cancel(json!(7))), vec!["7"]);
        assert_eq!(
            cancelled_requests(&json!([cancel(json!("a")), call(json!(1))])),
            vec!["\"a\""]
        );
        assert!(cancelled_requests(&cancel(Value::Null)).is_empty());
        assert!(cancelled_requests(&call(json!(7))).is_empty());
        // A request (with an id) named like the notification is not a cancellation.
        let mut not_a_notification = cancel(json!(7));
        not_a_notification["id"] = json!(3);
        assert!(cancelled_requests(&not_a_notification).is_empty());
    }

    #[tokio::test]
    async fn batches_answer_every_request() {
        let (_, session) = session();
        let v = reply(
            &session,
            r#"[{"jsonrpc":"2.0","id":1,"method":"ping"},{"jsonrpc":"2.0","method":"notifications/initialized"},{"jsonrpc":"2.0","id":2,"method":"nope"}]"#,
        )
        .await;
        let arr = v.as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["id"], 1);
        assert_eq!(arr[0]["result"], json!({}));
        assert_eq!(arr[1]["error"]["code"], METHOD_NOT_FOUND);
    }

    #[tokio::test]
    async fn claimed_agent_ids_and_client_names_are_sanitized() {
        let (backend, session) = session();
        session
            .handle_line(
                r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"evil\nname"}}}"#,
            )
            .await;
        assert_eq!(session.agent_id(), "evilname (stdio)");
        session
            .handle_line(
                r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"session_list","agent_id":"admin"}}"#,
            )
            .await;
        assert_eq!(
            backend.calls.lock().unwrap()[0].0,
            "evilname (stdio) (claimed: admin)"
        );
    }
}

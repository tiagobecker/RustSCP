//! End to end: an MCP client on stdio -> bridge -> app gateway -> a connected session.

use async_trait::async_trait;
use rustscp_core::LocalFsDriver;
use rustscp_mcp::ipc::{endpoint_file_path, EndpointInfo};
use rustscp_mcp::{
    ApprovalDecision, ApprovalRequest, AuditLogger, ConnectionInfo, EndpointKind, McpGateway,
    McpServer, ToolApprover,
};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader, Lines};

const TIMEOUT: Duration = Duration::from_secs(10);

struct RecordingApprover {
    allow: bool,
    seen: Mutex<Vec<ApprovalRequest>>,
}

#[async_trait]
impl ToolApprover for RecordingApprover {
    async fn approve(&self, request: ApprovalRequest) -> ApprovalDecision {
        self.seen.lock().unwrap().push(request);
        if self.allow {
            ApprovalDecision::Approved
        } else {
            ApprovalDecision::Denied("rejected by the user".into())
        }
    }
}

/// App side: a server with one "connected" session rooted in a temp folder.
async fn app_with_session(files: &Path) -> (Arc<McpServer>, AuditLogger) {
    std::fs::write(files.join("hello.txt"), "hello from the server\n").unwrap();
    std::fs::create_dir(files.join("etc")).unwrap();
    std::fs::write(files.join("etc").join("app.conf"), "port=8080\n").unwrap();
    let audit = AuditLogger::new();
    let server = Arc::new(McpServer::new(audit.clone()));
    server
        .register_session(
            "demo".into(),
            ConnectionInfo {
                name: "Demo server".into(),
                protocol: "sftp".into(),
                host: "demo.example".into(),
            },
            Arc::new(LocalFsDriver::new()),
        )
        .await;
    (server, audit)
}

/// Client side of an MCP stdio stream.
struct Client<W> {
    write: W,
    lines: Lines<Box<dyn tokio::io::AsyncBufRead + Unpin + Send>>,
    next_id: u64,
}

impl<W: AsyncWrite + Unpin> Client<W> {
    async fn send(&mut self, message: Value) {
        let mut line = message.to_string();
        line.push('\n');
        self.write.write_all(line.as_bytes()).await.unwrap();
        self.write.flush().await.unwrap();
    }

    async fn request(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        let id = self.next_id;
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
            .await;
        let line = tokio::time::timeout(TIMEOUT, self.lines.next_line())
            .await
            .expect("reply in time")
            .unwrap()
            .expect("a reply line");
        let reply: Value = serde_json::from_str(&line).unwrap_or_else(|e| panic!("{e}: {line}"));
        assert_eq!(reply["jsonrpc"], "2.0");
        assert_eq!(reply["id"], id, "{reply}");
        reply
    }

    async fn call(&mut self, tool: &str, arguments: Value) -> (bool, String) {
        let reply = self
            .request(
                "tools/call",
                json!({ "name": tool, "arguments": arguments }),
            )
            .await;
        let result = &reply["result"];
        let text = result["content"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        (result["isError"] == true, text)
    }

    async fn initialize(&mut self) -> Value {
        let reply = self
            .request(
                "initialize",
                json!({
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": { "name": "test-agent", "version": "1.0" }
                }),
            )
            .await;
        self.send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
            .await;
        reply
    }
}

/// Runs the bridge in-process over an in-memory "stdio" pair.
fn start_bridge(config_dir: &Path) -> Client<tokio::io::WriteHalf<tokio::io::DuplexStream>> {
    let (client, server) = tokio::io::duplex(1024 * 1024);
    let (server_read, server_write) = tokio::io::split(server);
    tokio::spawn(rustscp_mcp::bridge::serve_bridge(
        server_read,
        server_write,
        config_dir.to_path_buf(),
    ));
    let (client_read, client_write) = tokio::io::split(client);
    let reader: Box<dyn tokio::io::AsyncBufRead + Unpin + Send> =
        Box::new(BufReader::new(client_read));
    Client {
        write: client_write,
        lines: reader.lines(),
        next_id: 0,
    }
}

async fn list_and_read(kind: EndpointKind) {
    let config = tempfile::tempdir().unwrap();
    let files = tempfile::tempdir().unwrap();
    let (server, audit) = app_with_session(files.path()).await;
    let gateway = McpGateway::start_with(server, config.path(), kind)
        .await
        .unwrap();

    let mut agent = start_bridge(config.path());
    let init = agent.initialize().await;
    assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(init["result"]["serverInfo"]["name"], "RustSCP MCP Gateway");

    let tools = agent.request("tools/list", json!({})).await;
    let names: Vec<&str> = tools["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    for expected in [
        "session_list",
        "fs_list_dir",
        "fs_read_file",
        "fs_write_file",
    ] {
        assert!(names.contains(&expected), "{names:?}");
    }

    let (is_error, text) = agent.call("session_list", json!({})).await;
    assert!(!is_error, "{text}");
    let sessions: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(sessions["sessions"][0]["connection_id"], "demo");
    assert_eq!(sessions["sessions"][0]["name"], "Demo server");
    assert_eq!(gateway.connected_clients(), 1);

    let root = files.path().to_str().unwrap();
    let (is_error, text) = agent
        .call(
            "fs_list_dir",
            json!({ "connection_id": "demo", "path": root }),
        )
        .await;
    assert!(!is_error, "{text}");
    let listing: Value = serde_json::from_str(&text).unwrap();
    let entries: Vec<&str> = listing["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    assert!(
        entries.contains(&"hello.txt") && entries.contains(&"etc"),
        "{entries:?}"
    );

    let conf = files.path().join("etc").join("app.conf");
    let (is_error, text) = agent
        .call(
            "fs_read_file",
            json!({ "connection_id": "demo", "path": conf.to_str().unwrap() }),
        )
        .await;
    assert!(!is_error, "{text}");
    assert_eq!(text, "port=8080\n");

    // The unrestricted local filesystem is not reachable.
    let (is_error, _) = agent
        .call(
            "fs_list_dir",
            json!({ "connection_id": "local", "path": "/" }),
        )
        .await;
    assert!(is_error);

    // Every call reached the app's audit log under the client's name.
    let events = audit.get_recent_events(10).await;
    assert!(events
        .iter()
        .any(|e| e.tool_name == "fs_read_file" && e.status == "success"));
    assert!(
        events.iter().all(|e| e.agent_id == "test-agent (stdio)"),
        "{events:?}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn agent_lists_and_reads_a_session_over_a_unix_socket() {
    list_and_read(EndpointKind::Unix).await;
}

#[tokio::test]
async fn agent_lists_and_reads_a_session_over_loopback_tcp() {
    list_and_read(EndpointKind::Tcp).await;
}

#[tokio::test]
async fn writes_go_through_the_app_approval() {
    let config = tempfile::tempdir().unwrap();
    let files = tempfile::tempdir().unwrap();
    let (server, audit) = app_with_session(files.path()).await;
    let approver = Arc::new(RecordingApprover {
        allow: false,
        seen: Mutex::new(Vec::new()),
    });
    server.set_approver(approver.clone());
    let _gateway = McpGateway::start(server.clone(), config.path())
        .await
        .unwrap();
    let mut agent = start_bridge(config.path());
    agent.initialize().await;

    let target = files.path().join("hello.txt");
    let args =
        json!({ "connection_id": "demo", "path": target.to_str().unwrap(), "content": "changed" });
    let (is_error, text) = agent.call("fs_write_file", args.clone()).await;
    assert!(is_error);
    assert!(text.contains("not allowed"), "{text}");
    assert_eq!(
        std::fs::read_to_string(&target).unwrap(),
        "hello from the server\n"
    );
    {
        let seen = approver.seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].agent_id, "test-agent (stdio)");
        assert_eq!(seen[0].connection_name, "Demo server");
        assert_eq!(seen[0].preview.as_deref(), Some("changed"));
    }
    assert_eq!(
        audit.get_recent_events(1).await[0].status,
        "denied: rejected by the user"
    );

    server.set_approver(Arc::new(RecordingApprover {
        allow: true,
        seen: Mutex::new(Vec::new()),
    }));
    let (is_error, text) = agent.call("fs_write_file", args).await;
    assert!(!is_error, "{text}");
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "changed");
    assert_eq!(audit.get_recent_events(1).await[0].status, "success");
}

#[tokio::test]
async fn bridge_works_before_the_app_starts_and_reconnects() {
    let config = tempfile::tempdir().unwrap();
    let files = tempfile::tempdir().unwrap();
    let mut agent = start_bridge(config.path());

    // No app: the handshake and tool list still work, calls explain what to do.
    agent.initialize().await;
    let tools = agent.request("tools/list", json!({})).await;
    assert!(tools["result"]["tools"].as_array().unwrap().len() >= 5);
    let (is_error, text) = agent.call("session_list", json!({})).await;
    assert!(is_error);
    assert!(text.contains("not running"), "{text}");

    // The app starts: the next call connects.
    let (server, _) = app_with_session(files.path()).await;
    let gateway = McpGateway::start(server.clone(), config.path())
        .await
        .unwrap();
    let (is_error, text) = agent.call("session_list", json!({})).await;
    assert!(!is_error, "{text}");

    // The app quits: calls fail cleanly instead of hanging...
    drop(gateway);
    assert!(!endpoint_file_path(config.path()).exists());
    let (is_error, _) = agent.call("session_list", json!({})).await;
    assert!(is_error);

    // ...and work again once it is back.
    let _gateway = McpGateway::start(server, config.path()).await.unwrap();
    let (is_error, text) = agent.call("session_list", json!({})).await;
    assert!(!is_error, "{text}");
}

#[tokio::test]
async fn gateway_rejects_a_wrong_token_and_keeps_its_files_private() {
    let config = tempfile::tempdir().unwrap();
    let files = tempfile::tempdir().unwrap();
    let (server, _) = app_with_session(files.path()).await;
    let gateway = McpGateway::start(server, config.path()).await.unwrap();

    let path = endpoint_file_path(config.path());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        if let rustscp_mcp::ipc::Endpoint::Unix { path } = gateway.endpoint() {
            let mode = std::fs::metadata(path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    // A bridge with a stale token is turned away and never sees a session.
    let mut info: EndpointInfo = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    info.token = "0".repeat(64);
    std::fs::write(&path, serde_json::to_vec(&info).unwrap()).unwrap();
    let mut agent = start_bridge(config.path());
    agent.initialize().await;
    let (is_error, text) = agent.call("session_list", json!({})).await;
    assert!(is_error);
    assert!(text.contains("refused"), "{text}");
    assert_eq!(gateway.connected_clients(), 0);
}

/// The shipped binary: stdout carries nothing but protocol lines.
#[tokio::test]
async fn stdio_binary_serves_a_real_session() {
    let config = tempfile::tempdir().unwrap();
    let files = tempfile::tempdir().unwrap();
    let (server, _) = app_with_session(files.path()).await;
    let _gateway = McpGateway::start(server, config.path()).await.unwrap();

    let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_rustscp-mcp"))
        .env("RUSTSCP_CONFIG_DIR", config.path())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let stdout: Box<dyn tokio::io::AsyncBufRead + Unpin + Send> =
        Box::new(BufReader::new(child.stdout.take().unwrap()));
    let mut agent = Client {
        write: child.stdin.take().unwrap(),
        lines: stdout.lines(),
        next_id: 0,
    };

    agent.initialize().await;
    let hello = files.path().join("hello.txt");
    let (is_error, text) = agent
        .call(
            "fs_read_file",
            json!({ "connection_id": "demo", "path": hello.to_str().unwrap() }),
        )
        .await;
    assert!(!is_error, "{text}");
    assert_eq!(text, "hello from the server\n");

    // Closing stdin shuts the server down.
    drop(agent.write);
    let status = tokio::time::timeout(TIMEOUT, child.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(status.success());
    assert!(agent.lines.next_line().await.unwrap().is_none());
}

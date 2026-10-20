//! End to end: an MCP client on stdio -> bridge -> app gateway -> a connected session.

use async_trait::async_trait;
use bytes::Bytes;
use rustscp_core::{
    CoreResult, FileEntry, FileSystemInfo, FindFileMatch, FindFileQuery, LocalFsDriver, Protocol,
    VirtualFileSystem,
};
use rustscp_mcp::ipc::{endpoint_file_path, EndpointInfo};
use rustscp_mcp::{
    ApprovalDecision, ApprovalRequest, AuditLogger, ConnectionInfo, EndpointKind, GatewaySettings,
    McpGateway, McpServer, ToolApprover,
};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader, Lines};
use tokio::sync::Notify;

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

/// Never answers, like an unanswered dialog; tells when it is asked and withdrawn.
#[derive(Default)]
struct PendingApprover {
    asked: Notify,
    withdrawn: Notify,
}

struct Withdrawn<'a>(&'a Notify);

impl Drop for Withdrawn<'_> {
    fn drop(&mut self) {
        self.0.notify_one();
    }
}

#[async_trait]
impl ToolApprover for PendingApprover {
    async fn approve(&self, _request: ApprovalRequest) -> ApprovalDecision {
        let _withdrawn = Withdrawn(&self.withdrawn);
        self.asked.notify_one();
        std::future::pending().await
    }
}

/// Local files whose writes wait for `release`; `writing` fires when one starts.
#[derive(Debug, Default)]
struct GatedFs {
    inner: LocalFsDriver,
    writing: Notify,
    release: Notify,
}

#[async_trait]
impl VirtualFileSystem for GatedFs {
    fn protocol(&self) -> Protocol {
        self.inner.protocol()
    }
    async fn list_dir(&self, path: &str) -> CoreResult<Vec<FileEntry>> {
        self.inner.list_dir(path).await
    }
    async fn metadata(&self, path: &str) -> CoreResult<FileEntry> {
        self.inner.metadata(path).await
    }
    async fn read_file(&self, path: &str) -> CoreResult<Bytes> {
        self.inner.read_file(path).await
    }
    async fn read_range(&self, path: &str, offset: u64, length: u64) -> CoreResult<Bytes> {
        self.inner.read_range(path, offset, length).await
    }
    async fn write_file(&self, path: &str, data: Bytes) -> CoreResult<()> {
        self.writing.notify_one();
        self.release.notified().await;
        self.inner.write_file(path, data).await
    }
    async fn create_dir(&self, path: &str) -> CoreResult<()> {
        self.inner.create_dir(path).await
    }
    async fn remove_file(&self, path: &str) -> CoreResult<()> {
        self.inner.remove_file(path).await
    }
    async fn remove_dir(&self, path: &str, recursive: bool) -> CoreResult<()> {
        self.inner.remove_dir(path, recursive).await
    }
    async fn rename(&self, from: &str, to: &str) -> CoreResult<()> {
        self.inner.rename(from, to).await
    }
    async fn set_permissions(&self, path: &str, mode: u32) -> CoreResult<()> {
        self.inner.set_permissions(path, mode).await
    }
    async fn exists(&self, path: &str) -> CoreResult<bool> {
        self.inner.exists(path).await
    }
    async fn search(
        &self,
        root_path: &str,
        pattern: &str,
        max_results: usize,
    ) -> CoreResult<Vec<FileEntry>> {
        self.inner.search(root_path, pattern, max_results).await
    }
    async fn create_symlink(
        &self,
        target: &str,
        link_path: &str,
        is_symbolic: bool,
    ) -> CoreResult<()> {
        self.inner
            .create_symlink(target, link_path, is_symbolic)
            .await
    }
    async fn get_filesystem_info(&self, path: &str) -> CoreResult<FileSystemInfo> {
        self.inner.get_filesystem_info(path).await
    }
    async fn calculate_size(&self, path: &str) -> CoreResult<u64> {
        self.inner.calculate_size(path).await
    }
    async fn find_files(&self, query: &FindFileQuery) -> CoreResult<Vec<FindFileMatch>> {
        self.inner.find_files(query).await
    }
}

async fn within<F: std::future::Future>(what: &str, future: F) -> F::Output {
    tokio::time::timeout(TIMEOUT, future)
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for {what}"))
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

impl<W: AsyncWrite + Unpin> Client<W> {
    /// `tools/call` of `fs_write_file` under `id`, without waiting for the reply.
    async fn start_write(&mut self, id: &str, connection_id: &str, path: &Path, content: &str) {
        self.send(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "tools/call",
            "params": {
                "name": "fs_write_file",
                "arguments": { "connection_id": connection_id, "path": path, "content": content }
            }
        }))
        .await;
    }

    async fn cancel(&mut self, id: &str) {
        self.send(json!({
            "jsonrpc": "2.0",
            "method": "notifications/cancelled",
            "params": { "requestId": id, "reason": "the user interrupted the agent" }
        }))
        .await;
    }

    /// Closes stdin and checks that nothing else was ever answered.
    async fn finish(mut self) {
        self.write.shutdown().await.unwrap();
        let rest = within("the bridge to close", self.lines.next_line())
            .await
            .unwrap();
        assert!(rest.is_none(), "unexpected reply: {rest:?}");
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
async fn cancelling_a_write_withdraws_its_approval_and_it_is_never_answered() {
    let config = tempfile::tempdir().unwrap();
    let files = tempfile::tempdir().unwrap();
    let (server, audit) = app_with_session(files.path()).await;
    let approver = Arc::new(PendingApprover::default());
    server.set_approver(approver.clone());
    let _gateway = McpGateway::start(server, config.path()).await.unwrap();
    let mut agent = start_bridge(config.path());
    agent.initialize().await;

    let target = files.path().join("hello.txt");
    agent
        .start_write("write-1", "demo", &target, "changed")
        .await;
    within("the approval request", approver.asked.notified()).await;
    agent.cancel("write-1").await;
    // The cancellation crossed the bridge and the app dropped the dialog's request.
    within(
        "the approval to be withdrawn",
        approver.withdrawn.notified(),
    )
    .await;

    // The agent keeps working over the same connection; the next reply is its own.
    let (is_error, text) = agent.call("session_list", json!({})).await;
    assert!(!is_error, "{text}");
    assert_eq!(
        std::fs::read_to_string(&target).unwrap(),
        "hello from the server\n"
    );
    assert!(!audit
        .get_recent_events(10)
        .await
        .iter()
        .any(|e| e.tool_name == "fs_write_file" && e.status == "success"));
    agent.finish().await;
}

#[tokio::test]
async fn an_approved_write_finishes_even_when_the_agent_cancels_it() {
    let config = tempfile::tempdir().unwrap();
    let files = tempfile::tempdir().unwrap();
    let (server, audit) = app_with_session(files.path()).await;
    let gated = Arc::new(GatedFs::default());
    server
        .register_session("gated".into(), ConnectionInfo::default(), gated.clone())
        .await;
    server.set_approver(Arc::new(RecordingApprover {
        allow: true,
        seen: Mutex::new(Vec::new()),
    }));
    let _gateway = McpGateway::start(server, config.path()).await.unwrap();
    let mut agent = start_bridge(config.path());
    agent.initialize().await;

    let target = files.path().join("hello.txt");
    agent
        .start_write("write-2", "gated", &target, "changed")
        .await;
    within("the approved write to start", gated.writing.notified()).await;
    agent.cancel("write-2").await;
    // This call reaches the app after the cancellation, so once it is answered the app has
    // dropped the cancelled call.
    let (is_error, text) = agent.call("session_list", json!({})).await;
    assert!(!is_error, "{text}");
    gated.release.notify_one();

    within("the write to finish", async {
        while std::fs::read_to_string(&target).unwrap() != "changed" {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    within("the write to be audited", async {
        while !audit
            .get_recent_events(10)
            .await
            .iter()
            .any(|e| e.tool_name == "fs_write_file" && e.status == "success")
        {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    agent.finish().await;
}

#[tokio::test]
async fn a_turned_off_gateway_tells_the_agent() {
    let config = tempfile::tempdir().unwrap();
    GatewaySettings { enabled: false }
        .save(config.path())
        .unwrap();
    let mut agent = start_bridge(config.path());
    agent.initialize().await;
    let (is_error, text) = agent.call("session_list", json!({})).await;
    assert!(is_error);
    assert!(text.contains("turned off"), "{text}");
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

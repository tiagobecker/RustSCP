//! The MCP stdio server agents launch (`rustscp-desktop --mcp-stdio` or `rustscp-mcp`).
//!
//! It speaks MCP on stdin/stdout itself (so `initialize` and `tools/list` work even
//! before RustSCP is open) and forwards each `tools/call` to the running app over the
//! private channel in [`crate::ipc`]. The app runs the call on its own sessions, with its
//! approvals and audit log; no credential ever reaches this process.

use crate::gateway::GatewaySettings;
use crate::ipc::{
    connect, endpoint_file_path, BoxRead, CallReply, CallRequestRef, CancelCall, EndpointInfo,
    Handshake, ENDPOINT_FORMAT, HANDSHAKE_TIMEOUT, MAX_HANDSHAKE_BYTES, MAX_IPC_MESSAGE_BYTES,
};
use crate::protocol::McpToolResult;
use crate::rpc::{RpcSession, ToolBackend};
use crate::transport::{read_frame, serve, write_lines, Frame, MAX_CONCURRENT_REQUESTS};
use async_trait::async_trait;
use serde_json::Value;
use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::mpsc::{self, error::TrySendError};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

/// Agent label until the client's `initialize` names it.
pub const BRIDGE_AGENT_ID: &str = "mcp-stdio";

const TURNED_OFF: &str = "The RustSCP AI gateway is turned off. Ask the user to turn it on in RustSCP (AI gateway window), then try again.";
const NOT_RUNNING: &str = "RustSCP is not running, so no server sessions are available. Ask the user to open the RustSCP app and connect a server, then try again.";
const CONNECTION_LOST: &str = "The connection to RustSCP closed before it answered (the app may have quit). Ask the user to open RustSCP, then try again.";

/// Serves MCP on this process's stdin/stdout until the client closes stdin.
pub async fn run_stdio_bridge(config_dir: PathBuf) -> io::Result<()> {
    serve_bridge(tokio::io::stdin(), tokio::io::stdout(), config_dir).await
}

/// [`run_stdio_bridge`] over any streams (used by tests).
pub async fn serve_bridge<R, W>(reader: R, writer: W, config_dir: PathBuf) -> io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let backend = Arc::new(AppBridge::new(config_dir));
    let session = Arc::new(RpcSession::new(backend, BRIDGE_AGENT_ID, Some("stdio")));
    serve(reader, writer, session).await
}

/// Forwards tool calls to the running app, connecting (again) when needed.
pub struct AppBridge {
    config_dir: PathBuf,
    connection: tokio::sync::Mutex<Option<Arc<AppConnection>>>,
}

impl AppBridge {
    pub fn new(config_dir: PathBuf) -> Self {
        Self {
            config_dir,
            connection: tokio::sync::Mutex::new(None),
        }
    }

    async fn connection(&self) -> Result<Arc<AppConnection>, String> {
        let mut current = self.connection.lock().await;
        if let Some(conn) = current.as_ref() {
            if conn.shared.alive.load(Ordering::SeqCst) {
                return Ok(conn.clone());
            }
        }
        *current = None;
        let conn = Arc::new(AppConnection::open(&self.config_dir).await?);
        *current = Some(conn.clone());
        Ok(conn)
    }
}

#[async_trait]
impl ToolBackend for AppBridge {
    async fn call_tool(&self, agent_id: &str, name: &str, arguments: &Value) -> McpToolResult {
        let conn = match self.connection().await {
            Ok(c) => c,
            Err(message) => return McpToolResult::error_text(message),
        };
        match conn.call(agent_id, name, arguments).await {
            Ok(result) => result,
            Err(message) => McpToolResult::error_text(message),
        }
    }
}

/// State shared with the task that reads the app's replies.
struct Shared {
    pending: Mutex<HashMap<u64, oneshot::Sender<McpToolResult>>>,
    alive: AtomicBool,
}

impl Shared {
    fn pending(&self) -> std::sync::MutexGuard<'_, HashMap<u64, oneshot::Sender<McpToolResult>>> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Marks the connection dead, then wakes every waiting call with CONNECTION_LOST (by
    /// dropping its sender).
    fn close(&self) {
        self.alive.store(false, Ordering::SeqCst);
        self.pending().clear();
    }
}

/// One authenticated connection to the app; calls are matched to replies by id.
pub struct AppConnection {
    /// Lines for the app. The writer task writes each one whole, so a call dropped midway
    /// never leaves half a line on the socket.
    outgoing: mpsc::Sender<String>,
    shared: Arc<Shared>,
    next_id: AtomicU64,
    /// The app drops a call on a [`CancelCall`] line.
    cancels: bool,
    reader: JoinHandle<()>,
    writer: JoinHandle<()>,
}

impl Drop for AppConnection {
    fn drop(&mut self) {
        self.reader.abort();
        self.writer.abort();
    }
}

/// A call waiting for the app. Dropped before the app answers (the agent cancelled it),
/// it asks the app to drop the call too, which withdraws a pending approval.
struct Waiting<'a> {
    conn: &'a AppConnection,
    id: u64,
    sent: bool,
}

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        // Still registered: no answer came, so the app may still be running it.
        let unanswered = self.conn.shared.pending().remove(&self.id).is_some();
        if unanswered && self.sent && self.conn.cancels {
            self.conn.send_cancel(self.id);
        }
    }
}

impl AppConnection {
    async fn open(config_dir: &std::path::Path) -> Result<Self, String> {
        let path = endpoint_file_path(config_dir);
        let data = match tokio::fs::read(&path).await {
            Ok(d) => d,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                let off = !GatewaySettings::load(config_dir).enabled;
                return Err(if off { TURNED_OFF } else { NOT_RUNNING }.to_string());
            }
            Err(e) => return Err(format!("Could not read {}: {e}", path.display())),
        };
        let info: EndpointInfo = serde_json::from_slice(&data)
            .map_err(|e| format!("{} is not valid ({e}); restart RustSCP", path.display()))?;
        if info.format != ENDPOINT_FORMAT {
            return Err(format!(
                "This RustSCP gateway (format {}) does not match the app (format {}); use the setup command shown in the app's AI gateway window.",
                ENDPOINT_FORMAT, info.format
            ));
        }
        let (read, mut write) = connect(&info.endpoint).await.map_err(|e| {
            tracing::debug!(
                "could not reach the RustSCP gateway at {}: {e}",
                info.endpoint
            );
            NOT_RUNNING.to_string()
        })?;

        let mut hello = serde_json::to_string(&Handshake::Hello {
            token: info.token.clone(),
            bridge_version: env!("CARGO_PKG_VERSION").to_string(),
        })
        .map_err(|e| e.to_string())?;
        hello.push('\n');
        write
            .write_all(hello.as_bytes())
            .await
            .and(write.flush().await)
            .map_err(|_| NOT_RUNNING.to_string())?;

        let mut reader = BufReader::new(read);
        let mut buf = Vec::new();
        let answer = tokio::time::timeout(
            HANDSHAKE_TIMEOUT,
            read_frame(&mut reader, &mut buf, MAX_HANDSHAKE_BYTES),
        )
        .await;
        if !matches!(answer, Ok(Ok(Frame::Line))) {
            return Err(
                "RustSCP did not answer the gateway handshake; restart the app and try again."
                    .to_string(),
            );
        }
        let cancels = match serde_json::from_slice::<Handshake>(&buf) {
            Ok(Handshake::Welcome {
                app_version,
                cancels,
            }) => {
                if app_version != env!("CARGO_PKG_VERSION") {
                    tracing::warn!(
                        "RustSCP {app_version} is running; this gateway is {}",
                        env!("CARGO_PKG_VERSION")
                    );
                }
                cancels
            }
            Ok(Handshake::Rejected { message }) => {
                return Err(format!("RustSCP refused the connection: {message}"));
            }
            _ => {
                return Err(
                    "RustSCP sent an unexpected handshake; restart the app and try again."
                        .to_string(),
                )
            }
        };

        let shared = Arc::new(Shared {
            pending: Mutex::new(HashMap::new()),
            alive: AtomicBool::new(true),
        });
        let reader = tokio::spawn(read_replies(reader, shared.clone()));
        let (outgoing, lines) = mpsc::channel(MAX_CONCURRENT_REQUESTS * 2);
        let writer = tokio::spawn({
            let shared = shared.clone();
            async move {
                let _ = write_lines(write, lines).await;
                shared.close();
            }
        });
        Ok(Self {
            outgoing,
            shared,
            next_id: AtomicU64::new(1),
            cancels,
            reader,
            writer,
        })
    }

    async fn call(
        &self,
        agent: &str,
        name: &str,
        arguments: &Value,
    ) -> Result<McpToolResult, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.shared.pending().insert(id, tx);
        let mut waiting = Waiting {
            conn: self,
            id,
            sent: false,
        };
        // A closing connection is marked dead before its waiting calls are dropped, so a
        // call registered after that is caught here.
        if !self.shared.alive.load(Ordering::SeqCst) {
            return Err(CONNECTION_LOST.to_string());
        }

        let request = CallRequestRef {
            id,
            agent,
            name,
            arguments,
        };
        let line = serde_json::to_string(&request).map_err(|e| e.to_string())?;
        if self.outgoing.send(line).await.is_err() {
            return Err(CONNECTION_LOST.to_string());
        }
        waiting.sent = true;
        rx.await.map_err(|_| CONNECTION_LOST.to_string())
    }

    /// Queues a [`CancelCall`] behind the call's own line, so the app always sees the call
    /// first. Runs from a destructor, so it never waits.
    fn send_cancel(&self, id: u64) {
        let Ok(line) = serde_json::to_string(&CancelCall { cancel: id }) else {
            return;
        };
        if let Err(TrySendError::Full(line)) = self.outgoing.try_send(line) {
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                let outgoing = self.outgoing.clone();
                runtime.spawn(async move {
                    let _ = outgoing.send(line).await;
                });
            }
        }
    }
}

async fn read_replies(mut reader: BufReader<BoxRead>, shared: Arc<Shared>) {
    let mut buf = Vec::new();
    while let Ok(Frame::Line) = read_frame(&mut reader, &mut buf, MAX_IPC_MESSAGE_BYTES).await {
        match serde_json::from_slice::<CallReply>(&buf) {
            Ok(reply) => {
                if let Some(tx) = shared.pending().remove(&reply.id) {
                    let _ = tx.send(reply.result);
                }
            }
            Err(e) => tracing::warn!("ignoring a malformed reply from RustSCP: {e}"),
        }
    }
    shared.close();
}

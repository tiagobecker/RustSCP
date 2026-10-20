//! App side of the AI gateway: accepts stdio bridges and runs their tool calls on the
//! app's [`McpServer`] (same sessions, permission checks, approvals and audit log).

use crate::ipc::{
    endpoint_file_path, new_token, tokens_match, BoxRead, BoxWrite, CallReply, CallRequest,
    Endpoint, EndpointInfo, Handshake, ENDPOINT_FORMAT, HANDSHAKE_TIMEOUT, MAX_HANDSHAKE_BYTES,
    MAX_IPC_MESSAGE_BYTES,
};
use crate::rpc::sanitize_label;
use crate::server::McpServer;
use crate::transport::{read_frame, write_lines, Frame, MAX_CONCURRENT_REQUESTS};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, Semaphore};
use tokio::task::{JoinHandle, JoinSet};

/// Bridges connected at the same time; more are turned away.
pub const MAX_CLIENTS: usize = 8;
/// Longest agent label kept in the audit log.
const MAX_AGENT_LABEL_CHARS: usize = 200;
/// Unix socket paths longer than this (the OS limit is 104 bytes on macOS) move to the
/// per-user temp directory.
#[cfg(unix)]
const MAX_UNIX_SOCKET_PATH: usize = 100;

/// How the gateway listens.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndpointKind {
    /// Unix domain socket with owner-only permissions.
    Unix,
    /// Loopback TCP port; the token keeps other local users out.
    Tcp,
}

impl EndpointKind {
    /// Unix socket where available, loopback TCP elsewhere (Windows).
    pub fn platform_default() -> Self {
        if cfg!(unix) {
            Self::Unix
        } else {
            Self::Tcp
        }
    }
}

enum Listener {
    #[cfg(unix)]
    Unix(tokio::net::UnixListener),
    Tcp(tokio::net::TcpListener),
}

impl Listener {
    async fn accept(&self) -> io::Result<(BoxRead, BoxWrite)> {
        match self {
            #[cfg(unix)]
            Listener::Unix(l) => {
                let (stream, _) = l.accept().await?;
                let (r, w) = stream.into_split();
                Ok((Box::new(r), Box::new(w)))
            }
            Listener::Tcp(l) => {
                let (stream, _) = l.accept().await?;
                stream.set_nodelay(true)?;
                let (r, w) = stream.into_split();
                Ok((Box::new(r), Box::new(w)))
            }
        }
    }
}

/// A running gateway. Dropping it (or [`stop`](Self::stop)) closes the listener, ends
/// the connected bridges and removes the endpoint file.
pub struct McpGateway {
    endpoint: Endpoint,
    endpoint_file: PathBuf,
    token: String,
    clients: Arc<AtomicUsize>,
    accept_task: JoinHandle<()>,
}

impl McpGateway {
    /// Starts listening on the platform's default endpoint kind.
    pub async fn start(server: Arc<McpServer>, config_dir: &Path) -> io::Result<Self> {
        Self::start_with(server, config_dir, EndpointKind::platform_default()).await
    }

    pub async fn start_with(
        server: Arc<McpServer>,
        config_dir: &Path,
        kind: EndpointKind,
    ) -> io::Result<Self> {
        rustscp_core::vault::ensure_private_dir(config_dir)?;
        let token = new_token();
        let (listener, endpoint) = bind(config_dir, kind).await?;

        let info = EndpointInfo {
            format: ENDPOINT_FORMAT,
            endpoint: endpoint.clone(),
            token: token.clone(),
            pid: std::process::id(),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
        };
        let endpoint_file = endpoint_file_path(config_dir);
        let data = serde_json::to_vec_pretty(&info).map_err(io::Error::other)?;
        if let Err(e) = rustscp_core::vault::write_private_file_atomic(&endpoint_file, &data) {
            remove_socket_file(&endpoint);
            return Err(e);
        }

        let clients = Arc::new(AtomicUsize::new(0));
        let accept_task = tokio::spawn(accept_loop(
            listener,
            server,
            Arc::new(token.clone()),
            clients.clone(),
        ));
        tracing::info!("MCP gateway listening on {endpoint}");
        Ok(Self {
            endpoint,
            endpoint_file,
            token,
            clients,
            accept_task,
        })
    }

    pub fn endpoint(&self) -> &Endpoint {
        &self.endpoint
    }

    /// Bridges connected right now.
    pub fn connected_clients(&self) -> usize {
        self.clients.load(Ordering::SeqCst)
    }

    /// Stops listening and disconnects every bridge. Safe to call more than once.
    pub fn stop(&self) {
        self.accept_task.abort();
        remove_socket_file(&self.endpoint);
        // Another RustSCP instance may have taken over the file since: only remove ours.
        let ours = std::fs::read(&self.endpoint_file)
            .ok()
            .and_then(|d| serde_json::from_slice::<EndpointInfo>(&d).ok())
            .is_some_and(|info| info.token == self.token);
        if ours {
            let _ = std::fs::remove_file(&self.endpoint_file);
        }
    }
}

impl Drop for McpGateway {
    fn drop(&mut self) {
        self.stop();
    }
}

fn remove_socket_file(endpoint: &Endpoint) {
    if let Endpoint::Unix { path } = endpoint {
        let _ = std::fs::remove_file(path);
    }
}

async fn bind(config_dir: &Path, kind: EndpointKind) -> io::Result<(Listener, Endpoint)> {
    match kind {
        #[cfg(unix)]
        EndpointKind::Unix => {
            let path = unix_socket_path(config_dir);
            let listener = bind_unix(&path).await?;
            Ok((Listener::Unix(listener), Endpoint::Unix { path }))
        }
        #[cfg(not(unix))]
        EndpointKind::Unix => {
            let _ = config_dir;
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "Unix sockets are not available on this system",
            ))
        }
        EndpointKind::Tcp => {
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
            let addr = listener.local_addr()?;
            Ok((Listener::Tcp(listener), Endpoint::Tcp { addr }))
        }
    }
}

/// `mcp.sock` in the config directory, or, when that path is too long for a socket, a
/// name derived from the config directory in the per-user runtime directory (so the next
/// start replaces a socket a crash left behind).
#[cfg(unix)]
fn unix_socket_path(config_dir: &Path) -> PathBuf {
    let preferred = config_dir.join("mcp.sock");
    if preferred.as_os_str().len() <= MAX_UNIX_SOCKET_PATH {
        return preferred;
    }
    let runtime_dir = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .filter(|d| d.is_absolute())
        .unwrap_or_else(std::env::temp_dir);
    let digest = rustscp_core::disk_cache::sha256_hex(config_dir.as_os_str().as_encoded_bytes());
    runtime_dir.join(format!("rustscp-mcp-{}.sock", &digest[..16]))
}

/// Binds `path` (owner-only). A socket left behind by a crashed run is replaced; one that
/// still answers belongs to another RustSCP instance and is left alone.
#[cfg(unix)]
async fn bind_unix(path: &Path) -> io::Result<tokio::net::UnixListener> {
    use std::os::unix::fs::{FileTypeExt, PermissionsExt};

    let listener = match tokio::net::UnixListener::bind(path) {
        Ok(l) => l,
        Err(e) if e.kind() == io::ErrorKind::AddrInUse => {
            if tokio::net::UnixStream::connect(path).await.is_ok() {
                return Err(io::Error::new(
                    io::ErrorKind::AddrInUse,
                    "another RustSCP instance is already running the AI gateway",
                ));
            }
            let is_socket = std::fs::symlink_metadata(path)
                .map(|m| m.file_type().is_socket())
                .unwrap_or(false);
            if !is_socket {
                return Err(e);
            }
            std::fs::remove_file(path)?;
            tokio::net::UnixListener::bind(path)?
        }
        Err(e) => return Err(e),
    };
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(listener)
}

async fn accept_loop(
    listener: Listener,
    server: Arc<McpServer>,
    token: Arc<String>,
    clients: Arc<AtomicUsize>,
) {
    // Owned here, so stopping the gateway (aborting this task) ends every bridge too.
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((read, mut write)) => {
                    if connections.len() >= MAX_CLIENTS {
                        let _ = send_handshake(&mut write, &Handshake::Rejected {
                            message: format!("too many agents connected (at most {MAX_CLIENTS})"),
                        }).await;
                        continue;
                    }
                    connections.spawn(serve_bridge_client(
                        read,
                        write,
                        server.clone(),
                        token.clone(),
                        clients.clone(),
                    ));
                }
                Err(e) => {
                    tracing::warn!("MCP gateway accept failed: {e}");
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            },
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
        }
    }
}

async fn send_handshake(write: &mut BoxWrite, message: &Handshake) -> io::Result<()> {
    let mut line = serde_json::to_string(message).map_err(io::Error::other)?;
    line.push('\n');
    write.write_all(line.as_bytes()).await?;
    write.flush().await
}

/// Decrements the connected-bridge count when a bridge goes away.
struct ClientGuard(Arc<AtomicUsize>);

impl Drop for ClientGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// One bridge: token handshake, then tool calls until it disconnects. Calls still
/// running then are dropped (pending approvals are withdrawn; approved writes finish).
async fn serve_bridge_client(
    read: BoxRead,
    mut write: BoxWrite,
    server: Arc<McpServer>,
    token: Arc<String>,
    clients: Arc<AtomicUsize>,
) {
    let mut reader = BufReader::new(read);
    let mut buf = Vec::new();

    let hello = tokio::time::timeout(
        HANDSHAKE_TIMEOUT,
        read_frame(&mut reader, &mut buf, MAX_HANDSHAKE_BYTES),
    )
    .await;
    let authorized = matches!(hello, Ok(Ok(Frame::Line)))
        && matches!(
            serde_json::from_slice::<Handshake>(&buf),
            Ok(Handshake::Hello { token: given, .. }) if tokens_match(&given, &token)
        );
    if !authorized {
        tracing::warn!("MCP gateway refused a connection without a valid token");
        let _ = send_handshake(
            &mut write,
            &Handshake::Rejected {
                message: "invalid or missing gateway token".to_string(),
            },
        )
        .await;
        return;
    }
    if send_handshake(
        &mut write,
        &Handshake::Welcome {
            app_version: env!("CARGO_PKG_VERSION").to_string(),
        },
    )
    .await
    .is_err()
    {
        return;
    }

    clients.fetch_add(1, Ordering::SeqCst);
    let _guard = ClientGuard(clients);
    let (tx, rx) = mpsc::channel::<String>(MAX_CONCURRENT_REQUESTS * 2);
    let writer = tokio::spawn(write_lines(write, rx));
    let permits = Arc::new(Semaphore::new(MAX_CONCURRENT_REQUESTS));
    let mut calls = JoinSet::new();

    loop {
        while calls.try_join_next().is_some() {}
        match read_frame(&mut reader, &mut buf, MAX_IPC_MESSAGE_BYTES).await {
            Ok(Frame::Line) => {
                let req: CallRequest = match serde_json::from_slice(&buf) {
                    Ok(r) => r,
                    Err(e) => {
                        tracing::warn!("MCP gateway: malformed call from a bridge: {e}");
                        break;
                    }
                };
                let Ok(permit) = permits.clone().acquire_owned().await else {
                    break;
                };
                let server = server.clone();
                let tx = tx.clone();
                calls.spawn(async move {
                    let mut agent = sanitize_label(&req.agent, MAX_AGENT_LABEL_CHARS);
                    if agent.is_empty() {
                        agent = "mcp-stdio".to_string();
                    }
                    let result = server
                        .handle_tool_call(&agent, &req.name, &req.arguments)
                        .await;
                    if let Ok(line) = serde_json::to_string(&CallReply { id: req.id, result }) {
                        let _ = tx.send(line).await;
                    }
                    drop(permit);
                });
            }
            Ok(Frame::TooLong) => {
                tracing::warn!("MCP gateway: a bridge sent an oversized call; disconnecting it");
                break;
            }
            Ok(Frame::Eof) | Err(_) => break,
        }
    }
    calls.abort_all();
    drop(tx);
    writer.abort();
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn long_config_dirs_get_a_stable_short_socket_path() {
        let short = Path::new("/tmp/rustscp-cfg");
        assert_eq!(unix_socket_path(short), short.join("mcp.sock"));

        let long = PathBuf::from(format!("/tmp/{}", "x".repeat(120)));
        let path = unix_socket_path(&long);
        assert_eq!(
            path,
            unix_socket_path(&long),
            "same config dir, same socket"
        );
        let name = path.file_name().unwrap().to_str().unwrap();
        assert!(
            name.starts_with("rustscp-mcp-") && name.ends_with(".sock"),
            "{name}"
        );
        let other = PathBuf::from(format!("/tmp/{}", "y".repeat(120)));
        assert_ne!(path, unix_socket_path(&other));
    }
}

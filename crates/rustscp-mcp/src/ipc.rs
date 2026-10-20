//! Private channel between the stdio bridge (`rustscp-desktop --mcp-stdio`) and the
//! running RustSCP app.
//!
//! The app listens on a Unix socket in its config directory (0600, Unix) or on a loopback
//! TCP port (elsewhere) and writes where, plus a random token, to
//! [`ENDPOINT_FILE`] (0600). A bridge must send that token before anything else. After
//! the handshake each line is one tool call (`CallRequest`) or its result (`CallReply`).

use crate::protocol::McpToolResult;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite};

/// File in the RustSCP config directory that tells bridges how to reach the app.
pub const ENDPOINT_FILE: &str = "mcp-gateway.json";
/// Version of the endpoint file and handshake format.
pub const ENDPOINT_FORMAT: u32 = 1;
/// Largest handshake line.
pub(crate) const MAX_HANDSHAKE_BYTES: usize = 4096;
/// How long either side waits for the other's handshake line.
pub(crate) const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
/// Largest call or reply line: an MCP message plus the call envelope.
pub(crate) const MAX_IPC_MESSAGE_BYTES: usize = crate::transport::MAX_MESSAGE_BYTES + 64 * 1024;

/// Where the app listens.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Endpoint {
    /// Unix domain socket (owner-only permissions).
    Unix { path: PathBuf },
    /// Loopback TCP port (token-protected).
    Tcp { addr: SocketAddr },
}

impl std::fmt::Display for Endpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Endpoint::Unix { path } => write!(f, "unix:{}", path.display()),
            Endpoint::Tcp { addr } => write!(f, "tcp:{addr}"),
        }
    }
}

/// Contents of [`ENDPOINT_FILE`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EndpointInfo {
    pub format: u32,
    pub endpoint: Endpoint,
    pub token: String,
    pub pid: u32,
    pub app_version: String,
}

pub fn endpoint_file_path(config_dir: &Path) -> PathBuf {
    config_dir.join(ENDPOINT_FILE)
}

/// First line each side sends.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum Handshake {
    Hello {
        token: String,
        bridge_version: String,
    },
    Welcome {
        app_version: String,
    },
    Rejected {
        message: String,
    },
}

/// One tool call, bridge to app.
#[derive(Debug, Serialize)]
pub(crate) struct CallRequestRef<'a> {
    pub id: u64,
    pub agent: &'a str,
    pub name: &'a str,
    pub arguments: &'a Value,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CallRequest {
    pub id: u64,
    #[serde(default)]
    pub agent: String,
    pub name: String,
    #[serde(default)]
    pub arguments: Value,
}

/// Result of one tool call, app to bridge.
#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct CallReply {
    pub id: u64,
    pub result: McpToolResult,
}

/// 256 random bits (two v4 UUIDs from the OS random generator), hex encoded.
pub(crate) fn new_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// Compares tokens without stopping at the first difference.
pub(crate) fn tokens_match(given: &str, expected: &str) -> bool {
    let (a, b) = (given.as_bytes(), expected.as_bytes());
    if a.len() != b.len() || b.is_empty() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub(crate) type BoxRead = Box<dyn AsyncRead + Send + Unpin>;
pub(crate) type BoxWrite = Box<dyn AsyncWrite + Send + Unpin>;

/// Opens a stream to the app's endpoint.
pub(crate) async fn connect(endpoint: &Endpoint) -> io::Result<(BoxRead, BoxWrite)> {
    match endpoint {
        #[cfg(unix)]
        Endpoint::Unix { path } => {
            let (r, w) = tokio::net::UnixStream::connect(path).await?.into_split();
            Ok((Box::new(r), Box::new(w)))
        }
        #[cfg(not(unix))]
        Endpoint::Unix { .. } => Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Unix sockets are not available on this system",
        )),
        Endpoint::Tcp { addr } => {
            if !addr.ip().is_loopback() {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "the gateway endpoint must be a loopback address",
                ));
            }
            let stream = tokio::net::TcpStream::connect(addr).await?;
            stream.set_nodelay(true)?;
            let (r, w) = stream.into_split();
            Ok((Box::new(r), Box::new(w)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_random_and_compared_exactly() {
        let a = new_token();
        let b = new_token();
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
        assert!(tokens_match(&a, &a.clone()));
        assert!(!tokens_match(&b, &a));
        assert!(!tokens_match(&a[..63], &a));
        assert!(!tokens_match("", ""));
    }

    #[test]
    fn endpoint_info_round_trips() {
        let info = EndpointInfo {
            format: ENDPOINT_FORMAT,
            endpoint: Endpoint::Tcp {
                addr: "127.0.0.1:4567".parse().unwrap(),
            },
            token: "t".into(),
            pid: 1,
            app_version: "0.1.0".into(),
        };
        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains(r#""kind":"tcp""#), "{json}");
        let back: EndpointInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(back.endpoint, info.endpoint);
    }
}

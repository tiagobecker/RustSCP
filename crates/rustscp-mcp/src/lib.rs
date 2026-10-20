pub mod audit;
pub mod protocol;
pub mod server;

pub use audit::{AuditEvent, AuditLogger};
pub use protocol::*;
pub use server::{McpServer, MCP_TRANSPORT_AVAILABLE, SUPPORTED_PROTOCOL_VERSIONS};

/// Whether an external MCP client can currently reach the gateway (no stdio, socket or
/// HTTP transport is wired into the app yet). Status screens must report the gateway as
/// unavailable while this returns `false`.
pub const fn transport_available() -> bool {
    MCP_TRANSPORT_AVAILABLE
}

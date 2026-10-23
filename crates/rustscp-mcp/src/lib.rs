pub mod audit;
pub mod bridge;
pub mod gateway;
pub mod ipc;
pub mod policy;
pub mod protocol;
pub mod rpc;
pub mod server;
pub mod transport;

pub use audit::{AuditEvent, AuditLogger};
pub use bridge::run_stdio_bridge;
pub use gateway::{EndpointKind, GatewaySettings, McpGateway};
pub use policy::{classify_command, CommandAccess, CommandDecision, CommandRisk};
pub use protocol::*;
pub use rpc::{RpcSession, ToolBackend};
pub use server::{
    tool_requires_approval, ApprovalDecision, ApprovalKind, ApprovalRequest, ConnectionInfo,
    McpServer, ToolApprover, MCP_TRANSPORT_AVAILABLE, SUPPORTED_PROTOCOL_VERSIONS,
};

/// Whether an external MCP client can reach the gateway: this build ships the stdio
/// transport (`rustscp-desktop --mcp-stdio`). Whether the running app is accepting
/// bridges right now is reported separately by the app ([`McpGateway`]).
pub const fn transport_available() -> bool {
    MCP_TRANSPORT_AVAILABLE
}

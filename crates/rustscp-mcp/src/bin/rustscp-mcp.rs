//! Stand-alone MCP stdio server for AI agents (development builds; the desktop app ships
//! the same server as `rustscp-desktop --mcp-stdio`). Tool calls go to the running
//! RustSCP app; stdout carries protocol messages only.

#[tokio::main]
async fn main() {
    let config_dir = rustscp_core::get_rustscp_config_dir();
    if let Err(e) = rustscp_mcp::run_stdio_bridge(config_dir).await {
        eprintln!("rustscp-mcp: {e}");
        std::process::exit(1);
    }
}

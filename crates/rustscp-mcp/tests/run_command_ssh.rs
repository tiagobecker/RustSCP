//! `run_command` end to end against a real SSH server, through the MCP server on a live
//! SFTP session. Skipped unless set (see `rustscp-core`'s `terminal_ssh.rs`):
//!
//! - `RUSTSCP_TEST_SSH_PORT`: port of an SSH server on 127.0.0.1
//! - `RUSTSCP_TEST_SSH_KEY`: a private key that logs in as the current user

use rustscp_core::{AuthMethod, ConnectionConfig, Protocol, SftpDriver};
use rustscp_mcp::{AuditLogger, CommandAccess, McpServer};
use serde_json::{json, Value};
use std::sync::Arc;

#[tokio::test]
async fn agent_runs_a_command_on_a_real_ssh_session() {
    let (Ok(port), Ok(key)) = (
        std::env::var("RUSTSCP_TEST_SSH_PORT"),
        std::env::var("RUSTSCP_TEST_SSH_KEY"),
    ) else {
        eprintln!("skipped: RUSTSCP_TEST_SSH_PORT / RUSTSCP_TEST_SSH_KEY not set");
        return;
    };
    let config_dir = tempfile::tempdir().unwrap();
    std::env::set_var("RUSTSCP_CONFIG_DIR", config_dir.path());
    let user = std::env::var("USER").unwrap();

    let driver = SftpDriver::new(ConnectionConfig {
        id: "srv".into(),
        name: "Live server".into(),
        protocol: Protocol::Sftp,
        host: "127.0.0.1".into(),
        port: port.parse().unwrap(),
        username: user,
        auth: AuthMethod::PrivateKey {
            path: key,
            passphrase: None,
            key_data: None,
        },
        remote_root: "/".into(),
        tls_fingerprint: None,
        group: None,
    });
    driver.connect().await.expect("connect");

    let server = Arc::new(McpServer::new(AuditLogger::new()));
    server
        .register_connection("srv".into(), Arc::new(driver))
        .await;
    // Trusted: run without an approver, so the test needs no UI.
    server.set_command_access(CommandAccess::Trusted);

    // A plain command: exit code and stdout come back.
    let res = server
        .handle_tool_call(
            "agent",
            "run_command",
            &json!({ "connection_id": "srv", "command": "echo mcp-ran-$((6*7))" }),
        )
        .await;
    assert!(!res.is_error);
    let text = match &res.content[0] {
        rustscp_mcp::McpContent::Text { text } => text.clone(),
    };
    let v: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(v["exit_code"], 0);
    assert!(
        v["stdout"].as_str().unwrap().contains("mcp-ran-42"),
        "{text}"
    );

    // A non-zero exit is reported, not hidden.
    let res = server
        .handle_tool_call(
            "agent",
            "run_command",
            &json!({ "connection_id": "srv", "command": "exit 3" }),
        )
        .await;
    let text = match &res.content[0] {
        rustscp_mcp::McpContent::Text { text } => text.clone(),
    };
    let v: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(v["exit_code"], 3, "{text}");

    // working_dir runs the command there.
    let res = server
        .handle_tool_call(
            "agent",
            "run_command",
            &json!({ "connection_id": "srv", "command": "pwd", "working_dir": "/tmp" }),
        )
        .await;
    let text = match &res.content[0] {
        rustscp_mcp::McpContent::Text { text } => text.clone(),
    };
    let v: Value = serde_json::from_str(&text).unwrap();
    assert!(v["stdout"].as_str().unwrap().contains("/tmp"), "{text}");
}

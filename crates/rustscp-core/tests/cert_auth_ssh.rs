//! SSH login with an OpenSSH user certificate, against a real server. Skipped unless set:
//!
//! - `RUSTSCP_TEST_SSH_PORT`: port of an SSH server on 127.0.0.1 that trusts a CA
//!   (`TrustedUserCAKeys`)
//! - `RUSTSCP_TEST_CERT_KEY`: a private key whose `<key>-cert.pub` the CA signed
//!
//! A throwaway server needs no root (see `terminal_ssh.rs`); add `TrustedUserCAKeys
//! <ca>.pub` and sign the key with `ssh-keygen -s <ca> -I id -n <user> <key>.pub`.

use rustscp_core::{AuthMethod, ConnectionConfig, Protocol, SftpDriver, VirtualFileSystem};
use std::time::Duration;

#[tokio::test]
async fn logs_in_with_an_openssh_certificate() {
    let (Ok(port), Ok(key)) = (
        std::env::var("RUSTSCP_TEST_SSH_PORT"),
        std::env::var("RUSTSCP_TEST_CERT_KEY"),
    ) else {
        eprintln!("skipped: RUSTSCP_TEST_SSH_PORT / RUSTSCP_TEST_CERT_KEY not set");
        return;
    };
    let config_dir = tempfile::tempdir().unwrap();
    std::env::set_var("RUSTSCP_CONFIG_DIR", config_dir.path());
    let user = std::env::var("USER").unwrap();

    let driver = SftpDriver::new(ConnectionConfig {
        id: "cert".into(),
        name: "Cert server".into(),
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
    driver.connect().await.expect("certificate login");

    let (code, stdout, _) = driver
        .execute_command_with_timeout("echo cert-login-ok", Duration::from_secs(20))
        .await
        .expect("run a command");
    assert_eq!(code, 0);
    assert!(stdout.contains("cert-login-ok"), "stdout: {stdout}");
}

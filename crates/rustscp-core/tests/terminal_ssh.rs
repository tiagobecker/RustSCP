//! Built-in terminal against a real SSH server. Skipped unless these are set:
//!
//! - `RUSTSCP_TEST_SSH_PORT`: port of an SSH server on 127.0.0.1
//! - `RUSTSCP_TEST_SSH_KEY`: private key file that logs in as the current user
//!
//! A throwaway server needs no root: `sshd -D -e -f <config>` with its own `HostKey`,
//! `AuthorizedKeysFile`, `Port`, `UsePAM no` and `StrictModes no`.

use rustscp_core::terminal::{ShellEvent, ShellEventParser};
use rustscp_core::{
    shell_bootstrap, AuthMethod, ConnectionConfig, Protocol, SftpDriver, TerminalOptions,
    TerminalSink, TerminalSize,
};
use std::time::Duration;
use tokio::sync::mpsc;

enum Out {
    Data(Vec<u8>),
    Closed(Option<i32>, Option<String>),
}

struct ChannelSink(mpsc::UnboundedSender<Out>);

impl TerminalSink for ChannelSink {
    fn output(&mut self, data: &[u8]) {
        let _ = self.0.send(Out::Data(data.to_vec()));
    }
    fn closed(&mut self, exit_status: Option<i32>, error: Option<String>) {
        let _ = self.0.send(Out::Closed(exit_status, error));
    }
}

struct Screen {
    rx: mpsc::UnboundedReceiver<Out>,
    text: String,
    parser: ShellEventParser,
    events: Vec<ShellEvent>,
    closed: Option<(Option<i32>, Option<String>)>,
}

impl Screen {
    /// Reads output until `done` says so (or fails after 15 s).
    async fn until(&mut self, what: &str, done: impl Fn(&Screen) -> bool) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        while !done(self) {
            match tokio::time::timeout_at(deadline, self.rx.recv()).await {
                Ok(Some(Out::Data(d))) => {
                    self.parser.feed(&d, &mut self.events);
                    self.text.push_str(&String::from_utf8_lossy(&d));
                }
                Ok(Some(Out::Closed(code, error))) => self.closed = Some((code, error)),
                Ok(None) => panic!("terminal channel closed while waiting for {what}"),
                Err(_) => panic!(
                    "timed out waiting for {what}; screen so far:\n{}",
                    self.text
                ),
            }
        }
    }

    fn prompts(&self) -> usize {
        self.events
            .iter()
            .filter(|e| matches!(e, ShellEvent::Prompt(_)))
            .count()
    }
}

#[tokio::test]
async fn terminal_streams_a_real_shell() {
    let (Ok(port), Ok(key)) = (
        std::env::var("RUSTSCP_TEST_SSH_PORT"),
        std::env::var("RUSTSCP_TEST_SSH_KEY"),
    ) else {
        eprintln!("skipped: RUSTSCP_TEST_SSH_PORT / RUSTSCP_TEST_SSH_KEY not set");
        return;
    };
    // Host keys go to a throwaway known_hosts.
    let config_dir = tempfile::tempdir().unwrap();
    std::env::set_var("RUSTSCP_CONFIG_DIR", config_dir.path());
    let user = std::env::var("USER").unwrap();

    let driver = SftpDriver::new(ConnectionConfig {
        id: "test".into(),
        name: "Test server".into(),
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
    driver.connect().await.unwrap();
    let connector = driver.terminal_connector();
    // The file session can go away: the terminal keeps its own connection.
    drop(driver);

    let (tx, rx) = mpsc::unbounded_channel();
    let folder = tempfile::tempdir().unwrap();
    let folder_path = std::fs::canonicalize(folder.path()).unwrap();
    let handle = connector
        .open(
            TerminalOptions {
                size: TerminalSize {
                    cols: 100,
                    rows: 30,
                },
                // Whatever the account's login shell is, test the bash hook.
                command: Some(format!(
                    "SHELL=/bin/bash; export SHELL; HISTFILE=/dev/null; export HISTFILE\n{}",
                    shell_bootstrap(&folder_path.to_string_lossy())
                )),
            },
            ChannelSink(tx),
        )
        .await
        .unwrap();
    let mut screen = Screen {
        rx,
        text: String::new(),
        parser: ShellEventParser::default(),
        events: Vec::new(),
        closed: None,
    };

    // The first prompt reports the folder.
    screen.until("the first prompt", |s| s.prompts() >= 1).await;
    assert!(screen
        .events
        .contains(&ShellEvent::Cwd(folder_path.to_string_lossy().into_owned())));

    // A command and its exit status, streamed while it runs.
    handle.write(b"for i in 1 2 3; do echo tick-$i; sleep 0.2; done; (exit 7)\r".to_vec());
    screen
        .until("tick-1", |s| s.text.contains("tick-1\r\n"))
        .await;
    assert_eq!(
        screen.prompts(),
        1,
        "output arrives before the command ends"
    );
    screen
        .until("the second prompt", |s| s.prompts() >= 2)
        .await;
    assert!(screen.events.contains(&ShellEvent::Command(
        "for i in 1 2 3; do echo tick-$i; sleep 0.2; done; (exit 7)".into()
    )));
    assert!(screen.events.contains(&ShellEvent::Prompt(7)));

    // The PTY follows the window size.
    handle.resize(TerminalSize {
        cols: 132,
        rows: 43,
    });
    handle.write(b"stty size\r".to_vec());
    screen
        .until("stty size", |s| s.text.contains("43 132"))
        .await;

    // Ctrl+C stops a running command.
    let before = screen.prompts();
    handle.write(b"sleep 30\r".to_vec());
    tokio::time::sleep(Duration::from_millis(500)).await;
    handle.write(vec![0x03]);
    screen
        .until("the prompt after Ctrl+C", |s| s.prompts() > before + 1)
        .await;
    assert!(screen.events.contains(&ShellEvent::Prompt(130)));

    // A big paste (50 KB, more than one write chunk) reaches the program while its echo
    // streams back: 500 lines of 99 characters into `wc -c`.
    handle.write(b"wc -c\r".to_vec());
    tokio::time::sleep(Duration::from_millis(300)).await;
    let paste = format!("{}\r", "x".repeat(99)).repeat(500);
    handle.write(paste.into_bytes());
    handle.write(vec![0x04]); // Ctrl+D: end of input
    screen
        .until("wc's count", |s| s.text.contains(" 50000\r"))
        .await;

    // `exit` ends the terminal with the shell's status.
    handle.write(b"exit 3\r".to_vec());
    screen.until("the end", |s| s.closed.is_some()).await;
    assert_eq!(screen.closed, Some((Some(3), None)));
    assert!(handle.is_closed() || !handle.write(b"x".to_vec()));
}

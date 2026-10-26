//! Throwaway OpenSSH servers for the SFTP compatibility-mode tests and bench.
//!
//! Each [`Sshd`] is an unprivileged `/usr/sbin/sshd -D` on a free 127.0.0.1 port with a
//! folder of its own: ed25519 host and user keys, `authorized_keys`, config, pid file and
//! a DEBUG1 log. It can only log in as the current OS user (whose real home it starts
//! in), so callers work inside [`Sshd::work`] with absolute paths and nowhere else. The
//! server and every session it started are killed when it is dropped.
//!
//! Only std and `tempfile`, so the harness can be checked on its own with the system
//! `sftp` client ([`Sshd::openssh_sftp`]).

#![allow(dead_code)]

use std::fs;
use std::io::Read;
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

pub const SSHD: &str = "/usr/sbin/sshd";

/// Why the spawned-server tests cannot run here, or `None` when they can.
pub fn skip_reason() -> Option<String> {
    if std::env::var("RUSTSCP_TEST_SPAWN_SSHD").as_deref() != Ok("1") {
        return Some("RUSTSCP_TEST_SPAWN_SSHD=1 not set".into());
    }
    if !Path::new(SSHD).is_file() {
        return Some(format!("{SSHD} not found"));
    }
    if sftp_server_path().is_none() {
        return Some("no sftp-server binary found".into());
    }
    if Command::new("ssh-keygen")
        .arg("-?")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_err()
    {
        return Some("ssh-keygen not found".into());
    }
    None
}

/// The local OpenSSH `sftp-server` (macOS, Debian/Ubuntu, Fedora/RHEL, Arch).
pub fn sftp_server_path() -> Option<PathBuf> {
    [
        "/usr/libexec/sftp-server",
        "/usr/lib/openssh/sftp-server",
        "/usr/libexec/openssh/sftp-server",
        "/usr/lib/ssh/sftp-server",
    ]
    .iter()
    .map(PathBuf::from)
    .find(|p| p.is_file())
}

/// How the server answers a request for the `sftp` subsystem.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Variant {
    /// `Subsystem sftp <absolute sftp-server>`: native SFTP works.
    Good,
    /// `Subsystem sftp sftp-server`: the request is accepted, then the login shell does
    /// not find the program (exit 127) and the channel closes without an SFTP reply.
    Relative,
    /// No `Subsystem` line: the request is refused.
    NoSubsystem,
    /// The relative line plus `ForceCommand internal-sftp`: sshd answers every session
    /// (subsystem, exec or shell) with its built-in SFTP server.
    ForceCommand,
}

impl Variant {
    pub fn name(self) -> &'static str {
        match self {
            Variant::Good => "good",
            Variant::Relative => "relative",
            Variant::NoSubsystem => "none",
            Variant::ForceCommand => "forcecommand",
        }
    }

    fn config_lines(self) -> String {
        match self {
            Variant::Good => format!(
                "Subsystem sftp {}\n",
                sftp_server_path().expect("sftp-server").display()
            ),
            Variant::Relative => "Subsystem sftp sftp-server\n".into(),
            Variant::NoSubsystem => String::new(),
            Variant::ForceCommand => {
                "Subsystem sftp sftp-server\nForceCommand internal-sftp\n".into()
            }
        }
    }
}

pub struct Sshd {
    pub variant: Variant,
    pub port: u16,
    /// The OS user the server logs in.
    pub user: String,
    /// Private key that logs in as `user`.
    pub key: PathBuf,
    /// Empty folder for the caller's files (absolute, symlinks resolved).
    pub work: PathBuf,
    /// sshd's DEBUG1 log.
    pub log: PathBuf,
    root: PathBuf,
    child: Child,
    _dir: tempfile::TempDir,
}

impl Sshd {
    /// Starts a server and waits until it greets on its port. Panics (with the log)
    /// when it cannot start.
    pub fn start(variant: Variant) -> Sshd {
        let dir = tempfile::Builder::new()
            .prefix(&format!("rustscp-sshd-{}-", variant.name()))
            .tempdir()
            .unwrap();
        // macOS temp folders sit behind the /var -> /private/var symlink.
        let root = dir.path().canonicalize().unwrap();
        keygen(&root.join("host_ed25519"));
        let key = root.join("user_ed25519");
        keygen(&key);
        fs::copy(root.join("user_ed25519.pub"), root.join("authorized_keys")).unwrap();
        let work = root.join("work");
        fs::create_dir(&work).unwrap();
        let log = root.join("sshd.log");
        let cfg = root.join("sshd_config");
        let user = std::env::var("USER").expect("USER");

        // A port from the OS, released before sshd binds it: another process can take
        // it in between, so a failed bind is retried with a new one.
        for attempt in 1..=5 {
            let port = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
                .unwrap()
                .local_addr()
                .unwrap()
                .port();
            fs::write(
                &cfg,
                format!(
                    "Port {port}\n\
                     ListenAddress 127.0.0.1\n\
                     HostKey {root}/host_ed25519\n\
                     PidFile {root}/sshd.pid\n\
                     AuthorizedKeysFile {root}/authorized_keys\n\
                     UsePAM no\n\
                     StrictModes no\n\
                     PasswordAuthentication no\n\
                     KbdInteractiveAuthentication no\n\
                     PubkeyAuthentication yes\n\
                     UseDNS no\n\
                     PrintMotd no\n\
                     LogLevel DEBUG1\n\
                     {variant}",
                    root = root.display(),
                    variant = variant.config_lines(),
                ),
            )
            .unwrap();
            let _ = fs::remove_file(&log);
            let mut child = Command::new(SSHD)
                .arg("-D")
                .arg("-e")
                .arg("-E")
                .arg(&log)
                .arg("-f")
                .arg(&cfg)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(fs::File::create(root.join("sshd.stderr")).unwrap())
                .spawn()
                .expect("spawn sshd");
            match wait_for_banner(&mut child, port) {
                Ok(()) => {
                    return Sshd {
                        variant,
                        port,
                        user,
                        key,
                        work,
                        log,
                        root,
                        child,
                        _dir: dir,
                    }
                }
                Err(why) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let log_text = fs::read_to_string(&log).unwrap_or_default();
                    if attempt < 5 && log_text.contains("Address already in use") {
                        continue;
                    }
                    panic!(
                        "sshd ({}) did not start: {why}\n--- sshd.log ---\n{log_text}\n\
                         --- stderr ---\n{}",
                        variant.name(),
                        fs::read_to_string(root.join("sshd.stderr")).unwrap_or_default()
                    );
                }
            }
        }
        unreachable!()
    }

    pub fn log_text(&self) -> String {
        fs::read_to_string(&self.log).unwrap_or_default()
    }

    /// Runs the system `sftp` client in batch mode against this server (no user
    /// config, agent or known_hosts). With `server_program` it runs that program as a
    /// command instead of asking for the subsystem (`sftp -s /path`), which is what
    /// compatibility mode does. Returns whether it succeeded and its output.
    pub fn openssh_sftp(&self, batch: &str, server_program: Option<&Path>) -> (bool, String) {
        let batch_file = self.root.join("sftp.batch");
        let out_file = self.root.join("sftp.out");
        fs::write(&batch_file, batch).unwrap();
        let out = fs::File::create(&out_file).unwrap();
        let mut cmd = Command::new("sftp");
        if let Some(program) = server_program {
            cmd.arg("-s").arg(program);
        }
        let mut child = cmd
            .args(["-F", "/dev/null", "-b"])
            .arg(&batch_file)
            .arg("-P")
            .arg(self.port.to_string())
            .arg("-i")
            .arg(&self.key)
            .args([
                "-o",
                "IdentitiesOnly=yes",
                "-o",
                "IdentityAgent=none",
                "-o",
                "BatchMode=yes",
                "-o",
                "StrictHostKeyChecking=no",
                "-o",
                "UserKnownHostsFile=/dev/null",
                "-o",
                "LogLevel=ERROR",
                "-o",
                "ConnectTimeout=10",
            ])
            .arg(format!("{}@127.0.0.1", self.user))
            .stdin(Stdio::null())
            .stdout(out.try_clone().unwrap())
            .stderr(out)
            .spawn()
            .expect("spawn sftp");
        let deadline = Instant::now() + Duration::from_secs(30);
        let ok = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status.success();
            }
            if Instant::now() > deadline {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        (ok, fs::read_to_string(&out_file).unwrap_or_default())
    }

    /// Checks the server behaves as its variant promises for the stock OpenSSH client:
    /// the subsystem works for `Good`/`ForceCommand` and fails for `Relative`/
    /// `NoSubsystem`; `sftp-server` run as a command works everywhere except under
    /// `ForceCommand internal-sftp`, which answers any exec with "This service allows
    /// sftp connections only.". Guards the driver tests against a machine where, say,
    /// the login shell finds a relative `sftp-server` on its PATH.
    pub fn assert_openssh_sftp_behaviour(&self) {
        let batch = format!("ls {}\n", self.work.display());
        let (ok, out) = self.openssh_sftp(&batch, None);
        let expected = matches!(self.variant, Variant::Good | Variant::ForceCommand);
        assert_eq!(
            ok,
            expected,
            "system sftp (subsystem) against the {} server: {out}\n--- sshd.log ---\n{}",
            self.variant.name(),
            self.log_text()
        );
        let program = sftp_server_path().unwrap();
        let (ok, out) = self.openssh_sftp(&batch, Some(&program));
        assert_eq!(
            ok,
            self.variant != Variant::ForceCommand,
            "system sftp (exec {}) against the {} server: {out}\n--- sshd.log ---\n{}",
            program.display(),
            self.variant.name(),
            self.log_text()
        );
    }
}

impl Sshd {
    /// Kills (SIGKILL) every sftp-server process this server started, leaving the
    /// SSH sessions themselves running. Returns how many were killed.
    pub fn kill_sftp_servers(&self) -> usize {
        let mut stack = vec![self.child.id()];
        let mut killed = 0;
        while let Some(pid) = stack.pop() {
            let Ok(out) = Command::new("pgrep")
                .args(["-P", &pid.to_string()])
                .output()
            else {
                continue;
            };
            for child in String::from_utf8_lossy(&out.stdout).lines() {
                let Ok(child) = child.trim().parse::<u32>() else {
                    continue;
                };
                stack.push(child);
                let comm = Command::new("ps")
                    .args(["-o", "comm=", "-p", &child.to_string()])
                    .output()
                    .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
                    .unwrap_or_default();
                if comm.contains("sftp-server") {
                    let _ = Command::new("kill")
                        .args(["-9", &child.to_string()])
                        .status();
                    killed += 1;
                }
            }
        }
        killed
    }
}

impl Drop for Sshd {
    fn drop(&mut self) {
        if std::thread::panicking() {
            let log = self.log_text();
            let lines: Vec<&str> = log.lines().collect();
            eprintln!(
                "--- last lines of the {} server's sshd.log ---\n{}",
                self.variant.name(),
                lines[lines.len().saturating_sub(40)..].join("\n")
            );
        }
        // Sessions run in children of the listener (and their own process groups):
        // stop them first, then the listener.
        let _ = Command::new("pkill")
            .args(["-TERM", "-P", &self.child.id().to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn keygen(path: &Path) {
    let status = Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", "", "-C", "rustscp-test", "-f"])
        .arg(path)
        .stdin(Stdio::null())
        .status()
        .expect("ssh-keygen");
    assert!(status.success(), "ssh-keygen failed for {}", path.display());
}

/// Waits (10 s at most) for an SSH banner on the port while the server keeps running.
fn wait_for_banner(child: &mut Child, port: u16) -> Result<(), String> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            return Err(format!("sshd exited with {status}"));
        }
        if let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(200)) {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let mut banner = [0u8; 8];
            if stream.read_exact(&mut banner).is_ok() && &banner == b"SSH-2.0-" {
                return match child.try_wait().map_err(|e| e.to_string())? {
                    Some(status) => Err(format!("sshd exited with {status}")),
                    None => Ok(()),
                };
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err(format!("no SSH banner on port {port} within 10 s"))
}

//! Lets the system `ssh` client opened by "Open in system terminal" log in with the site's
//! saved password or key passphrase, the way RustSCP itself does, so the terminal window
//! connects without asking.
//!
//! With `SSH_ASKPASS_REQUIRE=force` (OpenSSH 8.4+), ssh runs `$SSH_ASKPASS "<prompt>"` for
//! every question it has. RustSCP points `SSH_ASKPASS` at its own executable and names, in
//! [`ASKPASS_ENV`], a one-shot Unix socket served by the running app: the helper prints the
//! secret for the first prompt that asks for it. Every other question (a new host key, a
//! 2FA code, a retry after a wrong password) is asked on the terminal, as ssh would. The
//! secret never touches the disk; the socket lives in a private folder and is removed after
//! one answer or [`SERVE_FOR`]. Older ssh versions ignore the variables and ask as usual.

use std::io::{self, BufRead, Read, Write};
use std::time::Duration;

/// Environment variable that turns the RustSCP executable into the askpass helper. Its
/// value is `<kind>:<socket path>`, `kind` being `password` or `passphrase`.
pub const ASKPASS_ENV: &str = "RUSTSCP_ASKPASS";
/// How long the app waits for ssh to ask for the secret.
#[cfg_attr(not(unix), allow(dead_code))]
const SERVE_FOR: Duration = Duration::from_secs(120);
/// How long the helper waits for the app's answer.
const FETCH_TIMEOUT: Duration = Duration::from_secs(5);

/// Which of ssh's prompts the saved secret answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretKind {
    /// `user@host's password:`, `(user@host) Password:`
    Password,
    /// `Enter passphrase for key '…':`
    Passphrase,
}

impl SecretKind {
    #[cfg_attr(not(unix), allow(dead_code))]
    fn tag(self) -> &'static str {
        match self {
            Self::Password => "password",
            Self::Passphrase => "passphrase",
        }
    }

    fn from_tag(tag: &str) -> Option<Self> {
        match tag {
            "password" => Some(Self::Password),
            "passphrase" => Some(Self::Passphrase),
            _ => None,
        }
    }

    fn answers(self, prompt: &str) -> bool {
        let p = prompt.to_lowercase();
        match self {
            Self::Password => p.contains("password") && !p.contains("passphrase"),
            Self::Passphrase => p.contains("passphrase"),
        }
    }
}

/// Serves `secret` to the first askpass helper that connects and returns the value for
/// [`ASKPASS_ENV`]. Must be called on the async runtime.
#[cfg(unix)]
pub fn serve_secret(secret: String, kind: SecretKind) -> io::Result<String> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};
    use tokio::io::AsyncWriteExt;
    use zeroize::Zeroize;

    // A short path: Unix socket paths are limited to about 100 bytes.
    let id = uuid::Uuid::new_v4().simple().to_string();
    let dir = runtime_dir().join(format!("rsa-{}", &id[..16]));
    std::fs::DirBuilder::new().mode(0o700).create(&dir)?;
    let socket = dir.join("s");
    let listener = match tokio::net::UnixListener::bind(&socket) {
        Ok(l) => l,
        Err(e) => {
            let _ = std::fs::remove_dir(&dir);
            return Err(e);
        }
    };
    let owner = std::fs::metadata(&dir)?.uid();
    let spec = format!("{}:{}", kind.tag(), socket.display());
    tokio::spawn(async move {
        let mut secret = secret;
        let deadline = tokio::time::Instant::now() + SERVE_FOR;
        while let Ok(Ok((mut stream, _))) =
            tokio::time::timeout_at(deadline, listener.accept()).await
        {
            // The folder is private already; a client of another user is still refused.
            if stream.peer_cred().map(|c| c.uid()).ok() != Some(owner) {
                continue;
            }
            let _ = stream.write_all(secret.as_bytes()).await;
            let _ = stream.shutdown().await;
            break;
        }
        secret.zeroize();
        drop(listener);
        let _ = std::fs::remove_file(&socket);
        let _ = std::fs::remove_dir(&dir);
    });
    Ok(spec)
}

/// The user's private runtime folder where there is one, else the temporary folder (the
/// socket's own folder is private either way).
#[cfg(unix)]
fn runtime_dir() -> std::path::PathBuf {
    if cfg!(target_os = "linux") {
        if let Some(dir) = std::env::var_os("XDG_RUNTIME_DIR").filter(|d| !d.is_empty()) {
            return dir.into();
        }
    }
    std::env::temp_dir()
}

/// The `SSH_ASKPASS` program: prints the answer to `prompt` and returns the exit code.
pub fn run_helper(spec: &str, prompt: &str) -> i32 {
    if let Some((kind, socket)) = spec.split_once(':') {
        if SecretKind::from_tag(kind).is_some_and(|k| k.answers(prompt)) {
            if let Some(secret) = fetch_secret(socket) {
                let mut out = io::stdout().lock();
                let _ = writeln!(out, "{secret}");
                let _ = out.flush();
                return 0;
            }
        }
    }
    match ask_on_terminal(prompt) {
        Ok(answer) => {
            println!("{answer}");
            0
        }
        Err(_) => 1,
    }
}

#[cfg(unix)]
fn fetch_secret(socket: &str) -> Option<String> {
    let mut stream = std::os::unix::net::UnixStream::connect(socket).ok()?;
    stream.set_read_timeout(Some(FETCH_TIMEOUT)).ok()?;
    let mut secret = String::new();
    stream.read_to_string(&mut secret).ok()?;
    (!secret.is_empty()).then_some(secret)
}

#[cfg(not(unix))]
fn fetch_secret(_socket: &str) -> Option<String> {
    None
}

/// Prompts that should not echo what is typed.
fn is_secret_prompt(prompt: &str) -> bool {
    let p = prompt.to_lowercase();
    [
        "password",
        "passphrase",
        "pin",
        "code",
        "token",
        "otp",
        "senha",
    ]
    .iter()
    .any(|w| p.contains(w))
}

/// Asks on the terminal ssh runs in, as ssh does without an askpass program.
#[cfg(unix)]
fn ask_on_terminal(prompt: &str) -> io::Result<String> {
    let mut tty = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/tty")?;
    tty.write_all(prompt.as_bytes())?;
    tty.flush()?;
    let hide = is_secret_prompt(prompt);
    let stty = |arg: &str, tty: &std::fs::File| {
        if let Ok(input) = tty.try_clone() {
            let _ = std::process::Command::new("stty")
                .arg(arg)
                .stdin(input)
                .status();
        }
    };
    if hide {
        stty("-echo", &tty);
    }
    let mut line = String::new();
    let read = io::BufReader::new(tty.try_clone()?).read_line(&mut line);
    if hide {
        stty("echo", &tty);
        let _ = tty.write_all(b"\n");
    }
    read?;
    Ok(line.trim_end_matches(['\r', '\n']).to_string())
}

#[cfg(not(unix))]
fn ask_on_terminal(_prompt: &str) -> io::Result<String> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "no terminal"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_prompt_it_answers() {
        let pw = SecretKind::Password;
        assert!(pw.answers("deploy@example.com's password: "));
        assert!(pw.answers("(deploy@example.com) Password: "));
        assert!(!pw.answers("Enter passphrase for key '/Users/me/.ssh/id_ed25519': "));
        assert!(
            !pw.answers("Are you sure you want to continue connecting (yes/no/[fingerprint])? ")
        );
        assert!(!pw.answers("Verification code: "));
        let pp = SecretKind::Passphrase;
        assert!(pp.answers("Enter passphrase for key '/k': "));
        assert!(!pp.answers("deploy@host's password: "));
        assert_eq!(SecretKind::from_tag("password"), Some(pw));
        assert_eq!(SecretKind::from_tag("passphrase"), Some(pp));
        assert_eq!(SecretKind::from_tag("other"), None);
        assert!(is_secret_prompt("Verification code: "));
        assert!(!is_secret_prompt(
            "Are you sure you want to continue connecting (yes/no)? "
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn serves_the_secret_once() {
        let spec = serve_secret("s3cr3t pw".to_string(), SecretKind::Password).unwrap();
        let (kind, socket) = spec.split_once(':').unwrap();
        assert_eq!(kind, "password");
        let socket = socket.to_string();
        assert!(socket.len() < 100, "{socket}");
        let dir = std::path::Path::new(&socket)
            .parent()
            .unwrap()
            .to_path_buf();
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700);
        }
        let first = tokio::task::spawn_blocking({
            let socket = socket.clone();
            move || fetch_secret(&socket)
        })
        .await
        .unwrap();
        assert_eq!(first.as_deref(), Some("s3cr3t pw"));
        // One answer only: the socket and its folder are gone.
        for _ in 0..50 {
            if !dir.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(!dir.exists());
        assert_eq!(fetch_secret(&socket), None);
    }
}

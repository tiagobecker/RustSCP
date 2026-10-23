//! The built-in terminal: interactive SSH shells that keep running in the background while
//! the user works elsewhere in RustSCP.
//!
//! Output reaches the window as it arrives (`terminal-output`, numbered so a reloaded
//! window can redraw from [`terminal_snapshot`] without gaps). With bash, the prompt hook
//! (see [`rustscp_core::shell_bootstrap`]) reports every command that finishes: the window
//! is told (`terminal-command`, with its exit status and the end of its output, to explain
//! a failure) and the command is kept in a local history that outlives the server session.

use crate::commands::{get_vfs, posix_shell_available, sftp_driver_of, AppState};
use rustscp_core::terminal::{strip_ansi, ShellEvent, ShellEventParser, SHELL_EVENT_OSC};
use rustscp_core::{
    get_rustscp_config_dir, shell_bootstrap, Protocol, TerminalConnector, TerminalHandle,
    TerminalOptions, TerminalSink, TerminalSize,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

/// Output kept per terminal to redraw it when the window reloads (bytes of text).
const SCROLLBACK_BYTES: usize = 2 * 1024 * 1024;
/// Output of the running command kept to explain why it failed (bytes).
const TAIL_BYTES: usize = 16 * 1024;
/// Characters of that output sent with `terminal-command`.
const TAIL_CHARS_SENT: usize = 2000;
/// A command that ran at least this long is reported even when the shell did not add it
/// to its history (a repeated command with `HISTCONTROL=ignoredups`).
const REPORT_UNNAMED_AFTER: Duration = Duration::from_secs(2);
/// Output is gathered this long before it is sent to the window, so a flood of small
/// writes becomes a few events.
const FLUSH_DELAY: Duration = Duration::from_millis(12);
const FLUSH_MAX: usize = 256 * 1024;
/// Commands kept in the local history.
const HISTORY_MAX: usize = 10_000;
const HISTORY_FILE: &str = "terminal-history.jsonl";

fn lock<T>(m: &StdMutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn emit<P: Serialize + Clone>(app: &AppHandle, event: &str, payload: P) {
    if let Err(e) = app.emit(event, payload) {
        tracing::debug!("could not send {event} to the window: {e}");
    }
}

// ---------------------------------------------------------------------------
// Events and replies
// ---------------------------------------------------------------------------

/// A terminal as the window shows it.
#[derive(Debug, Clone, Serialize)]
pub struct TerminalInfo {
    pub id: String,
    pub session_id: String,
    pub title: String,
    pub host: String,
    pub username: String,
    /// `user@host:port`: groups the local history by server.
    pub site_key: String,
    /// `connecting`, `running`, `exited` (the shell ended) or `lost` (connection error).
    pub status: &'static str,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
    pub cwd: Option<String>,
    /// The bash prompt hook reports commands (history, notifications).
    pub integration: bool,
    /// A command line was entered and its prompt has not come back yet.
    pub busy: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
struct OutputEvent<'a> {
    id: &'a str,
    seq: u64,
    data: String,
}

#[derive(Debug, Clone, Serialize)]
struct ExitEvent<'a> {
    id: &'a str,
    exit_code: Option<i32>,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct StateEvent<'a> {
    id: &'a str,
    busy: bool,
    integration: bool,
    cwd: Option<String>,
}

/// A command that finished (its prompt came back).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CommandEvent {
    pub id: String,
    /// The command line, when the shell recorded it in its history.
    pub command: Option<String>,
    pub exit_code: i32,
    pub duration_ms: Option<u64>,
    pub cwd: Option<String>,
    /// The end of what the command printed, as plain text.
    pub output_tail: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TerminalSnapshot {
    pub data: String,
    /// Number of the last output event included; later events continue from here.
    pub seq: u64,
}

// ---------------------------------------------------------------------------
// Terminal state
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
enum Status {
    Connecting,
    Running,
    Exited(Option<i32>),
    Lost(String),
}

/// Everything about a terminal that changes while it runs.
struct Live {
    handle: Option<TerminalHandle>,
    /// Bumped on every (re)connection: a connection that ends after it was replaced does
    /// not end the terminal.
    generation: u64,
    status: Status,
    scrollback: String,
    seq: u64,
    utf8_carry: Vec<u8>,
    parser: ShellEventParser,
    cwd: Option<String>,
    integration: bool,
    busy_since: Option<Instant>,
    pending_command: Option<String>,
    tail: VecDeque<u8>,
}

/// What one piece of output changed.
struct Absorbed {
    text: String,
    seq: u64,
    finished: Vec<CommandEvent>,
    state_changed: bool,
}

impl Live {
    fn new() -> Self {
        Self {
            handle: None,
            generation: 0,
            status: Status::Connecting,
            scrollback: String::new(),
            seq: 0,
            utf8_carry: Vec::new(),
            parser: ShellEventParser::default(),
            cwd: None,
            integration: false,
            busy_since: None,
            pending_command: None,
            tail: VecDeque::new(),
        }
    }

    /// Starts over for a new connection (the scrollback and folder are kept).
    fn reset_connection(&mut self) -> u64 {
        self.generation += 1;
        self.handle = None;
        self.status = Status::Connecting;
        self.utf8_carry.clear();
        self.parser = ShellEventParser::default();
        self.integration = false;
        self.busy_since = None;
        self.pending_command = None;
        self.tail.clear();
        self.generation
    }

    fn busy(&self) -> bool {
        self.busy_since.is_some()
    }

    /// Notes keystrokes sent to the shell: Enter at the prompt starts a command. `true`
    /// when that changed the state.
    fn note_input(&mut self, data: &[u8], now: Instant) -> bool {
        if self.integration && self.busy_since.is_none() && data.contains(&b'\r') {
            self.busy_since = Some(now);
            self.tail.clear();
            return true;
        }
        false
    }

    fn absorb(&mut self, id: &str, data: &[u8], now: Instant) -> Absorbed {
        if self.status == Status::Connecting {
            self.status = Status::Running;
        }
        let mut events = Vec::new();
        self.parser.feed(data, &mut events);
        if self.busy_since.is_some() {
            self.tail.extend(data);
            let extra = self.tail.len().saturating_sub(TAIL_BYTES);
            self.tail.drain(..extra);
        }
        let text = decode_utf8(&mut self.utf8_carry, data);
        self.scrollback.push_str(&text);
        trim_scrollback(&mut self.scrollback, SCROLLBACK_BYTES);
        self.seq += 1;

        let mut finished = Vec::new();
        let mut state_changed = false;
        for event in events {
            match event {
                ShellEvent::Command(command) => self.pending_command = Some(command),
                ShellEvent::Cwd(path) => {
                    if self.cwd.as_deref() != Some(path.as_str()) {
                        self.cwd = Some(path);
                        state_changed = true;
                    }
                }
                ShellEvent::Prompt(exit_code) => {
                    if !self.integration {
                        self.integration = true;
                        state_changed = true;
                    }
                    let started = self.busy_since.take();
                    state_changed |= started.is_some();
                    let duration = started.map(|t| now.saturating_duration_since(t));
                    let command = self.pending_command.take();
                    if command.is_some() || duration.is_some_and(|d| d >= REPORT_UNNAMED_AFTER) {
                        // What the command printed ends where the prompt hook's report begins.
                        let mut tail: Vec<u8> = self.tail.iter().copied().collect();
                        let marker = format!("\x1b]{SHELL_EVENT_OSC};");
                        if let Some(end) = tail
                            .windows(marker.len())
                            .position(|w| w == marker.as_bytes())
                        {
                            tail.truncate(end);
                        }
                        finished.push(CommandEvent {
                            id: id.to_string(),
                            command,
                            exit_code,
                            duration_ms: duration.map(|d| d.as_millis() as u64),
                            cwd: self.cwd.clone(),
                            output_tail: last_chars(&strip_ansi(&tail), TAIL_CHARS_SENT),
                        });
                    }
                    self.tail.clear();
                }
            }
        }
        Absorbed {
            text,
            seq: self.seq,
            finished,
            state_changed,
        }
    }
}

/// Decodes UTF-8 that may arrive split across reads: an incomplete sequence at the end is
/// kept in `carry` for the next call; invalid bytes become U+FFFD.
fn decode_utf8(carry: &mut Vec<u8>, data: &[u8]) -> String {
    carry.extend_from_slice(data);
    let mut out = String::with_capacity(carry.len());
    let mut rest: &[u8] = carry;
    loop {
        match std::str::from_utf8(rest) {
            Ok(text) => {
                out.push_str(text);
                rest = &[];
                break;
            }
            Err(e) => {
                let (valid, after) = rest.split_at(e.valid_up_to());
                out.push_str(std::str::from_utf8(valid).unwrap_or_default());
                match e.error_len() {
                    Some(len) => {
                        out.push('\u{FFFD}');
                        rest = &after[len..];
                    }
                    None => {
                        rest = after;
                        break;
                    }
                }
            }
        }
    }
    *carry = rest.to_vec();
    out
}

/// Drops the oldest output once `text` is over `max` bytes, at a line start when there is
/// one, keeping three quarters so trimming does not happen on every write.
fn trim_scrollback(text: &mut String, max: usize) {
    if text.len() <= max {
        return;
    }
    let mut cut = text.len() - max * 3 / 4;
    while !text.is_char_boundary(cut) {
        cut += 1;
    }
    if let Some(nl) = text[cut..].find('\n') {
        cut += nl + 1;
    }
    text.drain(..cut);
}

fn last_chars(text: &str, max: usize) -> String {
    let text = text.trim_end();
    let count = text.chars().count();
    text.chars().skip(count.saturating_sub(max)).collect()
}

struct Terminal {
    id: String,
    session_id: String,
    title: String,
    host: String,
    username: String,
    site_key: String,
    start_path: String,
    connector: TerminalConnector,
    /// The login shell reads `sh` syntax, so the bootstrap (folder, prompt hook) can run.
    posix_shell: bool,
    keep_history: bool,
    created_at: String,
    live: StdMutex<Live>,
}

impl Terminal {
    fn info(&self) -> TerminalInfo {
        let live = lock(&self.live);
        let (status, exit_code, error) = match &live.status {
            Status::Connecting => ("connecting", None, None),
            Status::Running => ("running", None, None),
            Status::Exited(code) => ("exited", *code, None),
            Status::Lost(e) => ("lost", None, Some(e.clone())),
        };
        TerminalInfo {
            id: self.id.clone(),
            session_id: self.session_id.clone(),
            title: self.title.clone(),
            host: self.host.clone(),
            username: self.username.clone(),
            site_key: self.site_key.clone(),
            status,
            exit_code,
            error,
            cwd: live.cwd.clone(),
            integration: live.integration,
            busy: live.busy(),
            created_at: self.created_at.clone(),
        }
    }

    fn handle(&self) -> Result<TerminalHandle, String> {
        lock(&self.live)
            .handle
            .clone()
            .filter(|h| !h.is_closed())
            .ok_or_else(|| "The terminal is not connected; reconnect it first".to_string())
    }

    /// Opens a new connection with a shell in `path` (also after the previous one ended).
    async fn connect(
        self: &Arc<Self>,
        app: &AppHandle,
        history: &Arc<HistoryStore>,
        path: &str,
        size: TerminalSize,
    ) -> Result<(), String> {
        let generation = {
            let mut live = lock(&self.live);
            if let Some(old) = live.handle.take() {
                old.close();
            }
            live.reset_connection()
        };
        let (tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(flush_output(
            app.clone(),
            self.clone(),
            history.clone(),
            generation,
            rx,
        ));
        let options = TerminalOptions {
            size,
            command: self.posix_shell.then(|| shell_bootstrap(path)),
        };
        match self.connector.open(options, WindowSink(tx)).await {
            Ok(handle) => {
                let mut live = lock(&self.live);
                if live.generation == generation {
                    live.handle = Some(handle);
                } else {
                    handle.close();
                }
                Ok(())
            }
            Err(e) => {
                let message = e.to_string();
                let mut live = lock(&self.live);
                if live.generation == generation {
                    live.status = Status::Lost(message.clone());
                }
                Err(message)
            }
        }
    }

    fn absorb_output(&self, app: &AppHandle, history: &HistoryStore, generation: u64, data: &[u8]) {
        let (absorbed, state) = {
            let mut live = lock(&self.live);
            if live.generation != generation {
                return;
            }
            let absorbed = live.absorb(&self.id, data, Instant::now());
            let state = absorbed
                .state_changed
                .then(|| (live.busy(), live.integration, live.cwd.clone()));
            (absorbed, state)
        };
        emit(
            app,
            "terminal-output",
            OutputEvent {
                id: &self.id,
                seq: absorbed.seq,
                data: absorbed.text,
            },
        );
        for finished in absorbed.finished {
            if self.keep_history {
                if let Some(command) = &finished.command {
                    history.add(HistoryEntry {
                        id: uuid::Uuid::new_v4().simple().to_string(),
                        command: command.clone(),
                        site_key: self.site_key.clone(),
                        site_name: self.title.clone(),
                        cwd: finished.cwd.clone(),
                        exit_code: Some(finished.exit_code),
                        duration_ms: finished.duration_ms,
                        finished_at: chrono::Utc::now().to_rfc3339(),
                    });
                }
            }
            emit(app, "terminal-command", finished);
        }
        if let Some((busy, integration, cwd)) = state {
            emit(
                app,
                "terminal-state",
                StateEvent {
                    id: &self.id,
                    busy,
                    integration,
                    cwd,
                },
            );
        }
    }

    fn absorb_closed(
        &self,
        app: &AppHandle,
        generation: u64,
        exit_code: Option<i32>,
        error: Option<String>,
    ) {
        {
            let mut live = lock(&self.live);
            if live.generation != generation {
                return;
            }
            live.handle = None;
            live.busy_since = None;
            live.status = match &error {
                Some(e) => Status::Lost(e.clone()),
                None => Status::Exited(exit_code),
            };
        }
        emit(
            app,
            "terminal-exit",
            ExitEvent {
                id: &self.id,
                exit_code,
                error,
            },
        );
    }
}

enum Flush {
    Data(Vec<u8>),
    Closed(Option<i32>, Option<String>),
}

/// Hands the shell's output from the connection task to [`flush_output`].
struct WindowSink(mpsc::UnboundedSender<Flush>);

impl TerminalSink for WindowSink {
    fn output(&mut self, data: &[u8]) {
        let _ = self.0.send(Flush::Data(data.to_vec()));
    }

    fn closed(&mut self, exit_status: Option<i32>, error: Option<String>) {
        let _ = self.0.send(Flush::Closed(exit_status, error));
    }
}

/// Sends one connection's output to the window in batches, in order, then its end.
async fn flush_output(
    app: AppHandle,
    terminal: Arc<Terminal>,
    history: Arc<HistoryStore>,
    generation: u64,
    mut rx: mpsc::UnboundedReceiver<Flush>,
) {
    while let Some(first) = rx.recv().await {
        let mut data = Vec::new();
        let mut closed = None;
        match first {
            Flush::Data(d) => data = d,
            Flush::Closed(code, error) => closed = Some((code, error)),
        }
        if closed.is_none() {
            let deadline = tokio::time::Instant::now() + FLUSH_DELAY;
            while data.len() < FLUSH_MAX {
                match tokio::time::timeout_at(deadline, rx.recv()).await {
                    Ok(Some(Flush::Data(more))) => data.extend(more),
                    Ok(Some(Flush::Closed(code, error))) => {
                        closed = Some((code, error));
                        break;
                    }
                    Ok(None) | Err(_) => break,
                }
            }
        }
        if !data.is_empty() {
            terminal.absorb_output(&app, &history, generation, &data);
        }
        if let Some((code, error)) = closed {
            terminal.absorb_closed(&app, generation, code, error);
            break;
        }
    }
}

pub struct TerminalState {
    terminals: StdMutex<HashMap<String, Arc<Terminal>>>,
    history: Arc<HistoryStore>,
}

impl Default for TerminalState {
    fn default() -> Self {
        Self {
            terminals: StdMutex::new(HashMap::new()),
            history: Arc::new(HistoryStore::new(
                get_rustscp_config_dir().join(HISTORY_FILE),
            )),
        }
    }
}

impl TerminalState {
    fn get(&self, id: &str) -> Result<Arc<Terminal>, String> {
        lock(&self.terminals)
            .get(id)
            .cloned()
            .ok_or_else(|| "This terminal is no longer open".to_string())
    }
}

/// Terminal ids come from the window (so it can show a tab before the connection is up).
fn valid_terminal_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err("Invalid terminal id".to_string())
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Opens a terminal on the server of SSH session `session_id`, in folder `path`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn terminal_open(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    terminals: tauri::State<'_, TerminalState>,
    id: String,
    session_id: String,
    path: String,
    cols: u16,
    rows: u16,
    keep_history: Option<bool>,
) -> Result<TerminalInfo, String> {
    valid_terminal_id(&id)?;
    if lock(&terminals.terminals).contains_key(&id) {
        return Err("A terminal with this id is already open".to_string());
    }
    let vfs = get_vfs(&state, &session_id).await?;
    if vfs.protocol() != Protocol::Sftp {
        return Err(
            "The built-in terminal needs an SSH (SFTP) connection; this session has no remote shell"
                .to_string(),
        );
    }
    let driver = sftp_driver_of(&vfs)
        .ok_or_else(|| "This SSH session cannot open a terminal".to_string())?;
    let posix_shell = posix_shell_available(&vfs).await;
    let connector = driver.terminal_connector();
    let cfg = connector.config();
    let host = cfg.host.trim().to_string();
    let username = cfg.username.trim().to_string();
    let port = if cfg.port == 0 { 22 } else { cfg.port };
    let title = if cfg.name.trim().is_empty() {
        format!("{username}@{host}")
    } else {
        cfg.name.trim().to_string()
    };
    let terminal = Arc::new(Terminal {
        id: id.clone(),
        session_id,
        title,
        site_key: format!("{username}@{host}:{port}"),
        host,
        username,
        start_path: path.clone(),
        connector,
        posix_shell,
        keep_history: keep_history.unwrap_or(true),
        created_at: chrono::Utc::now().to_rfc3339(),
        live: StdMutex::new(Live::new()),
    });
    lock(&terminals.terminals).insert(id.clone(), terminal.clone());
    let size = TerminalSize { cols, rows };
    if let Err(e) = terminal
        .connect(&app, &terminals.history, &path, size)
        .await
    {
        lock(&terminals.terminals).remove(&id);
        return Err(e);
    }
    Ok(terminal.info())
}

/// Keystrokes from the terminal view. `binary` data (mouse reports) is one byte per
/// character.
#[tauri::command]
pub fn terminal_write(
    app: AppHandle,
    terminals: tauri::State<'_, TerminalState>,
    id: String,
    data: String,
    binary: Option<bool>,
) -> Result<(), String> {
    let terminal = terminals.get(&id)?;
    let bytes: Vec<u8> = if binary.unwrap_or(false) {
        data.chars().map(|c| c as u32 as u8).collect()
    } else {
        data.into_bytes()
    };
    send_input(&app, &terminal, bytes)
}

fn send_input(app: &AppHandle, terminal: &Terminal, bytes: Vec<u8>) -> Result<(), String> {
    let handle = terminal.handle()?;
    let changed = {
        let mut live = lock(&terminal.live);
        live.note_input(&bytes, Instant::now())
            .then(|| (live.busy(), live.integration, live.cwd.clone()))
    };
    if !handle.write(bytes) {
        return Err("The terminal is not connected; reconnect it first".to_string());
    }
    if let Some((busy, integration, cwd)) = changed {
        emit(
            app,
            "terminal-state",
            StateEvent {
                id: &terminal.id,
                busy,
                integration,
                cwd,
            },
        );
    }
    Ok(())
}

/// Runs `command` from the command bar: whatever was typed at the prompt is cleared first
/// (only when the shell is known to be at its prompt), then the command and Enter are
/// sent. Without the prompt hook the command is recorded in the history right away.
#[tauri::command]
pub fn terminal_run(
    app: AppHandle,
    terminals: tauri::State<'_, TerminalState>,
    id: String,
    command: String,
) -> Result<(), String> {
    let terminal = terminals.get(&id)?;
    let command = command.trim_end_matches(['\r', '\n']).to_string();
    if command.trim().is_empty() {
        return Ok(());
    }
    let (at_prompt, integration) = {
        let live = lock(&terminal.live);
        (live.integration && !live.busy(), live.integration)
    };
    let mut bytes = Vec::with_capacity(command.len() + 2);
    if at_prompt {
        bytes.push(0x15); // Ctrl+U: the line editor (or the tty) discards the typed line
    }
    bytes.extend(command.replace('\n', "\r").as_bytes());
    bytes.push(b'\r');
    send_input(&app, &terminal, bytes)?;
    if !integration && terminal.keep_history {
        terminals.history.add(HistoryEntry {
            id: uuid::Uuid::new_v4().simple().to_string(),
            command,
            site_key: terminal.site_key.clone(),
            site_name: terminal.title.clone(),
            cwd: lock(&terminal.live).cwd.clone(),
            exit_code: None,
            duration_ms: None,
            finished_at: chrono::Utc::now().to_rfc3339(),
        });
    }
    Ok(())
}

#[tauri::command]
pub fn terminal_resize(
    terminals: tauri::State<'_, TerminalState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let terminal = terminals.get(&id)?;
    if let Ok(handle) = terminal.handle() {
        handle.resize(TerminalSize { cols, rows });
    }
    Ok(())
}

/// Hangs up and forgets the terminal.
#[tauri::command]
pub fn terminal_close(
    terminals: tauri::State<'_, TerminalState>,
    id: String,
) -> Result<(), String> {
    let removed = lock(&terminals.terminals).remove(&id);
    if let Some(terminal) = removed {
        if let Some(handle) = lock(&terminal.live).handle.take() {
            handle.close();
        }
    }
    Ok(())
}

/// A new connection for a terminal whose shell ended or whose connection was lost, in
/// the folder it was last in. It also works after the file session was closed.
#[tauri::command]
pub async fn terminal_reconnect(
    app: AppHandle,
    terminals: tauri::State<'_, TerminalState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<TerminalInfo, String> {
    let terminal = terminals.get(&id)?;
    let path = lock(&terminal.live)
        .cwd
        .clone()
        .unwrap_or_else(|| terminal.start_path.clone());
    terminal
        .connect(&app, &terminals.history, &path, TerminalSize { cols, rows })
        .await?;
    Ok(terminal.info())
}

#[tauri::command]
pub fn terminal_list(terminals: tauri::State<'_, TerminalState>) -> Vec<TerminalInfo> {
    let mut list: Vec<TerminalInfo> = lock(&terminals.terminals)
        .values()
        .map(|t| t.info())
        .collect();
    list.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    list
}

/// What the terminal printed so far (the most recent part), to redraw it after the
/// window reloads.
#[tauri::command]
pub fn terminal_snapshot(
    terminals: tauri::State<'_, TerminalState>,
    id: String,
) -> Result<TerminalSnapshot, String> {
    let terminal = terminals.get(&id)?;
    let live = lock(&terminal.live);
    Ok(TerminalSnapshot {
        data: live.scrollback.clone(),
        seq: live.seq,
    })
}

/// The local command history, newest first: commands containing `query` (any case), of
/// one server when `site_key` is given.
#[tauri::command]
pub async fn terminal_history(
    terminals: tauri::State<'_, TerminalState>,
    query: Option<String>,
    site_key: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<HistoryEntry>, String> {
    let history = terminals.history.clone();
    tokio::task::spawn_blocking(move || {
        history.list(
            query.as_deref().unwrap_or(""),
            site_key.as_deref(),
            limit.unwrap_or(500).min(HISTORY_MAX),
        )
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn terminal_history_delete(
    terminals: tauri::State<'_, TerminalState>,
    ids: Vec<String>,
) -> Result<usize, String> {
    let history = terminals.history.clone();
    tokio::task::spawn_blocking(move || history.delete(&ids))
        .await
        .map_err(|e| e.to_string())
}

/// Clears the history of one server, or all of it.
#[tauri::command]
pub async fn terminal_history_clear(
    terminals: tauri::State<'_, TerminalState>,
    site_key: Option<String>,
) -> Result<usize, String> {
    let history = terminals.history.clone();
    tokio::task::spawn_blocking(move || history.clear(site_key.as_deref()))
        .await
        .map_err(|e| e.to_string())
}

/// Text on the system clipboard, for "Paste" in the terminal's menu: the WebView can only
/// read the clipboard during a paste shortcut (or after an extra confirmation).
#[tauri::command]
pub async fn clipboard_read_text() -> Result<String, String> {
    tokio::task::spawn_blocking(|| {
        arboard::Clipboard::new()
            .and_then(|mut c| c.get_text())
            .map_err(|e| format!("Could not read the clipboard: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Whether `url` may be handed to the system browser: http(s), printable, no spaces.
fn openable_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    (lower.starts_with("http://") || lower.starts_with("https://"))
        && url.len() <= 4096
        && !url.chars().any(|c| c.is_control() || c.is_whitespace())
}

/// Opens a link clicked in the terminal in the system browser.
#[tauri::command]
pub async fn open_external_url(url: String) -> Result<(), String> {
    if !openable_url(&url) {
        return Err("Only web links (http/https) can be opened".to_string());
    }
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = tokio::process::Command::new("open");
        c.arg(&url);
        c
    };
    // The URL is one argument of a program that is not a shell.
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = tokio::process::Command::new("rundll32.exe");
        c.arg("url.dll,FileProtocolHandler").arg(&url);
        c
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut cmd = {
        let mut c = tokio::process::Command::new("xdg-open");
        c.arg(&url);
        c
    };
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open the link: {e}"))
}

// ---------------------------------------------------------------------------
// Local command history
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HistoryEntry {
    pub id: String,
    pub command: String,
    pub site_key: String,
    #[serde(default)]
    pub site_name: String,
    #[serde(default)]
    pub cwd: Option<String>,
    /// `None` when the shell did not report it (no prompt hook).
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub duration_ms: Option<u64>,
    pub finished_at: String,
}

/// Commands run in built-in terminals, one JSON object per line in a file private to
/// the user. Loaded on first use; new commands are appended, and the file is rewritten
/// when entries are deleted or it grows past [`HISTORY_MAX`] by a fifth.
pub struct HistoryStore {
    path: PathBuf,
    entries: StdMutex<Option<Vec<HistoryEntry>>>,
}

impl HistoryStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            entries: StdMutex::new(None),
        }
    }

    fn with_entries<R>(&self, f: impl FnOnce(&mut Vec<HistoryEntry>) -> R) -> R {
        let mut guard = lock(&self.entries);
        let entries = guard.get_or_insert_with(|| read_history(&self.path));
        f(entries)
    }

    /// Records a command. Like bash with `HISTCONTROL=ignorespace`, a command typed with
    /// a leading space is not recorded.
    pub fn add(&self, entry: HistoryEntry) {
        if entry.command.trim().is_empty() || entry.command.starts_with(' ') {
            return;
        }
        self.with_entries(|entries| {
            entries.push(entry.clone());
            if entries.len() > HISTORY_MAX + HISTORY_MAX / 5 {
                let extra = entries.len() - HISTORY_MAX;
                entries.drain(..extra);
                self.rewrite(entries);
            } else if let Err(e) = append_history(&self.path, &entry) {
                tracing::warn!("could not save the terminal history: {e}");
            }
        });
    }

    pub fn list(&self, query: &str, site_key: Option<&str>, limit: usize) -> Vec<HistoryEntry> {
        let query = query.trim().to_lowercase();
        self.with_entries(|entries| {
            entries
                .iter()
                .rev()
                .filter(|e| site_key.is_none_or(|k| e.site_key == k))
                .filter(|e| query.is_empty() || e.command.to_lowercase().contains(&query))
                .take(limit)
                .cloned()
                .collect()
        })
    }

    pub fn delete(&self, ids: &[String]) -> usize {
        self.with_entries(|entries| {
            let before = entries.len();
            entries.retain(|e| !ids.contains(&e.id));
            let removed = before - entries.len();
            if removed > 0 {
                self.rewrite(entries);
            }
            removed
        })
    }

    pub fn clear(&self, site_key: Option<&str>) -> usize {
        self.with_entries(|entries| {
            let before = entries.len();
            entries.retain(|e| site_key.is_some_and(|k| e.site_key != k));
            let removed = before - entries.len();
            if removed > 0 {
                self.rewrite(entries);
            }
            removed
        })
    }

    fn rewrite(&self, entries: &[HistoryEntry]) {
        if let Err(e) = write_history(&self.path, entries) {
            tracing::warn!("could not save the terminal history: {e}");
        }
    }
}

fn read_history(path: &Path) -> Vec<HistoryEntry> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut entries: Vec<HistoryEntry> = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    let extra = entries.len().saturating_sub(HISTORY_MAX);
    entries.drain(..extra);
    entries
}

fn private_file_options() -> std::fs::OpenOptions {
    let mut options = std::fs::OpenOptions::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
}

fn append_history(path: &Path, entry: &HistoryEntry) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut line = serde_json::to_string(entry).map_err(std::io::Error::other)?;
    line.push('\n');
    private_file_options()
        .create(true)
        .append(true)
        .open(path)?
        .write_all(line.as_bytes())
}

/// Replaces the file atomically (a crash never leaves half a history).
fn write_history(path: &Path, entries: &[HistoryEntry]) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir)?;
    let temp = dir.join(format!(
        ".{}.{}.tmp",
        HISTORY_FILE,
        uuid::Uuid::new_v4().simple()
    ));
    let mut text = String::new();
    for entry in entries {
        text.push_str(&serde_json::to_string(entry).map_err(std::io::Error::other)?);
        text.push('\n');
    }
    let result = private_file_options()
        .create_new(true)
        .write(true)
        .open(&temp)
        .and_then(|mut f| {
            f.write_all(text.as_bytes())?;
            f.sync_all()
        })
        .and_then(|()| std::fs::rename(&temp, path));
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, command: &str, site: &str) -> HistoryEntry {
        HistoryEntry {
            id: id.to_string(),
            command: command.to_string(),
            site_key: site.to_string(),
            site_name: "Server".to_string(),
            cwd: Some("/srv".to_string()),
            exit_code: Some(0),
            duration_ms: Some(10),
            finished_at: "2026-10-23T12:00:00Z".to_string(),
        }
    }

    #[test]
    fn decodes_utf8_split_across_reads() {
        let text = "ação ✓ 🦀";
        let bytes = text.as_bytes();
        for split in 0..=bytes.len() {
            let mut carry = Vec::new();
            let (a, b) = bytes.split_at(split);
            let mut out = decode_utf8(&mut carry, a);
            out.push_str(&decode_utf8(&mut carry, b));
            assert_eq!(out, text, "split at {split}");
            assert!(carry.is_empty());
        }
        let mut carry = Vec::new();
        assert_eq!(decode_utf8(&mut carry, b"a\xffb"), "a\u{FFFD}b");
    }

    #[test]
    fn trims_scrollback_at_a_line_start() {
        let mut text = "line one\nline two\nline three\n".to_string();
        trim_scrollback(&mut text, 20);
        assert_eq!(text, "line three\n");
        let mut text = "ééééééééééééééééééééééé".to_string();
        trim_scrollback(&mut text, 10);
        assert!(text.len() <= 10 && text.chars().all(|c| c == 'é'));
    }

    fn prompt(command: Option<&str>, code: i32) -> Vec<u8> {
        let mut out = Vec::new();
        if let Some(c) = command {
            out.extend(format!("\x1b]6973;cmd;{c}\x07").as_bytes());
        }
        out.extend(format!("\x1b]6973;cwd;/srv\x07\x1b]6973;done;{code}\x07$ ").as_bytes());
        out
    }

    #[test]
    fn reports_finished_commands() {
        let mut live = Live::new();
        let t0 = Instant::now();
        // Login: the first prompt only turns the integration on.
        let a = live.absorb("t", &prompt(None, 0), t0);
        assert!(a.finished.is_empty() && a.state_changed);
        assert!(live.integration && live.status == Status::Running);
        assert_eq!(live.cwd.as_deref(), Some("/srv"));

        // Enter starts a command; its output and the next prompt finish it.
        assert!(live.note_input(b"ls /nope\r", t0));
        assert!(!live.note_input(b"\r", t0), "already running");
        live.absorb(
            "t",
            b"ls: cannot access '/nope': \x1b[1mNo such file\x1b[0m\r\n",
            t0,
        );
        let a = live.absorb(
            "t",
            &prompt(Some("ls /nope"), 2),
            t0 + Duration::from_millis(1500),
        );
        assert_eq!(
            a.finished,
            vec![CommandEvent {
                id: "t".to_string(),
                command: Some("ls /nope".to_string()),
                exit_code: 2,
                duration_ms: Some(1500),
                cwd: Some("/srv".to_string()),
                output_tail: "ls: cannot access '/nope': No such file".to_string(),
            }]
        );
        assert!(!live.busy());

        // Enter on an empty line: nothing to report.
        live.note_input(b"\r", t0);
        assert!(live.absorb("t", &prompt(None, 0), t0).finished.is_empty());

        // A long command the shell did not record (ignoredups) is still reported.
        live.note_input(b"\r", t0);
        let a = live.absorb("t", &prompt(None, 0), t0 + Duration::from_secs(5));
        assert_eq!(a.finished.len(), 1);
        assert_eq!(a.finished[0].command, None);
        assert_eq!(a.finished[0].duration_ms, Some(5000));
    }

    #[test]
    fn input_does_not_start_commands_without_the_hook() {
        let mut live = Live::new();
        assert!(!live.note_input(b"ls\r", Instant::now()));
        let a = live.absorb("t", b"plain output", Instant::now());
        assert_eq!(a.text, "plain output");
        assert_eq!(a.seq, 1);
        assert!(!live.integration);
    }

    #[test]
    fn history_is_saved_privately_and_survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cfg").join(HISTORY_FILE);
        let store = HistoryStore::new(path.clone());
        store.add(entry("1", "df -h", "a@h:22"));
        store.add(entry("2", "systemctl status nginx", "b@h:22"));
        store.add(entry("3", " secret --password x", "a@h:22"));
        store.add(entry("4", "   ", "a@h:22"));
        store.add(entry("5", "DF -i", "a@h:22"));

        let reopened = HistoryStore::new(path.clone());
        let all = reopened.list("", None, 100);
        assert_eq!(
            all.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            ["5", "2", "1"]
        );
        assert_eq!(reopened.list("df", Some("a@h:22"), 100).len(), 2);
        assert_eq!(reopened.list("df", Some("a@h:22"), 1)[0].id, "5");
        assert_eq!(reopened.list("nginx", Some("a@h:22"), 100).len(), 0);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }

        assert_eq!(reopened.delete(&["1".to_string()]), 1);
        assert_eq!(reopened.clear(Some("b@h:22")), 1);
        let again = HistoryStore::new(path.clone());
        assert_eq!(again.list("", None, 100).len(), 1);
        assert_eq!(again.clear(None), 1);
        assert!(HistoryStore::new(path).list("", None, 100).is_empty());
    }

    #[test]
    fn history_keeps_the_newest_entries() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(HISTORY_FILE);
        let store = HistoryStore::new(path.clone());
        for i in 0..(HISTORY_MAX + HISTORY_MAX / 5 + 1) {
            store.add(entry(&i.to_string(), &format!("cmd {i}"), "a@h:22"));
        }
        let entries = HistoryStore::new(path).list("", None, usize::MAX);
        assert_eq!(entries.len(), HISTORY_MAX);
        assert_eq!(
            entries[0].command,
            format!("cmd {}", HISTORY_MAX + HISTORY_MAX / 5)
        );
    }

    #[test]
    fn only_web_links_are_opened() {
        assert!(openable_url("https://example.com/a?b=c#d"));
        assert!(openable_url("HTTP://example.com"));
        assert!(!openable_url("file:///etc/passwd"));
        assert!(!openable_url("javascript:alert(1)"));
        assert!(!openable_url("https://example.com/a b"));
        assert!(!openable_url("https://example.com/\n--flag"));
    }

    #[test]
    fn terminal_ids_are_plain() {
        assert!(valid_terminal_id("t-1a2b_3").is_ok());
        assert!(valid_terminal_id("").is_err());
        assert!(valid_terminal_id("../x").is_err());
        assert!(valid_terminal_id(&"a".repeat(65)).is_err());
    }
}

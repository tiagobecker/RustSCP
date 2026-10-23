//! Interactive shells for RustSCP's built-in terminal.
//!
//! Each terminal is a pseudo-terminal on an SSH connection of its own (as in PuTTY), so a
//! long command never competes with file transfers and keeps running while the user works
//! elsewhere in the app. The connection runs non-blocking on the async runtime: one task per
//! terminal waits for the socket, the user's input or a keepalive tick, and hands every
//! byte the shell prints to a [`TerminalSink`] as soon as it arrives.
//!
//! On bash, [`shell_bootstrap`] installs a prompt hook that reports each command line, its
//! exit status and the current folder as private OSC sequences, which
//! [`ShellEventParser`] picks out of the output stream.

use crate::sftp::SftpDriver;
use crate::shell::sh_quote;
use crate::types::{ConnectionConfig, CoreError, CoreResult};
use ssh2::{BlockDirections, Channel, ErrorCode, ExtendedData, Session};
use std::io::{self, ErrorKind, Read, Write};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::io::Interest;
use tokio::net::TcpStream;
use tokio::sync::mpsc;

/// Terminal type announced to the server (what xterm.js emulates).
pub const TERM_TYPE: &str = "xterm-256color";
const READ_CHUNK: usize = 32 * 1024;
/// Output read in one go before the user's input gets a turn.
const MAX_READ_BURST: usize = 512 * 1024;
/// Input is written in pieces, so a big paste does not hold the connection.
const WRITE_CHUNK: usize = 16 * 1024;
/// Reads in a row that return nothing (libssh2 handled a packet that was not terminal
/// data) before the task waits for the socket again.
const MAX_EMPTY_READS: usize = 64;
const KEEPALIVE_EVERY: Duration = Duration::from_secs(15);
/// libssh2 can hold decoded output after a write without the socket being readable; a
/// slow tick makes sure it is shown anyway.
const IDLE_POLL: Duration = Duration::from_millis(250);
/// Longest wait for the socket while a write or resize cannot go through yet.
const SOCKET_WAIT: Duration = Duration::from_millis(50);
/// Blocking-call limit while the connection and the shell are set up.
const SETUP_TIMEOUT_MS: u32 = 20_000;
/// Blocking-call limit for the goodbye messages when a terminal ends.
const CLOSE_TIMEOUT_MS: u32 = 2_000;
const LIBSSH2_ERROR_EAGAIN: i32 = -37;

/// Size of the terminal window in character cells.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalSize {
    pub cols: u16,
    pub rows: u16,
}

impl TerminalSize {
    fn clamped(self) -> (u32, u32) {
        (
            u32::from(self.cols.clamp(10, 1000)),
            u32::from(self.rows.clamp(2, 500)),
        )
    }
}

#[derive(Debug, Clone)]
pub struct TerminalOptions {
    pub size: TerminalSize,
    /// Command the server runs on the terminal instead of the login shell, normally
    /// [`shell_bootstrap`]; `None` starts the account's default shell.
    pub command: Option<String>,
}

/// Receives what the shell prints. Called from the terminal's own task, so it must not
/// block.
pub trait TerminalSink: Send + 'static {
    fn output(&mut self, data: &[u8]);
    /// Called once when the terminal ends: the shell's exit status, or why the
    /// connection was lost (`None`, `None` when it was closed with [`TerminalHandle::close`]).
    fn closed(&mut self, exit_status: Option<i32>, error: Option<String>);
}

enum Input {
    Data(Vec<u8>),
    Resize(TerminalSize),
    Close,
}

/// Controls a running terminal. Cloning it gives another handle to the same terminal.
#[derive(Debug, Clone)]
pub struct TerminalHandle {
    tx: mpsc::UnboundedSender<Input>,
}

impl TerminalHandle {
    /// Sends keystrokes or pasted text to the shell. `false` once the terminal has ended.
    pub fn write(&self, data: Vec<u8>) -> bool {
        self.tx.send(Input::Data(data)).is_ok()
    }

    pub fn resize(&self, size: TerminalSize) -> bool {
        self.tx.send(Input::Resize(size)).is_ok()
    }

    /// Hangs up: the server ends the shell and whatever runs in the foreground.
    pub fn close(&self) -> bool {
        self.tx.send(Input::Close).is_ok()
    }

    pub fn is_closed(&self) -> bool {
        self.tx.is_closed()
    }
}

/// Opens terminals on one server. It keeps the site and the host key accepted when the
/// file session logged in (not that session's connections), so a terminal can reconnect
/// after the file session is closed and never trusts a different host key.
#[derive(Clone)]
pub struct TerminalConnector {
    config: ConnectionConfig,
    host_key_pin: Arc<StdMutex<Option<Vec<u8>>>>,
}

impl std::fmt::Debug for TerminalConnector {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // ConnectionConfig's Debug redacts passwords and passphrases.
        f.debug_struct("TerminalConnector")
            .field("config", &self.config)
            .finish()
    }
}

impl TerminalConnector {
    pub(crate) fn new(config: ConnectionConfig, host_key: Option<Vec<u8>>) -> Self {
        Self {
            config,
            host_key_pin: Arc::new(StdMutex::new(host_key)),
        }
    }

    pub fn config(&self) -> &ConnectionConfig {
        &self.config
    }

    /// Logs in on a new SSH connection, starts the shell on a pseudo-terminal and returns
    /// once it runs. Output then flows to `sink` until the shell ends.
    pub async fn open<S: TerminalSink>(
        &self,
        options: TerminalOptions,
        sink: S,
    ) -> CoreResult<TerminalHandle> {
        let config = self.config.clone();
        let pin = self.host_key_pin.clone();
        let (session, channel, socket) =
            tokio::task::spawn_blocking(move || start_shell(&config, &pin, &options))
                .await
                .map_err(|e| CoreError::General(e.to_string()))??;
        let socket =
            TcpStream::from_std(socket).map_err(|e| CoreError::ConnectionFailed(e.to_string()))?;
        let (tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(run(session, channel, socket, rx, sink));
        Ok(TerminalHandle { tx })
    }
}

fn start_shell(
    config: &ConnectionConfig,
    pin: &StdMutex<Option<Vec<u8>>>,
    options: &TerminalOptions,
) -> CoreResult<(Session, Channel, std::net::TcpStream)> {
    let (sess, _, socket) = SftpDriver::connect_authenticated(config, pin)?;
    sess.set_timeout(SETUP_TIMEOUT_MS);
    let failed = |what: &str, e: ssh2::Error| CoreError::ConnectionFailed(format!("{what}: {e}"));

    let mut channel = sess
        .channel_session()
        .map_err(|e| failed("Could not open a terminal channel", e))?;
    // A pseudo-terminal already merges stderr into the output; make sure of it.
    let _ = channel.handle_extended_data(ExtendedData::Merge);
    let (cols, rows) = options.size.clamped();
    channel
        .request_pty(TERM_TYPE, None, Some((cols, rows, 0, 0)))
        .map_err(|e| failed("The server refused a terminal (PTY)", e))?;
    match &options.command {
        Some(command) => channel.exec(command),
        None => channel.shell(),
    }
    .map_err(|e| failed("The server refused to start a shell", e))?;

    sess.set_keepalive(true, KEEPALIVE_EVERY.as_secs() as u32);
    sess.set_blocking(false);
    socket
        .set_nonblocking(true)
        .map_err(|e| CoreError::ConnectionFailed(e.to_string()))?;
    Ok((sess, channel, socket))
}

enum Pumped {
    Idle,
    Busy,
    Closed,
}

fn is_eagain(e: &ssh2::Error) -> bool {
    matches!(e.code(), ErrorCode::Session(LIBSSH2_ERROR_EAGAIN))
}

fn connection_lost(e: impl std::fmt::Display) -> String {
    format!("Connection lost: {e}")
}

/// Hands the output libssh2 can decode right now to the sink. `Err(WouldBlock)` means the
/// socket has nothing more for now.
fn pump<S: TerminalSink>(
    channel: &mut Channel,
    buf: &mut [u8],
    sink: &mut S,
) -> io::Result<Pumped> {
    let mut total = 0;
    let mut empty = 0;
    loop {
        match channel.read(buf) {
            Ok(0) if channel.eof() => return Ok(Pumped::Closed),
            Ok(0) => {
                empty += 1;
                if empty >= MAX_EMPTY_READS {
                    return Ok(Pumped::Busy);
                }
            }
            Ok(n) => {
                sink.output(&buf[..n]);
                total += n;
                if total >= MAX_READ_BURST {
                    return Ok(Pumped::Busy);
                }
            }
            Err(e) => return Err(e),
        }
    }
}

/// [`pump`], also telling tokio when the socket is drained so it waits for new data.
fn drain<S: TerminalSink>(
    socket: &TcpStream,
    channel: &mut Channel,
    buf: &mut [u8],
    sink: &mut S,
) -> io::Result<Pumped> {
    match socket.try_io(Interest::READABLE, || pump(channel, buf, sink)) {
        // Either drained, or tokio did not consider the socket readable (the closure did
        // not run): output libssh2 already decoded is still shown.
        Err(e) if e.kind() == ErrorKind::WouldBlock => match pump(channel, buf, sink) {
            Err(e) if e.kind() == ErrorKind::WouldBlock => Ok(Pumped::Idle),
            other => other,
        },
        other => other,
    }
}

/// Waits (briefly) for the socket direction libssh2 is blocked on.
async fn wait_for_socket(sess: &Session, socket: &TcpStream) {
    let interest = match sess.block_directions() {
        BlockDirections::Outbound => {
            // libssh2 saw a full send buffer that tokio may still think writable.
            let _ = socket.try_io(Interest::WRITABLE, || {
                Err::<(), io::Error>(ErrorKind::WouldBlock.into())
            });
            Interest::WRITABLE
        }
        _ => Interest::READABLE,
    };
    let _ = tokio::time::timeout(SOCKET_WAIT, socket.ready(interest)).await;
}

async fn write_all<S: TerminalSink>(
    sess: &Session,
    channel: &mut Channel,
    socket: &TcpStream,
    mut data: &[u8],
    buf: &mut [u8],
    sink: &mut S,
) -> io::Result<()> {
    while !data.is_empty() {
        let n = data.len().min(WRITE_CHUNK);
        match channel.write(&data[..n]) {
            Ok(0) => wait_for_socket(sess, socket).await,
            Ok(written) => data = &data[written..],
            Err(e) if e.kind() == ErrorKind::WouldBlock => {
                // The server may take more input only once its output is read (when the
                // shell echoes a big paste, both windows fill up).
                if let Pumped::Closed = drain(socket, channel, buf, sink)? {
                    return Err(io::Error::new(ErrorKind::BrokenPipe, "the shell ended"));
                }
                wait_for_socket(sess, socket).await;
            }
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

async fn resize(
    sess: &Session,
    channel: &mut Channel,
    socket: &TcpStream,
    size: TerminalSize,
) -> Result<(), ssh2::Error> {
    let (cols, rows) = size.clamped();
    for _ in 0..40 {
        match channel.request_pty_size(cols, rows, None, None) {
            Err(e) if is_eagain(&e) => wait_for_socket(sess, socket).await,
            other => return other,
        }
    }
    Ok(()) // the server keeps the old size; the next resize tries again
}

async fn run<S: TerminalSink>(
    sess: Session,
    mut channel: Channel,
    socket: TcpStream,
    mut rx: mpsc::UnboundedReceiver<Input>,
    mut sink: S,
) {
    use tokio::time::MissedTickBehavior;

    let mut buf = vec![0u8; READ_CHUNK];
    let mut keepalive = tokio::time::interval(KEEPALIVE_EVERY);
    keepalive.set_missed_tick_behavior(MissedTickBehavior::Skip);
    keepalive.tick().await;
    let mut idle = tokio::time::interval(IDLE_POLL);
    idle.set_missed_tick_behavior(MissedTickBehavior::Skip);

    // Ok(true): the shell ended. Ok(false): closed from RustSCP.
    let outcome: Result<bool, String> = loop {
        tokio::select! {
            ready = socket.readable() => {
                if let Err(e) = ready {
                    break Err(connection_lost(e));
                }
                match drain(&socket, &mut channel, &mut buf, &mut sink) {
                    Ok(Pumped::Closed) => break Ok(true),
                    Ok(_) => {}
                    Err(e) => break Err(connection_lost(e)),
                }
            }
            input = rx.recv() => match input {
                Some(Input::Data(data)) => {
                    if let Err(e) = write_all(&sess, &mut channel, &socket, &data, &mut buf, &mut sink).await {
                        break if e.kind() == ErrorKind::BrokenPipe { Ok(true) } else { Err(connection_lost(e)) };
                    }
                }
                Some(Input::Resize(size)) => {
                    if let Err(e) = resize(&sess, &mut channel, &socket, size).await {
                        tracing::debug!("terminal resize failed: {}", e);
                    }
                }
                Some(Input::Close) | None => break Ok(false),
            },
            _ = idle.tick() => match drain(&socket, &mut channel, &mut buf, &mut sink) {
                Ok(Pumped::Closed) => break Ok(true),
                Ok(_) => {}
                Err(e) => break Err(connection_lost(e)),
            },
            _ = keepalive.tick() => {
                if let Err(e) = sess.keepalive_send() {
                    if !is_eagain(&e) {
                        break Err(connection_lost(e));
                    }
                }
            }
        }
    };

    let shell_ended = matches!(outcome, Ok(true));
    // Say goodbye properly when the connection still works (blocking, so off the runtime).
    // The server may send the exit status after the end of the output, before it closes
    // the channel: wait for the close before reading it.
    let status = tokio::task::spawn_blocking(move || {
        sess.set_blocking(true);
        sess.set_timeout(CLOSE_TIMEOUT_MS);
        let _ = channel.close();
        let status = if shell_ended {
            let _ = channel.wait_close();
            channel.exit_status().ok()
        } else {
            None
        };
        let _ = sess.disconnect(None, "terminal closed", None);
        status
    })
    .await
    .ok()
    .flatten();
    drop(socket);
    sink.closed(status, outcome.err());
}

// ---------------------------------------------------------------------------
// Shell integration
// ---------------------------------------------------------------------------

/// OSC number of RustSCP's private shell-integration sequences (`ESC ] 6973 ; … BEL`).
pub const SHELL_EVENT_OSC: &str = "6973";

/// Bash `PROMPT_COMMAND` run before every prompt. It reports the command line just added
/// to the shell's history (not the first prompt's, which is from an earlier login), the
/// current folder and the last exit status, then restores `$?` for the user's own prompt.
/// It stops being exported at the first prompt, so programs started later (another bash,
/// `sudo -s`...) do not run it. Terminals ignore OSC sequences they do not know.
const BASH_PROMPT_HOOK: &str = r#"__rustscp_st=$?
export -n PROMPT_COMMAND 2>/dev/null
__rustscp_h=$(HISTTIMEFORMAT= builtin history 1 2>/dev/null)
__rustscp_h=${__rustscp_h#"${__rustscp_h%%[![:space:]]*}"}
__rustscp_n=${__rustscp_h%%[!0-9]*}
if [ -n "${__rustscp_last+x}" ] && [ -n "$__rustscp_n" ] && [ "$__rustscp_n" != "$__rustscp_last" ]; then
__rustscp_c=${__rustscp_h#"$__rustscp_n"}
__rustscp_c=${__rustscp_c#\*}
__rustscp_c=${__rustscp_c#"${__rustscp_c%%[![:space:]]*}"}
__rustscp_c=${__rustscp_c//\\/\\\\}
__rustscp_c=${__rustscp_c//$'\n'/\\n}
__rustscp_c=${__rustscp_c//[$'\a\e']/}
builtin printf '\033]6973;cmd;%s\007' "$__rustscp_c"
fi
__rustscp_last=${__rustscp_n:-${__rustscp_last-}}
__rustscp_c=${PWD//[$'\a\e']/}
builtin printf '\033]6973;cwd;%s\007\033]6973;done;%s\007' "$__rustscp_c" "$__rustscp_st"
unset __rustscp_h __rustscp_n __rustscp_c
(exit "$__rustscp_st")"#;

/// POSIX `sh` command the server runs on a new terminal: go to `path` (the home folder
/// when it is missing), prefer a UTF-8 locale when the server would otherwise use plain
/// ASCII, install the prompt hook when the login shell is bash, and start the login
/// shell. Needs a POSIX login shell; other shells get a plain shell instead.
pub fn shell_bootstrap(path: &str) -> String {
    let p = path.trim();
    let cd = if p.is_empty() || p == "~" {
        "cd".to_string()
    } else if let Some(rest) = p.strip_prefix("~/") {
        format!("cd ~/{}", sh_quote(rest))
    } else if p.starts_with('-') {
        format!("cd {}", sh_quote(&format!("./{p}")))
    } else {
        format!("cd {}", sh_quote(p))
    };
    format!(
        "{cd} 2>/dev/null || cd\n\
         case \"${{LC_ALL:-${{LC_CTYPE:-${{LANG:-}}}}}}\" in\n\
         *[Uu][Tt][Ff]-8*|*[Uu][Tt][Ff]8*) ;;\n\
         *) __rustscp_l=$(locale -a 2>/dev/null | grep -i -m 1 -E '^(c|en_us)[.]utf-?8$')\n\
         if [ -n \"$__rustscp_l\" ]; then LANG=$__rustscp_l; export LANG; fi\n\
         unset __rustscp_l ;;\n\
         esac\n\
         case \"${{SHELL##*/}}\" in\n\
         bash) PROMPT_COMMAND={hook}; export PROMPT_COMMAND ;;\n\
         esac\n\
         exec \"${{SHELL:-/bin/sh}}\" -l\n",
        hook = sh_quote(BASH_PROMPT_HOOK),
    )
}

/// What the prompt hook reports (see [`shell_bootstrap`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShellEvent {
    /// The command line just run, as recorded in the shell's history.
    Command(String),
    /// The shell's current folder.
    Cwd(String),
    /// A new prompt is shown; the previous command ended with this status.
    Prompt(i32),
}

/// Longest OSC payload kept; longer ones (a huge command line) are skipped.
const MAX_OSC_PAYLOAD: usize = 64 * 1024;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum ParseState {
    #[default]
    Text,
    Escape,
    Osc,
    OscEscape,
}

/// Finds the prompt hook's sequences in terminal output, across chunk boundaries.
#[derive(Debug, Default)]
pub struct ShellEventParser {
    state: ParseState,
    payload: Vec<u8>,
    overflow: bool,
}

impl ShellEventParser {
    pub fn feed(&mut self, data: &[u8], events: &mut Vec<ShellEvent>) {
        let mut i = 0;
        while i < data.len() {
            let b = data[i];
            i += 1;
            match self.state {
                ParseState::Text => {
                    if b == 0x1b {
                        self.state = ParseState::Escape;
                    } else if let Some(pos) = data[i..].iter().position(|&c| c == 0x1b) {
                        i += pos;
                    } else {
                        i = data.len();
                    }
                }
                ParseState::Escape => self.state = self.after_escape(b),
                ParseState::Osc => match b {
                    0x07 => {
                        self.finish(events);
                        self.state = ParseState::Text;
                    }
                    0x1b => self.state = ParseState::OscEscape,
                    _ if self.payload.len() < MAX_OSC_PAYLOAD => self.payload.push(b),
                    _ => self.overflow = true,
                },
                ParseState::OscEscape => {
                    if b == b'\\' {
                        self.finish(events);
                        self.state = ParseState::Text;
                    } else {
                        // An ESC that is not a string terminator ends the OSC without
                        // result and starts a new sequence.
                        self.state = self.after_escape(b);
                    }
                }
            }
        }
    }

    fn after_escape(&mut self, b: u8) -> ParseState {
        match b {
            b']' => {
                self.payload.clear();
                self.overflow = false;
                ParseState::Osc
            }
            0x1b => ParseState::Escape,
            _ => ParseState::Text,
        }
    }

    fn finish(&mut self, events: &mut Vec<ShellEvent>) {
        if self.overflow {
            return;
        }
        let Some(rest) = self
            .payload
            .strip_prefix(SHELL_EVENT_OSC.as_bytes())
            .and_then(|r| r.strip_prefix(b";"))
        else {
            return;
        };
        let text = String::from_utf8_lossy(rest);
        let (kind, value) = text.split_once(';').unwrap_or((&text, ""));
        match kind {
            "cmd" => events.push(ShellEvent::Command(unescape_command(value))),
            "cwd" => events.push(ShellEvent::Cwd(value.to_string())),
            "done" => events.push(ShellEvent::Prompt(value.trim().parse().unwrap_or(-1))),
            _ => {}
        }
    }
}

/// Undoes the hook's escaping of a command line (`\\` and `\n`).
fn unescape_command(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    out
}

/// Terminal output as plain text: escape sequences and control characters other than
/// newlines and tabs removed, carriage returns treated as line breaks.
pub fn strip_ansi(data: &[u8]) -> String {
    let text = String::from_utf8_lossy(data);
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\u{1b}' => match chars.next() {
                // CSI: parameters up to a final byte in @..~
                Some('[') => {
                    for n in chars.by_ref() {
                        if ('@'..='~').contains(&n) {
                            break;
                        }
                    }
                }
                // OSC / DCS / APC / PM: up to BEL or ESC \
                Some(']' | 'P' | '_' | '^') => {
                    while let Some(n) = chars.next() {
                        if n == '\u{7}' {
                            break;
                        }
                        if n == '\u{1b}' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                // Two-byte sequences (ESC 7, ESC =, ESC ( B...)
                Some('(' | ')' | '*' | '+') => {
                    chars.next();
                }
                _ => {}
            },
            '\r' => {
                if chars.peek() != Some(&'\n') {
                    out.push('\n');
                }
            }
            '\n' | '\t' => out.push(c),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_all(chunks: &[&[u8]]) -> Vec<ShellEvent> {
        let mut parser = ShellEventParser::default();
        let mut events = Vec::new();
        for chunk in chunks {
            parser.feed(chunk, &mut events);
        }
        events
    }

    #[test]
    fn parses_hook_sequences_across_chunks() {
        let data = b"ls\r\nfile\r\n\x1b]6973;cmd;ls -la \\\\ x\\nnext\x07\x1b]6973;cwd;/srv/a;b\x07\x1b]6973;done;127\x1b\\$ ";
        let expected = vec![
            ShellEvent::Command("ls -la \\ x\nnext".to_string()),
            ShellEvent::Cwd("/srv/a;b".to_string()),
            ShellEvent::Prompt(127),
        ];
        assert_eq!(parse_all(&[data]), expected);
        for split in 1..data.len() {
            let (a, b) = data.split_at(split);
            assert_eq!(parse_all(&[a, b]), expected, "split at {split}");
        }
    }

    #[test]
    fn ignores_other_sequences() {
        let events = parse_all(&[
            b"\x1b]0;title\x07\x1b[31mred\x1b[0m\x1b]697;x\x07\x1b]6973;bogus;1\x07\x1b]6973;done;x\x07",
        ]);
        assert_eq!(events, vec![ShellEvent::Prompt(-1)]);
        // An OSC cut short by another escape sequence yields nothing.
        assert_eq!(parse_all(&[b"\x1b]6973;done;0\x1b[0m"]), vec![]);
    }

    #[test]
    fn skips_oversized_payloads() {
        let mut big = b"\x1b]6973;cmd;".to_vec();
        big.extend(std::iter::repeat_n(b'a', MAX_OSC_PAYLOAD + 10));
        big.extend(b"\x07\x1b]6973;done;0\x07");
        assert_eq!(parse_all(&[&big]), vec![ShellEvent::Prompt(0)]);
    }

    #[test]
    fn strips_escape_sequences() {
        assert_eq!(
            strip_ansi(b"\x1b[1;31merror:\x1b[0m bad\r\nline\rover\x1b]0;t\x07\x07 end"),
            "error: bad\nline\nover end"
        );
    }

    #[test]
    fn bootstrap_quotes_the_folder() {
        let script = shell_bootstrap("/srv/it's here");
        assert!(script.starts_with("cd '/srv/it'\\''s here' 2>/dev/null || cd\n"));
        assert!(shell_bootstrap("").starts_with("cd 2>/dev/null"));
        assert!(shell_bootstrap("~/a b").starts_with("cd ~/'a b' "));
        assert!(shell_bootstrap("-x").starts_with("cd './-x' "));
        assert!(script.ends_with("exec \"${SHELL:-/bin/sh}\" -l\n"));
    }

    /// Runs the whole bootstrap in `sh` with a stand-in login shell named `bash`.
    #[cfg(unix)]
    #[test]
    fn bootstrap_starts_the_login_shell_in_the_folder() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("my folder");
        std::fs::create_dir(&target).unwrap();
        let fake_bash = dir.path().join("bash");
        std::fs::write(
            &fake_bash,
            "#!/bin/sh\necho \"args=$* pwd=$(pwd -P) hook=${PROMPT_COMMAND:+set}\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&fake_bash, std::fs::Permissions::from_mode(0o755)).unwrap();

        let run = |path: &str, shell: &std::path::Path| {
            let out = std::process::Command::new("/bin/sh")
                .arg("-c")
                .arg(shell_bootstrap(path))
                .env("SHELL", shell)
                .env("HOME", dir.path())
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        let real = std::fs::canonicalize(&target).unwrap();
        assert_eq!(
            run(&target.to_string_lossy(), &fake_bash),
            format!("args=-l pwd={} hook=set", real.display())
        );
        // A missing folder falls back to the home folder.
        let home = std::fs::canonicalize(dir.path()).unwrap();
        assert_eq!(
            run("/no/such/folder", &fake_bash),
            format!("args=-l pwd={} hook=set", home.display())
        );
        // Other login shells get no bash hook.
        let fake_zsh = dir.path().join("zsh");
        std::fs::copy(&fake_bash, &fake_zsh).unwrap();
        assert_eq!(
            run("~", &fake_zsh),
            format!("args=-l pwd={} hook=", home.display())
        );
    }

    /// Runs the prompt hook in a real bash the way an interactive shell would.
    #[cfg(unix)]
    #[test]
    fn prompt_hook_reports_commands_in_bash() {
        let Some(bash) = ["/bin/bash", "/usr/bin/bash"]
            .into_iter()
            .find(|p| std::path::Path::new(p).exists())
        else {
            return;
        };
        let script = format!(
            "PROMPT_COMMAND={hook}\nexport PROMPT_COMMAND\n{body}",
            hook = sh_quote(BASH_PROMPT_HOOK),
            // History stays off, so only `history -s` adds entries (as typed lines do in
            // an interactive shell, where the hook itself is never recorded).
            body = r#"HISTFILE=/dev/null
cd /
history -s 'old command'
eval "$PROMPT_COMMAND"
cd /tmp
c=$(printf 'echo a\\b\nsecond line')
history -s "$c"
(exit 3)
eval "$PROMPT_COMMAND"
echo "status=$?"
(exit 0)
eval "$PROMPT_COMMAND"
bash -c 'echo "child=${PROMPT_COMMAND:-none}"'
"#
        );
        let out = std::process::Command::new(bash)
            .args(["--norc", "--noprofile", "-c", &script])
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let cwd = |p: &str| ShellEvent::Cwd(p.to_string());
        assert_eq!(
            parse_all(&[&out.stdout]),
            vec![
                // First prompt: the command in the history is from an earlier session.
                cwd("/"),
                ShellEvent::Prompt(0),
                ShellEvent::Command("echo a\\b\nsecond line".to_string()),
                cwd("/tmp"),
                ShellEvent::Prompt(3),
                // Same history entry as before: no new command.
                cwd("/tmp"),
                ShellEvent::Prompt(0),
            ]
        );
        let text = strip_ansi(&out.stdout);
        assert!(text.contains("status=3"), "{text}");
        assert!(text.contains("child=none"), "{text}");
    }
}

//! Minimal FTP client (RFC 959 with the RFC 2428 EPSV and RFC 3659
//! MLSD/MLST/SIZE/MDTM/REST extensions) on `std::net::TcpStream`, run on the
//! blocking thread pool, with optional explicit FTPS (RFC 4217).
//!
//! Plain FTP sends credentials and data unencrypted. With [`FtpConfig::tls`]
//! the control connection is upgraded with `AUTH TLS` before the user name
//! is sent, `PBSZ 0` + `PROT P` put every data connection under TLS too, and
//! nothing falls back to clear text. The server certificate is checked by the
//! operating system's verifier; a self-signed server is accepted only when
//! the user pinned its SHA-256 fingerprint.
//!
//! Every operation either really happens on the server or returns an error;
//! nothing reports success without doing the work.

use crate::types::{
    CoreError, CoreResult, FileEntry, FileSystemInfo, FileType, FindFileMatch, FindFileQuery,
    Permissions, Protocol,
};
use crate::vfs::VirtualFileSystem;
use async_trait::async_trait;
use bytes::Bytes;
use chrono::{DateTime, Datelike, NaiveDate, NaiveDateTime, TimeZone, Utc};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{
    CertificateError, ClientConfig, ClientConnection, DigitallySignedStruct, OtherError,
    SignatureScheme, StreamOwned,
};
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::fmt;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{IpAddr, Shutdown, SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tokio::sync::Semaphore;
use tokio::task;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const CONTROL_TIMEOUT: Duration = Duration::from_secs(30);
const DATA_TIMEOUT: Duration = Duration::from_secs(60);
/// Wait for the final reply after a transfer (servers may flush large uploads).
const TRANSFER_END_TIMEOUT: Duration = Duration::from_secs(120);
/// After a TLS upload, how long to wait for the server to close the data
/// connection (its close_notify and session tickets arrive meanwhile).
const TLS_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);
/// How long to wait for the server's explanation of a failed data handshake.
const TLS_FAILURE_REPLY_TIMEOUT: Duration = Duration::from_secs(3);
/// Idle pooled connections are checked with NOOP after this long.
const LIVENESS_CHECK_AFTER: Duration = Duration::from_secs(10);
/// An open sequential download is abandoned after this much idle time.
const RETR_REUSE_WINDOW: Duration = Duration::from_secs(20);
/// Parallel control connections per session.
const MAX_CONNECTIONS: usize = 4;
const MAX_LINE_BYTES: u64 = 64 * 1024;
const MAX_REPLY_LINES: usize = 10_000;
const MAX_LISTING_BYTES: u64 = 64 * 1024 * 1024;
const MAX_WALK_DEPTH: usize = 64;
const MAX_WALK_ENTRIES: usize = 200_000;

#[derive(Clone)]
pub struct FtpConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    /// Explicit FTPS: `AUTH TLS` on the control connection before the user
    /// name is sent, then `PROT P` so data connections are TLS as well.
    pub tls: bool,
    /// SHA-256 fingerprint of a server certificate to accept although the
    /// system does not trust it (a self-signed server). Certificates the
    /// system trusts are accepted either way. Only used with `tls`.
    pub tls_fingerprint: Option<String>,
}

impl fmt::Debug for FtpConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FtpConfig")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .field("password", &self.password.as_ref().map(|_| "<redacted>"))
            .field("tls", &self.tls)
            .field("tls_fingerprint", &self.tls_fingerprint)
            .finish()
    }
}

#[derive(Clone)]
pub struct FtpDriver {
    config: FtpConfig,
    /// Idle, logged-in control connections.
    pool: Arc<Mutex<Vec<Conn>>>,
    /// Bounds the number of simultaneous control connections.
    limiter: Arc<Semaphore>,
    /// Working directory right after login (PWD).
    home: Arc<Mutex<Option<String>>>,
}

impl fmt::Debug for FtpDriver {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FtpDriver")
            .field("config", &self.config)
            .finish()
    }
}

// ---------------------------------------------------------------------------
// Replies and errors
// ---------------------------------------------------------------------------

/// A complete (possibly multi-line) FTP reply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Reply {
    pub(crate) code: u16,
    pub(crate) lines: Vec<String>,
}

impl Reply {
    fn is_ok(&self) -> bool {
        self.code / 100 == 2
    }

    /// Reply text without the numeric code prefixes.
    fn message(&self) -> String {
        let code = self.code.to_string();
        self.lines
            .iter()
            .map(|line| {
                let rest = line.strip_prefix(code.as_str()).unwrap_or(line);
                rest.strip_prefix(['-', ' ']).unwrap_or(rest).trim()
            })
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    }
}

#[derive(Debug)]
enum FtpError {
    /// The server answered with an unexpected reply.
    Reply {
        context: String,
        reply: Reply,
    },
    Core(CoreError),
}

impl From<CoreError> for FtpError {
    fn from(e: CoreError) -> Self {
        FtpError::Core(e)
    }
}

impl From<FtpError> for CoreError {
    fn from(e: FtpError) -> Self {
        match e {
            FtpError::Core(c) => c,
            FtpError::Reply { context, reply } => reply_to_core(&context, &reply),
        }
    }
}

fn reply_error(context: String, reply: Reply) -> FtpError {
    FtpError::Reply { context, reply }
}

fn reply_code(e: &FtpError) -> Option<u16> {
    match e {
        FtpError::Reply { reply, .. } => Some(reply.code),
        FtpError::Core(_) => None,
    }
}

/// Maps an FTP error reply to a CoreError that keeps the server's text.
fn reply_to_core(context: &str, reply: &Reply) -> CoreError {
    let message = reply.message();
    let detail = format!("FTP {context}: {} {message}", reply.code);
    let lower = message.to_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| lower.contains(w));
    match reply.code {
        530 | 532 => CoreError::AuthFailed(detail),
        421 => CoreError::ConnectionFailed(detail),
        450 | 550 | 553 => {
            if has(&[
                "permission",
                "denied",
                "not allowed",
                "access is",
                "access to",
            ]) {
                CoreError::PermissionDenied(detail)
            } else if has(&[
                "no such",
                "not found",
                "not exist",
                "doesn't exist",
                "cannot find",
                "can't find",
            ]) {
                CoreError::NotFound(detail)
            } else {
                CoreError::Protocol(detail)
            }
        }
        _ => CoreError::Protocol(detail),
    }
}

fn io_error(context: &str, e: io::Error) -> CoreError {
    match e.kind() {
        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut => {
            CoreError::Timeout(format!("FTP {context}: timed out ({e})"))
        }
        kind => CoreError::Io(io::Error::new(kind, format!("FTP {context}: {e}"))),
    }
}

fn describe(verb: &str, arg: Option<&str>) -> String {
    match arg {
        Some(a) => format!("{verb} {a}"),
        None => verb.to_string(),
    }
}

/// One reply line without its line terminator.
fn read_line<R: BufRead>(r: &mut R) -> io::Result<String> {
    let mut buf = Vec::new();
    let n = r
        .by_ref()
        .take(MAX_LINE_BYTES)
        .read_until(b'\n', &mut buf)?;
    if n == 0 {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "server closed the control connection",
        ));
    }
    if buf.last() != Some(&b'\n') {
        if n as u64 >= MAX_LINE_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "reply line too long",
            ));
        }
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "server closed the control connection in the middle of a reply",
        ));
    }
    while matches!(buf.last(), Some(b'\n' | b'\r')) {
        buf.pop();
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn parse_reply_code(line: &str) -> Option<u16> {
    let b = line.as_bytes();
    if b.len() < 3 || !b[..3].iter().all(u8::is_ascii_digit) {
        return None;
    }
    match b.get(3) {
        None | Some(b' ') | Some(b'-') => line[..3].parse().ok(),
        _ => None,
    }
}

/// Reads one complete reply ("123 text" or "123-..." up to "123 text").
pub(crate) fn read_ftp_reply<R: BufRead>(r: &mut R) -> io::Result<Reply> {
    let first = read_line(r)?;
    let code = parse_reply_code(&first).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "malformed reply {:?}",
                first.chars().take(80).collect::<String>()
            ),
        )
    })?;
    let multiline = first.as_bytes().get(3) == Some(&b'-');
    let mut lines = vec![first];
    if multiline {
        let code_str = code.to_string();
        loop {
            let line = read_line(r)?;
            let done =
                line.starts_with(&code_str) && matches!(line.as_bytes().get(3), None | Some(b' '));
            lines.push(line);
            if done {
                break;
            }
            if lines.len() > MAX_REPLY_LINES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "reply has too many lines",
                ));
            }
        }
    }
    Ok(Reply { code, lines })
}

/// Rejects arguments that would let a value inject further commands.
fn check_arg(arg: &str) -> Result<(), FtpError> {
    if arg.contains(['\r', '\n', '\0']) {
        Err(FtpError::Core(CoreError::InvalidPath(
            "FTP command argument contains CR, LF or NUL characters".into(),
        )))
    } else {
        Ok(())
    }
}

/// Port from `229 Entering Extended Passive Mode (|||6446|)`.
pub(crate) fn parse_epsv_port(msg: &str) -> Option<u16> {
    let start = msg.find('(')?;
    let inner = &msg[start + 1..];
    let inner = &inner[..inner.find(')')?];
    let delim = inner.chars().next()?;
    let parts: Vec<&str> = inner.split(delim).collect();
    if parts.len() != 5 {
        return None;
    }
    parts[3].trim().parse().ok().filter(|p| *p != 0)
}

/// Address and port from `227 Entering Passive Mode (h1,h2,h3,h4,p1,p2)`.
pub(crate) fn parse_pasv(msg: &str) -> Option<([u8; 4], u16)> {
    let bytes = msg.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if !bytes[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let start = i;
        while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b',') {
            i += 1;
        }
        let nums: Vec<&str> = msg[start..i].split(',').collect();
        if nums.len() == 6 {
            if let Ok(v) = nums
                .iter()
                .map(|n| n.parse::<u8>())
                .collect::<Result<Vec<u8>, _>>()
            {
                let port = u16::from(v[4]) * 256 + u16::from(v[5]);
                if port != 0 {
                    return Some(([v[0], v[1], v[2], v[3]], port));
                }
            }
        }
    }
    None
}

/// Directory from `257 "/home/user" is the current directory` ("" escapes ").
pub(crate) fn parse_pwd(msg: &str) -> Option<String> {
    let start = msg.find('"')?;
    let mut out = String::new();
    let mut chars = msg[start + 1..].chars().peekable();
    while let Some(c) = chars.next() {
        if c == '"' {
            if chars.peek() == Some(&'"') {
                out.push('"');
                chars.next();
            } else {
                return Some(out);
            }
        } else {
            out.push(c);
        }
    }
    None
}

/// `YYYYMMDDHHMMSS[.sss]` (UTC), as used by MDTM and MLSD `modify`.
pub(crate) fn parse_ftp_time(s: &str) -> Option<DateTime<Utc>> {
    let digits = s.trim().get(..14)?;
    if !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let naive = NaiveDateTime::parse_from_str(digits, "%Y%m%d%H%M%S").ok()?;
    Some(Utc.from_utc_datetime(&naive))
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/// Absolute path without a trailing slash ("/" for the root).
///
/// Whitespace is kept: FTP names may start or end with spaces, and trimming
/// would address a different file (e.g. `DELE notes` for `notes `). Typed
/// paths are trimmed by the UI, not here.
fn normalize_path(path: &str) -> String {
    let mut p = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    while p.len() > 1 && p.ends_with('/') {
        p.pop();
    }
    p
}

fn join_path(dir: &str, name: &str) -> String {
    if dir.is_empty() || dir == "/" {
        format!("/{name}")
    } else if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

fn parent_of(path: &str) -> String {
    let p = path.trim_end_matches('/');
    match p.rfind('/') {
        Some(0) | None => "/".to_string(),
        Some(i) => p[..i].to_string(),
    }
}

fn basename(path: &str) -> String {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_string()
}

fn dir_entry(name: &str, path: &str) -> FileEntry {
    FileEntry {
        name: name.to_string(),
        path: path.to_string(),
        file_type: FileType::Directory,
        size: 0,
        modified_at: None,
        created_at: None,
        permissions: Permissions {
            mode: 0o755,
            ..Permissions::default()
        },
        is_hidden: name.starts_with('.'),
    }
}

// ---------------------------------------------------------------------------
// Listing parsers
// ---------------------------------------------------------------------------

/// Parses MLSD output (one `facts name` entry per line).
pub(crate) fn parse_mlsd_listing(text: &str, dir: &str) -> Vec<FileEntry> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim_end_matches('\r');
            if line.trim().is_empty() {
                return None;
            }
            let (facts, name) = split_mlsx_line(line)?;
            let (display, path) = if name.starts_with('/') {
                (basename(name), name.to_string())
            } else {
                (name.to_string(), join_path(dir, name))
            };
            entry_from_facts(&facts, &display, &path)
        })
        .collect()
}

/// Splits `type=file;size=1; name` into lower-cased facts and the name.
fn split_mlsx_line(line: &str) -> Option<(Vec<(String, String)>, &str)> {
    let (facts_str, name) = line.split_once(' ')?;
    let facts = facts_str
        .split(';')
        .filter(|f| !f.is_empty())
        .filter_map(|f| {
            f.split_once('=')
                .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.to_string()))
        })
        .collect();
    Some((facts, name))
}

fn entry_from_facts(facts: &[(String, String)], name: &str, path: &str) -> Option<FileEntry> {
    if name.is_empty() || name == "." || name == ".." {
        return None;
    }
    let get = |key: &str| {
        facts
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    };
    let kind = get("type").unwrap_or("file").to_ascii_lowercase();
    let file_type = match kind.as_str() {
        "file" => FileType::File,
        "dir" => FileType::Directory,
        "cdir" | "pdir" => return None,
        k if k.starts_with("os.unix=") && k.contains("link") => FileType::Symlink,
        _ => FileType::Other,
    };
    let size = get("size")
        .or_else(|| get("sizd"))
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(0);
    let default_mode = if file_type == FileType::Directory {
        0o755
    } else {
        0o644
    };
    let mode = get("unix.mode")
        .and_then(|m| u32::from_str_radix(m.trim(), 8).ok())
        .map(|m| m & 0o7777)
        .unwrap_or(default_mode);
    let readonly = match (file_type, get("perm")) {
        (FileType::File, Some(p)) => !p.to_ascii_lowercase().contains(['w', 'a']),
        _ => false,
    };
    Some(FileEntry {
        name: name.to_string(),
        path: path.to_string(),
        file_type,
        size,
        modified_at: get("modify").and_then(parse_ftp_time),
        created_at: get("create").and_then(parse_ftp_time),
        permissions: Permissions {
            mode,
            readonly,
            owner: get("unix.ownername")
                .or_else(|| get("unix.owner"))
                .or_else(|| get("unix.uid"))
                .map(str::to_string),
            group: get("unix.groupname")
                .or_else(|| get("unix.group"))
                .or_else(|| get("unix.gid"))
                .map(str::to_string),
        },
        is_hidden: name.starts_with('.'),
    })
}

/// One parsed LIST line.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ListItem {
    pub(crate) name: String,
    pub(crate) file_type: FileType,
    pub(crate) size: u64,
    pub(crate) modified: Option<DateTime<Utc>>,
    pub(crate) mode: Option<u32>,
    pub(crate) owner: Option<String>,
    pub(crate) group: Option<String>,
    pub(crate) link_target: Option<String>,
}

impl ListItem {
    fn into_entry(self, dir: &str) -> FileEntry {
        let path = join_path(dir, &self.name);
        let default_mode = if self.file_type == FileType::Directory {
            0o755
        } else {
            0o644
        };
        FileEntry {
            is_hidden: self.name.starts_with('.'),
            path,
            file_type: self.file_type,
            size: self.size,
            modified_at: self.modified,
            created_at: None,
            permissions: Permissions {
                mode: self.mode.unwrap_or(default_mode),
                readonly: self.mode.is_some_and(|m| m & 0o200 == 0),
                owner: self.owner,
                group: self.group,
            },
            name: self.name,
        }
    }
}

/// Parses LIST output in Unix `ls -l` or Windows/IIS DOS format.
pub(crate) fn parse_list_listing(text: &str, dir: &str, now: DateTime<Utc>) -> Vec<FileEntry> {
    let mut out = Vec::new();
    for raw in text.lines() {
        let line = raw.trim_end_matches('\r');
        if line.trim().is_empty() || line.to_ascii_lowercase().starts_with("total ") {
            continue;
        }
        match parse_unix_list_line(line, now).or_else(|| parse_dos_list_line(line)) {
            Some(item) if !item.name.is_empty() && item.name != "." && item.name != ".." => {
                out.push(item.into_entry(dir))
            }
            Some(_) => {}
            None => tracing::debug!("FTP: could not parse LIST line {line:?}"),
        }
    }
    out
}

/// Byte ranges of whitespace-separated tokens.
fn tokens(line: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut start = None;
    for (i, c) in line.char_indices() {
        if c.is_whitespace() {
            if let Some(s) = start.take() {
                out.push((s, i));
            }
        } else if start.is_none() {
            start = Some(i);
        }
    }
    if let Some(s) = start {
        out.push((s, line.len()));
    }
    out
}

fn month_number(s: &str) -> Option<u32> {
    const MONTHS: [&str; 12] = [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ];
    if s.len() != 3 {
        return None;
    }
    let lower = s.to_ascii_lowercase();
    MONTHS
        .iter()
        .position(|m| *m == lower)
        .map(|i| i as u32 + 1)
}

fn parse_hhmm(s: &str) -> Option<(u32, u32)> {
    let (h, m) = s.split_once(':')?;
    let h: u32 = h.parse().ok()?;
    let m: u32 = m.parse().ok()?;
    (h < 24 && m < 60).then_some((h, m))
}

/// `rwxr-xr-x` (with s/S/t/T) to an octal mode.
fn parse_mode_string(s: &str) -> u32 {
    let c: Vec<char> = s.chars().collect();
    if c.len() < 9 {
        return 0;
    }
    let mut mode = 0;
    let rw = [
        (0, 0o400),
        (1, 0o200),
        (3, 0o040),
        (4, 0o020),
        (6, 0o004),
        (7, 0o002),
    ];
    for (i, bit) in rw {
        if c[i] == 'r' || c[i] == 'w' {
            mode |= bit;
        }
    }
    let exec = [
        (2, 0o100, 0o4000, 's'),
        (5, 0o010, 0o2000, 's'),
        (8, 0o001, 0o1000, 't'),
    ];
    for (i, x, special, lower) in exec {
        match c[i] {
            'x' => mode |= x,
            ch if ch == lower => mode |= x | special,
            ch if ch == lower.to_ascii_uppercase() => mode |= special,
            _ => {}
        }
    }
    mode
}

/// `drwxr-xr-x 2 user group 4096 Jan  1 12:00 name` and variants (no group
/// column, a year instead of the time, ISO `2024-01-02 03:04` dates).
pub(crate) fn parse_unix_list_line(line: &str, now: DateTime<Utc>) -> Option<ListItem> {
    let toks = tokens(line);
    if toks.len() < 6 {
        return None;
    }
    let tok = |i: usize| &line[toks[i].0..toks[i].1];
    let perms = tok(0);
    let kind = perms.chars().next()?;
    if perms.len() < 10 || !"-dlbcpsD".contains(kind) {
        return None;
    }
    let file_type = match kind {
        'd' => FileType::Directory,
        'l' => FileType::Symlink,
        '-' => FileType::File,
        _ => FileType::Other,
    };
    let mode = parse_mode_string(perms.get(1..10)?);

    for m in 2..toks.len() {
        let Ok(size) = tok(m - 1).parse::<u64>() else {
            continue;
        };
        let (modified, date_end) = if let Some(month) = month_number(tok(m)) {
            if m + 3 >= toks.len() {
                continue;
            }
            let Some(day) = tok(m + 1)
                .parse::<u32>()
                .ok()
                .filter(|d| (1..=31).contains(d))
            else {
                continue;
            };
            let t = tok(m + 2);
            let modified = if let Some((h, mi)) = parse_hhmm(t) {
                // No year: the date lies within the last six months.
                let at = |year: i32| Utc.with_ymd_and_hms(year, month, day, h, mi, 0).single();
                match at(now.year()) {
                    Some(d) if d > now + chrono::Duration::days(2) => at(now.year() - 1),
                    other => other,
                }
            } else if t.len() == 4 && t.bytes().all(|b| b.is_ascii_digit()) {
                let year: i32 = t.parse().ok()?;
                Utc.with_ymd_and_hms(year, month, day, 0, 0, 0).single()
            } else {
                continue;
            };
            (modified, m + 2)
        } else if m + 2 < toks.len() {
            let Ok(date) = NaiveDate::parse_from_str(tok(m), "%Y-%m-%d") else {
                continue;
            };
            let Some((h, mi)) = parse_hhmm(tok(m + 1)) else {
                continue;
            };
            (
                date.and_hms_opt(h, mi, 0)
                    .map(|d| Utc.from_utc_datetime(&d)),
                m + 1,
            )
        } else {
            continue;
        };

        let rest = &line[toks[date_end].1..];
        let rest = rest.strip_prefix(' ').unwrap_or(rest);
        if rest.trim().is_empty() {
            continue;
        }
        let (name, link_target) = if file_type == FileType::Symlink {
            match rest.split_once(" -> ") {
                Some((n, t)) => (n.to_string(), Some(t.to_string())),
                None => (rest.to_string(), None),
            }
        } else {
            (rest.to_string(), None)
        };
        let size_idx = m - 1;
        return Some(ListItem {
            name,
            file_type,
            size: if file_type == FileType::Directory {
                0
            } else {
                size
            },
            modified,
            mode: Some(mode),
            owner: (size_idx >= 3).then(|| tok(2).to_string()),
            group: (size_idx >= 4).then(|| tok(3).to_string()),
            link_target,
        });
    }
    None
}

/// `01-02-24  03:04PM  <DIR>  name` / `01-02-24  03:04PM  1,234 name` (IIS).
pub(crate) fn parse_dos_list_line(line: &str) -> Option<ListItem> {
    let toks = tokens(line);
    if toks.len() < 4 {
        return None;
    }
    let tok = |i: usize| &line[toks[i].0..toks[i].1];
    let date_parts: Vec<&str> = tok(0).split(['-', '/']).collect();
    if date_parts.len() != 3 {
        return None;
    }
    let month: u32 = date_parts[0].parse().ok()?;
    let day: u32 = date_parts[1].parse().ok()?;
    let mut year: i32 = date_parts[2].parse().ok()?;
    if date_parts[2].len() == 2 {
        year += if year < 70 { 2000 } else { 1900 };
    }

    let time_tok = tok(1).to_ascii_uppercase();
    let (time_str, mut kind_idx, mut meridiem) = if let Some(t) = time_tok.strip_suffix("AM") {
        (t.to_string(), 2, Some(false))
    } else if let Some(t) = time_tok.strip_suffix("PM") {
        (t.to_string(), 2, Some(true))
    } else {
        (time_tok.clone(), 2, None)
    };
    if meridiem.is_none() {
        match tok(2).to_ascii_uppercase().as_str() {
            "AM" => {
                meridiem = Some(false);
                kind_idx = 3;
            }
            "PM" => {
                meridiem = Some(true);
                kind_idx = 3;
            }
            _ => {}
        }
    }
    let (mut hour, minute) = parse_hhmm(&time_str)?;
    match meridiem {
        Some(true) if hour < 12 => hour += 12,
        Some(false) if hour == 12 => hour = 0,
        _ => {}
    }
    if kind_idx + 1 >= toks.len() {
        return None;
    }
    let kind = tok(kind_idx);
    let (file_type, size) = if kind.eq_ignore_ascii_case("<DIR>") {
        (FileType::Directory, 0)
    } else {
        (FileType::File, kind.replace(',', "").parse::<u64>().ok()?)
    };
    let name = line[toks[kind_idx + 1].0..].trim_end().to_string();
    Some(ListItem {
        name,
        file_type,
        size,
        modified: Utc
            .with_ymd_and_hms(year, month, day, hour, minute, 0)
            .single(),
        mode: None,
        owner: None,
        group: None,
        link_target: None,
    })
}

// ---------------------------------------------------------------------------
// TLS (explicit FTPS, RFC 4217)
// ---------------------------------------------------------------------------

/// `AB:CD:…` (upper-case hex pairs): the SHA-256 fingerprint of a DER
/// certificate, as `openssl x509 -noout -fingerprint -sha256` prints it.
pub fn certificate_fingerprint(der: &[u8]) -> String {
    Sha256::digest(der)
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

/// Reads a SHA-256 certificate fingerprint typed or pasted by the user:
/// 64 hex digits in any case, optionally separated by colons, spaces or
/// dashes, optionally after `SHA256:` or OpenSSL's `SHA256 Fingerprint=`.
pub fn parse_certificate_fingerprint(text: &str) -> Option<[u8; 32]> {
    let mut s = text.trim();
    if let Some((_, after)) = s.split_once('=') {
        s = after;
    }
    let lower = s.trim().to_ascii_lowercase();
    let digits: String = lower
        .strip_prefix("sha256:")
        .or_else(|| lower.strip_prefix("sha-256:"))
        .unwrap_or(&lower)
        .chars()
        .filter(|c| !matches!(c, ':' | ' ' | '-' | '\t'))
        .collect();
    if digits.len() != 64 {
        return None;
    }
    hex::decode(digits).ok()?.try_into().ok()
}

/// What a server's answer to `AUTH TLS` / `AUTH SSL` means (RFC 4217 §4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AuthReply {
    /// 234: start the TLS handshake now.
    Accepted,
    /// The server does not know the command or this mechanism (500, 501,
    /// 502, 504): try the older `AUTH SSL`, or the server has no FTPS.
    Unsupported,
    /// Anything else (431 unavailable, 534 policy, 334 ADAT, 421…).
    Refused,
}

fn classify_auth_reply(code: u16) -> AuthReply {
    match code {
        234 => AuthReply::Accepted,
        500 | 501 | 502 | 504 => AuthReply::Unsupported,
        _ => AuthReply::Refused,
    }
}

/// A server certificate that the system rejected and no pinned fingerprint
/// matched. Travels inside the rustls error so the handshake error can show
/// the fingerprint the user would have to check and pin.
#[derive(Debug)]
struct UntrustedCertificate {
    fingerprint: String,
    reason: String,
}

impl fmt::Display for UntrustedCertificate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} (SHA-256 {})", self.reason, self.fingerprint)
    }
}

impl std::error::Error for UntrustedCertificate {}

fn certificate_problem(e: &rustls::Error) -> String {
    match e {
        rustls::Error::InvalidCertificate(c) => match c {
            CertificateError::UnknownIssuer => {
                "it is not issued by an authority this computer trusts (self-signed or private CA)"
                    .to_string()
            }
            CertificateError::NotValidForName | CertificateError::NotValidForNameContext { .. } => {
                "it was issued for a different host name".to_string()
            }
            CertificateError::Expired | CertificateError::ExpiredContext { .. } => {
                "it has expired".to_string()
            }
            CertificateError::NotValidYet | CertificateError::NotValidYetContext { .. } => {
                "it is not valid yet".to_string()
            }
            CertificateError::Revoked => "it has been revoked".to_string(),
            // The platform's own explanation (macOS: "… certificate is not trusted").
            CertificateError::Other(OtherError(inner)) => inner.to_string(),
            other => format!("{other:?}"),
        },
        other => other.to_string(),
    }
}

/// The operating system's certificate verification (trust store, host name,
/// validity), plus one pinned certificate for self-signed servers.
#[derive(Debug)]
struct FtpsVerifier {
    system: rustls_platform_verifier::Verifier,
    pinned: Option<[u8; 32]>,
}

impl ServerCertVerifier for FtpsVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let err = match self.system.verify_server_cert(
            end_entity,
            intermediates,
            server_name,
            ocsp_response,
            now,
        ) {
            Ok(verified) => return Ok(verified),
            Err(e) => e,
        };
        let digest = Sha256::digest(end_entity.as_ref());
        if self.pinned.is_some_and(|pin| pin[..] == digest[..]) {
            return Ok(ServerCertVerified::assertion());
        }
        let mut reason = certificate_problem(&err);
        if self.pinned.is_some() {
            reason.push_str(", and it is not the certificate pinned for this site");
        }
        Err(rustls::Error::InvalidCertificate(CertificateError::Other(
            OtherError(Arc::new(UntrustedCertificate {
                fingerprint: certificate_fingerprint(end_entity.as_ref()),
                reason,
            })),
        )))
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.system.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.system.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.system.supported_verify_schemes()
    }
}

/// TLS settings of one control connection, shared by its data connections.
///
/// Every control connection gets its own client config, and with it its own
/// session cache: servers such as vsftpd (`require_ssl_reuse`, on by default)
/// only accept data connections that resume the TLS session of their own
/// control connection.
#[derive(Clone)]
struct TlsSession {
    config: Arc<ClientConfig>,
    server_name: ServerName<'static>,
}

impl TlsSession {
    fn new(host: &str, pinned_fingerprint: Option<&str>) -> Result<Self, FtpError> {
        let pinned = match pinned_fingerprint.map(str::trim).filter(|s| !s.is_empty()) {
            None => None,
            Some(text) => Some(parse_certificate_fingerprint(text).ok_or_else(|| {
                CoreError::ConnectionFailed(format!(
                    "the trusted certificate fingerprint '{text}' is not a SHA-256 \
                     fingerprint (64 hexadecimal digits)"
                ))
            })?),
        };
        let setup_error =
            |e: rustls::Error| CoreError::ConnectionFailed(format!("FTPS: TLS setup failed: {e}"));
        let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
        let system =
            rustls_platform_verifier::Verifier::new(provider.clone()).map_err(setup_error)?;
        let config = ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(setup_error)?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(FtpsVerifier { system, pinned }))
            .with_no_client_auth();
        let server_name = ServerName::try_from(host.to_string()).map_err(|_| {
            CoreError::ConnectionFailed(format!("FTPS: '{host}' is not a valid TLS server name"))
        })?;
        Ok(Self {
            config: Arc::new(config),
            server_name,
        })
    }

    /// Starts TLS as the client on `tcp` and completes the handshake.
    fn connect(&self, tcp: TcpStream) -> io::Result<Stream> {
        let conn = ClientConnection::new(self.config.clone(), self.server_name.clone())
            .map_err(io::Error::other)?;
        let mut stream = Stream::Tls(Box::new(StreamOwned::new(conn, tcp)));
        stream.handshake()?;
        Ok(stream)
    }
}

/// Explains a failed TLS handshake. A certificate the system does not trust
/// is reported with its SHA-256 fingerprint so the user can check it with
/// the server's administrator and pin it.
fn tls_error(context: &str, e: io::Error) -> CoreError {
    let tls = e
        .get_ref()
        .and_then(|inner| inner.downcast_ref::<rustls::Error>());
    let untrusted = match tls {
        Some(rustls::Error::InvalidCertificate(CertificateError::Other(OtherError(inner)))) => {
            inner.downcast_ref::<UntrustedCertificate>()
        }
        _ => None,
    };
    if let Some(u) = untrusted {
        return CoreError::ConnectionFailed(format!(
            "FTPS {context}: the server's certificate is not trusted: {}. No user name or \
             password was sent. If this is your server, compare this SHA-256 fingerprint with \
             the certificate on the server and add it to the site as the trusted certificate: {}",
            u.reason, u.fingerprint
        ));
    }
    match tls {
        Some(err) => {
            CoreError::ConnectionFailed(format!("FTPS {context}: TLS handshake failed: {err}"))
        }
        None => io_error(&format!("{context} (TLS handshake)"), e),
    }
}

/// A control or data connection: plain TCP, or TLS over TCP.
enum Stream {
    Plain(TcpStream),
    Tls(Box<StreamOwned<ClientConnection, TcpStream>>),
}

impl Stream {
    fn tcp(&self) -> &TcpStream {
        match self {
            Stream::Plain(s) => s,
            Stream::Tls(t) => &t.sock,
        }
    }

    fn handshake(&mut self) -> io::Result<()> {
        if let Stream::Tls(t) = self {
            while t.conn.is_handshaking() {
                t.conn.complete_io(&mut t.sock)?;
            }
        }
        Ok(())
    }

    /// Ends the sending direction: TLS close_notify, then a TCP half-close.
    fn finish_sending(&mut self) {
        if let Stream::Tls(t) = self {
            t.conn.send_close_notify();
            let _ = t.flush();
        }
        let _ = self.tcp().shutdown(Shutdown::Write);
    }

    /// After a TLS upload: reads what the server still sends (session
    /// tickets, close_notify) until it closes the connection. The tickets
    /// let later data connections resume this session.
    fn drain(&mut self) {
        if let Stream::Tls(t) = self {
            let _ = t.sock.set_read_timeout(Some(TLS_DRAIN_TIMEOUT));
            let _ = io::copy(&mut (&mut **t).take(MAX_LINE_BYTES), &mut io::sink());
        }
    }
}

impl Read for Stream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self {
            Stream::Plain(s) => s.read(buf),
            Stream::Tls(t) => match t.read(buf) {
                // Many servers close data connections without a TLS
                // close_notify. That is the end of the data: the transfer's
                // final reply (on the TLS control connection) still says
                // whether it completed.
                Err(e) if e.kind() == io::ErrorKind::UnexpectedEof && !t.conn.is_handshaking() => {
                    Ok(0)
                }
                other => other,
            },
        }
    }
}

impl Write for Stream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            Stream::Plain(s) => s.write(buf),
            Stream::Tls(t) => t.write(buf),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self {
            Stream::Plain(s) => s.flush(),
            Stream::Tls(t) => t.flush(),
        }
    }
}

// ---------------------------------------------------------------------------
// Control connection
// ---------------------------------------------------------------------------

/// A download whose data connection stays open so that the next sequential
/// `read_range` continues without a new RETR.
struct ActiveRetr {
    path: String,
    next_offset: u64,
    data: Stream,
}

enum Transfer {
    Data(Stream),
    /// The server sent the final reply right away (e.g. an empty listing).
    Finished,
    /// REST was refused; nothing was started.
    RestRejected,
}

struct Conn {
    /// The control connection; commands are written through `get_mut()`.
    reader: BufReader<Stream>,
    /// Set once the control connection runs over TLS.
    tls: Option<TlsSession>,
    /// PROT P accepted: data connections use TLS too.
    protected_data: bool,
    peer_ip: IpAddr,
    /// The control connection is unusable and must not go back to the pool.
    broken: bool,
    last_used: Instant,
    epsv: bool,
    /// MLSD support: None = unknown (try it).
    mlsd: Option<bool>,
    mlst: bool,
    retr: Option<ActiveRetr>,
    /// False once the server answered APPE with "not implemented": later
    /// positional writes go straight to REST + STOR.
    appe: bool,
}

fn clean_host(host: &str) -> String {
    let h = host.trim();
    let h = h
        .strip_prefix("ftp://")
        .or_else(|| h.strip_prefix("FTP://"))
        .unwrap_or(h);
    let h = h.trim_end_matches('/');
    h.strip_prefix('[')
        .and_then(|x| x.strip_suffix(']'))
        .unwrap_or(h)
        .to_string()
}

impl Conn {
    fn connect(cfg: &FtpConfig) -> Result<Conn, FtpError> {
        let host = clean_host(&cfg.host);
        if host.is_empty() {
            return Err(CoreError::ConnectionFailed("FTP host is empty".into()).into());
        }
        let port = if cfg.port == 0 { 21 } else { cfg.port };
        // Before any network I/O, so a mistyped fingerprint fails right away.
        let tls = if cfg.tls {
            Some(TlsSession::new(&host, cfg.tls_fingerprint.as_deref())?)
        } else {
            None
        };
        let addrs: Vec<SocketAddr> = (host.as_str(), port)
            .to_socket_addrs()
            .map_err(|e| {
                CoreError::ConnectionFailed(format!(
                    "could not resolve FTP host '{host}:{port}': {e}"
                ))
            })?
            .collect();

        let mut last_err = None;
        let mut stream = None;
        for addr in &addrs {
            match TcpStream::connect_timeout(addr, CONNECT_TIMEOUT) {
                Ok(s) => {
                    stream = Some(s);
                    break;
                }
                Err(e) => last_err = Some(e),
            }
        }
        let stream = stream.ok_or_else(|| {
            CoreError::ConnectionFailed(format!(
                "could not connect to FTP server {host}:{port}: {}",
                last_err
                    .map(|e| e.to_string())
                    .unwrap_or_else(|| "no address found".into())
            ))
        })?;
        let setup = |s: &TcpStream| -> io::Result<()> {
            s.set_read_timeout(Some(CONTROL_TIMEOUT))?;
            s.set_write_timeout(Some(CONTROL_TIMEOUT))?;
            s.set_nodelay(true)
        };
        setup(&stream).map_err(|e| io_error("connect", e))?;
        let peer_ip = stream.peer_addr().map_err(|e| io_error("connect", e))?.ip();

        let mut conn = Conn {
            reader: BufReader::new(Stream::Plain(stream)),
            tls: None,
            protected_data: false,
            peer_ip,
            broken: false,
            last_used: Instant::now(),
            epsv: true,
            mlsd: None,
            mlst: false,
            retr: None,
            appe: true,
        };

        let mut banner = conn.read_reply("greeting")?;
        while banner.code == 120 {
            banner = conn.read_reply("greeting")?;
        }
        if banner.code != 220 {
            return Err(CoreError::ConnectionFailed(format!(
                "FTP server {host}:{port} refused the session: {} {}",
                banner.code,
                banner.message()
            ))
            .into());
        }
        if let Some(tls) = tls {
            conn.start_tls(tls)?;
        }
        conn.login(&cfg.username, cfg.password.as_deref())?;
        if conn.tls.is_some() {
            conn.protect_data()?;
        }
        conn.negotiate()?;
        Ok(conn)
    }

    /// `AUTH TLS` (falling back to the older `AUTH SSL`) and the TLS
    /// handshake on the control connection. Runs before USER, so neither the
    /// user name nor the password ever travels in clear text; a server
    /// without FTPS is an error, never a silent downgrade to plain FTP.
    fn start_tls(&mut self, tls: TlsSession) -> Result<(), FtpError> {
        let mut reply = self.command("AUTH", Some("TLS"))?;
        if classify_auth_reply(reply.code) == AuthReply::Unsupported {
            reply = self.command("AUTH", Some("SSL"))?;
        }
        match classify_auth_reply(reply.code) {
            AuthReply::Accepted => {}
            AuthReply::Unsupported => {
                return Err(CoreError::ConnectionFailed(format!(
                    "the FTP server does not support FTPS (AUTH TLS): {} {}. Nothing was sent; \
                     use plain FTP only if you accept that the password and files travel \
                     unencrypted",
                    reply.code,
                    reply.message().trim_end_matches('.')
                ))
                .into())
            }
            AuthReply::Refused => {
                return Err(CoreError::ConnectionFailed(format!(
                    "the FTP server refused to start TLS (AUTH TLS): {} {}",
                    reply.code,
                    reply.message()
                ))
                .into())
            }
        }
        // Anything already buffered arrived in clear text after the server
        // accepted AUTH: it could be injected by an attacker, so refuse it.
        if !self.reader.buffer().is_empty() {
            self.broken = true;
            return Err(CoreError::Protocol(
                "FTPS: the server sent unexpected data after accepting AUTH TLS".into(),
            )
            .into());
        }
        let tcp = self
            .reader
            .get_ref()
            .tcp()
            .try_clone()
            .map_err(|e| io_error("AUTH TLS", e))?;
        let stream = tls.connect(tcp).map_err(|e| {
            self.broken = true;
            tls_error("control connection", e)
        })?;
        self.reader = BufReader::new(stream);
        self.tls = Some(tls);
        Ok(())
    }

    /// `PBSZ 0` and `PROT P` (RFC 4217 §8–9): data connections use TLS too.
    /// A server that refuses PROT P is an error: files are never sent in
    /// clear text on an FTPS session.
    fn protect_data(&mut self) -> Result<(), FtpError> {
        let pbsz = self.command("PBSZ", Some("0"))?;
        // Only "not implemented" is tolerated: such servers may still take PROT P.
        if !pbsz.is_ok() && !matches!(pbsz.code, 500 | 502) {
            return Err(reply_error("PBSZ 0".into(), pbsz));
        }
        let prot = self.command("PROT", Some("P"))?;
        if !prot.is_ok() {
            return Err(CoreError::ConnectionFailed(format!(
                "the FTP server refused to encrypt file transfers (PROT P): {} {}. The session \
                 was closed so that no file travels unencrypted",
                prot.code,
                prot.message().trim_end_matches('.')
            ))
            .into());
        }
        self.protected_data = true;
        Ok(())
    }

    /// Puts a data connection under TLS once the server has answered the
    /// transfer command (servers start their side of the handshake then).
    fn secure_data(&mut self, tcp: TcpStream, context: &str) -> Result<Stream, FtpError> {
        let tls = match &self.tls {
            Some(tls) if self.protected_data => tls.clone(),
            _ => return Ok(Stream::Plain(tcp)),
        };
        let err = match tls.connect(tcp) {
            Ok(stream) => return Ok(stream),
            Err(e) => tls_error(&format!("{context} data connection"), e),
        };
        // The transfer is in an unknown state: this control connection is
        // not reused. The server usually explains the failure (vsftpd:
        // "522 SSL connection failed: session reuse required").
        self.broken = true;
        match self.read_reply_timeout(context, TLS_FAILURE_REPLY_TIMEOUT) {
            Ok(reply) if !reply.is_ok() => Err(CoreError::ConnectionFailed(format!(
                "{err} (server: {} {})",
                reply.code,
                reply.message()
            ))
            .into()),
            _ => Err(err.into()),
        }
    }

    fn read_reply(&mut self, context: &str) -> Result<Reply, FtpError> {
        match read_ftp_reply(&mut self.reader) {
            Ok(reply) => {
                if reply.code == 421 {
                    self.broken = true;
                }
                Ok(reply)
            }
            Err(e) => {
                self.broken = true;
                Err(io_error(context, e).into())
            }
        }
    }

    fn read_reply_timeout(&mut self, context: &str, timeout: Duration) -> Result<Reply, FtpError> {
        let _ = self.reader.get_ref().tcp().set_read_timeout(Some(timeout));
        let reply = self.read_reply(context);
        let _ = self
            .reader
            .get_ref()
            .tcp()
            .set_read_timeout(Some(CONTROL_TIMEOUT));
        reply
    }

    /// Ends an open sequential download (the server answers 226 or 426).
    fn close_retr(&mut self) -> Result<(), FtpError> {
        if let Some(active) = self.retr.take() {
            let context = describe("RETR", Some(&active.path));
            let _ = active.data.tcp().shutdown(Shutdown::Both);
            drop(active);
            self.read_reply_timeout(&context, TRANSFER_END_TIMEOUT)?;
        }
        Ok(())
    }

    fn command(&mut self, verb: &str, arg: Option<&str>) -> Result<Reply, FtpError> {
        self.close_retr()?;
        let line = match arg {
            Some(a) => {
                check_arg(a)?;
                format!("{verb} {a}\r\n")
            }
            None => format!("{verb}\r\n"),
        };
        // Never put the password into an error message.
        let context = if verb == "PASS" {
            "PASS".to_string()
        } else {
            describe(verb, arg)
        };
        let writer = self.reader.get_mut();
        let sent = writer
            .write_all(line.as_bytes())
            .and_then(|_| writer.flush());
        if let Err(e) = sent {
            self.broken = true;
            return Err(io_error(&context, e).into());
        }
        let reply = self.read_reply(&context)?;
        self.last_used = Instant::now();
        Ok(reply)
    }

    /// Sends a command and requires a 2xx reply.
    fn expect_ok(&mut self, verb: &str, arg: Option<&str>) -> Result<Reply, FtpError> {
        let reply = self.command(verb, arg)?;
        if reply.is_ok() {
            Ok(reply)
        } else {
            Err(reply_error(describe(verb, arg), reply))
        }
    }

    fn login(&mut self, user: &str, pass: Option<&str>) -> Result<(), FtpError> {
        let (user, pass) = if user.trim().is_empty() {
            (
                "anonymous",
                pass.filter(|p| !p.is_empty()).unwrap_or("anonymous@"),
            )
        } else {
            (user, pass.unwrap_or(""))
        };
        if user.contains(['\r', '\n', '\0']) || pass.contains(['\r', '\n', '\0']) {
            return Err(CoreError::AuthFailed(
                "FTP user name or password contains line breaks or NUL characters".into(),
            )
            .into());
        }
        let reply = self.command("USER", Some(user))?;
        match reply.code {
            230 => return Ok(()),
            331 => {}
            332 => {
                return Err(CoreError::AuthFailed(
                    "FTP server requires an account (ACCT), which is not supported".into(),
                )
                .into())
            }
            _ => {
                return Err(CoreError::AuthFailed(format!(
                    "FTP login rejected for user '{user}': {} {}",
                    reply.code,
                    reply.message()
                ))
                .into())
            }
        }
        let reply = self.command("PASS", Some(pass))?;
        match reply.code {
            230 | 202 => Ok(()),
            332 => Err(CoreError::AuthFailed(
                "FTP server requires an account (ACCT), which is not supported".into(),
            )
            .into()),
            _ => Err(CoreError::AuthFailed(format!(
                "FTP login failed for user '{user}': {} {}",
                reply.code,
                reply.message()
            ))
            .into()),
        }
    }

    fn negotiate(&mut self) -> Result<(), FtpError> {
        let feat = self.command("FEAT", None)?;
        if feat.code == 211 {
            let mut utf8 = false;
            for line in feat.lines.iter().skip(1) {
                let upper = line.trim().to_ascii_uppercase();
                if upper.starts_with("211") {
                    continue;
                }
                match upper.split_whitespace().next().unwrap_or("") {
                    "MLST" => self.mlst = true,
                    "UTF8" => utf8 = true,
                    _ => {}
                }
            }
            // RFC 3659: the MLST feature covers MLSD too.
            self.mlsd = Some(self.mlst);
            if utf8 {
                // Optional; servers that refuse it still work.
                let _ = self.command("OPTS", Some("UTF8 ON"))?;
            }
        }
        self.expect_ok("TYPE", Some("I"))?;
        Ok(())
    }

    fn pwd(&mut self) -> Result<String, FtpError> {
        let reply = self.expect_ok("PWD", None)?;
        parse_pwd(&reply.message()).ok_or_else(|| {
            CoreError::Protocol(format!("malformed PWD reply: {}", reply.message())).into()
        })
    }

    /// Opens a passive data connection (EPSV, falling back to PASV). The
    /// connection always goes to the control connection's peer address, never
    /// to an address named by the server.
    fn open_data(&mut self) -> Result<TcpStream, FtpError> {
        let mut port = None;
        if self.epsv {
            let reply = self.command("EPSV", None)?;
            if reply.code == 229 {
                port = Some(parse_epsv_port(&reply.message()).ok_or_else(|| {
                    CoreError::Protocol(format!("malformed EPSV reply: {}", reply.message()))
                })?);
            } else {
                self.epsv = false;
            }
        }
        let port = match port {
            Some(p) => p,
            None => {
                if self.peer_ip.is_ipv6() {
                    return Err(CoreError::Protocol(
                        "FTP server refused EPSV, and PASV cannot be used over IPv6".into(),
                    )
                    .into());
                }
                let reply = self.command("PASV", None)?;
                if reply.code != 227 {
                    return Err(reply_error("PASV".into(), reply));
                }
                parse_pasv(&reply.message())
                    .map(|(_, p)| p)
                    .ok_or_else(|| {
                        CoreError::Protocol(format!("malformed PASV reply: {}", reply.message()))
                    })?
            }
        };
        let addr = SocketAddr::new(self.peer_ip, port);
        let context = format!("data connection to {addr}");
        let stream = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT)
            .map_err(|e| io_error(&context, e))?;
        stream
            .set_read_timeout(Some(DATA_TIMEOUT))
            .and_then(|_| stream.set_write_timeout(Some(DATA_TIMEOUT)))
            .map_err(|e| io_error(&context, e))?;
        Ok(stream)
    }

    /// Opens the data connection, optionally sends REST, then the transfer
    /// command, and waits for its preliminary reply.
    fn start_transfer(
        &mut self,
        verb: &str,
        arg: Option<&str>,
        rest: Option<u64>,
    ) -> Result<Transfer, FtpError> {
        let data = self.open_data()?;
        if let Some(offset) = rest {
            let reply = self.command("REST", Some(&offset.to_string()))?;
            if reply.code != 350 {
                return Ok(Transfer::RestRejected);
            }
        }
        let reply = self.command(verb, arg)?;
        match reply.code / 100 {
            1 => Ok(Transfer::Data(
                self.secure_data(data, &describe(verb, arg))?,
            )),
            2 => Ok(Transfer::Finished),
            _ => Err(reply_error(describe(verb, arg), reply)),
        }
    }

    /// Reads the final reply of a transfer and requires 2xx.
    fn finish_transfer(&mut self, context: &str) -> Result<(), FtpError> {
        let reply = self.read_reply_timeout(context, TRANSFER_END_TIMEOUT)?;
        if reply.is_ok() {
            Ok(())
        } else {
            Err(reply_error(context.to_string(), reply))
        }
    }

    fn read_listing(&mut self, verb: &str, arg: Option<&str>) -> Result<String, FtpError> {
        let context = describe(verb, arg);
        let mut data = match self.start_transfer(verb, arg, None)? {
            Transfer::Data(d) => d,
            Transfer::Finished | Transfer::RestRejected => return Ok(String::new()),
        };
        let mut buf = Vec::new();
        let res = (&mut data).take(MAX_LISTING_BYTES).read_to_end(&mut buf);
        drop(data);
        if let Err(e) = res {
            self.broken = true;
            return Err(io_error(&context, e).into());
        }
        self.finish_transfer(&context)?;
        Ok(String::from_utf8_lossy(&buf).into_owned())
    }

    fn list(&mut self, path: &str) -> Result<Vec<FileEntry>, FtpError> {
        if self.mlsd != Some(false) {
            match self.read_listing("MLSD", Some(path)) {
                Ok(text) => {
                    self.mlsd = Some(true);
                    return Ok(parse_mlsd_listing(&text, path));
                }
                Err(e) if matches!(reply_code(&e), Some(500 | 501 | 502 | 504)) => {
                    self.mlsd = Some(false);
                }
                Err(e) => return Err(e),
            }
        }
        // LIST fallback. CWD first so names with spaces work on every server,
        // and so that a missing directory is reported as an error instead of
        // an empty listing.
        self.expect_ok("CWD", Some(path))?;
        match self.read_listing("LIST", Some("-a")) {
            Ok(text) => return Ok(parse_list_listing(&text, path, Utc::now())),
            // Servers that do not take ls options (or treat "-a" as a name).
            Err(e) if matches!(reply_code(&e), Some(450 | 500 | 501 | 502 | 504 | 550)) => {}
            Err(e) => return Err(e),
        }
        let text = self.read_listing("LIST", None)?;
        Ok(parse_list_listing(&text, path, Utc::now()))
    }

    /// Metadata of one path: MLST, then SIZE/MDTM, then the parent listing,
    /// then a CWD probe.
    fn stat(&mut self, path: &str) -> Result<FileEntry, FtpError> {
        if path == "/" {
            return Ok(dir_entry("/", "/"));
        }
        let name = basename(path);

        if self.mlst {
            let reply = self.command("MLST", Some(path))?;
            if reply.is_ok() {
                let fact_line = reply
                    .lines
                    .iter()
                    .skip(1)
                    .map(|l| l.trim_start())
                    .find(|l| l.contains('=') && l.contains(';'));
                if let Some((facts, _)) = fact_line.and_then(split_mlsx_line) {
                    if let Some(entry) = entry_from_facts(&facts, &name, path) {
                        return Ok(entry);
                    }
                }
            } else if matches!(reply.code, 450 | 550) {
                return match reply_to_core(&describe("MLST", Some(path)), &reply) {
                    e @ CoreError::PermissionDenied(_) => Err(e.into()),
                    _ => Err(CoreError::NotFound(format!("FTP: {path}")).into()),
                };
            } else if matches!(reply.code, 500 | 501 | 502 | 504) {
                self.mlst = false;
            }
        }

        let reply = self.command("SIZE", Some(path))?;
        if reply.code == 213 {
            if let Ok(size) = reply.message().trim().parse::<u64>() {
                let mdtm = self.command("MDTM", Some(path))?;
                let modified = if mdtm.code == 213 {
                    parse_ftp_time(&mdtm.message())
                } else {
                    None
                };
                return Ok(FileEntry {
                    name: name.clone(),
                    path: path.to_string(),
                    file_type: FileType::File,
                    size,
                    modified_at: modified,
                    created_at: None,
                    permissions: Permissions::default(),
                    is_hidden: name.starts_with('.'),
                });
            }
        }

        match self.list(&parent_of(path)) {
            Ok(entries) => {
                if let Some(entry) = entries.into_iter().find(|e| e.name == name) {
                    return Ok(FileEntry {
                        path: path.to_string(),
                        ..entry
                    });
                }
            }
            Err(e) if self.broken => return Err(e),
            Err(_) => {}
        }

        // Hidden from listings, or the parent is not listable.
        let reply = self.command("CWD", Some(path))?;
        if reply.is_ok() {
            return Ok(dir_entry(&name, path));
        }
        Err(CoreError::NotFound(format!("FTP: {path}")).into())
    }

    fn retrieve_all(&mut self, path: &str) -> Result<Vec<u8>, FtpError> {
        let context = describe("RETR", Some(path));
        let mut data = match self.start_transfer("RETR", Some(path), None)? {
            Transfer::Data(d) => d,
            Transfer::Finished | Transfer::RestRejected => return Ok(Vec::new()),
        };
        let mut buf = Vec::new();
        let res = data.read_to_end(&mut buf);
        drop(data);
        if let Err(e) = res {
            self.broken = true;
            return Err(io_error(&context, e).into());
        }
        self.finish_transfer(&context)?;
        Ok(buf)
    }

    fn read_range(&mut self, path: &str, offset: u64, length: u64) -> Result<Vec<u8>, FtpError> {
        if length == 0 {
            return Ok(Vec::new());
        }
        let context = describe("RETR", Some(path));
        let reusable = self.retr.as_ref().is_some_and(|r| {
            r.path == path
                && r.next_offset == offset
                && self.last_used.elapsed() < RETR_REUSE_WINDOW
        });
        if !reusable {
            self.close_retr()?;
            let rest = (offset > 0).then_some(offset);
            let (mut data, skip) = match self.start_transfer("RETR", Some(path), rest)? {
                Transfer::Data(d) => (d, 0),
                Transfer::Finished => return Ok(Vec::new()),
                // No REST: download from the start and discard the prefix.
                Transfer::RestRejected => match self.start_transfer("RETR", Some(path), None)? {
                    Transfer::Data(d) => (d, offset),
                    _ => return Ok(Vec::new()),
                },
            };
            if skip > 0 {
                let skipped = io::copy(&mut (&mut data).take(skip), &mut io::sink());
                match skipped {
                    Ok(n) if n == skip => {}
                    Ok(_) => {
                        // The file is shorter than the offset.
                        drop(data);
                        self.finish_transfer(&context)?;
                        return Ok(Vec::new());
                    }
                    Err(e) => {
                        self.broken = true;
                        return Err(io_error(&context, e).into());
                    }
                }
            }
            self.retr = Some(ActiveRetr {
                path: path.to_string(),
                next_offset: offset,
                data,
            });
        }

        let mut buf = Vec::with_capacity(length.min(16 * 1024 * 1024) as usize);
        let res = match self.retr.as_mut() {
            Some(active) => (&mut active.data).take(length).read_to_end(&mut buf),
            None => return Err(CoreError::General("FTP download state lost".into()).into()),
        };
        if let Err(e) = res {
            self.retr = None;
            self.broken = true;
            return Err(io_error(&context, e).into());
        }
        self.last_used = Instant::now();
        if (buf.len() as u64) < length {
            // End of file: the server has finished the transfer.
            self.retr = None;
            self.finish_transfer(&context)?;
        } else if let Some(active) = self.retr.as_mut() {
            active.next_offset += buf.len() as u64;
        }
        Ok(buf)
    }

    fn store(&mut self, path: &str, data: &[u8], verb: &str) -> Result<(), FtpError> {
        self.store_from(path, data, verb, None)
    }

    /// STOR/APPE, optionally after `REST offset` (an upload that continues
    /// the file at `offset`).
    fn store_from(
        &mut self,
        path: &str,
        data: &[u8],
        verb: &str,
        rest: Option<u64>,
    ) -> Result<(), FtpError> {
        let context = describe(verb, Some(path));
        let mut sock = match self.start_transfer(verb, Some(path), rest)? {
            Transfer::Data(s) => s,
            Transfer::Finished if data.is_empty() => return Ok(()),
            Transfer::RestRejected => {
                return Err(CoreError::Protocol(format!(
                    "FTP {context}: the server refused REST {}",
                    rest.unwrap_or(0)
                ))
                .into())
            }
            Transfer::Finished => {
                return Err(CoreError::Protocol(format!(
                    "FTP {context}: server ended the upload before receiving data"
                ))
                .into())
            }
        };
        let written = sock.write_all(data).and_then(|_| sock.flush());
        sock.finish_sending();
        if written.is_ok() {
            sock.drain();
        }
        drop(sock);
        // The final reply explains a failed upload (quota, permissions...).
        match self.read_reply_timeout(&context, TRANSFER_END_TIMEOUT) {
            Ok(reply) if !reply.is_ok() => return Err(reply_error(context, reply)),
            Ok(_) => {}
            Err(e) => {
                return Err(match written {
                    Err(we) => io_error(&context, we).into(),
                    Ok(()) => e,
                })
            }
        }
        written.map_err(|e| {
            self.broken = true;
            io_error(&context, e).into()
        })
    }

    /// File size from SIZE, or None when the server does not tell.
    fn remote_size(&mut self, path: &str) -> Result<Option<u64>, FtpError> {
        let reply = self.command("SIZE", Some(path))?;
        if reply.code != 213 {
            return Ok(None);
        }
        Ok(reply.message().trim().parse::<u64>().ok())
    }

    /// Writes `data` at `offset` of an existing file. Only sequential writes
    /// are possible: `offset` must be the current size (checked with SIZE when
    /// the server has it). Uses APPE, or REST + STOR when the server refuses
    /// APPE (not implemented, or not allowed on existing files).
    fn append_at(&mut self, path: &str, offset: u64, data: &[u8]) -> Result<(), FtpError> {
        if let Some(current) = self.remote_size(path)? {
            if current != offset {
                return Err(CoreError::Protocol(format!(
                    "FTP: cannot write {path} at offset {offset}: the remote file has {current} bytes"
                ))
                .into());
            }
        }
        if !self.appe {
            return self.store_from(path, data, "STOR", Some(offset));
        }
        let err = match self.store(path, data, "APPE") {
            Ok(()) => return Ok(()),
            Err(e) => e,
        };
        let code = reply_code(&err);
        let not_implemented = matches!(code, Some(500 | 502 | 504));
        if not_implemented {
            self.appe = false;
        } else if !matches!(code, Some(501 | 550 | 553))
            // A refusal may also come after the data: retry only while the
            // file is unchanged.
            || self.remote_size(path)? != Some(offset)
        {
            return Err(err);
        }
        self.store_from(path, data, "STOR", Some(offset))
            .map_err(|_| err)
    }

    fn is_dir(&mut self, path: &str) -> Result<bool, FtpError> {
        Ok(self.command("CWD", Some(path))?.is_ok())
    }

    /// MKD with missing parents; an existing directory is fine.
    fn mkdirs(&mut self, path: &str) -> Result<(), FtpError> {
        if path == "/" || self.is_dir(path)? {
            return Ok(());
        }
        if self.command("MKD", Some(path))?.is_ok() {
            return Ok(());
        }
        let mut current = String::new();
        for component in path.split('/').filter(|c| !c.is_empty()) {
            current.push('/');
            current.push_str(component);
            if self.is_dir(&current)? {
                continue;
            }
            let reply = self.command("MKD", Some(&current))?;
            if !reply.is_ok() && !self.is_dir(&current)? {
                return Err(reply_error(describe("MKD", Some(&current)), reply));
            }
        }
        Ok(())
    }

    fn remove_dir(&mut self, path: &str, recursive: bool) -> Result<(), FtpError> {
        if path == "/" {
            return Err(
                CoreError::PermissionDenied("refusing to delete the FTP root".into()).into(),
            );
        }
        let entry = self.stat(path)?;
        match entry.file_type {
            FileType::Directory => {}
            // A link to a directory: remove the link, never the target's content.
            FileType::Symlink => {
                self.expect_ok("DELE", Some(path))?;
                return Ok(());
            }
            _ => {
                return Err(CoreError::InvalidPath(format!("{path} is not a directory")).into());
            }
        }
        if recursive {
            self.expect_ok("CWD", Some(path))?;
            let real = self.pwd()?;
            self.remove_tree(path, &real, 0)
        } else {
            self.expect_ok("CWD", Some(&parent_of(path)))?;
            self.expect_ok("RMD", Some(path))?;
            Ok(())
        }
    }

    fn remove_tree(&mut self, path: &str, real: &str, depth: usize) -> Result<(), FtpError> {
        if depth > MAX_WALK_DEPTH {
            return Err(
                CoreError::General(format!("FTP: directory tree too deep at {path}")).into(),
            );
        }
        let real_prefix = format!("{}/", real.trim_end_matches('/'));
        for entry in self.list(path)? {
            match entry.file_type {
                FileType::Directory => {
                    // Do not follow links: a real subdirectory resolves to a
                    // path inside this one.
                    self.expect_ok("CWD", Some(&entry.path))?;
                    let child_real = self.pwd()?;
                    if child_real.starts_with(&real_prefix) {
                        self.remove_tree(&entry.path, &child_real, depth + 1)?;
                    } else {
                        self.expect_ok("DELE", Some(&entry.path))?;
                    }
                }
                _ => {
                    self.expect_ok("DELE", Some(&entry.path))?;
                }
            }
        }
        // Leave the directory before removing it (some servers refuse RMD of
        // the working directory).
        self.expect_ok("CWD", Some(&parent_of(path)))?;
        self.expect_ok("RMD", Some(path))?;
        Ok(())
    }

    fn rename(&mut self, from: &str, to: &str) -> Result<(), FtpError> {
        let reply = self.command("RNFR", Some(from))?;
        if reply.code != 350 {
            return Err(reply_error(describe("RNFR", Some(from)), reply));
        }
        self.expect_ok("RNTO", Some(to))?;
        Ok(())
    }

    /// Breadth-first walk below `root`. `visit(entry, depth)` returns false to stop.
    fn walk<F>(
        &mut self,
        root: &str,
        max_depth: Option<usize>,
        mut visit: F,
    ) -> Result<(), FtpError>
    where
        F: FnMut(&FileEntry, usize) -> bool,
    {
        let mut queue = VecDeque::from([(root.to_string(), 0usize)]);
        let mut seen = 0usize;
        while let Some((dir, depth)) = queue.pop_front() {
            let entries = match self.list(&dir) {
                Ok(e) => e,
                Err(e) if depth == 0 || self.broken => return Err(e),
                Err(e) => {
                    tracing::debug!("FTP walk skipped {dir}: {}", CoreError::from(e));
                    continue;
                }
            };
            for entry in entries {
                seen += 1;
                let child_depth = depth + 1;
                if !visit(&entry, child_depth) {
                    return Ok(());
                }
                if entry.is_dir()
                    && child_depth < MAX_WALK_DEPTH
                    && max_depth.is_none_or(|d| child_depth < d)
                {
                    queue.push_back((entry.path.clone(), child_depth));
                }
                if seen >= MAX_WALK_ENTRIES {
                    tracing::warn!("FTP walk below {root} stopped after {seen} entries");
                    return Ok(());
                }
            }
        }
        Ok(())
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Which pooled connection an operation would like.
enum Prefer {
    Idle,
    /// The connection whose open download continues at this offset.
    Retr(String, u64),
}

fn take_conn(pool: &Mutex<Vec<Conn>>, cfg: &FtpConfig, prefer: &Prefer) -> Result<Conn, FtpError> {
    loop {
        let candidate = {
            let mut conns = lock(pool);
            let preferred = match prefer {
                Prefer::Retr(path, offset) => conns.iter().position(|c| {
                    c.retr
                        .as_ref()
                        .is_some_and(|r| &r.path == path && r.next_offset == *offset)
                }),
                Prefer::Idle => None,
            };
            let idx = preferred
                .or_else(|| conns.iter().position(|c| c.retr.is_none()))
                .or_else(|| conns.len().checked_sub(1));
            idx.map(|i| conns.swap_remove(i))
        };
        let Some(mut conn) = candidate else {
            return Conn::connect(cfg);
        };
        if conn.last_used.elapsed() < LIVENESS_CHECK_AFTER {
            return Ok(conn);
        }
        // Idle for a while: make sure the server has not dropped the session.
        match conn.command("NOOP", None) {
            Ok(reply) if reply.is_ok() && !conn.broken => return Ok(conn),
            _ => continue,
        }
    }
}

impl FtpDriver {
    pub fn new(config: FtpConfig) -> Self {
        Self {
            config,
            pool: Arc::new(Mutex::new(Vec::new())),
            limiter: Arc::new(Semaphore::new(MAX_CONNECTIONS)),
            home: Arc::new(Mutex::new(None)),
        }
    }

    /// Connects and logs in (verifying the credentials), keeping the
    /// connection for later operations.
    pub async fn connect(&self) -> CoreResult<()> {
        let home = self
            .with_conn(Prefer::Idle, |c| c.pwd().map(Some).or(Ok(None)))
            .await?;
        *lock(&self.home) = home;
        Ok(())
    }

    /// Runs `op` on a pooled control connection on the blocking pool.
    async fn with_conn<T, F>(&self, prefer: Prefer, op: F) -> CoreResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Conn) -> Result<T, FtpError> + Send + 'static,
    {
        let permit = self
            .limiter
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| CoreError::General(format!("FTP connection limiter closed: {e}")))?;
        let pool = self.pool.clone();
        let cfg = self.config.clone();
        task::spawn_blocking(move || {
            let _permit = permit;
            let mut conn = take_conn(&pool, &cfg, &prefer).map_err(CoreError::from)?;
            let result = op(&mut conn);
            if !conn.broken {
                let mut conns = lock(&pool);
                if conns.len() < MAX_CONNECTIONS {
                    conns.push(conn);
                }
            }
            result.map_err(CoreError::from)
        })
        .await
        .map_err(|e| CoreError::General(format!("FTP worker task failed: {e}")))?
    }

    async fn walk_matching<F>(
        &self,
        root: &str,
        max_depth: Option<usize>,
        max_results: usize,
        matches: F,
    ) -> CoreResult<Vec<FileEntry>>
    where
        F: Fn(&FileEntry) -> bool + Send + 'static,
    {
        if max_results == 0 {
            return Ok(Vec::new());
        }
        let root = normalize_path(root);
        self.with_conn(Prefer::Idle, move |c| {
            let mut results = Vec::new();
            c.walk(&root, max_depth, |entry, _| {
                if matches(entry) {
                    results.push(entry.clone());
                }
                results.len() < max_results
            })?;
            Ok(results)
        })
        .await
    }
}

#[async_trait]
impl VirtualFileSystem for FtpDriver {
    fn protocol(&self) -> Protocol {
        if self.config.tls {
            Protocol::Ftps
        } else {
            Protocol::Ftp
        }
    }

    /// Not advertised: chunked uploads need APPE (or REST + STOR) on a file
    /// that already exists, which common servers refuse by default (stock
    /// ProFTPD answers 451 "Append/Restart not permitted" unless
    /// AllowStoreRestart is on; vsftpd anonymous upload dirs answer 553).
    /// A refusal mid-upload would leave the destination truncated (the first
    /// STOR already replaced it), so callers use one `write_file` (a single
    /// STOR) instead. `write_at` still works for callers that want it on a
    /// server known to allow appends.
    fn supports_write_at(&self) -> bool {
        false
    }

    async fn list_dir(&self, path: &str) -> CoreResult<Vec<FileEntry>> {
        let path = normalize_path(path);
        let mut entries = self.with_conn(Prefer::Idle, move |c| c.list(&path)).await?;
        entries.sort_by(|a, b| match (a.is_dir(), b.is_dir()) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });
        Ok(entries)
    }

    async fn metadata(&self, path: &str) -> CoreResult<FileEntry> {
        let path = normalize_path(path);
        self.with_conn(Prefer::Idle, move |c| c.stat(&path)).await
    }

    async fn read_file(&self, path: &str) -> CoreResult<Bytes> {
        let path = normalize_path(path);
        let data = self
            .with_conn(Prefer::Idle, move |c| c.retrieve_all(&path))
            .await?;
        Ok(Bytes::from(data))
    }

    async fn read_range(&self, path: &str, offset: u64, length: u64) -> CoreResult<Bytes> {
        if length == 0 {
            return Ok(Bytes::new());
        }
        let path = normalize_path(path);
        let prefer = Prefer::Retr(path.clone(), offset);
        let data = self
            .with_conn(prefer, move |c| c.read_range(&path, offset, length))
            .await?;
        Ok(Bytes::from(data))
    }

    async fn write_file(&self, path: &str, data: Bytes) -> CoreResult<()> {
        let path = normalize_path(path);
        self.with_conn(Prefer::Idle, move |c| c.store(&path, &data, "STOR"))
            .await
    }

    async fn write_at(&self, path: &str, offset: u64, data: Bytes) -> CoreResult<()> {
        let path = normalize_path(path);
        self.with_conn(Prefer::Idle, move |c| {
            if offset == 0 {
                c.store(&path, &data, "STOR")
            } else {
                c.append_at(&path, offset, &data)
            }
        })
        .await
    }

    async fn create_dir(&self, path: &str) -> CoreResult<()> {
        let path = normalize_path(path);
        self.with_conn(Prefer::Idle, move |c| c.mkdirs(&path)).await
    }

    async fn remove_file(&self, path: &str) -> CoreResult<()> {
        let path = normalize_path(path);
        self.with_conn(Prefer::Idle, move |c| {
            c.expect_ok("DELE", Some(&path)).map(|_| ())
        })
        .await
    }

    async fn remove_dir(&self, path: &str, recursive: bool) -> CoreResult<()> {
        let path = normalize_path(path);
        self.with_conn(Prefer::Idle, move |c| c.remove_dir(&path, recursive))
            .await
    }

    async fn rename(&self, from: &str, to: &str) -> CoreResult<()> {
        let from = normalize_path(from);
        let to = normalize_path(to);
        if from == to {
            return Ok(());
        }
        self.with_conn(Prefer::Idle, move |c| c.rename(&from, &to))
            .await
    }

    async fn set_permissions(&self, path: &str, mode: u32) -> CoreResult<()> {
        let path = normalize_path(path);
        self.with_conn(Prefer::Idle, move |c| {
            let arg = format!("CHMOD {:o} {path}", mode & 0o7777);
            c.expect_ok("SITE", Some(&arg)).map(|_| ())
        })
        .await
    }

    async fn exists(&self, path: &str) -> CoreResult<bool> {
        match self.metadata(path).await {
            Ok(_) => Ok(true),
            Err(CoreError::NotFound(_)) => Ok(false),
            Err(e) => Err(e),
        }
    }

    async fn search(
        &self,
        root_path: &str,
        pattern: &str,
        max_results: usize,
    ) -> CoreResult<Vec<FileEntry>> {
        let pat_lower = pattern.to_lowercase();
        self.walk_matching(root_path, None, max_results, move |e| {
            e.name.to_lowercase().contains(&pat_lower)
        })
        .await
    }

    async fn create_symlink(
        &self,
        _target: &str,
        _link_path: &str,
        _is_symbolic: bool,
    ) -> CoreResult<()> {
        Err(CoreError::General(
            "FTP server does not support symlink creation".to_string(),
        ))
    }

    async fn get_filesystem_info(&self, path: &str) -> CoreResult<FileSystemInfo> {
        // FTP has no standard way to query free space: report 0 (unknown)
        // instead of invented numbers.
        Ok(FileSystemInfo {
            path: path.to_string(),
            total_bytes: 0,
            free_bytes: 0,
            available_bytes: 0,
            used_bytes: 0,
            total_inodes: None,
            free_inodes: None,
            protocol_name: "FTP (File Transfer Protocol)".to_string(),
            protocol_version: "RFC 959".to_string(),
            host_key_fingerprint_sha256: None,
            host_key_fingerprint_md5: None,
            cipher_name: Some("None (plain FTP, unencrypted)".to_string()),
            compression_name: None,
        })
    }

    async fn calculate_size(&self, path: &str) -> CoreResult<u64> {
        let path = normalize_path(path);
        self.with_conn(Prefer::Idle, move |c| {
            let entry = c.stat(&path)?;
            if !entry.is_dir() {
                return Ok(entry.size);
            }
            let mut total = 0u64;
            c.walk(&path, None, |e, _| {
                if e.is_file() {
                    total = total.saturating_add(e.size);
                }
                true
            })?;
            Ok(total)
        })
        .await
    }

    async fn find_files(&self, query: &FindFileQuery) -> CoreResult<Vec<FindFileMatch>> {
        let mask = crate::file_masks::FileMaskFilter::new(&query.mask);
        let needle = query.contains_text.clone().filter(|t| !t.is_empty());
        let Some(needle) = needle else {
            let mask_for_walk = mask.clone();
            return Ok(self
                .walk_matching(
                    &query.base_path,
                    query.max_depth,
                    query.max_results,
                    move |e| mask_for_walk.matches(&e.name, e.is_dir()),
                )
                .await?
                .into_iter()
                .map(|entry| FindFileMatch {
                    entry,
                    matched_lines: vec![],
                })
                .collect());
        };

        let root = normalize_path(&query.base_path);
        let max_depth = query.max_depth;
        let max_results = query.max_results;
        let case_sensitive = query.case_sensitive;
        self.with_conn(Prefer::Idle, move |c| {
            let mut candidates = Vec::new();
            c.walk(&root, max_depth, |e, _| {
                if e.is_file()
                    && e.size <= crate::s3::CONTENT_SEARCH_MAX_BYTES
                    && mask.matches(&e.name, false)
                {
                    candidates.push(e.clone());
                }
                candidates.len() < crate::s3::CONTENT_SEARCH_MAX_CANDIDATES
            })?;
            let mut results = Vec::new();
            for entry in candidates {
                if results.len() >= max_results {
                    break;
                }
                let data = match c.retrieve_all(&entry.path) {
                    Ok(d) => d,
                    Err(e) if c.broken => return Err(e),
                    Err(_) => continue,
                };
                let lines = crate::s3::grep_content(&data, &needle, case_sensitive);
                if !lines.is_empty() {
                    results.push(FindFileMatch {
                        entry,
                        matched_lines: lines,
                    });
                }
            }
            Ok(results)
        })
        .await
    }

    async fn get_default_path(&self) -> CoreResult<String> {
        if let Some(home) = lock(&self.home).clone() {
            return Ok(home);
        }
        let home = self.with_conn(Prefer::Idle, |c| c.pwd()).await?;
        *lock(&self.home) = Some(home.clone());
        Ok(home)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn reply(text: &str) -> io::Result<Reply> {
        read_ftp_reply(&mut Cursor::new(text.as_bytes().to_vec()))
    }

    #[test]
    fn reply_parser_single_and_multi_line() {
        let r = reply("220 Service ready\r\n").unwrap();
        assert_eq!(r.code, 220);
        assert_eq!(r.message(), "Service ready");

        let r = reply("220-Welcome\r\n220-to the server\r\n  211 not an end\r\n220 ready\r\nextra")
            .unwrap();
        assert_eq!(r.code, 220);
        assert_eq!(r.lines.len(), 4);
        assert_eq!(r.message(), "Welcome to the server 211 not an end ready");

        let feat = reply("211-Features:\n MLST type*;size*;\n UTF8\n211 End\n").unwrap();
        assert_eq!(feat.code, 211);
        assert_eq!(feat.lines.len(), 4);

        // Reads exactly one reply and leaves the next one in the stream.
        let mut cur = Cursor::new(b"331 need password\r\n230 logged in\r\n".to_vec());
        assert_eq!(read_ftp_reply(&mut cur).unwrap().code, 331);
        assert_eq!(read_ftp_reply(&mut cur).unwrap().code, 230);
        assert!(read_ftp_reply(&mut cur).is_err());

        assert!(reply("hello\r\n").is_err());
        assert!(reply("220-unterminated\r\n220-still\r\n").is_err());
        assert!(reply("").is_err());
    }

    #[test]
    fn passive_reply_parsers() {
        assert_eq!(
            parse_epsv_port("Entering Extended Passive Mode (|||6446|)"),
            Some(6446)
        );
        assert_eq!(
            parse_epsv_port("Entering Extended Passive Mode (!!!21!)"),
            Some(21)
        );
        assert_eq!(parse_epsv_port("Entering Extended Passive Mode"), None);
        assert_eq!(
            parse_pasv("Entering Passive Mode (192,168,1,2,195,149)."),
            Some(([192, 168, 1, 2], 195 * 256 + 149))
        );
        assert_eq!(
            parse_pasv("Entering Passive Mode 10,0,0,1,4,1"),
            Some(([10, 0, 0, 1], 1025))
        );
        assert_eq!(parse_pasv("Entering Passive Mode (300,1,1,1,1,1)"), None);
    }

    #[test]
    fn pwd_and_time_parsers() {
        assert_eq!(
            parse_pwd("\"/home/user\" is the current directory").as_deref(),
            Some("/home/user")
        );
        assert_eq!(
            parse_pwd("\"/a \"\"quoted\"\" dir\"").as_deref(),
            Some("/a \"quoted\" dir")
        );
        assert_eq!(parse_pwd("no quotes"), None);
        let t = parse_ftp_time("20240102030405.123").unwrap();
        assert_eq!(t.to_rfc3339(), "2024-01-02T03:04:05+00:00");
        assert!(parse_ftp_time("2024").is_none());
    }

    #[test]
    fn mlsd_parser() {
        let text = "type=cdir;modify=20240101000000; .\r\n\
                    type=pdir;modify=20240101000000; ..\r\n\
                    type=file;size=1234;modify=20240102030405;UNIX.mode=0640;UNIX.owner=alice;UNIX.group=staff;perm=r; report; final v2.txt\r\n\
                    type=dir;modify=20240102030405;perm=flcdmpe; photos\r\n\
                    type=OS.unix=slink:/etc/hosts;modify=20240102030405; hosts-link\r\n\
                    Type=File;Size=7; .hidden\r\n";
        let entries = parse_mlsd_listing(text, "/data");
        assert_eq!(entries.len(), 4);
        let f = &entries[0];
        assert_eq!(f.name, "report; final v2.txt");
        assert_eq!(f.path, "/data/report; final v2.txt");
        assert_eq!(f.file_type, FileType::File);
        assert_eq!(f.size, 1234);
        assert_eq!(f.permissions.mode, 0o640);
        assert!(f.permissions.readonly);
        assert_eq!(f.permissions.owner.as_deref(), Some("alice"));
        assert_eq!(
            f.modified_at.unwrap().to_rfc3339(),
            "2024-01-02T03:04:05+00:00"
        );
        assert_eq!(entries[1].file_type, FileType::Directory);
        assert_eq!(entries[1].path, "/data/photos");
        assert_eq!(entries[2].file_type, FileType::Symlink);
        assert_eq!(entries[3].name, ".hidden");
        assert!(entries[3].is_hidden);
        assert_eq!(entries[3].size, 7);

        let root = parse_mlsd_listing("type=file;size=1; a.txt\n", "/");
        assert_eq!(root[0].path, "/a.txt");
    }

    #[test]
    fn unix_list_parser() {
        let now = Utc.with_ymd_and_hms(2024, 3, 15, 12, 0, 0).unwrap();
        let text = "total 12\r\n\
            drwxr-xr-x    2 ftp      ftp          4096 Mar 10 09:30 docs\r\n\
            -rw-r--r--    1 ftp      ftp        123456 Dec 24 18:05 old  name.tar.gz\r\n\
            -rwsr-x---    1 root     wheel         512 Jan  5  2021 setuid-bin\r\n\
            lrwxrwxrwx    1 ftp      ftp            11 Mar 01 00:00 current -> releases/v2\r\n\
            -rw-r--r--    1 owner              99 Feb 02 10:00 no-group.txt\r\n\
            crw-rw-rw-    1 root     root       1,   3 Mar 01 00:00 null\r\n\
            -rw-r--r-- 1 u g 42 2023-07-08 09:10 iso date.txt\r\n\
            drwxr-xr-x    2 ftp      ftp          4096 Mar 10 09:30 .\r\n\
            garbage line\r\n";
        let entries = parse_list_listing(text, "/pub", now);
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "docs",
                "old  name.tar.gz",
                "setuid-bin",
                "current",
                "no-group.txt",
                "null",
                "iso date.txt"
            ]
        );
        let docs = &entries[0];
        assert_eq!(docs.file_type, FileType::Directory);
        assert_eq!(docs.path, "/pub/docs");
        assert_eq!(docs.permissions.mode, 0o755);
        assert_eq!(
            docs.modified_at.unwrap().to_rfc3339(),
            "2024-03-10T09:30:00+00:00"
        );
        // December is in the future relative to March: previous year.
        let old = &entries[1];
        assert_eq!(old.size, 123456);
        assert_eq!(
            old.modified_at.unwrap().to_rfc3339(),
            "2023-12-24T18:05:00+00:00"
        );
        assert_eq!(old.permissions.owner.as_deref(), Some("ftp"));
        assert_eq!(old.permissions.group.as_deref(), Some("ftp"));
        let suid = &entries[2];
        assert_eq!(suid.permissions.mode, 0o4750);
        assert_eq!(
            suid.modified_at.unwrap().to_rfc3339(),
            "2021-01-05T00:00:00+00:00"
        );
        assert_eq!(entries[3].file_type, FileType::Symlink);
        assert_eq!(entries[3].name, "current");
        let ng = &entries[4];
        assert_eq!(ng.size, 99);
        assert_eq!(ng.permissions.owner.as_deref(), Some("owner"));
        assert_eq!(ng.permissions.group, None);
        assert_eq!(entries[5].file_type, FileType::Other);
        assert_eq!(entries[6].size, 42);
        assert_eq!(
            entries[6].modified_at.unwrap().to_rfc3339(),
            "2023-07-08T09:10:00+00:00"
        );
    }

    #[test]
    fn dos_list_parser() {
        let now = Utc::now();
        let text = "01-02-24  03:04PM       <DIR>          My Documents\r\n\
                    12-31-1999  11:59AM             1,234 report final.txt\r\n\
                    07-08-23  12:00 AM                0 empty.bin\r\n";
        let entries = parse_list_listing(text, "/", now);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].name, "My Documents");
        assert_eq!(entries[0].file_type, FileType::Directory);
        assert_eq!(
            entries[0].modified_at.unwrap().to_rfc3339(),
            "2024-01-02T15:04:00+00:00"
        );
        assert_eq!(entries[1].name, "report final.txt");
        assert_eq!(entries[1].size, 1234);
        assert_eq!(
            entries[1].modified_at.unwrap().to_rfc3339(),
            "1999-12-31T11:59:00+00:00"
        );
        assert_eq!(
            entries[2].modified_at.unwrap().to_rfc3339(),
            "2023-07-08T00:00:00+00:00"
        );
    }

    #[test]
    fn reply_mapping_and_injection_guard() {
        let r = |code: u16, text: &str| Reply {
            code,
            lines: vec![format!("{code} {text}")],
        };
        assert!(matches!(
            reply_to_core("PASS", &r(530, "Login incorrect.")),
            CoreError::AuthFailed(_)
        ));
        assert!(matches!(
            reply_to_core("RETR /x", &r(550, "/x: No such file or directory")),
            CoreError::NotFound(_)
        ));
        assert!(matches!(
            reply_to_core("STOR /x", &r(550, "/x: Permission denied")),
            CoreError::PermissionDenied(_)
        ));
        match reply_to_core("DELE /x", &r(550, "Delete operation failed.")) {
            CoreError::Protocol(msg) => assert!(msg.contains("Delete operation failed.")),
            other => panic!("unexpected {other:?}"),
        }
        assert!(check_arg("/a b/c.txt").is_ok());
        assert!(check_arg("x\r\nDELE /etc/passwd").is_err());
        assert!(check_arg("x\n").is_err());
    }

    #[test]
    fn path_helpers() {
        assert_eq!(normalize_path(""), "/");
        assert_eq!(normalize_path("/a/b/"), "/a/b");
        assert_eq!(normalize_path("a"), "/a");
        // Names with leading/trailing whitespace are addressed exactly.
        assert_eq!(normalize_path("/home/u/notes "), "/home/u/notes ");
        assert_eq!(normalize_path("/a/ b"), "/a/ b");
        assert_eq!(normalize_path("/a/b /"), "/a/b ");
        assert_eq!(normalize_path(" x"), "/ x");
        assert_eq!(parent_of("/a/b"), "/a");
        assert_eq!(parent_of("/a"), "/");
        assert_eq!(basename("/a/b c"), "b c");
        assert_eq!(join_path("/", "x"), "/x");
        assert_eq!(join_path("/a", "x"), "/a/x");
        assert_eq!(clean_host("ftp://example.com/"), "example.com");
        assert_eq!(clean_host("[::1]"), "::1");
        assert_eq!(parse_mode_string("rwxr-x--T"), 0o1750);
        assert_eq!(parse_mode_string("rw-r-Sr--"), 0o2644);
    }

    #[test]
    fn debug_output_redacts_password() {
        let d = FtpDriver::new(FtpConfig {
            host: "h".into(),
            port: 21,
            username: "u".into(),
            password: Some("hunter2".into()),
            tls: false,
            tls_fingerprint: None,
        });
        let dbg = format!("{d:?}");
        assert!(!dbg.contains("hunter2"));
    }

    // -----------------------------------------------------------------------
    // In-process fake FTP server for end-to-end tests
    // -----------------------------------------------------------------------

    mod fake {
        use base64::Engine as _;
        use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
        use rustls::{HandshakeKind, ServerConfig, ServerConnection, StreamOwned};
        use std::collections::{BTreeMap, BTreeSet};
        use std::io::{self, BufRead, BufReader, Read, Write};
        use std::net::{TcpListener, TcpStream};
        use std::sync::{Arc, Mutex};
        use std::thread;

        /// Self-signed P-256 test certificate (CN=localhost, SAN localhost and
        /// 127.0.0.1, valid until 2126) and its PKCS#8 key, DER in base64.
        const TEST_CERT_B64: &str =
            "MIIBPjCB5aADAgECAgkAnhBfzQ3bhPAwCgYIKoZIzj0EAwIwFDESMBAGA1UEAwwJbG9jYWxob3N0\
            MCAXDTI2MTAyMDE1NDgzNloYDzIxMjYwOTI2MTU0ODM2WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3Qw\
            WTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAQxRoBM2H5DuHB9T/w1Zp2tAcZcCH18aeFuHVi2xdwt\
            l4P55iZls5M6eM7kF6lpY1xKCoo+fYzNu4NLFDK358Npox4wHDAaBgNVHREEEzARgglsb2NhbGhv\
            c3SHBH8AAAEwCgYIKoZIzj0EAwIDSAAwRQIgUssOX5ElE2vZW7mWW0AmgNYQ7ZoAhMA7fzQOBool\
            +aICIQDOfPfkKDY9m7HEiQ1lovYnp0wUa5TTUdrX3yyXjSRbYQ==";
        const TEST_KEY_B64: &str =
            "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgv/YKp+XzmrEJh2ETTm+BNmbJUWvy\
            xI0lOa16igNIgWqhRANCAAQxRoBM2H5DuHB9T/w1Zp2tAcZcCH18aeFuHVi2xdwtl4P55iZls5M6\
            eM7kF6lpY1xKCoo+fYzNu4NLFDK358Np";
        /// `openssl x509 -noout -fingerprint -sha256` of the test certificate.
        pub const TEST_CERT_FINGERPRINT: &str = "FC:C5:C2:3D:8C:C6:0B:25:06:62:0D:2E:D5:63:A2:1C:\
            9C:38:A4:9E:A0:88:4F:CB:0C:F2:24:2F:D3:5A:2A:A9";

        fn der(b64: &str) -> Vec<u8> {
            let compact: String = b64.split_whitespace().collect();
            base64::engine::general_purpose::STANDARD
                .decode(compact)
                .unwrap()
        }

        pub fn test_cert_der() -> Vec<u8> {
            der(TEST_CERT_B64)
        }

        /// A fresh server config, and so a fresh session cache, per control
        /// connection: like vsftpd's per-session process, a data connection
        /// can only resume its own control connection's session.
        fn session_tls_config(tls12_only: bool) -> Arc<ServerConfig> {
            let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
            let builder = ServerConfig::builder_with_provider(provider);
            let builder = if tls12_only {
                builder.with_protocol_versions(&[&rustls::version::TLS12])
            } else {
                builder.with_safe_default_protocol_versions()
            };
            let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(der(TEST_KEY_B64)));
            Arc::new(
                builder
                    .unwrap()
                    .with_no_client_auth()
                    .with_single_cert(vec![CertificateDer::from(test_cert_der())], key)
                    .unwrap(),
            )
        }

        /// One end of a control or data connection, plain or TLS.
        pub enum Conn {
            Plain(TcpStream),
            Tls(Box<StreamOwned<ServerConnection, TcpStream>>),
            Closed,
        }

        impl Read for Conn {
            fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
                match self {
                    Conn::Plain(s) => s.read(buf),
                    Conn::Tls(t) => t.read(buf),
                    Conn::Closed => Ok(0),
                }
            }
        }

        impl Write for Conn {
            fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
                match self {
                    Conn::Plain(s) => s.write(buf),
                    Conn::Tls(t) => t.write(buf),
                    Conn::Closed => Err(io::ErrorKind::BrokenPipe.into()),
                }
            }

            fn flush(&mut self) -> io::Result<()> {
                match self {
                    Conn::Plain(s) => s.flush(),
                    Conn::Tls(t) => t.flush(),
                    Conn::Closed => Ok(()),
                }
            }
        }

        /// The control connection, shared by the line reader and the reply
        /// writer (one session thread uses it, so the lock never contends).
        #[derive(Clone)]
        pub struct Ctl(Arc<Mutex<Conn>>);

        impl Read for Ctl {
            fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
                self.0.lock().unwrap().read(buf)
            }
        }

        impl Write for Ctl {
            fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
                self.0.lock().unwrap().write(buf)
            }

            fn flush(&mut self) -> io::Result<()> {
                self.0.lock().unwrap().flush()
            }
        }

        /// A data connection; TLS ones end with close_notify, like vsftpd's.
        pub struct Data(Conn);

        impl Read for Data {
            fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
                self.0.read(buf)
            }
        }

        impl Write for Data {
            fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
                self.0.write(buf)
            }

            fn flush(&mut self) -> io::Result<()> {
                self.0.flush()
            }
        }

        impl Drop for Data {
            fn drop(&mut self) {
                if let Conn::Tls(t) = &mut self.0 {
                    t.conn.send_close_notify();
                    let _ = t.flush();
                }
            }
        }

        #[derive(Default)]
        pub struct Fs {
            pub files: BTreeMap<String, Vec<u8>>,
            pub dirs: BTreeSet<String>,
            /// RETR commands received (to check that sequential reads reuse one download).
            pub retr_count: usize,
            /// Answer APPE with 502 (servers without APPE).
            pub refuse_appe: bool,
            /// Answer APPE and REST + STOR on an existing file with 451, like
            /// stock ProFTPD without `AllowStoreRestart`.
            pub refuse_append_existing: bool,
            /// USER commands received on a control connection without / with TLS.
            pub plain_users: usize,
            pub tls_users: usize,
            /// TLS data connections that resumed the control connection's
            /// session, and those that needed a full handshake.
            pub data_resumed: usize,
            pub data_full: usize,
        }

        #[derive(Clone, Copy, Default)]
        pub struct Options {
            pub mlst: bool,
            pub epsv: bool,
            /// Offer explicit FTPS (AUTH TLS) with the test certificate.
            pub tls: bool,
            /// TLS 1.2 only (session-ID resumption instead of TLS 1.3 tickets).
            pub tls12_only: bool,
            /// Answer `AUTH TLS` with 504; only the older `AUTH SSL` works.
            pub auth_ssl_only: bool,
            /// Answer `PROT P` with 536.
            pub refuse_prot_p: bool,
            /// vsftpd's `require_ssl_reuse`: a TLS data connection that does
            /// not resume its control connection's session fails with 522.
            pub require_reuse: bool,
        }

        pub struct Server {
            pub port: u16,
            pub fs: Arc<Mutex<Fs>>,
        }

        pub fn start(opts: Options) -> Server {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let mut fs = Fs::default();
            fs.dirs.insert("/".into());
            fs.dirs.insert("/home".into());
            let fs = Arc::new(Mutex::new(fs));
            let shared = fs.clone();
            thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(stream) = stream else { break };
                    let fs = shared.clone();
                    thread::spawn(move || session(stream, fs, opts));
                }
            });
            Server { port, fs }
        }

        fn resolve(cwd: &str, arg: &str) -> String {
            let p = if arg.starts_with('/') {
                arg.to_string()
            } else if cwd == "/" {
                format!("/{arg}")
            } else {
                format!("{cwd}/{arg}")
            };
            if p.len() > 1 {
                p.trim_end_matches('/').to_string()
            } else {
                p
            }
        }

        fn children(fs: &Fs, dir: &str) -> Vec<(String, bool, usize)> {
            let prefix = if dir == "/" {
                "/".to_string()
            } else {
                format!("{dir}/")
            };
            let mut out = Vec::new();
            for d in &fs.dirs {
                if let Some(rest) = d.strip_prefix(&prefix) {
                    if !rest.is_empty() && !rest.contains('/') {
                        out.push((rest.to_string(), true, 0));
                    }
                }
            }
            for (f, data) in &fs.files {
                if let Some(rest) = f.strip_prefix(&prefix) {
                    if !rest.contains('/') {
                        out.push((rest.to_string(), false, data.len()));
                    }
                }
            }
            out
        }

        /// Accepts the passive data connection. Under PROT P (`tls` set) it
        /// completes the TLS handshake first and enforces session reuse; on
        /// failure the 522 reply has been sent and None is returned.
        fn open_data(
            passive: &mut Option<TcpListener>,
            out: &mut Ctl,
            tls: Option<&Arc<ServerConfig>>,
            opts: Options,
            fs: &Mutex<Fs>,
        ) -> Option<Data> {
            let listener = passive.take().expect("no passive listener");
            let tcp = listener.accept().unwrap().0;
            let Some(cfg) = tls else {
                return Some(Data(Conn::Plain(tcp)));
            };
            let mut tls = StreamOwned::new(ServerConnection::new(cfg.clone()).unwrap(), tcp);
            while tls.conn.is_handshaking() {
                if tls.conn.complete_io(&mut tls.sock).is_err() {
                    let _ = out.write_all(b"522 SSL connection failed\r\n");
                    return None;
                }
            }
            let resumed = tls.conn.handshake_kind() == Some(HandshakeKind::Resumed);
            {
                let mut g = fs.lock().unwrap();
                if resumed {
                    g.data_resumed += 1;
                } else {
                    g.data_full += 1;
                }
            }
            if opts.require_reuse && !resumed {
                let _ = out.write_all(b"522 SSL connection failed: session reuse required\r\n");
                return None;
            }
            Some(Data(Conn::Tls(Box::new(tls))))
        }

        fn session(stream: TcpStream, fs: Arc<Mutex<Fs>>, opts: Options) {
            let mut out = Ctl(Arc::new(Mutex::new(Conn::Plain(stream))));
            let mut reader = BufReader::new(out.clone());
            let send = |out: &mut Ctl, s: &str| {
                let _ = out.write_all(s.as_bytes()).and_then(|_| out.flush());
            };
            send(&mut out, "220-Fake FTP server\r\n220 Ready\r\n");
            let session_tls = opts.tls.then(|| session_tls_config(opts.tls12_only));
            let mut tls_active = false;
            let mut prot_p = false;
            let mut cwd = "/home".to_string();
            let mut passive: Option<TcpListener> = None;
            let mut rest: u64 = 0;
            let mut rename_from: Option<String> = None;
            let mut user_ok = false;
            let mut line = String::new();
            loop {
                line.clear();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    return;
                }
                let raw = line.trim_end_matches(['\r', '\n']).to_string();
                let (verb, arg) = match raw.split_once(' ') {
                    Some((v, a)) => (v.to_ascii_uppercase(), a.to_string()),
                    None => (raw.to_ascii_uppercase(), String::new()),
                };
                let data_tls = if prot_p { session_tls.as_ref() } else { None };
                match verb.as_str() {
                    "AUTH" if opts.tls => {
                        let mech = arg.to_ascii_uppercase();
                        if (mech == "TLS" && opts.auth_ssl_only)
                            || !matches!(mech.as_str(), "TLS" | "SSL")
                        {
                            send(&mut out, "504 Unknown AUTH type.\r\n");
                            continue;
                        }
                        send(&mut out, "234 Proceed with negotiation.\r\n");
                        let cfg = session_tls.clone().expect("TLS config");
                        let mut g = out.0.lock().unwrap();
                        if let Conn::Plain(tcp) = std::mem::replace(&mut *g, Conn::Closed) {
                            let conn = ServerConnection::new(cfg).unwrap();
                            *g = Conn::Tls(Box::new(StreamOwned::new(conn, tcp)));
                        }
                        tls_active = true;
                    }
                    "PBSZ" if opts.tls => send(&mut out, "200 PBSZ=0\r\n"),
                    "PROT" if opts.tls => match arg.to_ascii_uppercase().as_str() {
                        "P" if opts.refuse_prot_p => {
                            send(&mut out, "536 PROT P not supported.\r\n")
                        }
                        "P" => {
                            prot_p = true;
                            send(&mut out, "200 Protection level set to Private.\r\n");
                        }
                        _ => {
                            prot_p = false;
                            send(&mut out, "200 Protection level set to Clear.\r\n");
                        }
                    },
                    "USER" => {
                        {
                            let mut g = fs.lock().unwrap();
                            if tls_active {
                                g.tls_users += 1;
                            } else {
                                g.plain_users += 1;
                            }
                        }
                        user_ok = arg == "alice";
                        send(&mut out, "331 Password required\r\n");
                    }
                    "PASS" => {
                        if user_ok && arg == "secret" {
                            send(&mut out, "230 Logged in\r\n");
                        } else {
                            send(&mut out, "530 Login incorrect.\r\n");
                        }
                    }
                    "FEAT" => {
                        if opts.mlst {
                            send(&mut out, "211-Features:\r\n MLST type*;size*;modify*;\r\n UTF8\r\n SIZE\r\n211 End\r\n");
                        } else {
                            send(&mut out, "211-Features:\r\n SIZE\r\n211 End\r\n");
                        }
                    }
                    "OPTS" | "TYPE" | "NOOP" => send(&mut out, "200 OK\r\n"),
                    "PWD" => send(
                        &mut out,
                        &format!("257 \"{cwd}\" is the current directory\r\n"),
                    ),
                    "CWD" => {
                        let p = resolve(&cwd, &arg);
                        if fs.lock().unwrap().dirs.contains(&p) {
                            cwd = p;
                            send(&mut out, "250 OK\r\n");
                        } else {
                            send(&mut out, "550 Failed to change directory.\r\n");
                        }
                    }
                    "EPSV" if opts.epsv => {
                        let l = TcpListener::bind("127.0.0.1:0").unwrap();
                        let port = l.local_addr().unwrap().port();
                        passive = Some(l);
                        send(
                            &mut out,
                            &format!("229 Entering Extended Passive Mode (|||{port}|)\r\n"),
                        );
                    }
                    "PASV" => {
                        let l = TcpListener::bind("127.0.0.1:0").unwrap();
                        let port = l.local_addr().unwrap().port();
                        passive = Some(l);
                        // A bogus address: the client must use the control peer.
                        send(
                            &mut out,
                            &format!(
                                "227 Entering Passive Mode (10,255,255,1,{},{})\r\n",
                                port / 256,
                                port % 256
                            ),
                        );
                    }
                    "REST" => {
                        rest = arg.parse().unwrap_or(0);
                        send(&mut out, "350 Restarting\r\n");
                    }
                    "SIZE" => {
                        let p = resolve(&cwd, &arg);
                        match fs.lock().unwrap().files.get(&p) {
                            Some(d) => send(&mut out, &format!("213 {}\r\n", d.len())),
                            None => send(&mut out, "550 Could not get file size.\r\n"),
                        }
                    }
                    "MDTM" => send(&mut out, "213 20240102030405\r\n"),
                    "MLST" if opts.mlst => {
                        let p = resolve(&cwd, &arg);
                        let g = fs.lock().unwrap();
                        if let Some(d) = g.files.get(&p) {
                            send(&mut out, &format!("250-Listing\r\n type=file;size={};modify=20240102030405; {p}\r\n250 End\r\n", d.len()));
                        } else if g.dirs.contains(&p) {
                            send(&mut out, &format!("250-Listing\r\n type=dir;modify=20240102030405; {p}\r\n250 End\r\n"));
                        } else {
                            send(&mut out, "550 No such file or directory\r\n");
                        }
                    }
                    "MLSD" if opts.mlst => {
                        let p = resolve(&cwd, &arg);
                        let listing = {
                            let g = fs.lock().unwrap();
                            if !g.dirs.contains(&p) {
                                None
                            } else {
                                let mut s = format!("type=cdir; {p}\r\n");
                                for (name, is_dir, size) in children(&g, &p) {
                                    if is_dir {
                                        s.push_str(&format!(
                                            "type=dir;modify=20240102030405; {name}\r\n"
                                        ));
                                    } else {
                                        s.push_str(&format!("type=file;size={size};modify=20240102030405; {name}\r\n"));
                                    }
                                }
                                Some(s)
                            }
                        };
                        match listing {
                            None => send(&mut out, "550 No such file or directory\r\n"),
                            Some(s) => {
                                send(&mut out, "150 Here comes the listing\r\n");
                                let Some(mut data) =
                                    open_data(&mut passive, &mut out, data_tls, opts, &fs)
                                else {
                                    continue;
                                };
                                let _ = data.write_all(s.as_bytes());
                                drop(data);
                                send(&mut out, "226 Transfer complete\r\n");
                            }
                        }
                    }
                    "LIST" => {
                        let s = {
                            let g = fs.lock().unwrap();
                            let mut s = String::from("total 0\r\n");
                            for (name, is_dir, size) in children(&g, &cwd) {
                                let perms = if is_dir { "drwxr-xr-x" } else { "-rw-r--r--" };
                                s.push_str(&format!("{perms}    1 ftp      ftp      {size:>8} Jan 02  2024 {name}\r\n"));
                            }
                            s
                        };
                        send(&mut out, "150 Here comes the listing\r\n");
                        let Some(mut data) = open_data(&mut passive, &mut out, data_tls, opts, &fs)
                        else {
                            continue;
                        };
                        let _ = data.write_all(s.as_bytes());
                        drop(data);
                        send(&mut out, "226 Transfer complete\r\n");
                    }
                    "RETR" => {
                        let p = resolve(&cwd, &arg);
                        let content = {
                            let mut g = fs.lock().unwrap();
                            g.retr_count += 1;
                            g.files.get(&p).cloned()
                        };
                        match content {
                            None => send(&mut out, "550 Failed to open file.\r\n"),
                            Some(d) => {
                                send(&mut out, "150 Opening BINARY mode data connection\r\n");
                                let Some(mut data) =
                                    open_data(&mut passive, &mut out, data_tls, opts, &fs)
                                else {
                                    continue;
                                };
                                let start = (rest as usize).min(d.len());
                                rest = 0;
                                let ok = data.write_all(&d[start..]).is_ok();
                                drop(data);
                                if ok {
                                    send(&mut out, "226 Transfer complete\r\n");
                                } else {
                                    send(&mut out, "426 Failure writing network stream.\r\n");
                                }
                            }
                        }
                    }
                    "APPE" if fs.lock().unwrap().refuse_appe => {
                        send(&mut out, "502 Command not implemented.\r\n");
                    }
                    "STOR" | "APPE"
                        if {
                            let g = fs.lock().unwrap();
                            g.refuse_append_existing
                                && (verb == "APPE" || rest > 0)
                                && g.files.contains_key(&resolve(&cwd, &arg))
                        } =>
                    {
                        rest = 0;
                        let p = resolve(&cwd, &arg);
                        send(
                            &mut out,
                            &format!("451 {p}: Append/Restart not permitted, try again\r\n"),
                        );
                    }
                    "STOR" | "APPE" => {
                        let p = resolve(&cwd, &arg);
                        let parent_ok = {
                            let parent = match p.rfind('/') {
                                Some(0) => "/".to_string(),
                                Some(i) => p[..i].to_string(),
                                None => "/".to_string(),
                            };
                            fs.lock().unwrap().dirs.contains(&parent)
                        };
                        if !parent_ok {
                            send(&mut out, "553 Could not create file.\r\n");
                            continue;
                        }
                        send(&mut out, "150 Ok to send data\r\n");
                        let Some(mut data) = open_data(&mut passive, &mut out, data_tls, opts, &fs)
                        else {
                            continue;
                        };
                        let mut buf = Vec::new();
                        let _ = data.read_to_end(&mut buf);
                        let mut g = fs.lock().unwrap();
                        let start = std::mem::take(&mut rest) as usize;
                        if verb == "APPE" {
                            g.files.entry(p).or_default().extend_from_slice(&buf);
                        } else if start > 0 {
                            // REST + STOR: keep the first `start` bytes.
                            let f = g.files.entry(p).or_default();
                            f.truncate(start);
                            f.extend_from_slice(&buf);
                        } else {
                            g.files.insert(p, buf);
                        }
                        send(&mut out, "226 Transfer complete\r\n");
                    }
                    "DELE" => {
                        let p = resolve(&cwd, &arg);
                        if fs.lock().unwrap().files.remove(&p).is_some() {
                            send(&mut out, "250 Delete operation successful.\r\n");
                        } else {
                            send(&mut out, "550 Delete operation failed.\r\n");
                        }
                    }
                    "MKD" => {
                        let p = resolve(&cwd, &arg);
                        let mut g = fs.lock().unwrap();
                        let parent = match p.rfind('/') {
                            Some(0) => "/".to_string(),
                            Some(i) => p[..i].to_string(),
                            None => "/".to_string(),
                        };
                        if g.dirs.contains(&parent) && !g.dirs.contains(&p) {
                            g.dirs.insert(p.clone());
                            send(&mut out, &format!("257 \"{p}\" created\r\n"));
                        } else {
                            send(&mut out, "550 Create directory operation failed.\r\n");
                        }
                    }
                    "RMD" => {
                        let p = resolve(&cwd, &arg);
                        let mut g = fs.lock().unwrap();
                        if g.dirs.contains(&p) && children(&g, &p).is_empty() {
                            g.dirs.remove(&p);
                            send(&mut out, "250 Remove directory operation successful.\r\n");
                        } else {
                            send(&mut out, "550 Remove directory operation failed.\r\n");
                        }
                    }
                    "RNFR" => {
                        let p = resolve(&cwd, &arg);
                        let g = fs.lock().unwrap();
                        if g.files.contains_key(&p) || g.dirs.contains(&p) {
                            rename_from = Some(p);
                            send(&mut out, "350 Ready for RNTO.\r\n");
                        } else {
                            send(&mut out, "550 RNFR command failed.\r\n");
                        }
                    }
                    "RNTO" => {
                        let to = resolve(&cwd, &arg);
                        match rename_from.take() {
                            Some(from) => {
                                let mut g = fs.lock().unwrap();
                                if let Some(d) = g.files.remove(&from) {
                                    g.files.insert(to, d);
                                } else {
                                    g.dirs.remove(&from);
                                    g.dirs.insert(to);
                                }
                                send(&mut out, "250 Rename successful.\r\n");
                            }
                            None => send(&mut out, "503 RNFR required first.\r\n"),
                        }
                    }
                    "SITE" => send(&mut out, "200 SITE CHMOD command ok.\r\n"),
                    "QUIT" => {
                        send(&mut out, "221 Goodbye.\r\n");
                        return;
                    }
                    _ => send(&mut out, "502 Command not implemented.\r\n"),
                }
            }
        }
    }

    fn driver_for(port: u16, password: &str) -> FtpDriver {
        FtpDriver::new(FtpConfig {
            host: "127.0.0.1".into(),
            port,
            username: "alice".into(),
            password: Some(password.into()),
            tls: false,
            tls_fingerprint: None,
        })
    }

    fn ftps_driver(port: u16, fingerprint: Option<&str>) -> FtpDriver {
        FtpDriver::new(FtpConfig {
            host: "127.0.0.1".into(),
            port,
            username: "alice".into(),
            password: Some("secret".into()),
            tls: true,
            tls_fingerprint: fingerprint.map(str::to_string),
        })
    }

    /// The driver a test server expects: FTPS trusting the (self-signed)
    /// test certificate by its pinned fingerprint when the server offers TLS.
    fn driver_with(server: &fake::Server, opts: fake::Options) -> FtpDriver {
        if opts.tls {
            ftps_driver(server.port, Some(fake::TEST_CERT_FINGERPRINT))
        } else {
            driver_for(server.port, "secret")
        }
    }

    /// FTPS with MLSD/EPSV over TLS 1.3, and a server that, like vsftpd,
    /// refuses data connections that do not resume the control session.
    fn ftps_options() -> fake::Options {
        fake::Options {
            mlst: true,
            epsv: true,
            tls: true,
            require_reuse: true,
            ..Default::default()
        }
    }

    #[test]
    fn certificate_fingerprints_are_formatted_and_parsed() {
        let fp = certificate_fingerprint(&fake::test_cert_der());
        assert_eq!(fp, fake::TEST_CERT_FINGERPRINT);
        let bytes = parse_certificate_fingerprint(&fp).unwrap();
        assert_eq!(bytes[0], 0xFC);
        assert_eq!(bytes[31], 0xA9);
        // The forms users paste: bare lower-case hex, OpenSSL output, SHA256: prefix, spaces.
        let bare = fp.replace(':', "").to_lowercase();
        assert_eq!(parse_certificate_fingerprint(&bare), Some(bytes));
        assert_eq!(
            parse_certificate_fingerprint(&format!("SHA256 Fingerprint={fp}")),
            Some(bytes)
        );
        assert_eq!(
            parse_certificate_fingerprint(&format!("sha256:{bare}")),
            Some(bytes)
        );
        assert_eq!(
            parse_certificate_fingerprint(&format!("  {}  ", fp.replace(':', " "))),
            Some(bytes)
        );
        // Wrong length, SHA-1 sized, or not hex.
        assert_eq!(parse_certificate_fingerprint(""), None);
        assert_eq!(parse_certificate_fingerprint(&bare[..40]), None);
        assert_eq!(parse_certificate_fingerprint(&format!("{bare}00")), None);
        assert_eq!(parse_certificate_fingerprint(&"zz".repeat(32)), None);
    }

    #[test]
    fn auth_replies_are_classified() {
        assert_eq!(classify_auth_reply(234), AuthReply::Accepted);
        for code in [500, 501, 502, 504] {
            assert_eq!(classify_auth_reply(code), AuthReply::Unsupported, "{code}");
        }
        // 334 asks for ADAT (security data exchange), which TLS never uses.
        for code in [334, 421, 431, 530, 534] {
            assert_eq!(classify_auth_reply(code), AuthReply::Refused, "{code}");
        }
        // AUTH replies arrive like any other reply.
        let r = reply("234 Proceed with negotiation.\r\n").unwrap();
        assert_eq!(classify_auth_reply(r.code), AuthReply::Accepted);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn wrong_password_fails_to_connect() {
        let server = fake::start(fake::Options {
            mlst: true,
            epsv: true,
            ..Default::default()
        });
        let err = driver_for(server.port, "wrong")
            .connect()
            .await
            .unwrap_err();
        assert!(matches!(err, CoreError::AuthFailed(_)), "{err:?}");
    }

    async fn exercise_driver(opts: fake::Options) {
        let server = fake::start(opts);
        let d = driver_with(&server, opts);
        d.connect().await.unwrap();
        assert_eq!(d.get_default_path().await.unwrap(), "/home");

        // Directories with missing parents.
        d.create_dir("/home/a/b c").await.unwrap();
        d.create_dir("/home/a/b c").await.unwrap(); // already exists: fine
        assert!(server.fs.lock().unwrap().dirs.contains("/home/a/b c"));

        // Upload, download, metadata, listing.
        let file = "/home/a/b c/hello world.txt";
        d.write_file(file, Bytes::from_static(b"hello world"))
            .await
            .unwrap();
        assert_eq!(server.fs.lock().unwrap().files[file], b"hello world");
        assert_eq!(&d.read_file(file).await.unwrap()[..], b"hello world");
        let meta = d.metadata(file).await.unwrap();
        assert_eq!(meta.size, 11);
        assert!(meta.is_file());
        assert!(d.metadata("/home/a").await.unwrap().is_dir());
        let listing = d.list_dir("/home/a/b c").await.unwrap();
        assert_eq!(listing.len(), 1);
        assert_eq!(listing[0].name, "hello world.txt");
        assert_eq!(listing[0].path, file);
        assert_eq!(listing[0].size, 11);
        let root = d.list_dir("/home/a").await.unwrap();
        assert!(root[0].is_dir());
        assert_eq!(root[0].name, "b c");

        // Sequential ranged reads continue one download; a jump restarts it.
        let retr_before = server.fs.lock().unwrap().retr_count;
        assert_eq!(&d.read_range(file, 0, 4).await.unwrap()[..], b"hell");
        assert_eq!(&d.read_range(file, 4, 4).await.unwrap()[..], b"o wo");
        assert_eq!(&d.read_range(file, 8, 10).await.unwrap()[..], b"rld");
        assert_eq!(
            server.fs.lock().unwrap().retr_count - retr_before,
            1,
            "one RETR for three sequential reads"
        );
        assert_eq!(&d.read_range(file, 6, 5).await.unwrap()[..], b"world");
        assert_eq!(&d.read_range(file, 2, 3).await.unwrap()[..], b"llo");
        assert_eq!(server.fs.lock().unwrap().retr_count - retr_before, 3);
        assert!(d.read_range(file, 0, 0).await.unwrap().is_empty());

        // Missing paths are errors, not empty successes.
        assert!(!d.exists("/home/nope.txt").await.unwrap());
        assert!(d.read_file("/home/nope.txt").await.is_err());
        assert!(d.list_dir("/home/missing-dir").await.is_err());
        assert!(d.remove_file("/home/nope.txt").await.is_err());

        // Rename.
        let renamed = "/home/a/b c/renamed.txt";
        d.rename(file, renamed).await.unwrap();
        assert!(!d.exists(file).await.unwrap());
        assert!(d.exists(renamed).await.unwrap());

        // Positional writes.
        let chunked = "/home/a/chunked.bin";
        d.write_at(chunked, 0, Bytes::from_static(b"12345"))
            .await
            .unwrap();
        d.write_at(chunked, 5, Bytes::from_static(b"678"))
            .await
            .unwrap();
        assert!(d
            .write_at(chunked, 3, Bytes::from_static(b"x"))
            .await
            .is_err());
        assert_eq!(server.fs.lock().unwrap().files[chunked], b"12345678");
        // Not advertised: many servers refuse APPE to an existing file, so
        // the transfer queue must upload to FTP with a single STOR.
        assert!(!d.supports_write_at());
        // Offset 0 truncates an existing file.
        d.write_at(chunked, 0, Bytes::from_static(b"ab"))
            .await
            .unwrap();
        d.write_at(chunked, 2, Bytes::from_static(b"cdefgh"))
            .await
            .unwrap();
        assert_eq!(server.fs.lock().unwrap().files[chunked], b"abcdefgh");

        // Uploading into a missing directory reports the server's refusal.
        assert!(d
            .write_file("/home/missing/x.txt", Bytes::from_static(b"x"))
            .await
            .is_err());

        assert_eq!(d.calculate_size("/home/a").await.unwrap(), 11 + 8);
        let found = d.search("/home", "renamed", 10).await.unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].path, renamed);
        let content = d
            .find_files(&FindFileQuery {
                base_path: "/home".into(),
                mask: "*.txt".into(),
                contains_text: Some("WORLD".into()),
                case_sensitive: false,
                max_depth: None,
                max_results: 10,
            })
            .await
            .unwrap();
        assert_eq!(content.len(), 1);
        assert_eq!(content[0].matched_lines, vec!["Line 1: hello world"]);

        d.set_permissions(renamed, 0o640).await.unwrap();

        // Non-recursive removal of a non-empty directory fails; recursive works.
        assert!(d.remove_dir("/home/a", false).await.is_err());
        d.remove_dir("/home/a", true).await.unwrap();
        {
            let fs = server.fs.lock().unwrap();
            assert!(!fs.dirs.iter().any(|p| p.starts_with("/home/a")));
            assert!(!fs.files.keys().any(|p| p.starts_with("/home/a")));
        }
        assert!(!d.exists("/home/a").await.unwrap());

        let fs = server.fs.lock().unwrap();
        if opts.tls {
            assert_eq!(d.protocol(), Protocol::Ftps);
            assert_eq!(
                fs.plain_users, 0,
                "the user name must never travel in clear text"
            );
            assert!(fs.tls_users >= 1);
            assert!(
                fs.data_resumed > 10,
                "data connections resumed: {}",
                fs.data_resumed
            );
            assert_eq!(
                fs.data_full, 0,
                "every data connection resumes its control session"
            );
        } else {
            assert_eq!(d.protocol(), Protocol::Ftp);
            assert_eq!(fs.data_resumed + fs.data_full, 0);
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn end_to_end_with_mlsd_and_epsv() {
        exercise_driver(fake::Options {
            mlst: true,
            epsv: true,
            ..Default::default()
        })
        .await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn end_to_end_with_list_and_pasv_fallbacks() {
        exercise_driver(fake::Options {
            mlst: false,
            epsv: false,
            ..Default::default()
        })
        .await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ftps_end_to_end_tls13_with_pinned_certificate_and_session_reuse() {
        exercise_driver(ftps_options()).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ftps_end_to_end_tls12_with_list_and_pasv_fallbacks() {
        exercise_driver(fake::Options {
            mlst: false,
            epsv: false,
            tls12_only: true,
            ..ftps_options()
        })
        .await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ftps_untrusted_certificate_is_refused_before_the_user_name_is_sent() {
        let server = fake::start(ftps_options());
        let err = ftps_driver(server.port, None).connect().await.unwrap_err();
        let msg = err.to_string();
        assert!(matches!(err, CoreError::ConnectionFailed(_)), "{err:?}");
        assert!(msg.contains("not trusted"), "{msg}");
        assert!(
            msg.contains(fake::TEST_CERT_FINGERPRINT),
            "the error shows the fingerprint: {msg}"
        );

        // A different pinned certificate does not help either.
        let other = "00:".repeat(31) + "00";
        let err = ftps_driver(server.port, Some(&other))
            .connect()
            .await
            .unwrap_err();
        assert!(
            err.to_string().contains("not the certificate pinned"),
            "{err}"
        );

        let fs = server.fs.lock().unwrap();
        assert_eq!(fs.plain_users + fs.tls_users, 0, "no user name may be sent");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ftps_pinned_fingerprint_accepts_pasted_formats_and_rejects_garbage() {
        let server = fake::start(ftps_options());
        let bare = fake::TEST_CERT_FINGERPRINT.replace(':', "").to_lowercase();
        let d = ftps_driver(server.port, Some(&format!(" SHA256 Fingerprint={bare} ")));
        d.connect().await.unwrap();
        assert_eq!(d.list_dir("/").await.unwrap().len(), 1);

        let err = ftps_driver(server.port, Some("AB:CD"))
            .connect()
            .await
            .unwrap_err();
        assert!(
            err.to_string().contains("not a SHA-256 fingerprint"),
            "{err}"
        );
        // A blank fingerprint means "nothing pinned", not an error.
        let err = ftps_driver(server.port, Some("  "))
            .connect()
            .await
            .unwrap_err();
        assert!(err.to_string().contains("not trusted"), "{err}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ftps_falls_back_to_auth_ssl() {
        let opts = fake::Options {
            auth_ssl_only: true,
            ..ftps_options()
        };
        let server = fake::start(opts);
        let d = driver_with(&server, opts);
        d.connect().await.unwrap();
        d.write_file("/home/x.txt", Bytes::from_static(b"over tls"))
            .await
            .unwrap();
        assert_eq!(&d.read_file("/home/x.txt").await.unwrap()[..], b"over tls");
        let fs = server.fs.lock().unwrap();
        assert_eq!(fs.plain_users, 0);
        assert_eq!(fs.data_full, 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ftps_never_falls_back_to_plain_ftp() {
        let server = fake::start(fake::Options {
            mlst: true,
            epsv: true,
            ..Default::default()
        });
        let err = ftps_driver(server.port, None).connect().await.unwrap_err();
        assert!(matches!(err, CoreError::ConnectionFailed(_)), "{err:?}");
        assert!(err.to_string().contains("does not support FTPS"), "{err}");
        assert_eq!(
            server.fs.lock().unwrap().plain_users,
            0,
            "no user name may be sent"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ftps_requires_encrypted_data_connections() {
        let opts = fake::Options {
            refuse_prot_p: true,
            ..ftps_options()
        };
        let server = fake::start(opts);
        let err = driver_with(&server, opts).connect().await.unwrap_err();
        assert!(matches!(err, CoreError::ConnectionFailed(_)), "{err:?}");
        assert!(err.to_string().contains("PROT P"), "{err}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn positional_writes_fall_back_to_rest_stor_without_appe() {
        let server = fake::start(fake::Options {
            mlst: true,
            epsv: true,
            ..Default::default()
        });
        server.fs.lock().unwrap().refuse_appe = true;
        let d = driver_for(server.port, "secret");
        d.connect().await.unwrap();
        let path = "/home/resume.bin";
        d.write_at(path, 0, Bytes::from_static(b"abc"))
            .await
            .unwrap();
        d.write_at(path, 3, Bytes::from_static(b"def"))
            .await
            .unwrap();
        d.write_at(path, 6, Bytes::from_static(b"g")).await.unwrap();
        assert_eq!(server.fs.lock().unwrap().files[path], b"abcdefg");
        // Out-of-order writes are still refused.
        assert!(d.write_at(path, 2, Bytes::from_static(b"x")).await.is_err());
        assert_eq!(server.fs.lock().unwrap().files[path], b"abcdefg");
    }

    /// Multi-chunk uploads through the transfer queue must not depend on APPE
    /// (stock ProFTPD refuses it on existing files): the queue uploads to FTP
    /// with a single STOR, both for new files and for overwrites.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn transfer_queue_uploads_to_ftp_without_append() {
        use crate::local::LocalFsDriver;
        use crate::transfer_queue::TransferQueueManager;
        use crate::types::TransferStatus;
        use std::collections::HashMap;

        let server = fake::start(fake::Options {
            mlst: true,
            epsv: true,
            ..Default::default()
        });
        {
            let mut g = server.fs.lock().unwrap();
            g.refuse_append_existing = true;
            g.files
                .insert("/home/existing.bin".into(), vec![9u8; 16_000]);
        }
        let d = driver_for(server.port, "secret");
        d.connect().await.unwrap();
        // The driver really is refused an append on this server.
        assert!(d
            .write_at("/home/existing.bin", 16_000, Bytes::from_static(b"x"))
            .await
            .is_err());
        assert_eq!(
            server.fs.lock().unwrap().files["/home/existing.bin"].len(),
            16_000
        );

        let local = tempfile::tempdir().unwrap();
        let data: Vec<u8> = (0..300_000u32).map(|i| (i * 7 % 251) as u8).collect();
        std::fs::write(local.path().join("up.bin"), &data).unwrap();

        let mut map: HashMap<String, Arc<dyn VirtualFileSystem>> = HashMap::new();
        map.insert("l".into(), Arc::new(LocalFsDriver::with_root(local.path())));
        map.insert("f".into(), Arc::new(d));
        let sessions = Arc::new(tokio::sync::RwLock::new(map));
        let q = TransferQueueManager::with_chunk_size(1, 64 * 1024);
        for dest in ["/home/up.bin", "/home/existing.bin"] {
            let id = q
                .enqueue(
                    "l".into(),
                    "/up.bin".into(),
                    "f".into(),
                    dest.into(),
                    false,
                    sessions.clone(),
                )
                .await;
            let task = loop {
                let t = q.get_task(&id).await.unwrap();
                if !matches!(
                    t.status,
                    TransferStatus::Queued | TransferStatus::InProgress
                ) {
                    break t;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            };
            assert_eq!(
                task.status,
                TransferStatus::Completed,
                "{dest}: {:?}",
                task.error
            );
            assert_eq!(server.fs.lock().unwrap().files[dest], data, "{dest}");
        }
    }

    /// Names ending in whitespace are addressed exactly, never as the
    /// trimmed sibling.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn trailing_whitespace_names_are_not_trimmed() {
        let server = fake::start(fake::Options {
            mlst: true,
            epsv: true,
            ..Default::default()
        });
        {
            let mut g = server.fs.lock().unwrap();
            g.files.insert("/home/notes".into(), b"keep".to_vec());
            g.files.insert("/home/notes ".into(), b"spaced".to_vec());
        }
        let d = driver_for(server.port, "secret");
        d.connect().await.unwrap();
        let listing = d.list_dir("/home").await.unwrap();
        let spaced = listing.iter().find(|e| e.name == "notes ").expect("listed");
        assert_eq!(spaced.path, "/home/notes ");
        assert_eq!(d.metadata("/home/notes ").await.unwrap().size, 6);
        assert_eq!(&d.read_file("/home/notes ").await.unwrap()[..], b"spaced");
        d.write_file("/home/notes ", Bytes::from_static(b"new"))
            .await
            .unwrap();
        d.remove_file("/home/notes ").await.unwrap();
        let g = server.fs.lock().unwrap();
        assert!(!g.files.contains_key("/home/notes "));
        assert_eq!(g.files["/home/notes"], b"keep");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_operations_use_separate_connections() {
        concurrent_operations(fake::Options {
            mlst: true,
            epsv: true,
            ..Default::default()
        })
        .await;
    }

    /// Each pooled control connection has its own TLS session, which its data
    /// connections resume.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn ftps_concurrent_connections_resume_their_own_sessions() {
        concurrent_operations(ftps_options()).await;
        concurrent_operations(fake::Options {
            tls12_only: true,
            ..ftps_options()
        })
        .await;
    }

    async fn concurrent_operations(opts: fake::Options) {
        let server = fake::start(opts);
        let d = driver_with(&server, opts);
        d.connect().await.unwrap();
        let mut handles = Vec::new();
        for i in 0..8 {
            let d = d.clone();
            handles.push(tokio::spawn(async move {
                let path = format!("/home/f{i}.txt");
                let body = format!("content {i}");
                d.write_file(&path, Bytes::from(body.clone()))
                    .await
                    .unwrap();
                assert_eq!(d.read_file(&path).await.unwrap(), Bytes::from(body));
            }));
        }
        for h in handles {
            h.await.unwrap();
        }
        let fs = server.fs.lock().unwrap();
        assert_eq!(fs.files.len(), 8);
        assert!(lock(&d.pool).len() <= MAX_CONNECTIONS);
        assert_eq!(fs.data_full, 0);
    }
}

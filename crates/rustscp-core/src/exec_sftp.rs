//! SFTP v3 over an exec channel ("compatibility mode").
//!
//! Some servers refuse or break the `sftp` subsystem request (for example
//! `Subsystem sftp sftp-server` without an absolute path in sshd_config) while
//! the sftp-server program itself works. libssh2 can only start SFTP through
//! the subsystem request, so this module starts sftp-server as a command and
//! speaks SFTP v3 to it directly. It is only used after native SFTP failed to
//! start; servers whose subsystem works never reach this code.
//!
//! Everything a server sends is untrusted: parsing goes through a checked
//! cursor, packet sizes are capped and nothing is allocated from a size the
//! server reports. Replies are matched to requests by id, so concurrent
//! operations share the channel the way libssh2 shares its SFTP channel.
#![deny(
    clippy::indexing_slicing,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic
)]

use ssh2::{Channel, ErrorCode, ExtendedData, FileStat, OpenFlags, OpenType, Session};
use std::collections::{HashMap, VecDeque};
use std::io::{self, ErrorKind, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// Candidate sftp-server locations, most common first (Debian/Ubuntu, RHEL,
/// Arch/Alpine, openSUSE, macOS/BSD, other distributions, Gentoo, AIX, HP-UX).
const SERVER_PATHS: &str = "/usr/lib/openssh/sftp-server /usr/libexec/openssh/sftp-server \
/usr/lib/ssh/sftp-server /usr/libexec/ssh/sftp-server /usr/libexec/sftp-server /usr/lib/sftp-server \
/usr/local/libexec/sftp-server /usr/lib64/misc/sftp-server /usr/lib/misc/sftp-server \
/usr/sbin/sftp-server /opt/ssh/libexec/sftp-server";

/// The command run on the server. A constant: nothing from the user or the
/// server is ever interpolated. `exec /bin/sh -c '…'` works from any login
/// shell (sh, bash, zsh, csh/tcsh, fish) and is refused by restricted shells.
/// The marker line names the program that answers, before its SFTP output.
pub(crate) const EXEC_COMMAND: &str = "exec /bin/sh -c 'for p in /usr/lib/openssh/sftp-server \
/usr/libexec/openssh/sftp-server /usr/lib/ssh/sftp-server /usr/libexec/ssh/sftp-server \
/usr/libexec/sftp-server /usr/lib/sftp-server /usr/local/libexec/sftp-server \
/usr/lib64/misc/sftp-server /usr/lib/misc/sftp-server /usr/sbin/sftp-server \
/opt/ssh/libexec/sftp-server; do [ -f \"$p\" ] && [ -x \"$p\" ] && \
{ printf \"RUSTSCP-SFTP %s\\n\" \"$p\"; exec \"$p\"; }; done; exit 127'";

const MARKER: &[u8] = b"RUSTSCP-SFTP ";
/// Login-script output tolerated before the marker or the SFTP version reply.
const MAX_PREAMBLE: usize = 8 * 1024;
const MAX_SERVER_PATH: usize = 1024;

/// Largest packet accepted from the server (libssh2 uses the same limit).
const MAX_PACKET: usize = 256 * 1024;
/// Largest packet sent (OpenSSH sftp-server drops the connection above 256 KiB).
const MAX_OUT_PACKET: usize = 256 * 1024 - 1024;
/// Largest file handle accepted (OpenSSH uses 4 bytes; the spec allows 256).
const MAX_HANDLE: usize = 4096;

pub(crate) const READ_CHUNK: u32 = 32 * 1024;
/// Read requests in flight per file: 8 MiB, the same as libssh2's read-ahead.
const MAX_READS_IN_FLIGHT: usize = 256;
const WRITE_CHUNK: usize = 32 * 1024;
const MAX_WRITES_IN_FLIGHT: usize = 64;

/// Receive window of the exec channel. It must stay above the bytes a file
/// keeps in flight, or read-ahead stalls on window adjustments.
const CHANNEL_WINDOW: u32 = 16 * 1024 * 1024;
const CHANNEL_PACKET: u32 = 32 * 1024;
/// Reply bytes requested but not yet read, across all operations. Kept well
/// under the channel window: when replies nobody reads fill the window, the
/// server stops reading requests and a blocked write would never finish.
const REPLY_BUDGET: usize = CHANNEL_WINDOW as usize / 4 * 3;
/// Reply size reserved for a request (READ reserves its length).
const SMALL_REPLY: usize = 1024;
const LISTING_REPLY: usize = 64 * 1024;
/// A reply that makes no progress for this long fails the request.
const REPLY_TIMEOUT: Duration = Duration::from_secs(10);
/// libssh2 measures its own timeout in whole seconds, so a timed-out read may
/// report up to this much early.
const TIMEOUT_ROUNDING: Duration = Duration::from_millis(1500);
const START_TIMEOUT: Duration = Duration::from_secs(10);
const READ_SLICE: usize = 64 * 1024;

const FXP_INIT: u8 = 1;
const FXP_VERSION: u8 = 2;
const FXP_OPEN: u8 = 3;
const FXP_CLOSE: u8 = 4;
const FXP_READ: u8 = 5;
const FXP_WRITE: u8 = 6;
const FXP_LSTAT: u8 = 7;
const FXP_FSTAT: u8 = 8;
const FXP_SETSTAT: u8 = 9;
const FXP_OPENDIR: u8 = 11;
const FXP_READDIR: u8 = 12;
const FXP_REMOVE: u8 = 13;
const FXP_MKDIR: u8 = 14;
const FXP_RMDIR: u8 = 15;
const FXP_REALPATH: u8 = 16;
const FXP_STAT: u8 = 17;
const FXP_RENAME: u8 = 18;
const FXP_STATUS: u8 = 101;
const FXP_HANDLE: u8 = 102;
const FXP_DATA: u8 = 103;
const FXP_NAME: u8 = 104;
const FXP_ATTRS: u8 = 105;

const FX_OK: u32 = 0;
const FX_EOF: u32 = 1;

const ATTR_SIZE: u32 = 0x1;
const ATTR_UIDGID: u32 = 0x2;
const ATTR_PERMISSIONS: u32 = 0x4;
const ATTR_ACMODTIME: u32 = 0x8;
const ATTR_EXTENDED: u32 = 0x8000_0000;

// libssh2 session error codes, so the driver's error handling is unchanged.
const ERR_TIMEOUT: i32 = -9;
const ERR_FILE: i32 = -16;
const ERR_SFTP_PROTOCOL: i32 = -31;
const ERR_INVAL: i32 = -34;
const ERR_SOCKET_RECV: i32 = -43;

fn protocol_error(msg: &'static str) -> ssh2::Error {
    ssh2::Error::new(ErrorCode::Session(ERR_SFTP_PROTOCOL), msg)
}

/// The channel to sftp-server is gone or unusable: reported like a lost
/// connection, so the driver opens a new one instead of reporting "not found".
fn lost_error(msg: &'static str) -> ssh2::Error {
    ssh2::Error::new(ErrorCode::Session(ERR_SOCKET_RECV), msg)
}

/// A STATUS reply from the server, with libssh2's message for the code.
fn status_error(code: u32) -> ssh2::Error {
    ssh2::Error::from_errno(ErrorCode::SFTP(i32::try_from(code).unwrap_or(i32::MAX)))
}

/// Byte stream to the sftp-server process (an SSH channel; pipes in tests).
pub(crate) trait Transport: Send {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize>;
    fn write_all(&mut self, buf: &[u8]) -> io::Result<()>;
    /// libssh2-style error for a failed read or write.
    fn classify(&self, e: &io::Error) -> ssh2::Error;
    /// Exit status after the stream ended, when known.
    fn exit_status(&mut self) -> Option<i32> {
        None
    }
    /// Separate halves, so one thread can wait for replies while others
    /// send requests.
    fn split(self: Box<Self>) -> (Box<dyn ReadHalf>, Box<dyn WriteHalf>);
}

pub(crate) trait ReadHalf: Send {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize>;
    fn classify(&self, e: &io::Error) -> ssh2::Error;
}

pub(crate) trait WriteHalf: Send {
    fn write_all(&mut self, buf: &[u8]) -> io::Result<()>;
    fn classify(&self, e: &io::Error) -> ssh2::Error;
}

fn classify_ssh(sess: &Session, e: &io::Error) -> ssh2::Error {
    if e.kind() == ErrorKind::TimedOut {
        return ssh2::Error::new(
            ErrorCode::Session(ERR_TIMEOUT),
            "timed out waiting for the SFTP server",
        );
    }
    match ssh2::Error::last_session_error(sess) {
        Some(le) if matches!(le.code(), ErrorCode::Session(c) if crate::sftp::is_connection_lost_code(c)) => {
            le
        }
        _ => ssh2::Error::new(
            ErrorCode::Session(ERR_SOCKET_RECV),
            "connection to the SFTP server lost",
        ),
    }
}

/// The exec channel. Never call `Channel::flush`: in libssh2 it discards
/// received data instead of sending anything.
struct ChannelTransport {
    chan: Channel,
    sess: Session,
}

impl Transport for ChannelTransport {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.chan.read(buf)
    }

    fn write_all(&mut self, buf: &[u8]) -> io::Result<()> {
        Write::write_all(&mut self.chan, buf)
    }

    fn classify(&self, e: &io::Error) -> ssh2::Error {
        classify_ssh(&self.sess, e)
    }

    fn exit_status(&mut self) -> Option<i32> {
        let _ = self.chan.wait_close();
        self.chan.exit_status().ok()
    }

    fn split(self: Box<Self>) -> (Box<dyn ReadHalf>, Box<dyn WriteHalf>) {
        let reader = ChannelReader {
            stream: self.chan.stream(0),
            sess: self.sess.clone(),
        };
        let writer = ChannelWriter {
            chan: self.chan,
            sess: self.sess,
        };
        (Box::new(reader), Box::new(writer))
    }
}

struct ChannelReader {
    stream: ssh2::Stream,
    sess: Session,
}

impl ReadHalf for ChannelReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.stream.read(buf)
    }

    fn classify(&self, e: &io::Error) -> ssh2::Error {
        classify_ssh(&self.sess, e)
    }
}

struct ChannelWriter {
    chan: Channel,
    sess: Session,
}

impl WriteHalf for ChannelWriter {
    fn write_all(&mut self, buf: &[u8]) -> io::Result<()> {
        Write::write_all(&mut self.chan, buf)
    }

    fn classify(&self, e: &io::Error) -> ssh2::Error {
        classify_ssh(&self.sess, e)
    }
}

impl Drop for ChannelWriter {
    fn drop(&mut self) {
        // sftp-server exits on end of input.
        let _ = self.chan.send_eof();
        let _ = self.chan.close();
    }
}

/// Why compatibility mode could not start.
#[derive(Debug)]
pub(crate) enum StartError {
    /// The channel could not be opened or used: the connection may be gone.
    Channel(ssh2::Error),
    /// The command ran, but no SFTP server answered; the text says why.
    Unavailable(String),
}

// ---------------------------------------------------------------------------
// wire format
// ---------------------------------------------------------------------------

/// Bounds-checked reader over an untrusted packet.
struct Cursor<'a> {
    buf: &'a [u8],
}

impl<'a> Cursor<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Self { buf }
    }

    fn remaining(&self) -> usize {
        self.buf.len()
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], ssh2::Error> {
        let head = self
            .buf
            .get(..n)
            .ok_or_else(|| protocol_error("truncated SFTP packet"))?;
        self.buf = self.buf.get(n..).unwrap_or_default();
        Ok(head)
    }

    fn u8(&mut self) -> Result<u8, ssh2::Error> {
        let b = self.take(1)?;
        b.first()
            .copied()
            .ok_or_else(|| protocol_error("truncated SFTP packet"))
    }

    fn u32(&mut self) -> Result<u32, ssh2::Error> {
        let b = self.take(4)?;
        let arr: [u8; 4] = b
            .try_into()
            .map_err(|_| protocol_error("truncated SFTP packet"))?;
        Ok(u32::from_be_bytes(arr))
    }

    fn u64(&mut self) -> Result<u64, ssh2::Error> {
        let b = self.take(8)?;
        let arr: [u8; 8] = b
            .try_into()
            .map_err(|_| protocol_error("truncated SFTP packet"))?;
        Ok(u64::from_be_bytes(arr))
    }

    fn string(&mut self) -> Result<&'a [u8], ssh2::Error> {
        let len = self.u32()? as usize;
        if len > self.remaining() {
            return Err(protocol_error("SFTP string longer than its packet"));
        }
        self.take(len)
    }

    fn attrs(&mut self) -> Result<FileStat, ssh2::Error> {
        let flags = self.u32()?;
        let size = if flags & ATTR_SIZE != 0 {
            Some(self.u64()?)
        } else {
            None
        };
        let (uid, gid) = if flags & ATTR_UIDGID != 0 {
            (Some(self.u32()?), Some(self.u32()?))
        } else {
            (None, None)
        };
        let perm = if flags & ATTR_PERMISSIONS != 0 {
            Some(self.u32()?)
        } else {
            None
        };
        let (atime, mtime) = if flags & ATTR_ACMODTIME != 0 {
            (Some(u64::from(self.u32()?)), Some(u64::from(self.u32()?)))
        } else {
            (None, None)
        };
        if flags & ATTR_EXTENDED != 0 {
            let count = self.u32()? as usize;
            // Each pair holds at least two length fields.
            if count > self.remaining() / 8 {
                return Err(protocol_error("too many SFTP extended attributes"));
            }
            for _ in 0..count {
                self.string()?;
                self.string()?;
            }
        }
        Ok(FileStat {
            size,
            uid,
            gid,
            perm,
            atime,
            mtime,
        })
    }
}

fn put_u32(b: &mut Vec<u8>, v: u32) {
    b.extend_from_slice(&v.to_be_bytes());
}

fn put_u64(b: &mut Vec<u8>, v: u64) {
    b.extend_from_slice(&v.to_be_bytes());
}

fn put_str(b: &mut Vec<u8>, s: &[u8]) {
    put_u32(b, s.len() as u32);
    b.extend_from_slice(s);
}

/// Attributes as libssh2 sends them (an absent uid/gid or time is sent as 0
/// when its partner is set).
fn put_attrs(b: &mut Vec<u8>, st: &FileStat) {
    let mut flags = 0;
    if st.size.is_some() {
        flags |= ATTR_SIZE;
    }
    if st.uid.is_some() || st.gid.is_some() {
        flags |= ATTR_UIDGID;
    }
    if st.perm.is_some() {
        flags |= ATTR_PERMISSIONS;
    }
    if st.atime.is_some() || st.mtime.is_some() {
        flags |= ATTR_ACMODTIME;
    }
    put_u32(b, flags);
    if let Some(size) = st.size {
        put_u64(b, size);
    }
    if flags & ATTR_UIDGID != 0 {
        put_u32(b, st.uid.unwrap_or(0));
        put_u32(b, st.gid.unwrap_or(0));
    }
    if let Some(perm) = st.perm {
        put_u32(b, perm);
    }
    if flags & ATTR_ACMODTIME != 0 {
        put_u32(b, st.atime.unwrap_or(0) as u32);
        put_u32(b, st.mtime.unwrap_or(0) as u32);
    }
}

/// Path bytes as libssh2 sends them (Windows separators become `/`).
fn path_bytes(p: &Path) -> Result<Vec<u8>, ssh2::Error> {
    #[cfg(unix)]
    let bytes = {
        use std::os::unix::ffi::OsStrExt;
        p.as_os_str().as_bytes().to_vec()
    };
    #[cfg(not(unix))]
    let bytes = p
        .to_str()
        .ok_or_else(|| {
            ssh2::Error::new(
                ErrorCode::Session(ERR_INVAL),
                "only unicode paths on windows may be used",
            )
        })?
        .replace('\\', "/")
        .into_bytes();
    if bytes.contains(&0) {
        return Err(ssh2::Error::new(
            ErrorCode::Session(ERR_INVAL),
            "path provided contains a 0 byte",
        ));
    }
    Ok(bytes)
}

fn path_from_bytes(b: &[u8]) -> PathBuf {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        PathBuf::from(std::ffi::OsStr::from_bytes(b))
    }
    #[cfg(not(unix))]
    {
        PathBuf::from(String::from_utf8_lossy(b).into_owned())
    }
}

/// A reply, without its request id.
struct Reply {
    kind: u8,
    body: Vec<u8>,
}

impl Reply {
    fn status(&self) -> Result<u32, ssh2::Error> {
        if self.kind != FXP_STATUS {
            return Err(protocol_error("unexpected SFTP reply"));
        }
        Cursor::new(&self.body).u32()
    }

    /// Ok for STATUS OK, the server's error for any other status.
    fn expect_ok(&self) -> Result<(), ssh2::Error> {
        match self.status()? {
            FX_OK => Ok(()),
            code => Err(status_error(code)),
        }
    }

    /// The server's error for a STATUS reply where something else was expected.
    fn error_or(&self, unexpected: &'static str) -> ssh2::Error {
        match self.status() {
            Ok(FX_OK) | Err(_) => protocol_error(unexpected),
            Ok(code) => status_error(code),
        }
    }

    fn expect_handle(&self) -> Result<Vec<u8>, ssh2::Error> {
        if self.kind != FXP_HANDLE {
            return Err(self.error_or("unexpected reply to an SFTP open"));
        }
        let handle = Cursor::new(&self.body).string()?;
        if handle.is_empty() || handle.len() > MAX_HANDLE {
            return Err(protocol_error("invalid SFTP handle"));
        }
        Ok(handle.to_vec())
    }

    fn expect_attrs(&self) -> Result<FileStat, ssh2::Error> {
        if self.kind != FXP_ATTRS {
            return Err(self.error_or("unexpected reply to an SFTP stat"));
        }
        Cursor::new(&self.body).attrs()
    }

    fn expect_names(&self) -> Result<Vec<(PathBuf, FileStat)>, ssh2::Error> {
        if self.kind != FXP_NAME {
            return Err(self.error_or("unexpected reply to an SFTP name request"));
        }
        let mut c = Cursor::new(&self.body);
        let count = c.u32()? as usize;
        // Each entry holds two strings and an attribute flags field.
        if count > c.remaining() / 12 {
            return Err(protocol_error("too many SFTP names for the packet"));
        }
        let mut out = Vec::with_capacity(count.min(128));
        for _ in 0..count {
            let name = c.string()?;
            c.string()?; // long name (ls -l style), unused
            let attrs = c.attrs()?;
            out.push((path_from_bytes(name), attrs));
        }
        Ok(out)
    }
}

// ---------------------------------------------------------------------------
// shared channel
// ---------------------------------------------------------------------------

/// A request in flight; `Waiting` and `Discard` hold the reply bytes reserved.
enum Slot {
    Waiting(usize),
    Done(Reply),
    /// The requester gave up (seek, error, drop): drop the reply on arrival.
    Discard(usize),
}

/// Request bookkeeping, plus the write half: a request is written and
/// registered under one lock, so a reply can never arrive for a request the
/// table does not know yet.
struct State {
    writer: Box<dyn WriteHalf>,
    next_id: u32,
    slots: HashMap<u32, Slot>,
    /// Reply bytes reserved by requests whose replies have not been read.
    in_flight: usize,
    /// One thread at a time reads replies (for everybody); the others wait
    /// on `Inner::turn` without holding the channel.
    reader_active: bool,
    /// Set once the stream can no longer be trusted; every later call fails.
    broken: bool,
}

impl State {
    fn check(&self) -> Result<(), ssh2::Error> {
        if self.broken {
            return Err(lost_error(
                "the SFTP connection (compatibility mode) is broken",
            ));
        }
        Ok(())
    }

    /// Mark the stream unusable; `e` is returned to the caller that hit it.
    fn fail(&mut self, e: ssh2::Error) -> ssh2::Error {
        self.broken = true;
        e
    }

    fn route(&mut self, kind: u8, id: u32, body: Vec<u8>) -> Result<(), ssh2::Error> {
        match self.slots.remove(&id) {
            Some(Slot::Waiting(reserved)) => {
                self.in_flight = self.in_flight.saturating_sub(reserved);
                self.slots.insert(id, Slot::Done(Reply { kind, body }));
                Ok(())
            }
            Some(Slot::Discard(reserved)) => {
                self.in_flight = self.in_flight.saturating_sub(reserved);
                Ok(())
            }
            Some(done @ Slot::Done(_)) => {
                self.slots.insert(id, done);
                let e = protocol_error("duplicate SFTP reply");
                Err(self.fail(e))
            }
            None => {
                let e = protocol_error("SFTP reply to an unknown request");
                Err(self.fail(e))
            }
        }
    }
}

/// The read half with its receive buffer; used only by the thread that holds
/// the reader role.
struct Reader {
    half: Box<dyn ReadHalf>,
    /// Received bytes; `rbuf[rpos..]` is not parsed yet. Parsed bytes are
    /// dropped once everything is consumed or they pile up.
    rbuf: Vec<u8>,
    rpos: usize,
    scratch: Vec<u8>,
}

impl Reader {
    /// The next complete reply (type, request id, body) in `rbuf`, if one
    /// has arrived.
    fn parse_packet(&mut self) -> Result<Option<(u8, u32, Vec<u8>)>, ssh2::Error> {
        let unread = self.rbuf.get(self.rpos..).unwrap_or_default();
        let Some(len_bytes) = unread.get(..4) else {
            return Ok(None);
        };
        let len = Cursor::new(len_bytes).u32()? as usize;
        // A reply holds at least its type and request id.
        if !(5..=MAX_PACKET).contains(&len) {
            return Err(protocol_error("invalid SFTP packet length"));
        }
        let Some(pkt) = unread.get(4..4 + len) else {
            return Ok(None);
        };
        let mut c = Cursor::new(pkt);
        let kind = c.u8()?;
        let id = c.u32()?;
        let body = c.take(c.remaining())?.to_vec();
        self.rpos += 4 + len;
        if self.rpos == self.rbuf.len() {
            self.rbuf.clear();
            self.rpos = 0;
        }
        Ok(Some((kind, id, body)))
    }

    /// Read until one reply is complete.
    fn next_packet(&mut self) -> Result<(u8, u32, Vec<u8>), ssh2::Error> {
        let mut last_progress = Instant::now();
        loop {
            if let Some(packet) = self.parse_packet()? {
                return Ok(packet);
            }
            if self.rpos > 0 {
                self.rbuf.drain(..self.rpos);
                self.rpos = 0;
            }
            match self.half.read(&mut self.scratch) {
                Ok(0) => return Err(lost_error("the SFTP server program exited")),
                Ok(n) => {
                    let got = self.scratch.get(..n).unwrap_or_default();
                    self.rbuf.extend_from_slice(got);
                    last_progress = Instant::now();
                }
                // A timed-out read waited the session's whole I/O timeout
                // without data; another read is only tried when it ended early
                // (libssh2 counts whole seconds).
                Err(e) if e.kind() == ErrorKind::TimedOut => {
                    if last_progress.elapsed() + TIMEOUT_ROUNDING >= REPLY_TIMEOUT {
                        return Err(self.half.classify(&e));
                    }
                }
                Err(e) if e.kind() == ErrorKind::Interrupted => {}
                Err(e) => return Err(self.half.classify(&e)),
            }
        }
    }
}

struct Inner {
    state: Mutex<State>,
    /// Signalled whenever the reader routed a packet or gave up the role.
    turn: Condvar,
    reader: Mutex<Reader>,
}

fn broken_error() -> ssh2::Error {
    protocol_error("the SFTP connection (compatibility mode) is broken")
}

impl Inner {
    fn lock_state(&self) -> Result<MutexGuard<'_, State>, ssh2::Error> {
        // A poisoned lock means an operation stopped half way: the stream
        // may be desynchronised, so it is not used again.
        self.state.lock().map_err(|_| broken_error())
    }

    /// Make progress while holding the state lock: read one packet (when no
    /// other thread is reading) or wait for the reader to route one.
    fn progress<'a>(
        &'a self,
        mut st: MutexGuard<'a, State>,
    ) -> Result<MutexGuard<'a, State>, ssh2::Error> {
        if st.reader_active {
            return self.turn.wait(st).map_err(|_| broken_error());
        }
        st.reader_active = true;
        drop(st);
        // The network read happens without the state lock, so other threads
        // keep sending requests and picking up their replies meanwhile.
        let packet = match self.reader.lock() {
            Ok(mut r) => r.next_packet(),
            Err(_) => Err(broken_error()),
        };
        let mut st = self.lock_state()?;
        st.reader_active = false;
        match packet {
            Ok((kind, id, body)) => {
                let _ = st.route(kind, id, body);
            }
            Err(e) => {
                st.fail(e);
            }
        }
        self.turn.notify_all();
        Ok(st)
    }

    fn send(&self, kind: u8, parts: &[&[u8]], reserve: usize) -> Result<u32, ssh2::Error> {
        let mut st = self.lock_state()?;
        st.check()?;
        let body_len: usize = parts.iter().map(|p| p.len()).sum::<usize>() + 5;
        if body_len + 4 > MAX_OUT_PACKET {
            return Err(ssh2::Error::new(
                ErrorCode::Session(ERR_INVAL),
                "SFTP request too large",
            ));
        }
        // Let pending replies be read (for whoever asked) before adding more.
        while st.in_flight > 0 && st.in_flight + reserve > REPLY_BUDGET {
            st = self.progress(st)?;
            st.check()?;
        }
        let mut id = st.next_id;
        while st.slots.contains_key(&id) {
            id = id.wrapping_add(1);
        }
        st.next_id = id.wrapping_add(1);
        let mut pkt = Vec::with_capacity(body_len + 4);
        put_u32(&mut pkt, body_len as u32);
        pkt.push(kind);
        put_u32(&mut pkt, id);
        for p in parts {
            pkt.extend_from_slice(p);
        }
        if let Err(e) = st.writer.write_all(&pkt) {
            // A partly written packet desynchronises the stream.
            let err = st.writer.classify(&e);
            let err = st.fail(err);
            self.turn.notify_all();
            return Err(err);
        }
        st.slots.insert(id, Slot::Waiting(reserve));
        st.in_flight += reserve;
        Ok(id)
    }

    /// Wait for the reply to `id`.
    fn wait(&self, id: u32) -> Result<Reply, ssh2::Error> {
        let mut st = self.lock_state()?;
        loop {
            match st.slots.remove(&id) {
                Some(Slot::Done(reply)) => return Ok(reply),
                Some(slot) => {
                    st.slots.insert(id, slot);
                }
                None => return Err(protocol_error("no such SFTP request")),
            }
            if let Err(e) = st.check() {
                st.slots.remove(&id);
                return Err(e);
            }
            st = self.progress(st)?;
        }
    }

    fn request(&self, kind: u8, parts: &[&[u8]]) -> Result<Reply, ssh2::Error> {
        let reserve = if matches!(kind, FXP_READDIR | FXP_REALPATH) {
            LISTING_REPLY
        } else {
            SMALL_REPLY
        };
        let id = self.send(kind, parts, reserve)?;
        self.wait(id)
    }

    /// Give up on requests whose replies nobody will read.
    fn discard(&self, ids: impl IntoIterator<Item = u32>) {
        let Ok(mut st) = self.state.lock() else {
            return;
        };
        for id in ids {
            match st.slots.remove(&id) {
                Some(Slot::Waiting(reserved)) | Some(Slot::Discard(reserved)) => {
                    st.slots.insert(id, Slot::Discard(reserved));
                }
                Some(Slot::Done(_)) | None => {}
            }
        }
    }

    fn is_broken(&self) -> bool {
        self.state.lock().map(|st| st.broken).unwrap_or(true)
    }

    fn close_handle(&self, handle: &[u8]) {
        if self.is_broken() {
            return;
        }
        let _ = self.close_handle_checked(handle);
    }

    fn close_handle_checked(&self, handle: &[u8]) -> Result<(), ssh2::Error> {
        let mut h = Vec::with_capacity(handle.len() + 4);
        put_str(&mut h, handle);
        self.request(FXP_CLOSE, &[&h])?.expect_ok()
    }
}

// ---------------------------------------------------------------------------
// handshake
// ---------------------------------------------------------------------------

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// A packet header that can only be the VERSION reply (login-script text
/// read as a length is far above the packet limit).
fn looks_like_version(buf: &[u8]) -> bool {
    match (buf.get(..4), buf.get(4)) {
        (Some(len), Some(&kind)) => {
            let len = Cursor::new(len).u32().unwrap_or(0) as usize;
            kind == FXP_VERSION && (5..=MAX_PACKET).contains(&len)
        }
        _ => false,
    }
}

/// Send INIT and read the server's VERSION, skipping login-script text and
/// the marker line in front of it. Returns the stream and the program path.
fn handshake(
    mut transport: Box<dyn Transport>,
    timeout: Duration,
) -> Result<(Inner, String), StartError> {
    let deadline = Instant::now() + timeout;
    let mut init = Vec::with_capacity(9);
    put_u32(&mut init, 5);
    init.push(FXP_INIT);
    put_u32(&mut init, 3);
    if let Err(e) = transport.write_all(&init) {
        return Err(StartError::Channel(transport.classify(&e)));
    }

    let mut buf: Vec<u8> = Vec::new();
    let mut scratch = vec![0u8; 4096];
    let mut server: Option<String> = None;
    loop {
        if server.is_none() {
            if let Some(at) = find(&buf, MARKER) {
                let rest = buf.get(at + MARKER.len()..).unwrap_or_default();
                if let Some(nl) = rest.iter().position(|&b| b == b'\n') {
                    let path = rest.get(..nl.min(MAX_SERVER_PATH)).unwrap_or_default();
                    server = Some(String::from_utf8_lossy(path).trim().to_string());
                    if at > 0 {
                        tracing::debug!(
                            "Skipped {} bytes of login-script output before sftp-server",
                            at
                        );
                    }
                    buf.drain(..at + MARKER.len() + nl + 1);
                }
            } else if looks_like_version(&buf) {
                // ForceCommand internal-sftp answers without running the script.
                server = Some("internal-sftp".to_string());
            }
        }
        if server.is_some() && looks_like_version(&buf) {
            let len = buf
                .get(..4)
                .and_then(|b| Cursor::new(b).u32().ok())
                .unwrap_or(0) as usize;
            if let Some(pkt) = buf.get(4..4 + len) {
                let mut c = Cursor::new(pkt);
                let version = c.u8().and_then(|_| c.u32()).map_err(|_| {
                    StartError::Unavailable("sftp-server sent an invalid version reply".into())
                })?;
                if version < 3 {
                    return Err(StartError::Unavailable(format!(
                        "sftp-server speaks SFTP version {}, RustSCP needs version 3",
                        version
                    )));
                }
                // Extensions (name/data pairs) are not used.
                buf.drain(..4 + len);
                let server = server.unwrap_or_default();
                let (half, writer) = transport.split();
                let inner = Inner {
                    state: Mutex::new(State {
                        writer,
                        next_id: 1,
                        slots: HashMap::new(),
                        in_flight: 0,
                        reader_active: false,
                        broken: false,
                    }),
                    turn: Condvar::new(),
                    reader: Mutex::new(Reader {
                        half,
                        rbuf: buf,
                        rpos: 0,
                        scratch: vec![0; READ_SLICE],
                    }),
                };
                return Ok((inner, server));
            }
        } else if server.is_some() && buf.len() >= 5 {
            return Err(StartError::Unavailable(
                "sftp-server did not answer with an SFTP version".into(),
            ));
        } else if server.is_none() && buf.len() > MAX_PREAMBLE {
            return Err(StartError::Unavailable(
                "a login script on the server prints text for non-interactive sessions, which \
                 breaks SFTP (move that output to an interactive-only part of the shell startup files)"
                    .into(),
            ));
        }

        if Instant::now() >= deadline {
            return Err(StartError::Unavailable(
                "sftp-server did not answer in time".into(),
            ));
        }
        match transport.read(&mut scratch) {
            Ok(0) => {
                let status = transport.exit_status();
                return Err(StartError::Unavailable(match status {
                    Some(127) => {
                        format!("no sftp-server program was found (tried {})", SERVER_PATHS)
                    }
                    Some(code) if code != 0 => format!(
                        "the server could not start sftp-server (exit status {}); it may not allow \
                         commands for this account",
                        code
                    ),
                    _ => "the server closed the command without starting sftp-server".into(),
                }));
            }
            Ok(n) => buf.extend_from_slice(scratch.get(..n).unwrap_or_default()),
            Err(e) if matches!(e.kind(), ErrorKind::TimedOut | ErrorKind::Interrupted) => {}
            Err(e) => return Err(StartError::Channel(transport.classify(&e))),
        }
    }
}

// ---------------------------------------------------------------------------
// public API (mirrors the ssh2::Sftp calls the driver uses)
// ---------------------------------------------------------------------------

pub(crate) struct ExecSftp {
    inner: Arc<Inner>,
    server: String,
}

impl std::fmt::Debug for ExecSftp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ExecSftp")
            .field("server", &self.server)
            .finish()
    }
}

impl ExecSftp {
    /// Start sftp-server as a command on a new channel of `sess`.
    pub(crate) fn start(sess: &Session) -> Result<ExecSftp, StartError> {
        if sess.banner().is_some_and(|b| b.contains("Windows")) {
            return Err(StartError::Unavailable(
                "compatibility mode is not available for Windows SSH servers".into(),
            ));
        }
        let mut chan = sess
            .channel_open("session", CHANNEL_WINDOW, CHANNEL_PACKET, None)
            .map_err(StartError::Channel)?;
        chan.handle_extended_data(ExtendedData::Ignore)
            .map_err(StartError::Channel)?;
        if let Err(e) = chan.exec(EXEC_COMMAND) {
            let lost = matches!(e.code(), ErrorCode::Session(c) if crate::sftp::is_connection_lost_code(c));
            return Err(if lost {
                StartError::Channel(e)
            } else {
                StartError::Unavailable(format!(
                    "the server refused to run sftp-server as a command ({})",
                    e
                ))
            });
        }
        let transport = ChannelTransport {
            chan,
            sess: sess.clone(),
        };
        Self::with_transport(Box::new(transport), START_TIMEOUT)
    }

    pub(crate) fn with_transport(
        transport: Box<dyn Transport>,
        timeout: Duration,
    ) -> Result<ExecSftp, StartError> {
        let (inner, server) = handshake(transport, timeout)?;
        Ok(ExecSftp {
            inner: Arc::new(inner),
            server,
        })
    }

    /// The program that answers (for example `/usr/libexec/openssh/sftp-server`).
    pub(crate) fn server_path(&self) -> &str {
        &self.server
    }

    /// The channel can no longer be used; a new one is needed.
    pub(crate) fn is_broken(&self) -> bool {
        self.inner.is_broken()
    }

    fn path_request(&self, kind: u8, path: &Path) -> Result<Reply, ssh2::Error> {
        let mut p = Vec::new();
        put_str(&mut p, &path_bytes(path)?);
        self.inner.request(kind, &[&p])
    }

    pub(crate) fn realpath(&self, path: &Path) -> Result<PathBuf, ssh2::Error> {
        let names = self.path_request(FXP_REALPATH, path)?.expect_names()?;
        names
            .into_iter()
            .next()
            .map(|(p, _)| p)
            .ok_or_else(|| protocol_error("empty SFTP realpath reply"))
    }

    pub(crate) fn stat(&self, path: &Path) -> Result<FileStat, ssh2::Error> {
        self.path_request(FXP_STAT, path)?.expect_attrs()
    }

    pub(crate) fn lstat(&self, path: &Path) -> Result<FileStat, ssh2::Error> {
        self.path_request(FXP_LSTAT, path)?.expect_attrs()
    }

    pub(crate) fn setstat(&self, path: &Path, stat: FileStat) -> Result<(), ssh2::Error> {
        let mut p = Vec::new();
        put_str(&mut p, &path_bytes(path)?);
        put_attrs(&mut p, &stat);
        self.inner.request(FXP_SETSTAT, &[&p])?.expect_ok()
    }

    pub(crate) fn mkdir(&self, path: &Path, mode: i32) -> Result<(), ssh2::Error> {
        let mut p = Vec::new();
        put_str(&mut p, &path_bytes(path)?);
        put_u32(&mut p, ATTR_PERMISSIONS);
        put_u32(&mut p, mode as u32);
        self.inner.request(FXP_MKDIR, &[&p])?.expect_ok()
    }

    pub(crate) fn rmdir(&self, path: &Path) -> Result<(), ssh2::Error> {
        self.path_request(FXP_RMDIR, path)?.expect_ok()
    }

    pub(crate) fn unlink(&self, path: &Path) -> Result<(), ssh2::Error> {
        self.path_request(FXP_REMOVE, path)?.expect_ok()
    }

    /// Plain SFTP v3 rename, like libssh2 sends to a version 3 server.
    pub(crate) fn rename(&self, src: &Path, dst: &Path) -> Result<(), ssh2::Error> {
        let mut p = Vec::new();
        put_str(&mut p, &path_bytes(src)?);
        put_str(&mut p, &path_bytes(dst)?);
        self.inner.request(FXP_RENAME, &[&p])?.expect_ok()
    }

    pub(crate) fn opendir(&self, path: &Path) -> Result<ExecDir, ssh2::Error> {
        let handle = self.path_request(FXP_OPENDIR, path)?.expect_handle()?;
        Ok(ExecDir {
            inner: self.inner.clone(),
            handle,
            batch: VecDeque::new(),
            done: false,
        })
    }

    pub(crate) fn open(&self, path: &Path) -> Result<ExecFile, ssh2::Error> {
        self.open_mode(path, OpenFlags::READ, 0o644, OpenType::File)
    }

    pub(crate) fn open_mode(
        &self,
        path: &Path,
        flags: OpenFlags,
        mode: i32,
        open_type: OpenType,
    ) -> Result<ExecFile, ssh2::Error> {
        if matches!(open_type, OpenType::Dir) {
            return Err(ssh2::Error::new(
                ErrorCode::Session(ERR_INVAL),
                "use opendir for folders",
            ));
        }
        let mut p = Vec::new();
        put_str(&mut p, &path_bytes(path)?);
        // ssh2's flag bits are the SFTP v3 pflags.
        put_u32(&mut p, flags.bits() as u32);
        put_u32(&mut p, ATTR_PERMISSIONS);
        put_u32(&mut p, mode as u32);
        let handle = self.inner.request(FXP_OPEN, &[&p])?.expect_handle()?;
        Ok(ExecFile::new(self.inner.clone(), handle))
    }
}

/// An open folder; `readdir` ends with libssh2's `Session(-16)`, like ssh2.
pub(crate) struct ExecDir {
    inner: Arc<Inner>,
    handle: Vec<u8>,
    batch: VecDeque<(PathBuf, FileStat)>,
    done: bool,
}

impl ExecDir {
    pub(crate) fn readdir(&mut self) -> Result<(PathBuf, FileStat), ssh2::Error> {
        loop {
            if let Some(entry) = self.batch.pop_front() {
                return Ok(entry);
            }
            if self.done {
                return Err(ssh2::Error::new(
                    ErrorCode::Session(ERR_FILE),
                    "no more files",
                ));
            }
            let mut h = Vec::with_capacity(self.handle.len() + 4);
            put_str(&mut h, &self.handle);
            let reply = self.inner.request(FXP_READDIR, &[&h])?;
            if reply.kind == FXP_STATUS {
                match reply.status()? {
                    FX_EOF => self.done = true,
                    FX_OK => return Err(protocol_error("unexpected SFTP status in a listing")),
                    code => return Err(status_error(code)),
                }
            } else {
                self.batch.extend(reply.expect_names()?);
            }
        }
    }
}

impl Drop for ExecDir {
    fn drop(&mut self) {
        self.inner.close_handle(&self.handle);
    }
}

struct PendingRead {
    id: u32,
    offset: u64,
    len: u32,
}

/// An open file with read-ahead and pipelined writes, used like `ssh2::File`.
pub(crate) struct ExecFile {
    inner: Arc<Inner>,
    handle: Vec<u8>,
    /// Handle as an SFTP string, ready to send.
    handle_str: Vec<u8>,
    pos: u64,
    /// Read requests in flight, in offset order, covering the bytes right
    /// after the stash up to `next_req`.
    reads: VecDeque<PendingRead>,
    next_req: u64,
    /// The last DATA reply; `stash[stash_pos..stash_end]` is not read yet.
    stash: Vec<u8>,
    stash_pos: usize,
    stash_end: usize,
    eof: bool,
    /// Closed by [`close`](Self::close): nothing left to close on drop.
    closed: bool,
}

impl ExecFile {
    fn new(inner: Arc<Inner>, handle: Vec<u8>) -> Self {
        let mut handle_str = Vec::with_capacity(handle.len() + 4);
        put_str(&mut handle_str, &handle);
        Self {
            inner,
            handle,
            handle_str,
            pos: 0,
            reads: VecDeque::new(),
            next_req: 0,
            stash: Vec::new(),
            stash_pos: 0,
            stash_end: 0,
            eof: false,
            closed: false,
        }
    }

    /// Close the file and report the server's answer (dropping it closes it
    /// without one).
    pub(crate) fn close(mut self) -> Result<(), ssh2::Error> {
        self.reset_read_ahead();
        self.closed = true;
        self.inner.close_handle_checked(&self.handle)
    }

    pub(crate) fn stat(&mut self) -> Result<FileStat, ssh2::Error> {
        self.inner
            .request(FXP_FSTAT, &[&self.handle_str])?
            .expect_attrs()
    }

    fn reset_read_ahead(&mut self) {
        self.inner.discard(self.reads.drain(..).map(|r| r.id));
        self.stash.clear();
        self.stash_pos = 0;
        self.stash_end = 0;
        self.next_req = self.pos;
        self.eof = false;
    }

    fn send_read(&self, offset: u64, len: u32) -> Result<u32, ssh2::Error> {
        let mut args = [0u8; 12];
        let (off_bytes, len_bytes) = args.split_at_mut(8);
        off_bytes.copy_from_slice(&offset.to_be_bytes());
        len_bytes.copy_from_slice(&len.to_be_bytes());
        self.inner.send(
            FXP_READ,
            &[&self.handle_str, &args],
            len as usize + SMALL_REPLY,
        )
    }

    fn read_inner(&mut self, out: &mut [u8]) -> Result<usize, ssh2::Error> {
        let result = self.read_step(out);
        if result.is_err() {
            // Requests in flight no longer match the position.
            self.reset_read_ahead();
        }
        result
    }

    fn read_step(&mut self, out: &mut [u8]) -> Result<usize, ssh2::Error> {
        if out.is_empty() {
            return Ok(0);
        }
        // Read ahead four times the caller's buffer from where this call
        // starts, like libssh2: callers that read a byte range size their
        // buffer so the read-ahead ends at the range end.
        let ahead = (out.len() as u64).saturating_mul(4).clamp(
            u64::from(READ_CHUNK),
            u64::from(READ_CHUNK) * MAX_READS_IN_FLIGHT as u64,
        );
        let limit = self.pos.saturating_add(ahead.max(out.len() as u64));
        let mut filled = 0usize;
        loop {
            let available = self
                .stash
                .get(self.stash_pos..self.stash_end)
                .unwrap_or_default();
            if !available.is_empty() {
                let dst = out.get_mut(filled..).unwrap_or_default();
                let n = available.len().min(dst.len());
                if let (Some(d), Some(s)) = (dst.get_mut(..n), available.get(..n)) {
                    d.copy_from_slice(s);
                }
                self.stash_pos += n;
                self.pos = self.pos.saturating_add(n as u64);
                filled += n;
                if filled == out.len() {
                    return Ok(filled);
                }
                continue;
            }
            if self.eof {
                return Ok(filled);
            }
            while self.reads.len() < MAX_READS_IN_FLIGHT && self.next_req < limit {
                let Some(after) = self.next_req.checked_add(u64::from(READ_CHUNK)) else {
                    break;
                };
                let id = self.send_read(self.next_req, READ_CHUNK)?;
                self.reads.push_back(PendingRead {
                    id,
                    offset: self.next_req,
                    len: READ_CHUNK,
                });
                self.next_req = after;
            }
            let Some(req) = self.reads.pop_front() else {
                return Ok(filled);
            };
            let reply = self.inner.wait(req.id)?;
            match reply.kind {
                FXP_DATA => {
                    let data = match Cursor::new(&reply.body).string() {
                        Ok(d) if !d.is_empty() && d.len() <= req.len as usize => d,
                        _ => return Err(protocol_error("invalid SFTP data reply")),
                    };
                    let got = data.len() as u32;
                    // The data follows its 4-byte length in the reply body.
                    let (start, end) = (4, 4 + data.len());
                    if got < req.len {
                        // Short read before the end: ask again for the rest,
                        // ahead of the requests already in flight.
                        let offset = req
                            .offset
                            .checked_add(u64::from(got))
                            .ok_or_else(|| protocol_error("invalid SFTP data reply"))?;
                        let id = self.send_read(offset, req.len - got)?;
                        self.reads.push_front(PendingRead {
                            id,
                            offset,
                            len: req.len - got,
                        });
                    }
                    self.stash = reply.body;
                    self.stash_pos = start;
                    self.stash_end = end;
                }
                FXP_STATUS => {
                    let code = reply.status()?;
                    self.reset_read_ahead();
                    if code == FX_EOF {
                        self.eof = true;
                        continue;
                    }
                    return Err(if code == FX_OK {
                        protocol_error("unexpected SFTP status for a read")
                    } else {
                        status_error(code)
                    });
                }
                _ => return Err(protocol_error("unexpected reply to an SFTP read")),
            }
        }
    }

    /// Write all of `buf` at the current position with pipelined requests and
    /// wait for every acknowledgement, so success means the server has it.
    fn write_inner(&mut self, buf: &[u8]) -> Result<usize, ssh2::Error> {
        if buf.is_empty() {
            return Ok(0);
        }
        self.reset_read_ahead();
        let mut in_flight: VecDeque<u32> = VecDeque::new();
        let mut offset = self.pos;
        let mut result = Ok(());
        for chunk in buf.chunks(WRITE_CHUNK) {
            if in_flight.len() >= MAX_WRITES_IN_FLIGHT {
                if let Some(id) = in_flight.pop_front() {
                    result = self.inner.wait(id).and_then(|r| r.expect_ok());
                    if result.is_err() {
                        break;
                    }
                }
            }
            let mut head = Vec::with_capacity(12);
            put_u64(&mut head, offset);
            put_u32(&mut head, chunk.len() as u32);
            match self
                .inner
                .send(FXP_WRITE, &[&self.handle_str, &head, chunk], SMALL_REPLY)
            {
                Ok(id) => in_flight.push_back(id),
                Err(e) => {
                    result = Err(e);
                    break;
                }
            }
            offset = offset.saturating_add(chunk.len() as u64);
        }
        while result.is_ok() {
            let Some(id) = in_flight.pop_front() else {
                break;
            };
            result = self.inner.wait(id).and_then(|r| r.expect_ok());
        }
        self.inner.discard(in_flight);
        result?;
        self.pos = self.pos.saturating_add(buf.len() as u64);
        self.next_req = self.pos;
        Ok(buf.len())
    }
}

impl Read for ExecFile {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.read_inner(buf).map_err(io::Error::from)
    }
}

impl Write for ExecFile {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.write_inner(buf).map_err(io::Error::from)
    }

    /// Writes are acknowledged before `write` returns.
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Seek for ExecFile {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let target = match from {
            SeekFrom::Start(o) => Some(o),
            SeekFrom::Current(d) => self.pos.checked_add_signed(d),
            SeekFrom::End(d) => {
                let size = self.stat().map_err(io::Error::from)?.size.unwrap_or(0);
                size.checked_add_signed(d)
            }
        };
        let target = target.ok_or_else(|| {
            io::Error::new(
                ErrorKind::InvalidInput,
                "invalid seek to a negative position",
            )
        })?;
        if target != self.pos {
            self.pos = target;
            self.reset_read_ahead();
        }
        Ok(target)
    }
}

impl Drop for ExecFile {
    fn drop(&mut self) {
        if self.closed {
            return;
        }
        self.reset_read_ahead();
        self.inner.close_handle(&self.handle);
    }
}

#[cfg(test)]
#[allow(
    clippy::indexing_slicing,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic
)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

    /// sftp-server (or a script) on local pipes. A thread drains its output
    /// into memory, the way libssh2 buffers channel data up to the window
    /// (a bare 64 KiB pipe would stall the server far earlier than SSH does).
    #[cfg(unix)]
    struct PipeTransport {
        reader: PipeReader,
        writer: PipeWriter,
    }

    #[cfg(unix)]
    struct PipeReader {
        rx: std::sync::mpsc::Receiver<Vec<u8>>,
        pending: Vec<u8>,
        pos: usize,
    }

    #[cfg(unix)]
    struct PipeWriter {
        child: Child,
        stdin: ChildStdin,
    }

    #[cfg(unix)]
    impl PipeTransport {
        fn spawn(program: &str, args: &[&str]) -> Self {
            let mut child = Command::new(program)
                .args(args)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            let stdin = child.stdin.take().unwrap();
            let mut stdout: ChildStdout = child.stdout.take().unwrap();
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let mut buf = vec![0u8; 64 * 1024];
                loop {
                    match stdout.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if tx.send(buf[..n].to_vec()).is_err() {
                                break;
                            }
                        }
                    }
                }
            });
            Self {
                reader: PipeReader {
                    rx,
                    pending: Vec::new(),
                    pos: 0,
                },
                writer: PipeWriter { child, stdin },
            }
        }
    }

    #[cfg(unix)]
    impl ReadHalf for PipeReader {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            if self.pos >= self.pending.len() {
                match self.rx.recv() {
                    Ok(v) => {
                        self.pending = v;
                        self.pos = 0;
                    }
                    Err(_) => return Ok(0),
                }
            }
            let n = buf.len().min(self.pending.len() - self.pos);
            buf[..n].copy_from_slice(&self.pending[self.pos..self.pos + n]);
            self.pos += n;
            Ok(n)
        }
        fn classify(&self, _e: &io::Error) -> ssh2::Error {
            ssh2::Error::new(ErrorCode::Session(ERR_SOCKET_RECV), "pipe failed")
        }
    }

    #[cfg(unix)]
    impl WriteHalf for PipeWriter {
        fn write_all(&mut self, buf: &[u8]) -> io::Result<()> {
            Write::write_all(&mut self.stdin, buf)
        }
        fn classify(&self, _e: &io::Error) -> ssh2::Error {
            ssh2::Error::new(ErrorCode::Session(ERR_SOCKET_RECV), "pipe failed")
        }
    }

    #[cfg(unix)]
    impl Drop for PipeWriter {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    #[cfg(unix)]
    impl Transport for PipeTransport {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.reader.read(buf)
        }
        fn write_all(&mut self, buf: &[u8]) -> io::Result<()> {
            self.writer.write_all(buf)
        }
        fn classify(&self, e: &io::Error) -> ssh2::Error {
            self.reader.classify(e)
        }
        fn exit_status(&mut self) -> Option<i32> {
            self.writer.child.wait().ok().and_then(|s| s.code())
        }
        fn split(self: Box<Self>) -> (Box<dyn ReadHalf>, Box<dyn WriteHalf>) {
            (Box::new(self.reader), Box::new(self.writer))
        }
    }

    #[cfg(unix)]
    fn local_server() -> Option<&'static str> {
        SERVER_PATHS
            .split_whitespace()
            .find(|p| Path::new(p).is_file())
    }

    #[cfg(unix)]
    fn connect_local() -> Option<ExecSftp> {
        let server = local_server()?;
        let t = PipeTransport::spawn(server, &[]);
        Some(ExecSftp::with_transport(Box::new(t), START_TIMEOUT).unwrap())
    }

    fn pseudo_random(len: usize, seed: u64) -> Vec<u8> {
        let mut x = seed | 1;
        (0..len)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                (x >> 24) as u8
            })
            .collect()
    }

    #[test]
    fn exec_command_is_pinned() {
        assert_eq!(
            EXEC_COMMAND,
            "exec /bin/sh -c 'for p in /usr/lib/openssh/sftp-server /usr/libexec/openssh/sftp-server \
/usr/lib/ssh/sftp-server /usr/libexec/ssh/sftp-server /usr/libexec/sftp-server /usr/lib/sftp-server \
/usr/local/libexec/sftp-server /usr/lib64/misc/sftp-server /usr/lib/misc/sftp-server \
/usr/sbin/sftp-server /opt/ssh/libexec/sftp-server; do [ -f \"$p\" ] && [ -x \"$p\" ] && \
{ printf \"RUSTSCP-SFTP %s\\n\" \"$p\"; exec \"$p\"; }; done; exit 127'"
        );
        // The candidate list in the command is the documented one.
        for p in SERVER_PATHS.split_whitespace() {
            assert!(EXEC_COMMAND.contains(p), "{p}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn exec_command_runs_under_sh() {
        if local_server().is_none() {
            return;
        }
        // The exact command, as a login shell would run it.
        let t = PipeTransport::spawn("/bin/sh", &["-c", EXEC_COMMAND]);
        let sftp = ExecSftp::with_transport(Box::new(t), START_TIMEOUT).unwrap();
        assert!(
            sftp.server_path().ends_with("sftp-server"),
            "{}",
            sftp.server_path()
        );
        assert!(sftp.realpath(Path::new(".")).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn login_noise_before_the_marker_is_skipped() {
        let Some(server) = local_server() else { return };
        let script = format!(
            "echo 'Welcome to the server'; echo 'last login: yesterday'; printf 'RUSTSCP-SFTP %s\\n' {s}; exec {s}",
            s = server
        );
        let t = PipeTransport::spawn("/bin/sh", &["-c", &script]);
        let sftp = ExecSftp::with_transport(Box::new(t), START_TIMEOUT).unwrap();
        assert_eq!(sftp.server_path(), server);
        assert!(sftp.stat(Path::new("/")).unwrap().is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn missing_server_and_noise_are_reported() {
        let t = PipeTransport::spawn("/bin/sh", &["-c", "exit 127"]);
        match ExecSftp::with_transport(Box::new(t), START_TIMEOUT) {
            Err(StartError::Unavailable(msg)) => assert!(msg.contains("no sftp-server"), "{msg}"),
            other => panic!("{other:?}"),
        }
        let t = PipeTransport::spawn(
            "/bin/sh",
            &["-c", "i=0; while [ $i -lt 600 ]; do echo 'motd motd motd motd'; i=$((i+1)); done; sleep 5"],
        );
        match ExecSftp::with_transport(Box::new(t), START_TIMEOUT) {
            Err(StartError::Unavailable(msg)) => assert!(msg.contains("login script"), "{msg}"),
            other => panic!("{other:?}"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn file_and_folder_operations_against_sftp_server() {
        let Some(sftp) = connect_local() else { return };
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();

        let sub = root.join("a");
        sftp.mkdir(&sub, 0o755).unwrap();
        assert!(sftp.stat(&sub).unwrap().is_dir());
        // An existing folder is an SFTP status error, not a protocol error.
        assert!(matches!(
            sftp.mkdir(&sub, 0o755).unwrap_err().code(),
            ErrorCode::SFTP(_)
        ));

        let data = pseudo_random(5 * 1024 * 1024 + 123, 7);
        let path = sub.join("data.bin");
        {
            let mut f = sftp
                .open_mode(
                    &path,
                    OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
                    0o644,
                    OpenType::File,
                )
                .unwrap();
            f.write_all(&data).unwrap();
            assert_eq!(f.stat().unwrap().size, Some(data.len() as u64));
        }
        assert_eq!(std::fs::read(&path).unwrap(), data);

        // Whole file.
        let mut back = Vec::new();
        sftp.open(&path).unwrap().read_to_end(&mut back).unwrap();
        assert_eq!(back, data);

        // A range at an odd offset, the way the driver reads ranges.
        let mut f = sftp.open(&path).unwrap();
        f.seek(SeekFrom::Start(1_000_003)).unwrap();
        let mut part = vec![0u8; 777_777];
        let mut got = 0;
        while got < part.len() {
            let want = (part.len() - got).min(65_536);
            let n = f.read(&mut part[got..got + want]).unwrap();
            assert!(n > 0);
            got += n;
        }
        assert_eq!(&part[..], &data[1_000_003..1_000_003 + 777_777]);
        // Seek back and read across the end.
        f.seek(SeekFrom::End(-10)).unwrap();
        let mut tail = Vec::new();
        f.read_to_end(&mut tail).unwrap();
        assert_eq!(&tail[..], &data[data.len() - 10..]);
        drop(f);

        // Overwrite in the middle.
        {
            let mut f = sftp
                .open_mode(&path, OpenFlags::WRITE, 0o644, OpenType::File)
                .unwrap();
            f.seek(SeekFrom::Start(10)).unwrap();
            f.write_all(b"hello").unwrap();
        }
        let disk = std::fs::read(&path).unwrap();
        assert_eq!(&disk[10..15], b"hello");
        assert_eq!(disk.len(), data.len());

        // Listing.
        std::fs::write(sub.join("b.txt"), b"b").unwrap();
        let mut d = sftp.opendir(&sub).unwrap();
        let mut names = Vec::new();
        loop {
            match d.readdir() {
                Ok((name, _)) => names.push(name.to_string_lossy().into_owned()),
                Err(e) => {
                    assert_eq!(e.code(), ErrorCode::Session(ERR_FILE));
                    break;
                }
            }
        }
        drop(d);
        names.sort();
        assert_eq!(names, vec![".", "..", "b.txt", "data.bin"]);

        // Attributes, rename, lstat of a symlink, errors.
        sftp.setstat(
            &path,
            FileStat {
                size: None,
                uid: None,
                gid: None,
                perm: Some(0o600),
                atime: None,
                mtime: None,
            },
        )
        .unwrap();
        assert_eq!(sftp.stat(&path).unwrap().perm.unwrap() & 0o777, 0o600);
        let moved = sub.join("moved.bin");
        sftp.rename(&path, &moved).unwrap();
        std::os::unix::fs::symlink(&moved, sub.join("link")).unwrap();
        assert!(sftp
            .lstat(&sub.join("link"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            sftp.stat(&path).unwrap_err().code(),
            ErrorCode::SFTP(2) // no such file
        );
        assert_eq!(sftp.realpath(&sub.join("..")).unwrap(), root);
        sftp.unlink(&sub.join("link")).unwrap();
        sftp.unlink(&moved).unwrap();
        sftp.unlink(&sub.join("b.txt")).unwrap();
        sftp.rmdir(&sub).unwrap();
        assert!(!sub.exists());

        // A short file read with a big buffer, and an empty file.
        std::fs::write(root.join("short"), b"abc").unwrap();
        let mut s = Vec::new();
        sftp.open(&root.join("short"))
            .unwrap()
            .read_to_end(&mut s)
            .unwrap();
        assert_eq!(s, b"abc");
        std::fs::write(root.join("empty"), b"").unwrap();
        let mut buf = [0u8; 100];
        assert_eq!(
            sftp.open(&root.join("empty"))
                .unwrap()
                .read(&mut buf)
                .unwrap(),
            0
        );
    }

    #[cfg(unix)]
    #[test]
    fn concurrent_operations_share_one_channel() {
        let Some(sftp) = connect_local() else { return };
        let sftp = Arc::new(sftp);
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let files: Vec<(PathBuf, Vec<u8>)> = (0..4)
            .map(|i| {
                let p = root.join(format!("f{i}"));
                let d = pseudo_random(3 * 1024 * 1024 + i * 1000, i as u64 + 1);
                std::fs::write(&p, &d).unwrap();
                (p, d)
            })
            .collect();
        let mut threads = Vec::new();
        for (p, d) in files {
            let s = sftp.clone();
            threads.push(std::thread::spawn(move || {
                for _ in 0..2 {
                    let mut back = Vec::new();
                    s.open(&p).unwrap().read_to_end(&mut back).unwrap();
                    assert_eq!(back, d);
                }
            }));
        }
        let lister = {
            let s = sftp.clone();
            let root = root.clone();
            std::thread::spawn(move || {
                for _ in 0..50 {
                    assert!(s.stat(&root).unwrap().is_dir());
                    let mut d = s.opendir(&root).unwrap();
                    while d.readdir().is_ok() {}
                }
            })
        };
        let writer = {
            let s = sftp.clone();
            let p = root.join("w");
            std::thread::spawn(move || {
                let d = pseudo_random(2 * 1024 * 1024, 99);
                let mut f = s
                    .open_mode(
                        &p,
                        OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
                        0o644,
                        OpenType::File,
                    )
                    .unwrap();
                f.write_all(&d).unwrap();
                drop(f);
                assert_eq!(std::fs::read(&p).unwrap(), d);
            })
        };
        for t in threads {
            t.join().unwrap();
        }
        lister.join().unwrap();
        writer.join().unwrap();
        // Nothing left behind in the reply table.
        assert!(sftp.inner.state.lock().unwrap().slots.is_empty());
    }

    // ---------------------------------------------------------------------
    // hostile server
    // ---------------------------------------------------------------------

    type Responder = Box<dyn FnMut(u8, u32, &[u8]) -> Vec<u8> + Send>;

    /// A fake server: parses each request and appends whatever the responder
    /// returns (raw bytes, so tests can send anything).
    struct MockState {
        respond: Responder,
        incoming: Vec<u8>,
        outgoing: VecDeque<u8>,
    }

    #[derive(Clone)]
    struct MockServer(Arc<Mutex<MockState>>);

    impl MockServer {
        fn read_bytes(&self, buf: &mut [u8]) -> io::Result<usize> {
            let mut st = self.0.lock().unwrap();
            let n = buf.len().min(st.outgoing.len()).min(4093);
            for b in buf.iter_mut().take(n) {
                *b = st.outgoing.pop_front().unwrap();
            }
            Ok(n) // 0 = the server went away
        }

        fn write_bytes(&self, buf: &[u8]) -> io::Result<()> {
            let mut st = self.0.lock().unwrap();
            st.incoming.extend_from_slice(buf);
            while st.incoming.len() >= 4 {
                let len = u32::from_be_bytes(st.incoming[..4].try_into().unwrap()) as usize;
                if st.incoming.len() < 4 + len {
                    break;
                }
                let pkt: Vec<u8> = st.incoming.drain(..4 + len).skip(4).collect();
                let kind = pkt[0];
                let (id, payload) = if kind == FXP_INIT {
                    (0, &pkt[1..])
                } else {
                    (u32::from_be_bytes(pkt[1..5].try_into().unwrap()), &pkt[5..])
                };
                let out = (st.respond)(kind, id, payload);
                st.outgoing.extend(out);
            }
            Ok(())
        }
    }

    fn mock_error() -> ssh2::Error {
        ssh2::Error::new(ErrorCode::Session(ERR_SOCKET_RECV), "mock failed")
    }

    impl Transport for MockServer {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.read_bytes(buf)
        }
        fn write_all(&mut self, buf: &[u8]) -> io::Result<()> {
            self.write_bytes(buf)
        }
        fn classify(&self, _e: &io::Error) -> ssh2::Error {
            mock_error()
        }
        fn split(self: Box<Self>) -> (Box<dyn ReadHalf>, Box<dyn WriteHalf>) {
            (Box::new((*self).clone()), self)
        }
    }

    impl ReadHalf for MockServer {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.read_bytes(buf)
        }
        fn classify(&self, _e: &io::Error) -> ssh2::Error {
            mock_error()
        }
    }

    impl WriteHalf for MockServer {
        fn write_all(&mut self, buf: &[u8]) -> io::Result<()> {
            self.write_bytes(buf)
        }
        fn classify(&self, _e: &io::Error) -> ssh2::Error {
            mock_error()
        }
    }

    fn packet(kind: u8, id: Option<u32>, body: &[u8]) -> Vec<u8> {
        let mut p = Vec::new();
        let len = 1 + id.map_or(0, |_| 4) + body.len();
        put_u32(&mut p, len as u32);
        p.push(kind);
        if let Some(id) = id {
            put_u32(&mut p, id);
        }
        p.extend_from_slice(body);
        p
    }

    fn version_packet() -> Vec<u8> {
        let mut b = Vec::new();
        put_u32(&mut b, 3);
        packet(FXP_VERSION, None, &b)
    }

    fn mock(mut f: impl FnMut(u8, u32, &[u8]) -> Vec<u8> + Send + 'static) -> ExecSftp {
        let respond: Responder = Box::new(move |kind, id, payload| {
            if kind == FXP_INIT {
                version_packet()
            } else {
                f(kind, id, payload)
            }
        });
        let server = MockServer(Arc::new(Mutex::new(MockState {
            respond,
            incoming: Vec::new(),
            outgoing: VecDeque::new(),
        })));
        ExecSftp::with_transport(Box::new(server), START_TIMEOUT).unwrap()
    }

    /// Valid reply bodies for every request kind the client sends.
    fn valid_reply(kind: u8, id: u32) -> Vec<u8> {
        let mut b = Vec::new();
        match kind {
            FXP_OPEN | FXP_OPENDIR => {
                put_str(&mut b, b"h1");
                packet(FXP_HANDLE, Some(id), &b)
            }
            FXP_READ => {
                put_str(&mut b, &[7u8; 1000]);
                packet(FXP_DATA, Some(id), &b)
            }
            FXP_READDIR | FXP_REALPATH => {
                put_u32(&mut b, 2);
                for name in [&b"x"[..], b"y"] {
                    put_str(&mut b, name);
                    put_str(&mut b, b"-rw-r--r-- 1 u g 0 Jan 1 00:00 x");
                    put_attrs(
                        &mut b,
                        &FileStat {
                            size: Some(1),
                            uid: Some(1),
                            gid: Some(1),
                            perm: Some(0o100644),
                            atime: Some(1),
                            mtime: Some(2),
                        },
                    );
                }
                packet(FXP_NAME, Some(id), &b)
            }
            FXP_STAT | FXP_LSTAT | FXP_FSTAT => {
                put_attrs(
                    &mut b,
                    &FileStat {
                        size: Some(5),
                        uid: None,
                        gid: None,
                        perm: Some(0o100644),
                        atime: None,
                        mtime: None,
                    },
                );
                put_u32(&mut b, 0); // trailing junk is ignored
                packet(FXP_ATTRS, Some(id), &b)
            }
            _ => {
                put_u32(&mut b, FX_OK);
                put_str(&mut b, b"ok");
                put_str(&mut b, b"");
                packet(FXP_STATUS, Some(id), &b)
            }
        }
    }

    /// Run every client call once; errors are fine, panics are not.
    fn exercise(sftp: &ExecSftp) {
        let p = Path::new("/x");
        let _ = sftp.stat(p);
        let _ = sftp.lstat(p);
        let _ = sftp.realpath(p);
        let _ = sftp.mkdir(p, 0o755);
        let _ = sftp.rename(p, p);
        if let Ok(mut d) = sftp.opendir(p) {
            for _ in 0..5 {
                if d.readdir().is_err() {
                    break;
                }
            }
        }
        if let Ok(mut f) = sftp.open(p) {
            let mut buf = vec![0u8; 70_000];
            let _ = f.read(&mut buf);
            let _ = f.stat();
            let _ = f.write(b"data");
        }
    }

    #[test]
    fn crafted_replies_never_panic() {
        type Case = Box<dyn Fn(u8, u32) -> Vec<u8> + Send + Sync>;
        let cases: Vec<Case> = vec![
            // Huge declared packet length.
            Box::new(|_, _| vec![0xff, 0xff, 0xff, 0xff, 101]),
            // Zero length.
            Box::new(|_, _| vec![0, 0, 0, 0]),
            // Packet without an id.
            Box::new(|_, _| packet(FXP_STATUS, None, &[])),
            // Wrong id.
            Box::new(|k, id| valid_reply(k, id.wrapping_add(1000))),
            // Duplicate reply.
            Box::new(|k, id| [valid_reply(k, id), valid_reply(k, id)].concat()),
            // String longer than the packet.
            Box::new(|_, id| {
                let mut b = Vec::new();
                put_u32(&mut b, 0xffff_fff0);
                packet(FXP_DATA, Some(id), &b)
            }),
            // DATA longer than requested.
            Box::new(|_, id| {
                let mut b = Vec::new();
                put_str(&mut b, &[1u8; 40_000]);
                packet(FXP_DATA, Some(id), &b)
            }),
            // Empty DATA.
            Box::new(|_, id| {
                let mut b = Vec::new();
                put_str(&mut b, &[]);
                packet(FXP_DATA, Some(id), &b)
            }),
            // NAME with a count of 4 billion.
            Box::new(|_, id| {
                let mut b = Vec::new();
                put_u32(&mut b, u32::MAX);
                packet(FXP_NAME, Some(id), &b)
            }),
            // ATTRS with 4 billion extended pairs.
            Box::new(|_, id| {
                let mut b = Vec::new();
                put_u32(&mut b, ATTR_EXTENDED);
                put_u32(&mut b, u32::MAX);
                packet(FXP_ATTRS, Some(id), &b)
            }),
            // Size field of 64 TiB (must not be allocated).
            Box::new(|_, id| {
                let mut b = Vec::new();
                put_u32(&mut b, ATTR_SIZE);
                put_u64(&mut b, 1 << 46);
                packet(FXP_ATTRS, Some(id), &b)
            }),
            // Truncated ATTRS.
            Box::new(|_, id| packet(FXP_ATTRS, Some(id), &[0, 0, 0, 0x0f, 1])),
            // Empty and oversized handles.
            Box::new(|_, id| {
                let mut b = Vec::new();
                put_str(&mut b, &[]);
                packet(FXP_HANDLE, Some(id), &b)
            }),
            Box::new(|_, id| {
                let mut b = Vec::new();
                put_str(&mut b, &[1u8; 5000]);
                packet(FXP_HANDLE, Some(id), &b)
            }),
            // STATUS OK where data was expected; unknown packet type.
            Box::new(|_, id| {
                let mut b = Vec::new();
                put_u32(&mut b, 0);
                packet(FXP_STATUS, Some(id), &b)
            }),
            Box::new(|_, id| packet(250, Some(id), &[1, 2, 3])),
            // The server goes away.
            Box::new(|_, _| Vec::new()),
        ];
        for (i, case) in cases.into_iter().enumerate() {
            let case = Arc::new(case);
            let c = case.clone();
            let sftp = mock(move |kind, id, _| {
                // Let open/opendir succeed so file and folder paths get exercised.
                if matches!(kind, FXP_OPEN | FXP_OPENDIR | FXP_CLOSE) {
                    valid_reply(kind, id)
                } else {
                    c(kind, id)
                }
            });
            exercise(&sftp);
            let sftp = mock(move |kind, id, _| case(kind, id));
            exercise(&sftp);
            eprintln!("case {i} ok");
        }
    }

    #[test]
    fn mutated_replies_never_panic() {
        let mut seed = 0x9e37_79b9_7f4a_7c15u64;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for _ in 0..3000 {
            let r1 = next();
            let r2 = next();
            let r3 = next();
            let sftp = mock(move |kind, id, _| {
                let mut pkt = valid_reply(kind, id);
                if pkt.is_empty() {
                    return pkt;
                }
                let mut r = r1 ^ u64::from(id);
                match r3 % 4 {
                    // Flip a few bytes (header included).
                    0 | 1 => {
                        for _ in 0..(1 + r2 % 4) {
                            r = r.rotate_left(17) ^ 0x5555;
                            let at = (r as usize) % pkt.len();
                            pkt[at] ^= (r >> 8) as u8 | 1;
                        }
                    }
                    // Truncate.
                    2 => pkt.truncate((r as usize) % pkt.len()),
                    // Append garbage.
                    _ => pkt.extend((0..(r2 % 64)).map(|i| (r >> (i % 56)) as u8)),
                }
                pkt
            });
            exercise(&sftp);
        }
    }

    #[test]
    fn statuses_map_like_libssh2() {
        let sftp = mock(|kind, id, _| {
            let mut b = Vec::new();
            match kind {
                FXP_STAT => put_u32(&mut b, 2),  // no such file
                FXP_LSTAT => put_u32(&mut b, 3), // permission denied
                _ => put_u32(&mut b, 4),         // failure
            }
            put_str(&mut b, b"msg");
            put_str(&mut b, b"");
            packet(FXP_STATUS, Some(id), &b)
        });
        assert_eq!(
            sftp.stat(Path::new("/x")).unwrap_err().code(),
            ErrorCode::SFTP(2)
        );
        assert_eq!(
            sftp.lstat(Path::new("/x")).unwrap_err().code(),
            ErrorCode::SFTP(3)
        );
        assert_eq!(
            sftp.unlink(Path::new("/x")).unwrap_err().code(),
            ErrorCode::SFTP(4)
        );
        // A protocol violation is a session error, never an SFTP "not found".
        let bad = mock(|_, id, _| packet(250, Some(id), &[]));
        assert_eq!(
            bad.stat(Path::new("/x")).unwrap_err().code(),
            ErrorCode::Session(ERR_SFTP_PROTOCOL)
        );
        // After the stream broke, everything fails fast with a session error.
        let gone = mock(|_, _, _| vec![0xff, 0xff, 0xff, 0xff]);
        assert!(matches!(
            gone.stat(Path::new("/")).unwrap_err().code(),
            ErrorCode::Session(_)
        ));
        assert!(matches!(
            gone.stat(Path::new("/")).unwrap_err().code(),
            ErrorCode::Session(_)
        ));
    }

    #[test]
    fn short_reads_are_completed() {
        // Every READ returns at most 1000 bytes of the right data.
        let content = Arc::new(pseudo_random(200_000, 3));
        let c = content.clone();
        let sftp = mock(move |kind, id, payload| {
            if kind != FXP_READ {
                return valid_reply(kind, id);
            }
            let mut cur = Cursor::new(payload);
            cur.string().unwrap();
            let off = cur.u64().unwrap() as usize;
            let len = cur.u32().unwrap() as usize;
            let mut b = Vec::new();
            if off >= c.len() {
                put_u32(&mut b, FX_EOF);
                put_str(&mut b, b"eof");
                put_str(&mut b, b"");
                return packet(FXP_STATUS, Some(id), &b);
            }
            let end = (off + len.min(1000)).min(c.len());
            put_str(&mut b, &c[off..end]);
            packet(FXP_DATA, Some(id), &b)
        });
        let mut back = Vec::new();
        sftp.open(Path::new("/f"))
            .unwrap()
            .read_to_end(&mut back)
            .unwrap();
        assert_eq!(back, *content);
    }

    /// A mock file of `size` bytes that records every READ (offset, length).
    type ReadLog = Arc<Mutex<Vec<(u64, u32)>>>;

    fn recording_file(size: u64) -> (ExecSftp, ReadLog) {
        let log = Arc::new(Mutex::new(Vec::new()));
        let l = log.clone();
        let sftp = mock(move |kind, id, payload| {
            if kind != FXP_READ {
                return valid_reply(kind, id);
            }
            let mut cur = Cursor::new(payload);
            cur.string().unwrap();
            let off = cur.u64().unwrap();
            let len = cur.u32().unwrap();
            l.lock().unwrap().push((off, len));
            let mut b = Vec::new();
            if off >= size {
                put_u32(&mut b, FX_EOF);
                put_str(&mut b, b"eof");
                put_str(&mut b, b"");
                return packet(FXP_STATUS, Some(id), &b);
            }
            let n = (size - off).min(u64::from(len)) as usize;
            put_str(&mut b, &vec![1u8; n]);
            packet(FXP_DATA, Some(id), &b)
        });
        (sftp, log)
    }

    #[test]
    fn read_ahead_stays_inside_a_range_read_like_the_driver_does() {
        // The driver's sftp_read_range sizes each buffer so that libssh2's
        // read-ahead (4x the buffer, from where the call starts) ends at the
        // range end; compatibility mode must do the same.
        for (offset, length) in [
            (0u64, 256 * 1024u64),
            (1_000_003, 1024 * 1024),
            (0, 4 * 1024 * 1024),
            (16 * 1024 * 1024, 8 * 1024 * 1024),
        ] {
            let (sftp, log) = recording_file(64 * 1024 * 1024);
            let mut f = sftp.open(Path::new("/f")).unwrap();
            f.seek(SeekFrom::Start(offset)).unwrap();
            let mut buf = vec![0u8; 2 * 1024 * 1024];
            let mut remaining = length;
            while remaining > 0 {
                let want = (remaining / 4)
                    .clamp(32 * 1024, 2 * 1024 * 1024)
                    .min(remaining) as usize;
                let n = f.read(&mut buf[..want]).unwrap();
                assert!(n > 0);
                remaining -= n as u64;
            }
            drop(f);
            let requested_end = log
                .lock()
                .unwrap()
                .iter()
                .map(|(o, l)| o + u64::from(*l))
                .max()
                .unwrap();
            let past_end = requested_end.saturating_sub(offset + length);
            // Only the 32 KiB minimum buffer of the last reads may reach past it.
            assert!(
                past_end <= 128 * 1024,
                "range {offset}+{length}: requested {past_end} bytes past the end"
            );
        }
    }

    #[test]
    fn offsets_near_the_end_of_u64_do_not_overflow() {
        let (sftp, log) = recording_file(1024);
        let mut f = sftp.open(Path::new("/f")).unwrap();
        f.seek(SeekFrom::Start(u64::MAX - 10)).unwrap();
        let mut buf = [0u8; 1];
        let _ = f.read(&mut buf);
        assert!(log.lock().unwrap().len() <= 1, "{:?}", log.lock().unwrap());
        let _ = f.write(b"x");
    }

    #[test]
    fn a_dead_server_reads_as_a_lost_connection() {
        // sftp-server exits: the stream ends.
        let dead = mock(|_, _, _| Vec::new());
        for _ in 0..2 {
            assert_eq!(
                dead.stat(Path::new("/")).unwrap_err().code(),
                ErrorCode::Session(ERR_SOCKET_RECV)
            );
        }
        assert!(dead.is_broken());
    }

    #[test]
    fn a_failed_read_does_not_leave_stale_read_ahead() {
        // The first READ gets a STATUS with a truncated body; the next read
        // must start again at the same position.
        let first = Arc::new(Mutex::new(true));
        let sftp = mock(move |kind, id, payload| {
            if kind != FXP_READ {
                return valid_reply(kind, id);
            }
            if std::mem::replace(&mut *first.lock().unwrap(), false) {
                return packet(FXP_STATUS, Some(id), &[0, 0]);
            }
            let mut cur = Cursor::new(payload);
            cur.string().unwrap();
            let off = cur.u64().unwrap();
            let len = cur.u32().unwrap();
            let mut b = Vec::new();
            put_str(&mut b, &vec![(off % 251) as u8; len as usize]);
            packet(FXP_DATA, Some(id), &b)
        });
        let mut f = sftp.open(Path::new("/f")).unwrap();
        let mut buf = vec![0u8; 100_000];
        assert!(f.read(&mut buf).is_err());
        assert_eq!(f.stream_position().unwrap(), 0);
        let n = f.read(&mut buf).unwrap();
        assert!(n > 0);
        assert_eq!(buf[0], 0, "data must come from offset 0");
    }
}

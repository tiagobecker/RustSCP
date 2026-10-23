//! SSH host key verification against OpenSSH `known_hosts` files
//! (trust on first use).
//!
//! RustSCP keeps its own `known_hosts` file in OpenSSH format at
//! `get_rustscp_config_dir()/known_hosts` and also consults the user's
//! `~/.ssh/known_hosts` read-only, so hosts already trusted by OpenSSH are
//! recognised and a changed key is caught.
//!
//! The parser is our own instead of libssh2's (`ssh2::KnownHosts`) because
//! libssh2 stops reading a file at the first line it does not understand
//! (`@cert-authority`, `@revoked`, newer key types), ignores the key type when
//! comparing (a host known only by its RSA key would look "changed" when the
//! server offers Ed25519), and falls back from `[host]:port` to the bare host
//! for non-22 ports, which OpenSSH never does.

use crate::types::{CoreError, CoreResult};
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use base64::Engine as _;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Serializes "check, then append" on RustSCP's known_hosts file so two tabs
/// connecting to the same new host do not both append a key for it.
static APP_FILE_LOCK: Mutex<()> = Mutex::new(());

/// OpenSSH-style SHA-256 fingerprint: `SHA256:<base64 without padding>`,
/// exactly what `ssh-keygen -lf` prints.
pub fn fingerprint_sha256(key_blob: &[u8]) -> String {
    let digest = Sha256::digest(key_blob);
    format!("SHA256:{}", STANDARD_NO_PAD.encode(digest))
}

/// Key type stored at the start of an SSH public key blob (e.g. `ssh-ed25519`).
pub fn key_type_of_blob(blob: &[u8]) -> Option<String> {
    if blob.len() < 4 {
        return None;
    }
    let len = u32::from_be_bytes([blob[0], blob[1], blob[2], blob[3]]) as usize;
    let name = blob.get(4..4usize.checked_add(len)?)?;
    std::str::from_utf8(name).ok().map(str::to_string)
}

/// The host name OpenSSH writes to known_hosts: `host` for port 22 and
/// `[host]:port` otherwise. Host names are matched case-insensitively.
pub fn known_hosts_host_name(host: &str, port: u16) -> String {
    let h = host
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    if port == 22 || port == 0 {
        h
    } else {
        format!("[{}]:{}", h, port)
    }
}

/// One line of a known_hosts file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnownHostEntry {
    /// 1-based line number in the file.
    pub line: usize,
    pub marker: KnownHostMarker,
    /// Raw host field: comma separated patterns or a hashed `|1|salt|hash`.
    pub hosts: String,
    pub key_type: String,
    pub key_blob: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KnownHostMarker {
    None,
    Revoked,
    CertAuthority,
}

/// Parse OpenSSH known_hosts content. Comments, blank lines and malformed
/// lines are skipped instead of aborting the whole file.
pub fn parse_known_hosts(contents: &str) -> Vec<KnownHostEntry> {
    let mut out = Vec::new();
    for (idx, raw_line) in contents.lines().enumerate() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut fields = line.split_whitespace();
        let mut first = match fields.next() {
            Some(f) => f,
            None => continue,
        };
        let marker = if let Some(m) = first.strip_prefix('@') {
            let marker = match m {
                "revoked" => KnownHostMarker::Revoked,
                "cert-authority" => KnownHostMarker::CertAuthority,
                _ => continue,
            };
            first = match fields.next() {
                Some(f) => f,
                None => continue,
            };
            marker
        } else {
            KnownHostMarker::None
        };
        let (key_type, key_b64) = match (fields.next(), fields.next()) {
            (Some(t), Some(k)) => (t, k),
            _ => continue,
        };
        let key_blob = match STANDARD
            .decode(key_b64)
            .or_else(|_| STANDARD_NO_PAD.decode(key_b64))
        {
            Ok(b) => b,
            Err(_) => continue,
        };
        out.push(KnownHostEntry {
            line: idx + 1,
            marker,
            hosts: first.to_string(),
            key_type: key_type.to_string(),
            key_blob,
        });
    }
    out
}

/// Does the host field of an entry match `lookup` (as built by
/// [`known_hosts_host_name`])? Supports hashed names, comma lists, `*`/`?`
/// wildcards and `!` negation, like OpenSSH.
pub fn host_field_matches(hosts: &str, lookup: &str) -> bool {
    let lookup = lookup.to_ascii_lowercase();
    if let Some(rest) = hosts.strip_prefix("|1|") {
        let mut parts = rest.splitn(2, '|');
        let (salt_b64, hash_b64) = match (parts.next(), parts.next()) {
            (Some(s), Some(h)) => (s, h),
            _ => return false,
        };
        let (salt, hash) = match (STANDARD.decode(salt_b64), STANDARD.decode(hash_b64)) {
            (Ok(s), Ok(h)) => (s, h),
            _ => return false,
        };
        return hmac_sha1(&salt, lookup.as_bytes())[..] == hash[..];
    }

    let mut positive = false;
    for pattern in hosts.split(',').filter(|p| !p.is_empty()) {
        let (negated, pat) = match pattern.strip_prefix('!') {
            Some(p) => (true, p),
            None => (false, pattern),
        };
        if glob_match(&pat.to_ascii_lowercase(), &lookup) {
            if negated {
                return false;
            }
            positive = true;
        }
    }
    positive
}

/// Minimal `*` / `?` glob matcher (OpenSSH `match_pattern`).
fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti) = (0usize, 0usize);
    let mut star: Option<(usize, usize)> = None;
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some((pi, ti));
            pi += 1;
        } else if let Some((sp, st)) = star {
            pi = sp + 1;
            ti = st + 1;
            star = Some((sp, st + 1));
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// Result of looking a presented host key up in one known_hosts file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KnownHostsStatus {
    /// An entry for this host has exactly this key.
    Match,
    /// The key is listed under `@revoked`.
    Revoked { line: usize },
    /// The host is listed, but with a different key.
    Mismatch { line: usize, known_key_type: String },
    /// The host is not listed at all.
    NotFound,
}

/// Decide what a known_hosts file says about `key_blob` for `lookup`.
pub fn check_known_hosts(contents: &str, lookup: &str, key_blob: &[u8]) -> KnownHostsStatus {
    let entries = parse_known_hosts(contents);
    for e in &entries {
        if e.marker == KnownHostMarker::Revoked
            && e.key_blob == key_blob
            && host_field_matches(&e.hosts, lookup)
        {
            return KnownHostsStatus::Revoked { line: e.line };
        }
    }
    let mut mismatch = None;
    for e in &entries {
        if e.marker != KnownHostMarker::None || !host_field_matches(&e.hosts, lookup) {
            continue;
        }
        if e.key_blob == key_blob {
            return KnownHostsStatus::Match;
        }
        if mismatch.is_none() {
            mismatch = Some(KnownHostsStatus::Mismatch {
                line: e.line,
                known_key_type: key_type_of_blob(&e.key_blob).unwrap_or_else(|| e.key_type.clone()),
            });
        }
    }
    mismatch.unwrap_or(KnownHostsStatus::NotFound)
}

/// Key types (from the key blobs) recorded for `lookup`, in file order.
pub fn known_key_types(contents: &str, lookup: &str) -> Vec<String> {
    let mut types = Vec::new();
    for e in parse_known_hosts(contents) {
        if e.marker != KnownHostMarker::None || !host_field_matches(&e.hosts, lookup) {
            continue;
        }
        let t = key_type_of_blob(&e.key_blob).unwrap_or(e.key_type);
        if !types.contains(&t) {
            types.push(t);
        }
    }
    types
}

/// libssh2 host key method names that produce a key of the given blob type,
/// used to make a server we already know present that same key type.
pub fn host_key_methods_for_key_type(key_type: &str) -> &'static [&'static str] {
    match key_type {
        "ssh-ed25519" => &["ssh-ed25519"],
        "ecdsa-sha2-nistp256" => &["ecdsa-sha2-nistp256"],
        "ecdsa-sha2-nistp384" => &["ecdsa-sha2-nistp384"],
        "ecdsa-sha2-nistp521" => &["ecdsa-sha2-nistp521"],
        "ssh-rsa" => &["rsa-sha2-512", "rsa-sha2-256", "ssh-rsa"],
        "ssh-dss" => &["ssh-dss"],
        _ => &[],
    }
}

/// One `known_hosts` line for a newly trusted key (plain host name, OpenSSH format).
pub fn known_hosts_line(host: &str, port: u16, key_blob: &[u8]) -> String {
    let key_type = key_type_of_blob(key_blob).unwrap_or_else(|| "ssh-unknown".to_string());
    format!(
        "{} {} {}",
        known_hosts_host_name(host, port),
        key_type,
        STANDARD.encode(key_blob)
    )
}

/// Home directory from the environment (HOME, then USERPROFILE on Windows).
pub fn home_dir() -> Option<PathBuf> {
    for var in ["HOME", "USERPROFILE"] {
        if let Ok(v) = std::env::var(var) {
            if !v.is_empty() {
                return Some(PathBuf::from(v));
            }
        }
    }
    None
}

/// Expand a leading `~` (`~`, `~/x`, `~\x`) to the user's home directory.
pub fn expand_tilde(path: &str) -> PathBuf {
    let trimmed = path.trim();
    if trimmed == "~" {
        if let Some(h) = home_dir() {
            return h;
        }
    } else if let Some(rest) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
    {
        if let Some(h) = home_dir() {
            return h.join(rest);
        }
    }
    PathBuf::from(trimmed)
}

/// What [`HostKeyStore::verify`] decided for an accepted key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostKeyVerdict {
    /// The key is already recorded in this file.
    Known { file: PathBuf },
    /// First connection to this host: the key was recorded in this file.
    NewlyTrusted { file: PathBuf },
    /// First connection, but the key could not be saved (the connection is
    /// still allowed; it will be trusted on first use again next time).
    TrustedNotSaved { reason: String },
}

/// The known_hosts files consulted for host key verification.
#[derive(Debug, Clone)]
pub struct HostKeyStore {
    /// RustSCP's own file; new keys are recorded here.
    pub app_file: PathBuf,
    /// Files consulted read-only (the user's `~/.ssh/known_hosts`).
    pub read_only_files: Vec<PathBuf>,
}

impl HostKeyStore {
    pub fn new(app_file: PathBuf, read_only_files: Vec<PathBuf>) -> Self {
        Self {
            app_file,
            read_only_files,
        }
    }

    /// RustSCP's known_hosts plus the user's `~/.ssh/known_hosts`.
    pub fn for_current_user() -> Self {
        let app_file = crate::vault::get_rustscp_config_dir().join("known_hosts");
        let mut read_only = Vec::new();
        if let Some(home) = home_dir() {
            read_only.push(home.join(".ssh").join("known_hosts"));
        }
        Self::new(app_file, read_only)
    }

    fn files(&self) -> impl Iterator<Item = &PathBuf> {
        std::iter::once(&self.app_file).chain(self.read_only_files.iter())
    }

    fn read(path: &Path) -> String {
        match std::fs::read(path) {
            Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Err(e) => {
                if e.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!("Could not read known_hosts file {}: {}", path.display(), e);
                }
                String::new()
            }
        }
    }

    /// Key types already recorded for host:port in any file.
    pub fn known_key_types(&self, host: &str, port: u16) -> Vec<String> {
        let lookup = known_hosts_host_name(host, port);
        let mut types = Vec::new();
        for f in self.files() {
            for t in known_key_types(&Self::read(f), &lookup) {
                if !types.contains(&t) {
                    types.push(t);
                }
            }
        }
        types
    }

    /// Host keys recorded for host:port in any file (plain entries, in file order, each
    /// once). A key that any file lists as `@revoked` for the host is left out.
    pub fn host_keys(&self, host: &str, port: u16) -> Vec<Vec<u8>> {
        let lookup = known_hosts_host_name(host, port);
        let entries: Vec<KnownHostEntry> = self
            .files()
            .flat_map(|f| parse_known_hosts(&Self::read(f)))
            .filter(|e| host_field_matches(&e.hosts, &lookup))
            .collect();
        let mut keys: Vec<Vec<u8>> = Vec::new();
        for e in &entries {
            let revoked = entries
                .iter()
                .any(|r| r.marker == KnownHostMarker::Revoked && r.key_blob == e.key_blob);
            if e.marker == KnownHostMarker::None && !revoked && !keys.contains(&e.key_blob) {
                keys.push(e.key_blob.clone());
            }
        }
        keys
    }

    /// Records host keys a shared connection vouches for (see [`crate::share`]) before
    /// the first connection, so the server is checked against them instead of being
    /// trusted on first use. Keys already recorded are skipped; returns how many were
    /// added. Nothing is written, and [`CoreError::HostKeyMismatch`] is returned, when a
    /// key is listed as `@revoked`, or when this computer already knows the server only
    /// by other keys: the file and this computer disagree about who the server is.
    pub fn trust_shared_keys(&self, host: &str, port: u16, keys: &[Vec<u8>]) -> CoreResult<usize> {
        if keys.is_empty() {
            return Ok(0);
        }
        let lookup = known_hosts_host_name(host, port);
        let _guard = APP_FILE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let _file_lock = self.lock_app_file_across_processes();

        let mut known: Vec<Vec<u8>> = Vec::new();
        for file in self.files() {
            for e in parse_known_hosts(&Self::read(file)) {
                if !host_field_matches(&e.hosts, &lookup) {
                    continue;
                }
                match e.marker {
                    KnownHostMarker::Revoked if keys.contains(&e.key_blob) => {
                        return Err(CoreError::HostKeyMismatch(format!(
                            "the shared connection vouches for the host key {} of {}, but {} \
                             (line {}) marks that key @revoked. Nothing was changed.",
                            fingerprint_sha256(&e.key_blob),
                            lookup,
                            file.display(),
                            e.line
                        )));
                    }
                    KnownHostMarker::None => known.push(e.key_blob),
                    _ => {}
                }
            }
        }
        let new: Vec<&Vec<u8>> = keys.iter().filter(|k| !known.contains(k)).collect();
        if !known.is_empty() && new.len() == keys.len() {
            return Err(CoreError::HostKeyMismatch(format!(
                "this computer already knows {} by the host key {}, but the shared connection \
                 says the server's key is {}. Someone may be intercepting one of the \
                 connections, or the server's key was replaced. Ask the sender to confirm \
                 the server's key; nothing was changed.",
                lookup,
                fingerprint_sha256(&known[0]),
                fingerprint_sha256(&keys[0])
            )));
        }
        for key in &new {
            append_line(&self.app_file, &known_hosts_line(host, port, key))?;
        }
        Ok(new.len())
    }

    /// Exclusive advisory lock on `<app_file>.lock`, shared with other
    /// RustSCP processes (desktop app, MCP gateway). Best effort: None when
    /// the lock file cannot be opened or locked (the in-process lock still
    /// applies). Released when the returned file is dropped.
    fn lock_app_file_across_processes(&self) -> Option<std::fs::File> {
        let mut name = self.app_file.as_os_str().to_owned();
        name.push(".lock");
        let lock_path = PathBuf::from(name);
        if let Some(parent) = lock_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let mut opts = std::fs::OpenOptions::new();
        opts.create(true).truncate(false).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let file = match opts.open(&lock_path) {
            Ok(f) => f,
            Err(e) => {
                tracing::debug!(
                    "Could not open known_hosts lock file {}: {}",
                    lock_path.display(),
                    e
                );
                return None;
            }
        };
        match file.lock() {
            Ok(()) => Some(file),
            Err(e) => {
                tracing::debug!(
                    "Could not lock known_hosts lock file {}: {}",
                    lock_path.display(),
                    e
                );
                None
            }
        }
    }

    /// Verify the key a server presented. Must run before any credentials
    /// are sent. Unknown hosts are recorded (trust on first use); a changed
    /// or revoked key is refused with [`CoreError::HostKeyMismatch`].
    ///
    /// The whole read-check-append sequence runs under one lock (in-process
    /// and, best effort, across RustSCP processes), so two simultaneous first
    /// connections presenting different keys cannot both be recorded: the
    /// second one sees the first one's key and is refused as a mismatch.
    pub fn verify(&self, host: &str, port: u16, key_blob: &[u8]) -> CoreResult<HostKeyVerdict> {
        let lookup = known_hosts_host_name(host, port);
        let fingerprint = fingerprint_sha256(key_blob);
        let key_type = key_type_of_blob(key_blob).unwrap_or_else(|| "unknown".to_string());

        let _guard = APP_FILE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let _file_lock = self.lock_app_file_across_processes();

        let mut mismatch: Option<(PathBuf, usize, String)> = None;
        for file in self.files() {
            match check_known_hosts(&Self::read(file), &lookup, key_blob) {
                KnownHostsStatus::Revoked { line } => {
                    return Err(CoreError::HostKeyMismatch(format!(
                        "the {} host key {} presented by {} is marked @revoked in {} (line {}). \
                         The connection was refused and no credentials were sent.",
                        key_type,
                        fingerprint,
                        lookup,
                        file.display(),
                        line
                    )));
                }
                KnownHostsStatus::Match => {
                    return Ok(HostKeyVerdict::Known { file: file.clone() });
                }
                KnownHostsStatus::Mismatch {
                    line,
                    known_key_type,
                } => {
                    if mismatch.is_none() {
                        mismatch = Some((file.clone(), line, known_key_type));
                    }
                }
                KnownHostsStatus::NotFound => {}
            }
        }

        if let Some((file, line, known_key_type)) = mismatch {
            return Err(CoreError::HostKeyMismatch(format!(
                "the server {} presented the {} host key {}, but {} (line {}) records a \
                 different {} key for this host. Someone may be intercepting the connection \
                 (man-in-the-middle attack), or the server's host key was replaced. \
                 No credentials were sent. If you are sure the new key is legitimate, \
                 delete line {} for {} from {} and connect again.",
                lookup,
                key_type,
                fingerprint,
                file.display(),
                line,
                known_key_type,
                line,
                lookup,
                file.display()
            )));
        }

        // Trust on first use: record the key in RustSCP's own file (still
        // under the lock taken before the files were read).
        match append_line(&self.app_file, &known_hosts_line(host, port, key_blob)) {
            Ok(()) => {
                tracing::info!(
                    "Trusting new SSH host key for {}: {} {} (recorded in {})",
                    lookup,
                    key_type,
                    fingerprint,
                    self.app_file.display()
                );
                Ok(HostKeyVerdict::NewlyTrusted {
                    file: self.app_file.clone(),
                })
            }
            Err(e) => {
                tracing::warn!(
                    "Trusting new SSH host key for {}: {} {}, but it could not be saved to {}: {}",
                    lookup,
                    key_type,
                    fingerprint,
                    self.app_file.display(),
                    e
                );
                Ok(HostKeyVerdict::TrustedNotSaved {
                    reason: e.to_string(),
                })
            }
        }
    }
}

fn append_line(path: &Path, line: &str) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let needs_newline = match std::fs::read(path) {
        Ok(existing) => !existing.is_empty() && !existing.ends_with(b"\n"),
        Err(_) => false,
    };
    let mut opts = std::fs::OpenOptions::new();
    opts.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(path)?;
    if needs_newline {
        f.write_all(b"\n")?;
    }
    f.write_all(line.as_bytes())?;
    f.write_all(b"\n")?;
    f.sync_all()
}

/// SHA-1 (FIPS 180-4). Only used to match OpenSSH's hashed known_hosts host
/// names (HMAC-SHA1); never for anything security sensitive on its own.
fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [
        0x6745_2301,
        0xEFCD_AB89,
        0x98BA_DCFE,
        0x1032_5476,
        0xC3D2_E1F0,
    ];
    let bit_len = (data.len() as u64).wrapping_mul(8);
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());

    for block in msg.chunks_exact(64) {
        let mut w = [0u32; 80];
        for (i, word) in block.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let (mut a, mut b, mut c, mut d, mut e) = (h[0], h[1], h[2], h[3], h[4]);
        for (i, wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | ((!b) & d), 0x5A82_7999),
                20..=39 => (b ^ c ^ d, 0x6ED9_EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1B_BCDC),
                _ => (b ^ c ^ d, 0xCA62_C1D6),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }

    let mut out = [0u8; 20];
    for (i, v) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&v.to_be_bytes());
    }
    out
}

/// HMAC-SHA1 (RFC 2104).
fn hmac_sha1(key: &[u8], msg: &[u8]) -> [u8; 20] {
    let mut k = [0u8; 64];
    if key.len() > 64 {
        k[..20].copy_from_slice(&sha1(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut inner = Vec::with_capacity(64 + msg.len());
    inner.extend(k.iter().map(|b| b ^ 0x36));
    inner.extend_from_slice(msg);
    let inner_hash = sha1(&inner);
    let mut outer = Vec::with_capacity(84);
    outer.extend(k.iter().map(|b| b ^ 0x5c));
    outer.extend_from_slice(&inner_hash);
    sha1(&outer)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Generated with `ssh-keygen -t ed25519`; fingerprints from `ssh-keygen -lf`.
    const K1: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIDjP1T3SNNFtakzf0Bd1wYt9gyUG1LIfsIsG1pTC7g1l";
    const K1_FP: &str = "SHA256:JUVAlywPEwm1vZbR/js6Q1gABDMqjfwxpy4iYjDQdzQ";
    const K2: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIFohHsQCs7gH40DA/cvCUNMjR1Fog2zefhwLIklmS7LA";
    // `ssh-keygen -H` of "example.com <K1>" and "[example.com]:2222 <K2>".
    const K1_HASHED_HOST: &str = "|1|gDcFAn107/slorOiW2sf097nyWE=|M4K9/Bl4fsY43XMEMpKRcDfIpSI=";
    const K2_HASHED_HOST: &str = "|1|0tEQTuxtHvh7cYEzsL5KubQKJaM=|z/rO5jX2dTVhLheI0JQy6duipgg=";

    fn blob(b64: &str) -> Vec<u8> {
        STANDARD.decode(b64).unwrap()
    }

    fn fake_rsa_blob() -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(&7u32.to_be_bytes());
        b.extend_from_slice(b"ssh-rsa");
        b.extend_from_slice(&[1, 2, 3, 4, 5]);
        b
    }

    #[test]
    fn sha1_and_hmac_vectors() {
        assert_eq!(
            hex::encode(sha1(b"abc")),
            "a9993e364706816aba3e25717850c26c9cd0d89d"
        );
        assert_eq!(
            hex::encode(sha1(b"")),
            "da39a3ee5e6b4b0d3255bfef95601890afd80709"
        );
        // RFC 2202 test case 1 and 2.
        assert_eq!(
            hex::encode(hmac_sha1(&[0x0b; 20], b"Hi There")),
            "b617318655057264e28bc0b6fb378c8ef146be00"
        );
        assert_eq!(
            hex::encode(hmac_sha1(b"Jefe", b"what do ya want for nothing?")),
            "effcdf6ae5eb2fa2d27416d5f184df9c259a7c79"
        );
    }

    #[test]
    fn fingerprint_matches_ssh_keygen() {
        assert_eq!(fingerprint_sha256(&blob(K1)), K1_FP);
        assert_eq!(key_type_of_blob(&blob(K1)).as_deref(), Some("ssh-ed25519"));
    }

    #[test]
    fn host_names_follow_openssh_port_rules() {
        assert_eq!(known_hosts_host_name("Example.COM", 22), "example.com");
        assert_eq!(
            known_hosts_host_name("example.com", 2222),
            "[example.com]:2222"
        );
        assert_eq!(known_hosts_host_name("::1", 2200), "[::1]:2200");
    }

    #[test]
    fn plain_match_mismatch_and_not_found() {
        let file = format!("# comment\nexample.com ssh-ed25519 {K1} me@host\n");
        assert_eq!(
            check_known_hosts(&file, "example.com", &blob(K1)),
            KnownHostsStatus::Match
        );
        assert_eq!(
            check_known_hosts(&file, "example.com", &blob(K2)),
            KnownHostsStatus::Mismatch {
                line: 2,
                known_key_type: "ssh-ed25519".into()
            }
        );
        assert_eq!(
            check_known_hosts(&file, "other.com", &blob(K1)),
            KnownHostsStatus::NotFound
        );
        // A non-22 port never falls back to the bare host entry.
        assert_eq!(
            check_known_hosts(&file, "[example.com]:2222", &blob(K2)),
            KnownHostsStatus::NotFound
        );
    }

    #[test]
    fn bracketed_port_lists_wildcards_and_negation() {
        let file = format!(
            "[example.com]:2222,alias ssh-ed25519 {K2}\n*.corp.lan,!bad.corp.lan ssh-ed25519 {K1}\n"
        );
        assert_eq!(
            check_known_hosts(&file, "[example.com]:2222", &blob(K2)),
            KnownHostsStatus::Match
        );
        assert_eq!(
            check_known_hosts(&file, "alias", &blob(K2)),
            KnownHostsStatus::Match
        );
        assert_eq!(
            check_known_hosts(&file, "srv.corp.lan", &blob(K1)),
            KnownHostsStatus::Match
        );
        assert_eq!(
            check_known_hosts(&file, "bad.corp.lan", &blob(K1)),
            KnownHostsStatus::NotFound
        );
    }

    #[test]
    fn hashed_entries_are_matched() {
        let file =
            format!("{K1_HASHED_HOST} ssh-ed25519 {K1}\n{K2_HASHED_HOST} ssh-ed25519 {K2}\n");
        assert_eq!(
            check_known_hosts(&file, "example.com", &blob(K1)),
            KnownHostsStatus::Match
        );
        assert_eq!(
            check_known_hosts(&file, "[example.com]:2222", &blob(K2)),
            KnownHostsStatus::Match
        );
        assert!(matches!(
            check_known_hosts(&file, "example.com", &blob(K2)),
            KnownHostsStatus::Mismatch { line: 1, .. }
        ));
        assert_eq!(
            check_known_hosts(&file, "example.org", &blob(K1)),
            KnownHostsStatus::NotFound
        );
    }

    #[test]
    fn markers_and_garbage_lines_do_not_break_parsing() {
        let file = format!(
            "@cert-authority *.example.com ssh-ed25519 {K2}\n\
             this line is broken\n\
             host-x sk-ssh-ed25519@openssh.com !!notbase64!!\n\
             @revoked * ssh-ed25519 {K2}\n\
             example.com ssh-ed25519 {K1}\n"
        );
        assert_eq!(
            check_known_hosts(&file, "example.com", &blob(K1)),
            KnownHostsStatus::Match
        );
        assert_eq!(
            check_known_hosts(&file, "anything", &blob(K2)),
            KnownHostsStatus::Revoked { line: 4 }
        );
    }

    #[test]
    fn known_key_types_lists_each_type_once() {
        let rsa = STANDARD.encode(fake_rsa_blob());
        let file = format!(
            "example.com ssh-ed25519 {K1}\nexample.com ssh-rsa {rsa}\nexample.com ssh-ed25519 {K2}\n"
        );
        assert_eq!(
            known_key_types(&file, "example.com"),
            vec!["ssh-ed25519".to_string(), "ssh-rsa".to_string()]
        );
        assert!(host_key_methods_for_key_type("ssh-rsa").contains(&"rsa-sha2-256"));
    }

    #[test]
    fn verify_records_unknown_host_then_refuses_changed_key() {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path().join("cfg").join("known_hosts");
        let user = dir.path().join("user_known_hosts");
        std::fs::write(&user, format!("[pinned.example]:2200 ssh-ed25519 {K2}\n")).unwrap();
        let store = HostKeyStore::new(app.clone(), vec![user]);

        // First use: recorded in the app file.
        let v = store.verify("New.Example", 22, &blob(K1)).unwrap();
        assert_eq!(v, HostKeyVerdict::NewlyTrusted { file: app.clone() });
        let saved = std::fs::read_to_string(&app).unwrap();
        assert_eq!(saved, format!("new.example ssh-ed25519 {K1}\n"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&app).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }

        // Second use: known.
        assert_eq!(
            store.verify("new.example", 22, &blob(K1)).unwrap(),
            HostKeyVerdict::Known { file: app.clone() }
        );

        // Changed key: refused, message names fingerprint and file.
        let err = store.verify("new.example", 22, &blob(K2)).unwrap_err();
        let msg = err.to_string();
        assert!(matches!(err, CoreError::HostKeyMismatch(_)));
        assert!(msg.contains(&fingerprint_sha256(&blob(K2))), "{msg}");
        assert!(msg.contains(&app.display().to_string()), "{msg}");

        // Entry from the user's ~/.ssh/known_hosts on a custom port.
        assert!(matches!(
            store.verify("pinned.example", 2200, &blob(K2)).unwrap(),
            HostKeyVerdict::Known { .. }
        ));
        let err = store.verify("pinned.example", 2200, &blob(K1)).unwrap_err();
        assert!(err.to_string().contains("user_known_hosts"));
        assert_eq!(
            store.known_key_types("pinned.example", 2200),
            vec!["ssh-ed25519"]
        );
        assert!(store.known_key_types("pinned.example", 22).is_empty());
    }

    #[test]
    fn host_keys_lists_trusted_keys_of_one_host() {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path().join("known_hosts");
        let user = dir.path().join("user_known_hosts");
        std::fs::write(
            &app,
            format!("srv.example ssh-ed25519 {K1}\nother.example ssh-ed25519 {K2}\n"),
        )
        .unwrap();
        std::fs::write(
            &user,
            format!("{K1_HASHED_HOST} ssh-ed25519 {K1}\n[srv.example]:2222 ssh-ed25519 {K2}\n"),
        )
        .unwrap();
        let store = HostKeyStore::new(app.clone(), vec![user.clone()]);
        assert_eq!(store.host_keys("SRV.example", 22), vec![blob(K1)]);
        assert_eq!(store.host_keys("srv.example", 2222), vec![blob(K2)]);
        // Hashed names in ~/.ssh/known_hosts are matched too.
        assert_eq!(store.host_keys("example.com", 22), vec![blob(K1)]);
        assert!(store.host_keys("unknown.example", 22).is_empty());

        std::fs::write(&user, format!("@revoked srv.example ssh-ed25519 {K1}\n")).unwrap();
        assert!(store.host_keys("srv.example", 22).is_empty());
    }

    #[test]
    fn shared_host_keys_are_pinned_before_the_first_connection() {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path().join("cfg").join("known_hosts");
        let store = HostKeyStore::new(app.clone(), vec![]);

        // Unknown host: the shared key is recorded, then a different key is refused.
        assert_eq!(
            store
                .trust_shared_keys("srv.example", 2222, &[blob(K1)])
                .unwrap(),
            1
        );
        assert_eq!(
            std::fs::read_to_string(&app).unwrap(),
            format!("[srv.example]:2222 ssh-ed25519 {K1}\n")
        );
        assert!(matches!(
            store.verify("srv.example", 2222, &blob(K2)),
            Err(CoreError::HostKeyMismatch(_))
        ));
        assert!(matches!(
            store.verify("srv.example", 2222, &blob(K1)).unwrap(),
            HostKeyVerdict::Known { .. }
        ));

        // Already known with that key: nothing added, extra keys of the server are.
        assert_eq!(
            store
                .trust_shared_keys("srv.example", 2222, &[blob(K1)])
                .unwrap(),
            0
        );
        let rsa = fake_rsa_blob();
        assert_eq!(
            store
                .trust_shared_keys("srv.example", 2222, &[blob(K1), rsa.clone()])
                .unwrap(),
            1
        );
        assert_eq!(store.host_keys("srv.example", 2222), vec![blob(K1), rsa]);

        // Known only by other keys: refused, nothing written.
        let before = std::fs::read_to_string(&app).unwrap();
        let err = store
            .trust_shared_keys("srv.example", 2222, &[blob(K2)])
            .unwrap_err();
        assert!(matches!(err, CoreError::HostKeyMismatch(_)));
        assert!(err.to_string().contains(K1_FP), "{err}");
        assert_eq!(std::fs::read_to_string(&app).unwrap(), before);

        // A revoked key is refused.
        std::fs::write(&app, format!("@revoked revoked.example ssh-ed25519 {K2}\n")).unwrap();
        assert!(store
            .trust_shared_keys("revoked.example", 22, &[blob(K2)])
            .is_err());
        assert_eq!(
            store.trust_shared_keys("revoked.example", 22, &[]).unwrap(),
            0
        );
    }

    #[test]
    fn concurrent_first_use_with_different_keys_trusts_only_one() {
        for _ in 0..50 {
            let dir = tempfile::tempdir().unwrap();
            let app = dir.path().join("cfg").join("known_hosts");
            let store = HostKeyStore::new(app.clone(), vec![]);
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
            let handles: Vec<_> = [K1, K2]
                .into_iter()
                .map(|k| {
                    let store = store.clone();
                    let barrier = barrier.clone();
                    std::thread::spawn(move || {
                        barrier.wait();
                        store.verify("race.example", 22, &blob(k))
                    })
                })
                .collect();
            let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
            let accepted = results.iter().filter(|r| r.is_ok()).count();
            assert_eq!(accepted, 1, "{results:?}");
            assert!(results
                .iter()
                .any(|r| matches!(r, Err(CoreError::HostKeyMismatch(_)))));
            let saved = std::fs::read_to_string(&app).unwrap();
            assert_eq!(saved.lines().count(), 1, "{saved}");
        }
    }

    #[test]
    fn tilde_expansion() {
        if let Some(home) = home_dir() {
            assert_eq!(
                expand_tilde("~/.ssh/id_ed25519"),
                home.join(".ssh/id_ed25519")
            );
            assert_eq!(expand_tilde("~"), home);
        }
        assert_eq!(expand_tilde("/abs/key"), PathBuf::from("/abs/key"));
        assert_eq!(expand_tilde("rel~/key"), PathBuf::from("rel~/key"));
    }
}

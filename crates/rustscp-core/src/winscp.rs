//! Import of the sites stored by WinSCP (`WinSCP.ini`, written by WinSCP's
//! "Export/Backup configuration" or by a portable install).
//!
//! WinSCP keeps every site in a `[Sessions\<folder>/<name>]` section. Section names and
//! values are PuTTY-"munged": unsafe bytes are written as `%XX`, and non-ASCII text is
//! UTF-8 behind an encoded byte-order mark. Stored passwords are only obfuscated (XOR
//! with a constant, prefixed with user name + host), so they can be recovered; when a
//! WinSCP master password is set they are AES-encrypted instead and are not imported.
//! Nor is the password of a session WinSCP opens through a tunnel or proxy, since RustSCP
//! connects to that address directly.
//!
//! Parsing never panics on malformed input, caps the input size and the number of
//! sessions, and never logs anything. The secrets it recovers are only in the returned
//! [`ConnectionConfig`]s, whose `Debug` output redacts them.

use crate::types::{
    normalize_site_group, AuthMethod, ConnectionConfig, CoreError, CoreResult, Protocol,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

/// Largest `WinSCP.ini` accepted (a file with thousands of sites and the whole
/// configuration history stays far below this).
pub const MAX_WINSCP_INI_BYTES: usize = 16 * 1024 * 1024;
/// Most sites taken from one file; the rest are counted in `skipped_sessions`.
pub const MAX_WINSCP_SESSIONS: usize = 10_000;

/// `PWALG_SIMPLE_MAGIC` in WinSCP's `Security.cpp`.
const PW_MAGIC: u8 = 0xA3;
/// `PWALG_SIMPLE_FLAG`: the password is prefixed with user name + host.
const PW_FLAG: u8 = 0xFF;

/// What a `WinSCP.ini` holds, ready to be saved as RustSCP sites.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WinScpImportResult {
    /// Sites found (the length of `sites`).
    pub total_sessions: usize,
    /// Sites whose stored password was recovered.
    pub decrypted_passwords: usize,
    /// Sites that log in with a private key file.
    pub key_auth_sessions: usize,
    /// Every folder that holds a site (`/`-separated, sorted).
    pub folders: Vec<String>,
    pub sites: Vec<ConnectionConfig>,
    /// Sites with a stored password that could not be recovered (master password set,
    /// or a damaged value); they are imported without one.
    #[serde(default)]
    pub undecrypted_passwords: usize,
    /// Key sites whose key is a PuTTY `.ppk` file (read directly, see [`crate::ppk`]).
    #[serde(default)]
    pub ppk_key_sessions: usize,
    /// Key sites whose key file does not exist on this computer.
    #[serde(default)]
    pub missing_key_files: usize,
    /// Key sites whose key file was not looked for. Only files inside the home folder are
    /// checked: opening another path that an imported file names can reach the network
    /// (a `\\host\share` path on Windows logs in to that host with the Windows account).
    #[serde(default)]
    pub unchecked_key_files: usize,
    /// WinSCP protects its passwords with a master password: no password was imported.
    #[serde(default)]
    pub master_password_protected: bool,
    /// Sessions left out: workspace entries that point at a stored site, or sessions
    /// beyond [`MAX_WINSCP_SESSIONS`].
    #[serde(default)]
    pub skipped_sessions: usize,
    /// Sessions that WinSCP opens through an SSH tunnel (jump host) or a proxy. RustSCP
    /// connects to them directly, where the address may belong to another machine (a
    /// private address on another network), so their stored passwords are not imported.
    #[serde(default)]
    pub tunneled_sessions: usize,
    /// Filled by the desktop app's preview of a merge: saved sites that the file points at
    /// another host, user, port or protocol (plain FTP instead of FTPS or SFTP, say). The
    /// password, key passphrase and trusted certificate saved in RustSCP for them are not
    /// kept, so they ask for the password again. Always 0 from the parser.
    #[serde(default)]
    pub endpoint_changed_sessions: usize,
}

// ---------------------------------------------------------------------------
// Text decoding
// ---------------------------------------------------------------------------

/// Windows-1252 characters for the bytes 0x80..=0x9F (the rest equal Latin-1).
const CP1252_HIGH: [char; 32] = [
    '\u{20AC}', '\u{0081}', '\u{201A}', '\u{0192}', '\u{201E}', '\u{2026}', '\u{2020}', '\u{2021}',
    '\u{02C6}', '\u{2030}', '\u{0160}', '\u{2039}', '\u{0152}', '\u{008D}', '\u{017D}', '\u{008F}',
    '\u{0090}', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}', '\u{2022}', '\u{2013}', '\u{2014}',
    '\u{02DC}', '\u{2122}', '\u{0161}', '\u{203A}', '\u{0153}', '\u{009D}', '\u{017E}', '\u{0178}',
];

/// Decodes Windows-1252 ("ANSI" on Western Windows), the fallback for non-UTF-8 text.
fn decode_cp1252(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|&b| match b {
            0x80..=0x9F => CP1252_HIGH[(b - 0x80) as usize],
            _ => b as char,
        })
        .collect()
}

/// UTF-8 when the bytes are valid UTF-8, Windows-1252 otherwise.
fn decode_text(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => decode_cp1252(bytes),
    }
}

fn hex_value(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Reverses WinSCP's (PuTTY's) name/value escaping: `%XX` becomes the byte `XX`
/// (`D1%20-%20web` is `D1 - web`, `C:%5Ckeys` is `C:\keys`). The bytes are UTF-8 when
/// they start with an encoded byte-order mark (how WinSCP writes non-ASCII text) or are
/// valid UTF-8, Windows-1252 otherwise. A malformed `%` stays as it is, and the value
/// ends at an encoded NUL, as in WinSCP.
pub fn url_decode_winscp(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if let (Some(hi), Some(lo)) = (
                bytes.get(i + 1).copied().and_then(hex_value),
                bytes.get(i + 2).copied().and_then(hex_value),
            ) {
                out.push((hi << 4) | lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    if let Some(nul) = out.iter().position(|&b| b == 0) {
        out.truncate(nul);
    }
    match out.strip_prefix(&[0xEF, 0xBB, 0xBF][..]) {
        Some(utf8) => String::from_utf8_lossy(utf8).into_owned(),
        None => decode_text(&out),
    }
}

/// Decodes the bytes of a `WinSCP.ini`: UTF-8 (with or without BOM), UTF-16 LE/BE with
/// a BOM, or Windows-1252.
pub fn decode_ini_bytes(bytes: &[u8]) -> String {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF][..]) {
        return String::from_utf8_lossy(rest).into_owned();
    }
    let utf16 = |rest: &[u8], le: bool| {
        let units: Vec<u16> = rest
            .chunks_exact(2)
            .map(|c| {
                if le {
                    u16::from_le_bytes([c[0], c[1]])
                } else {
                    u16::from_be_bytes([c[0], c[1]])
                }
            })
            .collect();
        String::from_utf16_lossy(&units)
    };
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE][..]) {
        return utf16(rest, true);
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF][..]) {
        return utf16(rest, false);
    }
    decode_text(bytes)
}

/// Text for a name or folder: control characters removed, surrounding blanks trimmed.
fn clean_label(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .to_string()
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

/// Undoes WinSCP's password obfuscation (`DecryptPassword` in WinSCP's `Security.cpp`).
///
/// `encrypted_hex` is the session's `Password` value; `host` and `username` are the
/// session's (unescaped) `HostName` and `UserName`, which current WinSCP versions put in
/// front of the password. `None` when the value is malformed, truncated, or was not
/// written for this user and host (a master-password-encrypted value, for example).
pub fn decrypt_winscp_password(host: &str, username: &str, encrypted_hex: &str) -> Option<String> {
    let digits: Vec<u8> = encrypted_hex
        .trim()
        .bytes()
        .map(hex_value)
        .collect::<Option<_>>()?;
    if digits.len() < 2 || !digits.len().is_multiple_of(2) {
        return None;
    }
    let mut chars = digits
        .chunks_exact(2)
        .map(|pair| !(((pair[0] << 4) | pair[1]) ^ PW_MAGIC));

    let flag = chars.next()?;
    let length = if flag == PW_FLAG {
        let _internal = chars.next()?;
        chars.next()?
    } else {
        flag
    };
    let shift = chars.next()?;
    for _ in 0..shift {
        chars.next()?;
    }
    let mut clear = Vec::with_capacity(length as usize);
    for _ in 0..length {
        clear.push(chars.next()?);
    }

    let password = if flag == PW_FLAG {
        let key = format!("{username}{host}");
        clear.strip_prefix(key.as_bytes())?.to_vec()
    } else {
        clear
    };
    let password = decode_text(&password);
    // Control characters mean the bytes were not a password (wrong key, damaged value).
    if password.chars().any(|c| c.is_control()) {
        return None;
    }
    Some(password)
}

// ---------------------------------------------------------------------------
// Key files
// ---------------------------------------------------------------------------

/// What [`normalize_key_path`] needs to know about this computer (injected in tests).
struct KeyPathEnv<'a> {
    home: Option<PathBuf>,
    windows: bool,
    is_file: &'a dyn Fn(&Path) -> bool,
}

fn path_is_file(path: &Path) -> bool {
    path.is_file()
}

/// Whether a path starts like a Windows network or device path (`\\host\share`,
/// `//host/share`, `\\?\…`, `\\.\…`), with either separator.
fn is_network_or_device_path(path: &str) -> bool {
    let mut chars = path.chars();
    matches!(
        (chars.next(), chars.next()),
        (Some('/' | '\\'), Some('/' | '\\'))
    )
}

impl KeyPathEnv<'_> {
    fn local() -> KeyPathEnv<'static> {
        KeyPathEnv {
            home: crate::known_hosts::home_dir(),
            windows: cfg!(windows),
            is_file: &path_is_file,
        }
    }

    /// Whether `path` is a file, asked only for a path inside the home folder (no `..`, no
    /// network or device path); `None` when it is not checked. The imported file chooses
    /// its key paths, and a preview must not reach the network or hang: opening
    /// `\\host\share\key` on Windows logs in to that host with the person's Windows
    /// credentials (NTLM), and `/net/host/…` on macOS mounts that host's NFS export.
    fn check_file(&self, path: &Path) -> Option<bool> {
        let home = self.home.as_deref()?;
        let inside_home = !is_network_or_device_path(&path.to_string_lossy())
            && !path.components().any(|c| matches!(c, Component::ParentDir))
            && path.starts_with(home);
        inside_home.then(|| (self.is_file)(path))
    }

    /// Whether a normalized key path names an existing file (`~` expanded); `None` when the
    /// path is not checked (see [`Self::check_file`]).
    fn key_exists(&self, path: &str) -> Option<bool> {
        let rest = if path == "~" {
            Some("")
        } else {
            path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\"))
        };
        if let Some(rest) = rest {
            return self.check_file(&self.home.as_ref()?.join(rest));
        }
        // Outside Windows, a path that is still a Windows (or relative) path after
        // normalization names no file here: nothing to look for.
        if !self.windows && !path.starts_with('/') {
            return Some(false);
        }
        self.check_file(Path::new(path))
    }
}

/// A relative path without `..` (so a candidate stays inside the folder it is joined to).
fn plain_relative(rest: &str) -> Option<&str> {
    let rest = rest.trim_start_matches('/');
    (!rest.is_empty() && !rest.split('/').any(|seg| seg == "..")).then_some(rest)
}

/// Where a Windows key path may be on this computer: the same path under the home
/// folder (a drive or share that maps the Mac home, e.g. `Y:\Library\Mobile Documents`
/// in a VM), the same `.ssh` file, or the same file below `C:\Users\<name>\`.
fn windows_path_candidates(unix_style: &str, home: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let bytes = unix_style.as_bytes();
    let after_root = if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        // `C:/rest`
        Some(&unix_style[2..])
    } else if let Some(unc) = unix_style.strip_prefix("//") {
        // `//server/share/rest`
        unc.splitn(3, '/').nth(2)
    } else {
        None
    };
    if let Some(rest) = after_root.and_then(plain_relative) {
        out.push(home.join(rest));
    }
    let lower = unix_style.to_ascii_lowercase();
    if let Some(idx) = lower.find("/.ssh/") {
        if let Some(rest) = plain_relative(&unix_style[idx + 1..]) {
            out.push(home.join(rest));
        }
    }
    if let Some(idx) = lower.find("/users/") {
        let below_users = &unix_style[idx + "/users/".len()..];
        if let Some((_, rest)) = below_users.split_once('/') {
            if let Some(rest) = plain_relative(rest) {
                out.push(home.join(rest));
            }
        }
    }
    if let Some(idx) = unix_style.find("Library/Mobile Documents/") {
        if let Some(rest) = plain_relative(&unix_style[idx..]) {
            out.push(home.join(rest));
        }
    }
    out
}

fn normalize_key_path_in(raw: &str, env: &KeyPathEnv<'_>) -> String {
    let decoded = url_decode_winscp(raw.trim());
    let decoded = decoded.trim().trim_matches('"').trim();
    if decoded.is_empty() {
        return String::new();
    }
    if env.windows {
        // WinSCP's own paths work as they are on Windows.
        return decoded.to_string();
    }
    let unix_style = decoded.replace('\\', "/");
    // `~` / `~/...` stay portable: the SSH driver expands them when connecting.
    if unix_style == "~" || unix_style.starts_with("~/") {
        return unix_style;
    }
    if unix_style.starts_with('/') && !unix_style.starts_with("//") {
        return unix_style;
    }
    if let Some(home) = &env.home {
        for candidate in windows_path_candidates(&unix_style, home) {
            if env.check_file(&candidate) == Some(true) {
                return candidate.to_string_lossy().into_owned();
            }
        }
    }
    unix_style
}

/// Whether `path` is a PuTTY private key (`.ppk`), judged by its first bytes, not its
/// name; `false` when the file cannot be read.
pub fn is_putty_private_key(path: &Path) -> bool {
    crate::ppk::is_ppk_file(path)
}

/// Turns the `PublicKeyFile` of a WinSCP session into a key path for this computer:
/// unescaped, unquoted, `~\x` and `\` written with `/` (except on Windows), and a Windows
/// path (`C:\Users\me\.ssh\id`, `Y:\Library\Mobile Documents\...`, `\\server\share\...`)
/// replaced by the same file under the home folder when that file exists. Otherwise the
/// path is returned unchanged, so the person can see and fix it.
pub fn normalize_key_path(raw_path: &str) -> String {
    normalize_key_path_in(raw_path, &KeyPathEnv::local())
}

// ---------------------------------------------------------------------------
// INI parsing
// ---------------------------------------------------------------------------

struct Section {
    name: String,
    /// Lower-case key -> raw value (the first occurrence wins, as on Windows).
    props: HashMap<String, String>,
}

impl Section {
    fn get(&self, key: &str) -> Option<&str> {
        self.props.get(key).map(|v| v.as_str())
    }

    /// Unescaped, trimmed value; `None` when absent or empty.
    fn text(&self, key: &str) -> Option<String> {
        self.get(key)
            .map(|v| url_decode_winscp(v).trim().to_string())
            .filter(|v| !v.is_empty())
    }

    fn flag(&self, key: &str) -> bool {
        matches!(
            self.get(key)
                .map(|v| v.trim().to_ascii_lowercase())
                .as_deref(),
            Some("1" | "true" | "yes" | "on")
        )
    }
}

/// Splits INI text into sections in file order. Repeated sections are merged into the
/// first one; lines outside a section and malformed headers are ignored.
fn split_sections(content: &str) -> Vec<Section> {
    let mut sections: Vec<Section> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut current: Option<usize> = None;
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
            continue;
        }
        if let Some(rest) = line.strip_prefix('[') {
            current = rest.rfind(']').map(|end| {
                let name = rest[..end].trim().to_string();
                let key = name.to_lowercase();
                *index.entry(key).or_insert_with(|| {
                    sections.push(Section {
                        name,
                        props: HashMap::new(),
                    });
                    sections.len() - 1
                })
            });
            continue;
        }
        if let (Some(idx), Some((k, v))) = (current, line.split_once('=')) {
            let key = k.trim().to_ascii_lowercase();
            if !key.is_empty() {
                sections[idx]
                    .props
                    .entry(key)
                    .or_insert_with(|| v.trim().to_string());
            }
        }
    }
    sections
}

/// Stable id of an imported WinSCP site, derived from its stored name, so importing the
/// same file again updates the same sites. Always matches `^[A-Za-z0-9_-]{1,64}$`.
pub fn winscp_site_id(session_path: &str) -> String {
    let digest = Sha256::digest(session_path.trim().to_lowercase().as_bytes());
    format!("winscp-{}", &hex::encode(digest)[..16])
}

/// RustSCP protocol of a WinSCP session (`FSProtocol`, plus `Ftps` for FTP/WebDAV).
fn session_protocol(section: &Section) -> (Protocol, u16) {
    let ftps = section
        .get("ftps")
        .and_then(|v| v.trim().parse::<u8>().ok())
        .unwrap_or(0);
    match section.get("fsprotocol").map(str::trim) {
        // FTP; Ftps=1 is implicit TLS (port 990), 2/3 explicit. Implicit FTPS is imported
        // as FTPS so a TLS site never becomes plain FTP.
        Some("5") => match ftps {
            0 => (Protocol::Ftp, 21),
            1 => (Protocol::Ftps, 990),
            _ => (Protocol::Ftps, 21),
        },
        Some("6") => (Protocol::WebDav, if ftps == 0 { 80 } else { 443 }),
        Some("7") => (Protocol::S3, 443),
        // 0 = SCP, 1 = SFTP (SCP fallback), 2 = SFTP only; WinSCP's default is SFTP.
        _ => (Protocol::Sftp, 22),
    }
}

/// Whether WinSCP opens this session through an SSH tunnel (a jump host, `Tunnel`) or a
/// proxy (`ProxyMethod`; for FTP also an FTP proxy logon, `FtpProxyLogonType`). A setting
/// WinSCP would not read as a number or flag counts as off, as in WinSCP.
fn uses_tunnel_or_proxy(section: &Section, protocol: Protocol) -> bool {
    let on = |key: &str| {
        section.flag(key)
            || section
                .get(key)
                .and_then(|v| v.trim().parse::<i64>().ok())
                .is_some_and(|n| n != 0)
    };
    on("tunnel")
        || on("proxymethod")
        || (matches!(protocol, Protocol::Ftp | Protocol::Ftps) && on("ftpproxylogontype"))
}

/// Counters filled while sessions are turned into sites.
#[derive(Default)]
struct Tally {
    decrypted_passwords: usize,
    undecrypted_passwords: usize,
    key_auth_sessions: usize,
    ppk_key_sessions: usize,
    missing_key_files: usize,
    unchecked_key_files: usize,
    tunneled_sessions: usize,
}

/// How a session logs in. A session WinSCP opens through a tunnel or proxy keeps its key
/// but not its password: RustSCP connects straight to that address, which on another
/// network can be another machine (it is often a private address).
fn session_auth(
    section: &Section,
    protocol: Protocol,
    host: &str,
    username: &str,
    master_password: bool,
    env: &KeyPathEnv<'_>,
    tally: &mut Tally,
) -> AuthMethod {
    let direct = !uses_tunnel_or_proxy(section, protocol);
    if !direct {
        tally.tunneled_sessions += 1;
    }
    if protocol == Protocol::Sftp {
        if let Some(raw_key) = section.get("publickeyfile") {
            let path = normalize_key_path_in(raw_key, env);
            if !path.is_empty() {
                tally.key_auth_sessions += 1;
                if path.to_ascii_lowercase().ends_with(".ppk") {
                    tally.ppk_key_sessions += 1;
                }
                match env.key_exists(&path) {
                    Some(true) => {}
                    Some(false) => tally.missing_key_files += 1,
                    None => tally.unchecked_key_files += 1,
                }
                return AuthMethod::PrivateKey {
                    path,
                    passphrase: None,
                };
            }
        }
    }
    let Some(encrypted) = section.get("password").filter(|v| !v.trim().is_empty()) else {
        return AuthMethod::None;
    };
    if master_password {
        tally.undecrypted_passwords += 1;
        return AuthMethod::None;
    }
    if !direct {
        // Counted in `tunneled_sessions`; the password is not even decrypted.
        return AuthMethod::None;
    }
    match decrypt_winscp_password(host, username, encrypted) {
        Some(password) if !password.is_empty() => {
            tally.decrypted_passwords += 1;
            AuthMethod::Password(password)
        }
        // A stored empty password.
        Some(_) => AuthMethod::None,
        None => {
            tally.undecrypted_passwords += 1;
            AuthMethod::None
        }
    }
}

fn parse_with_env(content: &str, env: &KeyPathEnv<'_>) -> CoreResult<WinScpImportResult> {
    if content.len() > MAX_WINSCP_INI_BYTES {
        return Err(too_large());
    }
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let sections = split_sections(content);

    let master_password = sections.iter().any(|s| {
        s.name.eq_ignore_ascii_case("Configuration\\Security") && s.flag("usemasterpassword")
    });

    let mut sites: Vec<ConnectionConfig> = Vec::new();
    let mut folders: BTreeSet<String> = BTreeSet::new();
    let mut tally = Tally::default();
    let mut skipped = 0usize;

    for section in &sections {
        let Some(raw_path) = section
            .name
            .get(..9)
            .filter(|p| p.eq_ignore_ascii_case("Sessions\\"))
            .map(|_| &section.name[9..])
        else {
            continue;
        };
        // WinSCP's defaults for new sites are not a site, even when they name a host.
        if url_decode_winscp(raw_path)
            .trim()
            .eq_ignore_ascii_case("Default Settings")
        {
            continue;
        }
        // Sections without a host are not sites.
        let Some(host) = section.text("hostname") else {
            continue;
        };
        // A workspace entry that opens a stored site would duplicate that site.
        if section.flag("isworkspace") && section.text("link").is_some() {
            skipped += 1;
            continue;
        }
        if sites.len() >= MAX_WINSCP_SESSIONS {
            skipped += 1;
            continue;
        }

        // `/` separates folders; each part is escaped on its own.
        let mut parts: Vec<String> = raw_path
            .split('/')
            .map(|part| clean_label(&url_decode_winscp(part)))
            .filter(|part| !part.is_empty())
            .collect();
        let name = parts.pop().unwrap_or_else(|| host.clone());
        let group = normalize_site_group(&parts.join("/"));
        if let Some(g) = &group {
            folders.insert(g.clone());
        }

        let username = section.text("username").unwrap_or_default();
        let (protocol, default_port) = session_protocol(section);
        let port = section
            .get("portnumber")
            .and_then(|p| p.trim().parse::<u16>().ok())
            .filter(|p| *p != 0)
            .unwrap_or(default_port);
        let remote_dir = section.text("remotedirectory").unwrap_or_default();
        let remote_root = if protocol == Protocol::S3 {
            // RustSCP opens S3 sites at a bucket: the first part of the folder.
            remote_dir
                .trim_matches('/')
                .split('/')
                .next()
                .unwrap_or("")
                .to_string()
        } else {
            remote_dir
        };
        let auth = session_auth(
            section,
            protocol,
            &host,
            &username,
            master_password,
            env,
            &mut tally,
        );

        sites.push(ConnectionConfig {
            id: winscp_site_id(raw_path),
            name,
            protocol,
            host,
            port,
            username,
            auth,
            remote_root,
            tls_fingerprint: None,
            group,
        });
    }

    Ok(WinScpImportResult {
        total_sessions: sites.len(),
        decrypted_passwords: tally.decrypted_passwords,
        key_auth_sessions: tally.key_auth_sessions,
        folders: folders.into_iter().collect(),
        sites,
        undecrypted_passwords: tally.undecrypted_passwords,
        ppk_key_sessions: tally.ppk_key_sessions,
        missing_key_files: tally.missing_key_files,
        unchecked_key_files: tally.unchecked_key_files,
        master_password_protected: master_password,
        skipped_sessions: skipped,
        tunneled_sessions: tally.tunneled_sessions,
        endpoint_changed_sessions: 0,
    })
}

fn too_large() -> CoreError {
    CoreError::General(format!(
        "The WinSCP configuration is larger than {} MiB; this is not a WinSCP.ini file",
        MAX_WINSCP_INI_BYTES / (1024 * 1024)
    ))
}

/// Reads every stored site of a `WinSCP.ini` text. Fails only when the text is larger
/// than [`MAX_WINSCP_INI_BYTES`]; text without WinSCP sessions gives an empty result.
pub fn parse_winscp_ini(content: &str) -> CoreResult<WinScpImportResult> {
    parse_with_env(content, &KeyPathEnv::local())
}

/// Reads and parses a `WinSCP.ini` file (UTF-8, UTF-16 or Windows-1252), refusing
/// folders and files larger than [`MAX_WINSCP_INI_BYTES`].
pub fn parse_winscp_ini_file(path: &Path) -> CoreResult<WinScpImportResult> {
    let meta = std::fs::metadata(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            CoreError::NotFound(format!("WinSCP.ini not found: {}", path.display()))
        } else {
            CoreError::Io(e)
        }
    })?;
    if !meta.is_file() {
        return Err(CoreError::InvalidPath(format!(
            "'{}' is not a file",
            path.display()
        )));
    }
    if meta.len() > MAX_WINSCP_INI_BYTES as u64 {
        return Err(too_large());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(MAX_WINSCP_INI_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_WINSCP_INI_BYTES {
        return Err(too_large());
    }
    parse_winscp_ini(&decode_ini_bytes(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// WinSCP's `EncryptPassword` (Security.cpp), with the random shift and padding
    /// replaced by the given values, to produce test vectors.
    fn obfuscate(host: &str, user: &str, password: &str, shift: u8, pad_to: usize) -> String {
        fn enc(out: &mut String, ch: u8) {
            out.push_str(&format!("{:02X}", (!ch) ^ PW_MAGIC));
        }
        let data = format!("{user}{host}{password}");
        let mut out = String::new();
        enc(&mut out, PW_FLAG);
        enc(&mut out, 0x00);
        enc(&mut out, data.len() as u8);
        enc(&mut out, shift);
        for i in 0..shift {
            enc(&mut out, i.wrapping_mul(37));
        }
        for b in data.bytes() {
            enc(&mut out, b);
        }
        while out.len() < pad_to * 2 {
            let filler = (out.len() % 251) as u8;
            enc(&mut out, filler);
        }
        out
    }

    fn no_files(_: &Path) -> bool {
        false
    }

    fn env_with<'a>(home: &str, is_file: &'a dyn Fn(&Path) -> bool) -> KeyPathEnv<'a> {
        KeyPathEnv {
            home: Some(PathBuf::from(home)),
            windows: false,
            is_file,
        }
    }

    fn parse(content: &str) -> WinScpImportResult {
        parse_with_env(content, &env_with("/Users/me", &no_files)).unwrap()
    }

    #[test]
    fn hand_computed_vector_decrypts() {
        // FF 00 04 00 "uhpw" through ~(c) ^ 0xA3, written by hand from Security.cpp.
        assert_eq!(
            decrypt_winscp_password("h", "u", "A35C585C29342C2B").as_deref(),
            Some("pw")
        );
        // Lower-case hex and surrounding blanks are accepted.
        assert_eq!(
            decrypt_winscp_password("h", "u", "  a35c585c29342c2b \n").as_deref(),
            Some("pw")
        );
    }

    #[test]
    fn obfuscated_passwords_round_trip_with_shift_and_padding() {
        for (host, user, pw) in [
            ("srv.example.com", "deploy", "S3cr3t'\"$;@:/#pass"),
            ("10.0.0.5", "root", "x"),
            ("ftp.example.com.br", "joão", "pässwörd-ção"),
        ] {
            for shift in [0u8, 3, 17] {
                let enc = obfuscate(host, user, pw, shift, 50);
                assert_eq!(
                    decrypt_winscp_password(host, user, &enc).as_deref(),
                    Some(pw),
                    "{host} {user} shift {shift}"
                );
            }
        }
    }

    #[test]
    fn wrong_key_or_malformed_values_give_none_without_panicking() {
        let enc = obfuscate("host", "user", "secret", 2, 50);
        assert_eq!(decrypt_winscp_password("other", "user", &enc), None);
        assert_eq!(decrypt_winscp_password("host", "someone", &enc), None);
        for bad in [
            "",
            "A",
            "A3",
            "A35C",
            "A35C58",
            "ZZZZ",
            "A35C585C2934", // truncated: length says 4 bytes
            "A35C585C29342C2",
            "A35C585C29342C2G",
            "%%%%",
            "ÄÖÜ",
            &"F".repeat(1000)[..],
            &"0".repeat(4097)[..],
        ] {
            let _ = decrypt_winscp_password("h", "u", bad);
        }
        assert_eq!(decrypt_winscp_password("h", "u", "A35C585C2934"), None);
        assert_eq!(decrypt_winscp_password("h", "u", "A35C585C29342C2G"), None);
        // A huge shift that runs past the end.
        let mut long_shift = String::from("A35C58");
        long_shift.push_str(&format!("{:02X}", (!200u8) ^ PW_MAGIC));
        assert_eq!(decrypt_winscp_password("h", "u", &long_shift), None);
    }

    #[test]
    fn url_decoding_follows_winscp_escaping() {
        assert_eq!(
            url_decode_winscp("D1%20-%20ns537298%20server"),
            "D1 - ns537298 server"
        );
        assert_eq!(
            url_decode_winscp("Folder%2FSubfolder%5CPath"),
            "Folder/Subfolder\\Path"
        );
        // Non-ASCII text: UTF-8 behind an encoded BOM.
        assert_eq!(url_decode_winscp("%EF%BB%BFS%C3%A3o%20Paulo"), "São Paulo");
        // Plain UTF-8 escapes, Windows-1252 escapes and literal UTF-8 all work.
        assert_eq!(url_decode_winscp("Jo%C3%A3o"), "João");
        assert_eq!(url_decode_winscp("Jo%E3o"), "João");
        assert_eq!(url_decode_winscp("%80uro"), "€uro");
        assert_eq!(url_decode_winscp("Ação"), "Ação");
        // Malformed escapes stay as they are; an encoded NUL ends the value.
        assert_eq!(url_decode_winscp("100%"), "100%");
        assert_eq!(url_decode_winscp("a%2"), "a%2");
        assert_eq!(url_decode_winscp("%zz%4"), "%zz%4");
        assert_eq!(url_decode_winscp("abc%00def"), "abc");
        assert_eq!(url_decode_winscp(""), "");
    }

    #[test]
    fn ini_bytes_in_every_encoding_decode() {
        let text = "[Sessions\\Café]\r\nHostName=h\r\n";
        assert_eq!(decode_ini_bytes(text.as_bytes()), text);
        let bom = [&[0xEF, 0xBB, 0xBF][..], text.as_bytes()].concat();
        assert_eq!(decode_ini_bytes(&bom), text);
        let mut le = vec![0xFF, 0xFE];
        let mut be = vec![0xFE, 0xFF];
        for unit in text.encode_utf16() {
            le.extend_from_slice(&unit.to_le_bytes());
            be.extend_from_slice(&unit.to_be_bytes());
        }
        assert_eq!(decode_ini_bytes(&le), text);
        assert_eq!(decode_ini_bytes(&be), text);
        assert_eq!(
            decode_ini_bytes(b"Caf\xe9 \x93q\x94"),
            "Café \u{201C}q\u{201D}"
        );
        // Odd UTF-16 length and lone bytes never panic.
        let _ = decode_ini_bytes(&[0xFF, 0xFE, 0x41]);
        let _ = decode_ini_bytes(&[0xFE]);
        assert_eq!(decode_ini_bytes(&[]), "");
    }

    #[test]
    fn sessions_folders_and_fields_are_imported() {
        let pw = obfuscate("web.example.com", "deploy", "Web#Pass1", 4, 50);
        let ini = format!(
            "; WinSCP configuration\r\n\
             [Configuration\\Interface]\r\n\
             RandomSeedFile=%25APPDATA%25\\winscp.rnd\r\n\
             \r\n\
             [Sessions\\Default%20Settings]\r\n\
             UserName=nobody\r\n\
             \r\n\
             [Sessions\\Clientes/S%C3%A3o%20Paulo/Web%20server]\r\n\
             HostName=web.example.com\r\n\
             PortNumber=2222\r\n\
             UserName=deploy\r\n\
             Password={pw}\r\n\
             RemoteDirectory=/var/www/html\r\n\
             \r\n\
             [Sessions\\Oracle%20Cloud/ubuntu@10.0.0.5]\r\n\
             HostName=10.0.0.5\r\n\
             UserName=ubuntu\r\n\
             PublicKeyFile=C:%5CUsers%5CJo%C3%A3o%5C.ssh%5Coracle.ppk\r\n\
             \r\n\
             [Sessions\\top-level]\r\n\
             HostName=ftp.example.com\r\n\
             FSProtocol=5\r\n\
             Ftps=3\r\n\
             UserName=ftpuser\r\n\
             RemoteDirectory=\r\n"
        );
        let res = parse(&ini);
        assert_eq!(res.total_sessions, 3);
        assert_eq!(res.sites.len(), 3);
        assert_eq!(res.decrypted_passwords, 1);
        assert_eq!(res.key_auth_sessions, 1);
        assert_eq!(res.ppk_key_sessions, 1);
        assert_eq!(res.missing_key_files, 1);
        assert_eq!(res.undecrypted_passwords, 0);
        assert_eq!(res.skipped_sessions, 0);
        assert!(!res.master_password_protected);
        assert_eq!(res.folders, vec!["Clientes/São Paulo", "Oracle Cloud"]);

        let web = &res.sites[0];
        assert_eq!(web.name, "Web server");
        assert_eq!(web.group.as_deref(), Some("Clientes/São Paulo"));
        assert_eq!(web.protocol, Protocol::Sftp);
        assert_eq!(web.host, "web.example.com");
        assert_eq!(web.port, 2222);
        assert_eq!(web.username, "deploy");
        assert_eq!(web.remote_root, "/var/www/html");
        assert!(matches!(&web.auth, AuthMethod::Password(p) if p == "Web#Pass1"));

        let oracle = &res.sites[1];
        assert_eq!(oracle.name, "ubuntu@10.0.0.5");
        assert_eq!(oracle.port, 22);
        assert_eq!(oracle.remote_root, "");
        match &oracle.auth {
            AuthMethod::PrivateKey { path, passphrase } => {
                assert_eq!(path, "C:/Users/João/.ssh/oracle.ppk");
                assert!(passphrase.is_none());
            }
            other => panic!("expected a key, got {other:?}"),
        }

        let ftp = &res.sites[2];
        assert_eq!(ftp.name, "top-level");
        assert_eq!(ftp.group, None);
        assert_eq!(ftp.protocol, Protocol::Ftps);
        assert_eq!(ftp.port, 21);
        assert!(matches!(ftp.auth, AuthMethod::None));

        // Ids are valid session ids, stable across imports and distinct per site.
        let again = parse(&ini);
        for (a, b) in res.sites.iter().zip(&again.sites) {
            assert_eq!(a.id, b.id);
            assert!(a.id.starts_with("winscp-") && a.id.len() == 23);
            assert!(a
                .id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'));
        }
        let ids: BTreeSet<_> = res.sites.iter().map(|s| s.id.clone()).collect();
        assert_eq!(ids.len(), 3);
    }

    #[test]
    fn protocols_ports_and_s3_buckets_map() {
        let ini = "\
            [Sessions\\scp]\nHostName=a\nFSProtocol=0\n\
            [Sessions\\ftp]\nHostName=b\nFSProtocol=5\n\
            [Sessions\\implicit]\nHostName=c\nFSProtocol=5\nFtps=1\n\
            [Sessions\\dav]\nHostName=d\nFSProtocol=6\n\
            [Sessions\\davs]\nHostName=e\nFSProtocol=6\nFtps=1\n\
            [Sessions\\s3]\nHostName=s3.amazonaws.com\nFSProtocol=7\nRemoteDirectory=/my-bucket/logs\n\
            [Sessions\\odd]\nHostName=f\nFSProtocol=99\nPortNumber=99999\n\
            [Sessions\\zero]\nHostName=g\nPortNumber=0\n";
        let res = parse(ini);
        let got: Vec<_> = res
            .sites
            .iter()
            .map(|s| (s.name.as_str(), s.protocol, s.port))
            .collect();
        assert_eq!(
            got,
            vec![
                ("scp", Protocol::Sftp, 22),
                ("ftp", Protocol::Ftp, 21),
                ("implicit", Protocol::Ftps, 990),
                ("dav", Protocol::WebDav, 80),
                ("davs", Protocol::WebDav, 443),
                ("s3", Protocol::S3, 443),
                ("odd", Protocol::Sftp, 22),
                ("zero", Protocol::Sftp, 22),
            ]
        );
        assert_eq!(res.sites[5].remote_root, "my-bucket");
    }

    #[test]
    fn keys_win_over_passwords_and_only_for_ssh() {
        let pw = obfuscate("h", "u", "pw", 0, 50);
        let ini = format!(
            "[Sessions\\both]\nHostName=h\nUserName=u\nPassword={pw}\nPublicKeyFile=~%5C.ssh%5Cid_ed25519\n\
             [Sessions\\ftp-with-key]\nHostName=h\nUserName=u\nFSProtocol=5\nPassword={pw}\nPublicKeyFile=C:%5Ckey.ppk\n\
             [Sessions\\empty-key]\nHostName=h\nUserName=u\nPassword={pw}\nPublicKeyFile=\n"
        );
        let res = parse(&ini);
        assert!(matches!(
            &res.sites[0].auth,
            AuthMethod::PrivateKey { path, .. } if path == "~/.ssh/id_ed25519"
        ));
        assert!(matches!(&res.sites[1].auth, AuthMethod::Password(p) if p == "pw"));
        assert!(matches!(&res.sites[2].auth, AuthMethod::Password(p) if p == "pw"));
        assert_eq!(res.key_auth_sessions, 1);
        assert_eq!(res.ppk_key_sessions, 0);
        assert_eq!(res.decrypted_passwords, 2);
    }

    #[test]
    fn key_paths_are_mapped_to_this_computer() {
        let existing = [
            "/Users/me/Library/Mobile Documents/com~apple~CloudDocs/keys/oci",
            "/Users/me/.ssh/id_rsa",
            "/Users/me/Documents/keys/server.pem",
        ];
        let is_file = |p: &Path| existing.iter().any(|e| Path::new(e) == p);
        let env = env_with("/Users/me", &is_file);
        let n = |raw: &str| normalize_key_path_in(raw, &env);

        // A drive that maps the Mac home (Parallels, VMware shared folders).
        assert_eq!(
            n("Y:%5CLibrary%5CMobile%20Documents%5Ccom~apple~CloudDocs%5Ckeys%5Coci"),
            existing[0]
        );
        assert_eq!(
            n("\\\\Mac\\Home\\Library\\Mobile Documents\\com~apple~CloudDocs\\keys\\oci"),
            existing[0]
        );
        // The same .ssh file, or the same file below C:\Users\<name>.
        assert_eq!(n("C:%5CUsers%5CAdmin%5C.ssh%5Cid_rsa"), existing[1]);
        assert_eq!(
            n("\"D:\\Users\\Bob\\Documents\\keys\\server.pem\""),
            existing[2]
        );
        // Not found here: the Windows path is kept (with `/`) so it can be fixed.
        assert_eq!(n("C:%5Ckeys%5Cmissing.ppk"), "C:/keys/missing.ppk");
        // `..` never leaves the home folder.
        assert_eq!(n("C:\\..\\..\\etc\\passwd"), "C:/../../etc/passwd");
        // `~` paths stay portable, Unix paths stay as they are.
        assert_eq!(n("~%5C.ssh%5Cid"), "~/.ssh/id");
        assert_eq!(n("~"), "~");
        assert_eq!(n("/home/me/.ssh/id"), "/home/me/.ssh/id");
        assert_eq!(n("  "), "");
        assert_eq!(n("%22%22"), "");
        assert_eq!(env.key_exists("~/.ssh/id_rsa"), Some(true));
        assert_eq!(env.key_exists("~/.ssh/nope"), Some(false));
        assert_eq!(env.key_exists("/Users/me/.ssh/id_rsa"), Some(true));
        // A Windows path that was not mapped names no file here; paths outside the home
        // folder are not looked at.
        assert_eq!(env.key_exists("C:/keys/missing.ppk"), Some(false));
        assert_eq!(env.key_exists("/etc/ssh/key"), None);
        assert_eq!(env.key_exists("~/../../etc/ssh/key"), None);
        assert_eq!(env.key_exists("/Users/me/../other/.ssh/id_rsa"), None);
        assert_eq!(env.key_exists("//Mac/Home/.ssh/id_rsa"), None);

        // On Windows WinSCP's paths are used as they are.
        let win = KeyPathEnv {
            home: None,
            windows: true,
            is_file: &no_files,
        };
        assert_eq!(
            normalize_key_path_in("C:%5CUsers%5Cme%5Ckey.ppk", &win),
            "C:\\Users\\me\\key.ppk"
        );
    }

    /// One SFTP session per raw `PublicKeyFile` value.
    fn hostile_key_sessions(paths: &[&str]) -> String {
        paths
            .iter()
            .enumerate()
            .map(|(i, p)| format!("[Sessions\\k{i}]\nHostName=h\nUserName=u\nPublicKeyFile={p}\n"))
            .collect()
    }

    #[test]
    fn previews_never_look_at_network_or_outside_paths_on_windows() {
        let seen = std::cell::RefCell::new(Vec::<String>::new());
        let record = |p: &Path| {
            seen.borrow_mut().push(p.to_string_lossy().into_owned());
            false
        };
        let env = KeyPathEnv {
            home: Some(PathBuf::from("C:\\Users\\me")),
            windows: true,
            is_file: &record,
        };
        let ini = hostile_key_sessions(&[
            // SMB: opening it logs in to that host with the Windows account (NTLM).
            "%5C%5Cattacker.example%5Cshare%5Ckey",
            "//attacker.example/share/key",
            "/%5Cattacker.example%5Cshare%5Ckey",
            "%5C%5C%3F%5CUNC%5Cattacker.example%5Cshare%5Ckey",
            "%5C%5C.%5Cpipe%5Cattacker",
            "%5C%3F%3F%5CUNC%5Cattacker.example%5Cshare%5Ckey",
            "D:%5Ckeys%5Cid",
            "~%5C.ssh%5Cid",
        ]);
        let res = parse_with_env(&ini, &env).unwrap();
        let seen = seen.into_inner();
        assert_eq!(seen.len(), 1, "{seen:?}");
        assert!(seen[0].starts_with("C:\\Users\\me"), "{seen:?}");
        assert!(seen.iter().all(|p| !p.contains("attacker")), "{seen:?}");
        assert_eq!(res.key_auth_sessions, 8);
        assert_eq!(res.unchecked_key_files, 7);
        assert_eq!(res.missing_key_files, 1);
    }

    #[test]
    #[cfg(not(windows))]
    fn previews_never_look_at_network_or_outside_paths_elsewhere() {
        let seen = std::cell::RefCell::new(Vec::<String>::new());
        let record = |p: &Path| {
            seen.borrow_mut().push(p.to_string_lossy().into_owned());
            false
        };
        let env = env_with("/Users/me", &record);
        let ini = hostile_key_sessions(&[
            // macOS mounts /net/<host> (NFS) when it is opened.
            "/net/attacker.example/share/key",
            "%5C%5Cattacker.example%5Cshare%5Ckey",
            "~/../../net/attacker.example/key",
            "/Users/me/../../net/attacker.example/key",
            "C:%5C..%5C..%5Cnet%5Cattacker.example%5Ckey",
            "~/.ssh/id_ed25519",
        ]);
        let res = parse_with_env(&ini, &env).unwrap();
        let seen = seen.into_inner();
        assert!(!seen.is_empty());
        assert!(
            seen.iter().all(|p| p.starts_with("/Users/me/")
                && !p.contains("attacker")
                && !p.contains("..")),
            "{seen:?}"
        );
        assert_eq!(res.key_auth_sessions, 6);
        assert_eq!(res.unchecked_key_files, 4);
        // The unmapped Windows path and the missing ~ key.
        assert_eq!(res.missing_key_files, 2);
    }

    #[test]
    fn tunneled_and_proxied_sessions_are_imported_without_their_password() {
        let ini = format!(
            "[Sessions\\Internal/db]\nHostName=10.0.0.5\nUserName=root\nPassword={}\n\
             Tunnel=1\nTunnelHostName=bastion.corp.example\nTunnelUserName=jump\n\
             [Sessions\\Internal/proxied]\nHostName=192.168.1.20\nUserName=admin\nPassword={}\n\
             ProxyMethod=2\nProxyHost=proxy.corp.example\nProxyPort=1080\n\
             [Sessions\\Internal/keyed]\nHostName=10.0.0.6\nUserName=root\nTunnel=1\n\
             PublicKeyFile=~/.ssh/id_ed25519\n\
             [Sessions\\ftp-proxy]\nHostName=ftp.example.com\nUserName=u\nFSProtocol=5\n\
             Password={}\nFtpProxyLogonType=2\n\
             [Sessions\\direct]\nHostName=h\nUserName=u\nPassword={}\nTunnel=0\nProxyMethod=0\n\
             FtpProxyLogonType=3\n\
             [Sessions\\odd]\nHostName=h\nUserName=u\nPassword={}\nTunnel=no\nProxyMethod=abc\n",
            obfuscate("10.0.0.5", "root", "DbRoot#1", 0, 50),
            obfuscate("192.168.1.20", "admin", "Adm#2", 0, 50),
            obfuscate("ftp.example.com", "u", "Ftp#3", 0, 50),
            obfuscate("h", "u", "pw", 0, 50),
            obfuscate("h", "u", "pw", 0, 50),
        );
        let res = parse(&ini);
        assert_eq!(res.total_sessions, 6);
        assert_eq!(res.tunneled_sessions, 4);
        assert_eq!(res.decrypted_passwords, 2);
        assert_eq!(res.undecrypted_passwords, 0);
        assert!(matches!(res.sites[0].auth, AuthMethod::None));
        assert!(matches!(res.sites[1].auth, AuthMethod::None));
        assert!(matches!(
            &res.sites[2].auth,
            AuthMethod::PrivateKey { path, .. } if path == "~/.ssh/id_ed25519"
        ));
        assert!(matches!(res.sites[3].auth, AuthMethod::None));
        // FtpProxyLogonType is an FTP setting; an SFTP site with it connects directly.
        assert!(matches!(&res.sites[4].auth, AuthMethod::Password(p) if p == "pw"));
        assert!(matches!(&res.sites[5].auth, AuthMethod::Password(p) if p == "pw"));
        let json = serde_json::to_string(&res).unwrap();
        for secret in ["DbRoot#1", "Adm#2", "Ftp#3"] {
            assert!(!json.contains(secret), "{json}");
        }
        assert!(json.contains("\"tunneled_sessions\":4"), "{json}");
    }

    #[test]
    fn master_password_files_import_sites_without_passwords() {
        let pw = obfuscate("h", "u", "pw", 0, 50);
        let ini = format!(
            "[Configuration\\Security]\nUseMasterPassword=1\nMasterPasswordVerifier=0123\n\
             [Sessions\\a]\nHostName=h\nUserName=u\nPassword={pw}\n"
        );
        let res = parse(&ini);
        assert!(res.master_password_protected);
        assert_eq!(res.total_sessions, 1);
        assert_eq!(res.decrypted_passwords, 0);
        assert_eq!(res.undecrypted_passwords, 1);
        assert!(matches!(res.sites[0].auth, AuthMethod::None));

        // A damaged value is counted, not imported.
        let res = parse("[Sessions\\b]\nHostName=h\nUserName=u\nPassword=A35C0000\n");
        assert_eq!(res.undecrypted_passwords, 1);
        assert!(matches!(res.sites[0].auth, AuthMethod::None));
    }

    #[test]
    fn workspaces_duplicates_and_odd_names() {
        let ini = "\
            [Sessions\\My%20Workspace/0000]\nHostName=h\nIsWorkspace=1\nLink=Prod/web\n\
            [Sessions\\My%20Workspace/0001]\nHostName=adhoc\nIsWorkspace=1\n\
            [sessions\\Prod/web]\nHostName=first\n\
            [Sessions\\prod/WEB]\nHostName=second\nUserName=u\n\
            [Sessions\\//A%2FB//]\nHostName=x\n\
            [Sessions\\]\nHostName=nameless\n\
            [Sessions\\Bad%00Name/%09Tab%0A]\nHostName=y\n";
        let res = parse(ini);
        let got: Vec<_> = res
            .sites
            .iter()
            .map(|s| (s.group.as_deref(), s.name.as_str(), s.host.as_str()))
            .collect();
        assert_eq!(
            got,
            vec![
                (Some("My Workspace"), "0001", "adhoc"),
                // Repeated sections merge into the first (case-insensitive), first value wins.
                (Some("Prod"), "web", "first"),
                (None, "A/B", "x"),
                (None, "nameless", "nameless"),
                (Some("Bad"), "Tab", "y"),
            ]
        );
        assert_eq!(res.sites[1].username, "u");
        assert_eq!(res.skipped_sessions, 1);
    }

    #[test]
    fn malformed_input_never_panics() {
        for junk in [
            "",
            "[",
            "]",
            "[]",
            "[Sessions\\",
            "[Sessions\\x]",
            "[Sessions\\x]\n=\n==\nHostName",
            "HostName=orphan\n[Sessions\\x]\nHostName=\n",
            "[Sessions\\é]\nHostName=h\nPortNumber=-1\nPassword=%%%\nPublicKeyFile=%\n",
            "\u{feff}[Sessions\\bom]\nHostName=h\n",
            "[Sessions\\x]\r\nHostName=h\r\nFSProtocol=\r\nFtps=abc\r\n",
            "\0\0\0[Sessions\\x\0]\0HostName=\0",
        ] {
            let _ = parse(junk);
        }
        assert_eq!(parse("").total_sessions, 0);
        assert_eq!(parse("[Sessions\\x]").total_sessions, 0);
        assert_eq!(
            parse("\u{feff}[Sessions\\bom]\nHostName=h\n").sites[0].name,
            "bom"
        );
        let random: Vec<u8> = (0..20_000u32).map(|i| (i * 7919 % 256) as u8).collect();
        let _ = parse(&decode_ini_bytes(&random));
    }

    #[test]
    fn size_and_session_caps() {
        let big = "x".repeat(MAX_WINSCP_INI_BYTES + 1);
        assert!(parse_with_env(&big, &env_with("/h", &no_files)).is_err());

        let mut ini = String::new();
        for i in 0..MAX_WINSCP_SESSIONS + 3 {
            ini.push_str(&format!("[Sessions\\s{i}]\nHostName=h{i}\n"));
        }
        let res = parse(&ini);
        assert_eq!(res.total_sessions, MAX_WINSCP_SESSIONS);
        assert_eq!(res.skipped_sessions, 3);
    }

    #[test]
    fn files_are_read_with_limits() {
        let dir = tempfile::tempdir().unwrap();
        let pw = obfuscate("h", "u", "pw", 1, 50);
        let path = dir.path().join("WinSCP.ini");
        let utf16: Vec<u8> = [0xFF, 0xFE]
            .into_iter()
            .chain(
                format!("[Sessions\\x]\r\nHostName=h\r\nUserName=u\r\nPassword={pw}\r\n")
                    .encode_utf16()
                    .flat_map(|u| u.to_le_bytes()),
            )
            .collect();
        std::fs::write(&path, utf16).unwrap();
        let res = parse_winscp_ini_file(&path).unwrap();
        assert_eq!(res.total_sessions, 1);
        assert!(matches!(&res.sites[0].auth, AuthMethod::Password(p) if p == "pw"));

        assert!(matches!(
            parse_winscp_ini_file(&dir.path().join("missing.ini")),
            Err(CoreError::NotFound(_))
        ));
        assert!(matches!(
            parse_winscp_ini_file(dir.path()),
            Err(CoreError::InvalidPath(_))
        ));
        let big = dir.path().join("big.ini");
        let f = std::fs::File::create(&big).unwrap();
        f.set_len(MAX_WINSCP_INI_BYTES as u64 + 1).unwrap();
        assert!(matches!(
            parse_winscp_ini_file(&big),
            Err(CoreError::General(_))
        ));
    }

    /// Checks a real export without putting it in the repository; prints counts only:
    /// `RUSTSCP_WINSCP_INI=/path/WinSCP.ini cargo test -p rustscp-core winscp_real_file -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn winscp_real_file() {
        let Ok(path) = std::env::var("RUSTSCP_WINSCP_INI") else {
            return;
        };
        let res = parse_winscp_ini_file(Path::new(&path)).unwrap();
        println!(
            "sessions {} passwords {} undecrypted {} keys {} ppk {} missing keys {} \
             unchecked keys {} tunneled {} folders {} skipped {} master password {}",
            res.total_sessions,
            res.decrypted_passwords,
            res.undecrypted_passwords,
            res.key_auth_sessions,
            res.ppk_key_sessions,
            res.missing_key_files,
            res.unchecked_key_files,
            res.tunneled_sessions,
            res.folders.len(),
            res.skipped_sessions,
            res.master_password_protected
        );
        let ids: BTreeSet<_> = res.sites.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids.len(), res.sites.len(), "ids are unique");
        // The sites survive the vault format unchanged (groups included).
        let env = crate::vault::encrypt_sites_with_iterations(&res.sites, "test", 10_000).unwrap();
        let back = crate::vault::decrypt_sites(&env, "test").unwrap();
        assert_eq!(back.len(), res.sites.len());
        for (a, b) in res.sites.iter().zip(&back) {
            assert_eq!((&a.id, &a.group, &a.host), (&b.id, &b.group, &b.host));
        }
    }

    #[test]
    fn debug_output_of_a_result_never_shows_passwords() {
        let pw = obfuscate("h", "u", "TopSecret42", 0, 50);
        let res = parse(&format!(
            "[Sessions\\x]\nHostName=h\nUserName=u\nPassword={pw}\n"
        ));
        let dbg = format!("{res:?}");
        assert!(!dbg.contains("TopSecret42"), "{dbg}");
    }

    #[test]
    fn default_settings_are_never_a_site() {
        let res = parse(
            "[Sessions\\Default%20Settings]\nHostName=defaults.example.com\nUserName=me\n\
             [Sessions\\Folder/Default%20Settings]\nHostName=real.example.com\n",
        );
        // Only WinSCP's own top-level defaults are left out; a site with that name inside
        // a folder is a real site.
        assert_eq!(res.total_sessions, 1);
        assert_eq!(res.sites[0].host, "real.example.com");
        assert_eq!(res.skipped_sessions, 0);
    }

    #[test]
    fn putty_keys_are_recognized_by_content() {
        let dir = tempfile::tempdir().unwrap();
        let ppk = dir.path().join("renamed-key");
        std::fs::write(
            &ppk,
            "PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\n",
        )
        .unwrap();
        let ppk_bom = dir.path().join("bom.ppk");
        std::fs::write(&ppk_bom, b"\xEF\xBB\xBFPuTTY-User-Key-File-2: ssh-rsa\n").unwrap();
        let openssh = dir.path().join("id_ed25519.ppk");
        std::fs::write(&openssh, "-----BEGIN OPENSSH PRIVATE KEY-----\n").unwrap();
        let short = dir.path().join("short");
        std::fs::write(&short, "PuTTY").unwrap();

        assert!(is_putty_private_key(&ppk));
        assert!(is_putty_private_key(&ppk_bom));
        assert!(!is_putty_private_key(&openssh), "the name does not decide");
        assert!(!is_putty_private_key(&short));
        assert!(!is_putty_private_key(&dir.path().join("missing")));
        assert!(!is_putty_private_key(dir.path()));
    }
}

//! Private keys kept as text inside a saved site.
//!
//! A site received in a `.rustscp` share (see [`crate::share`]) carries its key file's
//! contents in [`AuthMethod::PrivateKey::key_data`](crate::AuthMethod::PrivateKey)
//! instead of a path, so it works on a computer that never had the file. The text is
//! the file exactly as the sender had it, OpenSSH (`openssh-key-v1` or PEM) or PuTTY
//! (`.ppk`), with its passphrase (if any) saved next to it. [`userauth`] logs in with
//! it from memory; [`write_openssh_copy`] saves it for the system `ssh` client.

use crate::ppk::{self, PpkKey};
use crate::types::{CoreError, CoreResult};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};

/// Largest key file embedded in a site. A 16384-bit RSA key is about 13 KiB.
pub const MAX_EMBEDDED_KEY_BYTES: usize = 64 * 1024;

/// How a private key file is written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyFormat {
    /// PuTTY `.ppk` (formats 2 and 3).
    Ppk,
    /// OpenSSH's own format (`-----BEGIN OPENSSH PRIVATE KEY-----`).
    OpenSsh,
    /// PEM (`-----BEGIN RSA PRIVATE KEY-----`, PKCS#8, ...).
    Pem,
}

/// What the text of a private key file says about it without decrypting it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyFileInfo {
    pub format: KeyFormat,
    /// Whether the key is protected by a passphrase.
    pub encrypted: bool,
    /// The public key as an `authorized_keys` line (`ssh-ed25519 AAAA...`), when the file
    /// stores it in the clear (OpenSSH format does).
    pub public_key: Option<String>,
}

/// Recognizes the text of a private key file. Errors when it is not one.
pub fn inspect(text: &str) -> CoreResult<KeyFileInfo> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    if ppk::is_ppk(text.as_bytes()) {
        let encrypted = text
            .lines()
            .find_map(|l| l.trim().strip_prefix("Encryption:"))
            .map(|v| !v.trim().eq_ignore_ascii_case("none"))
            .unwrap_or(false);
        return Ok(KeyFileInfo {
            format: KeyFormat::Ppk,
            encrypted,
            public_key: None,
        });
    }
    if text.contains("-----BEGIN OPENSSH PRIVATE KEY-----") {
        let (cipher, public_blob) = openssh_v1_header(text)
            .ok_or_else(|| CoreError::General("the OpenSSH private key file is damaged".into()))?;
        let public_key = crate::known_hosts::key_type_of_blob(&public_blob)
            .map(|t| format!("{} {}", t, BASE64.encode(&public_blob)));
        return Ok(KeyFileInfo {
            format: KeyFormat::OpenSsh,
            encrypted: cipher != "none",
            public_key,
        });
    }
    let pem_private = text.lines().any(|l| {
        let l = l.trim();
        l.starts_with("-----BEGIN ") && l.ends_with("PRIVATE KEY-----")
    });
    if pem_private {
        let encrypted = text.contains("ENCRYPTED");
        return Ok(KeyFileInfo {
            format: KeyFormat::Pem,
            encrypted,
            public_key: None,
        });
    }
    Err(CoreError::General(
        "the file is not an SSH private key (OpenSSH, PEM or PuTTY .ppk)".into(),
    ))
}

/// The key text in the form that is stored: no byte-order mark, `\n` line ends and one
/// final newline.
pub fn normalize(text: &str) -> String {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut out = text.replace("\r\n", "\n").replace('\r', "\n");
    let trimmed = out.trim_end().len();
    out.truncate(trimmed);
    out.push('\n');
    out
}

/// Reads a private key file to embed it in a site: at most
/// [`MAX_EMBEDDED_KEY_BYTES`], text, and recognizably a private key.
pub fn read_key_file(path: &Path) -> CoreResult<String> {
    let file = std::fs::File::open(path).map_err(|e| {
        CoreError::General(format!(
            "could not read the key file {}: {}",
            path.display(),
            e
        ))
    })?;
    let mut data = Vec::new();
    file.take(MAX_EMBEDDED_KEY_BYTES as u64 + 1)
        .read_to_end(&mut data)
        .map_err(|e| {
            CoreError::General(format!(
                "could not read the key file {}: {}",
                path.display(),
                e
            ))
        })?;
    if data.len() > MAX_EMBEDDED_KEY_BYTES {
        return Err(CoreError::General(format!(
            "{} is too large to be a private key",
            path.display()
        )));
    }
    let text = String::from_utf8(data).map_err(|_| {
        CoreError::General(format!(
            "{} is not an SSH private key (OpenSSH, PEM or PuTTY .ppk)",
            path.display()
        ))
    })?;
    let text = normalize(&text);
    inspect(&text).map_err(|e| CoreError::General(format!("{}: {}", path.display(), e)))?;
    Ok(text)
}

/// Checks that `passphrase` opens the key where that can be checked here (PuTTY keys);
/// for any encrypted key, that a passphrase is there at all.
pub fn check_passphrase(text: &str, passphrase: Option<&str>) -> CoreResult<()> {
    let passphrase = passphrase.filter(|p| !p.is_empty());
    let info = inspect(text)?;
    if info.format == KeyFormat::Ppk {
        return PpkKey::parse(text.as_bytes(), passphrase)
            .map(|_| ())
            .map_err(|e| CoreError::General(e.to_string()));
    }
    if info.encrypted && passphrase.is_none() {
        return Err(CoreError::General(
            "the key is protected by a passphrase; enter it in the site's settings".into(),
        ));
    }
    Ok(())
}

/// Public-key authentication with the key text, from memory.
pub fn userauth(
    sess: &ssh2::Session,
    user: &str,
    text: &str,
    passphrase: Option<&str>,
) -> CoreResult<()> {
    let passphrase = passphrase.filter(|p| !p.is_empty());
    let info = inspect(text)?;
    let result = if info.format == KeyFormat::Ppk {
        // libssh2 cannot read PuTTY keys: decrypted here and handed over as OpenSSH.
        let key = PpkKey::parse(text.as_bytes(), passphrase)
            .map_err(|e| CoreError::AuthFailed(e.to_string()))?;
        let private = key
            .to_openssh(None)
            .map_err(|e| CoreError::AuthFailed(e.to_string()))?;
        sess.userauth_pubkey_memory(user, Some(&key.public_key()), &private, None)
    } else {
        sess.userauth_pubkey_memory(user, info.public_key.as_deref(), text, passphrase)
    };
    result.map_err(|e| CoreError::AuthFailed(e.to_string()))
}

/// Saves the key in OpenSSH format inside `dir` for the system `ssh` client, which only
/// reads key files, and returns the file's path. A PuTTY key is converted (and stays
/// encrypted with the same passphrase when it was); an OpenSSH or PEM key is written as
/// it is. The file is private to the user and named after the key, so each key has one
/// copy, replaced on every call.
pub fn write_openssh_copy(text: &str, passphrase: Option<&str>, dir: &Path) -> CoreResult<PathBuf> {
    let passphrase = passphrase.filter(|p| !p.is_empty());
    let info = inspect(text)?;
    let pem = if info.format == KeyFormat::Ppk {
        let key = PpkKey::parse(text.as_bytes(), passphrase)
            .map_err(|e| CoreError::General(e.to_string()))?;
        key.to_openssh(if key.is_encrypted() { passphrase } else { None })
            .map_err(|e| CoreError::General(e.to_string()))?
            .to_string()
    } else {
        normalize(text)
    };
    let digest = Sha256::digest(text.as_bytes());
    let name = format!("shared-{}", hex::encode(&digest[..12]));
    ppk::write_private_key_file(dir, &name, &pem)
        .map_err(|e| CoreError::General(format!("could not save the key for ssh: {}", e)))
}

/// Saves a private copy of the key file at `path` inside `dir` when the system `ssh`
/// client would refuse the original, and returns the copy's path. ssh ignores a key that
/// other users can read ("UNPROTECTED PRIVATE KEY FILE"), which is how a key downloaded
/// from a cloud console (Oracle OCI, for one) usually arrives, while RustSCP itself logs in
/// with it fine; Windows line ends and a byte-order mark are fixed on the way. `Ok(None)`
/// when ssh can use the file as it is, and when it is not a key file RustSCP recognizes
/// (ssh then reports the problem itself).
pub fn private_copy_for_ssh(path: &Path, dir: &Path) -> CoreResult<Option<PathBuf>> {
    let Ok(file) = std::fs::File::open(path) else {
        return Ok(None);
    };
    let mut data = Vec::new();
    if file
        .take(MAX_EMBEDDED_KEY_BYTES as u64 + 1)
        .read_to_end(&mut data)
        .is_err()
        || data.len() > MAX_EMBEDDED_KEY_BYTES
    {
        return Ok(None);
    }
    let Ok(text) = String::from_utf8(data) else {
        return Ok(None);
    };
    let clean = normalize(&text);
    if clean == text && !readable_by_others(path) {
        return Ok(None);
    }
    if inspect(&clean).is_err() {
        return Ok(None);
    }
    let source = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let digest = Sha256::digest(source.to_string_lossy().as_bytes());
    let name = format!("key-{}", hex::encode(&digest[..12]));
    ppk::write_private_key_file(dir, &name, &clean)
        .map(Some)
        .map_err(|e| CoreError::General(format!("could not save the key for ssh: {}", e)))
}

/// Whether the group or other users may read the file (ssh then refuses it as a key).
#[cfg(unix)]
fn readable_by_others(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| m.permissions().mode() & 0o077 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn readable_by_others(_path: &Path) -> bool {
    false
}

/// Cipher name and public key blob from the clear header of an `openssh-key-v1` file.
fn openssh_v1_header(text: &str) -> Option<(String, Vec<u8>)> {
    let body: String = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("-----"))
        .collect();
    let blob = BASE64.decode(body).ok()?;
    let mut rest = blob.strip_prefix(b"openssh-key-v1\0")?;
    let cipher = String::from_utf8(take_string(&mut rest)?.to_vec()).ok()?;
    take_string(&mut rest)?; // KDF name
    take_string(&mut rest)?; // KDF options
    if take_u32(&mut rest)? < 1 {
        return None;
    }
    let public = take_string(&mut rest)?.to_vec();
    Some((cipher, public))
}

fn take_u32(rest: &mut &[u8]) -> Option<u32> {
    let (head, tail) = rest.split_at_checked(4)?;
    *rest = tail;
    Some(u32::from_be_bytes([head[0], head[1], head[2], head[3]]))
}

fn take_string<'a>(rest: &mut &'a [u8]) -> Option<&'a [u8]> {
    let len = take_u32(rest)? as usize;
    let (head, tail) = rest.split_at_checked(len)?;
    *rest = tail;
    Some(head)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    // A throwaway Ed25519 key made for these tests (ssh-keygen -t ed25519 -N '').
    pub(crate) const OPENSSH_ED25519: &str = "-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACCB+vUtYqjFnOe5Vt45BcAcfWkBOlrLu5st/lhHIU0DyAAAAJjU0xXP1NMV
zwAAAAtzc2gtZWQyNTUxOQAAACCB+vUtYqjFnOe5Vt45BcAcfWkBOlrLu5st/lhHIU0DyA
AAAEDFqYeI/T5LUXk7uWjtR+3R9w+Shq2YyeUmoHZrW5LzRoH69S1iqMWc57lW3jkFwBx9
aQE6Wsu7my3+WEchTQPIAAAAEHJ1c3RzY3AtdGVzdC1rZXkBAgMEBQ==
-----END OPENSSH PRIVATE KEY-----
";

    #[test]
    fn recognizes_openssh_keys_and_reads_their_public_key() {
        let info = inspect(OPENSSH_ED25519).unwrap();
        assert_eq!(info.format, KeyFormat::OpenSsh);
        assert!(!info.encrypted);
        let public = info.public_key.unwrap();
        assert!(
            public.starts_with("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5"),
            "{public}"
        );
    }

    #[test]
    fn recognizes_pem_and_ppk_and_rejects_other_files() {
        let pem = "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nabc\n-----END RSA PRIVATE KEY-----\n";
        let info = inspect(pem).unwrap();
        assert_eq!(info.format, KeyFormat::Pem);
        assert!(info.encrypted);

        let ppk = "PuTTY-User-Key-File-3: ssh-ed25519\r\nEncryption: aes256-cbc\r\nComment: x\r\n";
        let info = inspect(ppk).unwrap();
        assert_eq!(info.format, KeyFormat::Ppk);
        assert!(info.encrypted);

        assert!(inspect("ssh-ed25519 AAAAC3Nza... public key").is_err());
        assert!(inspect("hello").is_err());
    }

    #[test]
    fn an_encrypted_key_needs_its_passphrase() {
        let pem = "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nabc\n-----END RSA PRIVATE KEY-----\n";
        assert!(check_passphrase(pem, None).is_err());
        assert!(check_passphrase(pem, Some("")).is_err());
        assert!(check_passphrase(pem, Some("secret")).is_ok());
        assert!(check_passphrase(OPENSSH_ED25519, None).is_ok());
    }

    #[test]
    fn normalizes_line_ends_and_bom() {
        assert_eq!(normalize("\u{feff}a\r\nb\r\n\r\n"), "a\nb\n");
        assert_eq!(normalize("a\nb"), "a\nb\n");
    }

    #[test]
    fn reads_key_files_with_limits() {
        let dir = tempfile::tempdir().unwrap();
        let key = dir.path().join("id");
        std::fs::write(&key, OPENSSH_ED25519.replace('\n', "\r\n")).unwrap();
        assert_eq!(read_key_file(&key).unwrap(), OPENSSH_ED25519);

        let big = dir.path().join("big");
        std::fs::write(&big, vec![b'a'; MAX_EMBEDDED_KEY_BYTES + 1]).unwrap();
        assert!(read_key_file(&big).is_err());

        let public = dir.path().join("id.pub");
        std::fs::write(&public, "ssh-ed25519 AAAA comment\n").unwrap();
        assert!(read_key_file(&public).is_err());
        assert!(read_key_file(&dir.path().join("missing")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn copies_keys_that_ssh_would_refuse() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let keys = dir.path().join("openssh-keys");
        let set_mode = |p: &Path, mode: u32| {
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode)).unwrap()
        };

        // A private, clean key is used as it is.
        let ok = dir.path().join("ok");
        std::fs::write(&ok, OPENSSH_ED25519).unwrap();
        set_mode(&ok, 0o600);
        assert_eq!(private_copy_for_ssh(&ok, &keys).unwrap(), None);

        // Downloaded from a cloud console: readable by everyone.
        let open = dir.path().join("ssh-key-2026-10-23.key");
        std::fs::write(&open, OPENSSH_ED25519).unwrap();
        set_mode(&open, 0o644);
        let copy = private_copy_for_ssh(&open, &keys).unwrap().unwrap();
        assert!(copy.starts_with(&keys));
        assert_eq!(std::fs::read_to_string(&copy).unwrap(), OPENSSH_ED25519);
        let mode = std::fs::metadata(&copy).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        // The same file always maps to the same copy.
        assert_eq!(private_copy_for_ssh(&open, &keys).unwrap(), Some(copy));

        // Windows line ends are fixed even when the file is private.
        let crlf = dir.path().join("crlf");
        std::fs::write(&crlf, OPENSSH_ED25519.replace('\n', "\r\n")).unwrap();
        set_mode(&crlf, 0o600);
        let copy = private_copy_for_ssh(&crlf, &keys).unwrap().unwrap();
        assert_eq!(std::fs::read_to_string(&copy).unwrap(), OPENSSH_ED25519);

        // Not a key, or missing: left to ssh.
        let public = dir.path().join("id.pub");
        std::fs::write(&public, "ssh-ed25519 AAAA comment\n").unwrap();
        set_mode(&public, 0o644);
        assert_eq!(private_copy_for_ssh(&public, &keys).unwrap(), None);
        assert_eq!(
            private_copy_for_ssh(&dir.path().join("missing"), &keys).unwrap(),
            None
        );
    }

    #[test]
    fn writes_a_private_copy_for_ssh() {
        let dir = tempfile::tempdir().unwrap();
        let keys = dir.path().join("openssh-keys");
        let path = write_openssh_copy(OPENSSH_ED25519, None, &keys).unwrap();
        assert!(path.starts_with(&keys));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), OPENSSH_ED25519);
        // Same key, same file.
        assert_eq!(
            write_openssh_copy(OPENSSH_ED25519, None, &keys).unwrap(),
            path
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }
}

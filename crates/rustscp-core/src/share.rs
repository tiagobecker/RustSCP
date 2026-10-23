//! Connection sharing: one site packed into a `.rustscp` file that opens with an access
//! code.
//!
//! The sender picks a saved site (and optionally the folder to open); RustSCP embeds the
//! site's credentials — password / S3 secret, or the private key's *contents* (OpenSSH or
//! PuTTY `.ppk`) with its passphrase — plus the SSH host keys it has verified for the
//! server, and encrypts everything with a random access code. The code is shown once and
//! sent through another channel; the file alone opens nothing.
//!
//! Crypto: AES-256-GCM with a key from PBKDF2-HMAC-SHA256 (600,000 rounds, the same as
//! `.rustscp-vault` exports), a random 32-byte salt and 12-byte nonce. The envelope header
//! is bound to the ciphertext as associated data, so it cannot be edited unnoticed. The
//! code is 12 Crockford base32 characters (60 random bits), written `XXXX-XXXX-XXXX`.
//!
//! What the recipient's RustSCP does with an opened file is decided by the app; this
//! module only builds, seals, opens and validates it. Everything read from a file is
//! untrusted: [`open`] checks and cleans it (a key *path* never survives, only key text).

use crate::embedded_key::{self, KeyFormat};
use crate::known_hosts;
use crate::types::{AuthMethod, ConnectionConfig, Protocol};
use crate::vault;
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use zeroize::Zeroizing;

pub const SHARE_MAGIC: &str = "RUSTSCP_SHARE";
/// Envelope and payload format. A file with a higher version is refused with
/// [`ShareError::UnsupportedVersion`] ("update RustSCP"), never misread.
pub const SHARE_VERSION: u32 = 1;
/// File extension registered with the operating system (no dot).
pub const SHARE_FILE_EXTENSION: &str = "rustscp";
/// PBKDF2 rounds for new files.
pub const SHARE_KDF_ITERATIONS: u32 = vault::EXPORT_KDF_ITERATIONS;
/// Largest `.rustscp` file read.
pub const MAX_SHARE_FILE_BYTES: usize = 512 * 1024;
/// Longest message from the sender, in characters.
pub const MAX_SHARE_NOTE_CHARS: usize = 1000;
/// Most SSH host keys carried for one server.
pub const MAX_SHARED_HOST_KEYS: usize = 16;
const MAX_TEXT_FIELD_CHARS: usize = 255;
const MAX_PATH_CHARS: usize = 4096;
/// Crockford base32: no I, L, O or U, so a code read aloud or retyped survives.
const CODE_ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LEN: usize = 12;
/// Shown to anyone who opens the file in a text editor.
const ABOUT: &str = "RustSCP shared connection. Open this file with RustSCP and enter the \
                     access code you received separately. Its contents are encrypted.";

#[derive(Debug, Error)]
pub enum ShareError {
    #[error("This is not a RustSCP connection file")]
    NotAShare,
    #[error(
        "This connection file comes from a newer RustSCP (format {0}). Update RustSCP to open it"
    )]
    UnsupportedVersion(u32),
    #[error("Wrong access code, or the file was changed after it was made")]
    WrongCode,
    #[error("The connection file is damaged or invalid: {0}")]
    Invalid(String),
    #[error("{0}")]
    CannotShare(String),
}

impl ShareError {
    /// Stable, language-independent code for the UI to translate.
    pub fn code(&self) -> &'static str {
        match self {
            ShareError::NotAShare => "share.not_a_share",
            ShareError::UnsupportedVersion(_) => "share.unsupported_version",
            ShareError::WrongCode => "share.wrong_code",
            ShareError::Invalid(_) => "share.invalid",
            ShareError::CannotShare(_) => "share.cannot_share",
        }
    }
}

/// The file on disk: JSON, everything but the header encrypted.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShareEnvelope {
    pub magic: String,
    pub version: u32,
    #[serde(default)]
    pub about: String,
    pub cipher: String,
    pub kdf: String,
    pub kdf_iterations: u32,
    pub salt_hex: String,
    pub nonce_hex: String,
    pub ciphertext_hex: String,
    #[serde(default)]
    pub app_version: String,
}

impl ShareEnvelope {
    /// Associated data: the header fields that steer decryption.
    fn aad(&self) -> String {
        format!(
            "{}|{}|{}|{}|{}|{}",
            self.magic, self.version, self.cipher, self.kdf, self.kdf_iterations, self.salt_hex
        )
    }
}

/// What a `.rustscp` file carries, once decrypted.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SharedConnection {
    /// The site with its credentials: the password / S3 secret, or the key's text (in
    /// `key_data`, never a path) and its passphrase. Id and folder are left empty.
    pub site: ConnectionConfig,
    /// Folder the recipient's session opens in; empty for the site's own start folder.
    #[serde(default)]
    pub start_path: String,
    /// SSH host keys the sender's RustSCP verified for the server, `type base64` each.
    /// The recipient checks the server against them instead of trusting its first answer.
    #[serde(default)]
    pub host_keys: Vec<String>,
    /// Message from the sender.
    #[serde(default)]
    pub note: String,
    /// When the file was made (RFC 3339).
    #[serde(default)]
    pub created_at: String,
}

/// What the recipient is shown before opening the connection: no secrets.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SharePreview {
    pub name: String,
    pub protocol: Protocol,
    pub host: String,
    pub port: u16,
    pub username: String,
    /// `password`, `key`, `agent` (SSH without saved credentials) or `none`.
    pub auth_kind: String,
    /// `ppk`, `openssh` or `pem` for key sites.
    pub key_format: Option<String>,
    pub start_path: String,
    pub note: String,
    pub created_at: String,
    /// SHA-256 fingerprints of the carried SSH host keys.
    pub host_key_fingerprints: Vec<String>,
    pub tls_fingerprint: Option<String>,
}

impl SharedConnection {
    /// The carried host keys as SSH public key blobs.
    pub fn host_key_blobs(&self) -> Vec<Vec<u8>> {
        self.host_keys
            .iter()
            .filter_map(|k| parse_host_key(k))
            .collect()
    }

    pub fn preview(&self) -> SharePreview {
        let site = &self.site;
        let (auth_kind, key_format) = match &site.auth {
            AuthMethod::Password(p) if !p.is_empty() => ("password", None),
            AuthMethod::PrivateKey { .. } => {
                let format = site
                    .auth
                    .embedded_key()
                    .and_then(|k| embedded_key::inspect(k).ok())
                    .map(|info| match info.format {
                        KeyFormat::Ppk => "ppk",
                        KeyFormat::OpenSsh => "openssh",
                        KeyFormat::Pem => "pem",
                    });
                ("key", format.map(str::to_string))
            }
            _ if site.protocol == Protocol::Sftp => ("agent", None),
            _ => ("none", None),
        };
        SharePreview {
            name: site.name.clone(),
            protocol: site.protocol,
            host: site.host.clone(),
            port: site.port,
            username: site.username.clone(),
            auth_kind: auth_kind.to_string(),
            key_format,
            start_path: self.start_path.clone(),
            note: self.note.clone(),
            created_at: self.created_at.clone(),
            host_key_fingerprints: self
                .host_key_blobs()
                .iter()
                .map(|b| known_hosts::fingerprint_sha256(b))
                .collect(),
            tls_fingerprint: site.tls_fingerprint.clone(),
        }
    }
}

/// A new random access code, `XXXX-XXXX-XXXX`.
pub fn generate_access_code() -> String {
    let mut bytes = [0u8; CODE_LEN];
    rand::thread_rng().fill_bytes(&mut bytes);
    let chars: Vec<char> = bytes
        .iter()
        .map(|b| CODE_ALPHABET[(b & 31) as usize] as char)
        .collect();
    chars
        .chunks(4)
        .map(|c| c.iter().collect::<String>())
        .collect::<Vec<_>>()
        .join("-")
}

/// The secret a typed code stands for. A code is accepted in any case, with or without
/// dashes and spaces, and with O / I / L typed for 0 / 1 / 1. Anything that is not
/// shaped like a code is used as typed (trimmed).
pub fn normalize_access_code(input: &str) -> String {
    let compact: String = input
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| match c.to_ascii_uppercase() {
            'O' => '0',
            'I' | 'L' => '1',
            other => other,
        })
        .collect();
    if compact.len() == CODE_LEN && compact.bytes().all(|b| CODE_ALPHABET.contains(&b)) {
        compact
    } else {
        input.trim().to_string()
    }
}

/// The site as it goes into a share: credentials embedded (a key file is read into
/// `key_data` and its passphrase checked), id and folder dropped.
pub fn prepare_site(site: &ConnectionConfig) -> Result<ConnectionConfig, ShareError> {
    if site.protocol == Protocol::Local {
        return Err(ShareError::CannotShare(
            "This computer's own files cannot be shared".into(),
        ));
    }
    if site.host.trim().is_empty() {
        return Err(ShareError::CannotShare(
            "The site has no server address".into(),
        ));
    }
    let mut out = site.clone();
    out.id = String::new();
    out.group = None;
    if let AuthMethod::PrivateKey {
        path,
        passphrase,
        key_data,
    } = &mut out.auth
    {
        let text = match key_data.as_deref().filter(|d| !d.trim().is_empty()) {
            Some(d) => embedded_key::normalize(d),
            None => {
                if path.trim().is_empty() {
                    return Err(ShareError::CannotShare(
                        "The site has no private key file selected".into(),
                    ));
                }
                embedded_key::read_key_file(&known_hosts::expand_tilde(path))
                    .map_err(|e| ShareError::CannotShare(e.to_string()))?
            }
        };
        embedded_key::check_passphrase(&text, passphrase.as_deref()).map_err(|e| {
            ShareError::CannotShare(format!(
                "{e}. Save the key's passphrase in the site before sharing it"
            ))
        })?;
        *key_data = Some(text);
        path.clear();
        if passphrase.as_deref().is_some_and(str::is_empty) {
            *passphrase = None;
        }
    }
    if let AuthMethod::KeyringRef(_) = out.auth {
        out.auth = AuthMethod::None;
    }
    Ok(out)
}

/// One host key as carried in a share (`type base64`).
pub fn format_host_key(blob: &[u8]) -> Option<String> {
    let key_type = known_hosts::key_type_of_blob(blob)?;
    Some(format!("{} {}", key_type, BASE64.encode(blob)))
}

/// The blob of a carried host key; `None` when malformed or its type does not match.
fn parse_host_key(line: &str) -> Option<Vec<u8>> {
    let mut parts = line.split_whitespace();
    let (key_type, b64) = (parts.next()?, parts.next()?);
    let blob = BASE64.decode(b64).ok()?;
    (known_hosts::key_type_of_blob(&blob)? == key_type).then_some(blob)
}

/// Encrypts `shared` with `code` (as typed or generated) into the text of a `.rustscp`
/// file.
pub fn seal(shared: &SharedConnection, code: &str) -> Result<String, ShareError> {
    seal_with_iterations(shared, code, SHARE_KDF_ITERATIONS)
}

/// [`seal`] with an explicit PBKDF2 iteration count (tests use a low one).
pub fn seal_with_iterations(
    shared: &SharedConnection,
    code: &str,
    iterations: u32,
) -> Result<String, ShareError> {
    let secret = Zeroizing::new(normalize_access_code(code));
    if secret.is_empty() {
        return Err(ShareError::CannotShare("The access code is empty".into()));
    }
    let plaintext =
        Zeroizing::new(serde_json::to_vec(shared).map_err(|e| ShareError::Invalid(e.to_string()))?);

    let mut salt = [0u8; vault::SALT_LEN];
    let mut nonce = [0u8; vault::NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut salt);
    rand::thread_rng().fill_bytes(&mut nonce);

    let mut envelope = ShareEnvelope {
        magic: SHARE_MAGIC.to_string(),
        version: SHARE_VERSION,
        about: ABOUT.to_string(),
        cipher: vault::VAULT_CIPHER.to_string(),
        kdf: vault::VAULT_KDF.to_string(),
        kdf_iterations: iterations,
        salt_hex: hex::encode(salt),
        nonce_hex: hex::encode(nonce),
        ciphertext_hex: String::new(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
    };
    let key = Zeroizing::new(vault::derive_key(&secret, &salt, iterations));
    let cipher = Aes256Gcm::new_from_slice(&key[..])
        .map_err(|e| ShareError::Invalid(format!("cipher setup failed: {e}")))?;
    let aad = envelope.aad();
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &plaintext,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| ShareError::Invalid("encryption failed".into()))?;
    envelope.ciphertext_hex = hex::encode(ciphertext);
    serde_json::to_string_pretty(&envelope).map_err(|e| ShareError::Invalid(e.to_string()))
}

/// Reads the header of a `.rustscp` file without decrypting it: is it one, and one this
/// build can open?
pub fn parse_envelope(file_text: &str) -> Result<ShareEnvelope, ShareError> {
    if file_text.len() > MAX_SHARE_FILE_BYTES {
        return Err(ShareError::NotAShare);
    }
    let text = file_text.trim_start_matches('\u{feff}').trim();
    let envelope: ShareEnvelope = serde_json::from_str(text).map_err(|_| ShareError::NotAShare)?;
    if envelope.magic != SHARE_MAGIC {
        return Err(ShareError::NotAShare);
    }
    if envelope.version != SHARE_VERSION {
        return Err(ShareError::UnsupportedVersion(envelope.version));
    }
    if !envelope.cipher.eq_ignore_ascii_case(vault::VAULT_CIPHER)
        || !envelope.kdf.eq_ignore_ascii_case(vault::VAULT_KDF)
    {
        return Err(ShareError::Invalid(format!(
            "unsupported algorithm {} / {}",
            envelope.cipher, envelope.kdf
        )));
    }
    if !(vault::MIN_PASSWORD_KDF_ITERATIONS..=vault::MAX_PASSWORD_KDF_ITERATIONS)
        .contains(&envelope.kdf_iterations)
    {
        return Err(ShareError::Invalid(format!(
            "unsafe key derivation ({} rounds)",
            envelope.kdf_iterations
        )));
    }
    Ok(envelope)
}

/// Decrypts and validates a `.rustscp` file with the access code.
pub fn open(file_text: &str, code: &str) -> Result<SharedConnection, ShareError> {
    let envelope = parse_envelope(file_text)?;
    let secret = Zeroizing::new(normalize_access_code(code));
    if secret.is_empty() {
        return Err(ShareError::WrongCode);
    }
    let bad = |what: &str| ShareError::Invalid(what.to_string());
    let salt = hex::decode(&envelope.salt_hex).map_err(|_| bad("bad salt"))?;
    let nonce = hex::decode(&envelope.nonce_hex).map_err(|_| bad("bad nonce"))?;
    let ciphertext = hex::decode(&envelope.ciphertext_hex).map_err(|_| bad("bad ciphertext"))?;
    if salt.len() != vault::SALT_LEN || nonce.len() != vault::NONCE_LEN {
        return Err(bad("bad salt or nonce length"));
    }
    let key = Zeroizing::new(vault::derive_key(&secret, &salt, envelope.kdf_iterations));
    let cipher = Aes256Gcm::new_from_slice(&key[..]).map_err(|_| bad("cipher setup failed"))?;
    let aad = envelope.aad();
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| ShareError::WrongCode)?,
    );
    let mut shared: SharedConnection =
        serde_json::from_slice(&plaintext).map_err(|e| ShareError::Invalid(e.to_string()))?;
    validate(&mut shared)?;
    Ok(shared)
}

/// Checks and cleans what a file carries; everything in it is untrusted.
fn validate(shared: &mut SharedConnection) -> Result<(), ShareError> {
    let bad = |what: &str| ShareError::Invalid(what.to_string());
    let site = &mut shared.site;
    if site.protocol == Protocol::Local {
        return Err(bad("it points at a local folder"));
    }
    site.host = site.host.trim().to_string();
    if site.host.is_empty()
        || site.host.chars().count() > MAX_TEXT_FIELD_CHARS
        || site
            .host
            .chars()
            .any(|c| c.is_control() || c.is_whitespace())
    {
        return Err(bad("invalid server address"));
    }
    if site.username.chars().count() > MAX_TEXT_FIELD_CHARS
        || site.username.chars().any(char::is_control)
    {
        return Err(bad("invalid user name"));
    }
    site.id = String::new();
    site.group = None;
    site.name = clean_line(&site.name, 128);
    if site.name.is_empty() {
        site.name = if site.username.is_empty() {
            site.host.clone()
        } else {
            format!("{}@{}", site.username, site.host)
        };
    }
    if site.remote_root.chars().count() > MAX_PATH_CHARS
        || site.remote_root.chars().any(char::is_control)
    {
        return Err(bad("invalid start folder"));
    }
    if site.protocol != Protocol::Ftps {
        site.tls_fingerprint = None;
    }
    match &mut site.auth {
        AuthMethod::PrivateKey { path, key_data, .. } => {
            // Only key text is accepted: a path would name a file on *this* computer.
            path.clear();
            let text = key_data
                .as_deref()
                .filter(|d| !d.trim().is_empty())
                .ok_or_else(|| bad("the key is missing"))?;
            if text.len() > embedded_key::MAX_EMBEDDED_KEY_BYTES {
                return Err(bad("the key is too large"));
            }
            let text = embedded_key::normalize(text);
            embedded_key::inspect(&text).map_err(|e| ShareError::Invalid(e.to_string()))?;
            *key_data = Some(text);
        }
        AuthMethod::KeyringRef(_) => site.auth = AuthMethod::None,
        _ => {}
    }

    if shared.start_path.chars().count() > MAX_PATH_CHARS
        || shared.start_path.chars().any(char::is_control)
    {
        return Err(bad("invalid start folder"));
    }
    shared.start_path = shared.start_path.trim().to_string();
    shared.note = clean_note(&shared.note);
    shared.created_at = clean_line(&shared.created_at, 64);
    if shared.host_keys.len() > MAX_SHARED_HOST_KEYS
        || shared.host_keys.iter().any(|k| parse_host_key(k).is_none())
    {
        return Err(bad("invalid server host key"));
    }
    if site.protocol != Protocol::Sftp {
        shared.host_keys.clear();
    }
    Ok(())
}

/// One line of display text: no control characters, at most `max` characters.
fn clean_line(text: &str, max: usize) -> String {
    text.chars()
        .filter(|c| !c.is_control())
        .take(max)
        .collect::<String>()
        .trim()
        .to_string()
}

/// The sender's message: line breaks kept, other control characters dropped.
fn clean_note(text: &str) -> String {
    text.replace("\r\n", "\n")
        .chars()
        .filter(|c| *c == '\n' || !c.is_control())
        .take(MAX_SHARE_NOTE_CHARS)
        .collect::<String>()
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embedded_key::tests::OPENSSH_ED25519;
    use crate::ppk::tests::{PASSPHRASE, V3_ENCRYPTED};

    const FAST: u32 = vault::MIN_PASSWORD_KDF_ITERATIONS;

    fn site(auth: AuthMethod) -> ConnectionConfig {
        ConnectionConfig {
            id: "site-1".into(),
            name: "Produção".into(),
            protocol: Protocol::Sftp,
            host: "srv.example.com".into(),
            port: 2222,
            username: "deploy".into(),
            auth,
            remote_root: "/var/www".into(),
            tls_fingerprint: None,
            group: Some("Clientes/ACME".into()),
        }
    }

    fn shared(site: ConnectionConfig) -> SharedConnection {
        SharedConnection {
            site,
            start_path: "/var/www/app/logs".into(),
            host_keys: vec![],
            note: "Veja o log de hoje".into(),
            created_at: "2026-10-23T12:00:00Z".into(),
        }
    }

    fn key_auth(path: &str, passphrase: Option<&str>) -> AuthMethod {
        AuthMethod::PrivateKey {
            path: path.into(),
            passphrase: passphrase.map(str::to_string),
            key_data: None,
        }
    }

    #[test]
    fn codes_are_random_and_forgiving() {
        let code = generate_access_code();
        assert_eq!(code.len(), 14);
        assert_eq!(code.matches('-').count(), 2);
        assert_ne!(code, generate_access_code());
        let canonical = normalize_access_code(&code);
        assert_eq!(canonical.len(), 12);
        assert_eq!(normalize_access_code(&code.to_lowercase()), canonical);
        assert_eq!(
            normalize_access_code(&format!(" {} ", code.replace('-', " "))),
            canonical
        );
        assert_eq!(normalize_access_code("o1lI-ABCD-EFGH"), "0111ABCDEFGH");
        // Not shaped like a code: used as typed.
        assert_eq!(
            normalize_access_code(" my own password "),
            "my own password"
        );
    }

    #[test]
    fn password_sites_round_trip() {
        let original = shared(prepare_site(&site(AuthMethod::Password("s3cret".into()))).unwrap());
        let code = generate_access_code();
        let file = seal_with_iterations(&original, &code, FAST).unwrap();
        assert!(
            !file.contains("s3cret") && !file.contains("srv.example.com"),
            "{file}"
        );
        assert!(file.contains(SHARE_MAGIC));

        let opened = open(&file, &code.to_lowercase()).unwrap();
        assert!(matches!(&opened.site.auth, AuthMethod::Password(p) if p == "s3cret"));
        assert_eq!(opened.site.host, "srv.example.com");
        assert_eq!(opened.site.port, 2222);
        assert_eq!(opened.site.id, "");
        assert_eq!(opened.site.group, None);
        assert_eq!(opened.start_path, "/var/www/app/logs");
        assert_eq!(opened.note, "Veja o log de hoje");
        let preview = opened.preview();
        assert_eq!(preview.auth_kind, "password");
        assert_eq!(preview.name, "Produção");
    }

    #[test]
    fn wrong_code_and_tampering_are_refused() {
        let original = shared(prepare_site(&site(AuthMethod::Password("pw".into()))).unwrap());
        let code = generate_access_code();
        let file = seal_with_iterations(&original, &code, FAST).unwrap();

        let other = generate_access_code();
        assert!(matches!(open(&file, &other), Err(ShareError::WrongCode)));
        assert!(matches!(open(&file, ""), Err(ShareError::WrongCode)));

        // Header fields are authenticated.
        let mut env: ShareEnvelope = serde_json::from_str(&file).unwrap();
        env.kdf_iterations += 1;
        let edited = serde_json::to_string(&env).unwrap();
        assert!(matches!(open(&edited, &code), Err(ShareError::WrongCode)));

        let mut env: ShareEnvelope = serde_json::from_str(&file).unwrap();
        let mut ct = hex::decode(&env.ciphertext_hex).unwrap();
        ct[0] ^= 1;
        env.ciphertext_hex = hex::encode(ct);
        assert!(matches!(
            open(&serde_json::to_string(&env).unwrap(), &code),
            Err(ShareError::WrongCode)
        ));
    }

    #[test]
    fn other_files_and_newer_versions_are_told_apart() {
        assert!(matches!(open("hello", "x"), Err(ShareError::NotAShare)));
        assert!(matches!(
            open("{\"magic\":\"RUSTSCP_VAULT\"}", "x"),
            Err(ShareError::NotAShare)
        ));
        let original = shared(prepare_site(&site(AuthMethod::None)).unwrap());
        let file = seal_with_iterations(&original, "ABCD-EFGH-JKMN", FAST).unwrap();
        let mut env: ShareEnvelope = serde_json::from_str(&file).unwrap();
        env.version = 2;
        assert!(matches!(
            open(&serde_json::to_string(&env).unwrap(), "ABCD-EFGH-JKMN"),
            Err(ShareError::UnsupportedVersion(2))
        ));
        let mut env: ShareEnvelope = serde_json::from_str(&file).unwrap();
        env.kdf_iterations = 1;
        assert!(matches!(
            open(&serde_json::to_string(&env).unwrap(), "ABCD-EFGH-JKMN"),
            Err(ShareError::Invalid(_))
        ));
        assert!(open(&"x".repeat(MAX_SHARE_FILE_BYTES + 1), "x").is_err());
    }

    #[test]
    fn openssh_key_files_are_embedded_not_referenced() {
        let dir = tempfile::tempdir().unwrap();
        let key = dir.path().join("id_ed25519");
        std::fs::write(&key, OPENSSH_ED25519).unwrap();
        let prepared = prepare_site(&site(key_auth(key.to_str().unwrap(), None))).unwrap();
        match &prepared.auth {
            AuthMethod::PrivateKey {
                path,
                passphrase,
                key_data,
            } => {
                assert_eq!(path, "");
                assert_eq!(passphrase, &None);
                assert_eq!(key_data.as_deref(), Some(OPENSSH_ED25519));
            }
            other => panic!("{other:?}"),
        }
        let file = seal_with_iterations(&shared(prepared), "ABCD-EFGH-JKMN", FAST).unwrap();
        std::fs::remove_file(&key).unwrap(); // The recipient never had the file.
        let opened = open(&file, "abcd efgh jkmn").unwrap();
        assert_eq!(opened.site.auth.embedded_key(), Some(OPENSSH_ED25519));
        let preview = opened.preview();
        assert_eq!(preview.auth_kind, "key");
        assert_eq!(preview.key_format.as_deref(), Some("openssh"));
    }

    #[test]
    fn ppk_keys_travel_with_their_passphrase() {
        let dir = tempfile::tempdir().unwrap();
        let key = dir.path().join("cliente.ppk");
        std::fs::write(&key, V3_ENCRYPTED.replace('\n', "\r\n")).unwrap();

        // Without the passphrase saved, sharing would hand over a key nobody can open.
        let err = prepare_site(&site(key_auth(key.to_str().unwrap(), None))).unwrap_err();
        assert!(matches!(err, ShareError::CannotShare(_)), "{err}");
        let err = prepare_site(&site(key_auth(key.to_str().unwrap(), Some("wrong")))).unwrap_err();
        assert!(matches!(err, ShareError::CannotShare(_)), "{err}");

        let prepared =
            prepare_site(&site(key_auth(key.to_str().unwrap(), Some(PASSPHRASE)))).unwrap();
        let file = seal_with_iterations(&shared(prepared), "ABCD-EFGH-JKMN", FAST).unwrap();
        let opened = open(&file, "ABCD-EFGH-JKMN").unwrap();
        let text = opened.site.auth.embedded_key().unwrap();
        assert_eq!(text, V3_ENCRYPTED);
        assert!(crate::ppk::PpkKey::parse(text.as_bytes(), Some(PASSPHRASE)).is_ok());
        assert_eq!(opened.preview().key_format.as_deref(), Some("ppk"));
    }

    #[test]
    fn a_received_key_can_be_shared_again() {
        let mut received = site(key_auth("", None));
        if let AuthMethod::PrivateKey { key_data, .. } = &mut received.auth {
            *key_data = Some(OPENSSH_ED25519.into());
        }
        let prepared = prepare_site(&received).unwrap();
        assert_eq!(prepared.auth.embedded_key(), Some(OPENSSH_ED25519));
    }

    #[test]
    fn unusable_sites_cannot_be_shared() {
        let mut local = site(AuthMethod::None);
        local.protocol = Protocol::Local;
        assert!(prepare_site(&local).is_err());
        assert!(prepare_site(&site(key_auth("", None))).is_err());
        assert!(prepare_site(&site(key_auth("/no/such/key", None))).is_err());
        let mut no_host = site(AuthMethod::None);
        no_host.host = " ".into();
        assert!(prepare_site(&no_host).is_err());
    }

    #[test]
    fn opened_files_are_cleaned() {
        // A crafted file: a key *path* (a file on the recipient's computer), control
        // characters, a site id and folder.
        let mut crafted = site(AuthMethod::PrivateKey {
            path: "/etc/ssh/ssh_host_ed25519_key".into(),
            passphrase: None,
            key_data: Some(OPENSSH_ED25519.into()),
        });
        crafted.name = "Evil\u{1b}[31m".into();
        let mut payload = shared(crafted);
        payload.note = "a\u{0}b\r\nc".into();
        let file = seal_with_iterations(&payload, "ABCD-EFGH-JKMN", FAST).unwrap();
        let opened = open(&file, "ABCD-EFGH-JKMN").unwrap();
        assert!(
            matches!(&opened.site.auth, AuthMethod::PrivateKey { path, .. } if path.is_empty())
        );
        assert_eq!(opened.site.name, "Evil[31m");
        assert_eq!(opened.site.id, "");
        assert_eq!(opened.site.group, None);
        assert_eq!(opened.note, "ab\nc");

        // A key site whose key is missing, or a path only, is refused.
        let path_only = shared(site(key_auth("/home/u/.ssh/id_rsa", None)));
        let file = seal_with_iterations(&path_only, "ABCD-EFGH-JKMN", FAST).unwrap();
        assert!(matches!(
            open(&file, "ABCD-EFGH-JKMN"),
            Err(ShareError::Invalid(_))
        ));

        let mut local = shared(site(AuthMethod::None));
        local.site.protocol = Protocol::Local;
        let file = seal_with_iterations(&local, "ABCD-EFGH-JKMN", FAST).unwrap();
        assert!(matches!(
            open(&file, "ABCD-EFGH-JKMN"),
            Err(ShareError::Invalid(_))
        ));
    }

    /// End-to-end against a real sshd: a site shared with its OpenSSH key (and, when
    /// authorized, the PuTTY test key) logs in without any key file, and the server is
    /// held to the shared host key. Ignored by default; needs RUSTSCP_LIVE_SSH_PORT,
    /// RUSTSCP_LIVE_SSH_KEY (an OpenSSH key authorized there), RUSTSCP_CONFIG_DIR (scratch,
    /// receives known_hosts) and optionally RUSTSCP_LIVE_SSH_PPK=1 when the public key of
    /// `ppk::tests::V3_ENCRYPTED` is authorized too:
    /// `cargo test -p rustscp-core live_shared -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn live_shared_connection() {
        use crate::known_hosts::HostKeyStore;
        use crate::sftp::SftpDriver;
        use crate::vfs::VirtualFileSystem;

        let port: u16 = std::env::var("RUSTSCP_LIVE_SSH_PORT")
            .unwrap()
            .parse()
            .unwrap();
        let key = std::env::var("RUSTSCP_LIVE_SSH_KEY").unwrap();
        let cfg_dir = std::env::var("RUSTSCP_CONFIG_DIR").unwrap();
        let known_hosts = std::path::Path::new(&cfg_dir).join("known_hosts");
        let mut sender_site = site(key_auth(&key, None));
        sender_site.host = "127.0.0.1".into();
        sender_site.port = port;
        sender_site.username = std::env::var("USER").unwrap();
        sender_site.remote_root = "/".into();

        // The sender connects once (trusting the server on first use), then shares.
        let _ = std::fs::remove_file(&known_hosts);
        SftpDriver::new(sender_site.clone())
            .connect()
            .await
            .unwrap();
        let store = HostKeyStore::for_current_user();
        let host_keys: Vec<String> = store
            .host_keys("127.0.0.1", port)
            .iter()
            .filter_map(|b| format_host_key(b))
            .collect();
        assert_eq!(host_keys.len(), 1, "{host_keys:?}");
        let mut payload = shared(prepare_site(&sender_site).unwrap());
        payload.host_keys = host_keys;
        payload.start_path = "/tmp".into();
        let code = generate_access_code();
        let file = seal(&payload, &code).unwrap();

        // The recipient never saw the server or the key file.
        let _ = std::fs::remove_file(&known_hosts);
        let opened = open(&file, &code).unwrap();
        assert!(opened.site.auth.embedded_key().is_some());
        assert_eq!(
            store
                .trust_shared_keys(
                    &opened.site.host,
                    opened.site.port,
                    &opened.host_key_blobs()
                )
                .unwrap(),
            1
        );
        let drv = SftpDriver::new(opened.site.clone());
        drv.connect().await.unwrap();
        let listing = drv.list_dir(&opened.start_path).await.unwrap();
        println!(
            "OpenSSH key from the share: listed {} entries in /tmp",
            listing.len()
        );

        // A share that names another host key: the real server is refused.
        let _ = std::fs::remove_file(&known_hosts);
        let wrong = embedded_key::inspect(OPENSSH_ED25519)
            .unwrap()
            .public_key
            .unwrap();
        let wrong_blob = BASE64
            .decode(wrong.split_whitespace().nth(1).unwrap())
            .unwrap();
        store
            .trust_shared_keys("127.0.0.1", port, &[wrong_blob])
            .unwrap();
        let err = SftpDriver::new(opened.site.clone())
            .connect()
            .await
            .unwrap_err();
        assert!(
            matches!(err, crate::types::CoreError::HostKeyMismatch(_)),
            "{err}"
        );
        println!("Wrong shared host key refused: {err}");

        if std::env::var("RUSTSCP_LIVE_SSH_PPK").is_ok() {
            let _ = std::fs::remove_file(&known_hosts);
            let dir = tempfile::tempdir().unwrap();
            let ppk = dir.path().join("client.ppk");
            std::fs::write(&ppk, V3_ENCRYPTED).unwrap();
            let mut ppk_site = sender_site.clone();
            ppk_site.auth = key_auth(ppk.to_str().unwrap(), Some(PASSPHRASE));
            let file = seal(&shared(prepare_site(&ppk_site).unwrap()), &code).unwrap();
            drop(dir); // The .ppk file is gone before the recipient connects.
            let opened = open(&file, &code).unwrap();
            let drv = SftpDriver::new(opened.site.clone());
            drv.connect().await.unwrap();
            assert!(drv.list_dir("/").await.is_ok());
            println!("PuTTY key from the share: logged in");
        }
    }

    #[test]
    fn host_keys_are_carried_and_checked() {
        let info = embedded_key::inspect(OPENSSH_ED25519).unwrap();
        let line = info.public_key.unwrap();
        let blob = BASE64
            .decode(line.split_whitespace().nth(1).unwrap())
            .unwrap();
        assert_eq!(format_host_key(&blob).as_deref(), Some(line.as_str()));

        let mut payload = shared(site(AuthMethod::None));
        payload.host_keys = vec![line.clone()];
        let file = seal_with_iterations(&payload, "ABCD-EFGH-JKMN", FAST).unwrap();
        let opened = open(&file, "ABCD-EFGH-JKMN").unwrap();
        assert_eq!(opened.host_key_blobs(), vec![blob.clone()]);
        assert_eq!(
            opened.preview().host_key_fingerprints,
            vec![known_hosts::fingerprint_sha256(&blob)]
        );
        assert_eq!(opened.preview().auth_kind, "agent");

        // A key whose type does not match its blob is refused.
        payload.host_keys = vec![format!("ssh-rsa {}", BASE64.encode(&blob))];
        let file = seal_with_iterations(&payload, "ABCD-EFGH-JKMN", FAST).unwrap();
        assert!(matches!(
            open(&file, "ABCD-EFGH-JKMN"),
            Err(ShareError::Invalid(_))
        ));
    }
}

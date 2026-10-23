//! PuTTY private key files (`.ppk`, formats 2 and 3).
//!
//! PuTTYgen, WinSCP and Pageant keep SSH keys in this format, which libssh2 (the SSH
//! library behind [`crate::sftp`]) cannot read. [`PpkKey::parse`] reads one: it decrypts
//! the private part when the file has a passphrase (AES-256-CBC, with the key derived by
//! SHA-1 in format 2 and by Argon2 in format 3) and checks the file's MAC, so a wrong
//! passphrase and a damaged file are told apart from a key the server rejects.
//! [`PpkKey::to_openssh`] then writes the same key in OpenSSH's `openssh-key-v1` format.
//! The SFTP driver hands that text to libssh2 from memory, so a decrypted key never
//! reaches the disk; [`write_openssh_copy`] saves it for the system `ssh` client, which
//! only reads key files.
//!
//! RSA, DSA, ECDSA (NIST P-256, P-384, P-521) and Ed25519 keys are read: every key type
//! libssh2 logs in with. Ed448 keys and certificates are reported as unsupported.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use hmac::{Hmac, Mac};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use std::fmt;
use std::io::Read;
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

/// First bytes of every PuTTY private key file.
const PPK_MAGIC: &[u8] = b"PuTTY-User-Key-File-";
const UTF8_BOM: &[u8] = b"\xEF\xBB\xBF";
/// Largest `.ppk` read. A 16384-bit RSA key, the largest PuTTYgen makes, is about 13 KiB.
const MAX_PPK_BYTES: u64 = 256 * 1024;
/// Most base64 lines in the public or the private section (64 characters each).
const MAX_SECTION_LINES: usize = 4096;
/// Argon2 costs accepted from a file; PuTTYgen uses 8 MiB, one lane and the passes that
/// take about 0.1 s. The caps keep a hand-edited file from taking all memory or forever.
const MAX_ARGON2_MEMORY_KIB: u32 = 1024 * 1024;
const MAX_ARGON2_PASSES: u32 = 10_000;
const MAX_ARGON2_PARALLELISM: u32 = 64;
/// Most memory × passes (KiB): 8192 passes over PuTTYgen's 8 MiB, 64 over 1 GiB.
const MAX_ARGON2_WORK: u64 = 1 << 26;
/// bcrypt rounds of a key re-encrypted for OpenSSH: ssh-keygen's default.
const OPENSSH_BCRYPT_ROUNDS: u32 = 16;
/// Key types read, which are the ones libssh2 can log in with.
const SUPPORTED_ALGORITHMS: &[&str] = &[
    "ssh-rsa",
    "ssh-dss",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "ssh-ed25519",
];

/// Why a `.ppk` file could not be used.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PpkError {
    /// The file does not start like a PuTTY private key.
    NotPpk,
    /// The file could not be read.
    Io(String),
    /// A format other than 2 or 3 (format 1 is from PuTTY 0.52 and older).
    UnsupportedVersion(String),
    UnsupportedAlgorithm(String),
    UnsupportedEncryption(String),
    UnsupportedKeyDerivation(String),
    /// The key is encrypted and no passphrase was given.
    PassphraseRequired,
    /// The key is encrypted and the passphrase does not open it.
    WrongPassphrase,
    /// The file is damaged or hand-edited.
    Malformed(String),
}

impl fmt::Display for PpkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PpkError::NotPpk => write!(f, "not a PuTTY private key file"),
            PpkError::Io(e) => write!(f, "could not read the key file: {}", e),
            PpkError::UnsupportedVersion(v) => write!(
                f,
                "PuTTY key file format {} is not supported (RustSCP reads formats 2 and 3); \
                 save the key again with a current PuTTYgen",
                v
            ),
            PpkError::UnsupportedAlgorithm(a) => write!(
                f,
                "{} keys are not supported (RustSCP reads RSA, DSA, ECDSA and Ed25519 keys)",
                a
            ),
            PpkError::UnsupportedEncryption(e) => {
                write!(f, "unsupported PuTTY key encryption '{}'", e)
            }
            PpkError::UnsupportedKeyDerivation(k) => {
                write!(f, "unsupported PuTTY key derivation '{}'", k)
            }
            PpkError::PassphraseRequired => write!(
                f,
                "the key is protected by a passphrase; enter it in the site's settings"
            ),
            PpkError::WrongPassphrase => write!(f, "wrong passphrase for this key"),
            PpkError::Malformed(m) => write!(f, "the PuTTY key file is damaged ({})", m),
        }
    }
}

impl std::error::Error for PpkError {}

fn malformed(what: &str) -> PpkError {
    PpkError::Malformed(what.to_string())
}

/// Whether `data` is a PuTTY private key file, judged by its first bytes.
pub fn is_ppk(data: &[u8]) -> bool {
    data.strip_prefix(UTF8_BOM)
        .unwrap_or(data)
        .starts_with(PPK_MAGIC)
}

/// Whether `path` is a PuTTY private key file, judged by its first bytes, not its name;
/// `false` when it cannot be read.
pub fn is_ppk_file(path: &Path) -> bool {
    let mut head = [0u8; UTF8_BOM.len() + PPK_MAGIC.len()];
    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };
    let mut read = 0;
    let mut reader = file.take(head.len() as u64);
    while read < head.len() {
        match reader.read(&mut head[read..]) {
            Ok(0) | Err(_) => break,
            Ok(n) => read += n,
        }
    }
    is_ppk(&head[..read])
}

/// A PuTTY private key, decrypted. The private part is wiped from memory when dropped.
pub struct PpkKey {
    algorithm: String,
    comment: Vec<u8>,
    encrypted: bool,
    public_blob: Vec<u8>,
    /// The key type and private fields in the order of OpenSSH's private section.
    openssh_private: Zeroizing<Vec<u8>>,
}

impl fmt::Debug for PpkKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PpkKey")
            .field("algorithm", &self.algorithm)
            .field("comment", &self.comment())
            .field("private", &"<redacted>")
            .finish()
    }
}

/// Key derivation of an encrypted format 3 file.
struct Argon2Params {
    algorithm: argon2::Algorithm,
    memory_kib: u32,
    passes: u32,
    parallelism: u32,
    salt: Vec<u8>,
}

impl PpkKey {
    /// Reads and decrypts the key file at `path`.
    pub fn from_file(path: &Path, passphrase: Option<&str>) -> Result<Self, PpkError> {
        let file = std::fs::File::open(path).map_err(|e| PpkError::Io(e.to_string()))?;
        let mut data = Zeroizing::new(Vec::new());
        file.take(MAX_PPK_BYTES + 1)
            .read_to_end(&mut data)
            .map_err(|e| PpkError::Io(e.to_string()))?;
        if data.len() as u64 > MAX_PPK_BYTES {
            return Err(malformed("the file is too large for a key"));
        }
        Self::parse(&data, passphrase)
    }

    /// Reads the contents of a `.ppk` file. `passphrase` is only used when the key is
    /// encrypted; an empty one counts as none.
    pub fn parse(data: &[u8], passphrase: Option<&str>) -> Result<Self, PpkError> {
        let data = data.strip_prefix(UTF8_BOM).unwrap_or(data);
        if !data.starts_with(PPK_MAGIC) {
            return Err(PpkError::NotPpk);
        }
        let mut lines = Lines::new(data);

        let first = lines.next_line().ok_or_else(|| malformed("no header"))?;
        let rest = &first[PPK_MAGIC.len()..];
        let colon = rest
            .iter()
            .position(|&b| b == b':')
            .ok_or_else(|| malformed("no key type"))?;
        let version = text(&rest[..colon]).trim().to_string();
        if version != "2" && version != "3" {
            return Err(PpkError::UnsupportedVersion(version));
        }
        let v3 = version == "3";
        let algorithm = text(header_value(&rest[colon..]).ok_or_else(|| malformed("no key type"))?)
            .trim()
            .to_string();
        if !SUPPORTED_ALGORITHMS.contains(&algorithm.as_str()) {
            return Err(PpkError::UnsupportedAlgorithm(algorithm));
        }

        let encryption = text(lines.field("Encryption")?).trim().to_string();
        let encrypted = match encryption.as_str() {
            "none" => false,
            "aes256-cbc" => true,
            _ => return Err(PpkError::UnsupportedEncryption(encryption)),
        };
        // Covered by the MAC byte for byte, so it is kept exactly as written.
        let comment = lines.field("Comment")?.to_vec();
        let public_blob = lines.base64_section("Public-Lines")?;

        let argon2 = if v3 && encrypted {
            let kdf = text(lines.field("Key-Derivation")?).trim().to_string();
            let algorithm = match kdf.as_str() {
                "Argon2id" => argon2::Algorithm::Argon2id,
                "Argon2i" => argon2::Algorithm::Argon2i,
                "Argon2d" => argon2::Algorithm::Argon2d,
                _ => return Err(PpkError::UnsupportedKeyDerivation(kdf)),
            };
            let memory_kib = lines.number("Argon2-Memory", MAX_ARGON2_MEMORY_KIB)?;
            let passes = lines.number("Argon2-Passes", MAX_ARGON2_PASSES)?;
            let parallelism = lines.number("Argon2-Parallelism", MAX_ARGON2_PARALLELISM)?;
            if u64::from(memory_kib) * u64::from(passes) > MAX_ARGON2_WORK {
                return Err(malformed("the Argon2 costs are too high"));
            }
            let salt = hex::decode(text(lines.field("Argon2-Salt")?).trim())
                .map_err(|_| malformed("bad Argon2 salt"))?;
            Some(Argon2Params {
                algorithm,
                memory_kib,
                passes,
                parallelism,
                salt,
            })
        } else {
            None
        };

        let mut private_blob = Zeroizing::new(lines.base64_section("Private-Lines")?);
        let mac = hex::decode(text(lines.field("Private-MAC")?).trim())
            .map_err(|_| malformed("bad MAC"))?;

        let passphrase = passphrase.filter(|p| !p.is_empty());
        if encrypted && passphrase.is_none() {
            return Err(PpkError::PassphraseRequired);
        }
        let pass = passphrase.unwrap_or("").as_bytes();

        // Cipher key, IV and MAC key, as PuTTY derives them (`ssh2_ppk_derive_keys`).
        let mut cipher_key = Zeroizing::new([0u8; 32]);
        let mut cipher_iv = [0u8; 16];
        let mut mac_key = Zeroizing::new(Vec::new());
        if v3 {
            if let Some(params) = &argon2 {
                let mut out = Zeroizing::new([0u8; 80]);
                let costs = argon2::Params::new(
                    params.memory_kib,
                    params.passes,
                    params.parallelism,
                    Some(out.len()),
                )
                .map_err(|e| PpkError::Malformed(format!("bad Argon2 parameters: {}", e)))?;
                argon2::Argon2::new(params.algorithm, argon2::Version::V0x13, costs)
                    .hash_password_into(pass, &params.salt, &mut out[..])
                    .map_err(|e| PpkError::Malformed(format!("bad Argon2 parameters: {}", e)))?;
                cipher_key.copy_from_slice(&out[..32]);
                cipher_iv.copy_from_slice(&out[32..48]);
                mac_key.extend_from_slice(&out[48..]);
            }
            // An unencrypted format 3 file is MACed with an empty key.
        } else {
            if encrypted {
                let mut hash = Zeroizing::new(Vec::with_capacity(40));
                for counter in 0u32..2 {
                    let mut h = Sha1::new();
                    h.update(counter.to_be_bytes());
                    h.update(pass);
                    hash.extend_from_slice(&h.finalize());
                }
                cipher_key.copy_from_slice(&hash[..32]);
                // Format 2 always used an all-zero IV.
            }
            let mut h = Sha1::new();
            h.update(b"putty-private-key-file-mac-key");
            if encrypted {
                h.update(pass);
            }
            mac_key.extend_from_slice(&h.finalize());
        }

        if encrypted {
            use cbc::cipher::{block_padding::NoPadding, BlockDecryptMut, KeyIvInit};
            if private_blob.is_empty() || private_blob.len() % 16 != 0 {
                return Err(malformed("the private key is not whole AES blocks"));
            }
            cbc::Decryptor::<aes::Aes256>::new_from_slices(&cipher_key[..], &cipher_iv)
                .map_err(|_| malformed("bad cipher key"))?
                .decrypt_padded_mut::<NoPadding>(&mut private_blob)
                .map_err(|_| malformed("the private key is not whole AES blocks"))?;
        }

        let mut mac_data = Zeroizing::new(Vec::new());
        put_string(&mut mac_data, algorithm.as_bytes());
        put_string(&mut mac_data, encryption.as_bytes());
        put_string(&mut mac_data, &comment);
        put_string(&mut mac_data, &public_blob);
        put_string(&mut mac_data, &private_blob);
        let mac_ok = if v3 {
            let mut m = Hmac::<Sha256>::new_from_slice(&mac_key).expect("HMAC takes any key");
            m.update(&mac_data);
            m.verify_slice(&mac).is_ok()
        } else {
            let mut m = Hmac::<Sha1>::new_from_slice(&mac_key).expect("HMAC takes any key");
            m.update(&mac_data);
            m.verify_slice(&mac).is_ok()
        };
        if !mac_ok {
            return Err(if encrypted {
                PpkError::WrongPassphrase
            } else {
                malformed("its checksum does not match; the file was changed or is incomplete")
            });
        }

        let openssh_private = openssh_private_fields(&algorithm, &public_blob, &private_blob)?;
        Ok(PpkKey {
            algorithm,
            comment,
            encrypted,
            public_blob,
            openssh_private,
        })
    }

    /// The key type, as SSH names it (`ssh-rsa`, `ssh-ed25519`, ...).
    pub fn algorithm(&self) -> &str {
        &self.algorithm
    }

    pub fn comment(&self) -> String {
        String::from_utf8_lossy(&self.comment).into_owned()
    }

    /// Whether the file was protected by a passphrase.
    pub fn is_encrypted(&self) -> bool {
        self.encrypted
    }

    /// The public key as one OpenSSH `authorized_keys` line, without the comment.
    pub fn public_key(&self) -> String {
        format!("{} {}", self.algorithm, BASE64.encode(&self.public_blob))
    }

    /// SHA-256 fingerprint of the public key, as `ssh-keygen -l` prints it.
    pub fn fingerprint_sha256(&self) -> String {
        let digest = Sha256::digest(&self.public_blob);
        format!(
            "SHA256:{}",
            base64::engine::general_purpose::STANDARD_NO_PAD.encode(digest)
        )
    }

    /// The key as an OpenSSH private key file (`-----BEGIN OPENSSH PRIVATE KEY-----`).
    /// With a `passphrase` it is encrypted the way ssh-keygen does (bcrypt KDF,
    /// AES-256-CTR); without one it is stored in the clear.
    pub fn to_openssh(&self, passphrase: Option<&str>) -> Result<Zeroizing<String>, PpkError> {
        let passphrase = passphrase.filter(|p| !p.is_empty());
        let block = if passphrase.is_some() { 16 } else { 8 };

        let mut private = Zeroizing::new(Vec::with_capacity(
            self.openssh_private.len() + self.comment.len() + 12 + block,
        ));
        // Two equal check integers let a reader tell a wrong passphrase from a key.
        let check: u32 = rand::random();
        private.extend_from_slice(&check.to_be_bytes());
        private.extend_from_slice(&check.to_be_bytes());
        private.extend_from_slice(&self.openssh_private);
        put_string(&mut private, &self.comment);
        let mut pad = 1u8;
        while private.len() % block != 0 {
            private.push(pad);
            pad += 1;
        }

        let mut kdf_options = Vec::new();
        let (cipher, kdf) = match passphrase {
            None => ("none", "none"),
            Some(pass) => {
                use ctr::cipher::{KeyIvInit, StreamCipher};
                let salt: [u8; 16] = rand::random();
                let mut key_iv = Zeroizing::new([0u8; 48]);
                bcrypt_pbkdf::bcrypt_pbkdf(pass, &salt, OPENSSH_BCRYPT_ROUNDS, &mut key_iv[..])
                    .map_err(|e| PpkError::Malformed(format!("key derivation failed: {}", e)))?;
                ctr::Ctr128BE::<aes::Aes256>::new_from_slices(&key_iv[..32], &key_iv[32..])
                    .map_err(|_| malformed("bad cipher key"))?
                    .apply_keystream(&mut private);
                put_string(&mut kdf_options, &salt);
                kdf_options.extend_from_slice(&OPENSSH_BCRYPT_ROUNDS.to_be_bytes());
                ("aes256-ctr", "bcrypt")
            }
        };

        let mut blob = Zeroizing::new(Vec::with_capacity(
            64 + kdf_options.len() + self.public_blob.len() + private.len(),
        ));
        blob.extend_from_slice(b"openssh-key-v1\0");
        put_string(&mut blob, cipher.as_bytes());
        put_string(&mut blob, kdf.as_bytes());
        put_string(&mut blob, &kdf_options);
        blob.extend_from_slice(&1u32.to_be_bytes());
        put_string(&mut blob, &self.public_blob);
        put_string(&mut blob, &private);

        const BEGIN: &str = "-----BEGIN OPENSSH PRIVATE KEY-----\n";
        const END: &str = "-----END OPENSSH PRIVATE KEY-----\n";
        let encoded = Zeroizing::new(BASE64.encode(&blob[..]));
        // Sized up front so the text holding the key is never reallocated (and copied).
        let mut pem = Zeroizing::new(String::with_capacity(
            BEGIN.len() + encoded.len() + encoded.len() / 70 + 1 + END.len(),
        ));
        pem.push_str(BEGIN);
        for line in encoded.as_bytes().chunks(70) {
            pem.push_str(std::str::from_utf8(line).expect("base64 is ASCII"));
            pem.push('\n');
        }
        pem.push_str(END);
        Ok(pem)
    }
}

/// Saves the key of the `.ppk` file at `ppk_path` in OpenSSH format inside `dir`, for
/// programs that only read OpenSSH keys (the system `ssh` client), and returns the new
/// file's path. An encrypted key stays encrypted with the same `passphrase`, so the copy
/// is never easier to use than the original. The copy is private to the user (0600 in a
/// 0700 folder on Unix) and named after `ppk_path`, so each key has one copy, replaced on
/// every call.
pub fn write_openssh_copy(
    ppk_path: &Path,
    passphrase: Option<&str>,
    dir: &Path,
) -> Result<PathBuf, PpkError> {
    let key = PpkKey::from_file(ppk_path, passphrase)?;
    let pem = key.to_openssh(if key.is_encrypted() { passphrase } else { None })?;

    let source = std::fs::canonicalize(ppk_path).unwrap_or_else(|_| ppk_path.to_path_buf());
    let digest = Sha256::digest(source.to_string_lossy().as_bytes());
    let name = format!("putty-{}", hex::encode(&digest[..12]));
    write_private_key_file(dir, &name, &pem).map_err(|e| PpkError::Io(e.to_string()))
}

/// Writes `contents` atomically as `dir/name`, private to the user (0600 in a 0700
/// folder on Unix), replacing an older file of that name.
pub(crate) fn write_private_key_file(
    dir: &Path,
    name: &str,
    contents: &str,
) -> std::io::Result<PathBuf> {
    use std::io::Write;

    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    let target = dir.join(name);
    let temp = dir.join(format!(".{}-{}.tmp", name, uuid::Uuid::new_v4().simple()));

    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let written = options
        .open(&temp)
        .and_then(|mut f| f.write_all(contents.as_bytes()).and_then(|()| f.sync_all()))
        .and_then(|()| std::fs::rename(&temp, &target));
    if let Err(e) = written {
        let _ = std::fs::remove_file(&temp);
        return Err(e);
    }
    Ok(target)
}

/// The key type and private fields in OpenSSH's order, from PuTTY's public and private
/// blobs (`*_private_blob` and `*_openssh_blob` in PuTTY's `crypto/`).
fn openssh_private_fields(
    algorithm: &str,
    public_blob: &[u8],
    private_blob: &[u8],
) -> Result<Zeroizing<Vec<u8>>, PpkError> {
    let mut public = Reader(public_blob);
    if public.string()? != algorithm.as_bytes() {
        return Err(malformed("the public key does not match the key type"));
    }
    // Any bytes after the private fields are the padding of an encrypted format 2 file.
    let mut private = Reader(private_blob);
    let mut out = Zeroizing::new(Vec::with_capacity(
        public_blob.len() + private_blob.len() + 64,
    ));
    put_string(&mut out, algorithm.as_bytes());
    match algorithm {
        "ssh-rsa" => {
            let (e, n) = (public.mpint()?, public.mpint()?);
            let (d, p, q, iqmp) = (
                private.mpint()?,
                private.mpint()?,
                private.mpint()?,
                private.mpint()?,
            );
            for field in [n, e, d, iqmp, p, q] {
                put_string(&mut out, field);
            }
        }
        "ssh-dss" => {
            let (p, q, g, y) = (
                public.mpint()?,
                public.mpint()?,
                public.mpint()?,
                public.mpint()?,
            );
            let x = private.mpint()?;
            for field in [p, q, g, y, x] {
                put_string(&mut out, field);
            }
        }
        "ssh-ed25519" => {
            let public_key = public.string()?;
            if public_key.len() != 32 {
                return Err(malformed("bad Ed25519 public key"));
            }
            // The secret is stored as a little-endian integer; files from older PuTTY
            // versions leave out its high zero bytes, which come last.
            let secret = private.string()?;
            if secret.len() > 32 {
                return Err(malformed("bad Ed25519 private key"));
            }
            let mut pair = Zeroizing::new([0u8; 64]);
            pair[..secret.len()].copy_from_slice(secret);
            pair[32..].copy_from_slice(public_key);
            put_string(&mut out, public_key);
            put_string(&mut out, &pair[..]);
        }
        _ => {
            // ecdsa-sha2-nistp256/384/521: the curve name is the type's last part.
            let curve = public.string()?;
            if !algorithm.ends_with(&*text(curve)) || curve.is_empty() {
                return Err(malformed("the curve does not match the key type"));
            }
            let point = public.string()?;
            let d = private.mpint()?;
            for field in [curve, point, d] {
                put_string(&mut out, field);
            }
        }
    }
    Ok(out)
}

fn put_string(out: &mut Vec<u8>, data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(data);
}

fn text(bytes: &[u8]) -> std::borrow::Cow<'_, str> {
    String::from_utf8_lossy(bytes)
}

/// The value after `: ` in a header line, from the colon on.
fn header_value(from_colon: &[u8]) -> Option<&[u8]> {
    from_colon.strip_prefix(b": ")
}

/// SSH wire-format reader over a key blob.
struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    fn string(&mut self) -> Result<&'a [u8], PpkError> {
        let short = || malformed("a key field is cut short");
        let len_bytes: [u8; 4] = self.0.get(..4).ok_or_else(short)?.try_into().unwrap();
        let len = u32::from_be_bytes(len_bytes) as usize;
        let value = self.0.get(4..4 + len).ok_or_else(short)?;
        self.0 = &self.0[4 + len..];
        Ok(value)
    }

    /// An SSH `mpint`: a big-endian two's-complement integer, never negative in a key.
    fn mpint(&mut self) -> Result<&'a [u8], PpkError> {
        let value = self.string()?;
        if value.first().is_some_and(|b| b & 0x80 != 0) {
            return Err(malformed("a key number is negative"));
        }
        Ok(value)
    }
}

/// Line reader over a `.ppk` file. Lines end in LF or CRLF.
struct Lines<'a> {
    rest: &'a [u8],
}

impl<'a> Lines<'a> {
    fn new(data: &'a [u8]) -> Self {
        Lines { rest: data }
    }

    fn next_line(&mut self) -> Option<&'a [u8]> {
        if self.rest.is_empty() {
            return None;
        }
        let (line, rest) = match self.rest.iter().position(|&b| b == b'\n') {
            Some(i) => (&self.rest[..i], &self.rest[i + 1..]),
            None => (self.rest, &self.rest[self.rest.len()..]),
        };
        self.rest = rest;
        Some(line.strip_suffix(b"\r").unwrap_or(line))
    }

    /// The value of the next line, which must be the header `name`.
    fn field(&mut self, name: &str) -> Result<&'a [u8], PpkError> {
        let missing = || PpkError::Malformed(format!("no {} line", name));
        let line = self.next_line().ok_or_else(missing)?;
        line.strip_prefix(name.as_bytes())
            .and_then(header_value)
            .ok_or_else(missing)
    }

    fn number(&mut self, name: &str, max: u32) -> Result<u32, PpkError> {
        text(self.field(name)?)
            .trim()
            .parse::<u32>()
            .ok()
            .filter(|n| *n <= max)
            .ok_or_else(|| PpkError::Malformed(format!("bad {} value", name)))
    }

    /// A `<name>: <count>` header followed by that many lines of base64.
    fn base64_section(&mut self, name: &str) -> Result<Vec<u8>, PpkError> {
        let count = text(self.field(name)?)
            .trim()
            .parse::<usize>()
            .ok()
            .filter(|n| *n <= MAX_SECTION_LINES)
            .ok_or_else(|| PpkError::Malformed(format!("bad {} value", name)))?;
        let mut encoded = Zeroizing::new(Vec::new());
        for _ in 0..count {
            let line = self
                .next_line()
                .ok_or_else(|| malformed("a key section is cut short"))?;
            encoded.extend(line.iter().filter(|b| !b.is_ascii_whitespace()));
        }
        BASE64
            .decode(&encoded[..])
            .map_err(|_| malformed("a key section is not valid base64"))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    // Test vectors from PuTTY's own test suite (`test/cryptsuite.py`, testPPKLoadSave):
    // one Ed25519 key saved in both formats, in the clear and with a passphrase.
    pub(crate) const V3_CLEAR: &str = "\
PuTTY-User-Key-File-3: ssh-ed25519
Encryption: none
Comment: ed25519-key-20200105
Public-Lines: 2
AAAAC3NzaC1lZDI1NTE5AAAAIHJCszOHaI9X/yGLtjn22f0hO6VPMQDVtctkym6F
JH1W
Private-Lines: 1
AAAAIGvvIpl8jyqn8Xufkw6v3FnEGtXF3KWw55AP3/AGEBpY
Private-MAC: 816c84093fc4877e8411b8e5139c5ce35d8387a2630ff087214911d67417a54d
";
    pub(crate) const V3_ENCRYPTED: &str = "\
PuTTY-User-Key-File-3: ssh-ed25519
Encryption: aes256-cbc
Comment: ed25519-key-20200105
Public-Lines: 2
AAAAC3NzaC1lZDI1NTE5AAAAIHJCszOHaI9X/yGLtjn22f0hO6VPMQDVtctkym6F
JH1W
Key-Derivation: Argon2id
Argon2-Memory: 8192
Argon2-Passes: 13
Argon2-Parallelism: 1
Argon2-Salt: 37c3911bfefc8c1d11ec579627d2b3d9
Private-Lines: 1
amviz4sVUBN64jLO3gt4HGXJosUArghc4Soi7aVVLb2Tir5Baj0OQClorycuaPRd
Private-MAC: 6f5e588e475e55434106ec2c3569695b03f423228b44993a9e97d52ffe7be5a8
";
    pub(crate) const V2_CLEAR: &str = "\
PuTTY-User-Key-File-2: ssh-ed25519
Encryption: none
Comment: ed25519-key-20200105
Public-Lines: 2
AAAAC3NzaC1lZDI1NTE5AAAAIHJCszOHaI9X/yGLtjn22f0hO6VPMQDVtctkym6F
JH1W
Private-Lines: 1
AAAAIGvvIpl8jyqn8Xufkw6v3FnEGtXF3KWw55AP3/AGEBpY
Private-MAC: 2a629acfcfbe28488a1ba9b6948c36406bc28422
";
    pub(crate) const V2_ENCRYPTED: &str = "\
PuTTY-User-Key-File-2: ssh-ed25519
Encryption: aes256-cbc
Comment: ed25519-key-20200105
Public-Lines: 2
AAAAC3NzaC1lZDI1NTE5AAAAIHJCszOHaI9X/yGLtjn22f0hO6VPMQDVtctkym6F
JH1W
Private-Lines: 1
4/jKlTgC652oa9HLVGrMjHZw7tj0sKRuZaJPOuLhGTvb25Jzpcqpbi+Uf+y+uo+Z
Private-MAC: 5b1f6f4cc43eb0060d2c3e181bc0129343adba2b
";
    pub(crate) const PASSPHRASE: &str = "test-passphrase";
    pub(crate) const PUBLIC_KEY: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHJCszOHaI9X/yGLtjn22f0hO6VPMQDVtctkym6FJH1W";
    /// The 32-byte secret of the test key, in the clear in its private blob.
    const SECRET_HEX: &str = "6bef22997c8f2aa7f17b9f930eafdc59c41ad5c5dca5b0e7900fdff006101a58";

    /// Decodes an OpenSSH private key file written by [`PpkKey::to_openssh`].
    fn openssh_fields(pem: &str) -> (String, String, Vec<u8>, Vec<u8>) {
        let body: String = pem.lines().filter(|l| !l.starts_with("-----")).collect();
        let blob = BASE64.decode(body).unwrap();
        let rest = blob.strip_prefix(b"openssh-key-v1\0".as_slice()).unwrap();
        let mut r = Reader(rest);
        let cipher = text(r.string().unwrap()).into_owned();
        let kdf = text(r.string().unwrap()).into_owned();
        let _kdf_options = r.string().unwrap();
        assert_eq!(&r.0[..4], &1u32.to_be_bytes()[..]);
        r.0 = &r.0[4..];
        let public = r.string().unwrap().to_vec();
        let private = r.string().unwrap().to_vec();
        assert!(r.0.is_empty());
        (cipher, kdf, public, private)
    }

    #[test]
    fn reads_putty_test_vectors_in_both_formats() {
        for (file, pass) in [
            (V3_CLEAR, None),
            (V3_ENCRYPTED, Some(PASSPHRASE)),
            (V2_CLEAR, None),
            (V2_ENCRYPTED, Some(PASSPHRASE)),
        ] {
            let key = PpkKey::parse(file.as_bytes(), pass).unwrap();
            assert_eq!(key.is_encrypted(), pass.is_some());
            assert_eq!(key.algorithm(), "ssh-ed25519");
            assert_eq!(key.comment(), "ed25519-key-20200105");
            assert_eq!(key.public_key(), PUBLIC_KEY);
            // OpenSSH private section: type, public key, secret || public key.
            let mut r = Reader(&key.openssh_private);
            assert_eq!(r.string().unwrap(), b"ssh-ed25519");
            let public = r.string().unwrap().to_vec();
            let pair = r.string().unwrap();
            assert_eq!(hex::encode(&pair[..32]), SECRET_HEX);
            assert_eq!(&pair[32..], &public[..]);
            assert!(r.0.is_empty());
        }
    }

    #[test]
    fn encrypted_keys_need_the_right_passphrase() {
        for file in [V3_ENCRYPTED, V2_ENCRYPTED] {
            assert_eq!(
                PpkKey::parse(file.as_bytes(), None).unwrap_err(),
                PpkError::PassphraseRequired
            );
            assert_eq!(
                PpkKey::parse(file.as_bytes(), Some("")).unwrap_err(),
                PpkError::PassphraseRequired
            );
            assert_eq!(
                PpkKey::parse(file.as_bytes(), Some("wrong")).unwrap_err(),
                PpkError::WrongPassphrase
            );
        }
        // A passphrase given for a key without one is ignored.
        assert!(PpkKey::parse(V3_CLEAR.as_bytes(), Some("anything")).is_ok());
    }

    #[test]
    fn tampering_is_detected() {
        let changed = V3_CLEAR.replace("ed25519-key-20200105", "ed25519-key-20200106");
        assert!(matches!(
            PpkKey::parse(changed.as_bytes(), None),
            Err(PpkError::Malformed(_))
        ));
        let changed = V2_CLEAR.replace("Private-MAC: 2a", "Private-MAC: 3a");
        assert!(matches!(
            PpkKey::parse(changed.as_bytes(), None),
            Err(PpkError::Malformed(_))
        ));
        let truncated = &V3_CLEAR[..V3_CLEAR.find("Private-Lines").unwrap()];
        assert!(matches!(
            PpkKey::parse(truncated.as_bytes(), None),
            Err(PpkError::Malformed(_))
        ));
    }

    #[test]
    fn windows_line_endings_and_a_bom_are_accepted() {
        let windows = format!("\u{feff}{}", V3_CLEAR.replace('\n', "\r\n"));
        let key = PpkKey::parse(windows.as_bytes(), None).unwrap();
        assert_eq!(key.public_key(), PUBLIC_KEY);
        assert!(is_ppk(windows.as_bytes()));
    }

    #[test]
    fn unsupported_files_are_named() {
        assert_eq!(
            PpkKey::parse(b"-----BEGIN OPENSSH", None).unwrap_err(),
            PpkError::NotPpk
        );
        assert!(!is_ppk(b"-----BEGIN OPENSSH PRIVATE KEY-----"));
        assert_eq!(
            PpkKey::parse(b"PuTTY-User-Key-File-1: ssh-rsa\n", None).unwrap_err(),
            PpkError::UnsupportedVersion("1".into())
        );
        assert_eq!(
            PpkKey::parse(
                b"PuTTY-User-Key-File-3: ssh-ed448\nEncryption: none\n",
                None
            )
            .unwrap_err(),
            PpkError::UnsupportedAlgorithm("ssh-ed448".into())
        );
        let other_cipher = V2_CLEAR.replace("Encryption: none", "Encryption: 3des-cbc");
        assert_eq!(
            PpkKey::parse(other_cipher.as_bytes(), None).unwrap_err(),
            PpkError::UnsupportedEncryption("3des-cbc".into())
        );
    }

    #[test]
    fn hostile_argon2_costs_are_refused_before_hashing() {
        let huge = V3_ENCRYPTED.replace("Argon2-Memory: 8192", "Argon2-Memory: 4294967295");
        assert!(matches!(
            PpkKey::parse(huge.as_bytes(), Some(PASSPHRASE)),
            Err(PpkError::Malformed(_))
        ));
        for passes in ["100000000", "9000"] {
            let slow =
                V3_ENCRYPTED.replace("Argon2-Passes: 13", &format!("Argon2-Passes: {passes}"));
            assert!(matches!(
                PpkKey::parse(slow.as_bytes(), Some(PASSPHRASE)),
                Err(PpkError::Malformed(_))
            ));
        }
    }

    #[test]
    fn openssh_output_is_a_well_formed_key_file() {
        let key = PpkKey::parse(V3_CLEAR.as_bytes(), None).unwrap();
        let pem = key.to_openssh(None).unwrap();
        assert!(pem.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----\n"));
        assert!(pem.ends_with("-----END OPENSSH PRIVATE KEY-----\n"));
        assert!(pem.lines().all(|l| l.len() <= 70));
        let (cipher, kdf, public, private) = openssh_fields(&pem);
        assert_eq!((cipher.as_str(), kdf.as_str()), ("none", "none"));
        assert_eq!(public, key.public_blob);
        assert_eq!(private.len() % 8, 0);
        assert_eq!(&private[..4], &private[4..8], "check integers");
        let mut r = Reader(&private[8..]);
        assert_eq!(r.string().unwrap(), b"ssh-ed25519");
        r.string().unwrap();
        r.string().unwrap();
        assert_eq!(r.string().unwrap(), b"ed25519-key-20200105");
        // Padding is 1, 2, 3, ...
        assert!(r.0.iter().enumerate().all(|(i, b)| *b as usize == i + 1));
    }

    #[test]
    fn openssh_output_with_a_passphrase_is_encrypted() {
        let key = PpkKey::parse(V2_CLEAR.as_bytes(), None).unwrap();
        let plain = key.to_openssh(None).unwrap();
        let pem = key.to_openssh(Some("secret")).unwrap();
        let (cipher, kdf, public, private) = openssh_fields(&pem);
        assert_eq!((cipher.as_str(), kdf.as_str()), ("aes256-ctr", "bcrypt"));
        assert_eq!(public, key.public_blob);
        assert_eq!(private.len() % 16, 0);
        let (_, _, _, clear) = openssh_fields(&plain);
        assert!(
            !private.windows(32).any(|w| hex::encode(w) == SECRET_HEX),
            "the secret is not stored in the clear"
        );
        assert!(clear.windows(32).any(|w| hex::encode(w) == SECRET_HEX));
    }

    /// Builds a format 2 file, unencrypted, around the given blobs.
    fn v2_file(algorithm: &str, public: &[u8], private: &[u8]) -> String {
        let mut mac_data = Vec::new();
        for field in [algorithm.as_bytes(), b"none", b"test", public, private] {
            put_string(&mut mac_data, field);
        }
        let mac_key = Sha1::digest(b"putty-private-key-file-mac-key");
        let mut mac = Hmac::<Sha1>::new_from_slice(&mac_key).unwrap();
        mac.update(&mac_data);
        let lines = |blob: &[u8]| {
            let b64 = BASE64.encode(blob);
            let chunks: Vec<&str> = b64
                .as_bytes()
                .chunks(64)
                .map(|c| std::str::from_utf8(c).unwrap())
                .collect();
            format!("{}\n{}", chunks.len(), chunks.join("\n"))
        };
        format!(
            "PuTTY-User-Key-File-2: {algorithm}\nEncryption: none\nComment: test\n\
             Public-Lines: {}\nPrivate-Lines: {}\nPrivate-MAC: {}\n",
            lines(public),
            lines(private),
            hex::encode(mac.finalize().into_bytes())
        )
    }

    fn blob(fields: &[&[u8]]) -> Vec<u8> {
        let mut out = Vec::new();
        for f in fields {
            put_string(&mut out, f);
        }
        out
    }

    #[test]
    fn rsa_fields_are_reordered_for_openssh() {
        let public = blob(&[b"ssh-rsa", b"\x01\x00\x01", b"\x00\xc5nnnn"]);
        let private = blob(&[b"dddd", b"\x00\xe1pp", b"\x00\xf3qq", b"iqmp"]);
        let key = PpkKey::parse(v2_file("ssh-rsa", &public, &private).as_bytes(), None).unwrap();
        assert_eq!(
            &key.openssh_private[..],
            &blob(&[
                b"ssh-rsa",
                b"\x00\xc5nnnn",
                b"\x01\x00\x01",
                b"dddd",
                b"iqmp",
                b"\x00\xe1pp",
                b"\x00\xf3qq",
            ])[..]
        );
    }

    #[test]
    fn ecdsa_and_dsa_fields_follow_the_public_ones() {
        let public = blob(&[b"ecdsa-sha2-nistp256", b"nistp256", b"\x04point"]);
        let private = blob(&[b"\x00\x80d"]);
        let key = PpkKey::parse(
            v2_file("ecdsa-sha2-nistp256", &public, &private).as_bytes(),
            None,
        )
        .unwrap();
        assert_eq!(
            &key.openssh_private[..],
            &blob(&[
                b"ecdsa-sha2-nistp256",
                b"nistp256",
                b"\x04point",
                b"\x00\x80d"
            ])[..]
        );
        let wrong_curve = blob(&[b"ecdsa-sha2-nistp256", b"nistp384", b"\x04point"]);
        assert!(PpkKey::parse(
            v2_file("ecdsa-sha2-nistp256", &wrong_curve, &private).as_bytes(),
            None
        )
        .is_err());

        let public = blob(&[b"ssh-dss", b"p", b"q", b"g", b"y"]);
        let private = blob(&[b"x"]);
        let key = PpkKey::parse(v2_file("ssh-dss", &public, &private).as_bytes(), None).unwrap();
        assert_eq!(
            &key.openssh_private[..],
            &blob(&[b"ssh-dss", b"p", b"q", b"g", b"y", b"x"])[..]
        );
    }

    #[test]
    fn short_ed25519_secrets_are_padded_at_the_high_end() {
        let public = blob(&[b"ssh-ed25519", &[7u8; 32]]);
        let private = blob(&[&[9u8; 31]]);
        let key =
            PpkKey::parse(v2_file("ssh-ed25519", &public, &private).as_bytes(), None).unwrap();
        let mut r = Reader(&key.openssh_private);
        r.string().unwrap();
        r.string().unwrap();
        let pair = r.string().unwrap();
        assert_eq!(&pair[..31], &[9u8; 31]);
        assert_eq!(pair[31], 0);
        assert_eq!(&pair[32..], &[7u8; 32]);
    }

    #[test]
    fn mismatched_or_cut_blobs_are_refused() {
        let public = blob(&[b"ssh-dss", b"p", b"q", b"g", b"y"]);
        assert!(
            PpkKey::parse(v2_file("ssh-rsa", &public, &blob(&[b"x"])).as_bytes(), None).is_err()
        );
        let public = blob(&[b"ssh-rsa", b"\x01\x00\x01", b"\x00\xc5nnnn"]);
        let cut = blob(&[b"dddd", b"pp"]);
        assert!(PpkKey::parse(v2_file("ssh-rsa", &public, &cut).as_bytes(), None).is_err());
        let negative = blob(&[b"\x80ddd", b"pp", b"qq", b"iqmp"]);
        assert!(PpkKey::parse(v2_file("ssh-rsa", &public, &negative).as_bytes(), None).is_err());
    }

    #[test]
    fn files_are_sniffed_by_content() {
        let dir = tempfile::tempdir().unwrap();
        let ppk = dir.path().join("renamed-key");
        std::fs::write(&ppk, V3_ENCRYPTED).unwrap();
        let openssh = dir.path().join("id_ed25519.ppk");
        std::fs::write(&openssh, "-----BEGIN OPENSSH PRIVATE KEY-----\n").unwrap();
        assert!(is_ppk_file(&ppk));
        assert!(!is_ppk_file(&openssh));
        assert!(!is_ppk_file(&dir.path().join("missing")));
        assert!(!is_ppk_file(dir.path()));
    }

    #[test]
    fn openssh_copies_keep_the_protection_of_the_original() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("keys");
        let clear = dir.path().join("clear.ppk");
        std::fs::write(&clear, V2_CLEAR).unwrap();
        let encrypted = dir.path().join("encrypted.ppk");
        std::fs::write(&encrypted, V2_ENCRYPTED).unwrap();

        let copy = write_openssh_copy(&clear, None, &out).unwrap();
        let (cipher, ..) = openssh_fields(&std::fs::read_to_string(&copy).unwrap());
        assert_eq!(cipher, "none");
        // One copy per key, replaced on every call.
        assert_eq!(write_openssh_copy(&clear, None, &out).unwrap(), copy);

        assert_eq!(
            write_openssh_copy(&encrypted, None, &out).unwrap_err(),
            PpkError::PassphraseRequired
        );
        let copy2 = write_openssh_copy(&encrypted, Some(PASSPHRASE), &out).unwrap();
        assert_ne!(copy2, copy);
        let (cipher, kdf, ..) = openssh_fields(&std::fs::read_to_string(&copy2).unwrap());
        assert_eq!((cipher.as_str(), kdf.as_str()), ("aes256-ctr", "bcrypt"));
        assert_eq!(
            std::fs::read_dir(&out).unwrap().count(),
            2,
            "no temporary files left"
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&out), 0o700);
            assert_eq!(mode(&copy), 0o600);
            assert_eq!(mode(&copy2), 0o600);
        }
    }
}

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use chrono::Utc;
use pbkdf2::pbkdf2_hmac;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use thiserror::Error;

use crate::types::ConnectionConfig;

pub const VAULT_MAGIC: &str = "RUSTSCP_VAULT";
/// Envelope layout version. The layout is unchanged since version 1: the KDF iteration
/// count travels inside every envelope, so raising it for new exports keeps older files
/// readable and lets older builds open new exports.
pub const VAULT_VERSION: u32 = 1;
pub const VAULT_CIPHER: &str = "AES-256-GCM";
pub const VAULT_KDF: &str = "PBKDF2-HMAC-SHA256";
/// PBKDF2-HMAC-SHA256 iterations for new password-protected exports (.rustscp-vault).
/// 600,000 is the OWASP 2023 minimum for PBKDF2-HMAC-SHA256.
pub const DEFAULT_KDF_ITERATIONS: u32 = 600_000;
/// Alias that makes call sites explicit about which vault kind they describe.
pub const EXPORT_KDF_ITERATIONS: u32 = DEFAULT_KDF_ITERATIONS;
/// Iteration count used by exports written before the 600k upgrade (still imported).
pub const LEGACY_KDF_ITERATIONS: u32 = 100_000;
/// Bounds accepted for password-protected (imported) envelopes. The count comes from
/// an untrusted file, so it is bounded to keep a crafted file from hanging the app.
pub const MIN_PASSWORD_KDF_ITERATIONS: u32 = 10_000;
pub const MAX_PASSWORD_KDF_ITERATIONS: u32 = 10_000_000;
/// The local vault is encrypted with a random 256-bit device key, so key stretching adds
/// no security there. One PBKDF2 round keeps the envelope format identical (older builds
/// can still read it) while making every save/load cheap.
pub const LOCAL_VAULT_KDF_ITERATIONS: u32 = 1;
pub const SALT_LEN: usize = 32;
pub const NONCE_LEN: usize = 12;
/// Where the local device key lives. It is a plain file next to the vault, not an OS keychain.
pub const DEVICE_KEY_STORAGE: &str = "file";

const LOCAL_VAULT_FILE: &str = "sites.vault";
const DEVICE_KEY_FILE: &str = ".vault_key";
const LOCAL_VAULT_BACKUP_FILE: &str = "sites.vault.bak";

#[derive(Debug, Error)]
pub enum VaultError {
    #[error("Formato de cofre inválido ou corrompido")]
    InvalidHeader,
    #[error("Versão de cofre incompatível: {0}")]
    UnsupportedVersion(u32),
    #[error("Falha na decodificação: senha incorreta ou arquivo adulterado")]
    DecryptionFailed,
    #[error("Erro de serialização JSON: {0}")]
    SerializationError(#[from] serde_json::Error),
    #[error("Erro de codificação Hex: {0}")]
    HexError(#[from] hex::FromHexError),
    #[error("Erro de E/S de arquivo: {0}")]
    IoError(#[from] std::io::Error),
    #[error("Erro no cofre: {0}")]
    Other(String),
    /// The vault file exists but its device key file is missing or empty. A new key is
    /// never generated in that case, because saving with it would destroy the vault.
    #[error("The vault key file is missing or empty while an encrypted vault exists ({0}); no new key was created so the saved sites are not overwritten")]
    DeviceKeyMissing(String),
    /// The envelope asks for a KDF iteration count outside the accepted range.
    #[error("Unsafe or invalid key-derivation parameters: {0} PBKDF2 iterations")]
    KdfOutOfRange(u32),
    /// The envelope names a cipher or KDF this build does not implement.
    #[error("Unsupported vault algorithm: {0}")]
    UnsupportedAlgorithm(String),
}

impl VaultError {
    /// Stable, language-independent code for the UI to translate.
    pub fn code(&self) -> &'static str {
        match self {
            VaultError::InvalidHeader => "vault.invalid_header",
            VaultError::UnsupportedVersion(_) => "vault.unsupported_version",
            VaultError::DecryptionFailed => "vault.wrong_password",
            VaultError::SerializationError(_) => "vault.serialization",
            VaultError::HexError(_) => "vault.invalid_header",
            VaultError::IoError(_) => "vault.io",
            VaultError::Other(_) => "vault.other",
            VaultError::DeviceKeyMissing(_) => "vault.device_key_missing",
            VaultError::KdfOutOfRange(_) => "vault.kdf_out_of_range",
            VaultError::UnsupportedAlgorithm(_) => "vault.unsupported_algorithm",
        }
    }
}

/// Formato de envelope seguro e portátil do cofre (.rustscp-vault)
/// 100% autocontido e compatível entre macOS, Windows e Linux
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VaultEnvelope {
    pub magic: String,
    pub version: u32,
    pub cipher: String,
    pub kdf: String,
    pub kdf_iterations: u32,
    pub salt_hex: String,
    pub nonce_hex: String,
    pub ciphertext_hex: String,
    pub exported_at: String,
    pub app_version: String,
    pub site_count: usize,
}

/// Informações de status de segurança do cofre local.
///
/// The fields describe the local `sites.vault` as it is on disk. `kdf`/`kdf_iterations`
/// come from the file's own envelope; `key_storage`/`key_path` say where the device key
/// lives (a plain file next to the vault). `load_error`/`backup_path` are filled by the
/// app when the vault could not be loaded at startup and was moved aside.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VaultSecurityInfo {
    pub is_encrypted: bool,
    pub cipher: String,
    pub kdf: String,
    pub kdf_iterations: u32,
    pub vault_path: String,
    pub site_count: usize,
    pub has_custom_master_password: bool,
    /// "file": the device key is stored in `key_path`, next to the vault.
    #[serde(default)]
    pub key_storage: String,
    #[serde(default)]
    pub key_path: String,
    /// PBKDF2 iterations used for new password-protected exports.
    #[serde(default)]
    pub export_kdf_iterations: u32,
    /// Plain-English summary of what the encryption at rest does and does not protect against.
    #[serde(default)]
    pub protection_note: String,
    #[serde(default)]
    pub load_error: Option<String>,
    #[serde(default)]
    pub backup_path: Option<String>,
}

/// Deriva uma chave de 256 bits (32 bytes) a partir da senha e salt via PBKDF2-HMAC-SHA256
pub fn derive_key(password: &str, salt: &[u8], iterations: u32) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, iterations, &mut key);
    key
}

/// Criptografa dados arbitrários (bytes) usando AES-256-GCM + PBKDF2
/// (`DEFAULT_KDF_ITERATIONS` rounds, for password-protected exports).
pub fn encrypt_bytes(
    data: &[u8],
    password: &str,
    site_count: usize,
) -> Result<VaultEnvelope, VaultError> {
    encrypt_bytes_with_iterations(data, password, site_count, DEFAULT_KDF_ITERATIONS)
}

/// Same as [`encrypt_bytes`] with an explicit PBKDF2 iteration count (stored in the envelope).
pub fn encrypt_bytes_with_iterations(
    data: &[u8],
    password: &str,
    site_count: usize,
    iterations: u32,
) -> Result<VaultEnvelope, VaultError> {
    if password.is_empty() {
        return Err(VaultError::Other(
            "A senha de criptografia não pode ser vazia".to_string(),
        ));
    }
    if iterations == 0 {
        return Err(VaultError::KdfOutOfRange(iterations));
    }

    let mut salt = [0u8; SALT_LEN];
    let mut nonce_bytes = [0u8; NONCE_LEN];
    let mut rng = rand::thread_rng();
    rng.fill_bytes(&mut salt);
    rng.fill_bytes(&mut nonce_bytes);

    let key = derive_key(password, &salt, iterations);
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| VaultError::Other(format!("Erro ao inicializar cifra AES-256-GCM: {e}")))?;
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher.encrypt(nonce, data).map_err(|_| {
        VaultError::Other("Falha ao criptografar dados com AES-256-GCM".to_string())
    })?;

    Ok(VaultEnvelope {
        magic: VAULT_MAGIC.to_string(),
        version: VAULT_VERSION,
        cipher: VAULT_CIPHER.to_string(),
        kdf: VAULT_KDF.to_string(),
        kdf_iterations: iterations,
        salt_hex: hex::encode(salt),
        nonce_hex: hex::encode(nonce_bytes),
        ciphertext_hex: hex::encode(ciphertext),
        exported_at: Utc::now().to_rfc3339(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        site_count,
    })
}

/// Descriptografa um envelope de cofre (protegido por senha) retornando os bytes
/// originais autenticados. The iteration count read from the envelope must lie within
/// `MIN_PASSWORD_KDF_ITERATIONS..=MAX_PASSWORD_KDF_ITERATIONS`.
pub fn decrypt_bytes(envelope: &VaultEnvelope, password: &str) -> Result<Vec<u8>, VaultError> {
    decrypt_bytes_bounded(
        envelope,
        password,
        MIN_PASSWORD_KDF_ITERATIONS,
        MAX_PASSWORD_KDF_ITERATIONS,
    )
}

fn validate_envelope_header(
    envelope: &VaultEnvelope,
    min_iterations: u32,
    max_iterations: u32,
) -> Result<(), VaultError> {
    if envelope.magic != VAULT_MAGIC {
        return Err(VaultError::InvalidHeader);
    }
    if envelope.version != VAULT_VERSION {
        return Err(VaultError::UnsupportedVersion(envelope.version));
    }
    if !envelope.cipher.eq_ignore_ascii_case(VAULT_CIPHER) {
        return Err(VaultError::UnsupportedAlgorithm(envelope.cipher.clone()));
    }
    if !envelope.kdf.eq_ignore_ascii_case(VAULT_KDF) {
        return Err(VaultError::UnsupportedAlgorithm(envelope.kdf.clone()));
    }
    if envelope.kdf_iterations < min_iterations || envelope.kdf_iterations > max_iterations {
        return Err(VaultError::KdfOutOfRange(envelope.kdf_iterations));
    }
    Ok(())
}

fn decrypt_bytes_bounded(
    envelope: &VaultEnvelope,
    password: &str,
    min_iterations: u32,
    max_iterations: u32,
) -> Result<Vec<u8>, VaultError> {
    validate_envelope_header(envelope, min_iterations, max_iterations)?;
    if password.is_empty() {
        return Err(VaultError::DecryptionFailed);
    }

    let salt = hex::decode(&envelope.salt_hex)?;
    let nonce_bytes = hex::decode(&envelope.nonce_hex)?;
    let ciphertext = hex::decode(&envelope.ciphertext_hex)?;

    if salt.len() != SALT_LEN || nonce_bytes.len() != NONCE_LEN {
        return Err(VaultError::InvalidHeader);
    }

    let key = derive_key(password, &salt, envelope.kdf_iterations);
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| VaultError::Other(format!("Erro ao inicializar cifra: {e}")))?;
    let nonce = Nonce::from_slice(&nonce_bytes);

    let plaintext = cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|_| VaultError::DecryptionFailed)?;

    Ok(plaintext)
}

/// Criptografa uma lista de conexões (credenciais, hosts, senhas, chaves) em um envelope
/// seguro protegido por senha (`DEFAULT_KDF_ITERATIONS` rounds).
pub fn encrypt_sites(
    sites: &[ConnectionConfig],
    password: &str,
) -> Result<VaultEnvelope, VaultError> {
    encrypt_sites_with_iterations(sites, password, DEFAULT_KDF_ITERATIONS)
}

/// Same as [`encrypt_sites`] with an explicit PBKDF2 iteration count.
pub fn encrypt_sites_with_iterations(
    sites: &[ConnectionConfig],
    password: &str,
    iterations: u32,
) -> Result<VaultEnvelope, VaultError> {
    let json_bytes = serde_json::to_vec(sites)?;
    encrypt_bytes_with_iterations(&json_bytes, password, sites.len(), iterations)
}

/// Descriptografa um envelope seguro retornando a lista de conexões
pub fn decrypt_sites(
    envelope: &VaultEnvelope,
    password: &str,
) -> Result<Vec<ConnectionConfig>, VaultError> {
    let plaintext = decrypt_bytes(envelope, password)?;
    let sites: Vec<ConnectionConfig> = serde_json::from_slice(&plaintext)?;
    Ok(sites)
}

/// Runs [`encrypt_sites`] on a blocking thread so PBKDF2 never stalls an async runtime worker.
pub async fn encrypt_sites_async(
    sites: Vec<ConnectionConfig>,
    password: String,
) -> Result<VaultEnvelope, VaultError> {
    tokio::task::spawn_blocking(move || encrypt_sites(&sites, &password))
        .await
        .map_err(|e| VaultError::Other(format!("vault worker failed: {e}")))?
}

/// Runs [`decrypt_sites`] on a blocking thread so PBKDF2 never stalls an async runtime worker.
pub async fn decrypt_sites_async(
    envelope: VaultEnvelope,
    password: String,
) -> Result<Vec<ConnectionConfig>, VaultError> {
    tokio::task::spawn_blocking(move || decrypt_sites(&envelope, &password))
        .await
        .map_err(|e| VaultError::Other(format!("vault worker failed: {e}")))?
}

/// Serializa o envelope em formato JSON string (.rustscp-vault)
pub fn serialize_vault_to_json(envelope: &VaultEnvelope) -> Result<String, VaultError> {
    Ok(serde_json::to_string_pretty(envelope)?)
}

/// Deserializa o envelope a partir de uma string JSON
pub fn parse_vault_from_json(json_str: &str) -> Result<VaultEnvelope, VaultError> {
    let envelope: VaultEnvelope = serde_json::from_str(json_str)?;
    if envelope.magic != VAULT_MAGIC {
        return Err(VaultError::InvalidHeader);
    }
    Ok(envelope)
}

// ----------------- ARMAZENAMENTO LOCAL SEGURO EM DISCO -----------------

/// Retorna o diretório de dados/configuração do RustSCP de acordo com o SO
pub fn get_rustscp_config_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("RUSTSCP_CONFIG_DIR") {
        return PathBuf::from(dir);
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            return PathBuf::from(appdata).join("RustSCP");
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("com.rustscp.desktop");
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
            return PathBuf::from(xdg).join("rustscp");
        }
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join(".config").join("rustscp");
        }
    }

    PathBuf::from(".rustscp")
}

/// Retorna o caminho do arquivo de cofre local criptografado (sites.vault)
pub fn get_local_vault_path() -> PathBuf {
    get_rustscp_config_dir().join(LOCAL_VAULT_FILE)
}

/// Retorna o caminho da chave do dispositivo local (.vault_key)
pub fn get_local_device_key_path() -> PathBuf {
    get_rustscp_config_dir().join(DEVICE_KEY_FILE)
}

/// Path of the copy of the previous vault version kept by every successful save.
pub fn get_local_vault_backup_path() -> PathBuf {
    get_rustscp_config_dir().join(LOCAL_VAULT_BACKUP_FILE)
}

/// Creates `dir` (and parents) if needed and restricts it to the current user (0700 on Unix).
/// A failing chmod on an existing directory is logged, not fatal: the files inside are
/// created 0600 regardless.
pub fn ensure_private_dir(dir: &Path) -> std::io::Result<()> {
    if !dir.exists() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(dir)?;
        }
        #[cfg(not(unix))]
        {
            fs::create_dir_all(dir)?;
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(dir) {
            if meta.permissions().mode() & 0o077 != 0 {
                if let Err(e) = fs::set_permissions(dir, fs::Permissions::from_mode(0o700)) {
                    tracing::warn!("could not restrict {} to 0700: {e}", dir.display());
                }
            }
        }
    }
    Ok(())
}

fn open_private_new(path: &Path) -> std::io::Result<fs::File> {
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)
}

fn sync_dir(dir: &Path) {
    #[cfg(unix)]
    {
        if let Ok(d) = fs::File::open(dir) {
            let _ = d.sync_all();
        }
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
    }
}

/// Atomically replaces `path` with `data`: writes a temp file in the same directory
/// (created 0600 on Unix), fsyncs it, renames it over the target and fsyncs the
/// directory. A crash leaves either the old or the new content, never a partial file.
pub fn write_private_file_atomic(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let dir = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        _ => PathBuf::from("."),
    };
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let tmp_path = dir.join(format!(
        ".{}.tmp-{}",
        file_name,
        uuid::Uuid::new_v4().simple()
    ));

    let write_result = (|| -> std::io::Result<()> {
        let mut file = open_private_new(&tmp_path)?;
        file.write_all(data)?;
        file.sync_all()?;
        Ok(())
    })();
    if let Err(e) = write_result {
        let _ = fs::remove_file(&tmp_path);
        return Err(e);
    }

    if let Err(e) = fs::rename(&tmp_path, path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(e);
    }
    sync_dir(&dir);
    Ok(())
}

fn read_device_key_in(dir: &Path) -> Result<Option<String>, VaultError> {
    let key_path = dir.join(DEVICE_KEY_FILE);
    match fs::read_to_string(&key_path) {
        Ok(s) => {
            let key = s.trim().to_string();
            if key.is_empty() {
                Ok(None)
            } else {
                Ok(Some(key))
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(VaultError::IoError(e)),
    }
}

/// Returns the device key stored in `dir`, creating one only when no vault exists yet.
fn get_or_create_device_key_in(dir: &Path) -> Result<String, VaultError> {
    ensure_private_dir(dir)?;
    if let Some(key) = read_device_key_in(dir)? {
        return Ok(key);
    }

    let vault_path = dir.join(LOCAL_VAULT_FILE);
    if vault_path.exists() {
        // Never generate a new key over an existing vault: anything saved with it would
        // replace the vault that the lost key could still open.
        return Err(VaultError::DeviceKeyMissing(
            vault_path.to_string_lossy().to_string(),
        ));
    }

    let mut random_bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut random_bytes);
    let key_hex = hex::encode(random_bytes);

    let key_path = dir.join(DEVICE_KEY_FILE);
    if key_path.exists() {
        // Present but blank: replace it atomically (no vault depends on it).
        write_private_file_atomic(&key_path, key_hex.as_bytes())?;
        return Ok(key_hex);
    }
    match open_private_new(&key_path) {
        Ok(mut file) => {
            file.write_all(key_hex.as_bytes())?;
            file.sync_all()?;
            sync_dir(dir);
            Ok(key_hex)
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            // Another writer created it concurrently: use theirs.
            read_device_key_in(dir)?.ok_or_else(|| {
                VaultError::Other("device key file was created empty concurrently".into())
            })
        }
        Err(e) => Err(VaultError::IoError(e)),
    }
}

/// Obtém ou gera a chave local do dispositivo com permissões estritas (0600).
///
/// A new key is created only when no `sites.vault` exists; when the vault exists but the
/// key file is missing or blank this returns [`VaultError::DeviceKeyMissing`].
pub fn get_or_create_device_key() -> Result<String, VaultError> {
    get_or_create_device_key_in(&get_rustscp_config_dir())
}

fn unix_timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Renames `path` to `<path>.corrupt-<unix_ts>` (adding a counter if that name is taken)
/// and returns the new path.
fn quarantine_file(path: &Path) -> Result<PathBuf, VaultError> {
    let ts = unix_timestamp();
    let base = path.to_string_lossy().to_string();
    let mut candidate = PathBuf::from(format!("{base}.corrupt-{ts}"));
    let mut n = 1;
    while candidate.exists() {
        candidate = PathBuf::from(format!("{base}.corrupt-{ts}-{n}"));
        n += 1;
    }
    fs::rename(path, &candidate)?;
    if let Some(parent) = path.parent() {
        sync_dir(parent);
    }
    Ok(candidate)
}

fn quarantine_vault_in(dir: &Path) -> Result<Option<PathBuf>, VaultError> {
    let vault_path = dir.join(LOCAL_VAULT_FILE);
    if !vault_path.exists() {
        return Ok(None);
    }
    quarantine_file(&vault_path).map(Some)
}

/// Moves an unreadable local vault aside as `sites.vault.corrupt-<unix_ts>` (the key file
/// is kept) and returns the backup path, or `None` when there is no vault file.
pub fn quarantine_local_vault() -> Result<Option<PathBuf>, VaultError> {
    quarantine_vault_in(&get_rustscp_config_dir())
}

fn decrypt_local_envelope(
    json_str: &str,
    device_key: &str,
) -> Result<Vec<ConnectionConfig>, VaultError> {
    let envelope = parse_vault_from_json(json_str)?;
    // Local vaults: 1 round (current format) up to the legacy 100k (older builds).
    let plaintext = decrypt_bytes_bounded(&envelope, device_key, 1, MAX_PASSWORD_KDF_ITERATIONS)?;
    Ok(serde_json::from_slice(&plaintext)?)
}

fn save_vault_in(dir: &Path, sites: &[ConnectionConfig]) -> Result<(), VaultError> {
    ensure_private_dir(dir)?;
    let vault_path = dir.join(LOCAL_VAULT_FILE);
    // Refuses (DeviceKeyMissing) instead of inventing a key when the vault exists.
    let device_key = get_or_create_device_key_in(dir)?;

    // Safety net: never overwrite a vault this key cannot open. Keep it as
    // `.corrupt-<ts>` and keep the last good version as `.bak`.
    match fs::read_to_string(&vault_path) {
        Ok(existing) => match decrypt_local_envelope(&existing, &device_key) {
            Ok(_) => {
                if let Err(e) = write_private_file_atomic(
                    &dir.join(LOCAL_VAULT_BACKUP_FILE),
                    existing.as_bytes(),
                ) {
                    tracing::warn!("could not refresh the vault backup: {e}");
                }
            }
            Err(e) => {
                let moved = quarantine_file(&vault_path)?;
                tracing::warn!(
                    "existing vault could not be opened ({e}); preserved as {}",
                    moved.display()
                );
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(VaultError::IoError(e)),
    }

    let envelope = encrypt_sites_with_iterations(sites, &device_key, LOCAL_VAULT_KDF_ITERATIONS)?;
    let json = serde_json::to_string_pretty(&envelope)?;
    write_private_file_atomic(&vault_path, json.as_bytes())?;
    Ok(())
}

fn load_vault_in(dir: &Path) -> Result<Vec<ConnectionConfig>, VaultError> {
    let vault_path = dir.join(LOCAL_VAULT_FILE);
    let json_str = match fs::read_to_string(&vault_path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(VaultError::IoError(e)),
    };
    // Loading never creates a key: a vault without its key is an error, not "empty".
    let device_key = read_device_key_in(dir)?
        .ok_or_else(|| VaultError::DeviceKeyMissing(vault_path.to_string_lossy().to_string()))?;
    decrypt_local_envelope(&json_str, &device_key)
}

/// Salva a lista de sites no cofre local criptografado.
///
/// The write is atomic (temp file + fsync + rename, 0600). It fails with
/// [`VaultError::DeviceKeyMissing`] rather than replacing a vault whose key is gone, and
/// an existing vault that the current key cannot open is preserved as
/// `sites.vault.corrupt-<unix_ts>` before the new one is written.
pub fn save_local_vault(sites: &[ConnectionConfig]) -> Result<(), VaultError> {
    save_vault_in(&get_rustscp_config_dir(), sites)
}

/// Carrega a lista de sites do cofre local criptografado.
///
/// Returns an empty list only when `sites.vault` does not exist. Every other problem
/// (unreadable file, missing key, wrong key, corrupt JSON) is an error, so callers must
/// not treat a failure as "no sites".
pub fn load_local_vault() -> Result<Vec<ConnectionConfig>, VaultError> {
    load_vault_in(&get_rustscp_config_dir())
}

/// [`save_local_vault`] on a blocking thread.
pub async fn save_local_vault_async(sites: Vec<ConnectionConfig>) -> Result<(), VaultError> {
    tokio::task::spawn_blocking(move || save_local_vault(&sites))
        .await
        .map_err(|e| VaultError::Other(format!("vault worker failed: {e}")))?
}

/// [`load_local_vault`] on a blocking thread.
pub async fn load_local_vault_async() -> Result<Vec<ConnectionConfig>, VaultError> {
    tokio::task::spawn_blocking(load_local_vault)
        .await
        .map_err(|e| VaultError::Other(format!("vault worker failed: {e}")))?
}

fn vault_security_info_in(dir: &Path, site_count: usize) -> VaultSecurityInfo {
    let vault_path = dir.join(LOCAL_VAULT_FILE);
    let key_path = dir.join(DEVICE_KEY_FILE);
    let header = fs::read_to_string(&vault_path)
        .ok()
        .and_then(|s| parse_vault_from_json(&s).ok());

    let (cipher, kdf, kdf_iterations) = match &header {
        Some(h) => (h.cipher.clone(), h.kdf.clone(), h.kdf_iterations),
        None => (
            VAULT_CIPHER.to_string(),
            VAULT_KDF.to_string(),
            LOCAL_VAULT_KDF_ITERATIONS,
        ),
    };

    let protection_note = format!(
        "Saved sites are encrypted with {VAULT_CIPHER} using a random 256-bit device key. \
         The key is stored unencrypted in {} (permissions 0600 on macOS/Linux), in the same \
         folder as the vault, not in the OS keychain. This protects the vault file if it \
         leaks on its own, but anyone or anything that can read both files (backups of this \
         folder, other software running as your user) can decrypt it. No master password \
         is used. Exported .rustscp-vault files are protected by your export password with \
         {VAULT_KDF} ({EXPORT_KDF_ITERATIONS} iterations).",
        key_path.display()
    );

    VaultSecurityInfo {
        is_encrypted: header.is_some(),
        cipher,
        kdf,
        kdf_iterations,
        vault_path: vault_path.to_string_lossy().to_string(),
        site_count,
        has_custom_master_password: false,
        key_storage: DEVICE_KEY_STORAGE.to_string(),
        key_path: key_path.to_string_lossy().to_string(),
        export_kdf_iterations: EXPORT_KDF_ITERATIONS,
        protection_note,
        load_error: None,
        backup_path: None,
    }
}

/// Honest description of the local vault as it is on disk (cipher/KDF read from the
/// file's envelope, key location, export KDF). `load_error`/`backup_path` are left `None`
/// for the caller to fill.
pub fn local_vault_security_info(site_count: usize) -> VaultSecurityInfo {
    vault_security_info_in(&get_rustscp_config_dir(), site_count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{AuthMethod, Protocol};
    use tempfile::tempdir;

    /// Low iteration count for tests that only exercise the format, not the KDF cost.
    const TEST_ITERATIONS: u32 = MIN_PASSWORD_KDF_ITERATIONS;

    fn sample_sites() -> Vec<ConnectionConfig> {
        vec![
            ConnectionConfig {
                id: "site-1".to_string(),
                name: "Hetzner Web Server".to_string(),
                protocol: Protocol::Sftp,
                host: "192.168.1.50".to_string(),
                port: 22,
                username: "deployer".to_string(),
                auth: AuthMethod::Password("SuperSecretP@ss123!".to_string()),
                remote_root: "/var/www/html".to_string(),
            },
            ConnectionConfig {
                id: "site-2".to_string(),
                name: "AWS S3 Production".to_string(),
                protocol: Protocol::S3,
                host: "s3.us-east-1.amazonaws.com".to_string(),
                port: 443,
                username: "AKIAIOSFODNN7EXAMPLE".to_string(),
                auth: AuthMethod::Password("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".to_string()),
                remote_root: "prod-bucket".to_string(),
            },
            ConnectionConfig {
                id: "site-3".to_string(),
                name: "SSH Key Server".to_string(),
                protocol: Protocol::Sftp,
                host: "ssh.company.internal".to_string(),
                port: 2222,
                username: "admin".to_string(),
                auth: AuthMethod::PrivateKey {
                    path: "/home/user/.ssh/id_ed25519".to_string(),
                    passphrase: Some("key-passphrase-xyz".to_string()),
                },
                remote_root: "/root".to_string(),
            },
        ]
    }

    #[test]
    fn test_vault_encrypt_decrypt_success() {
        let sites = sample_sites();
        let password = "MyUltraSecureVaultPassword#2026";

        let envelope = encrypt_sites_with_iterations(&sites, password, TEST_ITERATIONS)
            .expect("Falha ao criptografar sites");
        assert_eq!(envelope.magic, VAULT_MAGIC);
        assert_eq!(envelope.cipher, "AES-256-GCM");
        assert_eq!(envelope.site_count, 3);
        assert!(!envelope.ciphertext_hex.is_empty());
        assert!(!envelope.salt_hex.is_empty());
        assert!(!envelope.nonce_hex.is_empty());

        let decrypted = decrypt_sites(&envelope, password).expect("Falha ao descriptografar sites");
        assert_eq!(decrypted.len(), 3);
        assert_eq!(decrypted[0].name, "Hetzner Web Server");
        assert_eq!(decrypted[0].host, "192.168.1.50");
        if let AuthMethod::Password(ref pass) = decrypted[0].auth {
            assert_eq!(pass, "SuperSecretP@ss123!");
        } else {
            panic!("Expected Password auth method");
        }

        if let AuthMethod::PrivateKey {
            ref path,
            ref passphrase,
        } = decrypted[2].auth
        {
            assert_eq!(path, "/home/user/.ssh/id_ed25519");
            assert_eq!(passphrase.as_deref(), Some("key-passphrase-xyz"));
        } else {
            panic!("Expected PrivateKey auth method");
        }
    }

    #[test]
    fn test_new_exports_use_600k_iterations_and_roundtrip() {
        let sites = sample_sites();
        let envelope = encrypt_sites(&sites, "Export-Password-2026").unwrap();
        assert!(envelope.kdf_iterations >= 600_000);
        assert_eq!(envelope.kdf_iterations, DEFAULT_KDF_ITERATIONS);
        assert_eq!(envelope.version, VAULT_VERSION);
        let decrypted = decrypt_sites(&envelope, "Export-Password-2026").unwrap();
        assert_eq!(decrypted.len(), 3);
    }

    #[test]
    fn test_legacy_100k_export_is_still_readable() {
        // Exports written by older builds: version 1, 100k iterations stored in the envelope.
        let sites = sample_sites();
        let envelope =
            encrypt_sites_with_iterations(&sites, "OldPassword", LEGACY_KDF_ITERATIONS).unwrap();
        let json = serialize_vault_to_json(&envelope).unwrap();
        assert!(json.contains("\"kdf_iterations\": 100000"));
        let parsed = parse_vault_from_json(&json).unwrap();
        let decrypted = decrypt_sites(&parsed, "OldPassword").unwrap();
        assert_eq!(decrypted[1].name, "AWS S3 Production");
    }

    #[test]
    fn test_untrusted_iteration_count_is_rejected_before_deriving() {
        let sites = sample_sites();
        let mut envelope = encrypt_sites_with_iterations(&sites, "pw", TEST_ITERATIONS).unwrap();

        envelope.kdf_iterations = u32::MAX;
        match decrypt_sites(&envelope, "pw") {
            Err(VaultError::KdfOutOfRange(n)) => assert_eq!(n, u32::MAX),
            other => panic!("expected KdfOutOfRange, got {:?}", other.map(|s| s.len())),
        }

        envelope.kdf_iterations = 1;
        assert!(matches!(
            decrypt_sites(&envelope, "pw"),
            Err(VaultError::KdfOutOfRange(1))
        ));

        envelope.kdf_iterations = TEST_ITERATIONS;
        envelope.kdf = "scrypt".to_string();
        assert!(matches!(
            decrypt_sites(&envelope, "pw"),
            Err(VaultError::UnsupportedAlgorithm(_))
        ));
    }

    #[test]
    fn test_vault_wrong_password_fails() {
        let sites = sample_sites();
        let envelope = encrypt_sites_with_iterations(&sites, "CorrectPassword", TEST_ITERATIONS)
            .expect("Encryption failed");

        let result = decrypt_sites(&envelope, "WrongPassword");
        assert!(result.is_err(), "Deveria falhar com senha incorreta");
        match result.unwrap_err() {
            VaultError::DecryptionFailed => (),
            e => panic!("Esperado DecryptionFailed, recebido: {:?}", e),
        }
    }

    #[test]
    fn test_vault_tampered_ciphertext_fails() {
        let sites = sample_sites();
        let mut envelope =
            encrypt_sites_with_iterations(&sites, "CorrectPassword", TEST_ITERATIONS)
                .expect("Encryption failed");

        // Adultera um byte do ciphertext
        let mut bytes = hex::decode(&envelope.ciphertext_hex).unwrap();
        bytes[5] ^= 0xff;
        envelope.ciphertext_hex = hex::encode(bytes);

        let result = decrypt_sites(&envelope, "CorrectPassword");
        assert!(
            result.is_err(),
            "Deveria falhar com dados adulterados (Auth Tag mismatch)"
        );
    }

    #[test]
    fn test_vault_json_serialization_roundtrip() {
        let sites = sample_sites();
        let password = "ExportPassword123";

        let envelope = encrypt_sites_with_iterations(&sites, password, TEST_ITERATIONS).unwrap();
        let json_str = serialize_vault_to_json(&envelope).unwrap();

        let parsed_envelope = parse_vault_from_json(&json_str).unwrap();
        assert_eq!(envelope, parsed_envelope);

        let decrypted = decrypt_sites(&parsed_envelope, password).unwrap();
        assert_eq!(decrypted.len(), 3);
    }

    #[tokio::test]
    async fn test_async_wrappers_roundtrip() {
        let sites = sample_sites();
        let envelope = encrypt_sites_async(sites, "AsyncPassword".into())
            .await
            .unwrap();
        let back = decrypt_sites_async(envelope, "AsyncPassword".into())
            .await
            .unwrap();
        assert_eq!(back.len(), 3);
    }

    #[test]
    fn test_local_vault_filesystem_persistence() {
        let temp_dir = tempdir().unwrap();
        std::env::set_var("RUSTSCP_CONFIG_DIR", temp_dir.path().to_str().unwrap());

        let sites = sample_sites();
        save_local_vault(&sites).expect("Falha ao salvar cofre local");

        // Verifica que o arquivo sites.vault foi criado e NÃO está em texto plano
        let vault_file = temp_dir.path().join("sites.vault");
        assert!(vault_file.exists());
        let raw_content = fs::read_to_string(&vault_file).unwrap();
        assert!(!raw_content.contains("SuperSecretP@ss123!"));
        assert!(!raw_content.contains("192.168.1.50"));
        assert!(raw_content.contains("RUSTSCP_VAULT"));
        assert!(raw_content.contains("AES-256-GCM"));

        // Carrega do cofre
        let loaded_sites = load_local_vault().expect("Falha ao carregar cofre local");
        assert_eq!(loaded_sites.len(), 3);
        assert_eq!(loaded_sites[0].name, "Hetzner Web Server");

        let info = local_vault_security_info(3);
        assert!(info.is_encrypted);
        assert_eq!(info.key_storage, "file");
        assert!(info.key_path.ends_with(".vault_key"));
        assert_eq!(info.kdf_iterations, LOCAL_VAULT_KDF_ITERATIONS);
        assert_eq!(info.export_kdf_iterations, EXPORT_KDF_ITERATIONS);
        assert!(info.protection_note.contains(".vault_key"));
        assert!(!info.has_custom_master_password);
    }

    #[test]
    fn test_missing_key_with_existing_vault_is_an_error_and_nothing_is_overwritten() {
        let dir = tempdir().unwrap();
        save_vault_in(dir.path(), &sample_sites()).unwrap();
        let vault_path = dir.path().join(LOCAL_VAULT_FILE);
        let original = fs::read(&vault_path).unwrap();

        // Lose the key (crash during first creation, partial restore, copied vault...).
        fs::remove_file(dir.path().join(DEVICE_KEY_FILE)).unwrap();

        assert!(matches!(
            load_vault_in(dir.path()),
            Err(VaultError::DeviceKeyMissing(_))
        ));
        assert!(matches!(
            get_or_create_device_key_in(dir.path()),
            Err(VaultError::DeviceKeyMissing(_))
        ));
        // Saving a near-empty list must not replace the vault either.
        assert!(matches!(
            save_vault_in(dir.path(), &[]),
            Err(VaultError::DeviceKeyMissing(_))
        ));
        assert!(
            !dir.path().join(DEVICE_KEY_FILE).exists(),
            "no new key may be created"
        );
        assert_eq!(fs::read(&vault_path).unwrap(), original);

        // A blank key file is treated the same way.
        fs::write(dir.path().join(DEVICE_KEY_FILE), "  \n").unwrap();
        assert!(matches!(
            load_vault_in(dir.path()),
            Err(VaultError::DeviceKeyMissing(_))
        ));
        assert_eq!(fs::read(&vault_path).unwrap(), original);
    }

    #[test]
    fn test_save_preserves_a_vault_the_key_cannot_open() {
        let dir = tempdir().unwrap();
        save_vault_in(dir.path(), &sample_sites()).unwrap();
        let vault_path = dir.path().join(LOCAL_VAULT_FILE);
        let original = fs::read(&vault_path).unwrap();

        // Replace the key: the vault on disk no longer decrypts.
        fs::write(dir.path().join(DEVICE_KEY_FILE), "ab".repeat(32)).unwrap();
        assert!(matches!(
            load_vault_in(dir.path()),
            Err(VaultError::DecryptionFailed)
        ));

        save_vault_in(dir.path(), &sample_sites()[..1]).unwrap();
        let corrupt: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("sites.vault.corrupt-")
            })
            .collect();
        assert_eq!(corrupt.len(), 1, "unreadable vault must be kept aside");
        assert_eq!(fs::read(corrupt[0].path()).unwrap(), original);
        assert_eq!(load_vault_in(dir.path()).unwrap().len(), 1);
    }

    #[test]
    fn test_corrupt_vault_json_is_an_error_not_empty() {
        let dir = tempdir().unwrap();
        save_vault_in(dir.path(), &sample_sites()).unwrap();
        fs::write(dir.path().join(LOCAL_VAULT_FILE), "{ truncated").unwrap();
        assert!(load_vault_in(dir.path()).is_err());

        let moved = quarantine_vault_in(dir.path()).unwrap().unwrap();
        assert!(moved
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("sites.vault.corrupt-"));
        assert!(!dir.path().join(LOCAL_VAULT_FILE).exists());
        assert!(
            dir.path().join(DEVICE_KEY_FILE).exists(),
            "key file is kept"
        );
        assert!(load_vault_in(dir.path()).unwrap().is_empty());
        assert!(quarantine_vault_in(dir.path()).unwrap().is_none());
    }

    #[test]
    fn test_save_is_atomic_private_and_keeps_backup() {
        let dir = tempdir().unwrap();
        let sites = sample_sites();
        save_vault_in(dir.path(), &sites).unwrap();
        save_vault_in(dir.path(), &sites[..2]).unwrap();

        // The previous version is kept as .bak and still opens with the key.
        let bak = fs::read_to_string(dir.path().join(LOCAL_VAULT_BACKUP_FILE)).unwrap();
        let key = read_device_key_in(dir.path()).unwrap().unwrap();
        assert_eq!(decrypt_local_envelope(&bak, &key).unwrap().len(), 3);
        assert_eq!(load_vault_in(dir.path()).unwrap().len(), 2);

        // No temp files are left behind.
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for name in [LOCAL_VAULT_FILE, DEVICE_KEY_FILE, LOCAL_VAULT_BACKUP_FILE] {
                let mode = fs::metadata(dir.path().join(name))
                    .unwrap()
                    .permissions()
                    .mode();
                assert_eq!(mode & 0o777, 0o600, "{name} must be 0600");
            }
        }
    }

    #[test]
    fn test_local_vault_uses_cheap_kdf_and_reads_legacy_local_vaults() {
        let dir = tempdir().unwrap();
        let key = get_or_create_device_key_in(dir.path()).unwrap();
        assert_eq!(key.len(), 64);

        // A vault written by an older build (100k rounds, hex key as password).
        let legacy =
            encrypt_sites_with_iterations(&sample_sites(), &key, LEGACY_KDF_ITERATIONS).unwrap();
        fs::write(
            dir.path().join(LOCAL_VAULT_FILE),
            serde_json::to_string_pretty(&legacy).unwrap(),
        )
        .unwrap();
        assert_eq!(load_vault_in(dir.path()).unwrap().len(), 3);

        // Re-saving rewrites it in the current (1-round) format, same key.
        save_vault_in(dir.path(), &sample_sites()).unwrap();
        let raw = fs::read_to_string(dir.path().join(LOCAL_VAULT_FILE)).unwrap();
        let env = parse_vault_from_json(&raw).unwrap();
        assert_eq!(env.kdf_iterations, LOCAL_VAULT_KDF_ITERATIONS);
        assert_eq!(read_device_key_in(dir.path()).unwrap().unwrap(), key);
        assert_eq!(load_vault_in(dir.path()).unwrap().len(), 3);
    }

    #[test]
    fn test_security_info_without_vault() {
        let dir = tempdir().unwrap();
        let info = vault_security_info_in(dir.path(), 0);
        assert!(!info.is_encrypted);
        assert_eq!(info.key_storage, DEVICE_KEY_STORAGE);
        assert!(info.load_error.is_none());
        assert!(info.backup_path.is_none());
    }

    #[test]
    fn test_error_codes_are_stable() {
        assert_eq!(VaultError::DecryptionFailed.code(), "vault.wrong_password");
        assert_eq!(
            VaultError::DeviceKeyMissing(String::new()).code(),
            "vault.device_key_missing"
        );
        assert_eq!(
            VaultError::KdfOutOfRange(1).code(),
            "vault.kdf_out_of_range"
        );
    }
}

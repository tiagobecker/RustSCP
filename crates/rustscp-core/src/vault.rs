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
/// `key_storage` value: the device key is the file `.vault_key` next to the vault (0600).
/// Windows and Linux always use it; macOS only when the Keychain cannot be used.
pub const DEVICE_KEY_STORAGE_FILE: &str = "file";
/// `key_storage` value: the device key is an item in the macOS login Keychain.
pub const DEVICE_KEY_STORAGE_KEYCHAIN: &str = "macos-keychain";

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
    /// The device key is kept in the OS keychain, which could not be read (locked, or
    /// access denied). Nothing is created or overwritten: the vault stays as it is.
    #[error("The saved-sites key could not be read from the macOS Keychain ({0}); the saved sites were left untouched. Allow RustSCP to access the Keychain and restart it")]
    KeychainUnavailable(String),
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
            VaultError::KeychainUnavailable(_) => "vault.keychain_unavailable",
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
/// really is (the macOS Keychain, or a file next to the vault). `load_error`/`backup_path`
/// are filled by the app when the vault could not be loaded at startup.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VaultSecurityInfo {
    pub is_encrypted: bool,
    pub cipher: String,
    pub kdf: String,
    pub kdf_iterations: u32,
    pub vault_path: String,
    pub site_count: usize,
    pub has_custom_master_password: bool,
    /// [`DEVICE_KEY_STORAGE_FILE`] (`key_path` is the key file) or
    /// [`DEVICE_KEY_STORAGE_KEYCHAIN`] (`key_path` names the Keychain item).
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

/// Where a device key lives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KeyStorage {
    File,
    Keychain,
}

impl KeyStorage {
    fn as_str(self) -> &'static str {
        match self {
            KeyStorage::File => DEVICE_KEY_STORAGE_FILE,
            KeyStorage::Keychain => DEVICE_KEY_STORAGE_KEYCHAIN,
        }
    }
}

/// A secure OS store for the device key of one vault (the macOS Keychain). Unit tests
/// use an in-memory store, so they never touch the real Keychain.
trait KeyStore {
    /// Where the key is, for people ("macOS Keychain, item ...").
    fn location(&self) -> String;
    /// The stored key, `None` when there is none, `Err` when the store cannot be read.
    fn get(&self) -> Result<Option<String>, String>;
    /// Stores `key` unless a key is already stored (never replaces one): `Ok(false)`
    /// means another key was there first.
    fn add(&self, key: &str) -> Result<bool, String>;
}

/// The OS key store for the vault in `dir`: the macOS Keychain on macOS, none on
/// Windows and Linux (they keep the 0600 key file). Unit tests get none.
fn platform_key_store(dir: &Path) -> Option<Box<dyn KeyStore>> {
    #[cfg(all(target_os = "macos", not(test)))]
    {
        Some(Box::new(keychain::MacKeychain::for_vault_dir(dir)))
    }
    #[cfg(not(all(target_os = "macos", not(test))))]
    {
        let _ = dir;
        None
    }
}

#[cfg(target_os = "macos")]
mod keychain {
    use super::KeyStore;
    use core_foundation::data::CFData;
    use security_framework::item::{ItemAddOptions, ItemAddValue, ItemClass};
    use security_framework::passwords::{generic_password, PasswordOptions};
    use std::path::Path;

    const SERVICE: &str = "com.rustscp.desktop.vault";
    const LABEL: &str = "RustSCP saved-sites key";
    const ERR_SEC_DUPLICATE_ITEM: i32 = -25299;
    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

    /// A generic password in the login keychain. The account is the vault's folder, so
    /// separate config folders (RUSTSCP_CONFIG_DIR) never share or overwrite a key.
    pub(super) struct MacKeychain {
        account: String,
    }

    impl MacKeychain {
        pub(super) fn for_vault_dir(dir: &Path) -> Self {
            Self {
                account: dir.to_string_lossy().into_owned(),
            }
        }

        #[cfg(test)]
        pub(super) fn delete(&self) {
            let _ = security_framework::passwords::delete_generic_password(SERVICE, &self.account);
        }
    }

    fn describe(e: security_framework::base::Error) -> String {
        format!("{e} (OSStatus {})", e.code())
    }

    impl KeyStore for MacKeychain {
        fn location(&self) -> String {
            format!("macOS Keychain (login keychain), item \"{LABEL}\"")
        }

        fn get(&self) -> Result<Option<String>, String> {
            match generic_password(PasswordOptions::new_generic_password(
                SERVICE,
                &self.account,
            )) {
                Ok(bytes) => String::from_utf8(bytes)
                    .map(|k| Some(k.trim().to_string()).filter(|k| !k.is_empty()))
                    .map_err(|_| "the Keychain item does not hold a text key".to_string()),
                Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
                Err(e) => Err(describe(e)),
            }
        }

        fn add(&self, key: &str) -> Result<bool, String> {
            // SecItemAdd, not the add-or-update of set_generic_password: a key that is
            // already stored may protect a vault and must never be replaced.
            let mut item = ItemAddOptions::new(ItemAddValue::Data {
                class: ItemClass::generic_password(),
                data: CFData::from_buffer(key.as_bytes()),
            });
            item.set_service(SERVICE)
                .set_account_name(&self.account)
                .set_label(LABEL)
                .set_comment("Decrypts RustSCP's saved sites (sites.vault)");
            match item.add() {
                Ok(()) => Ok(true),
                Err(e) if e.code() == ERR_SEC_DUPLICATE_ITEM => Ok(false),
                Err(e) => Err(describe(e)),
            }
        }
    }
}

/// The device key of a vault and where it was found.
struct DeviceKey {
    key: String,
    storage: KeyStorage,
}

fn remove_key_file(dir: &Path) {
    match fs::remove_file(dir.join(DEVICE_KEY_FILE)) {
        Ok(()) => sync_dir(dir),
        Err(e) => tracing::warn!("could not delete the old vault key file: {e}"),
    }
}

/// Moves the key of `.vault_key` into `store`: adds it, reads it back, and only then
/// deletes the file. On any failure the file stays and is used (and retried) next time.
fn migrate_key_file(dir: &Path, store: &dyn KeyStore, key: &str) -> KeyStorage {
    if let Err(e) = store.add(key) {
        tracing::warn!(
            "could not move the vault key into the {}: {e}",
            store.location()
        );
        return KeyStorage::File;
    }
    match store.get() {
        Ok(Some(stored)) if stored == key => {
            remove_key_file(dir);
            tracing::info!("vault key moved into the {}", store.location());
            KeyStorage::Keychain
        }
        Ok(_) => {
            tracing::warn!(
                "the {} holds a different vault key; the key file is kept",
                store.location()
            );
            KeyStorage::File
        }
        Err(e) => {
            tracing::warn!(
                "could not verify the vault key in the {}: {e}",
                store.location()
            );
            KeyStorage::File
        }
    }
}

/// Finds the device key of the vault in `dir` without ever creating one.
///
/// With a `store`, a key still in `.vault_key` is moved into it when `migrate` is set
/// (the file is deleted once the store returns the same key). A store that cannot be
/// read falls back to the key file; without one that is [`VaultError::KeychainUnavailable`].
fn resolve_device_key(
    dir: &Path,
    store: Option<&dyn KeyStore>,
    migrate: bool,
) -> Result<Option<DeviceKey>, VaultError> {
    let file_key = read_device_key_in(dir)?;
    let from_file = |key: String| DeviceKey {
        key,
        storage: KeyStorage::File,
    };
    let Some(store) = store else {
        return Ok(file_key.map(from_file));
    };
    let stored = match store.get() {
        Ok(stored) => stored,
        Err(e) => {
            return match file_key {
                Some(key) => {
                    tracing::warn!(
                        "{} unavailable ({e}); using the vault key file",
                        store.location()
                    );
                    Ok(Some(from_file(key)))
                }
                None => Err(VaultError::KeychainUnavailable(e)),
            }
        }
    };
    let from_store = |key: String| DeviceKey {
        key,
        storage: KeyStorage::Keychain,
    };
    Ok(match (stored, file_key) {
        (None, None) => None,
        (Some(key), None) => Some(from_store(key)),
        (None, Some(key)) => {
            let storage = if migrate {
                migrate_key_file(dir, store, &key)
            } else {
                KeyStorage::File
            };
            Some(DeviceKey { key, storage })
        }
        (Some(stored), Some(file)) if stored == file => {
            // A migration that stopped before deleting the file.
            if migrate {
                remove_key_file(dir);
            }
            Some(from_store(stored))
        }
        (Some(stored), Some(file)) => {
            // Two different keys (e.g. an older RustSCP made a new key file). Use the one
            // that opens the vault and delete neither: the other may open a copy of it.
            let vault = fs::read_to_string(dir.join(LOCAL_VAULT_FILE)).ok();
            let opens = |key: &str| {
                vault
                    .as_deref()
                    .is_some_and(|v| decrypt_local_envelope(v, key).is_ok())
            };
            tracing::warn!(
                "the {} and {} hold different vault keys; both are kept",
                store.location(),
                DEVICE_KEY_FILE
            );
            if !opens(&stored) && opens(&file) {
                Some(from_file(file))
            } else {
                Some(from_store(stored))
            }
        }
    })
}

/// Returns the vault's device key, creating one only when no vault exists yet. A new
/// key goes into `store` when there is one (the key file is the fallback).
fn get_or_create_device_key_with(
    dir: &Path,
    store: Option<&dyn KeyStore>,
) -> Result<String, VaultError> {
    ensure_private_dir(dir)?;
    let vault_path = dir.join(LOCAL_VAULT_FILE);
    let mut store = store;
    match resolve_device_key(dir, store, true) {
        Ok(Some(found)) => return Ok(found.key),
        Ok(None) => {}
        // No vault depends on the unreadable store yet: a key file will do.
        Err(VaultError::KeychainUnavailable(e)) if !vault_path.exists() => {
            tracing::warn!("Keychain unavailable ({e}); the new vault key is kept in a file");
            store = None;
        }
        Err(e) => return Err(e),
    }

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

    if let Some(store) = store {
        match store.add(&key_hex) {
            Ok(true) => return Ok(key_hex),
            // Another RustSCP process stored one first: use theirs.
            Ok(false) => {
                return store.get().ok().flatten().ok_or_else(|| {
                    VaultError::Other("the Keychain reported a vault key it does not return".into())
                })
            }
            Err(e) => tracing::warn!(
                "could not store the new vault key in the {} ({e}); using a key file",
                store.location()
            ),
        }
    }

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

/// File-only variant (no key store), as on Windows and Linux.
#[cfg(test)]
fn get_or_create_device_key_in(dir: &Path) -> Result<String, VaultError> {
    get_or_create_device_key_with(dir, None)
}

/// Obtém ou gera a chave local do dispositivo: no macOS fica no Keychain; no Windows e
/// no Linux num arquivo com permissões estritas (0600).
///
/// A new key is created only when no `sites.vault` exists; when the vault exists but its
/// key is missing this returns [`VaultError::DeviceKeyMissing`]. A key file left by an
/// older version is moved into the Keychain (and deleted) on macOS.
pub fn get_or_create_device_key() -> Result<String, VaultError> {
    let dir = get_rustscp_config_dir();
    let store = platform_key_store(&dir);
    get_or_create_device_key_with(&dir, store.as_deref())
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

fn save_vault_with(
    dir: &Path,
    store: Option<&dyn KeyStore>,
    sites: &[ConnectionConfig],
) -> Result<(), VaultError> {
    ensure_private_dir(dir)?;
    let vault_path = dir.join(LOCAL_VAULT_FILE);
    // Refuses (DeviceKeyMissing, KeychainUnavailable) instead of inventing a key when
    // the vault exists.
    let device_key = get_or_create_device_key_with(dir, store)?;

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

fn load_vault_with(
    dir: &Path,
    store: Option<&dyn KeyStore>,
) -> Result<Vec<ConnectionConfig>, VaultError> {
    let vault_path = dir.join(LOCAL_VAULT_FILE);
    let json_str = match fs::read_to_string(&vault_path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(VaultError::IoError(e)),
    };
    // Loading never creates a key: a vault without its key is an error, not "empty".
    // An old key file is moved into the Keychain here, on the first load.
    let device_key = resolve_device_key(dir, store, true)?
        .ok_or_else(|| VaultError::DeviceKeyMissing(vault_path.to_string_lossy().to_string()))?;
    decrypt_local_envelope(&json_str, &device_key.key)
}

/// File-only variants (no key store), as on Windows and Linux.
#[cfg(test)]
fn save_vault_in(dir: &Path, sites: &[ConnectionConfig]) -> Result<(), VaultError> {
    save_vault_with(dir, None, sites)
}

#[cfg(test)]
fn load_vault_in(dir: &Path) -> Result<Vec<ConnectionConfig>, VaultError> {
    load_vault_with(dir, None)
}

/// Salva a lista de sites no cofre local criptografado.
///
/// The write is atomic (temp file + fsync + rename, 0600). It fails with
/// [`VaultError::DeviceKeyMissing`] rather than replacing a vault whose key is gone, and
/// an existing vault that the current key cannot open is preserved as
/// `sites.vault.corrupt-<unix_ts>` before the new one is written.
pub fn save_local_vault(sites: &[ConnectionConfig]) -> Result<(), VaultError> {
    let dir = get_rustscp_config_dir();
    let store = platform_key_store(&dir);
    save_vault_with(&dir, store.as_deref(), sites)
}

/// Carrega a lista de sites do cofre local criptografado.
///
/// Returns an empty list only when `sites.vault` does not exist. Every other problem
/// (unreadable file, missing key, wrong key, corrupt JSON, Keychain unavailable) is an
/// error, so callers must not treat a failure as "no sites". On macOS a key file left by
/// an older version is moved into the Keychain and deleted.
pub fn load_local_vault() -> Result<Vec<ConnectionConfig>, VaultError> {
    let dir = get_rustscp_config_dir();
    let store = platform_key_store(&dir);
    load_vault_with(&dir, store.as_deref())
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

fn vault_security_info_with(
    dir: &Path,
    store: Option<&dyn KeyStore>,
    site_count: usize,
) -> VaultSecurityInfo {
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

    // Where the key really is now (no migration from here), or where a new one would go.
    let (storage, unavailable) = match resolve_device_key(dir, store, false) {
        Ok(Some(found)) => (found.storage, None),
        Ok(None) if store.is_some() => (KeyStorage::Keychain, None),
        Ok(None) => (KeyStorage::File, None),
        Err(e) => (KeyStorage::Keychain, Some(e.to_string())),
    };
    let export = format!(
        "No master password is used. Exported .rustscp-vault files are protected by your \
         export password with {VAULT_KDF} ({EXPORT_KDF_ITERATIONS} iterations)."
    );
    let (key_location, protection_note) = match (storage, store) {
        (KeyStorage::Keychain, Some(store)) => {
            let mut note = format!(
                "Saved sites are encrypted with {VAULT_CIPHER} using a random 256-bit device \
                 key kept in the {}, not in a file next to the vault, so the vault file or a \
                 backup of its folder cannot be decrypted on its own. The login keychain is \
                 unlocked while you are logged in: RustSCP reads the key without asking, and \
                 macOS asks you before other apps can. Backups made while older versions kept \
                 the key in {} still contain that key. {export}",
                store.location(),
                key_path.display()
            );
            if let Some(e) = unavailable {
                note.push_str(&format!(" The Keychain cannot be read right now: {e}"));
            } else if key_path.exists() {
                note.push_str(&format!(
                    " A separate key file is also present at {} and was kept because it holds \
                     a different key.",
                    key_path.display()
                ));
            }
            (store.location(), note)
        }
        _ => {
            let mut note = format!(
                "Saved sites are encrypted with {VAULT_CIPHER} using a random 256-bit device \
                 key. The key is stored unencrypted in {} (permissions 0600 on macOS/Linux), in \
                 the same folder as the vault, not in the OS keychain. This protects the vault \
                 file if it leaks on its own, but anyone or anything that can read both files \
                 (backups of this folder, other software running as your user) can decrypt it. \
                 {export}",
                key_path.display()
            );
            if let Some(store) = store {
                note.push_str(&format!(
                    " RustSCP moves the key into the {} when it next opens the vault; it has not \
                     been able to yet.",
                    store.location()
                ));
            }
            (key_path.to_string_lossy().to_string(), note)
        }
    };

    VaultSecurityInfo {
        is_encrypted: header.is_some(),
        cipher,
        kdf,
        kdf_iterations,
        vault_path: vault_path.to_string_lossy().to_string(),
        site_count,
        has_custom_master_password: false,
        key_storage: storage.as_str().to_string(),
        key_path: key_location,
        export_kdf_iterations: EXPORT_KDF_ITERATIONS,
        protection_note,
        load_error: None,
        backup_path: None,
    }
}

/// Honest description of the local vault as it is on disk (cipher/KDF read from the
/// file's envelope, where the key really is, export KDF). `load_error`/`backup_path` are
/// left `None` for the caller to fill.
pub fn local_vault_security_info(site_count: usize) -> VaultSecurityInfo {
    let dir = get_rustscp_config_dir();
    let store = platform_key_store(&dir);
    vault_security_info_with(&dir, store.as_deref(), site_count)
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
                tls_fingerprint: None,
                group: Some("Production/Web".to_string()),
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
                tls_fingerprint: None,
                group: Some("Cloud/Storage".to_string()),
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
                tls_fingerprint: None,
                group: None,
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
        let info = vault_security_info_with(dir.path(), None, 0);
        assert!(!info.is_encrypted);
        assert_eq!(info.key_storage, DEVICE_KEY_STORAGE_FILE);
        assert!(info.load_error.is_none());
        assert!(info.backup_path.is_none());
    }

    /// In-memory stand-in for the macOS Keychain.
    #[derive(Default)]
    struct MemoryStore {
        key: std::sync::Mutex<Option<String>>,
        fail_get: bool,
        fail_add: bool,
    }

    impl MemoryStore {
        fn holding(key: &str) -> Self {
            let store = Self::default();
            *store.key.lock().unwrap() = Some(key.to_string());
            store
        }

        fn stored(&self) -> Option<String> {
            self.key.lock().unwrap().clone()
        }
    }

    impl KeyStore for MemoryStore {
        fn location(&self) -> String {
            "test keychain".to_string()
        }

        fn get(&self) -> Result<Option<String>, String> {
            if self.fail_get {
                return Err("keychain locked".to_string());
            }
            Ok(self.stored())
        }

        fn add(&self, key: &str) -> Result<bool, String> {
            if self.fail_add {
                return Err("write refused".to_string());
            }
            let mut slot = self.key.lock().unwrap();
            if slot.is_some() {
                return Ok(false);
            }
            *slot = Some(key.to_string());
            Ok(true)
        }
    }

    #[test]
    fn test_existing_key_file_is_moved_into_the_keychain_and_deleted() {
        let dir = tempdir().unwrap();
        // A vault written by a version that kept the key in .vault_key.
        save_vault_in(dir.path(), &sample_sites()).unwrap();
        let old_key = read_device_key_in(dir.path()).unwrap().unwrap();
        let vault_before = fs::read(dir.path().join(LOCAL_VAULT_FILE)).unwrap();

        // Asking where the key is does not move it.
        let store = MemoryStore::default();
        let info = vault_security_info_with(dir.path(), Some(&store), 3);
        assert_eq!(info.key_storage, DEVICE_KEY_STORAGE_FILE);
        assert!(info.protection_note.contains("has not been able to yet"));
        assert!(store.stored().is_none());

        // The first load moves it: same key in the store, file gone, vault untouched.
        assert_eq!(load_vault_with(dir.path(), Some(&store)).unwrap().len(), 3);
        assert_eq!(store.stored().as_deref(), Some(old_key.as_str()));
        assert!(
            !dir.path().join(DEVICE_KEY_FILE).exists(),
            "key file is deleted"
        );
        assert_eq!(
            fs::read(dir.path().join(LOCAL_VAULT_FILE)).unwrap(),
            vault_before
        );

        // Existing vaults keep loading and saving with the key from the store.
        assert_eq!(load_vault_with(dir.path(), Some(&store)).unwrap().len(), 3);
        save_vault_with(dir.path(), Some(&store), &sample_sites()[..2]).unwrap();
        assert_eq!(load_vault_with(dir.path(), Some(&store)).unwrap().len(), 2);
        assert!(
            !dir.path().join(DEVICE_KEY_FILE).exists(),
            "no key file comes back"
        );
        let bak = fs::read_to_string(dir.path().join(LOCAL_VAULT_BACKUP_FILE)).unwrap();
        assert_eq!(decrypt_local_envelope(&bak, &old_key).unwrap().len(), 3);

        let info = vault_security_info_with(dir.path(), Some(&store), 2);
        assert_eq!(info.key_storage, DEVICE_KEY_STORAGE_KEYCHAIN);
        assert_eq!(info.key_path, "test keychain");
        assert!(info
            .protection_note
            .contains("not in a file next to the vault"));
        assert!(!info.protection_note.contains("stored unencrypted"));
    }

    #[test]
    fn test_new_vault_key_goes_to_the_keychain_not_a_file() {
        let dir = tempdir().unwrap();
        let store = MemoryStore::default();
        assert_eq!(
            vault_security_info_with(dir.path(), Some(&store), 0).key_storage,
            DEVICE_KEY_STORAGE_KEYCHAIN
        );
        save_vault_with(dir.path(), Some(&store), &sample_sites()).unwrap();
        let key = store.stored().expect("key stored");
        assert_eq!(key.len(), 64);
        assert!(!dir.path().join(DEVICE_KEY_FILE).exists());
        assert_eq!(load_vault_with(dir.path(), Some(&store)).unwrap().len(), 3);
        // Without the store the vault cannot be opened, and no key is invented for it.
        assert!(matches!(
            load_vault_in(dir.path()),
            Err(VaultError::DeviceKeyMissing(_))
        ));
        assert!(matches!(
            save_vault_in(dir.path(), &[]),
            Err(VaultError::DeviceKeyMissing(_))
        ));
    }

    #[test]
    fn test_keychain_write_failure_keeps_the_key_file() {
        let dir = tempdir().unwrap();
        save_vault_in(dir.path(), &sample_sites()).unwrap();
        let key = read_device_key_in(dir.path()).unwrap().unwrap();
        let store = MemoryStore {
            fail_add: true,
            ..Default::default()
        };
        assert_eq!(load_vault_with(dir.path(), Some(&store)).unwrap().len(), 3);
        assert_eq!(read_device_key_in(dir.path()).unwrap(), Some(key));
        save_vault_with(dir.path(), Some(&store), &sample_sites()).unwrap();
        assert_eq!(
            vault_security_info_with(dir.path(), Some(&store), 3).key_storage,
            DEVICE_KEY_STORAGE_FILE
        );

        // A brand-new vault falls back to a key file too.
        let fresh = tempdir().unwrap();
        save_vault_with(fresh.path(), Some(&store), &sample_sites()).unwrap();
        assert!(fresh.path().join(DEVICE_KEY_FILE).exists());
        assert_eq!(
            load_vault_with(fresh.path(), Some(&store)).unwrap().len(),
            3
        );
    }

    #[test]
    fn test_unreadable_keychain_never_replaces_the_vault() {
        let dir = tempdir().unwrap();
        let store = MemoryStore::default();
        save_vault_with(dir.path(), Some(&store), &sample_sites()).unwrap();
        let vault_path = dir.path().join(LOCAL_VAULT_FILE);
        let original = fs::read(&vault_path).unwrap();

        let locked = MemoryStore {
            fail_get: true,
            ..MemoryStore::holding(&store.stored().unwrap())
        };
        assert!(matches!(
            load_vault_with(dir.path(), Some(&locked)),
            Err(VaultError::KeychainUnavailable(_))
        ));
        assert!(matches!(
            save_vault_with(dir.path(), Some(&locked), &[]),
            Err(VaultError::KeychainUnavailable(_))
        ));
        assert_eq!(fs::read(&vault_path).unwrap(), original, "vault untouched");
        assert!(
            !dir.path().join(DEVICE_KEY_FILE).exists(),
            "no key invented"
        );
        let info = vault_security_info_with(dir.path(), Some(&locked), 3);
        assert_eq!(info.key_storage, DEVICE_KEY_STORAGE_KEYCHAIN);
        assert!(info.protection_note.contains("cannot be read right now"));
        assert_eq!(
            VaultError::KeychainUnavailable(String::new()).code(),
            "vault.keychain_unavailable"
        );

        // A key file that is still there keeps working while the keychain is locked.
        let legacy = tempdir().unwrap();
        save_vault_in(legacy.path(), &sample_sites()).unwrap();
        assert_eq!(
            load_vault_with(legacy.path(), Some(&locked)).unwrap().len(),
            3
        );
        assert!(legacy.path().join(DEVICE_KEY_FILE).exists());

        // With no vault yet, an unreadable keychain falls back to a key file.
        let fresh = tempdir().unwrap();
        save_vault_with(fresh.path(), Some(&locked), &sample_sites()).unwrap();
        assert!(fresh.path().join(DEVICE_KEY_FILE).exists());
    }

    #[test]
    fn test_interrupted_migration_and_conflicting_keys() {
        // The key reached the keychain but the file was not deleted yet.
        let dir = tempdir().unwrap();
        save_vault_in(dir.path(), &sample_sites()).unwrap();
        let key = read_device_key_in(dir.path()).unwrap().unwrap();
        let store = MemoryStore::holding(&key);
        assert_eq!(load_vault_with(dir.path(), Some(&store)).unwrap().len(), 3);
        assert!(!dir.path().join(DEVICE_KEY_FILE).exists());

        // Different keys: the one that opens the vault wins and nothing is deleted.
        let other = "cd".repeat(32);
        let dir = tempdir().unwrap();
        save_vault_in(dir.path(), &sample_sites()).unwrap();
        let file_key = read_device_key_in(dir.path()).unwrap().unwrap();
        let store = MemoryStore::holding(&other);
        assert_eq!(load_vault_with(dir.path(), Some(&store)).unwrap().len(), 3);
        assert_eq!(
            read_device_key_in(dir.path()).unwrap(),
            Some(file_key.clone())
        );
        assert_eq!(store.stored(), Some(other.clone()));
        assert_eq!(
            vault_security_info_with(dir.path(), Some(&store), 3).key_storage,
            DEVICE_KEY_STORAGE_FILE
        );

        let dir = tempdir().unwrap();
        let store = MemoryStore::default();
        save_vault_with(dir.path(), Some(&store), &sample_sites()).unwrap();
        fs::write(dir.path().join(DEVICE_KEY_FILE), &other).unwrap();
        assert_eq!(load_vault_with(dir.path(), Some(&store)).unwrap().len(), 3);
        assert!(dir.path().join(DEVICE_KEY_FILE).exists());
        let info = vault_security_info_with(dir.path(), Some(&store), 3);
        assert_eq!(info.key_storage, DEVICE_KEY_STORAGE_KEYCHAIN);
        assert!(info.protection_note.contains("different key"));
    }

    /// Round trip through the real login keychain with a throwaway item. Not run by
    /// default (it writes to the Keychain): `cargo test -p rustscp-core real_keychain -- --ignored`.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn test_real_keychain_round_trip() {
        let dir = tempdir().unwrap();
        let store = keychain::MacKeychain::for_vault_dir(dir.path());
        store.delete();
        assert_eq!(store.get().unwrap(), None);
        save_vault_in(dir.path(), &sample_sites()).unwrap();
        let key = read_device_key_in(dir.path()).unwrap().unwrap();

        let loaded = load_vault_with(dir.path(), Some(&store));
        let stored = store.get();
        let second_add = store.add("ef".repeat(32).as_str());
        let reloaded = load_vault_with(dir.path(), Some(&store));
        store.delete();

        assert_eq!(loaded.unwrap().len(), 3);
        assert_eq!(stored.unwrap().as_deref(), Some(key.as_str()));
        assert_eq!(second_add, Ok(false), "an existing key is never replaced");
        assert_eq!(reloaded.unwrap().len(), 3);
        assert!(!dir.path().join(DEVICE_KEY_FILE).exists());
        assert_eq!(store.get().unwrap(), None, "test item removed");
    }

    /// Writes `sites_json` (the plaintext an older build serialized) as the local vault
    /// in `dir`, encrypted with that folder's device key.
    fn write_raw_local_vault(dir: &Path, sites_json: &str, site_count: usize) {
        let key = get_or_create_device_key_in(dir).unwrap();
        let envelope = encrypt_bytes_with_iterations(
            sites_json.as_bytes(),
            &key,
            site_count,
            LOCAL_VAULT_KDF_ITERATIONS,
        )
        .unwrap();
        fs::write(
            dir.join(LOCAL_VAULT_FILE),
            serde_json::to_string_pretty(&envelope).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn test_export_round_trip_keeps_site_groups() {
        let envelope =
            encrypt_sites_with_iterations(&sample_sites(), "GroupPass", TEST_ITERATIONS).unwrap();
        let json = serialize_vault_to_json(&envelope).unwrap();
        let back = decrypt_sites(&parse_vault_from_json(&json).unwrap(), "GroupPass").unwrap();
        let groups: Vec<_> = back.iter().map(|s| s.group.as_deref()).collect();
        assert_eq!(
            groups,
            vec![Some("Production/Web"), Some("Cloud/Storage"), None]
        );
    }

    #[test]
    fn test_old_vault_without_groups_loads_and_keeps_groups_on_save() {
        // Plaintext exactly as builds before site folders wrote it: no `group`, no
        // `tls_fingerprint`.
        let old_format = r#"[
            {"id":"local","name":"Local Machine","protocol":"local","host":"localhost",
             "port":0,"username":"me","auth":{"type":"None"},"remote_root":"/"},
            {"id":"web-1","name":"Web","protocol":"sftp","host":"web.example.com","port":22,
             "username":"deploy","auth":{"type":"Password","value":"OldSecret!"},
             "remote_root":"/var/www"}
        ]"#;
        let dir = tempdir().unwrap();
        write_raw_local_vault(dir.path(), old_format, 2);

        let mut sites = load_vault_in(dir.path()).unwrap();
        assert_eq!(sites.len(), 2);
        assert!(sites.iter().all(|s| s.group.is_none()));
        assert!(matches!(&sites[1].auth, AuthMethod::Password(p) if p == "OldSecret!"));

        // Filing the site into a folder survives a save and a reload.
        sites[1].group = Some("Clientes/São Paulo".to_string());
        save_vault_in(dir.path(), &sites).unwrap();
        let reloaded = load_vault_in(dir.path()).unwrap();
        assert_eq!(reloaded[0].group, None);
        assert_eq!(reloaded[1].group.as_deref(), Some("Clientes/São Paulo"));
        assert!(matches!(&reloaded[1].auth, AuthMethod::Password(p) if p == "OldSecret!"));
        // The previous (group-less) version is the backup.
        let bak = fs::read_to_string(dir.path().join(LOCAL_VAULT_BACKUP_FILE)).unwrap();
        let key = read_device_key_in(dir.path()).unwrap().unwrap();
        assert!(decrypt_local_envelope(&bak, &key)
            .unwrap()
            .iter()
            .all(|s| s.group.is_none()));
    }

    #[test]
    fn test_vault_written_by_the_september_build_keeps_its_groups() {
        // That build serialized `group` on every site, `null` included.
        let wip_format = r#"[
            {"id":"a","name":"A","protocol":"sftp","host":"a.example.com","port":22,
             "username":"u","auth":{"type":"None"},"remote_root":"/","group":null},
            {"id":"winscp-1","name":"B","protocol":"ftp","host":"b.example.com","port":21,
             "username":"u","auth":{"type":"Password","value":"pw"},"remote_root":"/",
             "group":"Suporte/Dedicado"}
        ]"#;
        let dir = tempdir().unwrap();
        write_raw_local_vault(dir.path(), wip_format, 2);
        let sites = load_vault_in(dir.path()).unwrap();
        assert_eq!(sites[0].group, None);
        assert_eq!(sites[1].group.as_deref(), Some("Suporte/Dedicado"));

        save_vault_in(dir.path(), &sites).unwrap();
        let reloaded = load_vault_in(dir.path()).unwrap();
        assert_eq!(reloaded[1].group.as_deref(), Some("Suporte/Dedicado"));
        assert_eq!(reloaded[0].group, None);
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

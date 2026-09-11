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
use std::path::PathBuf;
use thiserror::Error;

use crate::types::ConnectionConfig;

pub const VAULT_MAGIC: &str = "RUSTSCP_VAULT";
pub const VAULT_VERSION: u32 = 1;
pub const DEFAULT_KDF_ITERATIONS: u32 = 100_000;
pub const SALT_LEN: usize = 32;
pub const NONCE_LEN: usize = 12;

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

/// Informações de status de segurança do cofre local
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultSecurityInfo {
    pub is_encrypted: bool,
    pub cipher: String,
    pub kdf: String,
    pub kdf_iterations: u32,
    pub vault_path: String,
    pub site_count: usize,
    pub has_custom_master_password: bool,
}

/// Deriva uma chave de 256 bits (32 bytes) a partir da senha e salt via PBKDF2-HMAC-SHA256
pub fn derive_key(password: &str, salt: &[u8], iterations: u32) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, iterations, &mut key);
    key
}

/// Criptografa dados arbitrários (bytes) usando AES-256-GCM + PBKDF2
pub fn encrypt_bytes(data: &[u8], password: &str, site_count: usize) -> Result<VaultEnvelope, VaultError> {
    if password.is_empty() {
        return Err(VaultError::Other("A senha de criptografia não pode ser vazia".to_string()));
    }

    let mut salt = [0u8; SALT_LEN];
    let mut nonce_bytes = [0u8; NONCE_LEN];
    let mut rng = rand::thread_rng();
    rng.fill_bytes(&mut salt);
    rng.fill_bytes(&mut nonce_bytes);

    let key = derive_key(password, &salt, DEFAULT_KDF_ITERATIONS);
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| VaultError::Other(format!("Erro ao inicializar cifra AES-256-GCM: {e}")))?;
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, data)
        .map_err(|_| VaultError::Other("Falha ao criptografar dados com AES-256-GCM".to_string()))?;

    Ok(VaultEnvelope {
        magic: VAULT_MAGIC.to_string(),
        version: VAULT_VERSION,
        cipher: "AES-256-GCM".to_string(),
        kdf: "PBKDF2-HMAC-SHA256".to_string(),
        kdf_iterations: DEFAULT_KDF_ITERATIONS,
        salt_hex: hex::encode(salt),
        nonce_hex: hex::encode(nonce_bytes),
        ciphertext_hex: hex::encode(ciphertext),
        exported_at: Utc::now().to_rfc3339(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        site_count,
    })
}

/// Descriptografa um envelope de cofre retornando os bytes originais autenticados
pub fn decrypt_bytes(envelope: &VaultEnvelope, password: &str) -> Result<Vec<u8>, VaultError> {
    if envelope.magic != VAULT_MAGIC {
        return Err(VaultError::InvalidHeader);
    }
    if envelope.version != VAULT_VERSION {
        return Err(VaultError::UnsupportedVersion(envelope.version));
    }
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

/// Criptografa uma lista de conexões (credenciais, hosts, senhas, chaves) em um envelope seguro
pub fn encrypt_sites(sites: &[ConnectionConfig], password: &str) -> Result<VaultEnvelope, VaultError> {
    let json_bytes = serde_json::to_vec(sites)?;
    encrypt_bytes(&json_bytes, password, sites.len())
}

/// Descriptografa um envelope seguro retornando a lista de conexões
pub fn decrypt_sites(envelope: &VaultEnvelope, password: &str) -> Result<Vec<ConnectionConfig>, VaultError> {
    let plaintext = decrypt_bytes(envelope, password)?;
    let sites: Vec<ConnectionConfig> = serde_json::from_slice(&plaintext)?;
    Ok(sites)
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
    get_rustscp_config_dir().join("sites.vault")
}

/// Retorna o caminho da chave do dispositivo local (.vault_key)
pub fn get_local_device_key_path() -> PathBuf {
    get_rustscp_config_dir().join(".vault_key")
}

/// Obtém ou gera a chave local segura do dispositivo com permissões estritas
pub fn get_or_create_device_key() -> Result<String, VaultError> {
    let config_dir = get_rustscp_config_dir();
    if !config_dir.exists() {
        fs::create_dir_all(&config_dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&config_dir, fs::Permissions::from_mode(0o700));
        }
    }

    let key_path = get_local_device_key_path();
    if key_path.exists() {
        let key_str = fs::read_to_string(&key_path)?.trim().to_string();
        if !key_str.is_empty() {
            return Ok(key_str);
        }
    }

    // Gera nova chave criptográfica aleatória de 32 bytes
    let mut random_bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut random_bytes);
    let key_hex = hex::encode(random_bytes);

    fs::write(&key_path, &key_hex)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&key_path, fs::Permissions::from_mode(0o600));
    }

    Ok(key_hex)
}

/// Salva a lista de sites no cofre local de forma 100% criptografada no disco
pub fn save_local_vault(sites: &[ConnectionConfig]) -> Result<(), VaultError> {
    let config_dir = get_rustscp_config_dir();
    if !config_dir.exists() {
        fs::create_dir_all(&config_dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&config_dir, fs::Permissions::from_mode(0o700));
        }
    }

    let device_key = get_or_create_device_key()?;
    let envelope = encrypt_sites(sites, &device_key)?;
    let json = serde_json::to_string_pretty(&envelope)?;

    let vault_path = get_local_vault_path();
    fs::write(&vault_path, json)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&vault_path, fs::Permissions::from_mode(0o600));
    }

    Ok(())
}

/// Carrega a lista de sites do cofre local criptografado
pub fn load_local_vault() -> Result<Vec<ConnectionConfig>, VaultError> {
    let vault_path = get_local_vault_path();
    if !vault_path.exists() {
        return Ok(Vec::new());
    }

    let json_str = fs::read_to_string(&vault_path)?;
    let envelope = parse_vault_from_json(&json_str)?;

    let device_key = get_or_create_device_key()?;
    let sites = decrypt_sites(&envelope, &device_key)?;
    Ok(sites)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{AuthMethod, Protocol};
    use tempfile::tempdir;

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

        let envelope = encrypt_sites(&sites, password).expect("Falha ao criptografar sites");
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

        if let AuthMethod::PrivateKey { ref path, ref passphrase } = decrypted[2].auth {
            assert_eq!(path, "/home/user/.ssh/id_ed25519");
            assert_eq!(passphrase.as_deref(), Some("key-passphrase-xyz"));
        } else {
            panic!("Expected PrivateKey auth method");
        }
    }

    #[test]
    fn test_vault_wrong_password_fails() {
        let sites = sample_sites();
        let envelope = encrypt_sites(&sites, "CorrectPassword").expect("Encryption failed");

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
        let mut envelope = encrypt_sites(&sites, "CorrectPassword").expect("Encryption failed");

        // Adultera um byte do ciphertext
        let mut bytes = hex::decode(&envelope.ciphertext_hex).unwrap();
        bytes[5] ^= 0xff;
        envelope.ciphertext_hex = hex::encode(bytes);

        let result = decrypt_sites(&envelope, "CorrectPassword");
        assert!(result.is_err(), "Deveria falhar com dados adulterados (Auth Tag mismatch)");
    }

    #[test]
    fn test_vault_json_serialization_roundtrip() {
        let sites = sample_sites();
        let password = "ExportPassword123";

        let envelope = encrypt_sites(&sites, password).unwrap();
        let json_str = serialize_vault_to_json(&envelope).unwrap();

        let parsed_envelope = parse_vault_from_json(&json_str).unwrap();
        assert_eq!(envelope, parsed_envelope);

        let decrypted = decrypt_sites(&parsed_envelope, password).unwrap();
        assert_eq!(decrypted.len(), 3);
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
    }
}

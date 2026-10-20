use crate::types::{AuthMethod, ConnectionConfig, CoreError, CoreResult, Protocol};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

pub const PW_MAGIC: u8 = 0xA3;
pub const PW_FLAG: u8 = 0xFF;

/// Decodifica proximo caractere na sequencia de bytes ofuscada do WinSCP
fn dec_next_char(passbytes: &mut Vec<u8>) -> u8 {
    if passbytes.len() < 2 {
        return 0;
    }
    let a = passbytes.remove(0);
    let b = passbytes.remove(0);
    (!(((a << 4) + b) ^ PW_MAGIC)) & 0xFF
}

/// Descriptografa senhas ofuscadas salvas pelo WinSCP no formato .ini ou Registro
pub fn decrypt_winscp_password(host: &str, username: &str, encrypted_hex: &str) -> String {
    let encrypted_hex = encrypted_hex.trim();
    if encrypted_hex.is_empty() {
        return String::new();
    }

    let mut passbytes: Vec<u8> = Vec::new();
    for c in encrypted_hex.chars() {
        if let Some(val) = c.to_digit(16) {
            passbytes.push(val as u8);
        }
    }

    if passbytes.len() < 2 {
        return String::new();
    }

    let flag = dec_next_char(&mut passbytes);
    let length = if flag == PW_FLAG {
        let _dummy = dec_next_char(&mut passbytes);
        dec_next_char(&mut passbytes)
    } else {
        flag
    };

    let to_be_deleted = dec_next_char(&mut passbytes);
    let delete_count = (to_be_deleted as usize) * 2;
    if passbytes.len() >= delete_count {
        passbytes.drain(0..delete_count);
    } else {
        passbytes.clear();
    }

    let mut clearpass_bytes: Vec<u8> = Vec::new();
    for _ in 0..length {
        if passbytes.len() < 2 {
            break;
        }
        let val = dec_next_char(&mut passbytes);
        clearpass_bytes.push(val);
    }

    let mut clearpass = String::from_utf8_lossy(&clearpass_bytes).to_string();

    if flag == PW_FLAG {
        let key = format!("{}{}", username, host);
        if clearpass.starts_with(&key) {
            clearpass = clearpass[key.len()..].to_string();
        }
    }

    clearpass
}

/// Decodifica sequencias percent-encoded (%20 -> espaco, %5C -> \, %2F -> /, etc.)
pub fn url_decode_winscp(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();

    while let Some(c) = chars.next() {
        if c == '%' {
            let h1 = chars.next();
            let h2 = chars.next();
            if let (Some(h1), Some(h2)) = (h1, h2) {
                let hex_str = format!("{}{}", h1, h2);
                if let Ok(byte) = u8::from_str_radix(&hex_str, 16) {
                    result.push(byte as char);
                    continue;
                } else {
                    result.push('%');
                    result.push(h1);
                    result.push(h2);
                    continue;
                }
            } else {
                result.push('%');
                if let Some(h1) = h1 {
                    result.push(h1);
                }
                continue;
            }
        } else {
            result.push(c);
        }
    }

    result
}

/// Normaliza caminhos de chaves e certificados SSH, convertendo unidades do Windows
/// (ex: Y:\Library\Mobile Documents\... ou C:\Users\...) para os caminhos correspondentes locais
pub fn normalize_key_path(raw_path: &str) -> String {
    let decoded = url_decode_winscp(raw_path.trim().trim_matches('"'));
    if decoded.is_empty() {
        return String::new();
    }

    let unix_style = decoded.replace('\\', "/");

    #[cfg(unix)]
    {
        if let Ok(home) = std::env::var("HOME") {
            // Caso especial: Drive do iCloud emulado no Windows (Y:\Library\Mobile Documents\...)
            if let Some(idx) = unix_style.find("Library/Mobile Documents/") {
                let subpath = &unix_style[idx..];
                let candidate = PathBuf::from(&home).join(subpath);
                if candidate.exists() {
                    return candidate.to_string_lossy().to_string();
                }
            }

            // Caso geral: C:/Users/<user>/.ssh/... -> $HOME/.ssh/...
            if let Some(idx) = unix_style.find("/.ssh/") {
                let subpath = &unix_style[idx + 1..];
                let candidate = PathBuf::from(&home).join(subpath);
                if candidate.exists() {
                    return candidate.to_string_lossy().to_string();
                }
            }
        }
    }

    unix_style
}

/// Decodifica bytes de arquivo INI lidando com UTF-8, UTF-16 e fallback ISO-8859-1 / Windows-1252
pub fn decode_ini_bytes(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }

    // Checa UTF-8 com BOM
    let bytes_no_bom = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        &bytes[3..]
    } else {
        bytes
    };

    // Checa UTF-16LE com BOM
    if bytes_no_bom.starts_with(&[0xFF, 0xFE]) {
        let u16_slice: Vec<u16> = bytes_no_bom[2..]
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect();
        return String::from_utf16_lossy(&u16_slice);
    }

    // Tenta UTF-8 nativo
    if let Ok(utf8_str) = std::str::from_utf8(bytes_no_bom) {
        return utf8_str.to_string();
    }

    // Fallback seguro: Windows-1252 / ISO-8859-1 (preserva acentuacoes e caracteres latinos)
    bytes_no_bom.iter().map(|&b| b as char).collect()
}

/// Resultado da importacao e migracao das sessoes do WinSCP
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WinScpImportResult {
    pub total_sessions: usize,
    pub decrypted_passwords: usize,
    pub key_auth_sessions: usize,
    pub folders: Vec<String>,
    pub sites: Vec<ConnectionConfig>,
}

/// Analisa o conteudo textual de um arquivo WinSCP.ini e extrai todas as sessoes
pub fn parse_winscp_ini(content: &str) -> WinScpImportResult {
    let mut sites: Vec<ConnectionConfig> = Vec::new();
    let mut folders_set: BTreeSet<String> = BTreeSet::new();
    let mut decrypted_passwords = 0;
    let mut key_auth_sessions = 0;

    let mut current_section: Option<String> = None;
    let mut current_props: HashMap<String, String> = HashMap::new();

    let flush_section = |section: Option<String>,
                         props: HashMap<String, String>,
                         sites: &mut Vec<ConnectionConfig>,
                         folders_set: &mut BTreeSet<String>,
                         decrypted_passwords: &mut usize,
                         key_auth_sessions: &mut usize| {
        let Some(sec) = section else { return };
        let sec_trimmed = sec.trim();

        let session_raw_path = if let Some(stripped) = sec_trimmed.strip_prefix("Sessions\\") {
            stripped
        } else if let Some(stripped) = sec_trimmed.strip_prefix("sessions\\") {
            stripped
        } else {
            return;
        };

        let host = props.get("HostName").cloned().unwrap_or_default();
        if host.trim().is_empty() {
            return;
        }

        let decoded_path = url_decode_winscp(session_raw_path);
        let path_parts: Vec<&str> = decoded_path.split('/').collect();

        let (group, name) = if path_parts.len() > 1 {
            let folder = path_parts[..path_parts.len() - 1].join("/");
            folders_set.insert(folder.clone());
            (Some(folder), path_parts[path_parts.len() - 1].to_string())
        } else {
            (None, path_parts[0].to_string())
        };

        let username = props.get("UserName").cloned().unwrap_or_default();
        let protocol_code = props.get("FSProtocol").map(|s| s.as_str()).unwrap_or("0");

        let protocol = match protocol_code {
            "5" => Protocol::Ftp,
            "6" => Protocol::WebDav,
            "7" => Protocol::S3,
            _ => Protocol::Sftp,
        };

        let default_port = match protocol {
            Protocol::Ftp => 21,
            Protocol::S3 => 443,
            Protocol::WebDav => 80,
            _ => 22,
        };

        let port: u16 = props
            .get("PortNumber")
            .and_then(|p| p.parse::<u16>().ok())
            .unwrap_or(default_port);

        let remote_dir = props
            .get("RemoteDirectory")
            .map(|d| url_decode_winscp(d.trim_matches('"')))
            .unwrap_or_else(|| "/".to_string());
        let remote_root = if remote_dir.trim().is_empty() {
            "/".to_string()
        } else {
            remote_dir
        };

        let pub_key_raw = props.get("PublicKeyFile").cloned();
        let enc_password = props.get("Password").cloned();

        let auth = if let Some(pub_key) = pub_key_raw {
            let normalized_path = normalize_key_path(&pub_key);
            if !normalized_path.is_empty() {
                *key_auth_sessions += 1;
                AuthMethod::PrivateKey {
                    path: normalized_path,
                    passphrase: None,
                }
            } else {
                AuthMethod::None
            }
        } else if let Some(enc_pwd) = enc_password {
            let dec = decrypt_winscp_password(&host, &username, &enc_pwd);
            if !dec.is_empty() {
                *decrypted_passwords += 1;
                AuthMethod::Password(dec)
            } else {
                AuthMethod::None
            }
        } else {
            AuthMethod::None
        };

        let site_id = format!("winscp-{}", uuid::Uuid::new_v4());

        sites.push(ConnectionConfig {
            id: site_id,
            name,
            protocol,
            host,
            port,
            username,
            auth,
            remote_root,
            group,
        });
    };

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
            continue;
        }

        if line.starts_with('[') && line.ends_with(']') {
            let next_sec = line[1..line.len() - 1].to_string();
            let prev_sec = current_section.replace(next_sec);
            let prev_props = std::mem::take(&mut current_props);

            flush_section(
                prev_sec,
                prev_props,
                &mut sites,
                &mut folders_set,
                &mut decrypted_passwords,
                &mut key_auth_sessions,
            );
        } else if let Some((k, v)) = line.split_once('=') {
            current_props.insert(k.trim().to_string(), v.trim().to_string());
        }
    }

    // Flush last section
    flush_section(
        current_section,
        current_props,
        &mut sites,
        &mut folders_set,
        &mut decrypted_passwords,
        &mut key_auth_sessions,
    );

    WinScpImportResult {
        total_sessions: sites.len(),
        decrypted_passwords,
        key_auth_sessions,
        folders: folders_set.into_iter().collect(),
        sites,
    }
}

/// Carrega e analisa um arquivo WinSCP.ini do disco suportando UTF-8 e codificacoes legadas
pub fn parse_winscp_ini_file(path: &Path) -> CoreResult<WinScpImportResult> {
    if !path.exists() {
        return Err(CoreError::NotFound(format!(
            "Arquivo WinSCP.ini nao encontrado em: {}",
            path.display()
        )));
    }

    let bytes = fs::read(path).map_err(|e| {
        CoreError::Io(std::io::Error::new(
            e.kind(),
            format!("Falha ao ler arquivo WinSCP.ini: {e}"),
        ))
    })?;

    let content = decode_ini_bytes(&bytes);
    Ok(parse_winscp_ini(&content))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_winscp_password_decryption_real_cases() {
        // Teste com casos do WinSCP.ini do usuario
        // executiva@executivacob.com.br
        let host = "executivacob.com.br";
        let user = "executi";
        let enc = "A35C7F5E32C43924393F2928353924393F2928352A3D3F333E723F3331723E2E39647D1F6962356E05EDE75136DF038074EE";
        let dec = decrypt_winscp_password(host, user, enc);
        assert_eq!(dec.len(), 9);
        assert!(dec.starts_with("e8"));
        assert!(dec.ends_with("2Y"));

        // acanova@acanovachurrasco.com
        let host2 = "acanovachurrasco.com";
        let user2 = "acanova";
        let enc2 = "A35C7F5C3D3F3D32332A3D3D3F3D32332A3D3F34292E2E3D2F3F33723F33311017326517696E0DC653869798FA8638A7ABE2";
        let dec2 = decrypt_winscp_password(host2, user2, enc2);
        assert_eq!(dec2.len(), 8);
        assert!(dec2.starts_with("LK"));
    }

    #[test]
    fn test_url_decode_winscp() {
        assert_eq!(
            url_decode_winscp("D1%20-%20ns537298%20server"),
            "D1 - ns537298 server"
        );
        assert_eq!(
            url_decode_winscp("Folder%2FSubfolder%5CPath"),
            "Folder/Subfolder\\Path"
        );
    }

    #[test]
    fn test_parse_sample_winscp_ini_string() {
        let ini = r#"
[Configuration\Interface]
RandomSeedFile=%25APPDATA%25\winscp.rnd

[Sessions\Suporte/Inovar/Dedicado/executiva@executivacob.com.br]
HostName=executivacob.com.br
PortNumber=9942
UserName=executi
Password=A35C7F5E32C43924393F2928353924393F2928352A3D3F333E723F3331723E2E39647D1F6962356E05EDE75136DF038074EE
RemoteDirectory=/home/executi/web/public_html

[Sessions\Oracle-OCI/InfoB-UbuntuAarch64-aaPanel/ubuntu@136.248.94.28]
HostName=136.248.94.28
PortNumber=22
UserName=ubuntu
PublicKeyFile=Y:%5CLibrary%5CMobile%20Documents%5Ccom~apple~CloudDocs%5Ctest.ppk
RemoteDirectory=/home/ubuntu
"#;

        let res = parse_winscp_ini(ini);
        assert_eq!(res.total_sessions, 2);
        assert_eq!(res.decrypted_passwords, 1);
        assert_eq!(res.key_auth_sessions, 1);
        assert_eq!(res.folders.len(), 2);
        assert!(res.folders.contains(&"Suporte/Inovar/Dedicado".to_string()));
        assert!(res
            .folders
            .contains(&"Oracle-OCI/InfoB-UbuntuAarch64-aaPanel".to_string()));

        let s1 = &res.sites[0];
        assert_eq!(s1.name, "executiva@executivacob.com.br");
        assert_eq!(s1.group.as_deref(), Some("Suporte/Inovar/Dedicado"));
        assert_eq!(s1.host, "executivacob.com.br");
        assert_eq!(s1.port, 9942);
        assert_eq!(s1.username, "executi");
        assert_eq!(s1.remote_root, "/home/executi/web/public_html");

        if let AuthMethod::Password(ref p) = s1.auth {
            assert_eq!(p.len(), 9);
        } else {
            panic!("Esperado AuthMethod::Password");
        }

        let s2 = &res.sites[1];
        assert_eq!(s2.name, "ubuntu@136.248.94.28");
        assert_eq!(
            s2.group.as_deref(),
            Some("Oracle-OCI/InfoB-UbuntuAarch64-aaPanel")
        );
        assert!(matches!(s2.auth, AuthMethod::PrivateKey { .. }));
    }

    #[test]
    fn test_parse_real_user_winscp_file_if_present() {
        let path = Path::new("/Users/tiagobecker/Downloads/WinSCP.ini");
        if path.exists() {
            let res = parse_winscp_ini_file(path).expect("Falha ao ler WinSCP.ini real");
            assert_eq!(res.total_sessions, 151);
            assert_eq!(res.decrypted_passwords, 146);
            assert_eq!(res.key_auth_sessions, 4);
            assert_eq!(res.folders.len(), 26);

            // Valida integridade com cofre AES-256-GCM
            let envelope = crate::vault::encrypt_sites(&res.sites, "WinSCP-Migration-Vault-Pass-2026")
                .expect("Falha ao cifrar sites importados do WinSCP no cofre");
            assert_eq!(envelope.site_count, 151);

            let decrypted = crate::vault::decrypt_sites(&envelope, "WinSCP-Migration-Vault-Pass-2026")
                .expect("Falha ao decifrar sites do cofre");
            assert_eq!(decrypted.len(), 151);
            assert_eq!(decrypted[0].name, res.sites[0].name);
            assert_eq!(decrypted[0].group, res.sites[0].group);
        }
    }
}

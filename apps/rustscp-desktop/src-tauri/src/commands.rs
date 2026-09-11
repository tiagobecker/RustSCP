use rustscp_actions::{ActionCatalog, ActionContext, ActionDefinition, ActionExecutor};
use rustscp_core::{
    get_rustscp_config_dir, BookmarkItem, CacheStats, CodeGenerator, CodeTargetLanguage,
    ConnectionConfig, DirectoryDiffItem, DirectoryDiffType, FileEntry, FileMaskFilter,
    FileSystemInfo, FindFileMatch, FindFileQuery, FtpConfig, FtpDriver, LocalFsDriver,
    ManagedDiskCache, Protocol, QueueTransferTask, RemoteSystemInfo, RemoteTrashItem,
    RemoteTrashStatus, S3Config, S3Driver, ScriptCommandOutput, ScriptInterpreter, SftpDriver,
    SyncEngine, SyncItem, SyncOptions, TransferQueueManager, VirtualDiskInfo, VirtualFileSystem,
    WebDavServer,
};
use rustscp_mcp::{AuditEvent, AuditLogger, McpServer};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex, RwLock};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpStatusInfo {
    pub enabled: bool,
    pub active_sessions_count: usize,
    pub total_audit_events: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandExecutionResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChecksumResult {
    pub algorithm: String,
    pub hash: String,
}

#[allow(dead_code)]
pub struct AppState {
    pub local_vfs: Arc<LocalFsDriver>,
    pub active_sessions: Arc<RwLock<HashMap<String, Arc<dyn VirtualFileSystem>>>>,
    pub session_configs: Arc<RwLock<HashMap<String, ConnectionConfig>>>,
    pub saved_sites: Arc<RwLock<Vec<ConnectionConfig>>>,
    pub bookmarks: Arc<RwLock<Vec<BookmarkItem>>>,
    pub continuous_sync_active: Arc<AtomicBool>,
    pub continuous_sync_cancel: Arc<Mutex<Option<broadcast::Sender<()>>>>,
    pub virtual_disks: Arc<Mutex<HashMap<String, WebDavServer>>>,
    pub disk_cache: Arc<ManagedDiskCache>,
    pub transfer_queue: Arc<TransferQueueManager>,
    pub mcp_server: Arc<McpServer>,
    pub audit_logger: AuditLogger,
}

impl AppState {
    pub fn new() -> Self {
        let audit = AuditLogger::new();
        let mcp = Arc::new(McpServer::new(audit.clone()));
        let mut active: HashMap<String, Arc<dyn VirtualFileSystem>> = HashMap::new();
        let mut configs = HashMap::new();

        let local_cfg = ConnectionConfig::local();
        let local_driver = Arc::new(LocalFsDriver::new());

        active.insert("local".to_string(), local_driver.clone());
        configs.insert("local".to_string(), local_cfg.clone());

        let mut initial_sites = match rustscp_core::load_local_vault() {
            Ok(loaded) if !loaded.is_empty() => loaded,
            _ => vec![local_cfg.clone()],
        };
        if !initial_sites.iter().any(|s| s.id == "local") {
            initial_sites.insert(0, local_cfg.clone());
        }

        Self {
            local_vfs: local_driver,
            active_sessions: Arc::new(RwLock::new(active)),
            session_configs: Arc::new(RwLock::new(configs)),
            saved_sites: Arc::new(RwLock::new(initial_sites)),
            bookmarks: Arc::new(RwLock::new(Vec::new())),
            continuous_sync_active: Arc::new(AtomicBool::new(false)),
            continuous_sync_cancel: Arc::new(Mutex::new(None)),
            virtual_disks: Arc::new(Mutex::new(HashMap::new())),
            disk_cache: Arc::new(ManagedDiskCache::default()),
            transfer_queue: Arc::new(TransferQueueManager::new(3)),
            mcp_server: mcp,
            audit_logger: audit,
        }
    }
}

// ---------------------- CONNECTION & SESSION COMMANDS ----------------------

#[tauri::command]
pub async fn connect_session(
    state: tauri::State<'_, AppState>,
    config: ConnectionConfig,
) -> Result<String, String> {
    let session_id = if config.id.is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        config.id.clone()
    };

    let vfs: Arc<dyn VirtualFileSystem> = match config.protocol {
        Protocol::Local => Arc::new(LocalFsDriver::new()),

        Protocol::Sftp => {
            let driver = SftpDriver::new(config.clone());
            driver.connect().await.map_err(|e| e.to_string())?;
            Arc::new(driver)
        }

        Protocol::S3 => {
            let s3_cfg = S3Config {
                endpoint: if config.host.starts_with("http") {
                    config.host.clone()
                } else {
                    format!("https://{}", config.host)
                },
                region: "us-east-1".to_string(),
                access_key: config.username.clone(),
                secret_key: match &config.auth {
                    rustscp_core::AuthMethod::Password(p) => p.clone(),
                    _ => "".to_string(),
                },
                bucket: if config.remote_root.trim_matches('/').is_empty() {
                    None
                } else {
                    Some(config.remote_root.trim_matches('/').to_string())
                },
            };
            Arc::new(S3Driver::new(s3_cfg))
        }

        Protocol::Ftp => {
            let ftp_cfg = FtpConfig {
                host: config.host.clone(),
                port: if config.port == 0 { 21 } else { config.port },
                username: config.username.clone(),
                password: match &config.auth {
                    rustscp_core::AuthMethod::Password(p) => Some(p.clone()),
                    _ => None,
                },
            };
            let driver = FtpDriver::new(ftp_cfg);
            driver.connect().await.map_err(|e| e.to_string())?;
            Arc::new(driver)
        }

        Protocol::WebDav => {
            return Err("WebDAV protocol support requires endpoint URL".to_string());
        }
    };

    // Store in active sessions
    let mut sessions = state.active_sessions.write().await;
    sessions.insert(session_id.clone(), vfs.clone());

    let mut configs = state.session_configs.write().await;
    configs.insert(session_id.clone(), config);

    // Register with MCP Server so AI agents can safely browse this session
    state
        .mcp_server
        .register_connection(session_id.clone(), vfs)
        .await;

    Ok(session_id)
}

#[tauri::command]
pub async fn disconnect_session(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    if session_id == "local" {
        return Err("Cannot disconnect local session".to_string());
    }
    let mut sessions = state.active_sessions.write().await;
    sessions.remove(&session_id);

    let mut configs = state.session_configs.write().await;
    configs.remove(&session_id);

    let _ = state.disk_cache.clear_session(&session_id).await;

    Ok(())
}

#[tauri::command]
pub async fn get_saved_sites(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ConnectionConfig>, String> {
    let sites = state.saved_sites.read().await;
    Ok(sites.clone())
}

#[tauri::command]
pub async fn save_site(
    state: tauri::State<'_, AppState>,
    config: ConnectionConfig,
) -> Result<(), String> {
    let mut sites = state.saved_sites.write().await;
    if let Some(pos) = sites.iter().position(|s| s.id == config.id) {
        sites[pos] = config;
    } else {
        sites.push(config);
    }
    rustscp_core::save_local_vault(&sites).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_site(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    let mut sites = state.saved_sites.write().await;
    sites.retain(|s| s.id != id);
    rustscp_core::save_local_vault(&sites).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn export_sites_vault(
    state: tauri::State<'_, AppState>,
    password: String,
) -> Result<String, String> {
    if password.trim().is_empty() {
        return Err("A senha para proteger o cofre não pode ser vazia.".to_string());
    }
    let sites = state.saved_sites.read().await;
    let exportable: Vec<_> = sites.iter().filter(|s| s.id != "local").cloned().collect();
    let envelope = rustscp_core::encrypt_sites(&exportable, password.trim())
        .map_err(|e| format!("Erro ao cifrar cofre: {e}"))?;
    let json = rustscp_core::serialize_vault_to_json(&envelope)
        .map_err(|e| format!("Erro ao gerar arquivo do cofre: {e}"))?;
    Ok(json)
}

#[tauri::command]
pub async fn import_sites_vault(
    state: tauri::State<'_, AppState>,
    vault_json: String,
    password: String,
    merge_mode: String,
) -> Result<Vec<ConnectionConfig>, String> {
    if password.trim().is_empty() {
        return Err("A senha do cofre é obrigatória para descriptografar os dados.".to_string());
    }
    let envelope = rustscp_core::parse_vault_from_json(vault_json.trim())
        .map_err(|e| format!("Arquivo de cofre inválido ou corrompido: {e}"))?;
    let imported_sites = rustscp_core::decrypt_sites(&envelope, password.trim())
        .map_err(|e| format!("Falha ao descriptografar: {e}"))?;

    let mut sites = state.saved_sites.write().await;
    let local_cfg = ConnectionConfig::local();

    if merge_mode == "replace" {
        let mut new_list = vec![local_cfg];
        for s in imported_sites {
            if s.id != "local" {
                new_list.push(s);
            }
        }
        *sites = new_list;
    } else {
        // Merge: adiciona ou atualiza pelo id ou host
        for s in imported_sites {
            if s.id == "local" {
                continue;
            }
            if let Some(pos) = sites.iter().position(|existing| existing.id == s.id) {
                sites[pos] = s;
            } else {
                sites.push(s);
            }
        }
    }

    rustscp_core::save_local_vault(&sites).map_err(|e| e.to_string())?;
    Ok(sites.clone())
}

#[tauri::command]
pub async fn get_vault_security_info(
    state: tauri::State<'_, AppState>,
) -> Result<rustscp_core::VaultSecurityInfo, String> {
    let sites = state.saved_sites.read().await;
    let vault_path = rustscp_core::get_local_vault_path();
    let is_encrypted = vault_path.exists();

    Ok(rustscp_core::VaultSecurityInfo {
        is_encrypted,
        cipher: "AES-256-GCM".to_string(),
        kdf: "PBKDF2-HMAC-SHA256".to_string(),
        kdf_iterations: rustscp_core::vault::DEFAULT_KDF_ITERATIONS,
        vault_path: vault_path.to_string_lossy().to_string(),
        site_count: sites.iter().filter(|s| s.id != "local").count(),
        has_custom_master_password: false,
    })
}

// ---------------------- FILE SYSTEM OPERATIONS ----------------------

#[tauri::command]
pub async fn list_directory(
    state: tauri::State<'_, AppState>,
    session_id: String,
    path: String,
    bypass_cache: Option<bool>,
) -> Result<Vec<FileEntry>, String> {
    let bypass = bypass_cache.unwrap_or(false);

    // Fast memory & catalog cache lookup (drastically accelerates remote SFTP/FTP/S3 directory browsing)
    if !bypass {
        if let Some(cached) = state.disk_cache.get_catalog(&session_id, &path).await {
            return Ok(cached);
        }
    }

    let sessions = state.active_sessions.read().await;
    let vfs = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    let entries = vfs.list_dir(&path).await.map_err(|e| e.to_string())?;

    // Cache the fresh entries in memory catalog for instant back/forward/up navigation
    state
        .disk_cache
        .put_catalog(&session_id, &path, entries.clone())
        .await;

    Ok(entries)
}

#[tauri::command]
pub async fn get_session_default_path(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<String, String> {
    let sessions = state.active_sessions.read().await;
    let vfs = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    vfs.get_default_path().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn read_file_content(
    state: tauri::State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<String, String> {
    let sessions = state.active_sessions.read().await;
    let vfs = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    let bytes = vfs.read_file(&path).await.map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

#[tauri::command]
pub async fn write_file_content(
    state: tauri::State<'_, AppState>,
    session_id: String,
    path: String,
    content: String,
) -> Result<(), String> {
    let sessions = state.active_sessions.read().await;
    let vfs = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    vfs.write_file(&path, bytes::Bytes::from(content.into_bytes()))
        .await
        .map_err(|e| e.to_string())?;

    state
        .disk_cache
        .invalidate_catalog(&session_id, &path)
        .await;
    Ok(())
}

#[tauri::command]
pub async fn create_new_directory(
    state: tauri::State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let sessions = state.active_sessions.read().await;
    let vfs = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    vfs.create_dir(&path).await.map_err(|e| e.to_string())?;

    state
        .disk_cache
        .invalidate_catalog(&session_id, &path)
        .await;
    Ok(())
}

#[tauri::command]
pub async fn delete_items(
    state: tauri::State<'_, AppState>,
    session_id: String,
    paths: Vec<String>,
) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }

    let sessions = state.active_sessions.read().await;
    let vfs = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    if session_id != "local" {
        // Quick delete on Linux remote:
        // Use `rm -rf -- 'path1' 'path2' ...` via SSH channel execution.
        // This is orders of magnitude faster than recursive SFTP traversals,
        // deleting even massive directories with tens of thousands of files in milliseconds.
        let quoted_paths: Vec<String> = paths
            .iter()
            .map(|p| {
                let trimmed = if p.len() > 1 && p.ends_with('/') {
                    p.trim_end_matches('/')
                } else {
                    p.as_str()
                };
                format!("'{}'", trimmed.replace('\'', "'\\''"))
            })
            .collect();

        let mut quick_delete_success = true;
        for chunk in quoted_paths.chunks(50) {
            let cmd = format!("rm -rf -- {}", chunk.join(" "));
            match vfs.execute_command(&cmd).await {
                Ok((exit_code, _stdout, stderr)) => {
                    if exit_code != 0 {
                        eprintln!(
                            "Quick delete rm -rf failed (exit code {}): {}",
                            exit_code, stderr
                        );
                        quick_delete_success = false;
                        break;
                    }
                }
                Err(e) => {
                    eprintln!("execute_command failed, falling back to VFS remove: {}", e);
                    quick_delete_success = false;
                    break;
                }
            }
        }

        if quick_delete_success {
            for path in &paths {
                state.disk_cache.invalidate_catalog(&session_id, path).await;
            }
            return Ok(());
        }

        // Fallback to VFS remove for remote sessions without shell execution or on quick delete failure
        for path in &paths {
            let trimmed = if path.len() > 1 && path.ends_with('/') {
                path.trim_end_matches('/')
            } else {
                path.as_str()
            };
            let is_directory = match vfs.metadata(trimmed).await {
                Ok(m) => m.is_dir(),
                Err(_) => false,
            };
            if is_directory {
                vfs.remove_dir(trimmed, true)
                    .await
                    .map_err(|e| e.to_string())?;
            } else {
                vfs.remove_file(trimmed).await.map_err(|e| e.to_string())?;
            }
            state
                .disk_cache
                .invalidate_catalog(&session_id, trimmed)
                .await;
        }
        return Ok(());
    }

    // Local file system deletion
    for path in &paths {
        let p = std::path::Path::new(path);
        match tokio::fs::symlink_metadata(p).await {
            Ok(meta) => {
                if meta.is_dir() {
                    tokio::fs::remove_dir_all(p)
                        .await
                        .map_err(|e| e.to_string())?;
                } else {
                    tokio::fs::remove_file(p).await.map_err(|e| e.to_string())?;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // already gone, ignore
            }
            Err(e) => {
                return Err(e.to_string());
            }
        }
        state.disk_cache.invalidate_catalog(&session_id, path).await;
    }

    Ok(())
}

#[tauri::command]
pub async fn delete_item(
    state: tauri::State<'_, AppState>,
    session_id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let _ = is_dir;
    delete_items(state, session_id, vec![path]).await
}

#[tauri::command]
pub async fn rename_item(
    state: tauri::State<'_, AppState>,
    session_id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let sessions = state.active_sessions.read().await;
    let vfs = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    vfs.rename(&from, &to).await.map_err(|e| e.to_string())?;

    state
        .disk_cache
        .invalidate_catalog(&session_id, &from)
        .await;
    state.disk_cache.invalidate_catalog(&session_id, &to).await;
    Ok(())
}

#[tauri::command]
pub async fn change_permissions(
    state: tauri::State<'_, AppState>,
    session_id: String,
    path: String,
    mode: u32,
) -> Result<(), String> {
    let sessions = state.active_sessions.read().await;
    let vfs = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    vfs.set_permissions(&path, mode)
        .await
        .map_err(|e| e.to_string())?;

    state
        .disk_cache
        .invalidate_catalog(&session_id, &path)
        .await;
    Ok(())
}

#[tauri::command]
pub async fn get_file_properties(
    state: tauri::State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<FileEntry, String> {
    let sessions = state.active_sessions.read().await;
    let vfs = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    vfs.metadata(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn calculate_checksum(
    state: tauri::State<'_, AppState>,
    session_id: String,
    path: String,
    algorithm: String,
) -> Result<ChecksumResult, String> {
    let sessions = state.active_sessions.read().await;
    let vfs = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    let data = vfs.read_file(&path).await.map_err(|e| e.to_string())?;

    let hash = match algorithm.to_uppercase().as_str() {
        "MD5" => {
            // Compute MD5
            format!("{:x}", md5::compute(&data))
        }
        _ => {
            // Default SHA-256
            hex::encode(Sha256::digest(&data))
        }
    };

    Ok(ChecksumResult { algorithm, hash })
}

// ---------------------- FILE TRANSFER & STREAMING ----------------------

#[tauri::command]
pub async fn transfer_file(
    state: tauri::State<'_, AppState>,
    source_session: String,
    source_path: String,
    dest_session: String,
    dest_path: String,
) -> Result<(), String> {
    let sessions = state.active_sessions.read().await;
    let src_vfs = sessions
        .get(&source_session)
        .ok_or_else(|| format!("Source session '{}' not found", source_session))?
        .clone();

    let dst_vfs = sessions
        .get(&dest_session)
        .ok_or_else(|| format!("Destination session '{}' not found", dest_session))?
        .clone();

    // Stream read from source, write to destination
    let data = src_vfs
        .read_file(&source_path)
        .await
        .map_err(|e| e.to_string())?;
    dst_vfs
        .write_file(&dest_path, data)
        .await
        .map_err(|e| e.to_string())?;

    state
        .disk_cache
        .invalidate_catalog(&dest_session, &dest_path)
        .await;

    Ok(())
}

// ---------------------- REMOTE COMMAND EXECUTION ----------------------

#[tauri::command]
pub async fn execute_remote_command(
    state: tauri::State<'_, AppState>,
    session_id: String,
    command: String,
) -> Result<CommandExecutionResult, String> {
    let sessions = state.active_sessions.read().await;
    let vfs = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    let (exit_code, stdout, stderr) = vfs
        .execute_command(&command)
        .await
        .map_err(|e| e.to_string())?;

    Ok(CommandExecutionResult {
        exit_code,
        stdout,
        stderr,
    })
}

// ---------------------- DIRECTORY SYNCHRONIZATION ----------------------

#[tauri::command]
pub async fn compare_and_sync_plan(
    state: tauri::State<'_, AppState>,
    local_session: String,
    local_dir: String,
    remote_session: String,
    remote_dir: String,
    options: SyncOptions,
) -> Result<Vec<SyncItem>, String> {
    let sessions = state.active_sessions.read().await;
    let local_vfs = sessions
        .get(&local_session)
        .ok_or_else(|| format!("Local session '{}' not found", local_session))?
        .clone();

    let remote_vfs = sessions
        .get(&remote_session)
        .ok_or_else(|| format!("Remote session '{}' not found", remote_session))?
        .clone();

    SyncEngine::compare_directories(local_vfs, remote_vfs, &local_dir, &remote_dir, &options)
        .await
        .map_err(|e| e.to_string())
}

// ---------------------- SMART ACTIONS & MCP ----------------------

#[tauri::command]
pub fn get_actions_catalog() -> Vec<ActionDefinition> {
    ActionCatalog::builtin_actions()
}

#[tauri::command]
pub fn render_action_command(
    action_id: String,
    current_dir: String,
    selected_paths: Vec<String>,
    params: HashMap<String, String>,
) -> Result<String, String> {
    let actions = ActionCatalog::builtin_actions();
    let action = actions
        .iter()
        .find(|a| a.id == action_id)
        .ok_or_else(|| format!("Action '{}' not found", action_id))?;

    let ctx = ActionContext::new(current_dir, selected_paths);
    ActionExecutor::render_command(action, &ctx, &params).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_mcp_audit_logs(
    state: tauri::State<'_, AppState>,
    limit: usize,
) -> Result<Vec<AuditEvent>, String> {
    Ok(state.audit_logger.get_recent_events(limit).await)
}

#[tauri::command]
pub async fn get_mcp_status(state: tauri::State<'_, AppState>) -> Result<McpStatusInfo, String> {
    let conns = state.active_sessions.read().await;
    let logs = state.audit_logger.get_recent_events(1000).await;
    Ok(McpStatusInfo {
        enabled: true,
        active_sessions_count: conns.len(),
        total_audit_events: logs.len(),
    })
}

// ---------------------- SCRIPT CONSOLE & AUTOMATION ----------------------

#[tauri::command]
pub async fn execute_script_line(
    state: tauri::State<'_, AppState>,
    session_id: String,
    line: String,
    mut local_dir: String,
    mut remote_dir: String,
) -> Result<ScriptCommandOutput, String> {
    let sessions = state.active_sessions.read().await;
    let local_vfs = state.local_vfs.clone();
    let remote_vfs = sessions.get(&session_id).cloned();
    drop(sessions);

    let output = ScriptInterpreter::execute_line(
        &line,
        local_vfs,
        remote_vfs,
        &mut local_dir,
        &mut remote_dir,
    )
    .await;

    Ok(output)
}

#[tauri::command]
pub async fn execute_script_batch(
    state: tauri::State<'_, AppState>,
    session_id: String,
    script: String,
    mut local_dir: String,
    mut remote_dir: String,
) -> Result<Vec<ScriptCommandOutput>, String> {
    let sessions = state.active_sessions.read().await;
    let local_vfs = state.local_vfs.clone();
    let remote_vfs = sessions.get(&session_id).cloned();
    drop(sessions);

    let mut outputs = Vec::new();
    for line in script.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let out = ScriptInterpreter::execute_line(
            line,
            local_vfs.clone(),
            remote_vfs.clone(),
            &mut local_dir,
            &mut remote_dir,
        )
        .await;
        let success = out.success;
        outputs.push(out);
        if !success {
            break;
        }
    }

    Ok(outputs)
}

#[tauri::command]
pub async fn generate_automation_code(
    state: tauri::State<'_, AppState>,
    session_id: String,
    target_language: String,
    remote_path: String,
    local_path: String,
) -> Result<String, String> {
    let configs = state.session_configs.read().await;
    let config = configs
        .get(&session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    let lang = match target_language.to_lowercase().as_str() {
        "url" | "session_url" | "winscp_url" => CodeTargetLanguage::WinScpUrl,
        "script" | "batch_script" | "winscp_script" => CodeTargetLanguage::WinScpScript,
        "curl" => CodeTargetLanguage::Curl,
        "python" => CodeTargetLanguage::Python,
        "rsync" | "bash" | "bash_rsync" => CodeTargetLanguage::BashRsync,
        "csharp" | "dotnet" | "dotnet_csharp" => CodeTargetLanguage::DotNetCSharp,
        _ => return Err(format!("Unsupported target language: {}", target_language)),
    };

    Ok(CodeGenerator::generate(
        config,
        lang,
        &remote_path,
        &local_path,
    ))
}

// ---------------------- ADVANCED SEARCH & FIND FILES (Shift+F7) ----------------------

#[tauri::command]
pub async fn find_files_advanced(
    state: tauri::State<'_, AppState>,
    session_id: String,
    query: FindFileQuery,
) -> Result<Vec<FindFileMatch>, String> {
    let sessions = state.active_sessions.read().await;
    let vfs = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    vfs.find_files(&query).await.map_err(|e| e.to_string())
}

// ---------------------- FILESYSTEM & SERVER INFO ----------------------

#[tauri::command]
pub async fn get_filesystem_info(
    state: tauri::State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<FileSystemInfo, String> {
    let sessions = state.active_sessions.read().await;
    let vfs = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    vfs.get_filesystem_info(&path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn calculate_directory_size(
    state: tauri::State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<u64, String> {
    let sessions = state.active_sessions.read().await;
    let vfs = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    vfs.calculate_size(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_symlink(
    state: tauri::State<'_, AppState>,
    session_id: String,
    link_path: String,
    target_path: String,
    is_symbolic: bool,
) -> Result<(), String> {
    let sessions = state.active_sessions.read().await;
    let vfs = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    vfs.create_symlink(&target_path, &link_path, is_symbolic)
        .await
        .map_err(|e| e.to_string())
}

// ---------------------- DUAL-PANE DIRECTORY COMPARISON (Shift+F2) ----------------------

#[tauri::command]
pub async fn compare_directories_fast(
    state: tauri::State<'_, AppState>,
    local_session: String,
    local_dir: String,
    remote_session: String,
    remote_dir: String,
    mode: String,
) -> Result<Vec<DirectoryDiffItem>, String> {
    let sessions = state.active_sessions.read().await;
    let local_vfs = sessions
        .get(&local_session)
        .ok_or_else(|| format!("Local session '{}' not found", local_session))?;
    let remote_vfs = sessions
        .get(&remote_session)
        .ok_or_else(|| format!("Remote session '{}' not found", remote_session))?;

    let local_items = local_vfs
        .list_dir(&local_dir)
        .await
        .map_err(|e| e.to_string())?;
    let remote_items = remote_vfs
        .list_dir(&remote_dir)
        .await
        .map_err(|e| e.to_string())?;

    let mut local_map: HashMap<String, FileEntry> = HashMap::new();
    for item in local_items {
        local_map.insert(item.name.clone(), item);
    }

    let mut remote_map: HashMap<String, FileEntry> = HashMap::new();
    for item in remote_items {
        remote_map.insert(item.name.clone(), item);
    }

    let mut all_names: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for k in local_map.keys() {
        all_names.insert(k.clone());
    }
    for k in remote_map.keys() {
        all_names.insert(k.clone());
    }

    let check_size = mode == "size" || mode == "both";
    let check_time = mode == "time" || mode == "both";

    let mut diffs = Vec::new();
    for name in all_names {
        let loc = local_map.get(&name);
        let rem = remote_map.get(&name);

        match (loc, rem) {
            (Some(l), None) => {
                diffs.push(DirectoryDiffItem {
                    name: name.clone(),
                    local_path: Some(l.path.clone()),
                    remote_path: None,
                    local_entry: Some(l.clone()),
                    remote_entry: None,
                    diff_type: DirectoryDiffType::MissingInRemote,
                });
            }
            (None, Some(r)) => {
                diffs.push(DirectoryDiffItem {
                    name: name.clone(),
                    local_path: None,
                    remote_path: Some(r.path.clone()),
                    local_entry: None,
                    remote_entry: Some(r.clone()),
                    diff_type: DirectoryDiffType::MissingInLocal,
                });
            }
            (Some(l), Some(r)) => {
                let mut diff_type = DirectoryDiffType::Identical;

                if check_size && l.size != r.size && l.is_file() && r.is_file() {
                    diff_type = DirectoryDiffType::DifferentSize;
                } else if check_time && l.modified_at != r.modified_at && l.is_file() && r.is_file()
                {
                    diff_type = DirectoryDiffType::DifferentTime;
                }

                diffs.push(DirectoryDiffItem {
                    name: name.clone(),
                    local_path: Some(l.path.clone()),
                    remote_path: Some(r.path.clone()),
                    local_entry: Some(l.clone()),
                    remote_entry: Some(r.clone()),
                    diff_type,
                });
            }
            (None, None) => {}
        }
    }

    Ok(diffs)
}

// ---------------------- CONTINUOUS SYNC (KEEP UP TO DATE) ----------------------

#[tauri::command]
pub async fn start_continuous_sync(
    state: tauri::State<'_, AppState>,
    local_path: String,
    remote_session: String,
    remote_path: String,
    _delete_remote: bool,
) -> Result<(), String> {
    if state.continuous_sync_active.load(Ordering::SeqCst) {
        return Ok(());
    }

    let (cancel_tx, mut cancel_rx) = broadcast::channel::<()>(1);
    {
        let mut cancel_guard = state.continuous_sync_cancel.lock().await;
        *cancel_guard = Some(cancel_tx.clone());
    }
    state.continuous_sync_active.store(true, Ordering::SeqCst);

    let (event_tx, mut event_rx) = tokio::sync::mpsc::channel(100);
    let mut watcher = rustscp_core::ContinuousSyncWatcher::new(&local_path, event_tx);
    watcher.start().map_err(|e| e.to_string())?;

    let sessions = state.active_sessions.clone();
    let is_active = state.continuous_sync_active.clone();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel_rx.recv() => {
                    watcher.stop();
                    break;
                }
                Some(evt) = event_rx.recv() => {
                    let guard = sessions.read().await;
                    if let Some(remote_vfs) = guard.get(&remote_session) {
                        let rel = evt.relative_path.replace('\\', "/");
                        let dest = format!("{}/{}", remote_path.trim_end_matches('/'), rel.trim_start_matches('/'));
                        if !evt.is_dir {
                            if let Ok(data) = tokio::fs::read(&evt.path).await {
                                let _ = remote_vfs.write_file(&dest, bytes::Bytes::from(data)).await;
                            }
                        } else {
                            let _ = remote_vfs.create_dir(&dest).await;
                        }
                    }
                }
            }
        }
        is_active.store(false, Ordering::SeqCst);
    });

    Ok(())
}

#[tauri::command]
pub async fn stop_continuous_sync(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut cancel_guard = state.continuous_sync_cancel.lock().await;
    if let Some(tx) = cancel_guard.take() {
        let _ = tx.send(());
    }
    state.continuous_sync_active.store(false, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn is_continuous_sync_running(state: tauri::State<'_, AppState>) -> bool {
    state.continuous_sync_active.load(Ordering::SeqCst)
}

// ---------------------- BOOKMARKS / FAVORITES ----------------------

#[tauri::command]
pub async fn get_bookmarks(state: tauri::State<'_, AppState>) -> Result<Vec<BookmarkItem>, String> {
    let bm = state.bookmarks.read().await;
    Ok(bm.clone())
}

#[tauri::command]
pub async fn add_bookmark(
    state: tauri::State<'_, AppState>,
    bookmark: BookmarkItem,
) -> Result<(), String> {
    let mut bm = state.bookmarks.write().await;
    bm.retain(|b| b.id != bookmark.id);
    bm.push(bookmark);
    Ok(())
}

#[tauri::command]
pub async fn delete_bookmark(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    let mut bm = state.bookmarks.write().await;
    bm.retain(|b| b.id != id);
    Ok(())
}

// ---------------------- FILE MASK FILTER TESTER ----------------------

#[tauri::command]
pub fn test_file_mask(mask: String, filename: String) -> bool {
    let filter = FileMaskFilter::new(&mask);
    filter.matches(&filename, false)
}

// ---------------------- VIRTUAL DISK / WEBDAV MOUNTING ----------------------

#[tauri::command]
pub async fn mount_virtual_disk(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<VirtualDiskInfo, String> {
    let sessions = state.active_sessions.read().await;
    let vfs = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?
        .clone();
    drop(sessions);

    let configs = state.session_configs.read().await;
    let (name, config_root) = configs
        .get(&session_id)
        .map(|c| (c.name.clone(), c.remote_root.clone()))
        .unwrap_or_else(|| (session_id.clone(), String::new()));
    drop(configs);

    // Mount strictly from the user's home / root directory
    let mount_root = if !config_root.trim().is_empty() && config_root != "/" {
        config_root
    } else {
        vfs.get_default_path()
            .await
            .unwrap_or_else(|_| "/".to_string())
    };

    let mut disks = state.virtual_disks.lock().await;
    if let Some(existing) = disks.get_mut(&session_id) {
        if existing.is_active() {
            return Ok(existing.info());
        }
    }

    let mut server = WebDavServer::new(
        session_id.clone(),
        name,
        mount_root,
        vfs,
        state.disk_cache.clone(),
    );
    server.mount_in_os().await.map_err(|e| e.to_string())?;
    let info = server.info();
    disks.insert(session_id, server);

    Ok(info)
}

#[tauri::command]
pub async fn unmount_virtual_disk(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let mut disks = state.virtual_disks.lock().await;
    if let Some(mut server) = disks.remove(&session_id) {
        server.unmount_and_stop().await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn get_virtual_disks_status(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<VirtualDiskInfo>, String> {
    let disks = state.virtual_disks.lock().await;
    let mut result = Vec::new();
    for (_, server) in disks.iter() {
        result.push(server.info());
    }
    Ok(result)
}

#[tauri::command]
pub async fn open_virtual_disk_folder(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<String, String> {
    let disks = state.virtual_disks.lock().await;
    let server = disks.get(&session_id).ok_or_else(|| {
        format!(
            "Disco virtual não encontrado para a conexão '{}'",
            session_id
        )
    })?;

    let mount_point = server
        .mount_point()
        .ok_or_else(|| "Disco virtual não possui ponto de montagem ativo no sistema".to_string())?
        .clone();
    drop(disks);

    #[cfg(target_os = "macos")]
    {
        tokio::process::Command::new("open")
            .arg(&mount_point)
            .spawn()
            .map_err(|e| format!("Falha ao abrir no Finder: {}", e))?;
        return Ok(format!("Aberto no Finder: {}", mount_point));
    }

    #[cfg(target_os = "windows")]
    {
        tokio::process::Command::new("explorer")
            .arg(&mount_point)
            .spawn()
            .map_err(|e| format!("Falha ao abrir no Windows Explorer: {}", e))?;
        return Ok(format!("Aberto no Windows Explorer: {}", mount_point));
    }

    #[cfg(target_os = "linux")]
    {
        tokio::process::Command::new("xdg-open")
            .arg(&mount_point)
            .spawn()
            .map_err(|e| format!("Falha ao abrir no gerenciador de arquivos: {}", e))?;
        return Ok(format!(
            "Aberto no Gerenciador de Arquivos: {}",
            mount_point
        ));
    }

    #[allow(unreachable_code)]
    Ok(format!("Ponto de montagem: {}", mount_point))
}

#[tauri::command]
pub async fn pick_key_file() -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(|| -> Result<Option<String>, String> {
        #[cfg(target_os = "macos")]
        {
            let script = r#"
            try
                set keyFile to choose file invisibles true with prompt "Selecione o arquivo de chave privada SSH ou certificado"
                return POSIX path of keyFile
            on error
                return ""
            end try
            "#;
            let output = std::process::Command::new("osascript")
                .arg("-e")
                .arg(script)
                .output()
                .map_err(|e| format!("Falha ao abrir seletor de arquivos nativo: {}", e))?;

            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if path.is_empty() {
                    Ok(None)
                } else {
                    Ok(Some(path))
                }
            } else {
                Ok(None)
            }
        }

        #[cfg(target_os = "windows")]
        {
            let script = r#"
            Add-Type -AssemblyName System.Windows.Forms
            $f = New-Object System.Windows.Forms.OpenFileDialog
            $f.Title = "Selecione a Chave Privada (SSH) ou Certificado"
            $f.Filter = "Todos os Arquivos (*.*)|*.*|Chaves Privadas (*.pem;*.key;*.id_*)|*.pem;*.key;*.id_*"
            if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
                Write-Output $f.FileName
            }
            "#;
            let output = std::process::Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", script])
                .output()
                .map_err(|e| format!("Falha ao abrir seletor de arquivos nativo: {}", e))?;

            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if path.is_empty() {
                    Ok(None)
                } else {
                    Ok(Some(path))
                }
            } else {
                Ok(None)
            }
        }

        #[cfg(target_os = "linux")]
        {
            let output = std::process::Command::new("zenity")
                .args(["--file-selection", "--title=Selecione a Chave Privada (SSH) ou Certificado"])
                .output();

            if let Ok(out) = output {
                if out.status.success() {
                    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if !path.is_empty() {
                        return Ok(Some(path));
                    }
                }
            }
            Ok(None)
        }

        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        {
            Ok(None)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------- LOCAL DISK & SHADOW CATALOG CACHE ----------------------

#[tauri::command]
pub async fn get_cache_stats(state: tauri::State<'_, AppState>) -> Result<CacheStats, String> {
    let configs = state.session_configs.read().await;
    let mut session_names = HashMap::new();
    for (id, cfg) in configs.iter() {
        session_names.insert(id.clone(), cfg.name.clone());
    }
    drop(configs);
    Ok(state.disk_cache.get_stats(&session_names).await)
}

#[tauri::command]
pub async fn clear_site_cache(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    state
        .disk_cache
        .clear_session(&session_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn clear_all_cache(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state
        .disk_cache
        .clear_all()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_max_cache_size(
    state: tauri::State<'_, AppState>,
    max_bytes: u64,
) -> Result<(), String> {
    state.disk_cache.set_max_size(max_bytes).await;
    Ok(())
}

// ---------------------- BACKGROUND ASYNC TRANSFER QUEUE ----------------------

#[tauri::command]
pub async fn enqueue_transfer(
    state: tauri::State<'_, AppState>,
    source_session: String,
    source_path: String,
    dest_session: String,
    dest_path: String,
    is_move: bool,
) -> Result<String, String> {
    let task_id = state
        .transfer_queue
        .enqueue(
            source_session,
            source_path,
            dest_session,
            dest_path,
            is_move,
            state.active_sessions.clone(),
        )
        .await;

    Ok(task_id)
}

#[tauri::command]
pub async fn get_transfer_queue_tasks(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<QueueTransferTask>, String> {
    Ok(state.transfer_queue.get_tasks().await)
}

#[tauri::command]
pub async fn cancel_transfer_task(
    state: tauri::State<'_, AppState>,
    task_id: String,
) -> Result<(), String> {
    state.transfer_queue.cancel_task(&task_id).await;
    Ok(())
}

#[tauri::command]
pub async fn clear_completed_transfers(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.transfer_queue.clear_completed().await;
    Ok(())
}

// ---------------------- COMPRESSION & EXTRACTION (ZIP / TAR / GZIP) ----------------------

#[tauri::command]
pub async fn compress_items(
    state: tauri::State<'_, AppState>,
    session_id: String,
    current_dir: String,
    items: Vec<String>,
    format: String,
    output_name: String,
) -> Result<String, String> {
    let sessions = state.active_sessions.read().await;
    let vfs = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    let items_escaped = items
        .iter()
        .map(|s| {
            let base = s
                .split('/')
                .next_back()
                .or_else(|| s.split('\\').next_back())
                .unwrap_or(s);
            format!("'{}'", base.replace('\'', "'\\''"))
        })
        .collect::<Vec<_>>()
        .join(" ");

    let clean_output = if output_name.is_empty() {
        match format.as_str() {
            "zip" => "archive.zip",
            "tar.bz2" | "tbz2" => "archive.tar.bz2",
            "tar.xz" | "txz" => "archive.tar.xz",
            "tar" => "archive.tar",
            _ => "archive.tar.gz",
        }
    } else {
        &output_name
    };

    if vfs.protocol() == Protocol::Local {
        #[cfg(target_os = "windows")]
        {
            let win_cmd = match format.as_str() {
                "zip" => {
                    let items_list = items
                        .iter()
                        .map(|s| format!("'{}'", s))
                        .collect::<Vec<_>>()
                        .join(", ");
                    format!("powershell -NoProfile -Command \"Compress-Archive -Path {} -DestinationPath '{}' -Force\"", items_list, clean_output)
                }
                _ => {
                    format!(
                        "tar -caf \"{}\" {}",
                        clean_output,
                        items_escaped.replace('\'', "\"")
                    )
                }
            };
            let (code, stdout, stderr) = vfs
                .execute_command(&win_cmd)
                .await
                .map_err(|e| e.to_string())?;
            if code != 0 && !stderr.trim().is_empty() {
                return Err(format!("Compression failed: {}", stderr));
            }
            return Ok(if stdout.is_empty() {
                format!("Archive '{}' created successfully", clean_output)
            } else {
                stdout
            });
        }

        #[cfg(not(target_os = "windows"))]
        {
            let cmd = match format.as_str() {
                "zip" => format!(
                    "cd '{}' && (which zip >/dev/null 2>&1 && zip -r '{}' {} || python3 -c \"import zipfile, os, sys; z = zipfile.ZipFile('{}', 'w', zipfile.ZIP_DEFLATED); [z.write(f) for f in sys.argv[1:]]\" {})",
                    current_dir.replace('\'', "'\\''"), clean_output, items_escaped, clean_output, items_escaped
                ),
                "tar.bz2" | "tbz2" => format!("cd '{}' && tar -cjf '{}' {}", current_dir.replace('\'', "'\\''"), clean_output, items_escaped),
                "tar.xz" | "txz" => format!("cd '{}' && (tar -cJf '{}' {} || tar -cf - {} | xz > '{}')", current_dir.replace('\'', "'\\''"), clean_output, items_escaped, items_escaped, clean_output),
                "tar" => format!("cd '{}' && tar -cf '{}' {}", current_dir.replace('\'', "'\\''"), clean_output, items_escaped),
                _ => format!(
                    "cd '{}' && (which pigz >/dev/null 2>&1 && tar -cf - {} | pigz > '{}' || tar -czf '{}' {})",
                    current_dir.replace('\'', "'\\''"), items_escaped, clean_output, clean_output, items_escaped
                ),
            };
            let (code, stdout, stderr) =
                vfs.execute_command(&cmd).await.map_err(|e| e.to_string())?;
            if code != 0 && !stderr.trim().is_empty() {
                return Err(format!("Compression failed: {}", stderr));
            }
            return Ok(if stdout.is_empty() {
                format!("Archive '{}' created successfully", clean_output)
            } else {
                stdout
            });
        }
    }

    // Remote SFTP execution
    let cmd = match format.as_str() {
        "zip" => format!(
            "cd '{}' && (which zip >/dev/null 2>&1 && zip -r '{}' {} || python3 -c \"import zipfile, os, sys; z = zipfile.ZipFile('{}', 'w', zipfile.ZIP_DEFLATED); [z.write(f) for f in sys.argv[1:]]\" {} || (echo 'zip utility not installed' >&2 && exit 1))",
            current_dir.replace('\'', "'\\''"), clean_output, items_escaped, clean_output, items_escaped
        ),
        "tar.bz2" | "tbz2" => format!("cd '{}' && tar -cjf '{}' {}", current_dir.replace('\'', "'\\''"), clean_output, items_escaped),
        "tar.xz" | "txz" => format!("cd '{}' && (tar -cJf '{}' {} || tar -cf - {} | xz > '{}')", current_dir.replace('\'', "'\\''"), clean_output, items_escaped, items_escaped, clean_output),
        "tar" => format!("cd '{}' && tar -cf '{}' {}", current_dir.replace('\'', "'\\''"), clean_output, items_escaped),
        _ => format!(
            "cd '{}' && (which pigz >/dev/null 2>&1 && tar -cf - {} | pigz > '{}' || tar -czf '{}' {})",
            current_dir.replace('\'', "'\\''"), items_escaped, clean_output, clean_output, items_escaped
        ),
    };

    let (code, stdout, stderr) = vfs.execute_command(&cmd).await.map_err(|e| e.to_string())?;
    if code != 0 && !stderr.trim().is_empty() {
        return Err(format!("Compression failed: {}", stderr));
    }
    state
        .disk_cache
        .invalidate_catalog(&session_id, &current_dir)
        .await;
    Ok(if stdout.is_empty() {
        format!("Archive '{}' created successfully", clean_output)
    } else {
        stdout
    })
}

#[tauri::command]
pub async fn extract_archive(
    state: tauri::State<'_, AppState>,
    session_id: String,
    current_dir: String,
    archive_path: String,
    dest_subfolder: Option<String>,
) -> Result<String, String> {
    let sessions = state.active_sessions.read().await;
    let vfs = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    let target_dest = if let Some(sub) = dest_subfolder {
        if sub.trim().is_empty() || sub == "." {
            current_dir.clone()
        } else {
            format!(
                "{}/{}",
                current_dir.trim_end_matches('/'),
                sub.trim().trim_matches('/')
            )
        }
    } else {
        current_dir.clone()
    };

    let is_zip = archive_path.ends_with(".zip");
    let is_bz2 = archive_path.ends_with(".tar.bz2")
        || archive_path.ends_with(".tbz2")
        || archive_path.ends_with(".bz2");
    let is_xz = archive_path.ends_with(".tar.xz")
        || archive_path.ends_with(".txz")
        || archive_path.ends_with(".xz");
    let is_tar = archive_path.ends_with(".tar");

    if vfs.protocol() == Protocol::Local {
        #[cfg(target_os = "windows")]
        {
            let win_cmd = if is_zip {
                format!("powershell -NoProfile -Command \"Expand-Archive -Path '{}' -DestinationPath '{}' -Force\"", archive_path, target_dest)
            } else {
                format!(
                    "mkdir \"{}\" 2>nul & tar -xvf \"{}\" -C \"{}\"",
                    target_dest, archive_path, target_dest
                )
            };
            let (code, stdout, stderr) = vfs
                .execute_command(&win_cmd)
                .await
                .map_err(|e| e.to_string())?;
            if code != 0 && !stderr.trim().is_empty() {
                return Err(format!("Extraction failed: {}", stderr));
            }
            state
                .disk_cache
                .invalidate_catalog(&session_id, &target_dest)
                .await;
            state
                .disk_cache
                .invalidate_catalog(&session_id, &current_dir)
                .await;
            return Ok(if stdout.is_empty() {
                "Extracted successfully".to_string()
            } else {
                stdout
            });
        }

        #[cfg(not(target_os = "windows"))]
        {
            let cmd = if is_zip {
                format!(
                    "mkdir -p '{}' && (which unzip >/dev/null 2>&1 && unzip -o '{}' -d '{}' || python3 -m zipfile -e '{}' '{}')",
                    target_dest.replace('\'', "'\\''"), archive_path.replace('\'', "'\\''"), target_dest.replace('\'', "'\\'"),
                    archive_path.replace('\'', "'\\''"), target_dest.replace('\'', "'\\'")
                )
            } else if is_bz2 {
                format!(
                    "mkdir -p '{}' && tar -xjf '{}' -C '{}'",
                    target_dest.replace('\'', "'\\''"),
                    archive_path.replace('\'', "'\\''"),
                    target_dest.replace('\'', "'\\'")
                )
            } else if is_xz {
                format!(
                    "mkdir -p '{}' && (tar -xJf '{}' -C '{}' || tar -xf '{}' -C '{}')",
                    target_dest.replace('\'', "'\\''"),
                    archive_path.replace('\'', "'\\''"),
                    target_dest.replace('\'', "'\\'"),
                    archive_path.replace('\'', "'\\''"),
                    target_dest.replace('\'', "'\\'")
                )
            } else if is_tar {
                format!(
                    "mkdir -p '{}' && tar -xf '{}' -C '{}'",
                    target_dest.replace('\'', "'\\''"),
                    archive_path.replace('\'', "'\\''"),
                    target_dest.replace('\'', "'\\'")
                )
            } else {
                format!(
                    "mkdir -p '{}' && (which pigz >/dev/null 2>&1 && pigz -dc '{}' | tar -xf - -C '{}' || tar -xzf '{}' -C '{}')",
                    target_dest.replace('\'', "'\\''"), archive_path.replace('\'', "'\\''"), target_dest.replace('\'', "'\\'"),
                    archive_path.replace('\'', "'\\''"), target_dest.replace('\'', "'\\'")
                )
            };
            let (code, stdout, stderr) =
                vfs.execute_command(&cmd).await.map_err(|e| e.to_string())?;
            if code != 0 && !stderr.trim().is_empty() {
                return Err(format!("Extraction failed: {}", stderr));
            }
            state
                .disk_cache
                .invalidate_catalog(&session_id, &target_dest)
                .await;
            state
                .disk_cache
                .invalidate_catalog(&session_id, &current_dir)
                .await;
            return Ok(if stdout.is_empty() {
                "Extracted successfully".to_string()
            } else {
                stdout
            });
        }
    }

    // Remote extraction
    let cmd = if is_zip {
        format!(
            "mkdir -p '{}' && (which unzip >/dev/null 2>&1 && unzip -o '{}' -d '{}' || python3 -m zipfile -e '{}' '{}' || busybox unzip -o '{}' -d '{}')",
            target_dest.replace('\'', "'\\''"), archive_path.replace('\'', "'\\''"), target_dest.replace('\'', "'\\'"),
            archive_path.replace('\'', "'\\''"), target_dest.replace('\'', "'\\'"),
            archive_path.replace('\'', "'\\''"), target_dest.replace('\'', "'\\'")
        )
    } else if is_bz2 {
        format!(
            "mkdir -p '{}' && tar -xjf '{}' -C '{}'",
            target_dest.replace('\'', "'\\''"),
            archive_path.replace('\'', "'\\''"),
            target_dest.replace('\'', "'\\'")
        )
    } else if is_xz {
        format!(
            "mkdir -p '{}' && (tar -xJf '{}' -C '{}' || tar -xf '{}' -C '{}')",
            target_dest.replace('\'', "'\\''"),
            archive_path.replace('\'', "'\\''"),
            target_dest.replace('\'', "'\\'"),
            archive_path.replace('\'', "'\\''"),
            target_dest.replace('\'', "'\\'")
        )
    } else if is_tar {
        format!(
            "mkdir -p '{}' && tar -xf '{}' -C '{}'",
            target_dest.replace('\'', "'\\''"),
            archive_path.replace('\'', "'\\''"),
            target_dest.replace('\'', "'\\'")
        )
    } else {
        format!(
            "mkdir -p '{}' && (which pigz >/dev/null 2>&1 && pigz -dc '{}' | tar -xf - -C '{}' || tar -xzf '{}' -C '{}')",
            target_dest.replace('\'', "'\\''"), archive_path.replace('\'', "'\\''"), target_dest.replace('\'', "'\\'"),
            archive_path.replace('\'', "'\\''"), target_dest.replace('\'', "'\\'")
        )
    };

    let (code, stdout, stderr) = vfs.execute_command(&cmd).await.map_err(|e| e.to_string())?;
    if code != 0 && !stderr.trim().is_empty() {
        return Err(format!("Extraction failed: {}", stderr));
    }
    state
        .disk_cache
        .invalidate_catalog(&session_id, &target_dest)
        .await;
    state
        .disk_cache
        .invalidate_catalog(&session_id, &current_dir)
        .await;
    Ok(if stdout.is_empty() {
        "Extracted successfully".to_string()
    } else {
        stdout
    })
}

#[tauri::command]
pub async fn duplicate_item(
    state: tauri::State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<String, String> {
    let sessions = state.active_sessions.read().await;
    let vfs = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    let meta = vfs.metadata(&path).await.map_err(|e| e.to_string())?;
    let new_path = if meta.is_dir() {
        format!("{}_copy", path.trim_end_matches('/'))
    } else if let Some(idx) = path.rfind('.') {
        format!("{}_copy{}", &path[..idx], &path[idx..])
    } else {
        format!("{}_copy", path)
    };

    if meta.is_dir() {
        let cmd = format!(
            "cp -r '{}' '{}'",
            path.replace('\'', "'\\''"),
            new_path.replace('\'', "'\\'")
        );
        let _ = vfs.execute_command(&cmd).await.map_err(|e| e.to_string())?;
    } else {
        let data = vfs.read_file(&path).await.map_err(|e| e.to_string())?;
        vfs.write_file(&new_path, data)
            .await
            .map_err(|e| e.to_string())?;
    }

    state
        .disk_cache
        .invalidate_catalog(&session_id, &path)
        .await;
    state
        .disk_cache
        .invalidate_catalog(&session_id, &new_path)
        .await;

    Ok(new_path)
}

// ---------------------- REMOTE OS & TERMINAL COMMANDS ----------------------

#[tauri::command]
pub async fn detect_remote_system(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<RemoteSystemInfo, String> {
    let sessions = state.active_sessions.read().await;
    let vfs = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    if vfs.protocol() != Protocol::Sftp {
        let os = std::env::consts::OS.to_string();
        let arch = std::env::consts::ARCH.to_string();
        return Ok(RemoteSystemInfo {
            os_name: format!("{} ({})", os, arch),
            distro_id: os,
            kernel: std::env::consts::FAMILY.to_string(),
            default_shell: std::env::var("SHELL").unwrap_or_else(|_| "sh".to_string()),
            package_manager: if cfg!(target_os = "macos") {
                "brew".to_string()
            } else if cfg!(target_os = "windows") {
                "winget".to_string()
            } else {
                "apt".to_string()
            },
            is_root: false,
            has_sudo: true,
            hostname: "localhost".to_string(),
            architecture: arch,
        });
    }

    let configs = state.session_configs.read().await;
    if let Some(cfg) = configs.get(&session_id) {
        let driver = SftpDriver::new(cfg.clone());
        driver.connect().await.map_err(|e| e.to_string())?;
        return driver
            .detect_os_and_shell()
            .await
            .map_err(|e| e.to_string());
    }

    Err(format!(
        "Could not inspect system for session '{}'",
        session_id
    ))
}

#[tauri::command]
pub async fn open_native_terminal(
    state: tauri::State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<String, String> {
    let sessions = state.active_sessions.read().await;
    let vfs = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    let is_remote = vfs.protocol() == Protocol::Sftp;
    let target_path = if path.trim().is_empty() {
        "~".to_string()
    } else {
        path
    };

    if !is_remote {
        #[cfg(target_os = "macos")]
        {
            tokio::process::Command::new("open")
                .arg("-a")
                .arg("Terminal")
                .arg(&target_path)
                .spawn()
                .map_err(|e| e.to_string())?;
            return Ok("Opened macOS Terminal.app".to_string());
        }

        #[cfg(target_os = "windows")]
        {
            let _ = tokio::process::Command::new("wt.exe")
                .arg("-d")
                .arg(&target_path)
                .spawn()
                .or_else(|_| {
                    tokio::process::Command::new("cmd.exe")
                        .arg("/K")
                        .arg(format!("cd /d \"{}\"", target_path))
                        .spawn()
                })
                .map_err(|e| e.to_string())?;
            return Ok("Opened Windows Terminal".to_string());
        }

        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            for term in &[
                "x-terminal-emulator",
                "gnome-terminal",
                "konsole",
                "alacritty",
                "kitty",
                "xfce4-terminal",
            ] {
                if tokio::process::Command::new(term)
                    .arg(format!("--working-directory={}", target_path))
                    .spawn()
                    .is_ok()
                {
                    return Ok(format!("Opened {}", term));
                }
            }
            return Err("No supported terminal emulator found".to_string());
        }
    }

    // Remote SSH session
    let configs = state.session_configs.read().await;
    let cfg = configs
        .get(&session_id)
        .ok_or_else(|| format!("Session config for '{}' not found", session_id))?;

    let port_arg = format!("-p {}", if cfg.port == 0 { 22 } else { cfg.port });
    let user_host = format!("{}@{}", cfg.username, cfg.host);

    let key_arg = match &cfg.auth {
        rustscp_core::AuthMethod::PrivateKey { path, .. } => format!("-i \"{}\"", path),
        _ => String::new(),
    };

    let remote_cd = format!(
        "cd '{}' 2>/dev/null || cd; exec bash -l || exec sh -l",
        target_path.replace('\'', "'\\''")
    );
    let ssh_full_cmd = format!(
        "ssh {} {} {} -t \"{}\"",
        port_arg, key_arg, user_host, remote_cd
    );

    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "tell application \"Terminal\"\n  activate\n  do script \"{}\"\nend tell",
            ssh_full_cmd.replace('\\', "\\\\").replace('"', "\\\"")
        );
        tokio::process::Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok("Opened SSH in macOS Terminal.app".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        let _ = tokio::process::Command::new("wt.exe")
            .arg("ssh")
            .arg(port_arg)
            .arg(&user_host)
            .spawn()
            .or_else(|_| {
                tokio::process::Command::new("cmd.exe")
                    .arg("/K")
                    .arg(&ssh_full_cmd)
                    .spawn()
            })
            .map_err(|e| e.to_string())?;
        return Ok("Opened SSH in Windows Terminal".to_string());
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        for term in &[
            "x-terminal-emulator",
            "gnome-terminal",
            "konsole",
            "alacritty",
            "kitty",
            "xfce4-terminal",
        ] {
            if tokio::process::Command::new(term)
                .arg("-e")
                .arg(&ssh_full_cmd)
                .spawn()
                .is_ok()
            {
                return Ok(format!("Opened SSH in {}", term));
            }
        }
        return Err("No supported terminal emulator found".to_string());
    }
}

// ---------------------- REMOTE TRASH MANAGEMENT ----------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteTrashResponse {
    pub status: RemoteTrashStatus,
    pub items: Vec<RemoteTrashItem>,
    pub message: String,
}

#[tauri::command]
pub async fn manage_remote_trash(
    state: tauri::State<'_, AppState>,
    session_id: String,
    action: String,
    target_path: Option<String>,
    payload: Option<String>,
) -> Result<RemoteTrashResponse, String> {
    let sessions = state.active_sessions.read().await;
    let vfs = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    let default_trash_dir = "~/.local/share/Trash";

    match action.as_str() {
        "setup" => {
            let script = r#"
mkdir -p ~/.local/share/Trash/files ~/.local/share/Trash/info 2>/dev/null
chmod 700 ~/.local/share/Trash ~/.local/share/Trash/files ~/.local/share/Trash/info 2>/dev/null
echo "READY"
"#;
            let (code, _, stderr) = vfs
                .execute_command(script)
                .await
                .map_err(|e| e.to_string())?;
            if code != 0 {
                return Err(format!("Setup failed: {}", stderr));
            }
            Ok(RemoteTrashResponse {
                status: RemoteTrashStatus {
                    enabled: true,
                    initialized: true,
                    trash_dir: default_trash_dir.to_string(),
                    item_count: 0,
                    total_size_bytes: 0,
                },
                items: Vec::new(),
                message: "Lixeira remota criada com sucesso em ~/.local/share/Trash".to_string(),
            })
        }
        "move_to_trash" => {
            let paths_to_trash: Vec<String> = if let Some(pl) = payload {
                if pl.trim_start().starts_with('[') {
                    serde_json::from_str(&pl).unwrap_or_else(|_| vec![pl])
                } else {
                    vec![pl]
                }
            } else if let Some(tp) = target_path {
                if tp.trim_start().starts_with('[') {
                    serde_json::from_str(&tp).unwrap_or_else(|_| vec![tp])
                } else {
                    vec![tp]
                }
            } else {
                return Err("Target path or payload required for move_to_trash".to_string());
            };

            for path in &paths_to_trash {
                let filename = path.split('/').next_back().unwrap_or(path).to_string();
                let timestamp = chrono::Utc::now()
                    .timestamp_nanos_opt()
                    .unwrap_or_else(|| chrono::Utc::now().timestamp() * 1_000_000_000);
                let trash_filename = format!("{}_{}", timestamp, filename);
                let now_iso = chrono::Utc::now().to_rfc3339();

                let script = format!(
                    r#"
mkdir -p ~/.local/share/Trash/files ~/.local/share/Trash/info 2>/dev/null
mv '{}' ~/.local/share/Trash/files/'{}' && \
cat << 'EOF' > ~/.local/share/Trash/info/'{}'.trashinfo
[Trash Info]
Path={}
DeletionDate={}
EOF
echo "OK"
"#,
                    path.replace('\'', "'\\''"),
                    trash_filename.replace('\'', "'\\''"),
                    trash_filename.replace('\'', "'\\''"),
                    path,
                    now_iso
                );

                let (code, _, stderr) = vfs
                    .execute_command(&script)
                    .await
                    .map_err(|e| e.to_string())?;
                if code != 0 {
                    return Err(format!(
                        "Falha ao mover '{}' para lixeira: {}",
                        filename, stderr
                    ));
                }

                state.disk_cache.invalidate_catalog(&session_id, path).await;
            }

            Ok(RemoteTrashResponse {
                status: RemoteTrashStatus {
                    enabled: true,
                    initialized: true,
                    trash_dir: default_trash_dir.to_string(),
                    item_count: paths_to_trash.len(),
                    total_size_bytes: 0,
                },
                items: Vec::new(),
                message: format!(
                    "{} item(ns) movido(s) para a lixeira remota",
                    paths_to_trash.len()
                ),
            })
        }
        "list" | "status" => {
            let script = r#"
if [ ! -d ~/.local/share/Trash/files ]; then
    echo "NOT_INITIALIZED"
    exit 0
fi
echo "---COUNT---"
ls -1 ~/.local/share/Trash/files 2>/dev/null | wc -l
echo "---SIZE---"
du -sb ~/.local/share/Trash/files 2>/dev/null | cut -f1 || echo 0
echo "---FILES---"
for info in ~/.local/share/Trash/info/*.trashinfo; do
    if [ -f "$info" ]; then
        base=$(basename "$info" .trashinfo)
        orig=$(grep '^Path=' "$info" | cut -d= -f2-)
        date=$(grep '^DeletionDate=' "$info" | cut -d= -f2-)
        filesize=$(stat -c%s ~/.local/share/Trash/files/"$base" 2>/dev/null || stat -f%z ~/.local/share/Trash/files/"$base" 2>/dev/null || echo 0)
        is_dir=0
        if [ -d ~/.local/share/Trash/files/"$base" ]; then is_dir=1; fi
        echo "$base|$orig|$date|$filesize|$is_dir"
    fi
done
"#;
            let (_, stdout, _) = vfs
                .execute_command(script)
                .await
                .map_err(|e| e.to_string())?;
            if stdout.contains("NOT_INITIALIZED") {
                return Ok(RemoteTrashResponse {
                    status: RemoteTrashStatus {
                        enabled: false,
                        initialized: false,
                        trash_dir: default_trash_dir.to_string(),
                        item_count: 0,
                        total_size_bytes: 0,
                    },
                    items: Vec::new(),
                    message: "Lixeira ainda não inicializada no servidor".to_string(),
                });
            }

            let mut count: usize = 0;
            let mut total_size: u64 = 0;
            let mut items = Vec::new();
            let mut section = "";

            for line in stdout.lines() {
                let line = line.trim();
                if line.starts_with("---") && line.ends_with("---") {
                    section = line;
                    continue;
                }
                match section {
                    "---COUNT---" => {
                        count = line.parse().unwrap_or(0);
                    }
                    "---SIZE---" => {
                        total_size = line.parse().unwrap_or(0);
                    }
                    "---FILES---" => {
                        let parts: Vec<&str> = line.split('|').collect();
                        if parts.len() >= 5 {
                            items.push(RemoteTrashItem {
                                id: parts[0].to_string(),
                                filename: parts[0].to_string(),
                                trash_path: format!("~/.local/share/Trash/files/{}", parts[0]),
                                original_path: parts[1].to_string(),
                                deletion_date: parts[2].to_string(),
                                size: parts[3].parse().unwrap_or(0),
                                is_dir: parts[4] == "1",
                            });
                        }
                    }
                    _ => {}
                }
            }

            Ok(RemoteTrashResponse {
                status: RemoteTrashStatus {
                    enabled: true,
                    initialized: true,
                    trash_dir: default_trash_dir.to_string(),
                    item_count: count,
                    total_size_bytes: total_size,
                },
                items,
                message: "Status da lixeira obtido".to_string(),
            })
        }
        "restore" => {
            let item_id = target_path
                .or(payload)
                .ok_or_else(|| "Item id required for restore".to_string())?;
            let script = format!(
                r#"
info_file=~/.local/share/Trash/info/'{}'.trashinfo
trash_file=~/.local/share/Trash/files/'{}'
if [ ! -f "$info_file" ] || [ ! -e "$trash_file" ]; then
    echo "Item not found" >&2
    exit 1
fi
orig=$(grep '^Path=' "$info_file" | cut -d= -f2-)
orig_dir=$(dirname "$orig")
mkdir -p "$orig_dir" 2>/dev/null
mv "$trash_file" "$orig" && rm -f "$info_file"
echo "RESTORED:$orig"
"#,
                item_id.replace('\'', "'\\''"),
                item_id.replace('\'', "'\\''")
            );
            let (code, stdout, stderr) = vfs
                .execute_command(&script)
                .await
                .map_err(|e| e.to_string())?;
            if code != 0 {
                return Err(format!("Restore failed: {}", stderr));
            }
            for line in stdout.lines() {
                if let Some(restored_path) = line.strip_prefix("RESTORED:") {
                    state
                        .disk_cache
                        .invalidate_catalog(&session_id, restored_path.trim())
                        .await;
                }
            }
            state
                .disk_cache
                .invalidate_catalog(&session_id, "~/.local/share/Trash/files")
                .await;
            Ok(RemoteTrashResponse {
                status: RemoteTrashStatus {
                    enabled: true,
                    initialized: true,
                    trash_dir: default_trash_dir.to_string(),
                    item_count: 0,
                    total_size_bytes: 0,
                },
                items: Vec::new(),
                message: "Item restaurado com sucesso para a localização original".to_string(),
            })
        }
        "empty" => {
            let script = r#"
rm -rf ~/.local/share/Trash/files/* ~/.local/share/Trash/info/* 2>/dev/null
echo "EMPTIED"
"#;
            let (code, _, stderr) = vfs
                .execute_command(script)
                .await
                .map_err(|e| e.to_string())?;
            if code != 0 {
                return Err(format!("Empty trash failed: {}", stderr));
            }
            state
                .disk_cache
                .invalidate_catalog(&session_id, "~/.local/share/Trash/files")
                .await;
            Ok(RemoteTrashResponse {
                status: RemoteTrashStatus {
                    enabled: true,
                    initialized: true,
                    trash_dir: default_trash_dir.to_string(),
                    item_count: 0,
                    total_size_bytes: 0,
                },
                items: Vec::new(),
                message: "Lixeira remota esvaziada permanentemente".to_string(),
            })
        }
        other => Err(format!("Unknown trash action '{}'", other)),
    }
}

// ---------------------- SYSADMIN MARKETPLACE & TOOLS ----------------------

#[tauri::command]
pub async fn install_marketplace_tool(
    state: tauri::State<'_, AppState>,
    session_id: String,
    tool_id: String,
) -> Result<CommandExecutionResult, String> {
    let sessions = state.active_sessions.read().await;
    let vfs = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session '{}' not found", session_id))?;

    let install_cmd = match tool_id.as_str() {
        "ncdu" => "if command -v apt-get >/dev/null 2>&1; then sudo -n apt-get update && sudo -n apt-get install -y ncdu || apt-get install -y ncdu; elif command -v apk >/dev/null 2>&1; then apk add ncdu; elif command -v dnf >/dev/null 2>&1; then dnf install -y ncdu; elif command -v pacman >/dev/null 2>&1; then pacman -S --noconfirm ncdu; else echo 'No package manager found' >&2; exit 1; fi",
        "dust" => "if command -v pacman >/dev/null 2>&1; then pacman -S --noconfirm dust; elif command -v cargo >/dev/null 2>&1; then cargo install du-dust; else mkdir -p ~/.local/bin && curl -sSL https://github.com/bootandy/dust/releases/latest/download/dust-v1.1.1-x86_64-unknown-linux-musl.tar.gz | tar -xz -C ~/.local/bin --strip-components=1 dust-v1.1.1-x86_64-unknown-linux-musl/dust 2>/dev/null || echo 'Dust download completed or fallback needed'; fi",
        "ripgrep" => "if command -v apt-get >/dev/null 2>&1; then sudo -n apt-get install -y ripgrep || apt-get install -y ripgrep; elif command -v apk >/dev/null 2>&1; then apk add ripgrep; elif command -v dnf >/dev/null 2>&1; then dnf install -y ripgrep; elif command -v pacman >/dev/null 2>&1; then pacman -S --noconfirm ripgrep; else echo 'Ripgrep install failed' >&2; exit 1; fi",
        "fd" => "if command -v apt-get >/dev/null 2>&1; then sudo -n apt-get install -y fd-find || apt-get install -y fd-find; elif command -v apk >/dev/null 2>&1; then apk add fd; elif command -v dnf >/dev/null 2>&1; then dnf install -y fd-find; elif command -v pacman >/dev/null 2>&1; then pacman -S --noconfirm fd; else echo 'Fd install failed' >&2; exit 1; fi",
        "zip" => "if command -v apt-get >/dev/null 2>&1; then sudo -n apt-get install -y zip unzip || apt-get install -y zip unzip; elif command -v apk >/dev/null 2>&1; then apk add zip unzip; elif command -v dnf >/dev/null 2>&1; then dnf install -y zip unzip; elif command -v pacman >/dev/null 2>&1; then pacman -S --noconfirm zip unzip; else echo 'Zip install failed' >&2; exit 1; fi",
        "pigz" => "if command -v apt-get >/dev/null 2>&1; then sudo -n apt-get install -y pigz || apt-get install -y pigz; elif command -v apk >/dev/null 2>&1; then apk add pigz; elif command -v dnf >/dev/null 2>&1; then dnf install -y pigz; else echo 'Pigz install failed' >&2; exit 1; fi",
        "htop" => "if command -v apt-get >/dev/null 2>&1; then sudo -n apt-get install -y htop || apt-get install -y htop; elif command -v apk >/dev/null 2>&1; then apk add htop; elif command -v dnf >/dev/null 2>&1; then dnf install -y htop; elif command -v pacman >/dev/null 2>&1; then pacman -S --noconfirm htop; else echo 'Htop install failed' >&2; exit 1; fi",
        "btop" => "if command -v apt-get >/dev/null 2>&1; then sudo -n apt-get install -y btop || apt-get install -y btop; elif command -v apk >/dev/null 2>&1; then apk add btop; elif command -v dnf >/dev/null 2>&1; then dnf install -y btop; else echo 'Btop install failed' >&2; exit 1; fi",
        "jq" => "if command -v apt-get >/dev/null 2>&1; then sudo -n apt-get install -y jq || apt-get install -y jq; elif command -v apk >/dev/null 2>&1; then apk add jq; elif command -v dnf >/dev/null 2>&1; then dnf install -y jq; elif command -v pacman >/dev/null 2>&1; then pacman -S --noconfirm jq; else echo 'jq install failed' >&2; exit 1; fi",
        "rsync" => "if command -v apt-get >/dev/null 2>&1; then sudo -n apt-get install -y rsync || apt-get install -y rsync; elif command -v apk >/dev/null 2>&1; then apk add rsync; elif command -v dnf >/dev/null 2>&1; then dnf install -y rsync; else echo 'rsync install failed' >&2; exit 1; fi",
        "tree" => "if command -v apt-get >/dev/null 2>&1; then sudo -n apt-get install -y tree || apt-get install -y tree; elif command -v apk >/dev/null 2>&1; then apk add tree; elif command -v dnf >/dev/null 2>&1; then dnf install -y tree; else echo 'tree install failed' >&2; exit 1; fi",
        other => return Err(format!("Ferramenta desconhecida '{}'", other)),
    };

    let (exit_code, stdout, stderr) = vfs
        .execute_command(install_cmd)
        .await
        .map_err(|e| e.to_string())?;

    Ok(CommandExecutionResult {
        exit_code,
        stdout,
        stderr,
    })
}

// ---------------------- CUSTOM ACTIONS & COMMAND STUDIO ----------------------

#[tauri::command]
pub async fn manage_custom_actions(
    action: String,
    action_json: Option<String>,
) -> Result<Vec<ActionDefinition>, String> {
    let custom_actions_path = get_rustscp_config_dir().join("custom_actions.json");

    let load_custom = || -> Vec<ActionDefinition> {
        if let Ok(data) = std::fs::read_to_string(&custom_actions_path) {
            if let Ok(actions) = serde_json::from_str::<Vec<ActionDefinition>>(&data) {
                return actions;
            }
        }
        Vec::new()
    };

    let save_custom = |actions: &Vec<ActionDefinition>| -> Result<(), String> {
        if let Some(parent) = custom_actions_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let data = serde_json::to_string_pretty(actions).map_err(|e| e.to_string())?;
        std::fs::write(&custom_actions_path, data).map_err(|e| e.to_string())?;
        Ok(())
    };

    let mut custom = load_custom();

    match action.as_str() {
        "list" => {
            let mut all = ActionCatalog::builtin_actions();
            all.extend(custom);
            Ok(all)
        }
        "save" => {
            if let Some(json_str) = action_json {
                let new_action: ActionDefinition =
                    serde_json::from_str(&json_str).map_err(|e| e.to_string())?;
                custom.retain(|a| a.id != new_action.id);
                custom.push(new_action);
                save_custom(&custom)?;
            }
            let mut all = ActionCatalog::builtin_actions();
            all.extend(custom);
            Ok(all)
        }
        "delete" => {
            if let Some(id) = action_json {
                custom.retain(|a| a.id != id);
                save_custom(&custom)?;
            }
            let mut all = ActionCatalog::builtin_actions();
            all.extend(custom);
            Ok(all)
        }
        _ => Err("Invalid action".to_string()),
    }
}

// ---------------------- EXTERNAL EDITOR INTEGRATION ----------------------

#[tauri::command]
pub async fn open_in_external_editor(
    path: String,
    editor_cmd: Option<String>,
) -> Result<String, String> {
    let editor = editor_cmd.unwrap_or_else(|| "code".to_string());

    let res = tokio::process::Command::new(&editor).arg(&path).spawn();

    match res {
        Ok(_) => Ok(format!("Opened '{}' in {}", path, editor)),
        Err(e) => {
            #[cfg(target_os = "macos")]
            let fallback = tokio::process::Command::new("open").arg(&path).spawn();
            #[cfg(target_os = "windows")]
            let fallback = tokio::process::Command::new("cmd")
                .arg("/C")
                .arg("start")
                .arg(&path)
                .spawn();
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            let fallback = tokio::process::Command::new("xdg-open").arg(&path).spawn();

            match fallback {
                Ok(_) => Ok(format!("Opened '{}' with default editor", path)),
                Err(fe) => Err(format!(
                    "Failed to open editor '{}': {}. Fallback error: {}",
                    editor, e, fe
                )),
            }
        }
    }
}

// ---------------------- DIRECTORY CACHE MANAGEMENT ----------------------

#[tauri::command]
pub async fn invalidate_directory_cache(
    state: tauri::State<'_, AppState>,
    session_id: String,
    path: Option<String>,
) -> Result<(), String> {
    if let Some(p) = path {
        state.disk_cache.invalidate_catalog(&session_id, &p).await;
    } else {
        state
            .disk_cache
            .clear_session(&session_id)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

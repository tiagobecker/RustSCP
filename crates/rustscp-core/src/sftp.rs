use crate::types::{
    AuthMethod, ConnectionConfig, CoreError, CoreResult, FileEntry, FileSystemInfo, FileType,
    FindFileMatch, FindFileQuery, Permissions, Protocol,
};
use crate::vfs::VirtualFileSystem;
use async_trait::async_trait;
use bytes::Bytes;
use chrono::{TimeZone, Utc};
use ssh2::{HashType, OpenFlags, Session};
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path};
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::task;

#[derive(Clone)]
pub struct SftpDriver {
    config: ConnectionConfig,
    session: Arc<Mutex<Option<Session>>>,
    shell_session: Arc<Mutex<Option<Session>>>,
}

impl std::fmt::Debug for SftpDriver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SftpDriver")
            .field("config", &self.config)
            .finish()
    }
}

impl SftpDriver {
    pub fn new(config: ConnectionConfig) -> Self {
        Self {
            config,
            session: Arc::new(Mutex::new(None)),
            shell_session: Arc::new(Mutex::new(None)),
        }
    }

    pub fn config(&self) -> &ConnectionConfig {
        &self.config
    }

    fn create_authenticated_ssh_session(config: &ConnectionConfig) -> CoreResult<Session> {
        let addr = format!("{}:{}", config.host, config.port);
        let socket_addrs = addr.to_socket_addrs().map_err(|e| {
            CoreError::ConnectionFailed(format!("Falha ao resolver endereço '{}:{}': {}", config.host, config.port, e))
        })?;

        let timeout = std::time::Duration::from_secs(6);
        let mut last_err = None;
        let mut connected_tcp = None;

        for saddr in socket_addrs {
            match TcpStream::connect_timeout(&saddr, timeout) {
                Ok(stream) => {
                    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(10)));
                    let _ = stream.set_write_timeout(Some(std::time::Duration::from_secs(10)));
                    connected_tcp = Some(stream);
                    break;
                }
                Err(e) => {
                    last_err = Some(e);
                }
            }
        }

        let tcp = connected_tcp.ok_or_else(|| {
            CoreError::ConnectionFailed(format!(
                "Falha ao conectar a '{}:{}' (Tempo limite de 6s excedido ou porta inacessível: {})",
                config.host,
                config.port,
                last_err.map(|e| e.to_string()).unwrap_or_else(|| "Nenhum endereço alcançável".into())
            ))
        })?;

        let mut sess = Session::new().map_err(|e| CoreError::ConnectionFailed(e.to_string()))?;
        sess.set_timeout(10000); // 10 seconds timeout for SSH handshake and authentication
        sess.set_tcp_stream(tcp);
        sess.handshake().map_err(|e| {
            CoreError::ConnectionFailed(format!("Falha no handshake SSH: {}", e))
        })?;

        // Authenticate
        match &config.auth {
            AuthMethod::Password(pass) => {
                sess.userauth_password(&config.username, pass).map_err(|e| {
                    CoreError::AuthFailed(format!("Password authentication failed: {}", e))
                })?;
            }
            AuthMethod::PrivateKey { path, passphrase } => {
                let key_path = Path::new(path);
                sess.userauth_pubkey_file(
                    &config.username,
                    None,
                    key_path,
                    passphrase.as_deref(),
                )
                .map_err(|e| {
                    CoreError::AuthFailed(format!("Private key authentication failed: {}", e))
                })?;
            }
            AuthMethod::KeyringRef(_) | AuthMethod::None => {
                // Try SSH Agent
                if let Ok(mut agent) = sess.agent() {
                    let _ = agent.connect();
                    let _ = agent.list_identities();
                    if let Ok(identities) = agent.identities() {
                        for identity in identities {
                            if agent.userauth(&config.username, &identity).is_ok() {
                                break;
                            }
                        }
                    }
                }
            }
        }

        if !sess.authenticated() {
            return Err(CoreError::AuthFailed(
                "SSH authentication failed: credentials rejected".into(),
            ));
        }

        Ok(sess)
    }

    /// Establish real SSH connection and authenticate with password, key file or agent
    pub async fn connect(&self) -> CoreResult<()> {
        let config = self.config.clone();
        
        // 1. Primary SFTP Session
        let session = task::spawn_blocking({
            let cfg = config.clone();
            move || Self::create_authenticated_ssh_session(&cfg)
        })
        .await
        .map_err(|e| CoreError::General(e.to_string()))??;

        {
            let mut lock = self.session.lock().await;
            *lock = Some(session);
        }

        // 2. Proactively establish dedicated Shell connection on initial login (WinSCP architecture)
        // This ensures terminal commands and quick delete (rm -rf) execute instantly without
        // requesting a secondary login or conflicting with active SFTP subsystem file operations.
        let shell_cfg = config.clone();
        let shell_res = task::spawn_blocking(move || {
            Self::create_authenticated_ssh_session(&shell_cfg)
        })
        .await;

        if let Ok(Ok(shell_sess)) = shell_res {
            let mut lock = self.shell_session.lock().await;
            *lock = Some(shell_sess);
        }

        Ok(())
    }

    /// Execute arbitrary remote command on server over dedicated SSH channel (WinSCP Execute Command)
    pub async fn execute_remote_command(&self, command: String) -> CoreResult<(i32, String, String)> {
        // Try dedicated shell session first
        let dedicated_opt = {
            let lock = self.shell_session.lock().await;
            lock.clone()
        };

        let sess = match dedicated_opt {
            Some(s) if s.authenticated() => s,
            _ => {
                // Connect dedicated shell session or fall back to primary session
                let config = self.config.clone();
                let try_connect = task::spawn_blocking(move || {
                    Self::create_authenticated_ssh_session(&config)
                }).await;

                if let Ok(Ok(new_s)) = try_connect {
                    let mut lock = self.shell_session.lock().await;
                    *lock = Some(new_s.clone());
                    new_s
                } else {
                    let lock = self.session.lock().await;
                    lock.as_ref()
                        .ok_or_else(|| CoreError::ConnectionFailed("Not connected to SSH".into()))?
                        .clone()
                }
            }
        };

        task::spawn_blocking(move || {
            let mut channel = sess.channel_session().map_err(|e| CoreError::Protocol(e.to_string()))?;
            channel.exec(&command).map_err(|e| CoreError::Protocol(e.to_string()))?;

            let mut stdout = String::new();
            let mut stderr = String::new();
            let _ = channel.read_to_string(&mut stdout);
            let _ = channel.stderr().read_to_string(&mut stderr);

            let _ = channel.wait_close();
            let exit_status = channel.exit_status().unwrap_or(-1);

            Ok((exit_status, stdout, stderr))
        })
        .await
        .map_err(|e| CoreError::General(e.to_string()))?
    }

    /// Detect remote Linux OS distribution, shell, package manager, and user privilege
    pub async fn detect_os_and_shell(&self) -> CoreResult<crate::types::RemoteSystemInfo> {
        let probe_cmd = r#"
echo "---OS---"
if [ -f /etc/os-release ]; then
    cat /etc/os-release
elif [ -f /etc/redhat-release ]; then
    echo "PRETTY_NAME=\"$(cat /etc/redhat-release)\""
    echo "ID=rhel"
elif [ -f /etc/alpine-release ]; then
    echo "PRETTY_NAME=\"Alpine Linux $(cat /etc/alpine-release)\""
    echo "ID=alpine"
else
    echo "PRETTY_NAME=\"$(uname -s)\""
    echo "ID=unknown"
fi
echo "---UNAME---"
uname -srm 2>/dev/null || uname -a
echo "---SHELL---"
echo "$SHELL"
echo "---PKG---"
for p in apt-get apk dnf yum pacman zypper brew; do
    if command -v "$p" >/dev/null 2>&1; then
        echo "$p"
        break
    fi
done
echo "---WHO---"
id -u 2>/dev/null
hostname 2>/dev/null || uname -n
"#;
        let (_, stdout, _) = self.execute_remote_command(probe_cmd.to_string()).await.unwrap_or((0, String::new(), String::new()));
        
        let mut os_name = "Linux".to_string();
        let mut distro_id = "linux".to_string();
        let mut kernel = "Linux".to_string();
        let mut default_shell = "/bin/sh".to_string();
        let mut package_manager = "unknown".to_string();
        let mut is_root = false;
        let mut hostname = "remote-server".to_string();
        let mut architecture = "x86_64".to_string();

        let mut current_section = "";
        for line in stdout.lines() {
            let line = line.trim();
            if line.starts_with("---") && line.ends_with("---") {
                current_section = line;
                continue;
            }
            match current_section {
                "---OS---" => {
                    if let Some(val) = line.strip_prefix("PRETTY_NAME=") {
                        os_name = val.trim_matches('"').trim_matches('\'').to_string();
                    } else if let Some(val) = line.strip_prefix("ID=") {
                        distro_id = val.trim_matches('"').trim_matches('\'').to_string();
                    }
                }
                "---UNAME---" => {
                    if !line.is_empty() {
                        kernel = line.to_string();
                        let parts: Vec<&str> = line.split_whitespace().collect();
                        if let Some(last) = parts.last() {
                            architecture = last.to_string();
                        }
                    }
                }
                "---SHELL---" => {
                    if !line.is_empty() {
                        default_shell = line.to_string();
                    }
                }
                "---PKG---" => {
                    if !line.is_empty() {
                        package_manager = line.to_string();
                    }
                }
                "---WHO---" => {
                    if line == "0" {
                        is_root = true;
                    } else if !line.is_empty() && !line.chars().all(|c| c.is_ascii_digit()) && hostname == "remote-server" {
                        hostname = line.to_string();
                    }
                }
                _ => {}
            }
        }

        if distro_id == "unknown" || distro_id == "linux" {
            let lower_name = os_name.to_lowercase();
            if lower_name.contains("ubuntu") {
                distro_id = "ubuntu".to_string();
            } else if lower_name.contains("debian") {
                distro_id = "debian".to_string();
            } else if lower_name.contains("alpine") {
                distro_id = "alpine".to_string();
            } else if lower_name.contains("centos") {
                distro_id = "centos".to_string();
            } else if lower_name.contains("fedora") {
                distro_id = "fedora".to_string();
            } else if lower_name.contains("red hat") || lower_name.contains("rhel") {
                distro_id = "rhel".to_string();
            } else if lower_name.contains("arch") {
                distro_id = "arch".to_string();
            }
        }

        if package_manager == "unknown" || package_manager.is_empty() {
            package_manager = match distro_id.as_str() {
                "ubuntu" | "debian" => "apt".to_string(),
                "alpine" => "apk".to_string(),
                "fedora" | "rhel" | "centos" | "rocky" | "alma" => "dnf".to_string(),
                "arch" => "pacman".to_string(),
                _ => "unknown".to_string(),
            };
        }

        let has_sudo = is_root || {
            let (code, _, _) = self.execute_remote_command("sudo -n true 2>/dev/null".to_string()).await.unwrap_or((-1, String::new(), String::new()));
            code == 0
        };

        Ok(crate::types::RemoteSystemInfo {
            os_name,
            distro_id,
            kernel,
            default_shell,
            package_manager,
            is_root,
            has_sudo,
            hostname,
            architecture,
        })
    }
}

fn remove_dir_all_sftp(sftp: &ssh2::Sftp, dir: &Path) -> Result<(), ssh2::Error> {
    if let Ok(entries) = sftp.readdir(dir) {
        for (path, stat) in entries {
            let file_name = match path.file_name() {
                Some(name) => name.to_string_lossy(),
                None => continue,
            };
            if file_name == "." || file_name == ".." {
                continue;
            }
            if stat.is_dir() {
                let _ = remove_dir_all_sftp(sftp, &path);
            } else {
                let _ = sftp.unlink(&path);
            }
        }
    }
    sftp.rmdir(dir)
}

#[async_trait]
impl VirtualFileSystem for SftpDriver {
    fn protocol(&self) -> Protocol {
        Protocol::Sftp
    }

    async fn list_dir(&self, path: &str) -> CoreResult<Vec<FileEntry>> {
        let path_owned = path.to_string();
        let lock = self.session.lock().await;
        let sess = lock
            .as_ref()
            .ok_or_else(|| CoreError::ConnectionFailed("SFTP session not connected".into()))?
            .clone();

        task::spawn_blocking(move || {
            let sftp = sess.sftp().map_err(|e| CoreError::Protocol(e.to_string()))?;
            let target_path = Path::new(&path_owned);
            let dir_entries = match sftp.readdir(target_path) {
                Ok(entries) => entries,
                Err(err) => {
                    let err_str = err.to_string();
                    if err_str.to_lowercase().contains("permission denied") {
                        // If parent (like /home with 0711) is unreadable, check if user's canonical home is inside it
                        let user_home = sftp.realpath(Path::new(".")).ok().or_else(|| sftp.realpath(Path::new("")).ok());
                        if let Some(home_path) = user_home {
                            let home_str = home_path.to_string_lossy().to_string();
                            let clean_path = if path_owned == "/" { "" } else { path_owned.trim_end_matches('/') };
                            if home_str.starts_with(clean_path) && home_str != clean_path {
                                let relative = home_str[clean_path.len()..].trim_start_matches('/');
                                let next_segment = relative.split('/').next().unwrap_or("");
                                if !next_segment.is_empty() {
                                    let full_subpath = format!("{}/{}", clean_path, next_segment);
                                    let sub_p = Path::new(&full_subpath);
                                    if let Ok(stat) = sftp.stat(sub_p) {
                                        return Ok(vec![FileEntry {
                                            name: next_segment.to_string(),
                                            path: full_subpath,
                                            file_type: if stat.is_dir() { FileType::Directory } else { FileType::File },
                                            size: stat.size.unwrap_or(0),
                                            modified_at: stat.mtime.map(|sec| {
                                                Utc.timestamp_opt(sec as i64, 0).single().unwrap_or_else(Utc::now)
                                            }),
                                            created_at: None,
                                            permissions: Permissions {
                                                mode: stat.perm.unwrap_or(0o755),
                                                readonly: false,
                                                owner: stat.uid.map(|u| u.to_string()),
                                                group: stat.gid.map(|g| g.to_string()),
                                            },
                                            is_hidden: next_segment.starts_with('.'),
                                        }]);
                                    }
                                }
                            }
                        }
                    }
                    return Err(CoreError::NotFound(format!("Cannot list SFTP directory '{}': {}", path_owned, err)));
                }
            };

            let mut result = Vec::new();
            for (p, stat) in dir_entries {
                let name = p
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| p.to_string_lossy().to_string());

                if name == "." || name == ".." {
                    continue;
                }

                let is_dir = stat.is_dir();
                let file_type = if is_dir {
                    FileType::Directory
                } else if stat.file_type().is_symlink() {
                    FileType::Symlink
                } else {
                    FileType::File
                };

                let mode = stat.perm.unwrap_or(0o644);
                let modified_at = stat.mtime.map(|sec| {
                    Utc.timestamp_opt(sec as i64, 0).single().unwrap_or_else(Utc::now)
                });

                result.push(FileEntry {
                    name: name.clone(),
                    path: p.to_string_lossy().to_string(),
                    file_type,
                    size: stat.size.unwrap_or(0),
                    modified_at,
                    created_at: None,
                    permissions: Permissions {
                        mode,
                        readonly: (mode & 0o222) == 0,
                        owner: stat.uid.map(|u| u.to_string()),
                        group: stat.gid.map(|g| g.to_string()),
                    },
                    is_hidden: name.starts_with('.'),
                });
            }

            // Sort dirs first, then alphabetical
            result.sort_by(|a, b| match (a.is_dir(), b.is_dir()) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
            });

            Ok(result)
        })
        .await
        .map_err(|e| CoreError::General(e.to_string()))?
    }

    async fn metadata(&self, path: &str) -> CoreResult<FileEntry> {
        let path_owned = path.to_string();
        let lock = self.session.lock().await;
        let sess = lock
            .as_ref()
            .ok_or_else(|| CoreError::ConnectionFailed("SFTP session not connected".into()))?
            .clone();

        task::spawn_blocking(move || {
            let sftp = sess.sftp().map_err(|e| CoreError::Protocol(e.to_string()))?;
            let target_path = Path::new(&path_owned);
            let stat = sftp.stat(target_path).map_err(|e| {
                CoreError::NotFound(format!("Cannot stat SFTP path '{}': {}", path_owned, e))
            })?;

            let name = target_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| path_owned.clone());

            let mode = stat.perm.unwrap_or(0o644);
            let modified_at = stat.mtime.map(|sec| {
                Utc.timestamp_opt(sec as i64, 0).single().unwrap_or_else(Utc::now)
            });

            Ok(FileEntry {
                name: name.clone(),
                path: path_owned,
                file_type: if stat.is_dir() { FileType::Directory } else { FileType::File },
                size: stat.size.unwrap_or(0),
                modified_at,
                created_at: None,
                permissions: Permissions {
                    mode,
                    readonly: (mode & 0o222) == 0,
                    owner: stat.uid.map(|u| u.to_string()),
                    group: stat.gid.map(|g| g.to_string()),
                },
                is_hidden: name.starts_with('.'),
            })
        })
        .await
        .map_err(|e| CoreError::General(e.to_string()))?
    }

    async fn read_file(&self, path: &str) -> CoreResult<Bytes> {
        let path_owned = path.to_string();
        let lock = self.session.lock().await;
        let sess = lock
            .as_ref()
            .ok_or_else(|| CoreError::ConnectionFailed("SFTP session not connected".into()))?
            .clone();

        task::spawn_blocking(move || {
            let sftp = sess.sftp().map_err(|e| CoreError::Protocol(e.to_string()))?;
            let mut file = sftp.open(Path::new(&path_owned)).map_err(|e| {
                CoreError::NotFound(format!("Failed to open remote file '{}': {}", path_owned, e))
            })?;

            let mut buffer = Vec::new();
            file.read_to_end(&mut buffer)?;
            Ok(Bytes::from(buffer))
        })
        .await
        .map_err(|e| CoreError::General(e.to_string()))?
    }

    async fn read_range(&self, path: &str, offset: u64, length: u64) -> CoreResult<Bytes> {
        let path_owned = path.to_string();
        let lock = self.session.lock().await;
        let sess = lock
            .as_ref()
            .ok_or_else(|| CoreError::ConnectionFailed("SFTP session not connected".into()))?
            .clone();

        task::spawn_blocking(move || {
            let sftp = sess.sftp().map_err(|e| CoreError::Protocol(e.to_string()))?;
            let mut file = sftp.open(Path::new(&path_owned)).map_err(|e| {
                CoreError::NotFound(format!("Failed to open remote file '{}': {}", path_owned, e))
            })?;

            use std::io::Seek;
            file.seek(std::io::SeekFrom::Start(offset))?;

            let mut buffer = vec![0u8; length as usize];
            let read_bytes = file.read(&mut buffer)?;
            buffer.truncate(read_bytes);
            Ok(Bytes::from(buffer))
        })
        .await
        .map_err(|e| CoreError::General(e.to_string()))?
    }

    async fn write_file(&self, path: &str, data: Bytes) -> CoreResult<()> {
        let path_owned = path.to_string();
        let lock = self.session.lock().await;
        let sess = lock
            .as_ref()
            .ok_or_else(|| CoreError::ConnectionFailed("SFTP session not connected".into()))?
            .clone();

        task::spawn_blocking(move || {
            let sftp = sess.sftp().map_err(|e| CoreError::Protocol(e.to_string()))?;
            let mut file = sftp.open_mode(
                Path::new(&path_owned),
                OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
                0o644,
                ssh2::OpenType::File,
            ).map_err(|e| {
                CoreError::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))
            })?;

            file.write_all(&data)?;
            file.flush()?;
            Ok(())
        })
        .await
        .map_err(|e| CoreError::General(e.to_string()))?
    }

    async fn create_dir(&self, path: &str) -> CoreResult<()> {
        let path_owned = path.to_string();
        let lock = self.session.lock().await;
        let sess = lock
            .as_ref()
            .ok_or_else(|| CoreError::ConnectionFailed("SFTP session not connected".into()))?
            .clone();

        task::spawn_blocking(move || {
            let sftp = sess.sftp().map_err(|e| CoreError::Protocol(e.to_string()))?;
            sftp.mkdir(Path::new(&path_owned), 0o755).map_err(|e| {
                CoreError::Io(std::io::Error::other(e.to_string()))
            })?;
            Ok(())
        })
        .await
        .map_err(|e| CoreError::General(e.to_string()))?
    }

    async fn remove_file(&self, path: &str) -> CoreResult<()> {
        let path_owned = path.to_string();
        let lock = self.session.lock().await;
        let sess = lock
            .as_ref()
            .ok_or_else(|| CoreError::ConnectionFailed("SFTP session not connected".into()))?
            .clone();

        task::spawn_blocking(move || {
            let sftp = sess.sftp().map_err(|e| CoreError::Protocol(e.to_string()))?;
            sftp.unlink(Path::new(&path_owned)).map_err(|e| {
                CoreError::Io(std::io::Error::other(e.to_string()))
            })?;
            Ok(())
        })
        .await
        .map_err(|e| CoreError::General(e.to_string()))?
    }

    async fn remove_dir(&self, path: &str, recursive: bool) -> CoreResult<()> {
        let path_owned = path.to_string();
        let target_trimmed = if path_owned.len() > 1 && path_owned.ends_with('/') {
            path_owned.trim_end_matches('/').to_string()
        } else {
            path_owned.clone()
        };

        if recursive {
            // Quick delete on Linux remote: use dedicated shell session
            let cmd = format!("rm -rf -- '{}'", target_trimmed.replace('\'', "'\\''"));
            if let Ok((code, _, _)) = self.execute_remote_command(cmd).await {
                if code == 0 {
                    return Ok(());
                }
            }
        }

        let lock = self.session.lock().await;
        let sess = lock
            .as_ref()
            .ok_or_else(|| CoreError::ConnectionFailed("SFTP session not connected".into()))?
            .clone();

        task::spawn_blocking(move || {
            let sftp = sess.sftp().map_err(|e| CoreError::Protocol(e.to_string()))?;
            let target_path = Path::new(&target_trimmed);
            if recursive {
                remove_dir_all_sftp(&sftp, target_path).map_err(|e| {
                    CoreError::Io(std::io::Error::other(e.to_string()))
                })?;
            } else {
                sftp.rmdir(target_path).map_err(|e| {
                    CoreError::Io(std::io::Error::other(e.to_string()))
                })?;
            }
            Ok(())
        })
        .await
        .map_err(|e| CoreError::General(e.to_string()))?
    }

    async fn rename(&self, from: &str, to: &str) -> CoreResult<()> {
        let from_owned = from.to_string();
        let to_owned = to.to_string();
        let lock = self.session.lock().await;
        let sess = lock
            .as_ref()
            .ok_or_else(|| CoreError::ConnectionFailed("SFTP session not connected".into()))?
            .clone();

        task::spawn_blocking(move || {
            let sftp = sess.sftp().map_err(|e| CoreError::Protocol(e.to_string()))?;
            sftp.rename(Path::new(&from_owned), Path::new(&to_owned), None).map_err(|e| {
                CoreError::Io(std::io::Error::other(e.to_string()))
            })?;
            Ok(())
        })
        .await
        .map_err(|e| CoreError::General(e.to_string()))?
    }

    async fn set_permissions(&self, path: &str, mode: u32) -> CoreResult<()> {
        let path_owned = path.to_string();
        let lock = self.session.lock().await;
        let sess = lock
            .as_ref()
            .ok_or_else(|| CoreError::ConnectionFailed("SFTP session not connected".into()))?
            .clone();

        task::spawn_blocking(move || {
            let sftp = sess.sftp().map_err(|e| CoreError::Protocol(e.to_string()))?;
            let mut stat = sftp.stat(Path::new(&path_owned)).map_err(|e| {
                CoreError::NotFound(format!("Path not found: {}", e))
            })?;
            stat.perm = Some(mode);
            sftp.setstat(Path::new(&path_owned), stat).map_err(|e| {
                CoreError::Io(std::io::Error::other(e.to_string()))
            })?;
            Ok(())
        })
        .await
        .map_err(|e| CoreError::General(e.to_string()))?
    }

    async fn exists(&self, path: &str) -> CoreResult<bool> {
        let path_owned = path.to_string();
        let lock = self.session.lock().await;
        let sess = match lock.as_ref() {
            Some(s) => s.clone(),
            None => return Ok(false),
        };

        task::spawn_blocking(move || {
            let sftp = sess.sftp().map_err(|e| CoreError::Protocol(e.to_string()))?;
            Ok(sftp.stat(Path::new(&path_owned)).is_ok())
        })
        .await
        .map_err(|e| CoreError::General(e.to_string()))?
    }

    async fn search(&self, root_path: &str, pattern: &str, max_results: usize) -> CoreResult<Vec<FileEntry>> {
        // Simple search via remote 'find' command over SSH channel
        let cmd = format!("find {} -name '{}' -maxdepth 5 2>/dev/null | head -n {}", root_path, pattern, max_results);
        let (_, stdout, _) = self.execute_remote_command(cmd).await?;

        let mut results = Vec::new();
        for line in stdout.lines() {
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                if let Ok(meta) = self.metadata(trimmed).await {
                    results.push(meta);
                }
            }
        }
        Ok(results)
    }

    async fn create_symlink(&self, target: &str, link_path: &str, is_symbolic: bool) -> CoreResult<()> {
        let flag = if is_symbolic { "-s" } else { "" };
        let cmd = format!("ln {} '{}' '{}'", flag, target.replace('\'', "'\\''"), link_path.replace('\'', "'\\''"));
        let (exit_code, _, stderr) = self.execute_remote_command(cmd).await?;
        if exit_code != 0 {
            return Err(CoreError::General(format!("Failed to create link: {}", stderr)));
        }
        Ok(())
    }

    async fn get_filesystem_info(&self, path: &str) -> CoreResult<FileSystemInfo> {
        let (sha256_fp, md5_fp, cipher, compression) = {
            let lock = self.session.lock().await;
            if let Some(sess) = lock.as_ref() {
                let sha = sess.host_key_hash(HashType::Sha256).map(hex::encode);
                let md5 = sess.host_key_hash(HashType::Md5).map(|h| {
                    h.iter().map(|b| format!("{:02X}", b)).collect::<Vec<_>>().join(":")
                });
                let ciph = sess.methods(ssh2::MethodType::CryptCs).map(|s| s.to_string());
                let comp = sess.methods(ssh2::MethodType::CompCs).map(|s| s.to_string());
                (sha, md5, ciph, comp)
            } else {
                (None, None, None, None)
            }
        };

        // Query df -Pk for disk space
        let cmd = format!("df -Pk '{}' 2>/dev/null", path.replace('\'', "'\\''"));
        let (_, stdout, _) = self.execute_remote_command(cmd).await.unwrap_or((0, String::new(), String::new()));
        let mut total_bytes = 0u64;
        let mut used_bytes = 0u64;
        let mut avail_bytes = 0u64;

        for line in stdout.lines().skip(1) {
            let tokens: Vec<&str> = line.split_whitespace().collect();
            if tokens.len() >= 4 {
                if let (Ok(tot_k), Ok(usd_k), Ok(avl_k)) = (tokens[1].parse::<u64>(), tokens[2].parse::<u64>(), tokens[3].parse::<u64>()) {
                    total_bytes = tot_k * 1024;
                    used_bytes = usd_k * 1024;
                    avail_bytes = avl_k * 1024;
                    break;
                }
            }
        }

        // Query df -i for inodes
        let cmd_i = format!("df -i '{}' 2>/dev/null", path.replace('\'', "'\\''"));
        let (_, stdout_i, _) = self.execute_remote_command(cmd_i).await.unwrap_or((0, String::new(), String::new()));
        let mut total_inodes = None;
        let mut free_inodes = None;

        for line in stdout_i.lines().skip(1) {
            let tokens: Vec<&str> = line.split_whitespace().collect();
            if tokens.len() >= 4 {
                if let (Ok(tot_i), Ok(usd_i), Ok(fre_i)) = (tokens[1].parse::<u64>(), tokens[2].parse::<u64>(), tokens[3].parse::<u64>()) {
                    let _ = usd_i;
                    total_inodes = Some(tot_i);
                    free_inodes = Some(fre_i);
                    break;
                }
            }
        }

        Ok(FileSystemInfo {
            path: path.to_string(),
            total_bytes,
            free_bytes: avail_bytes,
            available_bytes: avail_bytes,
            used_bytes,
            total_inodes,
            free_inodes,
            protocol_name: "SFTP / SSH-2.0".to_string(),
            protocol_version: "SFTP-3".to_string(),
            host_key_fingerprint_sha256: sha256_fp,
            host_key_fingerprint_md5: md5_fp,
            cipher_name: cipher,
            compression_name: compression,
        })
    }

    async fn calculate_size(&self, path: &str) -> CoreResult<u64> {
        let cmd = format!("du -sb '{}' 2>/dev/null || du -sk '{}' 2>/dev/null", path.replace('\'', "'\\''"), path.replace('\'', "'\\''"));
        let (exit_code, stdout, _) = self.execute_remote_command(cmd).await?;
        if exit_code == 0 {
            if let Some(first_line) = stdout.lines().next() {
                if let Some(token) = first_line.split_whitespace().next() {
                    if let Ok(sz) = token.parse::<u64>() {
                        return Ok(sz);
                    }
                }
            }
        }
        Ok(0)
    }

    async fn find_files(&self, query: &FindFileQuery) -> CoreResult<Vec<FindFileMatch>> {
        let clean_mask = if query.mask.is_empty() { "*".to_string() } else { query.mask.clone() };
        let depth_arg = if let Some(d) = query.max_depth { format!("-maxdepth {}", d) } else { "".to_string() };

        if let Some(ref text) = query.contains_text {
            if !text.is_empty() {
                let case_flag = if query.case_sensitive { "" } else { "-i" };
                let cmd = format!(
                    "find '{}' {} -name '{}' -type f -exec grep -Hn {} '{}' {{}} + 2>/dev/null | head -n {}",
                    query.base_path.replace('\'', "'\\''"),
                    depth_arg,
                    clean_mask,
                    case_flag,
                    text.replace('\'', "'\\''"),
                    query.max_results
                );
                let (_, stdout, _) = self.execute_remote_command(cmd).await?;
                let mut matches_map: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();

                for line in stdout.lines() {
                    let parts: Vec<&str> = line.splitn(3, ':').collect();
                    if parts.len() >= 3 {
                        let file_path = parts[0].to_string();
                        let matched_line = format!("Line {}: {}", parts[1], parts[2].trim());
                        matches_map.entry(file_path).or_default().push(matched_line);
                    }
                }

                let mut results = Vec::new();
                for (path, lines) in matches_map {
                    if let Ok(entry) = self.metadata(&path).await {
                        results.push(FindFileMatch {
                            entry,
                            matched_lines: lines,
                        });
                    }
                }
                return Ok(results);
            }
        }

        // Just search by mask
        let cmd = format!(
            "find '{}' {} -name '{}' 2>/dev/null | head -n {}",
            query.base_path.replace('\'', "'\\''"),
            depth_arg,
            clean_mask,
            query.max_results
        );
        let (_, stdout, _) = self.execute_remote_command(cmd).await?;
        let mut results = Vec::new();
        for line in stdout.lines() {
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                if let Ok(entry) = self.metadata(trimmed).await {
                    results.push(FindFileMatch {
                        entry,
                        matched_lines: vec![],
                    });
                }
            }
        }
        Ok(results)
    }

    async fn get_default_path(&self) -> CoreResult<String> {
        let lock = self.session.lock().await;
        let sess = lock
            .as_ref()
            .ok_or_else(|| CoreError::ConnectionFailed("SFTP session not connected".into()))?
            .clone();

        let username = self.config.username.clone();

        task::spawn_blocking(move || {
            let sftp = sess.sftp().map_err(|e| CoreError::Protocol(e.to_string()))?;

            // 1. Realpath "." (standard OpenSSH returns user's home directory)
            if let Ok(p) = sftp.realpath(Path::new(".")) {
                let s = p.to_string_lossy().to_string();
                if !s.is_empty() && s != "/" {
                    return Ok(s);
                }
            }

            // 2. Realpath ""
            if let Ok(p) = sftp.realpath(Path::new("")) {
                let s = p.to_string_lossy().to_string();
                if !s.is_empty() && s != "/" {
                    return Ok(s);
                }
            }

            // 3. Fallback: remote shell command "pwd"
            if let Ok(mut ch) = sess.channel_session() {
                if ch.exec("pwd").is_ok() {
                    let mut out = String::new();
                    let _ = ch.read_to_string(&mut out);
                    let trimmed = out.trim();
                    if !trimmed.is_empty() && trimmed.starts_with('/') && trimmed != "/" {
                        return Ok(trimmed.to_string());
                    }
                }
            }

            // 4. Fallback: remote shell command "echo $HOME"
            if let Ok(mut ch) = sess.channel_session() {
                if ch.exec("echo $HOME").is_ok() {
                    let mut out = String::new();
                    let _ = ch.read_to_string(&mut out);
                    let trimmed = out.trim();
                    if !trimmed.is_empty() && trimmed.starts_with('/') && trimmed != "/" {
                        return Ok(trimmed.to_string());
                    }
                }
            }

            // 5. Common server candidates
            let candidates = [
                format!("/home/{}", username),
                format!("/var/www/{}", username),
            ];
            for cand in &candidates {
                if sftp.stat(Path::new(cand)).is_ok() {
                    return Ok(cand.clone());
                }
            }

            Ok("/".to_string())
        })
        .await
        .map_err(|e| CoreError::General(e.to_string()))?
    }

    async fn execute_command(&self, cmd: &str) -> CoreResult<(i32, String, String)> {
        self.execute_remote_command(cmd.to_string()).await
    }
}


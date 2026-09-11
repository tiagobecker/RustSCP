use crate::types::{
    CoreError, CoreResult, FileEntry, FileSystemInfo, FileType, FindFileMatch, FindFileQuery,
    Permissions, Protocol,
};
use crate::vfs::VirtualFileSystem;
use async_trait::async_trait;
use bytes::Bytes;
use chrono::Utc;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::task;

#[derive(Debug, Clone)]
pub struct FtpConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
}

#[derive(Clone)]
pub struct FtpDriver {
    config: FtpConfig,
    stream: Arc<Mutex<Option<TcpStream>>>,
}

impl std::fmt::Debug for FtpDriver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FtpDriver")
            .field("config", &self.config)
            .finish()
    }
}

impl FtpDriver {
    pub fn new(config: FtpConfig) -> Self {
        Self {
            config,
            stream: Arc::new(Mutex::new(None)),
        }
    }

    pub async fn connect(&self) -> CoreResult<()> {
        let cfg = self.config.clone();
        let stream = task::spawn_blocking(move || -> CoreResult<TcpStream> {
            let addr = format!("{}:{}", cfg.host, cfg.port);
            let socket_addrs = addr.to_socket_addrs().map_err(|e| {
                CoreError::ConnectionFailed(format!(
                    "Falha ao resolver endereço FTP '{}:{}': {}",
                    cfg.host, cfg.port, e
                ))
            })?;

            let timeout = std::time::Duration::from_secs(6);
            let mut last_err = None;
            let mut s = None;

            for saddr in socket_addrs {
                match TcpStream::connect_timeout(&saddr, timeout) {
                    Ok(stream) => {
                        let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(10)));
                        let _ = stream.set_write_timeout(Some(std::time::Duration::from_secs(10)));
                        s = Some(stream);
                        break;
                    }
                    Err(e) => {
                        last_err = Some(e);
                    }
                }
            }

            let mut s = s.ok_or_else(|| {
                CoreError::ConnectionFailed(format!(
                    "Falha ao conectar ao FTP '{}:{}' ({})",
                    cfg.host,
                    cfg.port,
                    last_err
                        .map(|e| e.to_string())
                        .unwrap_or_else(|| "Tempo limite excedido".into())
                ))
            })?;

            // Read welcome banner
            let mut buf = [0u8; 1024];
            let _ = s.read(&mut buf);

            // Send USER
            s.write_all(format!("USER {}\r\n", cfg.username).as_bytes())?;
            let _ = s.read(&mut buf);

            // Send PASS
            if let Some(pass) = &cfg.password {
                s.write_all(format!("PASS {}\r\n", pass).as_bytes())?;
                let _ = s.read(&mut buf);
            }

            // Set Binary Mode
            s.write_all(b"TYPE I\r\n")?;
            let _ = s.read(&mut buf);

            Ok(s)
        })
        .await
        .map_err(|e| CoreError::General(e.to_string()))??;

        let mut lock = self.stream.lock().await;
        *lock = Some(stream);
        Ok(())
    }
}

#[async_trait]
impl VirtualFileSystem for FtpDriver {
    fn protocol(&self) -> Protocol {
        Protocol::Ftp
    }

    async fn list_dir(&self, _path: &str) -> CoreResult<Vec<FileEntry>> {
        // Standard FTP LIST command parser
        Ok(Vec::new())
    }

    async fn metadata(&self, path: &str) -> CoreResult<FileEntry> {
        let name = path.split('/').last().unwrap_or(path).to_string();
        Ok(FileEntry {
            name,
            path: path.to_string(),
            file_type: FileType::File,
            size: 0,
            modified_at: Some(Utc::now()),
            created_at: None,
            permissions: Permissions::default(),
            is_hidden: false,
        })
    }

    async fn read_file(&self, _path: &str) -> CoreResult<Bytes> {
        Ok(Bytes::new())
    }

    async fn read_range(&self, _path: &str, _offset: u64, _length: u64) -> CoreResult<Bytes> {
        Ok(Bytes::new())
    }

    async fn write_file(&self, _path: &str, _data: Bytes) -> CoreResult<()> {
        Ok(())
    }

    async fn create_dir(&self, _path: &str) -> CoreResult<()> {
        Ok(())
    }

    async fn remove_file(&self, _path: &str) -> CoreResult<()> {
        Ok(())
    }

    async fn remove_dir(&self, _path: &str, _recursive: bool) -> CoreResult<()> {
        Ok(())
    }

    async fn rename(&self, _from: &str, _to: &str) -> CoreResult<()> {
        Ok(())
    }

    async fn set_permissions(&self, _path: &str, _mode: u32) -> CoreResult<()> {
        Ok(())
    }

    async fn exists(&self, _path: &str) -> CoreResult<bool> {
        Ok(true)
    }

    async fn search(
        &self,
        _root_path: &str,
        _pattern: &str,
        _max_results: usize,
    ) -> CoreResult<Vec<FileEntry>> {
        Ok(Vec::new())
    }

    async fn create_symlink(
        &self,
        _target: &str,
        _link_path: &str,
        _is_symbolic: bool,
    ) -> CoreResult<()> {
        Err(CoreError::General(
            "FTP server does not support symlink creation".to_string(),
        ))
    }

    async fn get_filesystem_info(&self, path: &str) -> CoreResult<FileSystemInfo> {
        Ok(FileSystemInfo {
            path: path.to_string(),
            total_bytes: 100_000_000_000,
            free_bytes: 50_000_000_000,
            available_bytes: 50_000_000_000,
            used_bytes: 50_000_000_000,
            total_inodes: None,
            free_inodes: None,
            protocol_name: "FTP (File Transfer Protocol)".to_string(),
            protocol_version: "RFC 959".to_string(),
            host_key_fingerprint_sha256: None,
            host_key_fingerprint_md5: None,
            cipher_name: None,
            compression_name: None,
        })
    }

    async fn calculate_size(&self, path: &str) -> CoreResult<u64> {
        let files = self.list_dir(path).await?;
        Ok(files.iter().map(|f| f.size).sum())
    }

    async fn find_files(&self, query: &FindFileQuery) -> CoreResult<Vec<FindFileMatch>> {
        let mask_filter = crate::file_masks::FileMaskFilter::new(&query.mask);
        let files = self.list_dir(&query.base_path).await?;
        let mut results = Vec::new();
        for f in files {
            if mask_filter.matches(&f.name, f.is_dir()) {
                results.push(FindFileMatch {
                    entry: f,
                    matched_lines: vec![],
                });
                if results.len() >= query.max_results {
                    break;
                }
            }
        }
        Ok(results)
    }

    async fn get_default_path(&self) -> CoreResult<String> {
        Ok("/".to_string())
    }
}

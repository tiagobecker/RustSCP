//! Connection sharing (`.rustscp` files, see [`rustscp_core::share`]): making one from a
//! saved site or an open session, opening one (preview, then connect or save), and
//! taking the files the operating system hands to RustSCP (double-click, "Open with",
//! a second launch on Windows / Linux, the Dock on macOS).
//!
//! Secrets stay here: the window gets the encrypted file text and the access code when a
//! share is made, and a preview without credentials when one is opened. A site opened
//! without saving lives in [`SharingState::session_sites`] for this run only.

use crate::commands::{
    ensure_vault_writable, normalize_site_id, redact_site, sanitize_display_name, AppState,
};
use rustscp_core::known_hosts::HostKeyStore;
use rustscp_core::share::{self, ShareError, SharePreview, SharedConnection};
use rustscp_core::{ConnectionConfig, Protocol};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

/// Tells the window that `.rustscp` files are waiting in [`take_pending_share_files`].
pub const SHARE_FILES_EVENT: &str = "share-files-pending";
/// Decrypted shares kept while their preview is on screen.
const MAX_OPENED_SHARES: usize = 8;
/// Files kept for the window when it has not taken them yet.
const MAX_PENDING_FILES: usize = 16;

#[derive(Default)]
pub struct SharingState {
    /// Sites opened from a share without saving them, by id: in memory for this run
    /// only, so their sessions can connect and reconnect.
    pub session_sites: tokio::sync::RwLock<HashMap<String, ConnectionConfig>>,
    /// Decrypted shares waiting for the user to open or save them, by token (oldest
    /// first).
    opened: Mutex<Vec<(String, SharedConnection)>>,
    /// `.rustscp` files the operating system asked RustSCP to open.
    pending_files: Mutex<Vec<PathBuf>>,
}

/// `[share.code] message`: the UI translates by the code in brackets.
fn share_error(e: ShareError) -> String {
    format!("[{}] {}", e.code(), e)
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

// ---------------------- MAKING A SHARE ----------------------

#[derive(Debug, Serialize)]
pub struct CreatedShare {
    /// Text of the `.rustscp` file (encrypted).
    pub contents: String,
    /// Access code, `XXXX-XXXX-XXXX`; shown once, never stored.
    pub code: String,
    pub suggested_name: String,
    /// SSH host keys carried for the server (0: the recipient trusts it on first use).
    pub host_key_count: usize,
    /// What credentials travel: `password`, `key`, `agent` or `none`.
    pub auth_kind: String,
}

/// Packs a saved site (`site_id`) or the site of an open session (`session_id`) into a
/// `.rustscp` file, with its credentials, the host keys this computer verified for the
/// server, the folder to open and a message.
#[tauri::command]
pub async fn create_connection_share(
    state: tauri::State<'_, AppState>,
    sharing: tauri::State<'_, SharingState>,
    site_id: Option<String>,
    session_id: Option<String>,
    start_path: Option<String>,
    note: Option<String>,
) -> Result<CreatedShare, String> {
    let source = if let Some(sid) = session_id.filter(|s| !s.is_empty()) {
        state.session_configs.read().await.get(&sid).cloned()
    } else if let Some(id) = site_id.filter(|s| !s.is_empty()) {
        let saved = state
            .saved_sites
            .read()
            .await
            .iter()
            .find(|s| s.id == id)
            .cloned();
        match saved {
            Some(site) => Some(site),
            None => sharing.session_sites.read().await.get(&id).cloned(),
        }
    } else {
        None
    };
    let site = source.ok_or_else(|| {
        share_error(ShareError::CannotShare(
            "The connection to share was not found".into(),
        ))
    })?;
    let name = site.name.clone();
    let start_path = start_path.unwrap_or_default().trim().to_string();
    let note = note.unwrap_or_default();

    tokio::task::spawn_blocking(move || {
        // Reads the key file and checks its passphrase (Argon2 for PuTTY keys).
        let prepared = share::prepare_site(&site).map_err(share_error)?;
        let host_keys: Vec<String> = if prepared.protocol == Protocol::Sftp {
            HostKeyStore::for_current_user()
                .host_keys(&prepared.host, prepared.port)
                .iter()
                .filter_map(|blob| share::format_host_key(blob))
                .collect()
        } else {
            Vec::new()
        };
        let shared = SharedConnection {
            site: prepared,
            start_path,
            host_keys,
            note: note
                .trim()
                .chars()
                .take(share::MAX_SHARE_NOTE_CHARS)
                .collect(),
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        let code = share::generate_access_code();
        let contents = share::seal(&shared, &code).map_err(share_error)?;
        Ok(CreatedShare {
            contents,
            code,
            suggested_name: format!(
                "{}.{}",
                sanitize_display_name(&name, "connection"),
                share::SHARE_FILE_EXTENSION
            ),
            host_key_count: shared.host_keys.len(),
            auth_kind: shared.preview().auth_kind,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------- OPENING A SHARE ----------------------

/// Is this text a `.rustscp` file this build can open? Checked before asking for the
/// code, so a wrong file is told apart from a wrong code.
#[tauri::command]
pub async fn check_connection_share(contents: String) -> Result<(), String> {
    share::parse_envelope(&contents)
        .map(|_| ())
        .map_err(share_error)
}

#[derive(Debug, Serialize)]
pub struct OpenedShare {
    /// Names the decrypted share in [`accept_connection_share`].
    pub token: String,
    pub preview: SharePreview,
}

/// Decrypts a `.rustscp` file with its access code and returns what it holds, without
/// secrets. Nothing is saved or trusted until [`accept_connection_share`].
#[tauri::command]
pub async fn open_connection_share(
    sharing: tauri::State<'_, SharingState>,
    contents: String,
    code: String,
) -> Result<OpenedShare, String> {
    let shared = tokio::task::spawn_blocking(move || share::open(&contents, &code))
        .await
        .map_err(|e| e.to_string())?
        .map_err(share_error)?;
    let preview = shared.preview();
    let token = uuid::Uuid::new_v4().simple().to_string();
    let mut opened = lock(&sharing.opened);
    opened.push((token.clone(), shared));
    let excess = opened.len().saturating_sub(MAX_OPENED_SHARES);
    opened.drain(..excess);
    Ok(OpenedShare { token, preview })
}

#[derive(Debug, Serialize)]
pub struct AcceptedShare {
    /// The site, secrets replaced by the stored-secret marker; connect it as usual.
    pub site: ConnectionConfig,
    /// Folder to open (empty: the site's own start folder).
    pub start_path: String,
    /// Host keys recorded for the server.
    pub host_keys_added: usize,
}

/// Uses an opened share: records the server's host keys it vouches for, then saves the
/// site in the vault (`save`) or keeps it for this run only. The window then connects
/// the returned site.
#[tauri::command]
pub async fn accept_connection_share(
    state: tauri::State<'_, AppState>,
    sharing: tauri::State<'_, SharingState>,
    token: String,
    save: bool,
) -> Result<AcceptedShare, String> {
    let shared = lock(&sharing.opened)
        .iter()
        .find(|(t, _)| *t == token)
        .map(|(_, s)| s.clone())
        .ok_or_else(|| {
            "[share.expired] This shared connection is no longer open. Open the file again."
                .to_string()
        })?;
    if save {
        ensure_vault_writable(&state)?;
    }

    let keys = shared.host_key_blobs();
    let (host, port) = (shared.site.host.clone(), shared.site.port);
    let host_keys_added = tokio::task::spawn_blocking(move || {
        HostKeyStore::for_current_user().trust_shared_keys(&host, port, &keys)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("[share.host_key_conflict] {e}"))?;

    let mut site = shared.site.clone();
    if save {
        site.id = normalize_site_id("");
        let mut sites = state.saved_sites.write().await;
        let mut updated = sites.clone();
        updated.push(site.clone());
        if rustscp_core::site_layout::dedupe_site_ids(&mut updated, &mut || normalize_site_id("")) {
            // The new row is last: if its id was taken, it got another one.
            if let Some(saved) = updated.last() {
                site.id = saved.id.clone();
            }
        }
        rustscp_core::vault::save_local_vault_async(updated.clone())
            .await
            .map_err(|e| e.to_string())?;
        *sites = updated;
    } else {
        site.id = format!(
            "shared-{}",
            &uuid::Uuid::new_v4().simple().to_string()[..12]
        );
        sharing
            .session_sites
            .write()
            .await
            .insert(site.id.clone(), site.clone());
    }
    lock(&sharing.opened).retain(|(t, _)| *t != token);

    Ok(AcceptedShare {
        site: redact_site(&site),
        start_path: shared.start_path,
        host_keys_added,
    })
}

/// Forgets an opened share (its preview was closed).
#[tauri::command]
pub fn discard_connection_share(sharing: tauri::State<'_, SharingState>, token: String) {
    lock(&sharing.opened).retain(|(t, _)| *t != token);
}

// ---------------------- FILES FROM THE OPERATING SYSTEM ----------------------

#[derive(Debug, Serialize)]
pub struct PendingShareFile {
    pub name: String,
    /// The file's text, or `None` when it could not be read (`error` says why).
    pub contents: Option<String>,
    pub error: Option<String>,
}

/// The `.rustscp` files the operating system asked RustSCP to open since the last call.
#[tauri::command]
pub fn take_pending_share_files(sharing: tauri::State<'_, SharingState>) -> Vec<PendingShareFile> {
    let paths: Vec<PathBuf> = std::mem::take(&mut *lock(&sharing.pending_files));
    paths
        .iter()
        .map(|path| {
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            match read_share_file(path) {
                Ok(contents) => PendingShareFile {
                    name,
                    contents: Some(contents),
                    error: None,
                },
                Err(e) => PendingShareFile {
                    name,
                    contents: None,
                    error: Some(e),
                },
            }
        })
        .collect()
}

pub(crate) fn is_share_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case(share::SHARE_FILE_EXTENSION))
}

fn read_share_file(path: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if !meta.is_file() || meta.len() > share::MAX_SHARE_FILE_BYTES as u64 {
        return Err(share_error(ShareError::NotAShare));
    }
    std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))
}

/// The `.rustscp` files among command-line arguments; relative ones are resolved
/// against `cwd` (the directory of the launch that passed them).
pub(crate) fn share_files_in_args<I, S>(args: I, cwd: Option<&Path>) -> Vec<PathBuf>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .filter_map(|arg| {
            let arg = arg.as_ref();
            if arg.starts_with('-') {
                return None;
            }
            let path = PathBuf::from(arg);
            if !is_share_file(&path) {
                return None;
            }
            Some(match cwd {
                Some(dir) if path.is_relative() => dir.join(path),
                _ => path,
            })
        })
        .collect()
}

/// Queues `.rustscp` files for the window, tells it, and brings it to the front.
pub fn receive_share_files(app: &AppHandle, paths: Vec<PathBuf>) {
    let paths: Vec<PathBuf> = paths.into_iter().filter(|p| is_share_file(p)).collect();
    if paths.is_empty() {
        return;
    }
    tracing::info!("received {} shared connection file(s)", paths.len());
    {
        let state = app.state::<SharingState>();
        let mut pending = lock(&state.pending_files);
        pending.extend(paths);
        let excess = pending.len().saturating_sub(MAX_PENDING_FILES);
        pending.drain(..excess);
    }
    // The window may still be loading: it also takes the queue when it starts.
    let _ = app.emit(SHARE_FILES_EVENT, ());
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

// ---------------------- LINUX APPIMAGE REGISTRATION ----------------------

/// An AppImage is never installed, so nothing told the desktop about `.rustscp` files:
/// on every start it writes (only when changed) the MIME type and a hidden launcher
/// that opens them with this AppImage, under `~/.local/share`. The `.deb` and `.rpm`
/// packages install the same MIME type system-wide instead.
#[cfg(target_os = "linux")]
pub fn register_linux_share_handler() {
    let Some(appimage) = std::env::var_os("APPIMAGE").filter(|v| !v.is_empty()) else {
        return;
    };
    let Some(data_dir) = std::env::var_os("XDG_DATA_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| rustscp_core::known_hosts::home_dir().map(|h| h.join(".local/share")))
    else {
        return;
    };
    let mime_xml = include_str!("../linux/rustscp-mime.xml");
    let desktop = format!(
        "[Desktop Entry]\nType=Application\nName=RustSCP\nComment=Open RustSCP shared connections\n\
         Exec={} %f\nIcon=rustscp-desktop\nTerminal=false\nNoDisplay=true\n\
         MimeType=application/x-rustscp;\n",
        desktop_exec_quote(&appimage.to_string_lossy())
    );
    let mime_dir = data_dir.join("mime");
    let apps_dir = data_dir.join("applications");
    let wrote_mime = write_if_changed(&mime_dir.join("packages/rustscp.xml"), mime_xml);
    let wrote_desktop = write_if_changed(&apps_dir.join("rustscp-share.desktop"), &desktop);
    let run = |cmd: &str, args: &[&std::ffi::OsStr]| {
        if let Err(e) = std::process::Command::new(cmd).args(args).output() {
            tracing::debug!("{cmd} unavailable: {e}");
        }
    };
    if wrote_mime {
        run("update-mime-database", &[mime_dir.as_os_str()]);
    }
    if wrote_desktop {
        run("update-desktop-database", &[apps_dir.as_os_str()]);
        run(
            "xdg-mime",
            &[
                "default".as_ref(),
                "rustscp-share.desktop".as_ref(),
                "application/x-rustscp".as_ref(),
            ],
        );
    }
}

#[cfg(target_os = "linux")]
fn write_if_changed(path: &Path, contents: &str) -> bool {
    if std::fs::read_to_string(path).is_ok_and(|old| old == contents) {
        return false;
    }
    let written = path
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|()| std::fs::write(path, contents));
    if let Err(e) = &written {
        tracing::warn!(
            "could not register .rustscp files ({}): {e}",
            path.display()
        );
    }
    written.is_ok()
}

/// One argument of a desktop entry's `Exec=` line, quoted per the Desktop Entry
/// specification.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn desktop_exec_quote(arg: &str) -> String {
    let mut out = String::with_capacity(arg.len() + 2);
    out.push('"');
    for c in arg.chars() {
        match c {
            '"' | '`' | '$' | '\\' => {
                out.push('\\');
                out.push(c);
            }
            '%' => out.push_str("%%"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_rustscp_files_are_taken_from_arguments() {
        let cwd = Path::new("/home/ana/Downloads");
        let args = [
            "/opt/RustSCP/rustscp-desktop",
            "--flag",
            "suporte.rustscp",
            "/tmp/Cliente X.RUSTSCP",
            "notes.txt",
            "-psn_0_12345",
        ];
        assert_eq!(
            share_files_in_args(args, Some(cwd)),
            vec![
                cwd.join("suporte.rustscp"),
                PathBuf::from("/tmp/Cliente X.RUSTSCP")
            ]
        );
        assert_eq!(
            share_files_in_args(["a.rustscp"], None),
            vec![PathBuf::from("a.rustscp")]
        );
    }

    #[test]
    fn share_files_are_read_with_limits() {
        let dir = tempfile::tempdir().unwrap();
        let ok = dir.path().join("a.rustscp");
        std::fs::write(&ok, "{}").unwrap();
        assert_eq!(read_share_file(&ok).unwrap(), "{}");
        let big = dir.path().join("big.rustscp");
        std::fs::write(&big, vec![b' '; share::MAX_SHARE_FILE_BYTES + 1]).unwrap();
        assert!(read_share_file(&big)
            .unwrap_err()
            .contains("share.not_a_share"));
        assert!(read_share_file(dir.path()).is_err());
        assert!(read_share_file(&dir.path().join("missing.rustscp")).is_err());
    }

    #[test]
    fn desktop_exec_arguments_are_quoted() {
        assert_eq!(
            desktop_exec_quote("/home/ana/Apps/RustSCP 1.0.AppImage"),
            "\"/home/ana/Apps/RustSCP 1.0.AppImage\""
        );
        assert_eq!(
            desktop_exec_quote("/a/$b\"c`d\\e%f"),
            "\"/a/\\$b\\\"c\\`d\\\\e%%f\""
        );
    }

    #[test]
    fn share_errors_carry_their_code() {
        assert!(share_error(ShareError::WrongCode).starts_with("[share.wrong_code] "));
    }
}

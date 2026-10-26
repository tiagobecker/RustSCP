//! Background transfer queue: copy or move files and folders between any two
//! sessions.
//!
//! Files are streamed chunk by chunk. When the destination supports
//! positional writes (`supports_write_at`: local, SFTP) every chunk is
//! written at its offset into a temporary sibling file
//! (`.<name>.rustscp-<task>.part`), so memory use stays at one chunk and the
//! existing destination file is untouched until the new copy is complete: the
//! temporary file is size-checked and then renamed over the destination.
//! Cancelling or failing only ever removes that temporary file. Other
//! destinations (S3, FTP) get the chunks collected and written with a single
//! `write_file` at the end. Progress counts the bytes actually read. A task is
//! `Completed` only after the destination size was checked, and a move deletes
//! its source only after that check.
//!
//! Safety rules:
//! - Before the first byte is written, a destination that is the source file
//!   itself under another path (symlinked folder, case-insensitive
//!   filesystem, two sessions on one server) is detected with a marker file
//!   and refused.
//! - Folder listings are not trusted: entry names that are not a single path
//!   component are refused, so a hostile server cannot make a download write
//!   outside the destination folder.
//! - Names that collide on a case-insensitive destination are refused
//!   instead of overwriting each other.
//! - The same destination (or the same move source) cannot be queued twice
//!   while a task for it is still active.

use crate::shell::sh_quote;
use crate::types::{CoreError, CoreResult, FileEntry, FileType, Protocol, TransferStatus};
use crate::vfs::{StreamId, VirtualFileSystem};
use bytes::{Bytes, BytesMut};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{RwLock, Semaphore};
use tokio::time::Instant;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueTransferTask {
    pub id: String,
    pub name: String,
    pub source_session: String,
    pub source_path: String,
    pub dest_session: String,
    pub dest_path: String,
    pub is_move: bool,
    pub total_bytes: u64,
    pub transferred_bytes: u64,
    pub status: TransferStatus,
    pub speed_bps: u64,
    pub error: Option<String>,
}

/// Chunk size range. The worker starts small (responsive progress on slow
/// links) and doubles while chunks finish quickly.
pub const MIN_CHUNK_SIZE: u64 = 256 * 1024;
pub const MAX_CHUNK_SIZE: u64 = 8 * 1024 * 1024;
/// Finished (completed/cancelled) tasks kept for the UI before the oldest are dropped.
const MAX_KEPT_TASKS: usize = 500;
/// Folder nesting limit for recursive transfers.
const MAX_TREE_DEPTH: usize = 64;
/// Preallocation cap when a destination needs the whole file in memory.
const MAX_PREALLOC: u64 = 64 * 1024 * 1024;

type Sessions = Arc<RwLock<HashMap<String, Arc<dyn VirtualFileSystem>>>>;

pub struct TransferQueueManager {
    tasks: Arc<RwLock<Vec<QueueTransferTask>>>,
    concurrency_semaphore: Arc<Semaphore>,
    is_paused: Arc<AtomicBool>,
    chunk_range: (u64, u64),
}

impl Default for TransferQueueManager {
    fn default() -> Self {
        Self::new(3)
    }
}

impl TransferQueueManager {
    pub fn new(max_concurrent: usize) -> Self {
        Self::with_chunk_range(max_concurrent, MIN_CHUNK_SIZE, MAX_CHUNK_SIZE)
    }

    /// Queue with a fixed chunk size (tests and tuning).
    pub fn with_chunk_size(max_concurrent: usize, chunk_size: u64) -> Self {
        Self::with_chunk_range(max_concurrent, chunk_size, chunk_size)
    }

    fn with_chunk_range(max_concurrent: usize, min: u64, max: u64) -> Self {
        let min = min.max(1);
        Self {
            tasks: Arc::new(RwLock::new(Vec::new())),
            concurrency_semaphore: Arc::new(Semaphore::new(max_concurrent.max(1))),
            is_paused: Arc::new(AtomicBool::new(false)),
            chunk_range: (min, max.max(min)),
        }
    }

    /// Hold queued tasks (running ones finish). They start again on `resume`.
    pub fn pause(&self) {
        self.is_paused.store(true, Ordering::SeqCst);
    }

    pub fn resume(&self) {
        self.is_paused.store(false, Ordering::SeqCst);
    }

    pub fn is_paused(&self) -> bool {
        self.is_paused.load(Ordering::SeqCst)
    }

    pub async fn enqueue(
        &self,
        source_session: String,
        source_path: String,
        dest_session: String,
        dest_path: String,
        is_move: bool,
        sessions: Sessions,
    ) -> String {
        let id = format!("tr-{}", uuid::Uuid::new_v4());
        let file_name = source_path
            .trim_end_matches(['/', '\\'])
            .rsplit(['/', '\\'])
            .next()
            .filter(|n| !n.is_empty())
            .unwrap_or(&source_path)
            .to_string();

        // Same session onto itself: fail right away, before any file is touched.
        let rejection = if source_session == dest_session {
            self_transfer_rejection(&source_path, &dest_path)
        } else {
            None
        };

        let rejected = {
            // Duplicate check and insert under one lock, so two identical
            // requests arriving together cannot both be queued.
            let mut list = self.tasks.write().await;
            let rejection = rejection.or_else(|| {
                duplicate_rejection(
                    &list,
                    &source_session,
                    &source_path,
                    &dest_session,
                    &dest_path,
                    is_move,
                )
            });
            let rejected = rejection.is_some();
            list.push(QueueTransferTask {
                id: id.clone(),
                name: file_name,
                source_session: source_session.clone(),
                source_path: source_path.clone(),
                dest_session: dest_session.clone(),
                dest_path: dest_path.clone(),
                is_move,
                total_bytes: 0,
                transferred_bytes: 0,
                status: if rejected {
                    TransferStatus::Failed
                } else {
                    TransferStatus::Queued
                },
                speed_bps: 0,
                error: rejection,
            });
            prune_finished(&mut list);
            rejected
        };
        if rejected {
            return id;
        }

        let tasks = self.tasks.clone();
        let sem = self.concurrency_semaphore.clone();
        let paused = self.is_paused.clone();
        let chunk_range = self.chunk_range;
        let task_id = id.clone();

        tokio::spawn(async move {
            // Paused: wait (cancellable) instead of stranding the task as Queued.
            while paused.load(Ordering::SeqCst) {
                if task_status(&tasks, &task_id).await != Some(TransferStatus::Queued) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }

            let _permit = match sem.acquire().await {
                Ok(p) => p,
                Err(_) => return,
            };

            // Mark InProgress unless cancelled while queued.
            {
                let mut list = tasks.write().await;
                match list.iter_mut().find(|x| x.id == task_id) {
                    Some(t) if t.status == TransferStatus::Queued => {
                        t.status = TransferStatus::InProgress;
                    }
                    _ => return,
                }
            }

            let (src, dst) = {
                let guard = sessions.read().await;
                (
                    guard.get(&source_session).cloned(),
                    guard.get(&dest_session).cloned(),
                )
            };

            let outcome = match (src, dst) {
                (Some(src), Some(dst)) => {
                    let mut job = Job {
                        tasks: tasks.clone(),
                        id: task_id.clone(),
                        tag: temp_tag(&task_id),
                        src,
                        dst,
                        same_session: source_session == dest_session,
                        is_move,
                        chunk_range,
                        started: Instant::now(),
                        transferred: 0,
                        alias_cache: HashMap::new(),
                    };
                    job.run(&source_path, &dest_path, is_move).await
                }
                _ => Outcome::Failed("Session disconnected".to_string()),
            };

            finalize(&tasks, &task_id, outcome).await;
        });

        id
    }

    pub async fn get_tasks(&self) -> Vec<QueueTransferTask> {
        let list = self.tasks.read().await;
        list.clone()
    }

    /// One task by id.
    pub async fn get_task(&self, id: &str) -> Option<QueueTransferTask> {
        let list = self.tasks.read().await;
        list.iter().find(|x| x.id == id).cloned()
    }

    /// Cancel a queued or running task. Finished tasks keep their status.
    pub async fn cancel_task(&self, id: &str) {
        let mut list = self.tasks.write().await;
        if let Some(t) = list.iter_mut().find(|x| x.id == id) {
            if matches!(
                t.status,
                TransferStatus::Queued | TransferStatus::InProgress | TransferStatus::Paused
            ) {
                t.status = TransferStatus::Cancelled;
                t.speed_bps = 0;
            }
        }
    }

    /// "Clear finished": drop completed, failed and cancelled tasks. Queued,
    /// running and paused tasks stay.
    pub async fn clear_completed(&self) {
        let mut list = self.tasks.write().await;
        list.retain(|x| !is_finished(x.status));
    }
}

fn is_finished(status: TransferStatus) -> bool {
    matches!(
        status,
        TransferStatus::Completed | TransferStatus::Failed | TransferStatus::Cancelled
    )
}

/// Why a new task would collide with one that is still queued or running:
/// the same destination (two writers on one file, and one task's cleanup
/// could remove the other's result), or, for a move, the same source (the
/// first move deletes what the second is still reading).
fn duplicate_rejection(
    list: &[QueueTransferTask],
    source_session: &str,
    source_path: &str,
    dest_session: &str,
    dest_path: &str,
    is_move: bool,
) -> Option<String> {
    let dest = normalize_for_compare(dest_path);
    let source = normalize_for_compare(source_path);
    for t in list.iter().filter(|t| !is_finished(t.status)) {
        if t.dest_session == dest_session && normalize_for_compare(&t.dest_path) == dest {
            return Some(format!(
                "Already queued: another transfer to '{}' is still in progress; nothing was transferred",
                dest_path
            ));
        }
        if is_move
            && t.is_move
            && t.source_session == source_session
            && normalize_for_compare(&t.source_path) == source
        {
            return Some(format!(
                "Already queued: '{}' is already being moved; nothing was transferred",
                source_path
            ));
        }
    }
    None
}

/// Drop the oldest completed/cancelled tasks once the list grows large.
/// Queued, running and failed tasks are always kept.
fn prune_finished(list: &mut Vec<QueueTransferTask>) {
    if list.len() <= MAX_KEPT_TASKS {
        return;
    }
    let mut excess = list.len() - MAX_KEPT_TASKS;
    list.retain(|t| {
        if excess > 0
            && matches!(
                t.status,
                TransferStatus::Completed | TransferStatus::Cancelled
            )
        {
            excess -= 1;
            false
        } else {
            true
        }
    });
}

async fn task_status(tasks: &RwLock<Vec<QueueTransferTask>>, id: &str) -> Option<TransferStatus> {
    tasks
        .read()
        .await
        .iter()
        .find(|x| x.id == id)
        .map(|t| t.status)
}

/// Write the final status, unless the user cancelled meanwhile.
async fn finalize(tasks: &RwLock<Vec<QueueTransferTask>>, id: &str, outcome: Outcome) {
    let mut list = tasks.write().await;
    let Some(t) = list.iter_mut().find(|x| x.id == id) else {
        return;
    };
    t.speed_bps = 0;
    if t.status != TransferStatus::InProgress {
        return;
    }
    match outcome {
        Outcome::Completed { note } => {
            t.status = TransferStatus::Completed;
            t.transferred_bytes = t.total_bytes.max(t.transferred_bytes);
            t.error = note;
        }
        Outcome::Failed(msg) => {
            t.status = TransferStatus::Failed;
            t.error = Some(msg);
        }
        Outcome::Cancelled => {
            t.status = TransferStatus::Cancelled;
        }
    }
}

enum Outcome {
    Completed { note: Option<String> },
    Failed(String),
    Cancelled,
}

enum CopyError {
    Cancelled,
    Failed(String),
}

/// How putting a temporary file in place of the destination went.
enum Commit {
    Done,
    /// Nothing changed: the server refused to rename or to replace.
    NotAllowed(String),
    /// The old file was removed, but the temporary file could not be renamed.
    OldRemoved(String),
}

struct Job {
    tasks: Arc<RwLock<Vec<QueueTransferTask>>>,
    id: String,
    /// Short unique token for this task's temporary and marker file names.
    tag: String,
    src: Arc<dyn VirtualFileSystem>,
    dst: Arc<dyn VirtualFileSystem>,
    same_session: bool,
    is_move: bool,
    chunk_range: (u64, u64),
    started: Instant,
    transferred: u64,
    /// (source folder, destination folder) -> what the marker probe found.
    alias_cache: HashMap<(String, String), DirAlias>,
}

/// Whether a source folder and a destination folder (paths in two sessions)
/// are the same folder on disk.
#[derive(Debug, Clone, Copy)]
struct DirAlias {
    same_dir: bool,
    /// Only meaningful with `same_dir`: names differing in case are one file.
    case_insensitive: bool,
}

/// Token for temporary file names: 12 hex digits of the task id.
fn temp_tag(task_id: &str) -> String {
    let hex: String = task_id.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    let tail = hex.len().saturating_sub(12);
    let tag = &hex[tail..];
    if tag.is_empty() {
        "0".to_string()
    } else {
        tag.to_ascii_lowercase()
    }
}

/// Parent (with its trailing separator, "" when there is none) and final
/// name of a path: "/a/b.txt" -> ("/a/", "b.txt"), "C:\\x\\f" -> ("C:\\x\\", "f").
fn split_name(path: &str) -> (&str, &str) {
    match path.rfind(['/', '\\']) {
        Some(i) => (&path[..=i], &path[i + 1..]),
        None => ("", path),
    }
}

/// Hidden sibling a positional destination is written to before it is
/// renamed over the real name. The visible name part is shortened so the
/// whole name stays below common 255-byte limits.
fn temp_file_name(name: &str, tag: &str) -> String {
    let mut short = String::new();
    for c in name.chars() {
        if short.len() + c.len_utf8() > 120 {
            break;
        }
        short.push(c);
    }
    format!(".{}.rustscp-{}.part", short, tag)
}

/// Empty marker file used to probe a destination folder.
fn probe_file_name(tag: &str) -> String {
    format!(".rustscp-probe-{}.tmp", tag)
}

/// The same name with the case of every ASCII letter swapped.
fn toggle_ascii_case(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_lowercase() {
                c.to_ascii_uppercase()
            } else if c.is_ascii_uppercase() {
                c.to_ascii_lowercase()
            } else {
                c
            }
        })
        .collect()
}

/// A folder entry name that must not be joined to a destination path: it is
/// not a single path component (a hostile server can list "../../.zshrc"),
/// or it is a name Windows would resolve to something else.
/// `backslash_is_separator` is false only where `\` is an ordinary
/// character (a local destination on a Unix client).
fn is_unsafe_entry_name(name: &str, backslash_is_separator: bool, windows_dest: bool) -> bool {
    if name.contains(['/', '\0']) || (backslash_is_separator && name.contains('\\')) {
        return true;
    }
    windows_dest && (name.contains(':') || name.chars().all(|c| c == '.' || c == ' '))
}

/// Is `child` strictly below `root` once `.`/`..` are resolved?
fn is_strictly_inside(child: &str, root: &str) -> bool {
    let root_n = normalize_for_compare(root);
    let child_n = normalize_for_compare(child);
    if root_n.is_empty() {
        // Relative root: lexical normalization cannot see an escape through
        // "..", so refuse any ".." component outright.
        return !child_n.is_empty() && !child.split(['/', '\\']).any(|p| p == "..");
    }
    child_n.starts_with(&format!("{}/", root_n.trim_end_matches('/')))
}

/// Key under which two destination paths are the same file on a
/// case-insensitive filesystem (Windows also ignores trailing dots/spaces).
fn case_fold_key(path: &str, windows_dest: bool) -> String {
    path.split(['/', '\\'])
        .map(|part| {
            let lower = part.to_lowercase();
            if windows_dest {
                lower.trim_end_matches(['.', ' ']).to_string()
            } else {
                lower
            }
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// `base` + `/` + `name` without doubling separators.
fn join_path(base: &str, name: &str) -> String {
    if base.is_empty() {
        name.to_string()
    } else if base.ends_with('/') || base.ends_with('\\') {
        format!("{}{}", base, name)
    } else {
        format!("{}/{}", base, name)
    }
}

/// Lexical normalization for comparing two paths of the same filesystem.
fn normalize_for_compare(path: &str) -> String {
    let unified = path.replace('\\', "/");
    let absolute = unified.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for part in unified.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            p => parts.push(p),
        }
    }
    let joined = parts.join("/");
    if absolute {
        format!("/{}", joined)
    } else {
        joined
    }
}

fn is_same_or_inside(candidate: &str, parent: &str) -> (bool, bool) {
    let c = normalize_for_compare(candidate);
    let p = normalize_for_compare(parent);
    let same = c == p;
    let inside = if p == "/" || p.is_empty() {
        !same
    } else {
        c.starts_with(&format!("{}/", p))
    };
    (same, inside)
}

/// Why a transfer within one session would overwrite itself: the same path,
/// or a destination inside the source (a folder copied into itself).
fn self_transfer_rejection(source: &str, dest: &str) -> Option<String> {
    match is_same_or_inside(dest, source) {
        (true, _) => {
            Some("Source and destination are the same; nothing was transferred".to_string())
        }
        (false, true) => Some(
            "A folder cannot be copied or moved into itself; nothing was transferred".to_string(),
        ),
        _ => None,
    }
}

impl Job {
    async fn is_cancelled(&self) -> bool {
        task_status(&self.tasks, &self.id).await == Some(TransferStatus::Cancelled)
    }

    async fn set_total(&self, total: u64) {
        let mut list = self.tasks.write().await;
        if let Some(t) = list.iter_mut().find(|x| x.id == self.id) {
            t.total_bytes = total;
        }
    }

    async fn add_progress(&mut self, n: u64) {
        self.transferred = self.transferred.saturating_add(n);
        let elapsed = self.started.elapsed().as_secs_f64();
        let speed = if elapsed > 0.1 {
            (self.transferred as f64 / elapsed) as u64
        } else {
            0
        };
        let mut list = self.tasks.write().await;
        if let Some(t) = list.iter_mut().find(|x| x.id == self.id) {
            t.transferred_bytes = self.transferred;
            t.speed_bps = speed;
        }
    }

    /// Source and destination are the same filesystem (same session, or two
    /// local sessions), so identical paths are the same file.
    fn same_filesystem(&self) -> bool {
        self.same_session
            || (self.src.protocol() == Protocol::Local && self.dst.protocol() == Protocol::Local)
    }

    async fn run(&mut self, source_path: &str, dest_path: &str, is_move: bool) -> Outcome {
        let meta = match self.src.metadata(source_path).await {
            Ok(m) => Some(m),
            Err(e) => {
                // Object stores have no metadata for "folders": accept a
                // path that lists as a directory.
                if self.src.list_dir(source_path).await.is_ok() {
                    None
                } else {
                    return Outcome::Failed(format!("Cannot read '{}': {}", source_path, e));
                }
            }
        };
        let is_dir = meta.as_ref().map(FileEntry::is_dir).unwrap_or(true);

        if self.same_filesystem() {
            let (same, inside) = is_same_or_inside(dest_path, source_path);
            if same {
                return Outcome::Failed(
                    "Source and destination are the same; nothing was transferred".to_string(),
                );
            }
            if is_dir && inside {
                return Outcome::Failed(
                    "A folder cannot be copied or moved into itself".to_string(),
                );
            }
        }

        if self.same_session {
            if let Some(outcome) = self
                .server_side_transfer(meta.as_ref(), source_path, dest_path, is_move)
                .await
            {
                return outcome;
            }
        }

        match meta {
            Some(m) if !m.is_dir() => {
                if m.file_type == FileType::Other {
                    return Outcome::Failed(format!(
                        "'{}' is not a regular file (device, socket or pipe)",
                        source_path
                    ));
                }
                self.transfer_file(source_path, dest_path, m.size, is_move)
                    .await
            }
            _ => {
                // `metadata` follows links, so a link to a folder looks like
                // the folder. A move must then not empty the folder it
                // points to: only the link itself is removed afterwards.
                // Object stores have no links (and huge parent listings).
                let root_is_link = is_move
                    && self.src.protocol() != Protocol::S3
                    && self.is_symlink(source_path).await;
                self.transfer_dir(source_path, dest_path, is_move, root_is_link)
                    .await
            }
        }
    }

    /// Is `path` itself a symbolic link? The VFS has no lstat, so look the
    /// entry up in its parent folder's listing (listings do not follow links).
    async fn is_symlink(&self, path: &str) -> bool {
        let trimmed = path.trim_end_matches(['/', '\\']);
        let (parent, name) = split_name(trimmed);
        if name.is_empty() || name == "." || name == ".." {
            return false;
        }
        let parent = if parent.is_empty() { "." } else { parent };
        match self.src.list_dir(parent).await {
            Ok(entries) => entries.iter().any(|e| e.name == name && e.is_symlink()),
            Err(e) => {
                tracing::debug!(
                    "Could not list '{}' to check whether '{}' is a link: {}",
                    parent,
                    path,
                    e
                );
                false
            }
        }
    }

    /// Same session: rename, or `mv`/`cp` on the server (no data through
    /// this machine). Returns None to fall back to streaming only when no
    /// server-side command ran (no shell, a `cp` that failed, or a result
    /// that could not be verified). A move whose rename and `mv` both fail is
    /// reported as failed, never streamed and deleted, and so is a command
    /// that may still be running on the server (time limit, lost connection).
    async fn server_side_transfer(
        &mut self,
        meta: Option<&FileEntry>,
        source_path: &str,
        dest_path: &str,
        is_move: bool,
    ) -> Option<Outcome> {
        let file_size = meta.filter(|m| !m.is_dir()).map(|m| m.size);
        self.set_total(file_size.unwrap_or(0)).await;

        let mut rename_error = String::new();
        if is_move {
            match self.src.rename(source_path, dest_path).await {
                Ok(()) => {
                    self.add_progress(file_size.unwrap_or(0)).await;
                    return Some(Outcome::Completed { note: None });
                }
                Err(e) => rename_error = e.to_string(),
            }
        }

        // cmd.exe has no mv/cp: local Windows sessions stream instead.
        let windows_local = cfg!(windows) && self.src.protocol() == Protocol::Local;
        if !self.src.supports_shell() || windows_local {
            return None;
        }
        // `mv`/`cp` put the source *inside* an existing folder: let the
        // streaming path merge (or fail on a file) instead.
        if matches!(self.dst.metadata(dest_path).await, Ok(m) if m.is_dir()) {
            return None;
        }
        let cmd = if is_move {
            format!("mv -f -- {} {}", sh_quote(source_path), sh_quote(dest_path))
        } else {
            format!(
                "cp -a -r -- {} {}",
                sh_quote(source_path),
                sh_quote(dest_path)
            )
        };
        match self.src.execute_command(&cmd).await {
            Ok((0, _, _)) => {
                // Exit code 0 alone is not proof (an SFTP-only account runs
                // nothing and exits 0): check the result.
                let dest_ok = match file_size {
                    Some(size) => {
                        matches!(self.dst.metadata(dest_path).await, Ok(m) if m.size == size)
                    }
                    None => self.dst.exists(dest_path).await.unwrap_or(false),
                };
                let source_gone = !is_move || !self.src.exists(source_path).await.unwrap_or(true);
                if dest_ok && source_gone {
                    self.add_progress(file_size.unwrap_or(0)).await;
                    return Some(Outcome::Completed { note: None });
                }
                tracing::warn!(
                    "Server-side {} of '{}' reported success but could not be verified; streaming instead",
                    if is_move { "move" } else { "copy" },
                    source_path
                );
                None
            }
            Ok((code, _, stderr)) if is_move => {
                let stderr: String = stderr.trim().chars().take(300).collect();
                Some(Outcome::Failed(format!(
                    "Could not move '{}': rename failed ({}) and mv exited with code {}{}{}. \
                     Nothing was copied or deleted by RustSCP",
                    source_path,
                    rename_error,
                    code,
                    if stderr.is_empty() { "" } else { ": " },
                    stderr
                )))
            }
            Ok((code, _, stderr)) => {
                tracing::debug!(
                    "Server-side copy failed (exit {}): {}; streaming instead",
                    code,
                    stderr.trim()
                );
                None
            }
            // `Protocol`: the command was never run (no shell, or the
            // connection failed before it started), so streaming is safe.
            Err(CoreError::Protocol(msg)) => {
                tracing::debug!(
                    "Server-side transfer unavailable: {}; streaming instead",
                    msg
                );
                None
            }
            // Anything else (time limit, connection lost while it ran) may
            // leave the command running on the server: streaming now would
            // race with it, and a move would delete files it is still
            // moving.
            Err(e) => Some(Outcome::Failed(format!(
                "The server-side {} of '{}' did not report completion ({}). It may still be \
                 running on the server; RustSCP did not stream or delete anything. Refresh the \
                 folder and check the result before trying again",
                if is_move { "move" } else { "copy" },
                source_path,
                e
            ))),
        }
    }

    async fn transfer_file(
        &mut self,
        source_path: &str,
        dest_path: &str,
        size: u64,
        is_move: bool,
    ) -> Outcome {
        self.set_total(size).await;
        match self.copy_file(source_path, dest_path, size).await {
            Err(CopyError::Cancelled) => Outcome::Cancelled,
            Err(CopyError::Failed(msg)) => Outcome::Failed(msg),
            Ok(()) => {
                if is_move {
                    if self.is_cancelled().await {
                        return Outcome::Cancelled;
                    }
                    // Check again right before deleting: the source goes
                    // only while its verified copy is really there.
                    if !self.dest_has_size(dest_path, size).await {
                        return Outcome::Failed(format!(
                            "'{}' was copied, but the copy no longer has the expected size of {} \
                             bytes; the source was not deleted",
                            dest_path, size
                        ));
                    }
                    if let Err(e) = self.src.remove_file(source_path).await {
                        return Outcome::Failed(format!(
                            "Copied and verified, but the source could not be deleted: {}",
                            e
                        ));
                    }
                }
                Outcome::Completed { note: None }
            }
        }
    }

    async fn dest_has_size(&self, path: &str, size: u64) -> bool {
        matches!(self.dst.metadata(path).await, Ok(m) if !m.is_dir() && m.size == size)
    }

    /// Remove a file this task wrote (best effort): its temporary file, a
    /// marker, or a whole-file destination that failed its size check.
    async fn discard_partial(&self, path: &str) {
        if let Err(e) = self.dst.remove_file(path).await {
            tracing::debug!("Could not remove partial file '{}': {}", path, e);
        }
    }

    /// Create an empty file on the destination (positional or whole-file).
    async fn create_empty(&self, path: &str) -> CoreResult<()> {
        if self.dst.supports_write_at() {
            self.dst.write_at(path, 0, Bytes::new()).await
        } else {
            self.dst.write_file(path, Bytes::new()).await
        }
    }

    /// With the marker `marker_name` just created in a destination folder,
    /// is `src_dir` (source session) that same folder, and is it
    /// case-insensitive?
    async fn probe_alias(&self, src_dir: &str, marker_name: &str) -> DirAlias {
        let seen = |r: CoreResult<bool>| matches!(r, Ok(true));
        let same_dir = seen(
            self.src
                .exists(&format!("{}{}", src_dir, marker_name))
                .await,
        );
        let case_insensitive = if same_dir {
            let toggled = toggle_ascii_case(marker_name);
            toggled != marker_name
                && seen(self.src.exists(&format!("{}{}", src_dir, toggled)).await)
        } else {
            false
        };
        DirAlias {
            same_dir,
            case_insensitive,
        }
    }

    /// Refuse a destination that is the source file itself under another
    /// path (symlinked folder, case-insensitive filesystem, two sessions on
    /// one server): rewriting it would destroy the source, and a move would
    /// then delete its own result. A marker in the destination folder (the
    /// task's temporary file when `temp_marker` is given, else a probe file)
    /// is looked up from the source session, once per pair of folders.
    async fn check_not_same_file(
        &mut self,
        source_path: &str,
        dest_path: &str,
        temp_marker: Option<&str>,
    ) -> Result<(), CopyError> {
        let (src_dir, src_name) = split_name(source_path);
        let (dst_dir, dst_name) = split_name(dest_path);
        // Different names are different folder entries (a link or hard link
        // under another name is replaced, never written through).
        if src_name.to_lowercase() != dst_name.to_lowercase() {
            return Ok(());
        }
        let key = (src_dir.to_string(), dst_dir.to_string());
        let alias = match self.alias_cache.get(&key) {
            Some(a) => *a,
            None => {
                let alias = match temp_marker {
                    Some(temp) => self.probe_alias(src_dir, split_name(temp).1).await,
                    None => {
                        let name = probe_file_name(&self.tag);
                        let marker = format!("{}{}", dst_dir, name);
                        if let Err(e) = self.create_empty(&marker).await {
                            // Unknown; the write itself reports its own error.
                            tracing::debug!("Could not create probe file '{}': {}", marker, e);
                            return Ok(());
                        }
                        let alias = self.probe_alias(src_dir, &name).await;
                        self.discard_partial(&marker).await;
                        alias
                    }
                };
                self.alias_cache.insert(key, alias);
                alias
            }
        };
        if alias.same_dir && (src_name == dst_name || alias.case_insensitive) {
            return Err(CopyError::Failed(format!(
                "Source and destination are the same file ('{}' and '{}'); nothing was transferred",
                source_path, dest_path
            )));
        }
        Ok(())
    }

    /// Last-resort guard when no marker can be created next to the
    /// destination (a writable file in a folder that allows no new files):
    /// same name (ignoring case), size and modification time as the source
    /// is treated as the source itself.
    async fn guard_in_place_same_file(
        &self,
        source_path: &str,
        dest_path: &str,
        existing: &FileEntry,
    ) -> Result<(), CopyError> {
        let src_name = split_name(source_path).1.to_lowercase();
        let dst_name = split_name(dest_path).1.to_lowercase();
        if src_name != dst_name {
            return Ok(());
        }
        if let Ok(src) = self.src.metadata(source_path).await {
            if src.size == existing.size
                && src.modified_at.is_some()
                && src.modified_at == existing.modified_at
            {
                return Err(CopyError::Failed(format!(
                    "'{}' appears to be the source file itself (same name, size and time as '{}'); \
                     nothing was transferred",
                    dest_path, source_path
                )));
            }
        }
        Ok(())
    }

    /// Put a complete, verified temporary file in place of `dest_path`.
    async fn commit_temp(&self, temp_path: &str, dest_path: &str) -> Commit {
        let first = match self.dst.rename(temp_path, dest_path).await {
            Ok(()) => return Commit::Done,
            Err(e) => e,
        };
        // SFTP v3 servers (OpenSSH) refuse to rename onto an existing file:
        // replace it explicitly.
        if !matches!(self.dst.exists(dest_path).await, Ok(true)) {
            return Commit::NotAllowed(format!("renaming the new copy failed: {}", first));
        }
        if let Err(e) = self.dst.remove_file(dest_path).await {
            return Commit::NotAllowed(format!(
                "renaming the new copy failed ({}) and removing the old file failed ({})",
                first, e
            ));
        }
        match self.dst.rename(temp_path, dest_path).await {
            Ok(()) => Commit::Done,
            Err(e) => Commit::OldRemoved(e.to_string()),
        }
    }

    /// Stream `source_path` into `target` on the destination (positional
    /// writes) and check its size. On failure or cancel, `target` is removed
    /// when it is `owned` by this task or this call wrote into it.
    async fn stream_verified(
        &mut self,
        source_path: &str,
        target: &str,
        shown_as: &str,
        expected: u64,
        owned: bool,
    ) -> Result<(), CopyError> {
        // The drivers may keep both files open from one chunk to the next; both
        // streams are ended before the size check, the rename or a cleanup.
        let (read, write) = (StreamId::new(), StreamId::new());
        let copied = self
            .stream_chunks(source_path, target, shown_as, expected, owned, read, write)
            .await;
        let copied = match copied {
            Ok(()) => {
                let _ = self.src.finish_stream(read).await;
                // Some servers only store a written file once it is closed.
                self.dst.finish_stream(write).await.map_err(|e| {
                    (
                        CopyError::Failed(format!("Write failed for '{}': {}", shown_as, e)),
                        true,
                    )
                })
            }
            Err(failed) => {
                self.src.abandon_stream(read).await;
                let _ = self.dst.finish_stream(write).await;
                Err(failed)
            }
        };
        if let Err((e, discard)) = copied {
            if discard {
                self.discard_partial(target).await;
            }
            return Err(e);
        }

        match self.dst.metadata(target).await {
            Ok(m) if m.size == expected => Ok(()),
            Ok(m) => {
                self.discard_partial(target).await;
                Err(CopyError::Failed(format!(
                    "Size check failed for '{}': {} bytes expected, {} written",
                    shown_as, expected, m.size
                )))
            }
            Err(e) => {
                if owned {
                    self.discard_partial(target).await;
                }
                Err(CopyError::Failed(format!(
                    "Could not verify '{}' after writing it: {}",
                    shown_as, e
                )))
            }
        }
    }

    /// The chunk loop of [`stream_verified`](Self::stream_verified). An error
    /// says whether `target` is to be removed.
    #[allow(clippy::too_many_arguments)]
    async fn stream_chunks(
        &mut self,
        source_path: &str,
        target: &str,
        shown_as: &str,
        expected: u64,
        owned: bool,
        read: StreamId,
        write: StreamId,
    ) -> Result<(), (CopyError, bool)> {
        let (min_chunk, max_chunk) = self.chunk_range;
        let mut chunk = min_chunk;
        let mut offset = 0u64;
        let mut wrote_any = false;

        if expected == 0 {
            if let Err(e) = self.dst.write_at(target, 0, Bytes::new()).await {
                return Err((
                    CopyError::Failed(format!("Cannot create '{}': {}", shown_as, e)),
                    owned,
                ));
            }
            wrote_any = true;
        }

        while offset < expected {
            if self.is_cancelled().await {
                return Err((CopyError::Cancelled, owned || wrote_any));
            }

            let want = chunk.min(expected - offset);
            let step_started = Instant::now();
            let data = match self
                .src
                .read_range_in(read, source_path, offset, want)
                .await
            {
                Ok(d) => d,
                Err(e) if offset == 0 => {
                    // Driver without ranged reads: read the whole file once.
                    match self.src.read_file(source_path).await {
                        Ok(all) if all.len() as u64 == expected => all,
                        other => {
                            return Err((
                                CopyError::Failed(match other {
                                    Ok(all) => format!(
                                        "The source changed during the transfer ({} bytes expected, {} read)",
                                        expected,
                                        all.len()
                                    ),
                                    Err(_) => {
                                        format!("Read failed for '{}': {}", source_path, e)
                                    }
                                }),
                                owned,
                            ));
                        }
                    }
                }
                Err(e) => {
                    return Err((
                        CopyError::Failed(format!(
                            "Read failed at byte {} of '{}': {}",
                            offset, source_path, e
                        )),
                        owned || wrote_any,
                    ));
                }
            };

            if data.is_empty() {
                return Err((
                    CopyError::Failed(format!(
                        "'{}' ended after {} of {} bytes (was it changed during the transfer?)",
                        source_path, offset, expected
                    )),
                    owned || wrote_any,
                ));
            }
            let data = if data.len() as u64 > expected - offset {
                data.slice(..(expected - offset) as usize)
            } else {
                data
            };
            let n = data.len() as u64;

            if let Err(e) = self.dst.write_at_in(write, target, offset, data).await {
                // Only remove what this task owns or wrote: if the first
                // write into an existing file fails (e.g. it is read-only),
                // that file is left alone.
                return Err((
                    CopyError::Failed(format!(
                        "Write failed at byte {} of '{}': {}",
                        offset, shown_as, e
                    )),
                    owned || wrote_any,
                ));
            }
            wrote_any = true;

            offset += n;
            self.add_progress(n).await;

            let took = step_started.elapsed();
            if took < Duration::from_millis(500) {
                chunk = (chunk.saturating_mul(2)).min(max_chunk);
            } else if took > Duration::from_secs(2) {
                chunk = (chunk / 2).max(min_chunk);
            }
        }
        Ok(())
    }

    /// Whole-file destinations (S3, FTP): read everything, write once, check.
    async fn copy_file_whole(
        &mut self,
        source_path: &str,
        dest_path: &str,
        expected: u64,
    ) -> Result<(), CopyError> {
        // A copy onto itself rewrites identical bytes; a move, which deletes
        // the source afterwards, must not target the source itself.
        if self.is_move {
            self.check_not_same_file(source_path, dest_path, None)
                .await?;
        }
        let read = StreamId::new();
        let collected = self.read_chunks(source_path, expected, read).await;
        match &collected {
            Ok(_) => {
                let _ = self.src.finish_stream(read).await;
            }
            Err(_) => self.src.abandon_stream(read).await,
        }
        let buf = collected?;

        if self.is_cancelled().await {
            return Err(CopyError::Cancelled);
        }
        if let Err(e) = self.dst.write_file(dest_path, buf.freeze()).await {
            return Err(CopyError::Failed(format!(
                "Write failed for '{}': {}",
                dest_path, e
            )));
        }
        match self.dst.metadata(dest_path).await {
            Ok(m) if m.size == expected => Ok(()),
            Ok(m) => {
                self.discard_partial(dest_path).await;
                Err(CopyError::Failed(format!(
                    "Size check failed for '{}': {} bytes expected, {} written",
                    dest_path, expected, m.size
                )))
            }
            Err(e) => Err(CopyError::Failed(format!(
                "Could not verify '{}' after writing it: {}",
                dest_path, e
            ))),
        }
    }

    /// The source of [`copy_file_whole`](Self::copy_file_whole), read chunk by
    /// chunk as `read`.
    async fn read_chunks(
        &mut self,
        source_path: &str,
        expected: u64,
        read: StreamId,
    ) -> Result<BytesMut, CopyError> {
        let (min_chunk, max_chunk) = self.chunk_range;
        let mut chunk = min_chunk;
        let mut offset = 0u64;
        let mut buf = BytesMut::with_capacity(expected.min(MAX_PREALLOC) as usize);

        while offset < expected {
            if self.is_cancelled().await {
                return Err(CopyError::Cancelled);
            }
            let want = chunk.min(expected - offset);
            let step_started = Instant::now();
            let data = match self
                .src
                .read_range_in(read, source_path, offset, want)
                .await
            {
                Ok(d) => d,
                Err(e) if offset == 0 => match self.src.read_file(source_path).await {
                    Ok(all) if all.len() as u64 == expected => all,
                    Ok(all) => {
                        return Err(CopyError::Failed(format!(
                            "The source changed during the transfer ({} bytes expected, {} read)",
                            expected,
                            all.len()
                        )))
                    }
                    Err(_) => {
                        return Err(CopyError::Failed(format!(
                            "Read failed for '{}': {}",
                            source_path, e
                        )))
                    }
                },
                Err(e) => {
                    return Err(CopyError::Failed(format!(
                        "Read failed at byte {} of '{}': {}",
                        offset, source_path, e
                    )))
                }
            };
            if data.is_empty() {
                return Err(CopyError::Failed(format!(
                    "'{}' ended after {} of {} bytes (was it changed during the transfer?)",
                    source_path, offset, expected
                )));
            }
            let data = if data.len() as u64 > expected - offset {
                data.slice(..(expected - offset) as usize)
            } else {
                data
            };
            let n = data.len() as u64;
            buf.extend_from_slice(&data);
            offset += n;
            self.add_progress(n).await;

            let took = step_started.elapsed();
            if took < Duration::from_millis(500) {
                chunk = (chunk.saturating_mul(2)).min(max_chunk);
            } else if took > Duration::from_secs(2) {
                chunk = (chunk / 2).max(min_chunk);
            }
        }
        Ok(buf)
    }

    /// Copy one file and verify the result.
    ///
    /// On positional destinations a new file is written directly (nothing
    /// to protect, and folders that allow uploads but no renames keep
    /// working). An existing file is replaced through a temporary sibling
    /// that takes its place only once it is complete and size-checked, so a
    /// cancelled or failed transfer leaves the old file untouched, and a
    /// destination that is the source itself under another path is refused
    /// before anything is written.
    async fn copy_file(
        &mut self,
        source_path: &str,
        dest_path: &str,
        expected: u64,
    ) -> Result<(), CopyError> {
        if !self.dst.supports_write_at() {
            return self.copy_file_whole(source_path, dest_path, expected).await;
        }

        let existing = match self.dst.metadata(dest_path).await {
            Ok(m) => m,
            // Not there: it cannot be the source, so write it directly.
            Err(_) => {
                return self
                    .stream_verified(source_path, dest_path, dest_path, expected, false)
                    .await
            }
        };
        if existing.is_dir() {
            return Err(CopyError::Failed(format!(
                "Write failed for '{}': a folder with that name exists",
                dest_path
            )));
        }
        if existing.permissions.readonly {
            return Err(CopyError::Failed(format!(
                "Write failed for '{}': the existing file is read-only and was left unchanged",
                dest_path
            )));
        }

        let (dst_dir, dst_name) = split_name(dest_path);
        let temp_path = format!("{}{}", dst_dir, temp_file_name(dst_name, &self.tag));
        if let Err(e) = self.dst.write_at(&temp_path, 0, Bytes::new()).await {
            // The folder allows no new files but the file itself may be
            // writable: overwrite it in place.
            tracing::debug!(
                "Cannot create '{}' ({}); overwriting '{}' in place",
                temp_path,
                e,
                dest_path
            );
            self.discard_partial(&temp_path).await;
            self.guard_in_place_same_file(source_path, dest_path, &existing)
                .await?;
            return self
                .stream_verified(source_path, dest_path, dest_path, expected, false)
                .await;
        }
        if let Err(e) = self
            .check_not_same_file(source_path, dest_path, Some(&temp_path))
            .await
        {
            self.discard_partial(&temp_path).await;
            return Err(e);
        }

        self.stream_verified(source_path, &temp_path, dest_path, expected, true)
            .await?;
        if self.is_cancelled().await {
            self.discard_partial(&temp_path).await;
            return Err(CopyError::Cancelled);
        }
        // Keep the replaced file's permission bits (not setuid/setgid).
        if self.dst.supports_permissions() {
            let mode = existing.permissions.mode & 0o777;
            if let Err(e) = self.dst.set_permissions(&temp_path, mode).await {
                tracing::debug!(
                    "Could not carry the permissions of '{}' over: {}",
                    dest_path,
                    e
                );
            }
        }

        match self.commit_temp(&temp_path, dest_path).await {
            Commit::Done => Ok(()),
            Commit::NotAllowed(why) => {
                // The server allows new files but no rename/replace: write
                // into the existing file like a plain overwrite.
                tracing::warn!(
                    "Could not replace '{}' through a temporary file ({}); overwriting it in place",
                    dest_path,
                    why
                );
                self.discard_partial(&temp_path).await;
                self.transferred = self.transferred.saturating_sub(expected);
                self.stream_verified(source_path, dest_path, dest_path, expected, false)
                    .await
            }
            Commit::OldRemoved(why) => {
                // The old file is gone and the new copy could not be renamed:
                // write the destination directly, keeping the complete
                // temporary copy until that worked.
                self.transferred = self.transferred.saturating_sub(expected);
                match self
                    .stream_verified(source_path, dest_path, dest_path, expected, false)
                    .await
                {
                    Ok(()) => {
                        self.discard_partial(&temp_path).await;
                        Ok(())
                    }
                    Err(CopyError::Cancelled) => Err(CopyError::Cancelled),
                    Err(CopyError::Failed(msg)) => Err(CopyError::Failed(format!(
                        "The old '{}' was removed, but the new copy could not be renamed into \
                         place ({}) or written directly ({}); the complete copy was kept as '{}'",
                        dest_path, why, msg, temp_path
                    ))),
                }
            }
        }
    }

    /// Does the destination folder treat names that differ only in case as
    /// the same file? None when the probe file cannot be created.
    async fn dest_case_insensitive(&self, dir: &str) -> Option<bool> {
        let name = probe_file_name(&self.tag);
        let marker = join_path(dir, &name);
        if let Err(e) = self.create_empty(&marker).await {
            tracing::debug!("Could not create probe file '{}': {}", marker, e);
            return None;
        }
        let toggled = join_path(dir, &toggle_ascii_case(&name));
        let result = self.dst.exists(&toggled).await.ok();
        self.discard_partial(&marker).await;
        result
    }

    /// Copy (or move) a folder tree: create folders, stream every file,
    /// aggregate progress. A move deletes sources only if everything was
    /// copied and verified. With `root_is_link` (the selected item is a link
    /// to a folder) a move removes only the link, never the folder's files.
    async fn transfer_dir(
        &mut self,
        source_root: &str,
        dest_root: &str,
        is_move: bool,
        root_is_link: bool,
    ) -> Outcome {
        let local_dest = self.dst.protocol() == Protocol::Local;
        let windows_dest = local_dest && cfg!(windows);
        // `\` is an ordinary character only on a local Unix destination.
        let backslash_is_separator = !local_dest || cfg!(windows);

        // 1. Plan the tree.
        let mut dirs: Vec<(String, String)> =
            vec![(source_root.to_string(), dest_root.to_string())];
        let mut files: Vec<(String, String, u64)> = Vec::new();
        let mut failures: Vec<String> = Vec::new();
        let mut refused = 0usize;
        let mut skipped_links = 0usize;
        let mut skipped_special = 0usize;
        let mut stack = vec![(source_root.to_string(), dest_root.to_string(), 0usize)];

        while let Some((sdir, ddir, depth)) = stack.pop() {
            if self.is_cancelled().await {
                return Outcome::Cancelled;
            }
            let entries = match self.src.list_dir(&sdir).await {
                Ok(e) => e,
                Err(e) => {
                    if depth == 0 {
                        return Outcome::Failed(format!("Cannot list '{}': {}", sdir, e));
                    }
                    failures.push(format!("{}: {}", sdir, e));
                    continue;
                }
            };
            for entry in entries {
                if entry.name.is_empty() || entry.name == "." || entry.name == ".." {
                    continue;
                }
                // Never trust a listing: a name that is not one path
                // component would read and write outside the folders.
                if is_unsafe_entry_name(&entry.name, backslash_is_separator, windows_dest) {
                    refused += 1;
                    failures.push(format!(
                        "{}: unsafe name {:?} in the folder listing; it was not transferred",
                        sdir, entry.name
                    ));
                    continue;
                }
                let child_src = join_path(&sdir, &entry.name);
                let child_dst = join_path(&ddir, &entry.name);
                if !is_strictly_inside(&child_dst, dest_root) {
                    refused += 1;
                    failures.push(format!(
                        "{}: {:?} would be written outside '{}'; it was not transferred",
                        sdir, entry.name, dest_root
                    ));
                    continue;
                }
                let was_link = entry.is_symlink();
                let resolved = if was_link {
                    match self.src.metadata(&child_src).await {
                        Ok(m) => m,
                        Err(_) => {
                            skipped_links += 1; // dangling link
                            continue;
                        }
                    }
                } else {
                    entry
                };
                if resolved.is_dir() {
                    if was_link {
                        // Never follow links to folders (cycles, escaping the tree).
                        skipped_links += 1;
                        continue;
                    }
                    if depth + 1 > MAX_TREE_DEPTH {
                        failures.push(format!("{}: folders nested too deeply", child_src));
                        continue;
                    }
                    dirs.push((child_src.clone(), child_dst.clone()));
                    stack.push((child_src, child_dst, depth + 1));
                } else if resolved.file_type == FileType::Other {
                    skipped_special += 1;
                } else {
                    files.push((child_src, child_dst, resolved.size));
                }
            }
        }

        // 2. Folders, parents first (discovery order).
        for (i, (_, d)) in dirs.iter().enumerate() {
            if let Err(e) = self.dst.create_dir(d).await {
                if i == 0 {
                    return Outcome::Failed(format!("Cannot create folder '{}': {}", d, e));
                }
                failures.push(format!("{}: {}", d, e));
            }
        }

        // 3. Names that are one file on a case-insensitive destination
        // (README and readme) would overwrite each other: keep the first,
        // refuse the others.
        let mut seen: HashMap<String, &str> = HashMap::new();
        for (_, d) in &dirs {
            seen.entry(case_fold_key(d, windows_dest))
                .or_insert(d.as_str());
        }
        let mut colliding = std::collections::HashSet::new();
        for (i, (_, d, _)) in files.iter().enumerate() {
            match seen.get(&case_fold_key(d, windows_dest)) {
                Some(existing) if *existing != d.as_str() => {
                    colliding.insert(i);
                }
                Some(_) => {}
                None => {
                    seen.insert(case_fold_key(d, windows_dest), d.as_str());
                }
            }
        }
        let refuse_collisions = !colliding.is_empty()
            && (windows_dest || self.dest_case_insensitive(dest_root).await.unwrap_or(true));
        drop(seen);
        if refuse_collisions {
            let planned = std::mem::take(&mut files);
            for (i, f) in planned.into_iter().enumerate() {
                if colliding.contains(&i) {
                    refused += 1;
                    failures.push(format!(
                        "{}: its name collides with another item in '{}' on this \
                         case-insensitive destination; it was not transferred",
                        f.0,
                        split_name(&f.1).0
                    ));
                } else {
                    files.push(f);
                }
            }
        }

        let total: u64 = files.iter().map(|f| f.2).sum();
        self.set_total(total).await;

        // 4. Files.
        let mut copied: Vec<String> = Vec::with_capacity(files.len());
        for (s, d, size) in &files {
            match self.copy_file(s, d, *size).await {
                Ok(()) => copied.push(s.clone()),
                Err(CopyError::Cancelled) => return Outcome::Cancelled,
                Err(CopyError::Failed(msg)) => failures.push(msg),
            }
        }

        if !failures.is_empty() {
            return Outcome::Failed(format!(
                "{} of {} items failed{}. First error: {}",
                failures.len(),
                files.len() + dirs.len() + refused,
                if is_move {
                    "; nothing was deleted from the source"
                } else {
                    ""
                },
                failures[0]
            ));
        }

        let mut notes = Vec::new();
        if skipped_links > 0 {
            notes.push(format!(
                "{} symbolic link(s) to folders or missing targets were skipped",
                skipped_links
            ));
        }
        if skipped_special > 0 {
            notes.push(format!(
                "{} special file(s) (devices, sockets, pipes) were skipped",
                skipped_special
            ));
        }

        // 5. Move: every file was verified, now delete the sources. Folders
        // are removed bottom-up and only when empty.
        if is_move {
            if self.is_cancelled().await {
                return Outcome::Cancelled;
            }
            if root_is_link {
                // Only the link goes; the folder it points to keeps its files.
                let link = source_root.trim_end_matches(['/', '\\']);
                match self.src.remove_file(link).await {
                    Ok(()) => notes.push(format!(
                        "'{}' is a link to a folder: the folder's contents were copied and \
                         only the link was removed",
                        link
                    )),
                    Err(e) => notes.push(format!(
                        "'{}' is a link to a folder: its contents were copied, but the link \
                         could not be removed: {}",
                        link, e
                    )),
                }
            } else {
                let mut left = 0usize;
                for s in &copied {
                    if self.src.remove_file(s).await.is_err() {
                        left += 1;
                    }
                }
                for (s, _) in dirs.iter().rev() {
                    if self.src.remove_dir(s, false).await.is_err() {
                        left += 1;
                    }
                }
                if left > 0 {
                    notes.push(format!(
                        "{} source item(s) could not be removed after the copy",
                        left
                    ));
                }
            }
        }

        Outcome::Completed {
            note: if notes.is_empty() {
                None
            } else {
                Some(notes.join("; "))
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local::LocalFsDriver;
    use crate::types::{CoreError, CoreResult, FileSystemInfo, FindFileMatch, FindFileQuery};
    use async_trait::async_trait;
    use std::path::Path;

    /// Wraps the local driver to simulate other protocols: no positional
    /// writes, short reads, slow reads, or failures for some paths.
    #[derive(Debug)]
    struct TestFs {
        inner: LocalFsDriver,
        positional: bool,
        max_read: Option<usize>,
        read_delay: Option<Duration>,
        fail_write_containing: Option<&'static str>,
        /// Positional writes at or past this offset fail.
        fail_write_from: Option<u64>,
        fail_rename: bool,
        /// Some(code): a shell whose every command exits with `code`.
        shell_exit: Option<i32>,
        /// Some(f): a shell whose every command fails with `f()`.
        shell_error: Option<fn() -> CoreError>,
    }

    impl TestFs {
        fn new(root: &Path) -> Self {
            Self {
                inner: LocalFsDriver::with_root(root),
                positional: true,
                max_read: None,
                read_delay: None,
                fail_write_containing: None,
                fail_write_from: None,
                fail_rename: false,
                shell_exit: None,
                shell_error: None,
            }
        }
        fn check_write(&self, path: &str) -> CoreResult<()> {
            match self.fail_write_containing {
                Some(pat) if path.contains(pat) => Err(CoreError::PermissionDenied(format!(
                    "simulated failure: {}",
                    path
                ))),
                _ => Ok(()),
            }
        }
    }

    #[async_trait]
    impl VirtualFileSystem for TestFs {
        fn protocol(&self) -> Protocol {
            Protocol::S3
        }
        async fn list_dir(&self, path: &str) -> CoreResult<Vec<FileEntry>> {
            self.inner.list_dir(path).await
        }
        async fn metadata(&self, path: &str) -> CoreResult<FileEntry> {
            self.inner.metadata(path).await
        }
        async fn read_file(&self, path: &str) -> CoreResult<Bytes> {
            self.inner.read_file(path).await
        }
        async fn read_range(&self, path: &str, offset: u64, length: u64) -> CoreResult<Bytes> {
            if let Some(d) = self.read_delay {
                tokio::time::sleep(d).await;
            }
            let len = match self.max_read {
                Some(m) => length.min(m as u64),
                None => length,
            };
            self.inner.read_range(path, offset, len).await
        }
        async fn write_file(&self, path: &str, data: Bytes) -> CoreResult<()> {
            self.check_write(path)?;
            self.inner.write_file(path, data).await
        }
        fn supports_write_at(&self) -> bool {
            self.positional
        }
        async fn write_at(&self, path: &str, offset: u64, data: Bytes) -> CoreResult<()> {
            self.check_write(path)?;
            if matches!(self.fail_write_from, Some(limit) if offset >= limit) {
                return Err(CoreError::ConnectionFailed("simulated drop".into()));
            }
            self.inner.write_at(path, offset, data).await
        }
        async fn create_dir(&self, path: &str) -> CoreResult<()> {
            self.inner.create_dir(path).await
        }
        async fn remove_file(&self, path: &str) -> CoreResult<()> {
            self.inner.remove_file(path).await
        }
        async fn remove_dir(&self, path: &str, recursive: bool) -> CoreResult<()> {
            self.inner.remove_dir(path, recursive).await
        }
        async fn rename(&self, from: &str, to: &str) -> CoreResult<()> {
            if self.fail_rename {
                return Err(CoreError::PermissionDenied(format!(
                    "simulated rename failure: {}",
                    from
                )));
            }
            self.inner.rename(from, to).await
        }
        fn supports_shell(&self) -> bool {
            self.shell_exit.is_some() || self.shell_error.is_some()
        }
        async fn execute_command(&self, _cmd: &str) -> CoreResult<(i32, String, String)> {
            if let Some(f) = self.shell_error {
                return Err(f());
            }
            match self.shell_exit {
                Some(code) => Ok((code, String::new(), "mv: simulated failure".to_string())),
                None => Err(CoreError::Protocol("no shell".to_string())),
            }
        }
        async fn set_permissions(&self, path: &str, mode: u32) -> CoreResult<()> {
            self.inner.set_permissions(path, mode).await
        }
        async fn exists(&self, path: &str) -> CoreResult<bool> {
            self.inner.exists(path).await
        }
        async fn search(&self, r: &str, p: &str, m: usize) -> CoreResult<Vec<FileEntry>> {
            self.inner.search(r, p, m).await
        }
        async fn create_symlink(&self, t: &str, l: &str, s: bool) -> CoreResult<()> {
            self.inner.create_symlink(t, l, s).await
        }
        async fn get_filesystem_info(&self, path: &str) -> CoreResult<FileSystemInfo> {
            self.inner.get_filesystem_info(path).await
        }
        async fn calculate_size(&self, path: &str) -> CoreResult<u64> {
            self.inner.calculate_size(path).await
        }
        async fn find_files(&self, q: &FindFileQuery) -> CoreResult<Vec<FindFileMatch>> {
            self.inner.find_files(q).await
        }
    }

    /// folder path -> (entry name, content)
    type MemDirs = HashMap<String, Vec<(String, Vec<u8>)>>;

    /// Case-sensitive in-memory filesystem with a listing that can be made
    /// hostile (names are returned exactly as stored, `/` included).
    #[derive(Debug, Default)]
    struct MemFs {
        dirs: std::sync::Mutex<MemDirs>,
    }

    impl MemFs {
        fn with(dir: &str, files: &[(&str, &[u8])]) -> Self {
            let fs = MemFs::default();
            fs.dirs.lock().unwrap().insert(
                dir.to_string(),
                files
                    .iter()
                    .map(|(n, c)| (n.to_string(), c.to_vec()))
                    .collect(),
            );
            fs
        }
        fn file(&self, path: &str) -> Option<Vec<u8>> {
            let (dir, name) = split_name(path);
            let dir = dir.trim_end_matches('/');
            self.dirs
                .lock()
                .unwrap()
                .get(dir)?
                .iter()
                .find(|(n, _)| n == name)
                .map(|(_, c)| c.clone())
        }
        fn entry(name: &str, path: &str, file_type: FileType, size: u64) -> FileEntry {
            FileEntry {
                name: name.to_string(),
                path: path.to_string(),
                file_type,
                size,
                modified_at: None,
                created_at: None,
                permissions: Default::default(),
                is_hidden: false,
            }
        }
    }

    #[async_trait]
    impl VirtualFileSystem for MemFs {
        fn protocol(&self) -> Protocol {
            Protocol::Sftp
        }
        fn supports_shell(&self) -> bool {
            false
        }
        async fn list_dir(&self, path: &str) -> CoreResult<Vec<FileEntry>> {
            let dir = path.trim_end_matches('/');
            match self.dirs.lock().unwrap().get(dir) {
                Some(items) => Ok(items
                    .iter()
                    .map(|(n, c)| {
                        Self::entry(n, &format!("{}/{}", dir, n), FileType::File, c.len() as u64)
                    })
                    .collect()),
                None => Err(CoreError::NotFound(path.to_string())),
            }
        }
        async fn metadata(&self, path: &str) -> CoreResult<FileEntry> {
            let dir = path.trim_end_matches('/');
            if self.dirs.lock().unwrap().contains_key(dir) {
                return Ok(Self::entry(split_name(dir).1, dir, FileType::Directory, 0));
            }
            match self.file(path) {
                Some(c) => Ok(Self::entry(
                    split_name(path).1,
                    path,
                    FileType::File,
                    c.len() as u64,
                )),
                None => Err(CoreError::NotFound(path.to_string())),
            }
        }
        async fn read_file(&self, path: &str) -> CoreResult<Bytes> {
            self.file(path)
                .map(Bytes::from)
                .ok_or_else(|| CoreError::NotFound(path.to_string()))
        }
        async fn read_range(&self, path: &str, offset: u64, length: u64) -> CoreResult<Bytes> {
            let c = self
                .file(path)
                .ok_or_else(|| CoreError::NotFound(path.to_string()))?;
            let start = (offset as usize).min(c.len());
            let end = (start + length as usize).min(c.len());
            Ok(Bytes::copy_from_slice(&c[start..end]))
        }
        async fn write_file(&self, _path: &str, _data: Bytes) -> CoreResult<()> {
            Err(CoreError::Protocol("read-only test fs".into()))
        }
        async fn create_dir(&self, _path: &str) -> CoreResult<()> {
            Err(CoreError::Protocol("read-only test fs".into()))
        }
        async fn remove_file(&self, path: &str) -> CoreResult<()> {
            let (dir, name) = split_name(path);
            let dir = dir.trim_end_matches('/');
            let mut g = self.dirs.lock().unwrap();
            let items = g
                .get_mut(dir)
                .ok_or_else(|| CoreError::NotFound(path.to_string()))?;
            let before = items.len();
            items.retain(|(n, _)| n != name);
            if items.len() == before {
                return Err(CoreError::NotFound(path.to_string()));
            }
            Ok(())
        }
        async fn remove_dir(&self, path: &str, _recursive: bool) -> CoreResult<()> {
            let dir = path.trim_end_matches('/');
            let mut g = self.dirs.lock().unwrap();
            match g.get(dir) {
                Some(items) if items.is_empty() => {
                    g.remove(dir);
                    Ok(())
                }
                _ => Err(CoreError::General(format!("cannot remove {}", path))),
            }
        }
        async fn rename(&self, _from: &str, _to: &str) -> CoreResult<()> {
            Err(CoreError::Protocol("unsupported".into()))
        }
        async fn set_permissions(&self, _path: &str, _mode: u32) -> CoreResult<()> {
            Ok(())
        }
        async fn exists(&self, path: &str) -> CoreResult<bool> {
            Ok(self.metadata(path).await.is_ok())
        }
        async fn search(&self, _r: &str, _p: &str, _m: usize) -> CoreResult<Vec<FileEntry>> {
            Ok(vec![])
        }
        async fn create_symlink(&self, _t: &str, _l: &str, _s: bool) -> CoreResult<()> {
            Err(CoreError::Protocol("unsupported".into()))
        }
        async fn get_filesystem_info(&self, _path: &str) -> CoreResult<FileSystemInfo> {
            Err(CoreError::Protocol("unsupported".into()))
        }
        async fn calculate_size(&self, _path: &str) -> CoreResult<u64> {
            Ok(0)
        }
        async fn find_files(&self, _q: &FindFileQuery) -> CoreResult<Vec<FindFileMatch>> {
            Ok(vec![])
        }
    }

    /// Files whose name marks them as this queue's temporary or probe files.
    fn leftovers(dir: &Path) -> Vec<String> {
        let mut out = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(d) = stack.pop() {
            for e in std::fs::read_dir(&d).unwrap().flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                if e.file_type().unwrap().is_dir() {
                    stack.push(e.path());
                } else if name.contains(".rustscp-") {
                    out.push(e.path().display().to_string());
                }
            }
        }
        out
    }

    /// Is the filesystem holding `dir` case-insensitive (macOS, Windows)?
    fn case_insensitive_fs(dir: &Path) -> bool {
        let probe = dir.join("CaseProbe.tmp");
        std::fs::write(&probe, b"x").unwrap();
        let insensitive = dir.join("caseprobe.tmp").exists();
        std::fs::remove_file(probe).unwrap();
        insensitive
    }

    fn pattern(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i * 31 % 251) as u8).collect()
    }

    fn sessions(list: Vec<(&str, Arc<dyn VirtualFileSystem>)>) -> Sessions {
        Arc::new(RwLock::new(
            list.into_iter().map(|(k, v)| (k.to_string(), v)).collect(),
        ))
    }

    async fn wait_done(q: &TransferQueueManager, id: &str) -> QueueTransferTask {
        for _ in 0..2000 {
            let t = q.get_task(id).await.unwrap();
            if !matches!(
                t.status,
                TransferStatus::Queued | TransferStatus::InProgress
            ) {
                return t;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("transfer {} did not finish", id);
    }

    const CHUNK: u64 = 64 * 1024;

    #[tokio::test]
    async fn copies_multi_chunk_file_between_local_sessions() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let data = pattern((CHUNK * 3 + 1234) as usize);
        std::fs::write(a.path().join("big.bin"), &data).unwrap();

        let s = sessions(vec![
            ("a", Arc::new(LocalFsDriver::with_root(a.path()))),
            ("b", Arc::new(LocalFsDriver::with_root(b.path()))),
        ]);
        let q = TransferQueueManager::with_chunk_size(2, CHUNK);
        let id = q
            .enqueue(
                "a".into(),
                "/big.bin".into(),
                "b".into(),
                "/sub/copy.bin".into(),
                false,
                s,
            )
            .await;
        let t = wait_done(&q, &id).await;
        assert_eq!(t.status, TransferStatus::Completed, "{:?}", t.error);
        assert_eq!(t.total_bytes, data.len() as u64);
        assert_eq!(t.transferred_bytes, data.len() as u64);
        assert_eq!(std::fs::read(b.path().join("sub/copy.bin")).unwrap(), data);
        // A copy keeps the source.
        assert!(a.path().join("big.bin").exists());
    }

    #[tokio::test]
    async fn short_reads_and_whole_file_destinations_are_handled() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let data = pattern(200_000);
        std::fs::write(a.path().join("f.bin"), &data).unwrap();

        let mut src = TestFs::new(a.path());
        src.max_read = Some(7_000); // every read returns less than asked
        let mut dst = TestFs::new(b.path());
        dst.positional = false; // like S3: one write_file at the end
        let s = sessions(vec![("a", Arc::new(src)), ("b", Arc::new(dst))]);
        let q = TransferQueueManager::with_chunk_size(1, CHUNK);
        let id = q
            .enqueue(
                "a".into(),
                "f.bin".into(),
                "b".into(),
                "f.bin".into(),
                true,
                s,
            )
            .await;
        let t = wait_done(&q, &id).await;
        assert_eq!(t.status, TransferStatus::Completed, "{:?}", t.error);
        assert_eq!(std::fs::read(b.path().join("f.bin")).unwrap(), data);
        assert!(
            !a.path().join("f.bin").exists(),
            "move must delete the source"
        );
    }

    #[tokio::test]
    async fn copies_and_moves_directory_trees() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let root = a.path().join("proj");
        std::fs::create_dir_all(root.join("src/deep")).unwrap();
        std::fs::create_dir_all(root.join("empty")).unwrap();
        let big = pattern((CHUNK * 2 + 5) as usize);
        std::fs::write(root.join("README"), b"hello").unwrap();
        std::fs::write(root.join("src/main.rs"), &big).unwrap();
        std::fs::write(root.join("src/deep/zero.txt"), b"").unwrap();

        let s = sessions(vec![
            ("a", Arc::new(LocalFsDriver::with_root(a.path()))),
            ("b", Arc::new(LocalFsDriver::with_root(b.path()))),
        ]);
        let q = TransferQueueManager::with_chunk_size(2, CHUNK);

        // Copy.
        let id = q
            .enqueue(
                "a".into(),
                "/proj".into(),
                "b".into(),
                "/copy".into(),
                false,
                s.clone(),
            )
            .await;
        let t = wait_done(&q, &id).await;
        assert_eq!(t.status, TransferStatus::Completed, "{:?}", t.error);
        assert_eq!(t.total_bytes, 5 + big.len() as u64);
        let c = b.path().join("copy");
        assert_eq!(std::fs::read(c.join("README")).unwrap(), b"hello");
        assert_eq!(std::fs::read(c.join("src/main.rs")).unwrap(), big);
        assert_eq!(std::fs::read(c.join("src/deep/zero.txt")).unwrap(), b"");
        assert!(c.join("empty").is_dir());
        assert!(root.join("src/main.rs").exists());

        // Move.
        let id = q
            .enqueue(
                "a".into(),
                "/proj".into(),
                "b".into(),
                "/moved".into(),
                true,
                s,
            )
            .await;
        let t = wait_done(&q, &id).await;
        assert_eq!(t.status, TransferStatus::Completed, "{:?}", t.error);
        let m = b.path().join("moved");
        assert_eq!(std::fs::read(m.join("src/main.rs")).unwrap(), big);
        assert!(m.join("empty").is_dir());
        assert!(!root.exists(), "moved tree must be gone from the source");
    }

    #[tokio::test]
    async fn failed_move_keeps_every_source_file() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let root = a.path().join("d");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("ok.txt"), b"fine").unwrap();
        std::fs::write(root.join("fail.txt"), b"broken").unwrap();

        let mut dst = TestFs::new(b.path());
        dst.fail_write_containing = Some("fail.txt");
        let s = sessions(vec![
            ("a", Arc::new(LocalFsDriver::with_root(a.path()))),
            ("b", Arc::new(dst)),
        ]);
        let q = TransferQueueManager::with_chunk_size(1, CHUNK);
        let id = q
            .enqueue("a".into(), "/d".into(), "b".into(), "/d".into(), true, s)
            .await;
        let t = wait_done(&q, &id).await;
        assert_eq!(t.status, TransferStatus::Failed);
        assert!(t.error.unwrap().contains("nothing was deleted"));
        assert!(root.join("ok.txt").exists());
        assert!(root.join("fail.txt").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn failed_first_write_leaves_existing_destination_alone() {
        use std::os::unix::fs::PermissionsExt;
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        std::fs::write(a.path().join("src.txt"), b"new content").unwrap();
        let existing = b.path().join("f.txt");
        std::fs::write(&existing, b"precious").unwrap();
        std::fs::set_permissions(&existing, std::fs::Permissions::from_mode(0o444)).unwrap();

        let s = sessions(vec![
            ("a", Arc::new(LocalFsDriver::with_root(a.path()))),
            ("b", Arc::new(LocalFsDriver::with_root(b.path()))),
        ]);
        let q = TransferQueueManager::with_chunk_size(1, CHUNK);
        let id = q
            .enqueue(
                "a".into(),
                "/src.txt".into(),
                "b".into(),
                "/f.txt".into(),
                true,
                s,
            )
            .await;
        let t = wait_done(&q, &id).await;
        std::fs::set_permissions(&existing, std::fs::Permissions::from_mode(0o644)).unwrap();
        if t.status == TransferStatus::Failed {
            assert!(
                t.error.as_deref().unwrap_or("").contains("Write failed"),
                "{:?}",
                t.error
            );
            assert_eq!(std::fs::read(&existing).unwrap(), b"precious");
            assert!(
                a.path().join("src.txt").exists(),
                "failed move keeps the source"
            );
        } else {
            // Running as root: the write is allowed.
            assert_eq!(std::fs::read(&existing).unwrap(), b"new content");
        }
    }

    #[tokio::test]
    async fn cancel_stops_transfer_and_keeps_source() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let data = pattern((CHUNK * 40) as usize);
        std::fs::write(a.path().join("slow.bin"), &data).unwrap();

        let mut src = TestFs::new(a.path());
        src.read_delay = Some(Duration::from_millis(20));
        let s = sessions(vec![
            ("a", Arc::new(src)),
            ("b", Arc::new(LocalFsDriver::with_root(b.path()))),
        ]);
        let q = TransferQueueManager::with_chunk_size(1, CHUNK);
        let id = q
            .enqueue(
                "a".into(),
                "slow.bin".into(),
                "b".into(),
                "slow.bin".into(),
                true,
                s,
            )
            .await;
        // Wait until some data moved, then cancel.
        for _ in 0..500 {
            if q.get_task(&id).await.unwrap().transferred_bytes > 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        q.cancel_task(&id).await;
        let t = wait_done(&q, &id).await;
        assert_eq!(t.status, TransferStatus::Cancelled);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            q.get_task(&id).await.unwrap().status,
            TransferStatus::Cancelled
        );
        assert_eq!(std::fs::read(a.path().join("slow.bin")).unwrap(), data);
        assert!(
            !b.path().join("slow.bin").exists(),
            "partial file must be removed"
        );

        // Cancelling a finished task does not change it.
        q.cancel_task("missing").await;
    }

    #[tokio::test]
    async fn same_session_rename_and_self_copy_guard() {
        let a = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(a.path().join("dir")).unwrap();
        std::fs::write(a.path().join("dir/x.txt"), b"x").unwrap();
        let s = sessions(vec![("a", Arc::new(LocalFsDriver::with_root(a.path())))]);
        let q = TransferQueueManager::with_chunk_size(1, CHUNK);

        let id = q
            .enqueue(
                "a".into(),
                "/dir/x.txt".into(),
                "a".into(),
                "/dir/x.txt".into(),
                false,
                s.clone(),
            )
            .await;
        let t = wait_done(&q, &id).await;
        assert_eq!(t.status, TransferStatus::Failed);
        assert_eq!(std::fs::read(a.path().join("dir/x.txt")).unwrap(), b"x");

        let id = q
            .enqueue(
                "a".into(),
                "/dir".into(),
                "a".into(),
                "/dir/inner".into(),
                false,
                s.clone(),
            )
            .await;
        assert_eq!(wait_done(&q, &id).await.status, TransferStatus::Failed);

        let id = q
            .enqueue(
                "a".into(),
                "/dir/x.txt".into(),
                "a".into(),
                "/y.txt".into(),
                true,
                s,
            )
            .await;
        let t = wait_done(&q, &id).await;
        assert_eq!(t.status, TransferStatus::Completed, "{:?}", t.error);
        assert!(a.path().join("y.txt").exists());
        assert!(!a.path().join("dir/x.txt").exists());
    }

    #[tokio::test]
    async fn same_session_self_transfer_is_rejected_at_enqueue() {
        let a = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(a.path().join("dir/sub")).unwrap();
        std::fs::write(a.path().join("dir/sub/x.txt"), b"x").unwrap();
        // No sessions registered: a worker would fail with "Session
        // disconnected", so these messages prove nothing was started.
        let s = sessions(vec![]);
        let q = TransferQueueManager::with_chunk_size(1, CHUNK);
        q.pause(); // even a paused queue reports the rejection at once

        for (src, dst, is_move, expect) in [
            ("/dir/sub/x.txt", "/dir/sub/x.txt", false, "are the same"),
            ("/dir/sub/x.txt", "/dir/./sub//x.txt", true, "are the same"),
            ("/dir", "/dir/", true, "are the same"),
            ("/dir", "/dir/sub/dir", false, "into itself"),
            ("/dir/", "/dir/../dir/copy", true, "into itself"),
            ("/", "/backup", false, "into itself"),
        ] {
            let id = q
                .enqueue(
                    "a".into(),
                    src.into(),
                    "a".into(),
                    dst.into(),
                    is_move,
                    s.clone(),
                )
                .await;
            let t = q.get_task(&id).await.unwrap();
            assert_eq!(t.status, TransferStatus::Failed, "{} -> {}", src, dst);
            let err = t.error.unwrap_or_default();
            assert!(err.contains(expect), "{} -> {}: {}", src, dst, err);
            assert!(err.contains("nothing was transferred"), "{}", err);
        }
        assert_eq!(std::fs::read(a.path().join("dir/sub/x.txt")).unwrap(), b"x");
        assert!(!a.path().join("dir/sub/dir").exists());
        assert!(!a.path().join("dir/copy").exists());

        // Different sessions with the same path are not rejected up front.
        let id = q
            .enqueue(
                "a".into(),
                "/dir".into(),
                "b".into(),
                "/dir".into(),
                false,
                s,
            )
            .await;
        assert_eq!(
            q.get_task(&id).await.unwrap().status,
            TransferStatus::Queued
        );
        q.cancel_task(&id).await;
    }

    #[tokio::test]
    async fn same_session_move_fails_when_rename_and_mv_fail() {
        let a = tempfile::tempdir().unwrap();
        std::fs::write(a.path().join("x.txt"), b"keep me").unwrap();
        let mut fs = TestFs::new(a.path());
        fs.fail_rename = true;
        fs.shell_exit = Some(1);
        let s = sessions(vec![("a", Arc::new(fs))]);
        let q = TransferQueueManager::with_chunk_size(1, CHUNK);
        let id = q
            .enqueue(
                "a".into(),
                "/x.txt".into(),
                "a".into(),
                "/y.txt".into(),
                true,
                s,
            )
            .await;
        let t = wait_done(&q, &id).await;
        assert_eq!(t.status, TransferStatus::Failed);
        let err = t.error.unwrap_or_default();
        assert!(err.contains("rename failed"), "{}", err);
        assert!(err.contains("mv exited with code 1"), "{}", err);
        assert_eq!(std::fs::read(a.path().join("x.txt")).unwrap(), b"keep me");
        assert!(!a.path().join("y.txt").exists(), "must not stream a copy");
    }

    #[tokio::test]
    async fn same_session_move_without_shell_streams_when_rename_fails() {
        let a = tempfile::tempdir().unwrap();
        std::fs::write(a.path().join("x.txt"), b"data").unwrap();
        let mut fs = TestFs::new(a.path());
        fs.fail_rename = true; // e.g. S3/FTP: no shell to try instead
        let s = sessions(vec![("a", Arc::new(fs))]);
        let q = TransferQueueManager::with_chunk_size(1, CHUNK);
        let id = q
            .enqueue(
                "a".into(),
                "/x.txt".into(),
                "a".into(),
                "/y.txt".into(),
                true,
                s,
            )
            .await;
        let t = wait_done(&q, &id).await;
        assert_eq!(t.status, TransferStatus::Completed, "{:?}", t.error);
        assert_eq!(std::fs::read(a.path().join("y.txt")).unwrap(), b"data");
        assert!(!a.path().join("x.txt").exists());
    }

    #[tokio::test]
    async fn same_session_copy_into_existing_folder_merges_instead_of_nesting() {
        let a = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(a.path().join("proj")).unwrap();
        std::fs::create_dir_all(a.path().join("existing")).unwrap();
        std::fs::write(a.path().join("proj/README"), b"hi").unwrap();
        let mut fs = TestFs::new(a.path());
        // A shell that "succeeds" without doing anything: if `cp` were used,
        // the existing folder would pass verification with nothing copied.
        fs.shell_exit = Some(0);
        let s = sessions(vec![("a", Arc::new(fs))]);
        let q = TransferQueueManager::with_chunk_size(1, CHUNK);
        let id = q
            .enqueue(
                "a".into(),
                "/proj".into(),
                "a".into(),
                "/existing".into(),
                false,
                s,
            )
            .await;
        let t = wait_done(&q, &id).await;
        assert_eq!(t.status, TransferStatus::Completed, "{:?}", t.error);
        assert_eq!(
            std::fs::read(a.path().join("existing/README")).unwrap(),
            b"hi"
        );
        assert!(!a.path().join("existing/proj").exists());
    }

    #[tokio::test]
    async fn clear_completed_removes_every_finished_task() {
        let q = TransferQueueManager::default();
        {
            let mut list = q.tasks.write().await;
            for (i, status) in [
                TransferStatus::Queued,
                TransferStatus::InProgress,
                TransferStatus::Paused,
                TransferStatus::Completed,
                TransferStatus::Failed,
                TransferStatus::Cancelled,
            ]
            .into_iter()
            .enumerate()
            {
                list.push(QueueTransferTask {
                    id: i.to_string(),
                    name: String::new(),
                    source_session: String::new(),
                    source_path: String::new(),
                    dest_session: String::new(),
                    dest_path: String::new(),
                    is_move: false,
                    total_bytes: 0,
                    transferred_bytes: 0,
                    status,
                    speed_bps: 0,
                    error: None,
                });
            }
        }
        q.clear_completed().await;
        let left: Vec<_> = q.get_tasks().await.into_iter().map(|t| t.status).collect();
        assert_eq!(
            left,
            vec![
                TransferStatus::Queued,
                TransferStatus::InProgress,
                TransferStatus::Paused
            ]
        );
    }

    #[tokio::test]
    async fn missing_session_and_missing_source_fail() {
        let a = tempfile::tempdir().unwrap();
        let s = sessions(vec![("a", Arc::new(LocalFsDriver::with_root(a.path())))]);
        let q = TransferQueueManager::default();
        let id = q
            .enqueue(
                "a".into(),
                "/nope".into(),
                "zzz".into(),
                "/nope".into(),
                false,
                s.clone(),
            )
            .await;
        let t = wait_done(&q, &id).await;
        assert_eq!(t.status, TransferStatus::Failed);
        assert_eq!(t.error.as_deref(), Some("Session disconnected"));

        let b = tempfile::tempdir().unwrap();
        s.write()
            .await
            .insert("b".into(), Arc::new(LocalFsDriver::with_root(b.path())));
        let id = q
            .enqueue(
                "a".into(),
                "/nope".into(),
                "b".into(),
                "/nope".into(),
                true,
                s,
            )
            .await;
        assert_eq!(wait_done(&q, &id).await.status, TransferStatus::Failed);
    }

    #[tokio::test]
    async fn malicious_listing_cannot_escape_the_destination() {
        let home = tempfile::tempdir().unwrap();
        let downloads = home.path().join("Downloads");
        std::fs::create_dir_all(&downloads).unwrap();
        let server = Arc::new(MemFs::with(
            "/srv/dl",
            &[("ok.txt", b"fine"), ("../../escaped.txt", b"pwned")],
        ));
        let s = sessions(vec![
            ("srv", server.clone()),
            ("local", Arc::new(LocalFsDriver::new())),
        ]);
        let dest = downloads.join("dl").to_string_lossy().into_owned();
        for is_move in [false, true] {
            let q = TransferQueueManager::with_chunk_size(1, CHUNK);
            let id = q
                .enqueue(
                    "srv".into(),
                    "/srv/dl".into(),
                    "local".into(),
                    dest.clone(),
                    is_move,
                    s.clone(),
                )
                .await;
            let t = wait_done(&q, &id).await;
            assert_eq!(t.status, TransferStatus::Failed);
            let err = t.error.unwrap_or_default();
            assert!(err.contains("unsafe name"), "{}", err);
            assert!(!home.path().join("escaped.txt").exists());
            assert!(!downloads.join("escaped.txt").exists());
        }
        // The failed move deleted nothing on the server.
        assert_eq!(server.dirs.lock().unwrap()["/srv/dl"].len(), 2);
        assert_eq!(std::fs::read(downloads.join("dl/ok.txt")).unwrap(), b"fine");
        assert!(leftovers(home.path()).is_empty());
    }

    #[test]
    fn entry_name_and_containment_checks() {
        for bad in ["a/b", "../x", "a\0b"] {
            assert!(is_unsafe_entry_name(bad, false, false), "{bad:?}");
        }
        assert!(is_unsafe_entry_name("a\\..\\x", true, false));
        assert!(!is_unsafe_entry_name("a\\b", false, false));
        assert!(is_unsafe_entry_name("c:x", true, true));
        assert!(is_unsafe_entry_name("...", true, true));
        assert!(is_unsafe_entry_name(" . ", true, true));
        assert!(!is_unsafe_entry_name("...", true, false));
        assert!(!is_unsafe_entry_name("notes.txt", true, true));

        assert!(is_strictly_inside("/d/dl/a", "/d/dl"));
        assert!(is_strictly_inside("/d/dl/a", "/d/dl/"));
        assert!(is_strictly_inside("/a", "/"));
        assert!(!is_strictly_inside("/d/dl/../../x", "/d/dl"));
        assert!(!is_strictly_inside("/d/dl", "/d/dl"));
        assert!(!is_strictly_inside("/d/dlx/a", "/d/dl"));
        assert!(is_strictly_inside("C:\\d\\dl\\a", "C:\\d\\dl"));
        assert!(!is_strictly_inside("C:\\d\\dl\\..\\x", "C:\\d\\dl"));
        assert!(is_strictly_inside("a", ""));
        assert!(!is_strictly_inside("../a", ""));

        assert_eq!(split_name("/a/b.txt"), ("/a/", "b.txt"));
        assert_eq!(split_name("C:\\x\\f"), ("C:\\x\\", "f"));
        assert_eq!(split_name("f"), ("", "f"));
        assert_eq!(
            temp_tag("tr-0123abcd-ef01-4567-89ab-cdef01234567"),
            "cdef01234567"
        );
        let long = "é".repeat(200);
        assert!(temp_file_name(&long, "abc").len() < 160);
        assert_eq!(toggle_ascii_case(".a.B-1"), ".A.b-1");
        assert_eq!(case_fold_key("/X/ReadMe", false), "/x/readme");
        assert_eq!(case_fold_key("C:\\X\\a. ", true), "c:/x/a");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn same_file_through_a_symlinked_folder_is_refused() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("real")).unwrap();
        std::os::unix::fs::symlink(root.path().join("real"), root.path().join("link")).unwrap();
        let data = pattern((CHUNK * 5 + 17) as usize);
        std::fs::write(root.path().join("real/f.bin"), &data).unwrap();
        // Two sessions on the same disk, as the app opens for two local tabs.
        let s = sessions(vec![
            ("a", Arc::new(LocalFsDriver::with_root(root.path()))),
            ("b", Arc::new(LocalFsDriver::with_root(root.path()))),
        ]);
        for is_move in [false, true] {
            let q = TransferQueueManager::with_chunk_size(1, CHUNK);
            let id = q
                .enqueue(
                    "a".into(),
                    "/real/f.bin".into(),
                    "b".into(),
                    "/link/f.bin".into(),
                    is_move,
                    s.clone(),
                )
                .await;
            let t = wait_done(&q, &id).await;
            assert_eq!(t.status, TransferStatus::Failed, "move={is_move}");
            assert!(
                t.error.as_deref().unwrap_or("").contains("same file"),
                "{:?}",
                t.error
            );
            assert_eq!(std::fs::read(root.path().join("real/f.bin")).unwrap(), data);
        }
        assert!(
            leftovers(root.path()).is_empty(),
            "{:?}",
            leftovers(root.path())
        );
    }

    #[tokio::test]
    async fn case_variant_of_the_source_is_refused_on_case_insensitive_disks() {
        let root = tempfile::tempdir().unwrap();
        if !case_insensitive_fs(root.path()) {
            return; // README and readme are two files here
        }
        let data = pattern((CHUNK * 5) as usize);
        std::fs::write(root.path().join("File.bin"), &data).unwrap();
        let s = sessions(vec![
            ("a", Arc::new(LocalFsDriver::with_root(root.path()))),
            ("b", Arc::new(LocalFsDriver::with_root(root.path()))),
        ]);
        for is_move in [false, true] {
            let q = TransferQueueManager::with_chunk_size(1, CHUNK);
            let id = q
                .enqueue(
                    "a".into(),
                    "/File.bin".into(),
                    "b".into(),
                    "/file.bin".into(),
                    is_move,
                    s.clone(),
                )
                .await;
            let t = wait_done(&q, &id).await;
            assert_eq!(t.status, TransferStatus::Failed, "{:?}", t.error);
            assert!(t.error.unwrap_or_default().contains("same file"));
            assert_eq!(std::fs::read(root.path().join("File.bin")).unwrap(), data);
        }
        assert!(leftovers(root.path()).is_empty());
    }

    #[tokio::test]
    async fn duplicate_move_is_refused_and_the_file_survives() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let data = pattern((CHUNK * 30) as usize);
        std::fs::write(a.path().join("big.bin"), &data).unwrap();
        let mut src = TestFs::new(a.path());
        src.read_delay = Some(Duration::from_millis(5));
        let s = sessions(vec![
            ("a", Arc::new(src)),
            ("b", Arc::new(LocalFsDriver::with_root(b.path()))),
        ]);
        let q = TransferQueueManager::with_chunk_size(3, CHUNK);
        let first = q
            .enqueue(
                "a".into(),
                "/big.bin".into(),
                "b".into(),
                "/big.bin".into(),
                true,
                s.clone(),
            )
            .await;
        // Same move again (the file is still listed), and another move of
        // the same source to a different place.
        let second = q
            .enqueue(
                "a".into(),
                "/big.bin".into(),
                "b".into(),
                "//big.bin".into(),
                true,
                s.clone(),
            )
            .await;
        let third = q
            .enqueue(
                "a".into(),
                "/./big.bin".into(),
                "b".into(),
                "/other.bin".into(),
                true,
                s,
            )
            .await;
        for id in [&second, &third] {
            let t = q.get_task(id).await.unwrap();
            assert_eq!(t.status, TransferStatus::Failed);
            assert!(t.error.unwrap_or_default().contains("Already queued"));
        }
        let t = wait_done(&q, &first).await;
        assert_eq!(t.status, TransferStatus::Completed, "{:?}", t.error);
        assert_eq!(std::fs::read(b.path().join("big.bin")).unwrap(), data);
        assert!(!a.path().join("big.bin").exists());
        assert!(!b.path().join("other.bin").exists());
    }

    #[tokio::test]
    async fn cancelled_overwrite_keeps_the_old_file() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let data = pattern((CHUNK * 40) as usize);
        std::fs::write(a.path().join("backup.bin"), &data).unwrap();
        std::fs::write(b.path().join("backup.bin"), b"previous backup").unwrap();
        let mut src = TestFs::new(a.path());
        src.read_delay = Some(Duration::from_millis(20));
        let s = sessions(vec![
            ("a", Arc::new(src)),
            ("b", Arc::new(LocalFsDriver::with_root(b.path()))),
        ]);
        let q = TransferQueueManager::with_chunk_size(1, CHUNK);
        let id = q
            .enqueue(
                "a".into(),
                "/backup.bin".into(),
                "b".into(),
                "/backup.bin".into(),
                false,
                s,
            )
            .await;
        for _ in 0..500 {
            if q.get_task(&id).await.unwrap().transferred_bytes > CHUNK {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        q.cancel_task(&id).await;
        assert_eq!(wait_done(&q, &id).await.status, TransferStatus::Cancelled);
        // The worker removes its temporary file once it sees the cancel,
        // which can take a while when the whole suite runs in parallel.
        for _ in 0..500 {
            if leftovers(b.path()).is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(
            std::fs::read(b.path().join("backup.bin")).unwrap(),
            b"previous backup"
        );
        assert!(leftovers(b.path()).is_empty(), "{:?}", leftovers(b.path()));
    }

    #[tokio::test]
    async fn failed_overwrite_keeps_the_old_file() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        std::fs::write(a.path().join("f.bin"), pattern((CHUNK * 4) as usize)).unwrap();
        std::fs::write(b.path().join("f.bin"), b"old").unwrap();
        let mut dst = TestFs::new(b.path());
        dst.fail_write_from = Some(CHUNK * 2); // the connection drops midway
        let s = sessions(vec![
            ("a", Arc::new(LocalFsDriver::with_root(a.path()))),
            ("b", Arc::new(dst)),
        ]);
        let q = TransferQueueManager::with_chunk_size(1, CHUNK);
        let id = q
            .enqueue(
                "a".into(),
                "/f.bin".into(),
                "b".into(),
                "/f.bin".into(),
                true,
                s,
            )
            .await;
        let t = wait_done(&q, &id).await;
        assert_eq!(t.status, TransferStatus::Failed, "{:?}", t.error);
        assert!(t.error.unwrap_or_default().contains("Write failed at byte"));
        assert_eq!(std::fs::read(b.path().join("f.bin")).unwrap(), b"old");
        assert!(
            a.path().join("f.bin").exists(),
            "failed move keeps the source"
        );
        assert!(leftovers(b.path()).is_empty());
    }

    #[tokio::test]
    async fn overwrite_in_place_when_no_temporary_file_can_be_created() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        std::fs::write(a.path().join("f.bin"), pattern((CHUNK * 4) as usize)).unwrap();
        std::fs::write(b.path().join("f.bin"), b"old").unwrap();
        let mut dst = TestFs::new(b.path());
        dst.fail_write_containing = Some(".part"); // the replacement copy breaks
        let s = sessions(vec![
            ("a", Arc::new(LocalFsDriver::with_root(a.path()))),
            ("b", Arc::new(dst)),
        ]);
        let q = TransferQueueManager::with_chunk_size(1, CHUNK);
        let id = q
            .enqueue(
                "a".into(),
                "/f.bin".into(),
                "b".into(),
                "/f.bin".into(),
                true,
                s,
            )
            .await;
        let t = wait_done(&q, &id).await;
        // The folder takes no new files: the file is overwritten in place,
        // like a plain copy, and the move completes.
        assert_eq!(t.status, TransferStatus::Completed, "{:?}", t.error);
        assert_eq!(
            std::fs::read(b.path().join("f.bin")).unwrap().len() as u64,
            CHUNK * 4
        );
        assert!(!a.path().join("f.bin").exists());
        assert!(leftovers(b.path()).is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn overwrite_replaces_content_and_keeps_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let data = pattern((CHUNK * 3 + 9) as usize);
        std::fs::create_dir_all(a.path().join("build")).unwrap();
        std::fs::write(a.path().join("build/run.sh"), &data).unwrap();
        let existing = b.path().join("run.sh");
        std::fs::write(&existing, b"#!/bin/sh\necho old\n").unwrap();
        std::fs::set_permissions(&existing, std::fs::Permissions::from_mode(0o750)).unwrap();
        let s = sessions(vec![
            ("a", Arc::new(LocalFsDriver::with_root(a.path()))),
            ("b", Arc::new(LocalFsDriver::with_root(b.path()))),
        ]);
        let q = TransferQueueManager::with_chunk_size(1, CHUNK);
        let id = q
            .enqueue(
                "a".into(),
                "/build/run.sh".into(),
                "b".into(),
                "/run.sh".into(),
                false,
                s,
            )
            .await;
        let t = wait_done(&q, &id).await;
        assert_eq!(t.status, TransferStatus::Completed, "{:?}", t.error);
        assert_eq!(std::fs::read(&existing).unwrap(), data);
        let mode = std::fs::metadata(&existing).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o750);
        assert!(leftovers(b.path()).is_empty());
    }

    #[tokio::test]
    async fn move_whose_mv_may_still_run_is_not_streamed() {
        let a = tempfile::tempdir().unwrap();
        std::fs::write(a.path().join("x.bin"), b"keep me").unwrap();
        let mut fs = TestFs::new(a.path());
        fs.fail_rename = true; // e.g. EXDEV across mount points
        fs.shell_error = Some(|| CoreError::Timeout("Remote command did not finish".into()));
        let s = sessions(vec![("a", Arc::new(fs))]);
        let q = TransferQueueManager::with_chunk_size(1, CHUNK);
        for is_move in [true, false] {
            let id = q
                .enqueue(
                    "a".into(),
                    "/x.bin".into(),
                    "a".into(),
                    "/y.bin".into(),
                    is_move,
                    s.clone(),
                )
                .await;
            let t = wait_done(&q, &id).await;
            assert_eq!(t.status, TransferStatus::Failed);
            let err = t.error.unwrap_or_default();
            assert!(err.contains("did not report completion"), "{}", err);
            assert_eq!(std::fs::read(a.path().join("x.bin")).unwrap(), b"keep me");
            assert!(!a.path().join("y.bin").exists(), "must not stream");
        }
    }

    #[tokio::test]
    async fn move_whose_command_never_started_streams() {
        let a = tempfile::tempdir().unwrap();
        std::fs::write(a.path().join("x.bin"), b"data").unwrap();
        let mut fs = TestFs::new(a.path());
        fs.fail_rename = true;
        fs.shell_error = Some(|| CoreError::Protocol("no shell".into()));
        let s = sessions(vec![("a", Arc::new(fs))]);
        let q = TransferQueueManager::with_chunk_size(1, CHUNK);
        let id = q
            .enqueue(
                "a".into(),
                "/x.bin".into(),
                "a".into(),
                "/y.bin".into(),
                true,
                s,
            )
            .await;
        let t = wait_done(&q, &id).await;
        assert_eq!(t.status, TransferStatus::Completed, "{:?}", t.error);
        assert_eq!(std::fs::read(a.path().join("y.bin")).unwrap(), b"data");
        assert!(!a.path().join("x.bin").exists());
    }

    #[tokio::test]
    async fn case_colliding_names_are_not_merged_on_case_insensitive_destinations() {
        let b = tempfile::tempdir().unwrap();
        let insensitive = case_insensitive_fs(b.path());
        let server = MemFs::with("/src", &[("README", b"upper"), ("readme", b"lower lower")]);
        let s = sessions(vec![
            ("srv", Arc::new(server)),
            ("b", Arc::new(LocalFsDriver::with_root(b.path()))),
        ]);
        let q = TransferQueueManager::with_chunk_size(1, CHUNK);
        let id = q
            .enqueue(
                "srv".into(),
                "/src".into(),
                "b".into(),
                "/dst".into(),
                true,
                s.clone(),
            )
            .await;
        let t = wait_done(&q, &id).await;
        let guard = s.read().await;
        let srv = guard.get("srv").unwrap();
        if insensitive {
            assert_eq!(t.status, TransferStatus::Failed, "{:?}", t.error);
            let err = t.error.unwrap_or_default();
            assert!(err.contains("collides"), "{}", err);
            assert!(err.contains("nothing was deleted"), "{}", err);
            // Both originals are still on the server.
            assert!(srv.exists("/src/README").await.unwrap());
            assert!(srv.exists("/src/readme").await.unwrap());
        } else {
            assert_eq!(t.status, TransferStatus::Completed, "{:?}", t.error);
            assert_eq!(
                std::fs::read(b.path().join("dst/README")).unwrap(),
                b"upper"
            );
            assert_eq!(
                std::fs::read(b.path().join("dst/readme")).unwrap(),
                b"lower lower"
            );
        }
        assert!(leftovers(b.path()).is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn moving_a_link_to_a_folder_keeps_the_folder() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(a.path().join("releases/123")).unwrap();
        std::fs::write(a.path().join("releases/123/app.bin"), b"live").unwrap();
        std::os::unix::fs::symlink(a.path().join("releases/123"), a.path().join("current"))
            .unwrap();
        let s = sessions(vec![
            ("a", Arc::new(LocalFsDriver::with_root(a.path()))),
            ("b", Arc::new(LocalFsDriver::with_root(b.path()))),
        ]);
        let q = TransferQueueManager::with_chunk_size(1, CHUNK);
        let id = q
            .enqueue(
                "a".into(),
                "/current".into(),
                "b".into(),
                "/www/current".into(),
                true,
                s,
            )
            .await;
        let t = wait_done(&q, &id).await;
        assert_eq!(t.status, TransferStatus::Completed, "{:?}", t.error);
        assert!(t
            .error
            .unwrap_or_default()
            .contains("only the link was removed"));
        assert_eq!(
            std::fs::read(b.path().join("www/current/app.bin")).unwrap(),
            b"live"
        );
        // The folder behind the link keeps its files; the link is gone.
        assert_eq!(
            std::fs::read(a.path().join("releases/123/app.bin")).unwrap(),
            b"live"
        );
        assert!(std::fs::symlink_metadata(a.path().join("current")).is_err());
    }

    #[test]
    fn path_helpers() {
        assert_eq!(join_path("/", "a"), "/a");
        assert_eq!(join_path("/x", "a"), "/x/a");
        assert_eq!(join_path("C:\\x\\", "a"), "C:\\x\\a");
        assert_eq!(is_same_or_inside("/a/b/", "/a/b"), (true, false));
        assert_eq!(is_same_or_inside("/a/b/c", "/a/b"), (false, true));
        assert_eq!(is_same_or_inside("/a/bc", "/a/b"), (false, false));
        assert_eq!(is_same_or_inside("/a/./b", "/a//b"), (true, false));
    }

    #[test]
    fn prune_keeps_active_and_failed() {
        let mk = |i: usize, status| QueueTransferTask {
            id: i.to_string(),
            name: String::new(),
            source_session: String::new(),
            source_path: String::new(),
            dest_session: String::new(),
            dest_path: String::new(),
            is_move: false,
            total_bytes: 0,
            transferred_bytes: 0,
            status,
            speed_bps: 0,
            error: None,
        };
        let mut list: Vec<_> = (0..MAX_KEPT_TASKS + 10)
            .map(|i| {
                mk(
                    i,
                    if i % 2 == 0 {
                        TransferStatus::Completed
                    } else {
                        TransferStatus::Failed
                    },
                )
            })
            .collect();
        prune_finished(&mut list);
        assert_eq!(list.len(), MAX_KEPT_TASKS);
        assert_eq!(
            list.iter()
                .filter(|t| t.status == TransferStatus::Failed)
                .count(),
            (MAX_KEPT_TASKS + 10) / 2
        );
    }
}

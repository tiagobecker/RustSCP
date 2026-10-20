//! "Keep remote up to date": a debounced file-system watcher for a local folder.
//!
//! Raw notify events are coalesced per path on a dedicated worker thread. A path is
//! reported once it has been quiet for the debounce interval **and** its size/mtime
//! did not change between two checks, so a file that is still being written (a big
//! copy, an editor's temp-write + rename + chmod) produces one event instead of
//! hundreds. Each pending path is classified from the disk state when it settles:
//! it exists -> [`WatchEventKind::Changed`], it is gone -> [`WatchEventKind::Removed`].
//! This works the same for every backend (FSEvents reports renames as two
//! `Name(Any)` events, inotify as `From`/`To` or `Both`).
//!
//! The notify callback never blocks: it only pushes into an unbounded std channel.
//! The worker forwards events with `try_send`, keeping them queued (in order) while
//! the consumer's channel is full.

use crate::types::{CoreError, CoreResult};
use notify::event::{ModifyKind, RenameMode};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};
use tokio::sync::mpsc;

/// What happened to a watched path once its events settled.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum WatchEventKind {
    /// The path exists (created, modified, or renamed into place): upload it, or
    /// create the folder when `is_dir` is true.
    #[default]
    Changed,
    /// The path no longer exists locally (deleted, or renamed away). `is_dir` is always
    /// false for removals because the type can no longer be read from disk; the
    /// consumer decides between `remove_file` and `remove_dir` from the remote
    /// metadata, and only acts when the user enabled delete propagation.
    Removed,
}

#[derive(Debug, Clone)]
pub struct WatchEvent {
    /// Absolute local path (as reported by the OS, canonical form).
    pub path: PathBuf,
    /// Path relative to the watched root, always `/`-separated.
    pub relative_path: String,
    /// True when the path is a directory (always false for removals).
    pub is_dir: bool,
    /// Changed or removed. Consumers written before this field existed treat every
    /// event as an upload; for removals that is a harmless no-op (the local read
    /// fails, and `is_dir` is false so no folder is created).
    pub kind: WatchEventKind,
}

impl WatchEvent {
    pub fn is_removal(&self) -> bool {
        self.kind == WatchEventKind::Removed
    }
}

/// Default quiet period before a path is reported.
pub const DEFAULT_DEBOUNCE: Duration = Duration::from_millis(750);
/// Delay between the two size/mtime checks that prove a file is no longer growing.
const STABILITY_RECHECK: Duration = Duration::from_millis(300);
/// Longest time a path that keeps changing waits before it is reported anyway.
const MAX_PENDING: Duration = Duration::from_secs(10);
/// Upper bound on entries emitted when a folder appears (moved in / renamed).
const MAX_DIR_WALK_ENTRIES: usize = 20_000;
/// Upper bound on events waiting for the consumer; older ones are dropped beyond it.
const MAX_OUTBOX: usize = 100_000;

/// Folder names that are never synced, matched against whole path components.
pub const DEFAULT_IGNORED_DIRS: &[&str] = &[".git", "node_modules", ".svn", ".hg"];

/// True for paths that continuous sync skips: any component named like an ignored
/// folder (`.git`, `node_modules`, ...), and temp/backup files (`*.tmp`, editor swap
/// files, `.DS_Store`, partial downloads). Components are compared exactly, so
/// `.github/`, `.gitignore` or `my_node_modules_backup` are synced.
pub fn is_ignored_path(relative: &Path, ignored_dirs: &[String]) -> bool {
    let mut last: Option<String> = None;
    for comp in relative.components() {
        let name = comp.as_os_str().to_string_lossy();
        if ignored_dirs.iter().any(|d| d.as_str() == name) {
            return true;
        }
        last = Some(name.into_owned());
    }
    let Some(name) = last else {
        return false;
    };
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".tmp")
        || lower.ends_with(".swp")
        || lower.ends_with(".swx")
        || lower.ends_with(".crdownload")
        || name.ends_with('~')
        || name.starts_with(".#")
        || name.starts_with("~$")
        || name == ".DS_Store"
        || name.ends_with("___jb_tmp___")
        || name.ends_with("___jb_old___")
}

/// What a raw event says about one path.
#[derive(Debug, Clone, Copy, Default)]
struct RawHint {
    /// The path was created in this window.
    created: bool,
    /// The path may have disappeared (remove or rename-away).
    gone: bool,
    /// The path appeared through a rename (rename-to / rename-any).
    renamed: bool,
}

/// Maps one notify event to `(path, hint)` pairs; empty for events that never need
/// syncing (reads, metadata-only changes such as chmod/xattr/atime).
fn classify_event(event: &Event) -> Vec<(PathBuf, RawHint)> {
    let hint = |created, gone, renamed| RawHint {
        created,
        gone,
        renamed,
    };
    match event.kind {
        EventKind::Access(_) => Vec::new(),
        EventKind::Modify(ModifyKind::Metadata(_)) => Vec::new(),
        EventKind::Create(_) => event
            .paths
            .iter()
            .map(|p| (p.clone(), hint(true, false, false)))
            .collect(),
        EventKind::Remove(_) => event
            .paths
            .iter()
            .map(|p| (p.clone(), hint(false, true, false)))
            .collect(),
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => {
            let mut out = Vec::new();
            if let Some(from) = event.paths.first() {
                out.push((from.clone(), hint(false, true, false)));
            }
            for to in event.paths.iter().skip(1) {
                out.push((to.clone(), hint(false, false, true)));
            }
            out
        }
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => event
            .paths
            .iter()
            .map(|p| (p.clone(), hint(false, true, false)))
            .collect(),
        EventKind::Modify(ModifyKind::Name(_)) => event
            .paths
            .iter()
            // To / Any / Other: classified from the disk state when it settles.
            .map(|p| (p.clone(), hint(false, true, true)))
            .collect(),
        _ => event
            .paths
            .iter()
            .map(|p| (p.clone(), hint(false, false, false)))
            .collect(),
    }
}

type Signature = (u64, Option<SystemTime>);

#[derive(Debug)]
struct Pending {
    /// When this path started waiting; a file that never stops changing (a log being
    /// appended to) is still reported every [`MAX_PENDING`].
    first_seen: Instant,
    hint: RawHint,
    /// Size/mtime seen at the previous settle check (None until the first check).
    last_sig: Option<Signature>,
    next_check: Instant,
}

/// Per-path coalescing state machine. Fed with raw hints, polled for settled events.
struct Debouncer {
    roots: Vec<PathBuf>,
    excluded: Vec<PathBuf>,
    ignored_dirs: Vec<String>,
    debounce: Duration,
    pending: HashMap<PathBuf, Pending>,
    /// Paths already reported as Changed. A later removal of one of them is always
    /// reported, even when the backend tags the delete with a (stale) "created" flag,
    /// as FSEvents does when it coalesces flags.
    known: HashSet<PathBuf>,
}

/// Upper bound on remembered paths (cleared beyond it; removals then fall back to the
/// created-and-gone heuristic).
const MAX_KNOWN_PATHS: usize = 200_000;

impl Debouncer {
    fn remember(&mut self, events: &[WatchEvent]) {
        for ev in events {
            if ev.is_removal() {
                self.known.remove(&ev.path);
            } else {
                if self.known.len() >= MAX_KNOWN_PATHS {
                    self.known.clear();
                }
                self.known.insert(ev.path.clone());
            }
        }
    }

    fn relative(&self, path: &Path) -> Option<PathBuf> {
        if self.excluded.iter().any(|ex| path.starts_with(ex)) {
            return None;
        }
        for root in &self.roots {
            if let Ok(rel) = path.strip_prefix(root) {
                if rel.as_os_str().is_empty() {
                    // Events on the watched root itself are not synced.
                    return None;
                }
                return Some(rel.to_path_buf());
            }
        }
        None
    }

    fn record(&mut self, path: PathBuf, hint: RawHint, now: Instant) {
        let Some(rel) = self.relative(&path) else {
            return;
        };
        if is_ignored_path(&rel, &self.ignored_dirs) {
            return;
        }
        let debounce = self.debounce;
        let entry = self.pending.entry(path).or_insert(Pending {
            first_seen: now,
            hint: RawHint::default(),
            last_sig: None,
            next_check: now + debounce,
        });
        entry.next_check = (now + debounce).min(entry.first_seen + MAX_PENDING);
        entry.last_sig = None;
        entry.hint.created |= hint.created;
        entry.hint.gone |= hint.gone;
        entry.hint.renamed |= hint.renamed;
    }

    fn make_event(&self, path: PathBuf, is_dir: bool, kind: WatchEventKind) -> Option<WatchEvent> {
        let rel = self.relative(&path)?;
        let relative_path = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/");
        Some(WatchEvent {
            path,
            relative_path,
            is_dir,
            kind,
        })
    }

    /// Emits a Changed event for every entry below a folder that just appeared (moved
    /// or renamed in): those children produce no events of their own.
    fn walk_new_dir(&self, dir: &Path, out: &mut Vec<WatchEvent>) {
        let mut stack = vec![dir.to_path_buf()];
        let mut emitted = 0usize;
        while let Some(d) = stack.pop() {
            let Ok(reader) = std::fs::read_dir(&d) else {
                continue;
            };
            for entry in reader.flatten() {
                if emitted >= MAX_DIR_WALK_ENTRIES {
                    tracing::warn!(
                        "continuous sync: folder {} has more than {} entries, rest skipped",
                        dir.display(),
                        MAX_DIR_WALK_ENTRIES
                    );
                    return;
                }
                let p = entry.path();
                let Some(rel) = self.relative(&p) else {
                    continue;
                };
                if is_ignored_path(&rel, &self.ignored_dirs) {
                    continue;
                }
                // Never follow symlinks while walking (no loops).
                let Ok(ft) = entry.file_type() else {
                    continue;
                };
                let is_dir = ft.is_dir();
                if is_dir {
                    stack.push(p.clone());
                }
                if let Some(ev) = self.make_event(p, is_dir, WatchEventKind::Changed) {
                    out.push(ev);
                    emitted += 1;
                }
            }
        }
    }

    /// Returns the events of every path that has settled, ordered: folders (parents
    /// first), then files, then removals (children of a removed folder dropped).
    fn poll(&mut self, now: Instant) -> Vec<WatchEvent> {
        let due: Vec<PathBuf> = self
            .pending
            .iter()
            .filter(|(_, p)| p.next_check <= now)
            .map(|(k, _)| k.clone())
            .collect();
        if due.is_empty() {
            return Vec::new();
        }

        let mut dirs: Vec<WatchEvent> = Vec::new();
        let mut files: Vec<WatchEvent> = Vec::new();
        let mut removed: Vec<PathBuf> = Vec::new();

        for path in due {
            let Some(p) = self.pending.get_mut(&path) else {
                continue;
            };
            match std::fs::symlink_metadata(&path) {
                Ok(meta) => {
                    // Follow a symlink to decide what it points to (the consumer reads
                    // through it); a dangling link is skipped.
                    let meta = if meta.file_type().is_symlink() {
                        match std::fs::metadata(&path) {
                            Ok(m) => m,
                            Err(_) => {
                                self.pending.remove(&path);
                                continue;
                            }
                        }
                    } else {
                        meta
                    };
                    if meta.is_dir() {
                        let hint = p.hint;
                        self.pending.remove(&path);
                        // A plain "modified" event on a folder (a child changed) needs
                        // nothing: the child has its own events.
                        if hint.created || hint.renamed || hint.gone {
                            if let Some(ev) =
                                self.make_event(path.clone(), true, WatchEventKind::Changed)
                            {
                                dirs.push(ev);
                            }
                            let mut children = Vec::new();
                            self.walk_new_dir(&path, &mut children);
                            for ev in children {
                                if ev.is_dir {
                                    dirs.push(ev);
                                } else {
                                    files.push(ev);
                                }
                            }
                        }
                        continue;
                    }
                    let sig: Signature = (meta.len(), meta.modified().ok());
                    let overdue = now.duration_since(p.first_seen) >= MAX_PENDING;
                    if p.last_sig == Some(sig) || overdue {
                        self.pending.remove(&path);
                        if let Some(ev) = self.make_event(path, false, WatchEventKind::Changed) {
                            files.push(ev);
                        }
                    } else {
                        // Still being written, or first check: look again shortly.
                        p.last_sig = Some(sig);
                        p.next_check = now + STABILITY_RECHECK;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    let hint = p.hint;
                    self.pending.remove(&path);
                    // Created and deleted inside one window (editor temp file, vim's
                    // 4913 probe): it never reached the remote, nothing to remove.
                    if hint.created && !hint.renamed && !self.known.contains(&path) {
                        continue;
                    }
                    removed.push(path);
                }
                Err(_) => {
                    self.pending.remove(&path);
                }
            }
        }

        // Parents before children, so folders exist before their content is uploaded.
        dirs.sort_by_key(|e| e.path.components().count());
        let mut seen = HashSet::new();
        dirs.retain(|e| seen.insert(e.path.clone()));
        files.retain(|e| seen.insert(e.path.clone()));

        // Removing a folder removes its subtree: drop removals below another one.
        let removed_set: HashSet<PathBuf> = removed.iter().cloned().collect();
        let mut removals: Vec<WatchEvent> = Vec::new();
        removed.sort_by_key(|p| p.components().count());
        for path in removed {
            let covered = path.ancestors().skip(1).any(|a| removed_set.contains(a));
            if covered {
                continue;
            }
            if let Some(ev) = self.make_event(path, false, WatchEventKind::Removed) {
                removals.push(ev);
            }
        }

        let mut out = dirs;
        out.extend(files);
        out.extend(removals);
        self.remember(&out);
        out
    }

    fn next_deadline(&self) -> Option<Instant> {
        self.pending.values().map(|p| p.next_check).min()
    }
}

pub struct ContinuousSyncWatcher {
    local_root: PathBuf,
    watcher: Option<RecommendedWatcher>,
    event_tx: mpsc::Sender<WatchEvent>,
    debounce: Duration,
    ignored_dirs: Vec<String>,
    excluded: Vec<PathBuf>,
    stop_flag: Arc<AtomicBool>,
}

impl ContinuousSyncWatcher {
    pub fn new(local_root: impl Into<PathBuf>, event_tx: mpsc::Sender<WatchEvent>) -> Self {
        Self {
            local_root: local_root.into(),
            watcher: None,
            event_tx,
            debounce: DEFAULT_DEBOUNCE,
            ignored_dirs: DEFAULT_IGNORED_DIRS.iter().map(|s| s.to_string()).collect(),
            excluded: Vec::new(),
            stop_flag: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Quiet period a path must reach before it is reported (default 750 ms).
    pub fn with_debounce(mut self, debounce: Duration) -> Self {
        self.debounce = debounce;
        self
    }

    /// Replaces the folder names that are never synced (default: `.git`,
    /// `node_modules`, `.svn`, `.hg`). Matched against whole path components.
    pub fn with_ignored_dirs<I, S>(mut self, names: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.ignored_dirs = names.into_iter().map(Into::into).collect();
        self
    }

    /// Ignores every event at or below `path`. Use it when the sync destination is
    /// itself inside the watched folder (a Local session), so uploads cannot trigger
    /// new events forever. Call before [`start`](Self::start).
    pub fn exclude_path(&mut self, path: impl Into<PathBuf>) {
        let p: PathBuf = path.into();
        if let Ok(c) = std::fs::canonicalize(&p) {
            if c != p {
                self.excluded.push(c);
            }
        }
        self.excluded.push(p);
    }

    pub fn local_root(&self) -> &Path {
        &self.local_root
    }

    pub fn start(&mut self) -> CoreResult<()> {
        if self.watcher.is_some() {
            return Ok(());
        }
        if !self.local_root.is_dir() {
            return Err(CoreError::NotFound(format!(
                "Local folder '{}' does not exist or is not a folder",
                self.local_root.display()
            )));
        }

        // Backends report canonical paths (macOS: /private/var/... for /var/...), so
        // relative paths are computed against both spellings of the root.
        let mut roots = Vec::new();
        if let Ok(c) = std::fs::canonicalize(&self.local_root) {
            roots.push(c);
        }
        if !roots.contains(&self.local_root) {
            roots.push(self.local_root.clone());
        }

        self.stop_flag = Arc::new(AtomicBool::new(false));
        let (raw_tx, raw_rx) = std_mpsc::channel::<(PathBuf, RawHint)>();

        let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            match res {
                Ok(event) => {
                    if event.need_rescan() {
                        tracing::warn!(
                            "continuous sync: the OS dropped file events; changes made \
                             during the gap are synced on their next modification"
                        );
                    }
                    for item in classify_event(&event) {
                        // Unbounded and non-blocking: the notify thread never stalls.
                        let _ = raw_tx.send(item);
                    }
                }
                Err(e) => tracing::warn!("continuous sync watcher error: {e}"),
            }
        })
        .map_err(|e| CoreError::General(format!("Failed to create file watcher: {}", e)))?;

        watcher
            .watch(&self.local_root, RecursiveMode::Recursive)
            .map_err(|e| CoreError::General(format!("Failed to watch directory: {}", e)))?;

        let debouncer = Debouncer {
            roots,
            excluded: self.excluded.clone(),
            ignored_dirs: self.ignored_dirs.clone(),
            debounce: self.debounce,
            pending: HashMap::new(),
            known: HashSet::new(),
        };
        let tx = self.event_tx.clone();
        let stop = self.stop_flag.clone();
        std::thread::Builder::new()
            .name("rustscp-sync-debounce".to_string())
            .spawn(move || run_debouncer(debouncer, raw_rx, tx, stop))
            .map_err(|e| CoreError::General(format!("Failed to start sync worker: {}", e)))?;

        self.watcher = Some(watcher);
        Ok(())
    }

    pub fn is_watching(&self) -> bool {
        self.watcher.is_some()
    }

    pub fn stop(&mut self) {
        self.stop_flag.store(true, Ordering::SeqCst);
        if let Some(mut w) = self.watcher.take() {
            let _ = w.unwatch(&self.local_root);
            // Dropping the watcher drops the raw sender, which wakes the worker.
        }
    }
}

impl Drop for ContinuousSyncWatcher {
    fn drop(&mut self) {
        self.stop();
    }
}

fn run_debouncer(
    mut debouncer: Debouncer,
    raw_rx: std_mpsc::Receiver<(PathBuf, RawHint)>,
    tx: mpsc::Sender<WatchEvent>,
    stop: Arc<AtomicBool>,
) {
    let idle = Duration::from_millis(500);
    let mut outbox: VecDeque<WatchEvent> = VecDeque::new();
    let mut disconnected = false;

    loop {
        if stop.load(Ordering::SeqCst) {
            return;
        }
        let now = Instant::now();
        let mut wait = debouncer
            .next_deadline()
            .map(|d| d.saturating_duration_since(now))
            .unwrap_or(idle)
            .min(idle);
        if !outbox.is_empty() {
            wait = wait.min(Duration::from_millis(100));
        }

        if !disconnected {
            match raw_rx.recv_timeout(wait.max(Duration::from_millis(10))) {
                Ok((path, hint)) => {
                    let now = Instant::now();
                    debouncer.record(path, hint, now);
                    // Drain the burst without waiting.
                    while let Ok((path, hint)) = raw_rx.try_recv() {
                        debouncer.record(path, hint, now);
                    }
                }
                Err(std_mpsc::RecvTimeoutError::Timeout) => {}
                Err(std_mpsc::RecvTimeoutError::Disconnected) => disconnected = true,
            }
        } else {
            if debouncer.pending.is_empty() && outbox.is_empty() {
                return;
            }
            std::thread::sleep(wait.max(Duration::from_millis(10)));
        }

        if stop.load(Ordering::SeqCst) {
            return;
        }

        outbox.extend(debouncer.poll(Instant::now()));
        if outbox.len() > MAX_OUTBOX {
            let excess = outbox.len() - MAX_OUTBOX;
            tracing::warn!("continuous sync: consumer too slow, dropping {excess} events");
            outbox.drain(..excess);
        }
        while let Some(ev) = outbox.pop_front() {
            match tx.try_send(ev) {
                Ok(()) => {}
                Err(mpsc::error::TrySendError::Full(ev)) => {
                    outbox.push_front(ev);
                    break;
                }
                Err(mpsc::error::TrySendError::Closed(_)) => return,
            }
        }
    }
}

pub struct ContinuousSyncManager {
    is_running: std::sync::atomic::AtomicBool,
    cancel_tx: Option<tokio::sync::broadcast::Sender<()>>,
}

impl Default for ContinuousSyncManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ContinuousSyncManager {
    pub fn new() -> Self {
        Self {
            is_running: std::sync::atomic::AtomicBool::new(false),
            cancel_tx: None,
        }
    }

    pub fn is_active(&self) -> bool {
        self.is_running.load(std::sync::atomic::Ordering::SeqCst)
    }

    pub fn stop(&mut self) {
        if let Some(tx) = self.cancel_tx.take() {
            let _ = tx.send(());
        }
        self.is_running
            .store(false, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn set_active(&mut self, cancel_tx: tokio::sync::broadcast::Sender<()>) {
        self.cancel_tx = Some(cancel_tx);
        self.is_running
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn defaults() -> Vec<String> {
        DEFAULT_IGNORED_DIRS.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn continuous_ignore_filter_matches_components() {
        let ig = defaults();
        assert!(is_ignored_path(Path::new(".git/HEAD"), &ig));
        assert!(is_ignored_path(Path::new("a/node_modules/x/y.js"), &ig));
        assert!(is_ignored_path(Path::new("notes.tmp"), &ig));
        assert!(is_ignored_path(Path::new("src/.main.rs.swp"), &ig));
        assert!(is_ignored_path(Path::new("dir/.DS_Store"), &ig));
        assert!(!is_ignored_path(
            Path::new(".github/workflows/deploy.yml"),
            &ig
        ));
        assert!(!is_ignored_path(Path::new(".gitignore"), &ig));
        assert!(!is_ignored_path(Path::new(".gitlab-ci.yml"), &ig));
        assert!(!is_ignored_path(
            Path::new("user.github.io/index.html"),
            &ig
        ));
        assert!(!is_ignored_path(
            Path::new("my_node_modules_backup/a.txt"),
            &ig
        ));
        assert!(!is_ignored_path(Path::new("relatório ação.txt"), &ig));
    }

    fn debouncer(root: &Path) -> Debouncer {
        let canon = std::fs::canonicalize(root).unwrap();
        Debouncer {
            roots: vec![canon, root.to_path_buf()],
            excluded: Vec::new(),
            ignored_dirs: defaults(),
            debounce: Duration::from_millis(50),
            pending: HashMap::new(),
            known: HashSet::new(),
        }
    }

    fn settle(d: &mut Debouncer) -> Vec<WatchEvent> {
        let mut all = Vec::new();
        let start = Instant::now();
        while !d.pending.is_empty() && start.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(20));
            all.extend(d.poll(Instant::now()));
        }
        all
    }

    #[test]
    fn continuous_debounce_coalesces_and_classifies() {
        let tmp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(tmp.path()).unwrap();
        let mut d = debouncer(&root);
        let file = root.join("ação (1).txt");
        std::fs::write(&file, b"v1").unwrap();
        let now = Instant::now();
        for _ in 0..50 {
            d.record(
                file.clone(),
                RawHint {
                    created: true,
                    ..Default::default()
                },
                now,
            );
        }
        let evs = settle(&mut d);
        assert_eq!(evs.len(), 1, "{evs:?}");
        assert_eq!(evs[0].kind, WatchEventKind::Changed);
        assert_eq!(evs[0].relative_path, "ação (1).txt");
        assert!(!evs[0].is_dir);

        // Removal of a file that existed before the window.
        std::fs::remove_file(&file).unwrap();
        d.record(
            file.clone(),
            RawHint {
                gone: true,
                ..Default::default()
            },
            Instant::now(),
        );
        let evs = settle(&mut d);
        assert_eq!(evs.len(), 1);
        assert!(evs[0].is_removal());
        assert!(!evs[0].is_dir);

        // Transient temp file: created and deleted inside one window -> nothing.
        let t = root.join("transient.bin");
        d.record(
            t.clone(),
            RawHint {
                created: true,
                ..Default::default()
            },
            Instant::now(),
        );
        d.record(
            t,
            RawHint {
                gone: true,
                ..Default::default()
            },
            Instant::now(),
        );
        assert!(settle(&mut d).is_empty());

        // A file reported earlier is removed even if the delete carries a stale
        // "created" flag (FSEvents coalescing).
        let k = root.join("known.txt");
        std::fs::write(&k, b"k").unwrap();
        d.record(k.clone(), RawHint::default(), Instant::now());
        assert_eq!(settle(&mut d).len(), 1);
        std::fs::remove_file(&k).unwrap();
        d.record(
            k.clone(),
            RawHint {
                created: true,
                gone: true,
                renamed: false,
            },
            Instant::now(),
        );
        let evs = settle(&mut d);
        assert_eq!(evs.len(), 1);
        assert!(evs[0].is_removal());
    }

    #[test]
    fn continuous_renamed_folder_emits_children_and_dedups_removals() {
        let tmp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(tmp.path()).unwrap();
        let mut d = debouncer(&root);
        let new_dir = root.join("new");
        std::fs::create_dir_all(new_dir.join("sub")).unwrap();
        std::fs::write(new_dir.join("a.txt"), b"a").unwrap();
        std::fs::write(new_dir.join("sub/b.txt"), b"b").unwrap();
        std::fs::create_dir_all(new_dir.join(".git")).unwrap();
        std::fs::write(new_dir.join(".git/config"), b"x").unwrap();
        let old = root.join("old");
        let now = Instant::now();
        d.record(
            old.clone(),
            RawHint {
                gone: true,
                ..Default::default()
            },
            now,
        );
        d.record(
            old.join("a.txt"),
            RawHint {
                gone: true,
                ..Default::default()
            },
            now,
        );
        d.record(
            new_dir.clone(),
            RawHint {
                renamed: true,
                ..Default::default()
            },
            now,
        );
        let evs = settle(&mut d);
        let rels: Vec<(String, bool, WatchEventKind)> = evs
            .iter()
            .map(|e| (e.relative_path.clone(), e.is_dir, e.kind))
            .collect();
        assert_eq!(rels[0], ("new".to_string(), true, WatchEventKind::Changed));
        assert!(rels.contains(&("new/sub".to_string(), true, WatchEventKind::Changed)));
        assert!(rels.contains(&("new/a.txt".to_string(), false, WatchEventKind::Changed)));
        assert!(rels.contains(&("new/sub/b.txt".to_string(), false, WatchEventKind::Changed)));
        assert!(!rels.iter().any(|r| r.0.contains(".git")));
        let removals: Vec<_> = rels
            .iter()
            .filter(|r| r.2 == WatchEventKind::Removed)
            .collect();
        assert_eq!(removals.len(), 1, "{rels:?}");
        assert_eq!(removals[0].0, "old");
        // Folders come before files.
        let first_file = rels.iter().position(|r| !r.1).unwrap();
        assert!(rels[..first_file].iter().all(|r| r.1));
    }

    #[test]
    fn continuous_busy_file_is_reported_after_max_pending() {
        let tmp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(tmp.path()).unwrap();
        let mut d = debouncer(&root);
        let f = root.join("app.log");
        std::fs::write(&f, b"1").unwrap();
        let t0 = Instant::now();
        d.record(f.clone(), RawHint::default(), t0);
        // Events keep arriving; the deadline never moves past first_seen + MAX_PENDING.
        d.record(
            f.clone(),
            RawHint::default(),
            t0 + MAX_PENDING - Duration::from_millis(1),
        );
        assert!(d
            .poll(t0 + MAX_PENDING - Duration::from_millis(1))
            .is_empty());
        let evs = d.poll(t0 + MAX_PENDING);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].relative_path, "app.log");
    }

    #[test]
    fn continuous_excluded_and_root_paths_are_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(tmp.path()).unwrap();
        let mut d = debouncer(&root);
        d.excluded.push(root.join("mirror"));
        std::fs::create_dir_all(root.join("mirror")).unwrap();
        std::fs::write(root.join("mirror/x"), b"x").unwrap();
        d.record(root.join("mirror/x"), RawHint::default(), Instant::now());
        d.record(root.clone(), RawHint::default(), Instant::now());
        assert!(d.pending.is_empty());
    }

    #[tokio::test]
    async fn continuous_watcher_reports_once_per_change() {
        let tmp = tempfile::tempdir().unwrap();
        let (tx, mut rx) = mpsc::channel(4);
        let mut w =
            ContinuousSyncWatcher::new(tmp.path(), tx).with_debounce(Duration::from_millis(200));
        w.start().unwrap();
        // Give the backend a moment to arm (FSEvents has a short startup latency).
        tokio::time::sleep(Duration::from_millis(300)).await;
        let file = tmp.path().join("doc.txt");
        for i in 0..10 {
            std::fs::write(&file, format!("version {i}")).unwrap();
        }
        let ev = tokio::time::timeout(Duration::from_secs(10), rx.recv())
            .await
            .expect("no event")
            .unwrap();
        assert_eq!(ev.relative_path, "doc.txt");
        assert_eq!(ev.kind, WatchEventKind::Changed);
        // No duplicate burst for the same settled change.
        let extra = tokio::time::timeout(Duration::from_millis(1500), rx.recv()).await;
        if let Ok(Some(e)) = extra {
            assert_eq!(e.relative_path, "doc.txt");
        }
        w.stop();
        assert!(!w.is_watching());
    }

    #[test]
    fn continuous_start_fails_for_missing_folder() {
        let (tx, _rx) = mpsc::channel(1);
        let mut w = ContinuousSyncWatcher::new("/definitely/not/here/rustscp", tx);
        assert!(w.start().is_err());
    }
}

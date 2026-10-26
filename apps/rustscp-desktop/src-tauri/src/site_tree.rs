//! The Connect dialog's connections tree: folders, favorites, recents, labels and the
//! collapsed state (`site-layout.vault`, see [`rustscp_core::site_layout`]), and batched
//! changes to the saved sites with undo.
//!
//! Secrets stay here: results carry [`redact_sites`] copies, copies of sites are made
//! here, and undo snapshots (full configs) live in memory only, at most
//! [`UNDO_MAX_ENTRIES`] of them (and [`UNDO_MAX_SITE_RECORDS`] site records) for
//! [`UNDO_LIFETIME`], dropped on quit.
//!
//! Locks are always taken in the same order: `AppState::saved_sites`, then the layout,
//! then (inside the vault functions) the vault's own key lock. Every layout write happens
//! while holding the first two, so writes never overtake each other and never run beside
//! a write of `sites.vault`.
//!
//! While the saved sites could not be loaded at startup (`AppState::vault_load_error`),
//! the layout is read-only for the run: reconciling it with the sites in memory would
//! drop the favorites, labels and recents of every site that is not loaded.

use crate::commands::{ensure_vault_writable, normalize_site_id, redact_sites, AppState};
use rustscp_core::site_layout::{
    self, apply_ops, check_op_limits, reconcile, CreatedSite, LoadedSiteLayout, SiteLayout,
    SiteTreeOp, UndoReport, UndoSnapshot, ERR_LAYOUT_READ_ONLY, ERR_NOT_FOUND, ERR_UNDO_EXPIRED,
    LOCAL_SITE_ID, MAX_COLLAPSED, WARN_LAYOUT_UNAVAILABLE,
};
use rustscp_core::{ConnectionConfig, VaultError};
use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tokio::sync::RwLock;

/// Undo entries kept (oldest dropped first).
const UNDO_MAX_ENTRIES: usize = 20;
/// Site records ([`UndoSnapshot::site_records`]) kept across the undo entries: older
/// entries go first; the newest entry always stays.
const UNDO_MAX_SITE_RECORDS: usize = 100_000;
/// How long a change can be undone.
const UNDO_LIFETIME: Duration = Duration::from_secs(15 * 60);
/// Debounce of layout writes after a view change (collapsed folders and the like).
const VIEW_WRITE_DELAY: Duration = Duration::from_millis(800);
/// Debounce of layout writes after a connection is recorded as recent.
const RECENT_WRITE_DELAY: Duration = Duration::from_secs(2);
/// Longest the exit handler waits for the last layout write.
const EXIT_FLUSH_TIMEOUT: Duration = Duration::from_secs(2);
/// `SiteTreeResult::warnings`: the layout part of a change could not be written.
const WARN_LAYOUT_NOT_SAVED: &str = "layout_not_saved";
/// `SiteTreeResult::warnings`: the layout is read-only, its part of a change is kept in
/// memory for this run only.
const WARN_LAYOUT_READ_ONLY: &str = "layout_read_only";

#[derive(Default)]
pub struct SiteTreeState {
    /// Loaded on first use.
    layout: tokio::sync::Mutex<Option<LayoutSlot>>,
    /// Newest last.
    undo: std::sync::Mutex<VecDeque<UndoEntry>>,
    /// Debounce generation of the delayed layout writes.
    view_write_gen: AtomicU64,
}

struct LayoutSlot {
    layout: SiteLayout,
    /// Never written back (a newer version, its file or key could not be read, or the
    /// saved sites could not be loaded).
    read_only: bool,
    /// Changed in memory since the last write.
    dirty: bool,
    /// Load warning, `"[code] message"`.
    warning: Option<String>,
}

struct UndoEntry {
    token: String,
    label: Option<String>,
    created: Instant,
    snapshot: UndoSnapshot,
}

#[derive(Debug, Serialize)]
pub struct SiteLayoutResponse {
    pub layout: SiteLayout,
    /// Layout changes are not kept (also while saved sites cannot be written).
    pub read_only: bool,
    pub warning: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SiteTreeResult {
    /// The whole saved-site list after the change, secrets replaced by the marker.
    pub sites: Vec<ConnectionConfig>,
    pub layout: SiteLayout,
    /// `undo-<uuid>` for [`undo_site_tree_ops`]; `None` when nothing changed.
    pub undo_token: Option<String>,
    /// Copies made by `copy_sites` / `copy_folder`.
    pub created: Vec<CreatedSite>,
    /// Set by an undo.
    pub undo_report: Option<UndoReport>,
    /// [`WARN_LAYOUT_NOT_SAVED`], [`WARN_LAYOUT_READ_ONLY`].
    pub warnings: Vec<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
pub struct SiteTreeViewPatch {
    /// The full set of collapsed folders.
    pub collapsed: Option<Vec<String>>,
    pub forget_recents: Option<Vec<String>>,
    pub clear_recents: bool,
    /// One-time migration, newest first; used only while there are no recents.
    pub seed_recents: Option<Vec<String>>,
    pub migrated_local_storage: Option<bool>,
    pub large_library_collapsed: Option<bool>,
}

// ---------------------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------------------

/// Where the tree's data is written: the vault files in the app, memory in tests.
trait TreeStorage: Sync {
    async fn save_sites(&self, sites: Vec<ConnectionConfig>) -> Result<(), VaultError>;
    /// `keep_file`: the saved sites could not be loaded, so a layout file that does not
    /// open must stay where it is (read-only), never be moved aside.
    async fn load_layout(&self, keep_file: bool) -> LoadedSiteLayout;
    async fn save_layout(&self, layout: SiteLayout) -> Result<(), VaultError>;
}

/// `sites.vault` and `site-layout.vault` in the config folder.
struct VaultFiles;

impl TreeStorage for VaultFiles {
    async fn save_sites(&self, sites: Vec<ConnectionConfig>) -> Result<(), VaultError> {
        rustscp_core::vault::save_local_vault_async(sites).await
    }

    async fn load_layout(&self, keep_file: bool) -> LoadedSiteLayout {
        site_layout::load_site_layout_async(keep_file).await
    }

    async fn save_layout(&self, layout: SiteLayout) -> Result<(), VaultError> {
        site_layout::save_site_layout_async(layout).await
    }
}

/// What the tree works on.
struct TreeCx<'a, S> {
    storage: &'a S,
    sites: &'a RwLock<Vec<ConnectionConfig>>,
    /// Why saved sites cannot be written in this run (`AppState::vault_save_blocked`).
    blocked: Option<&'a str>,
    /// Why saved sites could not be loaded at startup (`AppState::vault_load_error`):
    /// the layout is then read-only for the run.
    vault_unread: Option<&'a str>,
}

fn app_cx(app: &AppState) -> TreeCx<'_, VaultFiles> {
    TreeCx {
        storage: &VaultFiles,
        sites: &app.saved_sites,
        blocked: app.vault_save_blocked.as_deref(),
        vault_unread: app.vault_load_error.as_deref(),
    }
}

fn vault_error(e: VaultError) -> String {
    format!("[{}] {e}", e.code())
}

fn lock<T>(m: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

async fn loaded_slot<'a, S: TreeStorage>(
    cx: &TreeCx<'_, S>,
    slot: &'a mut Option<LayoutSlot>,
) -> &'a mut LayoutSlot {
    if slot.is_none() {
        let mut loaded = cx.storage.load_layout(cx.vault_unread.is_some()).await;
        if let Some(warning) = &loaded.warning {
            tracing::warn!("site layout: {warning}");
        }
        if let Some(error) = cx.vault_unread {
            loaded.read_only = true;
            loaded.warning = Some(format!(
                "[{WARN_LAYOUT_UNAVAILABLE}] The saved sites could not be read ({error}); \
                 folders, favorites and labels are read-only until they can be"
            ));
        }
        *slot = Some(LayoutSlot {
            layout: loaded.layout,
            read_only: loaded.read_only,
            dirty: false,
            warning: loaded.warning,
        });
    }
    slot.as_mut().expect("the layout was loaded above")
}

fn layout_writable<S>(slot: &LayoutSlot, cx: &TreeCx<'_, S>) -> bool {
    !slot.read_only && cx.blocked.is_none() && cx.vault_unread.is_none()
}

/// Writes the layout when it changed since the last write and may be written.
async fn write_if_dirty<S: TreeStorage>(
    cx: &TreeCx<'_, S>,
    slot: &mut LayoutSlot,
) -> Result<(), String> {
    if !slot.dirty || !layout_writable(slot, cx) {
        return Ok(());
    }
    match cx.storage.save_layout(slot.layout.clone()).await {
        Ok(()) => {
            slot.dirty = false;
            Ok(())
        }
        Err(e) => {
            tracing::warn!("could not save the site layout: {e}");
            Err(vault_error(e))
        }
    }
}

// ---------------------------------------------------------------------------------------
// Undo entries
// ---------------------------------------------------------------------------------------

fn prune_undo(queue: &mut VecDeque<UndoEntry>, now: Instant) {
    queue.retain(|e| now.saturating_duration_since(e.created) < UNDO_LIFETIME);
}

fn push_undo(queue: &mut VecDeque<UndoEntry>, entry: UndoEntry, now: Instant) {
    prune_undo(queue, now);
    queue.push_back(entry);
    while queue.len() > UNDO_MAX_ENTRIES {
        queue.pop_front();
    }
    // Snapshots hold whole configs: bound what they keep in memory.
    let mut records: usize = queue.iter().map(|e| e.snapshot.site_records()).sum();
    while records > UNDO_MAX_SITE_RECORDS && queue.len() > 1 {
        if let Some(oldest) = queue.pop_front() {
            records -= oldest.snapshot.site_records();
        }
    }
}

fn take_undo(queue: &mut VecDeque<UndoEntry>, token: &str, now: Instant) -> Option<UndoEntry> {
    prune_undo(queue, now);
    let position = queue.iter().position(|e| e.token == token)?;
    queue.remove(position)
}

// ---------------------------------------------------------------------------------------
// View changes
// ---------------------------------------------------------------------------------------

/// Applies a view change to the layout; returns whether it changed. Collapsed paths are
/// kept only for existing folders (the layout is reconciled first).
fn apply_view_patch(
    layout: &mut SiteLayout,
    patch: &SiteTreeViewPatch,
    is_saved_site: &dyn Fn(&str) -> bool,
) -> bool {
    let before = layout.clone();
    if let Some(collapsed) = &patch.collapsed {
        let folders = &layout.folders;
        let kept = collapsed
            .iter()
            .filter_map(|p| site_layout::normalize_folder_path(p).ok().flatten())
            .filter(|p| folders.contains(p))
            .take(MAX_COLLAPSED)
            .collect();
        layout.collapsed = kept;
    }
    if patch.clear_recents {
        layout.recents.clear();
    }
    if let Some(forget) = &patch.forget_recents {
        layout.recents.retain(|r| !forget.contains(&r.id));
    }
    if let Some(seed) = &patch.seed_recents {
        site_layout::seed_recents(layout, seed, is_saved_site);
    }
    if let Some(migrated) = patch.migrated_local_storage {
        layout.migrated_local_storage = migrated;
    }
    if let Some(collapsed) = patch.large_library_collapsed {
        layout.large_library_collapsed = collapsed;
    }
    *layout != before
}

// ---------------------------------------------------------------------------------------
// The work behind the commands
// ---------------------------------------------------------------------------------------

impl SiteTreeState {
    /// The reconciled layout. The bool asks for a delayed write.
    async fn layout_view<S: TreeStorage>(&self, cx: &TreeCx<'_, S>) -> (SiteLayoutResponse, bool) {
        let sites = cx.sites.read().await;
        let mut guard = self.layout.lock().await;
        let slot = loaded_slot(cx, &mut guard).await;
        let writable = layout_writable(slot, cx);
        // A read-only layout is reconciled for the view only: never marked for a write.
        if reconcile(&mut slot.layout, &sites) && writable {
            slot.dirty = true;
        }
        let response = SiteLayoutResponse {
            layout: slot.layout.clone(),
            read_only: !writable,
            warning: slot.warning.clone(),
        };
        (response, slot.dirty && writable)
    }

    async fn apply<S: TreeStorage>(
        &self,
        cx: &TreeCx<'_, S>,
        ops: Vec<SiteTreeOp>,
        label: Option<String>,
    ) -> Result<SiteTreeResult, String> {
        if let Some(reason) = cx.blocked {
            return Err(reason.to_string());
        }
        check_op_limits(&ops).map_err(|e| e.to_string())?;
        let mut sites = cx.sites.write().await;
        let mut guard = self.layout.lock().await;
        let slot = loaded_slot(cx, &mut guard).await;
        // Folder ops are refused too: sites.vault would get the new folder paths and the
        // layout file would keep its labels, favorites and collapsed state at the old ones.
        let read_only = slot.read_only || cx.vault_unread.is_some();
        if read_only
            && ops
                .iter()
                .any(|op| op.changes_layout_only() || op.rewrites_folder_paths())
        {
            return Err(match cx.vault_unread {
                Some(_) => format!(
                    "[{ERR_LAYOUT_READ_ONLY}] Folders, favorites and labels are read-only \
                     until the saved sites can be read"
                ),
                None => format!(
                    "[{ERR_LAYOUT_READ_ONLY}] Folders, favorites and labels are read-only in \
                     this session"
                ),
            });
        }

        // The batch runs on copies: on any error nothing changes.
        let mut new_sites = sites.clone();
        let mut new_layout = slot.layout.clone();
        let outcome = apply_ops(&mut new_sites, &mut new_layout, &ops, &mut || {
            normalize_site_id("")
        })
        .map_err(|e| e.to_string())?;

        if outcome.sites_changed {
            // One write for the whole batch, so sites.vault.bak keeps the list from before it.
            cx.storage
                .save_sites(new_sites.clone())
                .await
                .map_err(vault_error)?;
            *sites = new_sites;
        }
        let warnings = self
            .store_layout(cx, slot, new_layout, outcome.layout_changed)
            .await;

        let undo_token = (outcome.sites_changed || outcome.layout_changed).then(|| {
            let token = format!("undo-{}", uuid::Uuid::new_v4().simple());
            let now = Instant::now();
            let entry = UndoEntry {
                token: token.clone(),
                label,
                created: now,
                snapshot: outcome.undo,
            };
            push_undo(&mut lock(&self.undo), entry, now);
            token
        });
        Ok(SiteTreeResult {
            sites: redact_sites(&sites),
            layout: slot.layout.clone(),
            undo_token,
            created: outcome.created,
            undo_report: None,
            warnings,
        })
    }

    /// Puts `layout` in place and writes it right away (after `sites.vault`), still under
    /// the layout lock. Returns the warnings for the result.
    async fn store_layout<S: TreeStorage>(
        &self,
        cx: &TreeCx<'_, S>,
        slot: &mut LayoutSlot,
        layout: SiteLayout,
        changed: bool,
    ) -> Vec<String> {
        let mut warnings = Vec::new();
        slot.layout = layout;
        if changed {
            slot.dirty = true;
            if !layout_writable(slot, cx) {
                warnings.push(WARN_LAYOUT_READ_ONLY.to_string());
            }
        }
        if write_if_dirty(cx, slot).await.is_err() {
            warnings.push(WARN_LAYOUT_NOT_SAVED.to_string());
        }
        warnings
    }

    async fn undo<S: TreeStorage>(
        &self,
        cx: &TreeCx<'_, S>,
        token: &str,
    ) -> Result<SiteTreeResult, String> {
        if let Some(reason) = cx.blocked {
            return Err(reason.to_string());
        }
        let entry = take_undo(&mut lock(&self.undo), token, Instant::now())
            .ok_or_else(|| format!("[{ERR_UNDO_EXPIRED}] This change can no longer be undone"))?;
        tracing::debug!(label = ?entry.label, "undoing a connections-tree change");
        let mut sites = cx.sites.write().await;
        let mut guard = self.layout.lock().await;
        let slot = loaded_slot(cx, &mut guard).await;

        let mut new_sites = sites.clone();
        let mut new_layout = slot.layout.clone();
        let report = site_layout::undo(&entry.snapshot, &mut new_sites, &mut new_layout);
        if report.restored > 0 {
            if let Err(e) = cx.storage.save_sites(new_sites.clone()).await {
                // Nothing changed: keep the entry so the undo can be tried again.
                push_undo(&mut lock(&self.undo), entry, Instant::now());
                return Err(vault_error(e));
            }
            *sites = new_sites;
        }
        let changed = new_layout != slot.layout;
        let warnings = self.store_layout(cx, slot, new_layout, changed).await;
        Ok(SiteTreeResult {
            sites: redact_sites(&sites),
            layout: slot.layout.clone(),
            undo_token: None,
            created: Vec::new(),
            undo_report: Some(report),
            warnings,
        })
    }

    fn forget_undo(&self) {
        lock(&self.undo).clear();
    }

    /// Returns whether a delayed write is wanted.
    async fn set_view<S: TreeStorage>(
        &self,
        cx: &TreeCx<'_, S>,
        patch: &SiteTreeViewPatch,
    ) -> bool {
        let sites = cx.sites.read().await;
        let mut guard = self.layout.lock().await;
        let slot = loaded_slot(cx, &mut guard).await;
        let reconciled = reconcile(&mut slot.layout, &sites);
        let saved: HashSet<&str> = match patch.seed_recents {
            Some(_) => sites.iter().map(|s| s.id.as_str()).collect(),
            None => HashSet::new(),
        };
        if apply_view_patch(&mut slot.layout, patch, &|id| saved.contains(id)) || reconciled {
            slot.dirty = true;
        }
        slot.dirty && layout_writable(slot, cx)
    }

    /// Records a connection to the saved site `id` at `at` (unix seconds). Returns
    /// whether a delayed write is wanted.
    async fn record<S: TreeStorage>(
        &self,
        cx: &TreeCx<'_, S>,
        id: &str,
        at: i64,
    ) -> Result<bool, String> {
        let sites = cx.sites.read().await;
        if id == LOCAL_SITE_ID || !sites.iter().any(|s| s.id == id) {
            return Err(format!(
                "[{ERR_NOT_FOUND}] Only saved connections are recorded as recent"
            ));
        }
        let mut guard = self.layout.lock().await;
        let slot = loaded_slot(cx, &mut guard).await;
        site_layout::record_recent(&mut slot.layout, id, at);
        slot.dirty = true;
        Ok(layout_writable(slot, cx))
    }

    /// Writes the layout if it changed since the last write and may be written (the
    /// delayed writes and the exit flush). Takes the saved sites (read) first, like every
    /// other layout write, so it never runs beside a write of `sites.vault`.
    async fn flush<S: TreeStorage>(&self, cx: &TreeCx<'_, S>) -> Result<(), String> {
        let _sites = cx.sites.read().await;
        let mut guard = self.layout.lock().await;
        match guard.as_mut() {
            Some(slot) => write_if_dirty(cx, slot).await,
            None => Ok(()),
        }
    }
}

/// Writes the layout after `delay`, unless another change asked for a write meanwhile
/// (that later write covers this one).
fn schedule_layout_write(handle: &AppHandle, tree: &SiteTreeState, delay: Duration) {
    let generation = tree.view_write_gen.fetch_add(1, Ordering::SeqCst) + 1;
    let handle = handle.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(delay).await;
        let tree = handle.state::<SiteTreeState>();
        if tree.view_write_gen.load(Ordering::SeqCst) != generation {
            return;
        }
        let app = handle.state::<AppState>();
        let _ = tree.flush(&app_cx(&app)).await;
    });
}

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

/// The layout (folders, favorites, recents, labels, collapsed), reconciled with the
/// saved sites.
#[tauri::command]
pub async fn get_site_layout(
    app: tauri::State<'_, AppState>,
    tree: tauri::State<'_, SiteTreeState>,
    handle: AppHandle,
) -> Result<SiteLayoutResponse, String> {
    let (response, write) = tree.layout_view(&app_cx(&app)).await;
    if write {
        schedule_layout_write(&handle, &tree, VIEW_WRITE_DELAY);
    }
    Ok(response)
}

/// Runs a batch of tree changes, all or nothing: `sites.vault` is written once, then the
/// layout once. The result can be undone with its `undo_token`.
#[tauri::command]
pub async fn apply_site_tree_ops(
    app: tauri::State<'_, AppState>,
    tree: tauri::State<'_, SiteTreeState>,
    ops: Vec<SiteTreeOp>,
    label: Option<String>,
) -> Result<SiteTreeResult, String> {
    ensure_vault_writable(&app)?;
    tree.apply(&app_cx(&app), ops, label).await
}

/// Undoes a batch, restoring only what nothing changed since (`undo_report` counts the
/// rest). An unknown or expired token is `[site_tree.undo_expired]`.
#[tauri::command]
pub async fn undo_site_tree_ops(
    app: tauri::State<'_, AppState>,
    tree: tauri::State<'_, SiteTreeState>,
    token: String,
) -> Result<SiteTreeResult, String> {
    ensure_vault_writable(&app)?;
    tree.undo(&app_cx(&app), &token).await
}

/// Drops every undo entry (after an import replaced or merged sites).
#[tauri::command]
pub fn forget_site_tree_undo(tree: tauri::State<'_, SiteTreeState>) {
    tree.forget_undo();
}

/// Collapsed folders, recents housekeeping and one-time flags; written after a short
/// delay (kept in memory only while the layout is read-only).
#[tauri::command]
pub async fn set_site_tree_view(
    app: tauri::State<'_, AppState>,
    tree: tauri::State<'_, SiteTreeState>,
    handle: AppHandle,
    view: SiteTreeViewPatch,
) -> Result<(), String> {
    if tree.set_view(&app_cx(&app), &view).await {
        schedule_layout_write(&handle, &tree, VIEW_WRITE_DELAY);
    }
    Ok(())
}

/// Records that the saved site `id` was just connected from the Connect dialog.
#[tauri::command]
pub async fn record_site_connected(
    app: tauri::State<'_, AppState>,
    tree: tauri::State<'_, SiteTreeState>,
    handle: AppHandle,
    id: String,
) -> Result<(), String> {
    let now = chrono::Utc::now().timestamp();
    if tree.record(&app_cx(&app), &id, now).await? {
        schedule_layout_write(&handle, &tree, RECENT_WRITE_DELAY);
    }
    Ok(())
}

/// On exit: drops the undo entries and writes a pending layout change (waiting at most
/// [`EXIT_FLUSH_TIMEOUT`]).
pub fn flush_site_layout_blocking(app: &AppHandle) {
    let tree = app.state::<SiteTreeState>();
    tree.forget_undo();
    // Delayed writes still sleeping stand down: this one covers them.
    tree.view_write_gen.fetch_add(1, Ordering::SeqCst);
    let state = app.state::<AppState>();
    let flushed = tauri::async_runtime::block_on(async {
        tokio::time::timeout(EXIT_FLUSH_TIMEOUT, tree.flush(&app_cx(&state))).await
    });
    match flushed {
        Ok(Ok(())) => {}
        Ok(Err(e)) => tracing::warn!("the site layout was not saved on exit: {e}"),
        Err(_) => tracing::warn!(
            "the site layout was not saved within {} s on exit",
            EXIT_FLUSH_TIMEOUT.as_secs()
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::STORED_SECRET_MARKER;
    use rustscp_core::site_layout::{FavoriteRef, LabelColor, LabelDef, RecentEntry};
    use rustscp_core::{AuthMethod, Protocol};
    use std::collections::BTreeMap;
    use std::sync::atomic::AtomicBool;
    use std::sync::Mutex;

    /// In-memory storage that logs every write.
    #[derive(Default)]
    struct Memory {
        log: Mutex<Vec<&'static str>>,
        sites: Mutex<Vec<Vec<ConnectionConfig>>>,
        layouts: Mutex<Vec<SiteLayout>>,
        initial: Mutex<Option<LoadedSiteLayout>>,
        fail_sites: AtomicBool,
        fail_layout: AtomicBool,
    }

    impl Memory {
        fn log(&self) -> Vec<&'static str> {
            lock(&self.log).clone()
        }

        fn read_only() -> Self {
            let memory = Memory::default();
            *lock(&memory.initial) = Some(LoadedSiteLayout {
                layout: SiteLayout::default(),
                read_only: true,
                warning: Some("[site_tree.layout_read_only] newer".into()),
            });
            memory
        }
    }

    impl TreeStorage for Memory {
        async fn save_sites(&self, sites: Vec<ConnectionConfig>) -> Result<(), VaultError> {
            if self.fail_sites.load(Ordering::SeqCst) {
                return Err(VaultError::Other("disk full".into()));
            }
            lock(&self.log).push("sites");
            lock(&self.sites).push(sites);
            Ok(())
        }

        async fn load_layout(&self, keep_file: bool) -> LoadedSiteLayout {
            lock(&self.log).push(if keep_file {
                "load (keep file)"
            } else {
                "load"
            });
            lock(&self.initial).take().unwrap_or(LoadedSiteLayout {
                layout: SiteLayout::default(),
                read_only: false,
                warning: None,
            })
        }

        async fn save_layout(&self, layout: SiteLayout) -> Result<(), VaultError> {
            if self.fail_layout.load(Ordering::SeqCst) {
                return Err(VaultError::KeychainUnavailable("locked".into()));
            }
            lock(&self.log).push("layout");
            lock(&self.layouts).push(layout);
            Ok(())
        }
    }

    fn site(id: &str, group: Option<&str>) -> ConnectionConfig {
        ConnectionConfig {
            id: id.into(),
            name: id.into(),
            protocol: Protocol::Sftp,
            host: format!("{id}.example.com"),
            group: group.map(Into::into),
            auth: AuthMethod::Password("hunter2".into()),
            ..ConnectionConfig::local()
        }
    }

    fn library(n: usize) -> RwLock<Vec<ConnectionConfig>> {
        let mut sites = vec![ConnectionConfig::local()];
        sites.extend((0..n).map(|i| site(&format!("web-{i:03}"), Some("Clients/Acme"))));
        RwLock::new(sites)
    }

    fn cx<'a>(memory: &'a Memory, sites: &'a RwLock<Vec<ConnectionConfig>>) -> TreeCx<'a, Memory> {
        TreeCx {
            storage: memory,
            sites,
            blocked: None,
            vault_unread: None,
        }
    }

    fn move_all(to: &str, n: usize) -> Vec<SiteTreeOp> {
        vec![SiteTreeOp::MoveSites {
            ids: (0..n).map(|i| format!("web-{i:03}")).collect(),
            to: Some(to.into()),
        }]
    }

    fn entry(token: &str, created: Instant) -> UndoEntry {
        UndoEntry {
            token: token.into(),
            label: None,
            created,
            snapshot: UndoSnapshot {
                sites_before: Vec::new(),
                sites_after: Vec::new(),
                layout_before: SiteLayout::default(),
                layout_after: SiteLayout::default(),
                folder_remaps: Vec::new(),
            },
        }
    }

    #[tokio::test]
    async fn a_batch_writes_the_vault_once_then_the_layout_and_undoes() {
        let memory = Memory::default();
        let sites = library(500);
        let tree = SiteTreeState::default();
        let cx = cx(&memory, &sites);

        let result = tree
            .apply(&cx, move_all("Archive", 500), Some("Move".into()))
            .await
            .unwrap();
        assert_eq!(memory.log(), ["load", "sites", "layout"]);
        // A clone: holding the guard would block the undo's own write below.
        let written = lock(&memory.sites)[0].clone();
        assert_eq!(written.len(), 501);
        assert!(written[1..]
            .iter()
            .all(|s| s.group.as_deref() == Some("Archive")));
        assert!(result.warnings.is_empty());
        assert!(result.layout.folders.contains("Archive"));
        // Secrets never reach the WebView.
        let json = serde_json::to_string(&result).unwrap();
        assert!(!json.contains("hunter2"));
        assert!(json.contains(STORED_SECRET_MARKER));
        let token = result.undo_token.unwrap();
        assert!(token.starts_with("undo-"));

        let undone = tree.undo(&cx, &token).await.unwrap();
        assert_eq!(memory.log(), ["load", "sites", "layout", "sites", "layout"]);
        assert_eq!(
            undone.undo_report,
            Some(UndoReport {
                restored: 500,
                skipped: 0
            })
        );
        let restored = sites.read().await;
        assert!(restored[1..]
            .iter()
            .all(|s| s.group.as_deref() == Some("Clients/Acme")));
        // Secrets are intact after the round trip.
        assert!(matches!(&restored[1].auth, AuthMethod::Password(p) if p == "hunter2"));
        drop(restored);

        let again = tree.undo(&cx, &token).await.unwrap_err();
        assert!(again.starts_with("[site_tree.undo_expired]"), "{again}");
    }

    #[tokio::test]
    async fn a_copy_is_made_here_with_its_secret() {
        let memory = Memory::default();
        let sites = library(1);
        let tree = SiteTreeState::default();
        let ops = vec![SiteTreeOp::CopySites {
            items: vec![rustscp_core::site_layout::CopyItem {
                id: "web-000".into(),
                name: "web-000 copy".into(),
                group: None,
            }],
        }];
        let result = tree.apply(&cx(&memory, &sites), ops, None).await.unwrap();
        let new_id = &result.created[0].id;
        assert!(new_id.starts_with("site-"));
        let saved = sites.read().await;
        let copy = saved.iter().find(|s| &s.id == new_id).unwrap();
        assert!(matches!(&copy.auth, AuthMethod::Password(p) if p == "hunter2"));
    }

    #[tokio::test]
    async fn a_layout_only_change_skips_the_vault() {
        let memory = Memory::default();
        let sites = library(2);
        let tree = SiteTreeState::default();
        let ops = vec![SiteTreeOp::CreateFolder {
            path: "Empty".into(),
        }];
        let result = tree.apply(&cx(&memory, &sites), ops, None).await.unwrap();
        assert_eq!(memory.log(), ["load", "layout"]);
        assert!(result.undo_token.is_some());

        // A batch that changes nothing has nothing to undo.
        let ops = vec![SiteTreeOp::MoveSites {
            ids: vec!["web-000".into()],
            to: Some("Clients/Acme".into()),
        }];
        let result = tree.apply(&cx(&memory, &sites), ops, None).await.unwrap();
        assert!(result.undo_token.is_none());
        assert_eq!(memory.log(), ["load", "layout"]);
    }

    #[tokio::test]
    async fn a_failed_vault_write_changes_nothing() {
        let memory = Memory::default();
        memory.fail_sites.store(true, Ordering::SeqCst);
        let sites = library(3);
        let tree = SiteTreeState::default();
        let err = tree
            .apply(&cx(&memory, &sites), move_all("Archive", 3), None)
            .await
            .unwrap_err();
        assert!(err.starts_with("[vault.other]"), "{err}");
        assert!(sites.read().await[1..]
            .iter()
            .all(|s| s.group.as_deref() == Some("Clients/Acme")));
        let guard = tree.layout.lock().await;
        assert!(!guard.as_ref().unwrap().layout.folders.contains("Archive"));
        assert!(lock(&tree.undo).is_empty());
    }

    #[tokio::test]
    async fn a_failed_layout_write_is_a_warning() {
        let memory = Memory::default();
        memory.fail_layout.store(true, Ordering::SeqCst);
        let sites = library(3);
        let tree = SiteTreeState::default();
        let result = tree
            .apply(&cx(&memory, &sites), move_all("Archive", 3), None)
            .await
            .unwrap();
        assert_eq!(result.warnings, [WARN_LAYOUT_NOT_SAVED]);
        assert_eq!(memory.log(), ["load", "sites"]);
        assert!(tree.layout.lock().await.as_ref().unwrap().dirty);

        // The next flush writes it.
        memory.fail_layout.store(false, Ordering::SeqCst);
        tree.flush(&cx(&memory, &sites)).await.unwrap();
        assert_eq!(memory.log(), ["load", "sites", "layout"]);
        tree.flush(&cx(&memory, &sites)).await.unwrap();
        assert_eq!(memory.log().len(), 3, "a clean layout is not written again");
    }

    #[tokio::test]
    async fn a_read_only_layout_refuses_layout_only_ops() {
        let memory = Memory::read_only();
        let sites = library(2);
        let tree = SiteTreeState::default();
        let ops = vec![SiteTreeOp::CreateFolder { path: "New".into() }];
        let err = tree
            .apply(&cx(&memory, &sites), ops, None)
            .await
            .unwrap_err();
        assert!(err.starts_with("[site_tree.layout_read_only]"), "{err}");

        let result = tree
            .apply(&cx(&memory, &sites), move_all("Archive", 2), None)
            .await
            .unwrap();
        assert_eq!(result.warnings, [WARN_LAYOUT_READ_ONLY]);
        assert_eq!(
            memory.log(),
            ["load", "sites"],
            "the layout is never written"
        );

        let (view, write) = tree.layout_view(&cx(&memory, &sites)).await;
        assert!(view.read_only && !write);
        assert!(view.warning.is_some());
    }

    #[tokio::test]
    async fn a_blocked_vault_refuses_ops_and_keeps_the_view_in_memory() {
        let memory = Memory::default();
        let sites = library(2);
        let tree = SiteTreeState::default();
        let blocked = TreeCx {
            storage: &memory,
            sites: &sites,
            blocked: Some("Saved sites are not changed in this session"),
            vault_unread: None,
        };
        let err = tree
            .apply(&blocked, move_all("Archive", 2), None)
            .await
            .unwrap_err();
        assert_eq!(err, "Saved sites are not changed in this session");

        let patch = SiteTreeViewPatch {
            collapsed: Some(vec!["Clients".into()]),
            ..Default::default()
        };
        assert!(
            !tree.set_view(&blocked, &patch).await,
            "no write is scheduled"
        );
        let (view, _) = tree.layout_view(&blocked).await;
        assert!(view.read_only);
        assert!(view.layout.collapsed.contains("Clients"));
        tree.flush(&blocked).await.unwrap();
        assert_eq!(memory.log(), ["load"]);
    }

    #[tokio::test]
    async fn recording_a_connection() {
        let memory = Memory::default();
        let sites = library(2);
        let tree = SiteTreeState::default();
        let cx = cx(&memory, &sites);
        for id in ["local", "nope"] {
            let err = tree.record(&cx, id, 1).await.unwrap_err();
            assert!(err.starts_with("[site_tree.not_found]"), "{err}");
        }
        assert!(tree.record(&cx, "web-001", 10).await.unwrap());
        assert!(tree.record(&cx, "web-000", 20).await.unwrap());
        assert!(tree.record(&cx, "web-001", 30).await.unwrap());
        let guard = tree.layout.lock().await;
        let slot = guard.as_ref().unwrap();
        assert!(slot.dirty);
        assert_eq!(
            slot.layout.recents,
            [
                RecentEntry {
                    id: "web-001".into(),
                    at: Some(30),
                    count: 2
                },
                RecentEntry {
                    id: "web-000".into(),
                    at: Some(20),
                    count: 1
                },
            ]
        );
        // Recording only touches the layout, later.
        assert_eq!(memory.log(), ["load"]);
    }

    #[test]
    fn the_undo_queue_keeps_20_entries_for_15_minutes() {
        let t0 = Instant::now();
        let mut queue = VecDeque::new();
        for i in 0..25 {
            push_undo(&mut queue, entry(&format!("undo-{i}"), t0), t0);
        }
        assert_eq!(queue.len(), UNDO_MAX_ENTRIES);
        assert!(
            take_undo(&mut queue, "undo-4", t0).is_none(),
            "the oldest went"
        );
        assert!(take_undo(&mut queue, "undo-5", t0).is_some());
        assert!(take_undo(&mut queue, "undo-5", t0).is_none(), "used once");

        let later = t0 + Duration::from_secs(14 * 60);
        assert!(take_undo(&mut queue, "undo-6", later).is_some());
        let expired = t0 + UNDO_LIFETIME;
        assert!(take_undo(&mut queue, "undo-7", expired).is_none());
        assert!(queue.is_empty(), "expired entries are dropped");

        push_undo(&mut queue, entry("old", t0), t0);
        push_undo(&mut queue, entry("new", expired), expired);
        assert_eq!(queue.len(), 1);
        assert_eq!(queue[0].token, "new");
    }

    #[test]
    fn seed_recents_is_ignored_when_recents_exist() {
        let saved = |id: &str| id.starts_with("web-");
        let mut layout = SiteLayout {
            recents: vec![RecentEntry {
                id: "web-1".into(),
                at: Some(5),
                count: 3,
            }],
            ..SiteLayout::default()
        };
        let patch = SiteTreeViewPatch {
            seed_recents: Some(vec!["web-2".into(), "web-3".into()]),
            ..Default::default()
        };
        assert!(!apply_view_patch(&mut layout, &patch, &saved));
        assert_eq!(layout.recents.len(), 1);
        assert_eq!(layout.recents[0].id, "web-1");

        layout.recents.clear();
        assert!(apply_view_patch(&mut layout, &patch, &saved));
        let seeded: Vec<&str> = layout.recents.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(seeded, ["web-2", "web-3"]);
    }

    #[test]
    fn a_view_patch_keeps_only_existing_folders() {
        let mut layout = SiteLayout {
            folders: ["A".to_string(), "A/B".to_string()].into(),
            favorites: vec![FavoriteRef::Folder { path: "A".into() }],
            ..SiteLayout::default()
        };
        let patch: SiteTreeViewPatch = serde_json::from_str(
            r#"{"collapsed":["A/B"," A / B ","Gone"],"migrated_local_storage":true}"#,
        )
        .unwrap();
        assert!(apply_view_patch(&mut layout, &patch, &|_| true));
        assert_eq!(
            layout.collapsed,
            std::collections::BTreeSet::from(["A/B".to_string()])
        );
        assert!(layout.migrated_local_storage);
        assert!(
            !apply_view_patch(&mut layout, &patch, &|_| true),
            "no change twice"
        );

        let clear: SiteTreeViewPatch = serde_json::from_str(r#"{"clear_recents":true}"#).unwrap();
        assert!(clear.collapsed.is_none() && clear.clear_recents);
    }

    fn tokens(queue: &VecDeque<UndoEntry>) -> Vec<&str> {
        queue.iter().map(|e| e.token.as_str()).collect()
    }

    fn entry_with_records(token: &str, created: Instant, records: usize) -> UndoEntry {
        let mut entry = entry(token, created);
        entry.snapshot.sites_before = vec![("x".to_string(), None); records / 2];
        entry.snapshot.sites_after = vec![("x".to_string(), None); records - records / 2];
        entry
    }

    #[test]
    fn the_undo_queue_keeps_at_most_100k_site_records() {
        let t0 = Instant::now();
        let mut queue = VecDeque::new();
        push_undo(&mut queue, entry_with_records("a", t0, 40_000), t0);
        push_undo(&mut queue, entry_with_records("b", t0, 40_000), t0);
        assert_eq!(tokens(&queue), ["a", "b"]);
        push_undo(&mut queue, entry_with_records("c", t0, 30_000), t0);
        assert_eq!(tokens(&queue), ["b", "c"], "the oldest went");
        // The newest entry stays even when it alone is over the limit.
        push_undo(&mut queue, entry_with_records("d", t0, 150_000), t0);
        assert_eq!(tokens(&queue), ["d"]);
        push_undo(&mut queue, entry("e", t0), t0);
        assert_eq!(tokens(&queue), ["e"]);
    }

    /// The saved sites could not be loaded at startup (wrong or missing key, damaged
    /// file: sites.vault was moved aside and only Local is loaded). Opening Connect must
    /// not prune the favorites, labels and recents of the sites that are not loaded.
    #[tokio::test]
    async fn a_vault_that_failed_to_load_leaves_the_layout_untouched() {
        let library = vec![
            ConnectionConfig::local(),
            site("web-1", Some("Clients")),
            site("db-1", Some("Clients")),
        ];
        let mut good = SiteLayout {
            labels: vec![LabelDef {
                id: "label-a".into(),
                name: "Prod".into(),
                color: LabelColor::Red,
            }],
            favorites: vec![
                FavoriteRef::Site { id: "web-1".into() },
                FavoriteRef::Site { id: "db-1".into() },
            ],
            site_labels: BTreeMap::from([
                ("web-1".into(), "label-a".into()),
                ("db-1".into(), "label-a".into()),
            ]),
            recents: vec![RecentEntry {
                id: "db-1".into(),
                at: Some(1_700_000_000),
                count: 42,
            }],
            ..SiteLayout::default()
        };
        reconcile(&mut good, &library);
        let stored = |layout: &SiteLayout| LoadedSiteLayout {
            layout: layout.clone(),
            read_only: false,
            warning: None,
        };

        // Run 1: Local only, plus a site saved during the run.
        let memory = Memory::default();
        *lock(&memory.initial) = Some(stored(&good));
        let sites = RwLock::new(vec![ConnectionConfig::local(), site("new-1", None)]);
        let tree = SiteTreeState::default();
        let unread = TreeCx {
            storage: &memory,
            sites: &sites,
            blocked: None,
            vault_unread: Some("The vault key file is missing"),
        };
        let (view, write) = tree.layout_view(&unread).await;
        assert!(!write, "no write is scheduled");
        assert!(view.read_only);
        let warning = view.warning.unwrap();
        assert!(
            warning.starts_with("[site_tree.layout_unavailable]"),
            "{warning}"
        );
        assert!(!tree.layout.lock().await.as_ref().unwrap().dirty);

        let patch = SiteTreeViewPatch {
            collapsed: Some(vec!["Clients".into()]),
            clear_recents: true,
            ..Default::default()
        };
        assert!(!tree.set_view(&unread, &patch).await);
        assert!(!tree.record(&unread, "new-1", 5).await.unwrap());
        for op in [
            SiteTreeOp::CreateFolder { path: "New".into() },
            SiteTreeOp::SetFavorites { items: Vec::new() },
            SiteTreeOp::RenameFolder {
                path: "Clients".into(),
                name: "Customers".into(),
                merge: false,
            },
        ] {
            let err = tree.apply(&unread, vec![op], None).await.unwrap_err();
            assert!(err.starts_with("[site_tree.layout_read_only]"), "{err}");
        }
        // Site changes still work; only sites.vault is written.
        let moved = tree
            .apply(
                &unread,
                vec![SiteTreeOp::MoveSites {
                    ids: vec!["new-1".into()],
                    to: Some("Inbox".into()),
                }],
                None,
            )
            .await
            .unwrap();
        assert_eq!(moved.warnings, [WARN_LAYOUT_READ_ONLY]);
        tree.flush(&unread).await.unwrap();
        assert_eq!(
            memory.log(),
            ["load (keep file)", "sites"],
            "the layout file is kept and never written"
        );

        // Run 2: the vault opens again; the layout on disk is the one from before.
        let memory = Memory::default();
        *lock(&memory.initial) = Some(stored(&good));
        let sites = RwLock::new(library);
        let tree = SiteTreeState::default();
        let (view, _) = tree.layout_view(&cx(&memory, &sites)).await;
        assert!(!view.read_only && view.warning.is_none());
        assert_eq!(view.layout.favorites, good.favorites);
        assert_eq!(view.layout.site_labels, good.site_labels);
        assert_eq!(view.layout.recents, good.recents);
        assert_eq!(good.favorites.len(), 2);
        assert_eq!(good.site_labels.len(), 2);
        assert_eq!(good.recents.len(), 1);
    }

    /// A read-only layout (here: from a newer RustSCP) refuses folder renames, moves,
    /// copies and deletes: sites.vault would get the new paths and the layout file would
    /// keep the label, favorite and collapsed state at the old ones.
    #[tokio::test]
    async fn a_read_only_layout_refuses_folder_ops_and_leaves_sites_vault_alone() {
        let memory = Memory::read_only();
        let sites = library(2);
        let tree = SiteTreeState::default();
        let before = serde_json::to_string(&*sites.read().await).unwrap();
        for op in [
            SiteTreeOp::RenameFolder {
                path: "Clients".into(),
                name: "Customers".into(),
                merge: false,
            },
            SiteTreeOp::MoveFolder {
                path: "Clients/Acme".into(),
                to: None,
                merge: false,
            },
            SiteTreeOp::CopyFolder {
                path: "Clients".into(),
                to: None,
                name: "Copy".into(),
            },
            SiteTreeOp::DeleteFolder {
                path: "Clients".into(),
                keep_contents: true,
            },
        ] {
            let err = tree
                .apply(&cx(&memory, &sites), vec![op], None)
                .await
                .unwrap_err();
            assert!(err.starts_with("[site_tree.layout_read_only]"), "{err}");
        }
        assert_eq!(memory.log(), ["load"], "sites.vault is never written");
        assert_eq!(serde_json::to_string(&*sites.read().await).unwrap(), before);
        assert!(lock(&tree.undo).is_empty());
    }

    /// A delayed layout write waits for a save of sites.vault in progress (the saved
    /// sites are always locked before the layout).
    #[tokio::test]
    async fn a_layout_write_waits_for_a_site_save() {
        let memory = Memory::default();
        let sites = library(1);
        let tree = SiteTreeState::default();
        let cx = cx(&memory, &sites);
        assert!(tree.record(&cx, "web-000", 1).await.unwrap());

        let saving = sites.write().await;
        let mut flush = Box::pin(tree.flush(&cx));
        let waited = tokio::time::timeout(Duration::from_millis(50), flush.as_mut()).await;
        assert!(waited.is_err(), "the flush waits for the save");
        assert_eq!(memory.log(), ["load"]);
        drop(saving);
        flush.await.unwrap();
        assert_eq!(memory.log(), ["load", "layout"]);
    }

    /// Copies, deletes and undo never put a secret in a result for the WebView, and the
    /// copies and the restored sites keep theirs in memory.
    #[tokio::test]
    async fn no_secret_reaches_the_webview_through_copy_delete_and_undo() {
        let mut key_site = site("key-1", Some("Ops"));
        key_site.auth = AuthMethod::PrivateKey {
            path: String::new(),
            passphrase: Some("pp-secret".into()),
            key_data: Some("-----BEGIN OPENSSH PRIVATE KEY-----kd-secret".into()),
        };
        let mut pw_site = site("pw-1", Some("Ops"));
        pw_site.auth = AuthMethod::Password("pw-1-secret".into());
        let sites = RwLock::new(vec![ConnectionConfig::local(), pw_site, key_site]);
        let memory = Memory::default();
        let tree = SiteTreeState::default();
        let cx = cx(&memory, &sites);
        let ops = vec![
            SiteTreeOp::CopySites {
                items: vec![rustscp_core::site_layout::CopyItem {
                    id: "key-1".into(),
                    name: "key copy".into(),
                    group: None,
                }],
            },
            SiteTreeOp::CopyFolder {
                path: "Ops".into(),
                to: None,
                name: "Ops copy".into(),
            },
            SiteTreeOp::DeleteSites {
                ids: vec!["pw-1".into(), "key-1".into()],
            },
        ];
        let secrets = ["pw-1-secret", "pp-secret", "kd-secret", "BEGIN OPENSSH"];
        let result = tree.apply(&cx, ops, None).await.unwrap();
        let json = serde_json::to_string(&result).unwrap();
        for secret in secrets {
            assert!(!json.contains(secret), "{secret} in the apply result");
        }
        let token = result.undo_token.unwrap();
        let undone = tree.undo(&cx, &token).await.unwrap();
        let json = serde_json::to_string(&undone).unwrap();
        for secret in secrets {
            assert!(!json.contains(secret), "{secret} in the undo result");
        }
        let view = serde_json::to_string(&tree.layout_view(&cx).await.0).unwrap();
        assert!(!view.contains("secret"));
        // Undo removed the copies and restored both deleted sites with their secrets.
        let saved = sites.read().await;
        assert_eq!(saved.len(), 3);
        assert!(saved
            .iter()
            .any(|s| matches!(&s.auth, AuthMethod::Password(p) if p == "pw-1-secret")));
        assert!(saved.iter().any(|s| matches!(&s.auth,
            AuthMethod::PrivateKey { passphrase: Some(p), key_data: Some(k), .. }
            if p == "pp-secret" && k.contains("kd-secret"))));
    }

    #[test]
    fn collapse_all_keeps_every_folder_of_a_large_layout() {
        let paths: Vec<String> = (0..2_525).map(|i| format!("F{i:04}")).collect();
        let mut layout = SiteLayout {
            folders: paths.iter().cloned().collect(),
            ..SiteLayout::default()
        };
        let patch = SiteTreeViewPatch {
            collapsed: Some(paths),
            ..Default::default()
        };
        assert!(apply_view_patch(&mut layout, &patch, &|_| true));
        assert_eq!(layout.collapsed.len(), 2_525);
    }
}

//! How the saved sites are organized: explicit folders (empty ones included), favorites,
//! recently used sites, labels and which folders are collapsed.
//!
//! A site's folder stays in `ConnectionConfig::group`, so `sites.vault` keeps its format
//! and older builds keep working. Everything else lives in `site-layout.vault`, sealed
//! with the same device key (see [`crate::vault::save_device_sealed_file`]).
//!
//! Tree changes arrive as a batch of [`SiteTreeOp`]s. [`apply_ops`] runs a batch on the
//! sites and the layout at once, all or nothing, and returns an [`UndoSnapshot`] that
//! [`undo`] can restore later without overwriting anything changed since.

use crate::types::{normalize_site_group, ConnectionConfig, MAX_SITE_GROUP_LEN};
use crate::vault::{self, VaultError};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fmt;
use std::path::PathBuf;

pub const SITE_LAYOUT_FILE: &str = "site-layout.vault";
pub const SITE_LAYOUT_VERSION: u32 = 1;
pub const MAX_LAYOUT_FOLDERS: usize = 10_000;
pub const MAX_FAVORITES: usize = 200;
pub const MAX_RECENTS: usize = 50;
pub const MAX_LABELS: usize = 12;
/// Every folder can be collapsed ("Collapse all" on the largest layout).
pub const MAX_COLLAPSED: usize = MAX_LAYOUT_FOLDERS;
/// Ops in one batch (moving 150 selected folders is 150 ops).
pub const MAX_OPS_PER_CALL: usize = 2_000;
/// Ids and items in one batch, and sites one batch may create by copying.
pub const MAX_IDS_PER_CALL: usize = 50_000;
pub const MAX_SITE_NAME_LEN: usize = 255;
pub const MAX_LABEL_NAME_LEN: usize = 40;
/// Longest label id (`label-<uuid>` is 42 characters).
pub const MAX_LABEL_ID_LEN: usize = 64;

/// Id of the built-in local-disk site: never moved, copied, deleted or recorded as recent.
pub const LOCAL_SITE_ID: &str = "local";

pub const ERR_FOLDER_EXISTS: &str = "site_tree.folder_exists";
pub const ERR_INTO_SELF: &str = "site_tree.into_self";
pub const ERR_INVALID_NAME: &str = "site_tree.invalid_name";
pub const ERR_PATH_TOO_LONG: &str = "site_tree.path_too_long";
pub const ERR_LOCAL_IMMUTABLE: &str = "site_tree.local_immutable";
pub const ERR_NOT_FOUND: &str = "site_tree.not_found";
pub const ERR_TOO_MANY: &str = "site_tree.too_many";
pub const ERR_UNDO_EXPIRED: &str = "site_tree.undo_expired";
pub const ERR_LAYOUT_READ_ONLY: &str = "site_tree.layout_read_only";
/// Load warning: the layout key could not be read (Keychain locked, key missing); the
/// layout is kept in memory only.
pub const WARN_LAYOUT_UNAVAILABLE: &str = "site_tree.layout_unavailable";
/// Load warning: the layout file could not be read and was moved aside.
pub const WARN_LAYOUT_RESET: &str = "site_tree.layout_reset";

// ---------------------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct SiteLayout {
    pub version: u32,
    /// Every folder, explicit (empty ones included) and implied by a site's group,
    /// normalized ("A/B"), ancestors included.
    pub folders: BTreeSet<String>,
    /// In the user's order.
    pub favorites: Vec<FavoriteRef>,
    /// Newest first.
    pub recents: Vec<RecentEntry>,
    pub labels: Vec<LabelDef>,
    /// Site id → label id.
    pub site_labels: BTreeMap<String, String>,
    /// Folder path → label id (inherited by everything inside).
    pub folder_labels: BTreeMap<String, String>,
    /// Collapsed folder paths.
    pub collapsed: BTreeSet<String>,
    pub migrated_local_storage: bool,
    pub large_library_collapsed: bool,
    /// Keys this build does not know: kept, so a downgrade and upgrade loses nothing.
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl Default for SiteLayout {
    fn default() -> Self {
        Self {
            version: SITE_LAYOUT_VERSION,
            folders: BTreeSet::new(),
            favorites: Vec::new(),
            recents: Vec::new(),
            labels: Vec::new(),
            site_labels: BTreeMap::new(),
            folder_labels: BTreeMap::new(),
            collapsed: BTreeSet::new(),
            migrated_local_storage: false,
            large_library_collapsed: false,
            extra: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FavoriteRef {
    Site { id: String },
    Folder { path: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecentEntry {
    pub id: String,
    /// Unix seconds of the last connection; `None` for entries seeded from older data.
    #[serde(default)]
    pub at: Option<i64>,
    #[serde(default)]
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LabelDef {
    pub id: String,
    pub name: String,
    pub color: LabelColor,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LabelColor {
    Red,
    Orange,
    Yellow,
    Green,
    Blue,
    Purple,
    Gray,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct CopyItem {
    pub id: String,
    pub name: String,
    /// Folder of the copy; `None` is the top level.
    #[serde(default)]
    pub group: Option<String>,
}

/// One change to the tree. Folder targets (`to`) of `None` mean the top level.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum SiteTreeOp {
    MoveSites {
        ids: Vec<String>,
        #[serde(default)]
        to: Option<String>,
    },
    CopySites {
        items: Vec<CopyItem>,
    },
    DeleteSites {
        ids: Vec<String>,
    },
    RenameSite {
        id: String,
        name: String,
    },
    CreateFolder {
        path: String,
    },
    RenameFolder {
        path: String,
        name: String,
        #[serde(default)]
        merge: bool,
    },
    MoveFolder {
        path: String,
        #[serde(default)]
        to: Option<String>,
        #[serde(default)]
        merge: bool,
    },
    CopyFolder {
        path: String,
        #[serde(default)]
        to: Option<String>,
        name: String,
    },
    DeleteFolder {
        path: String,
        keep_contents: bool,
    },
    SetFavorites {
        items: Vec<FavoriteRef>,
    },
    SetLabel {
        #[serde(default)]
        sites: Vec<String>,
        #[serde(default)]
        folders: Vec<String>,
        #[serde(default)]
        label: Option<String>,
    },
    SetLabelDefs {
        labels: Vec<LabelDef>,
    },
}

impl SiteTreeOp {
    /// How many ids / items the op carries (for [`MAX_IDS_PER_CALL`]).
    fn id_count(&self) -> usize {
        match self {
            Self::MoveSites { ids, .. } | Self::DeleteSites { ids } => ids.len(),
            Self::CopySites { items } => items.len(),
            Self::SetFavorites { items } => items.len(),
            Self::SetLabel { sites, folders, .. } => sites.len() + folders.len(),
            Self::SetLabelDefs { labels } => labels.len(),
            _ => 1,
        }
    }

    /// Whether the op only changes the layout file (never `sites.vault`). Those ops are
    /// refused while the layout is read-only, since their result could not be kept.
    pub fn changes_layout_only(&self) -> bool {
        matches!(
            self,
            Self::CreateFolder { .. }
                | Self::SetFavorites { .. }
                | Self::SetLabel { .. }
                | Self::SetLabelDefs { .. }
        )
    }

    /// Whether the op renames, moves, copies or deletes a folder. Those rewrite folder
    /// paths in the layout too (labels, favorites, collapsed state), so they are refused
    /// as well while the layout is read-only: `sites.vault` would get the new paths and
    /// the layout file would keep the old ones.
    pub fn rewrites_folder_paths(&self) -> bool {
        matches!(
            self,
            Self::RenameFolder { .. }
                | Self::MoveFolder { .. }
                | Self::DeleteFolder { .. }
                | Self::CopyFolder { .. }
        )
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CreatedSite {
    pub source_id: String,
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
pub struct UndoReport {
    pub restored: usize,
    pub skipped: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SiteTreeError {
    pub code: &'static str,
    pub message: String,
}

impl SiteTreeError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for SiteTreeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for SiteTreeError {}

#[derive(Debug)]
pub struct ApplyOutcome {
    pub sites_changed: bool,
    pub layout_changed: bool,
    pub created: Vec<CreatedSite>,
    pub undo: UndoSnapshot,
}

/// What a batch changed, for [`undo`]. Holds full configs (secrets included): keep it in
/// memory only.
#[derive(Debug, Clone)]
pub struct UndoSnapshot {
    /// Every site the batch changed, as it was before; `None` = it did not exist.
    pub sites_before: Vec<(String, Option<ConnectionConfig>)>,
    /// The same sites as the batch left them (`serde_json::to_value`, since
    /// `ConnectionConfig` has no `PartialEq`); `None` = deleted.
    pub sites_after: Vec<(String, Option<Value>)>,
    pub layout_before: SiteLayout,
    pub layout_after: SiteLayout,
    /// The folder renames, moves and lifts of the batch, in order.
    pub folder_remaps: Vec<FolderRemap>,
}

impl UndoSnapshot {
    /// Site records it holds (snapshots before and after, and ids of moved sites).
    pub fn site_records(&self) -> usize {
        self.sites_before.len()
            + self.sites_after.len()
            + self
                .folder_remaps
                .iter()
                .map(|r| r.site_ids.as_ref().map_or(0, Vec::len))
                .sum::<usize>()
    }
}

/// One folder rename, move, or lift (a delete that keeps the contents), for [`undo`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FolderRemap {
    /// Each `.0` folder, with everything inside it, went to `.1`.
    pub moves: Vec<(String, String)>,
    /// The sites it moved that the batch left changed; `None` when there were too many
    /// to list, which [`undo`] reads as "any of them".
    pub site_ids: Option<Vec<String>>,
}

/// What a batch did besides changing the lists, gathered while it runs.
#[derive(Default)]
struct BatchLog {
    created: Vec<CreatedSite>,
    remaps: Vec<FolderRemap>,
    /// Site ids listed in `remaps` so far (at most [`MAX_IDS_PER_CALL`]).
    remap_ids: usize,
}

impl BatchLog {
    /// Refuses one more copy once the batch made [`MAX_IDS_PER_CALL`] of them: a copy of
    /// a folder copies every site inside it, so a few ops could ask for millions.
    fn check_copy_budget(&self) -> Result<(), SiteTreeError> {
        if self.created.len() >= MAX_IDS_PER_CALL {
            return Err(err_too_many("items at once"));
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------
// Paths and names
// ---------------------------------------------------------------------------------------

fn err_invalid(message: impl Into<String>) -> SiteTreeError {
    SiteTreeError::new(ERR_INVALID_NAME, message)
}

fn err_too_long(path: &str) -> SiteTreeError {
    SiteTreeError::new(
        ERR_PATH_TOO_LONG,
        format!(
            "\"{}…\" would be longer than {MAX_SITE_GROUP_LEN} characters",
            path.chars().take(40).collect::<String>()
        ),
    )
}

fn err_folder_exists(name: &str, parent: Option<&str>) -> SiteTreeError {
    SiteTreeError::new(
        ERR_FOLDER_EXISTS,
        match parent {
            Some(p) => format!("A folder named \"{name}\" already exists in \"{p}\""),
            None => format!("A folder named \"{name}\" already exists at the top level"),
        },
    )
}

fn err_local() -> SiteTreeError {
    SiteTreeError::new(
        ERR_LOCAL_IMMUTABLE,
        "The Local site can't be moved, duplicated or deleted",
    )
}

fn err_too_many(what: &str) -> SiteTreeError {
    SiteTreeError::new(ERR_TOO_MANY, format!("Too many {what}"))
}

fn check_len(path: &str) -> Result<(), SiteTreeError> {
    if path.chars().count() > MAX_SITE_GROUP_LEN {
        Err(err_too_long(path))
    } else {
        Ok(())
    }
}

/// Cleans a folder path strictly: segments are split on `/`, trimmed, and dropped when
/// empty (`" A // B/ "` is `"A/B"`). A control character is an error, and so is a result
/// longer than [`MAX_SITE_GROUP_LEN`] characters: nothing is silently cut (unlike
/// [`normalize_site_group`]). `Ok(None)` is the top level.
pub fn normalize_folder_path(raw: &str) -> Result<Option<String>, SiteTreeError> {
    let mut out = String::new();
    for segment in raw.split('/') {
        let segment = segment.trim();
        if segment.is_empty() {
            continue;
        }
        if segment.chars().any(char::is_control) {
            return Err(err_invalid("Folder names can't contain control characters"));
        }
        if !out.is_empty() {
            out.push('/');
        }
        out.push_str(segment);
    }
    check_len(&out)?;
    Ok((!out.is_empty()).then_some(out))
}

/// Checks one folder name (trimmed): not empty, no `/`, no control characters.
pub fn validate_folder_name(raw: &str) -> Result<String, SiteTreeError> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(err_invalid("Enter a folder name"));
    }
    if name.contains('/') {
        return Err(err_invalid("Folder names can't contain \"/\""));
    }
    if name.chars().any(char::is_control) {
        return Err(err_invalid("Folder names can't contain control characters"));
    }
    check_len(name)?;
    Ok(name.to_string())
}

/// Checks a site name (trimmed): not empty, no control characters, at most
/// [`MAX_SITE_NAME_LEN`] characters. Names may repeat.
pub fn validate_site_name(raw: &str) -> Result<String, SiteTreeError> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(err_invalid("Enter a name"));
    }
    if name.chars().any(char::is_control) {
        return Err(err_invalid("Names can't contain control characters"));
    }
    if name.chars().count() > MAX_SITE_NAME_LEN {
        return Err(err_invalid(format!(
            "Names can be at most {MAX_SITE_NAME_LEN} characters long"
        )));
    }
    Ok(name.to_string())
}

fn valid_label_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_LABEL_ID_LEN
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Parent folder of `path` (`None` at the top level).
pub fn parent_path(path: &str) -> Option<&str> {
    path.rsplit_once('/').map(|(parent, _)| parent)
}

/// Last segment of `path`.
pub fn base_name(path: &str) -> &str {
    path.rsplit_once('/').map_or(path, |(_, name)| name)
}

fn join_path(parent: Option<&str>, name: &str) -> String {
    match parent {
        Some(p) => format!("{p}/{name}"),
        None => name.to_string(),
    }
}

/// `path` is `ancestor` or a folder inside it.
fn is_same_or_under(path: &str, ancestor: &str) -> bool {
    path == ancestor
        || (path.len() > ancestor.len()
            && path.starts_with(ancestor)
            && path.as_bytes()[ancestor.len()] == b'/')
}

fn add_with_ancestors(set: &mut BTreeSet<String>, path: &str) {
    for (i, c) in path.char_indices() {
        if c == '/' && !set.contains(&path[..i]) {
            set.insert(path[..i].to_string());
        }
    }
    if !set.contains(path) {
        set.insert(path.to_string());
    }
}

fn is_local(site: &ConnectionConfig) -> bool {
    site.id == LOCAL_SITE_ID
}

/// The folder a site is filed under, normalized as `save_site` does (Local: none).
fn site_folder(site: &ConnectionConfig) -> Option<String> {
    if is_local(site) {
        None
    } else {
        site.group.as_deref().and_then(normalize_site_group)
    }
}

/// A sibling of `name` in `parent` whose name is the same ignoring case (`exclude` is
/// never returned).
fn find_sibling_ci(
    folders: &BTreeSet<String>,
    parent: Option<&str>,
    name: &str,
    exclude: Option<&str>,
) -> Option<String> {
    let lower = name.to_lowercase();
    folders
        .iter()
        .find(|f| {
            Some(f.as_str()) != exclude
                && parent_path(f) == parent
                && base_name(f).to_lowercase() == lower
        })
        .cloned()
}

fn index_by_id(sites: &[ConnectionConfig]) -> HashMap<&str, usize> {
    let mut index = HashMap::with_capacity(sites.len());
    for (i, s) in sites.iter().enumerate() {
        index.entry(s.id.as_str()).or_insert(i);
    }
    index
}

fn site_not_found(id: &str) -> SiteTreeError {
    SiteTreeError::new(
        ERR_NOT_FOUND,
        format!("No saved connection has the id \"{}\"", id.escape_default()),
    )
}

// ---------------------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------------------

/// Brings the layout in line with the sites: adds every folder a site's group names
/// (ancestors included), normalizes paths, drops favorites, labels, recents and collapsed
/// entries that point at missing sites, folders or labels, removes duplicates and
/// enforces the caps. Returns whether anything changed.
pub fn reconcile(layout: &mut SiteLayout, sites: &[ConnectionConfig]) -> bool {
    let before = layout.clone();
    if layout.version == 0 {
        layout.version = SITE_LAYOUT_VERSION;
    }
    let site_ids: HashSet<&str> = sites.iter().map(|s| s.id.as_str()).collect();

    // Folders: implied ones always stay; explicit (possibly empty) ones are capped.
    let mut implied = BTreeSet::new();
    for site in sites {
        if let Some(group) = site_folder(site) {
            add_with_ancestors(&mut implied, &group);
        }
    }
    let mut folders = BTreeSet::new();
    for f in &layout.folders {
        if let Ok(Some(path)) = normalize_folder_path(f) {
            add_with_ancestors(&mut folders, &path);
        }
    }
    folders.extend(implied.iter().cloned());
    if folders.len() > MAX_LAYOUT_FOLDERS {
        // Deepest-last order: a folder goes only after everything inside it went.
        let excess = folders.len() - MAX_LAYOUT_FOLDERS;
        let drop: Vec<String> = folders
            .iter()
            .rev()
            .filter(|f| !implied.contains(*f))
            .take(excess)
            .cloned()
            .collect();
        for f in drop {
            folders.remove(&f);
        }
    }
    layout.folders = folders;

    // Labels.
    let mut label_ids = HashSet::new();
    let labels = std::mem::take(&mut layout.labels);
    for mut label in labels {
        let name: String = label.name.trim().chars().take(MAX_LABEL_NAME_LEN).collect();
        let name = name.trim().to_string();
        if !valid_label_id(&label.id) || name.is_empty() || !label_ids.insert(label.id.clone()) {
            continue;
        }
        label.name = name;
        layout.labels.push(label);
        if layout.labels.len() == MAX_LABELS {
            break;
        }
    }
    let label_ids: HashSet<&str> = layout.labels.iter().map(|l| l.id.as_str()).collect();

    // Favorites.
    let mut seen = HashSet::new();
    let favorites = std::mem::take(&mut layout.favorites);
    for fav in favorites {
        let fav = match fav {
            FavoriteRef::Site { id } if site_ids.contains(id.as_str()) => FavoriteRef::Site { id },
            FavoriteRef::Folder { path } => match normalize_folder_path(&path) {
                Ok(Some(p)) if layout.folders.contains(&p) => FavoriteRef::Folder { path: p },
                _ => continue,
            },
            FavoriteRef::Site { .. } => continue,
        };
        if seen.insert(fav.clone()) {
            layout.favorites.push(fav);
            if layout.favorites.len() == MAX_FAVORITES {
                break;
            }
        }
    }

    // Recents: saved sites other than Local, newest first, each once.
    let mut seen = HashSet::new();
    layout.recents.retain(|r| {
        r.id != LOCAL_SITE_ID && site_ids.contains(r.id.as_str()) && seen.insert(r.id.clone())
    });
    layout.recents.truncate(MAX_RECENTS);

    // Label assignments.
    layout
        .site_labels
        .retain(|id, label| site_ids.contains(id.as_str()) && label_ids.contains(label.as_str()));
    let folder_labels = std::mem::take(&mut layout.folder_labels);
    for (path, label) in folder_labels {
        if let Ok(Some(p)) = normalize_folder_path(&path) {
            if layout.folders.contains(&p) && label_ids.contains(label.as_str()) {
                layout.folder_labels.entry(p).or_insert(label);
            }
        }
    }

    // Collapsed folders.
    let collapsed = std::mem::take(&mut layout.collapsed);
    for path in collapsed {
        if layout.collapsed.len() == MAX_COLLAPSED {
            break;
        }
        if let Ok(Some(p)) = normalize_folder_path(&path) {
            if layout.folders.contains(&p) {
                layout.collapsed.insert(p);
            }
        }
    }

    *layout != before
}

// ---------------------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------------------

/// Refuses a batch with more than [`MAX_OPS_PER_CALL`] ops or [`MAX_IDS_PER_CALL`] ids.
/// [`apply_ops`] also refuses a batch that would create more than [`MAX_IDS_PER_CALL`]
/// copies.
pub fn check_op_limits(ops: &[SiteTreeOp]) -> Result<(), SiteTreeError> {
    if ops.len() > MAX_OPS_PER_CALL {
        return Err(err_too_many("changes at once"));
    }
    let ids: usize = ops.iter().map(SiteTreeOp::id_count).sum();
    if ids > MAX_IDS_PER_CALL {
        return Err(err_too_many("items at once"));
    }
    Ok(())
}

/// Runs a batch of ops, all or nothing: on `Err` neither `sites` nor `layout` changes.
/// `new_id` makes the ids of copies (the app passes `|| normalize_site_id("")`).
pub fn apply_ops(
    sites: &mut Vec<ConnectionConfig>,
    layout: &mut SiteLayout,
    ops: &[SiteTreeOp],
    new_id: &mut dyn FnMut() -> String,
) -> Result<ApplyOutcome, SiteTreeError> {
    check_op_limits(ops)?;
    let mut work_sites = sites.clone();
    let mut work_layout = layout.clone();
    reconcile(&mut work_layout, &work_sites);
    let layout_before = work_layout.clone();
    let folders_before = work_layout.folders.len();

    let mut log = BatchLog::default();
    for op in ops {
        apply_one(&mut work_sites, &mut work_layout, op, new_id, &mut log)?;
    }
    if work_layout.folders.len() > MAX_LAYOUT_FOLDERS && work_layout.folders.len() > folders_before
    {
        return Err(err_too_many("folders"));
    }
    reconcile(&mut work_layout, &work_sites);

    let (sites_before, sites_after) = diff_sites(sites, &work_sites);
    // Undo only looks at sites the batch left changed.
    let changed: HashSet<&str> = sites_before.iter().map(|(id, _)| id.as_str()).collect();
    for remap in &mut log.remaps {
        if let Some(ids) = &mut remap.site_ids {
            ids.retain(|id| changed.contains(id.as_str()));
        }
    }
    let outcome = ApplyOutcome {
        sites_changed: !sites_before.is_empty(),
        layout_changed: work_layout != *layout,
        created: log.created,
        undo: UndoSnapshot {
            sites_before,
            sites_after,
            layout_before,
            layout_after: work_layout.clone(),
            folder_remaps: log.remaps,
        },
    };
    *sites = work_sites;
    *layout = work_layout;
    Ok(outcome)
}

fn site_value(site: &ConnectionConfig) -> Value {
    serde_json::to_value(site).unwrap_or(Value::Null)
}

/// The sites that differ between `old` and `new` (added, removed or changed), in list order.
#[allow(clippy::type_complexity)]
fn diff_sites(
    old: &[ConnectionConfig],
    new: &[ConnectionConfig],
) -> (
    Vec<(String, Option<ConnectionConfig>)>,
    Vec<(String, Option<Value>)>,
) {
    let old_index = index_by_id(old);
    let new_index = index_by_id(new);
    let mut before = Vec::new();
    let mut after = Vec::new();
    let mut seen = HashSet::new();
    for id in old.iter().chain(new.iter()).map(|s| s.id.as_str()) {
        if !seen.insert(id) {
            continue;
        }
        let old_site = old_index.get(id).map(|&i| &old[i]);
        let new_site = new_index.get(id).map(|&i| &new[i]);
        let new_value = new_site.map(site_value);
        if old_site.map(site_value) != new_value {
            before.push((id.to_string(), old_site.cloned()));
            after.push((id.to_string(), new_value));
        }
    }
    (before, after)
}

fn apply_one(
    sites: &mut Vec<ConnectionConfig>,
    layout: &mut SiteLayout,
    op: &SiteTreeOp,
    new_id: &mut dyn FnMut() -> String,
    log: &mut BatchLog,
) -> Result<(), SiteTreeError> {
    match op {
        SiteTreeOp::MoveSites { ids, to } => move_sites(sites, ids, to.as_deref()),
        SiteTreeOp::CopySites { items } => copy_sites(sites, layout, items, new_id, log),
        SiteTreeOp::DeleteSites { ids } => delete_sites(sites, ids),
        SiteTreeOp::RenameSite { id, name } => {
            let name = validate_site_name(name)?;
            let &i = index_by_id(sites)
                .get(id.as_str())
                .ok_or_else(|| site_not_found(id))?;
            sites[i].name = name;
            Ok(())
        }
        SiteTreeOp::CreateFolder { path } => create_folder(layout, path),
        SiteTreeOp::RenameFolder { path, name, merge } => {
            rename_folder(sites, layout, path, name, *merge, log)
        }
        SiteTreeOp::MoveFolder { path, to, merge } => {
            move_folder(sites, layout, path, to.as_deref(), *merge, log)
        }
        SiteTreeOp::CopyFolder { path, to, name } => {
            copy_folder(sites, layout, path, to.as_deref(), name, new_id, log)
        }
        SiteTreeOp::DeleteFolder {
            path,
            keep_contents,
        } => delete_folder(sites, layout, path, *keep_contents, log),
        SiteTreeOp::SetFavorites { items } => {
            if items.len() > MAX_FAVORITES {
                return Err(err_too_many("favorites"));
            }
            // Dangling or duplicate entries are dropped by the closing reconcile.
            layout.favorites = items
                .iter()
                .filter_map(|fav| match fav {
                    FavoriteRef::Site { .. } => Some(fav.clone()),
                    FavoriteRef::Folder { path } => normalize_folder_path(path)
                        .ok()
                        .flatten()
                        .map(|path| FavoriteRef::Folder { path }),
                })
                .collect();
            Ok(())
        }
        SiteTreeOp::SetLabel {
            sites: site_ids,
            folders,
            label,
        } => set_label(sites, layout, site_ids, folders, label.as_deref()),
        SiteTreeOp::SetLabelDefs { labels } => set_label_defs(layout, labels),
    }
}

fn move_sites(
    sites: &mut [ConnectionConfig],
    ids: &[String],
    to: Option<&str>,
) -> Result<(), SiteTreeError> {
    let to = normalize_folder_path(to.unwrap_or(""))?;
    let positions: Vec<usize> = {
        let index = index_by_id(sites);
        ids.iter()
            .map(|id| {
                index
                    .get(id.as_str())
                    .copied()
                    .ok_or_else(|| site_not_found(id))
            })
            .collect::<Result<_, _>>()?
    };
    for i in positions {
        if is_local(&sites[i]) {
            return Err(err_local());
        }
        sites[i].group = to.clone();
    }
    Ok(())
}

fn fresh_id(
    taken: &mut HashSet<String>,
    new_id: &mut dyn FnMut() -> String,
) -> Result<String, SiteTreeError> {
    for _ in 0..32 {
        let id = new_id();
        if !id.is_empty() && id != LOCAL_SITE_ID && !taken.contains(&id) {
            taken.insert(id.clone());
            return Ok(id);
        }
    }
    Err(err_invalid("Could not make a unique id for the copy"))
}

fn copy_sites(
    sites: &mut Vec<ConnectionConfig>,
    layout: &mut SiteLayout,
    items: &[CopyItem],
    new_id: &mut dyn FnMut() -> String,
    log: &mut BatchLog,
) -> Result<(), SiteTreeError> {
    let mut taken: HashSet<String> = sites.iter().map(|s| s.id.clone()).collect();
    let mut copies = Vec::with_capacity(items.len());
    {
        let index = index_by_id(sites);
        for item in items {
            let &i = index
                .get(item.id.as_str())
                .ok_or_else(|| site_not_found(&item.id))?;
            let source = &sites[i];
            if is_local(source) {
                return Err(err_local());
            }
            log.check_copy_budget()?;
            let name = validate_site_name(&item.name)?;
            let group = normalize_folder_path(item.group.as_deref().unwrap_or(""))?;
            let id = fresh_id(&mut taken, new_id)?;
            // The whole config, secrets and fields this build does not name included.
            let mut copy = source.clone();
            copy.id = id.clone();
            copy.name = name;
            copy.group = group;
            if let Some(label) = layout.site_labels.get(&source.id).cloned() {
                layout.site_labels.insert(id.clone(), label);
            }
            log.created.push(CreatedSite {
                source_id: source.id.clone(),
                id,
            });
            copies.push(copy);
        }
    }
    sites.extend(copies);
    Ok(())
}

fn delete_sites(sites: &mut Vec<ConnectionConfig>, ids: &[String]) -> Result<(), SiteTreeError> {
    let mut doomed = HashSet::new();
    {
        let index = index_by_id(sites);
        for id in ids {
            let &i = index.get(id.as_str()).ok_or_else(|| site_not_found(id))?;
            if is_local(&sites[i]) {
                return Err(err_local());
            }
            doomed.insert(id.as_str());
        }
    }
    sites.retain(|s| !doomed.contains(s.id.as_str()));
    Ok(())
}

/// An existing folder, by its (normalized) path.
fn existing_folder(layout: &SiteLayout, raw: &str) -> Result<String, SiteTreeError> {
    let path = normalize_folder_path(raw)?.ok_or_else(|| err_invalid("Enter a folder name"))?;
    if !layout.folders.contains(&path) {
        return Err(SiteTreeError::new(
            ERR_NOT_FOUND,
            format!("There is no folder \"{path}\""),
        ));
    }
    Ok(path)
}

fn create_folder(layout: &mut SiteLayout, raw: &str) -> Result<(), SiteTreeError> {
    let path = normalize_folder_path(raw)?.ok_or_else(|| err_invalid("Enter a folder name"))?;
    // Every level that does not exist yet must not clash (ignoring case) with a sibling,
    // and the folder itself must be new.
    let mut parent: Option<&str> = None;
    let ends = path
        .char_indices()
        .filter(|&(_, c)| c == '/')
        .map(|(i, _)| i)
        .chain(std::iter::once(path.len()));
    for end in ends {
        let prefix = &path[..end];
        let name = base_name(prefix);
        if layout.folders.contains(prefix) {
            if end == path.len() {
                return Err(err_folder_exists(name, parent));
            }
        } else if let Some(existing) = find_sibling_ci(&layout.folders, parent, name, None) {
            return Err(err_folder_exists(base_name(&existing), parent));
        }
        parent = Some(prefix);
    }
    add_with_ancestors(&mut layout.folders, &path);
    Ok(())
}

/// Maps `old` and everything inside it to `new` (and leaves other paths alone).
fn prefix_map<'a>(old: &'a str, new: &'a str) -> impl Fn(&str) -> Option<String> + 'a {
    move |path: &str| {
        if is_same_or_under(path, old) {
            Some(format!("{new}{}", &path[old.len()..]))
        } else {
            None
        }
    }
}

/// Folder moves done at the same time, by folder (none inside another).
fn moves_lookup(moves: &[(String, String)]) -> HashMap<&str, &str> {
    moves
        .iter()
        .map(|(from, to)| (from.as_str(), to.as_str()))
        .collect()
}

/// Where `path` goes under `moves`: a moved folder, or something inside one, follows it.
fn moved_path(moves: &HashMap<&str, &str>, path: &str) -> Option<String> {
    let ends = path
        .char_indices()
        .filter(|&(_, c)| c == '/')
        .map(|(i, _)| i)
        .chain(std::iter::once(path.len()));
    for end in ends {
        if let Some(to) = moves.get(&path[..end]) {
            return Some(format!("{to}{}", &path[end..]));
        }
    }
    None
}

/// Rewrites the folder paths of the layout through `map`, as if every path moved at the
/// same time: folders, folder favorites, folder labels and collapsed. On a merge the
/// folder label already at the target wins.
fn remap_layout(layout: &mut SiteLayout, map: &dyn Fn(&str) -> Option<String>) {
    layout.folders = std::mem::take(&mut layout.folders)
        .into_iter()
        .map(|f| map(&f).unwrap_or(f))
        .collect();
    for fav in &mut layout.favorites {
        if let FavoriteRef::Folder { path } = fav {
            if let Some(new) = map(path) {
                *path = new;
            }
        }
    }
    let old_labels = std::mem::take(&mut layout.folder_labels);
    let mut moved = Vec::new();
    for (path, label) in old_labels {
        match map(&path) {
            Some(new) => moved.push((new, label)),
            None => {
                layout.folder_labels.insert(path, label);
            }
        }
    }
    for (path, label) in moved {
        layout.folder_labels.entry(path).or_insert(label);
    }
    layout.collapsed = std::mem::take(&mut layout.collapsed)
        .into_iter()
        .map(|p| map(&p).unwrap_or(p))
        .collect();
}

/// Moves folders (each `.0`, with everything inside it, to `.1`) all at once: site
/// groups and the layout (see [`remap_layout`]). Logs the move for [`undo`].
fn remap_paths(
    sites: &mut [ConnectionConfig],
    layout: &mut SiteLayout,
    moves: Vec<(String, String)>,
    log: &mut BatchLog,
) -> Result<(), SiteTreeError> {
    if moves.is_empty() {
        return Ok(());
    }
    let moved_sites = {
        let lookup = moves_lookup(&moves);
        let map = |p: &str| moved_path(&lookup, p);
        let mut groups = Vec::new();
        for (i, site) in sites.iter().enumerate() {
            if let Some(new) = site_folder(site).and_then(|g| map(&g)) {
                check_len(&new)?;
                groups.push((i, new));
            }
        }
        for f in &layout.folders {
            if let Some(new) = map(f) {
                check_len(&new)?;
            }
        }
        let moved_sites: Vec<usize> = groups.iter().map(|&(i, _)| i).collect();
        for (i, group) in groups {
            sites[i].group = Some(group);
        }
        remap_layout(layout, &map);
        moved_sites
    };
    let site_ids = (log.remap_ids + moved_sites.len() <= MAX_IDS_PER_CALL).then(|| {
        log.remap_ids += moved_sites.len();
        moved_sites.iter().map(|&i| sites[i].id.clone()).collect()
    });
    log.remaps.push(FolderRemap { moves, site_ids });
    Ok(())
}

fn rename_folder(
    sites: &mut [ConnectionConfig],
    layout: &mut SiteLayout,
    raw_path: &str,
    raw_name: &str,
    merge: bool,
    log: &mut BatchLog,
) -> Result<(), SiteTreeError> {
    let path = existing_folder(layout, raw_path)?;
    let name = validate_folder_name(raw_name)?;
    let parent = parent_path(&path);
    let mut target = join_path(parent, &name);
    if target == path {
        return Ok(());
    }
    if let Some(existing) = find_sibling_ci(&layout.folders, parent, &name, Some(path.as_str())) {
        if !merge {
            return Err(err_folder_exists(base_name(&existing), parent));
        }
        target = existing;
    }
    remap_paths(sites, layout, vec![(path, target)], log)
}

fn move_folder(
    sites: &mut [ConnectionConfig],
    layout: &mut SiteLayout,
    raw_path: &str,
    to: Option<&str>,
    merge: bool,
    log: &mut BatchLog,
) -> Result<(), SiteTreeError> {
    let path = existing_folder(layout, raw_path)?;
    let to = normalize_folder_path(to.unwrap_or(""))?;
    if to.as_deref().is_some_and(|t| is_same_or_under(t, &path)) {
        return Err(SiteTreeError::new(
            ERR_INTO_SELF,
            "A folder can't go inside itself",
        ));
    }
    if parent_path(&path) == to.as_deref() {
        return Ok(());
    }
    let name = base_name(&path);
    let target = match find_sibling_ci(&layout.folders, to.as_deref(), name, None) {
        Some(existing) if merge => existing,
        Some(existing) => return Err(err_folder_exists(base_name(&existing), to.as_deref())),
        None => join_path(to.as_deref(), name),
    };
    remap_paths(sites, layout, vec![(path, target)], log)
}

fn copy_folder(
    sites: &mut Vec<ConnectionConfig>,
    layout: &mut SiteLayout,
    raw_path: &str,
    to: Option<&str>,
    raw_name: &str,
    new_id: &mut dyn FnMut() -> String,
    log: &mut BatchLog,
) -> Result<(), SiteTreeError> {
    let path = existing_folder(layout, raw_path)?;
    let to = normalize_folder_path(to.unwrap_or(""))?;
    if to.as_deref().is_some_and(|t| is_same_or_under(t, &path)) {
        return Err(SiteTreeError::new(
            ERR_INTO_SELF,
            "A folder can't be copied inside itself",
        ));
    }
    let name = validate_folder_name(raw_name)?;
    if let Some(existing) = find_sibling_ci(&layout.folders, to.as_deref(), &name, None) {
        return Err(err_folder_exists(base_name(&existing), to.as_deref()));
    }
    let target = join_path(to.as_deref(), &name);
    let map = prefix_map(&path, &target);

    let mut new_folders = Vec::new();
    for f in &layout.folders {
        if let Some(new) = map(f) {
            check_len(&new)?;
            new_folders.push(new);
        }
    }
    let new_folder_labels: Vec<(String, String)> = layout
        .folder_labels
        .iter()
        .filter_map(|(p, label)| map(p).map(|new| (new, label.clone())))
        .collect();

    let mut taken: HashSet<String> = sites.iter().map(|s| s.id.clone()).collect();
    let mut copies = Vec::new();
    for source in sites.iter() {
        let Some(group) = site_folder(source).and_then(|g| map(&g)) else {
            continue;
        };
        check_len(&group)?;
        log.check_copy_budget()?;
        let id = fresh_id(&mut taken, new_id)?;
        let mut copy = source.clone();
        copy.id = id.clone();
        copy.group = Some(group);
        if let Some(label) = layout.site_labels.get(&source.id).cloned() {
            layout.site_labels.insert(id.clone(), label);
        }
        log.created.push(CreatedSite {
            source_id: source.id.clone(),
            id,
        });
        copies.push(copy);
    }

    sites.extend(copies);
    layout.folders.extend(new_folders);
    for (path, label) in new_folder_labels {
        layout.folder_labels.entry(path).or_insert(label);
    }
    Ok(())
}

fn delete_folder(
    sites: &mut Vec<ConnectionConfig>,
    layout: &mut SiteLayout,
    raw_path: &str,
    keep_contents: bool,
    log: &mut BatchLog,
) -> Result<(), SiteTreeError> {
    let path = existing_folder(layout, raw_path)?;
    if !keep_contents {
        // Favorites, labels and collapsed entries of the removed folders and sites are
        // dropped by the closing reconcile.
        sites.retain(|s| !site_folder(s).is_some_and(|g| is_same_or_under(&g, &path)));
        layout.folders.retain(|f| !is_same_or_under(f, &path));
        return Ok(());
    }

    // Keep the contents: lift everything one level, keeping its structure. A lifted
    // folder that clashes (ignoring case) with one already in the parent merges into it.
    let parent = parent_path(&path).map(str::to_string);
    let mut siblings: HashMap<String, String> = HashMap::new();
    for f in &layout.folders {
        if parent_path(f) == parent.as_deref() && !is_same_or_under(f, &path) {
            siblings
                .entry(base_name(f).to_lowercase())
                .or_insert_with(|| f.clone());
        }
    }

    // The folder itself goes, with what points at it.
    layout.folders.remove(&path);
    layout.collapsed.remove(&path);
    layout.folder_labels.remove(&path);
    layout
        .favorites
        .retain(|f| !matches!(f, FavoriteRef::Folder { path: p } if *p == path));
    for site in sites.iter_mut() {
        if site_folder(site).as_deref() == Some(path.as_str()) {
            site.group = parent.clone();
        }
    }

    // Every child (a folder, or the first level of a site's group, inside the folder)
    // moves up to the parent, or into the parent's folder of the same name.
    let prefix_len = path.len() + 1;
    let first_level = |p: &str| -> Option<String> {
        if p.len() <= prefix_len || !is_same_or_under(p, &path) {
            return None;
        }
        let rest = &p[prefix_len..];
        Some(
            rest.split_once('/')
                .map_or(rest, |(first, _)| first)
                .to_string(),
        )
    };
    let mut children = BTreeSet::new();
    for f in &layout.folders {
        children.extend(first_level(f));
    }
    for site in sites.iter() {
        if let Some(group) = site_folder(site) {
            children.extend(first_level(&group));
        }
    }
    let moves = children
        .into_iter()
        .map(|name| {
            let target = siblings
                .get(&name.to_lowercase())
                .cloned()
                .unwrap_or_else(|| join_path(parent.as_deref(), &name));
            (join_path(Some(&path), &name), target)
        })
        .collect();
    remap_paths(sites, layout, moves, log)
}

fn set_label(
    sites: &[ConnectionConfig],
    layout: &mut SiteLayout,
    site_ids: &[String],
    folders: &[String],
    label: Option<&str>,
) -> Result<(), SiteTreeError> {
    if let Some(label) = label {
        if !layout.labels.iter().any(|l| l.id == label) {
            return Err(SiteTreeError::new(
                ERR_NOT_FOUND,
                format!("There is no label \"{}\"", label.escape_default()),
            ));
        }
    }
    let index = index_by_id(sites);
    for id in site_ids {
        if !index.contains_key(id.as_str()) {
            return Err(site_not_found(id));
        }
        match label {
            Some(label) => layout.site_labels.insert(id.clone(), label.to_string()),
            None => layout.site_labels.remove(id),
        };
    }
    for raw in folders {
        let path = existing_folder(layout, raw)?;
        match label {
            Some(label) => layout.folder_labels.insert(path, label.to_string()),
            None => layout.folder_labels.remove(&path),
        };
    }
    Ok(())
}

fn set_label_defs(layout: &mut SiteLayout, labels: &[LabelDef]) -> Result<(), SiteTreeError> {
    if labels.len() > MAX_LABELS {
        return Err(err_too_many("labels"));
    }
    let mut ids = HashSet::new();
    let mut checked = Vec::with_capacity(labels.len());
    for label in labels {
        if !valid_label_id(&label.id) || !ids.insert(label.id.as_str()) {
            return Err(err_invalid("Invalid or repeated label id"));
        }
        let name = label.name.trim();
        if name.is_empty() {
            return Err(err_invalid("Enter a label name"));
        }
        if name.chars().any(char::is_control) || name.chars().count() > MAX_LABEL_NAME_LEN {
            return Err(err_invalid(format!(
                "Label names can be at most {MAX_LABEL_NAME_LEN} characters long"
            )));
        }
        checked.push(LabelDef {
            id: label.id.clone(),
            name: name.to_string(),
            color: label.color,
        });
    }
    layout.labels = checked;
    Ok(())
}

// ---------------------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------------------

/// Gives every saved site its own id: the first row with an id keeps it, and each later
/// row with the same id gets a fresh one from `new_id` (the app passes
/// `|| normalize_site_id("")`). Rows sharing an id are moved, deleted and undone as one,
/// and an undo could bring back only one of them. Returns whether any id changed.
pub fn dedupe_site_ids(sites: &mut [ConnectionConfig], new_id: &mut dyn FnMut() -> String) -> bool {
    let mut taken: HashSet<String> = sites.iter().map(|s| s.id.clone()).collect();
    let mut seen: HashSet<String> = HashSet::with_capacity(sites.len());
    let mut changed = false;
    for site in sites.iter_mut() {
        if seen.insert(site.id.clone()) {
            continue;
        }
        let id = fresh_id(&mut taken, new_id).unwrap_or_else(|_| {
            // `new_id` keeps repeating itself: number the row instead.
            (1u64..)
                .map(|n| format!("site-{n}"))
                .find(|id| taken.insert(id.clone()))
                .expect("an unused number exists")
        });
        tracing::warn!(
            "two saved sites shared the id \"{}\"; the later one is now \"{id}\"",
            site.id.escape_default()
        );
        site.id = id.clone();
        seen.insert(id);
        changed = true;
    }
    changed
}

// ---------------------------------------------------------------------------------------
// Recents
// ---------------------------------------------------------------------------------------

/// Records a connection to `id` (a saved site other than Local) at `at` (unix seconds):
/// it moves to the front with its count raised by one.
pub fn record_recent(layout: &mut SiteLayout, id: &str, at: i64) {
    if id == LOCAL_SITE_ID {
        return;
    }
    let count = match layout.recents.iter().position(|r| r.id == id) {
        Some(i) => layout.recents.remove(i).count,
        None => 0,
    };
    layout.recents.insert(
        0,
        RecentEntry {
            id: id.to_string(),
            at: Some(at),
            count: count.saturating_add(1),
        },
    );
    layout.recents.truncate(MAX_RECENTS);
}

/// Seeds the recents from older data (newest first), only while there are none. Keeps
/// saved sites other than Local, each once. Returns whether anything was added.
pub fn seed_recents(
    layout: &mut SiteLayout,
    ids: &[String],
    is_saved_site: &dyn Fn(&str) -> bool,
) -> bool {
    if !layout.recents.is_empty() {
        return false;
    }
    let mut seen = HashSet::new();
    layout.recents = ids
        .iter()
        .filter(|id| *id != LOCAL_SITE_ID && is_saved_site(id) && seen.insert(id.as_str()))
        .take(MAX_RECENTS)
        .map(|id| RecentEntry {
            id: id.clone(),
            at: None,
            count: 0,
        })
        .collect();
    !layout.recents.is_empty()
}

// ---------------------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------------------

/// Restores what a batch changed, key by key, wherever the current value is still the
/// one the batch left: a site changed since (by a save, an import, another batch) is
/// skipped and counted. A folder rename, move or lift is undone only when every site it
/// moved came back; otherwise the folder stays where the batch put it, with its label,
/// favorite and collapsed state. Ends with [`reconcile`].
pub fn undo(
    snapshot: &UndoSnapshot,
    sites: &mut Vec<ConnectionConfig>,
    layout: &mut SiteLayout,
) -> UndoReport {
    let mut report = UndoReport::default();
    let after: HashMap<&str, &Option<Value>> = snapshot
        .sites_after
        .iter()
        .map(|(id, value)| (id.as_str(), value))
        .collect();
    let mut replace = Vec::new();
    let mut remove = HashSet::new();
    let mut insert = Vec::new();
    let mut skipped: HashSet<&str> = HashSet::new();
    {
        let index = index_by_id(sites);
        for (id, before) in &snapshot.sites_before {
            let expected: Option<&Value> = after.get(id.as_str()).and_then(|v| v.as_ref());
            let position = index.get(id.as_str()).copied();
            let current = position.map(|i| site_value(&sites[i]));
            if current.as_ref() != expected {
                report.skipped += 1;
                skipped.insert(id.as_str());
                continue;
            }
            match (before, position) {
                (Some(config), Some(i)) => replace.push((i, config.clone())),
                (Some(config), None) => insert.push(config.clone()),
                (None, Some(i)) => {
                    remove.insert(i);
                }
                (None, None) => {}
            }
            report.restored += 1;
        }
    }
    for (i, config) in replace {
        sites[i] = config;
    }
    if !remove.is_empty() {
        let mut i = 0;
        sites.retain(|_| {
            let keep = !remove.contains(&i);
            i += 1;
            keep
        });
    }
    // Sites the batch removed go back at the end of the list.
    sites.extend(insert);

    // Folder moves that keep a skipped site stay: the layout from before the batch is
    // read as if they had already happened, so their folders are left as they are.
    let kept: Vec<&FolderRemap> = if skipped.is_empty() {
        Vec::new()
    } else {
        snapshot
            .folder_remaps
            .iter()
            .filter(|remap| {
                remap
                    .site_ids
                    .as_ref()
                    .is_none_or(|ids| ids.iter().any(|id| skipped.contains(id.as_str())))
            })
            .collect()
    };
    let before_with_kept;
    let before = if kept.is_empty() {
        &snapshot.layout_before
    } else {
        let mut adjusted = snapshot.layout_before.clone();
        for remap in kept {
            let lookup = moves_lookup(&remap.moves);
            remap_layout(&mut adjusted, &|p| moved_path(&lookup, p));
        }
        before_with_kept = adjusted;
        &before_with_kept
    };
    let after = &snapshot.layout_after;
    restore_set(&mut layout.folders, &before.folders, &after.folders);
    restore_set(&mut layout.collapsed, &before.collapsed, &after.collapsed);
    restore_list(
        &mut layout.favorites,
        &before.favorites,
        &after.favorites,
        |f| f.clone(),
    );
    restore_list(&mut layout.recents, &before.recents, &after.recents, |r| {
        r.id.clone()
    });
    restore_map(
        &mut layout.site_labels,
        &before.site_labels,
        &after.site_labels,
    );
    restore_map(
        &mut layout.folder_labels,
        &before.folder_labels,
        &after.folder_labels,
    );
    restore_list(&mut layout.labels, &before.labels, &after.labels, |l| {
        l.id.clone()
    });
    reconcile(layout, sites);
    report
}

/// Three-way restore of set membership.
fn restore_set(
    current: &mut BTreeSet<String>,
    before: &BTreeSet<String>,
    after: &BTreeSet<String>,
) {
    for key in before.symmetric_difference(after) {
        let was = before.contains(key);
        if current.contains(key) != was {
            if was {
                current.insert(key.clone());
            } else {
                current.remove(key);
            }
        }
    }
}

/// Three-way restore of an ordered list: the whole list when it is still exactly as the
/// batch left it (so a reorder is undone too), else entry presence by `key`, re-inserting
/// at the old index.
fn restore_list<T: Clone + PartialEq, K: PartialEq>(
    current: &mut Vec<T>,
    before: &[T],
    after: &[T],
    key: impl Fn(&T) -> K,
) {
    if current.as_slice() == after {
        *current = before.to_vec();
        return;
    }
    // Entries the batch added or changed: drop them if they are still as it left them.
    for item in after {
        let in_before = before.iter().find(|b| key(b) == key(item));
        if in_before != Some(item) {
            current.retain(|c| c != item);
        }
    }
    // Entries the batch removed or changed: put them back if the key is free.
    for (i, item) in before.iter().enumerate() {
        let in_after = after.iter().find(|a| key(a) == key(item));
        if in_after != Some(item) && !current.iter().any(|c| key(c) == key(item)) {
            let at = i.min(current.len());
            current.insert(at, item.clone());
        }
    }
}

/// Three-way restore of map values.
fn restore_map(
    current: &mut BTreeMap<String, String>,
    before: &BTreeMap<String, String>,
    after: &BTreeMap<String, String>,
) {
    let keys: BTreeSet<&String> = before.keys().chain(after.keys()).collect();
    for key in keys {
        let (b, a) = (before.get(key), after.get(key));
        if b != a && current.get(key) == a {
            match b {
                Some(value) => current.insert(key.clone(), value.clone()),
                None => current.remove(key),
            };
        }
    }
}

// ---------------------------------------------------------------------------------------
// Loading and saving
// ---------------------------------------------------------------------------------------

pub struct LoadedSiteLayout {
    pub layout: SiteLayout,
    /// The layout must not be written back (newer version, or its key is unreadable).
    pub read_only: bool,
    /// `"[code] message"` for the UI, when something was not as expected.
    pub warning: Option<String>,
}

impl LoadedSiteLayout {
    fn fresh(read_only: bool, warning: Option<String>) -> Self {
        Self {
            layout: SiteLayout::default(),
            read_only,
            warning,
        }
    }
}

fn lenient_vec<T: DeserializeOwned>(value: Value) -> Vec<T> {
    match value {
        Value::Array(items) => items
            .into_iter()
            .filter_map(|item| serde_json::from_value(item).ok())
            .collect(),
        _ => Vec::new(),
    }
}

fn lenient_string_map(value: Value) -> BTreeMap<String, String> {
    match value {
        Value::Object(map) => map
            .into_iter()
            .filter_map(|(k, v)| match v {
                Value::String(s) => Some((k, s)),
                _ => None,
            })
            .collect(),
        _ => BTreeMap::new(),
    }
}

/// Reads a layout file's JSON, keeping every entry this build understands (an unknown
/// favorite kind or label colour drops that entry only) and every unknown key (in
/// `extra`). Returns the layout and whether it comes from a newer layout version.
pub fn parse_site_layout(bytes: &[u8]) -> Result<(SiteLayout, bool), serde_json::Error> {
    let value: Value = serde_json::from_slice(bytes)?;
    let Value::Object(map) = value else {
        return Err(serde::de::Error::custom(
            "the site layout is not a JSON object",
        ));
    };
    let mut layout = SiteLayout::default();
    for (key, value) in map {
        match key.as_str() {
            "version" => {
                if let Some(v) = value.as_u64() {
                    layout.version = u32::try_from(v).unwrap_or(u32::MAX);
                }
            }
            "folders" => layout.folders = lenient_vec::<String>(value).into_iter().collect(),
            "favorites" => layout.favorites = lenient_vec(value),
            "recents" => layout.recents = lenient_vec(value),
            "labels" => layout.labels = lenient_vec(value),
            "site_labels" => layout.site_labels = lenient_string_map(value),
            "folder_labels" => layout.folder_labels = lenient_string_map(value),
            "collapsed" => layout.collapsed = lenient_vec::<String>(value).into_iter().collect(),
            "migrated_local_storage" => {
                layout.migrated_local_storage = value.as_bool().unwrap_or(false)
            }
            "large_library_collapsed" => {
                layout.large_library_collapsed = value.as_bool().unwrap_or(false)
            }
            _ => {
                layout.extra.insert(key, value);
            }
        }
    }
    let newer = layout.version > SITE_LAYOUT_VERSION;
    Ok((layout, newer))
}

/// Decides what a load gives: the layout, read-only (a newer version, a key problem, or
/// a file that cannot be read right now: not a damaged file, so it stays), or a fresh
/// layout with the damaged file (not JSON, not an envelope, does not decrypt) moved
/// aside by `quarantine`.
fn interpret_loaded_layout(
    loaded: Result<Option<Vec<u8>>, VaultError>,
    sites_vault_exists: bool,
    quarantine: impl FnOnce() -> Result<Option<PathBuf>, VaultError>,
) -> LoadedSiteLayout {
    let problem = match loaded {
        Ok(None) => return LoadedSiteLayout::fresh(false, None),
        Ok(Some(bytes)) => match parse_site_layout(&bytes) {
            Ok((layout, newer)) => {
                return LoadedSiteLayout {
                    layout,
                    read_only: newer,
                    warning: newer.then(|| {
                        format!(
                        "[{ERR_LAYOUT_READ_ONLY}] Folders, favorites and labels were saved by a \
                             newer RustSCP and are read-only here"
                    )
                    }),
                }
            }
            Err(e) => e.to_string(),
        },
        Err(e @ VaultError::KeychainUnavailable(_)) => {
            return LoadedSiteLayout::fresh(true, Some(format!("[{WARN_LAYOUT_UNAVAILABLE}] {e}")))
        }
        // The key of an existing sites.vault is missing: a key problem, the file stays.
        Err(e @ VaultError::DeviceKeyMissing(_)) if sites_vault_exists => {
            return LoadedSiteLayout::fresh(true, Some(format!("[{WARN_LAYOUT_UNAVAILABLE}] {e}")))
        }
        // The file (or its key file) cannot be read right now (EACCES, EIO, ...), or the
        // load failed for another reason than its content: the file stays.
        Err(e)
            if matches!(&e, VaultError::IoError(io) if io.kind() != std::io::ErrorKind::NotFound)
                || matches!(&e, VaultError::Other(_)) =>
        {
            return LoadedSiteLayout::fresh(true, Some(format!("[{WARN_LAYOUT_UNAVAILABLE}] {e}")))
        }
        // No sites.vault and no key: nothing can ever open the file.
        Err(e) => e.to_string(),
    };
    tracing::warn!("could not read the site layout ({problem}); starting a new one");
    let moved = match quarantine() {
        Ok(Some(path)) => format!(" It was kept as {}.", path.display()),
        Ok(None) => String::new(),
        Err(e) => {
            tracing::error!("could not move the unreadable site layout aside: {e}");
            // Never overwrite a file that could not be moved aside.
            return LoadedSiteLayout::fresh(
                true,
                Some(format!("[{WARN_LAYOUT_UNAVAILABLE}] {problem}")),
            );
        }
    };
    LoadedSiteLayout::fresh(
        false,
        Some(format!(
            "[{WARN_LAYOUT_RESET}] Folders, favorites and labels could not be read ({problem}) \
             and start empty.{moved}"
        )),
    )
}

/// [`interpret_loaded_layout`], except that with `keep_file` (the saved sites could not
/// be loaded in this run) a file that cannot be read is never moved aside: the same key
/// problem may hide both files, and restoring the vault must bring the layout back too.
fn interpret_loaded_layout_keeping(
    loaded: Result<Option<Vec<u8>>, VaultError>,
    sites_vault_exists: bool,
    keep_file: bool,
    quarantine: impl FnOnce() -> Result<Option<PathBuf>, VaultError>,
) -> LoadedSiteLayout {
    interpret_loaded_layout(loaded, sites_vault_exists || keep_file, || {
        if keep_file {
            return Err(VaultError::Other(
                "kept while the saved sites cannot be read".into(),
            ));
        }
        quarantine()
    })
}

/// Loads `site-layout.vault`. Never fails: problems give a default layout and a warning
/// (see [`LoadedSiteLayout`]). With `keep_file` (the saved sites could not be loaded in
/// this run) an unreadable file stays where it is and the layout is read-only.
pub fn load_site_layout(keep_file: bool) -> LoadedSiteLayout {
    let loaded = vault::load_device_sealed_file(SITE_LAYOUT_FILE);
    let sites_vault_exists = vault::get_local_vault_path().exists();
    interpret_loaded_layout_keeping(loaded, sites_vault_exists, keep_file, || {
        vault::quarantine_config_file(SITE_LAYOUT_FILE)
    })
}

fn layout_bytes(layout: &SiteLayout) -> Result<Vec<u8>, VaultError> {
    if layout.version > SITE_LAYOUT_VERSION {
        return Err(VaultError::Other(format!(
            "[{ERR_LAYOUT_READ_ONLY}] the site layout was written by a newer RustSCP"
        )));
    }
    Ok(serde_json::to_vec(layout)?)
}

/// Writes `site-layout.vault` (device key, atomic, 0600). Refuses a layout from a newer
/// version.
pub fn save_site_layout(layout: &SiteLayout) -> Result<(), VaultError> {
    vault::save_device_sealed_file(SITE_LAYOUT_FILE, &layout_bytes(layout)?)
}

/// [`load_site_layout`] on a blocking thread.
pub async fn load_site_layout_async(keep_file: bool) -> LoadedSiteLayout {
    match tokio::task::spawn_blocking(move || load_site_layout(keep_file)).await {
        Ok(loaded) => loaded,
        Err(e) => LoadedSiteLayout::fresh(
            true,
            Some(format!(
                "[{WARN_LAYOUT_UNAVAILABLE}] layout worker failed: {e}"
            )),
        ),
    }
}

/// [`save_site_layout`] on a blocking thread.
pub async fn save_site_layout_async(layout: SiteLayout) -> Result<(), VaultError> {
    tokio::task::spawn_blocking(move || save_site_layout(&layout))
        .await
        .map_err(|e| VaultError::Other(format!("layout worker failed: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{AuthMethod, Protocol};

    fn site(id: &str, name: &str, group: Option<&str>) -> ConnectionConfig {
        ConnectionConfig {
            id: id.into(),
            name: name.into(),
            protocol: Protocol::Sftp,
            host: format!("{id}.example.com"),
            group: group.map(Into::into),
            auth: AuthMethod::Password("pw".into()),
            ..ConnectionConfig::local()
        }
    }

    fn library() -> Vec<ConnectionConfig> {
        vec![
            ConnectionConfig::local(),
            site("web-01", "web-01", Some("Clients/Acme/Web")),
            site("db-01", "db-01", Some("Clients/Acme")),
            site("solo", "solo", None),
            site("stg", "stg", Some("Staging")),
        ]
    }

    fn ids() -> impl FnMut() -> String {
        let mut n = 0;
        move || {
            n += 1;
            format!("new-{n}")
        }
    }

    fn run(
        sites: &mut Vec<ConnectionConfig>,
        layout: &mut SiteLayout,
        ops: Vec<SiteTreeOp>,
    ) -> Result<ApplyOutcome, SiteTreeError> {
        apply_ops(sites, layout, &ops, &mut ids())
    }

    fn group_of<'a>(sites: &'a [ConnectionConfig], id: &str) -> Option<&'a str> {
        sites.iter().find(|s| s.id == id).unwrap().group.as_deref()
    }

    fn folders(layout: &SiteLayout) -> Vec<&str> {
        layout.folders.iter().map(String::as_str).collect()
    }

    fn label(id: &str) -> LabelDef {
        LabelDef {
            id: id.into(),
            name: id.into(),
            color: LabelColor::Red,
        }
    }

    // 1
    #[test]
    fn reconcile_adds_implied_folders_and_drops_dangling_refs() {
        let sites = library();
        let mut layout = SiteLayout {
            favorites: vec![
                FavoriteRef::Site { id: "gone".into() },
                FavoriteRef::Site { id: "solo".into() },
                FavoriteRef::Site { id: "solo".into() },
                FavoriteRef::Folder {
                    path: "Nowhere".into(),
                },
                FavoriteRef::Folder {
                    path: " Clients / Acme ".into(),
                },
            ],
            recents: vec![
                RecentEntry {
                    id: "local".into(),
                    at: Some(1),
                    count: 1,
                },
                RecentEntry {
                    id: "gone".into(),
                    at: Some(2),
                    count: 1,
                },
                RecentEntry {
                    id: "stg".into(),
                    at: Some(3),
                    count: 2,
                },
            ],
            labels: vec![label("label-a")],
            site_labels: BTreeMap::from([
                ("gone".into(), "label-a".into()),
                ("solo".into(), "label-a".into()),
                ("stg".into(), "label-missing".into()),
            ]),
            folder_labels: BTreeMap::from([("Nowhere".into(), "label-a".into())]),
            collapsed: BTreeSet::from(["Nowhere".into(), "Clients".into()]),
            ..SiteLayout::default()
        };
        assert!(reconcile(&mut layout, &sites));
        assert_eq!(
            folders(&layout),
            ["Clients", "Clients/Acme", "Clients/Acme/Web", "Staging"]
        );
        assert_eq!(
            layout.favorites,
            [
                FavoriteRef::Site { id: "solo".into() },
                FavoriteRef::Folder {
                    path: "Clients/Acme".into()
                }
            ]
        );
        assert_eq!(layout.recents.len(), 1);
        assert_eq!(layout.recents[0].id, "stg");
        assert_eq!(
            layout.site_labels,
            BTreeMap::from([("solo".into(), "label-a".into())])
        );
        assert!(layout.folder_labels.is_empty());
        assert_eq!(layout.collapsed, BTreeSet::from(["Clients".to_string()]));
        // A second pass has nothing left to do.
        assert!(!reconcile(&mut layout, &sites));
    }

    // 2
    #[test]
    fn an_empty_folder_persists() {
        let mut sites = library();
        let mut layout = SiteLayout::default();
        let out = run(
            &mut sites,
            &mut layout,
            vec![SiteTreeOp::CreateFolder {
                path: "Archive/2024".into(),
            }],
        )
        .unwrap();
        assert!(!out.sites_changed);
        assert!(out.layout_changed);
        assert!(layout.folders.contains("Archive") && layout.folders.contains("Archive/2024"));

        // Moving the last site out of a folder keeps the folder.
        run(
            &mut sites,
            &mut layout,
            vec![SiteTreeOp::MoveSites {
                ids: vec!["stg".into()],
                to: None,
            }],
        )
        .unwrap();
        assert_eq!(group_of(&sites, "stg"), None);
        assert!(layout.folders.contains("Staging"));
        assert!(!reconcile(&mut layout, &sites));
        assert!(layout.folders.contains("Archive/2024"));
    }

    // 3
    #[test]
    fn a_deep_rename_rewrites_everything_under_the_folder() {
        let mut sites = library();
        let mut layout = SiteLayout {
            labels: vec![label("label-a")],
            favorites: vec![FavoriteRef::Folder {
                path: "Clients/Acme/Web".into(),
            }],
            folder_labels: BTreeMap::from([("Clients/Acme".into(), "label-a".into())]),
            collapsed: BTreeSet::from(["Clients/Acme/Web".into(), "Clients".into()]),
            ..SiteLayout::default()
        };
        let out = run(
            &mut sites,
            &mut layout,
            vec![SiteTreeOp::RenameFolder {
                path: "Clients/Acme".into(),
                name: "Acme Corp".into(),
                merge: false,
            }],
        )
        .unwrap();
        assert!(out.sites_changed && out.layout_changed);
        assert_eq!(group_of(&sites, "web-01"), Some("Clients/Acme Corp/Web"));
        assert_eq!(group_of(&sites, "db-01"), Some("Clients/Acme Corp"));
        assert_eq!(group_of(&sites, "stg"), Some("Staging"));
        assert_eq!(
            folders(&layout),
            [
                "Clients",
                "Clients/Acme Corp",
                "Clients/Acme Corp/Web",
                "Staging"
            ]
        );
        assert_eq!(
            layout.favorites,
            [FavoriteRef::Folder {
                path: "Clients/Acme Corp/Web".into()
            }]
        );
        assert_eq!(
            layout.folder_labels,
            BTreeMap::from([("Clients/Acme Corp".into(), "label-a".into())])
        );
        assert_eq!(
            layout.collapsed,
            BTreeSet::from(["Clients".to_string(), "Clients/Acme Corp/Web".to_string()])
        );
        // Only the two sites inside changed.
        let touched: Vec<&str> = out
            .undo
            .sites_before
            .iter()
            .map(|(id, _)| id.as_str())
            .collect();
        assert_eq!(touched, ["web-01", "db-01"]);
    }

    #[test]
    fn a_case_only_rename_is_not_a_clash() {
        let mut sites = library();
        let mut layout = SiteLayout::default();
        run(
            &mut sites,
            &mut layout,
            vec![SiteTreeOp::RenameFolder {
                path: "Staging".into(),
                name: "STAGING".into(),
                merge: false,
            }],
        )
        .unwrap();
        assert_eq!(group_of(&sites, "stg"), Some("STAGING"));
        assert!(!layout.folders.contains("Staging"));
    }

    // 4
    #[test]
    fn a_rename_clash_needs_merge() {
        let mut sites = library();
        sites.push(site("prod-web", "prod-web", Some("Clients/web")));
        let mut layout = SiteLayout {
            folders: BTreeSet::from(["Clients/web/Old".into()]),
            ..SiteLayout::default()
        };
        let rename = |merge| SiteTreeOp::RenameFolder {
            path: "Clients/web".into(),
            name: "acme".into(),
            merge,
        };
        let err = run(&mut sites, &mut layout, vec![rename(false)]).unwrap_err();
        assert_eq!(err.code, ERR_FOLDER_EXISTS);
        assert!(err.to_string().starts_with("[site_tree.folder_exists] "));
        assert_eq!(group_of(&sites, "prod-web"), Some("Clients/web"));

        run(&mut sites, &mut layout, vec![rename(true)]).unwrap();
        // Merged into the existing "Acme", keeping its spelling.
        assert_eq!(group_of(&sites, "prod-web"), Some("Clients/Acme"));
        assert!(layout.folders.contains("Clients/Acme/Old"));
        assert!(!layout.folders.iter().any(|f| f.starts_with("Clients/web")));
        assert!(!layout.folders.contains("Clients/acme"));
    }

    #[test]
    fn a_move_clash_needs_merge() {
        let mut sites = library();
        sites.push(site("x", "x", Some("Old/Web")));
        let mut layout = SiteLayout::default();
        let mv = |merge| SiteTreeOp::MoveFolder {
            path: "Old/Web".into(),
            to: Some("Clients/Acme".into()),
            merge,
        };
        assert_eq!(
            run(&mut sites, &mut layout, vec![mv(false)])
                .unwrap_err()
                .code,
            ERR_FOLDER_EXISTS
        );
        run(&mut sites, &mut layout, vec![mv(true)]).unwrap();
        assert_eq!(group_of(&sites, "x"), Some("Clients/Acme/Web"));
        assert_eq!(group_of(&sites, "web-01"), Some("Clients/Acme/Web"));
        assert!(layout.folders.contains("Old"));
        assert!(!layout.folders.contains("Old/Web"));
    }

    // 5
    #[test]
    fn a_folder_cannot_move_into_itself() {
        let mut sites = library();
        let mut layout = SiteLayout::default();
        for to in ["Clients", "Clients/Acme", "Clients/Acme/Web"] {
            let err = run(
                &mut sites,
                &mut layout,
                vec![SiteTreeOp::MoveFolder {
                    path: "Clients".into(),
                    to: Some(to.into()),
                    merge: true,
                }],
            )
            .unwrap_err();
            assert_eq!(err.code, ERR_INTO_SELF, "{to}");
        }
        let err = run(
            &mut sites,
            &mut layout,
            vec![SiteTreeOp::CopyFolder {
                path: "Clients".into(),
                to: Some("Clients/Acme".into()),
                name: "Copy".into(),
            }],
        )
        .unwrap_err();
        assert_eq!(err.code, ERR_INTO_SELF);
        // A sibling whose name starts the same way is not inside it.
        run(
            &mut sites,
            &mut layout,
            vec![
                SiteTreeOp::CreateFolder {
                    path: "Clients2".into(),
                },
                SiteTreeOp::MoveFolder {
                    path: "Clients2".into(),
                    to: Some("Clients".into()),
                    merge: false,
                },
            ],
        )
        .unwrap();
        assert!(layout.folders.contains("Clients/Clients2"));
    }

    // 6
    #[test]
    fn delete_folder_keeping_contents_lifts_them_and_merges_clashes() {
        let mut sites = vec![
            ConnectionConfig::local(),
            site("a", "a", Some("Production")),
            site("b", "b", Some("Production/Web/Edge")),
            site("c", "c", Some("Production/db")),
            site("d", "d", Some("DB")),
            site("e", "e", Some("Production/Production")),
        ];
        let mut layout = SiteLayout {
            folders: BTreeSet::from(["Production/Empty".into()]),
            favorites: vec![
                FavoriteRef::Folder {
                    path: "Production".into(),
                },
                FavoriteRef::Folder {
                    path: "Production/Web".into(),
                },
            ],
            ..SiteLayout::default()
        };
        run(
            &mut sites,
            &mut layout,
            vec![SiteTreeOp::DeleteFolder {
                path: "Production".into(),
                keep_contents: true,
            }],
        )
        .unwrap();
        assert_eq!(group_of(&sites, "a"), None);
        assert_eq!(group_of(&sites, "b"), Some("Web/Edge"));
        // "db" merges into the existing "DB".
        assert_eq!(group_of(&sites, "c"), Some("DB"));
        assert_eq!(group_of(&sites, "d"), Some("DB"));
        // A child named like the deleted folder takes its place.
        assert_eq!(group_of(&sites, "e"), Some("Production"));
        assert_eq!(
            folders(&layout),
            ["DB", "Empty", "Production", "Web", "Web/Edge"]
        );
        // The favorite of the deleted folder went; the one inside followed its folder.
        assert_eq!(
            layout.favorites,
            [FavoriteRef::Folder { path: "Web".into() }]
        );
        assert_eq!(sites.len(), 6);
    }

    // 7
    #[test]
    fn delete_folder_with_contents_removes_its_sites() {
        let mut sites = library();
        let mut layout = SiteLayout {
            favorites: vec![FavoriteRef::Site {
                id: "web-01".into(),
            }],
            ..SiteLayout::default()
        };
        let out = run(
            &mut sites,
            &mut layout,
            vec![SiteTreeOp::DeleteFolder {
                path: "Clients/Acme".into(),
                keep_contents: false,
            }],
        )
        .unwrap();
        let left: Vec<&str> = sites.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(left, ["local", "solo", "stg"]);
        assert_eq!(folders(&layout), ["Clients", "Staging"]);
        assert!(layout.favorites.is_empty());
        // The snapshot keeps the deleted sites with their secrets.
        let web = out
            .undo
            .sites_before
            .iter()
            .find(|(id, _)| id == "web-01")
            .unwrap();
        assert!(matches!(
            web.1.as_ref().unwrap().auth,
            AuthMethod::Password(ref p) if p == "pw"
        ));
    }

    // 8
    #[test]
    fn copies_clone_secrets_and_every_field() {
        let mut sites = library();
        let mut source = site("key", "key", Some("Clients/Acme"));
        source.auth = AuthMethod::PrivateKey {
            path: String::new(),
            passphrase: Some("s3cret".into()),
            key_data: Some("-----BEGIN OPENSSH PRIVATE KEY-----".into()),
        };
        source.tls_fingerprint = Some("AB:CD".into());
        source.remote_root = "/srv".into();
        source.port = 2222;
        sites.push(source);
        let mut layout = SiteLayout {
            labels: vec![label("label-a")],
            site_labels: BTreeMap::from([("key".into(), "label-a".into())]),
            folder_labels: BTreeMap::from([("Clients/Acme".into(), "label-a".into())]),
            favorites: vec![FavoriteRef::Site { id: "key".into() }],
            ..SiteLayout::default()
        };
        let out = run(
            &mut sites,
            &mut layout,
            vec![
                SiteTreeOp::CopySites {
                    items: vec![CopyItem {
                        id: "key".into(),
                        name: "key copy".into(),
                        group: Some("Clients/Acme".into()),
                    }],
                },
                SiteTreeOp::CopyFolder {
                    path: "Clients/Acme".into(),
                    to: None,
                    name: "Acme copy".into(),
                },
            ],
        )
        .unwrap();
        let without_id_and_name = |s: &ConnectionConfig| {
            let mut v = serde_json::to_value(s).unwrap();
            let obj = v.as_object_mut().unwrap();
            obj.remove("id");
            obj.remove("name");
            obj.remove("group");
            v
        };
        let original = sites.iter().find(|s| s.id == "key").unwrap().clone();
        let copy = sites.iter().find(|s| s.id == "new-1").unwrap();
        assert_eq!(copy.name, "key copy");
        assert_eq!(copy.group.as_deref(), Some("Clients/Acme"));
        assert_eq!(without_id_and_name(copy), without_id_and_name(&original));
        // The folder copy holds copies of db-01, web-01, key and "key copy".
        let created: Vec<(&str, &str)> = out
            .created
            .iter()
            .map(|c| (c.source_id.as_str(), c.id.as_str()))
            .collect();
        assert_eq!(created[0], ("key", "new-1"));
        assert_eq!(created.len(), 5);
        let key_copy = &sites
            .iter()
            .find(|s| {
                s.id == created
                    .iter()
                    .find(|c| c.0 == "key" && c.1 != "new-1")
                    .unwrap()
                    .1
            })
            .unwrap();
        assert_eq!(key_copy.group.as_deref(), Some("Acme copy"));
        assert_eq!(key_copy.name, "key");
        assert_eq!(
            without_id_and_name(key_copy),
            without_id_and_name(&original)
        );
        assert_eq!(group_of(&sites, created[1].1), Some("Acme copy/Web"));
        assert!(layout.folders.contains("Acme copy/Web"));
        // Labels are copied, favorites are not.
        assert_eq!(
            layout.site_labels.get("new-1").map(String::as_str),
            Some("label-a")
        );
        assert_eq!(
            layout.folder_labels.get("Acme copy").map(String::as_str),
            Some("label-a")
        );
        assert_eq!(layout.favorites.len(), 1);
    }

    // 9
    #[test]
    fn local_cannot_be_moved_copied_or_deleted_but_can_be_renamed() {
        let mut sites = library();
        let mut layout = SiteLayout::default();
        for op in [
            SiteTreeOp::MoveSites {
                ids: vec!["local".into()],
                to: Some("Staging".into()),
            },
            SiteTreeOp::DeleteSites {
                ids: vec!["solo".into(), "local".into()],
            },
            SiteTreeOp::CopySites {
                items: vec![CopyItem {
                    id: "local".into(),
                    name: "x".into(),
                    group: None,
                }],
            },
        ] {
            let err = run(&mut sites, &mut layout, vec![op]).unwrap_err();
            assert_eq!(err.code, ERR_LOCAL_IMMUTABLE);
        }
        assert_eq!(sites.len(), 5);
        run(
            &mut sites,
            &mut layout,
            vec![SiteTreeOp::RenameSite {
                id: "local".into(),
                name: " My Mac ".into(),
            }],
        )
        .unwrap();
        assert_eq!(sites[0].name, "My Mac");
        // A recent entry for Local is never kept.
        record_recent(&mut layout, "local", 5);
        assert!(layout.recents.is_empty());
    }

    // 10
    #[test]
    fn a_path_over_255_characters_is_rejected_not_truncated() {
        let long = "x".repeat(250);
        let mut sites = library();
        sites.push(site("deep", "deep", Some(&format!("{long}/abc"))));
        let mut layout = SiteLayout::default();
        // "<250 x>/abc" is 254 characters; renaming the parent to 6 characters more is not.
        let err = run(
            &mut sites,
            &mut layout,
            vec![SiteTreeOp::RenameFolder {
                path: long.clone(),
                name: "y".repeat(253),
                merge: false,
            }],
        )
        .unwrap_err();
        assert_eq!(err.code, ERR_PATH_TOO_LONG);
        assert_eq!(
            group_of(&sites, "deep"),
            Some(format!("{long}/abc").as_str())
        );

        let err = run(
            &mut sites,
            &mut layout,
            vec![SiteTreeOp::MoveFolder {
                path: format!("{long}/abc"),
                to: Some("Staging".into()),
                merge: false,
            }],
        );
        assert!(err.is_ok(), "Staging/abc is short");
        let err = run(
            &mut sites,
            &mut layout,
            vec![SiteTreeOp::CreateFolder {
                path: "z".repeat(256),
            }],
        )
        .unwrap_err();
        assert_eq!(err.code, ERR_PATH_TOO_LONG);
        assert_eq!(
            normalize_folder_path(&"é".repeat(256)).unwrap_err().code,
            ERR_PATH_TOO_LONG
        );
        assert!(normalize_folder_path(&"é".repeat(255)).is_ok());
        assert_eq!(
            normalize_folder_path("a\u{7}b").unwrap_err().code,
            ERR_INVALID_NAME
        );
        assert_eq!(
            normalize_folder_path(" A // B/ ").unwrap().as_deref(),
            Some("A/B")
        );
        assert_eq!(normalize_folder_path(" / ").unwrap(), None);
        assert_eq!(
            validate_folder_name("a/b").unwrap_err().code,
            ERR_INVALID_NAME
        );
        assert_eq!(
            validate_folder_name("  ").unwrap_err().code,
            ERR_INVALID_NAME
        );
    }

    // 11
    #[test]
    fn a_batch_is_all_or_nothing() {
        let mut sites = library();
        let mut layout = SiteLayout {
            folders: BTreeSet::from(["Keep".into()]),
            ..SiteLayout::default()
        };
        let sites_before = serde_json::to_value(&sites).unwrap();
        let layout_before = layout.clone();
        let err = run(
            &mut sites,
            &mut layout,
            vec![
                SiteTreeOp::MoveSites {
                    ids: vec!["solo".into()],
                    to: Some("Keep".into()),
                },
                SiteTreeOp::RenameFolder {
                    path: "Does/Not/Exist".into(),
                    name: "x".into(),
                    merge: false,
                },
            ],
        )
        .unwrap_err();
        assert_eq!(err.code, ERR_NOT_FOUND);
        assert_eq!(serde_json::to_value(&sites).unwrap(), sites_before);
        assert_eq!(layout, layout_before);

        let too_many: Vec<SiteTreeOp> = (0..=MAX_OPS_PER_CALL)
            .map(|i| SiteTreeOp::CreateFolder {
                path: format!("F{i}"),
            })
            .collect();
        assert_eq!(
            run(&mut sites, &mut layout, too_many).unwrap_err().code,
            ERR_TOO_MANY
        );
        let ids = vec!["solo".to_string(); MAX_IDS_PER_CALL + 1];
        assert_eq!(
            run(
                &mut sites,
                &mut layout,
                vec![SiteTreeOp::MoveSites { ids, to: None }]
            )
            .unwrap_err()
            .code,
            ERR_TOO_MANY
        );
        assert_eq!(layout, layout_before);
    }

    // 12
    #[test]
    fn undo_restores_a_delete_with_secrets_favorites_and_labels() {
        let mut sites = library();
        let mut layout = SiteLayout {
            labels: vec![label("label-a")],
            favorites: vec![
                FavoriteRef::Site { id: "solo".into() },
                FavoriteRef::Folder {
                    path: "Clients/Acme".into(),
                },
                FavoriteRef::Site { id: "stg".into() },
            ],
            site_labels: BTreeMap::from([("web-01".into(), "label-a".into())]),
            folder_labels: BTreeMap::from([("Clients/Acme/Web".into(), "label-a".into())]),
            collapsed: BTreeSet::from(["Clients/Acme".into()]),
            ..SiteLayout::default()
        };
        reconcile(&mut layout, &sites);
        let sites_start = serde_json::to_value(&sites).unwrap();
        let layout_start = layout.clone();

        let out = run(
            &mut sites,
            &mut layout,
            vec![SiteTreeOp::DeleteFolder {
                path: "Clients".into(),
                keep_contents: false,
            }],
        )
        .unwrap();
        assert_eq!(sites.len(), 3);
        assert_eq!(layout.favorites.len(), 2);

        let report = undo(&out.undo, &mut sites, &mut layout);
        assert_eq!(
            report,
            UndoReport {
                restored: 2,
                skipped: 0
            }
        );
        let mut restored = serde_json::to_value(&sites).unwrap();
        // Restored sites go back at the end of the list.
        restored
            .as_array_mut()
            .unwrap()
            .sort_by_key(|s| s["id"].as_str().unwrap().to_string());
        let mut start = sites_start.clone();
        start
            .as_array_mut()
            .unwrap()
            .sort_by_key(|s| s["id"].as_str().unwrap().to_string());
        assert_eq!(restored, start);
        assert_eq!(layout, layout_start);
    }

    #[test]
    fn undo_skips_a_site_changed_since_and_counts_it() {
        let mut sites = library();
        let mut layout = SiteLayout::default();
        let out = run(
            &mut sites,
            &mut layout,
            vec![SiteTreeOp::MoveSites {
                ids: vec!["solo".into(), "stg".into()],
                to: Some("Archive".into()),
            }],
        )
        .unwrap();
        // The user then edits "stg" in the form (save_site).
        sites.iter_mut().find(|s| s.id == "stg").unwrap().host = "new.example.com".into();

        let report = undo(&out.undo, &mut sites, &mut layout);
        assert_eq!(
            report,
            UndoReport {
                restored: 1,
                skipped: 1
            }
        );
        assert_eq!(group_of(&sites, "solo"), None);
        assert_eq!(group_of(&sites, "stg"), Some("Archive"));
        // "Archive" still holds "stg", so it stays.
        assert!(layout.folders.contains("Archive"));

        // Undoing a copy removes the copy unless it was edited.
        let out = run(
            &mut sites,
            &mut layout,
            vec![SiteTreeOp::CopySites {
                items: vec![CopyItem {
                    id: "solo".into(),
                    name: "solo copy".into(),
                    group: None,
                }],
            }],
        )
        .unwrap();
        let report = undo(&out.undo, &mut sites, &mut layout);
        assert_eq!(report.restored, 1);
        assert!(!sites.iter().any(|s| s.id == "new-1"));
    }

    #[test]
    fn undo_restores_the_layout_three_ways() {
        let mut sites = library();
        let mut layout = SiteLayout {
            labels: vec![label("label-a"), label("label-b")],
            favorites: vec![
                FavoriteRef::Site { id: "solo".into() },
                FavoriteRef::Site { id: "stg".into() },
            ],
            ..SiteLayout::default()
        };
        reconcile(&mut layout, &sites);
        let out = run(
            &mut sites,
            &mut layout,
            vec![
                SiteTreeOp::CreateFolder { path: "New".into() },
                SiteTreeOp::SetFavorites {
                    items: vec![
                        FavoriteRef::Site { id: "stg".into() },
                        FavoriteRef::Folder { path: "New".into() },
                    ],
                },
                SiteTreeOp::SetLabel {
                    sites: vec!["solo".into(), "stg".into()],
                    folders: vec!["New".into()],
                    label: Some("label-a".into()),
                },
            ],
        )
        .unwrap();
        assert!(!out.sites_changed);

        // Later, independently: "stg" is relabelled and "Other" is created.
        run(
            &mut sites,
            &mut layout,
            vec![
                SiteTreeOp::SetLabel {
                    sites: vec!["stg".into()],
                    folders: vec![],
                    label: Some("label-b".into()),
                },
                SiteTreeOp::CreateFolder {
                    path: "Other".into(),
                },
            ],
        )
        .unwrap();

        let report = undo(&out.undo, &mut sites, &mut layout);
        assert_eq!(report, UndoReport::default());
        assert!(!layout.folders.contains("New"));
        assert!(layout.folders.contains("Other"));
        // "solo" lost the label the batch gave it; "stg" keeps the newer one.
        assert_eq!(layout.site_labels.get("solo"), None);
        assert_eq!(
            layout.site_labels.get("stg").map(String::as_str),
            Some("label-b")
        );
        assert!(layout.folder_labels.is_empty());
        // Favorites: "solo" goes back to its old place, the folder favorite goes away.
        assert_eq!(
            layout.favorites,
            [
                FavoriteRef::Site { id: "solo".into() },
                FavoriteRef::Site { id: "stg".into() },
            ]
        );
    }

    #[test]
    fn undo_puts_back_a_reordered_favorites_list() {
        let mut sites = library();
        let order = |ids: &[&str]| -> Vec<FavoriteRef> {
            ids.iter()
                .map(|id| FavoriteRef::Site { id: (*id).into() })
                .collect()
        };
        let mut layout = SiteLayout {
            favorites: order(&["solo", "stg", "web-01"]),
            ..SiteLayout::default()
        };
        let out = run(
            &mut sites,
            &mut layout,
            vec![SiteTreeOp::SetFavorites {
                items: order(&["web-01", "solo", "stg"]),
            }],
        )
        .unwrap();
        undo(&out.undo, &mut sites, &mut layout);
        assert_eq!(layout.favorites, order(&["solo", "stg", "web-01"]));
    }

    // 13
    #[test]
    fn unknown_keys_survive_a_round_trip() {
        let json = r#"{
            "version": 1,
            "folders": ["Clients"],
            "favorites": [{"kind":"site","id":"solo"},{"kind":"smart","query":"x"}],
            "labels": [{"id":"label-a","name":"Prod","color":"red"},
                       {"id":"label-b","name":"Pink","color":"pink"}],
            "future_feature": {"enabled": true},
            "pinned": ["a"]
        }"#;
        let (layout, newer) = parse_site_layout(json.as_bytes()).unwrap();
        assert!(!newer);
        assert_eq!(layout.favorites, [FavoriteRef::Site { id: "solo".into() }]);
        assert_eq!(layout.labels.len(), 1);
        assert_eq!(
            layout.extra["future_feature"],
            serde_json::json!({"enabled": true})
        );

        let written = serde_json::to_vec(&layout).unwrap();
        let (again, _) = parse_site_layout(&written).unwrap();
        assert_eq!(again, layout);
        // The derived serde impls agree.
        let derived: SiteLayout = serde_json::from_slice(&written).unwrap();
        assert_eq!(derived, layout);
        assert_eq!(derived.extra["pinned"], serde_json::json!(["a"]));
    }

    #[test]
    fn a_layout_survives_the_sealed_file() {
        let dir = tempfile::tempdir().unwrap();
        let mut layout = SiteLayout::default();
        layout.folders.insert("Clients".into());
        layout.extra.insert("future".into(), serde_json::json!(1));
        vault::save_sealed_in(
            dir.path(),
            SITE_LAYOUT_FILE,
            &layout_bytes(&layout).unwrap(),
        )
        .unwrap();
        let bytes = vault::load_sealed_in(dir.path(), SITE_LAYOUT_FILE)
            .unwrap()
            .unwrap();
        assert_eq!(parse_site_layout(&bytes).unwrap(), (layout, false));
    }

    #[test]
    fn loading_handles_every_outcome() {
        let never = || -> Result<Option<PathBuf>, VaultError> { panic!("must not quarantine") };

        let fresh = interpret_loaded_layout(Ok(None), true, never);
        assert!(!fresh.read_only && fresh.warning.is_none());
        assert_eq!(fresh.layout, SiteLayout::default());

        let newer = br#"{"version":2,"folders":["A"],"favorites":"changed shape"}"#.to_vec();
        let loaded = interpret_loaded_layout(Ok(Some(newer)), true, never);
        assert!(loaded.read_only);
        assert!(loaded
            .warning
            .unwrap()
            .starts_with("[site_tree.layout_read_only]"));
        assert!(loaded.layout.folders.contains("A"));
        assert!(layout_bytes(&loaded.layout).is_err(), "never written back");

        let locked = interpret_loaded_layout(
            Err(VaultError::KeychainUnavailable("locked".into())),
            true,
            never,
        );
        assert!(locked.read_only);
        assert!(locked
            .warning
            .unwrap()
            .starts_with("[site_tree.layout_unavailable]"));
        let no_key =
            interpret_loaded_layout(Err(VaultError::DeviceKeyMissing("x".into())), true, never);
        assert!(no_key.read_only);

        let mut moved = false;
        let corrupt = interpret_loaded_layout(Ok(Some(b"[1,2]".to_vec())), true, || {
            moved = true;
            Ok(Some(PathBuf::from("site-layout.vault.corrupt-1")))
        });
        assert!(moved && !corrupt.read_only);
        assert!(corrupt
            .warning
            .unwrap()
            .starts_with("[site_tree.layout_reset]"));

        let mut moved = false;
        let orphan =
            interpret_loaded_layout(Err(VaultError::DeviceKeyMissing("x".into())), false, || {
                moved = true;
                Ok(None)
            });
        assert!(moved && !orphan.read_only);

        let stuck = interpret_loaded_layout(Err(VaultError::DecryptionFailed), true, || {
            Err(VaultError::Other("busy".into()))
        });
        assert!(
            stuck.read_only,
            "a file that could not be moved aside is never overwritten"
        );
    }

    #[test]
    fn ops_parse_from_the_ui_wire_format() {
        let json = r#"[
            {"op":"move_sites","ids":["a"],"to":null},
            {"op":"move_sites","ids":["a"],"to":"X/Y"},
            {"op":"copy_sites","items":[{"id":"a","name":"a copy","group":"X"}]},
            {"op":"delete_sites","ids":["a"]},
            {"op":"rename_site","id":"a","name":"b"},
            {"op":"create_folder","path":"X"},
            {"op":"rename_folder","path":"X","name":"Y"},
            {"op":"move_folder","path":"X","to":null,"merge":true},
            {"op":"copy_folder","path":"X","to":"Z","name":"X copy"},
            {"op":"delete_folder","path":"X","keep_contents":true},
            {"op":"set_favorites","items":[{"kind":"site","id":"a"},{"kind":"folder","path":"X"}]},
            {"op":"set_label","sites":["a"],"label":null},
            {"op":"set_label_defs","labels":[{"id":"label-1","name":"Prod","color":"red"}]}
        ]"#;
        let ops: Vec<SiteTreeOp> = serde_json::from_str(json).unwrap();
        assert_eq!(ops.len(), 13);
        assert_eq!(
            ops[6],
            SiteTreeOp::RenameFolder {
                path: "X".into(),
                name: "Y".into(),
                merge: false
            }
        );
        assert_eq!(
            ops[11],
            SiteTreeOp::SetLabel {
                sites: vec!["a".into()],
                folders: vec![],
                label: None
            }
        );
        assert!(ops[5].changes_layout_only() && !ops[9].changes_layout_only());
    }

    #[test]
    fn create_folder_refuses_clashes_ignoring_case() {
        let mut sites = library();
        let mut layout = SiteLayout::default();
        for path in ["Staging", "staging", "clients/New", "Clients/ACME"] {
            let err = run(
                &mut sites,
                &mut layout,
                vec![SiteTreeOp::CreateFolder { path: path.into() }],
            )
            .unwrap_err();
            assert_eq!(err.code, ERR_FOLDER_EXISTS, "{path}");
        }
        run(
            &mut sites,
            &mut layout,
            vec![SiteTreeOp::CreateFolder {
                path: "Clients/New".into(),
            }],
        )
        .unwrap();
        assert!(layout.folders.contains("Clients/New"));
    }

    #[test]
    fn labels_and_recents() {
        let mut sites = library();
        let mut layout = SiteLayout::default();
        let err = run(
            &mut sites,
            &mut layout,
            vec![SiteTreeOp::SetLabel {
                sites: vec!["solo".into()],
                folders: vec![],
                label: Some("label-x".into()),
            }],
        )
        .unwrap_err();
        assert_eq!(err.code, ERR_NOT_FOUND);
        // Defining and using a label in one batch works.
        run(
            &mut sites,
            &mut layout,
            vec![
                SiteTreeOp::SetLabelDefs {
                    labels: vec![label("label-x")],
                },
                SiteTreeOp::SetLabel {
                    sites: vec!["solo".into()],
                    folders: vec!["Staging".into()],
                    label: Some("label-x".into()),
                },
            ],
        )
        .unwrap();
        assert_eq!(
            layout.site_labels.get("solo").map(String::as_str),
            Some("label-x")
        );
        // Removing the definition removes its assignments.
        run(
            &mut sites,
            &mut layout,
            vec![SiteTreeOp::SetLabelDefs { labels: vec![] }],
        )
        .unwrap();
        assert!(layout.site_labels.is_empty() && layout.folder_labels.is_empty());
        let thirteen: Vec<LabelDef> = (0..13).map(|i| label(&format!("label-{i}"))).collect();
        assert_eq!(
            run(
                &mut sites,
                &mut layout,
                vec![SiteTreeOp::SetLabelDefs { labels: thirteen }]
            )
            .unwrap_err()
            .code,
            ERR_TOO_MANY
        );

        record_recent(&mut layout, "solo", 10);
        record_recent(&mut layout, "stg", 20);
        record_recent(&mut layout, "solo", 30);
        assert_eq!(
            layout.recents,
            [
                RecentEntry {
                    id: "solo".into(),
                    at: Some(30),
                    count: 2
                },
                RecentEntry {
                    id: "stg".into(),
                    at: Some(20),
                    count: 1
                },
            ]
        );
        let saved = |id: &str| sites.iter().any(|s| s.id == id);
        assert!(!seed_recents(&mut layout, &["web-01".into()], &saved));
        layout.recents.clear();
        assert!(seed_recents(
            &mut layout,
            &[
                "web-01".into(),
                "local".into(),
                "gone".into(),
                "web-01".into(),
                "stg".into()
            ],
            &saved
        ));
        let seeded: Vec<&str> = layout.recents.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(seeded, ["web-01", "stg"]);
        assert_eq!(layout.recents[0].at, None);
    }

    fn site_pw(id: &str, name: &str, group: Option<&str>, pw: &str) -> ConnectionConfig {
        ConnectionConfig {
            auth: AuthMethod::Password(pw.into()),
            ..site(id, name, group)
        }
    }

    #[test]
    fn folder_path_ops_are_told_apart() {
        let ops: Vec<SiteTreeOp> = serde_json::from_str(
            r#"[
            {"op":"rename_folder","path":"A","name":"B"},
            {"op":"move_folder","path":"A","to":"B"},
            {"op":"delete_folder","path":"A","keep_contents":true},
            {"op":"copy_folder","path":"A","name":"B"},
            {"op":"move_sites","ids":["a"]},
            {"op":"copy_sites","items":[]},
            {"op":"delete_sites","ids":[]},
            {"op":"rename_site","id":"a","name":"b"},
            {"op":"create_folder","path":"A"},
            {"op":"set_favorites","items":[]},
            {"op":"set_label","sites":[]},
            {"op":"set_label_defs","labels":[]}
        ]"#,
        )
        .unwrap();
        let rewrites: Vec<bool> = ops.iter().map(SiteTreeOp::rewrites_folder_paths).collect();
        assert_eq!(
            rewrites,
            [true, true, true, true, false, false, false, false, false, false, false, false]
        );
        assert!(ops[..4].iter().all(|op| !op.changes_layout_only()));
    }

    /// A rename, then a save of the moved site elsewhere: the undo skips the site, so
    /// the folder stays renamed with its label, favorite and collapsed state.
    #[test]
    fn a_partial_undo_leaves_a_renamed_folder_with_its_label_and_favorite() {
        let mut sites = vec![ConnectionConfig::local(), site("x", "web", Some("Clients"))];
        let mut layout = SiteLayout {
            labels: vec![label("label-a")],
            folder_labels: BTreeMap::from([("Clients".into(), "label-a".into())]),
            favorites: vec![FavoriteRef::Folder {
                path: "Clients".into(),
            }],
            collapsed: BTreeSet::from(["Clients".to_string()]),
            ..SiteLayout::default()
        };
        let outcome = run(
            &mut sites,
            &mut layout,
            vec![SiteTreeOp::RenameFolder {
                path: "Clients".into(),
                name: "Customers".into(),
                merge: false,
            }],
        )
        .unwrap();
        sites[1].auth = AuthMethod::Password("changed elsewhere".into()); // save_site
        let report = undo(&outcome.undo, &mut sites, &mut layout);
        assert_eq!(
            report,
            UndoReport {
                restored: 0,
                skipped: 1
            }
        );
        assert_eq!(group_of(&sites, "x"), Some("Customers"));
        assert_eq!(folders(&layout), ["Customers"], "no empty Clients folder");
        assert_eq!(
            layout.folder_labels,
            BTreeMap::from([("Customers".to_string(), "label-a".to_string())])
        );
        assert_eq!(
            layout.favorites,
            [FavoriteRef::Folder {
                path: "Customers".into()
            }]
        );
        assert_eq!(layout.collapsed, BTreeSet::from(["Customers".to_string()]));
    }

    /// Two renames in one batch: the one whose site came back is undone, the one whose
    /// site was changed since stays.
    #[test]
    fn a_partial_undo_decides_per_folder_move() {
        let mut sites = vec![
            ConnectionConfig::local(),
            site("a", "a", Some("A/Sub")),
            site("b", "b", Some("B")),
        ];
        let mut layout = SiteLayout {
            labels: vec![label("label-a")],
            folder_labels: BTreeMap::from([
                ("A/Sub".into(), "label-a".into()),
                ("B".into(), "label-a".into()),
            ]),
            ..SiteLayout::default()
        };
        let outcome = run(
            &mut sites,
            &mut layout,
            vec![
                SiteTreeOp::RenameFolder {
                    path: "A".into(),
                    name: "A2".into(),
                    merge: false,
                },
                SiteTreeOp::RenameFolder {
                    path: "B".into(),
                    name: "B2".into(),
                    merge: false,
                },
            ],
        )
        .unwrap();
        assert_eq!(outcome.undo.folder_remaps.len(), 2);
        let b = sites.iter_mut().find(|s| s.id == "b").unwrap();
        b.host = "moved.example.com".into();
        let report = undo(&outcome.undo, &mut sites, &mut layout);
        assert_eq!(
            report,
            UndoReport {
                restored: 1,
                skipped: 1
            }
        );
        assert_eq!(group_of(&sites, "a"), Some("A/Sub"));
        assert_eq!(group_of(&sites, "b"), Some("B2"));
        assert_eq!(folders(&layout), ["A", "A/Sub", "B2"]);
        assert_eq!(
            layout.folder_labels,
            BTreeMap::from([
                ("A/Sub".to_string(), "label-a".to_string()),
                ("B2".to_string(), "label-a".to_string()),
            ])
        );
    }

    /// Deleting a folder but keeping its contents lifts its subfolders; when a lifted
    /// site was changed since, its subfolder stays lifted with its label.
    #[test]
    fn a_partial_undo_of_a_lift_keeps_the_lifted_folder() {
        let mut sites = vec![
            ConnectionConfig::local(),
            site("x", "x", Some("Clients/Acme")),
        ];
        let mut layout = SiteLayout {
            labels: vec![label("label-a")],
            folder_labels: BTreeMap::from([("Clients/Acme".into(), "label-a".into())]),
            ..SiteLayout::default()
        };
        let outcome = run(
            &mut sites,
            &mut layout,
            vec![SiteTreeOp::DeleteFolder {
                path: "Clients".into(),
                keep_contents: true,
            }],
        )
        .unwrap();
        assert_eq!(group_of(&sites, "x"), Some("Acme"));
        sites[1].port = 2222;
        let report = undo(&outcome.undo, &mut sites, &mut layout);
        assert_eq!(report.skipped, 1);
        assert_eq!(group_of(&sites, "x"), Some("Acme"));
        assert!(
            !layout.folders.contains("Clients/Acme"),
            "{:?}",
            layout.folders
        );
        assert_eq!(
            layout.folder_labels.get("Acme").map(String::as_str),
            Some("label-a")
        );
    }

    /// Copying a folder into itself and merging it back doubles it every two ops; the
    /// batch is refused once it would create more than MAX_IDS_PER_CALL sites.
    #[test]
    fn a_batch_that_keeps_doubling_a_folder_is_refused() {
        let mut sites = vec![ConnectionConfig::local(), site("s", "s", Some("T"))];
        let mut layout = SiteLayout::default();
        let mut ops = Vec::new();
        for _ in 0..17 {
            ops.push(SiteTreeOp::CopyFolder {
                path: "T".into(),
                to: None,
                name: "c".into(),
            });
            ops.push(SiteTreeOp::RenameFolder {
                path: "c".into(),
                name: "T".into(),
                merge: true,
            });
        }
        assert!(check_op_limits(&ops).is_ok(), "34 ops carry 34 items");
        let err = run(&mut sites, &mut layout, ops).unwrap_err();
        assert_eq!(err.code, ERR_TOO_MANY);
        assert_eq!(
            err.to_string(),
            "[site_tree.too_many] Too many items at once"
        );
        assert_eq!(sites.len(), 2, "all or nothing");
        assert!(layout.folders.is_empty());

        // Up to the limit, copies are fine.
        let mut ops = Vec::new();
        for _ in 0..10 {
            ops.push(SiteTreeOp::CopyFolder {
                path: "T".into(),
                to: None,
                name: "c".into(),
            });
            ops.push(SiteTreeOp::RenameFolder {
                path: "c".into(),
                name: "T".into(),
                merge: true,
            });
        }
        let outcome = run(&mut sites, &mut layout, ops).unwrap();
        assert_eq!(outcome.created.len(), 1023);
        assert_eq!(sites.len(), 1025);
    }

    #[test]
    fn large_selections_fit_in_one_batch() {
        // Move 6,000 selected sites.
        let mut sites = vec![ConnectionConfig::local()];
        sites.extend((0..6_000).map(|i| site(&format!("s{i}"), "s", Some("Old"))));
        let mut layout = SiteLayout::default();
        let ids: Vec<String> = (0..6_000).map(|i| format!("s{i}")).collect();
        let outcome = run(
            &mut sites,
            &mut layout,
            vec![SiteTreeOp::MoveSites {
                ids,
                to: Some("New".into()),
            }],
        )
        .unwrap();
        assert_eq!(outcome.undo.sites_before.len(), 6_000);
        assert!(sites[1..].iter().all(|s| s.group.as_deref() == Some("New")));

        // Move 150 selected folders into a new one (151 ops).
        let mut sites = vec![ConnectionConfig::local()];
        sites.extend((0..150).map(|i| site(&format!("s{i}"), "s", Some(&format!("F{i:03}")))));
        let mut layout = SiteLayout::default();
        let mut ops = vec![SiteTreeOp::CreateFolder {
            path: "Archive".into(),
        }];
        ops.extend((0..150).map(|i| SiteTreeOp::MoveFolder {
            path: format!("F{i:03}"),
            to: Some("Archive".into()),
            merge: false,
        }));
        run(&mut sites, &mut layout, ops).unwrap();
        assert_eq!(group_of(&sites, "s149"), Some("Archive/F149"));
        assert_eq!(layout.folders.len(), 151);

        // The caps themselves.
        let too_many_ops: Vec<SiteTreeOp> = (0..=MAX_OPS_PER_CALL)
            .map(|i| SiteTreeOp::CreateFolder {
                path: format!("F{i}"),
            })
            .collect();
        assert_eq!(too_many_ops.len(), 2_001);
        let err = check_op_limits(&too_many_ops).unwrap_err();
        assert_eq!(
            err.to_string(),
            "[site_tree.too_many] Too many changes at once"
        );
        let mut sites = vec![ConnectionConfig::local()];
        assert!(run(&mut sites, &mut SiteLayout::default(), too_many_ops).is_err());
        let too_many_ids = vec![SiteTreeOp::DeleteSites {
            ids: vec!["x".into(); MAX_IDS_PER_CALL + 1],
        }];
        assert_eq!(
            check_op_limits(&too_many_ids).unwrap_err().to_string(),
            "[site_tree.too_many] Too many items at once"
        );
    }

    #[test]
    fn collapse_all_keeps_every_folder() {
        assert_eq!(MAX_COLLAPSED, MAX_LAYOUT_FOLDERS);
        let paths: Vec<String> = (0..2_525).map(|i| format!("F{i:04}")).collect();
        let mut layout = SiteLayout {
            folders: paths.iter().cloned().collect(),
            collapsed: paths.iter().cloned().collect(),
            ..SiteLayout::default()
        };
        reconcile(&mut layout, &[ConnectionConfig::local()]);
        assert_eq!(layout.collapsed.len(), 2_525);
    }

    #[test]
    fn only_a_damaged_layout_file_is_moved_aside() {
        let never = || -> Result<Option<PathBuf>, VaultError> { panic!("must not quarantine") };
        for kind in [
            std::io::ErrorKind::PermissionDenied,
            std::io::ErrorKind::Other,
            std::io::ErrorKind::IsADirectory,
        ] {
            let loaded = interpret_loaded_layout(
                Err(VaultError::IoError(std::io::Error::from(kind))),
                true,
                never,
            );
            assert!(loaded.read_only, "{kind:?}");
            assert!(
                loaded
                    .warning
                    .as_deref()
                    .is_some_and(|w| w.starts_with("[site_tree.layout_unavailable]")),
                "{kind:?}: {:?}",
                loaded.warning
            );
        }
        let damaged = [
            VaultError::DecryptionFailed,
            VaultError::InvalidHeader,
            serde_json::from_str::<Value>("{").unwrap_err().into(),
        ];
        for error in damaged {
            let mut moved = false;
            let loaded = interpret_loaded_layout(Err(error), true, || {
                moved = true;
                Ok(None)
            });
            assert!(moved && !loaded.read_only);
        }
    }

    /// While the saved sites could not be loaded, a layout file that does not open is
    /// kept (read-only) whatever the reason, so restoring the vault brings it back.
    #[test]
    fn a_layout_is_never_moved_aside_while_the_saved_sites_are_unreadable() {
        let never = || -> Result<Option<PathBuf>, VaultError> { panic!("must not quarantine") };
        for error in [
            VaultError::DeviceKeyMissing("x".into()),
            VaultError::DecryptionFailed,
        ] {
            let loaded = interpret_loaded_layout_keeping(Err(error), false, true, never);
            assert!(loaded.read_only);
            assert!(loaded
                .warning
                .unwrap()
                .starts_with("[site_tree.layout_unavailable]"));
        }
        let loaded = interpret_loaded_layout_keeping(Ok(Some(b"[1]".to_vec())), false, true, never);
        assert!(loaded.read_only);

        let mut moved = false;
        let reset =
            interpret_loaded_layout_keeping(Err(VaultError::DecryptionFailed), true, false, || {
                moved = true;
                Ok(None)
            });
        assert!(
            moved && !reset.read_only,
            "without keep_file a damaged file goes"
        );
    }

    /// A layout file that cannot be read right now (EACCES here) stays as it is and the
    /// layout is read-only for the run.
    #[cfg(unix)]
    #[test]
    fn an_unreadable_layout_file_is_kept_and_read_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let mut layout = SiteLayout::default();
        layout.folders.insert("Clients".into());
        layout.labels.push(label("label-a"));
        vault::save_sealed_in(
            dir.path(),
            SITE_LAYOUT_FILE,
            &layout_bytes(&layout).unwrap(),
        )
        .unwrap();
        let path = dir.path().join(SITE_LAYOUT_FILE);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::read(&path).is_ok() {
            // Running as root: permissions do not apply.
            return;
        }

        let loaded_raw = vault::load_sealed_in(dir.path(), SITE_LAYOUT_FILE);
        let mut quarantined = false;
        let loaded = interpret_loaded_layout(loaded_raw, true, || {
            quarantined = true;
            Ok(Some(PathBuf::from("site-layout.vault.corrupt-1")))
        });
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(loaded.read_only && !quarantined, "{:?}", loaded.warning);
        assert!(loaded
            .warning
            .unwrap()
            .starts_with("[site_tree.layout_unavailable]"));
        let again = vault::load_sealed_in(dir.path(), SITE_LAYOUT_FILE)
            .unwrap()
            .unwrap();
        assert_eq!(parse_site_layout(&again).unwrap().0, layout);
    }

    #[test]
    fn repeated_site_ids_are_made_unique() {
        let mut sites = vec![
            ConnectionConfig::local(),
            site_pw("dup", "prod-db", None, "pw-prod"),
            site_pw("dup", "staging-db", None, "pw-staging"),
            site_pw("new-1", "taken", None, "pw"),
            site_pw("dup", "qa-db", None, "pw-qa"),
            ConnectionConfig::local(),
        ];
        assert!(dedupe_site_ids(&mut sites, &mut ids()));
        let got: Vec<(&str, &str)> = sites
            .iter()
            .map(|s| (s.id.as_str(), s.name.as_str()))
            .collect();
        assert_eq!(
            got,
            [
                ("local", "Local Machine"),
                ("dup", "prod-db"),
                ("new-2", "staging-db"),
                ("new-1", "taken"),
                ("new-3", "qa-db"),
                ("new-4", "Local Machine"),
            ]
        );
        assert!(
            !dedupe_site_ids(&mut sites, &mut ids()),
            "nothing left to change"
        );

        // A generator that keeps repeating itself still ends with unique ids.
        let mut sites = vec![
            site("a", "a", None),
            site("a", "b", None),
            site("a", "c", None),
        ];
        assert!(dedupe_site_ids(&mut sites, &mut || "a".to_string()));
        let unique: HashSet<&str> = sites.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(unique.len(), 3);
    }

    /// Two rows that shared an id (legacy data) get their own ids at startup, so a
    /// delete and its undo bring both back with their passwords.
    #[test]
    fn a_delete_and_undo_of_deduplicated_sites_brings_both_back() {
        let mut sites = vec![
            ConnectionConfig::local(),
            site_pw("dup", "prod-db", None, "pw-prod"),
            site_pw("dup", "staging-db", None, "pw-staging"),
        ];
        dedupe_site_ids(&mut sites, &mut ids());
        let ids_now: Vec<String> = sites[1..].iter().map(|s| s.id.clone()).collect();
        let mut layout = SiteLayout::default();
        let outcome = run(
            &mut sites,
            &mut layout,
            vec![SiteTreeOp::DeleteSites { ids: ids_now }],
        )
        .unwrap();
        assert_eq!(sites.len(), 1);
        let report = undo(&outcome.undo, &mut sites, &mut layout);
        assert_eq!(
            report,
            UndoReport {
                restored: 2,
                skipped: 0
            }
        );
        let names: Vec<&str> = sites.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["Local Machine", "prod-db", "staging-db"]);
        assert!(matches!(&sites[2].auth, AuthMethod::Password(p) if p == "pw-staging"));
    }

    /// Undo across a "replace" import (the UI also calls forget_site_tree_undo): an
    /// imported site with the same id is never overwritten; a deleted site that the
    /// import does not contain comes back.
    #[test]
    fn undo_after_a_replace_import_never_overwrites_imported_sites() {
        let mut sites = vec![
            ConnectionConfig::local(),
            site_pw("x", "web", None, "old-pw"),
            site_pw("y", "db", None, "y-pw"),
        ];
        let mut layout = SiteLayout::default();
        let outcome = run(
            &mut sites,
            &mut layout,
            vec![SiteTreeOp::DeleteSites {
                ids: vec!["x".into(), "y".into()],
            }],
        )
        .unwrap();
        // import_sites_vault "replace": Local + an x pointing elsewhere.
        let mut imported_x = site_pw("x", "web", None, "");
        imported_x.host = "other-host.example.com".into();
        sites = vec![ConnectionConfig::local(), imported_x];
        let report = undo(&outcome.undo, &mut sites, &mut layout);
        assert_eq!(
            report,
            UndoReport {
                restored: 1,
                skipped: 1
            }
        );
        let x = sites.iter().find(|s| s.id == "x").unwrap();
        assert_eq!(x.host, "other-host.example.com");
        assert!(matches!(&x.auth, AuthMethod::Password(p) if p.is_empty()));
        assert!(
            sites.iter().any(|s| s.id == "y"),
            "y (not in the import) is back"
        );
    }

    #[test]
    fn undo_never_reverts_a_password_changed_since() {
        let mut sites = vec![
            ConnectionConfig::local(),
            site_pw("x", "web", Some("A"), "old-pw"),
        ];
        let mut layout = SiteLayout::default();
        let outcome = run(
            &mut sites,
            &mut layout,
            vec![SiteTreeOp::MoveSites {
                ids: vec!["x".into()],
                to: Some("B".into()),
            }],
        )
        .unwrap();
        // save_site elsewhere: new password, same folder.
        sites[1].auth = AuthMethod::Password("new-pw".into());
        let report = undo(&outcome.undo, &mut sites, &mut layout);
        assert_eq!(
            report,
            UndoReport {
                restored: 0,
                skipped: 1
            }
        );
        assert!(matches!(&sites[1].auth, AuthMethod::Password(p) if p == "new-pw"));
        assert_eq!(sites[1].group.as_deref(), Some("B"));
    }

    #[test]
    fn paths_keep_dots_and_refuse_slashes_control_characters_and_overlong_names() {
        assert_eq!(
            normalize_folder_path(" A // .. / B ").unwrap().as_deref(),
            Some("A/../B")
        );
        assert!(validate_folder_name("a/b").is_err());
        assert!(validate_folder_name("a\u{7}b").is_err());
        assert!(normalize_folder_path("a\nb").is_err());
        assert!(validate_folder_name(&"é".repeat(255)).is_ok());
        assert!(validate_folder_name(&"é".repeat(256)).is_err());
        let mut layout = SiteLayout::default();
        let deep = format!("{}/{}", "a".repeat(200), "b".repeat(54));
        assert!(create_folder(&mut layout, &deep).is_ok());
        let mut sites = vec![ConnectionConfig::local()];
        let r = run(
            &mut sites,
            &mut layout,
            vec![SiteTreeOp::RenameFolder {
                path: "a".repeat(200),
                name: "a".repeat(201),
                merge: false,
            }],
        );
        assert_eq!(r.unwrap_err().code, ERR_PATH_TOO_LONG);
    }
}

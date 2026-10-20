use crate::types::{CoreError, CoreResult, FileEntry};
use crate::vfs::VirtualFileSystem;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncDirection {
    LocalToRemote,
    RemoteToLocal,
    Both,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncActionType {
    Upload,
    Download,
    DeleteRemote,
    DeleteLocal,
    Identical,
    /// Both copies changed (or it is unclear which one is newer, or whether a newer
    /// same-size copy really differs) in a way the chosen direction would overwrite.
    /// Never transferred automatically.
    Conflict,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncItem {
    pub relative_path: String,
    pub action: SyncActionType,
    pub local_size: Option<u64>,
    pub remote_size: Option<u64>,
    pub local_modified: Option<DateTime<Utc>>,
    pub remote_modified: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncOptions {
    pub direction: SyncDirection,
    pub mirror_delete: bool,
    pub compare_by_size_only: bool,
    /// Also compare subfolders. Relative paths then use '/' (e.g. `css/site.css`).
    /// Off by default: only the top-level files of both folders are compared.
    #[serde(default)]
    pub recursive: bool,
    /// Maximum folder depth when `recursive` is set (default [`DEFAULT_SYNC_MAX_DEPTH`]).
    #[serde(default)]
    pub max_depth: Option<u32>,
    /// True when transfers between the two backends keep the source modification
    /// time, so a same-size copy that is newer on one side really was edited there and
    /// `Both` transfers it without reading any file. When false (the default), `Both`
    /// compares the bytes of such pairs instead, because the newer mtime may only come
    /// from an earlier upload or download.
    ///
    /// Set by the caller from the backends' capabilities; never read from the UI.
    #[serde(default, skip_deserializing)]
    pub mtimes_preserved: bool,
}

impl Default for SyncOptions {
    fn default() -> Self {
        Self {
            direction: SyncDirection::LocalToRemote,
            mirror_delete: false,
            compare_by_size_only: false,
            recursive: false,
            max_depth: None,
            mtimes_preserved: false,
        }
    }
}

/// Depth limit for recursive comparisons when none is given.
pub const DEFAULT_SYNC_MAX_DEPTH: u32 = 32;
/// Modification times closer than this are considered equal (FAT/SMB/FTP granularity).
pub const MTIME_TOLERANCE_SECS: i64 = 2;
/// Largest file whose bytes `Both` compares to tell a same-size edit from a copy that
/// is only newer because it was transferred. Larger files keep the provisional action.
pub const CONTENT_CHECK_MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
/// Total bytes read from each side for content checks in one comparison.
pub const CONTENT_CHECK_BUDGET_BYTES: u64 = 256 * 1024 * 1024;
/// Bytes read from each side per step of a content check (stops at the first difference).
const CONTENT_CHECK_CHUNK_BYTES: u64 = 4 * 1024 * 1024;

/// Which copy is newer by modification time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Newer {
    Local,
    Remote,
    Same,
    Unknown,
}

fn newer_side(local: Option<DateTime<Utc>>, remote: Option<DateTime<Utc>>) -> Newer {
    match (local, remote) {
        (Some(l), Some(r)) => {
            let diff = l.signed_duration_since(r).num_seconds();
            if diff > MTIME_TOLERANCE_SECS {
                Newer::Local
            } else if diff < -MTIME_TOLERANCE_SECS {
                Newer::Remote
            } else {
                Newer::Same
            }
        }
        _ => Newer::Unknown,
    }
}

/// Action for a file present on both sides, decided from sizes and mtimes alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Decision {
    Action(SyncActionType),
    /// `Both` mode, same size, one side newer, and transfers do not keep mtimes: the
    /// newer mtime may come from an edit or only from an earlier transfer. The bytes
    /// decide: equal means `Identical`, different means `if_differs`. When they cannot
    /// be compared (too large, over budget, read error) `if_unverified` is used.
    CompareContent {
        if_differs: SyncActionType,
        if_unverified: SyncActionType,
    },
}

impl Decision {
    /// The action to report when no file content is read.
    fn provisional(self) -> SyncActionType {
        match self {
            Decision::Action(a) => a,
            Decision::CompareContent { if_unverified, .. } => if_unverified,
        }
    }
}

/// Decides the action for a file present on both sides. The chosen direction is always
/// respected: one-way modes only ever transfer towards the destination and report a
/// `Conflict` when the destination looks newer and different; `Both` transfers the
/// clearly newer copy and reports a `Conflict` when that cannot be told.
fn plan_both_present(l: &FileEntry, r: &FileEntry, options: &SyncOptions) -> Decision {
    use SyncActionType::*;
    let same_size = l.size == r.size;
    let newer = newer_side(l.modified_at, r.modified_at);

    if options.compare_by_size_only {
        if same_size {
            return Decision::Action(Identical);
        }
        return Decision::Action(match options.direction {
            SyncDirection::LocalToRemote => Upload,
            SyncDirection::RemoteToLocal => Download,
            SyncDirection::Both => match newer {
                Newer::Local => Upload,
                Newer::Remote => Download,
                Newer::Same | Newer::Unknown => Conflict,
            },
        });
    }

    let action = match options.direction {
        SyncDirection::LocalToRemote => match (same_size, newer) {
            (true, Newer::Local) => Upload,
            // A copy just uploaded is newer on the remote side: same size means in sync.
            (true, _) => Identical,
            (false, Newer::Remote) => Conflict,
            (false, _) => Upload,
        },
        SyncDirection::RemoteToLocal => match (same_size, newer) {
            (true, Newer::Remote) => Download,
            (true, _) => Identical,
            (false, Newer::Local) => Conflict,
            (false, _) => Download,
        },
        SyncDirection::Both => match (same_size, newer) {
            (true, Newer::Local) if options.mtimes_preserved => Upload,
            (true, Newer::Remote) if options.mtimes_preserved => Download,
            // Without preserved mtimes a fresh download is newer locally: compare the
            // bytes so it is not uploaded back. Unverified, upload as before (a local
            // edit is never lost that way).
            (true, Newer::Local) => {
                return Decision::CompareContent {
                    if_differs: Upload,
                    if_unverified: Upload,
                }
            }
            // A same-size remote copy that is newer is either the copy just uploaded or
            // a remote edit (e.g. a changed port number). Treating it as in sync hid the
            // edit until a later upload overwrote it; downloading it unread ping-pongs.
            // Compare the bytes, and report a conflict when they cannot be read.
            (true, Newer::Remote) => {
                return Decision::CompareContent {
                    if_differs: Download,
                    if_unverified: Conflict,
                }
            }
            (true, _) => Identical,
            (false, Newer::Local) => Upload,
            (false, Newer::Remote) => Download,
            (false, _) => Conflict,
        },
    };
    Decision::Action(action)
}

/// The action for a file present on both sides when no file content is read.
#[cfg(test)]
fn decide_both_present(l: &FileEntry, r: &FileEntry, options: &SyncOptions) -> SyncActionType {
    plan_both_present(l, r, options).provisional()
}

/// Limits for reading file contents during a comparison (see [`Decision::CompareContent`]).
#[derive(Debug, Clone, Copy)]
struct ContentCheckLimits {
    max_file_bytes: u64,
    budget_bytes: u64,
    chunk_bytes: u64,
}

impl Default for ContentCheckLimits {
    fn default() -> Self {
        Self {
            max_file_bytes: CONTENT_CHECK_MAX_FILE_BYTES,
            budget_bytes: CONTENT_CHECK_BUDGET_BYTES,
            chunk_bytes: CONTENT_CHECK_CHUNK_BYTES,
        }
    }
}

/// A planned item whose action depends on whether both copies hold the same bytes.
#[derive(Debug)]
struct PendingContentCheck {
    /// Index of the item in the plan (before sorting).
    index: usize,
    local_path: String,
    remote_path: String,
    size: u64,
    if_differs: SyncActionType,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ContentCheck {
    Equal,
    Differs,
    Unverified,
}

/// Compares two same-size files chunk by chunk, stopping at the first difference.
/// `budget` is the number of bytes per side still allowed to be read.
async fn compare_contents(
    local_vfs: &Arc<dyn VirtualFileSystem>,
    remote_vfs: &Arc<dyn VirtualFileSystem>,
    check: &PendingContentCheck,
    limits: &ContentCheckLimits,
    budget: &mut u64,
) -> ContentCheck {
    let size = check.size;
    if size == 0 {
        return ContentCheck::Equal;
    }
    if size > limits.max_file_bytes || size > *budget {
        return ContentCheck::Unverified;
    }
    let chunk = limits.chunk_bytes.max(1);
    let mut offset = 0u64;
    while offset < size {
        let want = chunk.min(size - offset);
        let (local, remote) = tokio::join!(
            local_vfs.read_range(&check.local_path, offset, want),
            remote_vfs.read_range(&check.remote_path, offset, want),
        );
        *budget = budget.saturating_sub(want);
        let (local, remote) = match (local, remote) {
            (Ok(l), Ok(r)) => (l, r),
            (Err(e), _) | (_, Err(e)) => {
                tracing::debug!(
                    "sync: could not compare '{}' with '{}': {e}",
                    check.local_path,
                    check.remote_path
                );
                return ContentCheck::Unverified;
            }
        };
        if local.len() as u64 != want || remote.len() as u64 != want {
            // A copy changed size after it was listed.
            return ContentCheck::Unverified;
        }
        if local != remote {
            return ContentCheck::Differs;
        }
        offset += want;
    }
    ContentCheck::Equal
}

fn join_dir(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        return name.to_string();
    }
    let sep = if dir.contains('\\') && !dir.contains('/') {
        '\\'
    } else {
        '/'
    };
    if dir.ends_with(sep) {
        format!("{dir}{name}")
    } else {
        format!("{dir}{sep}{name}")
    }
}

fn join_rel(prefix: &str, name: &str) -> String {
    if prefix.is_empty() {
        name.to_string()
    } else {
        format!("{prefix}/{name}")
    }
}

async fn list_side(
    vfs: &Arc<dyn VirtualFileSystem>,
    dir: &str,
    side: &str,
) -> CoreResult<Vec<FileEntry>> {
    vfs.list_dir(dir)
        .await
        .map_err(|e| CoreError::General(format!("Could not read {side} folder '{dir}': {e}")))
}

pub struct SyncEngine;

impl SyncEngine {
    /// Compares local and remote folders and produces a preview synchronization plan.
    ///
    /// Listing errors are returned (a folder that cannot be read is never treated as
    /// empty). Without `options.recursive` only top-level files are compared.
    ///
    /// In `Both` mode, unless `options.mtimes_preserved` is set, same-size files that
    /// are newer on one side are read from both sides (up to
    /// [`CONTENT_CHECK_MAX_FILE_BYTES`] per file and [`CONTENT_CHECK_BUDGET_BYTES`] in
    /// total) so a same-size edit is transferred and a copy that is only newer because
    /// it was transferred is reported as `Identical`.
    pub async fn compare_directories(
        local_vfs: Arc<dyn VirtualFileSystem>,
        remote_vfs: Arc<dyn VirtualFileSystem>,
        local_dir: &str,
        remote_dir: &str,
        options: &SyncOptions,
    ) -> CoreResult<Vec<SyncItem>> {
        Self::compare_directories_with_limits(
            local_vfs,
            remote_vfs,
            local_dir,
            remote_dir,
            options,
            ContentCheckLimits::default(),
        )
        .await
    }

    async fn compare_directories_with_limits(
        local_vfs: Arc<dyn VirtualFileSystem>,
        remote_vfs: Arc<dyn VirtualFileSystem>,
        local_dir: &str,
        remote_dir: &str,
        options: &SyncOptions,
        limits: ContentCheckLimits,
    ) -> CoreResult<Vec<SyncItem>> {
        let max_depth = if options.recursive {
            options.max_depth.unwrap_or(DEFAULT_SYNC_MAX_DEPTH)
        } else {
            0
        };

        let mut plan = Vec::new();
        let mut checks: Vec<PendingContentCheck> = Vec::new();
        // (relative prefix, local dir if it exists, remote dir if it exists, depth)
        let mut stack: Vec<(String, Option<String>, Option<String>, u32)> = vec![(
            String::new(),
            Some(local_dir.to_string()),
            Some(remote_dir.to_string()),
            0,
        )];

        while let Some((prefix, l_dir, r_dir, depth)) = stack.pop() {
            let local_files = match &l_dir {
                Some(d) => list_side(&local_vfs, d, "local").await?,
                None => Vec::new(),
            };
            let remote_files = match &r_dir {
                Some(d) => list_side(&remote_vfs, d, "remote").await?,
                None => Vec::new(),
            };

            let mut local_map: HashMap<String, FileEntry> = HashMap::new();
            let mut local_dirs: BTreeSet<String> = BTreeSet::new();
            for f in local_files {
                if f.is_dir() {
                    local_dirs.insert(f.name.clone());
                } else {
                    local_map.insert(f.name.clone(), f);
                }
            }

            let mut remote_map: HashMap<String, FileEntry> = HashMap::new();
            let mut remote_dirs: BTreeSet<String> = BTreeSet::new();
            for f in remote_files {
                if f.is_dir() {
                    remote_dirs.insert(f.name.clone());
                } else {
                    remote_map.insert(f.name.clone(), f);
                }
            }

            let dirs = (l_dir.as_deref(), r_dir.as_deref());
            Self::plan_files(
                &prefix,
                dirs,
                &local_map,
                &remote_map,
                options,
                &mut plan,
                &mut checks,
            );

            if depth < max_depth {
                let names: BTreeSet<&String> =
                    local_dirs.iter().chain(remote_dirs.iter()).collect();
                for name in names {
                    if name == "." || name == ".." {
                        continue;
                    }
                    let l_sub = if local_dirs.contains(name) {
                        l_dir.as_deref().map(|d| join_dir(d, name))
                    } else {
                        None
                    };
                    let r_sub = if remote_dirs.contains(name) {
                        r_dir.as_deref().map(|d| join_dir(d, name))
                    } else {
                        None
                    };
                    stack.push((join_rel(&prefix, name), l_sub, r_sub, depth + 1));
                }
            }
        }

        // Smallest files first, so a limited budget settles as many items as possible.
        checks.sort_by_key(|c| c.size);
        let mut budget = limits.budget_bytes;
        for check in &checks {
            match compare_contents(&local_vfs, &remote_vfs, check, &limits, &mut budget).await {
                ContentCheck::Equal => plan[check.index].action = SyncActionType::Identical,
                ContentCheck::Differs => plan[check.index].action = check.if_differs,
                ContentCheck::Unverified => {}
            }
        }

        // Sort by path
        plan.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
        Ok(plan)
    }

    /// `dirs` holds the local and remote folder being compared (when it exists).
    fn plan_files(
        prefix: &str,
        dirs: (Option<&str>, Option<&str>),
        local_map: &HashMap<String, FileEntry>,
        remote_map: &HashMap<String, FileEntry>,
        options: &SyncOptions,
        plan: &mut Vec<SyncItem>,
        checks: &mut Vec<PendingContentCheck>,
    ) {
        let all_names: BTreeSet<&String> = local_map.keys().chain(remote_map.keys()).collect();

        for name in all_names {
            let relative_path = join_rel(prefix, name);
            match (local_map.get(name), remote_map.get(name)) {
                (Some(l), None) => {
                    // Local only
                    let action = match options.direction {
                        SyncDirection::LocalToRemote | SyncDirection::Both => {
                            Some(SyncActionType::Upload)
                        }
                        SyncDirection::RemoteToLocal if options.mirror_delete => {
                            Some(SyncActionType::DeleteLocal)
                        }
                        SyncDirection::RemoteToLocal => None,
                    };
                    if let Some(action) = action {
                        plan.push(SyncItem {
                            relative_path,
                            action,
                            local_size: Some(l.size),
                            remote_size: None,
                            local_modified: l.modified_at,
                            remote_modified: None,
                        });
                    }
                }
                (None, Some(r)) => {
                    // Remote only
                    let action = match options.direction {
                        SyncDirection::RemoteToLocal | SyncDirection::Both => {
                            Some(SyncActionType::Download)
                        }
                        SyncDirection::LocalToRemote if options.mirror_delete => {
                            Some(SyncActionType::DeleteRemote)
                        }
                        SyncDirection::LocalToRemote => None,
                    };
                    if let Some(action) = action {
                        plan.push(SyncItem {
                            relative_path,
                            action,
                            local_size: None,
                            remote_size: Some(r.size),
                            local_modified: None,
                            remote_modified: r.modified_at,
                        });
                    }
                }
                (Some(l), Some(r)) => {
                    let decision = plan_both_present(l, r, options);
                    if let (
                        Decision::CompareContent { if_differs, .. },
                        (Some(l_dir), Some(r_dir)),
                    ) = (decision, dirs)
                    {
                        checks.push(PendingContentCheck {
                            index: plan.len(),
                            local_path: join_dir(l_dir, name),
                            remote_path: join_dir(r_dir, name),
                            size: l.size,
                            if_differs,
                        });
                    }
                    plan.push(SyncItem {
                        relative_path,
                        action: decision.provisional(),
                        local_size: Some(l.size),
                        remote_size: Some(r.size),
                        local_modified: l.modified_at,
                        remote_modified: r.modified_at,
                    });
                }
                (None, None) => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local::LocalFsDriver;
    use crate::types::FileType;
    use std::time::{Duration, SystemTime};

    fn entry(size: u64, mtime: Option<i64>) -> FileEntry {
        FileEntry {
            name: "f".into(),
            path: "/f".into(),
            file_type: FileType::File,
            size,
            modified_at: mtime.map(|s| DateTime::<Utc>::from_timestamp(s, 0).unwrap()),
            created_at: None,
            permissions: Default::default(),
            is_hidden: false,
        }
    }

    fn opts(direction: SyncDirection) -> SyncOptions {
        SyncOptions {
            direction,
            ..Default::default()
        }
    }

    #[test]
    fn test_one_way_modes_never_transfer_against_the_direction() {
        use SyncActionType::*;
        let cases = [
            // (local, remote)
            (entry(10, Some(1000)), entry(20, Some(5000))), // remote newer, differs
            (entry(10, None), entry(20, None)),             // mtimes unknown (FTP/S3)
            (entry(10, Some(5000)), entry(20, Some(1000))), // local newer
            (entry(10, Some(1000)), entry(10, Some(5000))), // same size, remote newer
            (entry(10, Some(5000)), entry(10, Some(1000))), // same size, local newer
            (entry(10, Some(1000)), entry(20, Some(1001))), // within tolerance
        ];
        for (l, r) in &cases {
            for size_only in [false, true] {
                let mut o = opts(SyncDirection::LocalToRemote);
                o.compare_by_size_only = size_only;
                let a = decide_both_present(l, r, &o);
                assert!(
                    matches!(a, Upload | Identical | Conflict),
                    "L2R produced {a:?}"
                );
                let mut o = opts(SyncDirection::RemoteToLocal);
                o.compare_by_size_only = size_only;
                let a = decide_both_present(l, r, &o);
                assert!(
                    matches!(a, Download | Identical | Conflict),
                    "R2L produced {a:?}"
                );
            }
        }

        let l2r = opts(SyncDirection::LocalToRemote);
        let r2l = opts(SyncDirection::RemoteToLocal);
        // The regression from the audit: unknown mtimes + size change used to Download.
        assert_eq!(decide_both_present(&cases[1].0, &cases[1].1, &l2r), Upload);
        assert_eq!(
            decide_both_present(&cases[1].0, &cases[1].1, &r2l),
            Download
        );
        // Destination newer and different: flagged, not overwritten.
        assert_eq!(
            decide_both_present(&cases[0].0, &cases[0].1, &l2r),
            Conflict
        );
        assert_eq!(
            decide_both_present(&cases[2].0, &cases[2].1, &r2l),
            Conflict
        );
        // Same size, remote newer: downloaded in Remote -> Local mode (SYNC-05).
        assert_eq!(
            decide_both_present(&cases[3].0, &cases[3].1, &r2l),
            Download
        );
        assert_eq!(
            decide_both_present(&cases[3].0, &cases[3].1, &l2r),
            Identical
        );
        assert_eq!(decide_both_present(&cases[4].0, &cases[4].1, &l2r), Upload);
    }

    #[test]
    fn test_both_direction_uses_newer_copy_or_reports_conflict() {
        use SyncActionType::*;
        let both = opts(SyncDirection::Both);
        assert_eq!(
            decide_both_present(&entry(10, Some(5000)), &entry(20, Some(1000)), &both),
            Upload
        );
        assert_eq!(
            decide_both_present(&entry(10, Some(1000)), &entry(20, Some(5000)), &both),
            Download
        );
        assert_eq!(
            decide_both_present(&entry(10, None), &entry(20, None), &both),
            Conflict
        );
        assert_eq!(
            decide_both_present(&entry(10, Some(1000)), &entry(20, Some(1001)), &both),
            Conflict
        );
        assert_eq!(
            decide_both_present(&entry(10, Some(1000)), &entry(10, Some(1001)), &both),
            Identical
        );
    }

    #[test]
    fn test_both_direction_same_size_newer_copy() {
        use SyncActionType::*;
        let remote_newer = (entry(10, Some(1000)), entry(10, Some(5000)));
        let local_newer = (entry(10, Some(5000)), entry(10, Some(1000)));

        // mtimes kept by transfers: a newer same-size copy was edited, transfer it.
        let mut both = opts(SyncDirection::Both);
        both.mtimes_preserved = true;
        assert_eq!(
            decide_both_present(&remote_newer.0, &remote_newer.1, &both),
            Download
        );
        assert_eq!(
            decide_both_present(&local_newer.0, &local_newer.1, &both),
            Upload
        );

        // Otherwise the bytes decide; unread, a newer remote copy is never "in sync".
        let both = opts(SyncDirection::Both);
        assert_eq!(
            plan_both_present(&remote_newer.0, &remote_newer.1, &both),
            Decision::CompareContent {
                if_differs: Download,
                if_unverified: Conflict
            }
        );
        assert_eq!(
            decide_both_present(&remote_newer.0, &remote_newer.1, &both),
            Conflict
        );
        assert_eq!(
            plan_both_present(&local_newer.0, &local_newer.1, &both),
            Decision::CompareContent {
                if_differs: Upload,
                if_unverified: Upload
            }
        );

        // One-way modes never read contents.
        for dir in [SyncDirection::LocalToRemote, SyncDirection::RemoteToLocal] {
            for (l, r) in [&remote_newer, &local_newer] {
                assert!(matches!(
                    plan_both_present(l, r, &opts(dir)),
                    Decision::Action(_)
                ));
            }
        }
    }

    /// Writes `contents` and sets the mtime `secs_ago` seconds in the past.
    fn put(path: &std::path::Path, contents: &[u8], secs_ago: u64) {
        std::fs::write(path, contents).unwrap();
        set_mtime(path, secs_ago);
    }

    #[tokio::test]
    async fn test_both_direction_reads_same_size_files_to_tell_edits_from_transfers() {
        let tmp = tempfile::tempdir().unwrap();
        let local = tmp.path().join("local");
        let remote = tmp.path().join("remote");
        std::fs::create_dir_all(local.join("sub")).unwrap();
        std::fs::create_dir_all(remote.join("sub")).unwrap();
        // The audit scenario: a same-length edit on the server (port 8080 -> 8081).
        put(&local.join("config.php"), b"port=8080", 3 * 3600);
        put(&remote.join("config.php"), b"port=8081", 3600);
        // Just uploaded: same bytes, remote newer only because of the transfer.
        put(&local.join("uploaded.css"), b"a{color:red}", 3600);
        put(&remote.join("uploaded.css"), b"a{color:red}", 60);
        // Just downloaded: same bytes, local newer only because of the transfer.
        put(&local.join("sub/downloaded.js"), b"let x = 1;", 60);
        put(&remote.join("sub/downloaded.js"), b"let x = 1;", 3600);
        // Same-length local edit.
        put(&local.join("notes.txt"), b"version B", 60);
        put(&remote.join("notes.txt"), b"version A", 3600);
        // Empty on both sides.
        put(&local.join("empty"), b"", 3600);
        put(&remote.join("empty"), b"", 60);

        let vfs: Arc<dyn VirtualFileSystem> = Arc::new(LocalFsDriver::new());
        let l = local.to_string_lossy().to_string();
        let r = remote.to_string_lossy().to_string();
        let mut both = opts(SyncDirection::Both);
        both.recursive = true;

        let plan = SyncEngine::compare_directories(vfs.clone(), vfs.clone(), &l, &r, &both)
            .await
            .unwrap();
        let by_path: HashMap<_, _> = plan
            .iter()
            .map(|p| (p.relative_path.as_str(), p.action))
            .collect();
        assert_eq!(by_path["config.php"], SyncActionType::Download);
        assert_eq!(by_path["uploaded.css"], SyncActionType::Identical);
        assert_eq!(by_path["sub/downloaded.js"], SyncActionType::Identical);
        assert_eq!(by_path["notes.txt"], SyncActionType::Upload);
        assert_eq!(by_path["empty"], SyncActionType::Identical);

        // Files that cannot be read in full keep the provisional action: the remote
        // edit becomes a visible conflict instead of a silent "unchanged".
        let tiny = ContentCheckLimits {
            max_file_bytes: 4,
            budget_bytes: 1024,
            chunk_bytes: 2,
        };
        let plan = SyncEngine::compare_directories_with_limits(
            vfs.clone(),
            vfs.clone(),
            &l,
            &r,
            &both,
            tiny,
        )
        .await
        .unwrap();
        let by_path: HashMap<_, _> = plan
            .iter()
            .map(|p| (p.relative_path.as_str(), p.action))
            .collect();
        assert_eq!(by_path["config.php"], SyncActionType::Conflict);
        assert_eq!(by_path["uploaded.css"], SyncActionType::Conflict);
        assert_eq!(by_path["sub/downloaded.js"], SyncActionType::Upload);
        assert_eq!(by_path["notes.txt"], SyncActionType::Upload);

        // Budget: small chunks still compare correctly, and once the budget is spent
        // the remaining files are left unverified (smallest files are checked first).
        let budget = ContentCheckLimits {
            max_file_bytes: 1024,
            budget_bytes: 20,
            chunk_bytes: 3,
        };
        let plan = SyncEngine::compare_directories_with_limits(
            vfs.clone(),
            vfs.clone(),
            &l,
            &r,
            &both,
            budget,
        )
        .await
        .unwrap();
        let by_path: HashMap<_, _> = plan
            .iter()
            .map(|p| (p.relative_path.as_str(), p.action))
            .collect();
        // 9 + 9 bytes fit (config.php and notes.txt), the 10- and 12-byte files do not.
        assert_eq!(by_path["config.php"], SyncActionType::Download);
        assert_eq!(by_path["notes.txt"], SyncActionType::Upload);
        assert_eq!(by_path["sub/downloaded.js"], SyncActionType::Upload);
        assert_eq!(by_path["uploaded.css"], SyncActionType::Conflict);

        // With preserved mtimes nothing is read: the newer copy is transferred.
        both.mtimes_preserved = true;
        let plan = SyncEngine::compare_directories_with_limits(
            vfs.clone(),
            vfs.clone(),
            &l,
            &r,
            &both,
            tiny,
        )
        .await
        .unwrap();
        let by_path: HashMap<_, _> = plan
            .iter()
            .map(|p| (p.relative_path.as_str(), p.action))
            .collect();
        assert_eq!(by_path["config.php"], SyncActionType::Download);
        assert_eq!(by_path["uploaded.css"], SyncActionType::Download);
        assert_eq!(by_path["sub/downloaded.js"], SyncActionType::Upload);
    }

    fn set_mtime(path: &std::path::Path, secs_ago: u64) {
        let f = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        f.set_modified(SystemTime::now() - Duration::from_secs(secs_ago))
            .unwrap();
    }

    #[tokio::test]
    async fn test_compare_directories_respects_direction_and_recurses_on_request() {
        let tmp = tempfile::tempdir().unwrap();
        let local = tmp.path().join("local");
        let remote = tmp.path().join("remote");
        std::fs::create_dir_all(local.join("css")).unwrap();
        std::fs::create_dir_all(remote.join("css")).unwrap();
        std::fs::create_dir_all(local.join("js")).unwrap();
        std::fs::write(local.join("index.html"), "local version").unwrap();
        std::fs::write(remote.join("index.html"), "remote, longer version").unwrap();
        set_mtime(&local.join("index.html"), 3600);
        set_mtime(&remote.join("index.html"), 60);
        std::fs::write(local.join("css/site.css"), "a{}").unwrap();
        std::fs::write(remote.join("css/site.css"), "a{color:red}").unwrap();
        set_mtime(&local.join("css/site.css"), 60);
        set_mtime(&remote.join("css/site.css"), 3600);
        std::fs::write(local.join("js/app.js"), "x").unwrap();

        let vfs: Arc<dyn VirtualFileSystem> = Arc::new(LocalFsDriver::new());
        let l = local.to_string_lossy().to_string();
        let r = remote.to_string_lossy().to_string();

        let plan = SyncEngine::compare_directories(
            vfs.clone(),
            vfs.clone(),
            &l,
            &r,
            &opts(SyncDirection::LocalToRemote),
        )
        .await
        .unwrap();
        assert_eq!(plan.len(), 1, "top level only by default: {plan:?}");
        assert_eq!(plan[0].relative_path, "index.html");
        assert_eq!(plan[0].action, SyncActionType::Conflict);
        assert!(plan.iter().all(|p| p.action != SyncActionType::Download));

        let mut rec = opts(SyncDirection::LocalToRemote);
        rec.recursive = true;
        let plan = SyncEngine::compare_directories(vfs.clone(), vfs.clone(), &l, &r, &rec)
            .await
            .unwrap();
        let by_path: HashMap<_, _> = plan
            .iter()
            .map(|p| (p.relative_path.as_str(), p.action))
            .collect();
        assert_eq!(by_path.get("css/site.css"), Some(&SyncActionType::Upload));
        assert_eq!(by_path.get("js/app.js"), Some(&SyncActionType::Upload));
        assert_eq!(by_path.get("index.html"), Some(&SyncActionType::Conflict));

        rec.max_depth = Some(0);
        let plan = SyncEngine::compare_directories(vfs.clone(), vfs.clone(), &l, &r, &rec)
            .await
            .unwrap();
        assert_eq!(plan.len(), 1);
    }

    #[tokio::test]
    async fn test_listing_errors_are_reported_not_treated_as_empty() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.txt"), "x").unwrap();
        let vfs: Arc<dyn VirtualFileSystem> = Arc::new(LocalFsDriver::new());
        let mut o = opts(SyncDirection::RemoteToLocal);
        o.mirror_delete = true;
        let missing = tmp.path().join("does-not-exist");
        let res = SyncEngine::compare_directories(
            vfs.clone(),
            vfs.clone(),
            &tmp.path().to_string_lossy(),
            &missing.to_string_lossy(),
            &o,
        )
        .await;
        let err = res.expect_err("an unreadable remote folder must be an error");
        assert!(err.to_string().contains("remote"), "{err}");
    }

    #[test]
    fn test_sync_options_deserialize_without_new_fields() {
        let o: SyncOptions = serde_json::from_str(
            r#"{"direction":"both","mirror_delete":false,"compare_by_size_only":true}"#,
        )
        .unwrap();
        assert!(!o.recursive);
        assert_eq!(o.max_depth, None);
        assert_eq!(o.direction, SyncDirection::Both);
        assert!(!o.mtimes_preserved);

        // Only the backend may claim that transfers keep mtimes.
        let o: SyncOptions = serde_json::from_str(
            r#"{"direction":"both","mirror_delete":false,"compare_by_size_only":false,"mtimes_preserved":true}"#,
        )
        .unwrap();
        assert!(!o.mtimes_preserved);
    }
}

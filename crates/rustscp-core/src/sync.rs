use crate::types::{CoreResult, FileEntry};
use crate::vfs::VirtualFileSystem;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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
}

impl Default for SyncOptions {
    fn default() -> Self {
        Self {
            direction: SyncDirection::LocalToRemote,
            mirror_delete: false,
            compare_by_size_only: false,
        }
    }
}

pub struct SyncEngine;

impl SyncEngine {
    /// Compares local and remote folders and produces a preview synchronization plan
    pub async fn compare_directories(
        local_vfs: Arc<dyn VirtualFileSystem>,
        remote_vfs: Arc<dyn VirtualFileSystem>,
        local_dir: &str,
        remote_dir: &str,
        options: &SyncOptions,
    ) -> CoreResult<Vec<SyncItem>> {
        let local_files = local_vfs.list_dir(local_dir).await.unwrap_or_default();
        let remote_files = remote_vfs.list_dir(remote_dir).await.unwrap_or_default();

        let mut local_map: HashMap<String, FileEntry> = HashMap::new();
        for f in local_files {
            if !f.is_dir() {
                local_map.insert(f.name.clone(), f);
            }
        }

        let mut remote_map: HashMap<String, FileEntry> = HashMap::new();
        for f in remote_files {
            if !f.is_dir() {
                remote_map.insert(f.name.clone(), f);
            }
        }

        let mut plan = Vec::new();
        let mut all_names: std::collections::HashSet<String> = local_map.keys().cloned().collect();
        for k in remote_map.keys() {
            all_names.insert(k.clone());
        }

        for name in all_names {
            let l_opt = local_map.get(&name);
            let r_opt = remote_map.get(&name);

            match (l_opt, r_opt) {
                (Some(l), None) => {
                    // Local only
                    match options.direction {
                        SyncDirection::LocalToRemote | SyncDirection::Both => {
                            plan.push(SyncItem {
                                relative_path: name,
                                action: SyncActionType::Upload,
                                local_size: Some(l.size),
                                remote_size: None,
                                local_modified: l.modified_at,
                                remote_modified: None,
                            });
                        }
                        SyncDirection::RemoteToLocal => {
                            if options.mirror_delete {
                                plan.push(SyncItem {
                                    relative_path: name,
                                    action: SyncActionType::DeleteLocal,
                                    local_size: Some(l.size),
                                    remote_size: None,
                                    local_modified: l.modified_at,
                                    remote_modified: None,
                                });
                            }
                        }
                    }
                }
                (None, Some(r)) => {
                    // Remote only
                    match options.direction {
                        SyncDirection::RemoteToLocal | SyncDirection::Both => {
                            plan.push(SyncItem {
                                relative_path: name,
                                action: SyncActionType::Download,
                                local_size: None,
                                remote_size: Some(r.size),
                                local_modified: None,
                                remote_modified: r.modified_at,
                            });
                        }
                        SyncDirection::LocalToRemote => {
                            if options.mirror_delete {
                                plan.push(SyncItem {
                                    relative_path: name,
                                    action: SyncActionType::DeleteRemote,
                                    local_size: None,
                                    remote_size: Some(r.size),
                                    local_modified: None,
                                    remote_modified: r.modified_at,
                                });
                            }
                        }
                    }
                }
                (Some(l), Some(r)) => {
                    // Both exist: check differences
                    let size_diff = l.size != r.size;
                    let time_diff = match (l.modified_at, r.modified_at) {
                        (Some(lm), Some(rm)) => lm > rm,
                        _ => false,
                    };

                    if !size_diff && (options.compare_by_size_only || !time_diff) {
                        plan.push(SyncItem {
                            relative_path: name,
                            action: SyncActionType::Identical,
                            local_size: Some(l.size),
                            remote_size: Some(r.size),
                            local_modified: l.modified_at,
                            remote_modified: r.modified_at,
                        });
                    } else if time_diff {
                        // Local is newer
                        plan.push(SyncItem {
                            relative_path: name,
                            action: SyncActionType::Upload,
                            local_size: Some(l.size),
                            remote_size: Some(r.size),
                            local_modified: l.modified_at,
                            remote_modified: r.modified_at,
                        });
                    } else {
                        // Remote is newer
                        plan.push(SyncItem {
                            relative_path: name,
                            action: SyncActionType::Download,
                            local_size: Some(l.size),
                            remote_size: Some(r.size),
                            local_modified: l.modified_at,
                            remote_modified: r.modified_at,
                        });
                    }
                }
                (None, None) => {}
            }
        }

        // Sort by path
        plan.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
        Ok(plan)
    }
}

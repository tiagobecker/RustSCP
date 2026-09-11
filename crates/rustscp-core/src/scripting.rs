use crate::vfs::VirtualFileSystem;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScriptCommandOutput {
    pub command: String,
    pub success: bool,
    pub output: String,
}

pub struct ScriptInterpreter;

impl ScriptInterpreter {
    pub async fn execute_line(
        line: &str,
        local_vfs: Arc<dyn VirtualFileSystem>,
        remote_vfs: Option<Arc<dyn VirtualFileSystem>>,
        current_local_dir: &mut String,
        current_remote_dir: &mut String,
    ) -> ScriptCommandOutput {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with(';') {
            return ScriptCommandOutput {
                command: line.to_string(),
                success: true,
                output: String::new(),
            };
        }

        let parts: Vec<&str> = trimmed.split_whitespace().collect();
        let cmd = parts[0].to_lowercase();
        let args = &parts[1..];

        match cmd.as_str() {
            "pwd" => {
                let out = format!("Remote: {}\nLocal: {}", current_remote_dir, current_local_dir);
                ScriptCommandOutput {
                    command: line.to_string(),
                    success: true,
                    output: out,
                }
            }

            "cd" => {
                if let Some(target) = args.first() {
                    let new_path = if target.starts_with('/') {
                        target.to_string()
                    } else {
                        format!("{}/{}", current_remote_dir.trim_end_matches('/'), target)
                    };
                    *current_remote_dir = new_path.clone();
                    ScriptCommandOutput {
                        command: line.to_string(),
                        success: true,
                        output: format!("Remote directory changed to: {}", new_path),
                    }
                } else {
                    ScriptCommandOutput {
                        command: line.to_string(),
                        success: false,
                        output: "Usage: cd <path>".into(),
                    }
                }
            }

            "lcd" => {
                if let Some(target) = args.first() {
                    let new_path = if target.starts_with('/') {
                        target.to_string()
                    } else {
                        format!("{}/{}", current_local_dir.trim_end_matches('/'), target)
                    };
                    *current_local_dir = new_path.clone();
                    ScriptCommandOutput {
                        command: line.to_string(),
                        success: true,
                        output: format!("Local directory changed to: {}", new_path),
                    }
                } else {
                    ScriptCommandOutput {
                        command: line.to_string(),
                        success: false,
                        output: "Usage: lcd <path>".into(),
                    }
                }
            }

            "ls" | "dir" => {
                let target = args.first().copied().unwrap_or(current_remote_dir);
                if let Some(rvfs) = &remote_vfs {
                    match rvfs.list_dir(target).await {
                        Ok(entries) => {
                            let mut out = String::new();
                            for e in entries {
                                out.push_str(&format!(
                                    "{:10} {:>10} {}\n",
                                    if e.is_dir() { "<DIR>" } else { "FILE" },
                                    e.size,
                                    e.name
                                ));
                            }
                            ScriptCommandOutput {
                                command: line.to_string(),
                                success: true,
                                output: out,
                            }
                        }
                        Err(e) => ScriptCommandOutput {
                            command: line.to_string(),
                            success: false,
                            output: format!("Error listing directory: {}", e),
                        },
                    }
                } else {
                    ScriptCommandOutput {
                        command: line.to_string(),
                        success: false,
                        output: "No active remote session".into(),
                    }
                }
            }

            "lls" => {
                let target = args.first().copied().unwrap_or(current_local_dir);
                match local_vfs.list_dir(target).await {
                    Ok(entries) => {
                        let mut out = String::new();
                        for e in entries {
                            out.push_str(&format!(
                                "{:10} {:>10} {}\n",
                                if e.is_dir() { "<DIR>" } else { "FILE" },
                                e.size,
                                e.name
                            ));
                        }
                        ScriptCommandOutput {
                            command: line.to_string(),
                            success: true,
                            output: out,
                        }
                    }
                    Err(e) => ScriptCommandOutput {
                        command: line.to_string(),
                        success: false,
                        output: format!("Error listing local directory: {}", e),
                    },
                }
            }

            "mkdir" => {
                if let Some(dir_name) = args.first() {
                    let target = format!("{}/{}", current_remote_dir.trim_end_matches('/'), dir_name);
                    if let Some(rvfs) = &remote_vfs {
                        match rvfs.create_dir(&target).await {
                            Ok(_) => ScriptCommandOutput {
                                command: line.to_string(),
                                success: true,
                                output: format!("Directory created: {}", target),
                            },
                            Err(e) => ScriptCommandOutput {
                                command: line.to_string(),
                                success: false,
                                output: format!("Failed to create directory: {}", e),
                            },
                        }
                    } else {
                        ScriptCommandOutput {
                            command: line.to_string(),
                            success: false,
                            output: "No active remote session".into(),
                        }
                    }
                } else {
                    ScriptCommandOutput {
                        command: line.to_string(),
                        success: false,
                        output: "Usage: mkdir <directory_name>".into(),
                    }
                }
            }

            "rm" | "del" => {
                if let Some(file_name) = args.first() {
                    let target = format!("{}/{}", current_remote_dir.trim_end_matches('/'), file_name);
                    if let Some(rvfs) = &remote_vfs {
                        match rvfs.remove_file(&target).await {
                            Ok(_) => ScriptCommandOutput {
                                command: line.to_string(),
                                success: true,
                                output: format!("Deleted remote file: {}", target),
                            },
                            Err(e) => ScriptCommandOutput {
                                command: line.to_string(),
                                success: false,
                                output: format!("Failed to delete: {}", e),
                            },
                        }
                    } else {
                        ScriptCommandOutput {
                            command: line.to_string(),
                            success: false,
                            output: "No active remote session".into(),
                        }
                    }
                } else {
                    ScriptCommandOutput {
                        command: line.to_string(),
                        success: false,
                        output: "Usage: rm <filename>".into(),
                    }
                }
            }

            "help" => {
                let help_text = "\
Available RustSCP Automation Script Commands:
  open <session_url>  - Connect to a remote server (e.g. sftp://user:pass@host:22)
  close               - Close the current session
  pwd                 - Print working remote and local directories
  cd <path>           - Change remote working directory
  lcd <path>          - Change local working directory
  ls [path]           - List remote files
  lls [path]          - List local files
  get <remote> [loc]  - Download file
  put <local> [rem]   - Upload file
  mkdir <dir>         - Create remote directory
  rm <file>           - Delete remote file
  exit                - Exit console
";
                ScriptCommandOutput {
                    command: line.to_string(),
                    success: true,
                    output: help_text.into(),
                }
            }

            unknown => ScriptCommandOutput {
                command: line.to_string(),
                success: false,
                output: format!("Unknown command '{}'. Type 'help' for command list.", unknown),
            },
        }
    }
}

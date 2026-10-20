use crate::vfs::VirtualFileSystem;
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScriptCommandOutput {
    pub command: String,
    pub success: bool,
    pub output: String,
    /// Remote working directory after the command (`cd` resolved, `..` normalized).
    #[serde(default)]
    pub remote_dir: Option<String>,
    /// Local working directory after the command (`lcd` resolved, `..` normalized).
    #[serde(default)]
    pub local_dir: Option<String>,
}

/// Largest file `get`/`put` copy in memory; bigger files belong in the transfer queue.
pub const MAX_SCRIPT_TRANSFER_BYTES: u64 = 512 * 1024 * 1024;

/// Splits a script line into words with shell-like quoting:
/// `'single quotes'` are literal, `"double quotes"` honour `\"` and `\\`, and outside
/// quotes a backslash escapes only a space, tab or quote (so Windows paths such as
/// `C:\Users\me` keep their backslashes).
pub fn tokenize_script_line(line: &str) -> Result<Vec<String>, String> {
    let mut tokens = Vec::new();
    let mut cur = String::new();
    let mut in_token = false;
    let mut chars = line.chars().peekable();

    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                in_token = true;
                loop {
                    match chars.next() {
                        Some('\'') => break,
                        Some(ch) => cur.push(ch),
                        None => return Err("Unterminated ' quote".to_string()),
                    }
                }
            }
            '"' => {
                in_token = true;
                loop {
                    match chars.next() {
                        Some('"') => break,
                        Some('\\') => match chars.peek() {
                            Some('"') | Some('\\') => cur.push(chars.next().unwrap_or('\\')),
                            _ => cur.push('\\'),
                        },
                        Some(ch) => cur.push(ch),
                        None => return Err("Unterminated \" quote".to_string()),
                    }
                }
            }
            '\\' => {
                in_token = true;
                match chars.peek() {
                    Some(&n) if matches!(n, ' ' | '\t' | '\'' | '"') => {
                        cur.push(n);
                        chars.next();
                    }
                    _ => cur.push('\\'),
                }
            }
            c if c.is_whitespace() => {
                if in_token {
                    tokens.push(std::mem::take(&mut cur));
                    in_token = false;
                }
            }
            c => {
                in_token = true;
                cur.push(c);
            }
        }
    }
    if in_token {
        tokens.push(cur);
    }
    Ok(tokens)
}

/// Normalizes a POSIX-style remote path: drops empty and `.` segments and resolves `..`
/// (never above `/`; kept literally when there is nothing to pop in a relative path or
/// after `~`).
pub fn normalize_remote_path(path: &str) -> String {
    let absolute = path.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for seg in path.split('/') {
        match seg {
            "" | "." => {}
            ".." => match parts.last() {
                Some(&last) if last != ".." && last != "~" => {
                    parts.pop();
                }
                _ => {
                    if !absolute {
                        parts.push("..");
                    }
                }
            },
            s => parts.push(s),
        }
    }
    let body = parts.join("/");
    if absolute {
        format!("/{body}")
    } else if body.is_empty() {
        ".".to_string()
    } else {
        body
    }
}

/// Resolves a remote path argument against the remote working directory. Absolute paths
/// (`/...`) and home paths (`~`, `~/...`) are kept, relative ones are joined to `cwd`;
/// the result is normalized.
pub fn resolve_remote_path(cwd: &str, arg: &str) -> String {
    let joined = if arg.starts_with('/') || arg == "~" || arg.starts_with("~/") || cwd.is_empty()
    {
        arg.to_string()
    } else {
        format!("{}/{}", cwd.trim_end_matches('/'), arg)
    };
    normalize_remote_path(&joined)
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Resolves a local path argument against the local working directory with the host's
/// path rules (drive letters and `\` on Windows), expanding a leading `~` and resolving
/// `.`/`..` lexically.
pub fn resolve_local_path(cwd: &str, arg: &str) -> String {
    let expanded: PathBuf = if arg == "~" {
        home_dir().unwrap_or_else(|| PathBuf::from(arg))
    } else if let Some(rest) = arg.strip_prefix("~/").or_else(|| arg.strip_prefix("~\\")) {
        match home_dir() {
            Some(h) => h.join(rest),
            None => PathBuf::from(arg),
        }
    } else {
        PathBuf::from(arg)
    };
    let joined = Path::new(cwd).join(expanded);

    let mut out = PathBuf::new();
    for comp in joined.components() {
        match comp {
            Component::Prefix(_) | Component::RootDir => out.push(comp.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => match out.components().next_back() {
                Some(Component::Normal(_)) => {
                    out.pop();
                }
                Some(Component::RootDir) | Some(Component::Prefix(_)) => {}
                _ => out.push(".."),
            },
            Component::Normal(s) => out.push(s),
        }
    }
    if out.as_os_str().is_empty() {
        ".".to_string()
    } else {
        out.to_string_lossy().into_owned()
    }
}

fn remote_basename(path: &str) -> Option<&str> {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|n| !n.is_empty() && *n != "." && *n != ".." && *n != "~")
}

fn local_basename(path: &str) -> Option<String> {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
}

fn join_remote(dir: &str, name: &str) -> String {
    format!("{}/{}", dir.trim_end_matches('/'), name)
}

const HELP_TEXT: &str = "\
Available RustSCP Automation Script Commands:
  pwd                   - Print working remote and local directories
  cd <path>             - Change remote working directory
  lcd <path>            - Change local working directory
  ls [path]  (dir)      - List remote files
  lls [path]            - List local files
  get <remote> [local]  - Download a file (up to 512 MB) to the local directory
  put <local> [remote]  - Upload a file (up to 512 MB) to the remote directory
  mkdir <dir>           - Create remote directory
  rm <file>  (del)      - Delete remote file
  help                  - Show this help

Quote paths that contain spaces: rm \"My Report.pdf\" or rm 'My Report.pdf'.
Relative paths are resolved against the working directories; '..' goes up one level.
Lines starting with # or ; are comments. Connect to servers from the Site Manager.
";

pub struct ScriptInterpreter;

impl ScriptInterpreter {
    pub async fn execute_line(
        line: &str,
        local_vfs: Arc<dyn VirtualFileSystem>,
        remote_vfs: Option<Arc<dyn VirtualFileSystem>>,
        current_local_dir: &mut String,
        current_remote_dir: &mut String,
    ) -> ScriptCommandOutput {
        let (success, output) = Self::run(
            line,
            local_vfs,
            remote_vfs,
            current_local_dir,
            current_remote_dir,
        )
        .await;
        ScriptCommandOutput {
            command: line.to_string(),
            success,
            output,
            remote_dir: Some(current_remote_dir.clone()),
            local_dir: Some(current_local_dir.clone()),
        }
    }

    async fn run(
        line: &str,
        local_vfs: Arc<dyn VirtualFileSystem>,
        remote_vfs: Option<Arc<dyn VirtualFileSystem>>,
        current_local_dir: &mut String,
        current_remote_dir: &mut String,
    ) -> (bool, String) {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with(';') {
            return (true, String::new());
        }

        let parts = match tokenize_script_line(trimmed) {
            Ok(p) if !p.is_empty() => p,
            Ok(_) => return (true, String::new()),
            Err(e) => return (false, format!("Parse error: {e}")),
        };
        let cmd = parts[0].to_lowercase();
        let args: Vec<&str> = parts[1..].iter().map(|s| s.as_str()).collect();

        let no_remote = || (false, "No active remote session".to_string());
        let usage = |text: &str| {
            (
                false,
                format!("Usage: {text}\nQuote paths that contain spaces, e.g. \"my file.txt\"."),
            )
        };
        let one_path = |args: &[&str]| -> Option<String> {
            match args {
                [p] if !p.is_empty() => Some((*p).to_string()),
                _ => None,
            }
        };

        match cmd.as_str() {
            "pwd" => (
                true,
                format!(
                    "Remote: {}\nLocal: {}",
                    current_remote_dir, current_local_dir
                ),
            ),

            "cd" => {
                let Some(target) = one_path(&args) else {
                    return usage("cd <path>");
                };
                let new_path = resolve_remote_path(current_remote_dir, &target);
                *current_remote_dir = new_path.clone();
                (true, format!("Remote directory changed to: {}", new_path))
            }

            "lcd" => {
                let Some(target) = one_path(&args) else {
                    return usage("lcd <path>");
                };
                let new_path = resolve_local_path(current_local_dir, &target);
                match local_vfs.metadata(&new_path).await {
                    Ok(meta) if meta.is_dir() => {
                        *current_local_dir = new_path.clone();
                        (true, format!("Local directory changed to: {}", new_path))
                    }
                    Ok(_) => (false, format!("Not a directory: {}", new_path)),
                    Err(e) => (false, format!("Cannot change to {}: {}", new_path, e)),
                }
            }

            "ls" | "dir" | "lls" => {
                let is_local = cmd == "lls";
                let target = match args.as_slice() {
                    [] => {
                        if is_local {
                            current_local_dir.clone()
                        } else {
                            current_remote_dir.clone()
                        }
                    }
                    [p] if is_local => resolve_local_path(current_local_dir, p),
                    [p] => resolve_remote_path(current_remote_dir, p),
                    _ => return usage(if is_local { "lls [path]" } else { "ls [path]" }),
                };
                let vfs = if is_local {
                    local_vfs.clone()
                } else {
                    match &remote_vfs {
                        Some(r) => r.clone(),
                        None => return no_remote(),
                    }
                };
                match vfs.list_dir(&target).await {
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
                        (true, out)
                    }
                    Err(e) => (
                        false,
                        if is_local {
                            format!("Error listing local directory: {}", e)
                        } else {
                            format!("Error listing directory: {}", e)
                        },
                    ),
                }
            }

            "mkdir" => {
                let Some(dir_name) = one_path(&args) else {
                    return usage("mkdir <directory_name>");
                };
                let Some(rvfs) = &remote_vfs else {
                    return no_remote();
                };
                let target = resolve_remote_path(current_remote_dir, &dir_name);
                match rvfs.create_dir(&target).await {
                    Ok(_) => (true, format!("Directory created: {}", target)),
                    Err(e) => (false, format!("Failed to create directory: {}", e)),
                }
            }

            "rm" | "del" => {
                let Some(file_name) = one_path(&args) else {
                    return usage("rm <filename>");
                };
                let Some(rvfs) = &remote_vfs else {
                    return no_remote();
                };
                let target = resolve_remote_path(current_remote_dir, &file_name);
                if target == "/" || target == "." || target == "~" {
                    return (false, format!("Refusing to delete '{}'", target));
                }
                match rvfs.remove_file(&target).await {
                    Ok(_) => (true, format!("Deleted remote file: {}", target)),
                    Err(e) => (false, format!("Failed to delete: {}", e)),
                }
            }

            "get" => {
                let (remote_arg, local_arg) = match args.as_slice() {
                    [r] if !r.is_empty() => (*r, None),
                    [r, l] if !r.is_empty() && !l.is_empty() => (*r, Some(*l)),
                    _ => return usage("get <remote_file> [local_path]"),
                };
                let Some(rvfs) = &remote_vfs else {
                    return no_remote();
                };
                let remote = resolve_remote_path(current_remote_dir, remote_arg);
                let Some(name) = remote_basename(&remote).map(str::to_string) else {
                    return (false, format!("Not a file name: {}", remote));
                };
                let mut local = match local_arg {
                    Some(l) => resolve_local_path(current_local_dir, l),
                    None => resolve_local_path(current_local_dir, &name),
                };
                if let Ok(meta) = local_vfs.metadata(&local).await {
                    if meta.is_dir() {
                        local = resolve_local_path(&local, &name);
                    }
                }
                match rvfs.metadata(&remote).await {
                    Ok(meta) if meta.is_dir() => {
                        return (false, format!("{} is a directory", remote))
                    }
                    Ok(meta) if meta.size > MAX_SCRIPT_TRANSFER_BYTES => {
                        return (
                            false,
                            format!(
                                "{} is {} bytes; use the transfer queue for files over {} bytes",
                                remote, meta.size, MAX_SCRIPT_TRANSFER_BYTES
                            ),
                        )
                    }
                    Ok(_) => {}
                    Err(e) => return (false, format!("Cannot read {}: {}", remote, e)),
                }
                let data = match rvfs.read_file(&remote).await {
                    Ok(d) => d,
                    Err(e) => return (false, format!("Download failed: {}", e)),
                };
                let len = data.len();
                match local_vfs.write_file(&local, data).await {
                    Ok(_) => (true, format!("Downloaded {} -> {} ({} bytes)", remote, local, len)),
                    Err(e) => (false, format!("Could not write {}: {}", local, e)),
                }
            }

            "put" => {
                let (local_arg, remote_arg) = match args.as_slice() {
                    [l] if !l.is_empty() => (*l, None),
                    [l, r] if !l.is_empty() && !r.is_empty() => (*l, Some(*r)),
                    _ => return usage("put <local_file> [remote_path]"),
                };
                let Some(rvfs) = &remote_vfs else {
                    return no_remote();
                };
                let local = resolve_local_path(current_local_dir, local_arg);
                let Some(name) = local_basename(&local) else {
                    return (false, format!("Not a file name: {}", local));
                };
                match local_vfs.metadata(&local).await {
                    Ok(meta) if meta.is_dir() => return (false, format!("{} is a directory", local)),
                    Ok(meta) if meta.size > MAX_SCRIPT_TRANSFER_BYTES => {
                        return (
                            false,
                            format!(
                                "{} is {} bytes; use the transfer queue for files over {} bytes",
                                local, meta.size, MAX_SCRIPT_TRANSFER_BYTES
                            ),
                        )
                    }
                    Ok(_) => {}
                    Err(e) => return (false, format!("Cannot read {}: {}", local, e)),
                }
                let mut remote = match remote_arg {
                    Some(r) => resolve_remote_path(current_remote_dir, r),
                    None => join_remote(current_remote_dir, &name),
                };
                if remote_arg.is_some() {
                    if let Ok(meta) = rvfs.metadata(&remote).await {
                        if meta.is_dir() {
                            remote = join_remote(&remote, &name);
                        }
                    }
                }
                let data = match local_vfs.read_file(&local).await {
                    Ok(d) => d,
                    Err(e) => return (false, format!("Could not read {}: {}", local, e)),
                };
                let len = data.len();
                match rvfs.write_file(&remote, data).await {
                    Ok(_) => (true, format!("Uploaded {} -> {} ({} bytes)", local, remote, len)),
                    Err(e) => (false, format!("Upload failed: {}", e)),
                }
            }

            "help" | "?" => (true, HELP_TEXT.to_string()),

            unknown => (
                false,
                format!(
                    "Unknown command '{}'. Type 'help' for command list.",
                    unknown
                ),
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local::LocalFsDriver;

    #[test]
    fn test_tokenizer_handles_quotes_and_escapes() {
        assert_eq!(
            tokenize_script_line(r#"rm "My Report.pdf""#).unwrap(),
            vec!["rm", "My Report.pdf"]
        );
        assert_eq!(
            tokenize_script_line("rm 'a \"b\" c'").unwrap(),
            vec!["rm", "a \"b\" c"]
        );
        assert_eq!(
            tokenize_script_line(r"rm my\ file.txt").unwrap(),
            vec!["rm", "my file.txt"]
        );
        assert_eq!(
            tokenize_script_line(r"lcd C:\Users\me").unwrap(),
            vec!["lcd", r"C:\Users\me"]
        );
        assert_eq!(tokenize_script_line("rm \"\"").unwrap(), vec!["rm", ""]);
        assert!(tokenize_script_line("rm \"open").is_err());
        assert!(tokenize_script_line("rm 'open").is_err());
    }

    #[test]
    fn test_remote_path_resolution() {
        assert_eq!(resolve_remote_path("/a/b", ".."), "/a");
        assert_eq!(resolve_remote_path("/a/b", "../../.."), "/");
        assert_eq!(resolve_remote_path("/a/b", "/var/www/old.txt"), "/var/www/old.txt");
        assert_eq!(resolve_remote_path("/a/b", "./c//d/"), "/a/b/c/d");
        assert_eq!(resolve_remote_path("/", "x"), "/x");
        assert_eq!(resolve_remote_path("~", "x/../y"), "~/y");
        assert_eq!(resolve_remote_path("/home/u", "~/x"), "~/x");
        assert_eq!(resolve_remote_path("bucket/dir", ".."), "bucket");
        assert_eq!(normalize_remote_path("a/../.."), "..");
    }

    #[cfg(unix)]
    #[test]
    fn test_local_path_resolution() {
        assert_eq!(resolve_local_path("/a/b", ".."), "/a");
        assert_eq!(resolve_local_path("/a/b", "../../../.."), "/");
        assert_eq!(resolve_local_path("/a/b", "/etc"), "/etc");
        assert_eq!(resolve_local_path("/a/b", "./c/../d"), "/a/b/d");
    }

    fn setup() -> (tempfile::TempDir, Arc<dyn VirtualFileSystem>, String, String) {
        let tmp = tempfile::tempdir().unwrap();
        let local = tmp.path().join("local");
        let remote = tmp.path().join("remote");
        std::fs::create_dir_all(local.join("sub")).unwrap();
        std::fs::create_dir_all(remote.join("docs")).unwrap();
        let vfs: Arc<dyn VirtualFileSystem> = Arc::new(LocalFsDriver::new());
        (
            tmp,
            vfs,
            local.to_string_lossy().to_string(),
            remote.to_string_lossy().to_string(),
        )
    }

    #[tokio::test]
    async fn test_rm_with_spaces_targets_the_quoted_file_only() {
        let (_tmp, vfs, mut l, mut r) = setup();
        std::fs::write(format!("{r}/my"), "keep").unwrap();
        std::fs::write(format!("{r}/my file.txt"), "delete me").unwrap();

        let out = ScriptInterpreter::execute_line(
            "rm my file.txt",
            vfs.clone(),
            Some(vfs.clone()),
            &mut l,
            &mut r,
        )
        .await;
        assert!(!out.success, "unquoted extra args must be rejected");
        assert!(std::path::Path::new(&format!("{r}/my")).exists());

        let out = ScriptInterpreter::execute_line(
            "rm \"my file.txt\"",
            vfs.clone(),
            Some(vfs.clone()),
            &mut l,
            &mut r,
        )
        .await;
        assert!(out.success, "{}", out.output);
        assert!(!std::path::Path::new(&format!("{r}/my file.txt")).exists());
        assert!(std::path::Path::new(&format!("{r}/my")).exists());
    }

    #[tokio::test]
    async fn test_cd_lcd_report_normalized_dirs() {
        let (_tmp, vfs, mut l, mut r) = setup();
        let start_r = r.clone();
        let start_l = l.clone();

        let out =
            ScriptInterpreter::execute_line("cd docs", vfs.clone(), Some(vfs.clone()), &mut l, &mut r)
                .await;
        assert!(out.success);
        assert_eq!(out.remote_dir.as_deref(), Some(format!("{start_r}/docs").as_str()));

        let out =
            ScriptInterpreter::execute_line("cd ..", vfs.clone(), Some(vfs.clone()), &mut l, &mut r)
                .await;
        assert_eq!(out.remote_dir.as_deref(), Some(start_r.as_str()));
        assert_eq!(r, start_r);

        let out =
            ScriptInterpreter::execute_line("lcd sub/..", vfs.clone(), None, &mut l, &mut r).await;
        assert!(out.success, "{}", out.output);
        assert_eq!(out.local_dir.as_deref(), Some(start_l.as_str()));

        let out = ScriptInterpreter::execute_line("lcd nope", vfs.clone(), None, &mut l, &mut r)
            .await;
        assert!(!out.success);
        assert_eq!(l, start_l, "failed lcd keeps the old directory");
        assert_eq!(out.local_dir.as_deref(), Some(start_l.as_str()));

        // Comments and errors still report the working dirs.
        let out = ScriptInterpreter::execute_line("# note", vfs.clone(), None, &mut l, &mut r).await;
        assert!(out.success);
        assert_eq!(out.remote_dir.as_deref(), Some(start_r.as_str()));
    }

    #[tokio::test]
    async fn test_mkdir_ls_get_put_resolve_paths() {
        let (_tmp, vfs, mut l, mut r) = setup();
        let rv = Some(vfs.clone());

        let out =
            ScriptInterpreter::execute_line("mkdir \"new dir\"", vfs.clone(), rv.clone(), &mut l, &mut r)
                .await;
        assert!(out.success, "{}", out.output);
        assert!(std::path::Path::new(&format!("{r}/new dir")).is_dir());

        // Absolute paths are not prefixed with the working directory.
        let abs = format!("{r}/docs/abs.txt");
        std::fs::write(&abs, "abs").unwrap();
        let out = ScriptInterpreter::execute_line(
            &format!("rm '{abs}'"),
            vfs.clone(),
            rv.clone(),
            &mut l,
            &mut r,
        )
        .await;
        assert!(out.success, "{}", out.output);
        assert!(!std::path::Path::new(&abs).exists());

        std::fs::write(format!("{r}/docs/readme.md"), "hello").unwrap();
        let out = ScriptInterpreter::execute_line("ls docs", vfs.clone(), rv.clone(), &mut l, &mut r)
            .await;
        assert!(out.success, "{}", out.output);
        assert!(out.output.contains("readme.md"));

        let out = ScriptInterpreter::execute_line(
            "get docs/readme.md",
            vfs.clone(),
            rv.clone(),
            &mut l,
            &mut r,
        )
        .await;
        assert!(out.success, "{}", out.output);
        assert_eq!(std::fs::read_to_string(format!("{l}/readme.md")).unwrap(), "hello");

        let out =
            ScriptInterpreter::execute_line("get docs/readme.md sub", vfs.clone(), rv.clone(), &mut l, &mut r)
                .await;
        assert!(out.success, "{}", out.output);
        assert!(std::path::Path::new(&format!("{l}/sub/readme.md")).exists());

        std::fs::write(format!("{l}/up.txt"), "up").unwrap();
        let out =
            ScriptInterpreter::execute_line("put up.txt docs", vfs.clone(), rv.clone(), &mut l, &mut r)
                .await;
        assert!(out.success, "{}", out.output);
        assert_eq!(std::fs::read_to_string(format!("{r}/docs/up.txt")).unwrap(), "up");

        let out = ScriptInterpreter::execute_line("get", vfs.clone(), rv.clone(), &mut l, &mut r).await;
        assert!(!out.success);

        let out = ScriptInterpreter::execute_line("help", vfs.clone(), None, &mut l, &mut r).await;
        assert!(out.output.contains("get <remote>"));
        assert!(!out.output.contains("user:pass"));
        assert!(!out.output.contains("open <"));

        let out = ScriptInterpreter::execute_line("rm x", vfs.clone(), None, &mut l, &mut r).await;
        assert!(!out.success);
        assert!(out.output.contains("No active remote session"));
    }

    #[test]
    fn test_output_deserializes_without_dirs() {
        let o: ScriptCommandOutput =
            serde_json::from_str(r#"{"command":"pwd","success":true,"output":""}"#).unwrap();
        assert!(o.remote_dir.is_none() && o.local_dir.is_none());
    }
}

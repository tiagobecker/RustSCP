use std::path::Path;
use std::process::Command;

fn track_dir_recursive(dir: &Path) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                track_dir_recursive(&path);
            } else if path.is_file() {
                println!("cargo:rerun-if-changed={}", path.display());
            }
        }
    }
}

fn get_latest_mtime(dir: &Path) -> Option<std::time::SystemTime> {
    let mut latest: Option<std::time::SystemTime> = None;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let mtime = if path.is_dir() {
                get_latest_mtime(&path)
            } else if let Ok(meta) = path.metadata() {
                meta.modified().ok()
            } else {
                None
            };
            if let Some(t) = mtime {
                latest = Some(match latest {
                    Some(prev) => prev.max(t),
                    None => t,
                });
            }
        }
    }
    latest
}

fn main() {
    let ui_src = Path::new("../ui/src");
    let ui_dist = Path::new("../ui/dist");
    let dist_index = Path::new("../ui/dist/index.html");

    // 1. Recursively track all source files so Cargo NEVER skips build.rs when files change
    track_dir_recursive(ui_src);
    track_dir_recursive(Path::new("../ui/public"));
    println!("cargo:rerun-if-changed=../ui/index.html");
    println!("cargo:rerun-if-changed=../ui/package.json");
    println!("cargo:rerun-if-changed=../ui/tailwind.config.js");
    println!("cargo:rerun-if-changed=../ui/vite.config.ts");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    track_dir_recursive(Path::new("icons"));

    // 2. Determine if frontend needs rebuilding
    let src_mtime = get_latest_mtime(ui_src);
    let dist_mtime = dist_index.metadata().and_then(|m| m.modified()).ok();

    let needs_build = match (src_mtime, dist_mtime) {
        (Some(src_t), Some(dist_t)) => src_t > dist_t,
        _ => !dist_index.exists(),
    };

    if needs_build && ui_src.exists() {
        println!("cargo:warning=Building frontend assets for rustscp-desktop...");

        // Ensure rich PATH with inherited PATH and user ~/.local/bin prioritized
        let original_path = std::env::var("PATH").unwrap_or_default();
        let home = std::env::var("HOME").unwrap_or_default();
        let extended_path = format!(
            "{}:{}/.local/bin:{}/Library/pnpm:{}/.local/share/pnpm:/usr/local/bin:/opt/homebrew/bin:{}/.cargo/bin",
            original_path, home, home, home, home
        );

        let mut cmd = Command::new("pnpm");
        cmd.arg("run")
            .arg("build")
            .current_dir("../ui")
            .env("PATH", &extended_path);

        let status = cmd.status().or_else(|_| {
            let mut npm_cmd = Command::new("npm");
            npm_cmd
                .arg("run")
                .arg("build")
                .current_dir("../ui")
                .env("PATH", &extended_path)
                .status()
        });

        match status {
            Ok(s) if s.success() => {
                println!("cargo:warning=Frontend assets built successfully.");
            }
            Ok(s) => {
                if dist_index.exists() {
                    println!("cargo:warning=Frontend build exited with {:?}, but dist/index.html exists; using existing dist.", s.code());
                } else {
                    panic!("Frontend build failed with exit code: {:?}", s.code());
                }
            }
            Err(e) => {
                if dist_index.exists() {
                    println!("cargo:warning=Could not execute frontend build ({}). Using existing dist.", e);
                } else {
                    panic!("Could not execute frontend build and dist/index.html does not exist: {}", e);
                }
            }
        }
    } else {
        println!("cargo:warning=Frontend dist is already up-to-date.");
    }

    // Track dist files so Cargo detects newly generated bundles
    track_dir_recursive(ui_dist);

    tauri_build::build();
}

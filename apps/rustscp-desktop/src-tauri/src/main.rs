#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

use commands::*;

#[cfg(target_os = "macos")]
fn setup_macos_dock_icon() {
    use objc2::AnyThread;
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::{MainThreadMarker, NSData};

    if let Some(mtm) = MainThreadMarker::new() {
        let icon_bytes = include_bytes!("../icons/icon.png");
        let data = NSData::with_bytes(icon_bytes);
        if let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) {
            let app = NSApplication::sharedApplication(mtm);
            unsafe {
                app.setApplicationIconImage(Some(&image));
            }
        }
    }
}

/// RustSCP text fields hold machine data (usernames, hosts, paths, commands, keys).
/// macOS applies "Capitalize words automatically", autocorrect and smart punctuation to
/// WKWebView inputs, which turned `root` into `Root` and broke logins. Opt this app's own
/// preference domain out of every automatic text substitution before the webview starts.
#[cfg(target_os = "macos")]
fn disable_macos_text_substitutions() {
    use objc2_foundation::{NSString, NSUserDefaults};

    let defaults = NSUserDefaults::standardUserDefaults();
    for key in [
        "NSAutomaticCapitalizationEnabled",
        "NSAutomaticSpellingCorrectionEnabled",
        "NSAutomaticTextCompletionEnabled",
        "NSAutomaticInlinePredictionEnabled",
        "NSAutomaticPeriodSubstitutionEnabled",
        "NSAutomaticQuoteSubstitutionEnabled",
        "NSAutomaticDashSubstitutionEnabled",
        "NSAutomaticTextReplacementEnabled",
        "WebAutomaticSpellingCorrectionEnabled",
        "WebAutomaticTextReplacementEnabled",
        "WebAutomaticQuoteSubstitutionEnabled",
        "WebAutomaticDashSubstitutionEnabled",
        "WebContinuousSpellCheckingEnabled",
        "WebGrammarCheckingEnabled",
    ] {
        defaults.setBool_forKey(false, &NSString::from_str(key));
    }
}

fn main() {
    // `rustscp-desktop --mcp-stdio`: the MCP server AI agents launch. It never opens a
    // window; it forwards tool calls to the RustSCP app that is already running.
    if std::env::args_os().skip(1).any(|arg| arg == MCP_STDIO_FLAG) {
        std::process::exit(run_mcp_stdio());
    }

    tracing_subscriber::fmt::init();

    #[cfg(target_os = "macos")]
    disable_macos_text_substitutions();

    tauri::Builder::default()
        .setup(|app| {
            #[cfg(target_os = "macos")]
            setup_macos_dock_icon();
            tauri::async_runtime::spawn(start_mcp_gateway(app.handle().clone()));
            Ok(())
        })
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            connect_session,
            disconnect_session,
            get_saved_sites,
            save_site,
            delete_site,
            export_sites_vault,
            import_sites_vault,
            get_vault_security_info,
            list_directory,
            get_session_default_path,
            read_file_content,
            write_file_content,
            create_new_directory,
            delete_item,
            delete_items,
            rename_item,
            change_permissions,
            get_file_properties,
            calculate_checksum,
            transfer_file,
            execute_remote_command,
            compare_and_sync_plan,
            get_actions_catalog,
            render_action_command,
            get_mcp_audit_logs,
            get_mcp_status,
            get_pending_mcp_approvals,
            respond_mcp_approval,
            set_mcp_gateway_enabled,
            execute_script_line,
            execute_script_batch,
            generate_automation_code,
            find_files_advanced,
            get_filesystem_info,
            calculate_directory_size,
            create_symlink,
            compare_directories_fast,
            start_continuous_sync,
            stop_continuous_sync,
            is_continuous_sync_running,
            get_bookmarks,
            add_bookmark,
            delete_bookmark,
            test_file_mask,
            mount_virtual_disk,
            unmount_virtual_disk,
            get_virtual_disks_status,
            open_virtual_disk_folder,
            pick_key_file,
            get_cache_stats,
            clear_site_cache,
            clear_all_cache,
            set_max_cache_size,
            enqueue_transfer,
            get_transfer_queue_tasks,
            cancel_transfer_task,
            clear_completed_transfers,
            compress_items,
            extract_archive,
            duplicate_item,
            detect_remote_system,
            open_native_terminal,
            manage_remote_trash,
            install_marketplace_tool,
            manage_custom_actions,
            open_in_external_editor,
            save_text_file_dialog,
            invalidate_directory_cache,
        ])
        .build(tauri::generate_context!())
        .expect("error while building RustSCP desktop application")
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                stop_background_services_once(app);
            }
        });
}

/// Serves MCP on stdin/stdout until the agent closes stdin. stdout carries protocol
/// messages only, so logs go to stderr. Returns the process exit code.
fn run_mcp_stdio() -> i32 {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("rustscp: could not start the MCP server: {e}");
            return 1;
        }
    };
    let config_dir = rustscp_core::get_rustscp_config_dir();
    match runtime.block_on(rustscp_mcp::run_stdio_bridge(config_dir)) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("rustscp: MCP server stopped: {e}");
            1
        }
    }
}

/// Longest the exit handler waits for virtual disks to unmount and continuous sync to stop.
const SHUTDOWN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Unmounts the virtual disks and stops continuous sync before the process ends, so
/// Finder / Explorer never keep a volume that points at a dead port. Runs once even
/// though both `ExitRequested` and `Exit` arrive.
fn stop_background_services_once(app: &tauri::AppHandle) {
    use std::sync::atomic::{AtomicBool, Ordering};
    use tauri::Manager;

    static DONE: AtomicBool = AtomicBool::new(false);
    if DONE.swap(true, Ordering::SeqCst) {
        return;
    }
    let state = app.state::<AppState>();
    let finished = tauri::async_runtime::block_on(async {
        tokio::time::timeout(SHUTDOWN_TIMEOUT, shutdown_background_services(&state)).await
    });
    if finished.is_err() {
        tracing::warn!(
            "background services did not stop within {} s; exiting anyway",
            SHUTDOWN_TIMEOUT.as_secs()
        );
    }
}

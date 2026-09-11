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

fn main() {
    tracing_subscriber::fmt::init();

    tauri::Builder::default()
        .setup(|_app| {
            #[cfg(target_os = "macos")]
            setup_macos_dock_icon();
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
            invalidate_directory_cache,
        ])
        .run(tauri::generate_context!())
        .expect("error while running RustSCP desktop application");
}

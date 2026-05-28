pub mod ai;
pub mod commands;
pub mod ffi;
pub mod path_validate;
pub mod process_classifier;
pub mod tray;
#[cfg(windows)]
pub mod uwp_apps;
pub mod window_titles;

use commands::{
    ai::{
        ai_classify_leak, ai_classify_process, ai_classify_project_folder, ai_clear_embedding_cache,
        ai_delete_model, ai_disk_usage, ai_download_model, ai_embed_files, ai_embed_text,
        ai_embedding_cache_stats, ai_classify_workload, ai_explain_process, ai_find_versions,
        ai_generate_folder_name, ai_generate_smart_rename, ai_generate_summary, ai_get_status,
        ai_model_status, ai_prewarm_embedder, ai_prewarm_genlm, ai_search_similar,
        ai_search_text, ai_set_tier, ai_suggest_folder_names, ai_summarize_folder, ai_tag_files,
    },
    bluetooth::{bluetooth_remove_device, get_bluetooth_snapshot, open_bluetooth_settings},
    disk::get_disk_data,
    display::{list_gpu_adapters, list_monitors, open_graphics_settings, set_display_mode},
    gpu::get_gpu_data,
    npu::get_npu_data,
    network::get_network_data,
    oem::{
        get_oem_info, get_charge_limit, set_charge_limit, is_elevated, relaunch_as_admin,
        get_oem_thermal_capabilities, get_oem_thermal_status,
    },
    performance::get_performance_snapshot,
    performance::get_per_core_cpu,
    power::get_power_data,
    processes::get_processes,
    status::get_status_data,
    storage::{get_storage_volumes, get_top_folders, get_installed_apps, measure_installed_app_storage, get_recycle_bin_size, empty_recycle_bin, scan_file_types, detect_projects, get_user_folders, create_folder, move_items_to_folder, recycle_files, classify_paths, list_files_by_extensions, list_folder_children, size_folder_paths, check_path_exists, reveal_in_explorer, scan_build_artifacts, find_duplicate_files, rename_file},
    system::get_system_info,
    task::{end_task, set_priority},
    thermal_delegate::{get_thermal_delegate_info, launch_thermal_delegate},
    usb::get_usb_devices,
    windows_system::{get_windows_battery_usage, open_windows_uri},
};
use tauri::{Emitter, Manager};

#[derive(Clone, serde::Serialize)]
struct MainTrayBackgroundPayload {
    hidden: bool,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            get_processes,
            get_power_data,
            get_disk_data,
            get_network_data,
            get_gpu_data,
            get_npu_data,
            get_status_data,
            get_system_info,
            end_task,
            set_priority,
            get_performance_snapshot,
            get_per_core_cpu,
            open_windows_uri,
            get_windows_battery_usage,
            get_thermal_delegate_info,
            launch_thermal_delegate,
            list_monitors,
            list_gpu_adapters,
            set_display_mode,
            open_graphics_settings,
            get_oem_info,
            get_charge_limit,
            set_charge_limit,
            is_elevated,
            relaunch_as_admin,
            get_oem_thermal_capabilities,
            get_oem_thermal_status,
            get_storage_volumes,
            get_top_folders,
            get_installed_apps,
            measure_installed_app_storage,
            get_recycle_bin_size,
            empty_recycle_bin,
            scan_file_types,
            detect_projects,
            get_user_folders,
            create_folder,
            move_items_to_folder,
            recycle_files,
            classify_paths,
            list_files_by_extensions,
            list_folder_children,
            size_folder_paths,
            check_path_exists,
            reveal_in_explorer,
            scan_build_artifacts,
            find_duplicate_files,
            rename_file,
            get_bluetooth_snapshot,
            bluetooth_remove_device,
            open_bluetooth_settings,
            get_usb_devices,
            ai_get_status,
            ai_set_tier,
            ai_classify_process,
            ai_classify_leak,
            ai_classify_project_folder,
            ai_download_model,
            ai_model_status,
            ai_embed_text,
            ai_embed_files,
            ai_clear_embedding_cache,
            ai_embedding_cache_stats,
            ai_disk_usage,
            ai_delete_model,
            ai_search_text,
            ai_search_similar,
            ai_prewarm_embedder,
            ai_find_versions,
            ai_tag_files,
            ai_explain_process,
            ai_classify_workload,
            ai_generate_smart_rename,
            ai_generate_summary,
            ai_generate_folder_name,
            ai_summarize_folder,
            ai_suggest_folder_names,
            ai_prewarm_genlm,
        ])
        .setup(|app| {
            // Set up system tray
            if let Err(e) = tray::setup_tray(app) {
                log::warn!("Failed to setup tray: {e}");
            }

            // Minimize to tray on close
            let window = app.get_webview_window("main").unwrap();
            let window_clone = window.clone();
            let app_handle = app.handle().clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window_clone.hide();
                    let _ = app_handle.emit(
                        "main-tray-background",
                        MainTrayBackgroundPayload { hidden: true },
                    );
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running TaskManagerPlus");
}

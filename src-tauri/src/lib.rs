pub mod commands;
pub mod ffi;
pub mod process_classifier;
pub mod tray;

use commands::{
    disk::get_disk_data,
    display::{list_gpu_adapters, list_monitors, open_graphics_settings, set_display_mode},
    gpu::get_gpu_data,
    npu::get_npu_data,
    network::get_network_data,
    oem::{get_oem_info, get_charge_limit, set_charge_limit, is_elevated, relaunch_as_admin},
    performance::get_performance_snapshot,
    performance::get_per_core_cpu,
    power::get_power_data,
    processes::get_processes,
    status::get_status_data,
    system::get_system_info,
    task::{end_task, set_priority},
    thermal_delegate::{get_thermal_delegate_info, launch_thermal_delegate},
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

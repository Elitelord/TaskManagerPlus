pub mod commands;
pub mod ffi;
pub mod tray;

use commands::{
    disk::get_disk_data,
    gpu::get_gpu_data,
    network::get_network_data,
    performance::get_performance_snapshot,
    performance::get_per_core_cpu,
    power::get_power_data,
    processes::get_processes,
    status::get_status_data,
    system::get_system_info,
    task::{end_task, set_priority},
};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            get_processes,
            get_power_data,
            get_disk_data,
            get_network_data,
            get_gpu_data,
            get_status_data,
            get_system_info,
            end_task,
            set_priority,
            get_performance_snapshot,
            get_per_core_cpu,
        ])
        .setup(|app| {
            // Set up system tray
            if let Err(e) = tray::setup_tray(app) {
                log::warn!("Failed to setup tray: {e}");
            }

            // Minimize to tray on close
            let window = app.get_webview_window("main").unwrap();
            let window_clone = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window_clone.hide();
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running TaskManagerPlus");
}

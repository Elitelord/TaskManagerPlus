pub mod ai;
pub mod commands;
pub mod ffi;
#[cfg(windows)]
pub mod mcp;
pub mod mcp_config;
pub mod path_validate;
pub mod process_classifier;
pub mod process_guard;
pub mod process_workload;
pub mod startup;
pub mod tray;
#[cfg(windows)]
pub mod uwp_apps;
pub mod window_titles;

use commands::{
    ai::{
        ai_classify_leak, ai_classify_process, ai_classify_project_folder, ai_clear_embedding_cache,
        ai_delete_model, ai_disk_usage, ai_download_model, ai_embed_files, ai_embed_text,
        ai_embedding_cache_stats, ai_classify_workload, ai_explain_process, ai_find_versions,
        ai_generate_folder_name, ai_generate_smart_rename, ai_generate_summary, ai_genlm_runtime_status,
        ai_get_status, ai_model_status, ai_prewarm_embedder, ai_prewarm_genlm, ai_search_similar,
        ai_embedder_runtime_status, ai_search_text, ai_set_embedder_backend,
        ai_set_genlm_backend, ai_set_ollama_config, ai_set_tier,
        ai_suggest_folder_names, ai_summarize_folder, ai_tag_files, ai_test_ollama,
    },
    bluetooth::{bluetooth_remove_device, get_bluetooth_snapshot, open_bluetooth_settings},
    crash::{get_crash_context, get_device_drivers, get_unexpected_shutdowns},
    disk::get_disk_data,
    display::{list_gpu_adapters, list_monitors, open_graphics_settings, set_display_mode},
    gpu::get_gpu_data,
    mcp::{
        mcp_clients_available, mcp_get_destructive_enabled, mcp_install_claude_code,
        mcp_install_claude_desktop, mcp_set_destructive_enabled, mcp_sidecar_path,
    },
    npu::get_npu_data,
    network::{get_network_data, probe_download_path},
    oem::{
        get_oem_info, get_charge_limit, set_charge_limit, is_elevated, relaunch_as_admin,
        get_oem_thermal_capabilities, get_oem_thermal_status,
    },
    performance::get_performance_snapshot,
    performance::get_per_core_cpu,
    performance::set_fan_sensor_enabled,
    power::get_power_data,
    processes::{get_processes, get_process_icons},
    status::get_status_data,
    startup::{get_startup_apps, set_logon_task_enabled, set_startup_enabled},
    storage::{get_storage_volumes, get_top_folders, get_installed_apps, measure_installed_app_storage, get_recycle_bin_size, get_system_reserved, empty_recycle_bin, scan_file_types, detect_projects, get_user_folders, create_folder, move_items_to_folder, recycle_files, classify_paths, list_files_by_extensions, get_category_files, list_folder_children, size_folder_paths, check_path_exists, reveal_in_explorer, scan_build_artifacts, find_duplicate_files, rename_file},
    system::get_system_info,
    sysupdate::{get_bios_info, get_windows_update_status},
    task::{end_task, set_priority},
    thermal_delegate::{get_thermal_delegate_info, launch_thermal_delegate},
    usb::get_usb_devices,
    windows_system::{get_windows_battery_usage, open_device_manager, open_windows_uri},
};
use tauri::{Emitter, Manager};

#[derive(Clone, serde::Serialize)]
struct MainTrayBackgroundPayload {
    hidden: bool,
}

/// Where the on-disk log lives: `%LOCALAPPDATA%\com.taskmanagerplus.app\taskmanagerplus.log`.
///
/// Computed from the environment rather than Tauri's path resolver because the
/// logger is installed before the app handle exists.
#[cfg(windows)]
fn log_file_path() -> Option<std::path::PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    let dir = std::path::PathBuf::from(base).join("com.taskmanagerplus.app");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("taskmanagerplus.log"))
}

#[cfg(not(windows))]
fn log_file_path() -> Option<std::path::PathBuf> {
    None
}

/// Fans log output to stderr *and* a file.
///
/// A release build sets `windows_subsystem = "windows"`, so it has no console
/// and stderr goes nowhere — which meant the generative-backend diagnostics
/// were unreadable in exactly the builds users actually run, and a native
/// crash inside the GPU DLLs left no trace at all. Writing to a file as well
/// makes a shipped build diagnosable, and makes `tauri dev --release`
/// (optimised, therefore also console-less) usable for reproducing
/// timing-dependent faults.
struct TeeLog {
    file: Option<std::fs::File>,
}

impl std::io::Write for TeeLog {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        // Best-effort on both sinks: logging must never take the app down.
        let _ = std::io::stderr().write_all(buf);
        if let Some(f) = self.file.as_mut() {
            let _ = f.write_all(buf);
            // Flushed per record on purpose. The interesting case is a hard
            // native crash (STATUS_ACCESS_VIOLATION in llama.dll), where the
            // process dies without unwinding — anything still buffered would
            // be lost, and it's precisely the last line before the fault that
            // identifies the culprit.
            let _ = f.flush();
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        let _ = std::io::stderr().flush();
        if let Some(f) = self.file.as_mut() {
            f.flush()?;
        }
        Ok(())
    }
}

/// Open the log for appending, starting a fresh one if it has grown past ~5 MB
/// so it can't expand without bound on a long-lived tray-resident process.
fn open_log_file() -> Option<std::fs::File> {
    const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
    let path = log_file_path()?;
    let too_big = std::fs::metadata(&path).map(|m| m.len() > MAX_LOG_BYTES).unwrap_or(false);
    std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(!too_big)
        .truncate(too_big)
        .open(&path)
        .ok()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize the `log` crate backend so `log::info!` / `log::warn!`
    // calls actually surface somewhere. Without this they go to a null
    // sink — which is why the genlm dispatcher's "chose CPU / chose
    // Vulkan / Vulkan init failed" diagnostics were invisible to users
    // trying to debug acceleration. Default level is `info`; users can
    // override with RUST_LOG=debug at launch for deeper traces.
    // `try_init` (not `init`) so a hot-reloaded process that already
    // installed the logger doesn't panic.
    let log_path = log_file_path();
    let _ = env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info"),
    )
    .target(env_logger::Target::Pipe(Box::new(TeeLog {
        file: open_log_file(),
    })))
    .try_init();
    if let Some(p) = log_path {
        log::info!("log file: {}", p.display());
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            get_processes,
            get_process_icons,
            get_power_data,
            get_disk_data,
            get_network_data,
            probe_download_path,
            get_gpu_data,
            mcp_sidecar_path,
            mcp_clients_available,
            mcp_install_claude_code,
            mcp_install_claude_desktop,
            mcp_get_destructive_enabled,
            mcp_set_destructive_enabled,
            get_npu_data,
            get_status_data,
            get_startup_apps,
            set_startup_enabled,
            set_logon_task_enabled,
            get_system_info,
            end_task,
            set_priority,
            get_performance_snapshot,
            get_per_core_cpu,
            set_fan_sensor_enabled,
            open_windows_uri,
            open_device_manager,
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
            get_system_reserved,
            empty_recycle_bin,
            scan_file_types,
            detect_projects,
            get_user_folders,
            create_folder,
            move_items_to_folder,
            recycle_files,
            classify_paths,
            list_files_by_extensions,
            get_category_files,
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
            get_unexpected_shutdowns,
            get_device_drivers,
            get_crash_context,
            get_bios_info,
            get_windows_update_status,
            get_usb_devices,
            ai_get_status,
            ai_set_tier,
            ai_set_genlm_backend,
            ai_set_ollama_config,
            ai_test_ollama,
            ai_genlm_runtime_status,
            ai_set_embedder_backend,
            ai_embedder_runtime_status,
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
            // Y1-A: tell the genlm dispatcher where the Vulkan DLL
            // bundle will live so its Auto / Vulkan modes can resolve
            // DLL availability. Path matches model_download's
            // `llama-vulkan-b9433` spec dest_subdir; if the bundle
            // hasn't been downloaded the dispatcher silently keeps
            // routing to CPU.
            #[cfg(windows)]
            if let Ok(base) = app.path().app_local_data_dir() {
                let dll_dir = base.join("llama_vulkan");
                crate::ai::genlm::set_dll_dir(dll_dir);
                // Z4 — same pattern for the ORT runtime bundle. Path
                // matches model_download's `onnxruntime-dml-v1` spec
                // dest_subdir; pick_embedder uses this to find
                // onnxruntime.dll at first use.
                let dml_dir = base.join("onnx_dml");
                crate::ai::embeddings::set_dml_dll_dir(dml_dir);
            }

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

            // Idle AI-model reaper. The generative + embedding models pin
            // ~500 MB once loaded and nothing freed them before; this timer
            // unloads them after `ai::ai_idle_unload_ms()` of no use, and the
            // next AI call transparently reloads. Ticks once a minute — cheap:
            // when nothing is loaded or the models are hot, it's an atomic read
            // and return. (The app's only background task; per-poll telemetry
            // is driven from the frontend, not a Rust timer.)
            tauri::async_runtime::spawn(async {
                let mut ticker = tokio::time::interval(std::time::Duration::from_secs(60));
                // Skip the immediate first tick so we don't check before any
                // model could possibly be loaded.
                ticker.tick().await;
                loop {
                    ticker.tick().await;
                    crate::ai::maybe_unload_idle_models();
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running TaskManagerPlus");
}

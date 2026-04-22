use crate::ffi;

// All Tauri commands in this module are `async fn` + `spawn_blocking` so the
// underlying FFI/DLL call runs on the tokio blocking pool rather than blocking
// the Tauri main thread. With the prior sync signature, every concurrent call
// from the 1s JS polling loop serialized behind each other on the main thread —
// a batch of 10 commands × ~500ms FFI cost would pile up into 5s tail latency
// visible in DevTools Network. spawn_blocking lets them run concurrently.
#[tauri::command]
pub async fn get_performance_snapshot() -> Result<ffi::PerformanceSnapshot, String> {
    tauri::async_runtime::spawn_blocking(ffi::load_performance_snapshot)
        .await
        .map_err(|e| format!("join error: {e}"))?
}

#[tauri::command]
pub async fn get_per_core_cpu() -> Result<Vec<ffi::CoreCpuInfo>, String> {
    tauri::async_runtime::spawn_blocking(ffi::load_per_core_cpu)
        .await
        .map_err(|e| format!("join error: {e}"))?
}

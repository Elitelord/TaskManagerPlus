use crate::ffi;

// async + spawn_blocking so FFI call doesn't block the Tauri main thread.
// See performance.rs for the full rationale.
#[tauri::command]
pub async fn get_network_data() -> Result<Vec<ffi::ProcessNetworkInfo>, String> {
    tauri::async_runtime::spawn_blocking(ffi::load_network_list)
        .await
        .map_err(|e| format!("join error: {e}"))?
}

/// Enumerates writable file handles in `pid` to guess the on-disk download path.
#[tauri::command]
pub async fn probe_download_path(pid: u32) -> Result<Option<String>, String> {
    if pid == 0 {
        return Ok(None);
    }
    tauri::async_runtime::spawn_blocking(move || ffi::probe_download_path(pid))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

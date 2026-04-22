use crate::ffi;

// async + spawn_blocking so FFI call doesn't block the Tauri main thread.
// See performance.rs for the full rationale.
#[tauri::command]
pub async fn get_status_data() -> Result<Vec<ffi::ProcessStatusInfo>, String> {
    tauri::async_runtime::spawn_blocking(ffi::load_status_list)
        .await
        .map_err(|e| format!("join error: {e}"))?
}

use crate::ffi;

// async + spawn_blocking so FFI call doesn't block the Tauri main thread.
// See performance.rs for the full rationale.
#[tauri::command]
pub async fn get_system_info() -> Result<ffi::SystemInfo, String> {
    tauri::async_runtime::spawn_blocking(ffi::load_system_info)
        .await
        .map_err(|e| format!("join error: {e}"))?
}

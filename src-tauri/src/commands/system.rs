use crate::ffi;

#[tauri::command]
pub fn get_system_info() -> Result<ffi::SystemInfo, String> {
    ffi::load_system_info()
}

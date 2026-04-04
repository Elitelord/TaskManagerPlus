use crate::ffi;

#[tauri::command]
pub fn get_status_data() -> Result<Vec<ffi::ProcessStatusInfo>, String> {
    ffi::load_status_list()
}

use crate::ffi;

#[tauri::command]
pub fn get_processes() -> Result<Vec<ffi::ProcessInfo>, String> {
    ffi::load_process_list()
}

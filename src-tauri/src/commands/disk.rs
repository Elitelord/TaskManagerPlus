use crate::ffi;

#[tauri::command]
pub fn get_disk_data() -> Result<Vec<ffi::ProcessDiskInfo>, String> {
    ffi::load_disk_list()
}

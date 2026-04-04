use crate::ffi;

#[tauri::command]
pub fn get_power_data() -> Result<Vec<ffi::ProcessPowerInfo>, String> {
    ffi::load_power_list()
}

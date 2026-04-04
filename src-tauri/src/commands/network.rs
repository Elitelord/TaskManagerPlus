use crate::ffi;

#[tauri::command]
pub fn get_network_data() -> Result<Vec<ffi::ProcessNetworkInfo>, String> {
    ffi::load_network_list()
}

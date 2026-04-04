use crate::ffi;

#[tauri::command]
pub fn get_gpu_data() -> Result<Vec<ffi::ProcessGpuInfo>, String> {
    ffi::load_gpu_list()
}

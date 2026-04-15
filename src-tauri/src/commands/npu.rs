use crate::ffi;

#[tauri::command]
pub fn get_npu_data() -> Result<Vec<ffi::ProcessNpuInfo>, String> {
    ffi::load_npu_list()
}

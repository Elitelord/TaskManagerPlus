use crate::ffi;

#[tauri::command]
pub fn get_performance_snapshot() -> Result<ffi::PerformanceSnapshot, String> {
    ffi::load_performance_snapshot()
}

#[tauri::command]
pub fn get_per_core_cpu() -> Result<Vec<ffi::CoreCpuInfo>, String> {
    ffi::load_per_core_cpu()
}

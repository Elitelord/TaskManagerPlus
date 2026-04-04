use crate::ffi;

#[tauri::command]
pub fn end_task(pid: u32) -> Result<(), String> {
    ffi::kill_process(pid)
}

#[tauri::command]
pub fn set_priority(pid: u32, priority: i32) -> Result<(), String> {
    ffi::set_priority(pid, priority)
}

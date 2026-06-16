use crate::ffi;
use crate::process_guard;

// async + spawn_blocking: `guarded_kill` resolves the process name (loads the
// full process list) before terminating, so it must not run on the Tauri main
// thread. The critical-process refusals live in `process_guard` and are shared
// with the MCP `end_process` tool so the two kill paths can't drift apart.
#[tauri::command]
pub async fn end_task(pid: u32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || process_guard::guarded_kill(pid))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

#[tauri::command]
pub fn set_priority(pid: u32, priority: i32) -> Result<(), String> {
    ffi::set_priority(pid, priority)
}

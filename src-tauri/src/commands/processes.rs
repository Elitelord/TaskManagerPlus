use crate::ffi;
use std::collections::HashMap;

// async + spawn_blocking so FFI call doesn't block the Tauri main thread.
// See performance.rs for the full rationale.
#[tauri::command]
pub async fn get_processes() -> Result<Vec<ffi::ProcessInfo>, String> {
    tauri::async_runtime::spawn_blocking(|| -> Result<Vec<ffi::ProcessInfo>, String> {
        let mut list = ffi::load_process_list()?;
        // Icons travel on a separate, cached channel (`get_process_icons`)
        // keyed by exe name. Stripping them here keeps the per-poll IPC
        // payload from carrying a ~16 KB base64 string per process — the
        // single biggest cost in the previous payload. `load_process_list`
        // already seeded the icon cache, so the frontend can fetch each
        // name's icon once and reuse it.
        for p in &mut list {
            p.icon_base64 = String::new();
        }
        Ok(list)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Resolve base64 icons for a set of exe names. The frontend calls this only
/// for names it hasn't cached yet (typically just the first time each
/// executable appears), so after warm-up it's a no-op. Returns a
/// name → base64 map; names with no extractable icon are omitted.
#[tauri::command]
pub async fn get_process_icons(names: Vec<String>) -> Result<HashMap<String, String>, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(ffi::icons_for_names(&names)))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

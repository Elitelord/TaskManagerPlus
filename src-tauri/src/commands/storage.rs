use crate::ffi;
use serde::Serialize;

/// Well-known user folder paths for the Smart Organizer. Returned as absolute
/// paths derived from the `USERPROFILE` environment variable — we don't use
/// SHGetKnownFolderPath because JSDoc/OneDrive redirection can return cloud
/// paths that our scanner would then skip via the reparse-point filter.
#[derive(Serialize, Clone, Debug, Default)]
pub struct UserFolderPaths {
    pub home: String,
    pub documents: String,
    pub downloads: String,
    pub desktop: String,
    pub pictures: String,
    pub videos: String,
    pub music: String,
}

#[tauri::command]
pub fn get_user_folders() -> Result<UserFolderPaths, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|e| format!("USERPROFILE not set: {e}"))?;
    let join = |sub: &str| -> String {
        let trimmed = home.trim_end_matches(['\\', '/']);
        format!("{trimmed}\\{sub}")
    };
    Ok(UserFolderPaths {
        home: home.clone(),
        documents: join("Documents"),
        downloads: join("Downloads"),
        desktop:   join("Desktop"),
        pictures:  join("Pictures"),
        videos:    join("Videos"),
        music:     join("Music"),
    })
}

#[tauri::command]
pub async fn get_storage_volumes() -> Result<Vec<ffi::StorageVolumeInfo>, String> {
    tauri::async_runtime::spawn_blocking(ffi::load_storage_volumes)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_top_folders(root: String, max: Option<i32>) -> Result<Vec<ffi::StorageFolderInfo>, String> {
    let max = max.unwrap_or(32);
    tauri::async_runtime::spawn_blocking(move || ffi::load_top_folders(&root, max))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_installed_apps() -> Result<Vec<ffi::InstalledAppInfo>, String> {
    tauri::async_runtime::spawn_blocking(ffi::load_installed_apps)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_recycle_bin_size() -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(ffi::load_recycle_bin_size)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn empty_recycle_bin() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(ffi::empty_recycle_bin)
        .await
        .map_err(|e| e.to_string())?
}

/// Smart Organizer — classify files under `folder` (depth=6, ~20k file cap) into
/// category rollups. Called for each user folder the organizer wants composition
/// data for (Documents, Downloads, Desktop, Pictures, Videos, Music).
#[tauri::command]
pub async fn scan_file_types(folder: String) -> Result<Vec<ffi::FileTypeStat>, String> {
    tauri::async_runtime::spawn_blocking(move || ffi::load_file_type_stats(&folder))
        .await
        .map_err(|e| e.to_string())?
}

/// Smart Organizer — find project folders (Git repos, Node/Rust/.NET/Python
/// projects) under `root` to depth 4.
#[tauri::command]
pub async fn detect_projects(root: String) -> Result<Vec<ffi::DetectedProject>, String> {
    tauri::async_runtime::spawn_blocking(move || ffi::load_detected_projects(&root))
        .await
        .map_err(|e| e.to_string())?
}

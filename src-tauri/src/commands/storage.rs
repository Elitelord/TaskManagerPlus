use crate::ffi;
use crate::path_validate::{classify_str, PathVerdict};
use serde::Serialize;

/// Defense-in-depth gate for destructive file commands. Every source path
/// (and the move destination) goes through this filter before we touch the
/// filesystem. The frontend already shows confirms, but the UI layer is not
/// the security boundary — an event-payload exploit or a future plugin
/// bypassing the dialog must still hit a hard backend wall.
///
/// `allow_unsafe` is the user's explicit override. When `true`, we still
/// refuse `Forbidden` paths (system roots, drive roots, Program Files) but
/// permit `Sensitive` paths (the user's profile root, well-known top-level
/// user folders) because the frontend has surfaced a warning dialog and
/// the user actively confirmed. When `false`, both verdicts are refused.
///
/// Returns the list of `(path, verdict)` pairs that were rejected so the
/// caller can attribute them in the result payload — the user sees exactly
/// which paths the backend wouldn't touch.
fn screen_paths(paths: &[String], allow_unsafe: bool) -> Vec<(String, PathVerdict)> {
    let mut rejected = Vec::new();
    for p in paths {
        let v = classify_str(p);
        match v {
            PathVerdict::Forbidden => rejected.push((p.clone(), v)),
            PathVerdict::Sensitive if !allow_unsafe => rejected.push((p.clone(), v)),
            _ => {}
        }
    }
    rejected
}

fn verdict_label(v: PathVerdict) -> &'static str {
    match v {
        PathVerdict::Forbidden => "blocked (system or protected location)",
        PathVerdict::Sensitive => "needs confirm-unsafe (high-risk folder)",
        PathVerdict::Safe => "ok",
    }
}

/// Read-only scan commands refuse `Forbidden` paths outright (system roots,
/// Program Files, etc.) — no recursive walk, no directory listing.
fn refuse_forbidden(path: &str) -> Result<(), String> {
    if classify_str(path) == PathVerdict::Forbidden {
        Err(format!("{path}: {}", verdict_label(PathVerdict::Forbidden)))
    } else {
        Ok(())
    }
}

fn is_forbidden(path: &str) -> bool {
    classify_str(path) == PathVerdict::Forbidden
}

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

/// Deep-measure variant of `get_installed_apps`. Walks `InstallLocation`
/// recursively, attributes AppData / LocalAppData / ProgramData folders
/// per app (Phase A + C in the DLL), then merges in Microsoft Store / UWP
/// packages enumerated from the per-user app-model registry (Phase D, in
/// Rust). Returns rows with `install_bytes` / `data_bytes` / `size_source`
/// populated.
///
/// Bounded by per-app file caps in the DLL plus the two caller-supplied
/// budgets. The UWP pass shares the same wall-clock deadline so the
/// Storage page can fire-and-forget with one timeout.
///
/// `max_apps` and `time_budget_ms` default to the DLL's internal values
/// (40 apps, 30s) when omitted or set to 0.
#[tauri::command]
pub async fn measure_installed_app_storage(
    max_apps: Option<i32>,
    time_budget_ms: Option<i32>,
) -> Result<Vec<ffi::InstalledAppInfo>, String> {
    let max_apps = max_apps.unwrap_or(0);
    let time_budget_ms = time_budget_ms.unwrap_or(0);
    tauri::async_runtime::spawn_blocking(move || {
        let mut win32 = ffi::measure_installed_app_storage(max_apps, time_budget_ms)?;

        // Phase D — append UWP/Store apps. We share the remaining budget
        // from the time the call started so a slow DLL pass naturally
        // shrinks the UWP window rather than doubling the wall-clock cost.
        #[cfg(windows)]
        {
            let budget_ms = if time_budget_ms > 0 { time_budget_ms } else { 30_000 };
            let deadline = std::time::Instant::now()
                + std::time::Duration::from_millis(budget_ms as u64);
            let uwp_rows = crate::uwp_apps::enumerate_uwp_apps(deadline);
            merge_uwp_into_win32(&mut win32, uwp_rows);
        }

        Ok::<_, String>(win32)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Normalized display-name key for cross-source dedup. Casefolds, collapses
/// internal whitespace, and strips a trailing parenthetical so
/// "Microsoft Teams" and "Microsoft Teams (work or school)" collapse to the same
/// key. Heuristic by nature — B2's path-territory rule (%LOCALAPPDATA%\Packages
/// is UWP-only) is what actually prevents the *bytes* from being double counted;
/// this only decides which of two rows for the same app to keep.
pub fn normalize_app_name_key(name: &str) -> String {
    let mut s = name.trim().to_string();
    if s.ends_with(')') {
        if let Some(open) = s.rfind('(') {
            s.truncate(open);
        }
    }
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// Confidence ordering for a `size_source` string. Higher wins when two rows
/// describe the same app. A fully-measured row must beat a registry estimate —
/// the old merge kept whichever the Win32 list happened to hold, so an
/// ACL-blocked Win32 row with a stale estimate could shadow a measured UWP row.
pub fn size_source_rank(src: &str) -> u8 {
    match src {
        "measured_total" => 5,
        "measured_install" | "measured_data" => 4,
        "partial" => 3,
        "measured_shallow" => 2,
        "registry" => 1,
        _ => 0, // unknown / anything else
    }
}

/// True when `challenger` should replace `incumbent` for the same app: higher
/// measurement confidence, or equal confidence but a larger measured size.
pub fn prefer_row(inc_src: &str, inc_size: u64, chal_src: &str, chal_size: u64) -> bool {
    let (ri, rc) = (size_source_rank(inc_src), size_source_rank(chal_src));
    if rc != ri { rc > ri } else { chal_size > inc_size }
}

/// Merge UWP rows into the Win32 list, deduping on the normalized display name.
/// When a UWP row and a Win32 row describe the same app, keep the one with the
/// stronger size provenance (see `prefer_row`) rather than always dropping the
/// UWP row. Resulting list is re-sorted by `size_bytes` desc.
#[cfg(windows)]
fn merge_uwp_into_win32(
    win32: &mut Vec<ffi::InstalledAppInfo>,
    uwp_rows: Vec<ffi::InstalledAppInfo>,
) {
    use std::collections::HashMap;
    let mut by_key: HashMap<String, usize> = HashMap::new();
    for (i, a) in win32.iter().enumerate() {
        by_key.entry(normalize_app_name_key(&a.name)).or_insert(i);
    }
    for u in uwp_rows {
        let key = normalize_app_name_key(&u.name);
        if key.is_empty() {
            win32.push(u);
            continue;
        }
        if let Some(&idx) = by_key.get(&key) {
            let inc = &win32[idx];
            if prefer_row(&inc.size_source, inc.size_bytes, &u.size_source, u.size_bytes) {
                win32[idx] = u;
            }
        } else {
            by_key.insert(key, win32.len());
            win32.push(u);
        }
    }
    win32.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
}

#[tauri::command]
pub async fn get_recycle_bin_size() -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(ffi::load_recycle_bin_size)
        .await
        .map_err(|e| e.to_string())?
}

/// System-reserved storage for a volume root (e.g. "C:\\"): pagefile,
/// hibernation, swap, and this volume's recycle bin — the locked/skipped bytes
/// the folder scan can't attribute. Lets the ring show them as named slices
/// instead of an opaque remainder.
#[tauri::command]
pub async fn get_system_reserved(root: String) -> Result<ffi::SystemReservedInfo, String> {
    tauri::async_runtime::spawn_blocking(move || ffi::load_system_reserved(&root))
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

/// Create a folder at the given path. Returns Ok(()) if the folder already exists
/// or was successfully created. Errors on I/O failure or invalid paths.
#[tauri::command]
pub async fn create_folder(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&path)
            .map_err(|e| format!("Failed to create folder '{}': {}", path, e))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Move a list of files/folders into a destination folder. Each source path is
/// moved as-is (preserving its leaf name) into `destination`. If a file with
/// the same name already exists in `destination`, the move for that item is
/// skipped and reported in the return value.
///
/// `allow_unsafe` lets the frontend opt past the path-validation gate for
/// sensitive (but legitimate) destinations like the user's profile root.
/// `Forbidden` paths — system roots, Program Files, drive roots — are
/// refused regardless. The frontend MUST surface a warning dialog before
/// passing `allow_unsafe = true`.
#[tauri::command]
pub async fn move_items_to_folder(
    sources: Vec<String>,
    destination: String,
    allow_unsafe: Option<bool>,
) -> Result<MoveResult, String> {
    let allow = allow_unsafe.unwrap_or(false);
    // Destination is a forbidden/sensitive path? Stop before we even create it.
    let dest_verdict = classify_str(&destination);
    if matches!(dest_verdict, PathVerdict::Forbidden)
        || (matches!(dest_verdict, PathVerdict::Sensitive) && !allow)
    {
        return Err(format!(
            "Destination '{destination}' is {} — refusing.",
            verdict_label(dest_verdict)
        ));
    }
    let rejected_sources = screen_paths(&sources, allow);

    tauri::async_runtime::spawn_blocking(move || {
        let dest = std::path::Path::new(&destination);
        if !dest.exists() {
            std::fs::create_dir_all(dest)
                .map_err(|e| format!("Cannot create destination '{}': {}", destination, e))?;
        }
        let mut moved = 0u32;
        let mut skipped: Vec<String> = Vec::new();
        let mut errors: Vec<String> = Vec::new();

        // Attribute rejected sources up front so the UI can show "N
        // blocked by safety filter" rather than them silently disappearing.
        let rejected_lookup: std::collections::HashSet<&str> =
            rejected_sources.iter().map(|(p, _)| p.as_str()).collect();
        for (p, v) in &rejected_sources {
            errors.push(format!("{p}: {}", verdict_label(*v)));
        }

        for src_str in &sources {
            if rejected_lookup.contains(src_str.as_str()) { continue; }
            let src = std::path::Path::new(src_str);
            if !src.exists() {
                skipped.push(format!("{} (not found)", src_str));
                continue;
            }
            let leaf = match src.file_name() {
                Some(n) => n,
                None => {
                    skipped.push(format!("{} (no filename)", src_str));
                    continue;
                }
            };
            let target = dest.join(leaf);
            if target.exists() {
                skipped.push(format!("{} (already exists at destination)", src_str));
                continue;
            }
            // Try rename first (same-volume move = instant). Fall back to
            // copy+delete for cross-volume moves.
            match std::fs::rename(src, &target) {
                Ok(()) => { moved += 1; }
                Err(_rename_err) => {
                    // Cross-volume fallback
                    if src.is_dir() {
                        match copy_dir_recursive(src, &target) {
                            Ok(()) => {
                                let _ = std::fs::remove_dir_all(src);
                                moved += 1;
                            }
                            Err(e) => {
                                let _ = std::fs::remove_dir_all(&target);
                                errors.push(format!("{}: {}", src_str, e));
                            }
                        }
                    } else {
                        match std::fs::copy(src, &target) {
                            Ok(_) => {
                                let _ = std::fs::remove_file(src);
                                moved += 1;
                            }
                            Err(e) => {
                                let _ = std::fs::remove_file(&target);
                                errors.push(format!("{}: {}", src_str, e));
                            }
                        }
                    }
                }
            }
        }
        Ok(MoveResult { moved, skipped, errors })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Recursively copy a directory tree.
fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        let dest_path = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &dest_path)?;
        } else {
            std::fs::copy(entry.path(), &dest_path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct MoveResult {
    pub moved: u32,
    pub skipped: Vec<String>,
    pub errors: Vec<String>,
}

/// Send files/folders to the Recycle Bin via the Windows Shell API. This is
/// non-destructive — the user can restore items from the Recycle Bin later.
///
/// `allow_unsafe` matches `move_items_to_folder`: opt-in override for
/// sensitive paths (the user's profile root, well-known top folders); the
/// frontend must surface a warning dialog before passing `true`. Forbidden
/// system paths are always refused.
#[tauri::command]
pub async fn recycle_files(
    paths: Vec<String>,
    allow_unsafe: Option<bool>,
) -> Result<RecycleResult, String> {
    let allow = allow_unsafe.unwrap_or(false);
    let rejected = screen_paths(&paths, allow);
    let rejected_lookup: std::collections::HashSet<String> =
        rejected.iter().map(|(p, _)| p.clone()).collect();

    tauri::async_runtime::spawn_blocking(move || {
        let mut recycled = 0u32;
        let mut errors: Vec<String> = Vec::new();
        for (p, v) in &rejected {
            errors.push(format!("{p}: {}", verdict_label(*v)));
        }

        for path_str in &paths {
            if rejected_lookup.contains(path_str) { continue; }
            let path = std::path::Path::new(path_str);
            if !path.exists() {
                errors.push(format!("{} (not found)", path_str));
                continue;
            }
            match trash::delete(path) {
                Ok(()) => { recycled += 1; }
                Err(e) => { errors.push(format!("{}: {}", path_str, e)); }
            }
        }
        Ok(RecycleResult { recycled, errors })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Lightweight path-verdict helper for the frontend. Lets the UI ask "is
/// this destination sensitive / forbidden?" so it can warn the user BEFORE
/// they confirm a destructive action, rather than getting a generic
/// rejection error back from the destructive command.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PathSafetyReport {
    /// "safe" | "sensitive" | "forbidden"
    pub verdict: String,
    /// Always set for sensitive/forbidden so the UI can show context.
    pub reason: String,
    pub path: String,
}

#[tauri::command]
pub async fn classify_paths(paths: Vec<String>) -> Result<Vec<PathSafetyReport>, String> {
    Ok(paths
        .into_iter()
        .map(|p| {
            let v = classify_str(&p);
            let verdict = match v {
                PathVerdict::Safe => "safe",
                PathVerdict::Sensitive => "sensitive",
                PathVerdict::Forbidden => "forbidden",
            };
            PathSafetyReport {
                verdict: verdict.to_string(),
                reason: verdict_label(v).to_string(),
                path: p,
            }
        })
        .collect())
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct RecycleResult {
    pub recycled: u32,
    pub errors: Vec<String>,
}

/// List individual files inside `folder` whose extension matches one of the
/// provided values.  Returns up to `max_results` (default 100) files sorted
/// by size descending.  Used by the Smart Organizer to show the specific files
/// underlying a finding (e.g. "these 5 .msi files in Downloads") so the user
/// can review before recycling or moving them.
#[tauri::command]
pub async fn list_files_by_extensions(
    folder: String,
    extensions: Vec<String>,
    max_depth: Option<u32>,
    max_results: Option<u32>,
    // Optional filename-substring gate (lowercased contains-any). Lets the
    // installer finding enumerate the *same* set the native rollup counted,
    // which classifies by filename ("setup"/"install"), not extension alone.
    name_contains: Option<Vec<String>>,
) -> Result<Vec<FoundFile>, String> {
    let max_d = max_depth.unwrap_or(2);
    let max_r = max_results.unwrap_or(100) as usize;
    let exts: Vec<String> = extensions.iter().map(|e| e.to_lowercase()).collect();
    let needles: Vec<String> = name_contains
        .unwrap_or_default()
        .iter()
        .map(|s| s.to_lowercase())
        .collect();

    tauri::async_runtime::spawn_blocking(move || {
        // Collect up to a generous hard cap, THEN sort, THEN truncate to
        // `max_r` — so the result is the *largest* max_r files, not the first
        // max_r the walker happened to encounter. The old code stopped walking
        // at max_results and only sorted afterwards, so the single biggest file
        // in a folder was routinely absent from a list titled "biggest files".
        const HARD_CAP: usize = 5000;
        let mut results = Vec::new();
        walk_for_extensions(
            std::path::Path::new(&folder),
            &exts,
            &needles,
            0,
            max_d,
            HARD_CAP,
            &mut results,
        );
        results.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
        results.truncate(max_r);
        Ok(results)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// D1 — the largest files in one file-type category of `folder`, taken from the
/// same DLL traversal that produced the category's headline count. Use this for
/// category-backed findings (installers/archives/…) so the card's list is
/// provably a subset of what the headline counted, instead of a separate
/// extension-only walk that classifies files differently.
#[tauri::command]
pub async fn get_category_files(
    folder: String,
    category: String,
    max_results: Option<u32>,
) -> Result<Vec<FoundFile>, String> {
    let max = max_results.unwrap_or(100) as i32;
    tauri::async_runtime::spawn_blocking(move || {
        let rows = ffi::load_folder_category_files(&folder, &category, max)?;
        Ok::<_, String>(
            rows.into_iter()
                .map(|(path, size_bytes, modified_ts)| {
                    let name = std::path::Path::new(&path)
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    FoundFile { path, name, size_bytes, modified_ts: modified_ts.max(0) as u64 }
                })
                .collect(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

fn walk_for_extensions(
    dir: &std::path::Path,
    exts: &[String],
    needles: &[String],
    depth: u32,
    max_depth: u32,
    hard_cap: usize,
    results: &mut Vec<FoundFile>,
) {
    if depth > max_depth || results.len() >= hard_cap {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries {
        if results.len() >= hard_cap {
            break;
        }
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        if path.is_dir() {
            walk_for_extensions(&path, exts, needles, depth + 1, max_depth, hard_cap, results);
        } else {
            // Empty `exts` slice means "match every file" — used by the
            // UserFolderExplorer to surface biggest files regardless of type.
            let ext_ok = if exts.is_empty() {
                true
            } else if let Some(ext) = path.extension() {
                let ext_lower = format!(".{}", ext.to_string_lossy().to_lowercase());
                exts.iter().any(|e| e == &ext_lower)
            } else {
                false
            };
            if !ext_ok {
                continue;
            }
            // Optional filename gate (empty = no filter).
            if !needles.is_empty() {
                let name_lower = path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_lowercase())
                    .unwrap_or_default();
                if !needles.iter().any(|n| name_lower.contains(n.as_str())) {
                    continue;
                }
            }
            let meta = std::fs::metadata(&path).ok();
            let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
            let modified = meta
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            results.push(FoundFile {
                path: path.to_string_lossy().to_string(),
                name,
                size_bytes: size,
                modified_ts: modified,
            });
        }
    }
}

/// Recursive size of one folder tree (used to enrich inspector drill-down).
#[derive(serde::Serialize, Clone, Debug)]
pub struct FolderSizeResult {
    pub path: String,
    pub size_bytes: u64,
    pub file_count: i64,
}

fn dir_size_recursive(dir: &std::path::Path, depth: u32, max_depth: u32) -> (u64, i64) {
    if depth > max_depth {
        return (0, 0);
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return (0, 0);
    };
    let mut total = 0u64;
    let mut files = 0i64;
    for entry in entries.flatten() {
        let path = entry.path();
        if path
            .symlink_metadata()
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false)
        {
            continue;
        }
        if path.is_dir() {
            let (s, f) = dir_size_recursive(&path, depth + 1, max_depth);
            total += s;
            files += f;
        } else if path.is_file() {
            total += path.metadata().map(|m| m.len()).unwrap_or(0);
            files += 1;
        }
    }
    (total, files)
}

/// Size each folder path independently (immediate-child folders from the
/// inspector). Returns results in the same order as `paths`.
#[tauri::command]
pub async fn size_folder_paths(
    paths: Vec<String>,
    max_depth: Option<u32>,
) -> Result<Vec<FolderSizeResult>, String> {
    let max_d = max_depth.unwrap_or(8);
    tauri::async_runtime::spawn_blocking(move || {
        Ok(paths
            .into_iter()
            .map(|p| {
                if is_forbidden(&p) {
                    return FolderSizeResult {
                        path: p,
                        size_bytes: 0,
                        file_count: 0,
                    };
                }
                let (size, count) = dir_size_recursive(std::path::Path::new(&p), 0, max_d);
                FolderSizeResult {
                    path: p,
                    size_bytes: size,
                    file_count: count,
                }
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Immediate children of `folder` — one directory level, no recursive size
/// scan. Files include their byte size; folders are returned with
/// `size_bytes = 0` until a separate `get_top_folders` pass enriches them.
#[derive(serde::Serialize, Clone, Debug)]
pub struct FolderChildEntry {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub size_bytes: u64,
}

#[tauri::command]
pub async fn list_folder_children(folder: String) -> Result<Vec<FolderChildEntry>, String> {
    refuse_forbidden(&folder)?;
    tauri::async_runtime::spawn_blocking(move || {
        let dir = std::path::Path::new(&folder);
        let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for entry in entries {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            let path = entry.path();
            if path
                .symlink_metadata()
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(false)
            {
                continue;
            }
            let path_str = path.to_string_lossy().to_string();
            if is_forbidden(&path_str) {
                continue;
            }
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            if path.is_dir() {
                out.push(FolderChildEntry {
                    path: path_str,
                    name,
                    kind: "folder".into(),
                    size_bytes: 0,
                });
            } else if path.is_file() {
                let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                out.push(FolderChildEntry {
                    path: path_str,
                    name,
                    kind: "file".into(),
                    size_bytes: size,
                });
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct FoundFile {
    pub path: String,
    pub name: String,
    pub size_bytes: u64,
    pub modified_ts: u64,
}

// ---------------------------------------------------------------------------
// Smart Organizer — build artifact scanner
// ---------------------------------------------------------------------------
//
// Given a list of detected project roots, find build/dependency artifact
// folders (node_modules, target, __pycache__, .venv, etc.) and report each
// one's size + last-modified timestamp. The organizer turns stale entries
// (say, > 30 days) into a "stale dev artifacts" finding with a delete action.
//
// This is a pure-Rust walker (no DLL involvement) so it doesn't contend with
// the perf-polling DLL lock. We walk the project root only 4 levels deep —
// artifact folders are always at the top of a project, not buried inside.

#[derive(serde::Serialize, Clone, Debug)]
pub struct BuildArtifact {
    pub path: String,
    pub project_path: String,  // the parent project we found this under
    pub kind: String,          // "node_modules" | "target" | "__pycache__" | ...
    pub size_bytes: u64,
    pub newest_modified_ts: u64,  // most recent mtime in the tree, for staleness
    pub file_count: u64,
}

/// Folder names that indicate regenerable build/dependency output. The `kind`
/// field mirrors this name verbatim so the frontend can group + label.
const ARTIFACT_DIR_NAMES: &[&str] = &[
    "node_modules", "target", "__pycache__", ".venv", "venv",
    ".next", "dist", "build", ".nuxt", ".parcel-cache", ".turbo",
    "bower_components", ".gradle", "Pods",
];

/// Extra-special: `.git` folders that have ballooned past 1 GB almost always
/// need `git gc` or LFS migration. Not a delete candidate — we report as a
/// separate kind so the frontend offers a "run git gc" hint instead.
const GIT_KIND: &str = ".git";

#[tauri::command]
pub async fn scan_build_artifacts(project_paths: Vec<String>) -> Result<Vec<BuildArtifact>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out: Vec<BuildArtifact> = Vec::new();
        for proj in &project_paths {
            let proj_path = std::path::Path::new(proj);
            if !proj_path.exists() { continue; }
            // Walk up to depth 3 under the project — artifacts are at the top.
            walk_for_artifacts(proj_path, proj, 0, 3, &mut out);
        }
        // Sort by size descending so the biggest wins come first in the UI.
        out.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn walk_for_artifacts(
    dir: &std::path::Path,
    project_path: &str,
    depth: u32,
    max_depth: u32,
    out: &mut Vec<BuildArtifact>,
) {
    if depth > max_depth { return; }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() { continue; }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue; };
        // Don't descend into artifact folders themselves; measure and skip.
        if ARTIFACT_DIR_NAMES.iter().any(|n| n.eq_ignore_ascii_case(name)) {
            let (size, newest, count) = measure_tree(&path);
            out.push(BuildArtifact {
                path: path.to_string_lossy().to_string(),
                project_path: project_path.to_string(),
                kind: name.to_string(),
                size_bytes: size,
                newest_modified_ts: newest,
                file_count: count,
            });
            continue;
        }
        // .git is reported only if it's larger than 1 GB (git gc candidate).
        if name.eq_ignore_ascii_case(GIT_KIND) {
            let (size, newest, count) = measure_tree(&path);
            if size > 1024u64.pow(3) {
                out.push(BuildArtifact {
                    path: path.to_string_lossy().to_string(),
                    project_path: project_path.to_string(),
                    kind: GIT_KIND.to_string(),
                    size_bytes: size,
                    newest_modified_ts: newest,
                    file_count: count,
                });
            }
            continue;
        }
        // Recurse into other folders.
        walk_for_artifacts(&path, project_path, depth + 1, max_depth, out);
    }
}

/// Walks a tree fully, summing file sizes, counting files, and tracking the
/// most recent modification time. Reparse points (junctions, symlinks) are
/// skipped to avoid following OneDrive placeholders or cycles.
fn measure_tree(root: &std::path::Path) -> (u64, u64, u64) {
    let mut size = 0u64;
    let mut newest = 0u64;
    let mut count = 0u64;
    let mut stack: Vec<std::path::PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_symlink() { continue; }
            let path = entry.path();
            if ft.is_dir() {
                stack.push(path);
            } else if ft.is_file() {
                count += 1;
                if let Ok(meta) = entry.metadata() {
                    size += meta.len();
                    if let Ok(mtime) = meta.modified() {
                        if let Ok(d) = mtime.duration_since(std::time::UNIX_EPOCH) {
                            let s = d.as_secs();
                            if s > newest { newest = s; }
                        }
                    }
                }
            }
        }
    }
    (size, newest, count)
}

// ---------------------------------------------------------------------------
// Smart Organizer — duplicate file detector
// ---------------------------------------------------------------------------
//
// Two-pass detector:
//   1. Bucket candidate files by exact byte size. Any bucket with < 2 files
//      is dropped — they can't be duplicates of anything.
//   2. For surviving buckets, compute a BLAKE3 hash of each file and group
//      by hash. Groups of size ≥ 2 are duplicates.
//
// The size pre-filter is the single biggest win: on a typical user folder,
// 90%+ of files have unique sizes, so we never hash them. Hash cost is then
// bounded by the count × avg-size of size-colliding groups.
//
// `min_size` is enforced per-file (files smaller than this are ignored
// outright) and defaults to 10 MB on the frontend. Prevents the detector
// from churning through tiny node_modules files.

#[derive(serde::Serialize, Clone, Debug)]
pub struct DuplicateGroup {
    pub hash: String,              // BLAKE3 hex, full 32 bytes
    pub size_bytes: u64,           // each file in this group has this size
    pub paths: Vec<String>,        // ≥ 2 full paths
}

#[tauri::command]
pub async fn find_duplicate_files(
    paths: Vec<String>,
    min_size: Option<u64>,
) -> Result<Vec<DuplicateGroup>, String> {
    let threshold = min_size.unwrap_or(10 * 1024 * 1024); // 10 MB default
    tauri::async_runtime::spawn_blocking(move || {
        use std::collections::HashMap;
        // Pass 1 — bucket by size.
        let mut by_size: HashMap<u64, Vec<String>> = HashMap::new();
        for p in &paths {
            let meta = match std::fs::metadata(p) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if !meta.is_file() { continue; }
            let len = meta.len();
            if len < threshold { continue; }
            by_size.entry(len).or_default().push(p.clone());
        }
        // Pass 2 — hash size-collision groups only.
        let mut out: Vec<DuplicateGroup> = Vec::new();
        for (size, group) in by_size {
            if group.len() < 2 { continue; }
            let mut by_hash: HashMap<String, Vec<String>> = HashMap::new();
            for path in group {
                match hash_file_blake3(&path) {
                    Ok(h) => { by_hash.entry(h).or_default().push(path); }
                    Err(_) => { /* unreadable file — skip, don't fail the whole batch */ }
                }
            }
            for (hash, paths) in by_hash {
                if paths.len() >= 2 {
                    out.push(DuplicateGroup { hash, size_bytes: size, paths });
                }
            }
        }
        // Biggest-reclaim groups first (size × extra-copies).
        out.sort_by(|a, b| {
            let a_reclaim = a.size_bytes * (a.paths.len() as u64 - 1);
            let b_reclaim = b.size_bytes * (b.paths.len() as u64 - 1);
            b_reclaim.cmp(&a_reclaim)
        });
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Stream-hashes a file with BLAKE3. Uses a 64 KB buffer — large enough to
/// amortize syscall overhead, small enough to fit in L1 for most CPUs.
fn hash_file_blake3(path: &str) -> Result<String, String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = blake3::Hasher::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 { break; }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().to_hex().to_string())
}

/// Simple path existence check — used by the organizer to verify whether
/// well-known code-home folders (GitHub, Projects, etc.) exist under the user
/// profile, even if they're too small to appear in the top-by-size scan.
#[tauri::command]
pub async fn check_path_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

/// Reveal a file or folder in Windows Explorer. For files, opens the parent
/// folder and selects the file (via `explorer.exe /select,<path>`). For
/// folders, opens the folder itself. Used by the organizer's file-list rows
/// so the user can inspect a file in Explorer *before* deciding to recycle
/// or move it — opening the file directly would launch the installer / open
/// the archive, which is almost never what the user wants.
#[tauri::command]
pub async fn reveal_in_explorer(path: String) -> Result<(), String> {
    #[cfg(not(windows))]
    {
        let _ = path;
        return Err("reveal_in_explorer is only supported on Windows.".to_string());
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        if path.is_empty() || path.len() > 1024 {
            return Err("Invalid path.".to_string());
        }
        let p = std::path::Path::new(&path);
        if !p.exists() {
            return Err(format!("Path not found: {}", path));
        }

        tauri::async_runtime::spawn_blocking(move || {
            let p = std::path::Path::new(&path);
            // explorer.exe returns non-zero on success in some cases; rely
            // on spawn (fire and forget) rather than waiting on exit status.
            let result = if p.is_file() {
                // explorer.exe's `/select,` is finicky: the PATH must be
                // quoted on its own, NOT the whole "/select,<path>" token.
                // Rust's `.arg()` quotes the entire token when it contains
                // a space (e.g. "C:\UT CS\file.pdf"), producing
                // `"/select,C:\UT CS\file.pdf"` — which explorer mis-parses
                // and falls back to just opening the home folder without
                // selecting. `.raw_arg()` bypasses Rust's quoting so we can
                // emit `/select,"C:\UT CS\file.pdf"` exactly.
                std::process::Command::new("explorer.exe")
                    .raw_arg(format!("/select,\"{}\"", path))
                    .creation_flags(CREATE_NO_WINDOW)
                    .spawn()
            } else {
                std::process::Command::new("explorer.exe")
                    .raw_arg(format!("\"{}\"", path))
                    .creation_flags(CREATE_NO_WINDOW)
                    .spawn()
            };
            result.map(|_| ()).map_err(|e| format!("Failed to open Explorer: {}", e))
        })
        .await
        .map_err(|e| e.to_string())?
    }
}

/// Rename a file in place — keep it in the same folder, swap the stem, keep
/// the original extension. `new_stem` is the user-chosen name WITHOUT
/// extension (the smart-rename suggestions are extension-less). Refuses to
/// overwrite an existing file and rejects path separators in `new_stem` so a
/// "rename" can't move the file elsewhere. Returns the new absolute path.
#[tauri::command]
pub async fn rename_file(path: String, new_stem: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let src = std::path::Path::new(&path);
        if !src.exists() {
            return Err("File not found.".to_string());
        }
        let is_dir = src.is_dir();
        let stem = new_stem.trim();
        if stem.is_empty() {
            return Err("New name is empty.".to_string());
        }
        // No path traversal / directory change — rename stays in-folder.
        if stem.contains('/') || stem.contains('\\') || stem.contains(':')
            || stem == "." || stem == ".." {
            return Err("Name can't contain a path or drive separator.".to_string());
        }
        let parent = src.parent().ok_or("Item has no parent folder.")?;
        // Files keep their extension; folders have no extension to preserve.
        let new_name = if is_dir {
            stem.to_string()
        } else {
            match src.extension().and_then(|e| e.to_str()) {
                Some(e) if !e.is_empty() => format!("{stem}.{e}"),
                _ => stem.to_string(),
            }
        };
        let target = parent.join(&new_name);
        if target == src {
            // No-op rename — treat as success.
            return Ok(target.to_string_lossy().to_string());
        }
        if target.exists() {
            return Err(format!("A {} named \"{new_name}\" already exists here.",
                if is_dir { "folder" } else { "file" }));
        }
        std::fs::rename(src, &target).map_err(|e| format!("Rename failed: {e}"))?;
        Ok(target.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn scratch_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("tmp_walk_test_{}_{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn write_file(dir: &std::path::Path, name: &str, size: usize) {
        let mut f = std::fs::File::create(dir.join(name)).unwrap();
        f.write_all(&vec![b'x'; size]).unwrap();
    }

    // The B5 contract: return the LARGEST max_results files, not the first ones
    // the walker encountered. We exercise the same collect→sort→truncate the
    // command does.
    #[test]
    fn walk_returns_largest_not_first() {
        let dir = scratch_dir("largest");
        write_file(&dir, "a.bin", 1000);
        write_file(&dir, "b.bin", 5000);
        write_file(&dir, "c.bin", 2000);
        write_file(&dir, "d.bin", 4000);
        write_file(&dir, "e.bin", 3000);

        let mut out = Vec::new();
        walk_for_extensions(&dir, &[], &[], 0, 6, 5000, &mut out);
        out.sort_by(|x, y| y.size_bytes.cmp(&x.size_bytes));
        out.truncate(2);

        let sizes: Vec<u64> = out.iter().map(|f| f.size_bytes).collect();
        assert_eq!(sizes, vec![5000, 4000], "must be the two largest files");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn walk_filters_by_extension_and_name() {
        let dir = scratch_dir("filter");
        write_file(&dir, "setup_app.exe", 100);
        write_file(&dir, "install_tool.exe", 50);
        write_file(&dir, "game.exe", 999);        // .exe but not an installer name
        write_file(&dir, "notes.txt", 10);        // wrong extension

        let exts = vec![".exe".to_string()];
        let needles = vec!["setup".to_string(), "install".to_string()];
        let mut out = Vec::new();
        walk_for_extensions(&dir, &exts, &needles, 0, 6, 5000, &mut out);

        let mut names: Vec<String> = out.iter().map(|f| f.name.clone()).collect();
        names.sort();
        assert_eq!(names, vec!["install_tool.exe".to_string(), "setup_app.exe".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn normalize_collapses_teams_variants() {
        assert_eq!(normalize_app_name_key("Microsoft Teams"), "microsoft teams");
        assert_eq!(normalize_app_name_key("Microsoft Teams (work or school)"), "microsoft teams");
        assert_eq!(normalize_app_name_key("  Foo   Bar  "), "foo bar");
        assert_eq!(normalize_app_name_key("App (x64)"), "app");
    }

    #[test]
    fn prefer_measured_over_estimate_then_larger() {
        // A fully-measured row beats a registry estimate even if the estimate is
        // numerically larger (the old merge could keep the stale estimate).
        assert!(prefer_row("registry", 100_000, "measured_total", 40_000));
        // Equal confidence → larger size wins.
        assert!(prefer_row("measured_total", 40_000, "measured_total", 41_000));
        assert!(!prefer_row("measured_total", 41_000, "measured_total", 40_000));
        // A weaker source never displaces a stronger one.
        assert!(!prefer_row("measured_total", 1, "registry", u64::MAX));
    }
}

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
#[tauri::command]
pub async fn move_items_to_folder(
    sources: Vec<String>,
    destination: String,
) -> Result<MoveResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dest = std::path::Path::new(&destination);
        if !dest.exists() {
            std::fs::create_dir_all(dest)
                .map_err(|e| format!("Cannot create destination '{}': {}", destination, e))?;
        }
        let mut moved = 0u32;
        let mut skipped: Vec<String> = Vec::new();
        let mut errors: Vec<String> = Vec::new();

        for src_str in &sources {
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
#[tauri::command]
pub async fn recycle_files(paths: Vec<String>) -> Result<RecycleResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut recycled = 0u32;
        let mut errors: Vec<String> = Vec::new();

        for path_str in &paths {
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
) -> Result<Vec<FoundFile>, String> {
    let max_d = max_depth.unwrap_or(2);
    let max_r = max_results.unwrap_or(100) as usize;
    let exts: Vec<String> = extensions.iter().map(|e| e.to_lowercase()).collect();

    tauri::async_runtime::spawn_blocking(move || {
        let mut results = Vec::new();
        walk_for_extensions(
            &std::path::Path::new(&folder),
            &exts,
            0,
            max_d,
            max_r,
            &mut results,
        );
        // Sort by size descending so the biggest culprits are listed first.
        results.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
        Ok(results)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn walk_for_extensions(
    dir: &std::path::Path,
    exts: &[String],
    depth: u32,
    max_depth: u32,
    max_results: usize,
    results: &mut Vec<FoundFile>,
) {
    if depth > max_depth || results.len() >= max_results {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries {
        if results.len() >= max_results {
            break;
        }
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        if path.is_dir() {
            walk_for_extensions(&path, exts, depth + 1, max_depth, max_results, results);
        } else {
            // Empty `exts` slice means "match every file" — used by the
            // UserFolderExplorer to surface biggest files regardless of type.
            let matches = if exts.is_empty() {
                true
            } else if let Some(ext) = path.extension() {
                let ext_lower = format!(".{}", ext.to_string_lossy().to_lowercase());
                exts.iter().any(|e| e == &ext_lower)
            } else {
                false
            };
            if matches {
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
                std::process::Command::new("explorer.exe")
                    .arg(format!("/select,{}", path))
                    .creation_flags(CREATE_NO_WINDOW)
                    .spawn()
            } else {
                std::process::Command::new("explorer.exe")
                    .arg(&path)
                    .creation_flags(CREATE_NO_WINDOW)
                    .spawn()
            };
            result.map(|_| ()).map_err(|e| format!("Failed to open Explorer: {}", e))
        })
        .await
        .map_err(|e| e.to_string())?
    }
}

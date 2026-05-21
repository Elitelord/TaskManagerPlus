//! Download-on-demand machinery for AI model files (Phase 3, Stage A).
//!
//! Standard / Enhanced tier models are NOT bundled in the installer — the
//! tier is opt-in and defaults to Off, so bundling ~30 MB into every
//! installer would make most users pay for a feature they never enable.
//! Models download from the app's GitHub release assets into the per-user
//! app-data directory on first use.
//!
//! Integrity: every file carries a known size and a BLAKE3 hash compiled
//! into this binary. A download whose hash doesn't match is rejected and
//! the partial file deleted — a corrupt or tampered model never loads.
//!
//! Privacy: the only endpoint is github.com release assets. No third
//! party, no telemetry — the transfer moves a model file TO the user and
//! sends nothing about them. Mirrors the auto-updater's contract.
//!
//! A "model" is a *bundle* of files (the .onnx graph plus its tokenizer);
//! downloading the model means downloading every file in its spec.

use serde::Serialize;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

/// One downloadable file in a model bundle.
pub struct ModelFile {
    /// File name the file is saved as under the models directory.
    pub file_name: &'static str,
    /// HTTPS URL on the app's GitHub release assets.
    pub url: &'static str,
    /// Expected BLAKE3 hash, lowercase hex — the integrity gate.
    pub blake3: &'static str,
    /// Expected size in bytes — lets the UI show a progress total before
    /// the HTTP response headers arrive.
    pub size_bytes: u64,
}

/// A downloadable model — a logical bundle of one or more files (the
/// model graph + its tokenizer for embeddings, etc.).
pub struct ModelSpec {
    /// Stable identifier used by the IPC.
    pub id: &'static str,
    /// Files that make up the bundle; all download together.
    pub files: &'static [ModelFile],
}

/// Registry of downloadable models. Populated after the embedding spike
/// settled on a winner (S-11) and the file was published to a `models-v1`
/// GitHub release (kept as a pre-release so it doesn't hijack the
/// auto-updater's "latest").
pub static MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: "bge-small-en-v1.5",
        files: &[
            ModelFile {
                file_name: "bge-small-en-v1.5.onnx",
                url: "https://github.com/Elitelord/TaskManagerPlus/releases/download/models-v1/bge-small-en-v1.5.onnx",
                blake3: "0a560ffc62558579614d9044e18ec86e2f05d2b29fa60070f8e165d475e77e1f",
                size_bytes: 34_014_426,
            },
            ModelFile {
                file_name: "bge-small-en-v1.5.tokenizer.json",
                url: "https://github.com/Elitelord/TaskManagerPlus/releases/download/models-v1/bge-small-en-v1.5.tokenizer.json",
                blake3: "6e933bf59db40b8b2a0de480fe5006662770757e1e1671eb7e48ff6a5f00b0b4",
                size_bytes: 711_396,
            },
        ],
    },
];

/// Look up a model spec by id.
pub fn find_model(id: &str) -> Option<&'static ModelSpec> {
    MODELS.iter().find(|m| m.id == id)
}

/// Directory downloaded models live in: `<app-local-data>/models`,
/// created if absent.
pub fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let dir = base.join("models");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// On-disk path for a single model file.
pub fn file_path(app: &AppHandle, file: &ModelFile) -> Result<PathBuf, String> {
    Ok(models_dir(app)?.join(file.file_name))
}

/// True when every file in the spec is present on disk.
pub fn is_installed(app: &AppHandle, spec: &ModelSpec) -> bool {
    spec.files.iter().all(|f| {
        file_path(app, f).map(|p| p.exists()).unwrap_or(false)
    })
}

/// Total bytes of every file in the spec.
pub fn total_size(spec: &ModelSpec) -> u64 {
    spec.files.iter().map(|f| f.size_bytes).sum()
}

/// Progress payload — emitted on the `ai-model-download` event channel
/// for every progress tick of any file in the bundle.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub model_id: String,
    pub file_name: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub done: bool,
}

const PROGRESS_EVENT: &str = "ai-model-download";

/// Download every file in `spec` into the models directory, verifying each
/// BLAKE3 hash. Blocking — must be called from a worker thread, never an
/// async executor. Emits `DownloadProgress` events for each file.
pub fn download_blocking(app: &AppHandle, spec: &ModelSpec) -> Result<(), String> {
    for f in spec.files {
        download_file(app, spec.id, f)?;
    }
    Ok(())
}

/// Download one file with progress + integrity check.
fn download_file(app: &AppHandle, model_id: &str, f: &ModelFile) -> Result<PathBuf, String> {
    let final_path = file_path(app, f)?;
    // Already present and intact — nothing to do.
    if final_path.exists() && file_blake3(&final_path)? == f.blake3 {
        emit(app, model_id, f, f.size_bytes, f.size_bytes, true);
        return Ok(final_path);
    }

    let part_path = final_path.with_extension("part");
    let resp = reqwest::blocking::get(f.url).map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("download failed: HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(f.size_bytes);

    let mut reader = resp;
    let mut file = std::fs::File::create(&part_path).map_err(|e| e.to_string())?;
    let mut hasher = blake3::Hasher::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut downloaded: u64 = 0;
    let mut last_emit: u64 = 0;

    loop {
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        let chunk = &buf[..n];
        file.write_all(chunk).map_err(|e| e.to_string())?;
        hasher.update(chunk);
        downloaded += n as u64;
        // Throttle progress events to roughly every 512 KB.
        if downloaded - last_emit >= 512 * 1024 {
            emit(app, model_id, f, downloaded, total, false);
            last_emit = downloaded;
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);

    let got = hasher.finalize().to_hex().to_string();
    if got != f.blake3 {
        let _ = std::fs::remove_file(&part_path);
        return Err(format!(
            "integrity check failed for {}/{} — expected {}, got {}",
            model_id, f.file_name, f.blake3, got,
        ));
    }
    std::fs::rename(&part_path, &final_path).map_err(|e| e.to_string())?;
    emit(app, model_id, f, downloaded, total, true);
    Ok(final_path)
}

fn emit(
    app: &AppHandle,
    model_id: &str,
    f: &ModelFile,
    downloaded: u64,
    total: u64,
    done: bool,
) {
    let _ = app.emit(
        PROGRESS_EVENT,
        DownloadProgress {
            model_id: model_id.to_string(),
            file_name: f.file_name.to_string(),
            downloaded_bytes: downloaded,
            total_bytes: total,
            done,
        },
    );
}

/// BLAKE3 hash of a file on disk, lowercase hex.
pub fn file_blake3(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = blake3::Hasher::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().to_hex().to_string())
}

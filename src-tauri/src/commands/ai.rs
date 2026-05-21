//! Tauri command handlers for the AI subsystem.
//!
//! Phase 1: tier read/write plus stubs for the future inference commands.
//! Real implementations land in later phases — see
//! `docs/AI_INTEGRATION_PLAN.md` §4. Stubs return shapes the frontend can
//! consume so the UI codepaths can be wired up before models exist.

use crate::ai::{self, types::{AiStatus, AiTier}};
use serde::Serialize;

#[tauri::command]
pub fn ai_get_status() -> AiStatus {
    ai::get_status()
}

#[tauri::command]
pub fn ai_set_tier(tier: AiTier) -> Result<AiStatus, String> {
    ai::set_tier(tier);
    Ok(ai::get_status())
}

// ---------------------------------------------------------------------------
// Stubs for inference commands — wired into the invoke handler so the
// frontend can call them today, and Phase 2/3 implementations slot in
// without further IPC churn. Each returns a "no result" shape when the
// model isn't loaded (which is always, in Phase 1).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassificationResult {
    pub category: Option<String>,
    pub confidence: Option<f32>,
}

#[tauri::command]
pub fn ai_classify_process(_name: String) -> ClassificationResult {
    // Phase 2 will replace this with a real inference call.
    ClassificationResult { category: None, confidence: None }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeakClassification {
    pub class: Option<String>,
    pub confidence: Option<f32>,
}

#[tauri::command]
pub fn ai_classify_leak(memory_series: Vec<f32>) -> LeakClassification {
    // Observability (Stage 5): the leak classifier is the only on-device
    // inference path in the app. Time it at debug level — cheap, and enough
    // to spot a pathological series in logs. A full diagnostics subsystem
    // was deliberately not built (see spike S-9): one ~4 KB decision tree
    // running sub-millisecond does not warrant per-feature timing UI.
    let started = std::time::Instant::now();
    let result = crate::ai::classifiers::leak::classify(&memory_series);
    log::debug!(
        "ai_classify_leak: {} samples -> {:?} in {:?}",
        memory_series.len(),
        result.as_ref().map(|v| v.class.as_str()),
        started.elapsed(),
    );
    match result {
        Some(v) => LeakClassification {
            class: Some(v.class),
            confidence: Some(v.confidence),
        },
        None => LeakClassification { class: None, confidence: None },
    }
}

// NOTE: S1 (project-folder classification) ultimately shipped as
// transparent rules in TS (`src/lib/projectFolder.ts`) rather than a
// bundled model — see spike S-5 in docs/AI_INTEGRATION_PLAN.md §7.8. This
// command stays a stub; nothing in the app routes through it.
#[tauri::command]
pub fn ai_classify_project_folder(_folder_path: String) -> ClassificationResult {
    ClassificationResult { category: None, confidence: None }
}

// ---------------------------------------------------------------------------
// Phase 3 — download-on-demand of AI model files. The Standard/Enhanced
// embedding models are fetched from GitHub release assets on first use
// rather than bundled in the installer. See `ai::model_download`.
// ---------------------------------------------------------------------------

/// Download a registered model. Emits `ai-model-download` progress events;
/// resolves when the file is on disk and its hash verified.
#[tauri::command]
pub async fn ai_download_model(app: tauri::AppHandle, model_id: String) -> Result<(), String> {
    let spec = crate::ai::model_download::find_model(&model_id)
        .ok_or_else(|| format!("unknown model: {model_id}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::ai::model_download::download_blocking(&app, spec)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub model_id: String,
    pub installed: bool,
    pub size_bytes: u64,
}

/// Report which registered models are present on disk. A model bundle is
/// `installed` only when every file in its spec exists locally.
#[tauri::command]
pub fn ai_model_status(app: tauri::AppHandle) -> Vec<ModelStatus> {
    crate::ai::model_download::MODELS
        .iter()
        .map(|spec| ModelStatus {
            model_id: spec.id.to_string(),
            installed: crate::ai::model_download::is_installed(&app, spec),
            size_bytes: crate::ai::model_download::total_size(spec),
        })
        .collect()
}

/// Embed text with the bundled embedding model (Phase 3 / S4). Returns one
/// mean-pooled, L2-normalised vector per input. Errors if the embedding
/// model has not been downloaded yet.
#[tauri::command]
pub async fn ai_embed_text(
    app: tauri::AppHandle,
    texts: Vec<String>,
) -> Result<Vec<Vec<f32>>, String> {
    let dir = crate::ai::model_download::models_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::ai::embeddings::embed_texts(&dir, &texts)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Embed FILES — extract a text snippet from each path Rust-side, then
/// embed "filename + content". The S4 building block: one IPC call
/// returns vectors ready for clustering, keeping document text on-device
/// (never crossing into the webview).
#[tauri::command]
pub async fn ai_embed_files(
    app: tauri::AppHandle,
    file_paths: Vec<String>,
) -> Result<Vec<Vec<f32>>, String> {
    let dir = crate::ai::model_download::models_dir(&app)?;
    let cache_path = crate::ai::embedding_cache::cache_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        use rayon::prelude::*;
        use std::time::Instant;

        let n = file_paths.len();
        let t_total = Instant::now();

        // Load persistent cache and split inputs into hits vs misses. The
        // cache is the Stage D optimization — every successful embed lands
        // here keyed by `(path, mtime, size)`, so a second scan over the
        // same files pays no extract/embed cost.
        let mut cache = crate::ai::embedding_cache::EmbeddingCache::load(&cache_path);

        let mut result: Vec<Option<Vec<f32>>> = vec![None; n];
        let mut miss_indices: Vec<usize> = Vec::new();
        for (i, p) in file_paths.iter().enumerate() {
            if let Some(v) = cache.get_if_fresh(p) {
                result[i] = Some(v);
            } else {
                miss_indices.push(i);
            }
        }
        let hits = n - miss_indices.len();

        if !miss_indices.is_empty() {
            // Extract + embed only the misses. Parallel extraction —
            // PDF/docx parsing is the slow phase and is embarrassingly
            // parallel across files. Embedding still runs sequentially
            // behind the Mutex<Embedder>, but it's the fast phase.
            let miss_paths: Vec<&String> =
                miss_indices.iter().map(|&i| &file_paths[i]).collect();
            let texts: Vec<String> = miss_paths
                .par_iter()
                .map(|p| {
                    let t_file = Instant::now();
                    let path = std::path::PathBuf::from(p.as_str());
                    let name = path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("")
                        .to_string();
                    let content = crate::ai::text_extract::extract_text(&path);
                    let elapsed = t_file.elapsed();
                    if elapsed.as_millis() > 1000 {
                        // Only log files that took >1s to extract — these
                        // are the files where the watchdog and size gate
                        // didn't kick in fast enough; useful diagnostic
                        // signal without per-file noise.
                        eprintln!("[ai_embed] slow extract {} ms - {}",
                                  elapsed.as_millis(), p);
                    }
                    if content.is_empty() {
                        name
                    } else {
                        format!("{name}\n{content}")
                    }
                })
                .collect();

            let new_vecs = crate::ai::embeddings::embed_texts(&dir, &texts)?;

            // Write the freshly-computed vectors back into the cache and
            // into the result slots they came from.
            for (idx, vec) in miss_indices.iter().zip(new_vecs) {
                cache.insert(&file_paths[*idx], vec.clone());
                result[*idx] = Some(vec);
            }
        }

        // Persist (with eviction). Errors here are logged inside save();
        // they never break the embed pass — the cache is an optimization,
        // not a correctness layer.
        cache.trim();
        cache.save(&cache_path);

        // One summary line per call. Tells the user (in the dev terminal)
        // how warm the cache is and whether we're paying for fresh embeds.
        eprintln!("[ai_embed] {} files: {} hits, {} misses, {} ms total",
                  n, hits, miss_indices.len(), t_total.elapsed().as_millis());

        // Every slot should be Some by now — if a slot is None it means
        // a cache hit lookup succeeded but a parallel write didn't (which
        // can't happen here since the iterators are sequential). Defensive
        // unwrap with an explicit error rather than a panic.
        result
            .into_iter()
            .enumerate()
            .map(|(i, v)| {
                v.ok_or_else(|| format!("embedding missing for index {i}"))
            })
            .collect::<Result<Vec<_>, _>>()
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Drop every cached embedding vector. Settings → "Clear AI cache" wires
/// into this; the next scan pays the full cold-cache cost. Returns the
/// count of cleared entries for the UI to confirm.
#[tauri::command]
pub async fn ai_clear_embedding_cache(app: tauri::AppHandle) -> Result<usize, String> {
    let cache_path = crate::ai::embedding_cache::cache_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut cache = crate::ai::embedding_cache::EmbeddingCache::load(&cache_path);
        let n = cache.len();
        cache.clear();
        cache.save(&cache_path);
        Ok(n)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Snapshot of the embedding cache state — count of stored entries for
/// the Settings UI. Cheap read (no extract or embed).
#[tauri::command]
pub async fn ai_embedding_cache_stats(app: tauri::AppHandle) -> Result<usize, String> {
    let cache_path = crate::ai::embedding_cache::cache_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let cache = crate::ai::embedding_cache::EmbeddingCache::load(&cache_path);
        Ok(cache.len())
    })
    .await
    .map_err(|e| e.to_string())?
}

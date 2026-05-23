//! Tauri command handlers for the AI subsystem.
//!
//! Phase 1: tier read/write plus stubs for the future inference commands.
//! Real implementations land in later phases — see
//! `docs/AI_INTEGRATION_PLAN.md` §4. Stubs return shapes the frontend can
//! consume so the UI codepaths can be wired up before models exist.

use crate::ai::{self, types::{AiStatus, AiTier}};
use serde::{Deserialize, Serialize};

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

/// Remove a registered model's files from disk. Settings → "Delete
/// model" wires here when the user wants to reclaim the disk after
/// turning AI off (or to force a clean re-download). Returns the
/// count of files removed for UI confirmation.
#[tauri::command]
pub async fn ai_delete_model(app: tauri::AppHandle, model_id: String) -> Result<usize, String> {
    let spec = crate::ai::model_download::find_model(&model_id)
        .ok_or_else(|| format!("unknown model: {model_id}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::ai::model_download::delete_model(&app, spec)
    })
    .await
    .map_err(|e| e.to_string())?
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

            // Embed the whole batch at once. Phase 4 removed the
            // embedder mutex (OnceLock + concurrent embed) and made the
            // embed loop itself parallel via rayon, so chunking is no
            // longer needed for interactive responsiveness — search
            // runs truly concurrent with the batch embed, no mutex
            // contention to manage.
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

/// Pre-warm the embedder — load the model into the process-wide cache
/// so the first user-initiated search after app launch isn't cold-load
/// slow (2-5 seconds during which the mutex is held and any concurrent
/// search returns EMBEDDER_BUSY).
///
/// Called from the frontend on app launch when the AI tier is Standard,
/// and whenever the user transitions Off → Standard. No-op when the
/// model isn't installed yet; the install flow downloads then triggers
/// this same command.
#[tauri::command]
pub async fn ai_prewarm_embedder(app: tauri::AppHandle) -> Result<(), String> {
    let dir = crate::ai::model_download::models_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::ai::embeddings::ensure_loaded(&dir)
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

// ───────────────────────────────────────────────────────────────────────────
// Phase 4 — S7 / S9 semantic file search.
//
// One ranked search result: an absolute path plus the cosine similarity
// between the query (or seed-file) vector and the file's cached vector.
// Returned to the frontend over IPC.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    /// Cosine similarity in [-1, 1]; for normalised embeddings, typically
    /// in [0, 1]. Higher = more similar.
    pub score: f32,
}

/// Cosine similarity between two equal-length vectors. Inputs are assumed
/// L2-normalised by the embedder (which our `embed_texts` guarantees), so
/// the dot product IS the cosine.
fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let mut s = 0.0;
    for i in 0..a.len().min(b.len()) {
        s += a[i] * b[i];
    }
    s
}

/// Absolute floor for cosine similarity. Below this, two L2-normalised
/// embeddings are too different to surface as a search hit — anything
/// here is noise that pads the result list and erodes user trust.
///
/// Calibrated against bge-small-en-v1.5's empirical score distribution:
/// true topic matches sit at 0.65+, single-word queries like "vancouver"
/// matching a content-rich file usually score 0.50–0.65, and "both
/// files are English PDFs" generic similarity sits at 0.30–0.45.
///
/// Tuning history:
///   • 0.30 — first cut, too generous, padded results with noise
///   • 0.50 — second cut, too strict, dropped legitimate single-word
///     query matches ("vancouver" returning empty)
///   • 0.45 — current. Splits the difference: keeps single-word query
///     hits while still dropping pure-noise PDF-vs-PDF similarity.
const MIN_COSINE_FLOOR: f32 = 0.45;

/// Adaptive cutoff: drop results that score more than this much below
/// the top hit. Tightened from 0.30 → 0.20 to keep result lists from
/// padding with marginal matches when the best hit is strong. So if
/// the top hit is 0.85, only results above 0.65 surface; if the top is
/// 0.65, only above 0.50 (clamped by the absolute floor).
const ADAPTIVE_COSINE_GAP: f32 = 0.20;

/// Score boost given to files whose basename contains the query string
/// as a substring (case-insensitive, after collapsing whitespace and
/// removing punctuation). The boost forces the score into the [0.95, 1.0]
/// range, guaranteeing lexical matches always appear in the top results
/// regardless of how the embedder rates them.
///
/// Why this matters: a query like "Lecture 10" against a file literally
/// named "Lecture10_M362K.pdf" should be a guaranteed hit, but the
/// embedder's representation of short numeric phrases is weak — the
/// cosine score is often below the 0.45 floor. Hybrid retrieval
/// (semantic + lexical) is the standard fix used by Spotlight, Windows
/// Search, etc.
const LEXICAL_MATCH_SCORE_FLOOR: f32 = 0.95;

/// Normalise a string for substring matching: lowercase, replace any
/// non-alphanumeric run with a single space, collapse whitespace.
///
/// This means "lecture 10" matches "Lecture10_M362K.pdf" (the underscore
/// becomes a space and "lecture10" → "lecture 10"). It also means
/// "homework 3" matches "Homework-3-pages.pdf" but does NOT match
/// "homework30.pdf" — substring on tokens, not raw bytes.
fn normalise_for_lexical(s: &str) -> String {
    let lower = s.to_lowercase();
    let mut out = String::with_capacity(lower.len() + 4);
    out.push(' '); // sentinel so word-start matches work
    let mut last_was_space = true;
    for c in lower.chars() {
        if c.is_alphanumeric() {
            out.push(c);
            last_was_space = false;
        } else if !last_was_space {
            out.push(' ');
            last_was_space = true;
        }
    }
    if !last_was_space { out.push(' '); }
    // Pad alphanumeric/numeric boundaries — "lecture10" becomes "lecture
    // 10" so a query for "lecture 10" hits as a substring. Without this
    // the filename's numbers run together with letters and we miss the
    // most common real-world case.
    let mut padded = String::with_capacity(out.len() * 2);
    let mut prev: Option<char> = None;
    for c in out.chars() {
        if let Some(p) = prev {
            let p_alpha = p.is_alphabetic();
            let c_alpha = c.is_alphabetic();
            let p_num = p.is_numeric();
            let c_num = c.is_numeric();
            if (p_alpha && c_num) || (p_num && c_alpha) {
                padded.push(' ');
            }
        }
        padded.push(c);
        prev = Some(c);
    }
    padded
}

/// Rank every cached embedding by cosine to `query_vec`, with hybrid
/// lexical boosting when `query_text` is provided. Filters:
///   • entries whose file no longer exists at the recorded path,
///   • the seed file itself when given (S9 should never return its
///     own seed),
///   • anything below `MIN_COSINE_FLOOR` UNLESS its basename contains
///     the query as a substring (lexical hits always pass),
///   • anything more than `ADAPTIVE_COSINE_GAP` below the top hit.
///
/// Lexical-match files get their score clamped up to at least
/// `LEXICAL_MATCH_SCORE_FLOOR` so direct filename hits always sort to
/// the top. This is what makes "Lecture 10" reliably surface
/// "Lecture10_M362K.pdf" even when the embedder's cosine score for
/// that pair is below the floor.
///
/// Returns up to `k` hits sorted by score descending.
fn rank_cache_by_vector(
    cache: &crate::ai::embedding_cache::EmbeddingCache,
    query_text: Option<&str>,
    query_vec: &[f32],
    k: usize,
    exclude_path: Option<&str>,
) -> Vec<SearchHit> {
    // Precompute the normalised query needle for lexical matching. We
    // normalise both sides identically (lowercase, alphanumeric runs
    // separated by spaces, alpha/num boundary inserts a space) so
    // "lecture 10" matches "Lecture10_*.pdf".
    let needle = query_text.map(normalise_for_lexical);
    // Trim sentinel spaces for the actual contains() check.
    let needle_trimmed = needle.as_deref().map(str::trim).filter(|n| !n.is_empty());

    let mut hits: Vec<SearchHit> = cache
        .iter()
        .filter_map(|(path, entry)| {
            if Some(path.as_str()) == exclude_path {
                return None;
            }
            if !std::path::Path::new(path).exists() {
                return None;
            }
            let cosine_score = cosine(query_vec, &entry.vec);

            // Hybrid: check if the filename literally contains the query
            // (after normalisation). Lexical matches bypass the cosine
            // floor and get boosted to ensure they sort to the top.
            let lexical_hit = match needle_trimmed {
                Some(n) => {
                    let basename = std::path::Path::new(path)
                        .file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or("");
                    normalise_for_lexical(basename).contains(n)
                }
                None => false,
            };

            if lexical_hit {
                // Score = max(cosine, lexical floor). Multiple lexical
                // hits still sort relative to each other by their cosine,
                // so a file that BOTH matches the filename AND embeds
                // close to the query stays above one that only matches
                // the filename.
                Some(SearchHit {
                    path: path.clone(),
                    score: cosine_score.max(LEXICAL_MATCH_SCORE_FLOOR),
                })
            } else if cosine_score >= MIN_COSINE_FLOOR {
                Some(SearchHit { path: path.clone(), score: cosine_score })
            } else {
                None
            }
        })
        .collect();
    hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));

    // Adaptive cutoff relative to the top hit. Lexical hits with their
    // score=0.95+ shift the cutoff aggressively, which is fine — when
    // there's a direct filename match we don't want mediocre semantic
    // matches diluting the result list.
    if let Some(top) = hits.first() {
        let cutoff = top.score - ADAPTIVE_COSINE_GAP;
        hits.retain(|h| h.score >= cutoff);
    }

    hits.truncate(k);
    hits
}

/// S7 — Intent-based file search. Embeds the user's natural-language
/// query, then ranks every cached file embedding by cosine similarity.
///
/// Returns an empty vec (not an error) when the cache is cold — the
/// frontend can render an empty-state "scan first to populate the
/// index" message rather than treating it as a failure.
#[tauri::command]
pub async fn ai_search_text(
    app: tauri::AppHandle,
    query: String,
    k: usize,
) -> Result<Vec<SearchHit>, String> {
    let trimmed = query.trim().to_string();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let dir = crate::ai::model_download::models_dir(&app)?;
    let cache_path = crate::ai::embedding_cache::cache_path(&app)?;
    let k = k.clamp(1, 200);

    tauri::async_runtime::spawn_blocking(move || {
        // Embed the query (single text) via the non-blocking variant —
        // if a Storage scan is mid-embed of a batch, return EMBEDDER_BUSY
        // immediately instead of blocking the user's search behind a
        // multi-minute scan. The frontend translates this to a friendly
        // "scan in progress" message.
        let mut vecs = crate::ai::embeddings::try_embed_texts(&dir, &[trimmed.clone()])?;
        let query_vec = vecs.pop().ok_or_else(|| "empty query embedding".to_string())?;

        let cache = crate::ai::embedding_cache::EmbeddingCache::load(&cache_path);
        // Pass the query text as well as the vector so rank_cache_by_vector
        // can do lexical (filename substring) matching alongside semantic
        // cosine. This is what makes single-word and short-phrase queries
        // like "Lecture 10" reliably surface "Lecture10_M362K.pdf" even
        // when the embedder's cosine for that pair is below the floor.
        Ok(rank_cache_by_vector(&cache, Some(&trimmed), &query_vec, k, None))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// S9 — "Files like this." Looks up the seed file's cached vector, then
/// ranks the rest of the cache by cosine to it. Falls back gracefully:
/// if the seed file isn't in the cache yet (cache cold for this path),
/// returns an empty vec — the frontend can prompt for a re-scan.
#[tauri::command]
pub async fn ai_search_similar(
    app: tauri::AppHandle,
    seed_path: String,
    k: usize,
) -> Result<Vec<SearchHit>, String> {
    let cache_path = crate::ai::embedding_cache::cache_path(&app)?;
    let k = k.clamp(1, 200);

    tauri::async_runtime::spawn_blocking(move || {
        let cache = crate::ai::embedding_cache::EmbeddingCache::load(&cache_path);
        let seed_vec = match cache.get_if_fresh(&seed_path) {
            Some(v) => v,
            None => return Ok(Vec::new()),
        };
        // S9 (similar) has no query text — only the seed vector. Lexical
        // matching doesn't apply; we want pure semantic similarity to
        // the seed file.
        Ok(rank_cache_by_vector(&cache, None, &seed_vec, k, Some(&seed_path)))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ───────────────────────────────────────────────────────────────────────────
// Phase 4 / S10 — per-file tag classification.
//
// Given a curated tag vocabulary (id + natural-language query), embeds
// each query once, then assigns every cached file to its single best-
// matching tag (above a floor). Returns tag → files. This is the real
// auto-classification: each file lands under ONE tag (its best match),
// not scattered across every tag whose preset query happens to retrieve
// it. The frontend renders chips with counts + an inline expandable
// file list — no per-click search latency.

/// One tag definition sent from the frontend (mirrors TS `TagDef`).
#[derive(Debug, Clone, Deserialize)]
pub struct TagInput {
    pub id: String,
    pub query: String,
}

/// Files classified under one tag.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagResult {
    pub tag_id: String,
    pub files: Vec<SearchHit>,
}

/// Minimum cosine for a file to be assigned to its best tag. Below this,
/// the file is "untagged" — no tag is a good enough fit. Tuned to the
/// same regime as search: genuine topical matches sit at 0.45+, generic
/// similarity below.
const TAG_ASSIGN_FLOOR: f32 = 0.42;

/// S10 — classify every cached file to its single best-matching tag.
/// Embeds each tag query once, scores every file against every tag,
/// assigns each file to its argmax tag (if above the floor), and groups
/// the results. Files within a tag are sorted by score descending.
#[tauri::command]
pub async fn ai_tag_files(
    app: tauri::AppHandle,
    tags: Vec<TagInput>,
) -> Result<Vec<TagResult>, String> {
    if tags.is_empty() {
        return Ok(Vec::new());
    }
    let dir = crate::ai::model_download::models_dir(&app)?;
    let cache_path = crate::ai::embedding_cache::cache_path(&app)?;

    tauri::async_runtime::spawn_blocking(move || {
        // Embed all tag queries in one batch (parallel via embed_texts).
        let queries: Vec<String> = tags.iter().map(|t| t.query.clone()).collect();
        let tag_vecs = crate::ai::embeddings::try_embed_texts(&dir, &queries)?;
        if tag_vecs.len() != tags.len() {
            return Err("tag embedding count mismatch".into());
        }

        let cache = crate::ai::embedding_cache::EmbeddingCache::load(&cache_path);

        // For each file, find its best tag (argmax cosine). Assign only
        // if the best score clears the floor.
        let mut buckets: std::collections::HashMap<usize, Vec<SearchHit>> =
            std::collections::HashMap::new();
        for (path, entry) in cache.iter() {
            if !std::path::Path::new(path).exists() {
                continue;
            }
            let mut best_tag = 0usize;
            let mut best_score = f32::MIN;
            for (ti, tv) in tag_vecs.iter().enumerate() {
                let s = cosine(&entry.vec, tv);
                if s > best_score {
                    best_score = s;
                    best_tag = ti;
                }
            }
            if best_score >= TAG_ASSIGN_FLOOR {
                buckets
                    .entry(best_tag)
                    .or_default()
                    .push(SearchHit { path: path.clone(), score: best_score });
            }
        }

        // Assemble results in the input tag order; sort each bucket by
        // score descending. Tags with no files are omitted.
        let mut out: Vec<TagResult> = Vec::new();
        for (ti, tag) in tags.iter().enumerate() {
            if let Some(mut files) = buckets.remove(&ti) {
                files.sort_by(|a, b| {
                    b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal)
                });
                out.push(TagResult { tag_id: tag.id.clone(), files });
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ───────────────────────────────────────────────────────────────────────────
// Phase 4 / S11 — cross-folder version tracking.
//
// Walks the FULL on-disk embedding cache (not just the current scan's
// in-memory subset) and finds high-cosine pairs. Catches the case where
// the same logical document lives under multiple names in different
// folders / from different scans — e.g. "Resume Spring 2025.pdf" in
// Documents and "current-resume.pdf" in Desktop. The JS-side S5 only
// sees what's in the current scan's embedding batch (max 200 files);
// this widens coverage to everything that's ever been indexed.

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionGroup {
    /// Paths of the files in this near-duplicate group. Sorted with the
    /// most-recently-modified file first so the caller can use it as a
    /// reasonable default for "the canonical one".
    pub paths: Vec<String>,
    /// Mean pairwise cosine similarity among the group's members.
    pub similarity: f32,
}

/// Threshold for S11 version detection. Deliberately LOWER than S5's
/// exact-near-dup cut (0.95): S5 catches re-saves and metadata-only
/// diffs (essentially byte-twins), but a genuine version STACK — resume
/// v1 vs v2 with real edits, a draft vs final — has meaningfully
/// different content and lands around 0.85–0.93 cosine. 0.88 captures
/// those without pulling in merely-same-topic files (which sit ~0.75).
const VERSION_THRESHOLD: f32 = 0.88;

/// Minimum filename-token Jaccard for two files to be the same logical
/// document. Mirrors the JS-side gate (FILENAME_SIM_THRESHOLD). Content
/// cosine alone groups distinct-but-similar docs (Lecture12 vs Lecture32,
/// different schools' application files) as versions; requiring a similar
/// filename fixes those false positives.
const VERSION_FILENAME_SIM: f32 = 0.7;

/// Tokenise a filename for similarity: strip extension + copy-markers
/// ("(1)", "- copy", "_final", "_v2"), lowercase, split on non-alnum and
/// at letter/digit boundaries. So "Lecture13_M362K (1).pdf" and
/// "Lecture13_M362K.pdf" yield the same token set.
fn filename_tokens(name: &str) -> std::collections::HashSet<String> {
    let mut s = name.to_lowercase();
    // strip extension
    if let Some(dot) = s.rfind('.') {
        s.truncate(dot);
    }
    // strip a trailing " (N)" copy marker
    if let Some(idx) = s.rfind('(') {
        let tail = &s[idx..];
        if tail.starts_with('(') && tail.ends_with(')')
            && tail[1..tail.len() - 1].chars().all(|c| c.is_ascii_digit())
        {
            s.truncate(idx);
        }
    }
    // insert spaces at letter/digit boundaries
    let mut spaced = String::with_capacity(s.len() + 8);
    let mut prev: Option<char> = None;
    for c in s.chars() {
        if let Some(p) = prev {
            if (p.is_ascii_alphabetic() && c.is_ascii_digit())
                || (p.is_ascii_digit() && c.is_ascii_alphabetic())
            {
                spaced.push(' ');
            }
        }
        spaced.push(c);
        prev = Some(c);
    }
    spaced
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        // drop the common version markers as standalone tokens
        .filter(|t| !matches!(*t, "copy" | "final" | "draft"))
        .map(|t| t.to_string())
        .collect()
}

/// Jaccard similarity of two filenames' token sets.
fn filename_similarity(a: &str, b: &str) -> f32 {
    let ta = filename_tokens(a);
    let tb = filename_tokens(b);
    if ta.is_empty() && tb.is_empty() {
        return 1.0;
    }
    if ta.is_empty() || tb.is_empty() {
        return 0.0;
    }
    let inter = ta.intersection(&tb).count();
    let union = ta.len() + tb.len() - inter;
    if union > 0 { inter as f32 / union as f32 } else { 0.0 }
}

/// Basename of a path (after the last `\` or `/`).
fn path_basename(p: &str) -> &str {
    let cut = p.rfind(['\\', '/']).map(|i| i + 1).unwrap_or(0);
    &p[cut..]
}

/// Walks the cache, finds pairs ≥ VERSION_THRESHOLD, transitively unions
/// them, returns groups of ≥ 2 files. Each group is sorted by mtime
/// (most recent first) so callers can pick the freshest as the canonical
/// version. Skips entries whose file no longer exists.
#[tauri::command]
pub async fn ai_find_versions(app: tauri::AppHandle) -> Result<Vec<VersionGroup>, String> {
    let cache_path = crate::ai::embedding_cache::cache_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let cache = crate::ai::embedding_cache::EmbeddingCache::load(&cache_path);

        // Materialise (path, mtime, vec) for entries whose files still
        // exist on disk. Anything missing was renamed/deleted between
        // scans and shouldn't surface as a "version".
        let entries: Vec<(String, u64, Vec<f32>)> = cache
            .iter()
            .filter_map(|(path, entry)| {
                if !std::path::Path::new(path).exists() {
                    return None;
                }
                Some((path.clone(), entry.mtime_s, entry.vec.clone()))
            })
            .collect();
        let n = entries.len();
        if n < 2 {
            return Ok(Vec::new());
        }

        // Union-find: each entry starts in its own group, merges with
        // any peer whose cosine clears VERSION_THRESHOLD. The structure
        // is the same as the JS-side `findNearDuplicateGroups` — kept
        // server-side here because we're operating on the full cache,
        // which the JS layer doesn't have access to.
        let mut parent: Vec<usize> = (0..n).collect();
        fn find(parent: &mut Vec<usize>, mut x: usize) -> usize {
            while parent[x] != x {
                parent[x] = parent[parent[x]]; // path compression
                x = parent[x];
            }
            x
        }

        // Pair scores collected as we go so we can compute per-group
        // mean similarity at the end without re-scanning.
        let mut pair_scores: Vec<(usize, usize, f32)> = Vec::new();
        for i in 0..n {
            for j in (i + 1)..n {
                // Filename gate first (cheap, and the precision signal):
                // distinct documents on the same topic (Lecture12 vs
                // Lecture32) share content but not filenames.
                let name_sim = filename_similarity(
                    path_basename(&entries[i].0),
                    path_basename(&entries[j].0),
                );
                if name_sim < VERSION_FILENAME_SIM {
                    continue;
                }
                let sim = cosine(&entries[i].2, &entries[j].2);
                if sim >= VERSION_THRESHOLD {
                    let ri = find(&mut parent, i);
                    let rj = find(&mut parent, j);
                    if ri != rj { parent[ri] = rj; }
                    pair_scores.push((i, j, sim));
                }
            }
        }
        if pair_scores.is_empty() {
            return Ok(Vec::new());
        }

        // Bucket entries by group root, but only entries that actually
        // participated in a pair (otherwise everyone in the cache would
        // land in a trivial singleton group at their own root).
        let mut touched = vec![false; n];
        for &(i, j, _) in &pair_scores {
            touched[i] = true;
            touched[j] = true;
        }

        use std::collections::HashMap;
        let mut groups: HashMap<usize, (Vec<usize>, Vec<f32>)> = HashMap::new();
        for (i, t) in touched.iter().enumerate() {
            if !*t { continue; }
            let r = find(&mut parent, i);
            groups.entry(r).or_default().0.push(i);
        }
        for &(i, _, sim) in &pair_scores {
            let r = find(&mut parent, i);
            if let Some(g) = groups.get_mut(&r) { g.1.push(sim); }
        }

        let mut out: Vec<VersionGroup> = groups
            .into_values()
            .filter(|(members, _)| members.len() >= 2)
            .map(|(mut members, sims)| {
                // Sort by mtime descending — most recently modified
                // first, so a UI consuming the group can default to
                // keeping the freshest copy.
                members.sort_by_key(|&i| std::cmp::Reverse(entries[i].1));
                let mean = sims.iter().sum::<f32>() / sims.len().max(1) as f32;
                VersionGroup {
                    paths: members.into_iter().map(|i| entries[i].0.clone()).collect(),
                    similarity: mean,
                }
            })
            .collect();
        // Stable order — by group size descending, then by similarity.
        out.sort_by(|a, b| b.paths.len().cmp(&a.paths.len())
            .then_with(|| b.similarity.partial_cmp(&a.similarity).unwrap_or(std::cmp::Ordering::Equal)));
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ───────────────────────────────────────────────────────────────────────────
// Phase 4 / P5 — semantic process explanation for unknown executables.
//
// The rule-based explainer (`src/lib/processExplain.ts`) handles the common
// case: OS processes, Chromium subprocesses, anything with publisher metadata.
// When it falls through to its generic "unrecognised program" line, the
// frontend calls this with the process's combined descriptor
// (`name + product + publisher + path + window title`). We nearest-neighbour
// that against the curated software-description corpus and return the closest
// plain-language description, if any clears the corpus floor.

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessExplanation {
    /// Plain-language description from the corpus, or `None` when nothing
    /// matched closely enough (frontend keeps its rule-based fallback).
    pub description: Option<String>,
    pub confidence: Option<f32>,
}

#[tauri::command]
pub async fn ai_explain_process(
    app: tauri::AppHandle,
    descriptor: String,
) -> Result<ProcessExplanation, String> {
    let dir = crate::ai::model_download::models_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        match crate::ai::software_corpus::explain(&dir, &descriptor)? {
            Some((description, confidence)) => Ok(ProcessExplanation {
                description: Some(description),
                confidence: Some(confidence),
            }),
            None => Ok(ProcessExplanation { description: None, confidence: None }),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

// ───────────────────────────────────────────────────────────────────────────
// Phase 4 / P6 — semantic workload classification.
//
// Insights' workload detector is rule-driven (exe-name regex + PE metadata
// keywords). It's accurate on known apps but says "General Use" for anything
// it's never seen. When that happens and the machine is clearly busy, the
// frontend collects the busy unknown processes' window titles + product names
// and calls this. We embed each text and score it against a fixed set of
// workload-category prototype descriptions, returning the single strongest
// (text, category) pairing. This is a TIE-BREAKER — it only ever runs after
// the rules produce no concrete workload, and the frontend ignores low-
// confidence results.

/// Workload prototype descriptions, one per category the frontend's
/// `WorkloadType` understands. Category ids match the TS union exactly so the
/// result can drop straight into a `WorkloadProfile`.
const WORKLOAD_PROTOTYPES: &[(&str, &str)] = &[
    ("gaming", "Playing a video game. 3D gameplay, game level, multiplayer match, game launcher, in-game menu."),
    ("editing", "Creative content editing. Video editing, photo editing, 3D modeling, rendering, audio production, timeline, project."),
    ("development", "Software development. Writing source code, programming, IDE, terminal, compiling, debugging, repository."),
    ("streaming", "Media playback. Watching a video or movie, listening to music, episode, playlist, now playing."),
    ("communication", "Messaging and calls. Chat conversation, video meeting, email inbox, voice call."),
    ("office", "Office productivity. Editing a document, spreadsheet, presentation, notes, reading a PDF."),
    ("browsing", "Web browsing. Visiting websites, browser tabs, online articles, search results."),
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkloadClassification {
    /// Best-matching workload category id (matches the TS `WorkloadType`),
    /// or `None` when nothing cleared the floor.
    pub category: Option<String>,
    pub confidence: Option<f32>,
}

/// Process-wide cache of the workload-prototype embeddings (static text).
static WORKLOAD_PROTO_VECS: std::sync::OnceLock<Vec<Vec<f32>>> = std::sync::OnceLock::new();

fn workload_proto_vectors(dir: &std::path::Path) -> Result<&'static Vec<Vec<f32>>, String> {
    if let Some(v) = WORKLOAD_PROTO_VECS.get() {
        return Ok(v);
    }
    let texts: Vec<String> = WORKLOAD_PROTOTYPES.iter().map(|(_, d)| d.to_string()).collect();
    let vecs = crate::ai::embeddings::embed_texts(dir, &texts)?;
    let _ = WORKLOAD_PROTO_VECS.set(vecs);
    Ok(WORKLOAD_PROTO_VECS.get().expect("workload proto vectors just set"))
}

/// Minimum cosine for a workload guess to be returned. Window titles are
/// short, so this sits below the document-search floor — but high enough that
/// generic titles ("Settings", "Untitled") don't pin a category.
const WORKLOAD_FLOOR: f32 = 0.34;

#[tauri::command]
pub async fn ai_classify_workload(
    app: tauri::AppHandle,
    texts: Vec<String>,
) -> Result<WorkloadClassification, String> {
    let cleaned: Vec<String> = texts
        .into_iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();
    if cleaned.is_empty() {
        return Ok(WorkloadClassification { category: None, confidence: None });
    }
    let dir = crate::ai::model_download::models_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let protos = workload_proto_vectors(&dir)?;
        let text_vecs = crate::ai::embeddings::try_embed_texts(&dir, &cleaned)?;

        // Strongest (text, prototype) pairing wins — the single most telling
        // window title decides, rather than averaging signal away.
        let mut best_cat = 0usize;
        let mut best = f32::MIN;
        for tv in &text_vecs {
            for (ci, pv) in protos.iter().enumerate() {
                let s = cosine(tv, pv);
                if s > best {
                    best = s;
                    best_cat = ci;
                }
            }
        }
        if best >= WORKLOAD_FLOOR {
            Ok(WorkloadClassification {
                category: Some(WORKLOAD_PROTOTYPES[best_cat].0.to_string()),
                confidence: Some(best),
            })
        } else {
            Ok(WorkloadClassification { category: None, confidence: None })
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

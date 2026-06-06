//! Text embedding runtime (Phase 3 / S4) — pure-Rust ONNX inference via
//! `tract`, tokenised with the Hugging Face `tokenizers` crate.
//!
//! Engine: `tract` over ONNX Runtime — see spike S-12. Pure Rust, no
//! native library, no prerelease dependency; runs the 33 MB int8-quantized
//! `bge-small-en-v1.5` model the embedding spike validated (ARI 0.822 on
//! real labelled data — S-11).
//!
//! The model + tokenizer download on demand (`model_download.rs`) into the
//! app-local models directory. This module loads + optimises them lazily
//! on first use and caches the result — the load is seconds-slow, the
//! per-text embed is fast enough for a background pass.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use tokenizers::Tokenizer;
use tract_onnx::prelude::*;

// Z4 — embedder backend selection.
//
// The CPU tract path remains the default. Users on DirectX 12 hardware
// can opt into DirectML via Settings, which downloads the ORT runtime
// bundle and routes embeddings through `embeddings_dml`. Same model,
// same pooling, same vector shape — vectors stay comparable across
// backends so the persisted embedding cache survives a backend switch.

/// User preference, settable from the Settings UI.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EmbedderPreference {
    Cpu,
    DirectMl,
}

/// What the dispatcher actually chose at first call. Sticky per-process,
/// same rationale as the genlm `ActiveBackend`: model loads are slow,
/// hot-swapping is messy, and the user gets a clearer mental model from
/// "preference takes effect on restart" than from a half-loaded swap.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActiveEmbedderBackend {
    Cpu,
    DirectMl,
}

static EMBEDDER_PREF: Mutex<EmbedderPreference> = Mutex::new(EmbedderPreference::Cpu);
static EMBEDDER_DLL_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);
static ACTIVE_EMBEDDER: Mutex<Option<ActiveEmbedderBackend>> = Mutex::new(None);

pub fn set_embedder_preference(pref: EmbedderPreference) {
    log::info!("embeddings: set_embedder_preference({:?})", pref);
    if let Ok(mut g) = EMBEDDER_PREF.lock() {
        *g = pref;
    }
    if let Ok(mut g) = ACTIVE_EMBEDDER.lock() {
        *g = None;
    }
}

pub fn set_dml_dll_dir(dir: PathBuf) {
    log::info!("embeddings: set_dml_dll_dir({})", dir.display());
    if let Ok(mut g) = EMBEDDER_DLL_DIR.lock() {
        *g = Some(dir);
    }
}

pub fn active_embedder_backend() -> Option<ActiveEmbedderBackend> {
    ACTIVE_EMBEDDER.lock().ok().and_then(|g| *g)
}

/// File names of the embedding model under the models directory.
pub const MODEL_FILE: &str = "bge-small-en-v1.5.onnx";
pub const TOKENIZER_FILE: &str = "bge-small-en-v1.5.tokenizer.json";

/// Longest token sequence embedded. A document's opening past this adds
/// little signal and costs inference time.
const MAX_TOKENS: usize = 256;

/// A loaded embedding model — the optimised `tract` graph plus its
/// tokenizer and the model's declared input order.
pub struct Embedder {
    model: TypedRunnableModel<TypedModel>,
    tokenizer: Tokenizer,
    /// Input node names, in the order the model expects them — used to
    /// route input_ids / attention_mask / token_type_ids correctly, since
    /// `tract`'s `run` takes positional inputs.
    input_names: Vec<String>,
}

impl Embedder {
    /// Load and optimise the ONNX model and its tokenizer. Slow (seconds);
    /// call once and cache. Per the S-12 probe, the model's dimensions are
    /// left symbolic — pinning them trips tract's shape inference on this
    /// BERT graph; concrete shapes are supplied per-call at `run` time.
    pub fn load(model_path: &Path, tokenizer_path: &Path) -> Result<Self, String> {
        let infer = tract_onnx::onnx()
            .model_for_path(model_path)
            .map_err(|e| format!("load model: {e}"))?;
        let input_names: Vec<String> = infer
            .inputs
            .iter()
            .map(|o| infer.node(o.node).name.clone())
            .collect();
        let model = infer
            .into_optimized()
            .map_err(|e| format!("optimize model: {e}"))?
            .into_runnable()
            .map_err(|e| format!("ready model: {e}"))?;

        let mut tokenizer = Tokenizer::from_file(tokenizer_path)
            .map_err(|e| format!("load tokenizer: {e}"))?;
        tokenizer
            .with_truncation(Some(tokenizers::TruncationParams {
                max_length: MAX_TOKENS,
                ..Default::default()
            }))
            .map_err(|e| format!("configure tokenizer: {e}"))?;

        Ok(Self { model, tokenizer, input_names })
    }

    /// Embed one text into a mean-pooled, L2-normalised vector. Mirrors the
    /// validated Python spike: one text per forward pass (no batch padding),
    /// mean-pool over non-pad tokens, normalise.
    pub fn embed(&self, text: &str) -> Result<Vec<f32>, String> {
        let enc = self
            .tokenizer
            .encode(text, true)
            .map_err(|e| format!("tokenize: {e}"))?;
        let ids: Vec<i64> = enc.get_ids().iter().map(|&x| x as i64).collect();
        let mask: Vec<i64> = enc.get_attention_mask().iter().map(|&x| x as i64).collect();
        let seq = ids.len();
        if seq == 0 {
            return Err("empty tokenization".into());
        }
        let types: Vec<i64> = vec![0; seq];

        // Positional inputs, routed to the model's declared input order.
        let mut inputs: TVec<TValue> = tvec!();
        for name in &self.input_names {
            let lname = name.to_lowercase();
            let data: &[i64] = if lname.contains("mask") {
                &mask
            } else if lname.contains("type") {
                &types
            } else {
                &ids // input_ids — the default
            };
            let tensor = Tensor::from_shape(&[1, seq], data)
                .map_err(|e| format!("build input tensor: {e}"))?;
            inputs.push(tensor.into());
        }

        let out = self
            .model
            .run(inputs)
            .map_err(|e| format!("inference: {e}"))?;
        let shape = out[0].shape().to_vec(); // [1, seq, hidden]
        if shape.len() != 3 {
            return Err(format!("unexpected output shape {shape:?}"));
        }
        let hidden = shape[2];
        let data = out[0]
            .as_slice::<f32>()
            .map_err(|e| format!("read output: {e}"))?;

        // Mean-pool over non-pad tokens, then L2-normalise.
        let mut pooled = vec![0f32; hidden];
        let mut n = 0f32;
        for t in 0..seq {
            if mask[t] == 0 {
                continue;
            }
            n += 1.0;
            let base = t * hidden;
            for d in 0..hidden {
                pooled[d] += data[base + d];
            }
        }
        if n > 0.0 {
            for x in &mut pooled {
                *x /= n;
            }
        }
        let norm = pooled.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm > 1e-9 {
            for x in &mut pooled {
                *x /= norm;
            }
        }
        Ok(pooled)
    }
}

/// Process-wide cache of the loaded embedder. The model load is far too
/// slow to repeat per call (~2-5 seconds), so we load once and reuse.
///
/// `OnceLock` (vs the previous `Mutex<Option<Embedder>>`) is the
/// load-bearing change for Phase 4 search responsiveness: tract's
/// runnable model and HF's tokenizer are both `Send + Sync` and safe
/// to call concurrently with shared `&self` references. With the
/// mutex, every embed call serialised behind every other one — a
/// post-scan embedding pass could starve an interactive search for
/// minutes. With OnceLock, search and scan-embed run truly concurrently
/// on the same model; no contention at all once it's loaded.
static EMBEDDER: OnceLock<Embedder> = OnceLock::new();

/// Load the embedder into the global cell if it isn't already. Returns
/// a shared reference safe to call `embed()` on concurrently. The slow
/// load (seconds) happens at most once per process; subsequent calls
/// are free.
fn ensure_loaded_inner(models_dir: &Path) -> Result<&'static Embedder, String> {
    if let Some(e) = EMBEDDER.get() {
        return Ok(e);
    }
    let model_path = models_dir.join(MODEL_FILE);
    let tok_path = models_dir.join(TOKENIZER_FILE);
    if !model_path.exists() || !tok_path.exists() {
        return Err("The AI model isn't installed yet. Turn on AI in Settings to download it.".into());
    }
    // Two threads racing to load is fine — only one's value wins; the
    // other's gets dropped. The `set` call is the synchronisation point.
    let embedder = Embedder::load(&model_path, &tok_path)?;
    let _ = EMBEDDER.set(embedder);
    Ok(EMBEDDER.get().expect("just set"))
}

/// Z4 — pick the embedder backend for this call. Decisions are cached
/// in `ACTIVE_EMBEDDER` and sticky for the process lifetime, mirroring
/// the genlm dispatcher.
///
/// Selection rules:
///   * `Cpu` preference  → always Cpu.
///   * `DirectMl` preference → try to initialise the DML embedder; if
///      anything fails (DLLs missing, init error, model file missing),
///      fall back to Cpu permanently for this process and log a
///      warning so the UI's "Running on: CPU" badge reflects reality
///      instead of pretending DML is hot.
#[cfg(windows)]
fn pick_embedder(models_dir: &Path) -> ActiveEmbedderBackend {
    if let Ok(g) = ACTIVE_EMBEDDER.lock() {
        if let Some(b) = *g {
            return b;
        }
    }
    let pref = *EMBEDDER_PREF.lock().unwrap_or_else(|e| e.into_inner());
    let chosen = if matches!(pref, EmbedderPreference::DirectMl) {
        let dll_dir = EMBEDDER_DLL_DIR.lock().ok().and_then(|g| g.clone());
        match dll_dir {
            None => {
                log::warn!(
                    "embeddings: DirectMl preferred but DLL dir not set; using CPU"
                );
                ActiveEmbedderBackend::Cpu
            }
            Some(dir) => match super::embeddings_dml::ensure_loaded(&dir, models_dir) {
                Ok(_) => {
                    log::info!("embeddings: pick_embedder: DML init OK");
                    ActiveEmbedderBackend::DirectMl
                }
                Err(e) => {
                    log::warn!(
                        "embeddings: DML init FAILED, falling back to CPU: {e}"
                    );
                    ActiveEmbedderBackend::Cpu
                }
            },
        }
    } else {
        ActiveEmbedderBackend::Cpu
    };
    if let Ok(mut g) = ACTIVE_EMBEDDER.lock() {
        *g = Some(chosen);
    }
    chosen
}

#[cfg(not(windows))]
fn pick_embedder(_models_dir: &Path) -> ActiveEmbedderBackend {
    // Non-Windows builds never have DirectML. Keeps the dispatcher
    // compilable when consumers cross-build.
    ActiveEmbedderBackend::Cpu
}

/// Embed `texts` with the model in `models_dir`, loading and caching it
/// on first use. Returns one vector per input text in the same order.
///
/// Phase 4: embedding within a batch runs in parallel via rayon. The
/// CPU embedder is concurrent-safe (OnceLock + tract's `Send + Sync`
/// runnable model). The DML embedder serialises per call on its inner
/// `Mutex<Session>`, but per-call throughput on a modern GPU still
/// beats parallel CPU calls on typical batch sizes (S4 ~150 files).
/// `par_iter().map().collect()` preserves order so results align with
/// `texts` regardless of backend.
pub fn embed_texts(models_dir: &Path, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
    use rayon::prelude::*;
    match pick_embedder(models_dir) {
        ActiveEmbedderBackend::Cpu => {
            let embedder = ensure_loaded_inner(models_dir)?;
            texts.par_iter().map(|t| embedder.embed(t)).collect()
        }
        #[cfg(windows)]
        ActiveEmbedderBackend::DirectMl => {
            let dll_dir = EMBEDDER_DLL_DIR
                .lock()
                .ok()
                .and_then(|g| g.clone())
                .ok_or_else(|| "DirectMl selected but DLL dir unset".to_string())?;
            let embedder = super::embeddings_dml::ensure_loaded(&dll_dir, models_dir)?;
            texts.par_iter().map(|t| embedder.embed(t)).collect()
        }
        #[cfg(not(windows))]
        ActiveEmbedderBackend::DirectMl => {
            Err("DirectMl embedder is only available on Windows".into())
        }
    }
}

/// Load the embedder into the global cell if it isn't already. Used by
/// the pre-warm path so the first user-initiated search after launch
/// doesn't pay the cold-load cost.
///
/// Safe to call repeatedly — no-op once loaded. No-op when the model
/// isn't installed yet (the caller still gets a meaningful error from
/// the search path when the user actually tries to use it).
pub fn ensure_loaded(models_dir: &Path) -> Result<(), String> {
    let model_path = models_dir.join(MODEL_FILE);
    let tok_path = models_dir.join(TOKENIZER_FILE);
    if !model_path.exists() || !tok_path.exists() {
        return Ok(());
    }
    // Z4 — route through the dispatcher so prewarm warms the user's
    // preferred backend, not unconditionally the CPU one. If DML init
    // fails, pick_embedder downgrades the dispatcher state to Cpu and
    // we warm tract instead, matching what the next real embed call
    // would do.
    match pick_embedder(models_dir) {
        ActiveEmbedderBackend::Cpu => ensure_loaded_inner(models_dir).map(|_| ()),
        #[cfg(windows)]
        ActiveEmbedderBackend::DirectMl => {
            let dll_dir = EMBEDDER_DLL_DIR
                .lock()
                .ok()
                .and_then(|g| g.clone())
                .ok_or_else(|| "DirectMl selected but DLL dir unset".to_string())?;
            super::embeddings_dml::ensure_loaded(&dll_dir, models_dir).map(|_| ())
        }
        #[cfg(not(windows))]
        ActiveEmbedderBackend::DirectMl => Ok(()),
    }
}

/// Sentinel kept for backwards-compatible string matching on the
/// frontend — the new OnceLock architecture never actually emits this,
/// since embeds are concurrent and don't contend for an exclusive lock.
/// The CommandPalette still recognises it in case any future code path
/// resurrects a serialising primitive.
pub const EMBEDDER_BUSY: &str = "embedder busy";

/// Non-blocking variant of `embed_texts`. Post Phase 4 this is identical
/// to `embed_texts` — there's no mutex to fail-fast on, since embeds
/// are concurrent. Kept as a separate symbol so search call sites stay
/// semantically distinct from batch ones (and so a future fairness
/// regime, if ever needed, can swap behaviour here without touching
/// the search-side code).
pub fn try_embed_texts(models_dir: &Path, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
    embed_texts(models_dir, texts)
}

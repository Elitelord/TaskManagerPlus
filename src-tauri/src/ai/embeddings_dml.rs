//! Z4 — DirectML-accelerated embedder.
//!
//! Same bge-small-en-v1.5 ONNX model as the CPU tract path, but loaded
//! through ONNX Runtime via the `ort` crate with the DirectML execution
//! provider. Targets DirectX 12-capable GPUs on Windows (basically every
//! GPU built since 2015 — Intel, AMD, NVIDIA).
//!
//! Privacy / network: zero. Same as the CPU embedder — model file is
//! already on disk, the runtime is a dynamically-loaded local DLL, no
//! socket is opened.
//!
//! Bundling: the ORT runtime DLLs aren't shipped in the installer to
//! keep it small. The Settings UI downloads them on demand into
//! `<app local data>/onnx_dml/` via `model_download.rs`. Once present,
//! `ort::init_from(<path-to-onnxruntime.dll>)` points the crate at our
//! copy. Mirrors the Y1-A Vulkan llama bundle pattern.
//!
//! Concurrency: ort's `Session::run` takes `&mut self`, so unlike the
//! CPU embedder (where tract's `Send + Sync` runnable model lets us
//! share via `OnceLock`), we wrap the session in a `Mutex`. Per-call
//! embed serialises, but DirectML's per-call throughput is 5-10× the
//! CPU path on a modern GPU; the search/scan path runs concurrent at
//! a coarser grain (rayon over the batch).

#![cfg(windows)]

use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use ort::execution_providers::directml::DirectMLExecutionProvider;
use ort::session::{Session, builder::GraphOptimizationLevel};
use ort::value::Tensor;
use tokenizers::Tokenizer;

use super::embeddings::{MODEL_FILE, TOKENIZER_FILE};

/// Longest token sequence — kept identical to the CPU path so identical
/// inputs produce comparable vectors regardless of backend.
const MAX_TOKENS: usize = 256;

/// One-shot init flag for `ort::init_from`. The crate requires the
/// dynamic-library path to be set exactly once before any other ort API
/// call; subsequent calls are no-ops. We gate it so a stale failed init
/// followed by a successful download + retry both work.
static ORT_INITIALIZED: OnceLock<()> = OnceLock::new();

/// Loaded DML embedder. Session + tokenizer + the input name routing
/// the CPU embedder also tracks.
pub struct DmlEmbedder {
    session: Mutex<Session>,
    tokenizer: Tokenizer,
    input_names: Vec<String>,
}

/// Process-wide cache of the loaded DML embedder. Mirrors the CPU path's
/// `EMBEDDER` static: an `Arc` behind an `Option` so the idle reaper can drop
/// the session (freeing GPU memory) while an in-flight embed keeps its own
/// clone alive. `None` = not loaded. The ORT *runtime* (`ORT_INITIALIZED`)
/// stays initialised for the process lifetime — only the `Session` is dropped.
static DML_EMBEDDER: Mutex<Option<Arc<DmlEmbedder>>> = Mutex::new(None);
static DML_INIT_LOCK: Mutex<()> = Mutex::new(());

impl DmlEmbedder {
    /// Initialise ort against the bundle directory `dll_dir` (which must
    /// contain `onnxruntime.dll`), then load the bge-small model with
    /// the DirectML execution provider.
    ///
    /// **Caller must hold `DML_INIT_LOCK`** — this function reads
    /// `ORT_INITIALIZED` and calls `ort::init_from` without internally
    /// re-locking, because `std::sync::Mutex` is non-reentrant. The
    /// only public entry point (`ensure_loaded` below) acquires the
    /// lock for the whole load.
    ///
    /// Fails — and the dispatcher falls back to CPU — if the runtime
    /// DLLs aren't on disk, the GPU is too old to support DirectX 12,
    /// or the model file is missing. Each failure mode returns a
    /// human-readable error so the Settings card can show what's wrong.
    fn load_locked(dll_dir: &Path, model_path: &Path, tokenizer_path: &Path) -> Result<Self, String> {
        let onnx_dll = dll_dir.join("onnxruntime.dll");
        if !onnx_dll.exists() {
            return Err(format!(
                "onnxruntime.dll not found at {}. Download the DirectML \
                 bundle from Settings.",
                onnx_dll.display()
            ));
        }
        if !model_path.exists() {
            return Err(format!(
                "embedding model not found at {}",
                model_path.display()
            ));
        }
        if !tokenizer_path.exists() {
            return Err(format!(
                "embedding tokenizer not found at {}",
                tokenizer_path.display()
            ));
        }

        // `ort::init_from` MUST be called before any Session API and
        // can only be set once per process. We're already inside the
        // DML_INIT_LOCK held by `ensure_loaded`, so just check the
        // sentinel and init without acquiring again — std's Mutex is
        // non-reentrant and a previous re-lock here was deadlocking
        // the prewarm thread forever (no error, no log, just silence).
        if ORT_INITIALIZED.get().is_none() {
            let path_str = onnx_dll.to_string_lossy().into_owned();
            ort::init_from(path_str)
                .commit()
                .map_err(|e| format!("init ORT runtime: {e}"))?;
            let _ = ORT_INITIALIZED.set(());
        }

        let session = Session::builder()
            .map_err(|e| format!("ORT session builder: {e}"))?
            .with_execution_providers([DirectMLExecutionProvider::default().build()])
            .map_err(|e| format!("register DML EP: {e}"))?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(|e| format!("set opt level: {e}"))?
            .commit_from_file(model_path)
            .map_err(|e| format!("load model into ORT session: {e}"))?;

        let input_names: Vec<String> = session
            .inputs
            .iter()
            .map(|i| i.name.clone())
            .collect();

        let mut tokenizer = Tokenizer::from_file(tokenizer_path)
            .map_err(|e| format!("load tokenizer: {e}"))?;
        tokenizer
            .with_truncation(Some(tokenizers::TruncationParams {
                max_length: MAX_TOKENS,
                ..Default::default()
            }))
            .map_err(|e| format!("configure tokenizer: {e}"))?;

        Ok(Self {
            session: Mutex::new(session),
            tokenizer,
            input_names,
        })
    }

    /// Embed one text into a mean-pooled, L2-normalised vector. Output
    /// shape matches the CPU path exactly — same model, same pooling.
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

        // Build named inputs by matching what each input port wants. Same
        // routing rules as the CPU embedder; bge's input names are
        // `input_ids` / `attention_mask` / `token_type_ids`.
        let shape = [1_i64, seq as i64];
        let mut inputs: Vec<(String, ort::value::DynValue)> =
            Vec::with_capacity(self.input_names.len());
        for name in &self.input_names {
            let lname = name.to_lowercase();
            let data: &[i64] = if lname.contains("mask") {
                &mask
            } else if lname.contains("type") {
                &types
            } else {
                &ids
            };
            let tensor = Tensor::from_array((shape, data.to_vec()))
                .map_err(|e| format!("build {name} tensor: {e}"))?;
            inputs.push((name.clone(), tensor.into_dyn()));
        }

        // `Session::run` takes `&mut self` and returns a `SessionOutputs`
        // that borrows from the session. We have to materialise the data
        // we care about (the [1, seq, hidden] f32 view) before the lock
        // guard drops at the end of this block, otherwise the borrow
        // outlives the guard. So: do the extract here, return an owned
        // `(hidden, Vec<f32>)`.
        //
        // Lock cost: per-call serialisation. DirectML per-call throughput
        // is 5-10× the CPU path on modern GPUs; the batch level
        // concurrency (rayon over a 200-file batch) is what matters.
        let (hidden, data_owned) = {
            let mut session =
                self.session.lock().map_err(|e| format!("session lock poisoned: {e}"))?;
            let outputs = session
                .run(inputs)
                .map_err(|e| format!("ORT inference: {e}"))?;
            let first = outputs
                .into_iter()
                .next()
                .ok_or_else(|| "ORT session returned no outputs".to_string())?
                .1;
            let (shape, slice) = first
                .try_extract_tensor::<f32>()
                .map_err(|e| format!("extract output tensor: {e}"))?;
            if shape.len() != 3 {
                return Err(format!("unexpected output shape {shape:?}"));
            }
            (shape[2] as usize, slice.to_vec())
        };
        let data: &[f32] = &data_owned;

        let mut pooled = vec![0_f32; hidden];
        let mut n = 0_f32;
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

/// Load or return the cached DML embedder. `dll_dir` must point at the
/// downloaded ORT bundle; `models_dir` is the existing AI model directory
/// holding the bge-small files.
pub fn ensure_loaded(dll_dir: &Path, models_dir: &Path) -> Result<Arc<DmlEmbedder>, String> {
    {
        let g = DML_EMBEDDER.lock().map_err(|e| e.to_string())?;
        if let Some(e) = g.as_ref() {
            return Ok(e.clone());
        }
    }
    let _guard = DML_INIT_LOCK.lock().map_err(|e| e.to_string())?;
    {
        let g = DML_EMBEDDER.lock().map_err(|e| e.to_string())?;
        if let Some(e) = g.as_ref() {
            return Ok(e.clone());
        }
    }
    let model_path = models_dir.join(MODEL_FILE);
    let tok_path = models_dir.join(TOKENIZER_FILE);
    // Holds DML_INIT_LOCK for the entire load — `load_locked` documents that
    // requirement. Single-threaded init means the ORT global env init can never
    // race with the session build below it.
    let embedder = Arc::new(DmlEmbedder::load_locked(dll_dir, &model_path, &tok_path)?);
    *DML_EMBEDDER.lock().map_err(|e| e.to_string())? = Some(embedder.clone());
    Ok(embedder)
}

/// Drop the loaded DML session (if any) to reclaim GPU memory. The ORT runtime
/// stays initialised. Returns whether a session was actually unloaded.
pub fn unload() -> bool {
    DML_EMBEDDER.lock().map(|mut g| g.take().is_some()).unwrap_or(false)
}

/// True when the ORT bundle has been downloaded — used by the
/// dispatcher's `Auto`-style routing (currently the embedder dispatcher
/// is explicit-only, but this hook keeps the door open).
pub fn dlls_present(dll_dir: &Path) -> bool {
    dll_dir.join("onnxruntime.dll").exists()
        && dll_dir.join("DirectML.dll").exists()
}

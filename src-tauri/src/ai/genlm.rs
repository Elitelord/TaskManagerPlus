//! On-device generative LM runtime. Public API is backend-agnostic:
//! callers ask for `ensure_loaded` / `generate`; this module picks
//! between the CPU and GPU/Vulkan backends based on user setting +
//! Vulkan DLL availability, caches the choice for the process
//! lifetime, and dispatches accordingly.
//!
//! Backends:
//!   * **CPU** (`cpu_imp`) — statically-linked llama.cpp via the
//!     `llama-cpp-2` crate. Ships in every Windows build. Phase 5.
//!   * **Vulkan** (`super::genlm_vulkan`) — dynamically-loaded
//!     prebuilt llama.cpp DLL set. ~60 MB bundle, downloaded on demand
//!     and stored under `<app local data>/llama_vulkan/`. Phase 6 /
//!     Y1-A.
//!
//! Privacy contract is unchanged across backends: inference is 100 %
//! on the local machine, in-process; no network calls happen from
//! either path. The Vulkan bundle download is the one network call,
//! and goes through the same BLAKE3-verified `model_download` flow as
//! the GGUF.
//!
//! Windows-only — both backends are `cfg(windows)`. The non-Windows
//! stub returns an error so the call sites compile on any host.

use std::path::{Path, PathBuf};
// Outer module only needs Mutex (PREFERENCE, DLL_DIR, ACTIVE).
// `OnceLock` stays imported inside cpu_imp where it backs RUNTIME.
use std::sync::Mutex;

/// Downloaded GGUF filename (see `model_download::MODELS`). Same model
/// is used by both backends — Vulkan offload doesn't change the file
/// format, just where the tensors get evaluated.
pub const MODEL_FILE: &str = "Qwen2.5-0.5B-Instruct-Q4_K_M.gguf";

/// One chat turn fed to the model. Owned strings so the caller can
/// build them up freely; per-call cost is a handful of clones, dwarfed
/// by the inference itself.
pub struct Turn {
    pub role: String,
    pub content: String,
}

/// User preference for which backend to use. The dispatcher is set
/// via `set_backend_preference()`; defaults to `Auto`.
///
/// `Auto` resolves to Vulkan iff (a) the DLL dir has been set via
/// `set_dll_dir()`, (b) all required DLLs are present in it, and
/// (c) the Vulkan backend init doesn't error out at first use. Any
/// failure of (c) falls back to CPU permanently for this process.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BackendPreference {
    Auto,
    Cpu,
    Vulkan,
}

/// The backend actually selected at first inference call. Sticky for
/// the process lifetime — flipping the user setting takes effect on
/// next app restart, mirroring how the existing CPU model load is
/// process-cached.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActiveBackend {
    Cpu,
    Vulkan,
}

static PREFERENCE: Mutex<BackendPreference> = Mutex::new(BackendPreference::Auto);
static DLL_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);
// Originally a OnceLock — but the app's window-close handler routes to
// the tray instead of quitting (`api.prevent_close()` in lib.rs), which
// kept ACTIVE stuck for the lifetime of the tray-resident process. A
// user flipping CPU↔GPU and clicking X to "restart" wouldn't see the
// change. Switching to Mutex<Option<…>> lets set_backend_preference
// clear it so the next inference re-evaluates.
static ACTIVE: Mutex<Option<ActiveBackend>> = Mutex::new(None);

/// Set the user's backend preference. Called from a Tauri command when
/// the user flips the "Use GPU acceleration" setting. No-op if the
/// runtime has already loaded (process restart required to switch
/// after first inference).
pub fn set_backend_preference(p: BackendPreference) {
    log::info!("genlm: set_backend_preference({:?})", p);
    if let Ok(mut g) = PREFERENCE.lock() {
        *g = p;
    }
    // Invalidate the cached backend choice so the next inference
    // re-evaluates. Without this, the dispatcher's first-call
    // decision would persist for the tray-resident process lifetime.
    if let Ok(mut g) = ACTIVE.lock() {
        *g = None;
    }
}

/// Tell the dispatcher where the prebuilt Vulkan DLLs live. Called
/// once at app startup with `<app local data>/llama_vulkan/`. Without
/// this, `BackendPreference::Auto` resolves to CPU.
pub fn set_dll_dir(dir: PathBuf) {
    log::info!("genlm: set_dll_dir({})", dir.display());
    if let Ok(mut g) = DLL_DIR.lock() {
        *g = Some(dir);
    }
}

/// Currently-active backend, or `None` if inference hasn't run yet.
/// Useful for diagnostics and the settings UI ("running on: GPU").
pub fn active_backend() -> Option<ActiveBackend> {
    ACTIVE.lock().ok().and_then(|g| *g)
}

#[cfg(windows)]
mod cpu_imp {
    //! Statically-linked llama.cpp via `llama-cpp-2`. Validated in
    //! Phase 5 A2; shipped since v1.9.x. Code below is unchanged from
    //! the original `genlm.rs` modulo `Turn` now coming from `super`.

    use std::num::NonZeroU32;
    use std::path::Path;
    use std::sync::{Mutex, OnceLock};

    use llama_cpp_2::context::params::LlamaContextParams;
    use llama_cpp_2::llama_backend::LlamaBackend;
    use llama_cpp_2::llama_batch::LlamaBatch;
    use llama_cpp_2::model::params::LlamaModelParams;
    use llama_cpp_2::model::{AddBos, LlamaChatMessage, LlamaModel, Special};
    use llama_cpp_2::sampling::LlamaSampler;

    use super::{Turn, MODEL_FILE};

    struct Runtime {
        backend: LlamaBackend,
        model: LlamaModel,
    }

    static RUNTIME: OnceLock<Runtime> = OnceLock::new();
    static INIT_LOCK: Mutex<()> = Mutex::new(());

    fn runtime(models_dir: &Path) -> Result<&'static Runtime, String> {
        if let Some(r) = RUNTIME.get() {
            return Ok(r);
        }
        let _guard = INIT_LOCK.lock().map_err(|e| e.to_string())?;
        if let Some(r) = RUNTIME.get() {
            return Ok(r);
        }
        let backend = LlamaBackend::init().map_err(|e| format!("init llama backend: {e}"))?;
        let path = models_dir.join(MODEL_FILE);
        if !path.exists() {
            return Err(
                "The AI model isn't installed yet. Turn on AI in Settings to download it."
                    .to_string(),
            );
        }
        let model = LlamaModel::load_from_file(&backend, &path, &LlamaModelParams::default())
            .map_err(|e| format!("load generative model: {e}"))?;
        let _ = RUNTIME.set(Runtime { backend, model });
        Ok(RUNTIME.get().expect("runtime just set"))
    }

    pub fn ensure_loaded(models_dir: &Path) -> Result<(), String> {
        runtime(models_dir).map(|_| ())
    }

    pub fn generate(
        models_dir: &Path,
        turns: &[Turn],
        max_tokens: i32,
    ) -> Result<String, String> {
        let rt = runtime(models_dir)?;
        let model = &rt.model;

        let messages: Vec<LlamaChatMessage> = turns
            .iter()
            .map(|t| LlamaChatMessage::new(t.role.clone(), t.content.clone()))
            .collect::<Result<_, _>>()
            .map_err(|e| format!("build chat messages: {e}"))?;
        let template = model
            .chat_template(None)
            .map_err(|e| format!("model chat template: {e}"))?;
        let prompt = model
            .apply_chat_template(&template, &messages, true)
            .map_err(|e| format!("apply chat template: {e}"))?;

        let n_threads = std::thread::available_parallelism()
            .map(|n| n.get() as i32)
            .unwrap_or(4);
        let ctx_params = LlamaContextParams::default()
            .with_n_ctx(Some(NonZeroU32::new(4096).unwrap()))
            .with_n_threads(n_threads)
            .with_n_threads_batch(n_threads);
        let mut ctx = rt
            .model
            .new_context(&rt.backend, ctx_params)
            .map_err(|e| format!("create context: {e}"))?;

        let tokens = model
            .str_to_token(&prompt, AddBos::Never)
            .map_err(|e| format!("tokenize prompt: {e}"))?;

        let mut batch = LlamaBatch::new(tokens.len().max(512), 1);
        let last = tokens.len() as i32 - 1;
        for (i, tok) in tokens.iter().enumerate() {
            batch
                .add(*tok, i as i32, &[0], i as i32 == last)
                .map_err(|e| format!("batch add: {e}"))?;
        }
        ctx.decode(&mut batch).map_err(|e| format!("decode prompt: {e}"))?;

        let mut sampler = LlamaSampler::chain_simple([
            LlamaSampler::penalties(64, 1.15, 0.0, 0.0),
            LlamaSampler::greedy(),
        ]);
        let mut out = String::new();
        let mut n_cur = batch.n_tokens();
        let mut n_decoded = 0;

        while n_decoded < max_tokens {
            let token = sampler.sample(&ctx, -1);
            sampler.accept(token);
            if model.is_eog_token(token) {
                break;
            }
            // `token_to_str` is marked deprecated in favour of
            // `token_to_piece(token, &mut decoder, special, max_len)`,
            // but the replacement requires an encoding_rs::Decoder
            // setup that's overkill for a 4-arg utility call. Suppress
            // the lint locally; we'll migrate when llama-cpp-2 settles
            // its API (the upstream deprecation note itself describes
            // the new shape as "less flexible").
            #[allow(deprecated)]
            if let Ok(piece) = model.token_to_str(token, Special::Tokenize) {
                out.push_str(&piece);
            }
            batch.clear();
            batch
                .add(token, n_cur, &[0], true)
                .map_err(|e| format!("batch add (gen): {e}"))?;
            n_cur += 1;
            n_decoded += 1;
            ctx.decode(&mut batch).map_err(|e| format!("decode step: {e}"))?;
        }
        Ok(out.trim().to_string())
    }
}

#[cfg(windows)]
fn pick_backend(models_dir: &Path) -> ActiveBackend {
    // Cached choice from this preference epoch. `set_backend_preference`
    // clears the slot, so flipping the radio + triggering a new
    // generation re-evaluates from scratch.
    if let Ok(g) = ACTIVE.lock() {
        if let Some(b) = *g {
            return b;
        }
    }

    let pref = *PREFERENCE.lock().unwrap_or_else(|e| e.into_inner());
    let dll_dir = DLL_DIR
        .lock()
        .ok()
        .and_then(|g| g.as_ref().cloned());

    let try_vulkan = match pref {
        BackendPreference::Cpu => false,
        BackendPreference::Vulkan => true,
        // Auto: pick Vulkan iff DLLs are sitting there ready to go.
        // Avoids surprising the user with a download prompt on first
        // smart-rename — they have to deliberately enable the bundle.
        BackendPreference::Auto => dll_dir
            .as_deref()
            .map(super::genlm_vulkan::dlls_present)
            .unwrap_or(false),
    };

    // env_logger is initialized in `lib::run()`. Falling back to
    // `log::info!` for the dispatcher's trail (the v2.0 push used
    // eprintln! while debugging Vulkan reliability — env_logger init
    // is reliable now and proper log levels let downstream consumers
    // filter the volume).
    log::info!(
        "genlm: pick_backend: pref={:?} dll_dir={:?} try_vulkan={}",
        pref, dll_dir, try_vulkan,
    );
    let chosen = if try_vulkan {
        match (&dll_dir, models_dir.join(MODEL_FILE)) {
            (Some(dir), model_path) if model_path.exists() => {
                log::info!(
                    "genlm: pick_backend: attempting Vulkan init from {}",
                    dir.display(),
                );
                match super::genlm_vulkan::ensure_loaded(dir, &model_path) {
                    Ok(()) => {
                        log::info!("genlm: pick_backend: Vulkan init OK");
                        ActiveBackend::Vulkan
                    }
                    Err(e) => {
                        log::warn!(
                            "genlm: pick_backend: Vulkan backend init FAILED, falling back to CPU: {e}"
                        );
                        ActiveBackend::Cpu
                    }
                }
            }
            (None, _) => {
                log::warn!("genlm: pick_backend: try_vulkan but DLL_DIR is unset; using CPU");
                ActiveBackend::Cpu
            }
            (Some(dir), model_path) => {
                log::warn!(
                    "genlm: pick_backend: try_vulkan but model missing at {} (dll_dir={}); using CPU",
                    model_path.display(),
                    dir.display(),
                );
                ActiveBackend::Cpu
            }
        }
    } else {
        ActiveBackend::Cpu
    };
    log::info!("genlm: pick_backend: chose {:?}", chosen);
    if let Ok(mut g) = ACTIVE.lock() {
        *g = Some(chosen);
    }
    chosen
}

#[cfg(windows)]
pub fn ensure_loaded(models_dir: &Path) -> Result<(), String> {
    match pick_backend(models_dir) {
        ActiveBackend::Cpu => cpu_imp::ensure_loaded(models_dir),
        ActiveBackend::Vulkan => {
            let dll_dir = DLL_DIR
                .lock()
                .ok()
                .and_then(|g| g.as_ref().cloned())
                .ok_or_else(|| "Vulkan selected but DLL dir not set".to_string())?;
            super::genlm_vulkan::ensure_loaded(&dll_dir, &models_dir.join(MODEL_FILE))
        }
    }
}

#[cfg(windows)]
pub fn generate(
    models_dir: &Path,
    turns: &[Turn],
    max_tokens: i32,
) -> Result<String, String> {
    match pick_backend(models_dir) {
        ActiveBackend::Cpu => cpu_imp::generate(models_dir, turns, max_tokens),
        ActiveBackend::Vulkan => {
            let dll_dir = DLL_DIR
                .lock()
                .ok()
                .and_then(|g| g.as_ref().cloned())
                .ok_or_else(|| "Vulkan selected but DLL dir not set".to_string())?;
            // Cheap copy across the type boundary — both `Turn` types
            // are owned strings; one clone of role + content per turn.
            let vk_turns: Vec<super::genlm_vulkan::Turn> = turns
                .iter()
                .map(|t| super::genlm_vulkan::Turn {
                    role: t.role.clone(),
                    content: t.content.clone(),
                })
                .collect();
            super::genlm_vulkan::generate(
                &dll_dir,
                &models_dir.join(MODEL_FILE),
                &vk_turns,
                max_tokens,
            )
        }
    }
}

#[cfg(not(windows))]
pub fn ensure_loaded(_models_dir: &Path) -> Result<(), String> {
    Err("generative model is only available on Windows".to_string())
}

#[cfg(not(windows))]
pub fn generate(
    _models_dir: &Path,
    _turns: &[Turn],
    _max_tokens: i32,
) -> Result<String, String> {
    Err("generative model is only available on Windows".to_string())
}

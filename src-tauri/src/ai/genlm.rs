//! On-device generative LM runtime (Phase 5) — Qwen2.5-0.5B-Instruct via
//! llama.cpp (the `llama-cpp-2` binding). A1 validated the runtime on
//! SmolLM2-360M; realistic-data spikes then showed SmolLM2 dumps file content
//! (incl. PII) for smart-rename while Qwen names cleanly, so Qwen is the
//! shipped model. This is the in-app version of the A2 probe.
//!
//! Privacy contract is unchanged: inference is 100% on-CPU, in-process. The
//! prompt text never leaves the machine — same as the embedding runtime.
//!
//! Loading is cached process-wide (the model load is slow). The model is
//! shared `Send + Sync`; each `generate` call builds its own short-lived
//! context, so generations don't share KV state.
//!
//! Windows-only — `llama-cpp-2` is a `cfg(windows)` dependency, matching the
//! app's target. A non-Windows stub keeps the module callable everywhere.

#[cfg(windows)]
mod imp {
    use std::num::NonZeroU32;
    use std::path::Path;
    use std::sync::{Mutex, OnceLock};

    use llama_cpp_2::context::params::LlamaContextParams;
    use llama_cpp_2::llama_backend::LlamaBackend;
    use llama_cpp_2::llama_batch::LlamaBatch;
    use llama_cpp_2::model::params::LlamaModelParams;
    use llama_cpp_2::model::{AddBos, LlamaChatMessage, LlamaModel, Special};
    use llama_cpp_2::sampling::LlamaSampler;

    /// Downloaded file name (see `model_download::MODELS`).
    pub const MODEL_FILE: &str = "Qwen2.5-0.5B-Instruct-Q4_K_M.gguf";

    /// Loaded runtime: the llama.cpp backend + the model graph. Cached for
    /// the process lifetime.
    struct Runtime {
        backend: LlamaBackend,
        model: LlamaModel,
    }

    static RUNTIME: OnceLock<Runtime> = OnceLock::new();
    // Serialises the one-time backend+model load. `LlamaBackend::init()` must
    // run exactly once per process, so two threads racing the first call can't
    // both initialise it.
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

    /// Pre-load the model into the process cache (call off the UI thread).
    pub fn ensure_loaded(models_dir: &Path) -> Result<(), String> {
        runtime(models_dir).map(|_| ())
    }

    /// One chat turn fed to the model.
    pub struct Turn {
        pub role: String,
        pub content: String,
    }

    /// Generate a completion for a chat conversation.
    ///
    /// `turns` is the full message list (system / user / assistant …); the
    /// model's own chat template is applied and an assistant turn is requested.
    /// Returns the decoded assistant text (EOG-terminated or capped at
    /// `max_tokens`).
    ///
    /// Sampling uses a repetition penalty + low temperature (see the sampler
    /// below) — the A2 probe showed a bare temp+top_p chain loops and greedy
    /// copies the input verbatim on this 360M model. Callers still
    /// post-process (e.g. smart-rename trims to short names).
    pub fn generate(models_dir: &Path, turns: &[Turn], max_tokens: i32) -> Result<String, String> {
        let rt = runtime(models_dir)?;
        let model = &rt.model;

        // Build the prompt via the model's embedded chat template.
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

        // Tokenize (template already carries special markers; no extra BOS).
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

        // Greedy + a LIGHT repetition penalty. Greedy keeps the model anchored
        // on the actual content (temperature sampling on these small models
        // drifts toward memorised few-shot answers — parroting example outputs);
        // the small penalty stops run-on verbatim copying. No temp/top_p —
        // naming wants determinism, not variety.
        let mut sampler = LlamaSampler::chain_simple([
            LlamaSampler::penalties(64, 1.15, 0.0, 0.0),
            LlamaSampler::greedy(),
        ]);
        let mut out = String::new();
        let mut n_cur = batch.n_tokens();
        let mut n_decoded = 0;

        while n_decoded < max_tokens {
            // -1 = the last output's logits (see A2: an absolute batch index
            // after a multi-token decode reads the wrong row).
            let token = sampler.sample(&ctx, -1);
            sampler.accept(token);
            if model.is_eog_token(token) {
                break;
            }
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

#[cfg(not(windows))]
mod imp {
    use std::path::Path;

    pub const MODEL_FILE: &str = "Qwen2.5-0.5B-Instruct-Q4_K_M.gguf";

    pub struct Turn {
        pub role: String,
        pub content: String,
    }

    pub fn ensure_loaded(_models_dir: &Path) -> Result<(), String> {
        Err("generative model is only available on Windows".to_string())
    }

    pub fn generate(_models_dir: &Path, _turns: &[Turn], _max_tokens: i32) -> Result<String, String> {
        Err("generative model is only available on Windows".to_string())
    }
}

pub use imp::{ensure_loaded, generate, Turn, MODEL_FILE};

//! Y1-A — GPU/Vulkan generative backend. Mirrors the public surface of
//! `genlm.rs`'s `imp` module (`ensure_loaded` + `generate` + the same
//! `Turn` shape) so the dispatcher in `genlm.rs` can route either way
//! based on user preference and DLL availability.
//!
//! Loads the prebuilt llama.cpp DLL set at runtime via libloading.
//! Holds a process-wide cached runtime (the llama_model* the DLL hands
//! us, plus the `Llama` symbol table) — model load is the slowest part
//! of inference, so caching matters even more than it does on the CPU
//! path. Per-call inference builds a short-lived context, decodes the
//! prompt, samples tokens, then tears the context down — same pattern
//! as `genlm.rs::imp::generate`.
//!
//! `llama_log_set` is wired to a no-op callback during init to silence
//! the per-tensor loading chatter the spike printed (a few hundred
//! lines of `create_tensor: loading tensor blk.N.foo`). The spike kept
//! it on for validation; production has nothing to debug there.
//!
//! Concurrency: the runtime is shared across threads via a `OnceLock`
//! plus an init mutex (matches the CPU module). llama.cpp's model
//! handle is read-only after load; per-call context creation is
//! serialised in practice because the only consumers are the
//! generative-feature Tauri commands.

#![cfg(windows)]

use std::ffi::CString;
use std::os::raw::{c_char, c_void};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use crate::ai::llama_ffi::{
    llama_batch, llama_chat_message, llama_model, llama_token, Llama,
};

/// Filenames of the prebuilt llama.cpp Vulkan release that the download
/// flow places in the DLL bundle directory. See the `model_download`
/// MODELS table for the canonical source + BLAKE3 hash.
pub const REQUIRED_DLLS: &[&str] = &[
    "llama.dll",
    "ggml.dll",
    "ggml-base.dll",
    "ggml-vulkan.dll",
    "ggml-cpu-x64.dll",
    "libomp140.x86_64.dll",
];

/// Returns whether every required DLL is present in `dll_dir`. Cheap;
/// safe to call from the UI to gate the "Use GPU" toggle.
pub fn dlls_present(dll_dir: &Path) -> bool {
    REQUIRED_DLLS.iter().all(|f| dll_dir.join(f).exists())
}

/// Cached runtime: the loaded Llama symbol table + the model pointer.
///
/// `Send + Sync` is asserted manually because raw pointers aren't
/// `Send` by default. The llama_model is treated as immutable shared
/// state after load (per llama.cpp's documented usage); contexts that
/// mutate state are per-call.
///
/// `gen_lock` serializes concurrent `generate()` calls. The static
/// `llama-cpp-2` crate's Rust wrappers synchronize this internally,
/// but our raw libloading FFI doesn't — and the prebuilt Vulkan DLLs
/// crash with STATUS_ACCESS_VIOLATION when two threads construct
/// contexts on the same model at once (observed when the Storage
/// page auto-generates B3 folder names for multiple suggestions
/// concurrently). Serializing here is the simplest correct fix; gen
/// calls are seconds-long anyway, so a queue is acceptable UX.
struct Runtime {
    llama: Llama,
    model: *mut llama_model,
    gen_lock: Mutex<()>,
}

unsafe impl Send for Runtime {}
unsafe impl Sync for Runtime {}

static RUNTIME: OnceLock<Runtime> = OnceLock::new();
/// Serialises the one-time `backend_init` + `model_load_from_file`.
static INIT_LOCK: Mutex<()> = Mutex::new(());

/// No-op log callback. Silences llama.cpp's tensor-loading chatter
/// without dropping panics (we ignore log lines entirely; the Rust
/// side handles errors through return codes).
unsafe extern "C" fn silent_log(_level: i32, _text: *const c_char, _user_data: *mut c_void) {}

fn runtime(dll_dir: &Path, model_path: &Path) -> Result<&'static Runtime, String> {
    if let Some(r) = RUNTIME.get() {
        return Ok(r);
    }
    let _guard = INIT_LOCK.lock().map_err(|e| e.to_string())?;
    if let Some(r) = RUNTIME.get() {
        return Ok(r);
    }

    if !dlls_present(dll_dir) {
        return Err(format!(
            "GPU acceleration DLLs missing from {}. Enable GPU AI in Settings to download them.",
            dll_dir.display()
        ));
    }
    if !model_path.exists() {
        return Err(
            "The AI model isn't installed yet. Turn on AI in Settings to download it.".into(),
        );
    }

    let llama = Llama::load(dll_dir).map_err(|e| format!("load llama DLLs: {e}"))?;

    // SAFETY: every call into the DLL goes through the typed function
    // pointers in `llama`. Layouts are validated by the spike (see
    // `scripts/ml/vulkan_probe/`). The DLLs stay mapped for the
    // program's lifetime because we hold the `Llama` struct.
    //
    // NOTE: log_set silencing intentionally NOT called here yet — we
    // need llama.cpp's diagnostic output to surface failure reasons
    // during early production use. Re-enable once Vulkan inference is
    // reliable.
    let model = unsafe {
        (llama.backend_init)();
        // Explicitly load all backend plugins (Vulkan, CPU dispatch
        // variants) from the same directory as llama.dll. Recent
        // llama.cpp no longer auto-discovers these from
        // `llama_backend_init`; without this call, model load fails
        // with "no backends are loaded".
        let dll_dir_c = CString::new(dll_dir.to_string_lossy().as_ref())
            .map_err(|e| format!("dll_dir contains NUL: {e}"))?;
        eprintln!(
            "[genlm-vulkan] loading backend plugins from {}",
            dll_dir.display(),
        );
        (llama.backend_load_all_from_path)(dll_dir_c.as_ptr());

        let mut mparams = (llama.model_default_params)();
        // 99 = "offload everything you can"; llama.cpp clamps to actual
        // layer count. Validated as the right value in the spike.
        mparams.n_gpu_layers = 99;

        let model_path_str = model_path.to_string_lossy();
        eprintln!(
            "[genlm-vulkan] loading model from {} (n_gpu_layers={})",
            model_path_str, mparams.n_gpu_layers,
        );
        let model_path_c = CString::new(model_path_str.as_ref())
            .map_err(|e| format!("model path contains NUL: {e}"))?;
        let model = (llama.model_load_from_file)(model_path_c.as_ptr(), mparams);
        if model.is_null() {
            return Err(format!(
                "llama_model_load_from_file returned NULL for {} \
                 (check llama.cpp stderr above for the real reason)",
                model_path.display(),
            ));
        }
        eprintln!("[genlm-vulkan] model loaded OK");
        model
    };

    let _ = RUNTIME.set(Runtime {
        llama,
        model,
        gen_lock: Mutex::new(()),
    });
    Ok(RUNTIME.get().expect("runtime just set"))
}

/// Pre-load the model into the process cache. Call off the UI thread.
pub fn ensure_loaded(dll_dir: &Path, model_path: &Path) -> Result<(), String> {
    runtime(dll_dir, model_path).map(|_| ())
}

/// One chat turn fed to the model. Same shape as `genlm::Turn` so the
/// dispatcher can hand `&[Turn]` through unchanged.
pub struct Turn {
    pub role: String,
    pub content: String,
}

/// Generate a completion for a chat conversation via the Vulkan path.
///
/// Sampling and prompt-shaping match `genlm::imp::generate` exactly
/// (penalties(64, 1.15) + greedy, model's own chat template, no extra
/// BOS) so the same prompt produces the same output up to floating-
/// point determinism — important so smart-rename / summary output
/// quality doesn't shift when users flip CPU↔GPU.
pub fn generate(
    dll_dir: &Path,
    model_path: &Path,
    turns: &[Turn],
    max_tokens: i32,
) -> Result<String, String> {
    let rt = runtime(dll_dir, model_path)?;
    let llama = &rt.llama;
    let model = rt.model;
    // Serialize against any other concurrent `generate()` for this
    // Runtime — see `Runtime::gen_lock` doc. The lock is released
    // when `_gen_guard` drops at end of scope.
    let _gen_guard = rt
        .gen_lock
        .lock()
        .map_err(|e| format!("gen lock poisoned: {e}"))?;
    let n_threads = std::thread::available_parallelism()
        .map(|n| n.get() as i32)
        .unwrap_or(4);

    // Hoist CStrings out of the loop so the pointers we hand the DLL
    // remain valid for the whole apply_chat_template call.
    let cstr_turns: Vec<(CString, CString)> = turns
        .iter()
        .map(|t| {
            Ok::<_, String>((
                CString::new(t.role.as_str()).map_err(|e| format!("role NUL: {e}"))?,
                CString::new(t.content.as_str()).map_err(|e| format!("content NUL: {e}"))?,
            ))
        })
        .collect::<Result<_, _>>()?;
    let chat_msgs: Vec<llama_chat_message> = cstr_turns
        .iter()
        .map(|(role, content)| llama_chat_message {
            role: role.as_ptr(),
            content: content.as_ptr(),
        })
        .collect();

    // Everything from here on touches raw pointers — keep it in one
    // unsafe block so the lifetimes don't fragment.
    let result = unsafe {
        let vocab = (llama.model_get_vocab)(model);

        let tmpl_ptr = (llama.model_chat_template)(model, std::ptr::null());
        if tmpl_ptr.is_null() {
            return Err("model has no built-in chat template".into());
        }

        // Probe required size, then alloc + fill.
        let needed = (llama.chat_apply_template)(
            tmpl_ptr,
            chat_msgs.as_ptr(),
            chat_msgs.len(),
            true,
            std::ptr::null_mut(),
            0,
        );
        if needed < 0 {
            return Err(format!("chat_apply_template sizing failed: {needed}"));
        }
        let mut prompt_buf = vec![0i8; needed as usize + 1];
        let written = (llama.chat_apply_template)(
            tmpl_ptr,
            chat_msgs.as_ptr(),
            chat_msgs.len(),
            true,
            prompt_buf.as_mut_ptr(),
            prompt_buf.len() as i32,
        );
        if written < 0 {
            return Err(format!("chat_apply_template write failed: {written}"));
        }
        let prompt_bytes: Vec<u8> = prompt_buf[..written as usize]
            .iter()
            .map(|&c| c as u8)
            .collect();
        let prompt = std::str::from_utf8(&prompt_bytes)
            .map_err(|e| format!("template output not utf8: {e}"))?;

        // Build context fresh per call so consecutive calls don't share
        // KV state — matches the CPU path's contract.
        let mut cparams = (llama.context_default_params)();
        cparams.n_ctx = 4096;
        // n_batch must be >= the number of tokens decoded in a single
        // llama_decode call. Inspector prompts (file content + few-shot
        // examples) routinely exceed 512 tokens; clamping below that
        // trips `GGML_ASSERT(n_tokens_all <= cparams.n_batch)` and
        // STATUS_STACK_BUFFER_OVERRUN. Match n_ctx so any prompt that
        // fits in context fits in one batch. (The static-linked
        // `llama-cpp-2` path uses a larger default and never hit this,
        // which is why CPU mode worked.)
        cparams.n_batch = cparams.n_ctx;
        cparams.n_threads = n_threads;
        cparams.n_threads_batch = n_threads;

        let ctx = (llama.init_from_model)(model, cparams);
        if ctx.is_null() {
            return Err("llama_init_from_model returned NULL".into());
        }

        // Tokenize prompt. add_special=false because the chat template
        // already injects the BOS / role tokens.
        let prompt_c = CString::new(prompt).map_err(|e| format!("prompt NUL: {e}"))?;
        let max_prompt_tokens = (prompt.len() as i32).max(64) + 32;
        let mut prompt_tokens = vec![0 as llama_token; max_prompt_tokens as usize];
        let n_prompt = (llama.tokenize)(
            vocab,
            prompt_c.as_ptr(),
            prompt.len() as i32,
            prompt_tokens.as_mut_ptr(),
            prompt_tokens.len() as i32,
            false,
            true,
        );
        if n_prompt < 0 {
            (llama.free_ctx)(ctx);
            return Err(format!("tokenize failed: {n_prompt}"));
        }
        prompt_tokens.truncate(n_prompt as usize);

        // Decode the prompt in one batch. Only the last position
        // requests logits — sampling reads idx=-1 (last output).
        let mut batch = (llama.batch_init)(prompt_tokens.len().max(512) as i32, 0, 1);
        push_prompt_into_batch(&mut batch, &prompt_tokens);
        let dec = (llama.decode)(ctx, copy_batch_header(&batch));
        if dec != 0 {
            (llama.batch_free)(batch);
            (llama.free_ctx)(ctx);
            return Err(format!("decode(prompt) failed: {dec}"));
        }

        // Sampler chain: penalties + greedy — identical to genlm.rs.
        let smpl_params = (llama.sampler_chain_default_params)();
        let chain = (llama.sampler_chain_init)(smpl_params);
        let pen = (llama.sampler_init_penalties)(64, 1.15, 0.0, 0.0);
        let greedy = (llama.sampler_init_greedy)();
        (llama.sampler_chain_add)(chain, pen);
        (llama.sampler_chain_add)(chain, greedy);

        // Decode loop.
        let mut out = String::new();
        let mut n_cur = batch.n_tokens;
        let mut n_decoded = 0i32;
        let mut piece_buf = vec![0i8; 256];

        while n_decoded < max_tokens {
            let token = (llama.sampler_sample)(chain, ctx, -1);
            (llama.sampler_accept)(chain, token);
            if (llama.vocab_is_eog)(vocab, token) {
                break;
            }
            let n_chars = (llama.token_to_piece)(
                vocab,
                token,
                piece_buf.as_mut_ptr(),
                piece_buf.len() as i32,
                0,
                true,
            );
            if n_chars > 0 {
                let piece_bytes: Vec<u8> = piece_buf[..n_chars as usize]
                    .iter()
                    .map(|&c| c as u8)
                    .collect();
                if let Ok(s) = std::str::from_utf8(&piece_bytes) {
                    out.push_str(s);
                }
            }

            // Feed the sampled token back as a 1-token batch.
            push_single_token(&mut batch, token, n_cur);
            let dec = (llama.decode)(ctx, copy_batch_header(&batch));
            if dec != 0 {
                (llama.sampler_free)(chain);
                (llama.batch_free)(batch);
                (llama.free_ctx)(ctx);
                return Err(format!("decode(step) failed: {dec}"));
            }
            n_cur += 1;
            n_decoded += 1;
        }

        // Cleanup. Order: sampler chain owns its sub-samplers, free that
        // first; then the batch's heap buffers; then the context.
        (llama.sampler_free)(chain);
        (llama.batch_free)(batch);
        (llama.free_ctx)(ctx);

        Ok::<String, String>(out.trim().to_string())
    };

    result
}

/// Suggested install location for the Vulkan DLL bundle. Mirrors
/// `model_download`'s convention of putting installable AI assets under
/// `<app local data>/llama_vulkan/`. The dispatcher in `genlm.rs`
/// passes this through to `ensure_loaded` / `generate`.
pub fn dll_dir_under(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("llama_vulkan")
}

// ---------------------------------------------------------------------
// Batch helpers — mirror the probe's helpers exactly. The DLL allocates
// the backing arrays inside `llama_batch_init`; we just mutate
// `n_tokens` + the parallel arrays. `copy_batch_header` returns a
// shallow copy so `llama_decode` (which takes the batch by value)
// doesn't take ownership of our buffers.
// ---------------------------------------------------------------------

fn copy_batch_header(b: &llama_batch) -> llama_batch {
    llama_batch {
        n_tokens: b.n_tokens,
        token: b.token,
        embd: b.embd,
        pos: b.pos,
        n_seq_id: b.n_seq_id,
        seq_id: b.seq_id,
        logits: b.logits,
    }
}

unsafe fn push_prompt_into_batch(batch: &mut llama_batch, tokens: &[llama_token]) {
    batch.n_tokens = tokens.len() as i32;
    for (i, tok) in tokens.iter().enumerate() {
        *batch.token.add(i) = *tok;
        *batch.pos.add(i) = i as i32;
        *batch.n_seq_id.add(i) = 1;
        *(*batch.seq_id.add(i)).add(0) = 0;
        *batch.logits.add(i) = if i == tokens.len() - 1 { 1 } else { 0 };
    }
}

unsafe fn push_single_token(batch: &mut llama_batch, token: llama_token, pos: i32) {
    batch.n_tokens = 1;
    *batch.token.add(0) = token;
    *batch.pos.add(0) = pos;
    *batch.n_seq_id.add(0) = 1;
    *(*batch.seq_id.add(0)).add(0) = 0;
    *batch.logits.add(0) = 1;
}

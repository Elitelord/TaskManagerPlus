//! Hand-written FFI for llama.cpp's C API — just the surface our
//! generative-LM features use: load model, build context, tokenize,
//! apply chat template, decode batches, sample tokens, detokenize.
//!
//! This module backs the GPU/Vulkan code path. The CPU path stays on
//! the statically-linked `llama-cpp-2` crate; this module dlopens the
//! prebuilt llama.cpp Vulkan DLL bundle at runtime. See
//! `docs/AI_INTEGRATION_PLAN.md` §Phase 6 / Y1-A for the architecture
//! rationale — source-building `llama-cpp-2 --features vulkan` hits an
//! MSBuild `vulkan-shaders-gen` ExternalProject wall on Windows MSVC,
//! so we sidestep the build entirely.
//!
//! Validated end-to-end in `scripts/ml/vulkan_probe/` (gitignored):
//! these exact FFI definitions produced coherent Qwen2.5-0.5B Q4 output
//! at ~111 tok/s on Vulkan vs ~84 tok/s on static-linked CPU on the
//! dev Copilot+ PC (AMD Radeon 890M iGPU).
//!
//! Pinned to release tag `b9433` of llama.cpp. Bumping the prebuilt DLL
//! set MUST be paired with a re-validation of these signatures — the
//! ABI is stable across patch releases but has broken between
//! intermediate dev builds.
//!
//! Layout discipline:
//!   * All struct types use `#[repr(C)]` so layout matches the C ABI.
//!   * All enum-typed fields are spelled as `i32` (C enums are int on
//!     MSVC); the variants are exposed as constants below for callers
//!     that need to pass them as args.
//!   * `bool` is 1 byte in MSVC C — Rust `bool` is also 1 byte; layout
//!     matches because `#[repr(C)]` honors that.
//!   * We never CONSTRUCT a `LlamaModelParams` or `LlamaContextParams`
//!     from scratch — `llama_model_default_params` /
//!     `llama_context_default_params` return a fully-initialized struct
//!     from the DLL, and we just tweak the fields we care about
//!     (`n_gpu_layers`, `n_ctx`, `n_threads`). This avoids the trap of
//!     getting the default values for half a dozen unexposed knobs wrong.

#![allow(non_camel_case_types)]
#![allow(dead_code)]

use std::os::raw::{c_char, c_float, c_void};

// -----------------------------------------------------------------------
// Opaque handle types. We never inspect the contents — the DLL does.
// -----------------------------------------------------------------------

#[repr(C)]
pub struct llama_model {
    _opaque: [u8; 0],
}
#[repr(C)]
pub struct llama_context {
    _opaque: [u8; 0],
}
#[repr(C)]
pub struct llama_vocab {
    _opaque: [u8; 0],
}
#[repr(C)]
pub struct llama_sampler {
    _opaque: [u8; 0],
}

// -----------------------------------------------------------------------
// Token + index integer typedefs from llama.h. They're plain int32_t.
// -----------------------------------------------------------------------

pub type llama_token = i32;
pub type llama_pos = i32;
pub type llama_seq_id = i32;

// -----------------------------------------------------------------------
// Parameter structs. Field order MUST match llama.h at the pinned tag.
// We never construct these directly — see file-level comment.
//
// Pre-construction safety: tools like sizeof_val are reasonable
// double-checks if we ever suspect a mismatch. For the probe we
// rely on the DLL-provided default constructor.
// -----------------------------------------------------------------------

#[repr(C)]
pub struct llama_model_params {
    pub devices: *mut c_void,                  // ggml_backend_dev_t *
    pub tensor_buft_overrides: *const c_void,  // ...tensor_buft_override *
    pub n_gpu_layers: i32,
    pub split_mode: i32, // llama_split_mode (enum)
    pub main_gpu: i32,
    pub tensor_split: *const c_float,
    pub progress_callback: *mut c_void, // fn ptr, opaque for us
    pub progress_callback_user_data: *mut c_void,
    pub kv_overrides: *const c_void, // llama_model_kv_override *
    pub vocab_only: bool,
    pub use_mmap: bool,
    // `use_direct_io` was missing, which silently shifted every bool after it
    // by one byte — we were handing the DLL `use_direct_io`'s default as
    // `use_mlock`, and so on down the struct.
    pub use_direct_io: bool,
    pub use_mlock: bool,
    pub check_tensors: bool,
    pub use_extra_bufts: bool,
    pub no_host: bool,
    pub no_alloc: bool,
}

#[repr(C)]
pub struct llama_context_params {
    pub n_ctx: u32,
    pub n_batch: u32,
    pub n_ubatch: u32,
    pub n_seq_max: u32,
    pub n_rs_seq: u32,
    pub n_threads: i32,
    pub n_threads_batch: i32,
    pub ctx_type: i32,         // enum llama_context_type
    pub rope_scaling_type: i32, // enum
    pub pooling_type: i32,     // enum
    pub attention_type: i32,   // enum
    pub flash_attn_type: i32,  // enum
    pub rope_freq_base: c_float,
    pub rope_freq_scale: c_float,
    pub yarn_ext_factor: c_float,
    pub yarn_attn_factor: c_float,
    pub yarn_beta_fast: c_float,
    pub yarn_beta_slow: c_float,
    pub yarn_orig_ctx: u32,
    pub defrag_thold: c_float,
    pub cb_eval: *mut c_void,
    pub cb_eval_user_data: *mut c_void,
    pub type_k: i32, // enum ggml_type
    pub type_v: i32, // enum ggml_type
    pub abort_callback: *mut c_void,
    pub abort_callback_data: *mut c_void,
    pub embeddings: bool,
    pub offload_kqv: bool,
    pub no_perf: bool,
    pub op_offload: bool,
    pub swa_full: bool,
    pub kv_unified: bool,

    // These two were missing, and their absence is what crashed the Vulkan
    // backend. `llama_context_default_params` returns this struct *by value*:
    // on Win64 that means the caller supplies the destination buffer, so the
    // DLL wrote its full 144 bytes into our 128-byte stack slot and smashed
    // 16 bytes of whatever followed. A debug build has enough frame slack to
    // absorb that; an optimised build packs frames tightly, so the overwrite
    // hit live data and `llama_init_from_model` faulted with
    // STATUS_ACCESS_VIOLATION. That is precisely why this only ever crashed
    // in release builds.
    //
    // We never set these — the DLL's defaults (null / 0) are what we want —
    // but they must exist so the struct is the right size and the trailing
    // bytes are ours.
    pub samplers: *mut c_void, // llama_sampler_seq_config *
    pub n_samplers: usize,     // size_t
}

// Sizes derived from `scripts/ml/vulkan_probe/llama_headers/llama.h` at the
// pinned tag. These structs cross the FFI boundary *by value* in both
// directions, so a size mismatch is not a mis-read field — it is a stack
// buffer overflow. Assert at compile time rather than discover it as an
// access violation months later. If a future llama.cpp bump trips these,
// re-derive the layout from the new header instead of adjusting the number.
const _: () = assert!(
    core::mem::size_of::<llama_context_params>() == 144,
    "llama_context_params must match llama.h exactly — it is returned by value",
);
const _: () = assert!(
    core::mem::size_of::<llama_model_params>() == 72,
    "llama_model_params must match llama.h exactly — it is returned by value",
);
const _: () = assert!(
    core::mem::size_of::<llama_batch>() == 56,
    "llama_batch must match llama.h exactly — it is passed by value to llama_decode",
);

#[repr(C)]
pub struct llama_sampler_chain_params {
    pub no_perf: bool,
}

#[repr(C)]
pub struct llama_chat_message {
    pub role: *const c_char,
    pub content: *const c_char,
}

// The batch is passed BY VALUE across the FFI boundary. Field layout
// matches llama.h's `llama_batch` exactly. Pointer fields point at
// caller-owned buffers — we manage the allocation/lifetime, the DLL
// just reads/writes through them.
#[repr(C)]
pub struct llama_batch {
    pub n_tokens: i32,
    pub token: *mut llama_token,
    pub embd: *mut c_float,
    pub pos: *mut llama_pos,
    pub n_seq_id: *mut i32,
    pub seq_id: *mut *mut llama_seq_id,
    pub logits: *mut i8,
}

// -----------------------------------------------------------------------
// Function pointer types. These are what `libloading::Library::get`
// returns, parameterized by the same signature as the DLL exports.
// Grouped here so the loader struct below stays readable.
// -----------------------------------------------------------------------

pub type FnBackendInit = unsafe extern "C" fn();
pub type FnBackendFree = unsafe extern "C" fn();

// Recent llama.cpp split backend registration out of llama_backend_init —
// it no longer auto-loads ggml-vulkan.dll / ggml-cpu-*.dll. Without an
// explicit `ggml_backend_load_all_from_path(dir)` call, model load
// fails with: "no backends are loaded. hint: use ggml_backend_load()
// or ggml_backend_load_all() ...". The function is GGML_API (defined
// in ggml-base.dll) but re-exported through llama.dll so we resolve
// it off the same handle.
pub type FnBackendLoadAllFromPath = unsafe extern "C" fn(dir_path: *const c_char);

pub type FnModelDefaultParams = unsafe extern "C" fn() -> llama_model_params;
pub type FnContextDefaultParams = unsafe extern "C" fn() -> llama_context_params;
pub type FnSamplerChainDefaultParams =
    unsafe extern "C" fn() -> llama_sampler_chain_params;

pub type FnModelLoadFromFile =
    unsafe extern "C" fn(path: *const c_char, params: llama_model_params) -> *mut llama_model;
pub type FnModelFree = unsafe extern "C" fn(model: *mut llama_model);
pub type FnInitFromModel = unsafe extern "C" fn(
    model: *mut llama_model,
    params: llama_context_params,
) -> *mut llama_context;
pub type FnFreeCtx = unsafe extern "C" fn(ctx: *mut llama_context);

pub type FnModelGetVocab =
    unsafe extern "C" fn(model: *const llama_model) -> *const llama_vocab;
pub type FnVocabIsEog =
    unsafe extern "C" fn(vocab: *const llama_vocab, token: llama_token) -> bool;
pub type FnModelChatTemplate =
    unsafe extern "C" fn(model: *const llama_model, name: *const c_char) -> *const c_char;

pub type FnChatApplyTemplate = unsafe extern "C" fn(
    tmpl: *const c_char,
    chat: *const llama_chat_message,
    n_msg: usize,
    add_ass: bool,
    buf: *mut c_char,
    length: i32,
) -> i32;

pub type FnTokenize = unsafe extern "C" fn(
    vocab: *const llama_vocab,
    text: *const c_char,
    text_len: i32,
    tokens: *mut llama_token,
    n_tokens_max: i32,
    add_special: bool,
    parse_special: bool,
) -> i32;
pub type FnTokenToPiece = unsafe extern "C" fn(
    vocab: *const llama_vocab,
    token: llama_token,
    buf: *mut c_char,
    length: i32,
    lstrip: i32,
    special: bool,
) -> i32;

pub type FnBatchInit =
    unsafe extern "C" fn(n_tokens: i32, embd: i32, n_seq_max: i32) -> llama_batch;
pub type FnBatchFree = unsafe extern "C" fn(batch: llama_batch);
pub type FnDecode =
    unsafe extern "C" fn(ctx: *mut llama_context, batch: llama_batch) -> i32;

pub type FnSamplerChainInit =
    unsafe extern "C" fn(params: llama_sampler_chain_params) -> *mut llama_sampler;
pub type FnSamplerChainAdd =
    unsafe extern "C" fn(chain: *mut llama_sampler, smpl: *mut llama_sampler);
pub type FnSamplerInitGreedy = unsafe extern "C" fn() -> *mut llama_sampler;
pub type FnSamplerInitPenalties = unsafe extern "C" fn(
    last_n: i32,
    repeat: c_float,
    freq: c_float,
    present: c_float,
) -> *mut llama_sampler;
pub type FnSamplerSample = unsafe extern "C" fn(
    smpl: *mut llama_sampler,
    ctx: *mut llama_context,
    idx: i32,
) -> llama_token;
pub type FnSamplerAccept =
    unsafe extern "C" fn(smpl: *mut llama_sampler, token: llama_token);
pub type FnSamplerFree = unsafe extern "C" fn(smpl: *mut llama_sampler);

// ggml_log_callback — matches `typedef void (*)(enum ggml_log_level,
// const char * text, void * user_data)` from ggml.h. The enum is `int`
// on MSVC; pass i32 and the DLL doesn't care which variant we ignore.
pub type GgmlLogCallback =
    unsafe extern "C" fn(level: i32, text: *const c_char, user_data: *mut c_void);
pub type FnLogSet =
    unsafe extern "C" fn(callback: Option<GgmlLogCallback>, user_data: *mut c_void);

// -----------------------------------------------------------------------
// Loader. Wraps `libloading::Library` plus all resolved symbol pointers
// in one struct. Construction does the dlopen + symbol lookup; the rest
// of the probe goes through these typed function pointers.
//
// SAFETY NOTE on lifetimes: `libloading::Symbol<'lib>` borrows the
// library; storing both in the same struct ties the symbol lifetimes
// to the library by construction, which is what we want. We use
// `into_raw()` to detach symbols from the library lifetime — the loader
// is held for the program's lifetime so the DLL stays mapped, which
// makes the raw pointers safe to call.
// -----------------------------------------------------------------------

#[allow(dead_code)] // _lib + _ggml_lib are held to keep the DLLs mapped.
pub struct Llama {
    _lib: libloading::Library,
    // ggml-base.dll handle, held separately because Windows DLL symbol
    // namespaces don't merge across dependencies — even though
    // llama.dll loaded ggml-base.dll as an import, GetProcAddress on
    // llama's handle can't see ggml's exports. The `ggml_backend_*`
    // API lives here and must be resolved off this handle.
    _ggml_lib: libloading::Library,

    pub backend_init: FnBackendInit,
    pub backend_free: FnBackendFree,
    pub backend_load_all_from_path: FnBackendLoadAllFromPath,

    pub model_default_params: FnModelDefaultParams,
    pub context_default_params: FnContextDefaultParams,
    pub sampler_chain_default_params: FnSamplerChainDefaultParams,

    pub model_load_from_file: FnModelLoadFromFile,
    pub model_free: FnModelFree,
    pub init_from_model: FnInitFromModel,
    pub free_ctx: FnFreeCtx,

    pub model_get_vocab: FnModelGetVocab,
    pub vocab_is_eog: FnVocabIsEog,
    pub model_chat_template: FnModelChatTemplate,
    pub chat_apply_template: FnChatApplyTemplate,
    pub tokenize: FnTokenize,
    pub token_to_piece: FnTokenToPiece,

    pub batch_init: FnBatchInit,
    pub batch_free: FnBatchFree,
    pub decode: FnDecode,

    pub sampler_chain_init: FnSamplerChainInit,
    pub sampler_chain_add: FnSamplerChainAdd,
    pub sampler_init_greedy: FnSamplerInitGreedy,
    pub sampler_init_penalties: FnSamplerInitPenalties,
    pub sampler_sample: FnSamplerSample,
    pub sampler_accept: FnSamplerAccept,
    pub sampler_free: FnSamplerFree,

    // Log silencing — production mutes llama.cpp's per-tensor loading
    // chatter that the spike printed during validation.
    pub log_set: FnLogSet,
}

impl Llama {
    /// Load `llama.dll` from a directory. The DLL's transitive deps
    /// (`ggml.dll`, `ggml-base.dll`, `ggml-vulkan.dll`, etc.) must be in
    /// the same directory — Windows' DLL search resolves them by name
    /// from the directory of the first-loaded DLL.
    pub fn load(dll_dir: &std::path::Path) -> anyhow::Result<Self> {
        let llama_dll = dll_dir.join("llama.dll");
        // SAFETY: caller's responsibility — we trust the DLL came from
        // the pinned llama.cpp release. libloading::Library::new is
        // unsafe because loading arbitrary native code is inherently so.
        //
        // Why `os::windows::Library::load_with_flags` and not
        // `libloading::Library::new`: by default Windows resolves
        // llama.dll's imports (ggml.dll, ggml-vulkan.dll, ggml-base.dll,
        // ggml-cpu-x64.dll, libomp140.x86_64.dll) from the calling
        // EXE's directory + System32 + PATH — NOT from llama.dll's own
        // directory. Without the altered search-path flag, loading
        // succeeds only if every sibling DLL is on PATH, which it
        // isn't in `<app local data>/llama_vulkan/`. The result is
        // `LoadLibraryExW failed` (error 126). The flag tells Windows
        // to also probe the loaded DLL's directory for its dependency
        // chain — the standard idiom for sidecar DLL bundles.
        use libloading::os::windows::{Library as WinLibrary, LOAD_WITH_ALTERED_SEARCH_PATH};
        let win_lib = unsafe {
            WinLibrary::load_with_flags(&llama_dll, LOAD_WITH_ALTERED_SEARCH_PATH)
        }
        .map_err(|e| anyhow::anyhow!("load {llama_dll:?}: {e}"))?;
        let lib: libloading::Library = win_lib.into();

        // Also grab a handle to ggml.dll for backend-loading symbols
        // (see struct field doc). ggml.dll is the small umbrella DLL
        // that exports the ggml_backend_* loader API; ggml-base.dll
        // holds the heavier types (tensors, contexts). Both are already
        // mapped via llama.dll's dependency chain — this just bumps
        // the refcount so GetProcAddress can find the loader symbols.
        let ggml_dll = dll_dir.join("ggml.dll");
        let win_ggml_lib = unsafe {
            WinLibrary::load_with_flags(&ggml_dll, LOAD_WITH_ALTERED_SEARCH_PATH)
        }
        .map_err(|e| anyhow::anyhow!("load {ggml_dll:?}: {e}"))?;
        let ggml_lib: libloading::Library = win_ggml_lib.into();

        macro_rules! sym {
            ($name:literal, $ty:ty) => {{
                let s: libloading::Symbol<$ty> = unsafe { lib.get($name) }
                    .map_err(|e| anyhow::anyhow!("symbol {}: {e}", stringify!($name)))?;
                // Detach lifetime — see SAFETY NOTE on the struct.
                unsafe { std::mem::transmute::<libloading::Symbol<$ty>, $ty>(s) }
            }};
        }

        // Like sym! but pulls from the ggml-base.dll handle. Used for
        // the ggml_backend_* family of functions which aren't exported
        // by llama.dll.
        macro_rules! ggml_sym {
            ($name:literal, $ty:ty) => {{
                let s: libloading::Symbol<$ty> = unsafe { ggml_lib.get($name) }
                    .map_err(|e| anyhow::anyhow!("ggml symbol {}: {e}", stringify!($name)))?;
                unsafe { std::mem::transmute::<libloading::Symbol<$ty>, $ty>(s) }
            }};
        }

        Ok(Self {
            backend_init: sym!(b"llama_backend_init", FnBackendInit),
            backend_free: sym!(b"llama_backend_free", FnBackendFree),
            // GGML backend loader lives in ggml-base.dll, not llama.dll.
            backend_load_all_from_path: ggml_sym!(
                b"ggml_backend_load_all_from_path",
                FnBackendLoadAllFromPath
            ),
            model_default_params: sym!(b"llama_model_default_params", FnModelDefaultParams),
            context_default_params: sym!(
                b"llama_context_default_params",
                FnContextDefaultParams
            ),
            sampler_chain_default_params: sym!(
                b"llama_sampler_chain_default_params",
                FnSamplerChainDefaultParams
            ),
            model_load_from_file: sym!(b"llama_model_load_from_file", FnModelLoadFromFile),
            model_free: sym!(b"llama_model_free", FnModelFree),
            init_from_model: sym!(b"llama_init_from_model", FnInitFromModel),
            free_ctx: sym!(b"llama_free", FnFreeCtx),
            model_get_vocab: sym!(b"llama_model_get_vocab", FnModelGetVocab),
            vocab_is_eog: sym!(b"llama_vocab_is_eog", FnVocabIsEog),
            model_chat_template: sym!(b"llama_model_chat_template", FnModelChatTemplate),
            chat_apply_template: sym!(b"llama_chat_apply_template", FnChatApplyTemplate),
            tokenize: sym!(b"llama_tokenize", FnTokenize),
            token_to_piece: sym!(b"llama_token_to_piece", FnTokenToPiece),
            batch_init: sym!(b"llama_batch_init", FnBatchInit),
            batch_free: sym!(b"llama_batch_free", FnBatchFree),
            decode: sym!(b"llama_decode", FnDecode),
            sampler_chain_init: sym!(b"llama_sampler_chain_init", FnSamplerChainInit),
            sampler_chain_add: sym!(b"llama_sampler_chain_add", FnSamplerChainAdd),
            sampler_init_greedy: sym!(b"llama_sampler_init_greedy", FnSamplerInitGreedy),
            sampler_init_penalties: sym!(
                b"llama_sampler_init_penalties",
                FnSamplerInitPenalties
            ),
            sampler_sample: sym!(b"llama_sampler_sample", FnSamplerSample),
            sampler_accept: sym!(b"llama_sampler_accept", FnSamplerAccept),
            sampler_free: sym!(b"llama_sampler_free", FnSamplerFree),
            log_set: sym!(b"llama_log_set", FnLogSet),
            _lib: lib,
            _ggml_lib: ggml_lib,
        })
    }
}

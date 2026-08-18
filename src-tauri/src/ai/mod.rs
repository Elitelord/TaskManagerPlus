//! Local AI module — tiered, fully on-device inference.
//!
//! See `docs/AI_INTEGRATION_PLAN.md` for the design. This module is the
//! foundation: tier state management plus the public API surface the
//! frontend talks to via Tauri commands. Model loading and actual
//! inference are added in later phases — for now, every classifier /
//! embedder stub returns `None` or an empty result, gated on tier.
//!
//! Privacy contract: the bundled CPU + Vulkan paths make zero network
//! calls. Ever. The only exception is the BYO Ollama backend (Z3),
//! which talks to an explicit user-configured endpoint (loopback by
//! default) — it lives in `genlm_ollama` and only runs when the user
//! has selected Ollama in Settings. Anything outside that boundary
//! must be reviewable against `docs/AI_INTEGRATION_PLAN.md` §3.6.

pub mod classifiers;
pub mod embedding_cache;
pub mod embeddings;
#[cfg(windows)]
pub mod embeddings_dml;
pub mod genlm;
pub mod genlm_ollama;
#[cfg(windows)]
pub mod genlm_vulkan;
#[cfg(windows)]
pub mod llama_ffi;
pub mod model_download;
pub mod software_corpus;
pub mod text_extract;
pub mod types;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use types::{AiStatus, AiTier};

// ---------------------------------------------------------------------------
// Idle model unloading.
//
// The generative model (Qwen 0.5B GGUF) and the embedding model together pin
// ~500 MB of RAM (or VRAM on the GPU backends) once loaded, and nothing freed
// them for the life of the process — a user who ran one Smart Rename kept half
// a gigabyte resident until they quit. A background reaper (see `lib::setup`)
// unloads them after a window of no AI use; the next AI call transparently
// reloads (a few seconds of cold-load latency). The model *files* stay on disk,
// so reload is just re-reading them.
// ---------------------------------------------------------------------------

/// Idle window after which loaded AI models are unloaded. Defaults to 10
/// minutes; overridable via the `TMP_AI_IDLE_MS` env var for QA (e.g. set it
/// to 60000 to watch an unload happen a minute after use).
pub fn ai_idle_unload_ms() -> u64 {
    std::env::var("TMP_AI_IDLE_MS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|&v| v > 0)
        .unwrap_or(10 * 60 * 1000)
}

/// Serialises *first-time GPU runtime bring-up* across the two independent
/// GPU backends: ggml-vulkan (generative, `genlm_vulkan`) and onnxruntime
/// DirectML/D3D12 (embeddings, `embeddings_dml`).
///
/// Each module already has its own init lock, but those only guard a backend
/// against itself. Nothing stopped Vulkan device creation from running
/// concurrently with D3D12 device creation on the *same adapter* in the same
/// process — which is what happened when the frontend fired
/// `ai_prewarm_embedder` and `ai_prewarm_genlm` back-to-back on the Enhanced
/// tier: two `spawn_blocking` threads, two GPU runtimes coming up at once,
/// and the driver faulting with STATUS_ACCESS_VIOLATION a moment after both
/// reported success.
///
/// Bringing them up one at a time costs a second of startup latency on the
/// very first load and nothing thereafter (both callers check their cached
/// handle before reaching for this lock). Note this guards *initialisation*
/// only — inference on the two backends still runs concurrently.
pub(crate) static GPU_INIT_LOCK: Mutex<()> = Mutex::new(());

/// Take [`GPU_INIT_LOCK`], recovering from poisoning. A previous backend's
/// init panicking must not permanently disable the other backend — the
/// guarded data is `()`, so there is no state to be left inconsistent.
#[cfg(windows)]
pub(crate) fn gpu_init_guard() -> std::sync::MutexGuard<'static, ()> {
    GPU_INIT_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// Epoch-ms of the last AI model use. 0 = never used (nothing to unload).
static LAST_AI_USE_MS: AtomicU64 = AtomicU64::new(0);

fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Record AI activity. Called from every generative / embedding entry point so
/// the reaper's clock resets whenever a model is actually used.
pub(crate) fn touch_ai_use() {
    LAST_AI_USE_MS.store(now_epoch_ms(), Ordering::Relaxed);
}

/// Pure decision: should idle models be unloaded now? `last_ms == 0` means
/// nothing has ever loaded, so there's nothing to reclaim. Extracted for
/// testing without touching the globals or wall clock.
pub(crate) fn should_unload(now_ms: u64, last_ms: u64, idle_window_ms: u64) -> bool {
    last_ms != 0 && now_ms.saturating_sub(last_ms) >= idle_window_ms
}

/// Unload any idle AI models to reclaim memory. Safe to call on a timer: a
/// no-op when nothing is loaded or the models were used recently. Backend
/// *choice* caches (which GPU/CPU path was picked) are left intact, so the
/// next call reloads on the same backend. Returns true if anything dropped.
pub fn maybe_unload_idle_models() -> bool {
    let last = LAST_AI_USE_MS.load(Ordering::Relaxed);
    if !should_unload(now_epoch_ms(), last, ai_idle_unload_ms()) {
        return false;
    }

    let mut dropped = genlm::unload_idle();
    if embeddings::unload_embedder() {
        dropped = true;
    }
    #[cfg(windows)]
    if embeddings_dml::unload() {
        dropped = true;
    }

    if dropped {
        // Reset so the reaper doesn't re-run the now-empty unload every tick;
        // the next real use touches the clock again.
        LAST_AI_USE_MS.store(0, Ordering::Relaxed);
        log::info!("ai: unloaded idle models to reclaim memory");
    }
    dropped
}

/// Global AI state. Lock granularity is deliberately coarse: tier changes
/// are user-initiated and infrequent, inference calls are bounded in
/// duration, and we expect at most a few concurrent callers from the
/// frontend. If contention ever shows up in profiling we can split this
/// into per-resource locks.
struct AiState {
    tier: AiTier,
    /// Identifiers of models currently loaded into memory. Empty in
    /// Phase 1 — populated once the runtime is wired up.
    models_loaded: Vec<String>,
}

impl AiState {
    fn new() -> Self {
        Self {
            tier: AiTier::Off,
            models_loaded: Vec::new(),
        }
    }
}

fn state() -> &'static Mutex<AiState> {
    static STATE: OnceLock<Mutex<AiState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(AiState::new()))
}

/// Return a snapshot of the current AI subsystem state for the frontend.
pub fn get_status() -> AiStatus {
    let guard = state().lock().expect("ai state poisoned");
    AiStatus {
        tier: guard.tier,
        models_loaded: guard.models_loaded.clone(),
        // Phase 1: skip RAM probing. Available RAM is not used to gate
        // anything yet because no real models load until Phase 2.
        available_ram_mb: None,
    }
}

/// Set the active AI tier. In later phases this also drives lazy model
/// loading and unloading; for now it just records the choice.
pub fn set_tier(new_tier: AiTier) {
    let mut guard = state().lock().expect("ai state poisoned");
    if guard.tier == new_tier {
        return;
    }
    log::info!("AI tier change: {:?} -> {:?}", guard.tier, new_tier);
    guard.tier = new_tier;
    // Phase 2 hook: load/unload models to match the new tier here.
    // For now there's nothing to load.
    guard.models_loaded.clear();
}

/// Internal accessor used by stubbed classifiers to short-circuit when
/// the current tier doesn't enable AI. Kept private — frontend callers
/// go through `get_status`.
#[allow(dead_code)] // will be used once classifiers come online
fn current_tier() -> AiTier {
    state().lock().expect("ai state poisoned").tier
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_unload_respects_window_and_never_used() {
        let window = 600_000; // 10 min
        let now = 10_000_000;
        // Never used → never unload.
        assert!(!should_unload(now, 0, window));
        // 9m59s idle → not yet.
        assert!(!should_unload(now, now - 599_000, window));
        // Exactly 10m and just past → unload.
        assert!(should_unload(now, now - 600_000, window));
        assert!(should_unload(now, now - 601_000, window));
    }

    #[test]
    fn unload_on_empty_state_is_false_and_safe() {
        // With nothing loaded, the embedder unload is a harmless no-op that
        // must not panic or poison the lock. (genlm/dml unloads are exercised
        // via integration when models are actually present.)
        let _ = embeddings::unload_embedder();
    }
}

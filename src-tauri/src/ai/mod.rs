//! Local AI module — tiered, fully on-device inference.
//!
//! See `docs/AI_INTEGRATION_PLAN.md` for the design. This module is the
//! foundation: tier state management plus the public API surface the
//! frontend talks to via Tauri commands. Model loading and actual
//! inference are added in later phases — for now, every classifier /
//! embedder stub returns `None` or an empty result, gated on tier.
//!
//! Privacy contract: no network access from this module. Ever. Anything
//! that would hit the network must live elsewhere and be reviewable
//! against `docs/AI_INTEGRATION_PLAN.md` §3.6.

pub mod classifiers;
pub mod embedding_cache;
pub mod embeddings;
pub mod model_download;
pub mod text_extract;
pub mod types;

use std::sync::{Mutex, OnceLock};
use types::{AiStatus, AiTier};

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

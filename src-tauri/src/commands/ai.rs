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

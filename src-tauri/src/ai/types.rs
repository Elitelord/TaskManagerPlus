//! Shared AI types — serialized to the frontend via Tauri commands.
//!
//! Keep field names matching the camelCase used in the TS bindings
//! (`src/lib/ai/types.ts`) via `#[serde(rename_all = "camelCase")]`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiTier {
    /// No embedding model. Default. The bundled leak classifier still runs
    /// (it is compiled into the binary, on-device, ~4 KB) — the tier only
    /// governs the downloaded models.
    Off,
    /// The ~33 MB bge-small embedding model enabling content search,
    /// clustering, near-duplicate detection, and tagging for the file
    /// organizer.
    Standard,
    /// Standard PLUS the ~258 MB on-device generative model (SmolLM2-360M)
    /// for AI writing features (smart-rename, …). "Enhanced" once named a
    /// bigger embedding model (dropped after spikes S-13/S-14); the name is
    /// reused for the generative add-on (Phase 5).
    Enhanced,
}

impl AiTier {
    /// True when the embedding model should be loaded (Standard or Enhanced).
    #[allow(dead_code)] // consumers in Phase 3+
    pub fn enables_embeddings(self) -> bool {
        matches!(self, AiTier::Standard | AiTier::Enhanced)
    }

    /// True when the generative model should be loaded (Enhanced only).
    #[allow(dead_code)] // generative gating is currently frontend-side
    pub fn enables_generative(self) -> bool {
        matches!(self, AiTier::Enhanced)
    }
}

/// Snapshot of the AI subsystem state, sent to the frontend on
/// `ai_get_status`. Field names match the TS interface.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    pub tier: AiTier,
    /// Identifiers of currently-loaded models (empty in Phase 1).
    pub models_loaded: Vec<String>,
    /// Best-effort estimate of available system RAM in MB. `None` when
    /// not probed (Phase 1) — frontend treats `None` as "unknown" and
    /// doesn't gate UI on it.
    pub available_ram_mb: Option<u64>,
}

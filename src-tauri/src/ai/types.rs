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
    /// governs the embedding model.
    Off,
    /// The ~33 MB bge-small embedding model enabling content search,
    /// clustering, near-duplicate detection, and tagging for the file
    /// organizer. (The retired "enhanced" tier — a larger model — was
    /// dropped after spikes S-13/S-14; the frontend migrates any persisted
    /// "enhanced" setting to "standard" before it reaches here.)
    Standard,
}

impl AiTier {
    /// True when the embedding model should be loaded.
    #[allow(dead_code)] // first consumer is in Phase 3
    pub fn enables_embeddings(self) -> bool {
        matches!(self, AiTier::Standard)
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

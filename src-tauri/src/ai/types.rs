//! Shared AI types — serialized to the frontend via Tauri commands.
//!
//! Keep field names matching the camelCase used in the TS bindings
//! (`src/lib/ai/types.ts`) via `#[serde(rename_all = "camelCase")]`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiTier {
    /// No AI features. Default. Rules-only behavior throughout the app.
    Off,
    /// Bundled <10 MB classifiers for narrow tasks (process category,
    /// project folder, leak vs cache-warmup, etc.).
    Lite,
    /// Lite + a tiny embedding model (~25–40 MB) enabling semantic
    /// similarity and clustering.
    Standard,
    /// Lite + a larger embedding model (~100–150 MB, downloaded on
    /// demand) for higher-quality clustering and content search.
    Enhanced,
}

impl AiTier {
    /// True when AI features should be exposed at all. Lite or higher.
    #[allow(dead_code)] // first consumer is in Phase 2
    pub fn enables_classifiers(self) -> bool {
        !matches!(self, AiTier::Off)
    }

    /// True when embedding-based features are unlocked. Standard or higher.
    #[allow(dead_code)] // first consumer is in Phase 3
    pub fn enables_embeddings(self) -> bool {
        matches!(self, AiTier::Standard | AiTier::Enhanced)
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

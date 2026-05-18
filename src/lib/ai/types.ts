// Mirror of `src-tauri/src/ai/types.rs`. Keep field names in sync — Rust
// serializes camelCase via serde rename_all.

export type AiTier = "off" | "standard" | "enhanced";

export const AI_TIERS: AiTier[] = ["off", "standard", "enhanced"];

export interface AiStatus {
  tier: AiTier;
  /** Identifiers of currently-loaded models. Empty until Phase 3. */
  modelsLoaded: string[];
  /** Best-effort available RAM in MB. `null` = unknown (don't gate UI on it). */
  availableRamMb: number | null;
}

export interface ClassificationResult {
  category: string | null;
  confidence: number | null;
}

export interface LeakClassification {
  class: string | null;
  confidence: number | null;
}

/**
 * True when the selected tier loads the semantic embedding model.
 *
 * This is the ONLY thing the tier setting gates. The bundled leak
 * classifier (I1) runs at every tier, including Off — it is a ~4 KB
 * decision tree compiled into the binary, on-device, with no network or
 * meaningful CPU cost, so there is nothing to opt out of. The tier exists
 * purely to govern the larger embedding model (Standard / Enhanced), which
 * has real install-size and RAM cost.
 */
export function tierEnablesEmbeddings(t: AiTier): boolean {
  return t === "standard" || t === "enhanced";
}

/** Human-readable label per tier (used by Settings UI). */
export const AI_TIER_LABELS: Record<AiTier, string> = {
  off: "Off",
  standard: "Standard",
  enhanced: "Enhanced",
};

/** One-line description of what each tier unlocks (used by Settings UI). */
export const AI_TIER_DESCRIPTIONS: Record<AiTier, string> = {
  off:
    "No embedding model. Smart-organizer file features use the built-in " +
    "rules engine. This is the default.",
  standard:
    "Adds a small embedding model (~30–50 MB) for semantic file " +
    "clustering, near-duplicate detection, and smarter folder-name " +
    "suggestions.",
  enhanced:
    "Adds a larger embedding model (~110–160 MB, downloaded on first use) " +
    "for higher-quality clustering and intent-based file search.",
};

/** Approximate installer/disk impact per tier — shown in the picker. */
export const AI_TIER_SIZE_LABELS: Record<AiTier, string> = {
  off: "0 MB extra",
  standard: "~30–50 MB",
  enhanced: "~110–160 MB (downloaded on demand)",
};

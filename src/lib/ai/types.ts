// Mirror of `src-tauri/src/ai/types.rs`. Keep field names in sync — Rust
// serializes camelCase via serde rename_all.

// Enhanced was removed after spikes S-13/S-14 showed a larger embedding
// model performs no better (worse, even) than Standard's bge-small on
// real data — see docs/AI_INTEGRATION_PLAN.md. The tier is now a simple
// on/off for the one embedding model.
export type AiTier = "off" | "standard";

export const AI_TIERS: AiTier[] = ["off", "standard"];

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
  return t === "standard";
}

/** Human-readable label per tier (used by Settings UI). */
export const AI_TIER_LABELS: Record<AiTier, string> = {
  off: "Off",
  standard: "Standard",
};

/** One-line description of what each tier unlocks (used by Settings UI). */
export const AI_TIER_DESCRIPTIONS: Record<AiTier, string> = {
  off:
    "AI features off. The file organizer still works using its built-in " +
    "rules. This is the default.",
  standard:
    "Turns on AI file features: search your files by content, group " +
    "related ones, and find duplicates other tools miss. One-time " +
    "~33 MB download; everything runs on your device.",
};

/** Approximate installer/disk impact per tier — shown in the picker. */
export const AI_TIER_SIZE_LABELS: Record<AiTier, string> = {
  off: "No extra space",
  standard: "~33 MB download",
};

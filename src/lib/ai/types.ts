// Mirror of `src-tauri/src/ai/types.rs`. Keep field names in sync — Rust
// serializes camelCase via serde rename_all.

// Tiers (Phase 5):
//   off      — no models; rules-only organizer + the bundled leak classifier.
//   standard — the embedding model (semantic search / grouping / duplicates).
//   enhanced — Standard PLUS the on-device generative model (AI writing:
//              smart-rename, etc.). "Enhanced" once meant a bigger embedding
//              model (killed by spikes S-13/S-14); the name is reused here for
//              the generative add-on, which is a real, validated value bump.
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
 * True when the selected tier loads the semantic embedding model. Both
 * Standard and Enhanced include embeddings (Enhanced is a superset).
 *
 * The bundled leak classifier (I1) runs at every tier, including Off — it is
 * a ~4 KB decision tree compiled into the binary, so there's nothing to opt
 * out of. The tier governs the larger downloaded models.
 */
export function tierEnablesEmbeddings(t: AiTier): boolean {
  return t === "standard" || t === "enhanced";
}

/**
 * True when the tier loads the on-device GENERATIVE model (AI writing:
 * smart-rename, insight narratives, …). Only Enhanced. Generative is a
 * superset of Standard — there's no "generative without embeddings" tier.
 */
export function tierEnablesGenerative(t: AiTier): boolean {
  return t === "enhanced";
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
    "AI features off. The file organizer still works using its built-in " +
    "rules. This is the default.",
  standard:
    "Turns on AI file features: search your files by content, group " +
    "related ones, and find duplicates other tools miss. One-time " +
    "~33 MB download; everything runs on your device.",
  enhanced:
    "Everything in Standard, plus on-device AI writing — like suggesting " +
    "better names for badly-named files from their contents. Adds a " +
    "~380 MB writing model; still 100% on your device, nothing uploaded.",
};

/** Approximate installer/disk impact per tier — shown in the picker. */
export const AI_TIER_SIZE_LABELS: Record<AiTier, string> = {
  off: "No extra space",
  standard: "~33 MB download",
  enhanced: "~413 MB total",
};

// Mirror of `src-tauri/src/ai/types.rs`. Keep field names in sync — Rust
// serializes camelCase via serde rename_all.

export type AiTier = "off" | "lite" | "standard" | "enhanced";

export const AI_TIERS: AiTier[] = ["off", "lite", "standard", "enhanced"];

export interface AiStatus {
  tier: AiTier;
  /** Identifiers of currently-loaded models. Empty in Phase 1. */
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

/** True when the selected tier exposes classifier-based features. */
export function tierEnablesClassifiers(t: AiTier): boolean {
  return t !== "off";
}

/** True when the selected tier exposes embedding-based features. */
export function tierEnablesEmbeddings(t: AiTier): boolean {
  return t === "standard" || t === "enhanced";
}

/** Human-readable label per tier (used by Settings UI). */
export const AI_TIER_LABELS: Record<AiTier, string> = {
  off: "Off",
  lite: "Lite",
  standard: "Standard",
  enhanced: "Enhanced",
};

/** One-line description of what each tier unlocks (used by Settings UI). */
export const AI_TIER_DESCRIPTIONS: Record<AiTier, string> = {
  off: "No AI features. The app uses only rules-based logic, exactly as today.",
  lite:
    "A bundled <1 MB on-device classifier sharpens memory-leak detection — " +
    "telling a genuine leak apart from cache warmup or a startup spike. " +
    "Runs entirely on your device.",
  standard:
    "Lite features plus a small embedding model (~30–40 MB) that enables " +
    "semantic file clustering, near-duplicate detection, and smarter folder " +
    "name suggestions.",
  enhanced:
    "Standard features plus a larger embedding model (~100–150 MB, " +
    "downloaded on first use) for higher-quality clustering and intent-based " +
    "file search.",
};

/** Approximate installer/disk impact per tier — shown in the picker. */
export const AI_TIER_SIZE_LABELS: Record<AiTier, string> = {
  off: "0 MB",
  lite: "~5–10 MB",
  standard: "~30–50 MB",
  enhanced: "~110–160 MB (downloaded on demand)",
};

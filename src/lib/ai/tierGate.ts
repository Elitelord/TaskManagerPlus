// Tier-aware helpers for AI features.
//
// Only ONE thing is tier-gated: the semantic embedding model
// (Standard / Enhanced). The bundled leak classifier (I1) is a ~4 KB
// decision tree compiled into the binary — on-device, no network, no
// meaningful cost — so it runs at every tier and `tryClassifyLeak` always
// attempts it. Embedding-based features return `null` until the user opts
// into Standard or Enhanced.
//
// Pattern: each high-level function returns `null` on failure or when the
// required tier isn't met. Callers MUST handle `null` and fall back to the
// rules-based behavior — that contract is what keeps AI optional.

import { getSettings } from "../settings";
import type { AiTier, LeakClassification } from "./types";
import { tierEnablesEmbeddings } from "./types";
import { aiClassifyLeak, aiEmbedFiles } from "./api";

/** Read the current tier from app settings. */
function currentTier(): AiTier {
  return getSettings().aiTier;
}

/**
 * Classify a per-process memory series (I1 — leak / cache-warmup /
 * startup-spike / steady). NOT tier-gated: the leak classifier is bundled,
 * on-device and free, so it runs regardless of the AI tier. Returns `null`
 * only if the backend call fails — callers fall back to rules.
 */
export async function tryClassifyLeak(
  memorySeries: number[],
): Promise<LeakClassification | null> {
  try {
    return await aiClassifyLeak(memorySeries);
  } catch (err) {
    // AI must never break the host feature — log and fall through.
    console.warn("ai.classifyLeak failed:", err);
    return null;
  }
}

/** Phase 3 / S4 — embed file CONTENT for semantic clustering. Returns one
 *  vector per path, or `null` when the tier isn't Standard+, the model
 *  isn't installed, or the call fails. Callers MUST handle `null` and
 *  silently skip the semantic feature. */
export async function tryEmbedFiles(
  filePaths: string[],
): Promise<number[][] | null> {
  if (!tierEnablesEmbeddings(currentTier())) return null;
  if (filePaths.length === 0) return [];
  try {
    return await aiEmbedFiles(filePaths);
  } catch (err) {
    // Model not installed yet, or some inference failure — never break
    // the host feature; just skip S4 for this scan.
    console.warn("ai.embedFiles failed:", err);
    return null;
  }
}

// Tier-aware helpers. Every AI feature in the app goes through these so
// the "Off" tier is a single, auditable place rather than a check
// scattered across every caller.
//
// Pattern: each high-level function returns `null` when AI is disabled
// or the required tier isn't met. Callers MUST handle `null` and fall
// back to the existing rules-based behavior. This is the contract that
// makes "AI is optional" actually true.

import { getSettings } from "../settings";
import type { AiTier, ClassificationResult, LeakClassification } from "./types";
import { tierEnablesClassifiers, tierEnablesEmbeddings } from "./types";
import {
  aiClassifyLeak,
  aiClassifyProcess,
  aiClassifyProjectFolder,
} from "./api";

/** Read the current tier from app settings. */
function currentTier(): AiTier {
  return getSettings().aiTier;
}

/** Returns the classifier result, or `null` if AI is disabled or the
 *  required tier isn't met. */
export async function tryClassifyProcess(
  name: string,
): Promise<ClassificationResult | null> {
  if (!tierEnablesClassifiers(currentTier())) return null;
  try {
    return await aiClassifyProcess(name);
  } catch (err) {
    // AI must never break the host feature — log and fall through.
    console.warn("ai.classifyProcess failed:", err);
    return null;
  }
}

export async function tryClassifyLeak(
  memorySeries: number[],
): Promise<LeakClassification | null> {
  if (!tierEnablesClassifiers(currentTier())) return null;
  try {
    return await aiClassifyLeak(memorySeries);
  } catch (err) {
    console.warn("ai.classifyLeak failed:", err);
    return null;
  }
}

export async function tryClassifyProjectFolder(
  folderPath: string,
): Promise<ClassificationResult | null> {
  if (!tierEnablesClassifiers(currentTier())) return null;
  try {
    return await aiClassifyProjectFolder(folderPath);
  } catch (err) {
    console.warn("ai.classifyProjectFolder failed:", err);
    return null;
  }
}

/** Reserved for Phase 3 — returns null in Phase 1 because embedding
 *  models aren't loaded yet. Exported now so call sites can be wired up
 *  without a future API change. */
export async function tryEmbedText(
  _texts: string[],
): Promise<Float32Array[] | null> {
  if (!tierEnablesEmbeddings(currentTier())) return null;
  // Phase 3 implementation lands here.
  return null;
}

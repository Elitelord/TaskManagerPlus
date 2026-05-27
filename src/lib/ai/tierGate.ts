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
import { tierEnablesEmbeddings, tierEnablesGenerative } from "./types";
import {
  aiClassifyLeak, aiClassifyWorkload, aiEmbedFiles, aiExplainProcess, aiFindVersions,
  aiGenerateFolderName, aiGenerateSmartRename, aiGenerateSummary,
  aiSummarizeFolder, aiSuggestFolderNames,
  aiSearchSimilar, aiSearchText, aiTagFiles,
  type SearchHit, type TagInput, type TagResult, type VersionGroup,
} from "./api";

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

/** Phase 4 / S7 — natural-language file search.
 *
 *  Return-value contract (deliberately distinct from {@link tryEmbedFiles}):
 *    - `null` ONLY when the tier doesn't enable embeddings (AI is off).
 *      This is what makes the UI's "AI is not enabled" message correct.
 *    - `[]` when the cache is cold or no hits cleared the floor.
 *    - Throws on any backend error (embedder busy, model not installed,
 *      etc.). The caller's catch handler can read the error message and
 *      surface a specific reason — that's the only way to distinguish
 *      "AI is off" from "search failed for some other reason." */
export async function trySearchText(
  query: string, k = 30,
): Promise<SearchHit[] | null> {
  if (!tierEnablesEmbeddings(currentTier())) return null;
  if (!query.trim()) return [];
  return await aiSearchText(query, k);
}

/** Phase 4 / S9 — "files like this." Same return-value contract as
 *  {@link trySearchText}: null = tier off, [] = seed not in cache,
 *  throws on backend error. */
export async function trySearchSimilar(
  seedPath: string, k = 30,
): Promise<SearchHit[] | null> {
  if (!tierEnablesEmbeddings(currentTier())) return null;
  return await aiSearchSimilar(seedPath, k);
}

/** Phase 4 / S11 — cross-folder version tracking. Returns groups of
 *  near-duplicate files from the FULL embedding cache. Returns `null`
 *  when the tier is off (so callers can distinguish "no versions
 *  detected" from "feature disabled"). Errors propagate. */
export async function tryFindVersions(): Promise<VersionGroup[] | null> {
  if (!tierEnablesEmbeddings(currentTier())) return null;
  try {
    return await aiFindVersions();
  } catch (err) {
    console.warn("ai.findVersions failed:", err);
    return [];
  }
}

/** Phase 4 / S10 — per-file tag classification. Returns tag → files, or
 *  `null` when the tier is off. Empty array means the cache is cold (no
 *  files indexed yet). Errors are swallowed to `[]` so a tag failure
 *  never breaks the Storage page. */
export async function tryTagFiles(tags: TagInput[]): Promise<TagResult[] | null> {
  if (!tierEnablesEmbeddings(currentTier())) return null;
  try {
    return await aiTagFiles(tags);
  } catch (err) {
    console.warn("ai.tagFiles failed:", err);
    return [];
  }
}

/** Phase 4 / P5 — semantic explanation for a process the rule-based
 *  explainer couldn't identify. `descriptor` is the process's combined text
 *  (name + product + publisher + path + window title). Returns the matched
 *  description string, or `null` when the tier is off, the model isn't
 *  installed, nothing matched, or the call failed — every one of which means
 *  "keep the rule-based fallback." */
export async function tryExplainProcess(descriptor: string): Promise<string | null> {
  if (!tierEnablesEmbeddings(currentTier())) return null;
  if (!descriptor.trim()) return null;
  try {
    const res = await aiExplainProcess(descriptor);
    return res.description ?? null;
  } catch (err) {
    console.warn("ai.explainProcess failed:", err);
    return null;
  }
}

/** Phase 4 / P6 — semantic workload classification tie-breaker. `texts` are
 *  the busy unknown processes' window titles / product names. Returns the
 *  best workload category id (matching `WorkloadType`), or `null` when the
 *  tier is off, nothing matched confidently, or the call failed. Callers
 *  fall back to the rule-based "General Use". */
export async function tryClassifyWorkload(texts: string[]): Promise<string | null> {
  if (!tierEnablesEmbeddings(currentTier())) return null;
  if (texts.length === 0) return null;
  try {
    const res = await aiClassifyWorkload(texts);
    return res.category ?? null;
  } catch (err) {
    console.warn("ai.classifyWorkload failed:", err);
    return null;
  }
}

/** Phase 5 / Stage B — generative smart-rename. Gated by the INDEPENDENT
 *  Enhanced tier (the generative model). Returns up to 3 candidate names,
 *  `null` when the tier doesn't enable generative, or `[]` when the file
 *  yields no text. Errors (e.g. model not installed) surface so the caller
 *  can prompt to enable/download. */
export async function tryGenerateSmartRename(filePath: string): Promise<string[] | null> {
  if (!tierEnablesGenerative(currentTier())) return null;
  return await aiGenerateSmartRename(filePath);
}

/** Phase 5 / B2 — one-line file summary. `null` when the tier doesn't enable
 *  generative; `""` when the file has no readable text; the sentence
 *  otherwise. Errors (model not installed) propagate to the caller. */
export async function tryGenerateSummary(filePath: string): Promise<string | null> {
  if (!tierEnablesGenerative(currentTier())) return null;
  return await aiGenerateSummary(filePath);
}

/** Phase 5 / B3 — generative folder-name alternatives for a cluster of
 *  related files. `null` when the tier doesn't enable generative; up to 3
 *  candidate names otherwise. Errors (model not installed) propagate. */
export async function tryGenerateFolderName(fileNames: string[]): Promise<string[] | null> {
  if (!tierEnablesGenerative(currentTier())) return null;
  if (fileNames.length === 0) return [];
  return await aiGenerateFolderName(fileNames);
}

/** Phase 5 / B4 — one-line summary of an existing folder's contents. `null`
 *  when generative is off; `""` when the folder has no files. */
export async function trySummarizeFolder(folderPath: string): Promise<string | null> {
  if (!tierEnablesGenerative(currentTier())) return null;
  return await aiSummarizeFolder(folderPath);
}

/** Phase 5 / B4 — folder-name suggestions for an existing folder. `null` when
 *  generative is off; up to 3 names otherwise. */
export async function trySuggestFolderNames(folderPath: string): Promise<string[] | null> {
  if (!tierEnablesGenerative(currentTier())) return null;
  return await aiSuggestFolderNames(folderPath);
}

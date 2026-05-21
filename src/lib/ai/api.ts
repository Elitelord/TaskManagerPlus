// Thin wrappers around the Tauri `ai_*` commands. Every call goes
// through `tierGate.ts` in normal app code — this file is the raw
// transport. Don't call these directly from UI components.

import { invoke } from "@tauri-apps/api/core";
import type { AiStatus, AiTier, LeakClassification } from "./types";

export async function aiGetStatus(): Promise<AiStatus> {
  return invoke<AiStatus>("ai_get_status");
}

export async function aiSetTier(tier: AiTier): Promise<AiStatus> {
  return invoke<AiStatus>("ai_set_tier", { tier });
}

export async function aiClassifyLeak(memorySeries: number[]): Promise<LeakClassification> {
  return invoke<LeakClassification>("ai_classify_leak", { memorySeries });
}

/** Phase 3 — embed file CONTENT (filename + extracted text snippet). One
 *  vector per input path. Errors if the embedding model isn't installed. */
export async function aiEmbedFiles(filePaths: string[]): Promise<number[][]> {
  return invoke<number[][]>("ai_embed_files", { filePaths });
}

/** One model's installation state (Phase 3 download-on-demand). */
export interface ModelStatus {
  modelId: string;
  installed: boolean;
  sizeBytes: number;
}

/** Which registered AI models are present on disk. */
export async function aiModelStatus(): Promise<ModelStatus[]> {
  return invoke<ModelStatus[]>("ai_model_status");
}

/** Trigger a download of the model bundle by id. Progress streams over the
 *  `ai-model-download` Tauri event channel; this resolves when every file
 *  in the bundle is on disk with its hash verified. */
export async function aiDownloadModel(modelId: string): Promise<void> {
  return invoke<void>("ai_download_model", { modelId });
}

/** Clear the on-disk embedding cache (Stage D). Returns the count of
 *  entries that were dropped. Next scan re-embeds from scratch. */
export async function aiClearEmbeddingCache(): Promise<number> {
  return invoke<number>("ai_clear_embedding_cache");
}

/** Count of embeddings currently cached on disk. Used by the Settings UI
 *  to show "Cached: N files" + decide whether the Clear button is useful. */
export async function aiEmbeddingCacheStats(): Promise<number> {
  return invoke<number>("ai_embedding_cache_stats");
}

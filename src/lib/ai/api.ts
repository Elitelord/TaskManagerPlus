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

/** Remove a registered model's files from disk. Returns the count of
 *  files actually removed (idempotent — missing files don't error). */
export async function aiDeleteModel(modelId: string): Promise<number> {
  return invoke<number>("ai_delete_model", { modelId });
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

/** Pre-warm the embedder by loading the model into the process-wide
 *  cache. Called at app launch (when AI is on) and on Off→Standard
 *  transitions so the first user-initiated search isn't cold-load slow.
 *  No-op when the model isn't installed. Safe to call repeatedly. */
export async function aiPrewarmEmbedder(): Promise<void> {
  return invoke<void>("ai_prewarm_embedder");
}

/** One ranked hit from the S7 / S9 semantic file search. `score` is the
 *  cosine similarity between the query and the file's cached embedding —
 *  for L2-normalised vectors typically in [0, 1]. */
export interface SearchHit {
  path: string;
  score: number;
}

/** Phase 4 / S7 — intent-based file search. Embeds `query`, then ranks
 *  every cached file embedding by cosine similarity. Returns top-`k`
 *  hits. Empty array means cache is cold (no scan has populated it) or
 *  the query is empty. */
export async function aiSearchText(query: string, k = 30): Promise<SearchHit[]> {
  return invoke<SearchHit[]>("ai_search_text", { query, k });
}

/** Phase 4 / S9 — "files like this." Looks up `seedPath`'s cached vector
 *  and ranks the rest of the cache by cosine. Returns empty if the seed
 *  file isn't in the cache yet. */
export async function aiSearchSimilar(seedPath: string, k = 30): Promise<SearchHit[]> {
  return invoke<SearchHit[]>("ai_search_similar", { seedPath, k });
}

/** One detected version group from S11. `paths` is sorted with the
 *  most-recently-modified file first so callers can use it as the
 *  default "canonical" copy. `similarity` is the mean pairwise cosine
 *  among members — typically 0.95+ for true version stacks. */
export interface VersionGroup {
  paths: string[];
  similarity: number;
}

/** Phase 4 / S11 — cross-folder version tracking. Walks the FULL on-
 *  disk embedding cache (not just the current scan) and finds groups of
 *  near-identical files. Catches the same logical document under
 *  different names + locations + scan history. */
export async function aiFindVersions(): Promise<VersionGroup[]> {
  return invoke<VersionGroup[]>("ai_find_versions");
}

/** A tag definition sent to the backend for classification. */
export interface TagInput {
  id: string;
  query: string;
}

/** Files classified under one tag, sorted by match score descending. */
export interface TagResult {
  tagId: string;
  files: SearchHit[];
}

/** Phase 4 / S10 — per-file tag classification. Embeds each tag's query,
 *  assigns every cached file to its single best-matching tag (above a
 *  floor), and returns tag → files. Tags with no files are omitted. */
export async function aiTagFiles(tags: TagInput[]): Promise<TagResult[]> {
  return invoke<TagResult[]>("ai_tag_files", { tags });
}

/** Result of P5 semantic process explanation. `description` is null when
 *  nothing in the corpus matched closely enough. */
export interface ProcessExplanation {
  description: string | null;
  confidence: number | null;
}

/** Phase 4 / P5 — explain an unknown process. `descriptor` is the process's
 *  combined text (name + product + publisher + path + window title). Returns
 *  the closest curated software description, or null description when no
 *  corpus entry is a good enough fit. */
export async function aiExplainProcess(descriptor: string): Promise<ProcessExplanation> {
  return invoke<ProcessExplanation>("ai_explain_process", { descriptor });
}

/** Result of P6 semantic workload classification. `category` matches the
 *  TS `WorkloadType` union, or null when no prototype matched. */
export interface WorkloadClassification {
  category: string | null;
  confidence: number | null;
}

/** Phase 4 / P6 — classify the active workload from window titles. `texts`
 *  are the busy unknown processes' window titles / product names. Returns
 *  the best-matching workload category, or null when nothing is confident
 *  enough. A tie-breaker for the rule-based detector. */
export async function aiClassifyWorkload(texts: string[]): Promise<WorkloadClassification> {
  return invoke<WorkloadClassification>("ai_classify_workload", { texts });
}

/** Phase 5 / Stage B — generative smart-rename. Extracts the file's content
 *  (Rust-side) and asks the on-device LM for up to 3 descriptive,
 *  filename-safe candidates (no extension). Empty when the file has no
 *  extractable text; throws if the generative model isn't installed. */
export async function aiGenerateSmartRename(filePath: string): Promise<string[]> {
  return invoke<string[]>("ai_generate_smart_rename", { filePath });
}

/** Phase 5 — pre-load the generative model so the first suggestion isn't
 *  cold-load slow. Called when generative is enabled. No-op if not installed. */
export async function aiPrewarmGenlm(): Promise<void> {
  return invoke<void>("ai_prewarm_genlm");
}

/** Phase 5 / B2 — one-line summary of a file's content, generated on-device.
 *  Empty string when the file has no extractable text; throws if the
 *  generative model isn't installed. */
export async function aiGenerateSummary(filePath: string): Promise<string> {
  return invoke<string>("ai_generate_summary", { filePath });
}

/** Phase 5 / B3 — suggest folder names for a group of related files, from
 *  their file names. Returns up to 3 candidates; empty when none given. */
export async function aiGenerateFolderName(fileNames: string[]): Promise<string[]> {
  return invoke<string[]>("ai_generate_folder_name", { fileNames });
}

/** Phase 5 / B4 — one-line summary of what an existing folder contains, from
 *  its file names. Empty string when the folder has no files. */
export async function aiSummarizeFolder(folderPath: string): Promise<string> {
  return invoke<string>("ai_summarize_folder", { folderPath });
}

/** Phase 5 / B4 — folder-name suggestions for an existing folder, from its
 *  file names. Up to 3 candidates; empty when the folder has no files. */
export async function aiSuggestFolderNames(folderPath: string): Promise<string[]> {
  return invoke<string[]>("ai_suggest_folder_names", { folderPath });
}

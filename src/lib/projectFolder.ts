// Project-folder classifier (feature S1) — pure, framework-free, unit-testable.
//
// The Smart Organizer already detects *well-known* project types
// (Git / Node / Rust / .NET / Python) by their manifest files — see
// `DetectedProject`. This fills the gap: given only a folder's
// `FileTypeStat` rollup, classify it as one of five kinds even when no
// manifest file gives it away —
//
//   project        a working code/dev folder (code + supporting files)
//   media-library  a photo / music / video collection
//   archive        old, cold storage — archives, or everything untouched
//                  for a long time
//   dump           an unsorted pile with no clear purpose (a Downloads-like
//                  folder: many file types, evenly mixed, no code)
//   temp           a temp / cache / logs directory — regenerable junk
//
// SPIKE FINDING S-5 (see docs/AI_INTEGRATION_PLAN.md §7.8)
// -------------------------------------------------------
// S1 was scoped as "a genuine candidate for a small model". It ships as
// transparent rules instead, for two honest reasons:
//
//  1. Tautology. A model could only be trained on *synthetic* folders, so
//     it would only re-learn whatever thresholds the synthetic generator
//     encoded. Unlike I1 (the leak classifier), there is no real labelled
//     folder dataset to validate against — so a synthetic model buys
//     opacity with zero measurable accuracy gain.
//  2. Feature poverty. The plan listed "naming entropy" as a feature, but
//     `FileTypeStat` is a per-folder *rollup* — it carries no individual
//     filenames. The honestly-available signal is file count, the
//     category-count distribution, and modification-time spread. That is a
//     small, well-separated numeric space where a handful of thresholds
//     are as good as a tree and far easier to audit.
//
// Because this is rules — not a model — it ships for ALL users and is NOT
// AI-tier-gated, exactly like P2 (`endTaskSafety.ts`). The "AI" tier still
// gates genuine models (I1).

import type { FileTypeStat, OrganizerCategory } from "./types";

export type FolderKind =
  | "project"
  | "media-library"
  | "archive"
  | "dump"
  | "temp";

/** Numeric feature vector extracted from one folder's `FileTypeStat` rows.
 *  Kept as an explicit type so the classifier's inputs are inspectable and
 *  testable in isolation. */
export interface FolderFeatures {
  /** Total files across every category in the folder. */
  fileCount: number;
  /** Number of distinct categories with at least one file. */
  categoryCount: number;
  /** Normalised Shannon evenness of the category distribution, 0..1.
   *  0 = everything in one category, 1 = perfectly even spread. */
  typeEntropy: number;
  /** Fraction of files in the single largest category, 0..1. */
  dominantShare: number;
  /** Fraction of files that are source code, 0..1. */
  codeShare: number;
  /** Fraction of files that are media (images/video/audio/screenshots). */
  mediaShare: number;
  /** Fraction of files that are archives (.zip/.7z/...). */
  archiveShare: number;
  /** Days between the oldest and newest modified file (0 if unknown). */
  ageSpreadDays: number;
  /** Days since the most recently modified file (0 if unknown). */
  staleDays: number;
}

export interface FolderClassification {
  kind: FolderKind;
  /** 0..1 — how strongly the winning rule fired. Callers should ignore a
   *  classification below `MIN_CONFIDENCE`. */
  confidence: number;
}

/** Below this confidence a classification is too weak to act on. */
export const MIN_CONFIDENCE = 0.45;

const MEDIA_CATEGORIES: OrganizerCategory[] = [
  "images", "videos", "audio", "screenshots",
];

const DAY = 86_400;

/** Path-leaf keywords that identify a temp / cache / logs directory. */
const TEMP_LEAF = /^(temp|tmp|cache|caches|logs?|\.cache|appdata)$/i;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Last path segment of a Windows or POSIX path, lower-cased. */
function basename(path: string): string {
  const cleaned = path.replace(/[/\\]+$/, "");
  const cut = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return cleaned.slice(cut + 1).toLowerCase();
}

/**
 * Collapse every `FileTypeStat` row for ONE folder into a numeric feature
 * vector. All rows passed in must share a `folder_path`; callers that have
 * a mixed list should group first (see `classifyScannedFolders`).
 *
 * `nowTs` is injectable so tests are deterministic; it defaults to now.
 */
export function extractFolderFeatures(
  stats: FileTypeStat[],
  nowTs: number = Math.floor(Date.now() / 1000),
): FolderFeatures {
  let fileCount = 0;
  let codeFiles = 0;
  let mediaFiles = 0;
  let archiveFiles = 0;
  let maxCatFiles = 0;
  let categoryCount = 0;
  let oldest = Infinity;
  let newest = 0;

  for (const s of stats) {
    if (s.file_count <= 0) continue;
    fileCount += s.file_count;
    categoryCount += 1;
    if (s.file_count > maxCatFiles) maxCatFiles = s.file_count;
    if (s.category === "code") codeFiles += s.file_count;
    if (MEDIA_CATEGORIES.includes(s.category as OrganizerCategory)) {
      mediaFiles += s.file_count;
    }
    if (s.category === "archives") archiveFiles += s.file_count;
    if (s.oldest_modified_ts > 0 && s.oldest_modified_ts < oldest) {
      oldest = s.oldest_modified_ts;
    }
    if (s.newest_modified_ts > newest) newest = s.newest_modified_ts;
  }

  if (fileCount === 0) {
    return {
      fileCount: 0, categoryCount: 0, typeEntropy: 0, dominantShare: 0,
      codeShare: 0, mediaShare: 0, archiveShare: 0, ageSpreadDays: 0,
      staleDays: 0,
    };
  }

  // Normalised Shannon evenness over the per-category file-count shares.
  let entropy = 0;
  if (categoryCount > 1) {
    let h = 0;
    for (const s of stats) {
      if (s.file_count <= 0) continue;
      const p = s.file_count / fileCount;
      h -= p * Math.log(p);
    }
    entropy = clamp01(h / Math.log(categoryCount));
  }

  const ageSpreadDays =
    oldest !== Infinity && newest > oldest ? (newest - oldest) / DAY : 0;
  const staleDays = newest > 0 ? Math.max(0, (nowTs - newest) / DAY) : 0;

  return {
    fileCount,
    categoryCount,
    typeEntropy: entropy,
    dominantShare: maxCatFiles / fileCount,
    codeShare: codeFiles / fileCount,
    mediaShare: mediaFiles / fileCount,
    archiveShare: archiveFiles / fileCount,
    ageSpreadDays,
    staleDays,
  };
}

/**
 * Score each folder kind 0..1 from the feature vector and return the
 * winner. Transparent, monotonic rules — see the module header for why
 * this is not a trained model.
 *
 * `folderPath` is used only for the temp/cache path-leaf check; pass `""`
 * when the path is unavailable.
 */
export function classifyFolderFeatures(
  f: FolderFeatures,
  folderPath = "",
): FolderClassification {
  // An empty folder is not worth a verdict.
  if (f.fileCount === 0) return { kind: "dump", confidence: 0 };

  // --- temp -------------------------------------------------------------
  // A path leaf of temp/tmp/cache/logs is a near-certain signal. Failing
  // that, a stale folder that is almost entirely "other"/uncategorised
  // files reads as a scratch directory.
  let tempScore = 0;
  if (folderPath && TEMP_LEAF.test(basename(folderPath))) {
    tempScore = 0.92;
  } else {
    const uncategorised =
      1 - f.codeShare - f.mediaShare - f.archiveShare;
    if (uncategorised > 0.8 && f.staleDays > 30) {
      tempScore = 0.5;
    }
  }

  // --- project ----------------------------------------------------------
  // Source code plus supporting files. Needs a real amount of code and at
  // least one other category (a project is never code-only on disk —
  // there are configs, docs, assets). Recent activity raises confidence.
  let projectScore = 0;
  if (f.codeShare >= 0.12 && f.categoryCount >= 2 && f.fileCount >= 6) {
    projectScore = clamp01(f.codeShare / 0.35);
    projectScore *= f.staleDays < 120 ? 1 : 0.7; // dormant project still counts
  }

  // --- media-library ----------------------------------------------------
  // Dominated by media, few categories. Tight focus -> high confidence.
  let mediaScore = 0;
  if (f.mediaShare >= 0.6) {
    mediaScore = clamp01((f.mediaShare - 0.5) / 0.45);
    if (f.categoryCount <= 3) mediaScore = clamp01(mediaScore + 0.15);
  }

  // --- archive ----------------------------------------------------------
  // Either literally full of archive files, or everything is cold (no file
  // touched in a long time).
  const archiveByType = clamp01((f.archiveShare - 0.3) / 0.4);
  const archiveByAge = clamp01((f.staleDays - 240) / 600);
  const archiveScore = Math.max(archiveByType, archiveByAge);

  // --- dump -------------------------------------------------------------
  // Many categories, evenly mixed, no dominant purpose, little/no code.
  let dumpScore = 0;
  if (f.categoryCount >= 4 && f.dominantShare < 0.6 && f.codeShare < 0.12) {
    dumpScore = clamp01((f.categoryCount - 3) / 4)
      * clamp01((0.6 - f.dominantShare) / 0.4);
    dumpScore = clamp01(dumpScore + f.typeEntropy * 0.3);
    if (f.mediaShare > 0.55) dumpScore *= 0.5; // leans media-library instead
  }

  const scores: Array<[FolderKind, number]> = [
    ["project", projectScore],
    ["media-library", mediaScore],
    ["archive", archiveScore],
    ["dump", dumpScore],
    ["temp", tempScore],
  ];
  scores.sort((a, b) => b[1] - a[1]);
  const [kind, confidence] = scores[0];

  // Nothing fired — fall back to the most non-committal label.
  if (confidence < 0.15) return { kind: "dump", confidence };
  return { kind, confidence };
}

/** Convenience: extract features then classify, in one call. */
export function classifyFolder(
  stats: FileTypeStat[],
  nowTs?: number,
): FolderClassification {
  const feats = extractFolderFeatures(stats, nowTs);
  return classifyFolderFeatures(feats, stats[0]?.folder_path ?? "");
}

/**
 * Group a flat `FileTypeStat[]` by folder, classify each folder, and return
 * the paths confidently classified as `project`.
 *
 * The Smart Organizer feeds this into `detectLargeFiles` so a big file
 * living inside an *undetected* project (no `.git`, no manifest) is not
 * mis-flagged as a stray "forgotten megapile".
 */
export function classifyScannedFolders(
  stats: FileTypeStat[],
  nowTs?: number,
): string[] {
  const byFolder = new Map<string, FileTypeStat[]>();
  for (const s of stats) {
    const arr = byFolder.get(s.folder_path) ?? [];
    arr.push(s);
    byFolder.set(s.folder_path, arr);
  }
  const projectPaths: string[] = [];
  for (const [path, rows] of byFolder) {
    const verdict = classifyFolder(rows, nowTs);
    if (verdict.kind === "project" && verdict.confidence >= MIN_CONFIDENCE) {
      projectPaths.push(path);
    }
  }
  return projectPaths;
}

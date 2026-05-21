// Semantic file analysis (features S4 + S5, Phase 3) — the async organizer
// pass that wires the Stage A embedding runtime and the Stage B clustering
// algorithm into actual "create folder & move" suggestions AND near-
// duplicate findings in the Smart Organizer.
//
// One embed pass drives both detectors:
//   • S4 — average-linkage clustering for "potential project" groups,
//     surfaced as SubfolderSuggestions (Career/Classes-style rail).
//   • S5 — high-cosine pairs surfaced as content-near-duplicate findings.
//     The hash-based dup detector only catches BYTE-identical files; S5
//     catches files whose bytes differ (different PDF metadata, OCR
//     variations) but whose content is functionally the same.
//
// Tier-gated: only runs when the AI tier enables embeddings
// (Standard / Enhanced). Silently no-ops when the model isn't installed
// or anything fails — the host organizer features keep working regardless
// (the "AI is optional" contract from Phase 1).

import { tryEmbedFiles } from "./ai/tierGate";
import {
  clusterEmbeddings,
  isDocumentFile,
  type FileCluster,
  type FileEmbedding,
} from "./fileClustering";
import type { FindingGroup, SubfolderSuggestion } from "./smartOrganizer";

/** Don't bother running the analysis if there aren't this many document
 *  files. The clusterer needs at least 2; we set a higher bar so a
 *  single off-axis pair doesn't get surfaced as a "project". */
const MIN_FILES = 4;
/** Hard cap on candidates passed to the embedder. Each MISS costs a Rust-
 *  side text-extract + ONNX inference; hits are cheap (one metadata stat
 *  + a cache lookup). With the Stage D cache, second scans over the same
 *  files are near-instant — but the first scan still has to pay the cold-
 *  cache cost, so the cap is the safety net against catastrophic latency
 *  on a fresh install over a huge folder. */
const MAX_CANDIDATES = 200;
/** Cosine similarity above which two files are flagged as semantic near-
 *  duplicates. The real-world signal on the user's first scan put a true
 *  duplicate pair at 0.989 and the tightest legit-cluster pair below 0.95,
 *  so 0.95 is the safe cut. */
const DUPLICATE_THRESHOLD = 0.95;

/** SVG d-attribute for the "copies" icon — duplicates rail. */
const ICON_COPIES =
  "M16 8V5a3 3 0 0 0-3-3H5a3 3 0 0 0-3 3v8a3 3 0 0 0 3 3h3v3a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3v-8a3 3 0 0 0-3-3z";

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(i + 1) : p;
}

function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(0, i) : "";
}

/** Longest leading directory path shared by every file. */
function commonParent(paths: string[]): string {
  if (paths.length === 0) return "";
  const parts = paths.map((p) => p.replace(/\//g, "\\").split("\\"));
  const first = parts[0];
  let common = 0;
  for (let i = 0; i < first.length; i++) {
    const seg = first[i]?.toLowerCase();
    if (parts.every((q) => q[i]?.toLowerCase() === seg)) common = i + 1;
    else break;
  }
  return first.slice(0, common).join("\\");
}

/** Tokens we don't want anywhere in derived folder names — too generic,
 *  document-quality markers, or filename housekeeping. */
const STOPWORDS = new Set([
  // english function words
  "the", "a", "an", "and", "or", "of", "to", "for", "in", "on", "by",
  "with", "from", "at", "as", "is", "are", "be", "but", "not", "no",
  "if", "than", "then", "this", "that", "these", "those", "it", "its",
  "into", "out", "via", "per",
  // filename housekeeping / generic
  "based", "using", "draft", "final", "copy", "scan", "doc", "docs",
  "pdf", "docx", "exam", "homework", "lecture", "lectures", "notes",
  "untitled", "version", "rev", "new", "old", "temp", "test", "misc",
  // common short prefixes from naming conventions
  "fa", "sp", "su", "wi", "fall", "spring", "summer", "winter",
]);

/**
 * Pick a folder name from a cluster's filenames. Algorithm:
 *   1. Tokenize each filename on non-alphanumerics, lowercase
 *   2. Drop tokens that are stopwords, all-digits, or shorter than 3 chars
 *   3. Count each token's document frequency (once per file)
 *   4. Take the top 2 tokens that appear in ≥ 2 files
 *   5. Title-case and join with space
 *
 * Returns "" when nothing meaningful surfaces — caller falls back to a
 * generic "Untitled project" label.
 */
export function deriveFolderName(filenames: string[]): string {
  const counts = new Map<string, number>();
  for (const raw of filenames) {
    const stem = raw.replace(/\.[^.]+$/, ""); // strip extension
    const tokens = stem.toLowerCase().split(/[^a-z0-9]+/);
    const seen = new Set<string>(); // count once per file
    for (const t of tokens) {
      if (t.length < 3) continue;
      if (STOPWORDS.has(t)) continue;
      if (/^\d+$/.test(t)) continue;          // all-digits (years, IDs)
      if (/^v\d+$/.test(t)) continue;         // v1, v2, ...
      if (/^[0-9]+[a-z]?$/.test(t)) continue; // 2024, 7a
      if (seen.has(t)) continue;
      seen.add(t);
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  const minFreq = Math.max(2, Math.floor(filenames.length * 0.25));
  const sorted = [...counts.entries()]
    .filter(([, n]) => n >= minFreq)
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
  if (sorted.length === 0) return "";
  const picked = sorted.slice(0, 2).map(([t]) => t[0].toUpperCase() + t.slice(1));
  return picked.join(" ");
}

/** Result of one analyze call — both detectors. */
export interface SemanticAnalysis {
  /** S4 — project clusters as folder-creation suggestions. */
  suggestions: SubfolderSuggestion[];
  /** S5 — content-near-duplicate groups as cleanup findings. */
  duplicates: FindingGroup[];
}

/**
 * Run S4 (clustering → suggestions) and S5 (near-dup pairs → findings)
 * in one embed pass. Single entry point so callers embed only once.
 * Returns empty arrays on any failure (tier off / model missing / etc.).
 */
export async function analyzeSemanticDocuments(
  files: { path: string }[],
): Promise<SemanticAnalysis> {
  const empty: SemanticAnalysis = { suggestions: [], duplicates: [] };
  const t0 = performance.now();
  const docs = files.filter((f) => isDocumentFile(f.path));
  if (docs.length < MIN_FILES) return empty;

  const capped = docs.length > MAX_CANDIDATES ? docs.slice(0, MAX_CANDIDATES) : docs;
  const vecs = await tryEmbedFiles(capped.map((f) => f.path));
  if (!vecs || vecs.length !== capped.length) return empty;

  const items: FileEmbedding[] = capped.map((f, i) => ({ id: f.path, vec: vecs[i] }));

  // S4 — clusters → suggestions. Clusters of 3+ become suggestions;
  // clusters of exactly 2 that clear the duplicate threshold get fed into
  // the near-dup pass below instead.
  const clusters = clusterEmbeddings(items);
  const usefulClusters = clusters.filter((c) => c.ids.length >= 3);
  const dupClusters = clusters.filter((c) => c.ids.length === 2);
  const suggestions = usefulClusters.map((c, idx) => clusterToSuggestion(c, idx));

  // S5 — high-cosine pairs (transitively unioned so an A~B~C chain is one
  // group), plus the 2-file clusters whose cohesion clears the duplicate
  // threshold.
  const duplicateGroups = findNearDuplicateGroups(items);
  for (const c of dupClusters) {
    if (c.cohesion >= DUPLICATE_THRESHOLD) {
      duplicateGroups.push({ ids: c.ids, similarity: c.cohesion });
    }
  }
  const duplicates = dedupeGroups(duplicateGroups).map((g, idx) =>
    duplicateGroupToFinding(g, idx),
  );

  const elapsed = Math.round(performance.now() - t0);
  console.log(
    `[s4/s5] analyzed ${capped.length}/${docs.length} docs in ${elapsed}ms → ` +
    `${suggestions.length} suggestions, ${duplicates.length} near-dup groups`,
  );
  return { suggestions, duplicates };
}

/**
 * Backwards-compatible thin wrapper — returns just the S4 suggestions.
 * Kept so call sites and tests that only want clustering output don't
 * have to deconstruct the analysis result.
 */
export async function detectSemanticClusters(
  files: { path: string }[],
): Promise<SubfolderSuggestion[]> {
  const { suggestions } = await analyzeSemanticDocuments(files);
  return suggestions;
}

// ─── S4 mapping ───────────────────────────────────────────────────────────

function clusterToSuggestion(c: FileCluster, idx: number): SubfolderSuggestion {
  const filenames = c.ids.map((p) => basename(p));
  const derived = deriveFolderName(filenames);
  const suggestedName = derived || `Untitled project ${idx + 1}`;
  return {
    id: `semantic-cluster-${idx}`,
    suggestedName,
    parentPath: commonParent(c.ids),
    reason:
      `${c.ids.length} files appear related (cohesion ` +
      `${(c.cohesion * 100).toFixed(0)}%, detected on-device by content ` +
      `similarity). A dedicated "${suggestedName}" folder keeps them together.`,
    // Pass every member through — the SuggestionRow truncates display
    // with an expandable "+ N more" affordance.
    relatedItems: c.ids.map((p) => ({
      label: basename(p),
      detail: basename(dirOf(p)),
      path: p,
    })),
  };
}

// ─── S5 — near-duplicate detection ────────────────────────────────────────

interface DuplicateGroup {
  ids: string[];
  /** Mean pairwise cosine similarity among members — 1.0 is identical. */
  similarity: number;
}

/**
 * Union-find groups of files whose pairwise cosine similarity exceeds
 * DUPLICATE_THRESHOLD. Transitive: if A~B and B~C, all three end up in
 * one group. Returns groups of size ≥ 2 ordered by tightness (highest
 * similarity first).
 */
function findNearDuplicateGroups(items: FileEmbedding[]): DuplicateGroup[] {
  const n = items.length;
  if (n < 2) return [];

  // Union-find / disjoint set.
  const parent = new Array(n).fill(0).map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]; // path compression
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  // Collect all pairs above threshold and union them.
  const pairs: Array<{ i: number; j: number; sim: number }> = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let sim = 0;
      const a = items[i].vec, b = items[j].vec;
      for (let k = 0; k < a.length; k++) sim += a[k] * b[k];
      if (sim >= DUPLICATE_THRESHOLD) {
        pairs.push({ i, j, sim });
        union(i, j);
      }
    }
  }
  if (pairs.length === 0) return [];

  // Bucket pairs by group root. Only members touched by an above-threshold
  // pair count — singletons sitting at their own root aren't surfaced.
  const groupSims = new Map<number, { ids: string[]; sims: number[] }>();
  const touched = new Set<number>();
  for (const p of pairs) { touched.add(p.i); touched.add(p.j); }
  for (const i of touched) {
    const r = find(i);
    if (!groupSims.has(r)) groupSims.set(r, { ids: [], sims: [] });
    groupSims.get(r)!.ids.push(items[i].id);
  }
  for (const p of pairs) {
    const r = find(p.i);
    groupSims.get(r)?.sims.push(p.sim);
  }

  const groups: DuplicateGroup[] = [];
  for (const g of groupSims.values()) {
    if (g.ids.length < 2) continue;
    const meanSim = g.sims.reduce((s, x) => s + x, 0) / g.sims.length;
    groups.push({ ids: g.ids, similarity: meanSim });
  }
  groups.sort((a, b) => b.similarity - a.similarity);
  return groups;
}

/** Remove duplicate groups that have the same member set (we sometimes
 *  surface the same pair twice — once from the clusterer, once from the
 *  pairwise scan). */
function dedupeGroups(groups: DuplicateGroup[]): DuplicateGroup[] {
  const seen = new Set<string>();
  const out: DuplicateGroup[] = [];
  for (const g of groups) {
    const key = [...g.ids].sort().join("");
    if (!seen.has(key)) {
      seen.add(key);
      out.push(g);
    }
  }
  return out;
}

function duplicateGroupToFinding(g: DuplicateGroup, idx: number): FindingGroup {
  return {
    id: `semantic-duplicate-${idx}`,
    icon: ICON_COPIES,
    severity: "warning",
    title: `${g.ids.length} near-duplicate files by content`,
    summary:
      `Cosine similarity ${(g.similarity * 100).toFixed(0)}% (detected on-` +
      `device). Bytes differ but the content is nearly identical.`,
    detail:
      "These files look like the same document under different names — " +
      "for example, a re-scan of the same PDF or a duplicated copy with " +
      "different metadata. The hash-based duplicate detector can't catch " +
      "them because the bytes differ; the embedding model can.",
    items: g.ids.map((p) => ({
      label: basename(p),
      detail: basename(dirOf(p)),
      path: p,
    })),
    folderPath: commonParent(g.ids),
    // Bytes-to-reclaim would require file sizes the StoragePage knows but
    // we don't pass through here — leave at 0 for v1; the user reviews and
    // decides manually. (Stage E polish: thread sizes through so the user
    // gets a "reclaim X MB" badge.)
    reclaimableBytes: 0,
    actionType: "open",
    tags: ["duplicate"],
  };
}

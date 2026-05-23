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
  isIndexableFile,
  type FileCluster,
  type FileEmbedding,
} from "./fileClustering";
import type { FindingGroup, SubfolderSuggestion } from "./smartOrganizer";
import { learnUserVocabulary, getTokenSalience } from "./userVocabulary";
import { TAG_VOCAB, ICON_FOLDER, type TagDef } from "./aiTags";

/** Don't bother running the analysis if there aren't this many document
 *  files. The clusterer needs at least 2; we set a higher bar so a
 *  single off-axis pair doesn't get surfaced as a "project". */
const MIN_FILES = 4;
/** S12 — window (in days) for the "What's new" digest. Anything modified
 *  more recently than this is considered "recent" and gets included in
 *  the digest's clustering pass. 7 days is the natural "this week"
 *  window; one config knob if a user wants longer/shorter. */
const RECENT_DAYS_DEFAULT = 7;

/** S12 — minimum cluster size to surface in the digest. Below this it's
 *  just a single recent file, which doesn't earn a "theme" label. */
const RECENT_MIN_CLUSTER = 2;

/** Hard cap on candidates passed to the embedder. Each MISS costs a Rust-
 *  side text-extract + ONNX inference; hits are cheap (one metadata stat
 *  + a cache lookup).
 *
 *  Phase 4 architecture: OnceLock-cached embedder + rayon par_iter +
 *  parallel extraction. A 200-file cold batch takes ~30-60s on real
 *  document folders (extract dominates; embed is parallel-bounded by
 *  cores). Subsequent scans hit cache and are near-instant.
 *
 *  Tuning history:
 *    • 60   — original, conservative
 *    • 200  — post-mutex-chunking, interactive-safe with serial embed
 *    • 400  — too aggressive; real folders took 5+ minutes cold
 *    • 200  — current. Restored after parallel embed proved the issue
 *      was sequential bottlenecks, not the cap. Search uses the full
 *      cache regardless of cap, so this only bounds first-scan cost. */
const MAX_CANDIDATES = 200;
/** Cosine similarity above which two files are flagged as semantic near-
 *  duplicates. The real-world signal on the user's first scan put a true
 *  duplicate pair at 0.989 and the tightest legit-cluster pair below 0.95,
 *  so 0.95 is the safe cut. */
const DUPLICATE_THRESHOLD = 0.95;

/** Minimum filename-token Jaccard for two files to be considered the same
 *  logical document. Content cosine alone can't distinguish "same course
 *  material" (Lecture12 vs Lecture32 — 90%+ similar content, DIFFERENT
 *  documents) from "same document under two names". A true duplicate has
 *  a near-identical filename: same name in two folders, "X (1)" vs "X",
 *  or "doc.pdf" vs "doc.pptx". This gate adds that requirement.
 *
 *  Calibrated against the user's real false positives:
 *    accepts  "12.2 hazards how to tame" vs "...and how to tame" (0.89)
 *    accepts  "X (1)" vs "X" (1.0 after copy-marker stripping)
 *    rejects  "Lecture12" vs "Lecture32" (0.5)
 *    rejects  "HMCApplication" vs "CaltechApplication" (0.5)
 *    rejects  "Resume Fall 2025" vs "Resume Spring 2026" (0.43) */
const FILENAME_SIM_THRESHOLD = 0.7;

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

/** Tokenize a filename for duplicate-detection similarity. Strips the
 *  extension and copy-markers ("(1)", "- Copy", "_final", "_v2"), then
 *  splits on non-alphanumerics + alpha/numeric boundaries. So
 *  "Lecture13_M362K (1).pdf" → {lecture, 13, m362k} and the "(1)" copy
 *  doesn't change the token set vs "Lecture13_M362K.pdf". */
function filenameTokens(name: string): Set<string> {
  let s = name.toLowerCase();
  s = s.replace(/\.[^.]+$/, "");                       // extension
  s = s.replace(/\s*\(\d+\)\s*$/, "");                  // " (1)" copy marker
  s = s.replace(/[-_ ]+(copy|final|draft|v\d+|rev\d*)\s*$/g, ""); // version markers
  // Split on non-alnum, and insert boundaries between letters and digits.
  const spaced = s
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-z])/g, "$1 $2");
  const tokens = spaced.split(/[^a-z0-9]+/).filter((t) => t.length > 0);
  return new Set(tokens);
}

/** Jaccard similarity of two filenames' token sets — intersection over
 *  union. 1.0 = identical token sets, 0 = no shared tokens. */
function filenameSimilarity(a: string, b: string): number {
  const ta = filenameTokens(a);
  const tb = filenameTokens(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union > 0 ? inter / union : 0;
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
 *
 * `salience` (feature G — per-user vocabulary) optionally weights each
 * token: the within-cluster recurrence count is multiplied by the token's
 * salience so a term distinctive to the user's library wins over a generic
 * one that happens to recur slightly more in this cluster. Defaults to a
 * neutral weight of 1 for every token (the original frequency-only ranking),
 * keeping the function pure and the existing tests unchanged.
 */
export function deriveFolderName(
  filenames: string[],
  salience: (token: string) => number = () => 1,
): string {
  const ranked = rankSalientTokens(filenames, salience);
  if (ranked.length === 0) return "";
  const picked = ranked.slice(0, 2).map((t) => t[0].toUpperCase() + t.slice(1));
  return picked.join(" ");
}

/**
 * Shared ranker behind {@link deriveFolderName} and the discovered-tag
 * builder. Returns the cluster's eligible tokens (appear in ≥ minFreq files,
 * not stopwords / digits / version markers), ordered by within-cluster
 * recurrence × per-user salience (feature G), then alphabetically. Lowercased.
 */
function rankSalientTokens(
  filenames: string[],
  salience: (token: string) => number,
): string[] {
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
  return [...counts.entries()]
    .filter(([, n]) => n >= minFreq)
    .map(([t, n]) => [t, n * salience(t)] as const)
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .map(([t]) => t);
}

/** Discovered-tag tuning. A cluster must have at least this many files to
 *  become a "Browse by category" chip, and we surface at most this many so
 *  the chip row stays readable next to the curated presets. */
const DISCOVERED_MIN_FILES = 3;
const MAX_DISCOVERED_TAGS = 6;

/**
 * Build adaptive "Browse by category" chips from the user's own content
 * (the S4 clusters), so the category row reflects what's actually in their
 * files — a "PUF" or "Thesis" chip when those are large themes — alongside
 * the fixed curated presets. Each discovered tag's `query` is a phrase of
 * the cluster's top salient tokens, so the standard S10 `ai_tag_files`
 * pipeline can retrieve its files exactly like a preset tag.
 *
 * Skips clusters that produce no meaningful tokens, collide (by label) with
 * a curated preset, or repeat a leading token already used by an earlier
 * (larger) discovered tag. Ordered by cluster size, capped.
 */
export function deriveDiscoveredTags(clusters: FileCluster[]): TagDef[] {
  const presetLabels = new Set(TAG_VOCAB.map((t) => t.label.toLowerCase()));
  const usedKeys = new Set<string>();
  const out: TagDef[] = [];
  const bySize = clusters
    .filter((c) => c.ids.length >= DISCOVERED_MIN_FILES)
    .sort((a, b) => b.ids.length - a.ids.length);
  for (const c of bySize) {
    const tokens = rankSalientTokens(c.ids.map((p) => basename(p)), getTokenSalience);
    if (tokens.length === 0) continue;
    const key = tokens[0];
    if (usedKeys.has(key)) continue;
    const label = tokens.slice(0, 2).map((t) => t[0].toUpperCase() + t.slice(1)).join(" ");
    if (!label || presetLabels.has(label.toLowerCase())) continue;
    usedKeys.add(key);
    out.push({
      id: `discovered-${key}`,
      label,
      // A short phrase of the cluster's defining tokens — gives the embedder
      // a real direction, the same way the curated queries do.
      query: tokens.slice(0, 5).join(", "),
      icon: ICON_FOLDER,
    });
    if (out.length >= MAX_DISCOVERED_TAGS) break;
  }
  return out;
}

/** Result of one analyze call — both detectors. */
/** S12 — one themed group of recently-modified documents. */
export interface RecentDigestGroup {
  /** Derived theme name, same heuristic as S4 folder names. Falls back
   *  to "Recent docs N" when no token recurs across the group. */
  title: string;
  /** Mean intra-cluster cosine similarity — how cohesive the theme is. */
  cohesion: number;
  /** Files in the group, sorted by most-recently-modified first. */
  files: {
    path: string;
    label: string;          // basename for display
    parentLabel: string;    // parent folder name
    modifiedAt: number;     // unix seconds
  }[];
}

export interface SemanticAnalysis {
  /** S4 — project clusters as folder-creation suggestions. */
  suggestions: SubfolderSuggestion[];
  /** S5 — content-near-duplicate groups as cleanup findings. */
  duplicates: FindingGroup[];
  /** S12 — "What's new this week" — clusters of recently-modified docs.
   *  Empty when no file passes the mtime filter, or no cluster forms. */
  recentDigest: RecentDigestGroup[];
  /** Adaptive "Browse by category" chips derived from the user's own
   *  clusters (feature G). Appended to the curated TAG_VOCAB presets so the
   *  category row reflects the user's actual content. Empty when no cluster
   *  is large/distinctive enough. */
  discoveredTags: TagDef[];
}

/** Input shape for semantic analysis. `modified_ts` is optional and only
 *  used by the S12 digest — callers that don't have it (tests, legacy
 *  call sites) just don't get a digest. */
export interface SemanticInput {
  path: string;
  modified_ts?: number;
}

/**
 * Run S4 (clustering → suggestions), S5 (near-dup pairs → findings), and
 * S12 (recent-mtime digest) in one embed pass. Single entry point so
 * callers embed only once. Returns empty arrays on any failure (tier
 * off / model missing / etc.).
 */
export async function analyzeSemanticDocuments(
  files: SemanticInput[],
): Promise<SemanticAnalysis> {
  const empty: SemanticAnalysis = { suggestions: [], duplicates: [], recentDigest: [], discoveredTags: [] };
  const t0 = performance.now();

  // Embed the broad INDEXABLE set (documents + structured data) so
  // search & tagging cover geojson/csv/json/etc. Prioritise document
  // files within the cap so a folder full of data files doesn't push
  // project documents out of the embedding budget — clustering still
  // needs those documents.
  const indexable = files.filter((f) => isIndexableFile(f.path));
  if (indexable.length < MIN_FILES) return empty;

  // G — per-user vocabulary. Learn the user's distinctive terms from the
  // names of their whole indexable library this scan, so the cluster /
  // digest names below lean toward terms that identify their work rather
  // than generic recurring words.
  learnUserVocabulary(indexable.map((f) => basename(f.path)));
  indexable.sort((a, b) => {
    const aDoc = isDocumentFile(a.path) ? 0 : 1;
    const bDoc = isDocumentFile(b.path) ? 0 : 1;
    return aDoc - bDoc;
  });

  const capped = indexable.length > MAX_CANDIDATES ? indexable.slice(0, MAX_CANDIDATES) : indexable;
  const vecs = await tryEmbedFiles(capped.map((f) => f.path));
  if (!vecs || vecs.length !== capped.length) return empty;

  const items: FileEmbedding[] = capped.map((f, i) => ({ id: f.path, vec: vecs[i] }));

  // S4 — clusters → suggestions. CLUSTERING uses only the document
  // subset (data files form noise type-blobs — S-11). The full `items`
  // set (including data files) still flows to S5/S12/search/tags.
  const clusterItems = items.filter((it) => isDocumentFile(it.id));
  const clusters = clusterEmbeddings(clusterItems);
  const usefulClusters = clusters.filter((c) => c.ids.length >= 3);
  const dupClusters = clusters.filter((c) => c.ids.length === 2);
  const suggestions = usefulClusters.map((c, idx) => clusterToSuggestion(c, idx));

  // Adaptive category chips from the user's own clusters (feature G), to
  // sit alongside the curated TAG_VOCAB presets on the Storage page.
  const discoveredTags = deriveDiscoveredTags(usefulClusters);

  // S5 — high-cosine pairs (transitively unioned so an A~B~C chain is one
  // group), plus the 2-file clusters whose cohesion clears the duplicate
  // threshold.
  const duplicateGroups = findNearDuplicateGroups(items);
  for (const c of dupClusters) {
    // Same filename gate as findNearDuplicateGroups — a 2-file cluster
    // with high cohesion but dissimilar names is a topic pair, not a
    // duplicate.
    const nameSim = filenameSimilarity(basename(c.ids[0]), basename(c.ids[1]));
    if (c.cohesion >= DUPLICATE_THRESHOLD && nameSim >= FILENAME_SIM_THRESHOLD) {
      duplicateGroups.push({ ids: c.ids, similarity: c.cohesion });
    }
  }
  const duplicates = dedupeGroups(duplicateGroups).map((g, idx) =>
    duplicateGroupToFinding(g, idx),
  );

  // S12 — "What's new this week": cluster only the recently-modified
  // subset of the same embedding pass. We re-cluster from scratch (not
  // reuse the S4 output) because the recent-only file set is small and
  // its cluster structure is genuinely different — files that S4 lumps
  // with a larger group might form a fresh standalone "what's new" theme.
  const recentDigest = buildRecentDigest(capped, items);

  const elapsed = Math.round(performance.now() - t0);
  console.log(
    `[s4/s5/s12] analyzed ${capped.length}/${indexable.length} indexable in ${elapsed}ms → ` +
    `${suggestions.length} suggestions, ${duplicates.length} near-dup groups, ` +
    `${recentDigest.length} recent themes, ${discoveredTags.length} discovered tags`,
  );
  return { suggestions, duplicates, recentDigest, discoveredTags };
}

/** Filter `items` to files modified in the last RECENT_DAYS_DEFAULT days,
 *  cluster them, and assemble RecentDigestGroup output. Returns empty
 *  when no file is recent enough or no cluster of ≥ RECENT_MIN_CLUSTER
 *  forms. */
function buildRecentDigest(
  capped: SemanticInput[],
  items: FileEmbedding[],
): RecentDigestGroup[] {
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoffSec = nowSec - RECENT_DAYS_DEFAULT * 86_400;
  // Build a (path → modified_ts) lookup and filter the embedding set.
  const mtimeByPath = new Map<string, number>();
  for (const f of capped) {
    if (typeof f.modified_ts === "number") mtimeByPath.set(f.path, f.modified_ts);
  }
  const recentItems = items.filter((it) => {
    const m = mtimeByPath.get(it.id);
    return typeof m === "number" && m > 0 && m >= cutoffSec;
  });
  if (recentItems.length < RECENT_MIN_CLUSTER) return [];

  // Re-cluster the recent-only subset.
  const recentClusters = clusterEmbeddings(recentItems, { minSize: RECENT_MIN_CLUSTER });
  return recentClusters.map((c, idx) => {
    const filenames = c.ids.map((p) => basename(p));
    const derived = deriveFolderName(filenames, getTokenSalience);
    const title = derived || `Recent docs ${idx + 1}`;
    const files = c.ids
      .map((p) => ({
        path: p,
        label: basename(p),
        parentLabel: basename(dirOf(p)),
        modifiedAt: mtimeByPath.get(p) ?? 0,
      }))
      .sort((a, b) => b.modifiedAt - a.modifiedAt);
    return { title, cohesion: c.cohesion, files };
  });
}

/**
 * Backwards-compatible thin wrapper — returns just the S4 suggestions.
 * Kept so call sites and tests that only want clustering output don't
 * have to deconstruct the analysis result.
 */
export async function detectSemanticClusters(
  files: SemanticInput[],
): Promise<SubfolderSuggestion[]> {
  const { suggestions } = await analyzeSemanticDocuments(files);
  return suggestions;
}

// ─── S4 mapping ───────────────────────────────────────────────────────────

function clusterToSuggestion(c: FileCluster, idx: number): SubfolderSuggestion {
  const filenames = c.ids.map((p) => basename(p));
  const derived = deriveFolderName(filenames, getTokenSalience);
  const suggestedName = derived || `Untitled project ${idx + 1}`;
  return {
    id: `semantic-cluster-${idx}`,
    suggestedName,
    parentPath: commonParent(c.ids),
    reason:
      `${c.ids.length} files look related (${(c.cohesion * 100).toFixed(0)}% ` +
      `similar). A dedicated "${suggestedName}" folder keeps them together.`,
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

  // Collect all pairs above BOTH thresholds and union them. The filename
  // gate is what distinguishes "same document under two names" from "same
  // topic, different document" — content cosine alone confuses Lecture12
  // with Lecture32 (both ~0.9 on shared course material).
  const pairs: Array<{ i: number; j: number; sim: number }> = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const nameSim = filenameSimilarity(basename(items[i].id), basename(items[j].id));
      if (nameSim < FILENAME_SIM_THRESHOLD) continue;
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
    title: `${g.ids.length} files look like copies of each other`,
    summary:
      `${(g.similarity * 100).toFixed(0)}% similar content`,
    detail:
      "These look like the same document saved under different names — " +
      "for example a re-scan of the same PDF, or a copy with slightly " +
      "different file details. Review them and keep the one you want.",
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
    // "duplicates" (plural) matches the Smart Organizer's "Duplicates"
    // chip intent — singular "duplicate" would only show under "All".
    tags: ["duplicates"],
  };
}

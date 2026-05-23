// Per-user semantic vocabulary (feature G) — pure, framework-free, testable.
//
// The naming and grouping heuristics elsewhere (deriveFolderName, the recent-
// digest titles) rank tokens purely by how often they recur *within a single
// cluster*. That picks generic words a user happens to repeat ("report",
// "project", "final") over the term that actually identifies their work.
//
// G learns each user's own vocabulary from the names of every file they've
// indexed, then supplies an inverse-document-frequency weight: a token used
// across only a handful of the user's files (your rare "PUF") is distinctive
// and gets boosted; a token sprinkled across nearly everything ("resume",
// "screenshot") is common and stays neutral. Multiplying the within-cluster
// count by this weight makes cluster names lean toward the term that tells
// the user what the group really is.
//
// Everything is local: filenames only, no content, persisted to localStorage.
// Invisible on its own; additive across every feature that names a group.

const STORAGE_KEY = "tmp.userVocabulary.v1";

/** Learned state: number of files seen + per-token document frequency. */
interface VocabState {
  /** Total files contributing to the vocabulary (the library size N). */
  n: number;
  /** token → number of files whose name contains it (document frequency). */
  df: Record<string, number>;
}

/** In-memory cache so repeated lookups during one render don't re-parse
 *  localStorage. Invalidated on every `learnUserVocabulary` write. */
let cached: VocabState | null = null;
let cacheLoaded = false;

function load(): VocabState | null {
  if (cacheLoaded) return cached;
  cacheLoaded = true;
  try {
    if (typeof localStorage === "undefined") return (cached = null);
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return (cached = null);
    const parsed = JSON.parse(raw) as VocabState;
    if (parsed && typeof parsed.n === "number" && parsed.df) {
      return (cached = parsed);
    }
  } catch {
    // Corrupt / unavailable storage — behave as if no vocabulary exists.
  }
  return (cached = null);
}

/** Stopwords + housekeeping markers we never treat as user vocabulary. Kept
 *  in sync with `semanticClusters.ts`'s STOPWORDS so the two agree on what
 *  counts as a meaningful token. */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "for", "in", "on", "by",
  "with", "from", "at", "as", "is", "are", "be", "but", "not", "no",
  "if", "than", "then", "this", "that", "these", "those", "it", "its",
  "into", "out", "via", "per",
  "based", "using", "draft", "final", "copy", "scan", "doc", "docs",
  "pdf", "docx", "exam", "homework", "lecture", "lectures", "notes",
  "untitled", "version", "rev", "new", "old", "temp", "test", "misc",
  "fa", "sp", "su", "wi", "fall", "spring", "summer", "winter",
]);

/** Extract the meaningful tokens from one filename — same shape as
 *  deriveFolderName's tokenizer so the learned vocabulary lines up with the
 *  tokens it will later be asked to weight. */
export function vocabularyTokens(filename: string): Set<string> {
  const stem = filename.replace(/\.[^.]+$/, "");
  const out = new Set<string>();
  for (const t of stem.toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length < 3) continue;
    if (STOPWORDS.has(t)) continue;
    if (/^\d+$/.test(t)) continue;          // all-digits (years, IDs)
    if (/^v\d+$/.test(t)) continue;         // v1, v2, ...
    if (/^[0-9]+[a-z]?$/.test(t)) continue; // 2024, 7a
    out.add(t);
  }
  return out;
}

/**
 * Rebuild the user's vocabulary from the names of every indexed file. Called
 * once per scan with the full indexable set, so the document frequencies
 * reflect the whole library (replacing — not accumulating — to avoid double-
 * counting files seen in successive scans of the same root). Persists to
 * localStorage so the very first cluster naming in a later session can use
 * the last snapshot before any new scan runs.
 */
export function learnUserVocabulary(filenames: string[]): void {
  const df: Record<string, number> = {};
  for (const name of filenames) {
    for (const t of vocabularyTokens(name)) {
      df[t] = (df[t] ?? 0) + 1;
    }
  }
  const state: VocabState = { n: filenames.length, df };
  cached = state;
  cacheLoaded = true;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }
  } catch {
    // Persistence is best-effort; the in-memory cache still serves this session.
  }
}

/** Minimum library size before the weights mean anything. Below this we
 *  return a neutral 1.0 — a handful of files isn't enough to tell common
 *  from distinctive. */
const MIN_LIBRARY = 4;

/** Upper clamp on the boost so one very rare token can't completely
 *  dominate a cluster name over a strongly-recurring one. */
const MAX_SALIENCE = 3;

/**
 * Salience weight for a token, in `[1, MAX_SALIENCE]`. 1.0 = common across
 * the user's library (or not enough data); higher = more distinctive to a
 * small share of their files. Computed as a smoothed inverse document
 * frequency over the learned library.
 *
 * Intended use: multiply a token's within-cluster recurrence count by this
 * weight when ranking candidate names, so a distinctive domain term beats a
 * generic one even when the generic one appears slightly more often.
 */
export function getTokenSalience(token: string): number {
  const s = load();
  if (!s || s.n < MIN_LIBRARY) return 1;
  const df = s.df[token.toLowerCase()] ?? 0;
  // Smoothed idf: a token in every file → ~1; a token in a few files → high.
  const idf = Math.log((s.n + 1) / (df + 1)) + 1;
  return Math.max(1, Math.min(MAX_SALIENCE, idf));
}

/** Test/maintenance hook — drop the learned vocabulary (memory + storage). */
export function resetUserVocabulary(): void {
  cached = null;
  cacheLoaded = true;
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

// Version-pattern detection (feature S3) — pure, framework-free, unit-testable.
//
// Recognises the trailing "version marker" family in a file's base name —
// `_v2`, `- Copy`, `(3)`, `_final`, `_FINAL_v2`, `_draft`, `_old`, ` latest`,
// `_rev2`, `_backup`, `_updated` — so the Smart Organizer can group a stack
// of revisions of the same file (S3) and point at the most current one.
//
// Design note — false positives. Every marker is matched ONLY as a trailing
// token, after a separator (`-`, `_`, or a space), and the keyword list is
// deliberately limited to words that are almost never the genuine last word
// of a real filename (`final`, `draft`, `copy`, `latest`, `rev`, `backup`,
// `updated`...). Bare trailing numbers (`Report 2.docx`) are intentionally
// NOT treated as markers — they're indistinguishable from genuinely distinct
// documents (`Chapter 2.docx`). This mirrors the keyword-safety rule learned
// in spike S-2: never strip a token that doubles as ordinary filename text.

/** Result of parsing the trailing version markers off a file's base name. */
export interface VersionParse {
  /** Base name with every trailing version marker removed, trimmed and
   *  lower-cased. Two files in the same revision stack share a `stem`. */
  stem: string;
  /** True when at least one trailing version marker was found. */
  hadMarker: boolean;
  /** Recency rank — higher means the marker implies a more current file.
   *  A tiebreaker only; modification time is the better keeper signal. */
  rank: number;
}

// A separator is a dash/underscore (optionally space-padded) or one-or-more
// spaces. The bare "(N)" copy form needs no separator — Windows writes it
// directly against the name.
const SEP = "(?:\\s*[-_]\\s*|\\s+)";
// Keyword markers. `v\d+` requires a digit so a bare "v" is never a marker.
const KEYWORD =
  "copy(?:\\s*\\(\\d+\\))?|final(?:\\s*v?\\d*)?|draft\\s*\\d*" +
  "|version\\s*\\d*|revision\\s*\\d*|rev\\d*|v\\d+|latest" +
  "|backup|bak|previous|prev|original|orig|old" +
  "|updated?|edited|revised";
// One trailing version marker, anchored at the end of the string.
const TRAILING_MARKER = new RegExp(
  "(?:" + SEP + "(?:" + KEYWORD + ")|\\s*\\(\\d+\\))$",
  "i",
);

/** Map a marker to a recency stage — higher = more current. */
function markerStage(marker: string): number {
  const s = marker.toLowerCase();
  if (s.includes("latest")) return 6;
  if (s.includes("final")) return 5;
  if (/updat|edited|revised/.test(s)) return 4;
  if (/version|revision|rev\d|\brev\b|v\d/.test(s)) return 3;
  if (s.includes("draft")) return 1;
  if (/old|backup|bak|prev|orig/.test(s)) return 0;
  return 2; // plain copy / "(N)"
}

/**
 * Strip the trailing version-marker chain off a file's base name (the name
 * WITHOUT its extension) and report whether any was found, plus a recency
 * rank built from the markers seen.
 *
 * `project_FINAL_v2` → `{ stem: "project", hadMarker: true, rank: <high> }`
 * `Chapter 2`        → `{ stem: "chapter 2", hadMarker: false, rank: ... }`
 */
export function parseVersion(base: string): VersionParse {
  let rest = base;
  let hadMarker = false;
  // -1 = "no marker seen yet". Markers can be BELOW the base stage (draft=1,
  // old=0), so this must start unset rather than at the base stage — else a
  // draft/old marker could never pull the rank down.
  let maxStage = -1;
  let maxNum = 0;

  for (let guard = 0; guard < 16; guard++) {
    const m = TRAILING_MARKER.exec(rest);
    // No marker, or the whole string IS the marker (index 0) — stripping that
    // would leave an empty stem, so keep it intact.
    if (!m || m.index === 0) break;
    hadMarker = true;
    const marker = m[0];
    maxStage = Math.max(maxStage, markerStage(marker));
    const digits = marker.match(/\d+/g);
    if (digits) {
      for (const d of digits) maxNum = Math.max(maxNum, parseInt(d, 10));
    }
    rest = rest.slice(0, m.index);
  }

  // A file with no version marker sits at the "base" stage (2) — more current
  // than a draft, on par with a plain copy.
  const stage = hadMarker ? maxStage : 2;
  return {
    stem: rest.trim().toLowerCase(),
    hadMarker,
    rank: stage * 100_000 + maxNum,
  };
}

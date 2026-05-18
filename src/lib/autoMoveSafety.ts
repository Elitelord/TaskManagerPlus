// File auto-move safety (feature S2) — pure, framework-free, unit-testable.
//
// The Smart Organizer's "Create folder & move" button needs to know whether
// it may safely ship a file's path for one-click relocation. Two kinds of
// creative file behave very differently:
//
//   • Self-contained formats (.psd, .blend, RAW photos, CAD) — moving the
//     file breaks nothing. Always safe.
//   • Project-file formats (.prproj, .flp, .aep, .uproject) — these
//     reference sibling media by RELATIVE path, so moving the live project
//     file alone breaks the project.
//
// Until now `safeToAutoMove` was a single hardcoded boolean per CATEGORY, so
// every project file was blanket-unsafe. S2 makes it a per-FILE decision: a
// project file is still unsafe by default, but if it is clearly an archived
// / backup copy — not the live project — then relocating it is low-stakes
// (breaking an already-dead backup doesn't matter), so the button is
// re-enabled for that file.
//
// Conservative by construction. A wrong "safe" ships a move button that can
// break a live project; a wrong "unsafe" merely makes the user move a
// backup by hand. So "safe" is only ever returned for a self-contained
// format, or on a strong, explicit archive/backup signal — everything
// ambiguous stays "unsafe".
//
// Like S1 and S3 this shipped as transparent rules, not a model, and is not
// AI-tier-gated — there is no labelled dataset of "files that were safely
// moved", and the signal is a short, auditable set of path/name patterns.

/** Folder-name segments that mark a path as archival / backup storage. A
 *  project file living under one of these is a stashed copy, not the live
 *  project. `references` is included per the S2 spec. */
const ARCHIVE_SEGMENT =
  /^(backups?|archives?|archived|old|older|bak|references?)$/i;

/** Whole-word base-name tokens that mark the file itself as a backup/old
 *  copy. Anchored to word edges so "backup" in "backup-plan.prproj" counts
 *  while "bak" inside "bakery.prproj" does not. */
const ARCHIVE_NAME = /(^|[-_ ])(backups?|bak|old|archived?)([-_ ]|$)/i;

export interface AutoMoveVerdict {
  /** True when the one-click move button may ship this file's path. */
  safe: boolean;
  /** Short human-readable rationale — for tooltips / debugging. */
  reason: string;
}

/** True when the path or filename clearly marks the file as an archived /
 *  backup copy rather than a live working file. */
export function looksArchivedCopy(path: string): boolean {
  const segs = path.replace(/\//g, "\\").split("\\");
  // Directory segments only — exclude the filename leaf (last element).
  for (let i = 0; i < segs.length - 1; i++) {
    if (ARCHIVE_SEGMENT.test(segs[i].trim())) return true;
  }
  const leaf = segs[segs.length - 1] ?? "";
  const dot = leaf.lastIndexOf(".");
  const base = dot > 0 ? leaf.slice(0, dot) : leaf;
  return ARCHIVE_NAME.test(base);
}

/**
 * Decide whether a single creative file is safe for the organizer to
 * auto-move. `categorySafe` is the file type's baseline — true for
 * self-contained formats, false for project formats that reference sibling
 * media (the old per-category `CreativeCategoryDef.safeToAutoMove`).
 */
export function classifyAutoMoveSafety(
  file: { path: string },
  categorySafe: boolean,
): AutoMoveVerdict {
  if (categorySafe) {
    return { safe: true, reason: "self-contained file type" };
  }
  if (looksArchivedCopy(file.path)) {
    return { safe: true, reason: "archived/backup copy — low-stakes to move" };
  }
  return { safe: false, reason: "live project file — references sibling media" };
}

/** Boolean convenience for call sites that only gate a UI affordance. */
export function isFileSafeToAutoMove(
  file: { path: string },
  categorySafe: boolean,
): boolean {
  return classifyAutoMoveSafety(file, categorySafe).safe;
}

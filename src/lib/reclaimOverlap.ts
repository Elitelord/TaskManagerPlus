// Overlap-correction for reclaimable-byte totals.
//
// The Smart Organizer's detectors each report a `reclaimableBytes` for their
// finding, but several detectors describe *overlapping sets of files*. The
// clearest case: the duplicate-file candidate pool is built directly from the
// `largeFiles` list (StoragePage collects large files, then feeds them to the
// duplicate hasher), so a 4 GB ISO that has a second copy is claimed once by
// `duplicate-files` and again by `large-lone-files`. Summing the two findings'
// `reclaimableBytes` double-counts those 4 GB. The old code did exactly that in
// two different places (the footer badge and the free-up anchor), producing two
// different, both-inflated headline numbers.
//
// This module computes each finding's *residual* contribution — the bytes it
// claims that no higher-priority finding already claimed — so the sum across
// findings equals the true union of reclaimable bytes, never more.
//
// Resolvability differs by finding class:
//   • Exact-path (duplicate-files, large-lone-files, stale-build-artifacts,
//     log-temp-files): carry real paths + sizes → byte-exact de-overlap.
//   • Rollup (downloads-installers, downloads-archives): carry only a folder +
//     extension list → we can subtract already-claimed exact paths that fall
//     under the folder and match the extensions, but can't enumerate the rest.
//   • Opaque (installed-app, recycle-bin-bloat, semantic groups without paths):
//     no path information → passed through unchanged. These rarely overlap the
//     exact-path findings in practice.
//
// NOTE on installers vs archives: the native scanner (`scan_file_types_recursive`
// in storage_telemetry.cpp) *moves* a file into OC_INSTALLERS rather than adding
// it, so a `setup.zip` is counted as an installer OR an archive, never both.
// Those two rollups are therefore already disjoint and need no cross-subtraction
// here — the only rollup overlap we correct is rollup-vs-exact.

import type { FindingGroup } from "./smartOrganizer";

/** Lower-cased, trailing-separator-trimmed path key for set membership. */
function pathKey(p: string): string {
  return p.replace(/[\\/]+$/, "").toLowerCase();
}

/** True when `key` sits under `folderKey` (folderKey already lower-cased). */
function isUnder(key: string, folderKey: string): boolean {
  if (folderKey === "") return false;
  return key === folderKey || key.startsWith(folderKey + "\\") || key.startsWith(folderKey + "/");
}

/** True when `key`'s extension is in `exts` (exts include the leading dot). */
function extMatches(key: string, exts: string[]): boolean {
  for (const e of exts) {
    if (key.endsWith(e.toLowerCase())) return true;
  }
  return false;
}

/** Findings that carry exact per-file paths we can de-overlap byte-exactly. */
function isExactPath(f: FindingGroup): boolean {
  return (f.duplicates?.length ?? 0) > 0 || (f.directPaths?.length ?? 0) > 0;
}

/** Findings that describe a folder × extension set but no individual paths. */
function isRollup(f: FindingGroup): boolean {
  return !isExactPath(f) && (f.extensions?.length ?? 0) > 0 && f.folderPath !== "";
}

// Priority for the exact layer — lower claims its bytes first, so shared bytes
// are credited to the higher-confidence finding and the others get the residual.
// Duplicates are the most certain (a non-keeper copy is redundant by
// definition); build artifacts and log/temp are next; `large-lone-files`, the
// weakest claim (a big file that merely *might* be worth deleting), gets only
// what's left. Deterministic so the split doesn't flicker between renders.
function exactPriority(f: FindingGroup): number {
  if ((f.duplicates?.length ?? 0) > 0) return 0;
  if (f.id === "stale-build-artifacts") return 1;
  if (f.id === "log-temp-files") return 1;
  if (f.id === "large-lone-files") return 3;
  return 2;
}

/**
 * Return a NEW array of findings, each with `dedupedReclaimBytes` set to its
 * overlap-corrected contribution. Input order is preserved; only the field is
 * added. Pure and deterministic — the same finding set always yields the same
 * split regardless of array order.
 */
export function withDedupedReclaim(findings: FindingGroup[]): FindingGroup[] {
  // path key -> bytes, accumulated as exact-path findings claim their files.
  const claimed = new Map<string, number>();
  const deduped = new Map<string, number>(); // finding id -> residual bytes

  // --- Layer 1: exact-path findings, highest-confidence first ---------------
  const exact = findings
    .filter(isExactPath)
    .map((f, i) => ({ f, i }))
    .sort((a, b) => {
      const p = exactPriority(a.f) - exactPriority(b.f);
      if (p !== 0) return p;
      // Then larger claim first, then stable by original index / id.
      const s = b.f.reclaimableBytes - a.f.reclaimableBytes;
      if (s !== 0) return s;
      return a.i - b.i;
    });

  for (const { f } of exact) {
    let residual = 0;
    if (f.duplicates?.length) {
      for (const g of f.duplicates) {
        g.copies.forEach((c, idx) => {
          if (idx === g.defaultKeeperIndex) return; // keeper stays on disk
          const key = pathKey(c.path);
          if (claimed.has(key)) return;
          claimed.set(key, g.size_bytes);
          residual += g.size_bytes;
        });
      }
    } else if (f.directPaths?.length) {
      for (const p of f.directPaths) {
        const key = pathKey(p.path);
        if (claimed.has(key)) continue;
        claimed.set(key, p.size_bytes);
        residual += p.size_bytes;
      }
    }
    deduped.set(f.id, residual);
  }

  // --- Layer 2: rollups minus already-claimed exact paths under them --------
  for (const f of findings) {
    if (!isRollup(f)) continue;
    const folderKey = pathKey(f.folderPath);
    const exts = f.extensions ?? [];
    let overlap = 0;
    for (const [key, bytes] of claimed) {
      if (isUnder(key, folderKey) && extMatches(key, exts)) overlap += bytes;
    }
    deduped.set(f.id, Math.max(0, f.reclaimableBytes - overlap));
  }

  // --- Layer 3: opaque findings pass through unchanged ----------------------
  for (const f of findings) {
    if (!deduped.has(f.id)) deduped.set(f.id, f.reclaimableBytes);
  }

  return findings.map((f) => ({
    ...f,
    dedupedReclaimBytes: deduped.get(f.id) ?? f.reclaimableBytes,
  }));
}

/** A finding's overlap-corrected reclaim, falling back to the raw value when
 *  the annotation pass hasn't run. */
export function reclaimOf(f: FindingGroup): number {
  return f.dedupedReclaimBytes ?? f.reclaimableBytes;
}

/**
 * The single reclaimable-bytes headline for a set of findings: the true union
 * of reclaimable bytes with no double counting. Safe to call on raw findings
 * (it annotates internally).
 */
export function computeReclaimTotal(findings: FindingGroup[]): number {
  return withDedupedReclaim(findings).reduce((n, f) => n + (f.dedupedReclaimBytes ?? 0), 0);
}

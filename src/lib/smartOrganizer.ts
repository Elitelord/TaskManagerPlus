// Smart Organizer — pure analysis engine.
//
// Given the raw file-type rollups and detected projects returned by the DLL,
// this module produces the three payloads the StoragePage panel consumes:
//
//   • FolderComposition[]    — stacked-bar data, one entry per scanned folder
//   • FindingGroup[]         — collapsible "something's off" rows (≤ 6)
//   • SubfolderSuggestion[]  — softer "maybe organize this" hints (≤ 3)
//
// Keep this file framework-free so it can be unit-tested. The goal is to be
// opinionated and quiet: we'd rather show 3 high-signal findings than 12 noisy
// ones. Thresholds are tuned for typical desktop clutter (see `THRESHOLDS`).

import type { FileTypeStat, DetectedProject, OrganizerCategory } from "./types";

// Well-known user folders we expect composition data for. The *path keys* used
// below are the Windows short names — they're matched against the leaf of the
// `folder_path` returned by the scanner so we don't care about drive letter.
export const USER_FOLDER_KEYS = [
  "Documents",
  "Downloads",
  "Desktop",
  "Pictures",
  "Videos",
  "Music",
] as const;
export type UserFolderKey = (typeof USER_FOLDER_KEYS)[number];

const THRESHOLDS = {
  // Desktop clutter: more than this many loose items is "cluttered".
  DESKTOP_ITEM_CLUTTER: 30,
  // Downloads folder: installers older than this many days are stale.
  INSTALLER_STALE_DAYS: 30,
  // Downloads "lingering" trigger — any installers count, as long as they're ≥ 3.
  INSTALLER_LINGERING_MIN: 3,
  // Scattered git repos: this many Git projects outside a dedicated root.
  SCATTERED_REPOS_MIN: 3,
  // Loose screenshots on Desktop suggestion trigger.
  LOOSE_SCREENSHOTS_MIN: 10,
  // Misplaced videos (videos outside the Videos folder) — trigger threshold.
  MISPLACED_VIDEO_BYTES: 1 * 1024 ** 3, // 1 GB
  // Large Music-extension footprint outside Music folder.
  MISPLACED_AUDIO_BYTES: 500 * 1024 ** 2, // 500 MB
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FolderComposition {
  key: UserFolderKey;
  folderPath: string;           // full path returned by the scanner
  totalBytes: number;
  totalFiles: number;
  categories: { category: OrganizerCategory; bytes: number; files: number }[];
}

export interface FindingItem {
  label: string;                // e.g. "Downloads folder" or "Screenshot 2025-03-01.png"
  detail?: string;              // small trailing hint (size, age, etc.)
  path?: string;                // when present, an "Open" button targets this
}

export type Severity = "info" | "warning" | "suggestion";

export interface FindingGroup {
  id: string;
  icon: string;                 // single SVG path (d attribute)
  severity: Severity;
  title: string;                // "Installers lingering in Downloads"
  summary: string;              // "12 files · 3.2 GB"
  detail: string;               // expanded description shown on expand
  items: FindingItem[];         // individual culprits, may be empty for folder-level findings
  folderPath: string;           // target for the "Open folder" button
  reclaimableBytes: number;     // score contribution + footer total
}

export interface SubfolderSuggestion {
  id: string;
  suggestedName: string;        // "GitHub", "Screenshots", "Installers"
  parentPath: string;           // where to create the suggested folder
  reason: string;               // human-readable justification
  relatedItems: FindingItem[];  // paths of items that would go inside
}

export interface OrganizerAnalysis {
  compositions: FolderComposition[];
  findings: FindingGroup[];
  suggestions: SubfolderSuggestion[];
  orgScore: number;             // 0-100
  reclaimableBytes: number;     // sum across findings
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function leafName(p: string): string {
  const norm = p.replace(/[/]/g, "\\").replace(/\\+$/, "");
  const idx = norm.lastIndexOf("\\");
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

function matchUserFolder(folderPath: string): UserFolderKey | null {
  const leaf = leafName(folderPath).toLowerCase();
  for (const k of USER_FOLDER_KEYS) {
    if (k.toLowerCase() === leaf) return k;
  }
  return null;
}

function secondsAgoInDays(unixSeconds: number): number {
  if (!unixSeconds) return Infinity;
  const diffMs = Date.now() - unixSeconds * 1000;
  return diffMs / 86_400_000;
}

function bytesLabel(n: number): string {
  if (!n || n < 1) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i < 2 ? 0 : 1)} ${units[i]}`;
}

// ---------------------------------------------------------------------------
// Pass 1 — folder composition (stacked bars)
// ---------------------------------------------------------------------------

export function analyzeFolderComposition(stats: FileTypeStat[]): FolderComposition[] {
  const byFolder = new Map<string, FolderComposition>();

  for (const s of stats) {
    const key = matchUserFolder(s.folder_path);
    if (!key) continue;
    let comp = byFolder.get(s.folder_path);
    if (!comp) {
      comp = {
        key,
        folderPath: s.folder_path,
        totalBytes: 0,
        totalFiles: 0,
        categories: [],
      };
      byFolder.set(s.folder_path, comp);
    }
    comp.totalBytes += s.total_bytes;
    comp.totalFiles += s.file_count;
    comp.categories.push({
      category: s.category as OrganizerCategory,
      bytes: s.total_bytes,
      files: s.file_count,
    });
  }

  // Sort categories inside each composition by bytes desc so segments are in
  // a consistent "biggest first" order when rendered.
  for (const c of byFolder.values()) {
    c.categories.sort((a, b) => b.bytes - a.bytes);
  }

  // Sort compositions in the canonical USER_FOLDER_KEYS order so Documents is
  // always shown first, Music always last, regardless of filesystem order.
  const order = new Map(USER_FOLDER_KEYS.map((k, i) => [k, i]));
  return [...byFolder.values()].sort(
    (a, b) => (order.get(a.key) ?? 99) - (order.get(b.key) ?? 99)
  );
}

// ---------------------------------------------------------------------------
// Pass 2 — findings (things that look out of place)
// ---------------------------------------------------------------------------

interface CategoryMap {
  [category: string]: FileTypeStat | undefined;
}

function buildCategoryMap(statsForFolder: FileTypeStat[]): CategoryMap {
  const m: CategoryMap = {};
  for (const s of statsForFolder) m[s.category] = s;
  return m;
}

function groupStatsByFolder(stats: FileTypeStat[]): Map<UserFolderKey, FileTypeStat[]> {
  const out = new Map<UserFolderKey, FileTypeStat[]>();
  for (const s of stats) {
    const k = matchUserFolder(s.folder_path);
    if (!k) continue;
    const arr = out.get(k) ?? [];
    arr.push(s);
    out.set(k, arr);
  }
  return out;
}

// SVG icon paths (single `d` attribute) — kept here rather than inline in JSX
// because the engine is framework-agnostic. The panel reads these verbatim.
const ICON = {
  warning: "M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z M12 9v4 M12 17h.01",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3",
  video:    "M23 7l-7 5 7 5V7z M14 5H3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z",
  music:    "M9 18V5l12-2v13",
  desktop:  "M2 3h20v14H2z M8 21h8 M12 17v4",
  archive:  "M21 8v13H3V8 M1 3h22v5H1z M10 12h4",
  lightbulb:"M9 18h6 M10 22h4 M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z",
  folder:   "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z",
};

export function detectFindings(stats: FileTypeStat[]): FindingGroup[] {
  const byFolder = groupStatsByFolder(stats);
  const findings: FindingGroup[] = [];

  // 1. Downloads — lingering installers (often >1GB each, easy reclaim).
  const downloadsStats = byFolder.get("Downloads");
  if (downloadsStats) {
    const map = buildCategoryMap(downloadsStats);
    const installers = map["installers"];
    const archives = map["archives"];
    if (installers && installers.file_count >= THRESHOLDS.INSTALLER_LINGERING_MIN) {
      const oldestDays = secondsAgoInDays(installers.oldest_modified_ts);
      const stale = oldestDays > THRESHOLDS.INSTALLER_STALE_DAYS;
      findings.push({
        id: "downloads-installers",
        icon: ICON.download,
        severity: stale ? "warning" : "info",
        title: "Installers lingering in Downloads",
        summary: `${installers.file_count} files · ${bytesLabel(installers.total_bytes)}`,
        detail: stale
          ? `Setup files older than ${THRESHOLDS.INSTALLER_STALE_DAYS} days — usually safe to delete after the app is installed.`
          : "Setup files accumulate in Downloads. Delete them once the app is installed.",
        items: [{
          label: "Downloads",
          detail: bytesLabel(installers.total_bytes),
          path: installers.folder_path,
        }],
        folderPath: installers.folder_path,
        reclaimableBytes: installers.total_bytes,
      });
    }
    // Archive pileup (big zips sitting around)
    if (archives && archives.total_bytes > 5 * 1024 ** 3) {
      findings.push({
        id: "downloads-archives",
        icon: ICON.archive,
        severity: "info",
        title: "Archives in Downloads",
        summary: `${archives.file_count} files · ${bytesLabel(archives.total_bytes)}`,
        detail: "Extract what you need and remove the .zip/.rar files to reclaim space.",
        items: [{ label: "Downloads", detail: bytesLabel(archives.total_bytes), path: archives.folder_path }],
        folderPath: archives.folder_path,
        reclaimableBytes: archives.total_bytes,
      });
    }
  }

  // 2. Desktop clutter — high item count is a better signal than size.
  const desktopStats = byFolder.get("Desktop");
  if (desktopStats) {
    const totalFiles = desktopStats.reduce((n, s) => n + s.file_count, 0);
    const totalBytes = desktopStats.reduce((n, s) => n + s.total_bytes, 0);
    if (totalFiles >= THRESHOLDS.DESKTOP_ITEM_CLUTTER) {
      const desktopPath = desktopStats[0].folder_path;
      findings.push({
        id: "desktop-clutter",
        icon: ICON.desktop,
        severity: "warning",
        title: "Desktop clutter",
        summary: `${totalFiles} items · ${bytesLabel(totalBytes)}`,
        detail: "A cluttered desktop slows logins and makes files hard to find. Consider sorting into Documents / Pictures subfolders.",
        items: desktopStats
          .filter((s) => s.file_count > 0)
          .map((s) => ({
            label: s.category,
            detail: `${s.file_count} · ${bytesLabel(s.total_bytes)}`,
          })),
        folderPath: desktopPath,
        reclaimableBytes: 0, // clutter, not reclaimable
      });
    }
  }

  // 3. Misplaced videos — a lot of video bytes outside the Videos folder.
  let misplacedVideoBytes = 0;
  let misplacedVideoFiles = 0;
  const misplacedVideoSources: FindingItem[] = [];
  for (const [key, arr] of byFolder) {
    if (key === "Videos") continue;
    const v = buildCategoryMap(arr)["videos"];
    if (v && v.total_bytes > 0) {
      misplacedVideoBytes += v.total_bytes;
      misplacedVideoFiles += v.file_count;
      misplacedVideoSources.push({
        label: key,
        detail: `${v.file_count} · ${bytesLabel(v.total_bytes)}`,
        path: v.folder_path,
      });
    }
  }
  if (misplacedVideoBytes >= THRESHOLDS.MISPLACED_VIDEO_BYTES) {
    findings.push({
      id: "misplaced-videos",
      icon: ICON.video,
      severity: "info",
      title: "Videos outside the Videos folder",
      summary: `${misplacedVideoFiles} files · ${bytesLabel(misplacedVideoBytes)}`,
      detail: "Moving large videos into the Videos folder makes them easier to find and keeps other folders trim.",
      items: misplacedVideoSources,
      folderPath: misplacedVideoSources[0]?.path ?? "",
      reclaimableBytes: 0,
    });
  }

  // 4. Misplaced audio.
  let misplacedAudioBytes = 0;
  let misplacedAudioFiles = 0;
  const misplacedAudioSources: FindingItem[] = [];
  for (const [key, arr] of byFolder) {
    if (key === "Music") continue;
    const a = buildCategoryMap(arr)["audio"];
    if (a && a.total_bytes > 0) {
      misplacedAudioBytes += a.total_bytes;
      misplacedAudioFiles += a.file_count;
      misplacedAudioSources.push({
        label: key,
        detail: `${a.file_count} · ${bytesLabel(a.total_bytes)}`,
        path: a.folder_path,
      });
    }
  }
  if (misplacedAudioBytes >= THRESHOLDS.MISPLACED_AUDIO_BYTES) {
    findings.push({
      id: "misplaced-audio",
      icon: ICON.music,
      severity: "info",
      title: "Audio outside the Music folder",
      summary: `${misplacedAudioFiles} files · ${bytesLabel(misplacedAudioBytes)}`,
      detail: "Consider consolidating music files under the Music folder for easier management.",
      items: misplacedAudioSources,
      folderPath: misplacedAudioSources[0]?.path ?? "",
      reclaimableBytes: 0,
    });
  }

  // Prioritise by severity (warning > info) then by reclaimable space.
  const sevWeight: Record<Severity, number> = { warning: 2, info: 1, suggestion: 0 };
  findings.sort((a, b) => {
    const sev = sevWeight[b.severity] - sevWeight[a.severity];
    if (sev !== 0) return sev;
    return b.reclaimableBytes - a.reclaimableBytes;
  });

  // Cap to 6 as per design — any more becomes wall-of-cards.
  return findings.slice(0, 6);
}

// ---------------------------------------------------------------------------
// Pass 3 — subfolder suggestions
// ---------------------------------------------------------------------------

// Strong code-home names — folders literally named one of these are almost
// certainly intended as a repo consolidation folder, and ONE repo inside is
// enough evidence that the folder already exists. Weaker names (`code`, `dev`)
// are ambiguous and need multiple repos before we trust them as a home.
const STRONG_CODE_HOME = /^(github|gitlab|bitbucket|projects|project|repos|repositories)$/;
const WEAK_CODE_HOME   = /^(workspace|workspaces|dev|devel|coding|code)$/;

// A repo path is "inside a code home" if any segment of its parent chain
// matches a code-home folder name. We deliberately don't test for `src` /
// `source` here because those commonly appear INSIDE a repo (e.g.
// `my-app/src/foo.rs`) and would wrongly mark the repo as consolidated.
function isInsideCodeHome(repoPath: string): boolean {
  const norm = repoPath.replace(/[/]/g, "\\").replace(/\\+$/, "");
  const lastSep = norm.lastIndexOf("\\");
  if (lastSep < 0) return false;
  const parentChain = norm.slice(0, lastSep).toLowerCase().split("\\");
  return parentChain.some((seg) => STRONG_CODE_HOME.test(seg) || WEAK_CODE_HOME.test(seg));
}

/** Returns the absolute path of an existing code-home folder (GitHub, Projects,
 *  etc.) if one is detectable from the project paths, else null. We derive
 *  this from the detected repos themselves:
 *    • A single repo under a folder whose leaf is a STRONG home name ("GitHub",
 *      "Projects", "Repos") is enough — that folder clearly exists and is
 *      being used for repos.
 *    • A weak home name ("code", "dev") needs ≥ 2 repos to avoid false
 *      positives on incidental folder names. */
function findExistingCodeHome(projects: DetectedProject[]): string | null {
  const parentCounts = new Map<string, { count: number; strong: boolean }>();
  for (const p of projects) {
    const norm = p.path.replace(/[/]/g, "\\").replace(/\\+$/, "");
    const lastSep = norm.lastIndexOf("\\");
    if (lastSep <= 2) continue;
    const parent = norm.slice(0, lastSep);
    const parentLeaf = parent.slice(parent.lastIndexOf("\\") + 1).toLowerCase();
    const isStrong = STRONG_CODE_HOME.test(parentLeaf);
    const isWeak   = WEAK_CODE_HOME.test(parentLeaf);
    if (!isStrong && !isWeak) continue;
    const prev = parentCounts.get(parent);
    parentCounts.set(parent, {
      count: (prev?.count ?? 0) + 1,
      strong: isStrong,
    });
  }
  // Prefer strong matches over weak; within each group, most-repos wins.
  let winner: string | null = null;
  let winnerScore = 0;
  for (const [path, info] of parentCounts) {
    const threshold = info.strong ? 1 : 2;
    if (info.count < threshold) continue;
    // Score: strong matches dominate; count tiebreaker.
    const score = (info.strong ? 1000 : 0) + info.count;
    if (score > winnerScore) { winner = path; winnerScore = score; }
  }
  return winner;
}

export function generateSubfolderSuggestions(
  projects: DetectedProject[],
  stats: FileTypeStat[],
): SubfolderSuggestion[] {
  const suggestions: SubfolderSuggestion[] = [];
  const byFolder = groupStatsByFolder(stats);

  // 1. Scattered code repos.
  //
  // A repo counts as "scattered" when it is NOT already inside a dedicated
  // code-home folder (GitHub / Projects / Code / ...). We then split into two
  // messages depending on whether an existing code-home was detected:
  //   • If yes → "Move these N repos into your existing GitHub folder"
  //   • If no  → "Create a GitHub folder to consolidate these N repos"
  //
  // This prevents the common false positive where the user already has a
  // GitHub folder, but a few stray repos on Desktop/Documents trigger the
  // generic "create a GitHub folder" advice.
  const codeProjects = projects.filter(
    (p) => p.project_type === "git" || p.project_type === "nodejs"
        || p.project_type === "rust" || p.project_type === "dotnet"
        || p.project_type === "python",
  );
  const scattered = codeProjects.filter((p) => !isInsideCodeHome(p.path));
  if (scattered.length >= THRESHOLDS.SCATTERED_REPOS_MIN) {
    const existingHome = findExistingCodeHome(codeProjects);
    if (existingHome) {
      // User already has a GitHub/Projects/etc. folder — nudge them to move
      // the stragglers in rather than creating yet another one.
      const homeLeaf = existingHome.slice(existingHome.lastIndexOf("\\") + 1);
      suggestions.push({
        id: "consolidate-repos",
        suggestedName: homeLeaf,
        parentPath: existingHome,
        reason: `${scattered.length} code ${scattered.length === 1 ? "repository" : "repositories"} found outside your "${homeLeaf}" folder. Move them in to keep all repos in one place.`,
        relatedItems: scattered.slice(0, 10).map((p) => ({
          label: p.display_name,
          detail: p.project_type,
          path: p.path,
        })),
      });
    } else {
      const parent = commonParent(scattered.map((p) => p.path));
      suggestions.push({
        id: "github-folder",
        suggestedName: "GitHub",
        parentPath: parent,
        reason: `${scattered.length} code repositories found scattered across your user folders. A dedicated folder keeps them together.`,
        relatedItems: scattered.slice(0, 10).map((p) => ({
          label: p.display_name,
          detail: p.project_type,
          path: p.path,
        })),
      });
    }
  }

  // 2. Loose screenshots on Desktop — if Desktop has ≥ N screenshots, suggest
  //    creating Pictures\Screenshots.
  const desktopStats = byFolder.get("Desktop");
  const desktopScreens = desktopStats ? buildCategoryMap(desktopStats)["screenshots"] : undefined;
  if (desktopScreens && desktopScreens.file_count >= THRESHOLDS.LOOSE_SCREENSHOTS_MIN) {
    const picPath = byFolder.get("Pictures")?.[0]?.folder_path ?? "";
    suggestions.push({
      id: "screenshots-folder",
      suggestedName: "Screenshots",
      parentPath: picPath || desktopScreens.folder_path,
      reason: `${desktopScreens.file_count} screenshots found on your Desktop — moving them under Pictures\\Screenshots keeps the desktop tidy.`,
      relatedItems: [{
        label: "Desktop",
        detail: `${desktopScreens.file_count} · ${bytesLabel(desktopScreens.total_bytes)}`,
        path: desktopScreens.folder_path,
      }],
    });
  }

  // Note: we deliberately do NOT emit an "Installers folder" suggestion.
  // Installers should be deleted once the app is installed, not filed away
  // into a subfolder. The "Installers lingering in Downloads" finding already
  // handles this case with the correct "delete when done" guidance.

  return suggestions.slice(0, 3);
}

function commonParent(paths: string[]): string {
  if (paths.length === 0) return "";
  const normalized = paths.map((p) => p.replace(/[/]/g, "\\").split("\\"));
  const first = normalized[0];
  let common = 0;
  for (let i = 0; i < first.length; i++) {
    if (normalized.every((parts) => parts[i]?.toLowerCase() === first[i]?.toLowerCase())) {
      common = i + 1;
    } else {
      break;
    }
  }
  const parent = first.slice(0, common).join("\\");
  // Trim to at least 2 levels (e.g. "C:\Users\name") for sanity.
  if (!parent || parent.length < 4) {
    const parts = normalized[0];
    return parts.slice(0, Math.min(3, parts.length - 1)).join("\\");
  }
  return parent;
}

// ---------------------------------------------------------------------------
// Orchestrator + score
// ---------------------------------------------------------------------------

/**
 * Compute a 0-100 organization score. Starts at 100, deducts per-finding based
 * on severity and reclaimable size. Capped at a minimum of 10 so the UI never
 * shows 0 (which feels unhelpful when there's actual data).
 */
export function computeOrgScore(findings: FindingGroup[]): number {
  let score = 100;
  for (const f of findings) {
    const sevPenalty = f.severity === "warning" ? 12 : 6;
    score -= sevPenalty;
    // Extra penalty for big reclaimable piles (every 5 GB knocks off 3 points).
    const reclaimGB = f.reclaimableBytes / 1024 ** 3;
    score -= Math.min(10, Math.floor(reclaimGB / 5) * 3);
  }
  return Math.max(10, Math.min(100, Math.round(score)));
}

export function scoreLabel(score: number): string {
  if (score >= 85) return "Great";
  if (score >= 70) return "Good";
  if (score >= 50) return "Fair";
  if (score >= 30) return "Cluttered";
  return "Needs work";
}

export function runOrganizerAnalysis(
  stats: FileTypeStat[],
  projects: DetectedProject[],
): OrganizerAnalysis {
  const compositions = analyzeFolderComposition(stats);
  const findings = detectFindings(stats);
  const suggestions = generateSubfolderSuggestions(projects, stats);
  const orgScore = computeOrgScore(findings);
  const reclaimableBytes = findings.reduce((n, f) => n + f.reclaimableBytes, 0);
  return { compositions, findings, suggestions, orgScore, reclaimableBytes };
}

// Category → color (CSS var or literal) used by the stacked bars + legend.
// Exposed here so the component doesn't duplicate the palette.
export const CATEGORY_COLORS: Record<OrganizerCategory, string> = {
  documents:   "#5b9cf6",  // blue (accent-primary)
  images:      "#a78bfa",  // purple
  videos:      "#f472b6",  // pink
  audio:       "#22d3ee",  // cyan
  archives:    "#f5a524",  // amber
  code:        "#34d399",  // green
  executables: "#94a3b8",  // slate
  installers:  "#ef5350",  // red
  screenshots: "#c084fc",  // light purple
  other:       "#4b5563",  // gray
};

export const CATEGORY_LABELS: Record<OrganizerCategory, string> = {
  documents:   "Documents",
  images:      "Images",
  videos:      "Videos",
  audio:       "Audio",
  archives:    "Archives",
  code:        "Code",
  executables: "Executables",
  installers:  "Installers",
  screenshots: "Screenshots",
  other:       "Other",
};

export { bytesLabel };

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

import type {
  FileTypeStat,
  DetectedProject,
  OrganizerCategory,
  BuildArtifact,
  DuplicateGroup,
  InstalledAppInfo,
} from "./types";
import {
  detectCloudProvider,
  isCloudSynced,
  deleteVerb,
  cloudMirrorIndices,
} from "./cloudPaths";

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
  // Scattered git repos: this many Git projects outside a dedicated root
  // before we suggest creating a new code-home folder.
  SCATTERED_REPOS_MIN: 3,
  // If an existing code-home (GitHub/Projects/etc.) is already detected, we're
  // more willing to surface the "move these stragglers in" suggestion because
  // the fix is cheap and the target already exists — no new folder to create.
  SCATTERED_REPOS_MIN_WITH_HOME: 2,
  // Loose screenshots on Desktop suggestion trigger.
  LOOSE_SCREENSHOTS_MIN: 10,
  // Misplaced videos (videos outside the Videos folder) — trigger threshold.
  MISPLACED_VIDEO_BYTES: 1 * 1024 ** 3, // 1 GB
  // Large Music-extension footprint outside Music folder.
  MISPLACED_AUDIO_BYTES: 500 * 1024 ** 2, // 500 MB
  // Stale build-artifact folder: hasn't been touched in this many days and is
  // at least this big. Rebuild cost is trivial (`npm install` / `cargo build`),
  // so we're aggressive about flagging them.
  STALE_ARTIFACT_DAYS: 30,
  STALE_ARTIFACT_MIN_BYTES: 200 * 1024 ** 2, // 200 MB
  // Dormant .git repo — `.git` folder > this many MB AND untouched > this many
  // days. Usually benefits from `git gc --aggressive`.
  DORMANT_GIT_MIN_BYTES: 1 * 1024 ** 3, // 1 GB
  DORMANT_GIT_DAYS: 60,
  // Duplicate-file group is shown when aggregate waste clears this size.
  DUP_GROUP_MIN_WASTE: 50 * 1024 ** 2, // 50 MB per group
  DUP_TOTAL_MIN_WASTE: 200 * 1024 ** 2, // or 200 MB total across groups
  // Large single file living outside a project — surfaces as "big lone file".
  LARGE_FILE_MIN_BYTES: 1 * 1024 ** 3, // 1 GB
  // Log / temp / dump pileup triggers.
  LOG_TEMP_MIN_BYTES: 100 * 1024 ** 2, // 100 MB
  LOG_TEMP_MIN_FILES: 25,
  // Recycle Bin "it's getting big" trigger.
  RECYCLE_BIN_WARN_BYTES: 1 * 1024 ** 3, // 1 GB
  RECYCLE_BIN_CRIT_BYTES: 5 * 1024 ** 3, // 5 GB
  // "Forgotten" installed app: > this size AND installed > this long ago.
  APP_BLOAT_MIN_BYTES: 500 * 1024 ** 2, // 500 MB
  APP_BLOAT_MIN_DAYS: 180,               // ~6 months
  // Time-series growth: flag a folder that ≥ doubled AND grew by at least
  // this many bytes between the oldest kept snapshot and now.
  GROWTH_MIN_BYTES: 2 * 1024 ** 3, // 2 GB
  GROWTH_MULTIPLIER: 2,            // 2× or more
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
  /** What kind of action the UI should offer for this finding.
   *  - "recycle": move selected files to Recycle Bin (safe; recoverable).
   *  - "move":    move selected files into `targetFolderKey` home.
   *  - "open":    inert — just opens the folder in Explorer.
   *  - "duplicates": per-group keeper-choice picker (see `duplicates` field).
   *  - "emptyRecycleBin": one-click "empty recycle bin" button. */
  actionType?: "recycle" | "move" | "open" | "duplicates" | "emptyRecycleBin";
  /** File extensions relevant to this finding — used to enumerate individual
   *  files via `list_files_by_extensions`. */
  extensions?: string[];
  /** For "move" actions, the user-folder key to move files into (e.g. "Videos"). */
  targetFolderKey?: string;
  /** When set, the UI should act directly on these paths instead of calling
   *  `list_files_by_extensions`. Used by build-artifact, large-file, and
   *  log/temp findings where the exact paths are known up-front from the
   *  backend scan. Paths are pre-sorted largest-first by the detector. */
  directPaths?: DirectPathItem[];
  /** For "duplicates" findings: each entry is a single duplicate group with
   *  pre-computed keeper suggestions and cloud-mirror annotations. */
  duplicates?: DuplicateFinding[];
  /** Cloud provider (e.g. "OneDrive") when EVERY target of this finding is
   *  inside the same cloud-sync tree. Used to swap verbs ("Delete" →
   *  "Remove from local") and add a one-line warning to the detail copy. */
  cloudProvider?: string | null;
}

/** One direct-action path carried inline on a finding. */
export interface DirectPathItem {
  path: string;
  size_bytes: number;
  label?: string;           // defaults to path leaf
  detail?: string;          // short trailing hint (age, project name, etc.)
  cloudProvider?: string | null;
}

/** A single duplicate group flattened for the UI picker. The detector picks
 *  a `defaultKeeperIndex` — the copy most likely worth keeping — but the user
 *  can override it via the picker before confirming. All other copies become
 *  the recycle target. */
export interface DuplicateFinding {
  hash: string;
  size_bytes: number;          // each path is exactly this size
  copies: DuplicateCopy[];
  defaultKeeperIndex: number;  // index into `copies`
  wastedBytes: number;         // size_bytes × (copies.length - 1)
}

export interface DuplicateCopy {
  path: string;
  label: string;               // leaf name — shown as primary
  directory: string;           // parent folder path for disambiguation
  cloudProvider: string | null;
  /** True when this copy is the cloud mirror of another group member — i.e.
   *  the *same file* happens to live under OneDrive/Dropbox/etc. Keeping a
   *  cloud mirror is usually the wrong call (sync already preserves it). */
  isCloudMirror: boolean;
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

// Extension lists per scanner category — must match the C++ DLL's
// `classify_extension` so we enumerate the same files the scanner counted.
export const CATEGORY_EXTENSIONS: Record<string, string[]> = {
  installers: [".msi", ".msp", ".msix", ".msixbundle", ".appx", ".appxbundle"],
  archives: [".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz", ".iso", ".dmg", ".tgz"],
  videos: [".mp4", ".mkv", ".avi", ".mov", ".wmv", ".webm", ".flv", ".m4v", ".mpg", ".mpeg"],
  audio: [".mp3", ".wav", ".flac", ".aac", ".ogg", ".m4a", ".wma", ".opus", ".aiff", ".ape"],
  screenshots: [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"],
};

// ---------------------------------------------------------------------------
// Creative workflow categories
// ---------------------------------------------------------------------------
//
// These are workflow-specific file types we enumerate separately from the
// main C++ scanner. When enough of a given type are scattered across the
// user's folders, we suggest a dedicated home for them (e.g. "3D Models",
// "Art", "Video Projects"). Each category carries the extensions to scan
// for, a regex of folder names that would count as an already-existing home
// (so we don't suggest creating one that's already there), and whether
// individual files are safe to move via the one-click action.
//
// `safeToAutoMove=true` is set ONLY for file types that are self-contained
// and don't reference sibling assets by relative path. Project-file formats
// like .prproj (Premiere) and .flp (FL Studio) reference external media, so
// moving the project file alone would break it — for those we surface the
// suggestion but omit per-file paths (the user sees the Create-folder button
// and moves the files by hand).

export interface CreativeCategoryDef {
  id: string;
  folderName: string;      // default name when creating the home folder
  displayName: string;     // human description used in "reason" copy
  extensions: string[];    // lower-case, leading-dot extensions
  altHomeNames: RegExp;    // folder-name patterns that count as an existing home
  minScatteredFiles: number;
  minScatteredBytes: number;
  safeToAutoMove: boolean; // can the move button ship file paths?
}

export const CREATIVE_CATEGORIES: CreativeCategoryDef[] = [
  {
    id: "3d-models",
    folderName: "3D Models",
    displayName: "3D modeling files",
    extensions: [".blend", ".blend1", ".fbx", ".obj", ".stl", ".3ds", ".max",
                 ".c4d", ".dae", ".mb", ".ma", ".3mf", ".gltf", ".glb", ".usdz", ".ztl"],
    altHomeNames: /^(3d|3dmodels|3d[\s_-]?models|blender|models|meshes|zbrush)$/i,
    minScatteredFiles: 4,
    minScatteredBytes: 20 * 1024 ** 2, // 20 MB
    safeToAutoMove: true,
  },
  {
    id: "digital-art",
    folderName: "Art",
    displayName: "digital art files",
    extensions: [".psd", ".psb", ".ai", ".clip", ".kra", ".xcf", ".sai",
                 ".sai2", ".csp", ".ora", ".procreate", ".afphoto", ".afdesign"],
    altHomeNames: /^(art|artwork|drawings|paintings|digital[\s_-]?art|illustrations|krita|clipstudio)$/i,
    minScatteredFiles: 4,
    minScatteredBytes: 50 * 1024 ** 2, // 50 MB
    safeToAutoMove: true,
  },
  {
    id: "video-projects",
    folderName: "Video Projects",
    displayName: "video editing project files",
    extensions: [".prproj", ".aep", ".drp", ".veg", ".fcpxml", ".kdenlive", ".mlt", ".cmproj"],
    altHomeNames: /^(video[\s_-]?projects|editing|edits|premiere|resolve|aftereffects|projects[\s_-]?video)$/i,
    minScatteredFiles: 3,
    minScatteredBytes: 5 * 1024 ** 2, // 5 MB — project files are small, scatter matters more than size
    safeToAutoMove: false, // project files reference sibling media
  },
  {
    id: "audio-projects",
    folderName: "Audio Projects",
    displayName: "DAW project files",
    extensions: [".flp", ".als", ".alp", ".logicx", ".ptx", ".rpp", ".cpr", ".reason", ".band", ".npr"],
    altHomeNames: /^(music[\s_-]?projects|daw|fl[\s_-]?studio|ableton|audio[\s_-]?projects|logic[\s_-]?projects|reaper)$/i,
    minScatteredFiles: 3,
    minScatteredBytes: 5 * 1024 ** 2,
    safeToAutoMove: false, // project files reference sibling samples
  },
  {
    id: "raw-photos",
    folderName: "Photos",
    displayName: "RAW photos",
    extensions: [".cr2", ".cr3", ".nef", ".arw", ".dng", ".raf", ".orf", ".rw2", ".pef", ".srw", ".nrw"],
    altHomeNames: /^(photos?|photography|lightroom|raw|captures?)$/i,
    minScatteredFiles: 10,
    minScatteredBytes: 100 * 1024 ** 2, // 100 MB
    safeToAutoMove: true,
  },
  {
    id: "cad-files",
    folderName: "CAD",
    displayName: "CAD files",
    extensions: [".dwg", ".dxf", ".step", ".stp", ".iges", ".igs", ".f3d",
                 ".sldprt", ".sldasm", ".ipt", ".iam", ".3dm", ".skp"],
    altHomeNames: /^(cad|fusion[\s_-]?360|solidworks|inventor|autocad|sketchup|rhino)$/i,
    minScatteredFiles: 3,
    minScatteredBytes: 10 * 1024 ** 2, // 10 MB
    safeToAutoMove: true,
  },
  {
    id: "game-dev",
    folderName: "GameDev",
    displayName: "game engine projects",
    // .uproject (Unreal) and project.godot identify game projects without
    // pulling in tens of thousands of intermediate asset files.
    extensions: [".uproject", ".rbxl", ".rbxlx"],
    altHomeNames: /^(game|games|gamedev|game[\s_-]?dev|unreal|unity[\s_-]?projects|godot)$/i,
    minScatteredFiles: 2,
    minScatteredBytes: 1 * 1024 ** 2, // 1 MB — project manifests are small
    safeToAutoMove: false, // game projects are folders, not single files
  },
];

// Union of every creative extension, used by the frontend to issue a single
// `list_files_by_extensions` call per user folder and then bucket the results
// in JS. Exposed so the StoragePage scan routine doesn't duplicate the list.
export const ALL_CREATIVE_EXTENSIONS: string[] = Array.from(
  new Set(CREATIVE_CATEGORIES.flatMap((c) => c.extensions)),
);

/** One enumerated creative file. Produced by the StoragePage scan routine
 *  from `listFilesByExtensions` results and fed into `runOrganizerAnalysis`. */
export interface CreativeFileRecord {
  path: string;        // absolute path of the file
  ext: string;         // lower-case extension with leading dot
  size_bytes: number;  // size reported by the scanner
  parent_folder: string; // which user folder (Documents, Downloads, …) it was enumerated from
}

/** One enumerated large-standalone file. Produced by the scan routine via
 *  `listFilesByExtensions` with `extensions=[]` (all extensions) + a size
 *  threshold applied JS-side. `parent_folder` is the user-folder label we
 *  walked from (Documents/Downloads/etc.). */
export interface LargeFileRecord {
  path: string;
  size_bytes: number;
  modified_ts: number;
  parent_folder: string;
}

/** One enumerated log / temp / dump file — same shape as LargeFileRecord plus
 *  a normalised extension bucket so the detector can subtotal by kind. */
export interface LogTempFileRecord {
  path: string;
  size_bytes: number;
  modified_ts: number;
  ext: string; // ".log" | ".tmp" | ".etl" | ".dmp" | ".old"
  parent_folder: string;
}

/** Time-series snapshot kept in localStorage. Each entry is an aggregated
 *  by-folder-by-category byte count from one completed scan. The engine keeps
 *  the last N snapshots (see `ORGANIZER_HISTORY_MAX`) and uses them to spot
 *  folders that have doubled in size over the retention window. */
export interface HistorySnapshot {
  ts: number;
  /** Per user-folder total bytes, keyed by the leaf label
   *  ("Documents", "Downloads", …). Kept small so localStorage stays trim. */
  folderTotals: Partial<Record<UserFolderKey, number>>;
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
  code:     "M16 18l6-6-6-6 M8 6l-6 6 6 6",
  copies:   "M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2z M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
  bigFile:  "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M9 15h6 M9 11h4",
  recycle:  "M3 6h18 M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2 M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6",
  clock:    "M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2z M12 6v6l4 2",
  app:      "M2 3h7v7H2z M13 3h7v7h-7z M2 14h7v7H2z M13 14h7v7h-7z",
  trendUp:  "M23 6l-9.5 9.5-5-5L1 18 M17 6h6v6",
  cloud:    "M18 10h-1.3A8 8 0 0 0 6.4 13.4 6 6 0 0 0 7 23h11a5 5 0 0 0 0-10",
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
        actionType: "recycle",
        extensions: CATEGORY_EXTENSIONS.installers,
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
        actionType: "recycle",
        extensions: CATEGORY_EXTENSIONS.archives,
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
        actionType: "open",
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
      actionType: "move",
      extensions: CATEGORY_EXTENSIONS.videos,
      targetFolderKey: "Videos",
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
      actionType: "move",
      extensions: CATEGORY_EXTENSIONS.audio,
      targetFolderKey: "Music",
    });
  }

  // Prioritise by severity (warning > info) then by reclaimable space.
  const sevWeight: Record<Severity, number> = { warning: 2, info: 1, suggestion: 0 };
  findings.sort((a, b) => {
    const sev = sevWeight[b.severity] - sevWeight[a.severity];
    if (sev !== 0) return sev;
    return b.reclaimableBytes - a.reclaimableBytes;
  });

  // NOTE: callers used to cap findings to 6 here. That cap now lives in
  // `runOrganizerAnalysis` so it can fairly consider findings from all of
  // the extended detectors (duplicates, stale artifacts, etc.) alongside
  // these file-type rollups. Return the unbounded list from this pass.
  return findings;
}

// ---------------------------------------------------------------------------
// Extended detectors — operate on data orthogonal to file-type rollups.
// Each returns a *list* of FindingGroups so the orchestrator can merge and
// fairly rank them against the built-in file-type findings.
// ---------------------------------------------------------------------------

/** Human-friendly label for a build-artifact `kind` (from the Rust scanner). */
function artifactKindLabel(kind: string): string {
  switch (kind.toLowerCase()) {
    case "node_modules":   return "node_modules";
    case "target":         return "Rust target/";
    case ".next":          return "Next.js .next/";
    case ".nuxt":          return ".nuxt/";
    case "__pycache__":    return "Python __pycache__";
    case ".venv":
    case "venv":           return "Python venv";
    case "dist":           return "dist/";
    case "build":          return "build/";
    case ".parcel-cache":  return "Parcel cache";
    case ".turbo":         return "Turbo cache";
    case "bower_components": return "bower_components";
    case ".gradle":        return "Gradle cache";
    case "pods":           return "CocoaPods";
    case ".git":           return "dormant .git";
    default:               return kind;
  }
}

/**
 * Stale build / dependency artifacts. Folders like `node_modules` and Rust
 * `target/` are trivially regenerable via `npm install` / `cargo build`, so
 * any copy that hasn't been touched in a while is almost-free reclaim. We
 * emit ONE grouped finding for "everything stale" rather than one per kind
 * so the panel doesn't fill up with near-duplicate cards.
 *
 * Also emits a separate "dormant .git gc" finding when sizable .git dirs
 * haven't had activity — `git gc --aggressive` usually halves them.
 */
export function detectStaleDevArtifacts(artifacts: BuildArtifact[]): FindingGroup[] {
  if (artifacts.length === 0) return [];

  const out: FindingGroup[] = [];
  const now = Date.now();
  const staleMs = THRESHOLDS.STALE_ARTIFACT_DAYS * 86_400_000;
  const gitStaleMs = THRESHOLDS.DORMANT_GIT_DAYS * 86_400_000;

  // Pass 1 — non-git stale artifacts.
  const staleNonGit = artifacts.filter((a) => {
    if (a.kind.toLowerCase() === ".git") return false;
    if (a.size_bytes < THRESHOLDS.STALE_ARTIFACT_MIN_BYTES) return false;
    const ageMs = now - a.newest_modified_ts * 1000;
    return ageMs > staleMs;
  });
  if (staleNonGit.length > 0) {
    // Sort by size desc so the biggest reclaim appears first.
    staleNonGit.sort((a, b) => b.size_bytes - a.size_bytes);
    const total = staleNonGit.reduce((n, a) => n + a.size_bytes, 0);

    // Summarise up to three dominant kinds for the detail copy.
    const byKind = new Map<string, number>();
    for (const a of staleNonGit) {
      byKind.set(a.kind, (byKind.get(a.kind) ?? 0) + a.size_bytes);
    }
    const topKinds = [...byKind.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, b]) => `${artifactKindLabel(k)} (${bytesLabel(b)})`)
      .join(", ");

    out.push({
      id: "stale-build-artifacts",
      icon: ICON.code,
      severity: "warning",
      title: "Stale build artifacts",
      summary: `${staleNonGit.length} folders · ${bytesLabel(total)}`,
      detail:
        `These folders haven't been touched in ${THRESHOLDS.STALE_ARTIFACT_DAYS}+ days and are regenerable — ` +
        `the next build recreates them automatically. Mostly ${topKinds}.`,
      items: staleNonGit.slice(0, 8).map((a) => {
        const ageDays = Math.round((now - a.newest_modified_ts * 1000) / 86_400_000);
        const projectLeaf = a.project_path.slice(a.project_path.lastIndexOf("\\") + 1);
        return {
          label: `${artifactKindLabel(a.kind)} — ${projectLeaf}`,
          detail: `${bytesLabel(a.size_bytes)} · ${ageDays}d old`,
          path: a.path,
        };
      }),
      folderPath: staleNonGit[0].project_path,
      reclaimableBytes: total,
      actionType: "recycle",
      directPaths: staleNonGit.slice(0, 40).map((a) => ({
        path: a.path,
        size_bytes: a.size_bytes,
        label: `${artifactKindLabel(a.kind)} — ${a.project_path.slice(a.project_path.lastIndexOf("\\") + 1)}`,
        detail: `${bytesLabel(a.size_bytes)} · ${Math.round((now - a.newest_modified_ts * 1000) / 86_400_000)}d old`,
      })),
    });
  }

  // Pass 2 — dormant .git repositories worth running `git gc` on.
  const dormantGit = artifacts.filter((a) => {
    if (a.kind.toLowerCase() !== ".git") return false;
    if (a.size_bytes < THRESHOLDS.DORMANT_GIT_MIN_BYTES) return false;
    const ageMs = now - a.newest_modified_ts * 1000;
    return ageMs > gitStaleMs;
  });
  if (dormantGit.length > 0) {
    dormantGit.sort((a, b) => b.size_bytes - a.size_bytes);
    const total = dormantGit.reduce((n, a) => n + a.size_bytes, 0);
    out.push({
      id: "dormant-git-repos",
      icon: ICON.code,
      severity: "info",
      title: "Dormant .git folders",
      summary: `${dormantGit.length} repos · ${bytesLabel(total)}`,
      detail:
        "These .git directories are sizeable but haven't seen commits recently. " +
        "Running `git gc --aggressive` inside each typically reclaims 30-50% without losing history. " +
        "We don't auto-run it — open the folder and run it yourself when you're ready.",
      items: dormantGit.slice(0, 8).map((a) => {
        const projectLeaf = a.project_path.slice(a.project_path.lastIndexOf("\\") + 1);
        const ageDays = Math.round((now - a.newest_modified_ts * 1000) / 86_400_000);
        return {
          label: projectLeaf,
          detail: `${bytesLabel(a.size_bytes)} · ${ageDays}d dormant`,
          path: a.project_path, // reveal the repo root, not the .git subdir
        };
      }),
      folderPath: dormantGit[0].project_path,
      // We can estimate but don't claim the full `.git` size as reclaimable —
      // gc usually recovers ~40% in practice.
      reclaimableBytes: Math.round(total * 0.4),
      actionType: "open",
    });
  }

  return out;
}

/**
 * Choose a reasonable default keeper within a duplicate group. Preference
 * order (first-wins):
 *   1. A copy that is NOT itself a cloud mirror. Cloud mirrors are safe to
 *      drop because the cloud sync preserves them.
 *   2. The copy with the deepest directory path (likeliest "canonical" home).
 *   3. The copy whose parent folder name looks like a dedicated library
 *      folder (Documents, Pictures, Videos, Music, Photos).
 *   4. Fallback: index 0.
 */
function chooseDefaultKeeper(copies: DuplicateCopy[]): number {
  if (copies.length === 0) return 0;
  const nonMirror = copies.findIndex((c) => !c.isCloudMirror);
  if (nonMirror >= 0) {
    // Among non-mirrors, prefer the deepest.
    let best = nonMirror;
    let bestDepth = copies[nonMirror].directory.split(/[\\/]/).length;
    for (let i = 0; i < copies.length; i++) {
      if (copies[i].isCloudMirror) continue;
      const d = copies[i].directory.split(/[\\/]/).length;
      if (d > bestDepth) { best = i; bestDepth = d; }
    }
    return best;
  }
  // All copies are cloud mirrors — pick the deepest as a tiebreak.
  let best = 0;
  let bestDepth = copies[0].directory.split(/[\\/]/).length;
  for (let i = 1; i < copies.length; i++) {
    const d = copies[i].directory.split(/[\\/]/).length;
    if (d > bestDepth) { best = i; bestDepth = d; }
  }
  return best;
}

/**
 * Duplicate detection findings. Each `DuplicateGroup` already represents a
 * set of content-identical files (BLAKE3-verified). We:
 *   • Drop groups that don't clear `DUP_GROUP_MIN_WASTE` per-group.
 *   • Flatten each group into UI-friendly `DuplicateCopy[]` entries with
 *     cloud-mirror annotations.
 *   • Pick a sensible default keeper per group.
 *   • Emit ONE finding listing all qualifying groups for the picker UI.
 */
export function detectDuplicates(groups: DuplicateGroup[]): FindingGroup[] {
  if (groups.length === 0) return [];

  const candidates: DuplicateFinding[] = [];
  for (const g of groups) {
    if (g.paths.length < 2) continue;
    const wasted = g.size_bytes * (g.paths.length - 1);
    if (wasted < THRESHOLDS.DUP_GROUP_MIN_WASTE) continue;

    const mirrorIdx = new Set(cloudMirrorIndices(g.paths));
    const copies: DuplicateCopy[] = g.paths.map((p, i) => {
      const lastSep = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
      return {
        path: p,
        label: lastSep >= 0 ? p.slice(lastSep + 1) : p,
        directory: lastSep >= 0 ? p.slice(0, lastSep) : "",
        cloudProvider: detectCloudProvider(p),
        isCloudMirror: mirrorIdx.has(i),
      };
    });
    candidates.push({
      hash: g.hash,
      size_bytes: g.size_bytes,
      copies,
      defaultKeeperIndex: chooseDefaultKeeper(copies),
      wastedBytes: wasted,
    });
  }

  if (candidates.length === 0) return [];

  // Biggest reclaim first — this is what users care about.
  candidates.sort((a, b) => b.wastedBytes - a.wastedBytes);

  const totalWaste = candidates.reduce((n, c) => n + c.wastedBytes, 0);
  if (totalWaste < THRESHOLDS.DUP_TOTAL_MIN_WASTE) return [];

  // Cap to 20 groups in the finding payload so the picker stays manageable.
  const shown = candidates.slice(0, 20);
  const topGroupsByte = shown.slice(0, 3)
    .map((c) => `${bytesLabel(c.size_bytes)} × ${c.copies.length}`)
    .join(" · ");

  const anyMirror = shown.some((c) => c.copies.some((cp) => cp.isCloudMirror));
  const hint = anyMirror
    ? " Some copies are cloud-synced — those are safe to remove locally since the sync preserves the file."
    : "";

  return [{
    id: "duplicate-files",
    icon: ICON.copies,
    severity: totalWaste > 2 * 1024 ** 3 ? "warning" : "info",
    title: "Duplicate files",
    summary: `${shown.length} ${shown.length === 1 ? "group" : "groups"} · ${bytesLabel(totalWaste)} reclaimable`,
    detail:
      `Content-identical copies detected via BLAKE3 hashing. Top groups: ${topGroupsByte}. ` +
      `Pick which copy to keep per group — the rest are sent to the Recycle Bin.${hint}`,
    items: [], // real data lives on `duplicates` for the picker
    folderPath: shown[0].copies[0].directory,
    reclaimableBytes: totalWaste,
    actionType: "duplicates",
    duplicates: shown,
  }];
}

/**
 * Big lone files living outside project/build folders. These are usually
 * ISO downloads, old video exports, DB dumps, VM images — genuine
 * "forgotten megapile" candidates. Excludes anything under `projectPaths`
 * since those are managed by their tooling.
 */
export function detectLargeFiles(
  files: LargeFileRecord[],
  projectPaths: string[] = [],
): FindingGroup[] {
  if (files.length === 0) return [];

  const excludePrefixes = projectPaths.map(
    (p) => p.replace(/[/]/g, "\\").replace(/\\+$/, "").toLowerCase() + "\\",
  );
  const inProject = (p: string) => {
    const norm = p.replace(/[/]/g, "\\").toLowerCase();
    return excludePrefixes.some((pref) => norm.startsWith(pref));
  };

  const big = files.filter((f) =>
    f.size_bytes >= THRESHOLDS.LARGE_FILE_MIN_BYTES && !inProject(f.path),
  );
  if (big.length === 0) return [];

  big.sort((a, b) => b.size_bytes - a.size_bytes);
  const shown = big.slice(0, 15);
  const total = shown.reduce((n, f) => n + f.size_bytes, 0);

  return [{
    id: "large-lone-files",
    icon: ICON.bigFile,
    severity: total > 20 * 1024 ** 3 ? "warning" : "info",
    title: "Large individual files",
    summary: `${shown.length} files · ${bytesLabel(total)}`,
    detail:
      "Single files over 1 GB sitting outside any detected project folder. " +
      "Usually old ISOs, DB backups, VM images, or render outputs that can be archived elsewhere.",
    items: shown.slice(0, 8).map((f) => {
      const leaf = f.path.slice(Math.max(f.path.lastIndexOf("\\"), f.path.lastIndexOf("/")) + 1);
      const ageDays = f.modified_ts ? Math.round((Date.now() - f.modified_ts * 1000) / 86_400_000) : null;
      return {
        label: leaf,
        detail: ageDays !== null
          ? `${bytesLabel(f.size_bytes)} · ${ageDays}d old · ${f.parent_folder}`
          : `${bytesLabel(f.size_bytes)} · ${f.parent_folder}`,
        path: f.path,
      };
    }),
    folderPath: shown[0].path.slice(0, Math.max(shown[0].path.lastIndexOf("\\"), shown[0].path.lastIndexOf("/"))),
    reclaimableBytes: total,
    actionType: "recycle",
    directPaths: shown.map((f) => {
      const leaf = f.path.slice(Math.max(f.path.lastIndexOf("\\"), f.path.lastIndexOf("/")) + 1);
      const ageDays = f.modified_ts ? Math.round((Date.now() - f.modified_ts * 1000) / 86_400_000) : null;
      return {
        path: f.path,
        size_bytes: f.size_bytes,
        label: leaf,
        detail: ageDays !== null
          ? `${bytesLabel(f.size_bytes)} · ${ageDays}d old`
          : bytesLabel(f.size_bytes),
        cloudProvider: detectCloudProvider(f.path),
      };
    }),
  }];
}

/**
 * Log / .tmp / .etl / .dmp / .old pileups — usually leftover debug output
 * from crashes, installers, or long-running apps. Safe to recycle.
 */
export function detectLogAndTempFiles(files: LogTempFileRecord[]): FindingGroup[] {
  if (files.length === 0) return [];

  const totalBytes = files.reduce((n, f) => n + f.size_bytes, 0);
  if (
    files.length < THRESHOLDS.LOG_TEMP_MIN_FILES &&
    totalBytes < THRESHOLDS.LOG_TEMP_MIN_BYTES
  ) return [];

  // Bucket by extension for the summary.
  const byExt = new Map<string, { count: number; bytes: number }>();
  for (const f of files) {
    const b = byExt.get(f.ext) ?? { count: 0, bytes: 0 };
    b.count += 1;
    b.bytes += f.size_bytes;
    byExt.set(f.ext, b);
  }
  const bucketSummary = [...byExt.entries()]
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, 4)
    .map(([ext, v]) => `${v.count} ${ext} (${bytesLabel(v.bytes)})`)
    .join(", ");

  const sorted = [...files].sort((a, b) => b.size_bytes - a.size_bytes);
  const shown = sorted.slice(0, 40);

  return [{
    id: "log-temp-files",
    icon: ICON.recycle,
    severity: totalBytes > 1 * 1024 ** 3 ? "warning" : "info",
    title: "Log / temp / dump files",
    summary: `${files.length} files · ${bytesLabel(totalBytes)}`,
    detail:
      `Debug output, crash dumps, and leftover temp files — almost always safe to delete. ` +
      `Dominant buckets: ${bucketSummary}.`,
    items: shown.slice(0, 8).map((f) => {
      const leaf = f.path.slice(Math.max(f.path.lastIndexOf("\\"), f.path.lastIndexOf("/")) + 1);
      return {
        label: leaf,
        detail: `${bytesLabel(f.size_bytes)} · ${f.parent_folder}`,
        path: f.path,
      };
    }),
    folderPath: shown[0].path.slice(0, Math.max(shown[0].path.lastIndexOf("\\"), shown[0].path.lastIndexOf("/"))),
    reclaimableBytes: totalBytes,
    actionType: "recycle",
    directPaths: shown.map((f) => {
      const leaf = f.path.slice(Math.max(f.path.lastIndexOf("\\"), f.path.lastIndexOf("/")) + 1);
      return {
        path: f.path,
        size_bytes: f.size_bytes,
        label: leaf,
        detail: bytesLabel(f.size_bytes),
      };
    }),
  }];
}

/** Recycle Bin warning — past a certain size the Bin itself starts eating
 *  real disk. One click empties it. */
export function detectRecycleBinBloat(sizeBytes: number): FindingGroup[] {
  if (sizeBytes < THRESHOLDS.RECYCLE_BIN_WARN_BYTES) return [];
  const sev: Severity = sizeBytes >= THRESHOLDS.RECYCLE_BIN_CRIT_BYTES ? "warning" : "info";
  return [{
    id: "recycle-bin-bloat",
    icon: ICON.recycle,
    severity: sev,
    title: "Recycle Bin is using real disk space",
    summary: bytesLabel(sizeBytes),
    detail:
      "Items in the Recycle Bin still occupy their original size on disk. " +
      "Emptying the bin permanently deletes its contents — make sure nothing in it needs recovering first.",
    items: [],
    folderPath: "",
    reclaimableBytes: sizeBytes,
    actionType: "emptyRecycleBin",
  }];
}

/**
 * Installed-app bloat. Without actual usage telemetry we rely on a heuristic:
 * install_date older than N days AND size over threshold → "forgotten app".
 * This is intentionally conservative (6 months + 500 MB) so we don't nag
 * about apps the user still opens regularly. The action is "open" — we
 * surface the app's install location and let the user uninstall via their
 * preferred route rather than automating it.
 */
export function detectUnusedInstalledApps(apps: InstalledAppInfo[]): FindingGroup[] {
  if (apps.length === 0) return [];

  const now = Date.now();
  const cutoff = THRESHOLDS.APP_BLOAT_MIN_DAYS * 86_400_000;
  interface Candidate { app: InstalledAppInfo; ageDays: number; }

  const candidates: Candidate[] = [];
  for (const app of apps) {
    if (!app.size_bytes || app.size_bytes < THRESHOLDS.APP_BLOAT_MIN_BYTES) continue;
    // `install_date` is the raw string Windows returns — YYYYMMDD typically.
    const parsed = parseWindowsInstallDate(app.install_date);
    if (!parsed) continue;
    const age = now - parsed;
    if (age < cutoff) continue;
    candidates.push({ app, ageDays: Math.round(age / 86_400_000) });
  }
  if (candidates.length === 0) return [];

  candidates.sort((a, b) => b.app.size_bytes - a.app.size_bytes);
  const shown = candidates.slice(0, 8);
  const total = shown.reduce((n, c) => n + c.app.size_bytes, 0);

  return [{
    id: "unused-installed-apps",
    icon: ICON.app,
    severity: "info",
    title: "Large apps installed a while ago",
    summary: `${shown.length} apps · ${bytesLabel(total)}`,
    detail:
      `Installed ${THRESHOLDS.APP_BLOAT_MIN_DAYS}+ days ago and over ${bytesLabel(THRESHOLDS.APP_BLOAT_MIN_BYTES)}. ` +
      "We can't verify whether you still use them — open each in Settings > Apps if you want to uninstall.",
    items: shown.map((c) => ({
      label: c.app.name || "Unnamed app",
      detail: `${bytesLabel(c.app.size_bytes)} · ${c.ageDays}d since install${c.app.publisher ? ` · ${c.app.publisher}` : ""}`,
      path: c.app.install_location || undefined,
    })),
    folderPath: shown[0].app.install_location || "",
    reclaimableBytes: 0, // we don't commit to the number — user decides
    actionType: "open",
  }];
}

/** Best-effort parser for Windows' install-date string. Common forms:
 *   - "YYYYMMDD"   (registry DisplayInstallDate)
 *   - "M/D/YYYY"   (older reg key)
 *   - empty / missing (many MS store apps)
 *  Returns a JS timestamp or null if unparseable. */
function parseWindowsInstallDate(s: string): number | null {
  if (!s) return null;
  const trimmed = s.trim();
  // YYYYMMDD
  if (/^\d{8}$/.test(trimmed)) {
    const y = +trimmed.slice(0, 4);
    const m = +trimmed.slice(4, 6);
    const d = +trimmed.slice(6, 8);
    const t = new Date(y, m - 1, d).getTime();
    return Number.isFinite(t) ? t : null;
  }
  // M/D/YYYY or MM/DD/YYYY
  const us = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) {
    const t = new Date(+us[3], +us[1] - 1, +us[2]).getTime();
    return Number.isFinite(t) ? t : null;
  }
  // ISO-ish
  const iso = Date.parse(trimmed);
  return Number.isFinite(iso) ? iso : null;
}

/**
 * Time-series growth detection. Given history snapshots sorted oldest→newest,
 * flag any user folder that has at least doubled AND grown by
 * `GROWTH_MIN_BYTES` from the oldest snapshot to the current rollup. Useful
 * for catching "Downloads quietly grew to 40 GB over two months" before it
 * becomes a real problem.
 */
export function detectTimeSeriesGrowth(
  history: HistorySnapshot[],
  currentStats: FileTypeStat[],
): FindingGroup[] {
  if (history.length < 2) return [];
  const oldest = history[0];

  // Build current totals per user folder from `currentStats`.
  const currentTotals = new Map<UserFolderKey, number>();
  for (const s of currentStats) {
    const key = matchUserFolder(s.folder_path);
    if (!key) continue;
    currentTotals.set(key, (currentTotals.get(key) ?? 0) + s.total_bytes);
  }

  interface Growth { key: UserFolderKey; before: number; after: number; }
  const growers: Growth[] = [];
  for (const key of USER_FOLDER_KEYS) {
    const before = oldest.folderTotals[key] ?? 0;
    const after = currentTotals.get(key) ?? 0;
    if (before <= 0 || after <= 0) continue;
    if (after < before * THRESHOLDS.GROWTH_MULTIPLIER) continue;
    if (after - before < THRESHOLDS.GROWTH_MIN_BYTES) continue;
    growers.push({ key, before, after });
  }
  if (growers.length === 0) return [];

  // Biggest absolute growth first.
  growers.sort((a, b) => (b.after - b.before) - (a.after - a.before));

  const windowDays = Math.max(1, Math.round((Date.now() - oldest.ts) / 86_400_000));
  const out: FindingGroup[] = [];
  // Emit one finding PER grower, capped to the top 2 to avoid card spam.
  for (const g of growers.slice(0, 2)) {
    const delta = g.after - g.before;
    const multiple = (g.after / g.before).toFixed(1);
    // Locate a representative folder path for the "Open folder" button.
    const sample = currentStats.find((s) => matchUserFolder(s.folder_path) === g.key);
    out.push({
      id: `growth-${g.key.toLowerCase()}`,
      icon: ICON.trendUp,
      severity: "info",
      title: `${g.key} has grown a lot recently`,
      summary: `${bytesLabel(g.before)} → ${bytesLabel(g.after)} (+${bytesLabel(delta)}, ${multiple}×)`,
      detail:
        `Over the last ${windowDays} day${windowDays === 1 ? "" : "s"} this folder has ` +
        `grown by ${bytesLabel(delta)}. Worth a look to see what's piling up.`,
      items: [{
        label: g.key,
        detail: `${bytesLabel(g.before)} → ${bytesLabel(g.after)}`,
        path: sample?.folder_path,
      }],
      folderPath: sample?.folder_path ?? "",
      reclaimableBytes: 0,
      actionType: "open",
    });
  }
  return out;
}

/** Annotate findings with cloud-provider info + swap the verb where
 *  appropriate. Mutates the passed findings in place and returns them. */
function applyCloudAwareness(findings: FindingGroup[]): FindingGroup[] {
  for (const f of findings) {
    // A finding is "all-cloud" when every direct path it targets lives under
    // the same provider. Single-provider detection lets us use a concrete
    // label in the UI ("OneDrive") rather than a generic one.
    const directs = f.directPaths ?? [];
    if (directs.length === 0) continue;
    const providers = new Set<string>();
    let allCloud = true;
    for (const d of directs) {
      const prov = d.cloudProvider ?? detectCloudProvider(d.path);
      if (!prov) { allCloud = false; break; }
      providers.add(prov);
    }
    if (allCloud && providers.size === 1) {
      const prov = [...providers][0];
      f.cloudProvider = prov;
      // Append a one-liner so users know the action will propagate to the cloud.
      if (f.actionType === "recycle") {
        f.detail += ` These files are synced to ${prov} — recycling them locally will propagate the deletion to the cloud copy.`;
      }
    }
  }
  return findings;
}

export { deleteVerb, isCloudSynced }; // re-export for the panel

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
 *  etc.) if one is detectable, else null. Detection happens in two independent
 *  passes, and the higher-confidence winner wins:
 *
 *    Pass A — from detected repos:
 *      • A single repo under a folder whose leaf is a STRONG home name ("GitHub",
 *        "Projects", "Repos") is enough — that folder clearly exists and is
 *        being used for repos.
 *      • A weak home name ("code", "dev") needs ≥ 2 repos to avoid false
 *        positives on incidental folder names.
 *
 *    Pass B — from known subfolders under the user home (e.g. top folders
 *    returned by `get_top_folders(home, N)`):
 *      • If any subfolder's leaf matches STRONG_CODE_HOME, that folder
 *        exists even if no repos were detected inside it (empty or sparsely
 *        populated). This is the critical fix for the false-positive where
 *        the user already has a "GitHub" folder but with few/no detected
 *        projects, and we used to wrongly suggest creating another one.
 *      • WEAK names are included too when coming from a real folder listing,
 *        because the existence of a folder literally named "dev" is stronger
 *        evidence of intent than an incidentally-named parent path segment.
 *
 *    Pass A winners score higher (we know the folder is actively used), but
 *    Pass B still beats "null" — which was the source of the reported bug. */
function findExistingCodeHome(
  projects: DetectedProject[],
  knownSubfolderPaths: string[] = [],
): string | null {
  let winner: string | null = null;
  let winnerScore = 0;

  // Pass A — parents of detected repos.
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
  for (const [path, info] of parentCounts) {
    const threshold = info.strong ? 1 : 2;
    if (info.count < threshold) continue;
    // Pass-A score: strong matches dominate; count is tiebreaker. Offset of
    // 10_000 keeps Pass A above Pass B even with max reasonable repo counts.
    const score = 10_000 + (info.strong ? 1000 : 0) + info.count;
    if (score > winnerScore) { winner = path; winnerScore = score; }
  }

  // Pass B — folders that literally exist under the user home, regardless of
  // whether repos live inside. This is what fixes the "suggest creating a
  // GitHub folder when one already exists" bug.
  for (const rawPath of knownSubfolderPaths) {
    const norm = rawPath.replace(/[/]/g, "\\").replace(/\\+$/, "");
    if (!norm) continue;
    const leaf = norm.slice(norm.lastIndexOf("\\") + 1).toLowerCase();
    if (!leaf) continue;
    const isStrong = STRONG_CODE_HOME.test(leaf);
    const isWeak   = WEAK_CODE_HOME.test(leaf);
    if (!isStrong && !isWeak) continue;
    const score = (isStrong ? 500 : 100);
    if (score > winnerScore) { winner = norm; winnerScore = score; }
  }

  return winner;
}

/** Does `knownSubfolderPaths` contain any folder whose path (case-insensitive)
 *  matches `leafChain` — i.e. a trailing sequence of leaf names?
 *
 *  Example: `hasSubfolderChain(paths, ["Pictures", "Screenshots"])` returns
 *  true iff some path ends in `...\Pictures\Screenshots`. Used to detect
 *  already-created organization folders so we don't suggest making them again.
 */
function hasSubfolderChain(knownSubfolderPaths: string[], leafChain: string[]): boolean {
  if (leafChain.length === 0) return false;
  const suffix = "\\" + leafChain.join("\\").toLowerCase();
  for (const raw of knownSubfolderPaths) {
    const norm = raw.replace(/[/]/g, "\\").replace(/\\+$/, "").toLowerCase();
    if (norm.endsWith(suffix)) return true;
  }
  return false;
}

export function generateSubfolderSuggestions(
  projects: DetectedProject[],
  stats: FileTypeStat[],
  knownSubfolderPaths: string[] = [],
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
  // Existence detection uses BOTH the repo-parent pass AND a by-name pass
  // against `knownSubfolderPaths` so that a GitHub folder which exists but
  // contains no detected projects still counts as "already exists".
  const codeProjects = projects.filter(
    (p) => p.project_type === "git" || p.project_type === "nodejs"
        || p.project_type === "rust" || p.project_type === "dotnet"
        || p.project_type === "python",
  );
  const scattered = codeProjects.filter((p) => !isInsideCodeHome(p.path));
  const existingHome = findExistingCodeHome(codeProjects, knownSubfolderPaths);

  // When a home already exists the fix is cheap (just drag the repos in), so
  // we trigger at a lower threshold — 2 stragglers are still worth flagging.
  const threshold = existingHome
    ? THRESHOLDS.SCATTERED_REPOS_MIN_WITH_HOME
    : THRESHOLDS.SCATTERED_REPOS_MIN;

  if (scattered.length >= threshold) {
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
  //    creating Pictures\Screenshots. If that folder already exists we reframe
  //    as "move them into your existing Screenshots folder" instead of
  //    wrongly telling the user to create one they already have.
  const desktopStats = byFolder.get("Desktop");
  const desktopScreens = desktopStats ? buildCategoryMap(desktopStats)["screenshots"] : undefined;
  if (desktopScreens && desktopScreens.file_count >= THRESHOLDS.LOOSE_SCREENSHOTS_MIN) {
    const picPath = byFolder.get("Pictures")?.[0]?.folder_path ?? "";
    const existingScreenshots = hasSubfolderChain(knownSubfolderPaths, ["Pictures", "Screenshots"])
      || hasSubfolderChain(knownSubfolderPaths, ["Screenshots"]);
    const fileWord = desktopScreens.file_count === 1 ? "screenshot" : "screenshots";
    suggestions.push({
      id: "screenshots-folder",
      suggestedName: "Screenshots",
      parentPath: picPath || desktopScreens.folder_path,
      reason: existingScreenshots
        ? `${desktopScreens.file_count} ${fileWord} on your Desktop — your Pictures\\Screenshots folder already exists, move them in.`
        : `${desktopScreens.file_count} ${fileWord} found on your Desktop — moving them under Pictures\\Screenshots keeps the desktop tidy.`,
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

// ---------------------------------------------------------------------------
// Pass 3b — creative workflow suggestions
// ---------------------------------------------------------------------------

/** Returns the absolute path of a folder under `knownSubfolderPaths` whose
 *  leaf name matches `altHomeNames`, or null. Used by the creative-workflow
 *  suggestion generator to tell whether a user already has (say) a "Blender"
 *  folder and so we should nudge them to move files in rather than create a
 *  new "3D Models" folder. */
function findExistingCreativeHome(
  altHomeNames: RegExp,
  knownSubfolderPaths: string[],
): string | null {
  for (const raw of knownSubfolderPaths) {
    const norm = raw.replace(/[/]/g, "\\").replace(/\\+$/, "");
    if (!norm) continue;
    const leaf = norm.slice(norm.lastIndexOf("\\") + 1);
    if (altHomeNames.test(leaf)) return norm;
  }
  return null;
}

/** Strip a user-folder leaf (Documents/Downloads/...) off the end of `path`
 *  so creative-home suggestions land at the user root rather than nested
 *  inside a well-known folder (we'd rather suggest `C:\Users\Foo\3D Models`
 *  than `C:\Users\Foo\Documents\3D Models`). */
function stripUserFolderLeaf(path: string): string {
  const norm = path.replace(/[/]/g, "\\").replace(/\\+$/, "");
  const lastSep = norm.lastIndexOf("\\");
  if (lastSep <= 2) return norm;
  const leaf = norm.slice(lastSep + 1).toLowerCase();
  if (USER_FOLDER_KEYS.some((k) => k.toLowerCase() === leaf)) {
    return norm.slice(0, lastSep);
  }
  return norm;
}

export function generateCreativeSuggestions(
  creativeFiles: CreativeFileRecord[],
  knownSubfolderPaths: string[] = [],
): SubfolderSuggestion[] {
  if (creativeFiles.length === 0) return [];

  // Bucket files by category via extension lookup.
  const extToCategory = new Map<string, CreativeCategoryDef>();
  for (const cat of CREATIVE_CATEGORIES) {
    for (const ext of cat.extensions) extToCategory.set(ext.toLowerCase(), cat);
  }

  const bucket = new Map<string, CreativeFileRecord[]>();
  for (const f of creativeFiles) {
    const cat = extToCategory.get(f.ext.toLowerCase());
    if (!cat) continue;
    const arr = bucket.get(cat.id) ?? [];
    arr.push(f);
    bucket.set(cat.id, arr);
  }

  interface CategoryCandidate {
    cat: CreativeCategoryDef;
    files: CreativeFileRecord[];
    totalBytes: number;
    existingHome: string | null;
  }

  const candidates: CategoryCandidate[] = [];
  for (const cat of CREATIVE_CATEGORIES) {
    const files = bucket.get(cat.id) ?? [];
    if (files.length < cat.minScatteredFiles) continue;
    const totalBytes = files.reduce((n, f) => n + f.size_bytes, 0);
    if (totalBytes < cat.minScatteredBytes) continue;
    // Skip if files are already consolidated under a single existing home:
    // if the common parent of all files matches altHomeNames, the user has
    // already organized them and we shouldn't nag.
    const parent = commonParent(files.map((f) => f.path));
    const parentLeaf = parent.slice(parent.lastIndexOf("\\") + 1);
    if (cat.altHomeNames.test(parentLeaf)) continue;
    const existingHome = findExistingCreativeHome(cat.altHomeNames, knownSubfolderPaths);
    candidates.push({ cat, files, totalBytes, existingHome });
  }

  // Prioritise by total size so the biggest clutter gets flagged first.
  candidates.sort((a, b) => b.totalBytes - a.totalBytes);

  const suggestions: SubfolderSuggestion[] = [];
  for (const { cat, files, totalBytes, existingHome } of candidates) {
    const sizeLabel = bytesLabel(totalBytes);

    // Related items — include paths only when safe to auto-move. For project
    // files (Premiere/FL/etc.) moving the single file would break references,
    // so we surface the hint without enabling the one-click move button.
    const relatedItems: FindingItem[] = cat.safeToAutoMove
      ? files.slice(0, 10).map((f) => ({
          label: f.path.slice(f.path.lastIndexOf("\\") + 1),
          detail: `${f.parent_folder} · ${bytesLabel(f.size_bytes)}`,
          path: f.path,
        }))
      : files.slice(0, 10).map((f) => ({
          label: f.path.slice(f.path.lastIndexOf("\\") + 1),
          detail: `${f.parent_folder} · ${bytesLabel(f.size_bytes)}`,
          // path intentionally omitted — prevents Create-&-move from shipping
          // these paths, since project files reference sibling media.
        }));

    if (existingHome) {
      const homeLeaf = existingHome.slice(existingHome.lastIndexOf("\\") + 1);
      suggestions.push({
        id: `consolidate-creative-${cat.id}`,
        suggestedName: homeLeaf,
        parentPath: existingHome,
        reason: `${files.length} ${cat.displayName} (${sizeLabel}) found outside your "${homeLeaf}" folder. Move them in to keep your ${cat.displayName} together.`,
        relatedItems,
      });
    } else {
      const rawParent = commonParent(files.map((f) => f.path));
      const parent = stripUserFolderLeaf(rawParent);
      suggestions.push({
        id: `creative-${cat.id}`,
        suggestedName: cat.folderName,
        parentPath: parent,
        reason: `${files.length} ${cat.displayName} (${sizeLabel}) scattered across your user folders. A dedicated "${cat.folderName}" folder keeps them together.`,
        relatedItems,
      });
    }
  }

  return suggestions;
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

/** Extended inputs bundle for `runOrganizerAnalysis`. All fields are optional
 *  so callers can skip tiers incrementally (e.g. during streaming partial
 *  scans where only `stats` + `projects` exist initially). */
export interface ExtendedOrganizerInputs {
  buildArtifacts?: BuildArtifact[];
  duplicates?: DuplicateGroup[];
  largeFiles?: LargeFileRecord[];
  logTempFiles?: LogTempFileRecord[];
  recycleBinSize?: number;
  installedApps?: InstalledAppInfo[];
  history?: HistorySnapshot[];
}

export function runOrganizerAnalysis(
  stats: FileTypeStat[],
  projects: DetectedProject[],
  knownSubfolderPaths: string[] = [],
  creativeFiles: CreativeFileRecord[] = [],
  extended: ExtendedOrganizerInputs = {},
): OrganizerAnalysis {
  const compositions = analyzeFolderComposition(stats);

  // Merge all detector outputs, then rank + cap at 6 so one detector can't
  // crowd out the others. Per-detector severity + reclaimableBytes drive the
  // ranking so high-severity + high-reclaim findings always bubble up.
  const mergedFindings: FindingGroup[] = [
    ...detectFindings(stats),
    ...detectStaleDevArtifacts(extended.buildArtifacts ?? []),
    ...detectDuplicates(extended.duplicates ?? []),
    ...detectLargeFiles(
      extended.largeFiles ?? [],
      projects.map((p) => p.path),
    ),
    ...detectLogAndTempFiles(extended.logTempFiles ?? []),
    ...detectRecycleBinBloat(extended.recycleBinSize ?? 0),
    ...detectUnusedInstalledApps(extended.installedApps ?? []),
    ...detectTimeSeriesGrowth(extended.history ?? [], stats),
  ];

  applyCloudAwareness(mergedFindings);

  const sevWeight: Record<Severity, number> = { warning: 2, info: 1, suggestion: 0 };
  mergedFindings.sort((a, b) => {
    const sev = sevWeight[b.severity] - sevWeight[a.severity];
    if (sev !== 0) return sev;
    return b.reclaimableBytes - a.reclaimableBytes;
  });
  const findings = mergedFindings.slice(0, 6);

  const baseSuggestions = generateSubfolderSuggestions(projects, stats, knownSubfolderPaths);
  const creativeSuggestions = generateCreativeSuggestions(creativeFiles, knownSubfolderPaths);
  // Base suggestions (code-home, screenshots) come first — they're generally
  // higher-impact. Creative suggestions fill remaining slots. Overall cap is
  // bumped from 3 to 5 so creative workflows can surface alongside the base
  // pair without getting crowded out.
  const suggestions = [...baseSuggestions, ...creativeSuggestions].slice(0, 5);
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

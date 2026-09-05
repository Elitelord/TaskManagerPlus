import type { FoundFile } from "./ipc";
import type { StorageFolderInfo } from "./types";

/** Per-folder drill-down cache (localStorage). Populated by the inspector and
 *  Smart Organizer expand rows so revisiting a folder is instant. */
const SUB_CACHE_KEY = "taskmanagerplus-subfolder-cache-v2";
// Cache entries are considered fresh for 2 hours. Stale entries are re-computed
// in the background — the user still sees the old data instantly while the
// refresh runs, so the TTL can be generous.
export const DRILL_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const LEGACY_SUB_CACHE_KEY = "taskmanagerplus-subfolder-cache";

export interface SubFolderCacheEntry {
  folders: StorageFolderInfo[];
  files: FoundFile[];
  ts: number;
}

export interface DrillContentEntry {
  kind: "file" | "folder";
  name: string;
  path: string;
  size: number;
  fileCount?: number;
  /** False for folders until a background size scan finishes. */
  sizeKnown: boolean;
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(i + 1) : p;
}

/** Normalize paths for cache keys and lookups (Windows-safe). */
export function normCachePath(p: string): string {
  return p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

export function getSubCache(path: string): SubFolderCacheEntry | null {
  try {
    const raw = localStorage.getItem(SUB_CACHE_KEY) ?? localStorage.getItem(LEGACY_SUB_CACHE_KEY);
    if (raw) {
      const cache = JSON.parse(raw);
      const key = normCachePath(path);
      const entry = cache?.[key] ?? cache?.[path];
      if (!entry) return null;
      if (Array.isArray(entry)) return { folders: entry, files: [], ts: 0 };
      if (Array.isArray(entry.folders)) {
        const ts = entry.ts ?? 0;
        if (ts > 0 && Date.now() - ts > DRILL_CACHE_TTL_MS) return null;
        return {
          folders: entry.folders,
          files: Array.isArray(entry.files) ? entry.files : [],
          ts,
        };
      }
    }
  } catch { /* ignore */ }
  return null;
}

// The whole drill cache lives in one localStorage key shared with the storage
// scan + organizer caches under the origin's ~5 MB quota. Without a bound it
// grew until `setItem` threw QuotaExceededError, which the catch swallowed — so
// once full, NOTHING new cached and folder sizes silently stopped persisting.
// Cap the serialized size and evict oldest-first, mirroring StoragePage's scan
// cache. Also cap the per-entry file list so one huge folder can't dominate the
// budget (the inspector shows biggest-first and re-lists on open anyway).
const MAX_SUB_CACHE_BYTES = 2 * 1024 * 1024;
const MAX_FILES_PER_ENTRY = 100;

type SubCache = Record<string, SubFolderCacheEntry>;

/** Evict oldest entries (by `ts`) until the serialized cache is under the cap.
 *  Pure — operates on the object, no localStorage — so it's unit-testable. */
export function trimSubCache(
  cache: SubCache,
  maxBytes: number = MAX_SUB_CACHE_BYTES,
): SubCache {
  // Newest first, so `pop()` drops the oldest.
  const entries = Object.entries(cache).sort((a, b) => (b[1].ts ?? 0) - (a[1].ts ?? 0));
  let serialized = JSON.stringify(Object.fromEntries(entries));
  while (entries.length > 1 && serialized.length > maxBytes) {
    entries.pop();
    serialized = JSON.stringify(Object.fromEntries(entries));
  }
  return Object.fromEntries(entries);
}

export function setSubCache(path: string, folders: StorageFolderInfo[], files: FoundFile[]) {
  try {
    const raw = localStorage.getItem(SUB_CACHE_KEY);
    const cache: SubCache = raw ? JSON.parse(raw) : {};
    const cappedFiles = files.length > MAX_FILES_PER_ENTRY
      ? [...files].sort((a, b) => b.size_bytes - a.size_bytes).slice(0, MAX_FILES_PER_ENTRY)
      : files;
    cache[normCachePath(path)] = { folders, files: cappedFiles, ts: Date.now() };
    const trimmed = trimSubCache(cache);
    try {
      localStorage.setItem(SUB_CACHE_KEY, JSON.stringify(trimmed));
    } catch {
      // Quota even after the trim — keep only the entry we just wrote so the
      // most recent folder at least caches.
      try {
        const key = normCachePath(path);
        localStorage.setItem(SUB_CACHE_KEY, JSON.stringify({ [key]: trimmed[key] }));
      } catch { /* give up — a missing cache entry just means a re-scan */ }
    }
  } catch { /* unreadable/parse — ignore */ }
}

/**
 * Forget the cached listing for one folder, so the next read re-walks it.
 *
 * Needed by every "re-scan this folder" affordance: dropping in-component
 * state isn't enough on its own, because the next lookup would just restore
 * the same stale entry from localStorage.
 */
export function invalidateSubCache(path: string) {
  try {
    const raw = localStorage.getItem(SUB_CACHE_KEY);
    if (!raw) return;
    const cache = JSON.parse(raw);
    delete cache[normCachePath(path)];
    delete cache[path]; // pre-normalisation key, if one is still around
    localStorage.setItem(SUB_CACHE_KEY, JSON.stringify(cache));
  } catch { /* unreadable/quota — a stale entry is better than throwing */ }
}

/** Apply cached folder sizes onto a full shallow listing (never drops items). */
export function mergeCachedSizes(
  entries: DrillContentEntry[],
  folderPath: string,
): DrillContentEntry[] {
  const cached = getSubCache(folderPath);
  if (!cached) return entries;
  const sizeByPath = new Map(
    cached.folders.map((f) => [
      normCachePath(f.path),
      { size: f.size_bytes, fileCount: f.file_count },
    ]),
  );
  return entries.map((e) => {
    if (e.kind !== "folder" || e.sizeKnown) return e;
    const hit = sizeByPath.get(normCachePath(e.path));
    if (!hit) return e;
    return {
      ...e,
      size: hit.size,
      fileCount: hit.fileCount,
      sizeKnown: true,
    };
  });
}

export function cacheToContentEntries(cached: SubFolderCacheEntry): DrillContentEntry[] {
  const entries: DrillContentEntry[] = [];
  for (const f of cached.folders) {
    entries.push({
      kind: "folder",
      name: f.display_name || basename(f.path),
      path: f.path,
      size: f.size_bytes,
      fileCount: f.file_count,
      sizeKnown: true,
    });
  }
  for (const f of cached.files) {
    entries.push({
      kind: "file",
      name: f.name || basename(f.path),
      path: f.path,
      size: f.size_bytes,
      sizeKnown: true,
    });
  }
  entries.sort((a, b) => b.size - a.size);
  return entries;
}

export function contentEntriesToCache(entries: DrillContentEntry[]): {
  folders: StorageFolderInfo[];
  files: FoundFile[];
} {
  const folders: StorageFolderInfo[] = [];
  const files: FoundFile[] = [];
  for (const e of entries) {
    if (e.kind === "folder" && e.sizeKnown) {
      folders.push({
        path: e.path,
        display_name: e.name,
        size_bytes: e.size,
        file_count: e.fileCount ?? 0,
      });
    } else if (e.kind === "file") {
      files.push({
        path: e.path,
        name: e.name,
        size_bytes: e.size,
        modified_ts: 0,
      });
    }
  }
  return { folders, files };
}

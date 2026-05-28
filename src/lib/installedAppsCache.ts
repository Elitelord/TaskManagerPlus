/**
 * Installed-apps size cache (Phase B of the Total App Storage Sizing plan).
 *
 * The Storage page's fast `get_installed_apps` returns the registry-estimate
 * sizes immediately; the deep `measure_installed_app_storage` walks install
 * dirs + AppData folders to produce true totals. That deep measure takes
 * tens of seconds, so we persist the measured rows in localStorage and merge
 * them into the fast list on the next render — opening the Storage page
 * again surfaces the totals without re-scanning.
 *
 * Cache key is `name|version|install_location` (case-insensitive). Versions
 * change on app upgrade and invalidate naturally; install_location handles
 * apps the user reinstalled to a different drive.
 */

import type { InstalledAppInfo, SizeSource } from "./types";

/** How long a cached measured row is considered fresh. Anything older
 *  triggers a background re-measure on next open. 24h matches the plan. */
export const APP_SIZE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export const APP_SIZE_CACHE_KEY = "taskmanagerplus-app-size-cache-v1";

interface CachedSize {
  size_bytes: number;
  install_bytes: number;
  data_bytes: number;
  size_source: SizeSource;
  ts: number;
}

interface CacheFile {
  version: 1;
  entries: Record<string, CachedSize>;
}

/** Build the stable lookup key for an app row. Lower-cased so trivial
 *  registry casing differences don't fragment the cache. */
export function appCacheKey(app: Pick<InstalledAppInfo, "name" | "version" | "install_location">): string {
  return [
    (app.name ?? "").trim().toLowerCase(),
    (app.version ?? "").trim().toLowerCase(),
    (app.install_location ?? "").trim().toLowerCase(),
  ].join("|");
}

function emptyCache(): CacheFile {
  return { version: 1, entries: {} };
}

/** Load + validate the cache. Returns an empty cache on any parse error so
 *  one bad row doesn't poison every future read. */
export function loadAppSizeCache(): CacheFile {
  try {
    const raw = localStorage.getItem(APP_SIZE_CACHE_KEY);
    if (!raw) return emptyCache();
    const parsed = JSON.parse(raw) as CacheFile | null;
    if (parsed && parsed.version === 1 && parsed.entries) return parsed;
  } catch {
    /* corrupt cache — fall through */
  }
  return emptyCache();
}

function persist(cache: CacheFile) {
  try { localStorage.setItem(APP_SIZE_CACHE_KEY, JSON.stringify(cache)); }
  catch { /* quota — best-effort */ }
}

/** Write the measured rows into the cache. Only rows with a `size_source`
 *  more informative than `registry`/`unknown` are persisted — caching the
 *  fast-path estimate would defeat the purpose. */
export function saveMeasuredApps(apps: InstalledAppInfo[]): void {
  const cache = loadAppSizeCache();
  const now = Date.now();
  for (const a of apps) {
    if (a.size_source !== "measured_install"
        && a.size_source !== "measured_total"
        && a.size_source !== "partial") {
      continue;
    }
    cache.entries[appCacheKey(a)] = {
      size_bytes: a.size_bytes,
      install_bytes: a.install_bytes,
      data_bytes: a.data_bytes,
      size_source: a.size_source,
      ts: now,
    };
  }
  persist(cache);
}

/** Drop entries older than `ttlMs`. Returns the count removed. Called
 *  lazily — we don't run a timer; merge + save cycles trim naturally. */
export function pruneAppSizeCache(ttlMs: number = APP_SIZE_CACHE_TTL_MS): number {
  const cache = loadAppSizeCache();
  const cutoff = Date.now() - ttlMs;
  let removed = 0;
  for (const k of Object.keys(cache.entries)) {
    if (cache.entries[k].ts < cutoff) {
      delete cache.entries[k];
      removed++;
    }
  }
  if (removed > 0) persist(cache);
  return removed;
}

/** Merge fresh cached sizes into a fast-path list. Cache wins when its
 *  `size_source` is more informative than the fast row's (e.g. cached
 *  `measured_total` always beats fast `registry`). Stale entries (older
 *  than `ttlMs`) are ignored so users see the freshest registry value. */
export function mergeCachedSizes(
  apps: InstalledAppInfo[],
  ttlMs: number = APP_SIZE_CACHE_TTL_MS,
): InstalledAppInfo[] {
  const cache = loadAppSizeCache();
  const cutoff = Date.now() - ttlMs;

  const sourceRank: Record<SizeSource, number> = {
    unknown: 0,
    registry: 1,
    partial: 2,
    measured_install: 3,
    measured_total: 4,
  };

  return apps.map((a) => {
    const hit = cache.entries[appCacheKey(a)];
    if (!hit || hit.ts < cutoff) return a;
    if (sourceRank[hit.size_source] <= sourceRank[a.size_source]) return a;
    return {
      ...a,
      size_bytes: hit.size_bytes,
      install_bytes: hit.install_bytes,
      data_bytes: hit.data_bytes,
      size_source: hit.size_source,
    };
  });
}

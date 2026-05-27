// Tiny persistent cache for generative AI results (file/folder summaries and
// name suggestions). Generation is the expensive part (~1s per call on CPU),
// so we memoise results to localStorage keyed by path — a file/folder is
// summarised at most once across sessions, not once per panel open.
//
// Keyed by path only (not path+mtime): a stale one-line summary after a file
// edit is low-stakes for a browser hint, and avoids a per-open stat IPC. A
// rename changes the path, so the new name naturally misses + regenerates.
// Bounded with a simple LRU eviction by last-write time.

const STORAGE_KEY = "tmp.aiResultCache.v1";
const MAX_ENTRIES = 400;

interface Entry {
  v: string | string[];
  /** last-access epoch ms — for LRU eviction. */
  t: number;
}
type Store = Record<string, Entry>;

let mem: Store | null = null;

function load(): Store {
  if (mem) return mem;
  try {
    if (typeof localStorage === "undefined") return (mem = {});
    const raw = localStorage.getItem(STORAGE_KEY);
    mem = raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    mem = {};
  }
  return mem;
}

function persist(s: Store) {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    }
  } catch {
    /* quota / unavailable — the in-memory copy still serves this session. */
  }
}

/** Look up a cached result. Touches the entry's access time (LRU). */
export function getCachedResult<T extends string | string[]>(key: string): T | undefined {
  const s = load();
  const e = s[key];
  if (!e) return undefined;
  e.t = Date.now();
  return e.v as T;
}

/** Store a result, evicting the least-recently-used entries past the cap. */
export function setCachedResult(key: string, value: string | string[]): void {
  const s = load();
  s[key] = { v: value, t: Date.now() };
  const keys = Object.keys(s);
  if (keys.length > MAX_ENTRIES) {
    keys
      .sort((a, b) => s[a].t - s[b].t)
      .slice(0, keys.length - MAX_ENTRIES)
      .forEach((k) => delete s[k]);
  }
  persist(s);
}

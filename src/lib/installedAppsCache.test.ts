import { describe, it, expect, beforeEach } from "vitest";
import type { InstalledAppInfo, SizeSource } from "./types";
import {
  appCacheKey,
  loadAppSizeCache,
  mergeCachedSizes,
  pruneAppSizeCache,
  saveMeasuredApps,
  APP_SIZE_CACHE_KEY,
  APP_SIZE_CACHE_TTL_MS,
} from "./installedAppsCache";

// The cache lives in localStorage, which isn't present in the vitest
// `node` environment. Stub it per-test so each case starts with a clean
// store. Matches the contract the production code actually uses.
beforeEach(() => {
  const store: Record<string, string> = {};
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    get length() { return Object.keys(store).length; },
    key: (i: number) => Object.keys(store)[i] ?? null,
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
  } as Storage;
});

const GB = 1024 ** 3;

function app(
  name: string,
  version: string,
  install_location: string,
  size_bytes: number,
  size_source: SizeSource = "registry",
  install_bytes = size_bytes,
  data_bytes = 0,
): InstalledAppInfo {
  return {
    name, publisher: "ACME", version, install_date: "",
    size_bytes, install_location,
    install_bytes, data_bytes, size_source,
  };
}

describe("appCacheKey", () => {
  it("is case-insensitive and trim-tolerant", () => {
    expect(appCacheKey({ name: "Chrome", version: "1.0", install_location: "C:\\Foo" }))
      .toBe(appCacheKey({ name: "  chrome ", version: "1.0", install_location: "c:\\foo" }));
  });

  it("treats different versions as distinct rows", () => {
    expect(appCacheKey({ name: "Chrome", version: "1.0", install_location: "" }))
      .not.toBe(appCacheKey({ name: "Chrome", version: "2.0", install_location: "" }));
  });
});

describe("saveMeasuredApps + mergeCachedSizes", () => {
  it("persists only measured rows, not registry estimates", () => {
    const inputs = [
      app("A", "1", "C:\\A", 1 * GB, "registry"),
      app("B", "1", "C:\\B", 2 * GB, "measured_install", 2 * GB, 0),
      app("C", "1", "C:\\C", 3 * GB, "measured_total", 2 * GB, 1 * GB),
      app("D", "1", "C:\\D", 4 * GB, "partial"),
      app("E", "1", "C:\\E", 0, "unknown"),
    ];
    saveMeasuredApps(inputs);
    const cache = loadAppSizeCache();
    const keys = Object.keys(cache.entries);
    // A (registry) and E (unknown) are not worth persisting — the fast
    // path produces them on every load anyway.
    expect(keys).toHaveLength(3);
    expect(cache.entries[appCacheKey(inputs[1])].size_source).toBe("measured_install");
    expect(cache.entries[appCacheKey(inputs[2])].size_source).toBe("measured_total");
    expect(cache.entries[appCacheKey(inputs[3])].size_source).toBe("partial");
  });

  it("merges cached measured sizes back into a fast-path list", () => {
    const measured = app("Chrome", "120.0", "C:\\Chrome", 50 * GB, "measured_total", 5 * GB, 45 * GB);
    saveMeasuredApps([measured]);

    const fastList = [
      app("Chrome", "120.0", "C:\\Chrome", 5 * GB, "registry"),
      app("Other", "1.0", "C:\\Other", 1 * GB, "registry"),
    ];
    const merged = mergeCachedSizes(fastList);

    expect(merged[0].size_bytes).toBe(50 * GB);
    expect(merged[0].size_source).toBe("measured_total");
    expect(merged[0].data_bytes).toBe(45 * GB);
    // Untouched — no cache hit.
    expect(merged[1].size_bytes).toBe(1 * GB);
    expect(merged[1].size_source).toBe("registry");
  });

  it("does not downgrade a fresher fast-path measurement with a stale cached one", () => {
    const stale = app("Foo", "1", "C:\\Foo", 5 * GB, "measured_install", 5 * GB, 0);
    saveMeasuredApps([stale]);

    // Fast path already came back with a `measured_total` — cache must yield.
    const fresher = app("Foo", "1", "C:\\Foo", 10 * GB, "measured_total", 5 * GB, 5 * GB);
    const merged = mergeCachedSizes([fresher]);
    expect(merged[0].size_bytes).toBe(10 * GB);
    expect(merged[0].size_source).toBe("measured_total");
  });

  it("ignores cache entries older than the TTL", () => {
    saveMeasuredApps([app("Old", "1", "C:\\Old", 9 * GB, "measured_total", 4 * GB, 5 * GB)]);
    // Hand-roll an aged timestamp.
    const raw = localStorage.getItem(APP_SIZE_CACHE_KEY)!;
    const parsed = JSON.parse(raw);
    const key = appCacheKey({ name: "Old", version: "1", install_location: "C:\\Old" });
    parsed.entries[key].ts = Date.now() - APP_SIZE_CACHE_TTL_MS - 1000;
    localStorage.setItem(APP_SIZE_CACHE_KEY, JSON.stringify(parsed));

    const merged = mergeCachedSizes([
      app("Old", "1", "C:\\Old", 1 * GB, "registry"),
    ]);
    expect(merged[0].size_source).toBe("registry");
  });

  it("pruneAppSizeCache drops only expired entries", () => {
    saveMeasuredApps([
      app("Fresh", "1", "C:\\Fresh", 1 * GB, "measured_total"),
      app("Old", "1", "C:\\Old", 1 * GB, "measured_total"),
    ]);
    // Age "Old" out.
    const raw = localStorage.getItem(APP_SIZE_CACHE_KEY)!;
    const parsed = JSON.parse(raw);
    const oldKey = appCacheKey({ name: "Old", version: "1", install_location: "C:\\Old" });
    parsed.entries[oldKey].ts = Date.now() - APP_SIZE_CACHE_TTL_MS - 1;
    localStorage.setItem(APP_SIZE_CACHE_KEY, JSON.stringify(parsed));

    const removed = pruneAppSizeCache();
    expect(removed).toBe(1);
    const after = loadAppSizeCache();
    expect(Object.keys(after.entries)).toHaveLength(1);
    expect(after.entries[oldKey]).toBeUndefined();
  });

  it("tolerates corrupt localStorage payloads", () => {
    localStorage.setItem(APP_SIZE_CACHE_KEY, "{not valid json");
    const merged = mergeCachedSizes([app("X", "1", "C:\\X", 1 * GB, "registry")]);
    // Should return the input unchanged rather than throw.
    expect(merged[0].size_source).toBe("registry");
  });
});

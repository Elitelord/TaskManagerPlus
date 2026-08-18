import { describe, it, expect, beforeEach } from "vitest";
import {
  getSubCache,
  setSubCache,
  invalidateSubCache,
  mergeCachedSizes,
  cacheToContentEntries,
  DRILL_CACHE_TTL_MS,
  type DrillContentEntry,
} from "./folderDrillCache";

// The cache lives in localStorage, which isn't present in the vitest `node`
// environment. Stub it per-test so each case starts with a clean store.
beforeEach(() => {
  const store: Record<string, string> = {};
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    get length() { return Object.keys(store).length; },
    key: (i: number) => Object.keys(store)[i] ?? null,
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
  } as Storage;
});

const folder = (path: string, size: number, files = 1) => ({
  path,
  display_name: path.slice(path.lastIndexOf("\\") + 1),
  size_bytes: size,
  file_count: files,
});

describe("folderDrillCache persistence", () => {
  it("round-trips a listing so a revisit reads from cache", () => {
    setSubCache("C:\\Users\\me\\Docs", [folder("C:\\Users\\me\\Docs\\A", 500)], []);
    const hit = getSubCache("C:\\Users\\me\\Docs");
    expect(hit).not.toBeNull();
    expect(hit!.folders).toHaveLength(1);
    expect(hit!.folders[0].size_bytes).toBe(500);
  });

  it("looks up case-insensitively and ignores a trailing slash", () => {
    setSubCache("C:\\Users\\me\\Docs", [folder("C:\\Users\\me\\Docs\\A", 10)], []);
    expect(getSubCache("c:\\users\\me\\docs\\")).not.toBeNull();
  });

  it("keeps entries that are still inside the TTL", () => {
    setSubCache("C:\\Data", [folder("C:\\Data\\X", 1)], []);
    expect(getSubCache("C:\\Data")).not.toBeNull();
  });

  it("drops entries older than the TTL so sizes eventually refresh", () => {
    setSubCache("C:\\Data", [folder("C:\\Data\\X", 1)], []);
    // Rewrite the stored timestamp to just past the expiry window.
    const key = "taskmanagerplus-subfolder-cache-v2";
    const cache = JSON.parse(localStorage.getItem(key)!);
    cache["c:\\data"].ts = Date.now() - DRILL_CACHE_TTL_MS - 1;
    localStorage.setItem(key, JSON.stringify(cache));

    expect(getSubCache("C:\\Data")).toBeNull();
  });

  it("returns null for a folder that was never cached", () => {
    expect(getSubCache("C:\\Never\\Visited")).toBeNull();
  });
});

describe("invalidateSubCache", () => {
  it("forces the next read of that folder to miss", () => {
    setSubCache("C:\\P", [folder("C:\\P\\A", 1)], []);
    expect(getSubCache("C:\\P")).not.toBeNull();

    invalidateSubCache("C:\\P");

    expect(getSubCache("C:\\P")).toBeNull();
  });

  it("leaves other folders alone", () => {
    setSubCache("C:\\P", [folder("C:\\P\\A", 1)], []);
    setSubCache("C:\\Q", [folder("C:\\Q\\B", 2)], []);

    invalidateSubCache("C:\\P");

    expect(getSubCache("C:\\P")).toBeNull();
    expect(getSubCache("C:\\Q")).not.toBeNull();
  });

  it("matches the same folder written with different case or trailing slash", () => {
    setSubCache("C:\\Users\\me\\Docs", [folder("C:\\Users\\me\\Docs\\A", 1)], []);
    invalidateSubCache("c:\\users\\me\\docs\\");
    expect(getSubCache("C:\\Users\\me\\Docs")).toBeNull();
  });

  it("is a no-op for a folder that was never cached", () => {
    expect(() => invalidateSubCache("C:\\Nope")).not.toThrow();
  });
});

describe("mergeCachedSizes", () => {
  it("fills in folder sizes from cache without dropping uncached rows", () => {
    setSubCache("C:\\P", [folder("C:\\P\\Known", 900)], []);
    const listing: DrillContentEntry[] = [
      { kind: "folder", name: "Known", path: "C:\\P\\Known", size: 0, sizeKnown: false },
      { kind: "folder", name: "New", path: "C:\\P\\New", size: 0, sizeKnown: false },
      { kind: "file", name: "a.txt", path: "C:\\P\\a.txt", size: 5, sizeKnown: true },
    ];

    const merged = mergeCachedSizes(listing, "C:\\P");

    expect(merged).toHaveLength(3);
    expect(merged[0]).toMatchObject({ size: 900, sizeKnown: true });
    // A folder the cache has never seen stays pending rather than showing 0.
    expect(merged[1]).toMatchObject({ size: 0, sizeKnown: false });
  });
});

describe("cacheToContentEntries", () => {
  it("returns folders and files together, biggest first", () => {
    const entries = cacheToContentEntries({
      folders: [folder("C:\\P\\Small", 10), folder("C:\\P\\Huge", 5000)],
      files: [{ path: "C:\\P\\mid.bin", name: "mid.bin", size_bytes: 900, modified_ts: 0 }],
      ts: Date.now(),
    });

    expect(entries.map((e) => e.name)).toEqual(["Huge", "mid.bin", "Small"]);
    expect(entries.every((e) => e.sizeKnown)).toBe(true);
  });
});

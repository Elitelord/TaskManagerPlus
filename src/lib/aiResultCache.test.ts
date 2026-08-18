import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getCachedResult,
  setCachedResult,
  clearCachedResults,
  folderContentSignature,
  AI_RESULT_TTL_MS,
} from "./aiResultCache";

// The module memoises the store in-process, so editing localStorage behind its
// back doesn't affect an already-imported binding. Age is therefore exercised
// by moving the clock rather than by rewriting timestamps, and each case uses
// its own key so entries can't leak between tests.
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

const file = (name: string) => ({ kind: "file" as const, name });
const dir = (name: string) => ({ kind: "folder" as const, name });

describe("getCachedResult TTL", () => {
  it("returns a freshly written entry", () => {
    setCachedResult("fresh", "hello");
    expect(getCachedResult("fresh")).toBe("hello");
  });

  it("drops an entry past its max age", () => {
    vi.useFakeTimers();
    try {
      setCachedResult("aged", "old");
      vi.advanceTimersByTime(AI_RESULT_TTL_MS + 1);
      expect(getCachedResult("aged")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an entry that is still inside the TTL", () => {
    vi.useFakeTimers();
    try {
      setCachedResult("young", "still good");
      vi.advanceTimersByTime(AI_RESULT_TTL_MS - 1000);
      expect(getCachedResult("young")).toBe("still good");
    } finally {
      vi.useRealTimers();
    }
  });

  it("honours an explicit maxAgeMs shorter than the default", () => {
    vi.useFakeTimers();
    try {
      setCachedResult("shortlived", "v");
      vi.advanceTimersByTime(5_000);
      expect(getCachedResult("shortlived", 1_000)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("can opt out of expiry with Infinity", () => {
    vi.useFakeTimers();
    try {
      setCachedResult("forever", "v");
      vi.advanceTimersByTime(AI_RESULT_TTL_MS * 10);
      expect(getCachedResult("forever", Infinity)).toBe("v");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("clearCachedResults", () => {
  it("clears every signature variant for one folder", () => {
    // What a folder accumulates as its contents change over time.
    setCachedResult("summary:folder:C:\\P:3.abc", "three files");
    setCachedResult("summary:folder:C:\\P:9.def", "nine files");
    setCachedResult("names:folder:C:\\P:9.def", ["Photos"]);

    expect(clearCachedResults("summary:folder:C:\\P")).toBe(2);

    expect(getCachedResult("summary:folder:C:\\P:3.abc")).toBeUndefined();
    expect(getCachedResult("summary:folder:C:\\P:9.def")).toBeUndefined();
    // Different prefix — untouched.
    expect(getCachedResult("names:folder:C:\\P:9.def")).toEqual(["Photos"]);
  });

  it("does not clear a sibling folder sharing a path prefix", () => {
    setCachedResult("summary:folder:C:\\P:1.a", "kept");
    setCachedResult("summary:folder:C:\\P2:1.a", "also kept");

    clearCachedResults("summary:folder:C:\\P:");

    expect(getCachedResult("summary:folder:C:\\P:1.a")).toBeUndefined();
    expect(getCachedResult("summary:folder:C:\\P2:1.a")).toBe("also kept");
  });

  it("reports zero when nothing matches", () => {
    expect(clearCachedResults("summary:folder:C:\\Absent")).toBe(0);
  });
});

describe("folderContentSignature", () => {
  it("changes when a file is added", () => {
    const before = folderContentSignature([file("a.txt"), file("b.txt")]);
    const after = folderContentSignature([file("a.txt"), file("b.txt"), file("c.txt")]);
    expect(after).not.toBe(before);
  });

  it("changes when a file is renamed", () => {
    const before = folderContentSignature([file("draft.txt")]);
    const after = folderContentSignature([file("final.txt")]);
    expect(after).not.toBe(before);
  });

  it("is stable across listing order", () => {
    const a = folderContentSignature([file("a.txt"), file("b.txt"), file("c.txt")]);
    const b = folderContentSignature([file("c.txt"), file("a.txt"), file("b.txt")]);
    expect(a).toBe(b);
  });

  it("ignores subfolders, which never feed the summary", () => {
    const withoutDir = folderContentSignature([file("a.txt")]);
    const withDir = folderContentSignature([file("a.txt"), dir("sub")]);
    expect(withDir).toBe(withoutDir);
  });

  it("still detects add/remove past the 40-name hash cap", () => {
    const many = Array.from({ length: 60 }, (_, i) => file(`f${i}.txt`));
    const oneFewer = many.slice(0, 59);
    // The hashed sample is capped, but the count prefix is not.
    expect(folderContentSignature(oneFewer)).not.toBe(folderContentSignature(many));
  });

  it("treats an empty folder as its own signature", () => {
    expect(folderContentSignature([])).toBe(folderContentSignature([]));
    expect(folderContentSignature([])).not.toBe(folderContentSignature([file("a")]));
  });
});

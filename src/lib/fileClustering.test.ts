import { describe, it, expect } from "vitest";
import {
  clusterEmbeddings,
  isDocumentFile,
  type FileEmbedding,
} from "./fileClustering";

/** L2-normalise. */
function nrm(v: number[]): number[] {
  const m = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / m);
}

/** An embedding dominated by basis dim `d`, with a tiny per-member wobble
 *  `k` so members of a group are distinct but very close. Groups built on
 *  non-adjacent dims are near-orthogonal — i.e. unrelated. */
function near(id: string, d: number, k: number): FileEmbedding {
  const v = [0, 0, 0, 0, 0, 0];
  v[d] = 1;
  v[(d + 1) % 6] = 0.03 * (k + 1);
  return { id, vec: nrm(v) };
}

describe("clusterEmbeddings", () => {
  it("handles empty and single-item input", () => {
    expect(clusterEmbeddings([])).toEqual([]);
    expect(clusterEmbeddings([near("a", 0, 0)])).toEqual([]);
  });

  it("groups well-separated files into distinct clusters", () => {
    const items = [
      near("a1", 0, 0), near("a2", 0, 1), near("a3", 0, 2),
      near("b1", 2, 0), near("b2", 2, 1), near("b3", 2, 2),
    ];
    const clusters = clusterEmbeddings(items);
    expect(clusters).toHaveLength(2);
    expect(clusters[0].ids).toHaveLength(3);
    // Each cluster is wholly "a*" or wholly "b*" — no cross-contamination.
    for (const c of clusters) {
      expect(new Set(c.ids.map((id) => id[0])).size).toBe(1);
    }
  });

  it("returns no clusters when every file stands alone", () => {
    // Dims 0, 2, 4 are mutually near-orthogonal — unrelated files.
    const items = [near("x", 0, 0), near("y", 2, 0), near("z", 4, 0)];
    expect(clusterEmbeddings(items)).toEqual([]);
  });

  it("reports a high cohesion for a genuinely tight cluster", () => {
    const c = clusterEmbeddings([
      near("a1", 0, 0), near("a2", 0, 1), near("a3", 0, 2),
    ]);
    expect(c).toHaveLength(1);
    expect(c[0].cohesion).toBeGreaterThan(0.9);
  });

  it("respects minSize", () => {
    const pair = [near("a1", 0, 0), near("a2", 0, 1)];
    expect(clusterEmbeddings(pair)).toHaveLength(1);
    expect(clusterEmbeddings(pair, { minSize: 3 })).toEqual([]);
  });

  it("the cohesion floor drops a cluster whose members aren't tight enough", () => {
    const items = [near("a1", 0, 0), near("a2", 0, 1), near("a3", 0, 2)];
    // The cluster forms, but demanding near-perfect cohesion rejects it...
    expect(clusterEmbeddings(items, { minCohesion: 0.999999 })).toEqual([]);
    // ...while a floor of 0 keeps it.
    expect(clusterEmbeddings(items, { minCohesion: 0 })).toHaveLength(1);
  });

  it("respects the maxFiles cap", () => {
    const items = [
      near("a1", 0, 0), near("a2", 0, 1), near("a3", 0, 2), near("a4", 0, 3),
    ];
    const c = clusterEmbeddings(items, { maxFiles: 2 });
    expect(c).toHaveLength(1);
    expect(c[0].ids).toHaveLength(2);
  });

  it("is deterministic", () => {
    const items = [
      near("a1", 0, 0), near("a2", 0, 1),
      near("b1", 3, 0), near("b2", 3, 1),
    ];
    expect(clusterEmbeddings(items)).toEqual(clusterEmbeddings(items));
  });
});

describe("isDocumentFile", () => {
  it("accepts documents and code", () => {
    for (const f of [
      "report.pdf", "notes.docx", "thesis.tex", "main.py", "app.ts",
      "slides.pptx", "README.md",
    ]) {
      expect(isDocumentFile(f), f).toBe(true);
    }
  });

  it("rejects installers, archives, media and raw data", () => {
    for (const f of [
      "setup.exe", "data.zip", "photo.jpg", "clip.mp4", "map.geojson",
      "sheet.xlsx", "song.mp3",
    ]) {
      expect(isDocumentFile(f), f).toBe(false);
    }
  });

  it("rejects a file with no extension", () => {
    expect(isDocumentFile("Makefile")).toBe(false);
  });
});

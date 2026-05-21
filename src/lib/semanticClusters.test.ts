import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted holder for the `tryEmbedFiles` mock — the embedder boundary.
const h = vi.hoisted(() => ({ embed: vi.fn() }));
vi.mock("./ai/tierGate", () => ({ tryEmbedFiles: h.embed }));

import {
  analyzeSemanticDocuments,
  detectSemanticClusters,
  deriveFolderName,
} from "./semanticClusters";

beforeEach(() => h.embed.mockReset());

/** Build a normalised vector dominated by basis dim `d`, with a tiny
 *  per-member wobble — same recipe as fileClustering.test.ts. */
function vec(d: number, k: number): number[] {
  const v = [0, 0, 0, 0, 0, 0];
  v[d] = 1;
  v[(d + 1) % 6] = 0.03 * (k + 1);
  const m = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / m);
}

describe("detectSemanticClusters", () => {
  it("returns [] without calling the embedder when too few document files", async () => {
    const findings = await detectSemanticClusters([
      { path: "a.pdf" }, { path: "b.pdf" }, { path: "c.pdf" },
    ]);
    expect(findings).toEqual([]);
    expect(h.embed).not.toHaveBeenCalled();
  });

  it("returns [] when the embedder declines (tier off / model missing)", async () => {
    h.embed.mockResolvedValueOnce(null);
    const findings = await detectSemanticClusters([
      { path: "a.pdf" }, { path: "b.pdf" }, { path: "c.pdf" }, { path: "d.pdf" },
    ]);
    expect(findings).toEqual([]);
  });

  it("filters non-document files out before embedding", async () => {
    h.embed.mockResolvedValueOnce([vec(0, 0), vec(0, 1), vec(0, 2), vec(0, 3)]);
    await detectSemanticClusters([
      { path: "a.pdf" }, { path: "b.docx" }, { path: "c.py" }, { path: "d.md" },
      { path: "installer.exe" }, { path: "movie.mp4" }, { path: "archive.zip" },
      { path: "data.geojson" }, { path: "sheet.xlsx" },
    ]);
    expect(h.embed).toHaveBeenCalledTimes(1);
    const arg = h.embed.mock.calls[0][0] as string[];
    expect(arg).toEqual(["a.pdf", "b.docx", "c.py", "d.md"]);
  });

  it("surfaces one SubfolderSuggestion per cluster with the expected shape", async () => {
    h.embed.mockResolvedValueOnce([vec(0, 0), vec(0, 1), vec(0, 2), vec(0, 3)]);
    const suggestions = await detectSemanticClusters([
      { path: "C:\\proj\\alpha-report.pdf" },
      { path: "C:\\proj\\alpha-summary.pdf" },
      { path: "C:\\proj\\alpha-notes.pdf" },
      { path: "C:\\proj\\alpha-appendix.pdf" },
    ]);
    expect(suggestions).toHaveLength(1);
    const s = suggestions[0];
    expect(s.id).toBe("semantic-cluster-0");
    expect(s.parentPath).toBe("C:\\proj");
    expect(s.relatedItems).toHaveLength(4);
    expect(s.relatedItems.every((it) => it.path?.endsWith(".pdf"))).toBe(true);
    // Folder name derived from the recurring "alpha" token.
    expect(s.suggestedName).toBe("Alpha");
    expect(s.reason).toMatch(/4 files/);
  });

  it("separates two unrelated groups into two suggestions", async () => {
    h.embed.mockResolvedValueOnce([
      vec(0, 0), vec(0, 1), vec(0, 2),
      vec(3, 0), vec(3, 1), vec(3, 2),
    ]);
    const suggestions = await detectSemanticClusters([
      { path: "C:\\a\\beta-1.pdf" }, { path: "C:\\a\\beta-2.pdf" }, { path: "C:\\a\\beta-3.pdf" },
      { path: "C:\\b\\gamma-1.pdf" }, { path: "C:\\b\\gamma-2.pdf" }, { path: "C:\\b\\gamma-3.pdf" },
    ]);
    expect(suggestions).toHaveLength(2);
    // Each suggestion sticks to one folder.
    for (const s of suggestions) {
      const folders = new Set(s.relatedItems.map((it) => it.path?.split("\\")[1]));
      expect(folders.size).toBe(1);
    }
  });

  it("falls back to 'Untitled project N' when no token recurs", async () => {
    h.embed.mockResolvedValueOnce([vec(0, 0), vec(0, 1), vec(0, 2), vec(0, 3)]);
    const suggestions = await detectSemanticClusters([
      { path: "C:\\x\\alpha.pdf" },
      { path: "C:\\x\\beta.pdf" },
      { path: "C:\\x\\gamma.pdf" },
      { path: "C:\\x\\delta.pdf" },
    ]);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].suggestedName).toBe("Untitled project 1");
  });

  it("returns [] when the embedder hands back the wrong number of vectors", async () => {
    h.embed.mockResolvedValueOnce([vec(0, 0), vec(0, 1)]); // 2 vecs for 4 files
    const findings = await detectSemanticClusters([
      { path: "a.pdf" }, { path: "b.pdf" }, { path: "c.pdf" }, { path: "d.pdf" },
    ]);
    expect(findings).toEqual([]);
  });
});

describe("analyzeSemanticDocuments — S5 near-duplicates", () => {
  /** Build a vector along basis dim `d`, with optional per-call wobble to
   *  produce identical-ish pairs (small wobble = near-dup). */
  function nearDup(d: number, wobble: number): number[] {
    const v = [0, 0, 0, 0, 0, 0];
    v[d] = 1;
    v[(d + 1) % 6] = wobble;
    const m = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / m);
  }

  it("surfaces a pair of essentially identical vectors as a duplicate finding", async () => {
    // Two near-identical vectors (wobble 0.001) — cosine should be > 0.99.
    h.embed.mockResolvedValueOnce([
      nearDup(0, 0.001),
      nearDup(0, 0.001),
      nearDup(3, 0.5),    // unrelated
      nearDup(4, 0.5),    // unrelated
    ]);
    const { duplicates } = await analyzeSemanticDocuments([
      { path: "C:\\a\\scan.pdf" },
      { path: "C:\\a\\scan-copy.pdf" },
      { path: "C:\\a\\other1.pdf" },
      { path: "C:\\a\\other2.pdf" },
    ]);
    expect(duplicates).toHaveLength(1);
    const d = duplicates[0];
    expect(d.severity).toBe("warning");
    expect(d.items).toHaveLength(2);
    expect(d.tags).toContain("duplicate");
    expect(d.title).toMatch(/2 near-duplicate/);
  });

  it("merges transitive near-dup pairs into one group (A~B, B~C → {A,B,C})", async () => {
    h.embed.mockResolvedValueOnce([
      nearDup(0, 0.001),
      nearDup(0, 0.001),
      nearDup(0, 0.001),
      nearDup(3, 0.5),
    ]);
    const { duplicates } = await analyzeSemanticDocuments([
      { path: "C:\\x\\a.pdf" },
      { path: "C:\\x\\b.pdf" },
      { path: "C:\\x\\c.pdf" },
      { path: "C:\\x\\unrelated.pdf" },
    ]);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].items).toHaveLength(3);
  });

  it("returns no duplicates when no pair clears the threshold", async () => {
    // All vectors moderately apart — cohesion well below 0.95.
    h.embed.mockResolvedValueOnce([
      nearDup(0, 0.3),
      nearDup(1, 0.3),
      nearDup(2, 0.3),
      nearDup(3, 0.3),
    ]);
    const { duplicates } = await analyzeSemanticDocuments([
      { path: "C:\\y\\a.pdf" }, { path: "C:\\y\\b.pdf" },
      { path: "C:\\y\\c.pdf" }, { path: "C:\\y\\d.pdf" },
    ]);
    expect(duplicates).toHaveLength(0);
  });
});

describe("deriveFolderName", () => {
  it("picks the most frequent meaningful token", () => {
    expect(
      deriveFolderName([
        "PUF-Based_Authentication.pdf",
        "PUF-Edge_Computing.pdf",
        "PUF_Security_Analysis.pdf",
        "Edge_Survey.pdf",
      ]),
    ).toMatch(/Puf/);
  });

  it("filters stopwords and short tokens", () => {
    expect(
      deriveFolderName([
        "the-a-of-doc1.pdf",
        "the-a-of-doc2.pdf",
        "the-a-of-doc3.pdf",
      ]),
    ).toBe("");
  });

  it("returns '' when no token appears in ≥ 2 files", () => {
    expect(
      deriveFolderName(["alpha.pdf", "beta.pdf", "gamma.pdf", "delta.pdf"]),
    ).toBe("");
  });

  it("title-cases tokens", () => {
    expect(deriveFolderName(["proj-alpha.pdf", "proj-alpha-2.pdf"]))
      .toBe("Alpha Proj");
  });

  it("rejects all-digit tokens (years, IDs)", () => {
    expect(
      deriveFolderName([
        "2024-Spring-report.pdf",
        "2024-Spring-notes.pdf",
        "2024-Spring-final.pdf",
      ]),
    ).toMatch(/Report|Notes|^$/);
  });
});

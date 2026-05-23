import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted holder for the `tryEmbedFiles` mock — the embedder boundary.
const h = vi.hoisted(() => ({ embed: vi.fn() }));
vi.mock("./ai/tierGate", () => ({ tryEmbedFiles: h.embed }));

import {
  analyzeSemanticDocuments,
  detectSemanticClusters,
  deriveFolderName,
  deriveDiscoveredTags,
} from "./semanticClusters";
import { resetUserVocabulary } from "./userVocabulary";

beforeEach(() => {
  h.embed.mockReset();
  resetUserVocabulary();
});

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

  it("embeds the broad INDEXABLE set (docs + structured data), excludes media/installers", async () => {
    // Phase 4: indexing scope is broader than clustering scope. geojson
    // and xlsx ARE indexable (searchable / taggable) even though they're
    // not clustered; installers / media / archives are excluded entirely.
    // Document files sort first within the candidate cap.
    h.embed.mockResolvedValueOnce([
      vec(0, 0), vec(0, 1), vec(0, 2), vec(0, 3), vec(0, 4), vec(0, 5),
    ]);
    await detectSemanticClusters([
      { path: "a.pdf" }, { path: "b.docx" }, { path: "c.py" }, { path: "d.md" },
      { path: "installer.exe" }, { path: "movie.mp4" }, { path: "archive.zip" },
      { path: "data.geojson" }, { path: "sheet.xlsx" },
    ]);
    expect(h.embed).toHaveBeenCalledTimes(1);
    const arg = h.embed.mock.calls[0][0] as string[];
    // Documents first (a.pdf, b.docx, c.py, d.md), then the data files
    // (geojson, xlsx). Installers / media / archives never appear.
    expect(arg).toContain("a.pdf");
    expect(arg).toContain("data.geojson");
    expect(arg).toContain("sheet.xlsx");
    expect(arg).not.toContain("installer.exe");
    expect(arg).not.toContain("movie.mp4");
    expect(arg).not.toContain("archive.zip");
    expect(arg).toHaveLength(6);
    // Document-type files sort ahead of data files in the candidate list.
    expect(arg.slice(0, 4).sort()).toEqual(["a.pdf", "b.docx", "c.py", "d.md"]);
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
    expect(d.tags).toContain("duplicates");
    expect(d.title).toMatch(/2 files look like copies/);
  });

  it("merges transitive near-dup pairs into one group (A~B, B~C → {A,B,C})", async () => {
    // Same-named copies in different folders so the filename gate passes;
    // the transitive union should still merge them into one group.
    h.embed.mockResolvedValueOnce([
      nearDup(0, 0.001),
      nearDup(0, 0.001),
      nearDup(0, 0.001),
      nearDup(3, 0.5),
    ]);
    const { duplicates } = await analyzeSemanticDocuments([
      { path: "C:\\x\\report.pdf" },
      { path: "C:\\y\\report.pdf" },
      { path: "C:\\z\\report (1).pdf" },
      { path: "C:\\x\\unrelated.pdf" },
    ]);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].items).toHaveLength(3);
  });

  it("does NOT group content-similar files with dissimilar names (filename gate)", async () => {
    // Three near-identical vectors but distinct filenames — e.g. different
    // lectures of the same course, or different schools' application files.
    // Content cosine is high, but they're distinct documents: no dup group.
    h.embed.mockResolvedValueOnce([
      nearDup(0, 0.001),
      nearDup(0, 0.001),
      nearDup(0, 0.001),
      nearDup(3, 0.5),
    ]);
    const { duplicates } = await analyzeSemanticDocuments([
      { path: "C:\\c\\Lecture12_M362K.pdf" },
      { path: "C:\\c\\Lecture32_M362K.pdf" },
      { path: "C:\\c\\Lecture27_M362K.pdf" },
      { path: "C:\\c\\unrelated.pdf" },
    ]);
    expect(duplicates).toHaveLength(0);
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

describe("analyzeSemanticDocuments — S12 recent digest", () => {
  /** Build a vector dominated by basis dim `d` with a small per-file wobble. */
  function vec(d: number, k: number): number[] {
    const v = [0, 0, 0, 0, 0, 0];
    v[d] = 1;
    v[(d + 1) % 6] = 0.03 * (k + 1);
    const m = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / m);
  }

  const NOW_SEC = Math.floor(Date.now() / 1000);
  const WITHIN_WINDOW = NOW_SEC - 2 * 86400;        // 2 days ago
  const OUTSIDE_WINDOW = NOW_SEC - 14 * 86400;       // 14 days ago

  it("returns empty digest when no file is recent enough", async () => {
    h.embed.mockResolvedValueOnce([
      vec(0, 0), vec(0, 1), vec(0, 2), vec(0, 3),
    ]);
    const { recentDigest } = await analyzeSemanticDocuments([
      { path: "C:\\old\\a.pdf", modified_ts: OUTSIDE_WINDOW },
      { path: "C:\\old\\b.pdf", modified_ts: OUTSIDE_WINDOW },
      { path: "C:\\old\\c.pdf", modified_ts: OUTSIDE_WINDOW },
      { path: "C:\\old\\d.pdf", modified_ts: OUTSIDE_WINDOW },
    ]);
    expect(recentDigest).toEqual([]);
  });

  it("returns empty digest when modified_ts is absent on every file", async () => {
    h.embed.mockResolvedValueOnce([
      vec(0, 0), vec(0, 1), vec(0, 2), vec(0, 3),
    ]);
    const { recentDigest } = await analyzeSemanticDocuments([
      { path: "C:\\x\\a.pdf" },
      { path: "C:\\x\\b.pdf" },
      { path: "C:\\x\\c.pdf" },
      { path: "C:\\x\\d.pdf" },
    ]);
    expect(recentDigest).toEqual([]);
  });

  it("clusters only the recent subset, ignoring older docs", async () => {
    // 4 docs: 3 recent + 1 old. The 3 recent share a basis dim (cluster);
    // the old one shouldn't appear in the digest even though it's similar.
    h.embed.mockResolvedValueOnce([
      vec(0, 0), vec(0, 1), vec(0, 2), vec(0, 3),
    ]);
    const { recentDigest } = await analyzeSemanticDocuments([
      { path: "C:\\proj\\recent-1.pdf", modified_ts: WITHIN_WINDOW },
      { path: "C:\\proj\\recent-2.pdf", modified_ts: WITHIN_WINDOW },
      { path: "C:\\proj\\recent-3.pdf", modified_ts: WITHIN_WINDOW },
      { path: "C:\\proj\\ancient.pdf",  modified_ts: OUTSIDE_WINDOW },
    ]);
    expect(recentDigest).toHaveLength(1);
    expect(recentDigest[0].files).toHaveLength(3);
    expect(recentDigest[0].files.every((f) => !f.label.includes("ancient"))).toBe(true);
  });

  it("sorts files within a group by mtime descending (most recent first)", async () => {
    h.embed.mockResolvedValueOnce([
      vec(0, 0), vec(0, 1), vec(0, 2), vec(0, 3),
    ]);
    const { recentDigest } = await analyzeSemanticDocuments([
      { path: "C:\\proj\\a.pdf", modified_ts: NOW_SEC - 5 * 86400 },
      { path: "C:\\proj\\b.pdf", modified_ts: NOW_SEC - 1 * 86400 },
      { path: "C:\\proj\\c.pdf", modified_ts: NOW_SEC - 3 * 86400 },
      { path: "C:\\proj\\d.pdf", modified_ts: NOW_SEC - 2 * 86400 },
    ]);
    expect(recentDigest).toHaveLength(1);
    const ts = recentDigest[0].files.map((f) => f.modifiedAt);
    for (let i = 1; i < ts.length; i++) {
      expect(ts[i - 1]).toBeGreaterThanOrEqual(ts[i]);
    }
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

  it("applies the per-user salience weight (feature G) to break ties", () => {
    // "alpha" and "beta" each recur in two files — a frequency tie. The
    // injected salience marks "beta" as the distinctive user term, so it
    // must be picked first.
    const files = ["alpha-beta.pdf", "alpha-beta-2.pdf"];
    const salience = (t: string) => (t === "beta" ? 2 : 1);
    expect(deriveFolderName(files, salience).split(" ")[0]).toBe("Beta");
    // Without the weight, the alphabetical tie-break puts "Alpha" first.
    expect(deriveFolderName(files).split(" ")[0]).toBe("Alpha");
  });
});

describe("deriveDiscoveredTags (adaptive category chips)", () => {
  const cluster = (ids: string[]) => ({ ids, cohesion: 0.8 });

  it("turns a distinctive cluster into a content-derived tag", () => {
    const tags = deriveDiscoveredTags([
      cluster(["C:/d/puf-study.pdf", "C:/d/puf-notes.pdf", "C:/d/puf-analysis.pdf"]),
    ]);
    expect(tags).toHaveLength(1);
    expect(tags[0].id).toBe("discovered-puf");
    expect(tags[0].label).toBe("Puf");
    expect(tags[0].query).toContain("puf");
  });

  it("skips clusters that collide with a curated preset label", () => {
    // "code" recurs in all three → label "Code", which is a preset → skipped.
    const tags = deriveDiscoveredTags([
      cluster(["C:/d/code-a.py", "C:/d/code-b.py", "C:/d/code-c.py"]),
    ]);
    expect(tags).toHaveLength(0);
  });

  it("ignores clusters below the minimum file count", () => {
    expect(deriveDiscoveredTags([cluster(["C:/d/puf-1.pdf", "C:/d/puf-2.pdf"])]))
      .toHaveLength(0);
  });

  it("dedupes clusters sharing a leading token", () => {
    const tags = deriveDiscoveredTags([
      cluster(["C:/d/thesis-a.pdf", "C:/d/thesis-b.pdf", "C:/d/thesis-c.pdf"]),
      cluster(["C:/e/thesis-x.pdf", "C:/e/thesis-y.pdf", "C:/e/thesis-z.pdf"]),
    ]);
    expect(tags).toHaveLength(1);
  });

});

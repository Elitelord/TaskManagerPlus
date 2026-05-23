import { describe, it, expect, beforeEach } from "vitest";
import {
  learnUserVocabulary,
  getTokenSalience,
  resetUserVocabulary,
  vocabularyTokens,
} from "./userVocabulary";

describe("userVocabulary (feature G)", () => {
  beforeEach(() => resetUserVocabulary());

  it("returns a neutral weight when nothing has been learned", () => {
    expect(getTokenSalience("anything")).toBe(1);
  });

  it("returns a neutral weight until the library is big enough", () => {
    learnUserVocabulary(["puf-study.pdf", "puf-notes.pdf"]); // n=2 < MIN_LIBRARY
    expect(getTokenSalience("puf")).toBe(1);
  });

  it("boosts a distinctive term above a near-ubiquitous one", () => {
    // A 10-file library: "report" is in every file (generic), "puf" in only
    // two (distinctive). The distinctive term must score strictly higher.
    const files = [
      "report-puf-2024.pdf",
      "report-puf-draft.pdf",
      "report-budget.pdf",
      "report-sales.pdf",
      "report-q1.pdf",
      "report-q2.pdf",
      "report-q3.pdf",
      "report-q4.pdf",
      "report-summary.pdf",
      "report-final.pdf",
    ];
    learnUserVocabulary(files);
    const puf = getTokenSalience("puf");
    const report = getTokenSalience("report");
    expect(puf).toBeGreaterThan(report);
    // The ubiquitous term collapses to the neutral floor.
    expect(report).toBeCloseTo(1, 5);
  });

  it("clamps salience to the documented ceiling", () => {
    const files = Array.from({ length: 20 }, (_, i) => `doc-${i}.pdf`);
    files[0] = "rareword-doc-0.pdf";
    learnUserVocabulary(files);
    expect(getTokenSalience("rareword")).toBeLessThanOrEqual(3);
    expect(getTokenSalience("rareword")).toBeGreaterThan(1);
  });

  it("is case-insensitive for lookups", () => {
    const files = Array.from({ length: 8 }, (_, i) => `Vector-${i}.pdf`);
    files[0] = "PUF-Vector-0.pdf";
    files[1] = "puf-vector-1.pdf";
    learnUserVocabulary(files);
    expect(getTokenSalience("PUF")).toBe(getTokenSalience("puf"));
  });

  it("relearning replaces (does not accumulate) the library", () => {
    learnUserVocabulary(Array.from({ length: 10 }, () => "alpha-file.pdf"));
    learnUserVocabulary(Array.from({ length: 10 }, (_, i) => `beta-${i}.pdf`));
    // "alpha" is gone from the new snapshot → unseen → treated as distinctive,
    // never as the now-stale ubiquitous term.
    expect(getTokenSalience("alpha")).toBeGreaterThan(1);
  });

  describe("vocabularyTokens", () => {
    it("drops extensions, stopwords, digits, and short tokens", () => {
      const t = vocabularyTokens("Final-Report-PUF-2024-v2.pdf");
      expect(t.has("puf")).toBe(true);
      expect(t.has("report")).toBe(true);  // a real content token (not a stopword)
      expect(t.has("final")).toBe(false);  // housekeeping stopword
      expect(t.has("2024")).toBe(false);   // all-digits
      expect(t.has("v2")).toBe(false);     // version marker
      expect(t.has("pdf")).toBe(false);    // extension + stopword
    });
  });
});

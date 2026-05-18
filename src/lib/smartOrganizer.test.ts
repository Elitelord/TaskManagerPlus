import { describe, it, expect } from "vitest";
import { detectNearDuplicateNames } from "./smartOrganizer";

const MB = 1024 * 1024;

/** Build a file record for the version-stack detector. */
function file(path: string, sizeMb: number, modifiedTs = 0) {
  return { path, size_bytes: sizeMb * MB, modified_ts: modifiedTs };
}

describe("detectNearDuplicateNames (S3 — version stacks)", () => {
  it("returns nothing for empty input", () => {
    expect(detectNearDuplicateNames([])).toEqual([]);
  });

  it("surfaces version stacks once 2+ groups clear the size threshold", () => {
    const findings = detectNearDuplicateNames([
      file("C:\\d\\report.docx", 15, 100),
      file("C:\\d\\report_v2.docx", 15, 200),
      file("C:\\d\\budget.xlsx", 15, 100),
      file("C:\\d\\budget_final.xlsx", 15, 200),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe("near-duplicate-names");
    // Two groups, one older 15 MB file reclaimable in each = ~30 MB.
    expect(findings[0].reclaimableBytes).toBe(30 * MB);
  });

  it("picks the most recently modified file as the keeper", () => {
    const findings = detectNearDuplicateNames([
      file("C:\\d\\report.docx", 15, 100),
      file("C:\\d\\report_v2.docx", 15, 999), // newest
      file("C:\\d\\budget.xlsx", 15, 100),
      file("C:\\d\\budget_final.xlsx", 15, 200),
    ]);
    const labels = findings[0].items.map((i) => i.label);
    expect(labels).toContain("report_v2.docx");
    expect(labels).toContain("budget_final.xlsx");
  });

  it("keeps the newest by mtime even when the name suggests otherwise", () => {
    // report.docx was edited AFTER report_v2.docx — mtime wins.
    const findings = detectNearDuplicateNames([
      file("C:\\d\\report.docx", 15, 999),
      file("C:\\d\\report_v2.docx", 15, 100),
      file("C:\\d\\budget.xlsx", 15, 100),
      file("C:\\d\\budget_final.xlsx", 15, 200),
    ]);
    expect(findings[0].items.map((i) => i.label)).toContain("report.docx");
  });

  it("does NOT group files distinguished by a bare number", () => {
    // Chapter 1/2/3 are distinct documents, not a version stack.
    const findings = detectNearDuplicateNames([
      file("C:\\d\\Chapter 1.docx", 30),
      file("C:\\d\\Chapter 2.docx", 30),
      file("C:\\d\\Chapter 3.docx", 30),
    ]);
    expect(findings).toEqual([]);
  });

  it("does not merge stacks across different directories", () => {
    const findings = detectNearDuplicateNames([
      file("C:\\a\\report.docx", 30),
      file("C:\\b\\report_v2.docx", 30),
    ]);
    expect(findings).toEqual([]);
  });

  it("stays quiet when reclaimable size is below the threshold", () => {
    const findings = detectNearDuplicateNames([
      file("C:\\d\\report.docx", 1, 100),
      file("C:\\d\\report_v2.docx", 1, 200),
      file("C:\\d\\budget.xlsx", 1, 100),
      file("C:\\d\\budget_final.xlsx", 1, 200),
    ]);
    expect(findings).toEqual([]);
  });

  it("falls back to version rank when modification times are unknown", () => {
    // No mtimes (all 0): keeper falls back to highest version rank.
    const findings = detectNearDuplicateNames([
      file("C:\\d\\report.docx", 15),
      file("C:\\d\\report_final.docx", 15),
      file("C:\\d\\budget.xlsx", 15),
      file("C:\\d\\budget_v3.xlsx", 15),
    ]);
    const labels = findings[0].items.map((i) => i.label);
    expect(labels).toContain("report_final.docx");
    expect(labels).toContain("budget_v3.xlsx");
  });
});

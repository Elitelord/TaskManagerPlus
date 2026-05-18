import { describe, it, expect } from "vitest";
import { parseVersion } from "./versionPattern";

describe("parseVersion — marker stripping", () => {
  it("leaves a plain name untouched", () => {
    const v = parseVersion("project");
    expect(v.stem).toBe("project");
    expect(v.hadMarker).toBe(false);
  });

  it("strips a _v2 version marker", () => {
    const v = parseVersion("project_v2");
    expect(v.stem).toBe("project");
    expect(v.hadMarker).toBe(true);
  });

  it("strips - Copy and - Copy (N) markers", () => {
    expect(parseVersion("report - Copy").stem).toBe("report");
    expect(parseVersion("report - Copy (2)").stem).toBe("report");
  });

  it("strips a bare (N) copy marker", () => {
    expect(parseVersion("report (3)").stem).toBe("report");
  });

  it("strips space-separated keyword markers", () => {
    expect(parseVersion("Resume final").stem).toBe("resume");
    expect(parseVersion("budget report v4").stem).toBe("budget report");
  });

  it("strips a chain of markers (FINAL_v2)", () => {
    const v = parseVersion("project_FINAL_v2");
    expect(v.stem).toBe("project");
    expect(v.hadMarker).toBe(true);
  });

  it("strips rev / draft / old / latest / backup markers", () => {
    expect(parseVersion("budget_rev3").stem).toBe("budget");
    expect(parseVersion("design_draft").stem).toBe("design");
    expect(parseVersion("design_old").stem).toBe("design");
    expect(parseVersion("notes_latest").stem).toBe("notes");
    expect(parseVersion("photo_backup").stem).toBe("photo");
  });

  it("is case-insensitive", () => {
    expect(parseVersion("PROJECT_V2").stem).toBe("project");
    expect(parseVersion("PROJECT_V2").hadMarker).toBe(true);
  });

  it("does NOT treat a bare trailing number as a marker", () => {
    // "Chapter 2" and "Chapter 3" are distinct documents, not versions.
    const v = parseVersion("Chapter 2");
    expect(v.hadMarker).toBe(false);
    expect(v.stem).toBe("chapter 2");
  });

  it("does NOT treat a common trailing word as a marker", () => {
    // "new" is intentionally excluded — too word-like (spike S-2 lesson).
    const v = parseVersion("My New Resume");
    expect(v.hadMarker).toBe(false);
    expect(v.stem).toBe("my new resume");
  });

  it("never strips the name down to an empty stem", () => {
    expect(parseVersion("(2)").stem).toBe("(2)");
    expect(parseVersion("final").stem).toBe("final");
  });
});

describe("parseVersion — recency rank", () => {
  it("ranks higher version numbers above lower ones", () => {
    expect(parseVersion("project_v10").rank).toBeGreaterThan(
      parseVersion("project_v2").rank,
    );
  });

  it("ranks _final above any plain version number", () => {
    expect(parseVersion("project_final").rank).toBeGreaterThan(
      parseVersion("project_v9").rank,
    );
  });

  it("ranks _FINAL_v2 above _final", () => {
    expect(parseVersion("project_FINAL_v2").rank).toBeGreaterThan(
      parseVersion("project_final").rank,
    );
  });

  it("ranks _draft and _old below a plain copy", () => {
    expect(parseVersion("design_draft").rank).toBeLessThan(
      parseVersion("design - Copy").rank,
    );
    expect(parseVersion("design_old").rank).toBeLessThan(
      parseVersion("design_draft").rank,
    );
  });

  it("ranks _latest highest of all", () => {
    const latest = parseVersion("notes_latest").rank;
    for (const name of ["notes_final", "notes_v99", "notes_draft", "notes_old"]) {
      expect(latest).toBeGreaterThan(parseVersion(name).rank);
    }
  });
});

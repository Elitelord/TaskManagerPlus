import { describe, it, expect } from "vitest";
import {
  classifyAutoMoveSafety,
  isFileSafeToAutoMove,
  looksArchivedCopy,
} from "./autoMoveSafety";

describe("classifyAutoMoveSafety", () => {
  it("treats self-contained file types as always safe", () => {
    const v = classifyAutoMoveSafety(
      { path: "C:\\Users\\me\\Desktop\\art.psd" },
      true,
    );
    expect(v.safe).toBe(true);
  });

  it("treats a live project file as unsafe", () => {
    const v = classifyAutoMoveSafety(
      { path: "C:\\Users\\me\\Videos\\wedding\\edit.prproj" },
      false,
    );
    expect(v.safe).toBe(false);
  });

  it("re-enables a project file living in a backup/archive folder", () => {
    for (const dir of ["backup", "Backups", "Archive", "archived", "Old", "references"]) {
      const v = classifyAutoMoveSafety(
        { path: `C:\\Users\\me\\Videos\\${dir}\\edit.prproj` },
        false,
      );
      expect(v.safe, dir).toBe(true);
    }
  });

  it("re-enables a project file whose name marks it as a backup", () => {
    for (const name of ["edit_backup.prproj", "edit-old.flp", "old_mix.als", "project_bak.aep"]) {
      const v = classifyAutoMoveSafety(
        { path: `C:\\Users\\me\\Videos\\${name}` },
        false,
      );
      expect(v.safe, name).toBe(true);
    }
  });
});

describe("looksArchivedCopy", () => {
  it("is false for an ordinary working file", () => {
    expect(looksArchivedCopy("C:\\Users\\me\\Videos\\film.prproj")).toBe(false);
  });

  it("does not false-trip on letters embedded in a real word", () => {
    // "bak" inside "bakery", "old" inside "scaffold".
    expect(looksArchivedCopy("C:\\Users\\me\\bakery.prproj")).toBe(false);
    expect(looksArchivedCopy("C:\\Users\\me\\scaffold.prproj")).toBe(false);
  });

  it("detects an archive directory segment regardless of case", () => {
    expect(looksArchivedCopy("D:\\Work\\ARCHIVE\\q3\\promo.prproj")).toBe(true);
  });

  it("ignores an archive-like word in the filename leaf for the segment check", () => {
    // "old" only in the filename — caught by the name check, not the segment
    // check; still archived overall.
    expect(looksArchivedCopy("C:\\Users\\me\\promo_old.prproj")).toBe(true);
  });
});

describe("isFileSafeToAutoMove", () => {
  it("returns a plain boolean matching classifyAutoMoveSafety", () => {
    expect(isFileSafeToAutoMove({ path: "x\\a.psd" }, true)).toBe(true);
    expect(isFileSafeToAutoMove({ path: "x\\a.prproj" }, false)).toBe(false);
    expect(isFileSafeToAutoMove({ path: "x\\old\\a.prproj" }, false)).toBe(true);
  });
});

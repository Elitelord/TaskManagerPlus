import { describe, it, expect } from "vitest";
import { buildStorageSlices } from "./storageSlices";
import type { StorageFolderInfo } from "./types";

const GB = 1024 ** 3;

function folder(name: string, gb: number): StorageFolderInfo {
  return {
    path: `C:\\${name}`,
    display_name: name,
    size_bytes: gb * GB,
    file_count: 0,
  };
}

describe("buildStorageSlices — volume partition", () => {
  it("slices sum exactly to the volume's used bytes", () => {
    const folders = [folder("Windows", 30), folder("Users", 20), folder("ProgramData", 5)];
    const used = 80 * GB; // more than scanned (55) → remainder fills the gap
    const r = buildStorageSlices({
      folders,
      topCount: 10,
      volumeUsedBytes: used,
      recycleBinBytes: 2 * GB,
    });
    const sum = r.slices.reduce((s, sl) => s + sl.value, 0);
    expect(sum).toBe(used);
    expect(r.remainderClamped).toBe(false);
    // Named remainder present and equal to used - scanned - recycle.
    const rem = r.slices.find((s) => s.kind === "system-unscanned");
    expect(rem?.value).toBe(used - 55 * GB - 2 * GB);
  });

  it("emits a system-files slice and still sums to used", () => {
    const folders = [folder("Windows", 30), folder("Users", 20), folder("ProgramData", 5)];
    const used = 80 * GB;
    const r = buildStorageSlices({
      folders,
      topCount: 10,
      volumeUsedBytes: used,
      recycleBinBytes: 2 * GB,
      systemReservedBytes: 12 * GB, // pagefile + hiberfil
    });
    const sys = r.slices.find((s) => s.kind === "system-files");
    expect(sys?.value).toBe(12 * GB);
    // Partition still exact: scanned(55) + recycle(2) + system(12) + remainder = used.
    expect(r.slices.reduce((s, sl) => s + sl.value, 0)).toBe(used);
    const rem = r.slices.find((s) => s.kind === "system-unscanned");
    expect(rem?.value).toBe(used - 55 * GB - 2 * GB - 12 * GB);
  });

  it("groups folders past topCount into one 'Other scanned folders' slice", () => {
    const folders = Array.from({ length: 14 }, (_, i) => folder(`f${i}`, 14 - i));
    const r = buildStorageSlices({ folders, topCount: 10, volumeUsedBytes: 200 * GB });
    const other = r.slices.find((s) => s.kind === "other-scanned");
    expect(r.otherScannedCount).toBe(4); // ranks 11..14
    // Other = sum of the 4 smallest (sizes 4,3,2,1 GB).
    expect(other?.value).toBe((4 + 3 + 2 + 1) * GB);
    expect(other?.label).toContain("(4)");
    // Exactly 10 folder slices + other + system remainder.
    expect(r.slices.filter((s) => s.kind === "folder")).toHaveLength(10);
  });

  it("clamps the remainder and flags it when scanned exceeds used", () => {
    // Logical sizes (hardlinks/compression/cloud) exceed real used bytes.
    const folders = [folder("WinSxS", 60), folder("OneDrive", 500)];
    const r = buildStorageSlices({
      folders,
      topCount: 10,
      volumeUsedBytes: 100 * GB,
    });
    expect(r.remainderClamped).toBe(true);
    // No negative or system slice is emitted.
    expect(r.slices.some((s) => s.kind === "system-unscanned")).toBe(false);
    expect(r.slices.every((s) => s.value >= 0)).toBe(true);
  });
});

describe("buildStorageSlices — drill-down (no volume)", () => {
  it("uses the slice sum as the denominator and emits no system slices", () => {
    const folders = [folder("sub1", 3), folder("sub2", 1)];
    const r = buildStorageSlices({ folders, topCount: 10 });
    expect(r.isVolumePartition).toBe(false);
    expect(r.remainderClamped).toBe(false);
    expect(r.slices.some((s) => s.kind === "recycle-bin" || s.kind === "system-unscanned")).toBe(false);
    expect(r.slices.reduce((s, sl) => s + sl.value, 0)).toBe(4 * GB);
  });
});

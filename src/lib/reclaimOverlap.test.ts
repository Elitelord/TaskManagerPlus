import { describe, it, expect } from "vitest";
import { withDedupedReclaim, computeReclaimTotal, reclaimOf } from "./reclaimOverlap";
import type { FindingGroup, DuplicateFinding } from "./smartOrganizer";

const MB = 1024 * 1024;

/** Minimal FindingGroup builder — only the fields the overlap pass reads. */
function finding(over: Partial<FindingGroup> & { id: string }): FindingGroup {
  return {
    icon: "",
    severity: "info",
    title: over.id,
    summary: "",
    detail: "",
    items: [],
    folderPath: "",
    reclaimableBytes: 0,
    ...over,
  };
}

function dupGroup(size: number, paths: string[], keeper = 0): DuplicateFinding {
  return {
    hash: paths.join("|"),
    size_bytes: size,
    defaultKeeperIndex: keeper,
    wastedBytes: size * (paths.length - 1),
    copies: paths.map((p) => ({
      path: p,
      label: p.split("\\").pop() ?? p,
      directory: p.split("\\").slice(0, -1).join("\\"),
      cloudProvider: null,
      isCloudMirror: false,
    })),
  };
}

describe("withDedupedReclaim", () => {
  it("does not double-count bytes shared by duplicate-files and large-lone-files", () => {
    const shared = "C:\\Users\\me\\Downloads\\big.iso";
    const dupes = finding({
      id: "duplicate-files",
      reclaimableBytes: 4000 * MB,
      actionType: "duplicates",
      duplicates: [dupGroup(4000 * MB, [shared, "D:\\backup\\big.iso"], 1)],
      // keeper is index 1 (D:\backup), so the non-keeper copy is `shared`.
    });
    const large = finding({
      id: "large-lone-files",
      reclaimableBytes: 4000 * MB,
      directPaths: [{ path: shared, size_bytes: 4000 * MB }],
    });

    const annotated = withDedupedReclaim([dupes, large]);
    const byId = Object.fromEntries(annotated.map((f) => [f.id, reclaimOf(f)]));

    // Duplicates claim the shared copy first (higher priority); large-lone-files
    // gets 0 residual because its only path was already claimed.
    expect(byId["duplicate-files"]).toBe(4000 * MB);
    expect(byId["large-lone-files"]).toBe(0);

    // Union total = 4000 MB, strictly less than the naive sum of 8000 MB.
    expect(computeReclaimTotal([dupes, large])).toBe(4000 * MB);
    expect(computeReclaimTotal([dupes, large])).toBeLessThan(
      dupes.reclaimableBytes + large.reclaimableBytes,
    );
  });

  it("keeps the duplicate keeper claimable by large-lone-files (different bytes)", () => {
    const keeperPath = "C:\\keep\\a.bin";
    const copyPath = "C:\\dup\\a.bin";
    const dupes = finding({
      id: "duplicate-files",
      reclaimableBytes: 100 * MB,
      duplicates: [dupGroup(100 * MB, [keeperPath, copyPath], 0)], // keep index 0
    });
    // large-lone-files lists BOTH the keeper and an unrelated file.
    const large = finding({
      id: "large-lone-files",
      reclaimableBytes: 300 * MB,
      directPaths: [
        { path: keeperPath, size_bytes: 100 * MB },
        { path: "C:\\other\\z.bin", size_bytes: 200 * MB },
      ],
    });

    const byId = Object.fromEntries(
      withDedupedReclaim([dupes, large]).map((f) => [f.id, reclaimOf(f)]),
    );
    // Duplicates claim only the non-keeper copy (100 MB).
    expect(byId["duplicate-files"]).toBe(100 * MB);
    // large-lone-files still gets the keeper (100 MB, not claimed) + unrelated
    // 200 MB = 300 MB. The keeper's bytes are genuinely still on disk.
    expect(byId["large-lone-files"]).toBe(300 * MB);
  });

  it("subtracts already-claimed exact paths from a rollup finding", () => {
    const folder = "C:\\Users\\me\\Downloads";
    const exactMsi = finding({
      id: "log-temp-files", // exact-path, higher priority than rollup
      reclaimableBytes: 120 * MB,
      directPaths: [{ path: `${folder}\\setup.msi`, size_bytes: 120 * MB }],
    });
    const rollup = finding({
      id: "downloads-installers",
      reclaimableBytes: 500 * MB,
      folderPath: folder,
      extensions: [".msi", ".msix"],
    });

    const byId = Object.fromEntries(
      withDedupedReclaim([exactMsi, rollup]).map((f) => [f.id, reclaimOf(f)]),
    );
    expect(byId["log-temp-files"]).toBe(120 * MB);
    // Rollup drops by exactly the claimed .msi under the folder.
    expect(byId["downloads-installers"]).toBe(380 * MB);
  });

  it("passes opaque findings (no paths) through unchanged", () => {
    const app = finding({ id: "installed-app:steam", reclaimableBytes: 90000 * MB });
    const byId = Object.fromEntries(
      withDedupedReclaim([app]).map((f) => [f.id, reclaimOf(f)]),
    );
    expect(byId["installed-app:steam"]).toBe(90000 * MB);
  });

  it("is deterministic regardless of input order", () => {
    const shared = "C:\\d\\x.bin";
    const a = finding({
      id: "duplicate-files",
      reclaimableBytes: 50 * MB,
      duplicates: [dupGroup(50 * MB, [shared, "E:\\x.bin"], 1)],
    });
    const b = finding({
      id: "large-lone-files",
      reclaimableBytes: 50 * MB,
      directPaths: [{ path: shared, size_bytes: 50 * MB }],
    });
    const c = finding({
      id: "stale-build-artifacts",
      reclaimableBytes: 10 * MB,
      directPaths: [{ path: "C:\\proj\\node_modules", size_bytes: 10 * MB }],
    });

    const forward = computeReclaimTotal([a, b, c]);
    const reversed = computeReclaimTotal([c, b, a]);
    expect(forward).toBe(reversed);
    expect(forward).toBe(60 * MB); // 50 (shared, once) + 10 (artifacts)
  });
});

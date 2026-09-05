// Builds the "What's using space on C:" ring as an honest partition of the
// drive's used bytes.
//
// The old ring had two defects (see the storage-accounting plan, #6/#7):
//   1. Its denominator was the sum of the slices, while the donut's centre
//      printed the volume's real used bytes — so the arcs could never agree
//      with the number in the middle.
//   2. Its "Other" slice was only ranks 11-24 of the fetched folders; ranks
//      25+, the Recycle Bin, pagefile/hiberfil, reparse points and everything
//      past the scan-depth limit simply vanished, with no indication.
//
// This builder produces slices that sum to the volume's used bytes: the top-N
// folders, then "Other scanned folders" (every remaining scanned folder), then
// the Recycle Bin, then a "System & unscanned" remainder for everything the
// walk didn't or couldn't attribute (pagefile, hibernation file, System Volume
// Information, protected folders, files below the depth cap). The centre label
// is the same used-bytes figure, so ring and centre agree by construction.
//
// When the scanned folders' *logical* sizes already exceed the volume's used
// bytes — which happens with NTFS compression, hardlinked trees like WinSxS, or
// dehydrated OneDrive files reported at full size (fixed properly in later
// phases) — the remainder is clamped to 0 and `remainderClamped` is set so the
// caller can show a caveat instead of a negative or hidden slice.

import type { StorageFolderInfo } from "./types";

export interface StorageSlice {
  label: string;
  value: number;
  /** Present for real folders → the row is clickable and gets a palette hue. */
  path?: string;
  kind: "folder" | "other-scanned" | "recycle-bin" | "system-files" | "system-unscanned";
  /** Rank among folder slices (0-based) → which palette colour to use. */
  rank?: number;
}

export interface StorageSlicesResult {
  slices: StorageSlice[];
  /** Sum of every scanned folder's size (top-N + other). */
  scannedSum: number;
  /** How many folders fell into "Other scanned folders". */
  otherScannedCount: number;
  /** True when scanned folders alone exceed the volume's used bytes, so the
   *  remainder had to be clamped to 0. Signals the logical-size caveat. */
  remainderClamped: boolean;
  /** True when this ring is a genuine partition of a volume's used bytes
   *  (as opposed to a drill-down where the denominator is just the slice sum). */
  isVolumePartition: boolean;
}

export interface BuildStorageSlicesInput {
  folders: StorageFolderInfo[];
  /** Number of folders that get their own coloured slice (palette length). */
  topCount: number;
  /** Volume used bytes (`total - free`). Provide ONLY when the scan root is a
   *  volume root; omit for folder drill-downs, where there is no drive total to
   *  partition and the denominator is simply the sum of the slices. */
  volumeUsedBytes?: number;
  /** All-drives Recycle Bin size, shown as its own slice in volume mode. */
  recycleBinBytes?: number;
  /** Bytes attributed to named system files (pagefile/hiberfil/swap), from
   *  `get_system_reserved`. Emitted as a "System files" slice; anything still
   *  unaccounted (System Volume Information, protected dirs) stays in the
   *  remainder. 0 falls back to the old behaviour (all in the remainder). */
  systemReservedBytes?: number;
}

function leafOf(displayName: string): string {
  return displayName.split("\\").pop() ?? displayName;
}

export function buildStorageSlices(input: BuildStorageSlicesInput): StorageSlicesResult {
  const { folders, topCount, volumeUsedBytes, recycleBinBytes = 0, systemReservedBytes = 0 } = input;

  const sorted = [...folders].sort((a, b) => b.size_bytes - a.size_bytes);
  const top = sorted.slice(0, Math.max(0, topCount));
  const rest = sorted.slice(Math.max(0, topCount));
  const otherScanned = rest.reduce((s, f) => s + f.size_bytes, 0);
  const scannedSum = sorted.reduce((s, f) => s + f.size_bytes, 0);

  const slices: StorageSlice[] = top.map((f, i) => ({
    label: leafOf(f.display_name),
    value: f.size_bytes,
    path: f.path,
    kind: "folder",
    rank: i,
  }));

  if (otherScanned > 0) {
    slices.push({
      label: `Other scanned folders (${rest.length})`,
      value: otherScanned,
      kind: "other-scanned",
    });
  }

  const isVolumePartition = typeof volumeUsedBytes === "number" && volumeUsedBytes > 0;

  if (!isVolumePartition) {
    // Drill-down: no drive total to partition. Denominator is the slice sum,
    // matching the pre-existing behaviour for folder inspection.
    return {
      slices,
      scannedSum,
      otherScannedCount: rest.length,
      remainderClamped: false,
      isVolumePartition: false,
    };
  }

  const used = volumeUsedBytes as number;

  if (recycleBinBytes > 0) {
    slices.push({ label: "Recycle Bin", value: recycleBinBytes, kind: "recycle-bin" });
  }

  // Named system files (pagefile/hibernation/swap) get their own slice — they're
  // real used bytes, just outside the folder walk. Emitting them (rather than
  // only subtracting them from the remainder) keeps the slices a true partition:
  // scanned + recycle + system-files + remainder === used.
  if (systemReservedBytes > 0) {
    slices.push({ label: "System files (pagefile, hibernation)", value: systemReservedBytes, kind: "system-files" });
  }

  const rawRemainder = used - scannedSum - recycleBinBytes - systemReservedBytes;
  const remainderClamped = rawRemainder < 0;
  const remainder = Math.max(0, rawRemainder);
  if (remainder > 0) {
    slices.push({ label: "System & unscanned", value: remainder, kind: "system-unscanned" });
  }

  return {
    slices,
    scannedSum,
    otherScannedCount: rest.length,
    remainderClamped,
    isVolumePartition: true,
  };
}

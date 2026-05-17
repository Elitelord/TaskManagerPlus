import { describe, it, expect } from "vitest";
import {
  extractFolderFeatures,
  classifyFolder,
  classifyScannedFolders,
  MIN_CONFIDENCE,
} from "./projectFolder";
import type { FileTypeStat } from "./types";

const NOW = 1_700_000_000;
const DAY = 86_400;

/** Build one FileTypeStat row. `daysAgo` sets how long ago the newest file
 *  was touched; the oldest is `spread` days before that. */
function stat(
  folder: string,
  category: string,
  fileCount: number,
  daysAgo = 10,
  spread = 5,
): FileTypeStat {
  return {
    folder_path: folder,
    category,
    total_bytes: fileCount * 1024,
    file_count: fileCount,
    newest_modified_ts: NOW - daysAgo * DAY,
    oldest_modified_ts: NOW - (daysAgo + spread) * DAY,
  };
}

describe("extractFolderFeatures", () => {
  it("aggregates counts and category shares", () => {
    const f = extractFolderFeatures(
      [
        stat("C:\\p", "code", 30),
        stat("C:\\p", "documents", 10),
        stat("C:\\p", "images", 10),
      ],
      NOW,
    );
    expect(f.fileCount).toBe(50);
    expect(f.categoryCount).toBe(3);
    expect(f.codeShare).toBeCloseTo(0.6);
    expect(f.mediaShare).toBeCloseTo(0.2);
    expect(f.dominantShare).toBeCloseTo(0.6);
  });

  it("returns a zeroed vector for an empty folder", () => {
    const f = extractFolderFeatures([], NOW);
    expect(f.fileCount).toBe(0);
    expect(f.typeEntropy).toBe(0);
    expect(f.staleDays).toBe(0);
  });

  it("ignores categories with zero files", () => {
    const f = extractFolderFeatures(
      [stat("C:\\p", "code", 10), stat("C:\\p", "images", 0)],
      NOW,
    );
    expect(f.categoryCount).toBe(1);
    expect(f.codeShare).toBe(1);
  });

  it("computes staleness from the newest modified time", () => {
    const f = extractFolderFeatures([stat("C:\\p", "code", 5, 90)], NOW);
    expect(f.staleDays).toBeCloseTo(90, 0);
  });
});

describe("classifyFolder", () => {
  it("classifies a code-plus-supporting-files folder as project", () => {
    const v = classifyFolder(
      [
        stat("C:\\dev\\app", "code", 30),
        stat("C:\\dev\\app", "documents", 10),
        stat("C:\\dev\\app", "other", 5),
        stat("C:\\dev\\app", "images", 5),
      ],
      NOW,
    );
    expect(v.kind).toBe("project");
    expect(v.confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE);
  });

  it("still calls a dormant (stale) code folder a project", () => {
    const v = classifyFolder(
      [
        stat("C:\\old\\app", "code", 40, 500),
        stat("C:\\old\\app", "documents", 12, 500),
      ],
      NOW,
    );
    expect(v.kind).toBe("project");
  });

  it("classifies a media-dominated folder as media-library", () => {
    const v = classifyFolder(
      [
        stat("C:\\Users\\me\\Pictures", "images", 80),
        stat("C:\\Users\\me\\Pictures", "videos", 15),
        stat("C:\\Users\\me\\Pictures", "other", 5),
      ],
      NOW,
    );
    expect(v.kind).toBe("media-library");
    expect(v.confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE);
  });

  it("classifies an archive-heavy folder as archive", () => {
    const v = classifyFolder(
      [
        stat("C:\\Backups", "archives", 40),
        stat("C:\\Backups", "documents", 5),
      ],
      NOW,
    );
    expect(v.kind).toBe("archive");
  });

  it("classifies a cold, long-untouched folder as archive", () => {
    const v = classifyFolder(
      [
        stat("C:\\Old Stuff", "documents", 20, 800, 400),
        stat("C:\\Old Stuff", "images", 10, 850, 300),
      ],
      NOW,
    );
    expect(v.kind).toBe("archive");
  });

  it("classifies a temp/cache directory as temp from its path leaf", () => {
    const v = classifyFolder(
      [stat("C:\\Users\\me\\AppData\\Local\\Temp", "other", 200)],
      NOW,
    );
    expect(v.kind).toBe("temp");
    expect(v.confidence).toBeGreaterThan(0.9);
  });

  it("classifies an evenly-mixed, code-free pile as dump", () => {
    const v = classifyFolder(
      [
        stat("C:\\Users\\me\\Downloads", "documents", 15),
        stat("C:\\Users\\me\\Downloads", "images", 8),
        stat("C:\\Users\\me\\Downloads", "archives", 10),
        stat("C:\\Users\\me\\Downloads", "executables", 9),
        stat("C:\\Users\\me\\Downloads", "installers", 8),
      ],
      NOW,
    );
    expect(v.kind).toBe("dump");
    expect(v.confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE);
  });

  it("gives an empty folder zero confidence", () => {
    const v = classifyFolder([], NOW);
    expect(v.confidence).toBe(0);
  });

  it("does not call a media folder a project just because it has a few code files", () => {
    const v = classifyFolder(
      [
        stat("C:\\Users\\me\\Pictures", "images", 90),
        stat("C:\\Users\\me\\Pictures", "code", 3),
      ],
      NOW,
    );
    expect(v.kind).toBe("media-library");
  });
});

describe("classifyScannedFolders", () => {
  it("returns only the folders confidently classified as project", () => {
    const stats: FileTypeStat[] = [
      stat("C:\\dev\\app", "code", 30),
      stat("C:\\dev\\app", "documents", 10),
      stat("C:\\dev\\app", "other", 6),
      stat("C:\\Users\\me\\Pictures", "images", 100),
      stat("C:\\Users\\me\\Pictures", "videos", 20),
    ];
    const projects = classifyScannedFolders(stats, NOW);
    expect(projects).toEqual(["C:\\dev\\app"]);
  });

  it("returns an empty list when nothing looks like a project", () => {
    const stats: FileTypeStat[] = [
      stat("C:\\Users\\me\\Music", "audio", 200),
    ];
    expect(classifyScannedFolders(stats, NOW)).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import { prettifyExeName, groupRunningApps } from "./workloadGrouping";
import type { RunningAppRow } from "./insightsEngine";

/** Build a RunningAppRow with sensible defaults for terse test cases. */
function row(p: Partial<RunningAppRow> & { name: string }): RunningAppRow {
  return {
    name: p.name,
    displayName: p.displayName ?? "",
    cpuPercent: p.cpuPercent ?? 0,
    memoryMb: p.memoryMb ?? 0,
    workload: p.workload ?? null,
    isBackground: p.isBackground ?? false,
  };
}

describe("prettifyExeName", () => {
  it("strips .exe and capitalizes", () => {
    expect(prettifyExeName("chrome.exe")).toBe("Chrome");
  });

  it("handles dotted exe names", () => {
    expect(prettifyExeName("com.docker.backend.exe")).toBe("Com.docker.backend");
  });

  it("is case-insensitive on the .exe suffix", () => {
    expect(prettifyExeName("Code.EXE")).toBe("Code");
  });

  it("returns the input unchanged when there is no stem", () => {
    expect(prettifyExeName("")).toBe("");
  });
});

describe("groupRunningApps", () => {
  it("collapses processes that share a friendly name", () => {
    const groups = groupRunningApps([
      row({ name: "Spotify.exe", displayName: "Spotify", cpuPercent: 1, memoryMb: 400 }),
      row({ name: "SpotifyLauncher.exe", displayName: "Spotify", cpuPercent: 0, memoryMb: 26 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Spotify");
    expect(groups[0].names).toEqual(["Spotify.exe", "SpotifyLauncher.exe"]);
    expect(groups[0].cpuPercent).toBe(1);
    expect(groups[0].memoryMb).toBe(426);
  });

  it("keeps apps with different friendly names separate", () => {
    const groups = groupRunningApps([
      row({ name: "chrome.exe", displayName: "Google Chrome", memoryMb: 100 }),
      row({ name: "Code.exe", displayName: "Visual Studio Code", memoryMb: 100 }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("falls back to a prettified exe name when displayName is empty", () => {
    const groups = groupRunningApps([
      row({ name: "weird_helper_x64.exe", displayName: "", memoryMb: 10 }),
    ]);
    expect(groups[0].label).toBe("Weird_helper_x64");
  });

  it("marks a group background only when every member is background", () => {
    const mixed = groupRunningApps([
      row({ name: "a.exe", displayName: "App", isBackground: true }),
      row({ name: "b.exe", displayName: "App", isBackground: false }),
    ]);
    expect(mixed[0].isBackground).toBe(false);

    const allBg = groupRunningApps([
      row({ name: "a.exe", displayName: "App", isBackground: true }),
      row({ name: "b.exe", displayName: "App", isBackground: true }),
    ]);
    expect(allBg[0].isBackground).toBe(true);
  });

  it("sorts groups heaviest-first by combined CPU + memory weight", () => {
    const groups = groupRunningApps([
      row({ name: "light.exe", displayName: "Light", cpuPercent: 0, memoryMb: 50 }),
      row({ name: "heavy.exe", displayName: "Heavy", cpuPercent: 40, memoryMb: 100 }),
      row({ name: "medium.exe", displayName: "Medium", cpuPercent: 0, memoryMb: 4000 }),
    ]);
    expect(groups.map(g => g.label)).toEqual(["Heavy", "Medium", "Light"]);
  });

  it("returns an empty array for no input", () => {
    expect(groupRunningApps([])).toEqual([]);
  });
});

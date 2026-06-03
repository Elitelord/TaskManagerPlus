import { describe, it, expect } from "vitest";
import {
  isHelperProcess,
  detectWorkloads,
  detectActiveDownload,
  applyDownloadDestination,
  downloadSourceFamilyKey,
  sameDownloadSourceFamily,
  type DownloadProcessSample,
} from "./insights";
import type { PerformanceSnapshot } from "./types";

/** Minimal ProcessBasic-shaped input for detectWorkloads. */
interface TestProc {
  name: string;
  cpuPercent: number;
  memoryMb: number;
  gpuPercent: number;
  metadata?: string;
}

function proc(p: Partial<TestProc> & { name: string }): TestProc {
  return {
    name: p.name,
    cpuPercent: p.cpuPercent ?? 0,
    memoryMb: p.memoryMb ?? 100,
    gpuPercent: p.gpuPercent ?? 0,
    metadata: p.metadata,
  };
}

/** All exe names appearing in any detected workload's matched-apps list. */
function allMatched(procs: TestProc[]): string[] {
  return detectWorkloads(procs).flatMap(w => w.matchedApps);
}

describe("isHelperProcess", () => {
  it("flags crash handlers, brokers, services, hosts, and webview2 runtimes", () => {
    for (const name of [
      "steamwebhelper.exe",
      "crashpad_handler.exe",
      "steamservice.exe",
      "gamingservices.exe",
      "RuntimeBroker.exe",
      "msedgewebview2.exe",
      "ApplicationFrameHost.exe",
      "Adobe Crash Processor.exe",
    ]) {
      expect(isHelperProcess(name), name).toBe(true);
    }
  });

  it("does not flag genuine foreground apps", () => {
    for (const name of [
      "chrome.exe",
      "Code.exe",
      "steam.exe",
      "discord.exe",
      "photoshop.exe",
    ]) {
      expect(isHelperProcess(name), name).toBe(false);
    }
  });
});

describe("detectWorkloads — regression coverage", () => {
  it("an exact exe match fires its workload even with no activity", () => {
    // chrome.exe is a strong exe-name match; browsing should fire at 0% CPU.
    const types = detectWorkloads([
      proc({ name: "chrome.exe", cpuPercent: 0, memoryMb: 500 }),
    ]).map(w => w.type);
    expect(types).toContain("browsing");
  });

  it("excludes helper processes from every workload (spike S-2)", () => {
    // A busy helper with no real app present must not drive a workload.
    const matched = allMatched([
      proc({ name: "steamwebhelper.exe", cpuPercent: 50, memoryMb: 500 }),
      proc({ name: "crashpad_handler.exe", cpuPercent: 20, memoryMb: 100 }),
    ]);
    expect(matched).not.toContain("steamwebhelper.exe");
    expect(matched).not.toContain("crashpad_handler.exe");
  });

  it("does not match browsing on 'operating system' metadata (the 'opera' bug)", () => {
    // Every Windows OS process carries ProductName "...Operating System".
    // The browsing rule must not treat the "opera" inside "operating" as Opera.
    const result = detectWorkloads([
      proc({
        name: "SystemSettings.exe",
        cpuPercent: 5,
        memoryMb: 90,
        metadata: "windows settings microsoft windows operating system",
      }),
    ]);
    expect(result.flatMap(w => w.matchedApps)).not.toContain("SystemSettings.exe");
  });

  it("treats a metadata keyword hit as soft — idle processes don't fire a workload", () => {
    // A process whose metadata mentions Photoshop but is idle (0% CPU) must
    // not, on its own, light up the editing workload.
    const idle = detectWorkloads([
      proc({ name: "psbackground.exe", cpuPercent: 0, gpuPercent: 0, metadata: "adobe photoshop" }),
    ]);
    expect(idle.map(w => w.type)).not.toContain("editing");

    // The same metadata hit WITH real CPU activity should fire editing.
    const active = detectWorkloads([
      proc({ name: "psbackground.exe", cpuPercent: 25, gpuPercent: 0, metadata: "adobe photoshop" }),
    ]);
    expect(active.map(w => w.type)).toContain("editing");
  });
});

const MB = 1024 * 1024;

/** Minimal PerformanceSnapshot for the download detector. Only the fields the
 *  detector reads are meaningful; the rest are zeroed and cast. */
function snap(p: {
  recv: number;
  diskWrite?: number;
  linkBps?: number;
  diskActive?: number;
  diskQueue?: number;
}): PerformanceSnapshot {
  return {
    net_recv_per_sec: p.recv,
    disk_write_per_sec: p.diskWrite ?? 0,
    net_link_speed_bps: p.linkBps ?? 1_000_000_000, // 1 Gbps default
    disk_active_percent: p.diskActive ?? 0,
    disk_queue_length: p.diskQueue ?? 0,
  } as unknown as PerformanceSnapshot;
}

function dlProc(p: Partial<DownloadProcessSample> & { name: string }): DownloadProcessSample {
  return {
    name: p.name,
    displayName: p.displayName,
    pid: p.pid,
    recvBytesPerSec: p.recvBytesPerSec ?? 0,
    writeBytesPerSec: p.writeBytesPerSec ?? 0,
  };
}

describe("detectActiveDownload", () => {
  /** A sustained, disk-backed fast download (20 MB/s) over 14 samples. */
  const downloadHistory = Array.from({ length: 14 }, () =>
    snap({ recv: 20 * MB, diskWrite: 18 * MB }),
  );

  it("fires on a sustained download that writes to disk", () => {
    const result = detectActiveDownload(downloadHistory, [
      dlProc({ name: "chrome.exe", displayName: "Google Chrome", pid: 100, recvBytesPerSec: 19 * MB, writeBytesPerSec: 18 * MB }),
    ]);
    expect(result).not.toBeNull();
    expect(result!.insight.id).toBe("active-download");
    expect(result!.insight.category).toBe("network");
    expect(result!.insight.description).toContain("Google Chrome");
    expect(result!.downloaderPid).toBe(100);
  });

  it("does NOT fire on streaming (high recv, negligible disk writes)", () => {
    const streamHistory = Array.from({ length: 14 }, () =>
      snap({ recv: 20 * MB, diskWrite: 0 }),
    );
    expect(detectActiveDownload(streamHistory, [])).toBeNull();
  });

  it("does NOT fire on a short blip below the absolute floor", () => {
    const short = Array.from({ length: 3 }, () => snap({ recv: 20 * MB, diskWrite: 18 * MB }));
    expect(detectActiveDownload(short, [])).toBeNull();
  });

  it("does NOT fire on moderate speed with too few active samples", () => {
    const moderate = Array.from({ length: 5 }, () => snap({ recv: 3 * MB, diskWrite: 3 * MB }));
    expect(detectActiveDownload(moderate, [])).toBeNull();
  });

  it("fires quickly at high speed with only a few samples", () => {
    // 25 MB/s only needs ~4 samples — fast detection (matters most while the
    // window is in the tray and the perf loop slows to ~4s/sample).
    const fast = Array.from({ length: 4 }, () => snap({ recv: 25 * MB, diskWrite: 22 * MB }));
    expect(detectActiveDownload(fast, [])).not.toBeNull();
  });

  it("does NOT fire on slow, non-large background traffic", () => {
    // 500 KB/s — below the active floor, never starts a run.
    const trickle = Array.from({ length: 30 }, () =>
      snap({ recv: 0.5 * MB, diskWrite: 0.5 * MB }),
    );
    expect(detectActiveDownload(trickle, [])).toBeNull();
  });

  it("suggests pausing other bandwidth consumers and offers to end them", () => {
    const result = detectActiveDownload(downloadHistory, [
      dlProc({ name: "steam.exe", displayName: "Steam", recvBytesPerSec: 25 * MB, writeBytesPerSec: 20 * MB }),
      dlProc({ name: "onedrive.exe", displayName: "OneDrive", recvBytesPerSec: 5 * MB, writeBytesPerSec: 0 }),
    ]);
    expect(result).not.toBeNull();
    const insight = result!.insight;
    // Downloader (top recv + disk write) is Steam; OneDrive is the "other" consumer.
    expect(insight.description).toContain("Steam");
    expect(insight.description).toContain("OneDrive");
    const endTargets = insight.actions.filter(a => a.type === "end-task").map(a => a.processName);
    expect(endTargets).toContain("onedrive.exe");
    expect(endTargets).not.toContain("steam.exe");
  });

  it("flags a disk bottleneck when the drive is saturated and no rival app exists", () => {
    const diskBound = Array.from({ length: 14 }, () =>
      snap({ recv: 20 * MB, diskWrite: 18 * MB, diskActive: 99, diskQueue: 5 }),
    );
    const result = detectActiveDownload(diskBound, [
      dlProc({ name: "setup.exe", displayName: "Installer", recvBytesPerSec: 19 * MB, writeBytesPerSec: 18 * MB }),
    ]);
    expect(result).not.toBeNull();
    expect(result!.insight.description.toLowerCase()).toContain("disk");
  });

  it("suggests pausing a running cloud-sync app even when its measured recv is low", () => {
    // Battle.net is the downloader; OneDrive is idle on the (approximate) net
    // counter but is a known background sync app, so it's still offered.
    const result = detectActiveDownload(downloadHistory, [
      dlProc({ name: "Battle.net.exe", displayName: "Battle.net", recvBytesPerSec: 18 * MB, writeBytesPerSec: 16 * MB }),
      dlProc({ name: "OneDrive.exe", displayName: "OneDrive", recvBytesPerSec: 0, writeBytesPerSec: 0 }),
    ]);
    expect(result).not.toBeNull();
    const endTargets = result!.insight.actions.filter(a => a.type === "end-task").map(a => a.processName);
    expect(endTargets).toContain("OneDrive.exe");
    expect(endTargets).not.toContain("Battle.net.exe");
  });

  it("always provides an actionable Windows shortcut when no rival is found (on Windows)", () => {
    // Node 20 (the CI runner's version) doesn't have a global `navigator`;
    // Node 21+ does. The test exercises a Windows-only code path that
    // sniffs `navigator.userAgent` in production, so stub the global if
    // it's absent. Caller restores the prior value in `finally`.
    const hadNavigator = typeof navigator !== "undefined";
    if (!hadNavigator) (globalThis as { navigator?: { userAgent: string } }).navigator = { userAgent: "" };
    const original = Object.getOwnPropertyDescriptor(navigator, "userAgent");
    Object.defineProperty(navigator, "userAgent", { value: "Windows NT 10.0", configurable: true });
    try {
      const result = detectActiveDownload(downloadHistory, [
        dlProc({ name: "Battle.net.exe", displayName: "Battle.net", recvBytesPerSec: 18 * MB, writeBytesPerSec: 16 * MB }),
      ]);
      expect(result).not.toBeNull();
      const insight = result!.insight;
      const nonDismiss = insight.actions.filter(a => a.type !== "dismiss");
      expect(nonDismiss.length).toBeGreaterThan(0);
      expect(insight.actions.some(a => a.type === "open-uri" && a.uri?.startsWith("ms-settings:"))).toBe(true);
    } finally {
      if (original) Object.defineProperty(navigator, "userAgent", original);
      // Remove the navigator stub we installed for Node 20 so other
      // tests see the original (absent) global.
      if (!hadNavigator) delete (globalThis as { navigator?: unknown }).navigator;
    }
  });

  it("attributes downloader by disk write when per-process recv is under-reported", () => {
    const history = Array.from({ length: 10 }, () =>
      snap({ recv: 15 * MB, diskWrite: 2 * MB }),
    );
    const result = detectActiveDownload(history, [
      dlProc({
        name: "Battle.net.exe",
        displayName: "Battle.net",
        recvBytesPerSec: 0.3 * MB,
        writeBytesPerSec: 12 * MB,
      }),
    ]);
    expect(result).not.toBeNull();
    expect(result!.insight.description).toContain("Battle.net");
  });

  it("still detects when recv dips briefly in the trailing window", () => {
    const history = [
      ...Array.from({ length: 8 }, () => snap({ recv: 18 * MB, diskWrite: 3 * MB })),
      snap({ recv: 0.5 * MB, diskWrite: 0 }),
      ...Array.from({ length: 8 }, () => snap({ recv: 18 * MB, diskWrite: 3 * MB })),
    ];
    expect(
      detectActiveDownload(history, [
        dlProc({ name: "Battle.net.exe", displayName: "Battle.net", recvBytesPerSec: 2 * MB, writeBytesPerSec: 10 * MB }),
      ]),
    ).not.toBeNull();
  });

  it("groups launcher and update-agent exes as one download source", () => {
    expect(
      sameDownloadSourceFamily(
        { name: "Battle.net.exe", displayName: "Battle.net" },
        { name: "Battle.net Update Agent.exe", displayName: "Battle.net Update Agent" },
      ),
    ).toBe(true);
    expect(downloadSourceFamilyKey("Battle.net Update Agent.exe", "Battle.net Update Agent")).toBe(
      downloadSourceFamilyKey("Battle.net.exe", "Battle.net"),
    );
  });

  it("does not suggest ending sibling processes of the same download", () => {
    const result = detectActiveDownload(downloadHistory, [
      dlProc({
        name: "Battle.net Update Agent.exe",
        displayName: "Battle.net Update Agent",
        pid: 200,
        recvBytesPerSec: 20 * MB,
        writeBytesPerSec: 18 * MB,
      }),
      dlProc({
        name: "Battle.net.exe",
        displayName: "Battle.net",
        pid: 100,
        recvBytesPerSec: 10 * MB,
        writeBytesPerSec: 8 * MB,
      }),
    ]);
    expect(result).not.toBeNull();
    expect(result!.insight.description).toContain("Battle.net");
    expect(result!.insight.description).not.toContain("Update Agent");
    const endTargets = result!.insight.actions
      .filter(a => a.type === "end-task")
      .map(a => a.processName?.toLowerCase());
    expect(endTargets).not.toContain("battle.net.exe");
    expect(endTargets).not.toContain("battle.net update agent.exe");
  });

  it("merges a probed destination path into the insight description", () => {
    const result = detectActiveDownload(downloadHistory, [
      dlProc({ name: "Battle.net.exe", displayName: "Battle.net", recvBytesPerSec: 18 * MB, writeBytesPerSec: 16 * MB }),
    ]);
    expect(result).not.toBeNull();
    const enriched = applyDownloadDestination(
      result!.insight,
      "C:\\ProgramData\\Battle.net\\Data\\games\\overwatch\\patch.pack",
    );
    expect(enriched.description).toContain("Saving to");
    expect(enriched.description).toContain("Battle.net");
    expect(enriched.description).toContain("patch.pack");
  });

  it("keeps decimal download rates intact when inserting a save path", () => {
    const history153 = Array.from({ length: 14 }, () =>
      snap({ recv: 15.3 * MB, diskWrite: 14 * MB }),
    );
    const base = detectActiveDownload(history153, [
      dlProc({ name: "Battle.net.exe", displayName: "Battle.net", recvBytesPerSec: 15.3 * MB, writeBytesPerSec: 14 * MB }),
    ])!.insight;
    const enriched = applyDownloadDestination(
      base,
      "C:\\Program Files (x86)\\Overwatch\\data\\casc\\data\\data.007",
    );
    expect(enriched.description).toMatch(/downloading at ~15\.3 MB\/s\./);
    expect(enriched.description).toContain("Saving to");
    expect(enriched.description).not.toMatch(/15\. Saving to/);
  });

  it("uses combined family recv in the displayed rate", () => {
    const history15 = Array.from({ length: 14 }, () =>
      snap({ recv: 15 * MB, diskWrite: 14 * MB }),
    );
    const result = detectActiveDownload(history15, [
      dlProc({
        name: "Battle.net Update Agent.exe",
        displayName: "Battle.net Update Agent",
        recvBytesPerSec: 8 * MB,
        writeBytesPerSec: 10 * MB,
      }),
      dlProc({
        name: "Battle.net.exe",
        displayName: "Battle.net",
        recvBytesPerSec: 7 * MB,
        writeBytesPerSec: 8 * MB,
      }),
    ]);
    expect(result).not.toBeNull();
    expect(result!.insight.metric).toBe("↓ 15.0 MB/s");
    expect(result!.insight.description).toContain("downloading at ~15.0 MB/s");
  });

  it("does not list unicode-dotted display names as rivals of the downloader", () => {
    const unicodeDot = "\u2024"; // ONE DOT LEADER — same UI glyph as Battle.net
    const result = detectActiveDownload(downloadHistory, [
      dlProc({
        name: "Battle.net Update Agent.exe",
        displayName: "Battle.net Update Agent",
        recvBytesPerSec: 20 * MB,
        writeBytesPerSec: 18 * MB,
      }),
      dlProc({
        name: "Battle.net.exe",
        displayName: `Battle${unicodeDot}net`,
        recvBytesPerSec: 10 * MB,
        writeBytesPerSec: 8 * MB,
      }),
      dlProc({ name: "Spotify.exe", displayName: "Spotify", recvBytesPerSec: 2 * MB, writeBytesPerSec: 0 }),
    ]);
    const endTargets = result!.insight.actions
      .filter(a => a.type === "end-task")
      .map(a => a.processName?.toLowerCase());
    expect(endTargets).toContain("spotify.exe");
    expect(endTargets).not.toContain("battle.net.exe");
    expect(result!.insight.description).not.toMatch(/Battle.*net.*Battle/i);
  });
});

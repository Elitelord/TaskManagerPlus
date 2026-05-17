import { describe, it, expect } from "vitest";
import { isHelperProcess, detectWorkloads } from "./insights";

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

import { describe, it, expect } from "vitest";
import {
  causeTitle,
  causeExplanation,
  classifyIncident,
  incidentRemediation,
  sameKindCount,
  pickDriverForClass,
  ageLabel,
  contextNear,
  describeWhen,
  newestNewerThan,
  type ShutdownEvent,
  type DriverInfo,
  type ContextEvent,
} from "./crashEvents";

const ev = (over: Partial<ShutdownEvent>): ShutdownEvent => ({
  timestampMs: 1000,
  kind: "unexpected_shutdown",
  bugcheckCode: null,
  detail: "Shut down unexpectedly",
  ...over,
});

describe("causeTitle / classifyIncident", () => {
  it("labels a power-state failure as a hang, not a blue screen", () => {
    const e = ev({ kind: "bsod", bugcheckCode: "0x0000009F" });
    expect(classifyIncident(e).presentation).toBe("hang");
    expect(classifyIncident(e).klass).toBe("power");
    expect(causeTitle(e)).toBe("System hang / freeze");
  });

  it("labels a genuine blue-screen code", () => {
    const e = ev({ kind: "bsod", bugcheckCode: "0x0000007E" });
    expect(classifyIncident(e).presentation).toBe("bluescreen");
    expect(causeTitle(e)).toBe("Blue-screen crash");
  });

  it("classifies GPU timeouts as hangs", () => {
    expect(classifyIncident(ev({ kind: "bsod", bugcheckCode: "0x00000116" })).klass).toBe("gpu");
    expect(causeTitle(ev({ kind: "bsod", bugcheckCode: "0x00000116" }))).toBe("System hang / freeze");
  });

  it("falls back to kind for unknown codes and non-BSOD shutdowns", () => {
    expect(causeTitle(ev({ kind: "bsod", bugcheckCode: "0xDEADBEEF" }))).toBe("Blue-screen crash");
    expect(causeTitle(ev({ kind: "power_loss" }))).toBe("Power loss or forced shutdown");
    expect(causeTitle(ev({ kind: "unexpected_shutdown" }))).toBe("Unexpected shutdown");
  });

  it("gives class-specific remediation (power → Wi-Fi power toggle)", () => {
    const steps = incidentRemediation(ev({ kind: "bsod", bugcheckCode: "0x0000009F" }));
    expect(steps.map((s) => s.text).join(" ")).toMatch(/turn off this device/i);
    // The toggle step offers a Device Manager action.
    expect(steps.some((s) => s.action?.kind === "device-manager")).toBe(true);
  });
});

describe("sameKindCount", () => {
  it("counts incidents sharing the same stop code across padding", () => {
    const list = [
      ev({ bugcheckCode: "0x0000009F" }),
      ev({ bugcheckCode: "0x9F" }),
      ev({ bugcheckCode: "0x0000007E" }),
    ];
    expect(sameKindCount(list, ev({ bugcheckCode: "0x0000009F" }))).toBe(2);
  });
});

describe("pickDriverForClass", () => {
  const drivers: DriverInfo[] = [
    { class: "gpu", name: "AMD Radeon 890M", version: "32.0", dateMs: 1 },
    { class: "wifi", name: "MediaTek MT7922", version: "3.4", dateMs: 2 },
    { class: "storage", name: "Samsung SSD", version: "5.1", dateMs: 3 },
  ];
  it("maps a class to its device", () => {
    expect(pickDriverForClass(drivers, "gpu")?.name).toContain("Radeon");
    expect(pickDriverForClass(drivers, "wifi")?.name).toContain("MT7922");
    expect(pickDriverForClass(drivers, "storage")?.name).toContain("SSD");
  });
  it("routes power hangs to Wi-Fi (then GPU)", () => {
    expect(pickDriverForClass(drivers, "power")?.class).toBe("wifi");
  });
  it("returns null for classes with no single device", () => {
    expect(pickDriverForClass(drivers, "memory")).toBeNull();
    expect(pickDriverForClass(drivers, "cpu_hw")).toBeNull();
  });
});

describe("ageLabel", () => {
  const now = new Date("2026-06-15T12:00:00").getTime();
  it("formats day / month / year ages", () => {
    expect(ageLabel(new Date("2026-06-01T12:00:00").getTime(), now)).toBe("14 days old");
    expect(ageLabel(new Date("2026-01-15T12:00:00").getTime(), now)).toBe("5 months old");
    expect(ageLabel(new Date("2024-06-15T12:00:00").getTime(), now)).toMatch(/year/);
  });
  it("returns null without a date", () => {
    expect(ageLabel(null, now)).toBeNull();
  });
});

describe("contextNear", () => {
  it("keeps only events within the window of the incident", () => {
    const evs: ContextEvent[] = [
      { timestampMs: 1_000_000, source: "gpu_tdr", detail: "near", driver: "amdwddmg" },
      { timestampMs: 9_000_000, source: "disk", detail: "far" },
    ];
    const near = contextNear(evs, 1_300_000, 10 * 60 * 1000);
    expect(near).toHaveLength(1);
    expect(near[0].detail).toBe("near");
  });
});

describe("causeExplanation", () => {
  it("is kind-specific and non-empty", () => {
    const bsod = causeExplanation(ev({ kind: "bsod" }));
    const power = causeExplanation(ev({ kind: "power_loss" }));
    const other = causeExplanation(ev({ kind: "unexpected_shutdown" }));
    expect(bsod).toMatch(/stop code/i);
    expect(power).toMatch(/battery/i);
    expect(other.length).toBeGreaterThan(0);
    expect(new Set([bsod, power, other]).size).toBe(3);
  });
});

describe("describeWhen", () => {
  const now = new Date("2026-06-15T12:00:00").getTime();
  const at = (d: string) => new Date(d).getTime();
  it("labels today and yesterday", () => {
    expect(describeWhen(at("2026-06-15T01:00:00"), now)).toBe("today");
    expect(describeWhen(at("2026-06-14T23:00:00"), now)).toBe("yesterday");
  });
  it("labels recent days and weeks", () => {
    expect(describeWhen(at("2026-06-12T08:00:00"), now)).toBe("3 days ago");
    expect(describeWhen(at("2026-06-05T08:00:00"), now)).toBe("1 week ago");
  });
});

describe("newestNewerThan", () => {
  it("returns null when no event is newer than the threshold", () => {
    expect(newestNewerThan([ev({ timestampMs: 500 })], 500)).toBeNull();
    expect(newestNewerThan([], 0)).toBeNull();
  });

  it("returns the newest event past the threshold", () => {
    const list = [
      ev({ timestampMs: 300 }),
      ev({ timestampMs: 900 }),
      ev({ timestampMs: 600 }),
    ];
    expect(newestNewerThan(list, 400)?.timestampMs).toBe(900);
  });

  it("is strict — an event exactly at the threshold is excluded", () => {
    expect(newestNewerThan([ev({ timestampMs: 700 })], 700)).toBeNull();
  });
});

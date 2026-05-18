import { describe, it, expect } from "vitest";
import {
  analyzeMetric,
  describeAnomaly,
  extractMetric,
  metricSpec,
  WATCHED_METRICS,
} from "./metricAnomaly";
import type { PerformanceSnapshot } from "./types";

const cpuSpec = metricSpec("cpu")!;

/** A flat-ish series of `n` values around `center`, with `last` appended. */
function series(n: number, center: number, last: number): number[] {
  const base = Array.from({ length: n }, (_, i) => center + ((i % 4) - 1.5));
  return [...base, last];
}

describe("analyzeMetric", () => {
  it("does not flag a reading inside the normal range", () => {
    const m = analyzeMetric(series(40, 20, 22), cpuSpec);
    expect(m.verdict.anomalous).toBe(false);
    expect(m.current).toBe(22);
  });

  it("flags a clear spike above the baseline", () => {
    const m = analyzeMetric(series(40, 12, 88), cpuSpec);
    expect(m.verdict.anomalous).toBe(true);
    expect(m.verdict.direction).toBe("high");
  });

  it("respects the per-metric minDelta floor", () => {
    // diskQueue minDelta is 2 — a jump from ~1 to 3 is only +2, allowed;
    // a jump to 1.5 would be statistically large but below the floor.
    const queueSpec = metricSpec("diskQueue")!;
    const tiny = analyzeMetric([...new Array(40).fill(1), 1.4], queueSpec);
    expect(tiny.verdict.anomalous).toBe(false);
  });

  it("gives no verdict with too little history", () => {
    const m = analyzeMetric([10, 12, 88], cpuSpec);
    expect(m.verdict.anomalous).toBe(false);
    expect(m.verdict.hasBaseline).toBe(false);
  });
});

describe("extractMetric", () => {
  it("derives memory as a percentage of total RAM", () => {
    const snap = {
      total_ram_bytes: 16_000_000_000,
      used_ram_bytes: 8_000_000_000,
    } as PerformanceSnapshot;
    expect(extractMetric(snap, "memory")).toBeCloseTo(50);
  });

  it("converts network to MB/s", () => {
    const snap = {
      net_send_per_sec: 3_000_000,
      net_recv_per_sec: 2_000_000,
    } as PerformanceSnapshot;
    expect(extractMetric(snap, "network")).toBeCloseTo(5);
  });

  it("returns 0 for memory when total RAM is unknown", () => {
    expect(extractMetric({ total_ram_bytes: 0, used_ram_bytes: 5 } as PerformanceSnapshot, "memory"))
      .toBe(0);
  });
});

describe("describeAnomaly", () => {
  it("returns null for a non-anomalous metric", () => {
    expect(describeAnomaly(analyzeMetric(series(40, 20, 21), cpuSpec))).toBeNull();
  });

  it("describes a spike with the baseline and current value", () => {
    const txt = describeAnomaly(analyzeMetric(series(40, 12, 88), cpuSpec));
    expect(txt).toMatch(/unusually high/i);
    expect(txt).toMatch(/CPU usage/);
  });
});

describe("WATCHED_METRICS", () => {
  it("every spec has a positive minDelta and a unique key", () => {
    const keys = new Set(WATCHED_METRICS.map((m) => m.key));
    expect(keys.size).toBe(WATCHED_METRICS.length);
    for (const m of WATCHED_METRICS) expect(m.minDelta).toBeGreaterThan(0);
  });
});

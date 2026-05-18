import { describe, it, expect } from "vitest";
import { detectAnomaly } from "./anomalyDetector";

/** A baseline of `n` values jittering around `center` by ±`spread`. */
function baseline(n: number, center: number, spread = 1): number[] {
  return Array.from({ length: n }, (_, i) =>
    center + ((i % 5) - 2) * (spread / 2),
  );
}

describe("detectAnomaly", () => {
  it("gives no opinion when there are too few samples", () => {
    const v = detectAnomaly([1, 2, 3], 99);
    expect(v.hasBaseline).toBe(false);
    expect(v.anomalous).toBe(false);
  });

  it("does not flag a value sitting inside the normal range", () => {
    const v = detectAnomaly(baseline(40, 50, 4), 51);
    expect(v.anomalous).toBe(false);
    expect(v.direction).toBe("normal");
  });

  it("flags a clear upward spike", () => {
    const v = detectAnomaly(baseline(40, 50, 4), 500);
    expect(v.anomalous).toBe(true);
    expect(v.direction).toBe("high");
    expect(v.score).toBeGreaterThan(3.5);
  });

  it("flags a clear downward dip", () => {
    const v = detectAnomaly(baseline(40, 500, 10), 10);
    expect(v.anomalous).toBe(true);
    expect(v.direction).toBe("low");
  });

  it("is robust to an outlier already in the baseline (MAD-based)", () => {
    // One stale spike in the history must not widen the baseline so much
    // that a fresh spike of the same size goes unnoticed.
    const withOutlier = [...baseline(39, 50, 4), 9000];
    const v = detectAnomaly(withOutlier, 600);
    expect(v.anomalous).toBe(true);
    expect(v.direction).toBe("high");
  });

  it("ignores a statistically-large but trivially-small deviation", () => {
    // Baseline barely moves; +3 is a huge z-score but a meaningless change.
    const v = detectAnomaly(baseline(40, 20, 0.2), 23, { minDelta: 10 });
    expect(v.anomalous).toBe(false);
  });

  it("gives no opinion on a perfectly flat baseline without an abs floor", () => {
    const v = detectAnomaly(new Array(40).fill(0), 5);
    expect(v.hasBaseline).toBe(false);
    expect(v.anomalous).toBe(false);
  });

  it("flags a flat baseline only when an absolute floor is crossed", () => {
    const flat = new Array(40).fill(0);
    expect(detectAnomaly(flat, 5, { minDelta: 10 }).anomalous).toBe(false);
    const v = detectAnomaly(flat, 50, { minDelta: 10 });
    expect(v.anomalous).toBe(true);
    expect(v.direction).toBe("high");
  });

  it("respects a custom threshold", () => {
    const b = baseline(40, 100, 6);
    const loose = detectAnomaly(b, 130, { threshold: 10 });
    const strict = detectAnomaly(b, 130, { threshold: 2 });
    expect(loose.anomalous).toBe(false);
    expect(strict.anomalous).toBe(true);
  });
});

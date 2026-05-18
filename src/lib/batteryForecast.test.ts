import { describe, it, expect, beforeEach } from "vitest";
import {
  forecastBatteryHealth,
  recordBatteryHealthSample,
  getBatteryHealthHistory,
  type HealthPoint,
} from "./batteryForecast";

const DAY = 86_400_000;

/** A health series degrading linearly from `start`% at `ratePerDay`%/day. */
function degrading(days: number, start: number, ratePerDay: number): HealthPoint[] {
  const t0 = Date.UTC(2026, 0, 1);
  return Array.from({ length: days }, (_, i) => ({
    ts: t0 + i * DAY,
    healthPercent: start + i * ratePerDay,
  }));
}

describe("forecastBatteryHealth", () => {
  it("has no trend with too few readings", () => {
    const f = forecastBatteryHealth(degrading(3, 95, -0.1));
    expect(f.hasTrend).toBe(false);
    expect(f.monthsToTarget).toBeNull();
  });

  it("has no trend when readings span too short a window", () => {
    // 6 readings but all within ~5 days.
    const t0 = Date.UTC(2026, 0, 1);
    const pts: HealthPoint[] = [0, 1, 2, 3, 4, 5].map((i) => ({
      ts: t0 + (i * DAY) / 2,
      healthPercent: 95 - i * 0.1,
    }));
    expect(forecastBatteryHealth(pts).hasTrend).toBe(false);
  });

  it("fits a degradation rate and projects months-to-target", () => {
    // 60 days, starting 95%, losing 0.1%/day → ~ -3%/month.
    const f = forecastBatteryHealth(degrading(60, 95, -0.1), 80);
    expect(f.hasTrend).toBe(true);
    expect(f.ratePerMonth).toBeCloseTo(-3, 0);
    expect(f.currentHealth).toBeCloseTo(95 + 59 * -0.1, 5);
    // From ~89.1% losing 0.1%/day, 80% is ~91 days ≈ 3 months away.
    expect(f.monthsToTarget).toBeGreaterThan(2);
    expect(f.monthsToTarget).toBeLessThan(4);
  });

  it("returns null months-to-target when the battery is not degrading", () => {
    const f = forecastBatteryHealth(degrading(60, 90, 0), 80);
    expect(f.hasTrend).toBe(true);
    expect(f.monthsToTarget).toBeNull();
  });

  it("returns 0 months when already at or below the target", () => {
    const f = forecastBatteryHealth(degrading(60, 78, -0.05), 80);
    expect(f.monthsToTarget).toBe(0);
  });

  it("does not require pre-sorted input", () => {
    const pts = degrading(60, 95, -0.1);
    const f = forecastBatteryHealth([...pts].reverse(), 80);
    expect(f.hasTrend).toBe(true);
    expect(f.ratePerMonth).toBeCloseTo(-3, 0);
  });
});

describe("battery health log persistence", () => {
  // The test env has no DOM — provide a minimal in-memory localStorage.
  beforeEach(() => {
    const store = new Map<string, string>();
    globalThis.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      get length() { return store.size; },
    } as Storage;
  });

  it("records one sample per calendar day, latest wins", () => {
    const t = Date.UTC(2026, 5, 1, 8, 0, 0);
    recordBatteryHealthSample(92, t);
    recordBatteryHealthSample(91, t + 3 * 3_600_000); // same day, later
    recordBatteryHealthSample(90, t + DAY);            // next day
    const hist = getBatteryHealthHistory();
    expect(hist).toHaveLength(2);
    expect(hist[0].healthPercent).toBe(91); // the day's latest reading
    expect(hist[1].healthPercent).toBe(90);
  });

  it("ignores invalid readings", () => {
    recordBatteryHealthSample(0);
    recordBatteryHealthSample(Number.NaN);
    expect(getBatteryHealthHistory()).toHaveLength(0);
  });

  it("round-trips through a forecast", () => {
    const t0 = Date.UTC(2026, 0, 1);
    for (let i = 0; i < 40; i++) recordBatteryHealthSample(95 - i * 0.1, t0 + i * DAY);
    const f = forecastBatteryHealth(getBatteryHealthHistory(), 80);
    expect(f.hasTrend).toBe(true);
    expect(f.ratePerMonth).toBeLessThan(0);
  });
});

import { describe, it, expect } from "vitest";
import { forecastUsage, type HourWorkloadLookup } from "./usageForecast";
import type { HourWorkload } from "./usagePattern";

/** Build a lookup from an hour-of-day → workload-shares map. */
function lookupFrom(
  table: Record<number, Array<[string, number]>>,
): HourWorkloadLookup {
  return (hour) => {
    const entries = table[hour] ?? [];
    return entries.map(
      ([type, share]): HourWorkload => ({ type, share, seconds: share * 3600 }),
    );
  };
}

// A Wednesday 12:00 — well clear of midnight so the window stays in-day.
const WED_NOON = new Date(2026, 4, 13, 12, 0, 0);

describe("forecastUsage", () => {
  it("returns nulls when the heatmap has no data", () => {
    const f = forecastUsage({ now: WED_NOON, lookup: lookupFrom({}) });
    expect(f.hours).toHaveLength(4);
    expect(f.hours.every((h) => h.workload === null)).toBe(true);
    expect(f.dominantWorkload).toBeNull();
    expect(f.confidence).toBe(0);
  });

  it("predicts the top workload for each upcoming hour", () => {
    const f = forecastUsage({
      now: WED_NOON,
      hoursAhead: 2,
      lookup: lookupFrom({
        13: [["gaming", 0.8], ["browsing", 0.2]],
        14: [["gaming", 0.6]],
      }),
    });
    expect(f.hours.map((h) => h.hour)).toEqual([13, 14]);
    expect(f.hours[0].workload).toBe("gaming");
    expect(f.hours[0].confidence).toBeCloseTo(0.8);
    expect(f.dominantWorkload).toBe("gaming");
  });

  it("averages dominant confidence across the whole window", () => {
    // gaming predicted in 2 of 4 hours at 0.8 share → 1.6 / 4 = 0.4.
    const f = forecastUsage({
      now: WED_NOON,
      hoursAhead: 4,
      lookup: lookupFrom({
        13: [["gaming", 0.8]],
        14: [["gaming", 0.8]],
      }),
    });
    expect(f.dominantWorkload).toBe("gaming");
    expect(f.confidence).toBeCloseTo(0.4);
  });

  it("picks the workload with the highest summed share as dominant", () => {
    const f = forecastUsage({
      now: WED_NOON,
      hoursAhead: 3,
      lookup: lookupFrom({
        13: [["editing", 0.9]],
        14: [["gaming", 0.5]],
        15: [["gaming", 0.5]],
      }),
    });
    // gaming: 0.5 + 0.5 = 1.0 > editing: 0.9.
    expect(f.dominantWorkload).toBe("gaming");
  });

  it("clamps hoursAhead to the 1–12 range", () => {
    const lk = lookupFrom({});
    expect(forecastUsage({ now: WED_NOON, hoursAhead: 99, lookup: lk }).hours)
      .toHaveLength(12);
    expect(forecastUsage({ now: WED_NOON, hoursAhead: 0, lookup: lk }).hours)
      .toHaveLength(1);
  });

  it("rolls past midnight and switches to the weekend heatmap", () => {
    // Friday 22:00 — +4h crosses into Saturday 02:00.
    const friNight = new Date(2026, 4, 15, 22, 0, 0);
    const seen: Array<[number, string]> = [];
    const lookup: HourWorkloadLookup = (hour, group) => {
      seen.push([hour, group]);
      return [];
    };
    forecastUsage({ now: friNight, hoursAhead: 4, lookup });
    expect(seen).toEqual([
      [23, "weekdays"], // Fri 23:00
      [0, "weekends"],  // Sat 00:00
      [1, "weekends"],  // Sat 01:00
      [2, "weekends"],  // Sat 02:00
    ]);
  });
});

// Usage-pattern forecasting (feature I5) — predict the next few hours'
// workload from the learned 7×24 usage heatmap in `usagePattern.ts`.
//
// Pure given its inputs: the heatmap lookup is injected (it defaults to
// `getHourWorkloads`), so the forecast logic is unit-testable without
// seeding global pattern state. Statistics over the observed heatmap, not
// a model — the same honest call as the rest of Phase 2. Not tier-gated.

import {
  getHourWorkloads,
  type DayGroup,
  type HourWorkload,
} from "./usagePattern";

export interface HourForecast {
  /** Clock hour being predicted (0–23, local time). */
  hour: number;
  /** Most likely workload type at that hour, or null if there is no data. */
  workload: string | null;
  /** 0..1 — the predicted workload's share of that hour's active time. */
  confidence: number;
}

export interface UsageForecast {
  /** One entry per forecast hour, earliest first. */
  hours: HourForecast[];
  /** The workload most likely to dominate the window, or null if unknown. */
  dominantWorkload: string | null;
  /** 0..1 — confidence in `dominantWorkload` across the whole window. */
  confidence: number;
}

/** Heatmap lookup signature — matches `getHourWorkloads`. Injectable. */
export type HourWorkloadLookup = (
  hour: number,
  group: DayGroup,
) => HourWorkload[];

const HOUR_MS = 3_600_000;

/** Weekday vs weekend bucket for a given date. */
function dayGroupFor(d: Date): DayGroup {
  const day = d.getDay();
  return day === 0 || day === 6 ? "weekends" : "weekdays";
}

export interface ForecastOptions {
  /** How many hours ahead to predict. Clamped to 1–12; default 4. */
  hoursAhead?: number;
  /** "Now" — injectable for deterministic tests. Defaults to the clock. */
  now?: Date;
  /** Heatmap lookup — injectable for tests. Defaults to the live heatmap. */
  lookup?: HourWorkloadLookup;
}

/**
 * Forecast the dominant workload for each of the next `hoursAhead` hours.
 *
 * Each future hour is bucketed into its own weekday/weekend group (so a
 * forecast that crosses midnight into Saturday correctly switches to the
 * weekend heatmap), then the heatmap's top workload for that hour-of-day
 * is taken as the prediction.
 */
export function forecastUsage(opts: ForecastOptions = {}): UsageForecast {
  const hoursAhead = Math.max(1, Math.min(12, Math.round(opts.hoursAhead ?? 4)));
  const now = opts.now ?? new Date();
  const lookup = opts.lookup ?? getHourWorkloads;

  const hours: HourForecast[] = [];
  // Sum of per-hour shares for each workload across the window.
  const score = new Map<string, number>();

  for (let i = 1; i <= hoursAhead; i++) {
    const at = new Date(now.getTime() + i * HOUR_MS);
    const hour = at.getHours();
    const ranked = lookup(hour, dayGroupFor(at));
    const top = ranked[0];
    if (!top || top.share <= 0) {
      hours.push({ hour, workload: null, confidence: 0 });
      continue;
    }
    hours.push({ hour, workload: top.type, confidence: top.share });
    score.set(top.type, (score.get(top.type) ?? 0) + top.share);
  }

  let dominantWorkload: string | null = null;
  let best = 0;
  for (const [type, s] of score) {
    if (s > best) {
      best = s;
      dominantWorkload = type;
    }
  }
  // Average the dominant workload's share over the FULL window, so a
  // workload predicted in only 1 of 4 hours scores a low confidence.
  const confidence = dominantWorkload ? best / hoursAhead : 0;

  return { hours, dominantWorkload, confidence };
}

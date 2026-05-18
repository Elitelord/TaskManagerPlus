// Battery-degradation forecast (feature M2) — predict months-to-X% capacity.
//
// `detectBatteryHealth` already reports *current* battery health (full-
// charge capacity / design capacity). M2 adds the forward view: fit a
// least-squares line through health readings logged over time and project
// when capacity will cross a target (default 80%).
//
// Per AI_INTEGRATION_PLAN.md this is "Lite (or no AI — pure regression)" —
// it is pure regression, no model, not tier-gated. The forecast logic is
// pure and unit-tested; a tiny localStorage log accumulates one health
// reading per day so the trend can be fitted as data builds up. New
// machines simply have no forecast yet — `hasTrend` is false until ~2
// weeks of readings exist, which is correct: battery wear is months-scale
// and a fit over a few days would be noise.

/** One battery-health reading. */
export interface HealthPoint {
  /** Unix milliseconds. */
  ts: number;
  /** full-charge / design capacity, as a percentage (0–100+). */
  healthPercent: number;
}

export interface BatteryForecast {
  /** Most recent health reading, percent. */
  currentHealth: number;
  /** Least-squares degradation rate in percentage points per 30 days.
   *  Negative = degrading (the normal case). */
  ratePerMonth: number;
  /** Months until health reaches `targetPercent`. `null` when not
   *  degrading, already past the target, or there is no usable trend. */
  monthsToTarget: number | null;
  /** False when there are too few readings, or they span too short a
   *  window, to fit a meaningful trend. */
  hasTrend: boolean;
}

const MIN_POINTS = 5;
const MIN_SPAN_DAYS = 14;
const DAY_MS = 86_400_000;

/**
 * Fit a degradation trend through `points` and project months to
 * `targetPercent`. Pure — `points` need not be sorted.
 */
export function forecastBatteryHealth(
  points: HealthPoint[],
  targetPercent = 80,
): BatteryForecast {
  const sorted = [...points].sort((a, b) => a.ts - b.ts);
  const currentHealth = sorted.length ? sorted[sorted.length - 1].healthPercent : 0;
  const blank: BatteryForecast = {
    currentHealth,
    ratePerMonth: 0,
    monthsToTarget: null,
    hasTrend: false,
  };

  if (sorted.length < MIN_POINTS) return blank;
  const spanDays = (sorted[sorted.length - 1].ts - sorted[0].ts) / DAY_MS;
  if (spanDays < MIN_SPAN_DAYS) return blank;

  // Least-squares slope of health (%) against time (days from first point).
  const t0 = sorted[0].ts;
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of sorted) {
    const x = (p.ts - t0) / DAY_MS;
    const y = p.healthPercent;
    n++; sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return blank;
  const slopePerDay = (n * sxy - sx * sy) / denom;
  const ratePerMonth = slopePerDay * 30;

  let monthsToTarget: number | null = null;
  if (currentHealth <= targetPercent) {
    monthsToTarget = 0;
  } else if (slopePerDay < 0) {
    // Days until the line drops from currentHealth to the target.
    monthsToTarget = (currentHealth - targetPercent) / -slopePerDay / 30;
  }
  // slopePerDay >= 0 (steady or — from reading noise — improving): leave null.

  return { currentHealth, ratePerMonth, monthsToTarget, hasTrend: true };
}

// --- Daily health log -------------------------------------------------------

const STORAGE_KEY = "taskmanagerplus-battery-health-log";
const MAX_SAMPLES = 400; // ~13 months of daily readings

/** UTC day index for a timestamp — used to keep one sample per day. */
function dayIndex(ts: number): number {
  return Math.floor(ts / DAY_MS);
}

/** Read the persisted health log, oldest-first. */
export function getBatteryHealthHistory(): HealthPoint[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (p): p is HealthPoint =>
          p && typeof p.ts === "number" && typeof p.healthPercent === "number",
      )
      .sort((a, b) => a.ts - b.ts);
  } catch {
    return [];
  }
}

/**
 * Record a health reading, keeping at most one sample per calendar day
 * (the latest reading for that day wins). No-op for an invalid reading.
 * Returns the updated log.
 */
export function recordBatteryHealthSample(
  healthPercent: number,
  now: number = Date.now(),
): HealthPoint[] {
  if (!Number.isFinite(healthPercent) || healthPercent <= 0) {
    return getBatteryHealthHistory();
  }
  const history = getBatteryHealthHistory();
  const today = dayIndex(now);
  const withoutToday = history.filter((p) => dayIndex(p.ts) !== today);
  withoutToday.push({ ts: now, healthPercent });
  const trimmed = withoutToday.slice(-MAX_SAMPLES);
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
    } catch {
      /* ignore quota / unavailable */
    }
  }
  return trimmed;
}

/**
 * Usage / schedule pattern tracker.
 *
 * Builds a long-running picture of *when* the user typically uses the system
 * and *when* they typically charge it. Persists 168 hour-of-week buckets
 * (7 days × 24 hours) to localStorage.
 *
 * Each bucket records:
 *   - `observed` — total seconds TM+ has been running in that slot
 *   - `charging` — of those, seconds the system was charging
 *   - `active`   — of those, seconds the CPU was above an "in-use" threshold
 *
 * From those buckets we derive:
 *   - "You typically charge weekdays 10 PM – 7 AM"
 *   - "You're typically active weekdays 9 AM – 5 PM"
 * plus a 7×24 heatmap that the Insights page renders as a tiny calendar.
 *
 * The tracker is fed from the insights engine on every snapshot tick so it
 * naturally piggybacks on the existing IPC stream — no extra backend work.
 */

import type { PerformanceSnapshot } from "./types";

const STORAGE_KEY = "taskmanagerplus.usagePattern.v1";

/** Clamp tick deltas so a long sleep doesn't dump 8 hours into one bucket. */
const MAX_TICK_SECONDS = 30;
/** CPU% above this counts the slot as "actively in use". */
const ACTIVE_CPU_THRESHOLD = 5;
/** Persist cadence (ms) — avoids hammering localStorage every 1s tick. */
const PERSIST_DEBOUNCE_MS = 30_000;
/** Need at least this much total observation time before patterns are shown.
 *  Lowered from 6 → 3 in v1.4.x: the old gate left the UI stuck in
 *  "Learning…" through most users' first day with the app. 3 h is enough
 *  for the per-slot averages to stabilize once they cross MIN_SLOT_SECONDS. */
const MIN_OBSERVATION_HOURS = 3;
/** A slot needs at least this many seconds of data before it can vote. */
const MIN_SLOT_SECONDS = 300;
/** Slot ratio threshold for the slot to count as "matched". */
const PATTERN_RATIO_THRESHOLD = 0.5;

interface HourBucket {
  /** Total observation time in this hour-of-week slot, in seconds. */
  observed: number;
  /** Of `observed`, time the system was charging. */
  charging: number;
  /** Of `observed`, time the system was in active use (CPU > threshold). */
  active: number;
  /**
   * Of `active`, seconds attributed to each detected workload type. Keyed by
   * the WorkloadType string (gaming / development / browsing / ...). Missing
   * keys mean zero. Optional in the schema so existing v1 buckets without
   * this field can be lazily upgraded on load. The sum across keys can be
   * less than `active` (e.g. ticks where no workload was assigned), which
   * is fine — we render shares relative to `active`, not relative to the
   * sum, so an "Other / undetected" remainder shows up naturally.
   */
  workloads?: Record<string, number>;
}

interface UsagePatternDB {
  version: 1;
  /** 168 buckets — index = dayOfWeek * 24 + hourOfDay, day 0 = Sunday. */
  buckets: HourBucket[];
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let db: UsagePatternDB = loadDb();
let lastTickMs = 0;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;

type Listener = () => void;
const listeners = new Set<Listener>();

function notify() {
  listeners.forEach(fn => fn());
}

function blankBuckets(): HourBucket[] {
  return Array.from({ length: 168 }, () => ({
    observed: 0,
    charging: 0,
    active: 0,
    workloads: {},
  }));
}

function loadDb(): UsagePatternDB {
  if (typeof localStorage === "undefined") {
    return { version: 1, buckets: blankBuckets() };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { version: 1, buckets: blankBuckets() };
    const parsed = JSON.parse(raw) as UsagePatternDB;
    if (
      !parsed ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.buckets) ||
      parsed.buckets.length !== 168
    ) {
      return { version: 1, buckets: blankBuckets() };
    }
    // Defensive: rebuild any malformed bucket entries; lazily upgrade older
    // (pre-workload) buckets by adding an empty workloads dict.
    for (let i = 0; i < 168; i++) {
      const b = parsed.buckets[i];
      if (
        !b ||
        typeof b.observed !== "number" ||
        typeof b.charging !== "number" ||
        typeof b.active !== "number"
      ) {
        parsed.buckets[i] = { observed: 0, charging: 0, active: 0, workloads: {} };
      } else if (!b.workloads || typeof b.workloads !== "object") {
        b.workloads = {};
      }
    }
    return parsed;
  } catch {
    return { version: 1, buckets: blankBuckets() };
  }
}

function schedulePersist() {
  dirty = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (!dirty) return;
    dirty = false;
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
      }
    } catch {
      // Quota / disabled storage — silently ignore; in-memory state still works.
    }
  }, PERSIST_DEBOUNCE_MS);
}

// ---------------------------------------------------------------------------
// Public API — feeding
// ---------------------------------------------------------------------------

/**
 * Feed the tracker with the current performance snapshot. Called from the
 * insights engine on every snapshot tick.
 *
 * `currentWorkloadType`, when supplied, is the dominant workload detected on
 * the previous analysis tick — it lags by ~1 tick which is irrelevant at
 * hour-level aggregation. Slot is only credited to a workload when the slot
 * also counts as "active" (CPU above threshold), so an idle session doesn't
 * pad a workload's hours.
 */
export function feedUsagePattern(
  snapshot: PerformanceSnapshot | undefined,
  currentWorkloadType?: string,
) {
  if (!snapshot) return;
  const now = Date.now();
  const prev = lastTickMs;
  lastTickMs = now;
  // First tick of this session — no delta yet.
  if (prev === 0) return;

  const delta = Math.min(Math.max((now - prev) / 1000, 0), MAX_TICK_SECONDS);
  if (delta <= 0) return;

  const date = new Date(now);
  const idx = date.getDay() * 24 + date.getHours();
  const bucket = db.buckets[idx];
  bucket.observed += delta;
  if (snapshot.is_charging) bucket.charging += delta;
  const isActive = snapshot.cpu_usage_percent > ACTIVE_CPU_THRESHOLD;
  if (isActive) bucket.active += delta;

  // Workload tally: only credit when both active AND a meaningful workload
  // was detected. "idle" / "mixed" / undefined never get attributed —
  // they'd just clutter the histogram.
  if (
    isActive
    && currentWorkloadType
    && currentWorkloadType !== "idle"
    && currentWorkloadType !== "mixed"
  ) {
    if (!bucket.workloads) bucket.workloads = {};
    bucket.workloads[currentWorkloadType] = (bucket.workloads[currentWorkloadType] || 0) + delta;
  }

  schedulePersist();
  notify();
}

// ---------------------------------------------------------------------------
// Public API — pattern derivation
// ---------------------------------------------------------------------------

export interface SchedulePattern {
  /** Human label for the day group: "Weekdays", "Weekends", "Everyday". */
  daysLabel: string;
  /** 0..6 day indexes (Sunday = 0). */
  daysList: number[];
  /** Inclusive start hour (0..23). */
  startHour: number;
  /** Exclusive end hour (0..24). May wrap (start > end means overnight). */
  endHour: number;
  /** Average ratio across the matched slots (0..1). */
  confidence: number;
}

export interface SchedulePatterns {
  /** Detected charging windows, ordered by day group. */
  charging: SchedulePattern[];
  /** Detected "in use" windows, ordered by day group. */
  active: SchedulePattern[];
  /** Total seconds observed across all slots. */
  totalObservedSeconds: number;
  /** True once enough data has accumulated to display anything meaningful. */
  ready: boolean;
}

const WEEKDAY_INDEXES = [1, 2, 3, 4, 5];
const WEEKEND_INDEXES = [0, 6];
const ALL_DAY_INDEXES = [0, 1, 2, 3, 4, 5, 6];

/**
 * Average each hour-of-day's metric across the given days, then walk the
 * 24-hour ring to find the longest contiguous run above
 * `PATTERN_RATIO_THRESHOLD`. Returns null if no run of at least 2 hours
 * matches.
 */
function detectWindow(
  metric: "charging" | "active",
  dayIndexes: number[],
): { startHour: number; endHour: number; confidence: number } | null {
  // Weighted average per hour.
  const sums = new Array<number>(24).fill(0);
  const weights = new Array<number>(24).fill(0);
  for (const d of dayIndexes) {
    for (let h = 0; h < 24; h++) {
      const b = db.buckets[d * 24 + h];
      if (!b || b.observed < MIN_SLOT_SECONDS) continue;
      const r = (metric === "charging" ? b.charging : b.active) / b.observed;
      sums[h] += r * b.observed;
      weights[h] += b.observed;
    }
  }

  const avg = sums.map((s, h) => (weights[h] > 0 ? s / weights[h] : -1));

  // Find the longest contiguous run above threshold, allowing wrap-around.
  let bestLen = 0;
  let bestStart = -1;
  let bestSum = 0;
  for (let start = 0; start < 24; start++) {
    let len = 0;
    let sum = 0;
    for (let k = 0; k < 24; k++) {
      const h = (start + k) % 24;
      if (avg[h] > PATTERN_RATIO_THRESHOLD) {
        len++;
        sum += avg[h];
      } else {
        break;
      }
    }
    if (len > bestLen) {
      bestLen = len;
      bestStart = start;
      bestSum = sum;
    }
  }
  if (bestLen < 2 || bestStart < 0) return null;
  return {
    startHour: bestStart,
    endHour: (bestStart + bestLen) % 24,
    confidence: bestSum / bestLen,
  };
}

/**
 * Returns true when the weekday and weekend windows look effectively the
 * same — same start, same length within ±1h. Used to collapse two patterns
 * into a single "Everyday" line for cleaner UI.
 */
function windowsAreSimilar(
  a: { startHour: number; endHour: number },
  b: { startHour: number; endHour: number },
): boolean {
  const lenA = (a.endHour - a.startHour + 24) % 24 || 24;
  const lenB = (b.endHour - b.startHour + 24) % 24 || 24;
  const startDiff = Math.min(
    Math.abs(a.startHour - b.startHour),
    24 - Math.abs(a.startHour - b.startHour),
  );
  return startDiff <= 1 && Math.abs(lenA - lenB) <= 1;
}

function deriveMetricPatterns(metric: "charging" | "active"): SchedulePattern[] {
  const wd = detectWindow(metric, WEEKDAY_INDEXES);
  const we = detectWindow(metric, WEEKEND_INDEXES);

  // Collapse to "Everyday" when both day groups agree.
  if (wd && we && windowsAreSimilar(wd, we)) {
    const all = detectWindow(metric, ALL_DAY_INDEXES);
    if (all) {
      return [
        {
          daysLabel: "Everyday",
          daysList: ALL_DAY_INDEXES,
          startHour: all.startHour,
          endHour: all.endHour,
          confidence: all.confidence,
        },
      ];
    }
  }

  const out: SchedulePattern[] = [];
  if (wd) {
    out.push({
      daysLabel: "Weekdays",
      daysList: WEEKDAY_INDEXES,
      startHour: wd.startHour,
      endHour: wd.endHour,
      confidence: wd.confidence,
    });
  }
  if (we) {
    out.push({
      daysLabel: "Weekends",
      daysList: WEEKEND_INDEXES,
      startHour: we.startHour,
      endHour: we.endHour,
      confidence: we.confidence,
    });
  }
  return out;
}

export function getSchedulePatterns(): SchedulePatterns {
  let total = 0;
  for (const b of db.buckets) total += b.observed;
  const ready = total >= MIN_OBSERVATION_HOURS * 3600;
  if (!ready) {
    return { charging: [], active: [], totalObservedSeconds: total, ready: false };
  }
  return {
    charging: deriveMetricPatterns("charging"),
    active: deriveMetricPatterns("active"),
    totalObservedSeconds: total,
    ready: true,
  };
}

export interface HourCell {
  observed: number;
  charging: number;
  active: number;
  /** charging / observed, or 0 if no data. */
  chargingRatio: number;
  /** active / observed, or 0 if no data. */
  activeRatio: number;
}

/**
 * Returns the full 7×24 grid for heatmap rendering. Outer index is day
 * (Sunday = 0), inner is hour-of-day (0..23).
 */
export function getHourGrid(): HourCell[][] {
  const grid: HourCell[][] = [];
  for (let d = 0; d < 7; d++) {
    const row: HourCell[] = [];
    for (let h = 0; h < 24; h++) {
      const b = db.buckets[d * 24 + h];
      const observed = b?.observed ?? 0;
      const charging = b?.charging ?? 0;
      const active = b?.active ?? 0;
      row.push({
        observed,
        charging,
        active,
        chargingRatio: observed > 0 ? charging / observed : 0,
        activeRatio: observed > 0 ? active / observed : 0,
      });
    }
    grid.push(row);
  }
  return grid;
}

/** Day-group filter used by the schedule strip + Phase 3 detectors. */
export type DayGroup = "all" | "weekdays" | "weekends";

const DAY_INDEXES_BY_GROUP: Record<DayGroup, number[]> = {
  all: ALL_DAY_INDEXES,
  weekdays: WEEKDAY_INDEXES,
  weekends: WEEKEND_INDEXES,
};

/**
 * Aggregate the 7×24 grid down to a 24-element-per-metric "typical day"
 * profile, weighted by observation time so an under-observed slot doesn't
 * skew the average. Used by the redesigned schedule strip in the UI and by
 * the routine-driven insight detectors.
 *
 * Returns ratios in [0, 1] plus the per-hour `observed` seconds so the UI
 * can grey out hours that have no data yet.
 */
export interface HourProfile {
  /** active / observed across the day group, weighted by observed time. */
  active: number[];   // 24 entries
  /** charging / observed across the day group, same weighting. */
  charging: number[]; // 24 entries
  /** Total observed seconds at each hour-of-day (across the day group). */
  observed: number[]; // 24 entries
}

export function getHourProfile(group: DayGroup = "all"): HourProfile {
  const days = DAY_INDEXES_BY_GROUP[group];
  const active = new Array<number>(24).fill(0);
  const charging = new Array<number>(24).fill(0);
  const observed = new Array<number>(24).fill(0);

  for (let h = 0; h < 24; h++) {
    let aSum = 0, cSum = 0, w = 0;
    for (const d of days) {
      const b = db.buckets[d * 24 + h];
      if (!b || b.observed <= 0) continue;
      aSum += b.active;
      cSum += b.charging;
      w += b.observed;
    }
    observed[h] = w;
    active[h]   = w > 0 ? aSum / w : 0;
    charging[h] = w > 0 ? cSum / w : 0;
  }
  return { active, charging, observed };
}

/**
 * What workloads were active at a given hour-of-day, aggregated across the
 * selected day group and weighted by `active` time. `share` is each
 * workload's fraction of the *active* seconds at that hour (so the values
 * sum to ≤ 1; the remainder is "active but no workload was assigned").
 *
 * Returned list is sorted by share descending. Callers pick the top N.
 */
export interface HourWorkload {
  type: string;
  seconds: number;
  share: number;
}

export function getHourWorkloads(hour: number, group: DayGroup = "all"): HourWorkload[] {
  const days = DAY_INDEXES_BY_GROUP[group];
  const totals = new Map<string, number>();
  let activeTotal = 0;
  for (const d of days) {
    const b = db.buckets[d * 24 + hour];
    if (!b) continue;
    activeTotal += b.active;
    if (!b.workloads) continue;
    for (const [type, secs] of Object.entries(b.workloads)) {
      totals.set(type, (totals.get(type) || 0) + secs);
    }
  }
  if (activeTotal <= 0) return [];

  const out: HourWorkload[] = [];
  for (const [type, seconds] of totals) {
    out.push({ type, seconds, share: seconds / activeTotal });
  }
  out.sort((a, b) => b.share - a.share);
  return out;
}

/**
 * Classify the *current* hour against the user's learned routine, scoped to
 * "today's day group" (weekday vs weekend). Used by Phase 3 detectors to
 * decide whether ongoing power draw is happening during a typical active
 * window or a typical inactive window.
 *
 * Returns "unknown" when there isn't enough observation time at this hour
 * yet (under MIN_SLOT_SECONDS) — callers should treat that as "don't fire."
 */
export type RoutineState = "active" | "inactive" | "neutral" | "unknown";

export function classifyCurrentHour(): RoutineState {
  const now = new Date();
  const isWeekend = now.getDay() === 0 || now.getDay() === 6;
  const profile = getHourProfile(isWeekend ? "weekends" : "weekdays");
  const h = now.getHours();
  const w = profile.observed[h];
  if (w < MIN_SLOT_SECONDS) return "unknown";
  const a = profile.active[h];
  if (a >= 0.55) return "active";
  if (a <= 0.20) return "inactive";
  return "neutral";
}

/** Reset all collected pattern data. Wired to a "clear" action if needed. */
export function resetUsagePattern() {
  db = { version: 1, buckets: blankBuckets() };
  lastTickMs = 0;
  dirty = true;
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }
  notify();
}

export function subscribeUsagePattern(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers (used by both the engine summary and the UI)
// ---------------------------------------------------------------------------

export function formatHour12(h: number): string {
  const hour = ((h % 24) + 24) % 24;
  if (hour === 0) return "12 AM";
  if (hour === 12) return "12 PM";
  if (hour < 12) return `${hour} AM`;
  return `${hour - 12} PM`;
}

export function formatHourRange(startHour: number, endHour: number): string {
  return `${formatHour12(startHour)} – ${formatHour12(endHour)}`;
}

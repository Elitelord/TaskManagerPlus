// Generic 1-D anomaly detector (feature I4) — pure, framework-free, testable.
//
// Answers "is this reading unusual *for this user*?" against a rolling
// baseline of recent values. Used to replace global fixed thresholds with
// a per-user baseline ("your disk queue is normally 0–1 but is 8 now").
//
// Per AI_INTEGRATION_PLAN.md the brief was "statistical baseline first, add
// a classifier head only if needed" — this is the statistical baseline,
// and it is sufficient. The method is the **median / MAD modified
// z-score**, chosen over mean/stddev because it is resistant to outliers:
// a metric that spiked an hour ago must not poison the baseline that
// judges the spike happening now. No model, not tier-gated.

export interface AnomalyOptions {
  /** Minimum baseline samples before a verdict is possible. Default 20. */
  minSamples?: number;
  /** |modified z-score| at/above which a value is anomalous. Default 3.5. */
  threshold?: number;
  /** Deviations smaller than this (absolute units) are never flagged, no
   *  matter how statistically large — filters out trivial wobble on a very
   *  steady metric. Default 0 (pure statistical). */
  minDelta?: number;
}

export interface AnomalyVerdict {
  /** True when `current` is unusual versus the baseline. */
  anomalous: boolean;
  /** Which way it deviates — `"normal"` when not anomalous. */
  direction: "high" | "low" | "normal";
  /** |modified z-score| — 0 when there is no usable baseline. */
  score: number;
  /** Baseline center (median). */
  median: number;
  /** False when there were too few samples, or the baseline is too flat
   *  to judge variance — callers should treat this as "no opinion". */
  hasBaseline: boolean;
}

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = n >> 1;
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stddev(values: number[], mean: number): number {
  if (values.length === 0) return 0;
  const variance =
    values.reduce((s, x) => s + (x - mean) * (x - mean), 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Judge `current` against `baseline` (the recent history, NOT including
 * `current` — the current reading must never inflate its own baseline).
 */
export function detectAnomaly(
  baseline: number[],
  current: number,
  opts: AnomalyOptions = {},
): AnomalyVerdict {
  const minSamples = opts.minSamples ?? 20;
  const threshold = opts.threshold ?? 3.5;
  const minDelta = opts.minDelta ?? 0;

  if (baseline.length < minSamples) {
    return { anomalous: false, direction: "normal", score: 0, median: current, hasBaseline: false };
  }

  const sorted = [...baseline].sort((a, b) => a - b);
  const med = median(sorted);
  const absDevs = sorted.map((x) => Math.abs(x - med)).sort((a, b) => a - b);
  const mad = median(absDevs);

  // Spread estimate: scaled MAD, or plain stddev when MAD collapses to 0
  // (e.g. >half the baseline shares one value).
  let sigma = mad > 0 ? mad * 1.4826 : 0;
  if (sigma === 0) {
    const mean = baseline.reduce((s, x) => s + x, 0) / baseline.length;
    sigma = stddev(baseline, mean);
  }

  const delta = current - med;

  // Perfectly flat baseline — no variance to compare against. Only an
  // explicit absolute floor can decide; without one, give no opinion.
  if (sigma === 0) {
    if (minDelta > 0 && Math.abs(delta) >= minDelta) {
      return {
        anomalous: true,
        direction: delta > 0 ? "high" : "low",
        score: threshold,
        median: med,
        hasBaseline: true,
      };
    }
    return { anomalous: false, direction: "normal", score: 0, median: med, hasBaseline: false };
  }

  const z = delta / sigma;
  const anomalous = Math.abs(z) >= threshold && Math.abs(delta) >= minDelta;
  return {
    anomalous,
    direction: anomalous ? (z > 0 ? "high" : "low") : "normal",
    score: Math.abs(z),
    median: med,
    hasBaseline: true,
  };
}

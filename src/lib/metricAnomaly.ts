// Per-metric anomaly highlight (feature M1) — pure, framework-free, testable.
//
// Wraps the I4 anomaly detector (`anomalyDetector.ts`) for the performance
// pages: given the rolling snapshot history, decide whether a metric's
// current reading is unusual *for this machine* and produce a short badge
// label. Replaces "global fixed threshold" judgements with a per-user
// baseline ("your disk queue is normally 0–1 but is 8 right now").
//
// Scope note (spike S-9, see docs/AI_INTEGRATION_PLAN.md §7.8): the
// baseline is the in-memory perf-history ring buffer — on the order of a
// minute of samples, not a multi-day "learned" baseline. That is what is
// available without a new persistence layer, and it still catches a
// genuine spike against recent activity. A long-horizon persisted baseline
// is a deferred enhancement. Statistics, not a model; not tier-gated.

import type { PerformanceSnapshot } from "./types";
import { detectAnomaly, type AnomalyVerdict } from "./anomalyDetector";

/** A metric M1 watches, with the absolute floor below which a deviation is
 *  too trivial to badge (passed to `detectAnomaly` as `minDelta`). */
export interface MetricSpec {
  key: string;
  label: string;
  unit: string;
  minDelta: number;
}

export const WATCHED_METRICS: MetricSpec[] = [
  { key: "cpu",      label: "CPU usage",     unit: "%",    minDelta: 15 },
  { key: "memory",   label: "Memory usage",  unit: "%",    minDelta: 10 },
  { key: "diskBusy", label: "Disk activity", unit: "%",    minDelta: 20 },
  { key: "diskQueue",label: "Disk queue",    unit: "",     minDelta: 2 },
  { key: "network",  label: "Network",       unit: " MB/s", minDelta: 5 },
  { key: "gpu",      label: "GPU usage",     unit: "%",    minDelta: 20 },
];

const BY_KEY: Record<string, MetricSpec> = Object.fromEntries(
  WATCHED_METRICS.map((m) => [m.key, m]),
);

/** Pull a single watched metric's scalar value out of a snapshot. */
export function extractMetric(s: PerformanceSnapshot, key: string): number {
  switch (key) {
    case "cpu":      return s.cpu_usage_percent;
    case "memory":
      return s.total_ram_bytes > 0
        ? (s.used_ram_bytes / s.total_ram_bytes) * 100
        : 0;
    case "diskBusy": return s.disk_active_percent;
    case "diskQueue":return s.disk_queue_length;
    case "network":  return (s.net_send_per_sec + s.net_recv_per_sec) / 1_000_000;
    case "gpu":      return s.gpu_usage_percent;
    default:         return 0;
  }
}

export interface MetricAnomaly {
  spec: MetricSpec;
  verdict: AnomalyVerdict;
  /** Current reading (the last value in the series). */
  current: number;
}

/**
 * Analyze one metric's recent series. The series is oldest-to-newest and
 * its LAST element is the current reading; everything before it is the
 * baseline (so the current value never inflates its own baseline).
 */
export function analyzeMetric(series: number[], spec: MetricSpec): MetricAnomaly {
  const current = series.length > 0 ? series[series.length - 1] : 0;
  const baseline = series.slice(0, -1);
  const verdict = detectAnomaly(baseline, current, { minDelta: spec.minDelta });
  return { spec, verdict, current };
}

/**
 * Run every watched metric over a snapshot history and return only the
 * ones currently anomalous. `history` is oldest-to-newest.
 */
export function detectMetricAnomalies(
  history: PerformanceSnapshot[],
): MetricAnomaly[] {
  const out: MetricAnomaly[] = [];
  for (const spec of WATCHED_METRICS) {
    const series = history.map((s) => extractMetric(s, spec.key));
    const m = analyzeMetric(series, spec);
    if (m.verdict.anomalous) out.push(m);
  }
  return out;
}

/** Short badge tooltip, e.g. "CPU usage is unusually high — normally ~12%,
 *  now 84%." `null` when the metric is not anomalous. */
export function describeAnomaly(m: MetricAnomaly): string | null {
  if (!m.verdict.anomalous) return null;
  const { spec, verdict, current } = m;
  const dir = verdict.direction === "high" ? "high" : "low";
  const fmt = (n: number) =>
    Number.isInteger(n) ? `${n}` : n.toFixed(n < 10 ? 1 : 0);
  return (
    `${spec.label} is unusually ${dir} — normally ~${fmt(verdict.median)}` +
    `${spec.unit}, now ${fmt(current)}${spec.unit}.`
  );
}

/** Look up a metric spec by key (for callers wiring a single badge). */
export function metricSpec(key: string): MetricSpec | undefined {
  return BY_KEY[key];
}

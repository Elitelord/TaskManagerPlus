// M1 — "unusual for you" badge for a performance-page metric.
//
// Reads the rolling snapshot history, runs the I4 anomaly detector
// (`metricAnomaly.ts`) for one metric, and renders a small amber badge
// only when the current reading is genuinely unusual against the
// machine's recent baseline. Renders nothing otherwise.

import type { PerformanceSnapshot } from "../lib/types";
import {
  analyzeMetric,
  describeAnomaly,
  extractMetric,
  metricSpec,
} from "../lib/metricAnomaly";

interface Props {
  /** Watched-metric key — see `WATCHED_METRICS` in `metricAnomaly.ts`. */
  metricKey: string;
  /** Rolling perf history, oldest-first. Each entry carries a `.snapshot`. */
  history: { snapshot: PerformanceSnapshot }[];
}

export function MetricAnomalyBadge({ metricKey, history }: Props) {
  const spec = metricSpec(metricKey);
  if (!spec) return null;

  const series = history.map((h) => extractMetric(h.snapshot, metricKey));
  const anomaly = analyzeMetric(series, spec);
  if (!anomaly.verdict.anomalous) return null;

  return (
    <span className="anomaly-badge" title={describeAnomaly(anomaly) ?? ""}>
      unusual for you
    </span>
  );
}

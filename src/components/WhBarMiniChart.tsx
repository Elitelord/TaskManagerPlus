import { useMemo } from "react";

interface Props {
  values: number[];
  /** Short labels under bars (e.g. hour "14" or day "Mon") */
  labels?: string[];
  color?: string;
  height?: number;
  unit?: string;
}

export function WhBarMiniChart({ values, labels, color = "#a78bfa", height = 88, unit = "Wh" }: Props) {
  const max = useMemo(() => Math.max(...values, 0.0001), [values]);
  const n = values.length || 1;
  // Use a normalized viewBox width so bars naturally stretch to fill the container width.
  // Each bar takes 10 units plus a 2-unit gap.
  const BAR_UNIT = 10;
  const GAP_UNIT = 2;
  const vbWidth = n * BAR_UNIT + (n - 1) * GAP_UNIT;
  const vbHeight = height + 22;

  return (
    <div className="wh-mini-chart" style={{ width: "100%" }}>
      <svg
        width="100%"
        height={vbHeight}
        viewBox={`0 0 ${vbWidth} ${vbHeight}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Energy bar chart"
        style={{ display: "block" }}
      >
        {values.map((v, i) => {
          const h = max > 0 ? (v / max) * (height - 4) : 0;
          const x = i * (BAR_UNIT + GAP_UNIT);
          const y = height - h;
          return (
            <rect
              key={i}
              x={x}
              y={y}
              width={BAR_UNIT}
              height={Math.max(h, 0)}
              rx={1.5}
              fill={color}
              opacity={v > 0 ? 0.9 : 0.12}
            />
          );
        })}
      </svg>
      {labels && labels.some((l) => l && l.length > 0) && (
        <div className="wh-mini-chart-labels">
          {labels.map((l, i) => (
            <span key={i} className="wh-mini-chart-label">{l}</span>
          ))}
        </div>
      )}
      <div className="estimate-note" style={{ marginTop: 6 }}>
        Peak {max.toFixed(2)} {unit} · Total {values.reduce((s, x) => s + x, 0).toFixed(2)} {unit}
      </div>
    </div>
  );
}

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
  const gap = 2;
  const barW = useMemo(() => Math.max(3, Math.min(14, Math.floor((280 - (n - 1) * gap) / n))), [n]);

  return (
    <div className="wh-mini-chart" style={{ width: "100%", maxWidth: 320 }}>
      <svg
        width="100%"
        height={height + 22}
        viewBox={`0 0 ${n * (barW + gap)} ${height + 22}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Energy bar chart"
      >
        {values.map((v, i) => {
          const h = max > 0 ? (v / max) * (height - 4) : 0;
          const x = i * (barW + gap);
          const y = height - h;
          return (
            <g key={i}>
              <rect
                x={x}
                y={y}
                width={barW}
                height={Math.max(h, 0)}
                rx={2}
                fill={color}
                opacity={v > 0 ? 0.9 : 0.12}
              />
              {labels && labels[i] !== undefined && (
                <text
                  x={x + barW / 2}
                  y={height + 12}
                  textAnchor="middle"
                  fill="var(--text-muted)"
                  fontSize="8"
                  fontFamily="system-ui, sans-serif"
                >
                  {labels[i]}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="estimate-note" style={{ marginTop: 4 }}>
        Peak {max.toFixed(2)} {unit} · Total {values.reduce((s, x) => s + x, 0).toFixed(2)} {unit}
      </div>
    </div>
  );
}

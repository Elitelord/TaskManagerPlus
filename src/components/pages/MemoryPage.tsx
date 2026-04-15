import { useMemo } from "react";
import { usePerformanceData } from "../../hooks/usePerformanceData";
import { ResourceGraph } from "../ResourceGraph";
import { useSettings } from "../../lib/settings";

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function UsageBar({ label, used, total, color, unit = "GB" }: {
  label: string; used: number; total: number; color: string; unit?: string;
}) {
  const pct = total > 0 ? (used / total) * 100 : 0;
  const status = pct > 90 ? "critical" : pct > 75 ? "warn" : "ok";
  const statusColors = { critical: "#ef4444", warn: "#f59e0b", ok: color };
  const barColor = statusColors[status];

  return (
    <div className="usage-bar-row">
      <div className="usage-bar-header">
        <span className="usage-bar-label">{label}</span>
        <span className="usage-bar-values" style={{ color: barColor }}>
          {used.toFixed(1)} / {total.toFixed(1)} {unit}
        </span>
      </div>
      <div className="usage-bar-track">
        <div
          className="usage-bar-fill"
          style={{ width: `${Math.min(pct, 100)}%`, background: barColor }}
        />
      </div>
      <span className="usage-bar-pct" style={{ color: barColor }}>{pct.toFixed(0)}%</span>
    </div>
  );
}

type PressureLevel = "critical" | "high" | "moderate" | "low";

const PRESSURE_RANK: Record<PressureLevel, number> = {
  low: 0,
  moderate: 1,
  high: 2,
  critical: 3,
};

function pressureFromAvailRam(availPct: number): PressureLevel {
  if (availPct < 5) return "critical";
  if (availPct < 15) return "high";
  if (availPct < 30) return "moderate";
  return "low";
}

/** Virtual commit (RAM + paging pool) can be tight while physical RAM still looks fine. */
function pressureFromCommitRatio(ratio: number): PressureLevel | null {
  if (ratio >= 0.95) return "critical";
  if (ratio >= 0.85) return "high";
  if (ratio >= 0.75) return "moderate";
  return null;
}

function mergePressure(ram: PressureLevel, commit: PressureLevel | null): PressureLevel {
  if (!commit) return ram;
  return PRESSURE_RANK[commit] > PRESSURE_RANK[ram] ? commit : ram;
}

const PRESSURE_CONFIG: Record<PressureLevel, { label: string; color: string; desc: string }> = {
  critical: {
    label: "Critical",
    color: "#ef4444",
    desc: "RAM is critically low or virtual commit is near the system limit. Close applications or add RAM/page file capacity.",
  },
  high: {
    label: "High",
    color: "#f59e0b",
    desc: "Low available RAM and/or high committed memory versus the commit limit. The system may struggle to satisfy new virtual allocations.",
  },
  moderate: {
    label: "Moderate",
    color: "#3b82f6",
    desc: "Memory headroom is reduced. Normal under load, but watch commit usage if the bar below is high.",
  },
  low: {
    label: "Low",
    color: "#34d399",
    desc: "Plenty of physical RAM available and commit usage is comfortable.",
  },
};

export function MemoryPage() {
  const { current, historyRef, generationRef } = usePerformanceData();
  const [settings] = useSettings();
  const accent = settings.accentColor;

  const derived = useMemo(() => {
    if (!current) return null;

    const totalGb = current.total_ram_bytes / (1024 ** 3);
    const usedGb = current.used_ram_bytes / (1024 ** 3);
    const availGb = current.available_ram_bytes / (1024 ** 3);
    const cachedGb = current.cached_bytes / (1024 ** 3);
    const usedPct = (current.used_ram_bytes / current.total_ram_bytes) * 100;
    const availPct = (current.available_ram_bytes / current.total_ram_bytes) * 100;

    const committedGb = current.committed_bytes / (1024 ** 3);
    const commitLimitGb = current.commit_limit_bytes / (1024 ** 3);
    const commitRatio = current.commit_limit_bytes > 0
      ? current.committed_bytes / current.commit_limit_bytes
      : 0;

    const ramPressure = pressureFromAvailRam(availPct);
    const commitPressure = pressureFromCommitRatio(commitRatio);
    const pressure = mergePressure(ramPressure, commitPressure);

    const arr = historyRef.current?.toArray() ?? [];
    const latest = arr[arr.length - 1];
    const topMem = latest?.topMem ?? [];

    const segments: { label: string; value: number; color: string }[] = [
      { label: "In Use", value: usedGb - cachedGb, color: accent },
      { label: "Cached", value: cachedGb, color: hexToRgba(accent, 0.4) },
      { label: "Available", value: availGb, color: "rgba(255,255,255,0.08)" },
    ].filter(s => s.value > 0);

    return {
      totalGb,
      usedPct,
      committedGb,
      commitLimitGb,
      pressure,
      topMem,
      segments,
    };
  }, [current, accent, historyRef]);

  if (!current || derived === null) {
    return <div className="loading-overlay">Initializing Memory metrics...</div>;
  }

  const formatGb = (bytes: number) => (bytes / (1024 ** 3)).toFixed(1) + " GB";

  const {
    totalGb,
    usedPct,
    committedGb,
    commitLimitGb,
    pressure,
    topMem,
    segments,
  } = derived;

  const pConfig = PRESSURE_CONFIG[pressure];

  return (
    <div className="resource-page">
      <div className="page-header">
        <div className="header-main">
          <h2>Memory</h2>
          <div className="header-meta">
            <span className="meta-item">Used: <strong>{formatGb(current.used_ram_bytes)}</strong></span>
            <span className="meta-item">Available: <strong>{formatGb(current.available_ram_bytes)}</strong></span>
            <span className="meta-item">Utilization: <strong>{usedPct.toFixed(1)}%</strong></span>
          </div>
        </div>
      </div>

      <div className="page-content">
        <div className="graph-section">
          <ResourceGraph
            metric="memory"
            label="Memory Usage"
            color="#45d483"
            fillColor="rgba(69,212,131,0.15)"
            historyRef={historyRef}
            generationRef={generationRef}
          />
        </div>

        <div className="info-panel">
          <h3 className="section-title">Memory Composition</h3>
          <div className="composition-bar">
            {segments.map((seg, i) => (
              <div
                key={i}
                className="composition-segment"
                style={{
                  width: `${(seg.value / totalGb) * 100}%`,
                  background: seg.color,
                }}
                title={`${seg.label}: ${seg.value.toFixed(1)} GB`}
              />
            ))}
          </div>
          <div className="composition-legend">
            {segments.map((seg, i) => (
              <div key={i} className="composition-legend-item">
                <span className="legend-dot" style={{ background: seg.color, border: seg.label === "Available" ? "1px solid rgba(255,255,255,0.15)" : "none" }} />
                <span className="legend-name">{seg.label}</span>
                <span className="legend-value">{seg.value.toFixed(1)} GB</span>
              </div>
            ))}
          </div>
        </div>

        <div className="two-col-grid">
          <div className="info-panel">
            <h3 className="section-title">Memory Status</h3>

            <div className="mem-pressure-card" style={{ background: `${pConfig.color}0a`, borderColor: `${pConfig.color}33` }}>
              <div className="mem-pressure-header">
                <span className="mem-pressure-label">Overall memory pressure</span>
                <span className="mem-pressure-badge" style={{ color: pConfig.color, background: `${pConfig.color}1a` }}>
                  {pConfig.label}
                </span>
              </div>
              <p className="mem-pressure-desc">{pConfig.desc}</p>
            </div>

            {commitLimitGb > 0.1 && (
              <UsageBar
                label="Committed memory (vs. commit limit)"
                used={Math.min(committedGb, commitLimitGb)}
                total={commitLimitGb}
                color="#a78bfa"
              />
            )}
          </div>

          <div className="info-panel">
            <h3 className="section-title">Top Memory Consumers</h3>
            <div className="top-consumers-list">
              {topMem.slice(0, 6).map((proc: { name: string; value: number }, i: number) => (
                <div key={i} className="consumer-row">
                  <span className="consumer-name">{proc.name}</span>
                  <div className="consumer-bar-track">
                    <div
                      className="consumer-bar-fill"
                      style={{
                        width: `${Math.min((proc.value / (totalGb * 1024)) * 100, 100)}%`,
                        background: accent,
                      }}
                    />
                  </div>
                  <span className="consumer-value">{proc.value >= 1024 ? `${(proc.value / 1024).toFixed(1)} GB` : `${proc.value.toFixed(0)} MB`}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

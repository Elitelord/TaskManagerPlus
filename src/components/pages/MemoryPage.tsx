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

export function MemoryPage() {
  const { current, historyRef } = usePerformanceData();
  const [settings] = useSettings();
  const accent = settings.accentColor;

  if (!current) return <div className="loading-overlay">Initializing Memory metrics...</div>;

  const formatGb = (bytes: number) => (bytes / (1024 ** 3)).toFixed(1) + " GB";

  const totalGb = current.total_ram_bytes / (1024 ** 3);
  const usedGb = current.used_ram_bytes / (1024 ** 3);
  const availGb = current.available_ram_bytes / (1024 ** 3);
  const cachedGb = current.cached_bytes / (1024 ** 3);
  const usedPct = (current.used_ram_bytes / current.total_ram_bytes) * 100;

  const committedGb = current.committed_bytes / (1024 ** 3);
  const commitLimitGb = current.commit_limit_bytes / (1024 ** 3);
  const swapUsedGb = Math.max(0, committedGb - usedGb);
  const swapTotalGb = commitLimitGb - totalGb;

  // Memory pressure indicator
  const availPct = (current.available_ram_bytes / current.total_ram_bytes) * 100;
  const pressure = availPct < 5 ? "critical" : availPct < 15 ? "high" : availPct < 30 ? "moderate" : "low";
  const pressureConfig = {
    critical: { label: "Critical", color: "#ef4444", desc: "System may become unresponsive. Close applications immediately." },
    high: { label: "High", color: "#f59e0b", desc: "Running low on memory. Consider closing unused applications." },
    moderate: { label: "Moderate", color: "#3b82f6", desc: "Memory usage is moderate. System is running normally." },
    low: { label: "Low", color: "#34d399", desc: "Plenty of memory available. System is running optimally." },
  };
  const pConfig = pressureConfig[pressure];

  const segments = [
    { label: "In Use", value: usedGb - cachedGb, color: accent },
    { label: "Cached", value: cachedGb, color: hexToRgba(accent, 0.4) },
    { label: "Available", value: availGb, color: "rgba(255,255,255,0.08)" },
  ].filter(s => s.value > 0);

  const arr = historyRef.current?.toArray() ?? [];
  const latest = arr[arr.length - 1];
  const topMem = latest?.topMem ?? [];

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
          <ResourceGraph metric="memory" label="Memory Usage" color="#45d483" fillColor="rgba(69,212,131,0.15)" />
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

            {/* Pressure indicator */}
            <div className="mem-pressure-card" style={{ background: `${pConfig.color}0a`, borderColor: `${pConfig.color}33` }}>
              <div className="mem-pressure-header">
                <span className="mem-pressure-label">Memory Pressure</span>
                <span className="mem-pressure-badge" style={{ color: pConfig.color, background: `${pConfig.color}1a` }}>
                  {pConfig.label}
                </span>
              </div>
              <p className="mem-pressure-desc">{pConfig.desc}</p>
            </div>

            {/* Virtual memory / swap bar */}
            {swapTotalGb > 0.1 && (
              <UsageBar
                label="Page File (Swap)"
                used={Math.max(0, swapUsedGb)}
                total={swapTotalGb}
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

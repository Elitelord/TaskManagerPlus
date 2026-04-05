import { usePerformanceData } from "../../hooks/usePerformanceData";
import { ResourceGraph } from "../ResourceGraph";
import { useSettings } from "../../lib/settings";

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function MemoryPage() {
  const { current, historyRef } = usePerformanceData();
  const [settings] = useSettings();
  const accent = settings.accentColor;

  if (!current) return <div className="loading-overlay">Initializing Memory metrics...</div>;

  const formatGb = (bytes: number) => (bytes / (1024 ** 3)).toFixed(1) + " GB";
  const formatMb = (bytes: number) => (bytes / (1024 ** 2)).toFixed(0) + " MB";

  const totalGb = current.total_ram_bytes / (1024 ** 3);
  const usedGb = current.used_ram_bytes / (1024 ** 3);
  const availGb = current.available_ram_bytes / (1024 ** 3);
  const cachedGb = current.cached_bytes / (1024 ** 3);
  const usedPct = (current.used_ram_bytes / current.total_ram_bytes) * 100;

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
            <h3 className="section-title">Details</h3>
            <div className="spec-row"><span className="label">Committed</span> <span className="value">{formatGb(current.committed_bytes)} / {formatGb(current.commit_limit_bytes)}</span></div>
            <div className="spec-row"><span className="label">Cached</span> <span className="value">{formatGb(current.cached_bytes)}</span></div>
            <div className="spec-row"><span className="label">Paged pool</span> <span className="value">{formatMb(current.paged_pool_bytes)}</span></div>
            <div className="spec-row"><span className="label">Non-paged pool</span> <span className="value">{formatMb(current.non_paged_pool_bytes)}</span></div>
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
                        background: "var(--accent-green)",
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

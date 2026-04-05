import { usePerformanceData } from "../../hooks/usePerformanceData";
import { ResourceGraph } from "../ResourceGraph";
import { useSettings } from "../../lib/settings";

export function GpuPage() {
  const { current } = usePerformanceData();
  const [settings] = useSettings();

  if (!current) return <div className="loading-overlay">Initializing GPU metrics...</div>;

  const formatGb = (bytes: number) => (bytes / (1024 ** 3)).toFixed(1) + " GB";
  const formatMb = (bytes: number) => (bytes / (1024 ** 2)).toFixed(0) + " MB";

  const formatTemp = (celsius: number) => {
    if (settings.temperatureUnit === "fahrenheit") {
      return `${(celsius * 9 / 5 + 32).toFixed(0)}°F`;
    }
    return `${celsius.toFixed(0)}°C`;
  };

  const vramTotal = current.gpu_memory_total;
  const vramUsed = current.gpu_memory_used;
  const vramFree = vramTotal > vramUsed ? vramTotal - vramUsed : 0;
  const vramPct = vramTotal > 0 ? Math.min((vramUsed / vramTotal) * 100, 100) : 0;

  return (
    <div className="resource-page">
      <div className="page-header">
        <div className="header-main">
          <h2>GPU</h2>
          <div className="header-meta">
            <span className="meta-item">Utilization: <strong>{current.gpu_usage_percent.toFixed(1)}%</strong></span>
            <span className="meta-item">Temp: <strong>{formatTemp(current.gpu_temperature)}</strong></span>
            <span className="meta-item">VRAM: <strong>{formatGb(vramUsed)} / {formatGb(vramTotal)}</strong></span>
          </div>
        </div>
      </div>

      <div className="page-content">
        <div className="graph-section">
          <ResourceGraph metric="gpu" label="GPU Usage" color="#ffd600" fillColor="rgba(255,214,0,0.15)" />
        </div>

        <div className="two-col-grid">
          <div className="info-panel">
            <h3 className="section-title">VRAM Usage</h3>
            <div className="composition-bar">
              <div
                className="composition-segment"
                style={{ width: `${vramPct}%`, background: "var(--accent-yellow)" }}
                title={`Used: ${formatGb(vramUsed)}`}
              />
              <div
                className="composition-segment"
                style={{ width: `${100 - vramPct}%`, background: "rgba(255,255,255,0.08)" }}
                title={`Free: ${formatGb(vramFree)}`}
              />
            </div>
            <div className="composition-legend">
              <div className="composition-legend-item">
                <span className="legend-dot" style={{ background: "var(--accent-yellow)" }} />
                <span className="legend-name">Used</span>
                <span className="legend-value">{vramUsed > 1024 ** 3 ? formatGb(vramUsed) : formatMb(vramUsed)}</span>
              </div>
              <div className="composition-legend-item">
                <span className="legend-dot" style={{ background: "rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.15)" }} />
                <span className="legend-name">Free</span>
                <span className="legend-value">{vramFree > 1024 ** 3 ? formatGb(vramFree) : formatMb(vramFree)}</span>
              </div>
            </div>
          </div>

          <div className="info-panel">
            <h3 className="section-title">Details</h3>
            <div className="spec-row"><span className="label">GPU utilization</span> <span className="value">{current.gpu_usage_percent.toFixed(1)}%</span></div>
            <div className="spec-row"><span className="label">Temperature</span> <span className="value">{formatTemp(current.gpu_temperature)}</span></div>
            <div className="spec-row"><span className="label">Dedicated memory</span> <span className="value">{formatGb(vramTotal)}</span></div>
            <div className="spec-row"><span className="label">Memory used</span> <span className="value">{vramPct.toFixed(1)}%</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}

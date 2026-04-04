import { usePerformanceData } from "../../hooks/usePerformanceData";
import { ResourceGraph } from "../ResourceGraph";

export function GpuPage() {
  const { current } = usePerformanceData();

  if (!current) return <div className="loading-overlay">Initializing GPU metrics...</div>;

  const formatGb = (bytes: number) => (bytes / (1024 ** 3)).toFixed(1) + " GB";

  return (
    <div className="resource-page">
      <div className="page-header">
        <div className="header-main">
          <h2>GPU Performance</h2>
          <div className="header-meta">
            <span className="meta-item">Utilization: <strong>{current.gpu_usage_percent.toFixed(1)}%</strong></span>
            <span className="meta-item">Temp: <strong>{current.gpu_temperature.toFixed(0)}°C</strong></span>
          </div>
        </div>
      </div>

      <div className="page-content">
        <div className="graph-section">
          <ResourceGraph metric="gpu" height={250} label="Total Usage (%)" color="#ffd600" fillColor="rgba(255,214,0,0.15)" />
        </div>

        <div className="gpu-details-grid">
          <div className="detail-card">
            <span className="label">Dedicated GPU memory</span>
            <span className="value">{formatGb(current.gpu_memory_used)} / {formatGb(current.gpu_memory_total)}</span>
          </div>
          <div className="detail-card">
            <span className="label">Temperature</span>
            <span className="value">{current.gpu_temperature.toFixed(1)}°C</span>
          </div>
        </div>
      </div>
    </div>
  );
}

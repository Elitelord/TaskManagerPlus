import { usePerformanceData } from "../../hooks/usePerformanceData";
import { ResourceGraph } from "../ResourceGraph";

export function DiskPage() {
  const { current } = usePerformanceData();

  if (!current) return <div className="loading-overlay">Initializing Disk metrics...</div>;

  const formatSpeed = (bytes: number) => {
    if (bytes > 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB/s";
    return (bytes / 1024).toFixed(0) + " KB/s";
  };

  return (
    <div className="resource-page">
      <div className="page-header">
        <div className="header-main">
          <h2>Disk Performance</h2>
          <div className="header-meta">
            <span className="meta-item">Read: <strong>{formatSpeed(current.disk_read_per_sec)}</strong></span>
            <span className="meta-item">Write: <strong>{formatSpeed(current.disk_write_per_sec)}</strong></span>
          </div>
        </div>
      </div>

      <div className="page-content">
        <div className="graph-section">
          <ResourceGraph metric="disk" height={250} label="Active Time (%)" color="#ff9800" fillColor="rgba(255,152,0,0.15)" />
        </div>

        <div className="disk-details-grid">
          <div className="detail-card">
            <span className="label">Active time</span>
            <span className="value">{current.disk_active_percent.toFixed(1)}%</span>
          </div>
          <div className="detail-card">
            <span className="label">Average queue length</span>
            <span className="value">{current.disk_queue_length.toFixed(2)}</span>
          </div>
          <div className="detail-card">
            <span className="label">Read speed</span>
            <span className="value">{formatSpeed(current.disk_read_per_sec)}</span>
          </div>
          <div className="detail-card">
            <span className="label">Write speed</span>
            <span className="value">{formatSpeed(current.disk_write_per_sec)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

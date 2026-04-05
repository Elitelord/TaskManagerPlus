import { usePerformanceData } from "../../hooks/usePerformanceData";
import { ResourceGraph } from "../ResourceGraph";

export function DiskPage() {
  const { current, historyRef } = usePerformanceData();

  if (!current) return <div className="loading-overlay">Initializing Disk metrics...</div>;

  const formatSpeed = (bytes: number) => {
    if (bytes > 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB/s";
    return (bytes / 1024).toFixed(0) + " KB/s";
  };

  const arr = historyRef.current?.toArray() ?? [];
  const latest = arr[arr.length - 1];
  const topDisk = latest?.topDisk ?? [];

  return (
    <div className="resource-page">
      <div className="page-header">
        <div className="header-main">
          <h2>Disk</h2>
          <div className="header-meta">
            <span className="meta-item">Read: <strong>{formatSpeed(current.disk_read_per_sec)}</strong></span>
            <span className="meta-item">Write: <strong>{formatSpeed(current.disk_write_per_sec)}</strong></span>
            <span className="meta-item">Active: <strong>{current.disk_active_percent.toFixed(1)}%</strong></span>
          </div>
        </div>
      </div>

      <div className="page-content">
        <div className="graph-section">
          <ResourceGraph metric="disk" label="Disk Activity" color="#f5a524" fillColor="rgba(245,165,36,0.15)" />
        </div>

        <div className="two-col-grid">
          <div className="info-panel">
            <h3 className="section-title">Performance</h3>
            <div className="spec-row"><span className="label">Active time</span> <span className="value">{current.disk_active_percent.toFixed(1)}%</span></div>
            <div className="spec-row"><span className="label">Avg queue length</span> <span className="value">{current.disk_queue_length.toFixed(2)}</span></div>
            <div className="spec-row"><span className="label">Read speed</span> <span className="value">{formatSpeed(current.disk_read_per_sec)}</span></div>
            <div className="spec-row"><span className="label">Write speed</span> <span className="value">{formatSpeed(current.disk_write_per_sec)}</span></div>
          </div>

          <div className="info-panel">
            <h3 className="section-title">Top Disk Consumers</h3>
            <div className="top-consumers-list">
              {topDisk.filter((p: { value: number }) => p.value > 100).slice(0, 6).map((proc: { name: string; value: number }, i: number) => (
                <div key={i} className="consumer-row">
                  <span className="consumer-name">{proc.name}</span>
                  <div className="consumer-bar-track">
                    <div
                      className="consumer-bar-fill"
                      style={{
                        width: `${Math.min((proc.value / Math.max(current.disk_read_per_sec + current.disk_write_per_sec, 1)) * 100, 100)}%`,
                        background: "var(--accent-orange)",
                      }}
                    />
                  </div>
                  <span className="consumer-value">{formatSpeed(proc.value)}</span>
                </div>
              ))}
              {topDisk.filter((p: { value: number }) => p.value > 100).length === 0 && (
                <div className="empty-state">No significant disk activity</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

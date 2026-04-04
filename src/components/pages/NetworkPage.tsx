import { usePerformanceData } from "../../hooks/usePerformanceData";
import { ResourceGraph } from "../ResourceGraph";

export function NetworkPage() {
  const { current } = usePerformanceData();

  if (!current) return <div className="loading-overlay">Initializing Network metrics...</div>;

  const formatSpeed = (bps: number) => {
    if (bps > 1000000) return (bps / 1000000).toFixed(1) + " Mbps";
    return (bps / 1000).toFixed(0) + " Kbps";
  };

  const formatThroughput = (bytes: number) => {
    if (bytes > 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB/s";
    return (bytes / 1024).toFixed(0) + " KB/s";
  };

  return (
    <div className="resource-page">
      <div className="page-header">
        <div className="header-main">
          <h2>Network Performance</h2>
          <div className="header-meta">
            <span className="meta-item">Send: <strong>{formatThroughput(current.net_send_per_sec)}</strong></span>
            <span className="meta-item">Receive: <strong>{formatThroughput(current.net_recv_per_sec)}</strong></span>
          </div>
        </div>
      </div>

      <div className="page-content">
        <div className="graph-section">
          <ResourceGraph metric="network" height={250} label="Throughput (MB/s)" color="#f44336" fillColor="rgba(244,67,54,0.15)" />
        </div>

        <div className="network-details-grid">
          <div className="detail-card">
            <span className="label">Link speed</span>
            <span className="value">{formatSpeed(current.net_link_speed_bps)}</span>
          </div>
          <div className="detail-card">
            <span className="label">Send rate</span>
            <span className="value">{formatThroughput(current.net_send_per_sec)}</span>
          </div>
          <div className="detail-card">
            <span className="label">Receive rate</span>
            <span className="value">{formatThroughput(current.net_recv_per_sec)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

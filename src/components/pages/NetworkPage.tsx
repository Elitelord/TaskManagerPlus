import { usePerformanceData } from "../../hooks/usePerformanceData";
import { ResourceGraph } from "../ResourceGraph";

export function NetworkPage() {
  const { current, historyRef } = usePerformanceData();

  if (!current) return <div className="loading-overlay">Initializing Network metrics...</div>;

  const formatSpeed = (bps: number) => {
    if (bps > 1000000) return (bps / 1000000).toFixed(1) + " Mbps";
    return (bps / 1000).toFixed(0) + " Kbps";
  };

  const formatThroughput = (bytes: number) => {
    if (bytes > 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB/s";
    return (bytes / 1024).toFixed(0) + " KB/s";
  };

  const arr = historyRef.current?.toArray() ?? [];
  const latest = arr[arr.length - 1];
  const topNet = latest?.topNet ?? [];

  return (
    <div className="resource-page">
      <div className="page-header">
        <div className="header-main">
          <h2>Network</h2>
          <div className="header-meta">
            <span className="meta-item">Send: <strong>{formatThroughput(current.net_send_per_sec)}</strong></span>
            <span className="meta-item">Receive: <strong>{formatThroughput(current.net_recv_per_sec)}</strong></span>
          </div>
        </div>
      </div>

      <div className="page-content">
        <div className="graph-section">
          <ResourceGraph metric="network" label="Network Throughput" color="#ef5350" fillColor="rgba(239,83,80,0.15)" />
        </div>

        <div className="two-col-grid">
          <div className="info-panel">
            <h3 className="section-title">Connection</h3>
            <div className="spec-row"><span className="label">Link speed</span> <span className="value">{formatSpeed(current.net_link_speed_bps)}</span></div>
            <div className="spec-row"><span className="label">Send rate</span> <span className="value">{formatThroughput(current.net_send_per_sec)}</span></div>
            <div className="spec-row"><span className="label">Receive rate</span> <span className="value">{formatThroughput(current.net_recv_per_sec)}</span></div>
            <div className="spec-row"><span className="label">Total throughput</span> <span className="value">{formatThroughput(current.net_send_per_sec + current.net_recv_per_sec)}</span></div>
          </div>

          <div className="info-panel">
            <h3 className="section-title">Top Network Consumers</h3>
            <div className="top-consumers-list">
              {topNet.filter((p: { value: number }) => p.value > 100).slice(0, 6).map((proc: { name: string; value: number }, i: number) => (
                <div key={i} className="consumer-row">
                  <span className="consumer-name">{proc.name}</span>
                  <div className="consumer-bar-track">
                    <div
                      className="consumer-bar-fill"
                      style={{
                        width: `${Math.min((proc.value / Math.max(current.net_send_per_sec + current.net_recv_per_sec, 1)) * 100, 100)}%`,
                        background: "var(--accent-red)",
                      }}
                    />
                  </div>
                  <span className="consumer-value">{formatThroughput(proc.value)}</span>
                </div>
              ))}
              {topNet.filter((p: { value: number }) => p.value > 100).length === 0 && (
                <div className="empty-state">No significant network activity</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

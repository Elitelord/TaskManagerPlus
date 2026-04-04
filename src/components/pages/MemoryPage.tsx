import { usePerformanceData } from "../../hooks/usePerformanceData";
import { ResourceGraph } from "../ResourceGraph";

export function MemoryPage() {
  const { current } = usePerformanceData();

  if (!current) return <div className="loading-overlay">Initializing Memory metrics...</div>;

  const formatGb = (bytes: number) => (bytes / (1024 ** 3)).toFixed(1) + " GB";
  const formatMb = (bytes: number) => (bytes / (1024 ** 2)).toFixed(0) + " MB";

  return (
    <div className="resource-page">
      <div className="page-header">
        <div className="header-main">
          <h2>Memory Performance</h2>
          <div className="header-meta">
            <span className="meta-item">Used: <strong>{formatGb(current.used_ram_bytes)}</strong></span>
            <span className="meta-item">Available: <strong>{formatGb(current.available_ram_bytes)}</strong></span>
          </div>
        </div>
      </div>

      <div className="page-content">
        <div className="graph-section">
          <ResourceGraph metric="memory" height={250} label="Usage (%)" color="#4caf50" fillColor="rgba(76,175,80,0.15)" />
        </div>

        <div className="memory-details-grid">
          <div className="detail-card">
            <span className="label">Committed</span>
            <span className="value">{formatGb(current.committed_bytes)} / {formatGb(current.commit_limit_bytes)}</span>
          </div>
          <div className="detail-card">
            <span className="label">Cached</span>
            <span className="value">{formatGb(current.cached_bytes)}</span>
          </div>
          <div className="detail-card">
            <span className="label">Paged pool</span>
            <span className="value">{formatMb(current.paged_pool_bytes)}</span>
          </div>
          <div className="detail-card">
            <span className="label">Non-paged pool</span>
            <span className="value">{formatMb(current.non_paged_pool_bytes)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

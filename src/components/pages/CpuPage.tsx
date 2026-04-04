import { usePerformanceData } from "../../hooks/usePerformanceData";
import { ResourceGraph } from "../ResourceGraph";

export function CpuPage() {
  const { current, cores } = usePerformanceData();

  if (!current) return <div className="loading-overlay">Initializing CPU metrics...</div>;

  return (
    <div className="resource-page">
      <div className="page-header">
        <div className="header-main">
          <h2>CPU Performance</h2>
          <div className="header-meta">
            <span className="meta-item">Utilization: <strong>{current.cpu_usage_percent.toFixed(1)}%</strong></span>
            <span className="meta-item">Speed: <strong>{(current.cpu_frequency_mhz / 1000).toFixed(2)} GHz</strong></span>
            <span className="meta-item">Processes: <strong>{current.process_count}</strong></span>
            <span className="meta-item">Threads: <strong>{current.thread_total_count}</strong></span>
          </div>
        </div>
      </div>

      <div className="page-content">
        <div className="graph-section">
          <ResourceGraph metric="cpu" height={250} label="Total Usage (%)" color="#4a9eff" fillColor="rgba(74,158,255,0.15)" />
        </div>

        <div className="cpu-secondary-grid">
          <div className="cores-grid-container">
            <h3 className="section-title">Logical Processors ({cores?.length || 0})</h3>
            <div className="cores-grid">
              {(cores || []).map((core) => (
                <div key={core.core_index} className={`core-box ${core.is_performance_core ? 'p-core' : 'e-core'}`}>
                  <div className="core-fill" style={{ height: `${core.usage_percent}%` }} />
                  <span className="core-index">{core.core_index}</span>
                  <span className="core-value">{core.usage_percent.toFixed(0)}%</span>
                  {core.is_performance_core ? <span className="core-type">P</span> : <span className="core-type">E</span>}
                </div>
              ))}
            </div>
          </div>

          <div className="cpu-specs-panel">
            <h3 className="section-title">Specifications</h3>
            <div className="spec-row"><span className="label">Base speed:</span> <span className="value">{(current.cpu_base_frequency_mhz / 1000).toFixed(2)} GHz</span></div>
            <div className="spec-row"><span className="label">Max speed:</span> <span className="value">{(current.cpu_max_frequency_mhz / 1000).toFixed(2)} GHz</span></div>
            <div className="spec-row"><span className="label">Cores:</span> <span className="value">{current.core_count}</span></div>
            <div className="spec-row"><span className="label">Logical processors:</span> <span className="value">{current.thread_count}</span></div>
            <div className="spec-row"><span className="label">Handles:</span> <span className="value">{current.handle_count}</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}

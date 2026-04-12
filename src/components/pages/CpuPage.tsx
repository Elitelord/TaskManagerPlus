import { usePerformanceData } from "../../hooks/usePerformanceData";
import { ResourceGraph } from "../ResourceGraph";

const CPU_GRAPH_COLOR = "#5b9cf6";
const CPU_GRAPH_FILL = "rgba(91, 156, 246, 0.12)";

export function CpuPage() {
  const { current, cores, historyRef } = usePerformanceData();

  if (!current) return <div className="loading-overlay">Initializing CPU metrics...</div>;

  const arr = historyRef.current?.toArray() ?? [];
  const latest = arr[arr.length - 1];
  const topCpu = latest?.topCpu ?? [];

  const pCores = (cores || []).filter(c => c.is_performance_core === 1);
  const eCores = (cores || []).filter(c => c.is_performance_core === 0);

  return (
    <div className="resource-page">
      <div className="page-header">
        <div className="header-main">
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <h2>CPU</h2>
            {current.cpu_name && (
              <div className="header-subtitle">
                <span className="adapter-name">{current.cpu_name}</span>
                <span className="adapter-type">
                  {pCores.length > 0 ? "Hybrid" : "x64"}
                </span>
              </div>
            )}
          </div>
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
          <ResourceGraph
            metric="cpu"
            label="CPU usage"
            color={CPU_GRAPH_COLOR}
            fillColor={CPU_GRAPH_FILL}
          />
        </div>

        <div className="cpu-secondary-grid">
          <div className="cores-grid-container">
            <h3 className="section-title">Logical Processors ({cores?.length || 0})</h3>
            <div className="cores-grid">
              {(cores || []).map((core) => (
                <div key={core.core_index} className={`core-box ${core.is_performance_core === 1 ? 'p-core' : 'e-core'}`}>
                  <div className="core-fill" style={{ height: `${core.usage_percent}%` }} />
                  <span className="core-index">{core.core_index}</span>
                  <span className="core-value">{core.usage_percent.toFixed(0)}%</span>
                  {core.is_performance_core === 1 ? <span className="core-type">P</span> : <span className="core-type">E</span>}
                </div>
              ))}
            </div>
          </div>

          <div className="cpu-specs-panel">
            <h3 className="section-title">Specifications</h3>
            <div className="spec-row"><span className="label">Base speed</span> <span className="value">{(current.cpu_base_frequency_mhz / 1000).toFixed(2)} GHz</span></div>
            <div className="spec-row"><span className="label">Max speed</span> <span className="value">{(current.cpu_max_frequency_mhz / 1000).toFixed(2)} GHz</span></div>
            <div className="spec-row"><span className="label">Current speed</span> <span className="value">{(current.cpu_frequency_mhz / 1000).toFixed(2)} GHz</span></div>
            <div className="spec-row"><span className="label">Cores</span> <span className="value">{current.core_count}{pCores.length > 0 ? ` (${pCores.length}P + ${eCores.length}E)` : ""}</span></div>
            <div className="spec-row"><span className="label">Logical processors</span> <span className="value">{current.thread_count}</span></div>
            <div className="spec-row"><span className="label">Handles</span> <span className="value">{current.handle_count.toLocaleString()}</span></div>
            <div className="spec-row"><span className="label">Threads</span> <span className="value">{current.thread_total_count.toLocaleString()}</span></div>
          </div>
        </div>

        <div className="info-panel">
          <h3 className="section-title">Top CPU Consumers</h3>
          <div className="top-consumers-list">
            {topCpu.filter((p: { value: number }) => p.value > 0.1).slice(0, 6).map((proc: { name: string; value: number }, i: number) => (
              <div key={i} className="consumer-row">
                <span className="consumer-name">{proc.name}</span>
                <div className="consumer-bar-track">
                  <div
                    className="consumer-bar-fill"
                    style={{
                      width: `${Math.min(proc.value, 100)}%`,
                      background: proc.value > 50 ? "var(--accent-red)" : proc.value > 20 ? "var(--accent-orange)" : "var(--accent-blue)",
                    }}
                  />
                </div>
                <span className="consumer-value">{proc.value.toFixed(1)}%</span>
              </div>
            ))}
            {topCpu.filter((p: { value: number }) => p.value > 0.1).length === 0 && (
              <div className="empty-state">No significant CPU usage</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

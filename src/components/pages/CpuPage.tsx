import { usePerformanceData } from "../../hooks/usePerformanceData";
import { ResourceGraph } from "../ResourceGraph";
import { useOemThermal } from "../../hooks/useOemThermal";
import { Fan, Gauge } from "lucide-react";

const CPU_GRAPH_COLOR = "#5b9cf6";
const CPU_GRAPH_FILL = "rgba(91, 156, 246, 0.12)";

/** Compact "lifetime CPU time" formatter for the Top Consumers card.
 *  Examples: 0.4s, 12s, 1m 03s, 2h 14m, 3d 05h. We never show milliseconds —
 *  per-process kernel/user time updates at OS clock-tick granularity, so
 *  showing 327ms would just be a flickery 4th digit. */
/** Compact fan bar — current vs session-observed max. ASUS WMI doesn't expose
 *  a max-RPM register, so the scale grows as we observe higher RPM during the
 *  session (with a 4000 RPM floor in the hook). The bar fades to a warmer
 *  color above ~75% to flag a fan ramp. */
export function FanBar({ current, max }: { current: number; max: number }) {
  const pct = max > 0 ? Math.min((current / max) * 100, 100) : 0;
  const color =
    pct >= 85 ? "var(--accent-red)" : pct >= 65 ? "var(--accent-orange)" : "var(--accent-primary)";
  return (
    <div className="fan-bar" title={`${Math.round(current).toLocaleString()} / ${Math.round(max).toLocaleString()} RPM`}>
      <div className="fan-bar-track">
        <div className="fan-bar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="fan-bar-meta">
        <span className="fan-bar-meta-pct">{pct.toFixed(0)}%</span>
        <span className="fan-bar-meta-max">peak {Math.round(max).toLocaleString()}</span>
      </span>
    </div>
  );
}

function formatCpuTime(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return "—";
  if (seconds < 1) return `${seconds.toFixed(1)}s`;
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${String(rs).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return `${h}h ${String(rm).padStart(2, "0")}m`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return `${d}d ${String(rh).padStart(2, "0")}h`;
}

export function CpuPage() {
  const { current, cores, historyRef } = usePerformanceData();
  const { capabilities, status, error, maxCpuFanRpm } = useOemThermal();

  if (!current) return <div className="loading-overlay">Initializing CPU metrics...</div>;

  const arr = historyRef.current?.toArray() ?? [];
  const latest = arr[arr.length - 1];
  const topCpu = latest?.topCpu ?? [];
  const anyCpuTime = topCpu.some((p) => (p.cpuTimeSec ?? 0) > 0);

  const pCores = (cores || []).filter(c => c.is_performance_core === 1);

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
          <div className="cpu-secondary-left">
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

            <div className="info-panel">
              <h3 className="section-title">Top CPU Consumers</h3>
              <div className={`top-consumers-list ${anyCpuTime ? "with-cpu-time" : ""}`}>
                {topCpu.filter((p) => p.value > 0.1).slice(0, 6).map((proc, i) => (
                  <div key={i} className="consumer-row">
                    <span className="consumer-name" title={proc.name}>{proc.name}</span>
                    <div className="consumer-bar-track">
                      <div
                        className="consumer-bar-fill"
                        style={{
                          width: `${Math.min(proc.value, 100)}%`,
                          background: proc.value > 50 ? "var(--accent-red)" : proc.value > 20 ? "var(--accent-orange)" : "var(--accent-green)",
                        }}
                      />
                    </div>
                    {anyCpuTime && (
                      <span
                        className="consumer-subvalue"
                        title="Cumulative CPU time since the process started"
                      >
                        {formatCpuTime(proc.cpuTimeSec ?? 0)}
                      </span>
                    )}
                    <span className="consumer-value">{proc.value.toFixed(1)}%</span>
                  </div>
                ))}
                {topCpu.filter((p) => p.value > 0.1).length === 0 && (
                  <div className="empty-state">No significant CPU usage</div>
                )}
              </div>
            </div>
          </div>

          {/* Middle column — system load + static specs. In 2-col layouts
              this stacks under the right column; in 3-col (>=1400px) it
              becomes its own column. */}
          <div className="cpu-secondary-middle">
            {/* System load — live counts with avg-per-process context. */}
            <div className="cpu-specs-panel cpu-load-card">
              <h3 className="section-title">System load</h3>
              {(() => {
                const procs = current.process_count;
                const threadsPer = procs > 0 ? current.thread_total_count / procs : 0;
                const handlesPer = procs > 0 ? current.handle_count / procs : 0;
                return (
                  <>
                    <div className="cpu-load-row">
                      <div className="cpu-load-row-main">
                        <span className="label">Processes</span>
                        <span className="value">{procs.toLocaleString()}</span>
                      </div>
                    </div>
                    <div className="cpu-load-row">
                      <div className="cpu-load-row-main">
                        <span className="label">Threads</span>
                        <span className="value">{current.thread_total_count.toLocaleString()}</span>
                      </div>
                      <span className="cpu-load-row-sub">≈ {threadsPer.toFixed(1)} per process</span>
                    </div>
                    <div className="cpu-load-row">
                      <div className="cpu-load-row-main">
                        <span className="label">Handles</span>
                        <span className="value">{current.handle_count.toLocaleString()}</span>
                      </div>
                      <span className="cpu-load-row-sub">≈ {handlesPer.toFixed(0)} per process</span>
                    </div>
                  </>
                );
              })()}
            </div>

            {/* Specifications — pure static spec sheet (sockets, cache). */}
            <div className="cpu-specs-panel">
              <h3 className="section-title">Specifications</h3>
              {current.socket_count > 1 && (
                <div className="spec-row">
                  <span className="label">Sockets</span>
                  <span className="value">{current.socket_count}</span>
                </div>
              )}
              {current.l1d_cache_kb > 0 && (
                <div className="spec-row">
                  <span className="label">L1 cache</span>
                  <span className="value">
                    {current.l1d_cache_kb.toLocaleString()} KB data
                    {current.l1i_cache_kb > 0 && ` · ${current.l1i_cache_kb.toLocaleString()} KB inst.`}
                  </span>
                </div>
              )}
              {current.l2_cache_kb > 0 && (
                <div className="spec-row">
                  <span className="label">L2 cache</span>
                  <span className="value">
                    {current.l2_cache_kb >= 1024
                      ? `${(current.l2_cache_kb / 1024).toFixed(1)} MB`
                      : `${current.l2_cache_kb.toLocaleString()} KB`}
                  </span>
                </div>
              )}
              {current.l3_cache_kb > 0 && (
                <div className="spec-row">
                  <span className="label">L3 cache</span>
                  <span className="value">
                    {current.l3_cache_kb >= 1024
                      ? `${(current.l3_cache_kb / 1024).toFixed(1)} MB`
                      : `${current.l3_cache_kb.toLocaleString()} KB`}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Right column — clock speed (always) + fan card (when present).
              Fan sits directly under speed so the column stays balanced
              regardless of whether the OEM exposes a fan reading. */}
          <div className="cpu-secondary-right">
            {/* Speed card — current/max bar with base as a footer line. */}
            {(() => {
              const cur = current.cpu_frequency_mhz;
              const max = current.cpu_max_frequency_mhz;
              const base = current.cpu_base_frequency_mhz;
              const pct = max > 0 ? Math.min((cur / max) * 100, 100) : 0;
              const overBase = base > 0 && cur > base * 1.02;
              const color =
                pct >= 90 ? "var(--accent-red)"
                : pct >= 70 ? "var(--accent-orange)"
                : overBase ? "var(--accent-green)"
                : "var(--accent-primary)";
              return (
                <div className="cpu-specs-panel cpu-speed-card">
                  <div className="cpu-speed-card-header">
                    <span className="cpu-speed-card-title">
                      <Gauge size={14} strokeWidth={2} aria-hidden style={{ verticalAlign: "-2px", marginRight: 6 }} />
                      Clock speed
                    </span>
                    <span className="cpu-speed-card-value">
                      <strong>{(cur / 1000).toFixed(2)}</strong>
                      <span className="cpu-speed-card-unit"> / {(max / 1000).toFixed(2)} GHz</span>
                    </span>
                  </div>
                  <div className="fan-bar" title={`${(cur / 1000).toFixed(2)} GHz of ${(max / 1000).toFixed(2)} GHz max`}>
                    <div className="fan-bar-track">
                      <div className="fan-bar-fill" style={{ width: `${pct}%`, background: color }} />
                    </div>
                    <span className="fan-bar-meta">
                      <span className="fan-bar-meta-pct">{pct.toFixed(0)}% of max</span>
                      {overBase && <span className="fan-bar-meta-max">turbo</span>}
                    </span>
                  </div>
                  {base > 0 && (
                    <div className="cpu-speed-card-base">
                      Base <strong>{(base / 1000).toFixed(2)} GHz</strong>
                    </div>
                  )}
                </div>
              );
            })()}

            {capabilities?.supports_fan_rpm && (
              <div className="cpu-fan-card cpu-specs-panel">
                <div className="cpu-fan-card-row">
                  <Fan className="cpu-fan-card-icon" size={44} strokeWidth={1.25} aria-hidden />
                  <div className="cpu-fan-card-body">
                    <span className="cpu-fan-card-value">
                      {status?.cpu_fan_rpm != null ? status.cpu_fan_rpm.toLocaleString() : "—"}
                    </span>
                    <span className="cpu-fan-card-unit">RPM</span>
                  </div>
                  <span className="cpu-fan-card-label">CPU fan</span>
                </div>
                <FanBar current={status?.cpu_fan_rpm ?? 0} max={maxCpuFanRpm} />
              </div>
            )}
            {(error || status?.error) && capabilities && (
              <div className="estimate-note" style={{ color: "var(--accent-red)" }}>
                {error || status?.error}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

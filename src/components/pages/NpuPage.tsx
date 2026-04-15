import { useMemo } from "react";
import { usePerformanceData } from "../../hooks/usePerformanceData";
import { ResourceGraph } from "../ResourceGraph";

export function NpuPage() {
  const { current } = usePerformanceData();

  const mem = useMemo(() => {
    if (!current) {
      return {
        dedicatedTotal: 0,
        dedicatedUsed: 0,
        dedicatedPct: 0,
        sharedTotal: 0,
        sharedUsed: 0,
      };
    }
    const dt = current.npu_dedicated_total_bytes;
    const du = Math.min(current.npu_dedicated_used_bytes, dt);
    const dp = dt > 0 ? (du / dt) * 100 : 0;
    return {
      dedicatedTotal: dt,
      dedicatedUsed: du,
      dedicatedPct: dp,
      sharedTotal: current.npu_shared_total_bytes,
      sharedUsed: current.npu_shared_used_bytes,
    };
  }, [current]);

  if (!current) {
    return <div className="loading-overlay">Initializing NPU metrics...</div>;
  }

  const formatGb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1) + " GB";
  const formatMb = (bytes: number) => (bytes / 1024 ** 2).toFixed(0) + " MB";
  const formatBytes = (bytes: number) =>
    bytes >= 1024 ** 3 ? formatGb(bytes) : formatMb(bytes);

  const hasDedicatedPool = mem.dedicatedTotal > 0 || mem.dedicatedUsed > 0;
  const hasSharedPool =
    mem.sharedTotal > 0 || mem.sharedUsed > 0;
  const hasAnyMem = hasDedicatedPool || hasSharedPool;

  const displayName =
    (current.npu_name || "").trim() ||
    (current.cpu_name || "").trim() ||
    "Neural processing unit";

  if (!current.npu_present) {
    return (
      <div className="resource-page">
        <div className="page-header">
          <div className="header-main">
            <h2>NPU</h2>
            <div className="header-meta">
              <span className="meta-item">No neural processing unit detected on this PC, or counters are not available on this Windows build.</span>
            </div>
          </div>
        </div>
        <div className="page-content">
          <div className="info-panel">
            <p className="setting-description">
              NPU utilization appears on Windows 11 AI PCs with a supported driver stack. If you expect an NPU here, try updating Windows and your chipset / NPU drivers.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="resource-page">
      <div className="page-header">
        <div className="header-main">
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <h2>NPU</h2>
            <div className="header-subtitle">
              <span className="adapter-name">{displayName}</span>
              <span className="adapter-type integrated">NPU</span>
            </div>
          </div>
          <div className="header-meta">
            <span className="meta-item">
              Utilization:{" "}
              <strong>{current.npu_usage_percent.toFixed(1)}%</strong>
            </span>
            {mem.dedicatedTotal > 0 && (
              <span className="meta-item">
                Dedicated:{" "}
                <strong>
                  {formatBytes(mem.dedicatedUsed)} / {formatBytes(mem.dedicatedTotal)}
                </strong>
              </span>
            )}
            {mem.dedicatedTotal === 0 && mem.dedicatedUsed > 0 && (
              <span className="meta-item">
                Dedicated in use:{" "}
                <strong>{formatBytes(mem.dedicatedUsed)}</strong>
                <span style={{ color: "var(--text-muted)", fontWeight: 400 }}> (total not reported)</span>
              </span>
            )}
            {hasSharedPool && (
              <span className="meta-item">
                Shared:{" "}
                <strong>
                  {mem.sharedTotal > 0
                    ? `${formatBytes(mem.sharedUsed)} / ${formatBytes(mem.sharedTotal)}`
                    : `${formatBytes(mem.sharedUsed)} in use`}
                </strong>
              </span>
            )}
            {(current.npu_hardware_id || "").trim() !== "" && (
              <span className="meta-item">
                Hardware ID: <strong>{current.npu_hardware_id.trim()}</strong>
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="page-content">
        <div className="graph-section">
          <ResourceGraph
            metric="npu"
            label="NPU Usage"
            color="#22d3ee"
            fillColor="rgba(34,211,238,0.15)"
          />
        </div>

        <div className="gpu-triple-grid">
          {hasAnyMem ? (
            <>
              {mem.dedicatedTotal > 0 && (
                <div className="info-panel">
                  <h3 className="section-title">Dedicated NPU memory</h3>
                  <div className="composition-bar">
                    <div
                      className="composition-segment"
                      style={{
                        width: `${mem.dedicatedPct}%`,
                        background: "var(--accent-cyan, #22d3ee)",
                      }}
                      title={`Used: ${formatBytes(mem.dedicatedUsed)}`}
                    />
                    <div
                      className="composition-segment"
                      style={{
                        width: `${100 - mem.dedicatedPct}%`,
                        background: "rgba(255,255,255,0.08)",
                      }}
                      title={`Free: ${formatBytes(Math.max(0, mem.dedicatedTotal - mem.dedicatedUsed))}`}
                    />
                  </div>
                  <div className="composition-legend">
                    <div className="composition-legend-item">
                      <span className="legend-dot" style={{ background: "var(--accent-cyan, #22d3ee)" }} />
                      Used {formatBytes(mem.dedicatedUsed)}
                    </div>
                    <div className="composition-legend-item">
                      <span className="legend-dot" style={{ background: "rgba(255,255,255,0.2)" }} />
                      Total {formatBytes(mem.dedicatedTotal)}
                    </div>
                  </div>
                </div>
              )}
              {mem.dedicatedTotal === 0 && mem.dedicatedUsed > 0 && (
                <div className="info-panel">
                  <h3 className="section-title">Dedicated NPU memory</h3>
                  <div className="npu-mem-readout">
                    <span className="npu-mem-value">{formatBytes(mem.dedicatedUsed)}</span>
                    <span className="npu-mem-label">in use</span>
                  </div>
                </div>
              )}
              {hasSharedPool && (
                <div className="info-panel">
                  <h3 className="section-title">Shared memory</h3>
                  {mem.sharedTotal > 0 ? (
                    <>
                      <div className="composition-bar">
                        <div
                          className="composition-segment"
                          style={{
                            width: `${Math.min((mem.sharedUsed / mem.sharedTotal) * 100, 100)}%`,
                            background: "var(--accent-cyan, #22d3ee)",
                          }}
                          title={`Used: ${formatBytes(mem.sharedUsed)}`}
                        />
                        <div
                          className="composition-segment"
                          style={{
                            width: `${Math.max(100 - (mem.sharedUsed / mem.sharedTotal) * 100, 0)}%`,
                            background: "rgba(255,255,255,0.08)",
                          }}
                          title={`Free: ${formatBytes(Math.max(0, mem.sharedTotal - mem.sharedUsed))}`}
                        />
                      </div>
                      <div className="composition-legend">
                        <div className="composition-legend-item">
                          <span className="legend-dot" style={{ background: "var(--accent-cyan, #22d3ee)" }} />
                          Used {formatBytes(mem.sharedUsed)}
                        </div>
                        <div className="composition-legend-item">
                          <span className="legend-dot" style={{ background: "rgba(255,255,255,0.2)" }} />
                          Total {formatBytes(mem.sharedTotal)}
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="npu-mem-readout">
                      <span className="npu-mem-value">{formatBytes(mem.sharedUsed)}</span>
                      <span className="npu-mem-label">in use</span>
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="info-panel">
              <h3 className="section-title">NPU memory</h3>
              <p className="setting-description">
                No dedicated or shared memory figures are available yet for this adapter (performance counters returned zero or the adapter LUID could not be matched
                to PDH instances). Dedicated and shared totals from DXCore are{" "}
                <strong>{formatBytes(mem.dedicatedTotal)}</strong> and <strong>{formatBytes(mem.sharedTotal)}</strong> respectively. If Task Manager shows NPU memory
                on this machine, a driver or Windows update may expose the matching counters here.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

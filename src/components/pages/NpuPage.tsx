import { useMemo } from "react";
import { usePerformanceData } from "../../hooks/usePerformanceData";
import { ResourceGraph } from "../ResourceGraph";

/** Compact NPU memory formatter for top-consumers rows. NPU per-process
 *  memory tends to be small (model parameters + activations), so MB is
 *  almost always the right scale. */
function formatNpuMem(bytes: number): string {
  if (!isFinite(bytes) || bytes <= 0) return "—";
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return "<1 MB";
  if (mb < 1024) return `${mb.toFixed(0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

export function NpuPage() {
  const { current, historyRef } = usePerformanceData();

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
                        background: "var(--chart-npu-low)",
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
                      <span className="legend-dot" style={{ background: "var(--chart-npu-low)" }} />
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
                            background: "var(--chart-npu-low)",
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
                          <span className="legend-dot" style={{ background: "var(--chart-npu-low)" }} />
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

        {/* -------- Top NPU Consumers -------- */}
        <TopNpuConsumers historyRef={historyRef} />
      </div>
    </div>
  );
}

/** Top NPU Consumers card. NPU PDH counters can be sparse on machines whose
 *  driver only reports adapter-level data (no per-process breakdown), so we
 *  hide the memory cell when nothing useful comes back. */
function TopNpuConsumers({
  historyRef,
}: {
  historyRef: ReturnType<typeof usePerformanceData>["historyRef"];
}) {
  const arr = historyRef.current?.toArray() ?? [];
  const latest = arr[arr.length - 1];
  const topNpu = latest?.topNpu ?? [];
  const visible = topNpu.filter((p) => p.value > 0.1 || (p.memBytes ?? 0) > 0);
  const anyMem = visible.some((p) => (p.memBytes ?? 0) > 0);

  return (
    <div className="info-panel">
      <h3 className="section-title">Top NPU Consumers</h3>
      <div className={`top-consumers-list ${anyMem ? "with-cpu-time" : ""}`}>
        {visible.slice(0, 6).map((proc, i) => (
          <div key={i} className="consumer-row">
            <span className="consumer-name" title={proc.name}>{proc.name}</span>
            <div className="consumer-bar-track">
              <div
                className="consumer-bar-fill"
                style={{
                  width: `${Math.min(proc.value, 100)}%`,
                  background: proc.value > 50 ? "var(--accent-red)" : proc.value > 20 ? "var(--accent-orange)" : "var(--chart-npu-low)",
                }}
              />
            </div>
            {anyMem && (
              <span
                className="consumer-subvalue"
                title="NPU memory currently in use (dedicated, or shared as fallback)"
              >
                {formatNpuMem(proc.memBytes ?? 0)}
              </span>
            )}
            <span className="consumer-value">{proc.value.toFixed(1)}%</span>
          </div>
        ))}
        {visible.length === 0 && (
          <div className="empty-state">No significant NPU usage</div>
        )}
      </div>
    </div>
  );
}

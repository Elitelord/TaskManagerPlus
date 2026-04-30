import { useEffect, useMemo, useState, useCallback } from "react";
import { usePerformanceData } from "../../hooks/usePerformanceData";
import { ResourceGraph } from "../ResourceGraph";
import { useSettings } from "../../lib/settings";
import {
  listGpuAdapters,
  listMonitors,
  openGraphicsSettings,
  setDisplayMode,
  type GpuAdapterInfo,
  type MonitorInfo,
} from "../../lib/ipc";

/** Compact "VRAM in use" formatter for top-consumers rows. Uses MB up to ~1
 *  GB and GB beyond that — matches what the rest of the GPU page does. */
function formatGpuMem(bytes: number): string {
  if (!isFinite(bytes) || bytes <= 0) return "—";
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return "<1 MB";
  if (mb < 1024) return `${mb.toFixed(0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

// -------------------------------------------------------------------------
// Thermometer
// -------------------------------------------------------------------------
// GPU thermal bands (°C): Cool < 55, Normal 55-70, Warm 70-85, Hot 85+
function thermoPalette(c: number) {
  if (c >= 85) {
    return {
      "--thermo-top": "#ef4444",
      "--thermo-bot": "#f97316",
      "--thermo-glow": "rgba(239, 68, 68, 0.55)",
      "--thermo-bulb-hi": "#f97316",
      "--thermo-bulb-lo": "#7f1d1d",
      "--thermo-status": "#ef4444",
      status: "Hot",
    } as Record<string, string>;
  }
  if (c >= 70) {
    return {
      "--thermo-top": "#f97316",
      "--thermo-bot": "#fbbf24",
      "--thermo-glow": "rgba(251, 146, 60, 0.45)",
      "--thermo-bulb-hi": "#fbbf24",
      "--thermo-bulb-lo": "#92400e",
      "--thermo-status": "#f97316",
      status: "Warm",
    } as Record<string, string>;
  }
  if (c >= 55) {
    return {
      "--thermo-top": "#fbbf24",
      "--thermo-bot": "#a3e635",
      "--thermo-glow": "rgba(251, 191, 36, 0.4)",
      "--thermo-bulb-hi": "#fde047",
      "--thermo-bulb-lo": "#78350f",
      "--thermo-status": "#fbbf24",
      status: "Normal",
    } as Record<string, string>;
  }
  return {
    "--thermo-top": "#60a5fa",
    "--thermo-bot": "#34d399",
    "--thermo-glow": "rgba(96, 165, 250, 0.35)",
    "--thermo-bulb-hi": "#93c5fd",
    "--thermo-bulb-lo": "#1e3a8a",
    "--thermo-status": "#60a5fa",
    status: "Cool",
  } as Record<string, string>;
}

function Thermometer({
  celsius,
  unit,
}: {
  celsius: number;
  unit: "celsius" | "fahrenheit";
}) {
  // Map 20..100 °C → 0..100% fill
  const pct = Math.max(0, Math.min(100, ((celsius - 20) / 80) * 100));
  const palette = thermoPalette(celsius);
  const isF = unit === "fahrenheit";
  const display = isF
    ? `${((celsius * 9) / 5 + 32).toFixed(0)}°F`
    : `${celsius.toFixed(0)}°C`;
  // 20 °C → 68 °F, 100 °C → 212 °F
  const rangeLabel = isF ? "68°F – 212°F" : "20°C – 100°C";

  return (
    <div className="thermometer-panel" style={palette as React.CSSProperties}>
      <div className="thermometer">
        <div className="thermometer-stem">
          <div className="thermometer-ticks">
            {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
              <div
                key={i}
                className={`thermometer-tick ${i % 2 === 0 ? "major" : ""}`}
                style={{ top: `${(i / 8) * 100}%` }}
              />
            ))}
          </div>
          <div className="thermometer-fill" style={{ height: `${pct}%` }} />
        </div>
        <div className="thermometer-bulb" />
      </div>
      <div className="thermometer-info">
        <div className="temp-value">{display}</div>
        <div className="temp-status">{palette.status}</div>
        <div className="temp-range">{rangeLabel}</div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------------
// GpuPage
// -------------------------------------------------------------------------
export function GpuPage() {
  const { current, historyRef } = usePerformanceData();
  const [settings] = useSettings();
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [adapters, setAdapters] = useState<GpuAdapterInfo[]>([]);
  const [busy, setBusy] = useState(false);
  // Selected GPU key (luid_high:luid_low). Initialised to primary once loaded.
  const [selectedAdapterKey, setSelectedAdapterKey] = useState<string>("");

  // Fetch once on mount (these rarely change at runtime).
  useEffect(() => {
    listMonitors().then(setMonitors).catch(() => setMonitors([]));
    listGpuAdapters()
      .then((a) => {
        setAdapters(a);
        const primary = a.find((x) => x.is_primary) ?? a[0];
        if (primary)
          setSelectedAdapterKey(`${primary.luid_high}:${primary.luid_low}`);
      })
      .catch(() => setAdapters([]));
  }, []);

  const refreshMonitors = useCallback(async () => {
    try {
      setMonitors(await listMonitors());
    } catch {
      /* ignore */
    }
  }, []);

  const handleResolutionChange = useCallback(
    async (m: MonitorInfo, value: string) => {
      const [w, h] = value.split("x").map((n) => parseInt(n, 10));
      if (!w || !h) return;
      // Pick the highest refresh rate the new resolution supports.
      const refreshes = m.available_modes
        .filter((mode) => mode.width === w && mode.height === h)
        .map((mode) => mode.refresh_hz);
      const best = refreshes.length
        ? Math.max(...refreshes)
        : m.current.refresh_hz;
      setBusy(true);
      try {
        await setDisplayMode(m.device_name, w, h, best);
        await refreshMonitors();
      } catch (e) {
        console.error("setDisplayMode failed", e);
      } finally {
        setBusy(false);
      }
    },
    [refreshMonitors],
  );

  const handleRefreshChange = useCallback(
    async (m: MonitorInfo, value: string) => {
      const hz = parseInt(value, 10);
      if (!hz) return;
      setBusy(true);
      try {
        await setDisplayMode(
          m.device_name,
          m.current.width,
          m.current.height,
          hz,
        );
        await refreshMonitors();
      } catch (e) {
        console.error("setDisplayMode failed", e);
      } finally {
        setBusy(false);
      }
    },
    [refreshMonitors],
  );

  const handleOpenGraphicsSettings = useCallback(async () => {
    try {
      await openGraphicsSettings();
    } catch (e) {
      console.error("openGraphicsSettings failed", e);
    }
  }, []);

  // Always show dedicated VRAM as the primary memory pool so the readout is
  // consistent between integrated and discrete GPUs. Shared memory is shown
  // as a secondary spec row below.
  const mem = useMemo(() => {
    if (!current)
      return {
        dedicatedTotal: 0,
        dedicatedUsed: 0,
        dedicatedFree: 0,
        dedicatedPct: 0,
        sharedTotal: 0,
        sharedUsed: 0,
        sharedFree: 0,
        sharedPct: 0,
      };
    const dt = current.gpu_memory_total;
    const du = Math.min(current.gpu_memory_used, dt); // clamp
    const df = dt > du ? dt - du : 0;
    const dp = dt > 0 ? (du / dt) * 100 : 0;
    const st = current.gpu_shared_memory_total;
    const su = Math.min(current.gpu_shared_memory_used, st); // clamp
    const sf = st > su ? st - su : 0;
    const sp = st > 0 ? (su / st) * 100 : 0;
    return {
      dedicatedTotal: dt,
      dedicatedUsed: du,
      dedicatedFree: df,
      dedicatedPct: dp,
      sharedTotal: st,
      sharedUsed: su,
      sharedFree: sf,
      sharedPct: sp,
    };
  }, [current]);

  if (!current)
    return <div className="loading-overlay">Initializing GPU metrics...</div>;

  const isIntegrated = current.gpu_is_integrated;

  const formatGb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1) + " GB";
  const formatMb = (bytes: number) => (bytes / 1024 ** 2).toFixed(0) + " MB";
  const formatBytes = (bytes: number) =>
    bytes >= 1024 ** 3 ? formatGb(bytes) : formatMb(bytes);

  return (
    <div className="resource-page">
      <div className="page-header">
        <div className="header-main">
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <h2>GPU</h2>
            {current.gpu_name && (
              <div className="header-subtitle">
                <span className="adapter-name">{current.gpu_name}</span>
                <span
                  className={`adapter-type ${
                    isIntegrated ? "integrated" : "discrete"
                  }`}
                >
                  {isIntegrated ? "Integrated" : "Discrete"}
                </span>
              </div>
            )}
          </div>
          <div className="header-meta">
            <span className="meta-item">
              Utilization:{" "}
              <strong>{current.gpu_usage_percent.toFixed(1)}%</strong>
            </span>
            <span className="meta-item">
              VRAM:{" "}
              <strong>
                {formatBytes(mem.dedicatedUsed)} /{" "}
                {formatBytes(mem.dedicatedTotal)}
              </strong>
            </span>
          </div>
        </div>
      </div>

      <div className="page-content">
        <div className="graph-section">
          <ResourceGraph
            metric="gpu"
            label="GPU Usage"
            color="#ffd600"
            fillColor="rgba(255,214,0,0.15)"
          />
        </div>

        <div className="gpu-triple-grid">
          {/* -------- Memory (dedicated VRAM + shared spec) -------- */}
          <div className="info-panel">
            <h3 className="section-title">Dedicated VRAM</h3>
            <div className="composition-bar">
              <div
                className="composition-segment"
                style={{
                  width: `${mem.dedicatedPct}%`,
                  background: "var(--accent-yellow)",
                }}
                title={`Used: ${formatBytes(mem.dedicatedUsed)}`}
              />
              <div
                className="composition-segment"
                style={{
                  width: `${100 - mem.dedicatedPct}%`,
                  background: "rgba(255,255,255,0.08)",
                }}
                title={`Free: ${formatBytes(mem.dedicatedFree)}`}
              />
            </div>
            <div className="composition-legend">
              <div className="composition-legend-item">
                <span
                  className="legend-dot"
                  style={{ background: "var(--accent-yellow)" }}
                />
                <span className="legend-name">Used</span>
                <span className="legend-value">
                  {formatBytes(mem.dedicatedUsed)}
                </span>
              </div>
              <div className="composition-legend-item">
                <span
                  className="legend-dot"
                  style={{
                    background: "rgba(255,255,255,0.15)",
                    border: "1px solid rgba(255,255,255,0.15)",
                  }}
                />
                <span className="legend-name">Free</span>
                <span className="legend-value">
                  {formatBytes(mem.dedicatedFree)}
                </span>
              </div>
            </div>
            {mem.sharedTotal > 0 && (
              <>
                <h3
                  className="section-title"
                  style={{ marginTop: 16 }}
                  title="System RAM the GPU is allowed to borrow when dedicated VRAM fills up. Shared with the rest of the OS."
                >
                  Shared memory
                </h3>
                <div className="composition-bar">
                  <div
                    className="composition-segment"
                    style={{
                      width: `${mem.sharedPct}%`,
                      background: "var(--accent-orange)",
                    }}
                    title={`Used: ${formatBytes(mem.sharedUsed)}`}
                  />
                  <div
                    className="composition-segment"
                    style={{
                      width: `${100 - mem.sharedPct}%`,
                      background: "rgba(255,255,255,0.08)",
                    }}
                    title={`Free: ${formatBytes(mem.sharedFree)}`}
                  />
                </div>
                <div className="composition-legend">
                  <div className="composition-legend-item">
                    <span
                      className="legend-dot"
                      style={{ background: "var(--accent-orange)" }}
                    />
                    <span className="legend-name">Used</span>
                    <span className="legend-value">
                      {formatBytes(mem.sharedUsed)}
                    </span>
                  </div>
                  <div className="composition-legend-item">
                    <span
                      className="legend-dot"
                      style={{
                        background: "rgba(255,255,255,0.15)",
                        border: "1px solid rgba(255,255,255,0.15)",
                      }}
                    />
                    <span className="legend-name">Free</span>
                    <span className="legend-value">
                      {formatBytes(mem.sharedFree)}
                    </span>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* -------- Temperature / Thermometer -------- */}
          <div className="info-panel thermometer-card">
            <h3 className="section-title">Temperature</h3>
            <Thermometer
              celsius={current.gpu_temperature}
              unit={settings.temperatureUnit}
            />
            {current.fan_rpm > 0 && (
              <div className="fan-readout">
                <span className="fan-label">Fan speed</span>
                <span className="fan-value">
                  {current.fan_rpm.toLocaleString()} RPM
                </span>
              </div>
            )}
          </div>

          {/* -------- Details: GPU / resolution / refresh-rate switchers -------- */}
          <div className="info-panel">
            <h3 className="section-title">Details</h3>

            <div className="display-controls">
              {/* Always show the GPU selector, even when there's only one. */}
              <div className="display-control-row">
                <label>GPU</label>
                <div className="select-wrap">
                  <select
                    value={selectedAdapterKey}
                    onChange={(e) => setSelectedAdapterKey(e.target.value)}
                    disabled={adapters.length === 0}
                  >
                    {adapters.length === 0 && (
                      <option value="">No adapters detected</option>
                    )}
                    {adapters.map((a) => {
                      const key = `${a.luid_high}:${a.luid_low}`;
                      return (
                        <option key={key} value={key}>
                          {a.name}
                          {a.is_primary ? " (Active)" : ""}
                        </option>
                      );
                    })}
                  </select>
                </div>
              </div>

              {monitors.length === 0 && (
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--text-muted)",
                    padding: "2px 0",
                  }}
                >
                  No active displays detected.
                </div>
              )}

              {monitors.map((m, idx) => {
                const currentRes = `${m.current.width}x${m.current.height}`;
                // Prefer the friendly name from the OS; otherwise fall back
                // to "Primary / Secondary / Tertiary" by index. The backend
                // already sorts primary first.
                const ordinal =
                  idx === 0
                    ? "Primary display"
                    : idx === 1
                      ? "Secondary display"
                      : idx === 2
                        ? "Tertiary display"
                        : `Display ${idx + 1}`;
                const label = m.friendly_name?.trim() || ordinal;
                return (
                  <div key={m.device_name} className="display-monitor-block">
                    {monitors.length > 1 && (
                      <div className="display-monitor-label">{label}</div>
                    )}
                    <div className="display-control-row">
                      <label>Resolution</label>
                      <div className="select-wrap">
                        <select
                          value={currentRes}
                          onChange={(e) =>
                            handleResolutionChange(m, e.target.value)
                          }
                          disabled={busy}
                        >
                          {m.resolutions.map(([w, h]) => (
                            <option key={`${w}x${h}`} value={`${w}x${h}`}>
                              {w} × {h}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <div className="display-control-row">
                      <label>Refresh rate</label>
                      <div className="select-wrap">
                        <select
                          value={String(m.current.refresh_hz)}
                          onChange={(e) =>
                            handleRefreshChange(m, e.target.value)
                          }
                          disabled={busy}
                        >
                          {m.refresh_rates_at_current.map((hz) => (
                            <option key={hz} value={String(hz)}>
                              {hz} Hz
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <button
              className="graphics-settings-btn"
              onClick={handleOpenGraphicsSettings}
              title="Open Windows Graphics settings to assign a preferred GPU per application"
              style={{ marginTop: 10 }}
            >
              Windows Graphics Settings…
            </button>
          </div>
        </div>

        {/* -------- Top GPU Consumers (per-process %) + dedicated VRAM)) -------- */}
        <TopGpuConsumers historyRef={historyRef} />
      </div>
    </div>
  );
}

/** Top GPU Consumers card — siblings the existing CPU/Memory cards in style.
 *  We render the raw VRAM cell only when at least one process reports a
 *  meaningful figure (some PDH counters return 0 across the board on certain
 *  driver/Windows combinations; in that case we silently fall back to a
 *  classic %-only layout to avoid an entire column of dashes). */
function TopGpuConsumers({
  historyRef,
}: {
  historyRef: ReturnType<typeof usePerformanceData>["historyRef"];
}) {
  const arr = historyRef.current?.toArray() ?? [];
  const latest = arr[arr.length - 1];
  const topGpu = latest?.topGpu ?? [];
  const visible = topGpu.filter((p) => p.value > 0.1 || (p.memBytes ?? 0) > 0);
  const anyMem = visible.some((p) => (p.memBytes ?? 0) > 0);

  return (
    <div className="info-panel">
      <h3 className="section-title">Top GPU Consumers</h3>
      <div className={`top-consumers-list ${anyMem ? "with-cpu-time" : ""}`}>
        {visible.slice(0, 6).map((proc, i) => (
          <div key={i} className="consumer-row">
            <span className="consumer-name" title={proc.name}>{proc.name}</span>
            <div className="consumer-bar-track">
              <div
                className="consumer-bar-fill"
                style={{
                  width: `${Math.min(proc.value, 100)}%`,
                  background: proc.value > 50 ? "var(--accent-red)" : proc.value > 20 ? "var(--accent-orange)" : "var(--accent-yellow)",
                }}
              />
            </div>
            {anyMem && (
              <span
                className="consumer-subvalue"
                title="Dedicated GPU memory (VRAM) currently in use"
              >
                {formatGpuMem(proc.memBytes ?? 0)}
              </span>
            )}
            <span className="consumer-value">{proc.value.toFixed(1)}%</span>
          </div>
        ))}
        {visible.length === 0 && (
          <div className="empty-state">No significant GPU usage</div>
        )}
      </div>
    </div>
  );
}

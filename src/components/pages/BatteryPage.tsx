import { usePerformanceData } from "../../hooks/usePerformanceData";
import { ResourceGraph } from "../ResourceGraph";
import { WhBarMiniChart } from "../WhBarMiniChart";
import { useEffect, useMemo, useState } from "react";
import { clearBatteryHourlyHistory, getLast24HoursAppsWh } from "../../lib/batteryUsage";
import { getWindowsBatteryUsage, type WindowsBatteryUsage } from "../../lib/ipc";

type BatteryUsageRange = "24h" | "7d";

function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function buildSevenDayWindowFromOs(rows: { day: string; drain_wh: number }[]): { day: string; systemWh: number }[] {
  const map = new Map(rows.map((r) => [r.day, r.drain_wh]));
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  const out: { day: string; systemWh: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(end);
    d.setDate(d.getDate() - i);
    const key = localDayKey(d);
    out.push({ day: key, systemWh: map.get(key) ?? 0 });
  }
  return out;
}

export function BatteryPage() {
  const { current, historyRef } = usePerformanceData();
  const [range, setRange] = useState<BatteryUsageRange>("24h");
  const [usageNonce, setUsageNonce] = useState(0);
  const [osSnapshot, setOsSnapshot] = useState<WindowsBatteryUsage | null>(null);
  const [osLoading, setOsLoading] = useState(false);
  const [osError, setOsError] = useState<string | null>(null);
  const [osRefreshKey, setOsRefreshKey] = useState(0);

  if (!current) return <div className="loading-overlay">Initializing Battery metrics...</div>;

  const formatTime = (seconds: number) => {
    if (seconds < 0) return null;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  };

  const getTimeStatus = () => {
    if (current.battery_percent >= 100 && current.is_charging) {
      return { label: "Status", value: "Fully charged" };
    }
    if (current.is_charging) {
      if (current.charge_rate_watts > 0.5 && current.battery_full_charge_capacity_mwh > 0) {
        const remainingPct = 100 - current.battery_percent;
        const remainingMwh = (remainingPct / 100) * current.battery_full_charge_capacity_mwh;
        const hoursToFull = remainingMwh / (current.charge_rate_watts * 1000);
        const formatted = formatTime(hoursToFull * 3600);
        return { label: "Time to full", value: formatted || "Calculating..." };
      }
      return { label: "Time to full", value: "Calculating..." };
    }
    const formatted = formatTime(current.battery_time_remaining);
    return { label: "Time remaining", value: formatted || "Calculating..." };
  };

  const timeStatus = getTimeStatus();
  const wallInput = current.is_charging ? Math.max(current.charge_rate_watts, current.power_draw_watts) : 0;
  const systemDraw = current.power_draw_watts;
  const netOffset = wallInput - systemDraw;

  const arr = historyRef.current?.toArray() ?? [];
  const latest = arr[arr.length - 1];
  const topPower = latest?.topPower ?? [];

  const designCap = current.battery_design_capacity_mwh;
  const fullChargeCap = current.battery_full_charge_capacity_mwh;
  const healthPct = designCap > 0 ? Math.min((fullChargeCap / designCap) * 100, 100) : 0;
  const hasHealthData = designCap > 0;

  const maxPowerBar = Math.max(wallInput, systemDraw, 1);

  useEffect(() => {
    let cancelled = false;
    setOsLoading(true);
    setOsError(null);
    getWindowsBatteryUsage()
      .then((snap) => {
        if (!cancelled) setOsSnapshot(snap);
      })
      .catch((e) => {
        if (!cancelled) {
          setOsError(e instanceof Error ? e.message : String(e));
          setOsSnapshot(null);
        }
      })
      .finally(() => {
        if (!cancelled) setOsLoading(false);
      });
    return () => { cancelled = true; };
  }, [osRefreshKey]);

  const hourly = osSnapshot?.hourly_24h ?? [];
  const daily7 = useMemo(
    () => (osSnapshot ? buildSevenDayWindowFromOs(osSnapshot.daily_7d) : []),
    [osSnapshot],
  );

  const total24Wh = hourly.reduce((s, x) => s + x.drain_wh, 0);
  const total7Wh = daily7.reduce((s, x) => s + x.systemWh, 0);

  const chartValues24 = hourly.map((h) => h.drain_wh);
  const chartLabels24 = hourly.map((h, i) => (i % 4 === 0 ? h.bucket_start_local.slice(11, 13) : ""));

  const chartValues7 = daily7.map((d) => d.systemWh);
  const chartLabels7 = daily7.map((d) => d.day.slice(5));

  const apps24h = getLast24HoursAppsWh(10);
  const appsMax = Math.max(...apps24h.map((a) => a.wh), 0.01);

  return (
    <div className="resource-page">
      <div className="page-header">
        <div className="header-main">
          <h2>Battery</h2>
          <div className="header-meta">
            <span className="meta-item">Status: <strong>{current.is_charging ? "Charging" : "On Battery"}</strong></span>
            <span className="meta-item">Level: <strong>{current.battery_percent.toFixed(0)}%</strong></span>
            <span className="meta-item">Draw: <strong>{systemDraw.toFixed(1)} W</strong></span>
          </div>
        </div>
      </div>

      <div className="page-content">
        <div className="graph-section">
          <ResourceGraph metric="battery" label="Power Draw (W)" color="#a78bfa" fillColor="rgba(167,139,250,0.15)" />
        </div>

        <div className="two-col-grid">
          <div className="info-panel">
            <h3 className="section-title">Status</h3>
            <div className="spec-row"><span className="label">{timeStatus.label}</span> <span className="value">{timeStatus.value}</span></div>
            <div className="spec-row"><span className="label">Charge level</span> <span className="value">{current.battery_percent.toFixed(0)}%</span></div>
            <div className="spec-row">
              <span className="label">Mode</span>
              <span className="value">{current.is_charging ? "⚡ AC Power" : "🔋 Battery"}</span>
            </div>
            {current.battery_voltage > 0 && (
              <div className="spec-row"><span className="label">Voltage</span> <span className="value">{current.battery_voltage.toFixed(2)} V</span></div>
            )}
            {current.battery_cycle_count > 0 && (
              <div className="spec-row"><span className="label">Cycle count</span> <span className="value">{current.battery_cycle_count}</span></div>
            )}
          </div>

          <div className="info-panel">
            <h3 className="section-title">Power Flow</h3>
            <div className="power-flow-visual">
              <div className="power-flow-row">
                <span className="power-flow-label">Charger Input</span>
                <div className="power-flow-bar-track">
                  <div
                    className="power-flow-bar-fill charger"
                    style={{ width: `${(wallInput / maxPowerBar) * 100}%` }}
                  />
                </div>
                <span className="power-flow-watts positive">+{wallInput.toFixed(1)} W</span>
              </div>
              <div className="power-flow-row">
                <span className="power-flow-label">System Draw</span>
                <div className="power-flow-bar-track">
                  <div
                    className="power-flow-bar-fill system"
                    style={{ width: `${(systemDraw / maxPowerBar) * 100}%` }}
                  />
                </div>
                <span className="power-flow-watts negative">-{systemDraw.toFixed(1)} W</span>
              </div>
              <div className="power-flow-divider" />
              <div className="power-flow-row net-row">
                <span className="power-flow-label">Net</span>
                <div className="power-flow-bar-track">
                  <div
                    className={`power-flow-bar-fill ${netOffset >= 0 ? "charger" : "system"}`}
                    style={{ width: `${(Math.abs(netOffset) / maxPowerBar) * 100}%` }}
                  />
                </div>
                <span className={`power-flow-watts ${netOffset >= 0 ? "positive" : "negative"}`}>
                  {netOffset >= 0 ? "+" : ""}{netOffset.toFixed(1)} W
                </span>
              </div>
            </div>
            {!current.is_charging && (
              <div className="estimate-note" style={{ marginTop: "8px" }}>
                Not connected to charger — system running on battery.
              </div>
            )}
          </div>

          <div className="info-panel">
            <h3 className="section-title">Battery Health</h3>
            {hasHealthData ? (
              <>
                <div className="health-bar-container">
                  <div className="health-bar">
                    <div
                      className="health-bar-fill"
                      style={{
                        width: `${healthPct}%`,
                        background: healthPct > 80 ? "var(--accent-green)" : healthPct > 50 ? "var(--accent-orange)" : "var(--accent-red)",
                      }}
                    />
                  </div>
                  <span className="health-pct">{healthPct.toFixed(1)}%</span>
                </div>
                <div className="spec-row"><span className="label">Design capacity</span> <span className="value">{(designCap / 1000).toFixed(1)} Wh</span></div>
                <div className="spec-row"><span className="label">Full charge capacity</span> <span className="value">{(fullChargeCap / 1000).toFixed(1)} Wh</span></div>
                <div className="spec-row"><span className="label">Wear</span> <span className="value">{((designCap - fullChargeCap) / 1000).toFixed(1)} Wh ({(100 - healthPct).toFixed(1)}%)</span></div>
              </>
            ) : (
              <div className="empty-state">Battery health data unavailable</div>
            )}
          </div>

          <div className="info-panel">
            <h3 className="section-title">
              Per-Process Power
              <span className="estimate-badge">Estimated</span>
            </h3>
            <div className="power-process-list">
              {topPower.length === 0 ? (
                <div className="empty-state">No significant power consumers detected</div>
              ) : (
                topPower.map((proc: { name: string; value: number }) => {
                  const pct = systemDraw > 0
                    ? (proc.value / systemDraw) * 100 : 0;
                  return (
                    <div key={proc.name} className="power-process-row">
                      <div className="power-process-info">
                        <span className="power-process-name">{proc.name}</span>
                        <span className="power-process-watts">{proc.value.toFixed(2)} W</span>
                      </div>
                      <div className="power-bar-track">
                        <div className="power-bar-fill" style={{ width: `${Math.min(pct, 100)}%` }} />
                      </div>
                      <span className="power-process-pct">{pct.toFixed(0)}%</span>
                    </div>
                  );
                })
              )}
            </div>
            <div className="estimate-note">
              Estimated from CPU share, GPU share when system and per-process usage are at least 5%, and display backlight from WMI brightness when available.
            </div>
          </div>

          <div className="info-panel" style={{ gridColumn: "1 / -1" }}>
            <h3 className="section-title">Battery Usage</h3>
            <div className="setting-row" style={{ marginBottom: 10 }}>
              <span className="setting-label">Range</span>
              <div className="setting-control">
                <button type="button" className={`theme-btn ${range === "24h" ? "active" : ""}`} onClick={() => setRange("24h")}>Last 24 hours</button>
                <button type="button" className={`theme-btn ${range === "7d" ? "active" : ""}`} onClick={() => setRange("7d")}>Last 7 days</button>
              </div>
            </div>

            {osLoading && (
              <div className="estimate-note" style={{ marginTop: 4 }}>Loading Windows battery report…</div>
            )}
            {osError && (
              <div className="estimate-note" style={{ marginTop: 4, color: "var(--accent-orange)" }}>
                Windows report unavailable: {osError}
              </div>
            )}

            <div className="spec-row">
              <span className="label">{range === "24h" ? "Total drain (24h, on battery)" : "Total drain (7 days, on battery)"}</span>
              <span className="value">
                {range === "24h" ? total24Wh.toFixed(2) : total7Wh.toFixed(2)} Wh
              </span>
            </div>

            <div className="estimate-note" style={{ marginTop: 8 }}>
              {range === "24h"
                ? "Bars: Windows battery report, summed per hour while on battery (last 24h ending at report time). Refresh to update."
                : "Bars: Windows battery report, total on-battery drain per calendar day. Days with no battery use show 0."}
            </div>

            {range === "24h" && hourly.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <WhBarMiniChart
                  values={chartValues24}
                  labels={chartLabels24}
                  color="#a78bfa"
                  height={72}
                />
              </div>
            )}
            {range === "24h" && !osLoading && hourly.length === 0 && !osError && (
              <div className="empty-state" style={{ marginTop: 8 }}>No on-battery usage in the report window.</div>
            )}

            {range === "7d" && daily7.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <WhBarMiniChart
                  values={chartValues7}
                  labels={chartLabels7}
                  color="#8b5cf6"
                  height={80}
                />
              </div>
            )}

            {range === "24h" && (
              <>
                <h4 className="section-title" style={{ marginTop: 16, fontSize: "13px" }}>Per process (last 24h)</h4>
                <div className="estimate-note" style={{ marginTop: 4 }}>
                  Windows does not expose per-app energy in the battery report XML. Below uses TaskManager+ estimates only while the app was open on battery.
                </div>
                {apps24h.length === 0 ? (
                  <div className="empty-state" style={{ marginTop: 8 }}>No per-app data yet — run on battery with TaskManager+ open.</div>
                ) : (
                  <div className="power-process-list" style={{ marginTop: 8 }} key={usageNonce}>
                    {apps24h.map((a) => (
                      <div key={a.name} className="power-process-row">
                        <div className="power-process-info">
                          <span className="power-process-name">{a.name}</span>
                          <span className="power-process-watts">{a.wh.toFixed(2)} Wh</span>
                        </div>
                        <div className="power-bar-track">
                          <div
                            className="power-bar-fill"
                            style={{ width: `${Math.min((a.wh / appsMax) * 100, 100)}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {range === "7d" && (
              <div className="estimate-note" style={{ marginTop: 12 }}>
                Per-app breakdown for a full week is not available from the battery report. Use Last 24 hours for in-app per-process estimates.
              </div>
            )}

            <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
              <button type="button" className="theme-btn" onClick={() => setOsRefreshKey((k) => k + 1)} disabled={osLoading}>
                Refresh Windows report
              </button>
              {range === "24h" && (
                <button
                  type="button"
                  className="theme-btn"
                  onClick={() => { clearBatteryHourlyHistory(); setUsageNonce((x) => x + 1); }}
                >
                  Clear in-app 24h app data
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

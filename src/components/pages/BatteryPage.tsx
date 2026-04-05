import { usePerformanceData } from "../../hooks/usePerformanceData";
import { ResourceGraph } from "../ResourceGraph";

export function BatteryPage() {
  const { current, historyRef } = usePerformanceData();

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

  // Power flow bar: shows charger input vs system draw visually
  const maxPowerBar = Math.max(wallInput, systemDraw, 1);

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

        {/* 2x2 Card Grid */}
        <div className="two-col-grid">
          {/* Card 1: Status & Time */}
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

          {/* Card 2: Power Flow (charger input vs system draw) */}
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
                    className={`power-flow-bar-fill ${netOffset >= 0 ? 'charger' : 'system'}`}
                    style={{ width: `${(Math.abs(netOffset) / maxPowerBar) * 100}%` }}
                  />
                </div>
                <span className={`power-flow-watts ${netOffset >= 0 ? 'positive' : 'negative'}`}>
                  {netOffset >= 0 ? '+' : ''}{netOffset.toFixed(1)} W
                </span>
              </div>
            </div>
            {!current.is_charging && (
              <div className="estimate-note" style={{ marginTop: "8px" }}>
                Not connected to charger — system running on battery.
              </div>
            )}
          </div>

          {/* Card 3: Battery Health */}
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

          {/* Card 4: Per-Process Power */}
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
              Estimated from CPU time share of total system power.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

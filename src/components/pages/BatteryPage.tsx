import { usePerformanceData } from "../../hooks/usePerformanceData";
import { ResourceGraph } from "../ResourceGraph";

export function BatteryPage() {
  const { current, historyRef } = usePerformanceData();

  if (!current) return <div className="loading-overlay">Initializing Battery metrics...</div>;

  const formatTime = (seconds: number) => {
    if (seconds < 0) return "Calculating...";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  };

  const wallInput = current.is_charging ? Math.max(current.charge_rate_watts, current.power_draw_watts) : 0;
  const netOffset = wallInput - current.power_draw_watts;

  const latest = historyRef.current?.latest;
  const topPower = latest?.topPower ?? [];

  return (
    <div className="resource-page">
      <div className="page-header">
        <div className="header-main">
          <h2>Battery Performance</h2>
          <div className="header-meta">
            <span className="meta-item">Status: <strong>{current.is_charging ? "On AC" : "On Battery"}</strong></span>
            <span className="meta-item">Level: <strong>{current.battery_percent.toFixed(0)}%</strong></span>
            <span className="meta-item">Draw: <strong>{current.power_draw_watts.toFixed(1)} W</strong></span>
          </div>
        </div>
      </div>

      <div className="page-content">
        <div className="graph-section">
          <ResourceGraph metric="battery" height={250} label="Power Draw (W)" color="#ff9800" fillColor="rgba(255,152,0,0.15)" />
        </div>

        <div className="battery-details-grid">
          <div className="battery-offset-section">
            <div className="offset-card">
              <h3 className="section-title">Power Offset</h3>
              <div className="offset-viz">
                <div className="offset-item">
                  <span className="label">Wall/Charger Input</span>
                  <span className="value positive">+{wallInput.toFixed(1)} W</span>
                </div>
                <div className="offset-arrow">&rarr;</div>
                <div className="offset-item">
                  <span className="label">System Total Draw</span>
                  <span className="value negative">-{current.power_draw_watts.toFixed(1)} W</span>
                </div>
                <div className="offset-divider">=</div>
                <div className="offset-item total">
                  <span className="label">Net Change</span>
                  <span className={`value ${netOffset >= 0 ? 'positive' : 'negative'}`}>
                    {netOffset >= 0 ? '+' : ''}{netOffset.toFixed(1)} W
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="battery-process-breakdown">
            <h3 className="section-title">Per-Process Power Usage</h3>
            <div className="power-process-list">
              {topPower.length === 0 ? (
                <div className="empty-state">No significant power consumers detected</div>
              ) : (
                topPower.map((proc) => {
                  const pct = current.power_draw_watts > 0
                    ? (proc.value / current.power_draw_watts) * 100 : 0;
                  return (
                    <div key={proc.name} className="power-process-row">
                      <div className="power-process-info">
                        <span className="power-process-name">{proc.name}</span>
                        <span className="power-process-watts">{proc.value.toFixed(2)} W</span>
                      </div>
                      <div className="power-bar-track">
                        <div
                          className="power-bar-fill"
                          style={{ width: `${Math.min(pct, 100)}%` }}
                        />
                      </div>
                      <span className="power-process-pct">{pct.toFixed(0)}%</span>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div className="battery-specs-panel">
            <h3 className="section-title">Estimates</h3>
            <div className="spec-row"><span className="label">Time remaining:</span> <span className="value">{formatTime(current.battery_time_remaining)}</span></div>
            <div className="spec-row"><span className="label">Total draw:</span> <span className="value">{current.power_draw_watts.toFixed(1)} W</span></div>
            <div className="spec-row"><span className="label">Charge rate:</span> <span className="value">{current.charge_rate_watts.toFixed(1)} W</span></div>
            <div className="spec-row"><span className="label">Charge level:</span> <span className="value">{current.battery_percent.toFixed(0)}%</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}

import { useSettings, ALL_COLUMNS, ACCENT_PRESETS, type GraphSize } from "../../lib/settings";

export function SettingsPage() {
  const [settings, update] = useSettings();

  const toggleColumn = (colId: string) => {
    const hidden = new Set(settings.hiddenColumns);
    if (hidden.has(colId)) hidden.delete(colId);
    else hidden.add(colId);
    update({ hiddenColumns: Array.from(hidden) });
  };

  return (
    <div className="resource-page settings-page">
      <div className="page-header">
        <div className="header-main">
          <h2>Settings</h2>
          <div className="header-meta">
            <span className="meta-item">Customize your TaskManager+ experience</span>
          </div>
        </div>
      </div>

      <div className="page-content">
        <div className="two-col-grid">
          {/* Appearance */}
          <div className="info-panel">
            <h3 className="section-title">Appearance</h3>

            <div className="setting-row">
              <span className="setting-label">Theme</span>
              <div className="setting-control">
                <button
                  className={`theme-btn ${settings.theme === "dark" ? "active" : ""}`}
                  onClick={() => update({ theme: "dark" })}
                >
                  Dark
                </button>
                <button
                  className={`theme-btn ${settings.theme === "light" ? "active" : ""}`}
                  onClick={() => update({ theme: "light" })}
                >
                  Light
                </button>
              </div>
            </div>

            <div className="setting-row">
              <span className="setting-label">Accent Color</span>
              <div className="accent-picker">
                {ACCENT_PRESETS.map(preset => (
                  <button
                    key={preset.value}
                    className={`accent-swatch ${settings.accentColor === preset.value ? "active" : ""}`}
                    style={{ background: preset.value }}
                    onClick={() => update({ accentColor: preset.value })}
                    title={preset.label}
                  />
                ))}
              </div>
            </div>

            <div className="setting-row">
              <span className="setting-label">Graph Size</span>
              <div className="setting-control">
                {(["small", "medium", "large"] as GraphSize[]).map(size => (
                  <button
                    key={size}
                    className={`theme-btn ${settings.graphSize === size ? "active" : ""}`}
                    onClick={() => update({ graphSize: size })}
                  >
                    {size.charAt(0).toUpperCase() + size.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            <div className="setting-row">
              <span className="setting-label">Display Values</span>
              <div className="setting-control">
                <button
                  className={`theme-btn ${settings.displayMode === "percent" ? "active" : ""}`}
                  onClick={() => update({ displayMode: "percent" })}
                >
                  %
                </button>
                <button
                  className={`theme-btn ${settings.displayMode === "values" ? "active" : ""}`}
                  onClick={() => update({ displayMode: "values" })}
                >
                  Values
                </button>
              </div>
            </div>

            <div className="setting-row">
              <span className="setting-label">Temperature Unit</span>
              <div className="setting-control">
                <button
                  className={`theme-btn ${settings.temperatureUnit === "celsius" ? "active" : ""}`}
                  onClick={() => update({ temperatureUnit: "celsius" })}
                >
                  Celsius
                </button>
                <button
                  className={`theme-btn ${settings.temperatureUnit === "fahrenheit" ? "active" : ""}`}
                  onClick={() => update({ temperatureUnit: "fahrenheit" })}
                >
                  Fahrenheit
                </button>
              </div>
            </div>
          </div>

          {/* Process Table Columns */}
          <div className="info-panel">
            <h3 className="section-title">Process Table Columns</h3>
            <p className="setting-description">Choose which columns to show in the processes view.</p>
            <div className="column-toggles">
              {ALL_COLUMNS.map(col => {
                const isHidden = settings.hiddenColumns.includes(col.id);
                const alwaysVisible = "alwaysVisible" in col && col.alwaysVisible;
                return (
                  <label
                    key={col.id}
                    className={`column-toggle ${alwaysVisible ? "locked" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={!isHidden}
                      disabled={alwaysVisible}
                      onChange={() => !alwaysVisible && toggleColumn(col.id)}
                    />
                    <span className="toggle-track">
                      <span className="toggle-thumb" />
                    </span>
                    <span className="toggle-label">{col.label}</span>
                  </label>
                );
              })}
            </div>
          </div>

          {/* Behavior */}
          <div className="info-panel">
            <h3 className="section-title">Behavior</h3>

            <div className="setting-row">
              <span className="setting-label">Update Interval</span>
              <div className="setting-control">
                <select
                  className="setting-select"
                  value={settings.refreshRate}
                  onChange={e => update({ refreshRate: Number(e.target.value) })}
                >
                  <option value={500}>Fast (500ms)</option>
                  <option value={1000}>Normal (1s)</option>
                  <option value={2000}>Slow (2s)</option>
                  <option value={5000}>Very Slow (5s)</option>
                </select>
              </div>
            </div>

            <label className="setting-toggle-row">
              <input
                type="checkbox"
                checked={settings.confirmEndTask}
                onChange={e => update({ confirmEndTask: e.target.checked })}
              />
              <span className="toggle-track"><span className="toggle-thumb" /></span>
              <span className="setting-label">Confirm before ending tasks</span>
            </label>

            <label className="setting-toggle-row">
              <input
                type="checkbox"
                checked={settings.minimizeToTray}
                onChange={e => update({ minimizeToTray: e.target.checked })}
              />
              <span className="toggle-track"><span className="toggle-thumb" /></span>
              <span className="setting-label">Minimize to system tray</span>
            </label>
          </div>

          {/* Sidebar Resources */}
          <div className="info-panel">
            <h3 className="section-title">Sidebar Resources</h3>
            <p className="setting-description">Toggle visibility of resources in the sidebar.</p>

            <label className="setting-toggle-row">
              <input
                type="checkbox"
                checked={settings.showGpu}
                onChange={e => update({ showGpu: e.target.checked })}
              />
              <span className="toggle-track"><span className="toggle-thumb" /></span>
              <span className="setting-label">Show GPU</span>
            </label>

            <label className="setting-toggle-row">
              <input
                type="checkbox"
                checked={settings.showBattery}
                onChange={e => update({ showBattery: e.target.checked })}
              />
              <span className="toggle-track"><span className="toggle-thumb" /></span>
              <span className="setting-label">Show Battery</span>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}

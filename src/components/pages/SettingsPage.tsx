import { useSettings, ALL_COLUMNS, ACCENT_PRESETS, type GraphSize } from "../../lib/settings";
import { openWindowsSettingsUri, WINDOWS_POWER_SETTINGS_URI } from "../../lib/ipc";
import { reopenOnboarding } from "../OnboardingTour";
import {
  AI_TIERS,
  AI_TIER_LABELS,
  AI_TIER_DESCRIPTIONS,
  AI_TIER_SIZE_LABELS,
  type AiTier,
} from "../../lib/ai/types";
import { AiModelInstall } from "../AiModelInstall";
import { EmbeddingAccelerationCard } from "../EmbeddingAccelerationCard";
import { GpuAccelerationCard } from "../GpuAccelerationCard";
import { McpServerCard } from "../McpServerCard";

// v2.1 reorg: collapsed from 9 separate cards to 5, with secondary
// controls (process columns, vendor toggles) in <details> elements so
// they don't dominate the page. Functionality is identical to v2.0;
// only the layout and copy changed. The AI section keeps its 4 sub-
// cards because each is a meaningful capability with its own UX.
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

          {/* === Card 1: Appearance === */}
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
              <span className="setting-label">Accent</span>
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
              <span className="setting-label">Graph size</span>
              <div className="setting-control">
                {(["small", "medium", "large"] as GraphSize[]).map(size => (
                  <button
                    key={size}
                    className={`theme-btn ${settings.graphSize === size ? "active" : ""}`}
                    onClick={() => update({ graphSize: size })}
                  >
                    {size[0].toUpperCase() + size.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            <div className="setting-row">
              <span className="setting-label">Show as</span>
              <div className="setting-control">
                <button
                  className={`theme-btn ${settings.displayMode === "percent" ? "active" : ""}`}
                  onClick={() => update({ displayMode: "percent" })}
                >%</button>
                <button
                  className={`theme-btn ${settings.displayMode === "values" ? "active" : ""}`}
                  onClick={() => update({ displayMode: "values" })}
                >Values</button>
              </div>
            </div>

            <div className="setting-row">
              <span className="setting-label">Temperature</span>
              <div className="setting-control">
                <button
                  className={`theme-btn ${settings.temperatureUnit === "celsius" ? "active" : ""}`}
                  onClick={() => update({ temperatureUnit: "celsius" })}
                >°C</button>
                <button
                  className={`theme-btn ${settings.temperatureUnit === "fahrenheit" ? "active" : ""}`}
                  onClick={() => update({ temperatureUnit: "fahrenheit" })}
                >°F</button>
              </div>
            </div>
          </div>

          {/* === Card 2: Behavior & Notifications === */}
          <div className="info-panel">
            <h3 className="section-title">Behavior</h3>

            <div className="setting-row">
              <span className="setting-label">Refresh rate</span>
              <div className="setting-control">
                <select
                  className="setting-select"
                  value={settings.refreshRate}
                  onChange={e => update({ refreshRate: Number(e.target.value) })}
                >
                  <option value={500}>Fast — 0.5s</option>
                  <option value={1000}>Normal — 1s</option>
                  <option value={2000}>Slow — 2s</option>
                  <option value={5000}>Very slow — 5s</option>
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
                checked={settings.confirmBeforeDisableStartup}
                onChange={e => update({ confirmBeforeDisableStartup: e.target.checked })}
              />
              <span className="toggle-track"><span className="toggle-thumb" /></span>
              <span className="setting-label">Confirm before disabling startup apps</span>
            </label>

            <label className="setting-toggle-row">
              <input
                type="checkbox"
                checked={settings.minimizeToTray}
                onChange={e => update({ minimizeToTray: e.target.checked })}
              />
              <span className="toggle-track"><span className="toggle-thumb" /></span>
              <span className="setting-label">Minimize to system tray (low-power monitoring)</span>
            </label>

            <label className="setting-toggle-row">
              <input
                type="checkbox"
                checked={settings.desktopNotifications}
                onChange={e => update({ desktopNotifications: e.target.checked })}
              />
              <span className="toggle-track"><span className="toggle-thumb" /></span>
              <span className="setting-label">Desktop notifications for insights</span>
            </label>

            <div className="setting-row">
              <span className="setting-label">Notify when</span>
              <div className="setting-control">
                <select
                  className="setting-select"
                  value={settings.notificationMinSeverity}
                  onChange={e =>
                    update({
                      notificationMinSeverity: e.target.value as
                        | "critical"
                        | "warning"
                        | "info",
                    })
                  }
                  disabled={!settings.desktopNotifications}
                >
                  <option value="critical">Critical only</option>
                  <option value="warning">Warning or higher</option>
                  <option value="info">Any insight (info+)</option>
                </select>
              </div>
            </div>

            <label className="setting-toggle-row">
              <input
                type="checkbox"
                checked={settings.downloadAssist}
                onChange={e => update({ downloadAssist: e.target.checked })}
              />
              <span className="toggle-track"><span className="toggle-thumb" /></span>
              <span className="setting-label">Suggest speed-ups for large downloads</span>
            </label>

            <div className="setting-row" style={{ borderBottom: "none" }}>
              <span className="setting-label">First-run tour</span>
              <div className="setting-control">
                <button type="button" className="theme-btn" onClick={reopenOnboarding}>
                  Replay
                </button>
              </div>
            </div>
          </div>

          {/* === Card 3: Layout (sidebar + columns) === */}
          <div className="info-panel">
            <h3 className="section-title">Layout</h3>

            <p className="setting-description" style={{ marginBottom: 6 }}>
              Show in sidebar
            </p>
            <div className="toggle-grid">
              <label className="setting-toggle-row">
                <input
                  type="checkbox"
                  checked={settings.showGpu}
                  onChange={e => update({ showGpu: e.target.checked })}
                />
                <span className="toggle-track"><span className="toggle-thumb" /></span>
                <span className="setting-label">GPU</span>
              </label>
              <label className="setting-toggle-row">
                <input
                  type="checkbox"
                  checked={settings.showNpu}
                  onChange={e => update({ showNpu: e.target.checked })}
                />
                <span className="toggle-track"><span className="toggle-thumb" /></span>
                <span className="setting-label">NPU</span>
              </label>
              <label className="setting-toggle-row">
                <input
                  type="checkbox"
                  checked={settings.showBattery}
                  onChange={e => update({ showBattery: e.target.checked })}
                />
                <span className="toggle-track"><span className="toggle-thumb" /></span>
                <span className="setting-label">Battery</span>
              </label>
              <label className="setting-toggle-row">
                <input
                  type="checkbox"
                  checked={settings.showStartup}
                  onChange={e => update({ showStartup: e.target.checked })}
                />
                <span className="toggle-track"><span className="toggle-thumb" /></span>
                <span className="setting-label">Startup</span>
              </label>
              <label className="setting-toggle-row">
                <input
                  type="checkbox"
                  checked={settings.showSidebarSparklines}
                  onChange={e => update({ showSidebarSparklines: e.target.checked })}
                />
                <span className="toggle-track"><span className="toggle-thumb" /></span>
                <span className="setting-label">Sparklines</span>
              </label>
            </div>

            <details className="settings-details">
              <summary>Process table columns</summary>
              <div className="settings-details-body">
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
            </details>
          </div>

          {/* === Card 4: Hardware & Power === */}
          <div className="info-panel">
            <h3 className="section-title">Hardware &amp; Power</h3>

            <div className="setting-row">
              <span className="setting-label">Power &amp; battery</span>
              <div className="setting-control">
                <button
                  type="button"
                  className="theme-btn"
                  onClick={() => { openWindowsSettingsUri(WINDOWS_POWER_SETTINGS_URI).catch(() => {}); }}
                >
                  Open in Windows
                </button>
              </div>
            </div>

            <details className="settings-details">
              <summary>Vendor controls (ASUS)</summary>
              <div className="settings-details-body">
                <label className="setting-toggle-row">
                  <input
                    type="checkbox"
                    checked={settings.enableOemPerformance}
                    onChange={e => update({ enableOemPerformance: e.target.checked })}
                  />
                  <span className="toggle-track"><span className="toggle-thumb" /></span>
                  <span className="setting-label">Enable ASUS fan telemetry</span>
                </label>
                <p className="setting-description">
                  Reads CPU fan speed via ASUS WMI. Some BIOS paths
                  require administrator privileges.
                </p>
              </div>
            </details>
          </div>

          {/* === Card 5: Local AI Features === */}
          <div className="info-panel">
            <h3 className="section-title">Local AI Features</h3>
            <p className="setting-description">
              On-device AI for file search, grouping, and writing tasks.
              {" "}<strong>No data leaves your device.</strong> Models
              download once on first enable; everything else runs locally.
            </p>

            <div className="ai-tier-selector">
              {AI_TIERS.map((tier) => {
                const isActive = settings.aiTier === tier;
                return (
                  <label
                    key={tier}
                    className={`ai-tier-option ${isActive ? "active" : ""}`}
                  >
                    <input
                      type="radio"
                      name="aiTier"
                      value={tier}
                      checked={isActive}
                      onChange={() => update({ aiTier: tier as AiTier })}
                    />
                    <div className="ai-tier-body">
                      <div className="ai-tier-head">
                        <span className="ai-tier-label">
                          {AI_TIER_LABELS[tier]}
                        </span>
                        <span className="ai-tier-size">
                          {AI_TIER_SIZE_LABELS[tier]}
                        </span>
                      </div>
                      <p className="ai-tier-description">
                        {AI_TIER_DESCRIPTIONS[tier]}
                      </p>
                    </div>
                  </label>
                );
              })}
            </div>

            <details className="settings-details">
              <summary>What the AI reads from your files</summary>
              <div className="settings-details-body">
                <p className="setting-description setting-privacy-note" style={{ margin: 0 }}>
                  To enable search and grouping, AI reads the opening of
                  your documents (about the first page) when scanning.
                  That text is used on-device to build a private index
                  and is never uploaded or stored as text — only the
                  file path and a numeric fingerprint are saved. You
                  can clear the index any time below.
                </p>
              </div>
            </details>

            <AiModelInstall />
          </div>

          {/* AI sub-features — each is a meaningful capability and
              gets its own card. They visually pair with the Local AI
              section above because they all sit on the same backend.
              (Diagnostics merged into AiModelInstall above in v2.1.) */}
          <GpuAccelerationCard />
          <EmbeddingAccelerationCard />
          <McpServerCard />

        </div>
      </div>
    </div>
  );
}

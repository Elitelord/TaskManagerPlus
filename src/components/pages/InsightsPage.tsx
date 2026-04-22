import { useEffect, useState, useCallback } from "react";
import { useInsights, dismissInsight } from "../../lib/insightsEngine";
import { usePerformanceData } from "../../hooks/usePerformanceData";
import { useThermalDelegate } from "../../hooks/useThermalDelegate";
import {
  endTask,
  launchThermalDelegate,
  listMonitors,
  openWindowsSettingsUri,
  setDisplayMode,
  WINDOWS_POWER_SETTINGS_URI,
  type MonitorInfo,
} from "../../lib/ipc";
import { useProcesses } from "../../hooks/useProcesses";
import { useSettings } from "../../lib/settings";
import type { Insight, InsightAction, WorkloadProfile } from "../../lib/insights";
import { formatDuration, type FrequentApp } from "../../lib/appUsage";
import { formatHourRange, type SchedulePattern, type HourCell } from "../../lib/usagePattern";
import {
  Cpu,
  MemoryStick,
  HardDrive,
  Wifi,
  Monitor,
  Battery,
  BatteryCharging,
  Plug,
  Info,
  Gamepad2,
  Film,
  Code2,
  Play,
  MessageCircle,
  FileText,
  Globe,
  Minus,
  Square,
  Thermometer,
  Fan,
  MonitorSmartphone,
  PlugZap,
  CircleDot,
  Activity,
} from "lucide-react";

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function PerformanceGauge({ score }: { score: number }) {
  const color = score >= 80 ? "#34d399" : score >= 50 ? "#f59e0b" : "#ef4444";
  const bgColor = score >= 80 ? "rgba(52,211,153,0.06)" : score >= 50 ? "rgba(245,158,11,0.06)" : "rgba(239,68,68,0.06)";
  const label = score >= 80 ? "Optimal" : score >= 50 ? "Fair" : "Poor";

  return (
    <div className="health-gauge" style={{ background: bgColor }}>
      <div className="health-gauge-header">
        <Activity size={14} style={{ color }} />
        <span className="health-gauge-title">System Health</span>
      </div>
      <div className="health-gauge-body">
        <div className="health-bar-outer">
          <div
            className="health-bar-inner"
            style={{
              width: `${score}%`,
              background: `linear-gradient(90deg, ${color}cc, ${color})`,
              transition: "width 0.8s ease, background 0.5s ease",
            }}
          />
        </div>
        <div className="health-gauge-stats">
          <span className="health-score" style={{ color }}>{score}<span className="health-score-max">/100</span></span>
          <span className="health-label" style={{ color }}>{label}</span>
        </div>
      </div>
    </div>
  );
}

function QuickStat({ label, value, status, accent }: { label: string; value: string; status: "good" | "warn" | "bad"; accent: string }) {
  const borderColors = { good: accent, warn: "#f59e0b", bad: "#ef4444" };
  const textColors = { good: accent, warn: "#f59e0b", bad: "#ef4444" };
  const bgs = { good: hexToRgba(accent, 0.08), warn: "rgba(245,158,11,0.08)", bad: "rgba(239,68,68,0.08)" };
  return (
    <div className="quick-stat" style={{ borderColor: borderColors[status], background: bgs[status] }}>
      <span className="quick-stat-value" style={{ color: textColors[status] }}>{value}</span>
      <span className="quick-stat-label">{label}</span>
    </div>
  );
}

const SEVERITY_CONFIG = {
  critical: { color: "#ef4444", bg: "rgba(239,68,68,0.06)", border: "rgba(239,68,68,0.3)" },
  warning: { color: "#f59e0b", bg: "rgba(245,158,11,0.06)", border: "rgba(245,158,11,0.25)" },
  info: { color: "#3b82f6", bg: "rgba(59,130,246,0.06)", border: "rgba(59,130,246,0.2)" },
};

const ICON_SIZE = 14;

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  memory: <MemoryStick size={ICON_SIZE} />,
  cpu: <Cpu size={ICON_SIZE} />,
  disk: <HardDrive size={ICON_SIZE} />,
  network: <Wifi size={ICON_SIZE} />,
  gpu: <Monitor size={ICON_SIZE} />,
  battery: <Battery size={ICON_SIZE} />,
  general: <Info size={ICON_SIZE} />,
};

function InsightCard({ insight, onAction }: { insight: Insight; onAction: (insight: Insight, action: InsightAction) => void }) {
  const config = SEVERITY_CONFIG[insight.severity];
  return (
    <div
      className="insight-card"
      style={{
        background: config.bg,
        borderLeft: `3px solid ${config.border}`,
        borderTop: `1px solid ${config.border}`,
        borderRight: `1px solid rgba(255,255,255,0.04)`,
        borderBottom: `1px solid rgba(255,255,255,0.04)`,
      }}
    >
      <div className="insight-card-header">
        <span className="insight-icon">{CATEGORY_ICONS[insight.category] || <Info size={ICON_SIZE} />}</span>
        <span className="insight-title">{insight.title}</span>
        {insight.metric && (
          <span className="insight-metric" style={{ color: config.color, background: `${config.color}1a` }}>
            {insight.metric}
          </span>
        )}
      </div>
      <p className="insight-description">{insight.description}</p>
      {insight.actions.length > 0 && (
        <div className="insight-actions">
          {insight.actions.map((action, i) => (
            <button
              key={i}
              className={`insight-btn ${
                action.type === "end-task" ? "danger" : action.type === "open-uri" ? "link" : "ghost"
              }`}
              onClick={() => onAction(insight, action)}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const FAN_COLORS = {
  silent: { color: "#34d399", bg: "rgba(52,211,153,0.08)", border: "rgba(52,211,153,0.2)" },
  balanced: { color: "#3b82f6", bg: "rgba(59,130,246,0.08)", border: "rgba(59,130,246,0.2)" },
  performance: { color: "#f59e0b", bg: "rgba(245,158,11,0.08)", border: "rgba(245,158,11,0.2)" },
  turbo: { color: "#ef4444", bg: "rgba(239,68,68,0.08)", border: "rgba(239,68,68,0.2)" },
};

function FrequentAppTile({ app, accent }: { app: FrequentApp; accent: string }) {
  const iconSrc = app.iconBase64
    ? app.iconBase64.startsWith("data:")
      ? app.iconBase64
      : `data:image/png;base64,${app.iconBase64}`
    : null;
  const displayName = (app.displayName || app.name).replace(/\.exe$/i, "");
  const timeLabel = formatDuration(app.weekSeconds > 0 ? app.weekSeconds : app.totalSeconds);
  const sublabel = app.weekSeconds > 0 ? "this week" : "all-time";
  return (
    <div
      className="frequent-app-tile"
      title={`${displayName}\n${timeLabel} ${sublabel} · ${app.sessions} session${app.sessions !== 1 ? "s" : ""}${app.isBackground ? " · background" : ""}`}
    >
      <div className="frequent-app-icon" style={{ background: hexToRgba(accent, 0.08) }}>
        {iconSrc ? (
          <img src={iconSrc} alt="" />
        ) : (
          <span className="frequent-app-icon-fallback" style={{ color: accent }}>
            {displayName.charAt(0).toUpperCase()}
          </span>
        )}
      </div>
      <div className="frequent-app-meta">
        <span className="frequent-app-name">{displayName}</span>
        <span className="frequent-app-time">
          {timeLabel}
          {app.isBackground && <span className="frequent-app-bg-dot" title="Background / always-on"> · bg</span>}
        </span>
      </div>
    </div>
  );
}

const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

function RoutinePatternRow({
  icon,
  title,
  patterns,
  emptyText,
  accentRgb,
}: {
  icon: React.ReactNode;
  title: string;
  patterns: SchedulePattern[];
  emptyText: string;
  accentRgb: string;
}) {
  return (
    <div className="routine-pattern-row">
      <div className="routine-pattern-header">
        <span className="routine-pattern-icon" style={{ color: `rgb(${accentRgb})` }}>{icon}</span>
        <span className="routine-pattern-title">{title}</span>
      </div>
      {patterns.length === 0 ? (
        <p className="routine-pattern-empty">{emptyText}</p>
      ) : (
        <ul className="routine-pattern-list">
          {patterns.map((p, i) => (
            <li key={i}>
              <span className="routine-pattern-days" style={{ background: `rgba(${accentRgb}, 0.12)`, color: `rgb(${accentRgb})` }}>
                {p.daysLabel}
              </span>
              <span className="routine-pattern-time">{formatHourRange(p.startHour, p.endHour)}</span>
              <span className="routine-pattern-conf">{Math.round(p.confidence * 100)}% confidence</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RoutineHeatmap({ grid, accent }: { grid: HourCell[][]; accent: string }) {
  if (grid.length === 0) return null;
  // Two stacked grids: active (top) and charging (bottom). They share the
  // same hour scale so a quick visual scan reveals overlap (e.g. you charge
  // overnight then become active in the morning).
  const renderGrid = (
    metric: "active" | "charging",
    label: string,
    color: string,
  ) => (
    <div className="routine-heatmap-block">
      <div className="routine-heatmap-label">{label}</div>
      <div className="routine-heatmap-grid">
        <div className="routine-heatmap-day-labels">
          {DAY_LABELS.map((d, i) => (
            <span key={i} className="routine-heatmap-day-label">{d}</span>
          ))}
        </div>
        <div className="routine-heatmap-cells">
          {grid.map((row, dayIdx) => (
            <div key={dayIdx} className="routine-heatmap-row">
              {row.map((cell, hourIdx) => {
                const ratio = metric === "active" ? cell.activeRatio : cell.chargingRatio;
                const noData = cell.observed < 60;
                const bg = noData
                  ? "rgba(255,255,255,0.04)"
                  : `rgba(${color}, ${0.08 + ratio * 0.85})`;
                const title = noData
                  ? `${DAY_LABELS[dayIdx]} ${hourIdx}:00 — no data`
                  : `${DAY_LABELS[dayIdx]} ${hourIdx}:00 — ${Math.round(ratio * 100)}% ${metric}`;
                return (
                  <div
                    key={hourIdx}
                    className="routine-heatmap-cell"
                    style={{ background: bg }}
                    title={title}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  // Soft accent — extract rgb from the user's accent if it's a hex.
  const accentRgb = accent.startsWith("#")
    ? `${parseInt(accent.slice(1, 3), 16)}, ${parseInt(accent.slice(3, 5), 16)}, ${parseInt(accent.slice(5, 7), 16)}`
    : "96, 165, 250";

  return (
    <div className="routine-heatmap">
      {renderGrid("active", "Active hours", accentRgb)}
      {renderGrid("charging", "Charging hours", "52, 211, 153")}
      <div className="routine-heatmap-axis">
        <span>12 AM</span>
        <span>6 AM</span>
        <span>12 PM</span>
        <span>6 PM</span>
        <span>12 AM</span>
      </div>
    </div>
  );
}

const WORKLOAD_ICONS: Record<string, React.ReactNode> = {
  gaming: <Gamepad2 size={14} />,
  editing: <Film size={14} />,
  development: <Code2 size={14} />,
  streaming: <Play size={14} />,
  communication: <MessageCircle size={14} />,
  office: <FileText size={14} />,
  browsing: <Globe size={14} />,
  idle: <Minus size={14} />,
  mixed: <Square size={14} />,
};

function WorkloadChip({ workload }: { workload: WorkloadProfile }) {
  return (
    <div className="workload-chip">
      <span className="workload-chip-icon">{WORKLOAD_ICONS[workload.type] || <Info size={14} />}</span>
      <span className="workload-chip-label">{workload.label}</span>
      {workload.matchedApps.length > 0 && (
        <span className="workload-chip-apps">
          {workload.matchedApps.slice(0, 2).map((a: string) => a.replace(/\.exe$/i, "")).join(", ")}
          {workload.matchedApps.length > 2 && ` +${workload.matchedApps.length - 2}`}
        </span>
      )}
    </div>
  );
}

interface InsightsPageProps {
  /** Switches the top-level tab. Used by the "Open GPU page" shortcut. */
  onNavigate?: (tab: string) => void;
}

export function InsightsPage({ onNavigate }: InsightsPageProps = {}) {
  const {
    insights,
    healthScore,
    calibrated,
    workloads,
    workloadSuggestions,
    frequentApps,
    schedulePatterns,
    hourGrid,
  } = useInsights();
  const { current: snapshot } = usePerformanceData();
  const { data: processes } = useProcesses();
  const { info: thermalDelegate, loading: thermalLoading } = useThermalDelegate();
  const [settings] = useSettings();
  const accent = settings.accentColor;
  const [thermalLaunchError, setThermalLaunchError] = useState<string | null>(null);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [displayBusy, setDisplayBusy] = useState(false);

  // Detect gaming workload — display tuning shortcuts only show while gaming.
  const isGaming = workloads.some(w => w.type === "gaming");

  // Load monitors once on mount so docked-mode detection works regardless of
  // whether the user is currently gaming. Cheap — just enumerates DEVMODEs.
  useEffect(() => {
    let cancelled = false;
    listMonitors()
      .then(m => { if (!cancelled) setMonitors(m); })
      .catch(() => { if (!cancelled) setMonitors([]); });
    return () => { cancelled = true; };
  }, []);

  const refreshMonitors = useCallback(async () => {
    try { setMonitors(await listMonitors()); } catch { /* ignore */ }
  }, []);

  // Quick action: bump every monitor to its highest available refresh rate at
  // its current resolution. Common gaming optimization.
  const handleMaxRefreshAll = useCallback(async () => {
    if (monitors.length === 0) return;
    setDisplayBusy(true);
    try {
      for (const m of monitors) {
        const maxHz = m.refresh_rates_at_current[0] ?? m.current.refresh_hz;
        if (maxHz === m.current.refresh_hz) continue;
        try {
          await setDisplayMode(m.device_name, m.current.width, m.current.height, maxHz);
        } catch (e) {
          console.error("setDisplayMode failed", e);
        }
      }
      await refreshMonitors();
    } finally {
      setDisplayBusy(false);
    }
  }, [monitors, refreshMonitors]);

  // Docked detection: a laptop is "docked" when at least one external display
  // is attached. We use the thermal delegate's chassis hint as the laptop
  // signal and the monitor count as the external-display signal. Plugged-in
  // power is a strong supporting indicator but not required (some users dock
  // for screen real estate without AC).
  const isLaptop = thermalDelegate?.isLikelyLaptop ?? false;
  const externalDisplayCount = Math.max(0, monitors.length - 1);
  const isDocked = isLaptop && externalDisplayCount > 0;

  const handleLaunchThermal = async () => {
    setThermalLaunchError(null);
    try {
      await launchThermalDelegate();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setThermalLaunchError(msg);
    }
  };

  const handleAction = async (insight: Insight, action: InsightAction) => {
    if (action.type === "dismiss") {
      dismissInsight(insight.id);
    } else if (action.type === "end-task" && action.processName && processes) {
      const pids = processes
        .filter(p => (p.display_name || p.name) === action.processName || p.name === action.processName)
        .map(p => p.pid);
      for (const pid of pids) {
        try { await endTask(pid); } catch { /* ignore */ }
      }
      dismissInsight(insight.id);
    } else if (action.type === "open-uri" && action.uri) {
      try { await openWindowsSettingsUri(action.uri); } catch { /* ignore */ }
    }
  };

  const handleCloseSuggestion = async (names: string[]) => {
    if (!processes) return;
    for (const name of names) {
      const pids = processes.filter(p => p.name === name).map(p => p.pid);
      for (const pid of pids) {
        try { await endTask(pid); } catch { /* ignore */ }
      }
    }
  };

  if (!snapshot) return <div className="loading-overlay">Initializing Insights...</div>;

  const cpuStatus: "good" | "warn" | "bad" = snapshot.cpu_usage_percent > 85 ? "bad" : snapshot.cpu_usage_percent > 60 ? "warn" : "good";
  const memUsedPct = (snapshot.used_ram_bytes / snapshot.total_ram_bytes) * 100;
  const memStatus: "good" | "warn" | "bad" = memUsedPct > 90 ? "bad" : memUsedPct > 75 ? "warn" : "good";
  const diskStatus: "good" | "warn" | "bad" = snapshot.disk_active_percent > 90 ? "bad" : snapshot.disk_active_percent > 60 ? "warn" : "good";
  const gpuStatus: "good" | "warn" | "bad" = snapshot.gpu_temperature > 85 ? "bad" : snapshot.gpu_temperature > 75 ? "warn" : "good";

  const criticals = insights.filter(i => i.severity === "critical");
  const warnings = insights.filter(i => i.severity === "warning");
  const infos = insights.filter(i => i.severity === "info");

  // Determine primary fan recommendation (highest priority workload)
  const primaryWorkload = workloads.length > 0 ? workloads[0] : null;
  const fanStyle = primaryWorkload ? (FAN_COLORS[primaryWorkload.fanProfile as keyof typeof FAN_COLORS] || FAN_COLORS.balanced) : FAN_COLORS.balanced;

  return (
    <div className="resource-page insights-page">
      <div className="page-header">
        <div className="header-main">
          <h2>Insights</h2>
          <div className="header-meta">
            <span className="meta-item">
              {!calibrated
                ? "Calibrating..."
                : `${insights.length} active insight${insights.length !== 1 ? "s" : ""}`
              }
            </span>
          </div>
        </div>
      </div>

      <div className="page-content">
        {/* Performance Score + Battery + Quick Stats */}
        <div className="insights-summary">
          <div className="insights-summary-left">
            <PerformanceGauge score={healthScore} />
            {snapshot.battery_percent > 0 && (
              <div className="battery-mini">
                <div className="battery-mini-header">
                  {snapshot.is_charging
                    ? <BatteryCharging size={14} style={{ color: "#34d399" }} />
                    : <Battery size={14} style={{ color: snapshot.battery_percent <= 20 ? "#ef4444" : "#a78bfa" }} />}
                  <span className="battery-mini-title">Battery</span>
                  {snapshot.is_charging && <Plug size={10} style={{ color: "#34d399", marginLeft: "auto" }} />}
                </div>
                <div className="battery-mini-bar-outer">
                  <div
                    className="battery-mini-bar-inner"
                    style={{
                      width: `${Math.min(snapshot.battery_percent, 100)}%`,
                      background: snapshot.is_charging
                        ? "#34d399"
                        : snapshot.battery_percent <= 20 ? "#ef4444" : "#a78bfa",
                      transition: "width 0.8s ease, background 0.5s ease",
                    }}
                  />
                </div>
                <div className="battery-mini-stats">
                  <span className="battery-mini-pct" style={{
                    color: snapshot.is_charging
                      ? "#34d399"
                      : snapshot.battery_percent <= 20 ? "#ef4444" : "#a78bfa"
                  }}>
                    {snapshot.battery_percent.toFixed(0)}%
                  </span>
                  <span className="battery-mini-detail">
                    {snapshot.is_charging
                      ? (snapshot.charge_rate_watts > 0.5 ? `+${snapshot.charge_rate_watts.toFixed(1)} W` : "Charging")
                      : (snapshot.power_draw_watts > 0.5 ? `${snapshot.power_draw_watts.toFixed(1)} W draw` : "Idle")}
                  </span>
                </div>
              </div>
            )}
          </div>
          <div className="quick-stats-grid">
            <QuickStat label="CPU" value={`${snapshot.cpu_usage_percent.toFixed(0)}%`} status={cpuStatus} accent={accent} />
            <QuickStat label="Memory" value={`${memUsedPct.toFixed(0)}%`} status={memStatus} accent={accent} />
            <QuickStat label="Disk" value={`${snapshot.disk_active_percent.toFixed(0)}%`} status={diskStatus} accent={accent} />
            <QuickStat label="GPU Temp" value={snapshot.gpu_temperature > 0 ? `${snapshot.gpu_temperature.toFixed(0)}°C` : "N/A"} status={gpuStatus} accent={accent} />
          </div>
        </div>

        {/* Workload Detection */}
        <div className="workload-section">
          <div className="workload-card">
            <div className="workload-detected">
              <div className="workload-info">
                <span className="workload-type">Detected Workloads</span>
                {workloads.length > 0 ? (
                  <div className="workload-chips">
                    {workloads.map((wl, i) => <WorkloadChip key={i} workload={wl} />)}
                  </div>
                ) : (
                  <span className="workload-label" style={{ color: "var(--text-muted)" }}>
                    {calibrated ? "No specific workload detected" : "Calibrating..."}
                  </span>
                )}
              </div>
            </div>

            {!thermalLoading && thermalDelegate && (
              <div className="thermal-delegate">
                <div className="thermal-delegate-main">
                  <div className="thermal-delegate-heading">
                    <span className="thermal-delegate-icon"><Thermometer size={14} /></span>
                    <span className="thermal-delegate-title">Fan &amp; power control</span>
                    {thermalDelegate.hasInstalledApp && (
                      <span className="thermal-delegate-badge">Installed</span>
                    )}
                  </div>
                  <p className="thermal-delegate-detail">{thermalDelegate.detailLine}</p>
                  {(thermalDelegate.manufacturer !== "Unknown" || thermalDelegate.model !== "Unknown") && (
                    <p className="thermal-delegate-meta">
                      {thermalDelegate.manufacturer !== "Unknown" ? thermalDelegate.manufacturer : "PC"}
                      {thermalDelegate.model !== "Unknown" ? ` · ${thermalDelegate.model}` : ""}
                      {!thermalDelegate.isLikelyLaptop ? " · chassis: desktop / mini" : ""}
                    </p>
                  )}
                </div>
                <div className="thermal-delegate-actions">
                  <button
                    type="button"
                    className="insight-btn link"
                    onClick={handleLaunchThermal}
                  >
                    {thermalDelegate.buttonLabel}
                  </button>
                  <button
                    type="button"
                    className="insight-btn ghost"
                    onClick={() => {
                      openWindowsSettingsUri(WINDOWS_POWER_SETTINGS_URI).catch(() => { /* ignore */ });
                    }}
                  >
                    {isLaptop ? "Power & battery settings" : "Power settings"}
                  </button>
                </div>
                {thermalLaunchError && (
                  <p className="thermal-delegate-error" style={{ color: "#ef4444", marginTop: 8, fontSize: "12px" }}>
                    Could not launch: {thermalLaunchError}
                  </p>
                )}
              </div>
            )}
            {!thermalLoading && !thermalDelegate && (
              <div className="thermal-delegate">
                <div className="thermal-delegate-main">
                  <div className="thermal-delegate-heading">
                    <span className="thermal-delegate-icon"><Thermometer size={14} /></span>
                    <span className="thermal-delegate-title">Fan &amp; power control</span>
                  </div>
                  <p className="thermal-delegate-detail">
                    We could not read your system vendor. Use Windows power settings, or install your laptop maker&apos;s control app (for example G-Helper for many ASUS / ROG models).
                  </p>
                </div>
                <div className="thermal-delegate-actions">
                  <button
                    type="button"
                    className="insight-btn link"
                    onClick={() => {
                      openWindowsSettingsUri(WINDOWS_POWER_SETTINGS_URI).catch(() => { /* ignore */ });
                    }}
                  >
                    {isLaptop ? "Open Power & battery" : "Open Power settings"}
                  </button>
                </div>
              </div>
            )}

            {primaryWorkload && (
              <div className="fan-recommendation" style={{ background: fanStyle.bg, borderColor: fanStyle.border }}>
                <div className="fan-header">
                  <span className="fan-icon"><Fan size={14} /></span>
                  <span className="fan-profile-label">Suggested Fan Profile</span>
                  <span className="fan-profile-badge" style={{ color: fanStyle.color, background: `${fanStyle.color}1a` }}>
                    {primaryWorkload.fanProfile.charAt(0).toUpperCase() + primaryWorkload.fanProfile.slice(1)}
                  </span>
                </div>
                <p className="fan-description">{primaryWorkload.fanDescription}</p>
              </div>
            )}

            {isDocked && (
              <div className="dock-status">
                <span className="dock-icon"><MonitorSmartphone size={14} /></span>
                <div className="dock-text">
                  <span className="dock-label">Docked mode</span>
                  <span className="dock-detail">
                    Connected to {externalDisplayCount} external display{externalDisplayCount !== 1 ? "s" : ""}
                    {snapshot?.is_charging ? " · on AC power" : ""}
                  </span>
                </div>
              </div>
            )}

            {isGaming && (
              <div className="display-tuning">
                <div className="display-tuning-header">
                  <span className="display-tuning-icon"><Monitor size={14} /></span>
                  <span className="display-tuning-title">Display tuning</span>
                </div>
                <p className="display-tuning-description">
                  Gaming detected — push every monitor to its max refresh rate, or open the GPU page for full resolution and adapter controls.
                </p>
                <div className="display-tuning-actions">
                  <button
                    type="button"
                    className="insight-btn link"
                    onClick={handleMaxRefreshAll}
                    disabled={displayBusy || monitors.length === 0}
                    title="Switch every monitor to its highest available refresh rate"
                  >
                    Max refresh rate
                  </button>
                  <button
                    type="button"
                    className="insight-btn ghost"
                    onClick={() => onNavigate?.("gpu")}
                    disabled={!onNavigate}
                    title="Jump to the GPU page to change resolution, refresh rate, and adapter settings"
                  >
                    Open GPU page
                  </button>
                </div>
              </div>
            )}

            {workloadSuggestions.length > 0 && (
              <div className="workload-suggestions">
                <span className="suggestion-title">Optimization Suggestions</span>
                {workloadSuggestions.map((s, i) => (
                  <div key={i} className="suggestion-row">
                    <span className="suggestion-reason">{s.reason}</span>
                    <button
                      className="insight-btn danger"
                      onClick={() => handleCloseSuggestion(s.close)}
                    >
                      Close {s.close.length > 1 ? `(${s.close.length})` : s.close[0].replace(/\.exe$/i, "")}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Frequent Apps */}
        {frequentApps.length > 0 && (
          <div className="frequent-apps-section">
            <div className="frequent-apps-card">
              <div className="frequent-apps-header">
                <div>
                  <span className="frequent-apps-title">Frequent Apps</span>
                  <span className="frequent-apps-subtitle">Most-used apps over the last 7 days</span>
                </div>
              </div>
              <div className="frequent-apps-grid">
                {frequentApps.slice(0, 8).map(app => (
                  <FrequentAppTile key={app.name} app={app} accent={accent} />
                ))}
              </div>
            </div>
          </div>
        )}

        {/* All Clear State */}
        {insights.length === 0 && calibrated && (
          <div className="insights-clear" style={{ background: hexToRgba(accent, 0.04), borderColor: hexToRgba(accent, 0.15) }}>
            <div className="clear-icon" style={{ background: hexToRgba(accent, 0.12), color: accent }}>✓</div>
            <h3 style={{ color: accent }}>System Running Smoothly</h3>
            <p>No issues detected. TaskManager+ is continuously monitoring your system for performance problems, memory leaks, and optimization opportunities.</p>
          </div>
        )}

        {criticals.length > 0 && (
          <div className="insight-group">
            <h3 className="section-title" style={{ color: "#ef4444" }}>Critical Issues</h3>
            {criticals.map(i => <InsightCard key={i.id} insight={i} onAction={handleAction} />)}
          </div>
        )}

        {warnings.length > 0 && (
          <div className="insight-group">
            <h3 className="section-title" style={{ color: "#f59e0b" }}>Warnings</h3>
            {warnings.map(i => <InsightCard key={i.id} insight={i} onAction={handleAction} />)}
          </div>
        )}

        {infos.length > 0 && (
          <div className="insight-group">
            <h3 className="section-title" style={{ color: "#3b82f6" }}>Recommendations</h3>
            {infos.map(i => <InsightCard key={i.id} insight={i} onAction={handleAction} />)}
          </div>
        )}

        {/* Daily Routine — learned schedule of charging + active hours.
         *
         * Temporarily disabled in v1.3.0: the routine detector needs more
         * observation time than the average session provides, so the card
         * spent most of its life in the "learning…" state. We're keeping
         * the code for a future revision that tracks data across sessions
         * properly — re-enable by flipping `false` below back to `true`.
         */}
        {false && (
          <div className="routine-section">
            <div className="routine-card">
              <div className="routine-card-header">
                <div>
                  <span className="routine-title">Daily Routine</span>
                  <span className="routine-subtitle">
                    {schedulePatterns.ready
                      ? `Learned from ${(schedulePatterns.totalObservedSeconds / 3600).toFixed(1)} hours of observation`
                      : `Learning your routine — ${(schedulePatterns.totalObservedSeconds / 3600).toFixed(1)}h collected so far`}
                  </span>
                </div>
              </div>
              {schedulePatterns.ready ? (
                <>
                  <div className="routine-patterns">
                    <RoutinePatternRow
                      icon={<PlugZap size={14} />}
                      title="Charging routine"
                      patterns={schedulePatterns.charging}
                      emptyText="No consistent charging window detected yet."
                      accentRgb="52, 211, 153"
                    />
                    <RoutinePatternRow
                      icon={<CircleDot size={14} />}
                      title="Active hours"
                      patterns={schedulePatterns.active}
                      emptyText="No consistent activity window detected yet."
                      accentRgb={accent.startsWith("#")
                        ? `${parseInt(accent.slice(1, 3), 16)}, ${parseInt(accent.slice(3, 5), 16)}, ${parseInt(accent.slice(5, 7), 16)}`
                        : "96, 165, 250"}
                    />
                  </div>
                  <RoutineHeatmap grid={hourGrid} accent={accent} />
                </>
              ) : (
                <p className="routine-learning">
                  TaskManager+ needs to observe your activity for a few more hours before it can detect a routine. Keep the app running in the background — patterns will appear here automatically.
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

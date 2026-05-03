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
import { ASSIGNABLE_WORKLOAD_TYPES, isSystemProcessName } from "../../lib/insights";
import type { RunningAppRow } from "../../lib/insightsEngine";
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

/** Good = fixed green (same family as PerformanceGauge) — not user accent — so orange/red presets never read as warn/bad. */
const QUICK_STAT_GOOD = "#34d399";

function QuickStat({ label, value, status }: { label: string; value: string; status: "good" | "warn" | "bad" }) {
  const borderColors = { good: QUICK_STAT_GOOD, warn: "#f59e0b", bad: "#ef4444" };
  const textColors = { good: QUICK_STAT_GOOD, warn: "#f59e0b", bad: "#ef4444" };
  const bgs = { good: "rgba(52,211,153,0.08)", warn: "rgba(245,158,11,0.08)", bad: "rgba(239,68,68,0.08)" };
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

/** Active vs charging use fixed RGB triples so green accent preset never merges with charging (emerald). */
const ROUTINE_HEATMAP_ACTIVE_RGB = "96, 165, 250"; // #60a5fa
const ROUTINE_HEATMAP_CHARGING_RGB = "52, 211, 153"; // #34d399

function RoutineHeatmap({ grid }: { grid: HourCell[][] }) {
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

  return (
    <div className="routine-heatmap">
      {renderGrid("active", "Active hours", ROUTINE_HEATMAP_ACTIVE_RGB)}
      {renderGrid("charging", "Charging hours", ROUTINE_HEATMAP_CHARGING_RGB)}
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

/**
 * Compact workload pill. Clicking selects/deselects the chip — the parent
 * shows an expanded panel for the selected chip with the apps under it and
 * per-app recategorize controls.
 */
function WorkloadChip({
  workload,
  isMain,
  isSelected,
  onClick,
}: {
  workload: WorkloadProfile;
  isMain: boolean;
  isSelected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`workload-chip${isSelected ? " selected" : ""}${isMain ? " is-main" : ""}`}
      onClick={onClick}
      title={isMain ? "Pinned as main workload" : "Click to view apps and recategorize"}
      style={{
        cursor: "pointer",
        outline: isSelected ? "1px solid var(--accent-primary)" : undefined,
        background: isMain ? "var(--accent-primary-subtle)" : undefined,
      }}
    >
      <span className="workload-chip-icon">{WORKLOAD_ICONS[workload.type] || <Info size={14} />}</span>
      <span className="workload-chip-label">{workload.label}</span>
      {isMain && (
        <span style={{ fontSize: 10, color: "var(--accent-primary)", fontWeight: 600, marginLeft: 4 }}>
          MAIN
        </span>
      )}
      {workload.matchedApps.length > 0 && (
        <span className="workload-chip-apps">
          {workload.matchedApps.length} app{workload.matchedApps.length !== 1 ? "s" : ""}
        </span>
      )}
    </button>
  );
}

/**
 * Per-app row under an expanded workload chip. An app may belong to multiple
 * workloads; current assignments are shown as removable chips and new ones
 * are added via the "+" dropdown. The "Auto" / "None" toggle on the right is
 * mutually exclusive with explicit assignments — switching to Auto clears the
 * override entirely; switching to None forces the app out of every workload.
 */
function WorkloadAppRow({
  app,
  currentOverrides,
  onChange,
}: {
  app: RunningAppRow;
  /** Current override list for this app. `[]` / undefined = auto-detect. `["none"]` = excluded. */
  currentOverrides: string[] | undefined;
  /** Apply a new override list. `[]` clears the override (back to auto). */
  onChange: (newCategories: string[]) => void;
}) {
  const cleanName = app.name.replace(/\.exe$/i, "");
  const ovList = currentOverrides ?? [];
  const isNone = ovList.length === 1 && ovList[0] === "none";
  const isAuto = ovList.length === 0;
  const explicitTypes = isNone ? [] : ovList;
  // Workloads not yet assigned — show in the add-dropdown so we don't suggest
  // a duplicate. We also exclude "none" from the add-list since it's handled
  // by the mode select on the right.
  const remainingTypes = ASSIGNABLE_WORKLOAD_TYPES.filter(
    w => !explicitTypes.includes(w.type),
  );

  const handleAdd = (type: string) => {
    if (!type) return;
    onChange([...explicitTypes, type]);
  };
  const handleRemove = (type: string) => {
    const next = explicitTypes.filter(t => t !== type);
    onChange(next);
  };
  const handleModeChange = (mode: string) => {
    if (mode === "auto") onChange([]);
    else if (mode === "none") onChange(["none"]);
    // "explicit" mode is implicit when chips are present — nothing to do.
  };
  const mode: "auto" | "none" | "explicit" = isAuto ? "auto" : isNone ? "none" : "explicit";

  return (
    <div
      className="workload-app-row"
      style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "6px 8px",
        borderTop: "1px solid var(--border-color)",
        fontSize: 12,
        flexWrap: "wrap",
      }}
    >
      <span style={{ flex: "1 1 140px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {cleanName}
        {app.isBackground && (
          <span style={{ fontSize: 10, color: "var(--text-muted)", marginLeft: 6 }}>· bg</span>
        )}
      </span>
      <span style={{ color: "var(--text-muted)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
        {app.cpuPercent.toFixed(1)}%
      </span>
      <span style={{ color: "var(--text-muted)", fontVariantNumeric: "tabular-nums", flexShrink: 0, minWidth: 60, textAlign: "right" }}>
        {app.memoryMb >= 1024 ? `${(app.memoryMb / 1024).toFixed(1)} GB` : `${app.memoryMb.toFixed(0)} MB`}
      </span>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center", flexShrink: 0 }}>
        {explicitTypes.map(t => {
          const meta = ASSIGNABLE_WORKLOAD_TYPES.find(w => w.type === t);
          const label = meta?.label ?? t;
          return (
            <span
              key={t}
              title={`Remove from ${label}`}
              style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                padding: "2px 6px", fontSize: 10.5,
                background: "var(--accent-primary-muted)",
                border: "1px solid var(--accent-border)",
                borderRadius: "var(--radius-sm)",
                color: "var(--text-primary)",
                cursor: "pointer",
              }}
              onClick={() => handleRemove(t)}
              role="button"
            >
              {label}
              <span style={{ fontSize: 11, color: "var(--text-muted)", marginLeft: 1 }}>×</span>
            </span>
          );
        })}
        {mode !== "none" && remainingTypes.length > 0 && (
          <select
            value=""
            onChange={(e) => handleAdd(e.target.value)}
            title="Add this app to another workload"
            style={{
              padding: "3px 6px", fontSize: 11,
              background: "var(--bg-tertiary)",
              border: "1px solid var(--border-color)",
              borderRadius: "var(--radius-sm)",
              color: "var(--text-primary)",
            }}
          >
            <option value="">+ Add workload</option>
            {remainingTypes.map(w => (
              <option key={w.type} value={w.type}>{w.label}</option>
            ))}
          </select>
        )}
        <select
          value={mode === "explicit" ? "auto" : mode}
          onChange={(e) => handleModeChange(e.target.value)}
          title="Auto = follow detection rules; None = exclude from every workload"
          style={{
            padding: "3px 6px", fontSize: 11,
            background: "var(--bg-tertiary)",
            border: "1px solid var(--border-color)",
            borderRadius: "var(--radius-sm)",
            color: "var(--text-primary)",
          }}
        >
          <option value="auto">{mode === "explicit" ? "Clear" : "Auto"}</option>
          <option value="none">None</option>
        </select>
      </div>
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
    mainWorkload,
    runningApps,
  } = useInsights();
  const { current: snapshot } = usePerformanceData();
  const { data: processes } = useProcesses();
  const { info: thermalDelegate, loading: thermalLoading } = useThermalDelegate();
  const [settings, updateSettings] = useSettings();
  const accent = settings.accentColor;
  const [thermalLaunchError, setThermalLaunchError] = useState<string | null>(null);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [displayBusy, setDisplayBusy] = useState(false);
  /**
   * Which workload chip is currently expanded. Independent from the "main"
   * pin — clicking a chip just opens the apps list for inspection. Pinning is
   * an explicit action inside the panel.
   */
  const [expandedWorkload, setExpandedWorkload] = useState<string | null>(null);
  /** Apps queued to be ended by the focus-on-workload action. */
  const [focusModal, setFocusModal] = useState<{ targets: RunningAppRow[]; mainLabel: string } | null>(null);
  const [focusBusy, setFocusBusy] = useState(false);

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

  /**
   * Replace this app's override list. An empty array clears the override
   * (auto-detect); `["none"]` excludes from every workload; any non-empty
   * list of WorkloadTypes assigns the app to each listed workload.
   */
  const handleOverrideApp = useCallback((appName: string, newCategories: string[]) => {
    const next = { ...settings.appCategoryOverrides };
    const key = appName.toLowerCase();
    if (newCategories.length === 0) {
      delete next[key];
    } else {
      next[key] = newCategories;
    }
    updateSettings({ appCategoryOverrides: next });
  }, [settings.appCategoryOverrides, updateSettings]);

  /** Pin a workload type as the main workload (or clear when given ""). */
  const handlePinMainWorkload = useCallback((type: string) => {
    updateSettings({ mainWorkloadType: type });
  }, [updateSettings]);

  /**
   * Open the focus-on-main-workload confirmation. Targets = running, non-bg,
   * non-system apps that are NOT under the main workload AND that are using
   * meaningful resources (worth ending). We never silently end-task — the
   * user must confirm with the apps and totals visible.
   */
  const handleOpenFocusModal = useCallback(() => {
    if (!mainWorkload.profile) return;
    const mainApps = new Set(mainWorkload.profile.matchedApps.map(n => n.toLowerCase()));
    const targets = runningApps.filter(app => {
      if (app.isBackground) return false;
      if (mainApps.has(app.name.toLowerCase())) return false;
      // Defense-in-depth: even though runningApps is already prefiltered for
      // system processes upstream, never let critical pseudo-processes (e.g.
      // Memory Compression, Secure System) into the kill list — Windows
      // either disallows ending them or destabilizes the system if you do.
      if (isSystemProcessName(app.name)) return false;
      // "Worth ending" gate: skip tiny apps that won't free much.
      return app.memoryMb > 500 || app.cpuPercent > 5;
    });
    setFocusModal({ targets, mainLabel: mainWorkload.profile.label });
  }, [mainWorkload.profile, runningApps]);

  const handleConfirmFocus = useCallback(async () => {
    if (!focusModal || !processes) return;
    setFocusBusy(true);
    try {
      for (const app of focusModal.targets) {
        const pids = processes
          .filter(p => p.name === app.name || p.display_name === app.name)
          .map(p => p.pid);
        for (const pid of pids) {
          try { await endTask(pid); } catch { /* ignore */ }
        }
      }
    } finally {
      setFocusBusy(false);
      setFocusModal(null);
    }
  }, [focusModal, processes]);

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
            <QuickStat label="CPU" value={`${snapshot.cpu_usage_percent.toFixed(0)}%`} status={cpuStatus} />
            <QuickStat label="Memory" value={`${memUsedPct.toFixed(0)}%`} status={memStatus} />
            <QuickStat label="Disk" value={`${snapshot.disk_active_percent.toFixed(0)}%`} status={diskStatus} />
            <QuickStat label="GPU Temp" value={snapshot.gpu_temperature > 0 ? `${snapshot.gpu_temperature.toFixed(0)}°C` : "N/A"} status={gpuStatus} />
          </div>
        </div>

        {/* Workload Detection */}
        <div className="workload-section">
          <div className="workload-card">
            <div className="workload-detected" style={{ position: "relative" }}>
              {/* Display-state icon, top-right of the card. Shows a richer icon
                  (MonitorSmartphone) when docked with a tooltip describing the
                  external displays + AC state; otherwise a plain monitor icon
                  with a minimal tooltip. Inline so we don't allocate a row. */}
              <span
                className="workload-display-state"
                title={
                  isDocked
                    ? `Docked mode — ${externalDisplayCount} external display${externalDisplayCount !== 1 ? "s" : ""}${snapshot?.is_charging ? " · on AC power" : ""}`
                    : monitors.length > 1
                      ? `${monitors.length} displays`
                      : "Single display"
                }
                style={{
                  position: "absolute", top: 0, right: 0,
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  width: 26, height: 26, borderRadius: "var(--radius-sm)",
                  color: isDocked ? "var(--accent-primary)" : "var(--text-muted)",
                  background: isDocked ? "var(--accent-primary-muted)" : "transparent",
                  border: isDocked ? "1px solid var(--accent-border)" : "1px solid var(--border-color)",
                }}
              >
                {isDocked ? <MonitorSmartphone size={14} /> : <Monitor size={14} />}
              </span>
              <div className="workload-info" style={{ paddingRight: 32 }}>
                <span className="workload-type">Detected Workloads</span>
                {workloads.length > 0 ? (
                  <div className="workload-chips">
                    {workloads.map((wl, i) => (
                      <WorkloadChip
                        key={i}
                        workload={wl}
                        isMain={mainWorkload.profile?.type === wl.type}
                        isSelected={expandedWorkload === wl.type}
                        onClick={() => setExpandedWorkload(prev => prev === wl.type ? null : wl.type)}
                      />
                    ))}
                  </div>
                ) : (
                  <span className="workload-label" style={{ color: "var(--text-muted)" }}>
                    {calibrated ? "No specific workload detected" : "Calibrating..."}
                  </span>
                )}
                <span style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4, display: "block" }}>
                  Click a chip to see its apps and reassign them. The chip marked MAIN exempts those apps from “high memory while idle” warnings.
                </span>
              </div>
            </div>

            {/* Expanded workload panel — apps under the selected chip with
                per-app recategorize dropdowns and a "set as main" toggle. */}
            {expandedWorkload && (() => {
              const wl = workloads.find(w => w.type === expandedWorkload);
              if (!wl) return null;
              const matchedSet = new Set(wl.matchedApps.map(n => n.toLowerCase()));
              const appsHere = runningApps.filter(a => matchedSet.has(a.name.toLowerCase()));
              const isMain = mainWorkload.profile?.type === wl.type;
              return (
                <div
                  className="workload-expanded"
                  style={{
                    marginTop: 10, padding: 10,
                    background: "var(--bg-tertiary)",
                    border: "1px solid var(--border-color)",
                    borderRadius: "var(--radius-sm)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{wl.label}</span>
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                      {appsHere.length} app{appsHere.length !== 1 ? "s" : ""}
                    </span>
                    <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                      <button
                        type="button"
                        className={`insight-btn ${isMain ? "ghost" : "link"}`}
                        onClick={() => handlePinMainWorkload(isMain ? "" : wl.type)}
                        title={isMain
                          ? "Stop pinning this workload — return to auto-detection"
                          : "Pin this workload as your main — its apps are exempt from idle warnings"}
                      >
                        {isMain ? "Unpin main" : "Set as main"}
                      </button>
                    </div>
                  </div>
                  {appsHere.length === 0 ? (
                    <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0, padding: "4px 0" }}>
                      No apps for this workload are visible in the running roster (they may be background-only or below the activity threshold).
                    </p>
                  ) : (
                    appsHere.map(app => (
                      <WorkloadAppRow
                        key={app.name}
                        app={app}
                        currentOverrides={settings.appCategoryOverrides[app.name.toLowerCase()]}
                        onChange={(newCats) => handleOverrideApp(app.name, newCats)}
                      />
                    ))
                  )}
                </div>
              );
            })()}

            {/* Main workload status row + focus action. Sits between the chip
                grid and the fan/thermal section. The focus action is the
                "kill everything not in my workload" escape hatch — guarded by
                a confirmation modal that lists exactly what would be ended. */}
            <div className="main-workload-row" style={{
              display: "flex", alignItems: "center", gap: 10, padding: "10px 0",
              borderTop: "1px solid var(--border-color)", marginTop: 10, flexWrap: "wrap",
            }}>
              <span className="workload-type" style={{ flexShrink: 0 }}>Main workload</span>
              <select
                value={settings.mainWorkloadType}
                onChange={(e) => handlePinMainWorkload(e.target.value)}
                style={{
                  flex: "1 1 180px", minWidth: 0,
                  padding: "6px 10px",
                  background: "var(--bg-tertiary)",
                  border: "1px solid var(--border-color)",
                  borderRadius: "var(--radius-sm)",
                  color: "var(--text-primary)",
                  fontSize: 12,
                }}
                title="Pin the workload type you're focused on. Apps under that workload are exempt from 'high memory while idle' warnings."
              >
                <option value="">
                  Auto: {mainWorkload.profile?.label ?? "(none detected)"}
                </option>
                {ASSIGNABLE_WORKLOAD_TYPES.map(w => (
                  <option key={w.type} value={w.type}>{w.label}</option>
                ))}
              </select>
              {mainWorkload.profile && (
                <button
                  type="button"
                  className="insight-btn danger"
                  onClick={handleOpenFocusModal}
                  style={{ flexShrink: 0 }}
                  title="End other high-resource apps that aren't part of your main workload"
                >
                  Focus on {mainWorkload.profile.label}
                </button>
              )}
              <span style={{ fontSize: 11, color: "var(--text-muted)", flexBasis: "100%" }}>
                {mainWorkload.pinned
                  ? `Pinned — apps under ${mainWorkload.profile?.label} won't be flagged as idle.`
                  : mainWorkload.profile
                    ? `Auto-detected. Pin a workload above to lock the choice.`
                    : `No clear workload yet. Resource hog warnings use the default (CPU < 1%) idle rule.`}
              </span>
            </div>

            {/* Single combined Fan & power row.
                Previously this card had TWO separate blocks: thermal-delegate
                (fan vendor app + power settings buttons) and fan-recommendation
                (workload-derived fan profile suggestion). They covered closely
                related ground and read as redundant. Combined here: heading +
                vendor info + workload-derived suggested profile chip + actions.
                The dock-status block also lived here; it's been promoted to a
                top-right icon in the card header, so it's gone from this row. */}
            {!thermalLoading && (
              <div
                className="thermal-delegate"
                style={primaryWorkload
                  ? { background: fanStyle.bg, borderColor: fanStyle.border }
                  : undefined}
              >
                <div className="thermal-delegate-main">
                  <div className="thermal-delegate-heading">
                    <span className="thermal-delegate-icon"><Thermometer size={14} /></span>
                    <span className="thermal-delegate-title">Fan &amp; power control</span>
                    {primaryWorkload && (
                      <span
                        className="fan-profile-badge"
                        style={{ color: fanStyle.color, background: `${fanStyle.color}1a`, marginLeft: 6 }}
                        title={primaryWorkload.fanDescription}
                      >
                        <Fan size={11} style={{ marginRight: 4, verticalAlign: "-1px" }} />
                        {primaryWorkload.fanProfile.charAt(0).toUpperCase() + primaryWorkload.fanProfile.slice(1)}
                      </span>
                    )}
                  </div>
                  <p className="thermal-delegate-detail">
                    {thermalDelegate
                      ? thermalDelegate.detailLine
                      : "We could not read your system vendor. Use Windows power settings, or install your laptop maker's control app (for example G-Helper for many ASUS / ROG models)."}
                  </p>
                  {thermalDelegate && (thermalDelegate.manufacturer !== "Unknown" || thermalDelegate.model !== "Unknown") && (
                    <p className="thermal-delegate-meta">
                      {thermalDelegate.manufacturer !== "Unknown" ? thermalDelegate.manufacturer : "PC"}
                      {thermalDelegate.model !== "Unknown" ? ` · ${thermalDelegate.model}` : ""}
                      {!thermalDelegate.isLikelyLaptop ? " · chassis: desktop / mini" : ""}
                    </p>
                  )}
                </div>
                <div className="thermal-delegate-actions">
                  {thermalDelegate && (
                    <button
                      type="button"
                      className="insight-btn link"
                      onClick={handleLaunchThermal}
                    >
                      {thermalDelegate.buttonLabel}
                    </button>
                  )}
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
        {/* Focus-on-main-workload confirmation modal. Lists exactly what would
            be ended and the resources freed, so the user is never surprised
            by losing unsaved work. */}
        {focusModal && (
          <div
            className="confirm-overlay"
            onClick={() => !focusBusy && setFocusModal(null)}
            style={{
              position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)",
              display: "flex", alignItems: "center", justifyContent: "center",
              zIndex: 1000,
            }}
          >
            <div
              className="confirm-dialog"
              onClick={(e) => e.stopPropagation()}
              style={{
                background: "var(--bg-secondary)",
                border: "1px solid var(--border-color)",
                borderRadius: "var(--radius-md)",
                padding: 20, maxWidth: 520, width: "90%",
                maxHeight: "80vh", overflow: "auto",
              }}
            >
              <h3 style={{ margin: "0 0 6px 0", fontSize: 16 }}>
                Focus on {focusModal.mainLabel}
              </h3>
              {focusModal.targets.length === 0 ? (
                <>
                  <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>
                    Nothing to end — no other high-resource apps are running outside your main workload.
                  </p>
                  <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
                    <button
                      type="button"
                      className="insight-btn ghost"
                      onClick={() => setFocusModal(null)}
                    >
                      Close
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "6px 0 12px 0" }}>
                    These {focusModal.targets.length} app{focusModal.targets.length !== 1 ? "s" : ""} aren't part of your main workload and will be closed.
                    Save anything important first — this is the same as End Task.
                  </p>
                  {(() => {
                    const totalMem = focusModal.targets.reduce((s, a) => s + a.memoryMb, 0);
                    const totalCpu = focusModal.targets.reduce((s, a) => s + a.cpuPercent, 0);
                    return (
                      <div style={{
                        display: "flex", gap: 16, padding: "8px 12px",
                        background: "var(--bg-tertiary)",
                        border: "1px solid var(--border-color)",
                        borderRadius: "var(--radius-sm)", marginBottom: 12, fontSize: 12,
                      }}>
                        <span>
                          <strong>~{totalMem >= 1024 ? `${(totalMem / 1024).toFixed(1)} GB` : `${totalMem.toFixed(0)} MB`}</strong>
                          <span style={{ color: "var(--text-muted)", marginLeft: 4 }}>memory freed</span>
                        </span>
                        <span>
                          <strong>~{totalCpu.toFixed(1)}%</strong>
                          <span style={{ color: "var(--text-muted)", marginLeft: 4 }}>CPU freed</span>
                        </span>
                      </div>
                    );
                  })()}
                  <div style={{
                    border: "1px solid var(--border-color)",
                    borderRadius: "var(--radius-sm)",
                    maxHeight: 240, overflow: "auto",
                  }}>
                    {focusModal.targets.map(app => (
                      <div
                        key={app.name}
                        style={{
                          display: "flex", alignItems: "center", gap: 8,
                          padding: "6px 10px", fontSize: 12,
                          borderBottom: "1px solid var(--border-color)",
                        }}
                      >
                        <span style={{ flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {app.name.replace(/\.exe$/i, "")}
                          {app.workload && (
                            <span style={{ fontSize: 10, color: "var(--text-muted)", marginLeft: 6 }}>
                              · {app.workload}
                            </span>
                          )}
                        </span>
                        <span style={{ color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>
                          {app.cpuPercent.toFixed(1)}%
                        </span>
                        <span style={{ color: "var(--text-muted)", fontVariantNumeric: "tabular-nums", minWidth: 60, textAlign: "right" }}>
                          {app.memoryMb >= 1024 ? `${(app.memoryMb / 1024).toFixed(1)} GB` : `${app.memoryMb.toFixed(0)} MB`}
                        </span>
                      </div>
                    ))}
                  </div>
                  <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "10px 0 0 0" }}>
                    Tip: if any of these are actually part of your workload, click the chip above and reassign them — they'll be exempted next time.
                  </p>
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
                    <button
                      type="button"
                      className="insight-btn ghost"
                      onClick={() => setFocusModal(null)}
                      disabled={focusBusy}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="insight-btn danger"
                      onClick={handleConfirmFocus}
                      disabled={focusBusy}
                    >
                      {focusBusy ? "Ending..." : `End ${focusModal.targets.length} app${focusModal.targets.length !== 1 ? "s" : ""}`}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

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
                  <RoutineHeatmap grid={hourGrid} />
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

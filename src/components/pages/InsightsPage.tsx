import { useEffect, useState, useCallback, useMemo, type ReactNode } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useInsights, dismissInsight } from "../../lib/insightsEngine";
import { usePerformanceData } from "../../hooks/usePerformanceData";
import { useThermalDelegate } from "../../hooks/useThermalDelegate";
import { useOemThermal } from "../../hooks/useOemThermal";
import {
  endTask,
  launchThermalDelegate,
  listMonitors,
  openWindowsSettingsUri,
  setDisplayMode,
  getStartupApps,
  setStartupEnabled,
  WINDOWS_POWER_SETTINGS_URI,
  type MonitorInfo,
} from "../../lib/ipc";
import type { StartupAppInfo } from "../../lib/types";
import { useProcesses } from "../../hooks/useProcesses";
import { useSettings } from "../../lib/settings";
import type { Insight, InsightAction, WorkloadProfile } from "../../lib/insights";
import { ASSIGNABLE_WORKLOAD_TYPES, isSystemProcessName } from "../../lib/insights";
import type { RunningAppRow } from "../../lib/insightsEngine";
import { groupRunningApps, type AppGroup } from "../../lib/workloadGrouping";
import { formatDuration, type FrequentApp } from "../../lib/appUsage";
import { formatHour12, formatHourRange, resetUsagePattern, getHourProfile, getHourWorkloads, getMinSlotSeconds, getObservationDays, type SchedulePattern, type SchedulePatterns, type DayGroup } from "../../lib/usagePattern";
import { forecastUsage } from "../../lib/usageForecast";
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
  Activity,
  Gauge,
  Sparkles,
  ChevronDown,
  ChevronUp,
  RotateCcw,
  ShieldAlert,
  RefreshCw,
  Download,
} from "lucide-react";
import { getUnexpectedShutdowns, getDeviceDrivers, getCrashContext, openDeviceManager, getBiosInfo, getWindowsUpdateStatus } from "../../lib/ipc";
import {
  keyDrivers,
  staleDrivers,
  oemSupportLink,
  healthSignature,
  isStale,
  isInbox,
  totalUpdates,
  updatesSignature,
  type BiosInfo,
  type WindowsUpdateStatus,
} from "../../lib/systemHealth";
import {
  causeTitle,
  causeExplanation,
  describeWhen,
  newestNewerThan,
  classifyIncident,
  incidentRemediation,
  sameKindCount,
  pickDriverForClass,
  ageLabel,
  contextNear,
  type ShutdownEvent,
  type DriverInfo,
  type CrashContext,
} from "../../lib/crashEvents";
import type { RemediationAction } from "../../lib/stopCodes";
import { maybeNotifyCrash } from "../../lib/crashNotifier";

const WINDOWS_UPDATE_SETTINGS_URI = "ms-settings:windowsupdate";

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
          {/* Flat fill, not a gradient: at this bar's height the gradient was
              invisible and only muddied the color. The width transition is a
              value animation so it stays slow-ish, but 0.8s made the bar still
              be moving well after the number beside it had settled. */}
          <div
            className="health-bar-inner"
            style={{
              width: `${score}%`,
              background: color,
              transition: "width 0.4s ease, background-color 0.2s ease",
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

type Severity = keyof typeof SEVERITY_CONFIG;

/**
 * Shell for every insight-style card on this page.
 *
 * These cards used to carry a 3px colored bar down the left edge, a 1px colored
 * top, and near-invisible 1px right and bottom borders. That asymmetry is the
 * callout/admonition idiom — right for a blockquote, but here it was standing in
 * for hierarchy on ordinary content, and it is the "colored line down the side
 * of the card" look. A uniform 1px border in the same color says the same thing.
 *
 * The severity *hue* stays: critical/warning/info is real information.
 *
 * Five call sites built this object by hand and four of them hardcoded values
 * SEVERITY_CONFIG already held, which had drifted — the same conceptual border
 * was written at 0.3, 0.4 and 0.5 alpha in different cards.
 */
function severityCardStyle(severity: Severity): React.CSSProperties {
  const { bg, border } = SEVERITY_CONFIG[severity];
  return { background: bg, border: `1px solid ${border}` };
}

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
        ...severityCardStyle(insight.severity as Severity),
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
                action.type === "end-task" ? "danger" : action.type === "open-uri" || action.type === "navigate-tab" ? "link" : "ghost"
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

// Apps where auto-start is often deliberate (security, sync, backup, VPN).
// Disabling them isn't blocked, but we surface an extra warning in the confirm
// dialog so a bulk "Disable all" doesn't silently turn off something important.
const STARTUP_IMPORTANT_KEYWORDS = [
  "security", "defender", "antivirus", "protect", "vpn", "backup",
  "onedrive", "dropbox", "sync", "cloud", "vault", "password",
];

function startupLooksImportant(app: StartupAppInfo): boolean {
  const s = `${app.name} ${app.publisher}`.toLowerCase();
  return STARTUP_IMPORTANT_KEYWORDS.some((k) => s.includes(k));
}

function StartupRecommendationCard({
  candidates,
  onNavigate,
  queryClient,
}: {
  candidates: StartupAppInfo[];
  onNavigate?: (tab: string) => void;
  queryClient: QueryClient;
}) {
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(candidates.map((c) => c.id)),
  );
  const [confirmList, setConfirmList] = useState<StartupAppInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep the selection valid as the candidate list changes after disabling.
  // Depend on the *id signature* (a stable string) rather than the array
  // reference, so this only runs when the actual set of candidates changes —
  // otherwise `setSelected(new Set(...))` would re-fire every render (the Set
  // is always a new reference) and spin a re-render loop.
  const candidateIdSig = candidates.map((c) => c.id).join("|");
  useEffect(() => {
    setSelected((prev) => {
      const ids = candidateIdSig ? candidateIdSig.split("|") : [];
      const next = new Set<string>();
      for (const id of ids) {
        if (prev.size === 0 || prev.has(id)) next.add(id);
      }
      return next.size ? next : new Set(ids);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateIdSig]);

  const highCount = candidates.filter((c) => c.impact === "high").length;
  const selectedApps = candidates.filter((c) => selected.has(c.id));

  const toggleOne = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const runDisable = async (apps: StartupAppInfo[]) => {
    setBusy(true);
    setError(null);
    const failures: string[] = [];
    for (const app of apps) {
      try {
        await setStartupEnabled(app.id, false);
      } catch (e) {
        failures.push(`${app.name}: ${String(e).replace(/^.*?elevation_required:?/, "")}`);
      }
    }
    await queryClient.invalidateQueries({ queryKey: ["startup-apps"] });
    setBusy(false);
    setConfirmList(null);
    if (failures.length) setError(`Couldn't disable: ${failures.join("; ")}`);
  };

  const description =
    highCount > 0
      ? `${highCount} high-impact app${highCount > 1 ? "s" : ""} and ${candidates.length - highCount} other${candidates.length - highCount !== 1 ? "s" : ""} run at sign-in. Disabling apps you don't need can speed up boot.`
      : `${candidates.length} apps run at sign-in with measurable impact. Disable the ones you don't need to speed up boot.`;

  return (
    <div
      className="insight-card"
      style={{
        ...severityCardStyle("info"),
      }}
    >
      <div className="insight-card-header">
        <span className="insight-icon"><Info size={ICON_SIZE} /></span>
        <span className="insight-title">Trim your startup apps</span>
        <span className="insight-metric" style={{ color: "#3b82f6", background: "#3b82f61a" }}>
          {candidates.length}
        </span>
      </div>
      <p className="insight-description">{description}</p>
      {error && (
        <p className="insight-description" style={{ color: "var(--accent-red)" }}>{error}</p>
      )}

      <div className="insight-actions">
        <button
          className="insight-btn danger"
          disabled={busy}
          onClick={() => setConfirmList(candidates)}
        >
          Disable all {candidates.length}
        </button>
        <button
          className="insight-btn ghost"
          disabled={busy}
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? "Hide list" : "Choose apps…"}
        </button>
        <button className="insight-btn link" onClick={() => onNavigate?.("startup")}>
          Open Startup
        </button>
      </div>

      {expanded && (
        <div className="startup-rec-list">
          {candidates.map((app) => {
            const important = startupLooksImportant(app);
            return (
              <label key={app.id} className="startup-rec-item">
                <input
                  type="checkbox"
                  checked={selected.has(app.id)}
                  onChange={() => toggleOne(app.id)}
                />
                <span className="startup-rec-name">{app.name}</span>
                <span className={`startup-rec-impact impact-${app.impact}`}>{app.impact}</span>
                {important && (
                  <span className="startup-rec-warn" title="Auto-start may be intentional for this app">
                    keep?
                  </span>
                )}
              </label>
            );
          })}
          <div className="insight-actions" style={{ marginTop: 8 }}>
            <button
              className="insight-btn danger"
              disabled={busy || selectedApps.length === 0}
              onClick={() => setConfirmList(selectedApps)}
            >
              Disable selected ({selectedApps.length})
            </button>
          </div>
        </div>
      )}

      {confirmList && (
        <StartupDisableConfirm
          apps={confirmList}
          busy={busy}
          onCancel={() => !busy && setConfirmList(null)}
          onConfirm={() => runDisable(confirmList)}
        />
      )}
    </div>
  );
}

function StartupDisableConfirm({
  apps,
  busy,
  onCancel,
  onConfirm,
}: {
  apps: StartupAppInfo[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const important = apps.filter(startupLooksImportant);

  // Esc dismisses. This dialog had no key handling, so clicking the backdrop
  // was the only way out. Guarded on `busy` for the same reason the backdrop
  // click is: don't let the user walk away mid-write.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) { e.preventDefault(); onCancel(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  return (
    <div
      className="confirm-overlay"
      onClick={onCancel}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
      }}
    >
      <div
        className="confirm-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="disable-startup-title"
        style={{
          background: "var(--bg-secondary)", border: "1px solid var(--border-color)",
          borderRadius: "var(--radius-md)", padding: 20, maxWidth: 480, width: "90%",
          maxHeight: "80vh", overflow: "auto",
        }}
      >
        <h3 id="disable-startup-title" style={{ margin: "0 0 6px 0", fontSize: 16 }}>
          Disable {apps.length} startup app{apps.length !== 1 ? "s" : ""}?
        </h3>
        <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "6px 0 12px 0" }}>
          These apps will no longer launch automatically when you sign in. You can
          re-enable any of them from the Startup page at any time.
        </p>
        {important.length > 0 && (
          <p style={{ fontSize: 12, color: "var(--accent-orange, #fbbf24)", margin: "0 0 12px 0" }}>
            ⚠ {important.length} of these ({important.map((a) => a.name).join(", ")}) may
            rely on auto-start (security, sync, or backup tools). Disable only if you're sure.
          </p>
        )}
        <div style={{ border: "1px solid var(--border-color)", borderRadius: "var(--radius-sm)", maxHeight: 220, overflow: "auto" }}>
          {apps.map((app) => (
            <div
              key={app.id}
              style={{
                display: "flex", alignItems: "center", gap: 8, padding: "6px 10px",
                fontSize: 12, borderBottom: "1px solid var(--border-color)",
              }}
            >
              <span style={{ flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {app.name}
              </span>
              <span style={{ color: "var(--text-muted)" }}>{app.impact}</span>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
          <button type="button" className="insight-btn ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="insight-btn danger" disabled={busy} onClick={onConfirm}>
            {busy ? "Disabling…" : `Disable ${apps.length}`}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Absolute date+time for an incident. */
function formatCrashTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** 1st / 2nd / 3rd / Nth. */
function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/**
 * Crash / unexpected-shutdown alert. Rendered at the top of the Insights
 * content when the most recent detected incident is newer than the user's
 * acknowledgement high-water mark. Beyond the stop-code meaning, it surfaces
 * the implicated component + its driver age (C), nearby event-log context
 * incl. GPU-driver TDR attribution (D), a Modern Standby note for power-state
 * hangs (E), a recurring-problem banner (F), and a per-class "what to try"
 * playbook (B). Dismissing advances the acknowledgement mark.
 */
function CrashAlertCard({
  event,
  allEvents,
  drivers,
  context,
  onDismiss,
}: {
  event: ShutdownEvent;
  /** Every incident in the lookback window (deduped, newest-first). */
  allEvents: ShutdownEvent[];
  drivers: DriverInfo[];
  context: CrashContext;
  onDismiss: () => void;
}) {
  const [showHistory, setShowHistory] = useState(false);
  const [showSteps, setShowSteps] = useState(false);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  // Step actions are all non-destructive: open a built-in tool / Settings, or
  // copy a command to the clipboard. They never change anything themselves.
  const runStepAction = async (action: RemediationAction, idx: number) => {
    try {
      if (action.kind === "device-manager") {
        await openDeviceManager();
      } else if (action.kind === "windows-update") {
        await openWindowsSettingsUri(WINDOWS_UPDATE_SETTINGS_URI);
      } else if (action.kind === "copy") {
        await navigator.clipboard.writeText(action.value);
        setCopiedIdx(idx);
        setTimeout(() => setCopiedIdx((c) => (c === idx ? null : c)), 1500);
      }
    } catch {
      /* non-fatal — these are convenience shortcuts */
    }
  };

  const { klass, stopInfo } = classifyIncident(event);
  const earlier = allEvents.filter((e) => e.timestampMs !== event.timestampMs);
  const recentCount = allEvents.length;
  const repeatCount = sameKindCount(allEvents, event);
  const steps = incidentRemediation(event);

  // (C) Implicated device + driver age for this incident's subsystem.
  const implicated = pickDriverForClass(drivers, klass);
  const implicatedAge = implicated ? ageLabel(implicated.dateMs) : null;

  // (D) GPU TDR near this incident *names* the display driver — the strongest
  // attribution available when no crash dump was written.
  const near = contextNear(context.events, event.timestampMs);
  const tdrDriver =
    near.find((e) => e.source === "gpu_tdr" && e.driver)?.driver ??
    context.events.find((e) => e.source === "gpu_tdr" && e.driver)?.driver ??
    null;

  return (
    <div
      className="insight-card"
      style={{
        ...severityCardStyle("critical"),
      }}
    >
      {/* (F) Recurring-problem banner. */}
      {repeatCount >= 3 && (
        <div
          style={{
            fontSize: 11.5, fontWeight: 600, color: "#ef4444",
            background: "#ef44441a", borderRadius: "var(--radius-sm)",
            padding: "4px 8px", marginBottom: 8,
          }}
        >
          Recurring problem — the {ordinal(repeatCount)} time you've hit{" "}
          {stopInfo ? stopInfo.code : "this"} in the last 30 days.
        </div>
      )}

      <div className="insight-card-header">
        <span className="insight-icon"><ShieldAlert size={ICON_SIZE} /></span>
        <span className="insight-title">{causeTitle(event)}</span>
        {event.bugcheckCode && (
          <span className="insight-metric" style={{ color: "#ef4444", background: "#ef44441a" }}>
            {event.bugcheckCode}
          </span>
        )}
      </div>

      {stopInfo ? (
        <p className="insight-description" style={{ marginBottom: 4 }}>
          <code style={{ fontWeight: 600, color: "var(--text-primary)" }}>{stopInfo.name}</code>
          {" — "}{stopInfo.summary}
        </p>
      ) : (
        <p className="insight-description" style={{ marginBottom: 4 }}>
          {causeExplanation(event)}
        </p>
      )}

      {/* (C) Likely-area device. */}
      {implicated && (
        <p className="insight-description" style={{ marginBottom: 4 }}>
          <strong>Likely area:</strong> {implicated.name}
          {implicated.version ? ` (v${implicated.version})` : ""}
          {implicatedAge ? ` — driver ${implicatedAge}` : ""}.
        </p>
      )}

      {/* (D) GPU-driver TDR attribution. */}
      {tdrDriver && (
        <p className="insight-description" style={{ marginBottom: 4, color: "var(--text-muted)", fontSize: 11.5 }}>
          The graphics driver <code>{tdrDriver}</code> was logged stopping responding around this time.
        </p>
      )}

      {/* (E) Modern Standby framing for power-state hangs. */}
      {klass === "power" && context.modernStandby && (
        <p className="insight-description" style={{ marginBottom: 4, color: "var(--text-muted)", fontSize: 11.5 }}>
          This machine uses Modern Standby (no classic S3 sleep) — power-transition failures here usually trace to Wi-Fi, graphics, or chipset power drivers.
        </p>
      )}

      <p className="insight-description" style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 6 }}>
        Detected {describeWhen(event.timestampMs)} · {formatCrashTime(event.timestampMs)}
        {recentCount > 1 && ` · ${recentCount} unexpected shutdowns in the last 30 days`}
      </p>

      {/* (B) What-to-try playbook, each step with an optional non-destructive action. */}
      {showSteps && (
        <ol style={{ margin: "0 0 8px 0", paddingLeft: 18 }}>
          {steps.map((s, i) => (
            <li key={i} style={{ marginBottom: 6, fontSize: 12, color: "var(--text-secondary)" }}>
              {s.text}
              {s.action && (
                <button
                  className="insight-btn link"
                  style={{ marginLeft: 8, padding: "1px 7px", fontSize: 11, verticalAlign: "baseline" }}
                  onClick={() => void runStepAction(s.action!, i)}
                >
                  {s.action.kind === "copy" && copiedIdx === i ? "Copied ✓" : s.action.label}
                </button>
              )}
            </li>
          ))}
        </ol>
      )}

      {earlier.length > 0 && showHistory && (
        <div
          style={{
            border: "1px solid var(--border-color)",
            borderRadius: "var(--radius-sm)",
            marginBottom: 8,
            maxHeight: 160,
            overflow: "auto",
          }}
        >
          {earlier.map((e) => (
            <div
              key={e.timestampMs}
              style={{
                display: "flex", alignItems: "center", gap: 8, padding: "5px 10px",
                fontSize: 11.5, borderBottom: "1px solid var(--border-color)",
              }}
            >
              <span style={{ flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {causeTitle(e)}{e.bugcheckCode ? ` · ${e.bugcheckCode}` : ""}
              </span>
              <span style={{ color: "var(--text-muted)", flexShrink: 0 }}>
                {formatCrashTime(e.timestampMs)}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="insight-actions">
        <button className="insight-btn link" onClick={() => setShowSteps((s) => !s)}>
          {showSteps ? "Hide steps" : "What to try"}
        </button>
        {earlier.length > 0 && (
          <button className="insight-btn ghost" onClick={() => setShowHistory((s) => !s)}>
            {showHistory ? "Hide history" : `Earlier shutdowns (${earlier.length})`}
          </button>
        )}
        <button className="insight-btn ghost" onClick={onDismiss}>Dismiss</button>
      </div>
    </div>
  );
}

const DRIVER_CLASS_LABEL: Record<string, string> = {
  gpu: "Graphics",
  wifi: "Wi-Fi",
  network: "Network",
  storage: "Storage",
};

/**
 * Update Helper P1 — persistent "System & driver health" card. Shows the BIOS
 * version/date and the key crash-relevant drivers with their ages, flags any
 * that look stale, and links out to Windows Update / the OEM. Read-only and
 * non-destructive; dismissable until the health signature changes.
 */
function SystemHealthCard({
  bios,
  drivers,
  onDismiss,
}: {
  bios: BiosInfo | undefined;
  drivers: DriverInfo[];
  onDismiss: () => void;
}) {
  const keys = keyDrivers(drivers);
  const stale = staleDrivers(drivers);
  const oem = bios ? oemSupportLink(bios.manufacturer) : null;
  const biosWhen = bios?.dateMs ? formatCrashTime(bios.dateMs) : null;

  const openWU = () => { void openWindowsSettingsUri(WINDOWS_UPDATE_SETTINGS_URI).catch(() => {}); };
  const openOem = () => { if (oem) void openWindowsSettingsUri(oem.url).catch(() => {}); };

  return (
    <div
      className="insight-card"
      style={{
        ...severityCardStyle("info"),
      }}
    >
      <div className="insight-card-header">
        <span className="insight-icon"><RefreshCw size={ICON_SIZE} /></span>
        <span className="insight-title">System &amp; driver health</span>
        {stale.length > 0 ? (
          <span className="insight-metric" style={{ color: "#f59e0b", background: "#f59e0b1a" }}>
            {stale.length} to review
          </span>
        ) : (
          <span className="insight-metric" style={{ color: "#34d399", background: "#34d3991a" }}>
            current
          </span>
        )}
      </div>

      <p className="insight-description" style={{ marginBottom: 6 }}>
        {stale.length > 0
          ? `${stale.length} key driver${stale.length !== 1 ? "s" : ""} look out of date. Updating your drivers + BIOS is the most reliable fix for crashes and power/sleep problems.`
          : "Your key drivers look current. Keeping BIOS and drivers up to date prevents most crash and power/sleep issues."}
      </p>

      {bios && (bios.version || biosWhen) && (
        <p className="insight-description" style={{ fontSize: 11.5, color: "var(--text-muted)", marginBottom: 6 }}>
          <strong>BIOS:</strong> {bios.version || "—"}{biosWhen ? ` · ${biosWhen}` : ""}
          {bios.model ? ` · ${bios.model}` : ""}
        </p>
      )}

      {keys.length > 0 && (
        <div style={{ border: "1px solid var(--border-color)", borderRadius: "var(--radius-sm)", marginBottom: 8 }}>
          {keys.map((d) => {
            const inbox = isInbox(d);
            const old = !inbox && isStale(d.dateMs);
            const age = ageLabel(d.dateMs);
            return (
              <div
                key={`${d.class}-${d.name}`}
                style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "5px 10px",
                  fontSize: 11.5, borderBottom: "1px solid var(--border-color)",
                }}
              >
                <span style={{ flexShrink: 0, color: "var(--text-muted)", width: 60 }}>
                  {DRIVER_CLASS_LABEL[String(d.class)] ?? d.class}
                </span>
                <span style={{ flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {d.name}
                </span>
                <span style={{ flexShrink: 0, color: old ? "#f59e0b" : "var(--text-muted)" }}>
                  {inbox ? "Windows built-in" : (age ?? "—")}{old ? " · update?" : ""}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div className="insight-actions">
        <button className="insight-btn link" onClick={openWU}>Open Windows Update</button>
        {oem && <button className="insight-btn link" onClick={openOem}>{oem.label}</button>}
        <button className="insight-btn ghost" onClick={onDismiss}>Dismiss</button>
      </div>
    </div>
  );
}

/**
 * Update Helper P2 — "Windows updates available" card. Surfaced only when a
 * periodic, read-only WUA scan finds pending updates. Driver updates are
 * called out because they're the ones that fix crashes / power-sleep issues.
 */
function UpdatesAvailableCard({
  status,
  onDismiss,
}: {
  status: WindowsUpdateStatus;
  onDismiss: () => void;
}) {
  const total = status.driverUpdates + status.otherUpdates;
  const parts: string[] = [];
  if (status.driverUpdates > 0) parts.push(`${status.driverUpdates} driver`);
  if (status.otherUpdates > 0) parts.push(`${status.otherUpdates} other`);
  return (
    <div
      className="insight-card"
      style={{
        ...severityCardStyle("warning"),
      }}
    >
      <div className="insight-card-header">
        <span className="insight-icon"><Download size={ICON_SIZE} /></span>
        <span className="insight-title">Windows updates available</span>
        <span className="insight-metric" style={{ color: "#f59e0b", background: "#f59e0b1a" }}>{total}</span>
      </div>
      <p className="insight-description">
        Windows Update has {parts.join(" and ")} update{total !== 1 ? "s" : ""} pending
        {status.driverUpdates > 0 ? " — driver updates often fix crashes and power/sleep problems" : ""}.
      </p>
      <div className="insight-actions">
        <button
          className="insight-btn link"
          onClick={() => { void openWindowsSettingsUri(WINDOWS_UPDATE_SETTINGS_URI).catch(() => {}); }}
        >
          Open Windows Update
        </button>
        <button className="insight-btn ghost" onClick={onDismiss}>Dismiss</button>
      </div>
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

/** Active vs charging use fixed RGB triples so green accent preset never merges with charging (emerald). */
const ROUTINE_HEATMAP_ACTIVE_RGB = "96, 165, 250"; // #60a5fa
const ROUTINE_HEATMAP_CHARGING_RGB = "52, 211, 153"; // #34d399

/** Compose a single-line page-header subtitle from the learned schedule.
 *  Picks the first (= strongest) detected pattern for active and charging.
 *  Returns null when nothing useful can be said yet. */
function formatScheduleSubtitle(patterns: SchedulePatterns): string | null {
  if (!patterns.ready) return null;
  const top = (list: SchedulePattern[]) => (list.length > 0 ? list[0] : null);
  const a = top(patterns.active);
  const c = top(patterns.charging);
  if (!a && !c) return null;

  const renderOne = (label: string, p: SchedulePattern) => {
    // Drop "Everyday" prefix to keep the line short — the absence of a day
    // qualifier already implies it.
    const days = p.daysLabel === "Everyday" ? "" : `${p.daysLabel} `;
    return `${label} ${days}${formatHourRange(p.startHour, p.endHour)}`;
  };

  const parts: string[] = [];
  if (a) parts.push(renderOne("Active", a));
  if (c) parts.push(renderOne("Charging", c));
  return parts.join("  ·  ");
}

/**
 * Schedule strip — the redesigned learned-schedule visualisation.
 *
 * Two horizontal rows of 24 hour-cells each (Active on top, Charging
 * underneath), aggregated across the selected day group (All / Weekdays /
 * Weekends). Massive readability win over the old 7×24 grid because the
 * answer to "when am I active?" is one horizontal scan instead of 168
 * cells of pattern matching.
 *
 * The current hour is ringed in both rows so the user can see "where am I
 * right now" relative to their typical day. Vertical separators mark every
 * 6 hours; the axis labels sit under the second row.
 */
function ScheduleStrip() {
  const [group, setGroup] = useState<DayGroup>("all");
  const [selectedHour, setSelectedHour] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  // Re-pull the profile on every render so a freshly-fed bucket from
  // background ticks shows up in the strip.
  useEffect(() => {
    const id = setInterval(() => setTick(t => (t + 1) % 1_000_000), 60_000);
    return () => clearInterval(id);
  }, []);
  // Tick is read into a stable ref to silence the "declared but unused"
  // hook lint while still forcing a re-render every minute.
  void tick;

  const profile = getHourProfile(group);
  const currentHour = new Date().getHours();
  const noDataAtAll = profile.observed.every(o => o < 60);
  // Confidence floor for this view, scaled by how many days we've collected.
  // Cells below it render as "tentative" rather than confidently coloured.
  const minSlot = getMinSlotSeconds();
  // I5 — forecast the next few hours' workload from the learned heatmap.
  const forecast = forecastUsage();

  const groupLabel = group === "all" ? "All days" : group === "weekdays" ? "Weekdays" : "Weekends";

  const renderRow = (
    rowKey: "active" | "charging",
    label: string,
    accent: string,
    values: number[],
  ) => (
    <div className="schedule-strip-row">
      <span className="schedule-strip-row-label">{label}</span>
      <div className="schedule-strip-cells">
        {values.map((ratio, h) => {
          const w = profile.observed[h];
          const noData = w < 60;
          // Has some data but below the scaled confidence floor — the ratio is
          // too thin a sample to trust, so don't colour by it.
          const tentative = !noData && w < minSlot;
          const bg = noData
            ? "rgba(255,255,255,0.05)"
            : tentative
              // Flat, ratio-independent tint: signals "a little data here"
              // without a noisy 79%-of-4-min painting a saturated cell.
              ? `rgba(${accent}, 0.14)`
              : `rgba(${accent}, ${0.10 + ratio * 0.85})`;
          const isCurrent = h === currentHour;
          const isSelected = selectedHour === h;
          // Tooltip — "active" now reflects user presence, not raw CPU.
          const verb = rowKey === "active" ? "you were active" : "plugged in";
          const title = noData
            ? `${formatHour12(h)} — no data yet · click for details`
            : tentative
              ? `${formatHour12(h)} — limited data, not enough to judge yet · click for details`
              : `${formatHour12(h)} — ${verb} ${Math.round(ratio * 100)}% of observed time · click for breakdown`;
          return (
            <button
              key={h}
              type="button"
              className={
                "schedule-strip-cell"
                + (tentative ? " schedule-strip-cell--tentative" : "")
                + (isCurrent ? " schedule-strip-cell--now" : "")
                + (isSelected ? " schedule-strip-cell--selected" : "")
              }
              style={{ background: bg }}
              title={title}
              aria-label={title}
              aria-pressed={isSelected}
              onClick={() => setSelectedHour(prev => (prev === h ? null : h))}
            />
          );
        })}
      </div>
    </div>
  );

  // Detail-panel content for a clicked hour. Pulls from the same aggregated
  // profile so the numbers always match what the cell colour represents.
  const renderDetail = (h: number) => {
    const observedSec = profile.observed[h];
    const activePct = profile.active[h];
    const chargingPct = profile.charging[h];
    const observedH = observedSec / 3600;
    const observedFmt = observedH >= 1
      ? `${observedH.toFixed(1)} h`
      : `${Math.round(observedSec / 60)} min`;
    // Confidence floor scales with how long we've been collecting, so a slot
    // that only ever caught a few minutes of background-wake activity isn't
    // presented as a trustworthy "active" reading.
    const minSlot = getMinSlotSeconds();

    if (observedSec < 60) {
      return (
        <div className="schedule-strip-detail">
          <div className="schedule-strip-detail-header">
            <span className="schedule-strip-detail-hour">{formatHour12(h)}</span>
            <span className="schedule-strip-detail-group">{groupLabel}</span>
            <button
              type="button"
              className="schedule-strip-detail-close"
              onClick={() => setSelectedHour(null)}
              title="Close"
              aria-label="Close detail"
            >×</button>
          </div>
          <div className="schedule-strip-detail-body">
            <p className="schedule-strip-detail-empty">
              No observation collected at this hour yet for {groupLabel.toLowerCase()}.
              The strip will fill in as the app keeps running.
            </p>
          </div>
        </div>
      );
    }

    // Between "has some data" and "enough data to trust": show how much was
    // observed but withhold the confident active/charging percentages, since
    // a handful of minutes over many days is noise, not a routine.
    if (observedSec < minSlot) {
      return (
        <div className="schedule-strip-detail">
          <div className="schedule-strip-detail-header">
            <span className="schedule-strip-detail-hour">{formatHour12(h)}</span>
            <span className="schedule-strip-detail-group">{groupLabel}</span>
            <button
              type="button"
              className="schedule-strip-detail-close"
              onClick={() => setSelectedHour(null)}
              title="Close"
              aria-label="Close detail"
            >×</button>
          </div>
          <div className="schedule-strip-detail-body">
            <div className="schedule-strip-detail-row">
              <span className="schedule-strip-detail-label">Observed</span>
              <span className="schedule-strip-detail-value">
                {observedFmt} of data recorded at this hour
              </span>
            </div>
            <p className="schedule-strip-detail-empty">
              Not enough yet to judge how active this hour is — only {observedFmt}{" "}
              recorded, below the {Math.round(minSlot / 60)} min needed after{" "}
              {getObservationDays()} {getObservationDays() === 1 ? "day" : "days"} of
              use. Activity stats appear once more time is logged here.
            </p>
          </div>
        </div>
      );
    }

    const activeMinPerHr = Math.round(activePct * 60);
    const chargingMinPerHr = Math.round(chargingPct * 60);

    return (
      <div className="schedule-strip-detail">
        <div className="schedule-strip-detail-header">
          <span className="schedule-strip-detail-hour">{formatHour12(h)}</span>
          <span className="schedule-strip-detail-group">{groupLabel}</span>
          <button
            type="button"
            className="schedule-strip-detail-close"
            onClick={() => setSelectedHour(null)}
            title="Close"
            aria-label="Close detail"
          >×</button>
        </div>
        <div className="schedule-strip-detail-body">
          <div className="schedule-strip-detail-row">
            <span className="schedule-strip-detail-label">Observed</span>
            <span className="schedule-strip-detail-value">
              {observedFmt} of data recorded at this hour
            </span>
          </div>
          <div className="schedule-strip-detail-row">
            <span
              className="schedule-strip-detail-label"
              style={{ color: `rgb(${ROUTINE_HEATMAP_ACTIVE_RGB})` }}
            >Active</span>
            <span className="schedule-strip-detail-value">
              <strong>{Math.round(activePct * 100)}%</strong> — you were active roughly{" "}
              <strong>{activeMinPerHr} of every 60 minutes</strong>
            </span>
          </div>
          <div className="schedule-strip-detail-row">
            <span
              className="schedule-strip-detail-label"
              style={{ color: `rgb(${ROUTINE_HEATMAP_CHARGING_RGB})` }}
            >Charging</span>
            <span className="schedule-strip-detail-value">
              <strong>{Math.round(chargingPct * 100)}%</strong> — typically{" "}
              <strong>{chargingMinPerHr > 30 ? "plugged in" : "on battery"}</strong>{" "}
              ({chargingMinPerHr} min/hr on AC)
            </span>
          </div>
          {/* Top workloads at this hour. Only render when active% is high
              enough that the breakdown is meaningful — under 5% active and
              you're aggregating noise. */}
          {(() => {
            if (activePct < 0.05) return null;
            const list = getHourWorkloads(h, group).slice(0, 3);
            if (list.length === 0) return null;
            return (
              <div className="schedule-strip-detail-row">
                <span className="schedule-strip-detail-label">Workloads</span>
                <div className="schedule-strip-workloads">
                  {list.map(w => {
                    const meta = WORKLOAD_TYPE_META[w.type] ?? { label: w.type, icon: <Activity size={12} />, rgb: "138, 143, 160" };
                    const pct = Math.round(w.share * 100);
                    // Inline CSS vars so the chip can tint background +
                    // border + icon + bar fill off a single category hue.
                    const styleVars = {
                      "--chip-rgb": meta.rgb,
                      "--chip-share": `${pct}%`,
                    } as React.CSSProperties;
                    return (
                      <span
                        key={w.type}
                        className="schedule-strip-workload-chip"
                        style={styleVars}
                        title={`${meta.label} — ${pct}% of active time at this hour`}
                      >
                        <span className="schedule-strip-workload-icon">{meta.icon}</span>
                        <span className="schedule-strip-workload-label">{meta.label}</span>
                        <span className="schedule-strip-workload-share">{pct}%</span>
                      </span>
                    );
                  })}
                </div>
              </div>
            );
          })()}
          <p className="schedule-strip-detail-note">
            Percentages are over <em>observed</em> time only — hours when the app
            wasn't running don't count for or against.
          </p>
        </div>
      </div>
    );
  };

  return (
    <div className="schedule-strip">
      <div className="schedule-strip-header">
        <div className="schedule-strip-toggle" role="tablist" aria-label="Day filter">
          {(["all", "weekdays", "weekends"] as DayGroup[]).map(g => (
            <button
              key={g}
              type="button"
              role="tab"
              aria-selected={group === g}
              className={`schedule-strip-toggle-btn${group === g ? " is-active" : ""}`}
              onClick={() => { setGroup(g); setSelectedHour(null); }}
            >
              {g === "all" ? "All days" : g === "weekdays" ? "Weekdays" : "Weekends"}
            </button>
          ))}
        </div>
        <span className="schedule-strip-now-label" title="Highlighted cell = current hour">
          Now: {formatHour12(currentHour)}
        </span>
      </div>

      {noDataAtAll ? (
        <div className="schedule-strip-empty">
          No observation yet for {group === "all" ? "any day" : group}. Patterns appear as you keep using the app.
        </div>
      ) : (
        <div className="schedule-strip-body">
          {renderRow("active",   "Active",   ROUTINE_HEATMAP_ACTIVE_RGB,   profile.active)}
          {renderRow("charging", "Charging", ROUTINE_HEATMAP_CHARGING_RGB, profile.charging)}
          <div className="schedule-strip-axis">
            {[0, 3, 6, 9, 12, 15, 18, 21].map(h => (
              <span key={h} className="schedule-strip-axis-tick">{formatHour12(h)}</span>
            ))}
          </div>
          {(() => {
            // I5 — "coming up" line. Shown only when the heatmap gives a
            // confident-enough read on the next few hours.
            if (!forecast.dominantWorkload || forecast.confidence < 0.25) return null;
            const meta = WORKLOAD_TYPE_META[forecast.dominantWorkload];
            if (!meta) return null;
            return (
              <p className="schedule-strip-forecast">
                <span
                  className="schedule-strip-forecast-icon"
                  style={{ color: `rgb(${meta.rgb})` }}
                >
                  {meta.icon}
                </span>
                <span>
                  Coming up — your routine suggests{" "}
                  <strong>{meta.label.toLowerCase()}</strong> over the next few hours.
                </span>
              </p>
            );
          })()}
          {selectedHour !== null
            ? renderDetail(selectedHour)
            : (
              <p className="schedule-strip-hint">
                Click any hour cell to see how that percentage was measured.
              </p>
            )
          }
        </div>
      )}
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

/** Compact label + icon + colour lookup for the schedule-strip workload
 *  breakdown. Per-category colour gives each chip its own identity and
 *  lifts contrast in both light and dark themes (the previous neutral
 *  pill design blended into the panel background in light mode). RGB
 *  triples are used so the CSS can tint background / border / icon at
 *  different alpha levels off the same hue. */
/** Every chip renders an icon, a name and a percentage, so the hue that used to
 *  vary per type (gaming red, office amber, browsing sky — no ordering, no
 *  severity) was a fourth channel encoding nothing the other three didn't
 *  already say. One neutral, kept as an RGB triple so the existing CSS can
 *  still tint background / border / icon at different alphas off it. The value
 *  is --text-secondary, which is legible on both themes. */
const WORKLOAD_CHIP_RGB = "138, 143, 160";

const WORKLOAD_TYPE_META: Record<string, { label: string; icon: React.ReactNode; rgb: string }> = {
  gaming:        { label: "Gaming",        icon: <Gamepad2 size={12} />,      rgb: WORKLOAD_CHIP_RGB },
  editing:       { label: "Creative",      icon: <Film size={12} />,          rgb: WORKLOAD_CHIP_RGB },
  development:   { label: "Development",   icon: <Code2 size={12} />,         rgb: WORKLOAD_CHIP_RGB },
  streaming:     { label: "Media",         icon: <Play size={12} />,          rgb: WORKLOAD_CHIP_RGB },
  communication: { label: "Communication", icon: <MessageCircle size={12} />, rgb: WORKLOAD_CHIP_RGB },
  office:        { label: "Office",        icon: <FileText size={12} />,      rgb: WORKLOAD_CHIP_RGB },
  browsing:      { label: "Browsing",      icon: <Globe size={12} />,         rgb: WORKLOAD_CHIP_RGB },
  other:         { label: "Other",         icon: <Activity size={12} />,      rgb: WORKLOAD_CHIP_RGB },
};

/**
 * Compact workload pill. Clicking selects/deselects the chip — the parent
 * shows an expanded panel for the selected chip with the apps under it and
 * per-app recategorize controls.
 */
function WorkloadChip({
  workload,
  appCount,
  isMain,
  isSelected,
  onClick,
}: {
  workload: WorkloadProfile;
  /** Count of collapsed app groups under this workload. */
  appCount: number;
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
      {appCount > 0 && (
        <span className="workload-chip-apps">
          {appCount} app{appCount !== 1 ? "s" : ""}
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
  group,
  currentOverrides,
  onChange,
}: {
  group: AppGroup;
  /** Current override list for this app group. `[]` / undefined = auto-detect. `["none"]` = excluded. */
  currentOverrides: string[] | undefined;
  /** Apply a new override list to every member process. `[]` clears it. */
  onChange: (newCategories: string[]) => void;
}) {
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
      <span
        style={{ flex: "1 1 140px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        title={group.names.length > 1 ? group.names.join(", ") : undefined}
      >
        {group.label}
        {group.names.length > 1 && (
          <span style={{ fontSize: 10, color: "var(--text-muted)", marginLeft: 6 }}>
            ·{group.names.length}
          </span>
        )}
        {group.isBackground && (
          <span style={{ fontSize: 10, color: "var(--text-muted)", marginLeft: 6 }}>· bg</span>
        )}
      </span>
      <span style={{ color: "var(--text-muted)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
        {group.cpuPercent.toFixed(1)}%
      </span>
      <span style={{ color: "var(--text-muted)", fontVariantNumeric: "tabular-nums", flexShrink: 0, minWidth: 60, textAlign: "right" }}>
        {group.memoryMb >= 1024 ? `${(group.memoryMb / 1024).toFixed(1)} GB` : `${group.memoryMb.toFixed(0)} MB`}
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
            className="workload-control-select"
            value=""
            onChange={(e) => handleAdd(e.target.value)}
            title="Add this app to another workload"
            style={{
              padding: "3px 6px", fontSize: 11,
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
          className="workload-control-select"
          value={mode === "explicit" ? "auto" : mode}
          onChange={(e) => handleModeChange(e.target.value)}
          title="Auto = follow detection rules; None = exclude from every workload"
          style={{
            padding: "3px 6px", fontSize: 11,
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
    mainWorkload,
    runningApps,
  } = useInsights();
  const { current: snapshot } = usePerformanceData();
  const { data: processes } = useProcesses();
  const { info: thermalDelegate, loading: thermalLoading } = useThermalDelegate();
  const { capabilities: oemThermalCaps, status: oemThermalStatus, maxCpuFanRpm } = useOemThermal();
  const [settings, updateSettings] = useSettings();
  const accent = settings.accentColor;
  const queryClient = useQueryClient();

  // Crash detection (Phase 1). Queried once — these events only change on
  // reboot, so it never rides the perf-poll loop. A one-shot desktop toast
  // fires for any incident newer than the last-notified mark; the card shows
  // until the user dismisses (acknowledges) it.
  const { data: shutdownEvents } = useQuery({
    queryKey: ["unexpected-shutdowns"],
    queryFn: () => getUnexpectedShutdowns(30),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (shutdownEvents && shutdownEvents.length > 0) {
      void maybeNotifyCrash(shutdownEvents);
    }
  }, [shutdownEvents]);
  const unacknowledgedCrash: ShutdownEvent | null = useMemo(
    () => newestNewerThan(shutdownEvents ?? [], settings.lastAcknowledgedCrashMs),
    [shutdownEvents, settings.lastAcknowledgedCrashMs],
  );
  // Implicated-driver + event-log context for the crash card. Only fetched
  // when there's actually a crash to show — both are one-shot, off the poll
  // loop, and degrade gracefully to empty on non-Windows.
  // Driver list feeds both the crash card and the persistent health card, so
  // it's always fetched (one-shot, cached). Crash context stays crash-gated.
  const { data: deviceDrivers } = useQuery({
    queryKey: ["device-drivers"],
    queryFn: getDeviceDrivers,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const { data: biosInfo } = useQuery({
    queryKey: ["bios-info"],
    queryFn: getBiosInfo,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const { data: crashContext } = useQuery({
    queryKey: ["crash-context"],
    queryFn: () => getCrashContext(30),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    enabled: !!unacknowledgedCrash,
  });
  const emptyContext: CrashContext = { events: [], modernStandby: false, s3Available: false };

  // Persistent System & Driver Health card visibility — shown until the user
  // dismisses the current signature; re-appears when that signature changes.
  const healthSig = useMemo(() => healthSignature(deviceDrivers ?? []), [deviceDrivers]);
  const showHealthCard = deviceDrivers !== undefined && healthSig !== settings.healthCardDismissed;

  // Periodic Windows Update scan (opt-out via settings). Slow + network-bound,
  // so it runs off the poll loop on a multi-hour cadence and is cached.
  const { data: windowsUpdateStatus } = useQuery({
    queryKey: ["windows-update-status"],
    queryFn: getWindowsUpdateStatus,
    staleTime: 3 * 60 * 60 * 1000,
    refetchInterval: 3 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
    enabled: settings.windowsUpdateScan,
  });
  const updatesSig = useMemo(() => updatesSignature(windowsUpdateStatus), [windowsUpdateStatus]);
  const showUpdatesCard =
    totalUpdates(windowsUpdateStatus) > 0 && updatesSig !== settings.updatesCardDismissed;

  const { data: startupData } = useQuery({
    queryKey: ["startup-apps"],
    queryFn: getStartupApps,
    staleTime: 60_000,
    enabled: settings.showStartup,
  });
  // Toggleable, editable apps with measurable startup impact — the actionable
  // set for the "Trim your startup apps" recommendation card.
  const startupCandidates = useMemo<StartupAppInfo[]>(() => {
    const apps = startupData?.apps ?? [];
    return apps.filter(
      (a) => a.enabled && a.editable && (a.impact === "high" || a.impact === "medium"),
    );
  }, [startupData]);
  const [thermalLaunchError, setThermalLaunchError] = useState<string | null>(null);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [displayBusy, setDisplayBusy] = useState(false);
  // Whether the learned-schedule disclosure under the page header is open.
  // Default closed — the subtitle line carries the at-a-glance info.
  const [scheduleOpen, setScheduleOpen] = useState(false);
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

  // Per-workload collapsed app groups. Joins each workload's matched apps to
  // the running roster and folds an app's helper / launcher / backend
  // processes into one row by friendly name. Drives both the chip app-count
  // and the expanded panel, so the two always agree.
  const workloadAppGroups = useMemo(() => {
    const out = new Map<string, AppGroup[]>();
    for (const wl of workloads) {
      const matchedSet = new Set(wl.matchedApps.map(n => n.toLowerCase()));
      const rows = runningApps.filter(a => matchedSet.has(a.name.toLowerCase()));
      out.set(wl.type, groupRunningApps(rows));
    }
    return out;
  }, [workloads, runningApps]);

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
    } else if (action.type === "navigate-tab" && action.tab) {
      if (action.tab === "startup") {
        try { sessionStorage.setItem("tmp:startup-filter", ""); } catch { /* ignore */ }
      }
      onNavigate?.(action.tab);
      dismissInsight(insight.id);
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
  // Apply one override list to every member process of an app group in a
  // single settings write. (Calling a per-app handler in a loop would race
  // on the stale `settings` closure and only the last write would stick.)
  const handleOverrideApps = useCallback((appNames: string[], newCategories: string[]) => {
    const next = { ...settings.appCategoryOverrides };
    for (const appName of appNames) {
      const key = appName.toLowerCase();
      if (newCategories.length === 0) {
        delete next[key];
      } else {
        next[key] = newCategories;
      }
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

  // Esc dismisses the focus modal, matching its backdrop click (both are
  // suppressed while the end-task loop is running).
  useEffect(() => {
    if (!focusModal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !focusBusy) { e.preventDefault(); setFocusModal(null); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusModal, focusBusy]);

  if (!snapshot) return <div className="loading-overlay">Initializing Insights...</div>;

  const cpuStatus: "good" | "warn" | "bad" = snapshot.cpu_usage_percent > 85 ? "bad" : snapshot.cpu_usage_percent > 60 ? "warn" : "good";
  const memUsedPct = (snapshot.used_ram_bytes / snapshot.total_ram_bytes) * 100;
  const memStatus: "good" | "warn" | "bad" = memUsedPct > 90 ? "bad" : memUsedPct > 75 ? "warn" : "good";
  const diskStatus: "good" | "warn" | "bad" = snapshot.disk_active_percent > 90 ? "bad" : snapshot.disk_active_percent > 60 ? "warn" : "good";
  const gpuStatus: "good" | "warn" | "bad" = snapshot.gpu_temperature > 85 ? "bad" : snapshot.gpu_temperature > 75 ? "warn" : "good";

  const criticals = insights.filter(i => i.severity === "critical");
  // The startup health insight is rendered as the richer, interactive
  // "Trim your startup apps" recommendation card instead of a plain insight.
  const warnings = insights.filter(i => i.severity === "warning" && i.id !== "startup-health");
  const infos = insights.filter(i => i.severity === "info" && i.id !== "startup-health");

  // Determine primary fan recommendation (highest priority workload)
  const primaryWorkload = workloads.length > 0 ? workloads[0] : null;
  const fanStyle = primaryWorkload ? (FAN_COLORS[primaryWorkload.fanProfile as keyof typeof FAN_COLORS] || FAN_COLORS.balanced) : FAN_COLORS.balanced;

  const oemCurrentModeLabel =
    oemThermalCaps?.supports_perf_mode && oemThermalStatus?.current_mode_id
      ? oemThermalCaps.perf_modes.find((p) => p.id === oemThermalStatus.current_mode_id)?.label ?? null
      : null;

  type TelemetryChip = {
    key: string;
    icon: ReactNode;
    label: string;
    value: string;
    unit?: string;
    accent?: string;
    barPct?: number;
  };
  const telemetryChips: TelemetryChip[] = [];
  if (oemThermalCaps?.supports_fan_rpm) {
    const rpm = oemThermalStatus?.cpu_fan_rpm ?? 0;
    const pct = maxCpuFanRpm > 0 ? Math.min((rpm / maxCpuFanRpm) * 100, 100) : 0;
    telemetryChips.push({
      key: "speed",
      icon: <Fan size={14} />,
      label: "Current speed",
      value: oemThermalStatus?.cpu_fan_rpm != null ? oemThermalStatus.cpu_fan_rpm.toLocaleString() : "—",
      unit: "RPM",
      barPct: rpm > 0 ? pct : undefined,
    });
  }
  if (oemThermalCaps?.supports_perf_mode) {
    telemetryChips.push({
      key: "mode",
      icon: <Gauge size={14} />,
      label: "Current mode",
      value: oemCurrentModeLabel ?? "—",
    });
  }
  if (primaryWorkload) {
    telemetryChips.push({
      key: "rec",
      icon: <Sparkles size={14} />,
      label: "Recommended",
      value: primaryWorkload.fanProfile.charAt(0).toUpperCase() + primaryWorkload.fanProfile.slice(1),
      accent: fanStyle.color,
    });
  }

  return (
    <div className="resource-page insights-page">
      <div className="page-header">
        <div className="header-main">
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <h2>Insights</h2>
            {/* Learned-schedule subtitle. Always rendered (either the
                detected schedule or a learning-progress line) so the page
                header has a consistent shape. Clickable to expand the
                detail block (heatmap + reset). */}
            {(() => {
              const subtitleText = formatScheduleSubtitle(schedulePatterns);
              const observedH = schedulePatterns.totalObservedSeconds / 3600;
              const learningTarget = 3; // matches MIN_OBSERVATION_HOURS
              const learningPct = Math.min(100, (observedH / learningTarget) * 100);
              return (
                <button
                  type="button"
                  className="schedule-subtitle"
                  onClick={() => setScheduleOpen(o => !o)}
                  aria-expanded={scheduleOpen}
                  title={subtitleText
                    ? "Click to view learned-schedule detail"
                    : "Click to view learning progress"}
                >
                  <Activity size={12} aria-hidden style={{ flexShrink: 0 }} />
                  <span className="schedule-subtitle-text">
                    {subtitleText
                      ? subtitleText
                      : schedulePatterns.ready
                        ? "No consistent schedule detected yet — keep using the app"
                        : `Learning your schedule — ${observedH.toFixed(1)}h / ${learningTarget}h observed`}
                  </span>
                  {!subtitleText && !schedulePatterns.ready && (
                    <span className="schedule-subtitle-progress" aria-hidden>
                      <span
                        className="schedule-subtitle-progress-fill"
                        style={{ width: `${learningPct}%` }}
                      />
                    </span>
                  )}
                  {scheduleOpen
                    ? <ChevronUp size={14} aria-hidden style={{ flexShrink: 0 }} />
                    : <ChevronDown size={14} aria-hidden style={{ flexShrink: 0 }} />}
                </button>
              );
            })()}
          </div>
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
        {/* Expanded learned-schedule detail. Renders a single combined
            heatmap (active fill + charging bar inside each cell) plus a
            reset link and the "learned from N hours" stamp. */}
        {scheduleOpen && (
          <div className="schedule-detail">
            <div className="schedule-detail-header">
              <span className="schedule-detail-title">Learned weekly schedule</span>
              <span className="schedule-detail-meta">
                {(() => {
                  const h = schedulePatterns.totalObservedSeconds / 3600;
                  if (h < 1) return "Just started observing — patterns will appear after a few hours";
                  if (h < 24) return `Learned from ${h.toFixed(1)} h of observation`;
                  return `Learned from ${(h / 24).toFixed(1)} days of observation`;
                })()}
              </span>
            </div>
            <ScheduleStrip />
            <div className="schedule-detail-footer">
              <button
                type="button"
                className="schedule-detail-reset"
                onClick={() => {
                  if (confirm("Clear all learned schedule data? This can't be undone.")) {
                    resetUsagePattern();
                  }
                }}
                title="Wipe the learned schedule and start fresh"
              >
                <RotateCcw size={12} aria-hidden /> Reset learned schedule
              </button>
            </div>
          </div>
        )}

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
                        appCount={workloadAppGroups.get(wl.type)?.length ?? 0}
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
              const appGroups = workloadAppGroups.get(wl.type) ?? [];
              const isMain = mainWorkload.profile?.type === wl.type;
              return (
                <div
                  className="workload-expanded"
                  style={{
                    marginTop: 10, padding: 10,
                    border: "1px solid var(--border-color)",
                    borderRadius: "var(--radius-sm)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{wl.label}</span>
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                      {appGroups.length} app{appGroups.length !== 1 ? "s" : ""}
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
                  {appGroups.length === 0 ? (
                    <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0, padding: "4px 0" }}>
                      No apps for this workload are visible in the running roster (they may be background-only or below the activity threshold).
                    </p>
                  ) : (
                    appGroups.map(g => (
                      <WorkloadAppRow
                        key={g.key}
                        group={g}
                        currentOverrides={settings.appCategoryOverrides[g.names[0].toLowerCase()]}
                        onChange={(newCats) => handleOverrideApps(g.names, newCats)}
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
                className="workload-control-select"
                value={settings.mainWorkloadType}
                onChange={(e) => handlePinMainWorkload(e.target.value)}
                style={{
                  flex: "1 1 180px", minWidth: 0,
                  padding: "6px 10px",
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
                  </div>
                  {telemetryChips.length > 0 && (
                    <div
                      className="thermal-telemetry-chips"
                      role="group"
                      aria-label="Fan telemetry"
                    >
                      {telemetryChips.map((chip) => {
                        const barColor =
                          chip.barPct == null
                            ? undefined
                            : chip.barPct >= 85
                              ? "var(--accent-red)"
                              : chip.barPct >= 65
                                ? "var(--accent-orange)"
                                : "var(--accent-primary)";
                        return (
                          <div
                            key={chip.key}
                            className="thermal-telemetry-chip"
                            style={chip.accent ? { borderColor: `${chip.accent}55` } : undefined}
                          >
                            <span
                              className="thermal-telemetry-chip-icon"
                              style={chip.accent ? { color: chip.accent, background: `${chip.accent}1a` } : undefined}
                            >
                              {chip.icon}
                            </span>
                            <div className="thermal-telemetry-chip-body">
                              <span className="thermal-telemetry-chip-label">{chip.label}</span>
                              <span
                                className="thermal-telemetry-chip-value"
                                style={chip.accent ? { color: chip.accent } : undefined}
                                title={chip.key === "rec" ? primaryWorkload?.fanDescription : undefined}
                              >
                                {chip.value}
                                {chip.unit && <span className="thermal-telemetry-chip-unit">{chip.unit}</span>}
                              </span>
                              {chip.barPct != null && (
                                <div
                                  className="thermal-telemetry-chip-bar"
                                  title={`${chip.barPct.toFixed(0)}% of session peak (${maxCpuFanRpm.toLocaleString()} RPM)`}
                                >
                                  <div
                                    className="thermal-telemetry-chip-bar-fill"
                                    style={{ width: `${chip.barPct}%`, background: barColor }}
                                  />
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <p className="thermal-delegate-detail">
                    {thermalDelegate
                      ? thermalDelegate.detailLine
                      : "We could not read your system vendor. Use Windows power settings, or install your laptop maker's control app (for example G-Helper for many ASUS / ROG models)."}
                  </p>
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

        {/* Crash / unexpected-shutdown alert — sits just above the
            recommendations/issues stack (below Frequent Apps). */}
        {unacknowledgedCrash && (
          <CrashAlertCard
            event={unacknowledgedCrash}
            allEvents={shutdownEvents ?? []}
            drivers={deviceDrivers ?? []}
            context={crashContext ?? emptyContext}
            onDismiss={() =>
              updateSettings({ lastAcknowledgedCrashMs: unacknowledgedCrash.timestampMs })
            }
          />
        )}

        {/* All Clear State — suppressed while a crash alert is showing so we
            don't claim "running smoothly" next to a crash. */}
        {insights.length === 0 && calibrated && !unacknowledgedCrash && (
          <div className="insights-clear" style={{ background: hexToRgba(accent, 0.04), borderColor: hexToRgba(accent, 0.15) }}>
            {/* Was "System Running Smoothly" over a 20-word sentence naming the
                product and listing what it watches for. Title case and the
                product name put it in a marketing register, and the sentence
                restated what the page is for rather than telling the user
                anything about their machine. */}
            <div className="clear-icon" style={{ background: hexToRgba(accent, 0.12), color: accent }}>✓</div>
            <h3>No issues detected</h3>
            <p>Checks are up to date.</p>
          </div>
        )}

        {criticals.length > 0 && (
          <div className="insight-group">
            <h3 className="section-title">Critical Issues</h3>
            {criticals.map(i => <InsightCard key={i.id} insight={i} onAction={handleAction} />)}
          </div>
        )}

        {warnings.length > 0 && (
          <div className="insight-group">
            <h3 className="section-title">Warnings</h3>
            {warnings.map(i => <InsightCard key={i.id} insight={i} onAction={handleAction} />)}
          </div>
        )}

        {(infos.length > 0 || startupCandidates.length > 0) && (
          <div className="insight-group">
            {/* No inline color: a tinted section heading is decoration, and it
                was a fourth near-duplicate blue besides. Hierarchy comes from
                .section-title's size and weight. */}
            <h3 className="section-title">Recommendations</h3>
            {startupCandidates.length > 0 && (
              <StartupRecommendationCard
                candidates={startupCandidates}
                onNavigate={onNavigate}
                queryClient={queryClient}
              />
            )}
            {infos.map(i => <InsightCard key={i.id} insight={i} onAction={handleAction} />)}
          </div>
        )}

        {/* Update Helper — persistent System & driver health card, plus the
            periodic "updates available" card. Sit at the bottom of the
            recommendations stack. */}
        {showHealthCard && (
          <SystemHealthCard
            bios={biosInfo}
            drivers={deviceDrivers ?? []}
            onDismiss={() => updateSettings({ healthCardDismissed: healthSig })}
          />
        )}
        {showUpdatesCard && windowsUpdateStatus && (
          <UpdatesAvailableCard
            status={windowsUpdateStatus}
            onDismiss={() => updateSettings({ updatesCardDismissed: updatesSig })}
          />
        )}

        {/* (The bottom-of-page "Daily Routine" card is gone — superseded
            by the schedule-strip detail under the page header.) */}

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
              role="dialog"
              aria-modal="true"
              aria-labelledby="focus-modal-title"
              style={{
                background: "var(--bg-secondary)",
                border: "1px solid var(--border-color)",
                borderRadius: "var(--radius-md)",
                padding: 20, maxWidth: 520, width: "90%",
                maxHeight: "80vh", overflow: "auto",
              }}
            >
              <h3 id="focus-modal-title" style={{ margin: "0 0 6px 0", fontSize: 16 }}>
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

      </div>
    </div>
  );
}

import type { PerformanceSnapshot } from "./types";
import { WINDOWS_POWER_SETTINGS_URI } from "./ipc";
import { guessWorkload } from "./workloadGuess";

export type InsightSeverity = "info" | "warning" | "critical";
export type InsightCategory = "memory" | "cpu" | "disk" | "network" | "gpu" | "battery" | "general";

export interface InsightAction {
  label: string;
  type: "end-task" | "dismiss" | "open-uri";
  pid?: number;
  processName?: string;
  /** Windows `ms-settings:` or other URL opened via the OS handler */
  uri?: string;
}

function isWindowsPlatform(): boolean {
  return typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
}

function windowsPowerSettingsActions(): InsightAction[] {
  if (!isWindowsPlatform()) return [];
  return [
    { label: "Open Windows Power & battery", type: "open-uri", uri: WINDOWS_POWER_SETTINGS_URI },
  ];
}

export interface Insight {
  id: string;
  severity: InsightSeverity;
  category: InsightCategory;
  title: string;
  description: string;
  metric?: string;
  actions: InsightAction[];
  timestamp: number;
}

// --- Protected processes that should never be recommended for closing ---
// "Memory Compression" / "Secure System" are pseudo-processes the kernel hosts
// — ending them is either disallowed by Windows or destabilises the system
// (Memory Compression manages compressed RAM pages; killing it leads to
// thrashing). Kept here so the focus-on-workload action and resource-hog
// suggestions never offer them as targets.
const SYSTEM_PROCESSES = new Set([
  "system", "system idle process", "registry", "smss.exe", "csrss.exe",
  "wininit.exe", "services.exe", "lsass.exe", "svchost.exe", "dwm.exe",
  "explorer.exe", "winlogon.exe", "fontdrvhost.exe", "spoolsv.exe",
  "taskmanagerplus", "taskmanagerplus.exe", "conhost.exe", "dllhost.exe",
  "sihost.exe", "taskhostw.exe", "runtimebroker.exe", "searchhost.exe",
  "startmenuexperiencehost.exe", "shellexperiencehost.exe",
  "textinputhost.exe", "widgetservice.exe", "ctfmon.exe",
  "memory compression", "secure system",
  "lockapp.exe", "logonui.exe", "userinit.exe",
  "wmiprvse.exe", "audiodg.exe", "mpdefendercoreservice.exe",
]);

function isSystemProcess(name: string): boolean {
  return SYSTEM_PROCESSES.has(name.toLowerCase());
}

/** Public alias of the internal isSystemProcess check, for use by the engine. */
export function isSystemProcessName(name: string): boolean {
  return isSystemProcess(name);
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>();

// --- Linear regression helper ---
function linearRegression(values: number[]): { slope: number; r2: number } {
  const n = values.length;
  if (n < 2) return { slope: 0, r2: 0 };
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumX2 += i * i;
    sumY2 += values[i] * values[i];
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return { slope: 0, r2: 0 };
  const slope = (n * sumXY - sumX * sumY) / denom;
  const ssTot = sumY2 - (sumY * sumY) / n;
  const ssRes = ssTot - slope * slope * denom / n;
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  return { slope, r2 };
}

// --- Detection Functions ---

/**
 * Memory leak detector. The previous gate (slope > 0.5 MB/min over 1 min) fired
 * on completely benign noise — e.g. "14 MB grown over 1.7 min (6.7 MB/min)" for
 * an editor that just opened a file. A real leak needs to be visible across:
 *   - a long enough window (5+ minutes; transient growth is normal)
 *   - a meaningful slope (≥ 3 MB/min; not just GC / cache jitter)
 *   - a meaningful absolute total (≥ 100 MB cumulative)
 *   - a meaningful RELATIVE total (≥ 25% growth from baseline; otherwise a
 *     2 GB browser gaining 100 MB is just normal cache use)
 *   - high goodness-of-fit (r² > 0.85; rules out wobbly spiky processes)
 *
 * All four numeric gates must clear together. Severity bumps to "critical"
 * when growth exceeds 750 MB AND slope exceeds 8 MB/min — sustained, fast,
 * and large.
 */
export function detectMemoryLeaks(
  processMemHistory: Map<string, number[]>,
  /** Minimum samples (1 sample ≈ 1s). 300 = 5 minutes of observation. */
  minSamples: number = 300,
): Insight[] {
  const insights: Insight[] = [];
  const MIN_SLOPE_MB_PER_MIN = 3;
  const MIN_ABS_GROWTH_MB = 100;
  const MIN_REL_GROWTH = 0.25;        // grew by ≥25% of starting size
  const MIN_R2 = 0.85;
  const CRITICAL_GROWTH_MB = 750;
  const CRITICAL_SLOPE_MB_PER_MIN = 8;

  for (const [name, values] of processMemHistory) {
    if (values.length < minSamples) continue;
    if (isSystemProcess(name)) continue;

    const { slope, r2 } = linearRegression(values);
    // slope is MB per sample (1 sample ≈ 1s), convert to MB per minute
    const slopePerMin = slope * 60;
    if (r2 < MIN_R2) continue;
    if (slopePerMin < MIN_SLOPE_MB_PER_MIN) continue;

    const start = values[0];
    const end = values[values.length - 1];
    const totalGrowth = end - start;
    if (totalGrowth < MIN_ABS_GROWTH_MB) continue;

    // Relative gate: a 100 MB gain on a 50 MB process is a leak; a 100 MB gain
    // on a 4 GB process is rounding error. Use max(start, 200 MB) so tiny
    // baselines don't make the relative test trivially pass for normal apps.
    const baseline = Math.max(start, 200);
    if (totalGrowth / baseline < MIN_REL_GROWTH) continue;

    const minutes = (values.length / 60).toFixed(1);
    const isCritical =
      totalGrowth > CRITICAL_GROWTH_MB && slopePerMin > CRITICAL_SLOPE_MB_PER_MIN;
    insights.push({
      id: `mem-leak:${name}`,
      severity: isCritical ? "critical" : "warning",
      category: "memory",
      title: `Possible Memory Leak: ${name}`,
      description: `Memory has grown steadily by ${totalGrowth.toFixed(0)} MB over ${minutes} min (${slopePerMin.toFixed(1)} MB/min, ${((totalGrowth / baseline) * 100).toFixed(0)}% above its starting size).`,
      metric: `+${totalGrowth.toFixed(0)} MB`,
      actions: [
        { label: "End Task", type: "end-task", processName: name },
        { label: "Dismiss", type: "dismiss" },
      ],
      timestamp: Date.now(),
    });
  }
  return insights;
}

export function detectCommitPressure(snapshot: PerformanceSnapshot): Insight | null {
  const ratio = snapshot.committed_bytes / snapshot.commit_limit_bytes;
  if (ratio > 0.85) {
    return {
      id: "commit-pressure",
      severity: ratio > 0.95 ? "critical" : "warning",
      category: "memory",
      title: "High Committed Memory",
      description: `System has committed ${(ratio * 100).toFixed(0)}% of the commit limit (RAM + paging pool — not the same as physical RAM usage). New virtual allocations may fail even if free RAM looks OK.`,
      metric: `${(ratio * 100).toFixed(0)}%`,
      actions: [{ label: "Dismiss", type: "dismiss" }],
      timestamp: Date.now(),
    };
  }
  return null;
}

export function detectLowMemory(snapshot: PerformanceSnapshot): Insight | null {
  const availRatio = snapshot.available_ram_bytes / snapshot.total_ram_bytes;
  if (availRatio < 0.10) {
    return {
      id: "low-memory",
      severity: availRatio < 0.05 ? "critical" : "warning",
      category: "memory",
      title: "Low Available Memory",
      description: `Only ${(availRatio * 100).toFixed(1)}% of RAM is available. Close unused applications to free memory.`,
      metric: `${(snapshot.available_ram_bytes / (1024 ** 3)).toFixed(1)} GB free`,
      actions: [{ label: "Dismiss", type: "dismiss" }],
      timestamp: Date.now(),
    };
  }
  return null;
}

export function detectCpuBottleneck(history: PerformanceSnapshot[]): Insight | null {
  if (history.length < 30) return null;
  const recent = history.slice(-30);
  const sustained = recent.every(s => s.cpu_usage_percent > 85);
  if (sustained) {
    const avg = recent.reduce((a, s) => a + s.cpu_usage_percent, 0) / recent.length;
    return {
      id: "cpu-bottleneck",
      severity: avg > 95 ? "critical" : "warning",
      category: "cpu",
      title: "High Sustained CPU Usage",
      description: `CPU has been above 85% for over 30 seconds (avg ${avg.toFixed(0)}%). This may slow down your system.`,
      metric: `${avg.toFixed(0)}% avg`,
      actions: [{ label: "Dismiss", type: "dismiss" }],
      timestamp: Date.now(),
    };
  }
  return null;
}

export function detectDiskBottleneck(history: PerformanceSnapshot[]): Insight | null {
  if (history.length < 10) return null;
  const recent = history.slice(-10);
  const sustained = recent.every(s => s.disk_active_percent > 90 && s.disk_queue_length > 2);
  if (sustained) {
    const avgQueue = recent.reduce((a, s) => a + s.disk_queue_length, 0) / recent.length;
    return {
      id: "disk-bottleneck",
      severity: "warning",
      category: "disk",
      title: "Disk Bottleneck Detected",
      description: `Disk is at 90%+ utilization with a queue depth of ${avgQueue.toFixed(1)} for over 10 seconds.`,
      metric: `Queue: ${avgQueue.toFixed(1)}`,
      actions: [{ label: "Dismiss", type: "dismiss" }],
      timestamp: Date.now(),
    };
  }
  return null;
}

export function detectNetworkSaturation(history: PerformanceSnapshot[]): Insight | null {
  if (history.length < 10) return null;
  const recent = history.slice(-10);
  const saturated = recent.every(s => {
    if (s.net_link_speed_bps <= 0) return false;
    const usage = ((s.net_send_per_sec + s.net_recv_per_sec) * 8) / s.net_link_speed_bps;
    return usage > 0.80;
  });
  if (saturated) {
    return {
      id: "network-saturation",
      severity: "warning",
      category: "network",
      title: "Network Connection Saturated",
      description: "Network usage is above 80% of link speed. Downloads and streaming may be affected.",
      actions: [{ label: "Dismiss", type: "dismiss" }],
      timestamp: Date.now(),
    };
  }
  return null;
}

export function detectGpuOverheat(snapshot: PerformanceSnapshot, tempUnit: "celsius" | "fahrenheit"): Insight | null {
  const tempC = snapshot.gpu_temperature;
  if (tempC <= 0) return null;
  if (tempC > 85) {
    const display = tempUnit === "fahrenheit" ? `${(tempC * 9 / 5 + 32).toFixed(0)}°F` : `${tempC.toFixed(0)}°C`;
    return {
      id: "gpu-overheat",
      severity: tempC > 95 ? "critical" : "warning",
      category: "gpu",
      title: "GPU Running Hot",
      description: `GPU temperature is ${display}. Consider improving airflow or reducing GPU workload to prevent thermal throttling.`,
      metric: display,
      actions: [{ label: "Dismiss", type: "dismiss" }],
      timestamp: Date.now(),
    };
  }
  return null;
}

export function detectBatteryHealth(snapshot: PerformanceSnapshot): Insight | null {
  if (snapshot.battery_design_capacity_mwh <= 0 || snapshot.battery_full_charge_capacity_mwh <= 0) return null;
  const health = snapshot.battery_full_charge_capacity_mwh / snapshot.battery_design_capacity_mwh;
  if (health < 0.80) {
    return {
      id: "battery-health",
      severity: health < 0.60 ? "critical" : "warning",
      category: "battery",
      title: "Battery Degraded",
      description: `Battery health is at ${(health * 100).toFixed(0)}%. Full charge capacity is ${(snapshot.battery_full_charge_capacity_mwh / 1000).toFixed(1)} Wh vs ${(snapshot.battery_design_capacity_mwh / 1000).toFixed(1)} Wh design.`,
      metric: `${(health * 100).toFixed(0)}%`,
      actions: [
        ...windowsPowerSettingsActions(),
        { label: "Dismiss", type: "dismiss" },
      ],
      timestamp: Date.now(),
    };
  }
  return null;
}

export function detectHighPowerDrain(
  snapshot: PerformanceSnapshot,
  topPower: { name: string; value: number }[],
  history?: PerformanceSnapshot[]
): Insight | null {
  if (snapshot.is_charging || snapshot.battery_percent <= 0) return null;

  // Use averaged power over recent history to avoid false alerts from CPU spikes
  let avgPower = snapshot.power_draw_watts;
  if (history && history.length >= 5) {
    const recent = history.slice(-10);
    avgPower = recent.reduce((sum, s) => sum + s.power_draw_watts, 0) / recent.length;
  }

  if (avgPower > 25) {
    const topList = topPower.slice(0, 3).map(p => `${p.name} (${p.value.toFixed(1)}W)`).join(", ");
    return {
      id: "high-power-drain",
      severity: avgPower > 40 ? "critical" : "warning",
      category: "battery",
      title: "High Power Consumption",
      description: `System is averaging ${avgPower.toFixed(1)}W on battery. Top consumers: ${topList}. Adjust screen timeout, power mode, and background apps in Windows Settings.`,
      metric: `${avgPower.toFixed(1)}W`,
      actions: [
        ...windowsPowerSettingsActions(),
        { label: "Dismiss", type: "dismiss" },
      ],
      timestamp: Date.now(),
    };
  }
  return null;
}

/**
 * Routine-driven: flags ongoing background power draw that's happening
 * during a stretch of the day the user is *typically inactive at* (per the
 * learned schedule). The signal is "you're usually asleep / away right now,
 * but Discord/Slack/some helper is sustaining 1-2 W and slowly draining the
 * battery." These eat overnight runtime users normally never notice.
 *
 * Gates (all required to fire):
 *   - learned routine has classified the current hour as "inactive"
 *   - on battery (no point complaining while plugged in)
 *   - average system power draw over recent history ≥ 4 W (otherwise the
 *     drain is just baseline platform overhead, not a fixable app)
 *   - top consumer is a non-system app with averaged ≥ 1 W
 *
 * Returns at most one card; targets the top consumer.
 */
export function detectOffHoursDrain(
  snapshot: PerformanceSnapshot,
  topPower: { name: string; value: number }[],
  routineState: "active" | "inactive" | "neutral" | "unknown",
  history?: PerformanceSnapshot[],
): Insight | null {
  if (routineState !== "inactive") return null;
  if (snapshot.is_charging || snapshot.battery_percent <= 0) return null;

  let avgPower = snapshot.power_draw_watts;
  if (history && history.length >= 5) {
    const recent = history.slice(-10);
    avgPower = recent.reduce((sum, s) => sum + s.power_draw_watts, 0) / recent.length;
  }
  if (avgPower < 4) return null;

  const topApp = topPower.find(p => !isSystemProcess(p.name) && p.value >= 1);
  if (!topApp) return null;

  return {
    id: `off-hours-drain-${topApp.name}`,
    severity: "info",
    category: "battery",
    title: "Background drain during off-hours",
    description: `You're typically inactive around this time, but ${topApp.name} is sustaining ${topApp.value.toFixed(1)} W. ` +
      `Suspending it could extend overnight runtime by an hour or two.`,
    metric: `${topApp.value.toFixed(1)} W`,
    actions: [
      { label: "End task", type: "end-task", processName: topApp.name },
      { label: "Dismiss", type: "dismiss" },
    ],
    timestamp: Date.now(),
  };
}

/**
 * Routine-driven, purely informational: notes when the user is *actively
 * using* the system during a typical inactive window (e.g. unusual late-
 * night session). No action attached — just a contextual flag so the user
 * isn't surprised when battery drains faster than usual.
 *
 * Conservative thresholds to avoid noise: requires CPU ≥ 15 % so we only
 * fire on real work, not idle background ticks.
 */
export function detectOffRoutineActivity(
  snapshot: PerformanceSnapshot,
  routineState: "active" | "inactive" | "neutral" | "unknown",
): Insight | null {
  if (routineState !== "inactive") return null;
  if (snapshot.cpu_usage_percent < 15) return null;
  return {
    id: "off-routine-activity",
    severity: "info",
    category: "general",
    title: "Activity outside your usual hours",
    description: `Currently using the system during a stretch you're typically inactive at. ` +
      `Battery and thermals will drift higher than your routine baseline — keep that in mind if you're on battery.`,
    actions: [{ label: "Dismiss", type: "dismiss" }],
    timestamp: Date.now(),
  };
}

/** On battery with low charge — nudge toward saver / timeouts before shutdown. */
export function detectLowBatterySettingsHint(snapshot: PerformanceSnapshot): Insight | null {
  if (snapshot.is_charging) return null;
  const pct = snapshot.battery_percent;
  if (pct <= 0 || pct >= 30) return null;
  return {
    id: "low-battery-settings",
    severity: pct < 15 ? "warning" : "info",
    category: "battery",
    title: "Battery Running Low",
    description: `Charge is at ${pct.toFixed(0)}%. Turn on battery saver or shorten screen-off time to stretch remaining runtime.`,
    metric: `${pct.toFixed(0)}%`,
    actions: [
      ...windowsPowerSettingsActions(),
      { label: "Dismiss", type: "dismiss" },
    ],
    timestamp: Date.now(),
  };
}

export interface ResourceHogProcess {
  name: string;
  cpuPercent: number;
  memoryMb: number;
}

/**
 * `exemptNames`, when provided, is the lowercase-name set of apps belonging to
 * the user's (or the engine's auto-picked) "main workload". Apps in this set
 * are exempt from the "high memory while idle" warning, because foreground
 * apps frequently sit at 0% CPU between keystrokes / scroll events while still
 * being *in active use*. High-CPU warnings still apply to main-workload apps
 * (real load is real load).
 */
export function detectResourceHogs(
  processes: ResourceHogProcess[],
  exemptNames?: ReadonlySet<string>,
): Insight[] {
  const insights: Insight[] = [];
  const exempt = exemptNames ?? EMPTY_SET;
  for (const proc of processes) {
    if (isSystemProcess(proc.name)) continue;
    if (proc.cpuPercent > 30) {
      insights.push({
        id: `hog-cpu:${proc.name}`,
        severity: proc.cpuPercent > 60 ? "warning" : "info",
        category: "cpu",
        title: `High CPU: ${proc.name}`,
        description: `Using ${proc.cpuPercent.toFixed(1)}% CPU. Consider closing if not needed.`,
        metric: `${proc.cpuPercent.toFixed(0)}% CPU`,
        actions: [
          { label: "End Task", type: "end-task", processName: proc.name },
          { label: "Dismiss", type: "dismiss" },
        ],
        timestamp: Date.now(),
      });
    }
    const isMain = exempt.has(proc.name.toLowerCase());
    if (proc.memoryMb > 2048 && proc.cpuPercent < 1 && !isMain) {
      insights.push({
        id: `hog-mem:${proc.name}`,
        severity: "info",
        category: "memory",
        title: `High Memory (idle): ${proc.name}`,
        description: `Using ${(proc.memoryMb / 1024).toFixed(1)} GB of memory while nearly idle. Closing it could free significant RAM.`,
        metric: `${(proc.memoryMb / 1024).toFixed(1)} GB`,
        actions: [
          { label: "End Task", type: "end-task", processName: proc.name },
          { label: "Dismiss", type: "dismiss" },
        ],
        timestamp: Date.now(),
      });
    }
  }
  return insights;
}

/**
 * Picks the user's "main workload" from the already-detected workloads list.
 * Order of preference:
 *   1. The user's explicit pin (`pinnedType`), if that workload is currently
 *      detected.
 *   2. The first (highest-priority) detected workload — the same one the UI
 *      shows in the "Detected Workloads" chips.
 *   3. Null if no concrete workload is detected (e.g. system is idle or
 *      "mixed"; we don't pin those because they're catch-alls).
 *
 * Returns the chosen profile + whether the pin took effect. The caller uses
 * `profile.matchedApps` as the exempt set for resource-hog idle warnings.
 */
export function pickMainWorkloadProfile(
  workloads: WorkloadProfile[],
  pinnedType: string,
): { profile: WorkloadProfile | null; pinned: boolean } {
  const pin = pinnedType.trim().toLowerCase();
  if (pin) {
    const match = workloads.find(w => w.type === pin);
    if (match) return { profile: match, pinned: true };
  }
  // Skip "idle" / "mixed" / "other" — those aren't real workloads, just
  // labels for "nothing identifiable is happening". Pinning them would mark
  // every running app as exempt, which defeats the purpose.
  const concrete = workloads.find(
    w => w.type !== "idle" && w.type !== "mixed" && w.type !== "other",
  );
  return { profile: concrete ?? null, pinned: false };
}

export function detectHandleThreadLeak(history: { handles: number; threads: number }[]): Insight | null {
  if (history.length < 60) return null;
  const handles = history.map(h => h.handles);
  const { slope, r2 } = linearRegression(handles);
  const slopePerMin = slope * 60;
  if (r2 > 0.8 && slopePerMin > 50) {
    return {
      id: "handle-leak",
      severity: "warning",
      category: "general",
      title: "System Handle Count Increasing",
      description: `Handle count is growing by ~${slopePerMin.toFixed(0)}/min, which may indicate a resource leak in a running application.`,
      metric: `+${slopePerMin.toFixed(0)}/min`,
      actions: [{ label: "Dismiss", type: "dismiss" }],
      timestamp: Date.now(),
    };
  }
  return null;
}

export function detectHighProcessCount(snapshot: PerformanceSnapshot): Insight | null {
  if (snapshot.process_count > 250) {
    return {
      id: "high-process-count",
      severity: "info",
      category: "general",
      title: "Many Running Processes",
      description: `${snapshot.process_count} processes are running. Consider disabling unnecessary startup programs to improve performance.`,
      metric: `${snapshot.process_count}`,
      actions: [{ label: "Dismiss", type: "dismiss" }],
      timestamp: Date.now(),
    };
  }
  return null;
}

// --- Workload Detection ---

export type WorkloadType =
  | "gaming"
  | "editing"
  | "browsing"
  | "development"
  | "streaming"
  | "communication"
  | "office"
  | "other"
  | "idle"
  | "mixed";

/**
 * Catalog of workload types the UI can offer in dropdowns and that
 * `appCategoryOverrides` can use as values. Order is the order users see in
 * the override picker. "none" is a sentinel meaning "remove this app from any
 * detected workload" — it isn't a real WorkloadType.
 */
export const ASSIGNABLE_WORKLOAD_TYPES: { type: WorkloadType; label: string }[] = [
  { type: "gaming", label: "Gaming" },
  { type: "editing", label: "Creative / Editing" },
  { type: "development", label: "Development" },
  { type: "streaming", label: "Media Playback" },
  { type: "communication", label: "Communication" },
  { type: "office", label: "Office / Productivity" },
  { type: "browsing", label: "Web Browsing" },
  { type: "other", label: "Other" },
];

/**
 * Default profile metadata for workloads added by user override (no regex
 * rule matched, so we need a label/icon/fan recommendation by hand). Mirrors
 * the WORKLOAD_RULES values for the corresponding type.
 */
const OVERRIDE_PROFILE_DEFAULTS: Record<
  WorkloadType,
  { label: string; icon: string; fan: "silent" | "balanced" | "performance" | "turbo"; fanDesc: string; priority: number }
> = {
  gaming:        { label: "Gaming",                 icon: "▶",   fan: "turbo",       fanDesc: "Maximum cooling recommended for sustained gaming loads", priority: 10 },
  editing:       { label: "Creative / Editing",     icon: "◆",   fan: "performance", fanDesc: "Sustained cooling for render-heavy tasks",                priority: 9 },
  development:   { label: "Development",            icon: "{ }", fan: "balanced",    fanDesc: "Balanced cooling — builds may spike, but mostly idle",   priority: 7 },
  streaming:     { label: "Media Playback",         icon: "▷",   fan: "balanced",    fanDesc: "Balanced cooling for sustained video decode",            priority: 5 },
  communication: { label: "Communication",          icon: "◯",   fan: "silent",      fanDesc: "Silent fan profile — chat and voice use minimal cooling", priority: 5 },
  office:        { label: "Office / Productivity",  icon: "▤",   fan: "silent",      fanDesc: "Silent fan profile — minimal cooling needed",            priority: 4 },
  browsing:      { label: "Web Browsing",           icon: "◎",   fan: "silent",      fanDesc: "Silent fan profile — browsing uses minimal resources",   priority: 3 },
  other:         { label: "Other",                  icon: "•",   fan: "silent",      fanDesc: "Generic apps — no specific cooling recommendation",      priority: 2 },
  idle:          { label: "Idle",                   icon: "—",   fan: "silent",      fanDesc: "Silent fan profile — system is mostly idle",             priority: 0 },
  mixed:         { label: "General Use",            icon: "■",   fan: "balanced",    fanDesc: "Balanced cooling for mixed workload",                    priority: 1 },
};

export interface WorkloadProfile {
  type: WorkloadType;
  label: string;
  icon: string;
  fanProfile: "silent" | "balanced" | "performance" | "turbo";
  fanDescription: string;
  matchedApps: string[];
}

/**
 * Build a display-ready {@link WorkloadProfile} from a bare workload type,
 * using the same label / icon / fan defaults the user-override path uses.
 * Exported for the P6 semantic workload classifier, which produces only a
 * category id and needs the surrounding profile metadata to render a chip.
 */
export function workloadProfileForType(
  type: WorkloadType,
  matchedApps: string[] = [],
): WorkloadProfile {
  const d = OVERRIDE_PROFILE_DEFAULTS[type] ?? OVERRIDE_PROFILE_DEFAULTS.mixed;
  return {
    type,
    label: d.label,
    icon: d.icon,
    fanProfile: d.fan,
    fanDescription: d.fanDesc,
    matchedApps,
  };
}

interface ProcessBasic {
  name: string;
  cpuPercent: number;
  memoryMb: number;
  gpuPercent: number;
  /** Pre-lowercased keyword haystack for the metadata matching in
   *  `matchWorkloadApps` — a join of the process image's PE
   *  FileDescription, CompanyName, ProductName, and full install path.
   *  Optional: absent in tests and when the image carries no version
   *  info. Built in `insightsEngine.ts`; see `native/src/memory_telemetry.cpp`
   *  for the underlying fields. */
  metadata?: string;
}

/**
 * True when the process is OS/runtime plumbing or an application's
 * background helper — a crash handler, broker, updater, embedded WebView2
 * runtime, or a service/host process. Such processes are never a
 * "workload" the user is actively doing, so the workload detector skips
 * them entirely (both exe-regex and metadata matching). This keeps
 * helpers like `steamwebhelper`, `steamservice`, `crashpad_handler`,
 * `msedgewebview2`, `RuntimeBroker`, and `*Host` processes out of the
 * workload chips.
 *
 * Matched on the executable name only — cheap and stable. Kept
 * deliberately conservative: every pattern here is something no genuine
 * foreground application would be named.
 *
 * Exported for unit testing.
 */
export function isHelperProcess(name: string): boolean {
  const n = name.toLowerCase().replace(/\.exe$/, "");
  if (
    n.includes("helper") ||
    n.includes("crashpad") ||
    n.includes("crashhandler") ||
    n.includes("crash handler") ||
    n.includes("crashreport") ||
    n.includes("crash report") ||
    n.includes("crashprocessor") ||
    n.includes("crash processor") ||
    n.includes("broker") ||
    n.includes("backgroundapp") ||
    n.includes("background app") ||
    n.includes("webview2") ||
    n.includes("subprocess")
  ) {
    return true;
  }
  // Service / host suffixes — OS plumbing, never a user workload.
  if (n.endsWith("service") || n.endsWith("services") || n.endsWith("svc")) {
    return true;
  }
  if (n.endsWith("host")) return true;
  return false;
}

/**
 * Patterns are split into two tiers:
 *  - `strong`  : unambiguous indicators of the workload (real game titles,
 *                dedicated IDEs, dedicated editors). A strong match always
 *                counts.
 *  - `soft`    : supporting indicators (launchers, runtimes, hosts). A soft
 *                match only counts when paired with either another match of
 *                the same workload or significant resource activity — this
 *                is what prevents a single idling `steam.exe` in the tray
 *                from flipping the whole system into "Gaming" mode.
 *
 * `needsActivity` means the workload only fires if its matched apps show
 * non-trivial CPU or GPU (prevents background apps like always-on Discord
 * from driving the detected workload).
 */
interface WorkloadRule {
  type: WorkloadType;
  label: string;
  icon: string;
  fan: "silent" | "balanced" | "performance" | "turbo";
  fanDesc: string;
  strong: RegExp[];
  soft?: RegExp[];
  /**
   * Option B (enhanced rules): substring keywords matched case-insensitively
   * against descriptive process metadata (the PE FileDescription +
   * ProductName, see `matchWorkloadApps`). Unlike `strong`, which is an
   * anchored exe-name regex, these are loose substring matches — so a
   * metadata match always counts as a SOFT match (it must be paired with
   * real CPU/GPU activity to fire its workload). This is deliberate: a
   * fuzzy keyword hit on an idle background process should never, on its
   * own, light up a workload.
   *
   * KEYWORD AUTHORING RULES — substring matching is unforgiving:
   *  - Never use a keyword that is a substring of a common word/phrase.
   *    "opera" is inside "operating system" (in the ProductName of every
   *    Windows OS process); "plex" is inside "complex"/"duplex". One bad
   *    keyword silently misclassifies dozens of processes.
   *  - Prefer multi-word, unambiguous app names ("visual studio code").
   *  - Do NOT add company names — a company ships many apps plus all
   *    their helper processes, so a company name is far too broad.
   */
  metaKeywords?: string[];
  priority: number;
  /** Minimum combined CPU% across matched apps for the workload to count. */
  minCpu?: number;
  /** Minimum combined GPU% across matched apps. */
  minGpu?: number;
  /** If true, always-on background apps alone cannot trigger this workload. */
  suppressIfAllBackground?: boolean;
}

const WORKLOAD_RULES: WorkloadRule[] = [
  {
    type: "gaming",
    label: "Gaming",
    icon: "▶",
    fan: "turbo",
    fanDesc: "Maximum cooling recommended for sustained gaming loads",
    // Strong: known titles, or Unreal/Unity/Godot shipping-build suffixes
    strong: [
      /^(valorant|valorant-win64-shipping|fortniteclient-win64-shipping|fortnite|csgo|cs2|minecraftlauncher|roblox|robloxplayerbeta|genshinimpact|hk4e|overwatch|apex_legends|r5apex|cyberpunk2077|witcher3|fallout4|fallout76|skyrimse|gta5|gtav|rdr2|satisfactory-win64-shipping|factorio|terraria|stardewvalley|amongus|dota2|leagueclient|leagueclientux|league ?of ?legends|pubg|tslgame|warzone|modernwarfare|cod|bf[0-9]|battlefield2042|fifa[0-9]{2}|nba2k[0-9]{2}|rocketleague|ark|arkascended|rust|dayz|eft|escapefromtarkov|deadlock|baldur ?s ?gate|eldenring|starfield|palworld|lethalcompany|helldivers|helldivers2|halo|halomcc|destiny2|marvelspidermanpc|marvel'?s? ?spider-?man ?remastered|marvelsspidermanmm|marvel'?s? ?spider-?man ?miles ?morales|marvelsspiderman2|spider-?man|gow|godofwar|gowragnarok|horizon|horizonzerodawn|horizonforbiddenwest|tlou|tlou-i|thelastofus|thelastofuspartone|deathstranding|ds|ghostoftsushima|uncharted|sackboy|returnal|sniperelite[0-9]?|metalgear|mgsv|residentevil[0-9]?|re[0-9]+|monsterhunter|mhrise|mhworld|monsterhunterwilds|finalfantasy|ff[0-9]+|ffxv|ffxvi|ff7|ff7r|ffvii|ffviiremake|ffviirebirth|kingdomhearts|kh[0-9]?|nier|nierautomata|nierreplicant|persona[0-9]?|tekken[0-9]?|streetfighter[0-9]?|sf[0-9]+|mortalkombat[0-9]?|mk[0-9]+|guiltygear|samuraishodown|forza|forzahorizon[0-9]?|forzamotorsport|fh[0-9]|fm[0-9]|gtr|f1[0-9]+|f1_[0-9]+|f1manager|dirt[0-9]?|dirtrally[0-9]?|wreckfest|assettocorsa|ac|acc|automobilista[0-9]?|iracing|simhub|simracingstudio|euro ?truck ?simulator[0-9]?|ets[0-9]?|americantrucksimulator|ats|farmingsimulator[0-9]+|fs[0-9]+|trainsimulator|fsx|msfs|microsoftflightsimulator|xplane[0-9]+|warthunder|aces|wot|wotblitz|worldoftanks|warships|wows|sea ?of ?thieves|sot|deeprockgalactic|drg|nomanssky|nms|stardew|hadesii|hades2|disco ?elysium|hollowknight|hk|silksong|celeste|hyperlightdrifter|hades|undertale|dontstarve|dst|terrariaserver|valheim|valheim_server|7daystodie|astroneer|raft|forest|sons ?of ?the ?forest|grounded|enshrouded|dredge|abiotic ?factor|repo|content ?warning|peak|liesofp|sekiro|darksouls|darksouls[0-9]+|ds[0-9]+|ds[0-9]+r|elden|nightreign|wuthering ?waves|wuwa|honkai|honkaistarrail|hsr|honkai ?impact|zenless|zzz|tower ?of ?fantasy|tof|nikke|punishing ?gray ?raven|pgr|granblue|granbluefantasyrelink|gbfr|sword ?art ?online|sao|persona ?5 ?(royal|tactica|strikers)?|p5r|p5s|p5t|likeadragon|yakuza[0-9]?|judgment|lost ?judgment|metaphor|metaphorrefantazio|tales ?of ?(arise|berseria|zestiria|graces)|toa|tob|toz|tog|fairy ?fencer|atelier|atelier[a-z]+|grandblue|granblue|cathedrals?|hogwartslegacy|hogwartslegacyclient|hogwarts|alanwake|alanwake2|control|max ?payne[0-9]?|quantum ?break|deathloop|prey|wolfenstein|wolfenstein[a-z0-9]+|doom|doometernal|doomthedarkages|rage[0-9]?|borderlands[0-9]?|bl[0-9]+|tinytinaswonderlands|outerworlds|outerwilds|atomic ?heart|stalker[0-9]?|stalker2|sh2|silenthill[0-9]?|alone ?in ?the ?dark|amnesia|outlast|outlast[0-9]?|trials|phasmophobia|backrooms|content[a-z]+)\.exe$/i,
      /-(shipping|win64-shipping|win64|windowsnoeditor|trunk|finalrelease)\.exe$/i,
    ],
    // Soft: launchers/runtimes — need activity or a strong match to fire
    soft: [
      /^(steam|steamwebhelper|epicgameslauncher|epicwebhelper|gog ?galaxy|gog\.galaxyclient|battle\.net|origin|originwebhelperservice|riotclient|riotclientservices|uplay|upc|ubisoftconnect|ubisoftgamelauncher|rockstargameslauncher|bethesdanetlauncher|xboxapp|gamingservices|javaw)\.exe$/i,
    ],
    metaKeywords: [
      "valorant", "fortnite", "counter-strike", "minecraft", "roblox",
      "genshin impact", "overwatch", "apex legends", "cyberpunk 2077",
      "the witcher", "grand theft auto", "red dead redemption", "elden ring",
      "starfield", "baldur's gate", "league of legends", "dota 2",
      "call of duty", "battlefield", "ea sports fc", "rocket league",
      "destiny 2", "diablo", "world of warcraft", "starcraft", "hearthstone",
      "monster hunter", "resident evil", "dark souls", "final fantasy",
      "forza", "hogwarts legacy", "god of war", "spider-man",
      "the last of us", "helldivers", "palworld", "deep rock galactic",
      "no man's sky", "path of exile", "warframe", "team fortress",
      "valheim", "stardew valley", "civilization", "total war", "sekiro",
      "hollow knight",
    ],
    priority: 10,
    minGpu: 10,
    minCpu: 3,
  },
  {
    type: "editing",
    label: "Creative / Editing",
    icon: "◆",
    fan: "performance",
    fanDesc: "Sustained cooling for render-heavy tasks",
    strong: [
      /^(resolve|davinci|adobe premiere pro|premiere ?pro|premiere|afterfx|after ?effects|photoshop|lightroom|lightroomclassic|illustrator|indesign|adobe audition|audition|animate|adobe ?media ?encoder|media ?encoder|handbrake|handbrakecli|ffmpeg|obs64|obs|obs-browser-page|streamlabs|xsplit|blender|cinema4d|maya|3dsmax|houdini|nuke|fusion|vegas|vegaspro|kdenlive|gimp|gimp-[0-9.]+|inkscape|krita|audacity|ableton|fl(64)?|flstudio|cubase|reaper|logic|protools|capcut|filmora|hitfilm|unrealeditor|unityeditor|godot)\.exe$/i,
    ],
    metaKeywords: [
      "photoshop", "premiere pro", "after effects", "lightroom",
      "illustrator", "indesign", "adobe audition", "davinci resolve",
      "blender", "cinema 4d", "autodesk maya", "3ds max", "houdini",
      "obs studio", "streamlabs", "fl studio", "ableton live", "audacity",
      "cubase", "pro tools", "krita", "inkscape", "capcut", "filmora",
      "substance painter", "substance designer", "zbrush", "handbrake",
      "vegas pro", "unreal editor", "unity editor", "unity hub", "nuke",
      "reaper",
    ],
    priority: 9,
    minCpu: 2,
  },
  {
    type: "development",
    label: "Development",
    icon: "{ }",
    fan: "balanced",
    fanDesc: "Balanced cooling — builds may spike, but mostly idle",
    // Strong: actual IDEs / editors. Runtimes like node/python/java are
    // intentionally excluded — too many unrelated Windows apps bundle them.
    strong: [
      /^(code|code - insiders|cursor|windsurf|zed|devenv|idea64|idea|webstorm64|pycharm64|pycharm|phpstorm64|rubymine64|clion64|goland64|rider64|datagrip64|studio64|studio|androidstudio|xcode|eclipse|netbeans|sublime_text|subl|atom|brackets|notepad\+\+|gvim|nvim-qt|emacs|windowsterminal|wt|alacritty|wezterm|hyper|warp|mobaxterm)\.exe$/i,
    ],
    // Soft: build tools and containerization clients — need an IDE present
    // or meaningful CPU to count.
    soft: [
      /^(cargo|rustc|dotnet|msbuild|cmake|ninja|bazel|gradle|gradlew|mvn|npm|yarn|pnpm|tsc|vite|webpack|rollup|esbuild|docker ?desktop|docker|com\.docker\.(service|backend)|wsl|wslhost|pwsh|powershell)\.exe$/i,
    ],
    metaKeywords: [
      "visual studio code", "visual studio", "intellij idea", "pycharm",
      "webstorm", "phpstorm", "clion", "datagrip", "goland", "rustrover",
      "jetbrains rider", "android studio", "sublime text", "notepad++",
      "github desktop", "gitkraken", "sourcetree", "windows terminal",
      "jetbrains", "dbeaver", "postman", "docker desktop",
      "git for windows", "git bash",
    ],
    priority: 7,
    minCpu: 1,
  },
  {
    type: "streaming",
    label: "Media Playback",
    icon: "▷",
    fan: "balanced",
    fanDesc: "Balanced cooling for sustained video decode",
    // Strong: dedicated media playback / music clients. No communication apps,
    // no browser-hosted services (Netflix/YouTube run in browsers, not .exe).
    strong: [
      /^(vlc|mpv|mpc-hc|mpc-hc64|mpc-be|mpc-be64|plex|plexamp|plexampdesktop|kodi|jellyfin|jellyfindesktop|windowsmediaplayer|wmplayer|groove|groovemusic|winamp|foobar2000|musicbee|tidal|appledigitalmaster|aimp|spotify|spotifywebhelper)\.exe$/i,
    ],
    metaKeywords: [
      "vlc media player", "media player classic", "windows media player",
      // "plex media server" not bare "plex" — "plex" is a substring of
      // "complex" / "duplex" / "multiplex". Plex apps are also covered by
      // the exe-name regex.
      "spotify", "plex media server", "kodi", "jellyfin", "itunes", "winamp",
      "foobar2000", "musicbee", "potplayer", "tidal", "amazon music",
      "apple music", "groove music", "aimp",
    ],
    priority: 5,
    minCpu: 1,
    suppressIfAllBackground: true,
  },
  {
    type: "communication",
    label: "Communication",
    icon: "◯",
    fan: "silent",
    fanDesc: "Silent fan profile — chat and voice use minimal cooling",
    strong: [
      /^(discord|discordptb|discordcanary|discorddevelopment|zoom|zoommeetings|cpthost|teams|ms-teams|msteams|ms-teams-new|slack|skype|skypebrowserhost|webex|webexmeetingsclient|webexteams|googlemeet|element|telegram|whatsapp|signal|wechat|line|viber|thunderbird|mailspring|betterbird)\.exe$/i,
    ],
    metaKeywords: [
      "discord", "slack", "microsoft teams", "zoom", "skype", "webex",
      "telegram", "whatsapp", "signal desktop", "wechat", "thunderbird",
      "mattermost", "rocket.chat", "google chat",
    ],
    priority: 5,
    // Communication apps are frequently background — don't use them to drive
    // the workload label unless they're actively using CPU (e.g. a call).
    suppressIfAllBackground: true,
    minCpu: 2,
  },
  {
    type: "office",
    label: "Office / Productivity",
    icon: "▤",
    fan: "silent",
    fanDesc: "Silent fan profile — minimal cooling needed",
    strong: [
      /^(winword|excel|powerpnt|msaccess|onenote|outlook|notion|obsidian|evernote|todoist|airtable|figma|figma ?agent|canva|acrobat|acrord32|foxitreader|foxit ?reader|sumatrapdf|libreoffice|soffice|calc|writer|impress)\.exe$/i,
    ],
    metaKeywords: [
      "microsoft word", "microsoft excel", "microsoft powerpoint",
      "microsoft outlook", "microsoft onenote", "microsoft access",
      "microsoft publisher", "microsoft visio", "notion", "obsidian",
      "evernote", "libreoffice", "wps office", "adobe acrobat", "foxit",
      "sumatra pdf", "pdf-xchange", "todoist", "trello", "scrivener",
      "zotero",
    ],
    priority: 4,
  },
  {
    type: "browsing",
    label: "Web Browsing",
    icon: "◎",
    fan: "silent",
    fanDesc: "Silent fan profile — browsing uses minimal resources",
    strong: [
      /^(chrome|msedge|firefox|brave|opera|opera_gx|vivaldi|safari|arc|tor|waterfox|librewolf|zen|ungoogled-chromium)\.exe$/i,
    ],
    metaKeywords: [
      "google chrome", "mozilla firefox", "microsoft edge", "brave",
      "vivaldi", "chromium", "tor browser", "librewolf",
      "waterfox", "web browser", "internet browser",
      // NOTE: do NOT add bare "opera" — it is a substring of "operating
      // system", which appears in the ProductName of essentially every
      // Windows OS process. Opera is covered by the exe-name regex
      // (opera/opera_gx) and the "internet browser" keyword instead.
    ],
    priority: 3,
    minCpu: 1,
  },
];

interface MatchedWorkload {
  type: WorkloadType;
  matches: string[];
  priority: number;
  rule: WorkloadRule;
  /** True if at least one matched app was a strong pattern hit. */
  hasStrong: boolean;
  totalCpu: number;
  totalGpu: number;
  /** True if every matched app is flagged as background/always-on. */
  allBackground: boolean;
}

/**
 * `appOverrides` maps lowercase process name → ARRAY of user-assigned
 * WorkloadTypes (or `["none"]` meaning "remove from every workload"). An app
 * with multiple types is included in every listed workload's match list.
 *
 * Semantics per app:
 *   - empty/undefined: regex rules apply normally
 *   - ["none"]:        excluded from every workload
 *   - [a]:             excluded from all workloads except `a`; force-included in `a`
 *   - [a, b, ...]:     force-included in each listed workload; excluded from all others
 */
function matchWorkloadApps(
  processes: ProcessBasic[],
  isBackgroundApp?: (name: string) => boolean,
  appOverrides?: Record<string, string[]>,
): MatchedWorkload[] {
  const results: MatchedWorkload[] = [];
  const overrides = appOverrides ?? {};
  const overridesOf = (name: string): string[] | undefined => overrides[name.toLowerCase()];

  for (const rule of WORKLOAD_RULES) {
    const matches: string[] = [];
    let hasStrong = false;
    let totalCpu = 0;
    let totalGpu = 0;
    let allBackground = true;
    let matchedAny = false;

    for (const p of processes) {
      const ov = overridesOf(p.name);
      // Skip if overridden, but NOT to this rule's type. ("none" array always
      // excludes; multi-element arrays exclude from any workload not listed.)
      if (ov && ov.length > 0 && !ov.includes(rule.type)) continue;
      // Force inclusion if the override list contains this rule's type.
      const forced = ov?.includes(rule.type) ?? false;

      // Skip OS/runtime helper processes (crash handlers, brokers, service
      // and host processes, embedded WebView2 runtimes). They are never a
      // workload the user is actively doing — keeping them out stops
      // helpers like steamwebhelper / crashpad_handler / msedgewebview2
      // from polluting the workload chips. An explicit user override still
      // wins.
      if (!forced && isHelperProcess(p.name)) continue;

      // Exe-name regex matching (the original mechanism). Only an exact
      // exe-name match counts as "strong" — strong matches can fire a
      // workload without activity (e.g. a paused game still in memory).
      const exeStrong = rule.strong.some(rx => rx.test(p.name));
      const exeSoft = !exeStrong && (rule.soft?.some(rx => rx.test(p.name)) ?? false);
      // Metadata keyword matching (Option B). Substring-match the rule's
      // keywords against the process's descriptive metadata (`p.metadata` —
      // the PE FileDescription + ProductName, lowercased; see
      // `insightsEngine.ts`). A fuzzy keyword hit always counts as SOFT, so
      // it needs real CPU/GPU activity to fire its workload — an idle
      // background process can never light one up on a keyword alone.
      const meta = p.metadata ?? "";
      const metaHit = meta.length > 0
        && (rule.metaKeywords?.some(kw => meta.includes(kw)) ?? false);

      const isStrong = exeStrong;
      const isSoft = !isStrong && (exeSoft || metaHit);
      if (!isStrong && !isSoft && !forced) continue;

      matches.push(p.name);
      matchedAny = true;
      if (isStrong || forced) hasStrong = true;
      totalCpu += p.cpuPercent;
      totalGpu += p.gpuPercent;

      const bg = isBackgroundApp?.(p.name) ?? false;
      if (!bg) allBackground = false;
    }

    if (!matchedAny) continue;

    // Soft-only matches need real activity to fire.
    if (!hasStrong) {
      const softFires =
        (rule.minCpu !== undefined && totalCpu >= rule.minCpu) ||
        (rule.minGpu !== undefined && totalGpu >= rule.minGpu);
      if (!softFires) continue;
    }

    // Apply per-rule minimums even for strong matches when requested.
    if (rule.minCpu !== undefined && rule.minGpu !== undefined) {
      if (totalCpu < rule.minCpu && totalGpu < rule.minGpu) {
        if (!hasStrong) continue;
      }
    }

    if (rule.suppressIfAllBackground && allBackground) {
      // Background-only match — skip unless there's clear foreground activity.
      if (totalCpu < (rule.minCpu ?? 5) && totalGpu < (rule.minGpu ?? 10)) {
        continue;
      }
    }

    results.push({
      type: rule.type,
      matches,
      priority: rule.priority,
      rule,
      hasStrong,
      totalCpu,
      totalGpu,
      allBackground,
    });
  }

  // Override-only post-pass: handle overrides whose target workload either
  // (a) has no regex rule (currently "other"), or (b) didn't fire because no
  // other apps matched. We iterate every (app, type) combination because a
  // single app may belong to multiple workloads via the override array.
  const overrideGroups = new Map<WorkloadType, ProcessBasic[]>();
  for (const p of processes) {
    const ovList = overridesOf(p.name);
    if (!ovList || ovList.length === 0) continue;
    for (const ov of ovList) {
      if (ov === "none") continue;
      const t = ov as WorkloadType;
      // Skip if this app is already represented under this target workload by
      // the regex pass (avoid double-counting).
      const existing = results.find(r => r.type === t);
      if (existing && existing.matches.includes(p.name)) continue;
      if (!overrideGroups.has(t)) overrideGroups.set(t, []);
      overrideGroups.get(t)!.push(p);
    }
  }
  for (const [type, procs] of overrideGroups) {
    const defaults = OVERRIDE_PROFILE_DEFAULTS[type];
    if (!defaults) continue;
    const existing = results.find(r => r.type === type);
    let totalCpu = 0;
    let totalGpu = 0;
    let allBackground = true;
    const names: string[] = [];
    for (const p of procs) {
      names.push(p.name);
      totalCpu += p.cpuPercent;
      totalGpu += p.gpuPercent;
      if (!(isBackgroundApp?.(p.name) ?? false)) allBackground = false;
    }
    if (existing) {
      // Merge into existing rule-based match.
      for (const n of names) if (!existing.matches.includes(n)) existing.matches.push(n);
      existing.totalCpu += totalCpu;
      existing.totalGpu += totalGpu;
      existing.allBackground = existing.allBackground && allBackground;
      existing.hasStrong = true;
    } else {
      // Build a synthetic rule so the rest of the pipeline (fan profile,
      // suggestions) has something to work with.
      const syntheticRule: WorkloadRule = {
        type, label: defaults.label, icon: defaults.icon,
        fan: defaults.fan, fanDesc: defaults.fanDesc,
        strong: [], priority: defaults.priority,
      };
      results.push({
        type, matches: names, priority: defaults.priority, rule: syntheticRule,
        hasStrong: true, totalCpu, totalGpu, allBackground,
      });
    }
  }

  // GPU-driven fallback: any unmatched process with high sustained GPU usage
  // is almost certainly a game we don't have in the title list. This catches
  // titles like Spider-Man, lesser-known indies, modded launchers, etc.
  // Only fires when the process isn't already classified under another rule
  // (and isn't a known browser/system/background process), preventing
  // hardware-accelerated browsers / video calls from flipping into gaming.
  const KNOWN_NON_GAME_GPU = /^(chrome|msedge|firefox|brave|opera|opera_gx|vivaldi|arc|zen|safari|discord|slack|teams|ms-teams|skype|zoom|cefclient|electron|dwm|explorer|searchapp|searchhost|startmenuexperiencehost|shellexperiencehost|videolan|vlc|mpv|mpc-hc|mpc-be|mediaplayer|spotify|wmplayer|netflix|primevideo|hulu|disneyplus|youtube|figma|figma_agent|notion|obsidian|onenote|powerpoint|powerpnt|excel|winword|outlook|nvidia ?(broadcast|share|web ?helper|overlay|geforceexperience|nvcontainer|gfsdk)|nvcontainer|nvidiabroadcast|amd ?software|adrenaline|radeonsoftware|wallpaper32|wallpaper64|wallpaper ?engine|rainmeter|lockapp|searchindexer|searchprotocolhost|searchfilterhost|wmiprvse|svchost|csrss|winlogon|smss|services|lsass|fontdrvhost|conhost|wininit|registry|msmpeng|securityhealthservice|sihost|taskhostw|runtimebroker|applicationframehost|systemsettings|widgets|widgetservice|gamebar|gamebarftserver|gamebarpresencewriter|broadcastdvruserservice|xbox|xboxapp|xboxgamebar|xboxpcapp|xboxgameoverlay|gamingservices|gamesservicesnet|nahimic|nahimicservice|ai ?suite|armoury ?crate|armourycrate|asus|lenovo|hp|dell|msi|razer|corsair|logitech|logioptionsplus|ghub|icue|aurora|onextool|adobe ?(updater|cleaner|crashreporter|crashdaemon|cefhelper|content ?synchronizer|application ?(manager|updater)|gc invoker)|adobeipcbroker|creative ?cloud|ccxprocess|core ?sync|mscoresync|nodejs|node|python|python[0-9]+|pythonw|java|javaw|powershell|pwsh|powershell_ise|cmd|wt|windowsterminal|terminus|hyper|alacritty|wezterm|tabby|cmder)\.exe$/i;

  const matchedNames = new Set<string>();
  for (const r of results) {
    for (const n of r.matches) matchedNames.add(n.toLowerCase());
  }

  const gpuFallbackMatches: string[] = [];
  let gpuFallbackTotalCpu = 0;
  let gpuFallbackTotalGpu = 0;
  let gpuFallbackAllBackground = true;
  for (const p of processes) {
    const lower = p.name.toLowerCase();
    if (matchedNames.has(lower)) continue;
    if (KNOWN_NON_GAME_GPU.test(p.name)) continue;
    if (isBackgroundApp?.(p.name)) continue;
    // Per-process GPU >= 15% is a strong signal of a 3D / compute workload.
    // Most idle apps sit at 0; even most browsers stay below this when not
    // playing video. Real games sustain 30-100%.
    if (p.gpuPercent >= 15) {
      gpuFallbackMatches.push(p.name);
      gpuFallbackTotalCpu += p.cpuPercent;
      gpuFallbackTotalGpu += p.gpuPercent;
      gpuFallbackAllBackground = false;
    }
  }

  if (gpuFallbackMatches.length > 0) {
    const existing = results.find(r => r.type === "gaming");
    if (existing) {
      // Merge into the canonical gaming result so the chip lists every
      // matched exe (known + unknown) in one place.
      for (const n of gpuFallbackMatches) {
        if (!existing.matches.includes(n)) existing.matches.push(n);
      }
      existing.totalCpu += gpuFallbackTotalCpu;
      existing.totalGpu += gpuFallbackTotalGpu;
      existing.allBackground = existing.allBackground && gpuFallbackAllBackground;
      existing.hasStrong = true;
    } else {
      const gamingDefaults = OVERRIDE_PROFILE_DEFAULTS["gaming"];
      const syntheticRule: WorkloadRule = {
        type: "gaming",
        label: gamingDefaults.label,
        icon: gamingDefaults.icon,
        fan: gamingDefaults.fan,
        fanDesc: gamingDefaults.fanDesc,
        strong: [],
        priority: gamingDefaults.priority,
      };
      results.push({
        type: "gaming",
        matches: gpuFallbackMatches,
        priority: gamingDefaults.priority,
        rule: syntheticRule,
        hasStrong: true,
        totalCpu: gpuFallbackTotalCpu,
        totalGpu: gpuFallbackTotalGpu,
        allBackground: gpuFallbackAllBackground,
      });
    }
  }

  return results.sort((a, b) => b.priority - a.priority);
}

export function detectWorkload(
  processes: ProcessBasic[],
  isBackgroundApp?: (name: string) => boolean,
  appOverrides?: Record<string, string[]>,
): WorkloadProfile {
  const all = detectWorkloads(processes, isBackgroundApp, appOverrides);
  return all.length > 0
    ? all[0]
    : {
        type: "idle",
        label: "Idle",
        icon: "—",
        fanProfile: "silent",
        fanDescription: "Silent fan profile — system is mostly idle",
        matchedApps: [],
      };
}

export function detectWorkloads(
  processes: ProcessBasic[],
  isBackgroundApp?: (name: string) => boolean,
  appOverrides?: Record<string, string[]>,
): WorkloadProfile[] {
  const matched = matchWorkloadApps(processes, isBackgroundApp, appOverrides);

  if (matched.length === 0) {
    const totalCpu = processes.reduce((a, p) => a + p.cpuPercent, 0);
    if (totalCpu < 15) {
      return [
        {
          type: "idle",
          label: "Idle",
          icon: "—",
          fanProfile: "silent",
          fanDescription: "Silent fan profile — system is mostly idle",
          matchedApps: [],
        },
      ];
    }
    // I2 tie-breaker — no WORKLOAD_RULE matched but the machine is busy. A
    // non-helper process sustaining real GPU load is most likely a game the
    // regex list doesn't know yet; report that instead of "General Use".
    const guess = guessWorkload(processes, isHelperProcess);
    if (guess) {
      const gpuHeavy = processes.some((p) => p.gpuPercent > 50);
      return [
        {
          type: "gaming",
          label: "Gaming",
          icon: "▶",
          fanProfile: gpuHeavy ? "performance" : "balanced",
          fanDescription:
            "Detected from sustained GPU activity — no known game matched.",
          matchedApps: [],
        },
      ];
    }
    return [
      {
        type: "mixed",
        label: "General Use",
        icon: "■",
        fanProfile: "balanced",
        fanDescription: "Balanced cooling for mixed workload",
        matchedApps: [],
      },
    ];
  }

  // Deduplicate by type (first match wins — list is already priority sorted).
  const seen = new Set<WorkloadType>();
  const workloads: WorkloadProfile[] = [];

  // Upgrade gaming to turbo only if GPU is really being used.
  const gpuHeavy = processes.some(p => p.gpuPercent > 50);

  for (const m of matched) {
    if (seen.has(m.type)) continue;
    seen.add(m.type);

    let fan = m.rule.fan;
    let fanDesc = m.rule.fanDesc;
    if (m.type === "gaming" && gpuHeavy) {
      fan = "turbo";
      fanDesc = "Maximum cooling recommended for sustained gaming loads";
    } else if (m.type === "gaming" && !gpuHeavy) {
      // Launcher-only or menu idle — dial down the recommendation.
      fan = "balanced";
      fanDesc = "Game launcher detected — balanced cooling until you're in-game";
    }

    workloads.push({
      type: m.type,
      label: m.rule.label,
      icon: m.rule.icon,
      fanProfile: fan,
      fanDescription: fanDesc,
      matchedApps: m.matches,
    });
  }

  return workloads;
}

export function getWorkloadSuggestions(
  workload: WorkloadProfile,
  allProcesses: ProcessBasic[],
  isBackgroundApp?: (name: string) => boolean,
  appOverrides?: Record<string, string[]>,
): { close: string[]; reason: string }[] {
  const suggestions: { close: string[]; reason: string }[] = [];
  const matched = matchWorkloadApps(allProcesses, isBackgroundApp, appOverrides);

  if (workload.type === "gaming") {
    // Free resources for gaming — target browsers, communication, media, office.
    const closeable = matched.filter(
      m =>
        m.type === "browsing" ||
        m.type === "office" ||
        m.type === "streaming" ||
        m.type === "communication",
    );
    for (const c of closeable) {
      const memMb = allProcesses
        .filter(p => c.matches.includes(p.name))
        .reduce((a, p) => a + p.memoryMb, 0);
      if (memMb > 200) {
        suggestions.push({
          close: c.matches,
          reason: `Close ${c.rule.label.toLowerCase()} apps to free ~${(memMb / 1024).toFixed(1)} GB for gaming`,
        });
      }
    }
  } else if (workload.type === "editing") {
    const closeable = matched.filter(m => m.type === "browsing" || m.type === "gaming");
    for (const c of closeable) {
      const memMb = allProcesses
        .filter(p => c.matches.includes(p.name))
        .reduce((a, p) => a + p.memoryMb, 0);
      if (memMb > 300) {
        suggestions.push({
          close: c.matches,
          reason: `Close ${c.rule.label.toLowerCase()} apps to free ~${(memMb / 1024).toFixed(1)} GB for editing`,
        });
      }
    }
  } else if (workload.type === "browsing" || workload.type === "office") {
    // Game launcher running idle during a light workload
    const closeable = matched.filter(m => m.type === "gaming");
    for (const c of closeable) {
      const cpuPct = allProcesses
        .filter(p => c.matches.includes(p.name))
        .reduce((a, p) => a + p.cpuPercent, 0);
      if (cpuPct < 5) {
        suggestions.push({
          close: c.matches,
          reason: `Game launcher running idle — close to save resources`,
        });
      }
    }
  }

  return suggestions;
}

// --- Health Score ---
export function computeHealthScore(snapshot: PerformanceSnapshot, insights: Insight[]): number {
  let score = 100;

  // Memory pressure penalty
  const memUsed = snapshot.used_ram_bytes / snapshot.total_ram_bytes;
  if (memUsed > 0.90) score -= 20;
  else if (memUsed > 0.80) score -= 10;
  else if (memUsed > 0.70) score -= 5;

  // CPU penalty
  if (snapshot.cpu_usage_percent > 90) score -= 15;
  else if (snapshot.cpu_usage_percent > 70) score -= 8;
  else if (snapshot.cpu_usage_percent > 50) score -= 3;

  // Disk penalty
  if (snapshot.disk_active_percent > 90) score -= 10;
  else if (snapshot.disk_active_percent > 70) score -= 5;

  // GPU temp penalty
  if (snapshot.gpu_temperature > 90) score -= 10;
  else if (snapshot.gpu_temperature > 80) score -= 5;

  // Battery health penalty
  if (snapshot.battery_design_capacity_mwh > 0 && snapshot.battery_full_charge_capacity_mwh > 0) {
    const battHealth = snapshot.battery_full_charge_capacity_mwh / snapshot.battery_design_capacity_mwh;
    if (battHealth < 0.60) score -= 10;
    else if (battHealth < 0.80) score -= 5;
  }

  // Insight severity penalties
  for (const insight of insights) {
    if (insight.severity === "critical") score -= 8;
    else if (insight.severity === "warning") score -= 3;
  }

  return Math.max(0, Math.min(100, score));
}

import type { PerformanceSnapshot } from "./types";
import { WINDOWS_POWER_SETTINGS_URI } from "./ipc";

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
const SYSTEM_PROCESSES = new Set([
  "system", "system idle process", "registry", "smss.exe", "csrss.exe",
  "wininit.exe", "services.exe", "lsass.exe", "svchost.exe", "dwm.exe",
  "explorer.exe", "winlogon.exe", "fontdrvhost.exe", "spoolsv.exe",
  "taskmanagerplus", "taskmanagerplus.exe", "conhost.exe", "dllhost.exe",
  "sihost.exe", "taskhostw.exe", "runtimebroker.exe", "searchhost.exe",
  "startmenuexperiencehost.exe", "shellexperiencehost.exe",
  "textinputhost.exe", "widgetservice.exe", "ctfmon.exe",
]);

function isSystemProcess(name: string): boolean {
  return SYSTEM_PROCESSES.has(name.toLowerCase());
}

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

export function detectMemoryLeaks(
  processMemHistory: Map<string, number[]>,
  minSamples: number = 60
): Insight[] {
  const insights: Insight[] = [];
  for (const [name, values] of processMemHistory) {
    if (values.length < minSamples) continue;
    if (isSystemProcess(name)) continue;

    const { slope, r2 } = linearRegression(values);
    // slope is MB per sample (1 sample ≈ 1s), convert to MB per minute
    const slopePerMin = slope * 60;

    if (r2 > 0.75 && slopePerMin > 0.5) {
      const totalGrowth = values[values.length - 1] - values[0];
      const minutes = (values.length / 60).toFixed(1);
      insights.push({
        id: `mem-leak:${name}`,
        severity: totalGrowth > 500 ? "critical" : "warning",
        category: "memory",
        title: `Possible Memory Leak: ${name}`,
        description: `Memory has grown steadily by ${totalGrowth.toFixed(0)} MB over ${minutes} min (${slopePerMin.toFixed(1)} MB/min).`,
        metric: `+${totalGrowth.toFixed(0)} MB`,
        actions: [
          { label: "End Task", type: "end-task", processName: name },
          { label: "Dismiss", type: "dismiss" },
        ],
        timestamp: Date.now(),
      });
    }
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
      description: `System has committed ${(ratio * 100).toFixed(0)}% of the page file limit. This can cause out-of-memory errors.`,
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

export function detectResourceHogs(processes: ResourceHogProcess[]): Insight[] {
  const insights: Insight[] = [];
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
    if (proc.memoryMb > 2048 && proc.cpuPercent < 1) {
      insights.push({
        id: `hog-mem:${proc.name}`,
        severity: "info",
        category: "memory",
        title: `Idle Memory Hog: ${proc.name}`,
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

export type WorkloadType = "gaming" | "editing" | "browsing" | "development" | "streaming" | "office" | "idle" | "mixed";

export interface WorkloadProfile {
  type: WorkloadType;
  label: string;
  icon: string;
  fanProfile: "silent" | "balanced" | "performance" | "turbo";
  fanDescription: string;
  matchedApps: string[];
}

interface ProcessBasic {
  name: string;
  cpuPercent: number;
  memoryMb: number;
  gpuPercent: number;
}

const WORKLOAD_RULES: {
  type: WorkloadType;
  label: string;
  icon: string;
  fan: "silent" | "balanced" | "performance" | "turbo";
  fanDesc: string;
  patterns: RegExp[];
  priority: number;
}[] = [
  {
    type: "gaming",
    label: "Gaming",
    icon: "🎮",
    fan: "turbo",
    fanDesc: "Maximum cooling recommended for sustained gaming loads",
    patterns: [
      /^(steam|steamwebhelper|epicgameslauncher|origin|battle\.net|riot client|valorant|fortnite|csgo|cs2|minecraft|java|javaw|roblox|genshin|overwatch|apex_legends|baldur|elden|starfield|palworld|lethal company|helldivers|halo|destiny2|cyberpunk|witcher|fallout|skyrim|gta|nms|satisfactory|factorio|terraria|stardew|among ?us|dota2|leagueoflegends|league ?client|pubg|warzone|cod|battlefield|fifa|nba2k|rocket ?league|ark|rust|dayz|tarkov|deadlock)\.exe$/i,
      /unreal|unity|godot.*game/i,
    ],
    priority: 10,
  },
  {
    type: "editing",
    label: "Creative / Editing",
    icon: "🎬",
    fan: "performance",
    fanDesc: "Sustained cooling for render-heavy tasks",
    patterns: [
      /^(resolve|davinci|premiere|afterfx|after ?effects|photoshop|lightroom|illustrator|indesign|audition|animate|media ?encoder|handbrake|ffmpeg|obs|obs64|blender|cinema4d|maya|3dsmax|houdini|nuke|fusion|vegas|kdenlive|gimp|inkscape|krita|audacity|ableton|fl ?studio|cubase|reaper|logic|pro ?tools|capcut|filmora|hitfilm)\.exe$/i,
    ],
    priority: 9,
  },
  {
    type: "development",
    label: "Development",
    icon: "💻",
    fan: "balanced",
    fanDesc: "Balanced cooling — builds may spike, but mostly idle",
    patterns: [
      /^(code|code - insiders|devenv|idea64|pycharm64|webstorm64|clion64|rider64|android ?studio|xcode|eclipse|netbeans|sublime_text|atom|brackets|notepad\+\+|vim|nvim|emacs|terminal|wt|windowsterminal|powershell|pwsh|cmd|git|node|python|python3|ruby|cargo|rustc|go|java|javac|dotnet|msbuild|cl|gcc|g\+\+|cmake|make|npm|yarn|pnpm|docker|podman|kubectl|wsl)\.exe$/i,
    ],
    priority: 7,
  },
  {
    type: "streaming",
    label: "Streaming / Video",
    icon: "📺",
    fan: "balanced",
    fanDesc: "Balanced cooling for sustained video decode/encode",
    patterns: [
      /^(obs|obs64|streamlabs|twitch|xsplit|netflix|spotify|vlc|mpv|mpc-hc|plex|disney|hulu|amazon ?video|youtube|zoom|teams|discord|slack|skype|webex|googlemeet)\.exe$/i,
    ],
    priority: 6,
  },
  {
    type: "office",
    label: "Office / Productivity",
    icon: "📄",
    fan: "silent",
    fanDesc: "Silent fan profile — minimal cooling needed",
    patterns: [
      /^(winword|excel|powerpnt|onenote|outlook|thunderbird|notion|obsidian|evernote|todoist|trello|asana|monday|airtable|figma|canva|acrobat|foxitreader|libreoffice|calc|writer|impress)\.exe$/i,
    ],
    priority: 4,
  },
  {
    type: "browsing",
    label: "Web Browsing",
    icon: "🌐",
    fan: "silent",
    fanDesc: "Silent fan profile — browsing uses minimal resources",
    patterns: [
      /^(chrome|msedge|firefox|brave|opera|vivaldi|safari|arc|tor|waterfox|librewolf)\.exe$/i,
    ],
    priority: 3,
  },
];

function matchWorkloadApps(processNames: string[]): { type: WorkloadType; matches: string[]; priority: number; rule: typeof WORKLOAD_RULES[0] }[] {
  const results: { type: WorkloadType; matches: string[]; priority: number; rule: typeof WORKLOAD_RULES[0] }[] = [];

  for (const rule of WORKLOAD_RULES) {
    const matches: string[] = [];
    for (const name of processNames) {
      if (rule.patterns.some(p => p.test(name))) {
        matches.push(name);
      }
    }
    if (matches.length > 0) {
      results.push({ type: rule.type, matches, priority: rule.priority, rule });
    }
  }

  return results.sort((a, b) => b.priority - a.priority);
}

export function detectWorkload(processes: ProcessBasic[]): WorkloadProfile {
  const all = detectWorkloads(processes);
  return all.length > 0 ? all[0] : {
    type: "idle",
    label: "Idle",
    icon: "😴",
    fanProfile: "silent",
    fanDescription: "Silent fan profile — system is mostly idle",
    matchedApps: [],
  };
}

export function detectWorkloads(processes: ProcessBasic[]): WorkloadProfile[] {
  const names = processes.map(p => p.name);
  const matched = matchWorkloadApps(names);

  if (matched.length === 0) {
    const totalCpu = processes.reduce((a, p) => a + p.cpuPercent, 0);
    if (totalCpu < 15) {
      return [{
        type: "idle",
        label: "Idle",
        icon: "😴",
        fanProfile: "silent",
        fanDescription: "Silent fan profile — system is mostly idle",
        matchedApps: [],
      }];
    }
    return [{
      type: "mixed",
      label: "General Use",
      icon: "🖥",
      fanProfile: "balanced",
      fanDescription: "Balanced cooling for mixed workload",
      matchedApps: [],
    }];
  }

  // Build all detected workloads (deduplicated by type)
  const seen = new Set<WorkloadType>();
  const workloads: WorkloadProfile[] = [];

  // If gaming + high GPU, boost priority
  const gpuHeavy = processes.some(p => p.gpuPercent > 50);

  for (const m of matched) {
    if (seen.has(m.type)) continue;
    seen.add(m.type);

    let fan = m.rule.fan;
    let fanDesc = m.rule.fanDesc;
    if (m.type === "gaming" && gpuHeavy) {
      fan = "turbo";
      fanDesc = "Maximum cooling recommended for sustained gaming loads";
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
  allProcesses: ProcessBasic[]
): { close: string[]; reason: string }[] {
  const suggestions: { close: string[]; reason: string }[] = [];
  const names = allProcesses.map(p => p.name);
  const matched = matchWorkloadApps(names);

  if (workload.type === "gaming") {
    // Suggest closing browsers, office, streaming apps
    const closeable = matched.filter(m =>
      m.type === "browsing" || m.type === "office" || m.type === "streaming"
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
    // If gaming processes are open but user is just browsing
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

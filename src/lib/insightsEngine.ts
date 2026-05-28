/**
 * Global Insights Engine — runs continuously regardless of which tab is active.
 * Components subscribe via useInsights() hook.
 */
import { useState, useEffect } from "react";
import type { PerformanceSnapshot } from "./types";
import type { ProcessInfo, ProcessPowerInfo } from "./types";
import { getSettings } from "./settings";
import {
  type Insight,
  detectMemoryLeaks,
  detectCommitPressure,
  detectLowMemory,
  detectCpuBottleneck,
  detectDiskBottleneck,
  detectNetworkSaturation,
  detectGpuOverheat,
  detectBatteryHealth,
  detectHighPowerDrain,
  detectOffHoursDrain,
  detectOffRoutineActivity,
  detectLowBatterySettingsHint,
  detectResourceHogs,
  detectHandleThreadLeak,
  detectHighProcessCount,
  computeHealthScore,
  detectWorkloads,
  getWorkloadSuggestions,
  pickMainWorkloadProfile,
  isSystemProcessName,
  isHelperProcess,
  workloadProfileForType,
  type WorkloadProfile,
  type WorkloadType,
} from "./insights";
import {
  feedAppUsage,
  isBackgroundApp,
  getFrequentApps,
  type FrequentApp,
} from "./appUsage";
import { tryClassifyLeak, tryClassifyWorkload } from "./ai/tierGate";
import { tierEnablesEmbeddings } from "./ai/types";
import {
  feedUsagePattern,
  getSchedulePatterns,
  getHourGrid,
  classifyCurrentHour,
  type SchedulePatterns,
  type HourCell,
} from "./usagePattern";
import { handleInsightTick } from "./insightNotifier";
import { getMainTrayHidden, subscribeMainTrayHidden } from "./mainTrayBackground";

const MAX_HISTORY = 120;
// Hard cap on the per-process memory history map. Once exceeded, smallest entries are dropped.
const MAX_PROCESS_HISTORY_KEYS = 200;

// --- Global State ---
let snapshotHistory: PerformanceSnapshot[] = [];
let processMemHistory = new Map<string, number[]>();
let handleHistory: { handles: number; threads: number }[] = [];
let lastGenerationSeen = -1;

let currentInsights: Insight[] = [];
let currentHealthScore = 100;
let currentWorkloads: WorkloadProfile[] = [];
let currentWorkloadSuggestions: ReturnType<typeof getWorkloadSuggestions> = [];
let currentMainWorkload: { profile: WorkloadProfile | null; pinned: boolean } = { profile: null, pinned: false };
// P6 — semantic workload classification (tie-breaker). When the rule-based
// detector finds no concrete workload but unknown apps are busy, we embed
// their window titles to guess a category. Cached by the candidate-set key
// so the embedding model is queried at most once per distinct set of unknown
// apps, not every tick.
let aiWorkload: { key: string; profile: WorkloadProfile | null } = { key: "", profile: null };
let aiWorkloadInFlight = false;
/**
 * Per-process aggregate (cpu + mem + workload assignment) for the current
 * tick. Surfaced via useInsights() so the InsightsPage workload chips can
 * show app rows with metrics, and so the "focus on main workload" modal can
 * compute which apps would be ended and how many resources they free up.
 */
export interface RunningAppRow {
  name: string;
  /** Friendly name (PE FileDescription, e.g. "Visual Studio Code") for UI
   *  display and for collapsing an app's helper processes into one row.
   *  Falls back to a prettified exe name when no version info exists. */
  displayName: string;
  cpuPercent: number;
  memoryMb: number;
  /** WorkloadType the app is currently classified under, or null if unclassified. */
  workload: string | null;
  isBackground: boolean;
}
let currentRunningApps: RunningAppRow[] = [];
let currentFrequentApps: FrequentApp[] = [];
let currentSchedulePatterns: SchedulePatterns = {
  charging: [],
  active: [],
  totalObservedSeconds: 0,
  ready: false,
};
let currentHourGrid: HourCell[][] = [];
let currentSnapshotCount = 0;
let dismissed = new Set<string>();
let calibrated = false;

type Listener = () => void;
const listeners = new Set<Listener>();

function notify() {
  listeners.forEach(fn => fn());
}

// --- Feed data into the engine (called from App-level component) ---
export function feedSnapshot(
  snapshot: PerformanceSnapshot,
  generation: number,
  processes: ProcessInfo[] | undefined,
  _powerData: ProcessPowerInfo[] | undefined,
  _topPower: { name: string; value: number }[],
) {
  if (generation === lastGenerationSeen) return;
  lastGenerationSeen = generation;

  // System snapshot history
  snapshotHistory.push(snapshot);
  if (snapshotHistory.length > MAX_HISTORY) snapshotHistory.shift();
  currentSnapshotCount = snapshotHistory.length;

  // Handle/thread history
  handleHistory.push({ handles: snapshot.handle_count, threads: snapshot.thread_total_count });
  if (handleHistory.length > MAX_HISTORY) handleHistory.shift();

  // Frequent-app usage tracker — feed with every new snapshot.
  // Wrapped defensively so a tracker bug can never stall the insights engine
  // (which would otherwise leave `calibrated` stuck at false and the UI
  //  permanently showing "Calibrating...").
  try {
    feedAppUsage(processes);
  } catch (e) {
    console.error("[insightsEngine] feedAppUsage failed:", e);
  }

  // Schedule / routine tracker — same defensive wrapping. Pass the dominant
  // workload type from the *previous* analysis tick (this tick's workloads
  // get computed further down). Hour-level aggregation makes the 1-tick
  // lag invisible.
  try {
    const dominantWorkload = currentWorkloads.length > 0 ? currentWorkloads[0].type : undefined;
    feedUsagePattern(snapshot, dominantWorkload);
  } catch (e) {
    console.error("[insightsEngine] feedUsagePattern failed:", e);
  }

  // Per-process memory history
  if (processes) {
    const grouped = new Map<string, number>();
    for (const p of processes) {
      const name = p.display_name || p.name;
      grouped.set(name, (grouped.get(name) || 0) + p.working_set_mb);
    }
    for (const [name, mb] of grouped) {
      if (!processMemHistory.has(name)) processMemHistory.set(name, []);
      const arr = processMemHistory.get(name)!;
      arr.push(mb);
      if (arr.length > MAX_HISTORY) arr.shift();
    }
    for (const [name, arr] of processMemHistory) {
      if (!grouped.has(name)) {
        if (arr.length > 0 && arr[arr.length - 1] === 0) {
          processMemHistory.delete(name);
        } else {
          arr.push(0);
          let zeroCount = 0;
          for (const v of arr) if (v === 0) zeroCount++;
          if (zeroCount > 10) processMemHistory.delete(name);
        }
      }
    }

    // Hard cap: drop entries with the smallest peak memory if the map grows too large.
    if (processMemHistory.size > MAX_PROCESS_HISTORY_KEYS) {
      const peaks: { name: string; peak: number }[] = [];
      for (const [name, arr] of processMemHistory) {
        let peak = 0;
        for (const v of arr) if (v > peak) peak = v;
        peaks.push({ name, peak });
      }
      peaks.sort((a, b) => a.peak - b.peak);
      const toRemove = processMemHistory.size - MAX_PROCESS_HISTORY_KEYS;
      for (let i = 0; i < toRemove; i++) processMemHistory.delete(peaks[i].name);
    }
  }
}

// --- Analysis interval (runs every 5s) ---
let analysisInterval: ReturnType<typeof setInterval> | null = null;
/**
 * When the main window is hidden to the tray we skip the heavy block of
 * `runAnalysis` (full workload detection, AI tie-breaker, running-apps
 * roster, schedule heatmap) for most ticks. The light path still runs every
 * 5s — it preserves notifications, schedule learning, and a cheap workload
 * "fingerprint" for hour-attribution accuracy. This cadence is how often we
 * still let the heavy block fire while hidden, so when the user restores
 * the window the workload chips/heatmap are at most this many ms stale.
 */
const TRAY_HEAVY_INTERVAL_MS = 30_000;
let lastHeavyRunAt = 0;

/**
 * Cheap "mini workload" pass used by the light path. Reuses the SAME
 * detector + override logic as the heavy block so hour-attribution stays
 * coherent — just skips building the running-apps roster, AI tie-breaker,
 * suggestions, and the rest. Returns the top workload type (e.g. "gaming",
 * "development") or `undefined` if nothing fired, plus the matched-app set
 * for the resource-hog exempt list.
 */
function miniDetectWorkload(): {
  type: string | undefined;
  exempt: Set<string>;
} {
  if (!cachedProcesses || !cachedPowerData) return { type: undefined, exempt: new Set() };
  try {
    const settings = getSettings();
    const procByPid = new Map<number, ProcessInfo>();
    for (const p of cachedProcesses) procByPid.set(p.pid, p);

    const grouped = new Map<string, { cpu: number; mem: number }>();
    const metadataByName = new Map<string, string>();
    for (const p of cachedProcesses) {
      const existing = grouped.get(p.name) || { cpu: 0, mem: 0 };
      existing.mem += p.working_set_mb;
      grouped.set(p.name, existing);
      if (!metadataByName.has(p.name)) {
        const haystack = [p.display_name, p.product_name]
          .filter(Boolean).join(" ").toLowerCase();
        if (haystack) metadataByName.set(p.name, haystack);
      }
    }
    for (const pw of cachedPowerData) {
      const proc = procByPid.get(pw.pid);
      if (proc) {
        const existing = grouped.get(proc.name) || { cpu: 0, mem: 0 };
        existing.cpu += pw.cpu_percent;
        grouped.set(proc.name, existing);
      }
    }
    const basic = [...grouped.entries()].map(([name, v]) => ({
      name,
      cpuPercent: v.cpu,
      memoryMb: v.mem,
      gpuPercent: 0,
      metadata: metadataByName.get(name),
    }));

    // GPU hint mirrors the heavy block exactly so workload classification matches.
    const snap = snapshotHistory[snapshotHistory.length - 1];
    if (snap && snap.gpu_usage_percent > 30) {
      const sorted = [...basic].sort((a, b) => b.memoryMb - a.memoryMb);
      if (sorted.length > 0) {
        const top = basic.find(p => p.name === sorted[0].name);
        if (top) top.gpuPercent = snap.gpu_usage_percent;
      }
    }

    const overrides = settings.appCategoryOverrides ?? {};
    const workloads = detectWorkloads(basic, isBackgroundApp, overrides);
    const main = pickMainWorkloadProfile(workloads, settings.mainWorkloadType ?? "");
    const exempt = new Set<string>();
    if (main.profile) {
      for (const n of main.profile.matchedApps) exempt.add(n.toLowerCase());
    }
    return { type: workloads[0]?.type, exempt };
  } catch (e) {
    console.error("[insightsEngine] miniDetectWorkload failed:", e);
    return { type: undefined, exempt: new Set() };
  }
}

function runAnalysis() {
  if (snapshotHistory.length === 0) return;
  const snapshot = snapshotHistory[snapshotHistory.length - 1];
  const settings = getSettings();

  // Tray-aware split: the heavy workload+hogs+AI block costs us hundreds of
  // ms across a few hundred processes. When the window is hidden, run it on
  // a slower cadence — the chips, running-apps roster, and heatmap are UI
  // surfaces nobody is looking at right now. Notifications and schedule
  // learning stay on the every-5s light path. The mini workload step below
  // keeps hour-attribution coherent even on skipped ticks.
  const trayHidden = getMainTrayHidden();
  const now = Date.now();
  const runHeavy = !trayHidden || (now - lastHeavyRunAt) >= TRAY_HEAVY_INTERVAL_MS;
  if (runHeavy) lastHeavyRunAt = now;

  // Flip the "calibrated" flag as early as possible. The UI shows
  // "Calibrating..." in several places when this is false, so any throw later
  // in runAnalysis would otherwise pin the UI in that state forever. Doing it
  // up front means even partial analysis still releases the UI from the
  // calibrating gate.
  if (snapshotHistory.length >= 5) calibrated = true;

  const newInsights: Insight[] = [];

  // Memory
  newInsights.push(...detectMemoryLeaks(processMemHistory));
  const commitInsight = detectCommitPressure(snapshot);
  if (commitInsight) newInsights.push(commitInsight);
  const lowMemInsight = detectLowMemory(snapshot);
  if (lowMemInsight) newInsights.push(lowMemInsight);

  // CPU
  const cpuInsight = detectCpuBottleneck(snapshotHistory);
  if (cpuInsight) newInsights.push(cpuInsight);

  // Disk
  const diskInsight = detectDiskBottleneck(snapshotHistory);
  if (diskInsight) newInsights.push(diskInsight);

  // Network
  const netInsight = detectNetworkSaturation(snapshotHistory);
  if (netInsight) newInsights.push(netInsight);

  // GPU
  const gpuInsight = detectGpuOverheat(snapshot, settings.temperatureUnit);
  if (gpuInsight) newInsights.push(gpuInsight);

  // Battery
  const battInsight = detectBatteryHealth(snapshot);
  if (battInsight) newInsights.push(battInsight);

  const lowBattInsight = detectLowBatterySettingsHint(snapshot);
  if (lowBattInsight) newInsights.push(lowBattInsight);

  // Power drain (use cached topPower from last feed)
  if (cachedTopPower.length > 0) {
    const powerInsight = detectHighPowerDrain(snapshot, cachedTopPower, snapshotHistory);
    if (powerInsight) newInsights.push(powerInsight);
  }

  // Routine-driven cards. Cheap; classifyCurrentHour is just a couple of
  // bucket lookups against the persisted usage pattern. Returns "unknown"
  // until the current hour-of-week slot has accumulated enough observation,
  // at which point both detectors short-circuit and emit nothing.
  const routineState = classifyCurrentHour();
  if (cachedTopPower.length > 0) {
    const offHoursInsight = detectOffHoursDrain(snapshot, cachedTopPower, routineState, snapshotHistory);
    if (offHoursInsight) newInsights.push(offHoursInsight);
  }
  const offRoutineInsight = detectOffRoutineActivity(snapshot, routineState);
  if (offRoutineInsight) newInsights.push(offRoutineInsight);

  // Resource hogs + main-workload pick. The main workload (auto or
  // user-pinned by TYPE) supplies an exempt-set of process names that won't
  // be flagged as "high memory while idle", since foreground apps frequently
  // sit at 0% CPU between user input.
  //
  // Order matters: workload detection runs FIRST so we know which apps fall
  // under each workload, THEN we pick the main workload, THEN we use that
  // workload's matched-app list as the exempt set for resource-hog detection.
  // (Workload detection's separate try/catch block below covers the chips
  // shown in the UI, but we also run it inline here so the exempt set stays
  // in sync with the picker on the same tick.)
  //
  // Light path (tray-hidden): we still need an exempt set for the resource-
  // hog detector, otherwise foreground apps idling at 0% CPU would spam
  // false-positive notifications. `miniDetectWorkload` reuses the same
  // detector + override logic so the exempt set matches what the heavy
  // path would produce, just without the surrounding bookkeeping.
  if (!runHeavy && cachedProcesses && cachedPowerData) {
    const mini = miniDetectWorkload();
    // Keep currentWorkloads in sync with the light pass so feedSnapshot's
    // hour-attribution sees today's workload type, not yesterday's stale one.
    if (mini.type) {
      const current = currentWorkloads[0]?.type;
      if (current !== mini.type) {
        // Synthesize a placeholder workload for hour-bucket feeding only —
        // the UI doesn't render off this tick. The next heavy pass
        // (≤30s away on tray-hidden, or instantly on window restore)
        // rebuilds the proper chip with matchedApps.
        const profile = workloadProfileForType(
          mini.type as WorkloadType,
          [...mini.exempt],
        );
        currentWorkloads = [profile];
      }
    }
    const hogProcs: { name: string; cpuPercent: number; memoryMb: number }[] = [];
    const grouped = new Map<string, { cpu: number; mem: number }>();
    const procByPid = new Map<number, ProcessInfo>();
    for (const p of cachedProcesses) procByPid.set(p.pid, p);
    for (const p of cachedProcesses) {
      const ex = grouped.get(p.name) || { cpu: 0, mem: 0 };
      ex.mem += p.working_set_mb;
      grouped.set(p.name, ex);
    }
    for (const pw of cachedPowerData) {
      const proc = procByPid.get(pw.pid);
      if (proc) {
        const ex = grouped.get(proc.name) || { cpu: 0, mem: 0 };
        ex.cpu += pw.cpu_percent;
        grouped.set(proc.name, ex);
      }
    }
    for (const [name, v] of grouped) hogProcs.push({ name, cpuPercent: v.cpu, memoryMb: v.mem });
    newInsights.push(...detectResourceHogs(hogProcs, mini.exempt));
  }

  if (runHeavy && cachedProcesses && cachedPowerData) {
    // Wrap the whole workload+hogs block: if anything in here throws, we still
    // want the rest of runAnalysis (and notify) to complete. Without this,
    // a single bad code path could leave currentWorkloads stuck empty and the
    // UI stuck on "Calibrating..." for the lifetime of the session.
    try {
    // Build a pid->process lookup once per analysis tick so the power-data
    // merge is O(n+m) instead of O(n*m). With hundreds of processes and
    // hundreds of power entries, the prior Array.find-per-entry could chew
    // tens of thousands of comparisons on the main thread every 5s.
    const procByPid = new Map<number, ProcessInfo>();
    for (const p of cachedProcesses) procByPid.set(p.pid, p);

    // We aggregate by raw exe name (e.g. "chrome.exe") because the workload
    // detector's regex rules match on executable names, and the workload
    // profile's `matchedApps` contains those same raw names. If we keyed by
    // display_name here, the running-apps roster and the workload chip
    // matchedApps would use different names — the chip's expanded app panel
    // would silently come up empty because the lookup wouldn't join.
    const grouped = new Map<string, { cpu: number; mem: number }>();
    // exe name -> lowercased metadata haystack for the workload detector's
    // keyword matching (Option B). Built from the PE FileDescription
    // (`display_name`) and ProductName only — CompanyName and the install
    // path are deliberately excluded: a company name matches every app and
    // helper from that vendor, far too broad a signal. All instances of one
    // exe share an image, hence the same metadata; first non-empty wins.
    const metadataByName = new Map<string, string>();
    // exe name -> friendly display name (PE FileDescription). Used by the UI
    // to show elegant names and to collapse an app's helper processes.
    const displayNameByName = new Map<string, string>();
    for (const p of cachedProcesses) {
      const existing = grouped.get(p.name) || { cpu: 0, mem: 0 };
      existing.mem += p.working_set_mb;
      grouped.set(p.name, existing);
      if (!metadataByName.has(p.name)) {
        const haystack = [p.display_name, p.product_name]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (haystack) metadataByName.set(p.name, haystack);
      }
      if (p.display_name && !displayNameByName.has(p.name)) {
        displayNameByName.set(p.name, p.display_name);
      }
    }
    for (const pw of cachedPowerData) {
      const proc = procByPid.get(pw.pid);
      if (proc) {
        const existing = grouped.get(proc.name) || { cpu: 0, mem: 0 };
        existing.cpu += pw.cpu_percent;
        grouped.set(proc.name, existing);
      }
    }
    const hogProcs = [...grouped.entries()].map(([name, v]) => ({
      name, cpuPercent: v.cpu, memoryMb: v.mem,
    }));

    const basicForPick = hogProcs.map(p => ({
      name: p.name,
      cpuPercent: p.cpuPercent,
      memoryMb: p.memoryMb,
      gpuPercent: 0,
      metadata: metadataByName.get(p.name),
    }));

    // GPU-heavy hint for the workload detector: when the system GPU is
    // clearly being used, attribute that load to the top-memory process so
    // gaming/editing rules can fire. We don't have per-process GPU readings,
    // so this is a heuristic — but it's the same one the downstream
    // workload-detection block previously used.
    if (snapshot.gpu_usage_percent > 30) {
      const sorted = [...basicForPick].sort((a, b) => b.memoryMb - a.memoryMb);
      if (sorted.length > 0) {
        const top = basicForPick.find(p => p.name === sorted[0].name);
        if (top) top.gpuPercent = snapshot.gpu_usage_percent;
      }
    }

    // Detect workloads (with overrides) once. The result drives:
    //   1. main-workload pick + exempt set for resource-hog detection
    //   2. the workload chips + per-app overrides UI
    //   3. workload suggestions ("close X to free Y for gaming")
    const overrides = settings.appCategoryOverrides ?? {};
    let inlineWorkloads: WorkloadProfile[] = [];
    try {
      inlineWorkloads = detectWorkloads(basicForPick, isBackgroundApp, overrides);
    } catch (e) {
      console.error("[insightsEngine] inline detectWorkloads failed:", e);
    }
    currentWorkloads = inlineWorkloads;
    try {
      currentWorkloadSuggestions = inlineWorkloads.length > 0
        ? getWorkloadSuggestions(inlineWorkloads[0], basicForPick, isBackgroundApp, overrides)
        : [];
    } catch (e) {
      console.error("[insightsEngine] getWorkloadSuggestions failed:", e);
      currentWorkloadSuggestions = [];
    }

    currentMainWorkload = pickMainWorkloadProfile(
      inlineWorkloads,
      settings.mainWorkloadType ?? "",
    );

    // Build the exempt set from main workload's matched apps (lowercased).
    const exemptSet = new Set<string>();
    if (currentMainWorkload.profile) {
      for (const n of currentMainWorkload.profile.matchedApps) {
        exemptSet.add(n.toLowerCase());
      }
    }

    // Build the running-apps roster surfaced to the UI. We drop system
    // services so the chip-app list and the workload picker only show things
    // a user would recognize. Each row carries the workload it's classified
    // under (if any) so the UI can group apps by workload chip and expose
    // the recategorize dropdown.
    //
    // Resource threshold: we filter to apps with >50 MB or >0.5% CPU so the
    // dropdown isn't a wall of trivial entries — BUT every workload-matched
    // app is kept regardless, so clicking a chip always shows its apps even
    // when they're idle (e.g. a game launcher in the tray, a chat client at
    // 0% CPU). Without this exemption, matched background apps would
    // silently disappear from the expanded panel.
    const nameToWorkload = new Map<string, string>();
    for (const w of inlineWorkloads) {
      for (const n of w.matchedApps) {
        // First match wins (workloads are priority sorted); never overwrite.
        if (!nameToWorkload.has(n.toLowerCase())) {
          nameToWorkload.set(n.toLowerCase(), w.type);
        }
      }
    }
    currentRunningApps = basicForPick
      .filter(p => !isSystemProcessName(p.name))
      .filter(p => {
        const isMatched = nameToWorkload.has(p.name.toLowerCase());
        return isMatched || p.memoryMb > 50 || p.cpuPercent > 0.5;
      })
      .sort((a, b) => (b.cpuPercent + b.memoryMb / 500) - (a.cpuPercent + a.memoryMb / 500))
      .slice(0, 80)
      .map(p => ({
        name: p.name,
        displayName: displayNameByName.get(p.name) ?? "",
        cpuPercent: p.cpuPercent,
        memoryMb: p.memoryMb,
        workload: nameToWorkload.get(p.name.toLowerCase()) ?? null,
        isBackground: isBackgroundApp(p.name),
      }));

    newInsights.push(...detectResourceHogs(hogProcs, exemptSet));

    // P6 — semantic workload tie-breaker. Fires ONLY when the rule-based
    // detector produced no concrete workload ("General Use"/idle) and the AI
    // tier enables embeddings. We read the window titles of busy, foreground,
    // unknown apps and ask the embedding model what kind of work they are —
    // catching the long tail the regex rules miss (a niche IDE, an indie
    // game, a specialist tool). Throttled by a candidate-set key so the model
    // is queried at most once per distinct set of unknown apps.
    try {
      const dominant = inlineWorkloads[0]?.type;
      const inconclusive = !dominant || dominant === "mixed" || dominant === "idle";
      if (inconclusive && tierEnablesEmbeddings(settings.aiTier)) {
        const metricsByName = new Map(hogProcs.map(h => [h.name, h] as const));
        const candidates = cachedProcesses
          .filter(p => (p.window_title ?? "").trim().length > 0)
          .filter(p => !nameToWorkload.has(p.name.toLowerCase()))
          .filter(p => !isSystemProcessName(p.name) && !isHelperProcess(p.name))
          .filter(p => !isBackgroundApp(p.name))
          .map(p => ({
            p,
            cpu: metricsByName.get(p.name)?.cpuPercent ?? 0,
            mem: metricsByName.get(p.name)?.memoryMb ?? 0,
          }))
          .filter(c => c.cpu > 1 || c.mem > 150)
          .sort((a, b) => (b.cpu + b.mem / 500) - (a.cpu + a.mem / 500))
          .slice(0, 5);

        const key = candidates.map(c => c.p.name.toLowerCase()).sort().join("|");
        const applyChip = (profile: WorkloadProfile) => {
          currentWorkloads = [
            profile,
            ...currentWorkloads.filter(w => w.type !== "mixed" && w.type !== "idle"),
          ];
        };

        if (key && key === aiWorkload.key) {
          // Cached result for this exact candidate set — apply immediately.
          if (aiWorkload.profile) applyChip(aiWorkload.profile);
        } else if (key && !aiWorkloadInFlight) {
          aiWorkloadInFlight = true;
          const reqKey = key;
          const titles = candidates.map(c => `${c.p.window_title} — ${c.p.display_name || c.p.name}`);
          const names = candidates.map(c => c.p.name);
          tryClassifyWorkload(titles)
            .then(category => {
              aiWorkloadInFlight = false;
              if (category) {
                const profile = workloadProfileForType(category as WorkloadType, names);
                aiWorkload = { key: reqKey, profile };
                // Apply at once if the system is still inconclusive, so the
                // chip appears without waiting for the next snapshot tick.
                const d = currentWorkloads[0]?.type;
                if (!d || d === "mixed" || d === "idle") {
                  applyChip(profile);
                  notify();
                }
              } else {
                aiWorkload = { key: reqKey, profile: null };
              }
            })
            .catch(() => { aiWorkloadInFlight = false; });
        }
      }
    } catch (e) {
      console.error("[insightsEngine] P6 workload classification failed:", e);
    }
    } catch (e) {
      console.error("[insightsEngine] workload+hogs block failed:", e);
    }
  }

  // Handle leak
  const handleInsight = detectHandleThreadLeak(handleHistory);
  if (handleInsight) newInsights.push(handleInsight);

  // Process count
  const procCountInsight = detectHighProcessCount(snapshot);
  if (procCountInsight) newInsights.push(procCountInsight);

  // (Workload detection now happens inline above with the resource-hogs
  // aggregation, so the chips, exempt set, and runningApps roster all share
  // a single source of truth — no name-mismatch risk between the two.)

  // Refresh frequent apps list (cheap — just Object.values + sort)
  try {
    currentFrequentApps = getFrequentApps(8);
  } catch (e) {
    console.error("[insightsEngine] getFrequentApps failed:", e);
    currentFrequentApps = [];
  }

  // Refresh schedule patterns + heatmap grid. Both are derived purely from
  // the in-memory bucket store so they're cheap (linear scan over 168 cells).
  try {
    currentSchedulePatterns = getSchedulePatterns();
    currentHourGrid = getHourGrid();
  } catch (e) {
    console.error("[insightsEngine] getSchedulePatterns failed:", e);
    currentSchedulePatterns = { charging: [], active: [], totalObservedSeconds: 0, ready: false };
    currentHourGrid = [];
  }

  // Sort
  const severityOrder = { critical: 0, warning: 1, info: 2 };
  newInsights.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  currentInsights = newInsights;
  currentHealthScore = computeHealthScore(snapshot, newInsights);

  notify();

  // Fire desktop notifications for new critical/warning insights. Wrapped
  // defensively — plugin errors must not stall the engine. Only run once
  // calibrated so we don't spam notifications during startup.
  if (calibrated) {
    handleInsightTick(currentInsights).catch(e => {
      console.warn("[insightsEngine] handleInsightTick failed:", e);
    });
  }

  // I1 — refine leak insights with the bundled leak classifier. Runs as an
  // async post-pass: the rules-based insights above are already published;
  // if the classifier reclassifies a flagged "leak" as benign growth
  // (cache warmup / startup spike) this drops it and re-publishes. Off-tier
  // users get a no-op (tryClassifyLeak returns null). Fire-and-forget.
  void refineLeakInsights();
}

/**
 * I1 leak-classifier post-pass. For every `mem-leak:` insight the rules
 * raised this tick, ask the bundled classifier whether the growth is
 * actually a leak. If it confidently says "cache-warmup" or
 * "startup-spike", the leak insight was a false positive — drop it.
 *
 * Async + AI-tier-gated: when the AI tier is Off, `tryClassifyLeak`
 * returns null and nothing changes. A staleness guard (array-identity
 * check) discards the result if a newer analysis tick has run meanwhile.
 */
async function refineLeakInsights(): Promise<void> {
  const baseline = currentInsights; // capture identity for the staleness guard
  const leakIds = baseline
    .filter(i => i.id.startsWith("mem-leak:"))
    .map(i => i.id);
  if (leakIds.length === 0) return;

  const toSuppress = new Set<string>();
  for (const id of leakIds) {
    const name = id.slice("mem-leak:".length);
    const series = processMemHistory.get(name);
    if (!series || series.length < 30) continue;
    let verdict;
    try {
      verdict = await tryClassifyLeak(series);
    } catch {
      continue; // classifier error must never break insight publishing
    }
    if (verdict && (verdict.class === "cache-warmup" || verdict.class === "startup-spike")) {
      toSuppress.add(id);
    }
  }

  // Discard if a newer analysis tick replaced the insight set while we awaited.
  if (currentInsights !== baseline || toSuppress.size === 0) return;

  currentInsights = baseline.filter(i => !toSuppress.has(i.id));
  const snap = snapshotHistory[snapshotHistory.length - 1];
  if (snap) currentHealthScore = computeHealthScore(snap, currentInsights);
  notify();
}

/**
 * Dev helper for collecting real validation data for the I1 leak
 * classifier. Returns a snapshot of the per-process memory history
 * (exe display name -> MB samples). Also exposed on `window` below so it
 * can be called from the DevTools console without a rebuild.
 */
export function dumpMemoryHistory(): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [name, arr] of processMemHistory) out[name] = [...arr];
  return out;
}

if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__tmplusDumpMemHistory =
    dumpMemoryHistory;
}

// Cache for processes/power data (updated via feedSnapshot wrapper)
let cachedProcesses: ProcessInfo[] | undefined;
let cachedPowerData: ProcessPowerInfo[] | undefined;
let cachedTopPower: { name: string; value: number }[] = [];

export function feedData(
  snapshot: PerformanceSnapshot,
  generation: number,
  processes: ProcessInfo[] | undefined,
  powerData: ProcessPowerInfo[] | undefined,
  topPower: { name: string; value: number }[],
) {
  cachedProcesses = processes;
  cachedPowerData = powerData;
  cachedTopPower = topPower;
  feedSnapshot(snapshot, generation, processes, powerData, topPower);
}

/**
 * When the main window comes back from the tray, force the next analysis to
 * run a heavy pass even if the throttled cadence hasn't elapsed yet. Without
 * this, the user would briefly see stale chips/heatmap (up to
 * `TRAY_HEAVY_INTERVAL_MS` old) right after restoring — exactly the moment
 * they care most about freshness.
 */
let trayUnsub: (() => void) | null = null;

export function startEngine() {
  if (analysisInterval) return;
  analysisInterval = setInterval(runAnalysis, 5000);
  // Run immediately too
  setTimeout(runAnalysis, 1000);
  if (!trayUnsub) {
    trayUnsub = subscribeMainTrayHidden(() => {
      if (!getMainTrayHidden()) {
        // Force the next tick to run the heavy pass.
        lastHeavyRunAt = 0;
        // Don't wait the full 5s — refresh chips/heatmap promptly.
        setTimeout(runAnalysis, 50);
      }
    });
  }
}

export function dismissInsight(id: string) {
  dismissed = new Set(dismissed).add(id);
  notify();
}

// --- React hook to subscribe ---
export function useInsights() {
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    const handler = () => forceUpdate(n => n + 1);
    listeners.add(handler);
    return () => { listeners.delete(handler); };
  }, []);

  const visibleInsights = currentInsights.filter(i => !dismissed.has(i.id));

  return {
    insights: visibleInsights,
    allInsights: currentInsights,
    healthScore: currentHealthScore,
    dismissInsight,
    snapshotCount: currentSnapshotCount,
    calibrated,
    workloads: currentWorkloads,
    workloadSuggestions: currentWorkloadSuggestions,
    frequentApps: currentFrequentApps,
    schedulePatterns: currentSchedulePatterns,
    hourGrid: currentHourGrid,
    /**
     * The user's "main workload" — full WorkloadProfile (with matched apps)
     * plus whether it was pinned or auto-detected. `profile` is null when no
     * concrete workload is detected (idle/mixed don't count).
     */
    mainWorkload: currentMainWorkload,
    /**
     * Roster of running, non-system apps for this tick. Each row carries the
     * workload it's classified under so the UI can group apps by workload
     * chip and offer per-app recategorization.
     */
    runningApps: currentRunningApps,
  };
}

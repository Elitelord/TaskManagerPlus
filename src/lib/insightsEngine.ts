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
  detectLowBatterySettingsHint,
  detectResourceHogs,
  detectHandleThreadLeak,
  detectHighProcessCount,
  computeHealthScore,
  detectWorkloads,
  getWorkloadSuggestions,
  type WorkloadProfile,
} from "./insights";

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
          if (arr.filter(v => v === 0).length > 10) processMemHistory.delete(name);
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

function runAnalysis() {
  if (snapshotHistory.length === 0) return;
  const snapshot = snapshotHistory[snapshotHistory.length - 1];
  const settings = getSettings();

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

  // Resource hogs
  if (cachedProcesses && cachedPowerData) {
    const grouped = new Map<string, { cpu: number; mem: number }>();
    for (const p of cachedProcesses) {
      const name = p.display_name || p.name;
      const existing = grouped.get(name) || { cpu: 0, mem: 0 };
      existing.mem += p.working_set_mb;
      grouped.set(name, existing);
    }
    for (const pw of cachedPowerData) {
      const proc = cachedProcesses.find(p => p.pid === pw.pid);
      if (proc) {
        const name = proc.display_name || proc.name;
        const existing = grouped.get(name) || { cpu: 0, mem: 0 };
        existing.cpu += pw.cpu_percent;
        grouped.set(name, existing);
      }
    }
    const hogProcs = [...grouped.entries()].map(([name, v]) => ({
      name, cpuPercent: v.cpu, memoryMb: v.mem,
    }));
    newInsights.push(...detectResourceHogs(hogProcs));
  }

  // Handle leak
  const handleInsight = detectHandleThreadLeak(handleHistory);
  if (handleInsight) newInsights.push(handleInsight);

  // Process count
  const procCountInsight = detectHighProcessCount(snapshot);
  if (procCountInsight) newInsights.push(procCountInsight);

  // Workload detection
  if (cachedProcesses && cachedPowerData) {
    const procGrouped = new Map<string, { cpu: number; mem: number; gpu: number }>();
    for (const p of cachedProcesses) {
      const existing = procGrouped.get(p.name) || { cpu: 0, mem: 0, gpu: 0 };
      existing.mem += p.working_set_mb;
      procGrouped.set(p.name, existing);
    }
    for (const pw of cachedPowerData) {
      const proc = cachedProcesses.find(pp => pp.pid === pw.pid);
      if (proc) {
        const existing = procGrouped.get(proc.name) || { cpu: 0, mem: 0, gpu: 0 };
        existing.cpu += pw.cpu_percent;
        procGrouped.set(proc.name, existing);
      }
    }
    const basicProcs = [...procGrouped.entries()].map(([name, v]) => ({
      name, cpuPercent: v.cpu, memoryMb: v.mem, gpuPercent: 0,
    }));
    if (snapshot.gpu_usage_percent > 30) {
      const sorted = [...basicProcs].sort((a, b) => b.memoryMb - a.memoryMb);
      if (sorted.length > 0) sorted[0].gpuPercent = snapshot.gpu_usage_percent;
    }
    currentWorkloads = detectWorkloads(basicProcs);
    // Use primary workload for suggestions
    if (currentWorkloads.length > 0) {
      currentWorkloadSuggestions = getWorkloadSuggestions(currentWorkloads[0], basicProcs);
    } else {
      currentWorkloadSuggestions = [];
    }
  }

  // Sort
  const severityOrder = { critical: 0, warning: 1, info: 2 };
  newInsights.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  currentInsights = newInsights;
  currentHealthScore = computeHealthScore(snapshot, newInsights);

  if (snapshotHistory.length >= 5) calibrated = true;

  notify();
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

export function startEngine() {
  if (analysisInterval) return;
  analysisInterval = setInterval(runAnalysis, 5000);
  // Run immediately too
  setTimeout(runAnalysis, 1000);
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
  };
}

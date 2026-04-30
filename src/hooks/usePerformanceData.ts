import { useRef, useEffect, useState } from "react";
import {
  getPerformanceSnapshot,
  getPerCoreCpu,
  getProcesses,
  getPowerData,
  getDiskData,
  getNetworkData,
  getGpuData,
  getNpuData,
  getStatusData,
  getSystemInfo,
} from "../lib/ipc";
import { RingBuffer } from "../lib/ringBuffer";
import { getSettings } from "../lib/settings";
import { recordBatteryHourlySample } from "../lib/batteryUsage";
import { getMainTrayHidden } from "../lib/mainTrayBackground";
import { feedData } from "../lib/insightsEngine";
import {
  sameProcessPowerSeries,
  sameProcessDiskSeries,
  sameProcessNetworkSeries,
  sameProcessGpuSeries,
  sameProcessNpuSeries,
  sameProcessStatusSeries,
} from "../lib/seriesEquality";
import type {
  PerformanceSnapshot,
  CoreCpuInfo,
  ProcessInfo,
  ProcessPowerInfo,
  ProcessDiskInfo,
  ProcessNetworkInfo,
  ProcessGpuInfo,
  ProcessNpuInfo,
  ProcessStatusInfo,
  SystemInfo,
} from "../lib/types";

export interface PerformanceHistory {
  snapshot: PerformanceSnapshot;
  cores: CoreCpuInfo[];
  /** Top CPU consumers — `value` is current CPU%, `cpuTimeSec` is the
   *  group's cumulative kernel+user CPU time across all PIDs (seconds). */
  topCpu: { pid: number, name: string, value: number, cpuTimeSec?: number }[];
  topMem: { pid: number, name: string, value: number }[];
  topDisk: { pid: number, name: string, value: number }[];
  topNet: { pid: number, name: string, value: number }[];
  topPower: { pid: number, name: string, value: number }[];
  /** Top GPU consumers — `value` is current GPU%, `memBytes` is summed
   *  per-process dedicated VRAM in bytes across each group's PIDs. */
  topGpu: { pid: number, name: string, value: number, memBytes?: number }[];
  /** Top NPU consumers — `value` is current NPU%, `memBytes` is summed
   *  per-process NPU dedicated memory in bytes (with shared as fallback
   *  for adapters that don't report dedicated). */
  topNpu: { pid: number, name: string, value: number, memBytes?: number }[];
  timestamp: number;
}

// --- Global generation listener system ---
// Components subscribe to be notified when new data arrives.
type GenerationListener = (gen: number) => void;
const generationListeners = new Set<GenerationListener>();

export function subscribeGeneration(fn: GenerationListener): () => void {
  generationListeners.add(fn);
  return () => { generationListeners.delete(fn); };
}

function notifyGeneration(gen: number) {
  for (const fn of generationListeners) fn(gen);
}

// --- Shared singleton data engine ---
// All IPC calls are batched into one tick so graphs get a single update per cycle.
const historyBuffer = new RingBuffer<PerformanceHistory>(60);
let generation = 0;
let currentSnapshot: PerformanceSnapshot | undefined;
let currentCores: CoreCpuInfo[] | undefined;
let currentSystemInfo: SystemInfo | undefined;
let currentProcesses: ProcessInfo[] | undefined;
let currentPower: ProcessPowerInfo[] | undefined;
let currentDisk: ProcessDiskInfo[] | undefined;
let currentNetwork: ProcessNetworkInfo[] | undefined;
let currentGpu: ProcessGpuInfo[] | undefined;
let currentNpu: ProcessNpuInfo[] | undefined;
let currentStatus: ProcessStatusInfo[] | undefined;

let tickTimer: ReturnType<typeof setTimeout> | null = null;
let mountCount = 0;
const powerEma = new Map<string, number>();
const POWER_ALPHA = 0.3;

// Throttling for slower-polled data
let lastProcessFetch = 0;
let lastSystemInfoFetch = 0;
let lastGpuFetch = 0;
let lastNpuFetch = 0;
let lastStatusFetch = 0;

// Stable icon cache: dedupes identical base64 strings across processes/fetches.
// Same exe name → reuse the same string reference so Chromium's image cache hits.
const iconCache = new Map<string, string>();
const ICON_CACHE_MAX = 400;

function canonicalizeIcons(processes: ProcessInfo[]) {
  const seen = new Set<string>();
  for (const p of processes) {
    if (!p.icon_base64) continue;
    const key = p.name; // use exe name as key — same exe → same icon
    seen.add(key);
    const cached = iconCache.get(key);
    if (cached !== undefined) {
      // Reuse the cached string reference (avoids duplicating the ~16KB string)
      p.icon_base64 = cached;
    } else {
      iconCache.set(key, p.icon_base64);
    }
  }
  // Bounded cache: drop unseen entries when oversized
  if (iconCache.size > ICON_CACHE_MAX) {
    for (const k of iconCache.keys()) {
      if (!seen.has(k)) {
        iconCache.delete(k);
        if (iconCache.size <= ICON_CACHE_MAX) break;
      }
    }
  }
}

// Public accessors for hooks
export function getCachedSnapshot() { return currentSnapshot; }
export function getCachedCores() { return currentCores; }
export function getCachedProcesses() { return currentProcesses; }
export function getCachedPower() { return currentPower; }
export function getCachedDisk() { return currentDisk; }
export function getCachedNetwork() { return currentNetwork; }
export function getCachedGpu() { return currentGpu; }
export function getCachedNpu() { return currentNpu; }
export function getCachedStatus() { return currentStatus; }
export function getCachedSystemInfo() { return currentSystemInfo; }

/**
 * Hook helper used by lightweight data hooks (useProcesses, useSystemInfo, …)
 * to keep the singleton engine alive while the calling component is mounted,
 * without re-rendering on every snapshot.
 */
export function useEngineLifecycle() {
  useEffect(() => {
    mountCount++;
    if (mountCount === 1) startEngine();
    return () => {
      mountCount--;
      if (mountCount === 0) stopEngine();
    };
  }, []);
}

/** Slower refresh while main window is in the tray — saves CPU; insights still get data via feedData. */
function effectiveRefreshMs(): number {
  const base = getSettings().refreshRate;
  if (!getMainTrayHidden()) return base;
  return Math.max(base * 4, 4000);
}

function getTopGrouped(procMap: Map<number, any>, data: any[], valFn: (p: any) => number, limit = 5) {
  const groups = new Map<string, number>();
  for (const d of data) {
    const val = valFn(d);
    if (val <= 0.001) continue;
    const name = procMap.get(d.pid)?.display_name || procMap.get(d.pid)?.name || `PID ${d.pid}`;
    groups.set(name, (groups.get(name) || 0) + val);
  }

  const sorted = [...groups.entries()]
    .map(([name, value]) => ({ pid: -1, name, value }))
    .sort((a, b) => b.value - a.value);

  const top = sorted.slice(0, limit);
  const otherSum = sorted.slice(limit).reduce((sum, d) => sum + d.value, 0);

  if (otherSum > 0.01) {
    top.push({ pid: -1, name: "Other", value: otherSum });
  }

  return top;
}

/** Group `data` by display-name like getTopGrouped, but additionally sum a
 *  secondary numeric field (e.g. dedicated VRAM bytes for GPU). Useful for
 *  cards that want to show both "% utilization right now" and "total bytes
 *  in use across this app's processes". The `value` is sorted descending and
 *  drives the top-N + Other rollup; the secondary value tags along.
 *
 *  We tolerate groups that have memory but 0% util (idle apps still holding
 *  textures), so we union the two key sets — but sort/slice still happens by
 *  current %, so quiescent apps will land in "Other" rather than dominate. */
function getTopGroupedWithBytes(
  procMap: Map<number, any>,
  data: any[],
  valFn: (p: any) => number,
  bytesFn: (p: any) => number,
  limit = 5,
): { pid: number, name: string, value: number, memBytes: number }[] {
  const groupVal = new Map<string, number>();
  const groupBytes = new Map<string, number>();
  for (const d of data) {
    const v = valFn(d);
    const b = bytesFn(d);
    if (v <= 0.001 && b <= 0) continue;
    const name = procMap.get(d.pid)?.display_name || procMap.get(d.pid)?.name || `PID ${d.pid}`;
    if (v > 0.001) groupVal.set(name, (groupVal.get(name) || 0) + v);
    if (b > 0) groupBytes.set(name, (groupBytes.get(name) || 0) + b);
  }
  const names = new Set<string>([...groupVal.keys(), ...groupBytes.keys()]);
  const rows = [...names].map(name => ({
    pid: -1,
    name,
    value: groupVal.get(name) || 0,
    memBytes: groupBytes.get(name) || 0,
  })).sort((a, b) => b.value - a.value);

  const top = rows.slice(0, limit);
  const rest = rows.slice(limit);
  const otherVal = rest.reduce((s, r) => s + r.value, 0);
  const otherBytes = rest.reduce((s, r) => s + r.memBytes, 0);
  if (otherVal > 0.01 || otherBytes > 0) {
    top.push({ pid: -1, name: "Other", value: otherVal, memBytes: otherBytes });
  }
  return top;
}

/** Top CPU consumers grouped by display name, with cumulative CPU time
 *  (kernel+user, seconds) summed across each group's PIDs.
 *
 *  Mirrors `getTopGrouped` but threads `cpu_time_ms` through so the CPU page
 *  can render `12.3% · 4m 21s` without a second pass over the power array. */
function getTopCpuGrouped(
  procMap: Map<number, any>,
  power: any[],
  limit = 5,
): { pid: number, name: string, value: number, cpuTimeSec: number }[] {
  const groupPct = new Map<string, number>();
  const groupTimeMs = new Map<string, number>();
  for (const d of power) {
    const pct = d.cpu_percent ?? 0;
    const timeMs = d.cpu_time_ms ?? 0;
    // Skip rows with no CPU activity AND no accumulated time — keeps the list clean.
    if (pct <= 0.001 && timeMs <= 0) continue;
    const name = procMap.get(d.pid)?.display_name || procMap.get(d.pid)?.name || `PID ${d.pid}`;
    if (pct > 0.001) groupPct.set(name, (groupPct.get(name) || 0) + pct);
    if (timeMs > 0) groupTimeMs.set(name, (groupTimeMs.get(name) || 0) + timeMs);
  }

  // Build a row per group that appears in either map (some groups may be
  // 0% right now but still have meaningful lifetime CPU time, though we sort
  // and slice by current %, so quiescent groups will fall into "Other").
  const names = new Set<string>([...groupPct.keys(), ...groupTimeMs.keys()]);
  const rows = [...names].map(name => ({
    pid: -1,
    name,
    value: groupPct.get(name) || 0,
    cpuTimeSec: (groupTimeMs.get(name) || 0) / 1000,
  })).sort((a, b) => b.value - a.value);

  const top = rows.slice(0, limit);
  const rest = rows.slice(limit);
  const otherPct = rest.reduce((s, r) => s + r.value, 0);
  const otherTime = rest.reduce((s, r) => s + r.cpuTimeSec, 0);
  if (otherPct > 0.01) {
    top.push({ pid: -1, name: "Other", value: otherPct, cpuTimeSec: otherTime });
  }
  return top;
}

async function tick() {
  const settings = getSettings();
  const rate = settings.refreshRate;
  const now = Date.now();

  try {
    const bg = getMainTrayHidden();
    // Throttling intervals: heavy queries fetch on a slower cadence than the base rate
    const procInterval = bg ? Math.max(10_000, rate * 5) : Math.max(2000, rate * 2);
    const sysInterval = bg ? Math.max(15_000, rate * 6) : Math.max(3000, rate * 3);
    const needProcesses = !currentProcesses || (now - lastProcessFetch) >= procInterval;
    const needSystemInfo = !currentSystemInfo || (now - lastSystemInfoFetch) >= sysInterval;
    // Skip GPU/NPU fetches entirely when the user has hidden them — these are
    // expensive queries (D3DKMT/WMI for GPU, NPU-specific APIs) and there's no
    // consumer for the data while hidden. Hide = sidebar toggle off OR column
    // toggle off. Cached arrays are replaced with [] so downstream hooks don't
    // render stale data if the user later re-enables.
    const hiddenColsSet = new Set(settings.hiddenColumns);
    const gpuEnabled = settings.showGpu && !hiddenColsSet.has("gpu");
    const npuEnabled = settings.showNpu && !hiddenColsSet.has("npu");
    const needGpu = gpuEnabled && (!currentGpu || (now - lastGpuFetch) >= procInterval);
    const needNpu = npuEnabled && (!currentNpu || (now - lastNpuFetch) >= procInterval);
    const needStatus = !currentStatus || (now - lastStatusFetch) >= procInterval;

    // Always fetch fast/changing data
    const fastPromises = [
      getPerformanceSnapshot(),
      getPerCoreCpu(),
      getPowerData(),
      getDiskData(),
      getNetworkData(),
    ] as const;

    // Optional slow data
    const slowPromises = [
      needProcesses ? getProcesses() : Promise.resolve(currentProcesses!),
      needSystemInfo ? getSystemInfo() : Promise.resolve(currentSystemInfo!),
      gpuEnabled
        ? (needGpu ? getGpuData() : Promise.resolve(currentGpu!))
        : Promise.resolve([] as ProcessGpuInfo[]),
      npuEnabled
        ? (needNpu ? getNpuData() : Promise.resolve(currentNpu!))
        : Promise.resolve([] as ProcessNpuInfo[]),
      needStatus ? getStatusData() : Promise.resolve(currentStatus!),
    ] as const;

    const [
      snapshot,
      cores,
      power,
      disk,
      network,
      processes,
      systemInfo,
      gpu,
      npu,
      status,
    ] = await Promise.all([...fastPromises, ...slowPromises]);

    if (needProcesses) lastProcessFetch = now;
    if (needSystemInfo) lastSystemInfoFetch = now;
    if (needGpu) lastGpuFetch = now;
    if (needNpu) lastNpuFetch = now;
    if (needStatus) lastStatusFetch = now;

    if (!snapshot || !cores || !processes || !power) return;

    // Dedupe icon strings before exposing — significantly reduces V8 string heap
    // and lets Chromium's image cache hit on identical data URLs.
    if (needProcesses) canonicalizeIcons(processes);

    currentSnapshot = snapshot;
    currentCores = cores;
    currentProcesses = processes;

    const diskArr = disk ?? [];
    const netArr = network ?? [];
    const gpuArr = gpu ?? [];
    const npuArr = npu ?? [];
    const statusArr = status ?? [];

    // Reuse prior array references when values barely moved — avoids 5× O(n) equality work in React hooks each tick.
    currentPower = currentPower && sameProcessPowerSeries(currentPower, power) ? currentPower : power;
    currentDisk = currentDisk && sameProcessDiskSeries(currentDisk, diskArr) ? currentDisk : diskArr;
    currentNetwork = currentNetwork && sameProcessNetworkSeries(currentNetwork, netArr) ? currentNetwork : netArr;
    currentGpu = currentGpu && sameProcessGpuSeries(currentGpu, gpuArr) ? currentGpu : gpuArr;
    currentNpu = currentNpu && sameProcessNpuSeries(currentNpu, npuArr) ? currentNpu : npuArr;
    currentStatus = currentStatus && sameProcessStatusSeries(currentStatus, statusArr) ? currentStatus : statusArr;
    currentSystemInfo = systemInfo;

    const procMap = new Map(processes.map((p: any) => [p.pid, p]));

    // Apply EMA smoothing to power values before grouping
    const smoothedPower = getTopGrouped(procMap, power, (p: any) => p.power_watts);
    const seenNames = new Set<string>();
    for (const entry of smoothedPower) {
      seenNames.add(entry.name);
      const prev = powerEma.get(entry.name);
      if (prev !== undefined) {
        entry.value = POWER_ALPHA * entry.value + (1 - POWER_ALPHA) * prev;
      }
      powerEma.set(entry.name, entry.value);
    }
    // Decay entries that disappeared
    for (const [name] of powerEma) {
      if (!seenNames.has(name)) {
        const decayed = (powerEma.get(name) || 0) * (1 - POWER_ALPHA);
        if (decayed < 0.01) powerEma.delete(name);
        else powerEma.set(name, decayed);
      }
    }

    historyBuffer.push({
      snapshot,
      cores,
      topCpu: getTopCpuGrouped(procMap, power),
      topMem: getTopGrouped(procMap, processes, (p: any) => p.private_working_set_mb),
      topDisk: getTopGrouped(procMap, disk || [], (p: any) => p.read_bytes_per_sec + p.write_bytes_per_sec),
      topNet: getTopGrouped(procMap, network || [], (p: any) => p.send_bytes_per_sec + p.recv_bytes_per_sec),
      topPower: smoothedPower,
      topGpu: getTopGroupedWithBytes(
        procMap,
        gpu || [],
        (p: any) => p.gpu_usage_percent ?? 0,
        (p: any) => p.gpu_memory_bytes ?? 0,
      ),
      // NPU groups by dedicated memory when present, else shared (some
      // adapters only expose one of the two). Util % drives the sort either
      // way so a process that's actively running a model still ranks first.
      topNpu: getTopGroupedWithBytes(
        procMap,
        npu || [],
        (p: any) => p.npu_usage_percent ?? 0,
        (p: any) => (p.npu_dedicated_bytes ?? 0) || (p.npu_shared_bytes ?? 0),
      ),
      timestamp: now,
    });

    // Rolling 24h per-app Wh (on battery) while the app is open.
    recordBatteryHourlySample({ timestamp: now, snapshot, topPower: smoothedPower.map(p => ({ name: p.name, value: p.value })) });

    generation++;
    const arr = historyBuffer.toArray();
    const latest = arr.length > 0 ? arr[arr.length - 1] : undefined;

    if (!bg) {
      notifyGeneration(generation);
    }

    // Defer insights feed so UI subscribers (tabs, graphs) run first; feedSnapshot does heavy per-process work.
    const snap = snapshot;
    const gen = generation;
    const proc = processes;
    const pow = currentPower;
    const topP = latest?.topPower ?? [];
    queueMicrotask(() => {
      feedData(snap, gen, proc, pow, topP);
    });
  } catch (e) {
    // Silently skip failed ticks
  }
}

function armNextTick() {
  tickTimer = setTimeout(() => {
    tick().finally(armNextTick);
  }, effectiveRefreshMs());
}

function startEngine() {
  if (tickTimer) return;
  // Run first tick immediately (same fire-and-forget pattern as before)
  tick();
  armNextTick();
}

function stopEngine() {
  if (tickTimer) {
    clearTimeout(tickTimer);
    tickTimer = null;
  }
}

/** After returning from tray: run an immediate foreground tick and reset the timer. */
export function wakeAfterTrayShow() {
  if (mountCount === 0) return;
  if (tickTimer) {
    clearTimeout(tickTimer);
    tickTimer = null;
  }
  tick().finally(armNextTick);
}

export function usePerformanceData() {
  const historyRef = useRef(historyBuffer);
  const generationRef = useRef(0);

  // Keep generationRef in sync
  generationRef.current = generation;

  // Trigger re-renders when new data arrives
  const [, setTick] = useState(0);

  useEffect(() => {
    mountCount++;
    if (mountCount === 1) startEngine();

    const unsub = subscribeGeneration((gen) => {
      generationRef.current = gen;
      setTick((n) => n + 1);
    });

    return () => {
      unsub();
      mountCount--;
      if (mountCount === 0) stopEngine();
    };
  }, []);

  return {
    current: currentSnapshot,
    cores: currentCores,
    historyRef,
    generationRef,
  };
}

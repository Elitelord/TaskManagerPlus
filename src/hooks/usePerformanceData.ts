import { useRef, useEffect, useState, useSyncExternalStore } from "react";
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
  getProcessIcons,
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

// --- Telemetry health ---
// The engine used to fail completely silently: a probe that rejected (or worse,
// one that never returned at all) left the UI sitting on "Loading processes…"
// forever with no clue what went wrong — undebuggable without physical access
// to the machine. We now track enough to explain it to the user, including
// *which* probe is outstanding, which is the part that matters when a native
// call hangs rather than fails (a hang throws nothing to catch).

/** Order of the batched probes — index-aligned with the tick's promise array. */
const PROBE_ORDER = [
  "performanceSnapshot", "perCoreCpu", "power", "disk", "network",
  "processes", "systemInfo", "gpu", "npu", "status",
] as const;

/** Human-readable names, used verbatim in the UI. */
export const PROBE_LABELS: Record<string, string> = {
  performanceSnapshot: "CPU & memory",
  perCoreCpu: "per-core CPU",
  power: "power usage",
  disk: "disk activity",
  network: "network activity",
  processes: "process list",
  systemInfo: "system info",
  gpu: "GPU",
  npu: "NPU",
  status: "process state",
  icons: "app icons",
};

export type TelemetryStatus =
  /** Normal startup, before the first tick has completed. */
  | { kind: "loading" }
  /** At least one full tick has landed. */
  | { kind: "ok" }
  /** Essential probes rejected — we have a concrete error to show. */
  | { kind: "error"; failed: string[]; detail: string }
  /** Nothing has come back yet and it's been too long — probably a hang. */
  | { kind: "stalled"; pending: string[]; seconds: number };

/** How long the first tick may take before we call it stalled. */
const STALL_AFTER_MS = 12_000;
/** Cosmetic icon fetch is never allowed to gate the data path longer than this. */
const ICON_TIMEOUT_MS = 8_000;

let telemetryStatus: TelemetryStatus = { kind: "loading" };
const statusListeners = new Set<() => void>();
/** Probes issued this tick that haven't settled yet — the stall diagnosis. */
let outstandingProbes = new Set<string>();
let firstTickOk = false;
let engineStartedAt = 0;
let stallTimer: ReturnType<typeof setInterval> | null = null;

export function subscribeTelemetryStatus(fn: () => void): () => void {
  statusListeners.add(fn);
  return () => { statusListeners.delete(fn); };
}

/** Stable snapshot for useSyncExternalStore — identity only changes on a real change. */
export function getTelemetryStatus(): TelemetryStatus {
  return telemetryStatus;
}

function sameStatus(a: TelemetryStatus, b: TelemetryStatus): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "error" && b.kind === "error") return a.detail === b.detail;
  if (a.kind === "stalled" && b.kind === "stalled") {
    return a.seconds === b.seconds && a.pending.join("|") === b.pending.join("|");
  }
  return true;
}

function setTelemetryStatus(next: TelemetryStatus) {
  if (sameStatus(telemetryStatus, next)) return;
  telemetryStatus = next;
  for (const fn of statusListeners) fn();
}

/**
 * Watches for a first tick that never completes. A hang produces no exception,
 * so this timer is the only thing that can turn it into a visible message.
 */
function startStallWatch() {
  if (stallTimer) return;
  stallTimer = setInterval(() => {
    if (firstTickOk) return;                        // data arrived; nothing to report
    if (telemetryStatus.kind === "error") return;   // a concrete error already wins
    const elapsed = Date.now() - engineStartedAt;
    if (elapsed < STALL_AFTER_MS) return;
    setTelemetryStatus({
      kind: "stalled",
      pending: [...outstandingProbes],
      seconds: Math.round(elapsed / 1000),
    });
  }, 2000);
}

function stopStallWatch() {
  if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
}

/**
 * Resolves to `undefined` instead of hanging forever. The underlying IPC call
 * can't be cancelled, but the tick must not be held hostage by it.
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    p.catch(() => undefined),
    new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), ms)),
  ]);
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
let tickInFlight = false;

// Which telemetry probes failed on the previous tick, so we log a change in
// the failing set once rather than every tick. Reset to "" when all succeed,
// so a later failure re-warns.
let lastFailedProbeKey = "";
function reportProbeFailures(names: string[]): void {
  const key = names.slice().sort().join(",");
  if (key === lastFailedProbeKey) return;
  lastFailedProbeKey = key;
  if (names.length > 0) {
    console.warn(`[perf] telemetry probe(s) failed, using fallbacks: ${key}`);
  }
}

// Icons arrive on a separate, cached IPC channel keyed by exe name (the
// `get_process_icons` command). `get_processes` no longer carries the ~16 KB
// base64 string per process, so each name's icon is fetched at most once and
// stamped onto every process row each tick. Reusing the cached string also
// lets Chromium's image cache hit on identical data URLs.
const iconByName = new Map<string, string>();
const ICON_CACHE_MAX = 400;

async function applyIcons(processes: ProcessInfo[]) {
  // Fetch icons only for names we haven't resolved yet — after warm-up this
  // set is empty and no extra IPC call happens.
  const missing = new Set<string>();
  for (const p of processes) {
    if (p.name && !iconByName.has(p.name)) missing.add(p.name);
  }
  if (missing.size > 0) {
    try {
      const fetched = await getProcessIcons([...missing]);
      for (const name of missing) {
        // Cache even an empty result so we don't re-request a name whose
        // icon the backend can't extract (protected/system processes).
        iconByName.set(name, fetched[name] ?? "");
      }
    } catch {
      // Icons are cosmetic — a failed fetch just leaves placeholders.
    }
  }
  for (const p of processes) {
    const icon = iconByName.get(p.name);
    if (icon) p.icon_base64 = icon;
  }
  // Bounded cache: drop names not present in the current snapshot when oversized.
  if (iconByName.size > ICON_CACHE_MAX) {
    const present = new Set(processes.map((p) => p.name));
    for (const k of [...iconByName.keys()]) {
      if (!present.has(k)) {
        iconByName.delete(k);
        if (iconByName.size <= ICON_CACHE_MAX) break;
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

function getTopGrouped(
  procMap: Map<number, any>,
  data: any[],
  valFn: (p: any) => number,
  limit = 5,
  tailLabel = "Other",
) {
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
    top.push({ pid: -1, name: tailLabel, value: otherSum });
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
  if (tickInFlight) return;
  tickInFlight = true;
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

    // Resolve with allSettled, not all: a single failing probe (a machine
    // with no NPU, a flaky GPU query, etc.) must degrade only its own series,
    // not reject the whole batch and leave the UI stuck on "Loading
    // processes…" forever. Essentials that fail fall back to undefined and are
    // caught by the guard below; optional series fall back to empty/previous.
    // Track which probes are still outstanding so a hang can be *named* in the
    // UI. `.finally` marks each one done as it settles; whatever is left in the
    // set when the stall watch fires is what's stuck.
    const batch = [...fastPromises, ...slowPromises];
    outstandingProbes = new Set(PROBE_ORDER);
    const tracked = batch.map((p, i) =>
      Promise.resolve(p).finally(() => outstandingProbes.delete(PROBE_ORDER[i])),
    );

    const settled = await Promise.allSettled(tracked);
    const failed: string[] = [];
    const failureDetail: string[] = [];
    const ok = (i: number): boolean => settled[i].status === "fulfilled";
    const pick = <T,>(i: number, fallback: T): T => {
      const r = settled[i];
      if (r.status === "fulfilled") return r.value as T;
      const name = PROBE_ORDER[i];
      failed.push(name);
      failureDetail.push(`${PROBE_LABELS[name] ?? name}: ${r.reason}`);
      return fallback;
    };

    const snapshot   = pick(0, undefined as PerformanceSnapshot | undefined);
    const cores      = pick(1, undefined as CoreCpuInfo[] | undefined);
    const power      = pick(2, undefined as ProcessPowerInfo[] | undefined);
    const disk       = pick(3, [] as ProcessDiskInfo[]);
    const network    = pick(4, [] as ProcessNetworkInfo[]);
    const processes  = pick(5, undefined as ProcessInfo[] | undefined);
    const systemInfo = pick(6, currentSystemInfo);
    const gpu        = pick(7, [] as ProcessGpuInfo[]);
    const npu        = pick(8, [] as ProcessNpuInfo[]);
    const status     = pick(9, [] as ProcessStatusInfo[]);

    // Only advance a probe's throttle clock when its fetch actually
    // succeeded, so a failed optional probe retries next tick instead of
    // waiting a full interval.
    if (needProcesses && ok(5)) lastProcessFetch = now;
    if (needSystemInfo && ok(6)) lastSystemInfoFetch = now;
    if (needGpu && ok(7)) lastGpuFetch = now;
    if (needNpu && ok(8)) lastNpuFetch = now;
    if (needStatus && ok(9)) lastStatusFetch = now;

    reportProbeFailures(failed);

    // An essential probe failed. Previously this returned silently and the UI
    // sat on "Loading processes…" indefinitely; now the user gets told what
    // broke and why.
    if (!snapshot || !cores || !processes || !power) {
      setTelemetryStatus({
        kind: "error",
        failed,
        detail: failureDetail.join("\n"),
      });
      return;
    }

    // Publish data *before* the cosmetic icon fetch. This assignment used to
    // sit after an unbounded `await applyIcons(...)`, so a stuck icon call
    // blanked the entire app — no processes, no snapshot, no cores.
    currentSnapshot = snapshot;
    currentCores = cores;
    currentProcesses = processes;
    firstTickOk = true;
    setTelemetryStatus({ kind: "ok" });


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
      topMem: getTopGrouped(
        procMap,
        processes,
        (p: any) => p.private_working_set_mb,
        40,
        "Other apps",
      ),
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
    const net = currentNetwork;
    const dsk = currentDisk;
    const topP = latest?.topPower ?? [];
    queueMicrotask(() => {
      feedData(snap, gen, proc, pow, topP, net, dsk);
    });

    // Icons last, and bounded. Purely cosmetic and mutated in place, so a slow
    // or hung fetch costs at most placeholder icons for one tick — it can no
    // longer delay the first paint or blank the app.
    if (needProcesses) {
      outstandingProbes.add("icons");
      try {
        await withTimeout(applyIcons(processes), ICON_TIMEOUT_MS);
      } finally {
        outstandingProbes.delete("icons");
      }
    }
  } catch (e) {
    // Silently skip failed ticks
  } finally {
    tickInFlight = false;
  }
}

function armNextTick() {
  tickTimer = setTimeout(() => {
    tick().finally(armNextTick);
  }, effectiveRefreshMs());
}

function startEngine() {
  if (tickTimer) return;
  engineStartedAt = Date.now();
  firstTickOk = false;
  setTelemetryStatus({ kind: "loading" });
  startStallWatch();
  // Run first tick immediately (same fire-and-forget pattern as before)
  tick();
  armNextTick();
}

/**
 * Current telemetry health, for surfacing failures in the UI rather than
 * leaving the user staring at a spinner.
 */
export function useTelemetryStatus(): TelemetryStatus {
  return useSyncExternalStore(subscribeTelemetryStatus, getTelemetryStatus);
}

function stopEngine() {
  if (tickTimer) {
    clearTimeout(tickTimer);
    tickTimer = null;
  }
  stopStallWatch();
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

import { useRef, useEffect, useState } from "react";
import { getPerformanceSnapshot, getPerCoreCpu, getProcesses, getPowerData, getDiskData, getNetworkData } from "../lib/ipc";
import { RingBuffer } from "../lib/ringBuffer";
import { getSettings } from "../lib/settings";
import { recordBatteryHourlySample } from "../lib/batteryUsage";
import type { PerformanceSnapshot, CoreCpuInfo } from "../lib/types";

export interface PerformanceHistory {
  snapshot: PerformanceSnapshot;
  cores: CoreCpuInfo[];
  topCpu: { pid: number, name: string, value: number }[];
  topMem: { pid: number, name: string, value: number }[];
  topDisk: { pid: number, name: string, value: number }[];
  topNet: { pid: number, name: string, value: number }[];
  topPower: { pid: number, name: string, value: number }[];
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
let tickTimer: ReturnType<typeof setInterval> | null = null;
let mountCount = 0;
const powerEma = new Map<string, number>();
const POWER_ALPHA = 0.3;

// Cache for slower-polled data (processes update less often)
let cachedProcesses: any[] | null = null;
let lastProcessFetch = 0;

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

async function tick() {
  const rate = getSettings().refreshRate;
  const now = Date.now();

  try {
    // Fetch everything in parallel in a single batch
    const needProcesses = !cachedProcesses || (now - lastProcessFetch) >= rate * 2;

    const promises: [
      Promise<PerformanceSnapshot>,
      Promise<CoreCpuInfo[]>,
      Promise<any>,
      Promise<any[]>,
      Promise<any[]>,
    ] = [
      getPerformanceSnapshot(),
      getPerCoreCpu(),
      getPowerData(),
      getDiskData(),
      getNetworkData(),
    ];

    const processPromise = needProcesses ? getProcesses() : null;

    const [snapshot, cores, power, disk, network] = await Promise.all(promises);
    if (processPromise) {
      cachedProcesses = await processPromise;
      lastProcessFetch = now;
    }

    const processes = cachedProcesses;
    if (!snapshot || !cores || !processes || !power) return;

    currentSnapshot = snapshot;
    currentCores = cores;

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
      topCpu: getTopGrouped(procMap, power, (p: any) => p.cpu_percent),
      topMem: getTopGrouped(procMap, processes, (p: any) => p.private_mb),
      topDisk: getTopGrouped(procMap, disk || [], (p: any) => p.read_bytes_per_sec + p.write_bytes_per_sec),
      topNet: getTopGrouped(procMap, network || [], (p: any) => p.send_bytes_per_sec + p.recv_bytes_per_sec),
      topPower: smoothedPower,
      timestamp: now,
    });

    // Rolling 24h per-app Wh (on battery) while the app is open.
    recordBatteryHourlySample({ timestamp: now, snapshot, topPower: smoothedPower.map(p => ({ name: p.name, value: p.value })) });

    generation++;
    notifyGeneration(generation);
  } catch (e) {
    // Silently skip failed ticks
  }
}

function startEngine() {
  if (tickTimer) return;
  // Run first tick immediately
  tick();
  // Then set up the interval — re-reads refreshRate each tick
  const scheduleNext = () => {
    const rate = getSettings().refreshRate;
    tickTimer = setTimeout(() => {
      tick().finally(scheduleNext);
    }, rate);
  };
  scheduleNext();
}

function stopEngine() {
  if (tickTimer) {
    clearTimeout(tickTimer);
    tickTimer = null;
  }
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
      setTick(gen);
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

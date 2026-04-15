import type {
  ProcessPowerInfo,
  ProcessDiskInfo,
  ProcessNetworkInfo,
  ProcessGpuInfo,
  ProcessNpuInfo,
  ProcessStatusInfo,
} from "./types";

/** Avoid React invalidation when per-process metrics barely moved (IPC always allocates new arrays). */
const CPU_EPS = 0.04;
const WATT_EPS = 0.08;
const BATT_EPS = 0.25;
const RATE_EPS = 512; // bytes/s — coalesce tiny disk/net noise
const GPU_EPS = 0.15;

function pidMap<T extends { pid: number }>(arr: T[]): Map<number, T> {
  const m = new Map<number, T>();
  for (const x of arr) m.set(x.pid, x);
  return m;
}

export function sameProcessPowerSeries(
  a: ProcessPowerInfo[] | undefined,
  b: ProcessPowerInfo[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  const bm = pidMap(b);
  for (const x of a) {
    const y = bm.get(x.pid);
    if (!y) return false;
    if (Math.abs(x.cpu_percent - y.cpu_percent) > CPU_EPS) return false;
    if (Math.abs(x.power_watts - y.power_watts) > WATT_EPS) return false;
    if (Math.abs(x.battery_percent - y.battery_percent) > BATT_EPS) return false;
    if (Math.abs(x.energy_uj - y.energy_uj) > 50_000) return false;
  }
  return true;
}

export function sameProcessDiskSeries(
  a: ProcessDiskInfo[] | undefined,
  b: ProcessDiskInfo[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  const bm = pidMap(b);
  for (const x of a) {
    const y = bm.get(x.pid);
    if (!y) return false;
    if (Math.abs(x.read_bytes_per_sec - y.read_bytes_per_sec) > RATE_EPS) return false;
    if (Math.abs(x.write_bytes_per_sec - y.write_bytes_per_sec) > RATE_EPS) return false;
  }
  return true;
}

export function sameProcessNetworkSeries(
  a: ProcessNetworkInfo[] | undefined,
  b: ProcessNetworkInfo[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  const bm = pidMap(b);
  for (const x of a) {
    const y = bm.get(x.pid);
    if (!y) return false;
    if (Math.abs(x.send_bytes_per_sec - y.send_bytes_per_sec) > RATE_EPS) return false;
    if (Math.abs(x.recv_bytes_per_sec - y.recv_bytes_per_sec) > RATE_EPS) return false;
  }
  return true;
}

export function sameProcessGpuSeries(
  a: ProcessGpuInfo[] | undefined,
  b: ProcessGpuInfo[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  const bm = pidMap(b);
  for (const x of a) {
    const y = bm.get(x.pid);
    if (!y) return false;
    if (Math.abs(x.gpu_usage_percent - y.gpu_usage_percent) > GPU_EPS) return false;
    if (Math.abs(x.gpu_memory_bytes - y.gpu_memory_bytes) > 512 * 1024) return false;
  }
  return true;
}

export function sameProcessNpuSeries(
  a: ProcessNpuInfo[] | undefined,
  b: ProcessNpuInfo[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  const bm = pidMap(b);
  for (const x of a) {
    const y = bm.get(x.pid);
    if (!y) return false;
    if (Math.abs(x.npu_usage_percent - y.npu_usage_percent) > GPU_EPS) return false;
    if (Math.abs(x.npu_dedicated_bytes - y.npu_dedicated_bytes) > 256 * 1024) return false;
    if (Math.abs(x.npu_shared_bytes - y.npu_shared_bytes) > 256 * 1024) return false;
  }
  return true;
}

export function sameProcessStatusSeries(
  a: ProcessStatusInfo[] | undefined,
  b: ProcessStatusInfo[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  const bm = pidMap(b);
  for (const x of a) {
    const y = bm.get(x.pid);
    if (!y) return false;
    if (x.status !== y.status) return false;
  }
  return true;
}

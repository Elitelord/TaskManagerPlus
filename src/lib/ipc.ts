import { invoke } from "@tauri-apps/api/core";
import type {
  ProcessInfo,
  ProcessPowerInfo,
  ProcessDiskInfo,
  ProcessNetworkInfo,
  ProcessGpuInfo,
  ProcessStatusInfo,
  SystemInfo,
  PerformanceSnapshot,
  CoreCpuInfo,
} from "./types";

export async function getProcesses(): Promise<ProcessInfo[]> {
  return invoke<ProcessInfo[]>("get_processes");
}

export async function getPowerData(): Promise<ProcessPowerInfo[]> {
  return invoke<ProcessPowerInfo[]>("get_power_data");
}

export async function getDiskData(): Promise<ProcessDiskInfo[]> {
  return invoke<ProcessDiskInfo[]>("get_disk_data");
}

export async function getNetworkData(): Promise<ProcessNetworkInfo[]> {
  return invoke<ProcessNetworkInfo[]>("get_network_data");
}

export async function getGpuData(): Promise<ProcessGpuInfo[]> {
  return invoke<ProcessGpuInfo[]>("get_gpu_data");
}

export async function getStatusData(): Promise<ProcessStatusInfo[]> {
  return invoke<ProcessStatusInfo[]>("get_status_data");
}

export async function getSystemInfo(): Promise<SystemInfo> {
  return invoke<SystemInfo>("get_system_info");
}

export async function endTask(pid: number): Promise<void> {
  return invoke<void>("end_task", { pid });
}

export async function setPriority(pid: number, priority: number): Promise<void> {
  return invoke<void>("set_priority", { pid, priority });
}

export async function getPerformanceSnapshot(): Promise<PerformanceSnapshot> {
  return invoke<PerformanceSnapshot>("get_performance_snapshot");
}

export async function getPerCoreCpu(): Promise<CoreCpuInfo[]> {
  return invoke<CoreCpuInfo[]>("get_per_core_cpu");
}

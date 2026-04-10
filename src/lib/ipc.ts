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

/** Single entry point — other `ms-settings:` battery URIs often route here on Windows 11. */
export const WINDOWS_POWER_SETTINGS_URI = "ms-settings:powersleep";

export interface WindowsBatteryUsage {
  hourly_24h: { bucket_start_local: string; drain_wh: number }[];
  daily_7d: { day: string; drain_wh: number }[];
}

/** Opens `ms-settings:` etc. via the OS (Tauri shell.open blocks non-http schemes). */
export async function openWindowsSettingsUri(uri: string): Promise<void> {
  return invoke<void>("open_windows_uri", { uri });
}

/** On-battery drain from `powercfg /batteryreport /xml` (24 hourly buckets + daily totals). */
export async function getWindowsBatteryUsage(): Promise<WindowsBatteryUsage> {
  return invoke<WindowsBatteryUsage>("get_windows_battery_usage");
}

/** WMI vendor + install-path scan for OEM fan / thermal tools (G-Helper, Vantage, etc.). */
export interface ThermalDelegateInfo {
  manufacturer: string;
  model: string;
  isLikelyLaptop: boolean;
  suggestedAppName: string;
  detailLine: string;
  buttonLabel: string;
  hasInstalledApp: boolean;
}

export async function getThermalDelegateInfo(): Promise<ThermalDelegateInfo> {
  return invoke<ThermalDelegateInfo>("get_thermal_delegate_info");
}

/** Launches detected OEM app, or store/download URL, or Windows Power settings as last resort. */
export async function launchThermalDelegate(): Promise<void> {
  return invoke<void>("launch_thermal_delegate");
}

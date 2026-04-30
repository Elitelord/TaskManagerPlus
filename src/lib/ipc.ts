import { invoke } from "@tauri-apps/api/core";
import type {
  ProcessInfo,
  ProcessPowerInfo,
  ProcessDiskInfo,
  ProcessNetworkInfo,
  ProcessGpuInfo,
  ProcessNpuInfo,
  ProcessStatusInfo,
  SystemInfo,
  PerformanceSnapshot,
  CoreCpuInfo,
  StorageVolumeInfo,
  StorageFolderInfo,
  InstalledAppInfo,
  FileTypeStat,
  DetectedProject,
  BuildArtifact,
  DuplicateGroup,
} from "./types";

export async function getStorageVolumes(): Promise<StorageVolumeInfo[]> {
  return invoke<StorageVolumeInfo[]>("get_storage_volumes");
}

export async function getTopFolders(root: string, max = 32): Promise<StorageFolderInfo[]> {
  return invoke<StorageFolderInfo[]>("get_top_folders", { root, max });
}

export async function getInstalledApps(): Promise<InstalledAppInfo[]> {
  return invoke<InstalledAppInfo[]>("get_installed_apps");
}

export async function getRecycleBinSize(): Promise<number> {
  return invoke<number>("get_recycle_bin_size");
}

export async function emptyRecycleBin(): Promise<void> {
  return invoke<void>("empty_recycle_bin");
}

/** Smart Organizer — classify files under `folder` (depth 6, 20k file cap). */
export async function scanFileTypes(folder: string): Promise<FileTypeStat[]> {
  return invoke<FileTypeStat[]>("scan_file_types", { folder });
}

/** Smart Organizer — find project folders (Git/Node/Rust/.NET/Python) under `root`. */
export async function detectProjects(root: string): Promise<DetectedProject[]> {
  return invoke<DetectedProject[]>("detect_projects", { root });
}

/** Smart Organizer — for each detected project root, locate build/dependency
 *  artifact folders (node_modules, target/, __pycache__, .venv, .next, etc.)
 *  and report each one's total size + newest-modification time. The staleness
 *  check + delete action is done on the frontend. */
export async function scanBuildArtifacts(projectPaths: string[]): Promise<BuildArtifact[]> {
  return invoke<BuildArtifact[]>("scan_build_artifacts", { projectPaths });
}

/** Smart Organizer — find content-identical duplicate files among the given
 *  candidate paths. Backend does size-prefilter + BLAKE3 hashing; only groups
 *  with ≥ 2 identical copies and file size ≥ `minSize` are returned. */
export async function findDuplicateFiles(
  paths: string[],
  minSize?: number,
): Promise<DuplicateGroup[]> {
  return invoke<DuplicateGroup[]>("find_duplicate_files", {
    paths,
    minSize: minSize ?? 10 * 1024 * 1024, // 10 MB default
  });
}

export interface UserFolderPaths {
  home: string;
  documents: string;
  downloads: string;
  desktop: string;
  pictures: string;
  videos: string;
  music: string;
}

/** Well-known user folder paths derived from `USERPROFILE`. */
export async function getUserFolders(): Promise<UserFolderPaths> {
  return invoke<UserFolderPaths>("get_user_folders");
}

/** Create a directory (and any missing parents) at the given path. */
export async function createFolder(path: string): Promise<void> {
  return invoke<void>("create_folder", { path });
}

export interface MoveResult {
  moved: number;
  skipped: string[];
  errors: string[];
}

/** Move files/folders into a destination folder. Returns counts and any errors. */
export async function moveItemsToFolder(sources: string[], destination: string): Promise<MoveResult> {
  return invoke<MoveResult>("move_items_to_folder", { sources, destination });
}

export interface RecycleResult {
  recycled: number;
  errors: string[];
}

/** Send files/folders to the Recycle Bin (non-destructive). */
export async function recycleFiles(paths: string[]): Promise<RecycleResult> {
  return invoke<RecycleResult>("recycle_files", { paths });
}

export interface FoundFile {
  path: string;
  name: string;
  size_bytes: number;
  modified_ts: number;
}

/** List files in a folder matching the given extensions (e.g. [".mp4", ".mkv"]). */
export async function listFilesByExtensions(
  folder: string,
  extensions: string[],
  maxDepth?: number,
  maxResults?: number,
): Promise<FoundFile[]> {
  return invoke<FoundFile[]>("list_files_by_extensions", {
    folder,
    extensions,
    maxDepth: maxDepth ?? 2,
    maxResults: maxResults ?? 100,
  });
}

/** Check whether a path (file or folder) exists on disk. */
export async function checkPathExists(path: string): Promise<boolean> {
  return invoke<boolean>("check_path_exists", { path });
}

/** Reveal a file or folder in Windows Explorer. For files, opens the parent
 *  folder and selects the file. For folders, opens the folder itself. */
export async function revealInExplorer(path: string): Promise<void> {
  return invoke<void>("reveal_in_explorer", { path });
}

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

export async function getNpuData(): Promise<ProcessNpuInfo[]> {
  return invoke<ProcessNpuInfo[]>("get_npu_data");
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

// ---------------------------------------------------------------------------
// Display / GPU adapter commands
// ---------------------------------------------------------------------------

export interface DisplayMode {
  width: number;
  height: number;
  refresh_hz: number;
  bpp: number;
}

export interface MonitorInfo {
  device_name: string;
  friendly_name: string;
  is_primary: boolean;
  current: DisplayMode;
  available_modes: DisplayMode[];
  refresh_rates_at_current: number[];
  resolutions: [number, number][];
}

export interface GpuAdapterInfo {
  name: string;
  vendor_id: number;
  device_id: number;
  dedicated_vram_bytes: number;
  shared_memory_bytes: number;
  is_integrated: boolean;
  is_primary: boolean;
  luid_high: number;
  luid_low: number;
}

/** Enumerates active monitors with their current + available modes. */
export async function listMonitors(): Promise<MonitorInfo[]> {
  return invoke<MonitorInfo[]>("list_monitors");
}

/** Switches the given device to `width x height @ refresh_hz`. */
export async function setDisplayMode(
  device_name: string,
  width: number,
  height: number,
  refresh_hz: number,
): Promise<void> {
  return invoke<void>("set_display_mode", { deviceName: device_name, width, height, refreshHz: refresh_hz });
}

/** Enumerates DXGI adapters (excluding WARP). One is flagged `is_primary`. */
export async function listGpuAdapters(): Promise<GpuAdapterInfo[]> {
  return invoke<GpuAdapterInfo[]>("list_gpu_adapters");
}

/** Opens the Windows "Graphics settings" page (per-app GPU preference picker). */
export async function openGraphicsSettings(): Promise<void> {
  return invoke<void>("open_graphics_settings");
}

export interface OemInfo {
  manufacturer: string;
  model: string;
  vendor: string;
  supports_charge_limit: boolean;
  charge_limit_presets: number[];
  charge_limit_min: number;
  charge_limit_max: number;
  note: string;
}

export interface ChargeLimitStatus {
  supported: boolean;
  enabled: boolean;
  limit_percent: number | null;
  error: string | null;
}

export async function getOemInfo(): Promise<OemInfo> {
  return invoke<OemInfo>("get_oem_info");
}

export async function getChargeLimit(): Promise<ChargeLimitStatus> {
  return invoke<ChargeLimitStatus>("get_charge_limit");
}

export async function setChargeLimit(percent: number): Promise<void> {
  return invoke<void>("set_charge_limit", { percent });
}

export async function isElevated(): Promise<boolean> {
  return invoke<boolean>("is_elevated");
}

export async function relaunchAsAdmin(): Promise<void> {
  return invoke<void>("relaunch_as_admin");
}

// ---------------------------------------------------------------------------
// Bluetooth (Phase 1 — read-only snapshot + disconnect/unpair)
// ---------------------------------------------------------------------------

export interface BluetoothRadio {
  name: string;
  address: string;
  manufacturer_id: number;
  class_of_device: number;
  subversion: number;
  discoverable: boolean;
  connectable: boolean;
}

export interface BluetoothDeviceSnapshot {
  address: string;
  name: string;
  class_of_device: number;
  major_class: string;
  minor_class: string;
  connected: boolean;
  authenticated: boolean;
  remembered: boolean;
  last_seen_unix: number;
  last_used_unix: number;
}

export interface BluetoothSnapshot {
  supported: boolean;
  radio_present: boolean;
  radios: BluetoothRadio[];
  devices: BluetoothDeviceSnapshot[];
  error: string | null;
}

/** One-shot paired-device enumeration. Never call this on a timer — the
 *  BluetoothPage invokes it on mount and on explicit user refresh only. */
export async function getBluetoothSnapshot(): Promise<BluetoothSnapshot> {
  return invoke<BluetoothSnapshot>("get_bluetooth_snapshot");
}

/** Unpair. Destructive — confirm with the user first. */
export async function bluetoothRemoveDevice(address: string): Promise<void> {
  return invoke<void>("bluetooth_remove_device", { address });
}

/** Opens `ms-settings:bluetooth`. Phase-1 escape hatch for radio on/off. */
export async function openBluetoothSettings(): Promise<void> {
  return invoke<void>("open_bluetooth_settings");
}

// ---------------------------------------------------------------------------
// USB (SetupAPI enumeration — no background polling)
// ---------------------------------------------------------------------------

export interface UsbDeviceInfo {
  name: string;
  manufacturer: string;
  class: string;         // Windows device-class ("HIDClass", "AudioEndpoint", ...)
  description: string;
  vendor_id: number;
  product_id: number;
  hardware_id: string;   // stable row key
}

export interface UsbSnapshot {
  supported: boolean;
  devices: UsbDeviceInfo[];
  error: string | null;
}

export async function getUsbDevices(): Promise<UsbSnapshot> {
  return invoke<UsbSnapshot>("get_usb_devices");
}

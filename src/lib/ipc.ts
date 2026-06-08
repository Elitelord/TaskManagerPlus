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
  StartupAppsResponse,
  FileTypeStat,
  DetectedProject,
  BuildArtifact,
  DuplicateGroup,
} from "./types";

export async function getStorageVolumes(): Promise<StorageVolumeInfo[]> {
  return invoke<StorageVolumeInfo[]>("get_storage_volumes");
}

/** Absolute path to the bundled `tmp_mcp.exe` sidecar, or `null` when
 *  the sidecar isn't built yet (typical in dev before
 *  `cargo build --bin tmp_mcp`). Drives the MCP settings card — the path
 *  flows into the copy-to-clipboard config snippet so users don't have to
 *  guess at the install dir. */
export async function getMcpSidecarPath(): Promise<string | null> {
  return invoke<string | null>("mcp_sidecar_path");
}

/** Which MCP clients we can one-click install for. `claudeCode` is true
 *  when the `claude` CLI is on PATH; `claudeDesktop` is true when the
 *  app's config directory exists (i.e. Claude Desktop has been
 *  launched at least once). */
export interface McpClientAvailability {
  claudeCode: boolean;
  claudeDesktop: boolean;
}
export async function getMcpClientsAvailable(): Promise<McpClientAvailability> {
  return invoke<McpClientAvailability>("mcp_clients_available");
}

/** Run `claude mcp add taskmanagerplus <sidecar> --scope user`. Errors
 *  if the CLI is missing or the server is already registered. */
export async function installMcpClaudeCode(): Promise<void> {
  return invoke<void>("mcp_install_claude_code");
}

/** Merge the taskmanagerplus entry into Claude Desktop's
 *  `claude_desktop_config.json`. Backs the previous file up to
 *  `claude_desktop_config.json.bak` before overwriting. */
export async function installMcpClaudeDesktop(): Promise<void> {
  return invoke<void>("mcp_install_claude_desktop");
}

/** Z1 — read the persisted opt-in for destructive MCP tools (end_process,
 *  recycle_files, empty_recycle_bin). The sidecar reads this flag once at
 *  startup, so toggling requires an MCP-client restart to take effect. */
export async function getMcpDestructiveEnabled(): Promise<boolean> {
  return invoke<boolean>("mcp_get_destructive_enabled");
}

/** Z1 — persist the destructive opt-in. Writes
 *  `%LOCALAPPDATA%\com.taskmanagerplus.app\mcp_config.json`. */
export async function setMcpDestructiveEnabled(enabled: boolean): Promise<void> {
  return invoke<void>("mcp_set_destructive_enabled", { enabled });
}

export async function getTopFolders(root: string, max = 32): Promise<StorageFolderInfo[]> {
  return invoke<StorageFolderInfo[]>("get_top_folders", { root, max });
}

export async function getInstalledApps(): Promise<InstalledAppInfo[]> {
  return invoke<InstalledAppInfo[]>("get_installed_apps");
}

export async function getStartupApps(): Promise<StartupAppsResponse> {
  return invoke<StartupAppsResponse>("get_startup_apps");
}

export async function setStartupEnabled(id: string, enabled: boolean): Promise<void> {
  return invoke<void>("set_startup_enabled", { id, enabled });
}

export async function setLogonTaskEnabled(
  path: string,
  name: string,
  enabled: boolean,
): Promise<void> {
  return invoke<void>("set_logon_task_enabled", { path, name, enabled });
}

export const WINDOWS_STARTUP_SETTINGS_URI = "ms-settings:startupapps";

/** Deep-measure variant. Walks each app's install folder + attributes
 *  AppData/LocalState folders to produce a true on-disk total. Bounded
 *  by `maxApps` (default 40) and `timeBudgetMs` (default 30s); apps
 *  outside the budget retain the fast-path registry estimate. */
export async function measureInstalledAppStorage(
  maxApps?: number,
  timeBudgetMs?: number,
): Promise<InstalledAppInfo[]> {
  return invoke<InstalledAppInfo[]>("measure_installed_app_storage", {
    maxApps: maxApps ?? null,
    timeBudgetMs: timeBudgetMs ?? null,
  });
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

/**
 * Move files/folders into a destination folder. Returns counts and any errors.
 *
 * `allowUnsafe` opts past the backend safety filter for "sensitive" but
 * legitimate paths (the user's profile root, well-known top folders like
 * Documents/Downloads). Forbidden paths — system roots, Program Files,
 * drive roots — are refused regardless. Always confirm with the user
 * before passing `true`.
 */
export async function moveItemsToFolder(
  sources: string[],
  destination: string,
  allowUnsafe = false,
): Promise<MoveResult> {
  return invoke<MoveResult>("move_items_to_folder", { sources, destination, allowUnsafe });
}

export interface RecycleResult {
  recycled: number;
  errors: string[];
}

/**
 * Send files/folders to the Recycle Bin (non-destructive).
 *
 * `allowUnsafe`: see {@link moveItemsToFolder}.
 */
export async function recycleFiles(
  paths: string[],
  allowUnsafe = false,
): Promise<RecycleResult> {
  return invoke<RecycleResult>("recycle_files", { paths, allowUnsafe });
}

/** Verdict the backend assigns to a path before a destructive op. */
export interface PathSafetyReport {
  verdict: "safe" | "sensitive" | "forbidden";
  reason: string;
  path: string;
}

/**
 * Ask the backend whether a set of paths are safe to operate on. Used by
 * the UI to surface a warning dialog BEFORE the user confirms a move /
 * recycle on a high-risk path, rather than getting a generic rejection
 * from the destructive command.
 */
export async function classifyPaths(paths: string[]): Promise<PathSafetyReport[]> {
  return invoke<PathSafetyReport[]>("classify_paths", { paths });
}

export interface FoundFile {
  path: string;
  name: string;
  size_bytes: number;
  modified_ts: number;
}

export interface FolderChildEntry {
  path: string;
  name: string;
  kind: "file" | "folder";
  size_bytes: number;
}

export interface FolderSizeResult {
  path: string;
  size_bytes: number;
  file_count: number;
}

/** List immediate children of a folder (no recursive size scan). */
export async function listFolderChildren(folder: string): Promise<FolderChildEntry[]> {
  return invoke<FolderChildEntry[]>("list_folder_children", { folder });
}

/** Recursive size for one or more folder paths (inspector size enrichment). */
export async function sizeFolderPaths(
  paths: string[],
  maxDepth = 8,
): Promise<FolderSizeResult[]> {
  return invoke<FolderSizeResult[]>("size_folder_paths", { paths, maxDepth });
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

/** Rename a file in place — same folder, new stem (no extension), original
 *  extension preserved. Returns the new absolute path. Rejects path
 *  separators and refuses to overwrite an existing file. */
export async function renameFile(path: string, newStem: string): Promise<string> {
  return invoke<string>("rename_file", { path, newStem });
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

/** Best-effort on-disk path for an in-progress download in `pid`. */
export async function probeDownloadPath(pid: number): Promise<string | null> {
  if (pid <= 0) return null;
  try {
    return await invoke<string | null>("probe_download_path", { pid });
  } catch {
    return null;
  }
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

export interface PerfMode {
  id: string;
  label: string;
  raw: number;
}

export interface OemThermalCapabilities {
  vendor: string;
  supports_perf_mode: boolean;
  perf_modes: PerfMode[];
  supports_fan_rpm: boolean;
  note: string;
}

export interface OemThermalStatus {
  supported: boolean;
  current_mode_id: string | null;
  cpu_fan_rpm: number | null;
  gpu_fan_rpm: number | null;
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

export async function getOemThermalCapabilities(): Promise<OemThermalCapabilities> {
  return invoke<OemThermalCapabilities>("get_oem_thermal_capabilities");
}

export async function getOemThermalStatus(): Promise<OemThermalStatus> {
  return invoke<OemThermalStatus>("get_oem_thermal_status");
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

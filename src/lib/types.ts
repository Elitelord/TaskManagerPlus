export interface ProcessInfo {
  pid: number;
  name: string;
  display_name: string;
  icon_base64: string;
  private_mb: number;              // Committed virtual memory (NOT real RAM — huge for Chromium apps)
  shared_mb: number;                // Shared working set (shared DLL pages etc.)
  working_set_mb: number;           // Total working set (shared + private)
  private_working_set_mb: number;   // Private working set — what Task Manager displays as "Memory"
  page_faults: number;
  process_type?: string; // e.g., "renderer", "gpu", "extension-host", "main"
}

export interface ProcessPowerInfo {
  pid: number;
  battery_percent: number;
  energy_uj: number;
  cpu_percent: number;
  power_watts: number;
}

export interface ProcessDiskInfo {
  pid: number;
  read_bytes_per_sec: number;
  write_bytes_per_sec: number;
  total_read_bytes: number;
  total_write_bytes: number;
}

export interface ProcessNetworkInfo {
  pid: number;
  send_bytes_per_sec: number;
  recv_bytes_per_sec: number;
  total_sent: number;
  total_received: number;
}

export interface ProcessGpuInfo {
  pid: number;
  gpu_usage_percent: number;
  gpu_memory_bytes: number;
}

export interface ProcessNpuInfo {
  pid: number;
  npu_usage_percent: number;
  npu_dedicated_bytes: number;
  npu_shared_bytes: number;
}

export interface ProcessStatusInfo {
  pid: number;
  status: "running" | "suspended" | "unknown";
}

export interface SystemInfo {
  total_ram_mb: number;
  used_ram_mb: number;
  cpu_usage_percent: number;
  battery_percent: number;
  is_charging: boolean;
  process_count: number;
  total_disk_read_per_sec: number;
  total_disk_write_per_sec: number;
  total_net_send_per_sec: number;
  total_net_recv_per_sec: number;
  gpu_usage_percent: number;
  power_draw_watts: number;
  charge_rate_watts: number;
}

export interface ProcessRow extends ProcessInfo {
  battery_percent: number;
  energy_uj: number;
  cpu_percent: number;
  power_watts: number;
  disk_read_per_sec: number;
  disk_write_per_sec: number;
  net_send_per_sec: number;
  net_recv_per_sec: number;
  gpu_percent: number;
  npu_percent: number;
  npu_dedicated_bytes: number;
  npu_shared_bytes: number;
  status: "running" | "suspended" | "unknown";
}

export interface ProcessGroup {
  name: string;
  display_name: string;
  count: number;
  total_private_mb: number;
  total_shared_mb: number;
  total_working_set_mb: number;
  total_private_working_set_mb: number;  // Matches Task Manager's "Memory" column
  total_battery_percent: number;
  total_energy_uj: number;
  total_cpu_percent: number;
  total_disk_read: number;
  total_disk_write: number;
  total_net_send: number;
  total_net_recv: number;
  total_gpu_percent: number;
  total_npu_percent: number;
  total_npu_dedicated_bytes: number;
  total_npu_shared_bytes: number;
  total_power_watts: number;
  status: "running" | "suspended" | "unknown";
  // Synthetic system row (Kernel / File Cache / Shared-unattributed). These rows:
  //  - cannot be ended or right-clicked
  //  - appear in memory-sorted order, but sink to the bottom for any other sort
  //  - have a fake child with pid < 0 and zero values for non-memory metrics
  is_system?: boolean;
  children: ProcessRow[];
}

export interface CoreCpuInfo {
  core_index: number;
  usage_percent: number;
  is_performance_core: number; // 1=P-core, 0=E-core, -1=unknown
}

export interface PerformanceSnapshot {
  // CPU
  cpu_usage_percent: number;
  core_count: number;
  thread_count: number;
  cpu_frequency_mhz: number;
  cpu_max_frequency_mhz: number;
  cpu_base_frequency_mhz: number;
  cpu_name: string;                   // CPU brand string (e.g., "Intel(R) Core(TM) i7-12700H")
  // Memory
  total_ram_bytes: number;
  used_ram_bytes: number;
  available_ram_bytes: number;
  committed_bytes: number;
  commit_limit_bytes: number;
  cached_bytes: number;
  paged_pool_bytes: number;
  non_paged_pool_bytes: number;
  // Standby list priority breakdown — together approximate cached_bytes.
  // 0 if NtQuerySystemInformation couldn't fetch it (then fall back to cached_bytes).
  cache_idle_bytes: number;       // low-priority / first to be evicted
  cache_active_bytes: number;     // mid-priority / recently used
  cache_launch_bytes: number;     // SuperFetch app-launch pages
  modified_pages_bytes: number;   // dirty pages awaiting writeback
  // Disk
  disk_read_per_sec: number;
  disk_write_per_sec: number;
  disk_active_percent: number;
  disk_queue_length: number;
  // Network
  net_send_per_sec: number;
  net_recv_per_sec: number;
  net_link_speed_bps: number;
  // GPU
  gpu_usage_percent: number;
  gpu_memory_total: number;           // Dedicated VRAM total
  gpu_memory_used: number;            // Dedicated VRAM in use
  gpu_shared_memory_total: number;    // Shared system memory pool available to GPU
  gpu_shared_memory_used: number;     // Shared system memory currently used by GPU
  gpu_is_integrated: boolean;         // True on integrated/UMA GPUs
  gpu_name: string;                   // Adapter description (e.g., "NVIDIA GeForce RTX 4070")
  gpu_temperature: number;
  fan_rpm: number;                    // System/GPU fan RPM, -1 if unavailable
  // NPU
  npu_present: boolean;
  npu_usage_percent: number;
  npu_dedicated_total_bytes: number;
  npu_dedicated_used_bytes: number;
  npu_shared_total_bytes: number;
  npu_shared_used_bytes: number;
  npu_name: string;
  npu_hardware_id: string;
  // Battery / Power
  battery_percent: number;
  is_charging: boolean;
  power_draw_watts: number;
  network_power_watts: number;
  charge_rate_watts: number;
  battery_time_remaining: number;
  battery_design_capacity_mwh: number;
  battery_full_charge_capacity_mwh: number;
  battery_cycle_count: number;
  battery_voltage: number;
  // Counts
  process_count: number;
  handle_count: number;
  thread_total_count: number;
}

export interface StorageVolumeInfo {
  letter: string;
  label: string;
  filesystem: string;
  media_kind: "hdd" | "ssd" | "nvme" | "usb" | "network" | "optical" | "virtual" | "unknown";
  is_system: boolean;
  is_readonly: boolean;
  total_bytes: number;
  free_bytes: number;
  read_bytes_per_sec: number;
  write_bytes_per_sec: number;
  active_percent: number;
  queue_length: number;
}

export interface StorageFolderInfo {
  path: string;
  display_name: string;
  size_bytes: number;
  file_count: number;
}

export interface InstalledAppInfo {
  name: string;
  publisher: string;
  version: string;
  install_date: string;
  size_bytes: number;
  install_location: string;
}

/** Smart Organizer — per-category rollup for a scanned folder. */
export type OrganizerCategory =
  | "documents" | "images" | "videos" | "audio" | "archives"
  | "code" | "executables" | "installers" | "screenshots" | "other";

export interface FileTypeStat {
  folder_path: string;
  category: OrganizerCategory | string;
  total_bytes: number;
  file_count: number;
  oldest_modified_ts: number;   // unix seconds, 0 if none
  newest_modified_ts: number;   // unix seconds, 0 if none
}

/** Smart Organizer — project folder detected under a scanned root. */
export type ProjectType = "git" | "nodejs" | "rust" | "dotnet" | "python" | "unknown";

export interface DetectedProject {
  path: string;
  project_type: ProjectType | string;
  display_name: string;
  size_bytes: number;
  file_count: number;
}

/** Smart Organizer — build/dependency artifact found inside a detected project
 *  (node_modules, target/, __pycache__, .venv, .next, etc.). These are all
 *  regenerable on demand, so the organizer frames them as "reclaim space by
 *  deleting — your next build will rebuild them." */
export interface BuildArtifact {
  path: string;
  project_path: string;
  kind: string;                 // "node_modules" | "target" | ".git" | ...
  size_bytes: number;
  newest_modified_ts: number;   // unix seconds, for staleness detection
  file_count: number;
}

/** Smart Organizer — a group of files that hash-identical and therefore are
 *  content-exact duplicates of each other. `paths.length >= 2` always. The
 *  backend already size-prefilters, so any file passed here had at least one
 *  size-matching peer. */
export interface DuplicateGroup {
  hash: string;
  size_bytes: number;           // each path has exactly this size
  paths: string[];
}

export type DisplayRow =
  | { type: "group"; group: ProcessGroup; expanded: boolean }
  | { type: "child"; process: ProcessRow; groupName: string };

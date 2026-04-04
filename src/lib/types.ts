export interface ProcessInfo {
  pid: number;
  name: string;
  display_name: string;
  icon_base64: string;
  private_mb: number;
  shared_mb: number;
  working_set_mb: number;
  page_faults: number;
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
  status: "running" | "suspended" | "unknown";
}

export interface ProcessGroup {
  name: string;
  display_name: string;
  count: number;
  total_private_mb: number;
  total_shared_mb: number;
  total_working_set_mb: number;
  total_battery_percent: number;
  total_energy_uj: number;
  total_cpu_percent: number;
  total_disk_read: number;
  total_disk_write: number;
  total_net_send: number;
  total_net_recv: number;
  total_gpu_percent: number;
  total_power_watts: number;
  status: "running" | "suspended" | "unknown";
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
  // Memory
  total_ram_bytes: number;
  used_ram_bytes: number;
  available_ram_bytes: number;
  committed_bytes: number;
  commit_limit_bytes: number;
  cached_bytes: number;
  paged_pool_bytes: number;
  non_paged_pool_bytes: number;
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
  gpu_memory_total: number;
  gpu_memory_used: number;
  gpu_temperature: number;
  // Battery / Power
  battery_percent: number;
  is_charging: boolean;
  power_draw_watts: number;
  charge_rate_watts: number;
  battery_time_remaining: number;
  // Counts
  process_count: number;
  handle_count: number;
  thread_total_count: number;
}

export type DisplayRow =
  | { type: "group"; group: ProcessGroup; expanded: boolean }
  | { type: "child"; process: ProcessRow; groupName: string };

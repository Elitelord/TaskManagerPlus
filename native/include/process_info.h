#pragma once

#include <stdint.h>

#ifdef BUILDING_DLL
  #define DLL_EXPORT __declspec(dllexport)
#else
  #define DLL_EXPORT __declspec(dllimport)
#endif

struct ProcessMemoryInfo {
    uint32_t pid;
    wchar_t  name[260];       // MAX_PATH
    wchar_t  display_name[260]; // Friendly name
    char     icon_base64[16384]; // Base64 encoded PNG icon
    uint64_t private_bytes;           // PrivateUsage — committed virtual memory (NOT physical RAM)
    uint64_t working_set;             // WorkingSetSize — total physical RAM incl. shared pages
    uint64_t shared_bytes;            // working_set - private (approximation)
    uint64_t private_working_set;     // Private working set — physical RAM unique to this process
                                      // (the value Task Manager displays by default, Win10 1709+)
    uint64_t page_faults;
};

struct ProcessPowerInfo {
    uint32_t pid;
    double   battery_percent; // estimated battery drain %
    uint64_t energy_uj;       // microjoules estimate
    double   cpu_percent;     // per-process CPU usage %
    double   power_watts;     // estimated draw (W): CPU+GPU pools plus optional NIC share; screen subtracted globally
};

struct ProcessDiskInfo {
    uint32_t pid;
    double   read_bytes_per_sec;
    double   write_bytes_per_sec;
    uint64_t total_read_bytes;
    uint64_t total_write_bytes;
};

struct ProcessNetworkInfo {
    uint32_t pid;
    double   send_bytes_per_sec;
    double   recv_bytes_per_sec;
    uint64_t total_sent;
    uint64_t total_received;
};

struct ProcessGpuInfo {
    uint32_t pid;
    double   gpu_usage_percent;
    uint64_t gpu_memory_bytes;
};

struct ProcessNpuInfo {
    uint32_t pid;
    double   npu_usage_percent;
    uint64_t npu_dedicated_bytes;
    uint64_t npu_shared_bytes;
};

// Per-core CPU info
struct CoreCpuInfo {
    uint32_t core_index;
    double   usage_percent;
    int32_t  is_performance_core;  // 1 = P-core, 0 = E-core, -1 = unknown
};

// Extended system info for performance tab
struct PerformanceSnapshot {
    // CPU
    double   cpu_usage_percent;
    uint32_t core_count;
    uint32_t thread_count;
    double   cpu_frequency_mhz;
    double   cpu_max_frequency_mhz;
    double   cpu_base_frequency_mhz;
    char     cpu_name[128];            // UTF-8 CPU brand string (null-terminated)

    // Memory
    uint64_t total_ram_bytes;
    uint64_t used_ram_bytes;
    uint64_t available_ram_bytes;
    uint64_t committed_bytes;
    uint64_t commit_limit_bytes;
    uint64_t cached_bytes;
    uint64_t paged_pool_bytes;
    uint64_t non_paged_pool_bytes;
    // Standby list split by priority (from NtQuerySystemInformation / SystemMemoryListInformation).
    // Together these sum to (approximately) `cached_bytes`.
    uint64_t cache_idle_bytes;       // priorities 0-1 — first to be evicted (friendly: "Reclaimable")
    uint64_t cache_active_bytes;     // priorities 2-5 — recently used (friendly: "Recently Used")
    uint64_t cache_launch_bytes;     // priorities 6-7 — SuperFetch app-launch pages
    uint64_t modified_pages_bytes;   // dirty pages pending write — count as "in use" by OS

    // Disk
    double   disk_read_per_sec;
    double   disk_write_per_sec;
    double   disk_active_percent;
    uint64_t disk_queue_length;

    // Network
    double   net_send_per_sec;
    double   net_recv_per_sec;
    double   net_link_speed_bps;

    // GPU
    double   gpu_usage_percent;
    uint64_t gpu_memory_total;         // Dedicated VRAM total (DXGI DedicatedVideoMemory)
    uint64_t gpu_memory_used;          // Dedicated VRAM in use (LOCAL segment CurrentUsage)
    uint64_t gpu_shared_memory_total;  // Shared system memory available to GPU
    uint64_t gpu_shared_memory_used;   // Shared system memory currently used (NON_LOCAL segment)
    int32_t  gpu_is_integrated;        // 1 if integrated/UMA GPU, 0 if discrete
    char     gpu_name[128];            // UTF-8 adapter description (null-terminated)
    double   gpu_temperature;
    int32_t  fan_rpm;                  // System/CPU fan RPM, -1 if unavailable

    // NPU (Windows 11 AI PC — DXCore + PDH; absent on systems without an NPU)
    int32_t  npu_present;              // 1 if an NPU was discovered or NPU PDH counters exist
    double   npu_usage_percent;
    uint64_t npu_dedicated_total_bytes;
    uint64_t npu_dedicated_used_bytes;
    uint64_t npu_shared_total_bytes;
    uint64_t npu_shared_used_bytes;
    char     npu_name[128];            // UTF-8 (null-terminated)
    char     npu_hardware_id[48];      // UTF-8 PCI id text e.g. "VEN_1002&DEV_17F0" (may be empty)

    // Battery / Power
    double   battery_percent;
    int32_t  is_charging;
    double   power_draw_watts;        // Estimated total system power draw
    double   network_power_watts;     // Estimated active NIC draw (W), modelled from throughput + link
    double   charge_rate_watts;       // Power coming from charger (0 if not charging)
    int32_t  battery_time_remaining;  // seconds, -1 if unknown
    uint32_t battery_design_capacity_mwh;   // Design capacity in mWh
    uint32_t battery_full_charge_capacity_mwh; // Current full charge capacity in mWh
    uint32_t battery_cycle_count;     // Charge cycle count
    double   battery_voltage;         // Current voltage in volts

    // Process count
    uint32_t process_count;
    uint32_t handle_count;
    uint32_t thread_total_count;
};

// 0 = unknown, 1 = running, 2 = suspended
struct ProcessStatusInfo {
    uint32_t pid;
    int32_t  status;
};

struct SystemInfoData {
    uint64_t total_ram_mb;
    uint64_t used_ram_mb;
    double   cpu_usage_percent;
    double   battery_percent;
    int32_t  is_charging;
    uint32_t process_count;
    double   total_disk_read_per_sec;
    double   total_disk_write_per_sec;
    double   total_net_send_per_sec;
    double   total_net_recv_per_sec;
    double   gpu_usage_percent;
    double   power_draw_watts;
    double   charge_rate_watts;
};

extern "C" {
    // Returns count of processes. If buffer is NULL, just returns count needed.
    DLL_EXPORT int32_t get_process_memory_list(ProcessMemoryInfo* buffer, int32_t max_count);

    // Returns count of power entries with CPU %. If buffer is NULL, just returns count needed.
    DLL_EXPORT int32_t get_process_power_list(ProcessPowerInfo* buffer, int32_t max_count);

    // Returns disk I/O per process. If buffer is NULL, just returns count needed.
    DLL_EXPORT int32_t get_process_disk_list(ProcessDiskInfo* buffer, int32_t max_count);

    // Returns network I/O per process. If buffer is NULL, just returns count needed.
    DLL_EXPORT int32_t get_process_network_list(ProcessNetworkInfo* buffer, int32_t max_count);

    // Returns GPU usage per process. If buffer is NULL, just returns count needed.
    DLL_EXPORT int32_t get_process_gpu_list(ProcessGpuInfo* buffer, int32_t max_count);

    // Returns NPU usage / memory per process. If buffer is NULL, just returns count needed.
    DLL_EXPORT int32_t get_process_npu_list(ProcessNpuInfo* buffer, int32_t max_count);

    // Returns process status (running/suspended). If buffer is NULL, just returns count needed.
    DLL_EXPORT int32_t get_process_status_list(ProcessStatusInfo* buffer, int32_t max_count);

    // Terminates a process by PID. Returns 0 on success, -1 on failure.
    DLL_EXPORT int32_t terminate_process(uint32_t pid);

    // Sets process priority class. Returns 0 on success, -1 on failure.
    DLL_EXPORT int32_t set_process_priority(uint32_t pid, int32_t priority_class);

    // Fills system info struct. Returns 0 on success.
    DLL_EXPORT int32_t get_system_info(SystemInfoData* info);

    // Returns per-core CPU usage. If buffer is NULL, returns core count.
    DLL_EXPORT int32_t get_per_core_cpu(CoreCpuInfo* buffer, int32_t max_count);

    // Returns detailed performance snapshot
    DLL_EXPORT int32_t get_performance_snapshot(PerformanceSnapshot* snapshot);

    // Returns DLL version for testing IPC pipeline
    DLL_EXPORT int32_t get_version();
}

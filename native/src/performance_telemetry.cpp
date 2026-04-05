#include "process_info.h"

#include <initguid.h>
#include <windows.h>
#include <psapi.h>
#include <pdh.h>
#include <vector>
#include <cstring>
#include <setupapi.h>
#include <devguid.h>
#include <batclass.h>
#include <dxgi.h>

// {72631E54-78A4-11D0-BCF7-00AA00B7B32A}
DEFINE_GUID(GUID_DEVINTERFACE_BATTERY, 0x72631e54, 0x78a4, 0x11d0, 0xbc, 0xf7, 0x00, 0xaa, 0x00, 0xb7, 0xb3, 0x2a);

#pragma comment(lib, "pdh.lib")
#pragma comment(lib, "setupapi.lib")
#pragma comment(lib, "gdi32.lib")

// ---------------------------------------------------------------------------
// D3DKMT types for GPU temperature (WDDM 2.5+, Windows 10 1809+)
// ---------------------------------------------------------------------------
typedef UINT D3DKMT_HANDLE;

typedef struct _D3DKMT_OPENADAPTERFROMLUID {
    LUID   AdapterLuid;
    D3DKMT_HANDLE hAdapter;
} D3DKMT_OPENADAPTERFROMLUID;

typedef struct _D3DKMT_CLOSEADAPTER {
    D3DKMT_HANDLE hAdapter;
} D3DKMT_CLOSEADAPTER;

typedef struct _D3DKMT_ADAPTER_PERFDATA {
    ULONG     PhysicalAdapterIndex;
    ULONGLONG MemoryFrequency;
    ULONGLONG MaxMemoryFrequency;
    ULONGLONG MaxMemoryFrequencyOC;
    ULONGLONG MemoryBandwidth;
    ULONGLONG PCIEBandwidth;
    ULONG     FanRPM;
    ULONG     Power;         // mW percentage * 100
    ULONG     Temperature;   // deci-Celsius (tenths of degree)
    UCHAR     PowerStateOverride;
} D3DKMT_ADAPTER_PERFDATA;

// KMTQAITYPE values
#define KMTQAITYPE_ADAPTERPERFDATA 62

typedef struct _D3DKMT_QUERYADAPTERINFO {
    D3DKMT_HANDLE hAdapter;
    UINT          Type;
    VOID*         pPrivateDriverData;
    UINT          PrivateDriverDataSize;
} D3DKMT_QUERYADAPTERINFO;

typedef NTSTATUS(WINAPI* PFN_D3DKMTOpenAdapterFromLuid)(D3DKMT_OPENADAPTERFROMLUID*);
typedef NTSTATUS(WINAPI* PFN_D3DKMTCloseAdapter)(D3DKMT_CLOSEADAPTER*);
typedef NTSTATUS(WINAPI* PFN_D3DKMTQueryAdapterInfo)(D3DKMT_QUERYADAPTERINFO*);

static PFN_D3DKMTOpenAdapterFromLuid pfnOpenAdapter = nullptr;
static PFN_D3DKMTCloseAdapter pfnCloseAdapter = nullptr;
static PFN_D3DKMTQueryAdapterInfo pfnQueryAdapterInfo = nullptr;
static bool g_d3dkmtLoaded = false;

static void load_d3dkmt() {
    if (g_d3dkmtLoaded) return;
    g_d3dkmtLoaded = true;
    HMODULE gdi = GetModuleHandleW(L"gdi32.dll");
    if (!gdi) gdi = LoadLibraryW(L"gdi32.dll");
    if (!gdi) return;
    pfnOpenAdapter = (PFN_D3DKMTOpenAdapterFromLuid)GetProcAddress(gdi, "D3DKMTOpenAdapterFromLuid");
    pfnCloseAdapter = (PFN_D3DKMTCloseAdapter)GetProcAddress(gdi, "D3DKMTCloseAdapter");
    pfnQueryAdapterInfo = (PFN_D3DKMTQueryAdapterInfo)GetProcAddress(gdi, "D3DKMTQueryAdapterInfo");
}

static double query_gpu_temperature(LUID adapterLuid) {
    load_d3dkmt();
    if (!pfnOpenAdapter || !pfnCloseAdapter || !pfnQueryAdapterInfo) return 0.0;

    D3DKMT_OPENADAPTERFROMLUID openParams = {};
    openParams.AdapterLuid = adapterLuid;
    if (pfnOpenAdapter(&openParams) != 0) return 0.0;

    D3DKMT_ADAPTER_PERFDATA perfData = {};
    perfData.PhysicalAdapterIndex = 0;
    D3DKMT_QUERYADAPTERINFO queryInfo = {};
    queryInfo.hAdapter = openParams.hAdapter;
    queryInfo.Type = KMTQAITYPE_ADAPTERPERFDATA;
    queryInfo.pPrivateDriverData = &perfData;
    queryInfo.PrivateDriverDataSize = sizeof(perfData);

    double temp = 0.0;
    if (pfnQueryAdapterInfo(&queryInfo) == 0) {
        temp = static_cast<double>(perfData.Temperature) / 10.0;
    }

    D3DKMT_CLOSEADAPTER closeParams = {};
    closeParams.hAdapter = openParams.hAdapter;
    pfnCloseAdapter(&closeParams);

    return temp;
}

#ifndef PDH_MORE_DATA
#define PDH_MORE_DATA ((LONG)0x800007D2L)
#endif

// ---------------------------------------------------------------------------
// NtQuerySystemInformation types (loaded dynamically from ntdll.dll)
// ---------------------------------------------------------------------------

typedef struct _SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION {
    LARGE_INTEGER IdleTime;
    LARGE_INTEGER KernelTime;
    LARGE_INTEGER UserTime;
    LARGE_INTEGER DpcTime;
    LARGE_INTEGER InterruptTime;
    ULONG         InterruptCount;
} SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION;

typedef LONG (WINAPI *NtQuerySystemInformation_t)(
    ULONG SystemInformationClass,
    PVOID SystemInformation,
    ULONG SystemInformationLength,
    PULONG ReturnLength
);

static const ULONG SystemProcessorPerformanceInformation = 8;

static NtQuerySystemInformation_t g_NtQuerySystemInformation = nullptr;
static bool g_ntdll_loaded = false;

static void ensure_ntdll() {
    if (g_ntdll_loaded) return;
    g_ntdll_loaded = true;
    HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    if (ntdll) {
        g_NtQuerySystemInformation = reinterpret_cast<NtQuerySystemInformation_t>(
            GetProcAddress(ntdll, "NtQuerySystemInformation"));
    }
}

// ---------------------------------------------------------------------------
// Per-core CPU previous state
// ---------------------------------------------------------------------------

struct CoreTimes {
    LONGLONG idle;
    LONGLONG kernel;
    LONGLONG user;
};

static std::vector<CoreTimes> g_prev_core_times;
static bool g_core_has_previous = false;

// ---------------------------------------------------------------------------
// P-core / E-core detection via GetSystemCpuSetInformation
// ---------------------------------------------------------------------------

typedef BOOL (WINAPI *GetSystemCpuSetInformation_t)(
    PVOID Information,
    ULONG BufferLength,
    PULONG ReturnedLength,
    HANDLE Process,
    ULONG Flags
);

// Minimal SYSTEM_CPU_SET_INFORMATION structure
#pragma pack(push, 1)
struct SYSTEM_CPU_SET_INFORMATION_ITEM {
    ULONG Size;
    ULONG Type; // 0 = CpuSetInformation
    union {
        struct {
            ULONG Id;
            USHORT Group;
            UCHAR LogicalProcessorIndex;
            UCHAR CoreIndex;
            UCHAR LastLevelCacheIndex;
            UCHAR NumaNodeIndex;
            UCHAR EfficiencyClass;
            union {
                UCHAR AllFlags;
                struct {
                    UCHAR Parked : 1;
                    UCHAR Allocated : 1;
                    UCHAR AllocatedToTargetProcess : 1;
                    UCHAR RealTime : 1;
                    UCHAR ReservedFlags : 4;
                };
            };
            union {
                ULONG Reserved;
                UCHAR SchedulingClass;
            };
            ULONG64 AllocationTag;
        } CpuSet;
    };
};
#pragma pack(pop)

static std::vector<int32_t> g_core_type_cache; // 1=P, 0=E, -1=unknown
static bool g_core_type_initialized = false;

static void init_core_types(int num_processors) {
    if (g_core_type_initialized) return;
    g_core_type_initialized = true;

    g_core_type_cache.resize(num_processors, -1);

    HMODULE kernel32 = GetModuleHandleW(L"kernel32.dll");
    if (!kernel32) return;

    auto pGetSystemCpuSetInformation = reinterpret_cast<GetSystemCpuSetInformation_t>(
        GetProcAddress(kernel32, "GetSystemCpuSetInformation"));
    if (!pGetSystemCpuSetInformation) return;

    ULONG bufLen = 0;
    pGetSystemCpuSetInformation(nullptr, 0, &bufLen, nullptr, 0);
    if (bufLen == 0) return;

    std::vector<BYTE> buf(bufLen);
    ULONG retLen = 0;
    if (!pGetSystemCpuSetInformation(buf.data(), bufLen, &retLen, nullptr, 0)) return;

    ULONG offset = 0;
    while (offset + sizeof(ULONG) * 2 <= retLen) {
        auto* item = reinterpret_cast<SYSTEM_CPU_SET_INFORMATION_ITEM*>(buf.data() + offset);
        if (item->Size == 0) break;

        if (item->Type == 0) { // CpuSetInformation
            int idx = item->CpuSet.LogicalProcessorIndex;
            if (idx >= 0 && idx < num_processors) {
                // EfficiencyClass > 0 means E-core on Intel hybrid arch
                g_core_type_cache[idx] = (item->CpuSet.EfficiencyClass > 0) ? 0 : 1;
            }
        }

        offset += item->Size;
    }
}

// ---------------------------------------------------------------------------
// get_per_core_cpu
// ---------------------------------------------------------------------------

extern "C" DLL_EXPORT int32_t get_per_core_cpu(CoreCpuInfo* buffer, int32_t max_count) {
    ensure_ntdll();

    SYSTEM_INFO sysInfo;
    GetSystemInfo(&sysInfo);
    int num_processors = static_cast<int>(sysInfo.dwNumberOfProcessors);
    if (num_processors < 1) num_processors = 1;

    // If buffer is NULL, return count only - do NOT save state
    if (buffer == nullptr) {
        return static_cast<int32_t>(num_processors);
    }

    init_core_types(num_processors);

    if (!g_NtQuerySystemInformation) {
        // Fallback: return zeros
        int count = (num_processors < max_count) ? num_processors : max_count;
        for (int i = 0; i < count; i++) {
            buffer[i].core_index = static_cast<uint32_t>(i);
            buffer[i].usage_percent = 0.0;
            buffer[i].is_performance_core = (i < static_cast<int>(g_core_type_cache.size()))
                ? g_core_type_cache[i] : -1;
        }
        return count;
    }

    // Query per-core times
    std::vector<SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION> perfInfo(num_processors);
    ULONG retLen = 0;
    LONG status = g_NtQuerySystemInformation(
        SystemProcessorPerformanceInformation,
        perfInfo.data(),
        static_cast<ULONG>(sizeof(SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION) * num_processors),
        &retLen
    );

    if (status != 0) {
        // NTSTATUS failure
        int count = (num_processors < max_count) ? num_processors : max_count;
        for (int i = 0; i < count; i++) {
            buffer[i].core_index = static_cast<uint32_t>(i);
            buffer[i].usage_percent = 0.0;
            buffer[i].is_performance_core = (i < static_cast<int>(g_core_type_cache.size()))
                ? g_core_type_cache[i] : -1;
        }
        return count;
    }

    int actual_cores = static_cast<int>(retLen / sizeof(SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION));
    if (actual_cores > num_processors) actual_cores = num_processors;

    // Build current times
    std::vector<CoreTimes> current(actual_cores);
    for (int i = 0; i < actual_cores; i++) {
        current[i].idle   = perfInfo[i].IdleTime.QuadPart;
        current[i].kernel = perfInfo[i].KernelTime.QuadPart;
        current[i].user   = perfInfo[i].UserTime.QuadPart;
    }

    int count = (actual_cores < max_count) ? actual_cores : max_count;

    if (g_core_has_previous && static_cast<int>(g_prev_core_times.size()) == actual_cores) {
        for (int i = 0; i < count; i++) {
            LONGLONG delta_idle   = current[i].idle   - g_prev_core_times[i].idle;
            LONGLONG delta_kernel = current[i].kernel - g_prev_core_times[i].kernel;
            LONGLONG delta_user   = current[i].user   - g_prev_core_times[i].user;

            // KernelTime includes IdleTime
            LONGLONG delta_total = delta_kernel + delta_user;
            LONGLONG delta_busy  = delta_total - delta_idle;

            double usage = 0.0;
            if (delta_total > 0) {
                usage = (static_cast<double>(delta_busy) / static_cast<double>(delta_total)) * 100.0;
            }
            if (usage < 0.0) usage = 0.0;
            if (usage > 100.0) usage = 100.0;

            buffer[i].core_index = static_cast<uint32_t>(i);
            buffer[i].usage_percent = usage;
            buffer[i].is_performance_core = (i < static_cast<int>(g_core_type_cache.size()))
                ? g_core_type_cache[i] : -1;
        }
    } else {
        for (int i = 0; i < count; i++) {
            buffer[i].core_index = static_cast<uint32_t>(i);
            buffer[i].usage_percent = 0.0;
            buffer[i].is_performance_core = (i < static_cast<int>(g_core_type_cache.size()))
                ? g_core_type_cache[i] : -1;
        }
    }

    // Save state
    g_prev_core_times = current;
    g_core_has_previous = true;

    return count;
}

// ---------------------------------------------------------------------------
// Performance snapshot - PDH counters
// ---------------------------------------------------------------------------

static PDH_HQUERY  g_perfQuery = nullptr;
static PDH_HCOUNTER g_perfCpuCounter = nullptr;
static PDH_HCOUNTER g_perfCpuFreqCounter = nullptr;
static PDH_HCOUNTER g_perfCpuMaxFreqCounter = nullptr;
static PDH_HCOUNTER g_perfDiskReadCounter = nullptr;
static PDH_HCOUNTER g_perfDiskWriteCounter = nullptr;
static PDH_HCOUNTER g_perfDiskTimeCounter = nullptr;
static PDH_HCOUNTER g_perfDiskQueueCounter = nullptr;
static PDH_HCOUNTER g_perfNetSendCounter = nullptr;
static PDH_HCOUNTER g_perfNetRecvCounter = nullptr;
static PDH_HCOUNTER g_perfNetBandwidthCounter = nullptr;
static PDH_HCOUNTER g_perfGpuCounter = nullptr;
static PDH_HCOUNTER g_perfGpuMemCounter = nullptr;
static bool g_perfInitialized = false;
static bool g_perfGpuAvailable = false;
static bool g_perfGpuMemAvailable = false;

static void init_perf_counters() {
    if (g_perfInitialized) return;
    g_perfInitialized = true;

    if (PdhOpenQueryW(nullptr, 0, &g_perfQuery) != ERROR_SUCCESS) {
        g_perfQuery = nullptr;
        return;
    }

    // CPU
    PdhAddEnglishCounterW(g_perfQuery,
        L"\\Processor(_Total)\\% Processor Time",
        0, &g_perfCpuCounter);

    PdhAddEnglishCounterW(g_perfQuery,
        L"\\Processor Information(_Total)\\Processor Frequency",
        0, &g_perfCpuFreqCounter);

    PdhAddEnglishCounterW(g_perfQuery,
        L"\\Processor Information(_Total)\\% of Maximum Frequency",
        0, &g_perfCpuMaxFreqCounter);

    // Disk
    PdhAddEnglishCounterW(g_perfQuery,
        L"\\PhysicalDisk(_Total)\\Disk Read Bytes/sec",
        0, &g_perfDiskReadCounter);

    PdhAddEnglishCounterW(g_perfQuery,
        L"\\PhysicalDisk(_Total)\\Disk Write Bytes/sec",
        0, &g_perfDiskWriteCounter);

    PdhAddEnglishCounterW(g_perfQuery,
        L"\\PhysicalDisk(_Total)\\% Disk Time",
        0, &g_perfDiskTimeCounter);

    PdhAddEnglishCounterW(g_perfQuery,
        L"\\PhysicalDisk(_Total)\\Current Disk Queue Length",
        0, &g_perfDiskQueueCounter);

    // Network
    PdhAddEnglishCounterW(g_perfQuery,
        L"\\Network Interface(*)\\Bytes Sent/sec",
        0, &g_perfNetSendCounter);

    PdhAddEnglishCounterW(g_perfQuery,
        L"\\Network Interface(*)\\Bytes Received/sec",
        0, &g_perfNetRecvCounter);

    PdhAddEnglishCounterW(g_perfQuery,
        L"\\Network Interface(*)\\Current Bandwidth",
        0, &g_perfNetBandwidthCounter);

    // GPU
    if (PdhAddEnglishCounterW(g_perfQuery,
            L"\\GPU Engine(*)\\Utilization Percentage",
            0, &g_perfGpuCounter) == ERROR_SUCCESS) {
        g_perfGpuAvailable = true;
    }

    if (PdhAddEnglishCounterW(g_perfQuery,
            L"\\GPU Process Memory(*)\\Dedicated Usage",
            0, &g_perfGpuMemCounter) == ERROR_SUCCESS) {
        g_perfGpuMemAvailable = true;
    }

    // Initial collection (required before counters return valid data)
    PdhCollectQueryData(g_perfQuery);
}

static double perf_get_double(PDH_HCOUNTER counter) {
    if (!counter) return 0.0;
    PDH_FMT_COUNTERVALUE val;
    if (PdhGetFormattedCounterValue(counter, PDH_FMT_DOUBLE, nullptr, &val) == ERROR_SUCCESS) {
        return val.doubleValue;
    }
    return 0.0;
}

static double perf_get_wildcard_sum(PDH_HCOUNTER counter) {
    if (!counter) return 0.0;

    DWORD bufSize = 0, itemCount = 0;
    PDH_STATUS status = PdhGetFormattedCounterArray(counter, PDH_FMT_DOUBLE, &bufSize, &itemCount, nullptr);
    if (status != PDH_MORE_DATA || bufSize == 0) return 0.0;

    std::vector<BYTE> buf(bufSize);
    auto* items = reinterpret_cast<PDH_FMT_COUNTERVALUE_ITEM_W*>(buf.data());
    status = PdhGetFormattedCounterArray(counter, PDH_FMT_DOUBLE, &bufSize, &itemCount, items);
    if (status != ERROR_SUCCESS) return 0.0;

    double total = 0.0;
    for (DWORD i = 0; i < itemCount; i++) {
        total += items[i].FmtValue.doubleValue;
    }
    return total;
}

static double perf_get_wildcard_max(PDH_HCOUNTER counter) {
    if (!counter) return 0.0;

    DWORD bufSize = 0, itemCount = 0;
    PDH_STATUS status = PdhGetFormattedCounterArray(counter, PDH_FMT_DOUBLE, &bufSize, &itemCount, nullptr);
    if (status != PDH_MORE_DATA || bufSize == 0) return 0.0;

    std::vector<BYTE> buf(bufSize);
    auto* items = reinterpret_cast<PDH_FMT_COUNTERVALUE_ITEM_W*>(buf.data());
    status = PdhGetFormattedCounterArray(counter, PDH_FMT_DOUBLE, &bufSize, &itemCount, items);
    if (status != ERROR_SUCCESS) return 0.0;

    double maxVal = 0.0;
    for (DWORD i = 0; i < itemCount; i++) {
        if (items[i].FmtValue.doubleValue > maxVal)
            maxVal = items[i].FmtValue.doubleValue;
    }
    return maxVal;
}

// ---------------------------------------------------------------------------
// Battery power query via IOCTL
// ---------------------------------------------------------------------------

static double g_prev_battery_percent = -1.0;
static ULONGLONG g_prev_battery_tick = 0;
static double g_estimated_power_watts = 0.0;
static uint32_t g_battery_design_capacity_mwh = 0;
static uint32_t g_battery_full_charge_capacity_mwh = 0;
static uint32_t g_battery_cycle_count = 0;
static double g_battery_voltage = 0.0;

static ULONGLONG GetTickCount64ULL() {
    return GetTickCount64();
}

static void get_battery_wattage(double& out_draw_watts, double& out_charge_watts) {
    out_draw_watts = 0.0;
    out_charge_watts = 0.0;

    HDEVINFO hdev = SetupDiGetClassDevsW(&GUID_DEVINTERFACE_BATTERY, 0, 0, DIGCF_PRESENT | DIGCF_DEVICEINTERFACE);
    if (hdev == INVALID_HANDLE_VALUE) return;

    SP_DEVICE_INTERFACE_DATA did = {0};
    did.cbSize = sizeof(did);

    for (int i = 0; SetupDiEnumDeviceInterfaces(hdev, 0, &GUID_DEVINTERFACE_BATTERY, i, &did); i++) {
        DWORD size = 0;
        SetupDiGetDeviceInterfaceDetailW(hdev, &did, 0, 0, &size, NULL);
        if (GetLastError() != ERROR_INSUFFICIENT_BUFFER) continue;

        std::vector<BYTE> buf(size);
        PSP_DEVICE_INTERFACE_DETAIL_DATA_W pdidd = reinterpret_cast<PSP_DEVICE_INTERFACE_DETAIL_DATA_W>(buf.data());
        pdidd->cbSize = sizeof(SP_DEVICE_INTERFACE_DETAIL_DATA_W);

        if (SetupDiGetDeviceInterfaceDetailW(hdev, &did, pdidd, size, &size, NULL)) {
            HANDLE hBat = CreateFileW(pdidd->DevicePath, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
            if (hBat != INVALID_HANDLE_VALUE) {
                ULONG batteryTag = 0;
                DWORD dwOut = 0;

                if (DeviceIoControl(hBat, IOCTL_BATTERY_QUERY_TAG, NULL, 0, &batteryTag, sizeof(batteryTag), &dwOut, NULL) && batteryTag) {
                    BATTERY_WAIT_STATUS bws = {0};
                    bws.BatteryTag = batteryTag;

                    BATTERY_STATUS bs = {0};
                    if (DeviceIoControl(hBat, IOCTL_BATTERY_QUERY_STATUS, &bws, sizeof(bws), &bs, sizeof(bs), &dwOut, NULL)) {
                        if (bs.Rate != BATTERY_UNKNOWN_RATE && bs.Rate != 0) {
                            double watts = static_cast<double>(abs(bs.Rate)) / 1000.0;
                            if (bs.PowerState & BATTERY_DISCHARGING) {
                                out_draw_watts += watts;
                            } else if (bs.PowerState & BATTERY_CHARGING) {
                                out_charge_watts += watts;
                            }
                        }
                        // Store voltage (mV -> V)
                        if (bs.Voltage != BATTERY_UNKNOWN_VOLTAGE) {
                            g_battery_voltage = static_cast<double>(bs.Voltage) / 1000.0;
                        }
                    }

                    // Query battery information (design capacity, full charge, cycles)
                    BATTERY_QUERY_INFORMATION bqi = {0};
                    bqi.BatteryTag = batteryTag;
                    bqi.InformationLevel = BatteryInformation;

                    BATTERY_INFORMATION bi = {0};
                    if (DeviceIoControl(hBat, IOCTL_BATTERY_QUERY_INFORMATION, &bqi, sizeof(bqi), &bi, sizeof(bi), &dwOut, NULL)) {
                        g_battery_design_capacity_mwh = bi.DesignedCapacity;
                        g_battery_full_charge_capacity_mwh = bi.FullChargedCapacity;
                        g_battery_cycle_count = bi.CycleCount;
                    }
                }
                CloseHandle(hBat);
            }
        }
    }
    SetupDiDestroyDeviceInfoList(hdev);
}

// ---------------------------------------------------------------------------
// get_performance_snapshot
// ---------------------------------------------------------------------------

extern "C" DLL_EXPORT int32_t get_performance_snapshot(PerformanceSnapshot* snapshot) {
    if (!snapshot) return -1;

    memset(snapshot, 0, sizeof(PerformanceSnapshot));

    init_perf_counters();

    // Collect PDH data
    if (g_perfQuery) {
        PdhCollectQueryData(g_perfQuery);
    }

    // ----- CPU -----
    SYSTEM_INFO sysInfo;
    GetSystemInfo(&sysInfo);
    snapshot->core_count = sysInfo.dwNumberOfProcessors;

    // Thread count from GetPerformanceInfo
    PERFORMANCE_INFORMATION perfInfo;
    perfInfo.cb = sizeof(perfInfo);
    if (GetPerformanceInfo(&perfInfo, sizeof(perfInfo))) {
        snapshot->thread_total_count = static_cast<uint32_t>(perfInfo.ThreadCount);
        snapshot->process_count = static_cast<uint32_t>(perfInfo.ProcessCount);
        snapshot->handle_count = static_cast<uint32_t>(perfInfo.HandleCount);

        // Memory from GetPerformanceInfo
        SIZE_T pageSize = perfInfo.PageSize;
        snapshot->committed_bytes = static_cast<uint64_t>(perfInfo.CommitTotal) * pageSize;
        snapshot->commit_limit_bytes = static_cast<uint64_t>(perfInfo.CommitLimit) * pageSize;
        snapshot->cached_bytes = static_cast<uint64_t>(perfInfo.SystemCache) * pageSize;
        snapshot->paged_pool_bytes = static_cast<uint64_t>(perfInfo.KernelPaged) * pageSize;
        snapshot->non_paged_pool_bytes = static_cast<uint64_t>(perfInfo.KernelNonpaged) * pageSize;
    }

    // Logical processor count as thread_count
    snapshot->thread_count = sysInfo.dwNumberOfProcessors;

    snapshot->cpu_usage_percent = perf_get_double(g_perfCpuCounter);
    if (snapshot->cpu_usage_percent > 100.0) snapshot->cpu_usage_percent = 100.0;

    snapshot->cpu_frequency_mhz = perf_get_double(g_perfCpuFreqCounter);

    double pct_of_max = perf_get_double(g_perfCpuMaxFreqCounter);
    if (pct_of_max > 0.0 && snapshot->cpu_frequency_mhz > 0.0) {
        snapshot->cpu_max_frequency_mhz = (snapshot->cpu_frequency_mhz / pct_of_max) * 100.0;
    } else {
        snapshot->cpu_max_frequency_mhz = snapshot->cpu_frequency_mhz;
    }

    // Base speed from registry (nominal clock, not turbo)
    {
        DWORD baseMhz = 0;
        DWORD size = sizeof(baseMhz);
        if (RegGetValueW(HKEY_LOCAL_MACHINE,
                L"HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0",
                L"~MHz", RRF_RT_REG_DWORD, nullptr, &baseMhz, &size) == ERROR_SUCCESS) {
            snapshot->cpu_base_frequency_mhz = static_cast<double>(baseMhz);
        } else {
            snapshot->cpu_base_frequency_mhz = snapshot->cpu_max_frequency_mhz;
        }
    }

    // ----- Memory -----
    MEMORYSTATUSEX memStatus;
    memStatus.dwLength = sizeof(memStatus);
    if (GlobalMemoryStatusEx(&memStatus)) {
        snapshot->total_ram_bytes = memStatus.ullTotalPhys;
        snapshot->available_ram_bytes = memStatus.ullAvailPhys;
        snapshot->used_ram_bytes = memStatus.ullTotalPhys - memStatus.ullAvailPhys;
    }

    // ----- Disk -----
    snapshot->disk_read_per_sec = perf_get_double(g_perfDiskReadCounter);
    snapshot->disk_write_per_sec = perf_get_double(g_perfDiskWriteCounter);
    snapshot->disk_active_percent = perf_get_double(g_perfDiskTimeCounter);
    if (snapshot->disk_active_percent > 100.0) snapshot->disk_active_percent = 100.0;
    snapshot->disk_queue_length = static_cast<uint64_t>(perf_get_double(g_perfDiskQueueCounter));

    // ----- Network -----
    snapshot->net_send_per_sec = perf_get_wildcard_sum(g_perfNetSendCounter);
    snapshot->net_recv_per_sec = perf_get_wildcard_sum(g_perfNetRecvCounter);
    snapshot->net_link_speed_bps = perf_get_wildcard_max(g_perfNetBandwidthCounter);

    // ----- GPU -----
    if (g_perfGpuAvailable) {
        snapshot->gpu_usage_percent = perf_get_wildcard_sum(g_perfGpuCounter);
        if (snapshot->gpu_usage_percent > 100.0) snapshot->gpu_usage_percent = 100.0;
    }
    if (g_perfGpuMemAvailable) {
        DWORD bufSize = 0, itemCount = 0;
        PDH_STATUS status = PdhGetFormattedCounterArray(g_perfGpuMemCounter, PDH_FMT_LARGE, &bufSize, &itemCount, nullptr);
        if (status == PDH_MORE_DATA && bufSize > 0) {
            std::vector<BYTE> buf(bufSize);
            auto* items = reinterpret_cast<PDH_FMT_COUNTERVALUE_ITEM_W*>(buf.data());
            status = PdhGetFormattedCounterArray(g_perfGpuMemCounter, PDH_FMT_LARGE, &bufSize, &itemCount, items);
            if (status == ERROR_SUCCESS) {
                uint64_t totalMem = 0;
                for (DWORD i = 0; i < itemCount; i++) {
                    totalMem += static_cast<uint64_t>(items[i].FmtValue.largeValue);
                }
                snapshot->gpu_memory_used = totalMem;
            }
        }
    }

    // ----- GPU Total VRAM + Temperature (via DXGI + D3DKMT) -----
    // Enumerate all adapters, pick the one with the most dedicated VRAM,
    // then query its temperature via D3DKMTQueryAdapterInfo
    {
        IDXGIFactory* factory = nullptr;
        if (SUCCEEDED(CreateDXGIFactory(__uuidof(IDXGIFactory), (void**)&factory))) {
            IDXGIAdapter* adapter = nullptr;
            uint64_t bestVram = 0;
            LUID bestLuid = {};
            for (UINT i = 0; factory->EnumAdapters(i, &adapter) != DXGI_ERROR_NOT_FOUND; i++) {
                DXGI_ADAPTER_DESC desc;
                if (SUCCEEDED(adapter->GetDesc(&desc))) {
                    uint64_t vram = static_cast<uint64_t>(desc.DedicatedVideoMemory);
                    if (vram > bestVram) {
                        bestVram = vram;
                        bestLuid = desc.AdapterLuid;
                    }
                }
                adapter->Release();
            }
            snapshot->gpu_memory_total = bestVram;
            factory->Release();

            // Query temperature from the best adapter
            if (bestVram > 0) {
                double temp = query_gpu_temperature(bestLuid);
                if (temp > 0.0 && temp < 200.0) {
                    snapshot->gpu_temperature = temp;
                }
            }
        }
    }

    // ----- Battery / Power -----
    SYSTEM_POWER_STATUS powerStatus;
    if (GetSystemPowerStatus(&powerStatus)) {
        if (powerStatus.BatteryLifePercent != 255)
            snapshot->battery_percent = static_cast<double>(powerStatus.BatteryLifePercent);
        else
            snapshot->battery_percent = 100.0;

        snapshot->is_charging = (powerStatus.ACLineStatus == 1) ? 1 : 0;

        if (powerStatus.BatteryLifeTime != (DWORD)-1)
            snapshot->battery_time_remaining = static_cast<int32_t>(powerStatus.BatteryLifeTime);
        else
            snapshot->battery_time_remaining = -1;

        // 1. Get real-time wattage from IOCTL
        double ioctl_draw = 0.0, ioctl_charge = 0.0;
        get_battery_wattage(ioctl_draw, ioctl_charge);

        // 2. Fallback to estimation from percentage change
        ULONGLONG now = GetTickCount64ULL();
        double currentPct = snapshot->battery_percent;
        double estimated_battery_draw = 0.0;

        if (g_prev_battery_percent >= 0.0 && g_prev_battery_tick > 0) {
            ULONGLONG elapsed_ms = now - g_prev_battery_tick;
            if (elapsed_ms > 1000) {
                double delta_pct = g_prev_battery_percent - currentPct;
                double elapsed_hours = static_cast<double>(elapsed_ms) / 3600000.0;
                if (elapsed_hours > 0.0) {
                    const double battery_capacity_wh = 50.0;
                    estimated_battery_draw = (delta_pct / 100.0) * battery_capacity_wh / elapsed_hours;
                    if (estimated_battery_draw < 0.0) estimated_battery_draw = 0.0;
                }
            }
        }
        g_prev_battery_percent = currentPct;
        g_prev_battery_tick = now;

        // 3. System usage estimate (CPU-based) - baseline for all modes
        double system_usage_estimate = (snapshot->cpu_usage_percent / 100.0) * 15.0 + 5.0; // 5W base + 15W TDP scaling

        // Logic: prefer IOCTL if non-zero, otherwise fallback to battery-drain-rate estimation, 
        // and finally baseline usage (especially for AC)
        if (ioctl_draw > 0.01) {
            snapshot->power_draw_watts = ioctl_draw;
        } else if (snapshot->is_charging) {
            snapshot->power_draw_watts = system_usage_estimate;
        } else if (estimated_battery_draw > 0.01) {
            g_estimated_power_watts = g_estimated_power_watts * 0.8 + estimated_battery_draw * 0.2;
            snapshot->power_draw_watts = g_estimated_power_watts;
        } else {
            snapshot->power_draw_watts = system_usage_estimate;
        }

        if (ioctl_charge > 0.01) {
            snapshot->charge_rate_watts = ioctl_charge;
        } else {
            snapshot->charge_rate_watts = 0.0;
        }
    } else {
        snapshot->battery_percent = 100.0;
        snapshot->is_charging = 0;
        snapshot->power_draw_watts = 0.0;
        snapshot->charge_rate_watts = 0.0;
        snapshot->battery_time_remaining = -1;
    }

    // Battery health info (from cached IOCTL results)
    snapshot->battery_design_capacity_mwh = g_battery_design_capacity_mwh;
    snapshot->battery_full_charge_capacity_mwh = g_battery_full_charge_capacity_mwh;
    snapshot->battery_cycle_count = g_battery_cycle_count;
    snapshot->battery_voltage = g_battery_voltage;

    return 0;
}
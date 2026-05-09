#include "process_info.h"
#include "network_power_estimate.h"

#include <string>

extern "C" void npu_collect_and_fill_snapshot(PerformanceSnapshot* snapshot);

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
#include <dxgi1_4.h>
#include <shlwapi.h>
#include <intrin.h>
#include <comdef.h>
#include <Wbemidl.h>
#include <powerbase.h>
// battery_devices.h pulls windows.h; include after initguid.h has done its
// DEFINE_GUID setup so we don't preempt the preprocessor state.
#include "battery_devices.h"
#include "gpu_engine_util.h"
#pragma comment(lib, "shlwapi.lib")
#pragma comment(lib, "wbemuuid.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "oleaut32.lib")
#pragma comment(lib, "powrprof.lib")

// PROCESSOR_POWER_INFORMATION isn't pulled in by powerbase.h on every SDK
// version, so declare it locally — same layout as the published struct.
typedef struct _PROCESSOR_POWER_INFORMATION_LOCAL {
    ULONG Number;
    ULONG MaxMhz;
    ULONG CurrentMhz;
    ULONG MhzLimit;
    ULONG MaxIdleState;
    ULONG CurrentIdleState;
} PROCESSOR_POWER_INFORMATION_LOCAL;

// Read the SMBIOS DMI Type 4 (Processor Information) "Max Speed" field. The
// BIOS publishes the silicon-rated max frequency here, which on AMD systems
// is usually the true turbo cap (since CPUID leaf 0x16 doesn't exist on AMD).
// Returns 0 on parse failure.
//
// SMBIOS layout: GetSystemFirmwareTable('RSMB', ...) returns a RawSMBIOSData
// header (8 bytes) followed by a sequence of DMI structures. Each structure
// starts with a 4-byte header { Type, Length, Handle(2) }, then `Length-4`
// bytes of formatted data, then a string-pool terminated by 0x00 0x00.
static unsigned int read_smbios_max_mhz() {
    DWORD size = GetSystemFirmwareTable('RSMB', 0, nullptr, 0);
    if (size == 0) return 0;

    std::vector<BYTE> buf(size);
    if (GetSystemFirmwareTable('RSMB', 0, buf.data(), size) != size) return 0;
    if (buf.size() < 8) return 0;

    // Skip the 8-byte RawSMBIOSData header (Used20CallingMethod, Major,
    // Minor, DmiRevision, Length).
    const BYTE* p = buf.data() + 8;
    const BYTE* end = buf.data() + buf.size();

    unsigned int best = 0;
    while (p + 4 <= end) {
        BYTE type = p[0];
        BYTE len  = p[1];
        if (len < 4 || p + len > end) break;

        // Type 4 = Processor Information. "Max Speed" is a 2-byte WORD at
        // offset 0x14 (per SMBIOS spec). Take the largest value across all
        // processor structures (multi-socket systems).
        if (type == 4 && len >= 0x16) {
            unsigned int max_mhz =
                static_cast<unsigned int>(p[0x14]) |
                (static_cast<unsigned int>(p[0x15]) << 8);
            if (max_mhz > best) best = max_mhz;
        }

        // Skip past the formatted area, then the string pool (terminated by
        // a double-null).
        const BYTE* q = p + len;
        while (q + 1 < end && !(q[0] == 0 && q[1] == 0)) q++;
        q += 2;  // consume the double-null
        if (q <= p) break;  // safety
        p = q;
    }
    return best;
}

// Observed high-water mark across the lifetime of the process. Updated each
// tick as a fallback for systems where neither CPUID leaf 0x16 nor SMBIOS
// reports a sensible max.
static double g_observed_max_mhz = 0.0;

// Static CPU topology — sockets, L1d/L1i/L2/L3 cache totals (in KB). Queried
// once via GetLogicalProcessorInformationEx and cached for the process
// lifetime. Cache numbers sum across all caches at each level (so on an 8c/8t
// part with 8× 32 KB L1d, total l1d_cache_kb = 256). For consumer use this
// matches what every spec sheet shows.
struct CpuTopology {
    uint32_t sockets = 0;
    uint32_t l1d_kb = 0;
    uint32_t l1i_kb = 0;
    uint32_t l2_kb = 0;
    uint32_t l3_kb = 0;
};

static const CpuTopology& get_cpu_topology() {
    static CpuTopology cached;
    static bool queried = false;
    if (queried) return cached;
    queried = true;

    auto query_relation = [](LOGICAL_PROCESSOR_RELATIONSHIP rel,
                             std::vector<BYTE>& buf) -> bool {
        DWORD len = 0;
        GetLogicalProcessorInformationEx(rel, nullptr, &len);
        if (len == 0) return false;
        buf.resize(len);
        return GetLogicalProcessorInformationEx(
            rel,
            reinterpret_cast<SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX*>(buf.data()),
            &len) != FALSE;
    };

    // --- Sockets (RelationProcessorPackage) ---
    {
        std::vector<BYTE> buf;
        if (query_relation(RelationProcessorPackage, buf)) {
            BYTE* p = buf.data();
            BYTE* end = p + buf.size();
            while (p + sizeof(SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX) <= end) {
                auto* info = reinterpret_cast<SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX*>(p);
                if (info->Relationship == RelationProcessorPackage) cached.sockets++;
                if (info->Size == 0) break;
                p += info->Size;
            }
        }
    }
    if (cached.sockets == 0) cached.sockets = 1;

    // --- Caches (RelationCache) ---
    {
        std::vector<BYTE> buf;
        if (query_relation(RelationCache, buf)) {
            BYTE* p = buf.data();
            BYTE* end = p + buf.size();
            while (p + sizeof(SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX) <= end) {
                auto* info = reinterpret_cast<SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX*>(p);
                if (info->Relationship == RelationCache) {
                    const auto& c = info->Cache;
                    uint32_t kb = c.CacheSize / 1024;
                    switch (c.Level) {
                        case 1:
                            if (c.Type == CacheData || c.Type == CacheUnified)
                                cached.l1d_kb += kb;
                            else if (c.Type == CacheInstruction)
                                cached.l1i_kb += kb;
                            break;
                        case 2: cached.l2_kb += kb; break;
                        case 3: cached.l3_kb += kb; break;
                    }
                }
                if (info->Size == 0) break;
                p += info->Size;
            }
        }
    }

    return cached;
}

// One-shot query: the turbo cap is constant for a given CPU, so we cache it
// on first call. Returns 0 on failure — callers should fall back to base.
//
// Strategy (best → worst):
//   1. CPUID leaf 0x16 (Intel Skylake+): EBX[15:0] = max frequency in MHz.
//      Read straight from the silicon, so it reports true turbo cap
//      regardless of what the OS thinks. Returns 0 on AMD / pre-Skylake.
//   2. SMBIOS DMI Type 4 "Max Speed" — published by the BIOS. On AMD this
//      is usually the spec turbo (e.g. 4.4 GHz on a 5800H). On Intel it
//      sometimes matches CPUID 0x16 and sometimes overshoots (turbo
//      headroom marketing). We sanity-cap it later via the observed max.
//   3. CallNtPowerInformation(ProcessorInformation).MaxMhz — Windows often
//      reports the base frequency here, so it's only a weak fallback.
//   4. Observed high-water mark of current_mhz — self-corrects upward as
//      the CPU hits turbo during the session.
static double get_cpu_max_turbo_mhz() {
    static double cached_max = 0.0;
    static bool queried = false;
    if (queried) return cached_max;
    queried = true;

    // --- 1. CPUID leaf 0x16 (Intel only) ---
    int regs[4] = {0, 0, 0, 0};
    __cpuid(regs, 0);                      // leaf 0 → max supported leaf in EAX
    unsigned int max_leaf = static_cast<unsigned int>(regs[0]);
    if (max_leaf >= 0x16) {
        __cpuid(regs, 0x16);
        unsigned int base_mhz_cpuid = static_cast<unsigned int>(regs[0]) & 0xFFFF;
        unsigned int max_mhz_cpuid  = static_cast<unsigned int>(regs[1]) & 0xFFFF;
        if (max_mhz_cpuid > 0 && max_mhz_cpuid >= base_mhz_cpuid) {
            cached_max = static_cast<double>(max_mhz_cpuid);
            return cached_max;
        }
    }

    // --- 2. SMBIOS DMI Type 4 Max Speed (works on AMD) ---
    unsigned int smbios_mhz = read_smbios_max_mhz();
    if (smbios_mhz > 0) {
        cached_max = static_cast<double>(smbios_mhz);
        return cached_max;
    }

    // --- 3. CallNtPowerInformation fallback (often returns base, not turbo) ---
    SYSTEM_INFO si{};
    GetSystemInfo(&si);
    DWORD cpu_count = si.dwNumberOfProcessors;
    if (cpu_count > 0) {
        std::vector<PROCESSOR_POWER_INFORMATION_LOCAL> info(cpu_count);
        LONG status = CallNtPowerInformation(
            ProcessorInformation,
            nullptr, 0,
            info.data(),
            static_cast<ULONG>(info.size() * sizeof(PROCESSOR_POWER_INFORMATION_LOCAL)));
        if (status == 0) {
            ULONG max_mhz = 0;
            for (const auto& p : info) {
                if (p.MaxMhz > max_mhz) max_mhz = p.MaxMhz;
            }
            if (max_mhz > 0) {
                cached_max = static_cast<double>(max_mhz);
                return cached_max;
            }
        }
    }

    return 0.0;  // caller falls back to base
}

// Get CPU brand string via CPUID (leaves 0x80000002..0x80000004). Writes up to
// 48 bytes of brand text plus a null terminator into `out` (caller must supply
// at least 49 bytes). The string may be internally padded with spaces.
static void read_cpu_brand(char* out, size_t out_size) {
    if (!out || out_size == 0) return;
    out[0] = '\0';

    int regs[4] = {0};
    __cpuid(regs, 0x80000000);
    if (static_cast<unsigned int>(regs[0]) < 0x80000004) return;

    char brand[49] = {0};
    for (int i = 0; i < 3; i++) {
        __cpuid(regs, 0x80000002 + i);
        memcpy(brand + i * 16, regs, 16);
    }
    brand[48] = '\0';

    // Trim leading whitespace
    char* start = brand;
    while (*start == ' ') start++;
    // Trim trailing whitespace
    size_t len = strlen(start);
    while (len > 0 && (start[len - 1] == ' ' || start[len - 1] == '\t')) {
        start[--len] = '\0';
    }

    strncpy_s(out, out_size, start, _TRUNCATE);
}

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

// Queries GPU per-adapter perf data via D3DKMT. `out_temp_c` receives the
// temperature in °C (0.0 if unavailable) and `out_fan_rpm` receives the GPU
// fan RPM (0 if not reported — integrated GPUs typically report 0 since they
// share the CPU cooler).
static void query_gpu_perfdata(LUID adapterLuid, double* out_temp_c, uint32_t* out_fan_rpm) {
    if (out_temp_c) *out_temp_c = 0.0;
    if (out_fan_rpm) *out_fan_rpm = 0;

    load_d3dkmt();
    if (!pfnOpenAdapter || !pfnCloseAdapter || !pfnQueryAdapterInfo) return;

    D3DKMT_OPENADAPTERFROMLUID openParams = {};
    openParams.AdapterLuid = adapterLuid;
    if (pfnOpenAdapter(&openParams) != 0) return;

    D3DKMT_ADAPTER_PERFDATA perfData = {};
    perfData.PhysicalAdapterIndex = 0;
    D3DKMT_QUERYADAPTERINFO queryInfo = {};
    queryInfo.hAdapter = openParams.hAdapter;
    queryInfo.Type = KMTQAITYPE_ADAPTERPERFDATA;
    queryInfo.pPrivateDriverData = &perfData;
    queryInfo.PrivateDriverDataSize = sizeof(perfData);

    if (pfnQueryAdapterInfo(&queryInfo) == 0) {
        if (out_temp_c) *out_temp_c = static_cast<double>(perfData.Temperature) / 10.0;
        if (out_fan_rpm) *out_fan_rpm = perfData.FanRPM;
    }

    D3DKMT_CLOSEADAPTER closeParams = {};
    closeParams.hAdapter = openParams.hAdapter;
    pfnCloseAdapter(&closeParams);
}

static double query_gpu_temperature(LUID adapterLuid) {
    double t = 0.0;
    query_gpu_perfdata(adapterLuid, &t, nullptr);
    return t;
}

// ---------------------------------------------------------------------------
// WMI fan speed fallback (Win32_Fan + LibreHardwareMonitor)
// ---------------------------------------------------------------------------
// Win32_Fan's DesiredSpeed is theoretically RPM but most laptops return 0
// or NULL. If LibreHardwareMonitor / OpenHardwareMonitor is running, their
// WMI namespace exposes actual sensor readings. Result is cached for a few
// seconds to avoid the ~10-30 ms WMI overhead per snapshot.
static int32_t g_fan_cache_rpm = -1;
static DWORD g_fan_cache_tick = 0;
static const DWORD FAN_CACHE_MS = 3000;

// Query one namespace/class/property combination. Returns the maximum value
// found across all returned rows, or -1 if nothing usable. `prop_is_string`
// true means the value is a decimal string (LHM uses VT_BSTR for some fields).
static int32_t query_wmi_int_prop(
    const wchar_t* ns,
    const wchar_t* query,
    const wchar_t* prop,
    bool prop_is_string)
{
    int32_t best = -1;

    HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    bool did_init = (hr == S_OK);
    if (FAILED(hr) && hr != RPC_E_CHANGED_MODE && hr != S_FALSE) return -1;

    IWbemLocator* pLoc = nullptr;
    IWbemServices* pSvc = nullptr;
    IEnumWbemClassObject* pEnum = nullptr;

    hr = CoCreateInstance(CLSID_WbemLocator, nullptr, CLSCTX_INPROC_SERVER,
                          IID_IWbemLocator, reinterpret_cast<void**>(&pLoc));
    if (FAILED(hr) || !pLoc) goto done;

    hr = pLoc->ConnectServer(_bstr_t(ns), nullptr, nullptr, nullptr, 0,
                             nullptr, nullptr, &pSvc);
    if (FAILED(hr) || !pSvc) goto done;

    CoSetProxyBlanket(pSvc, RPC_C_AUTHN_WINNT, RPC_C_AUTHZ_NONE, nullptr,
                      RPC_C_AUTHN_LEVEL_CALL, RPC_C_IMP_LEVEL_IMPERSONATE,
                      nullptr, EOAC_NONE);

    hr = pSvc->ExecQuery(_bstr_t(L"WQL"), _bstr_t(query),
                         WBEM_FLAG_FORWARD_ONLY | WBEM_FLAG_RETURN_IMMEDIATELY,
                         nullptr, &pEnum);
    if (FAILED(hr) || !pEnum) goto done;

    for (;;) {
        IWbemClassObject* pObj = nullptr;
        ULONG returned = 0;
        if (pEnum->Next(WBEM_INFINITE, 1, &pObj, &returned) != S_OK || returned == 0) break;

        VARIANT v;
        VariantInit(&v);
        if (SUCCEEDED(pObj->Get(prop, 0, &v, nullptr, nullptr))) {
            int32_t val = -1;
            if (v.vt == VT_I4) val = v.lVal;
            else if (v.vt == VT_UI4) val = static_cast<int32_t>(v.ulVal);
            else if (v.vt == VT_I2) val = v.iVal;
            else if (v.vt == VT_UI2) val = v.uiVal;
            else if (v.vt == VT_R4) val = static_cast<int32_t>(v.fltVal);
            else if (v.vt == VT_R8) val = static_cast<int32_t>(v.dblVal);
            else if (prop_is_string && v.vt == VT_BSTR && v.bstrVal) {
                val = _wtoi(v.bstrVal);
            }
            if (val > 0 && val < 50000 && val > best) best = val;
        }
        VariantClear(&v);
        pObj->Release();
    }

done:
    if (pEnum) pEnum->Release();
    if (pSvc) pSvc->Release();
    if (pLoc) pLoc->Release();
    if (did_init) CoUninitialize();
    return best;
}

static int32_t query_system_fan_rpm() {
    DWORD now = GetTickCount();
    if (g_fan_cache_tick != 0 && (now - g_fan_cache_tick) < FAN_CACHE_MS) {
        return g_fan_cache_rpm;
    }

    int32_t rpm = -1;

    // 1) LibreHardwareMonitor (if running) — most reliable on laptops
    rpm = query_wmi_int_prop(
        L"ROOT\\LibreHardwareMonitor",
        L"SELECT Value, SensorType FROM Sensor WHERE SensorType='Fan'",
        L"Value",
        false);

    // 2) OpenHardwareMonitor (older, same schema)
    if (rpm <= 0) {
        rpm = query_wmi_int_prop(
            L"ROOT\\OpenHardwareMonitor",
            L"SELECT Value, SensorType FROM Sensor WHERE SensorType='Fan'",
            L"Value",
            false);
    }

    // 3) Standard Win32_Fan DesiredSpeed — rarely populated but free.
    if (rpm <= 0) {
        rpm = query_wmi_int_prop(
            L"ROOT\\CIMV2",
            L"SELECT DesiredSpeed FROM Win32_Fan",
            L"DesiredSpeed",
            false);
    }

    g_fan_cache_rpm = rpm;
    g_fan_cache_tick = now;
    return rpm;
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
static const ULONG SystemMemoryListInformation = 80;

// Matches ntdll's SYSTEM_MEMORY_LIST_INFORMATION (undocumented but stable since Vista).
// Priorities 0-7 rank how eagerly Windows will evict standby pages under pressure.
typedef struct _SYSTEM_MEMORY_LIST_INFORMATION {
    ULONG_PTR ZeroPageCount;
    ULONG_PTR FreePageCount;
    ULONG_PTR ModifiedPageCount;
    ULONG_PTR ModifiedNoWritePageCount;
    ULONG_PTR BadPageCount;
    ULONG_PTR PageCountByPriority[8];
    ULONG_PTR RepurposedPagesByPriority[8];
    ULONG_PTR ModifiedPageCountPageFile;
} SYSTEM_MEMORY_LIST_INFORMATION;

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
static PDH_HCOUNTER g_perfGpuMemCounter = nullptr;          // GPU Process Memory \ Dedicated Usage (per-process)
static PDH_HCOUNTER g_perfGpuSharedMemCounter = nullptr;    // GPU Process Memory \ Shared Usage    (per-process)
static PDH_HCOUNTER g_perfGpuAdapterDedCounter = nullptr;   // GPU Adapter Memory \ Dedicated Usage (per-adapter aggregate)
static PDH_HCOUNTER g_perfGpuAdapterShrCounter = nullptr;   // GPU Adapter Memory \ Shared Usage    (per-adapter aggregate)
static bool g_perfInitialized = false;
static bool g_perfGpuAvailable = false;
static bool g_perfGpuMemAvailable = false;
static bool g_perfGpuSharedMemAvailable = false;
static bool g_perfGpuAdapterDedAvailable = false;
static bool g_perfGpuAdapterShrAvailable = false;

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

    // "Processor Frequency" reports the nominal/static clock — it does NOT
    // track turbo. For a live current-MHz readout that matches Task Manager,
    // we need "% Processor Performance" (can exceed 100 % during turbo) and
    // multiply by the base frequency.
    PdhAddEnglishCounterW(g_perfQuery,
        L"\\Processor Information(_Total)\\% Processor Performance",
        0, &g_perfCpuFreqCounter);

    // Kept for legacy reasons but no longer used for the max-speed display.
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

    if (PdhAddEnglishCounterW(g_perfQuery,
            L"\\GPU Process Memory(*)\\Shared Usage",
            0, &g_perfGpuSharedMemCounter) == ERROR_SUCCESS) {
        g_perfGpuSharedMemAvailable = true;
    }

    // Per-adapter aggregate counters (these are the values Task Manager actually
    // displays on the GPU page). Instance names are exactly
    //   luid_0xHHHHHHHH_0xLLLLLLLL_phys_<N>
    // so the same LUID-substring sum helper works for them too.
    if (PdhAddEnglishCounterW(g_perfQuery,
            L"\\GPU Adapter Memory(*)\\Dedicated Usage",
            0, &g_perfGpuAdapterDedCounter) == ERROR_SUCCESS) {
        g_perfGpuAdapterDedAvailable = true;
    }

    if (PdhAddEnglishCounterW(g_perfQuery,
            L"\\GPU Adapter Memory(*)\\Shared Usage",
            0, &g_perfGpuAdapterShrCounter) == ERROR_SUCCESS) {
        g_perfGpuAdapterShrAvailable = true;
    }

    // Initial collection (required before counters return valid data)
    PdhCollectQueryData(g_perfQuery);
}

// Sum a GPU Process Memory(*)-family counter but only instances whose LUID in
// the instance name matches the supplied adapter LUID. Instance names look
// like: pid_<PID>_luid_0x<HIGHPART>_0x<LOWPART>_phys_<N>
static uint64_t perf_sum_gpu_mem_by_luid(PDH_HCOUNTER counter, LUID luid) {
    if (!counter) return 0;

    DWORD bufSize = 0, itemCount = 0;
    PDH_STATUS status = PdhGetFormattedCounterArray(counter, PDH_FMT_LARGE, &bufSize, &itemCount, nullptr);
    if (status != PDH_MORE_DATA || bufSize == 0) return 0;

    std::vector<BYTE> buf(bufSize);
    auto* items = reinterpret_cast<PDH_FMT_COUNTERVALUE_ITEM_W*>(buf.data());
    status = PdhGetFormattedCounterArray(counter, PDH_FMT_LARGE, &bufSize, &itemCount, items);
    if (status != ERROR_SUCCESS) return 0;

    wchar_t expected[64];
    swprintf_s(expected, L"luid_0x%08lX_0x%08lX",
               static_cast<unsigned long>(luid.HighPart),
               static_cast<unsigned long>(luid.LowPart));

    uint64_t total = 0;
    for (DWORD i = 0; i < itemCount; i++) {
        const wchar_t* name = items[i].szName;
        if (!name) continue;
        // Case-insensitive substring match on the LUID portion
        if (StrStrIW(name, expected) != nullptr) {
            int64_t val = items[i].FmtValue.largeValue;
            if (val > 0) total += static_cast<uint64_t>(val);
        }
    }
    return total;
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

// Accumulates current capacity and full-charge capacity across all system
// batteries so that a single percentage can be reported even on multi-battery
// laptops. Returns a negative value if no valid IOCTL reading was obtained.
static void get_battery_wattage(double& out_draw_watts, double& out_charge_watts, double& out_percent) {
    out_draw_watts = 0.0;
    out_charge_watts = 0.0;
    out_percent = -1.0;

    uint64_t total_current_mwh = 0;
    uint64_t total_full_mwh = 0;

    // Cached enumeration (30s TTL) — see battery_devices.h. Replaces a
    // SetupDiGetClassDevs / SetupDiEnumDeviceInterfaces walk that ran
    // every snapshot tick.
    std::vector<std::wstring> paths;
    get_battery_device_paths(paths);

    bool any_create_failed = false;

    for (const auto& path : paths) {
        HANDLE hBat = CreateFileW(path.c_str(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
        if (hBat == INVALID_HANDLE_VALUE) {
            any_create_failed = true;
            continue;
        }
        ULONG batteryTag = 0;
        DWORD dwOut = 0;

        if (DeviceIoControl(hBat, IOCTL_BATTERY_QUERY_TAG, NULL, 0, &batteryTag, sizeof(batteryTag), &dwOut, NULL) && batteryTag) {
            BATTERY_WAIT_STATUS bws = {0};
            bws.BatteryTag = batteryTag;

            BATTERY_STATUS bs = {0};
            ULONG current_capacity = 0;
            bool have_capacity = false;
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
                if (bs.Capacity != BATTERY_UNKNOWN_CAPACITY) {
                    current_capacity = bs.Capacity;
                    have_capacity = true;
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

                if (have_capacity && bi.FullChargedCapacity > 0) {
                    total_current_mwh += current_capacity;
                    total_full_mwh += bi.FullChargedCapacity;
                }
            }
        }
        CloseHandle(hBat);
    }

    // Stale path → re-enumerate next call.
    if (any_create_failed) invalidate_battery_device_cache();

    if (total_full_mwh > 0) {
        double pct = (static_cast<double>(total_current_mwh) / static_cast<double>(total_full_mwh)) * 100.0;
        if (pct < 0.0) pct = 0.0;
        if (pct > 100.0) pct = 100.0;
        out_percent = pct;
    }
}

// ---------------------------------------------------------------------------
// get_performance_snapshot
// ---------------------------------------------------------------------------

extern "C" DLL_EXPORT int32_t get_performance_snapshot(PerformanceSnapshot* snapshot) {
    if (!snapshot) return -1;

    memset(snapshot, 0, sizeof(PerformanceSnapshot));
    snapshot->fan_rpm = -1; // -1 sentinel: unavailable

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

        // Static CPU topology — cached after first call.
        const CpuTopology& topo = get_cpu_topology();
        snapshot->socket_count = topo.sockets;
        snapshot->l1d_cache_kb = topo.l1d_kb;
        snapshot->l1i_cache_kb = topo.l1i_kb;
        snapshot->l2_cache_kb  = topo.l2_kb;
        snapshot->l3_cache_kb  = topo.l3_kb;

        // Memory from GetPerformanceInfo
        SIZE_T pageSize = perfInfo.PageSize;
        snapshot->committed_bytes = static_cast<uint64_t>(perfInfo.CommitTotal) * pageSize;
        snapshot->commit_limit_bytes = static_cast<uint64_t>(perfInfo.CommitLimit) * pageSize;
        snapshot->cached_bytes = static_cast<uint64_t>(perfInfo.SystemCache) * pageSize;
        snapshot->paged_pool_bytes = static_cast<uint64_t>(perfInfo.KernelPaged) * pageSize;
        snapshot->non_paged_pool_bytes = static_cast<uint64_t>(perfInfo.KernelNonpaged) * pageSize;

        // Standby list breakdown by priority.
        //   0-1 → "idle" / first to be evicted
        //   2-5 → "active" / recently touched
        //   6-7 → SuperFetch app-launch cache
        // Falls back to zeros if NtQuerySystemInformation is unavailable; the frontend
        // handles that by rolling back to a single combined "Cached Files" row.
        snapshot->cache_idle_bytes = 0;
        snapshot->cache_active_bytes = 0;
        snapshot->cache_launch_bytes = 0;
        snapshot->modified_pages_bytes = 0;
        ensure_ntdll();
        if (g_NtQuerySystemInformation) {
            SYSTEM_MEMORY_LIST_INFORMATION mli = {};
            ULONG retLen = 0;
            LONG st = g_NtQuerySystemInformation(
                SystemMemoryListInformation, &mli, sizeof(mli), &retLen);
            if (st >= 0) {
                uint64_t idle = 0, active = 0, launch = 0;
                for (int i = 0; i <= 1; ++i) idle   += mli.PageCountByPriority[i];
                for (int i = 2; i <= 5; ++i) active += mli.PageCountByPriority[i];
                for (int i = 6; i <= 7; ++i) launch += mli.PageCountByPriority[i];
                snapshot->cache_idle_bytes     = idle   * pageSize;
                snapshot->cache_active_bytes   = active * pageSize;
                snapshot->cache_launch_bytes   = launch * pageSize;
                snapshot->modified_pages_bytes =
                    (uint64_t)(mli.ModifiedPageCount + mli.ModifiedNoWritePageCount) * pageSize;
            }
        }
    }

    // Logical processor count as thread_count
    snapshot->thread_count = sysInfo.dwNumberOfProcessors;

    snapshot->cpu_usage_percent = perf_get_double(g_perfCpuCounter);
    if (snapshot->cpu_usage_percent > 100.0) snapshot->cpu_usage_percent = 100.0;

    // Base speed from registry first — needed to convert the performance
    // percent into a current-MHz figure. Constant for the life of the boot.
    static double cached_base_mhz = 0.0;
    if (cached_base_mhz == 0.0) {
        DWORD baseMhz = 0;
        DWORD size = sizeof(baseMhz);
        if (RegGetValueW(HKEY_LOCAL_MACHINE,
                L"HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0",
                L"~MHz", RRF_RT_REG_DWORD, nullptr, &baseMhz, &size) == ERROR_SUCCESS) {
            cached_base_mhz = static_cast<double>(baseMhz);
        }
    }
    snapshot->cpu_base_frequency_mhz = cached_base_mhz;

    // Live current MHz = base × (% Processor Performance / 100). This matches
    // Task Manager's "Speed" field and includes turbo.
    double perf_pct = perf_get_double(g_perfCpuFreqCounter);
    if (perf_pct > 0.0 && cached_base_mhz > 0.0) {
        snapshot->cpu_frequency_mhz = cached_base_mhz * perf_pct / 100.0;
    } else {
        snapshot->cpu_frequency_mhz = cached_base_mhz;
    }

    // Max speed: prefer the silicon-spec value (CPUID 0x16 → SMBIOS →
    // CallNtPowerInformation). If we have nothing, fall back to base.
    // Then ratchet upward by the highest current_mhz we've ever observed,
    // so on AMD systems where SMBIOS occasionally underreports we still
    // converge on the true turbo cap once the CPU bursts.
    if (snapshot->cpu_frequency_mhz > g_observed_max_mhz) {
        g_observed_max_mhz = snapshot->cpu_frequency_mhz;
    }
    double spec_max = get_cpu_max_turbo_mhz();
    double max_mhz = (spec_max > 0.0) ? spec_max : cached_base_mhz;
    if (g_observed_max_mhz > max_mhz) max_mhz = g_observed_max_mhz;
    snapshot->cpu_max_frequency_mhz = max_mhz;

    // CPU brand string (cached static — cpuid result doesn't change at runtime)
    static char s_cpu_name[128] = {0};
    static bool s_cpu_name_loaded = false;
    if (!s_cpu_name_loaded) {
        read_cpu_brand(s_cpu_name, sizeof(s_cpu_name));
        s_cpu_name_loaded = true;
    }
    strncpy_s(snapshot->cpu_name, sizeof(snapshot->cpu_name), s_cpu_name, _TRUNCATE);

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
    snapshot->network_power_watts = network_power_estimate_watts(
        snapshot->net_send_per_sec,
        snapshot->net_recv_per_sec,
        snapshot->net_link_speed_bps);

    // ----- GPU (DXGI best adapter first — same LUID as PDH engine + VRAM paths) -----
    PerfDxgiBestGpu dxgiBest = {};
    bool have_dxgi_gpu = perf_pick_best_dxgi_gpu(&dxgiBest);
    if (have_dxgi_gpu) {
        snapshot->gpu_memory_total = dxgiBest.dedicated_video_bytes;
        snapshot->gpu_shared_memory_total = dxgiBest.shared_system_bytes;
        snapshot->gpu_is_integrated = dxgiBest.is_integrated;
        if (dxgiBest.name[0]) {
            int n = WideCharToMultiByte(CP_UTF8, 0, dxgiBest.name, -1,
                                        snapshot->gpu_name,
                                        static_cast<int>(sizeof(snapshot->gpu_name)),
                                        nullptr, nullptr);
            if (n <= 0) snapshot->gpu_name[0] = '\0';
            else snapshot->gpu_name[sizeof(snapshot->gpu_name) - 1] = '\0';
        }
    }

    if (g_perfGpuAvailable) {
        const LUID* luidFilter = have_dxgi_gpu ? &dxgiBest.luid : nullptr;
        perf_aggregate_gpu_engine_util(g_perfGpuCounter, luidFilter,
            &snapshot->gpu_usage_percent,
            &snapshot->gpu_engine_sum_percent,
            &snapshot->gpu_usage_3d_percent,
            &snapshot->gpu_usage_compute_percent);
    }

    // ----- GPU VRAM used + temperature (same adapter LUID as above) -----
    bool dxgi_local_valid = false;
    bool dxgi_nonlocal_valid = false;
    if (have_dxgi_gpu) {
        LUID bestLuid = dxgiBest.luid;
        const uint64_t bestScore = dxgiBest.adapter_score;

            // VRAM usage: prefer the per-adapter PDH counters
            // (`\GPU Adapter Memory(luid_*)\{Dedicated,Shared} Usage`). These
            // are the exact same numbers Task Manager's GPU page displays —
            // aggregated by the OS across all processes for a single adapter.
            // DXGI's QueryVideoMemoryInfo has been unreliable on integrated
            // GPUs (it overshoots the BIOS carveout for LOCAL and rounds
            // weirdly for NON_LOCAL), so we skip it entirely and only fall back
            // to per-process sums if the adapter counter set isn't installed.
            if (g_perfGpuAdapterDedAvailable) {
                uint64_t dedicated_used = perf_sum_gpu_mem_by_luid(g_perfGpuAdapterDedCounter, bestLuid);
                if (snapshot->gpu_memory_total > 0 && dedicated_used > snapshot->gpu_memory_total) {
                    dedicated_used = snapshot->gpu_memory_total;
                }
                snapshot->gpu_memory_used = dedicated_used;
                dxgi_local_valid = true; // suppress per-process fallback below
            }
            if (g_perfGpuAdapterShrAvailable) {
                uint64_t shared_used = perf_sum_gpu_mem_by_luid(g_perfGpuAdapterShrCounter, bestLuid);
                if (snapshot->gpu_shared_memory_total > 0 && shared_used > snapshot->gpu_shared_memory_total) {
                    shared_used = snapshot->gpu_shared_memory_total;
                }
                snapshot->gpu_shared_memory_used = shared_used;
                dxgi_nonlocal_valid = true;
            }

            // Query temperature and fan RPM from the best adapter in one call.
            // D3DKMT_ADAPTER_PERFDATA exposes both Temperature and FanRPM, so
            // we grab them together to avoid opening the adapter twice.
            if (bestScore > 0) {
                double temp = 0.0;
                uint32_t gpuFan = 0;
                query_gpu_perfdata(bestLuid, &temp, &gpuFan);
                if (temp > 0.0 && temp < 200.0) {
                    snapshot->gpu_temperature = temp;
                }
                if (gpuFan > 0 && gpuFan < 50000) {
                    snapshot->fan_rpm = static_cast<int32_t>(gpuFan);
                }
            }
            // If the GPU driver doesn't report a fan (common on integrated
            // laptops), fall back to WMI sensors (LHM/OHM/Win32_Fan).
            if (snapshot->fan_rpm <= 0) {
                int32_t sysFan = query_system_fan_rpm();
                if (sysFan > 0) {
                    snapshot->fan_rpm = sysFan;
                }
            }

            // Fill any gap (or override) with PDH counters filtered by LUID.
            // Windows Task Manager itself uses these counters, so they're the
            // ground truth — particularly on UMA/integrated GPUs where
            // QueryVideoMemoryInfo can report 0 usage for both segments even
            // though memory is clearly in use.
            if (!dxgi_local_valid && g_perfGpuMemAvailable) {
                uint64_t dedicated_used = perf_sum_gpu_mem_by_luid(g_perfGpuMemCounter, bestLuid);
                // Clamp to the adapter-desc dedicated total. On integrated the
                // PDH sum can overshoot the BIOS carveout — the dedicated pool
                // in that case simply isn't meaningfully used, so capping to
                // the total gives a sensible display ("used ≈ total").
                if (snapshot->gpu_memory_total > 0 && dedicated_used > snapshot->gpu_memory_total) {
                    dedicated_used = snapshot->gpu_memory_total;
                }
                snapshot->gpu_memory_used = dedicated_used;
            }
            if (!dxgi_nonlocal_valid && g_perfGpuSharedMemAvailable) {
                uint64_t shared_used = perf_sum_gpu_mem_by_luid(g_perfGpuSharedMemCounter, bestLuid);
                if (snapshot->gpu_shared_memory_total > 0 && shared_used > snapshot->gpu_shared_memory_total) {
                    shared_used = snapshot->gpu_shared_memory_total;
                }
                snapshot->gpu_shared_memory_used = shared_used;
            }
    }
    bool dxgi_used_valid = dxgi_local_valid || dxgi_nonlocal_valid;

    // Fallback: if DXGI couldn't report live usage, sum the PDH dedicated-usage
    // counter but clamp to the total VRAM we reported so "used" never exceeds
    // "total" (which produced the "0 free" artifact).
    if (!dxgi_used_valid && g_perfGpuMemAvailable) {
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
                if (snapshot->gpu_memory_total > 0 && totalMem > snapshot->gpu_memory_total) {
                    totalMem = snapshot->gpu_memory_total;
                }
                snapshot->gpu_memory_used = totalMem;
            }
        }
    }

    npu_collect_and_fill_snapshot(snapshot);

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

        // 1. Get real-time wattage + accurate percent from IOCTL
        double ioctl_draw = 0.0, ioctl_charge = 0.0, ioctl_percent = -1.0;
        get_battery_wattage(ioctl_draw, ioctl_charge, ioctl_percent);

        // Prefer the IOCTL-derived percent when available — GetSystemPowerStatus
        // is notoriously inaccurate on some laptops (can report stale/fixed values
        // like 10%). The ACPI capacity reading is authoritative.
        if (ioctl_percent >= 0.0) {
            snapshot->battery_percent = ioctl_percent;
        }

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
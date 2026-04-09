#include "process_info.h"

#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <windows.h>
#include <winioctl.h>
#include <psapi.h>
#include <setupapi.h>
#include <devguid.h>
#include <batclass.h>
#include <pdh.h>
#include <comdef.h>
#include <Wbemidl.h>
#include <vector>
#include <unordered_map>
#include <string>
#include <cstring>
#include <cmath>
#include <algorithm>

#pragma comment(lib, "setupapi.lib")
#pragma comment(lib, "pdh.lib")
#pragma comment(lib, "wbemuuid.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "oleaut32.lib")

#ifndef PDH_MORE_DATA
#define PDH_MORE_DATA ((LONG)0x800007D2L)
#endif

// {72631E54-78A4-11D0-BCF7-00AA00B7B32A}
static const GUID GUID_DEVINTERFACE_BATTERY_PWR =
    { 0x72631e54, 0x78a4, 0x11d0, { 0xbc, 0xf7, 0x00, 0xaa, 0x00, 0xb7, 0xb3, 0x2a } };

// ---------------------------------------------------------------------------
// Battery IOCTL helper - returns real system power draw in watts, or a
// CPU-based estimate when IOCTL is unavailable (desktop, AC-only, etc.)
// ---------------------------------------------------------------------------
static double get_real_power_draw(double total_system_cpu_percent) {
    // Try IOCTL first
    HDEVINFO hdev = SetupDiGetClassDevsW(&GUID_DEVINTERFACE_BATTERY_PWR, 0, 0,
                                          DIGCF_PRESENT | DIGCF_DEVICEINTERFACE);
    if (hdev != INVALID_HANDLE_VALUE) {
        SP_DEVICE_INTERFACE_DATA did = {0};
        did.cbSize = sizeof(did);

        double total_watts = 0.0;
        bool got_reading = false;

        for (int i = 0; SetupDiEnumDeviceInterfaces(hdev, 0, &GUID_DEVINTERFACE_BATTERY_PWR, i, &did); i++) {
            DWORD size = 0;
            SetupDiGetDeviceInterfaceDetailW(hdev, &did, 0, 0, &size, NULL);
            if (GetLastError() != ERROR_INSUFFICIENT_BUFFER) continue;

            std::vector<BYTE> buf(size);
            PSP_DEVICE_INTERFACE_DETAIL_DATA_W pdidd =
                reinterpret_cast<PSP_DEVICE_INTERFACE_DETAIL_DATA_W>(buf.data());
            pdidd->cbSize = sizeof(SP_DEVICE_INTERFACE_DETAIL_DATA_W);

            if (SetupDiGetDeviceInterfaceDetailW(hdev, &did, pdidd, size, &size, NULL)) {
                HANDLE hBat = CreateFileW(pdidd->DevicePath,
                    GENERIC_READ | GENERIC_WRITE,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
                if (hBat != INVALID_HANDLE_VALUE) {
                    ULONG batteryTag = 0;
                    DWORD dwOut = 0;
                    if (DeviceIoControl(hBat, IOCTL_BATTERY_QUERY_TAG,
                            NULL, 0, &batteryTag, sizeof(batteryTag), &dwOut, NULL) && batteryTag) {
                        BATTERY_WAIT_STATUS bws = {0};
                        bws.BatteryTag = batteryTag;
                        BATTERY_STATUS bs = {0};
                        if (DeviceIoControl(hBat, IOCTL_BATTERY_QUERY_STATUS,
                                &bws, sizeof(bws), &bs, sizeof(bs), &dwOut, NULL)) {
                            if (bs.Rate != BATTERY_UNKNOWN_RATE && bs.Rate != 0) {
                                total_watts += static_cast<double>(abs(bs.Rate)) / 1000.0;
                                got_reading = true;
                            }
                        }
                    }
                    CloseHandle(hBat);
                }
            }
        }
        SetupDiDestroyDeviceInfoList(hdev);

        if (got_reading && total_watts > 0.01) {
            return total_watts;
        }
    }

    // Fallback: CPU-based estimate (base idle power + CPU proportional)
    return (total_system_cpu_percent / 100.0) * 15.0 + 5.0;
}

// ---------------------------------------------------------------------------
// Internal display brightness via WMI (ROOT\WMI\WmiMonitorBrightness)
// Returns -1 if unavailable, else 0-100.
// ---------------------------------------------------------------------------
static int g_brightness_cache = -2; // -2 = never queried yet
static ULONGLONG g_brightness_cache_tick = 0;

static int get_internal_display_brightness_percent() {
    const ULONGLONG kBrightnessCacheMs = 8000;
    ULONGLONG now = GetTickCount64();
    if (g_brightness_cache != -2 && (now - g_brightness_cache_tick) < kBrightnessCacheMs) {
        return g_brightness_cache;
    }

    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    bool did_init_com = false;
    if (hr == S_OK) {
        did_init_com = true;
    } else if (hr == S_FALSE) {
        // already initialized on this thread
    } else if (hr == RPC_E_CHANGED_MODE) {
        // different model; try STA for WMI
        hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
        if (hr == S_OK) did_init_com = true;
        else if (hr != S_FALSE) {
            g_brightness_cache = -1;
            g_brightness_cache_tick = now;
            return -1;
        }
    } else {
        g_brightness_cache = -1;
        g_brightness_cache_tick = now;
        return -1;
    }

    int result = -1;
    const long kWbemQueryFlags = 0x00000020L | 0x00000010L; // FORWARD_ONLY | RETURN_IMMEDIATE
    ULONG uReturn = 0;
    IWbemLocator* pLoc = nullptr;
    IWbemServices* pSvc = nullptr;
    IEnumWbemClassObject* pEnum = nullptr;
    IWbemClassObject* pObj = nullptr;

    hr = CoCreateInstance(CLSID_WbemLocator, nullptr, CLSCTX_INPROC_SERVER,
                          IID_IWbemLocator, reinterpret_cast<void**>(&pLoc));
    if (FAILED(hr) || !pLoc) goto cleanup;

    hr = pLoc->ConnectServer(_bstr_t(L"ROOT\\WMI"), nullptr, nullptr, nullptr, 0, nullptr, nullptr, &pSvc);
    if (FAILED(hr) || !pSvc) goto cleanup;

    hr = CoSetProxyBlanket(pSvc, RPC_C_AUTHN_WINNT, RPC_C_AUTHZ_NONE, nullptr,
                           RPC_C_AUTHN_LEVEL_CALL, RPC_C_IMP_LEVEL_IMPERSONATE, nullptr, EOAC_NONE);
    if (FAILED(hr)) goto cleanup;

    hr = pSvc->ExecQuery(
        _bstr_t(L"WQL"),
        _bstr_t(L"SELECT CurrentBrightness FROM WmiMonitorBrightness"),
        kWbemQueryFlags,
        nullptr, &pEnum);
    if (FAILED(hr) || !pEnum) goto cleanup;

    hr = pEnum->Next(WBEM_INFINITE, 1, &pObj, &uReturn);
    if (FAILED(hr) || uReturn == 0 || !pObj) goto cleanup;

    VARIANT vt;
    VariantInit(&vt);
    hr = pObj->Get(L"CurrentBrightness", 0, &vt, nullptr, nullptr);
    if (SUCCEEDED(hr) && vt.vt == VT_I4) {
        int b = vt.intVal;
        if (b >= 0 && b <= 100) result = b;
    }
    VariantClear(&vt);

cleanup:
    if (pObj) pObj->Release();
    if (pEnum) pEnum->Release();
    if (pSvc) pSvc->Release();
    if (pLoc) pLoc->Release();
    if (did_init_com) CoUninitialize();
    g_brightness_cache = result;
    g_brightness_cache_tick = now;
    return result;
}

// Backlight draw: ~1 W floor, up to ~8 W at full brightness (typical laptop panel).
static double estimate_screen_power_watts_from_brightness(int brightness_0_100) {
    if (brightness_0_100 < 0 || brightness_0_100 > 100) return 0.0;
    return 1.0 + (static_cast<double>(brightness_0_100) / 100.0) * 7.0;
}

// ---------------------------------------------------------------------------
// GPU Engine PDH (same counter set as gpu_telemetry.cpp)
// ---------------------------------------------------------------------------
static PDH_HQUERY g_powerGpuQuery = nullptr;
static PDH_HCOUNTER g_powerGpuCounter = nullptr;
static bool g_powerGpuPdhInit = false;
static bool g_powerGpuPdhOk = false;

static void init_power_gpu_pdh() {
    if (g_powerGpuPdhInit) return;
    g_powerGpuPdhInit = true;
    if (PdhOpenQueryW(nullptr, 0, &g_powerGpuQuery) != ERROR_SUCCESS) return;
    if (PdhAddEnglishCounterW(g_powerGpuQuery,
            L"\\GPU Engine(*)\\Utilization Percentage",
            0, &g_powerGpuCounter) == ERROR_SUCCESS) {
        PdhCollectQueryData(g_powerGpuQuery);
        g_powerGpuPdhOk = true;
    }
}

// Fills per-PID GPU utilization (sum of engine instances) and global sum (all instances).
static void collect_gpu_engine_usage(std::unordered_map<DWORD, double>& pid_gpu, double& global_engine_sum) {
    pid_gpu.clear();
    global_engine_sum = 0.0;
    init_power_gpu_pdh();
    if (!g_powerGpuPdhOk || !g_powerGpuQuery) return;

    if (PdhCollectQueryData(g_powerGpuQuery) != ERROR_SUCCESS) return;

    DWORD bufSize = 0;
    DWORD itemCount = 0;
    PDH_STATUS status = PdhGetFormattedCounterArray(
        g_powerGpuCounter, PDH_FMT_DOUBLE,
        &bufSize, &itemCount, nullptr);

    if (status != PDH_MORE_DATA || bufSize == 0) return;

    std::vector<BYTE> rawBuf(bufSize);
    auto* items = reinterpret_cast<PDH_FMT_COUNTERVALUE_ITEM_W*>(rawBuf.data());

    status = PdhGetFormattedCounterArray(
        g_powerGpuCounter, PDH_FMT_DOUBLE,
        &bufSize, &itemCount, items);

    if (status != ERROR_SUCCESS) return;

    for (DWORD i = 0; i < itemCount; i++) {
        double v = items[i].FmtValue.doubleValue;
        if (v < 0.0) v = 0.0;
        global_engine_sum += v;

        std::wstring name(items[i].szName);
        size_t pid_pos = name.find(L"pid_");
        if (pid_pos != std::wstring::npos) {
            DWORD pid = 0;
            try {
                pid = static_cast<DWORD>(std::stoul(name.substr(pid_pos + 4)));
            } catch (...) {
                continue;
            }
            if (pid > 0) {
                pid_gpu[pid] += v;
            }
        }
    }
    if (global_engine_sum > 100.0) global_engine_sum = 100.0;
}

struct ProcessCpuTimes {
    DWORD pid;
    ULONGLONG kernel_time;
    ULONGLONG user_time;
};

static std::vector<ProcessCpuTimes> g_prev_times;
static ULONGLONG g_prev_system_time = 0;
static bool g_has_previous = false;

static ULONGLONG FileTimeToULL(const FILETIME& ft) {
    return (static_cast<ULONGLONG>(ft.dwHighDateTime) << 32) | ft.dwLowDateTime;
}

static ULONGLONG GetSystemTimeAsULL() {
    FILETIME ft;
    GetSystemTimeAsFileTime(&ft);
    return FileTimeToULL(ft);
}

extern "C" DLL_EXPORT int32_t get_process_power_list(ProcessPowerInfo* buffer, int32_t max_count) {
    DWORD pids[1024];
    DWORD bytes_returned = 0;

    if (!EnumProcesses(pids, sizeof(pids), &bytes_returned)) {
        return 0;
    }

    DWORD num_processes = bytes_returned / sizeof(DWORD);

    // Count-only call: return count WITHOUT touching saved state
    if (buffer == nullptr) {
        return static_cast<int32_t>(num_processes);
    }

    SYSTEM_INFO sysInfo;
    GetSystemInfo(&sysInfo);
    int num_cpus = sysInfo.dwNumberOfProcessors;
    if (num_cpus < 1) num_cpus = 1;

    ULONGLONG current_system_time = GetSystemTimeAsULL();

    // Collect current CPU times
    std::vector<ProcessCpuTimes> current_times;
    current_times.reserve(num_processes);

    ULONGLONG total_proc_kernel = 0;
    ULONGLONG total_proc_user = 0;

    for (DWORD i = 0; i < num_processes; i++) {
        DWORD pid = pids[i];
        if (pid == 0) continue;

        HANDLE hProcess = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if (!hProcess) continue;

        FILETIME creation, exitFt, kernel, user;
        if (GetProcessTimes(hProcess, &creation, &exitFt, &kernel, &user)) {
            ProcessCpuTimes ct;
            ct.pid = pid;
            ct.kernel_time = FileTimeToULL(kernel);
            ct.user_time = FileTimeToULL(user);
            current_times.push_back(ct);

            total_proc_kernel += ct.kernel_time;
            total_proc_user += ct.user_time;
        }

        CloseHandle(hProcess);
    }

    SYSTEM_POWER_STATUS powerStatus;
    GetSystemPowerStatus(&powerStatus);
    // Always show real CPU-proportional battery impact regardless of charging state
    double discharge_multiplier = 1.0;

    int32_t filled = 0;

    if (g_has_previous && g_prev_system_time > 0) {
        ULONGLONG delta_system = current_system_time - g_prev_system_time;
        if (delta_system == 0) delta_system = 1;

        double total_cpu_time = static_cast<double>(delta_system) * num_cpus;

        ULONGLONG prev_total = 0;
        for (const auto& prev : g_prev_times)
            prev_total += prev.kernel_time + prev.user_time;
        ULONGLONG curr_total = total_proc_kernel + total_proc_user;
        ULONGLONG delta_all = (curr_total > prev_total) ? (curr_total - prev_total) : 1;

        // Compute total system CPU% across all processes for power distribution
        double total_cpu_percent_sum = 0.0;
        {
            // First pass: accumulate total CPU% for all processes
            for (size_t i = 0; i < current_times.size(); i++) {
                const auto& curr = current_times[i];
                ULONGLONG pk = 0, pu = 0;
                for (const auto& prev : g_prev_times) {
                    if (prev.pid == curr.pid) {
                        pk = prev.kernel_time;
                        pu = prev.user_time;
                        break;
                    }
                }
                ULONGLONG dp = 0;
                if (curr.kernel_time >= pk && curr.user_time >= pu)
                    dp = (curr.kernel_time - pk) + (curr.user_time - pu);
                double pct = (static_cast<double>(dp) / total_cpu_time) * 100.0;
                if (pct > 100.0) pct = 100.0;
                if (pct < 0.0) pct = 0.0;
                total_cpu_percent_sum += pct;
            }
            if (total_cpu_percent_sum < 0.01) total_cpu_percent_sum = 0.01;
        }

        // Get real system power draw (IOCTL or CPU-based fallback)
        double actual_system_watts = get_real_power_draw(total_cpu_percent_sum);

        // GPU engine usage (same sample as GPU tab)
        std::unordered_map<DWORD, double> pid_gpu;
        double global_gpu_sum = 0.0;
        collect_gpu_engine_usage(pid_gpu, global_gpu_sum);

        // Display backlight: subtract from allocatable pool so CPU share is not inflated
        int brightness_pct = get_internal_display_brightness_percent();
        double screen_watts = 0.0;
        if (brightness_pct >= 0) {
            screen_watts = estimate_screen_power_watts_from_brightness(brightness_pct);
            double max_screen = std::max(0.0, actual_system_watts * 0.4);
            if (screen_watts > max_screen) screen_watts = max_screen;
            if (screen_watts > actual_system_watts - 0.5) screen_watts = std::max(0.0, actual_system_watts - 0.5);
        }

        double R = actual_system_watts - screen_watts;
        if (R < 0.01) R = 0.01;

        // Split remaining power between CPU and GPU pools using global GPU activity (>= 5%)
        const double kGpuPoolMax = 0.85; // leave at least 15% for CPU when GPU is busy
        double P_cpu_budget = R;
        double P_gpu_budget = 0.0;
        if (global_gpu_sum >= 5.0) {
            double gpu_weight = (global_gpu_sum / 100.0) * kGpuPoolMax;
            if (gpu_weight > kGpuPoolMax) gpu_weight = kGpuPoolMax;
            P_gpu_budget = R * gpu_weight;
            P_cpu_budget = R - P_gpu_budget;
            if (P_cpu_budget < 0.0) P_cpu_budget = 0.0;
        }

        // Denominator for GPU allocation: only processes with GPU >= 5%
        double sum_gpu_qual = 0.0;
        for (const auto& kv : pid_gpu) {
            if (kv.second >= 5.0) sum_gpu_qual += kv.second;
        }
        if (sum_gpu_qual < 0.0001) {
            P_cpu_budget += P_gpu_budget;
            P_gpu_budget = 0.0;
        }

        for (size_t i = 0; i < current_times.size() && filled < max_count; i++) {
            const auto& curr = current_times[i];

            ULONGLONG prev_kernel = 0, prev_user = 0;
            for (const auto& prev : g_prev_times) {
                if (prev.pid == curr.pid) {
                    prev_kernel = prev.kernel_time;
                    prev_user = prev.user_time;
                    break;
                }
            }

            ULONGLONG delta_proc = 0;
            if (curr.kernel_time >= prev_kernel && curr.user_time >= prev_user)
                delta_proc = (curr.kernel_time - prev_kernel) + (curr.user_time - prev_user);

            double cpu_pct = (static_cast<double>(delta_proc) / total_cpu_time) * 100.0;
            if (cpu_pct > 100.0) cpu_pct = 100.0;
            if (cpu_pct < 0.0) cpu_pct = 0.0;

            double cpu_fraction = static_cast<double>(delta_proc) / static_cast<double>(delta_all);
            double battery_pct = cpu_fraction * 100.0 * discharge_multiplier;
            if (battery_pct > 100.0) battery_pct = 100.0;
            if (battery_pct < 0.0) battery_pct = 0.0;

            double cpu_watts = (cpu_pct / total_cpu_percent_sum) * P_cpu_budget;

            double gpu_watts = 0.0;
            if (P_gpu_budget > 0.0001 && global_gpu_sum >= 5.0 && sum_gpu_qual > 0.0001) {
                auto git = pid_gpu.find(curr.pid);
                if (git != pid_gpu.end() && git->second >= 5.0) {
                    gpu_watts = P_gpu_budget * (git->second / sum_gpu_qual);
                }
            }

            buffer[filled].pid = curr.pid;
            buffer[filled].cpu_percent = cpu_pct;
            buffer[filled].battery_percent = battery_pct;
            buffer[filled].energy_uj = static_cast<uint64_t>(delta_proc / 10);
            buffer[filled].power_watts = cpu_watts + gpu_watts;
            filled++;
        }
    } else {
        for (size_t i = 0; i < current_times.size() && filled < max_count; i++) {
            buffer[filled].pid = current_times[i].pid;
            buffer[filled].cpu_percent = 0.0;
            buffer[filled].battery_percent = 0.0;
            buffer[filled].energy_uj = 0;
            buffer[filled].power_watts = 0.0;
            filled++;
        }
    }

    // Only save state on fill calls (not count calls)
    g_prev_times = current_times;
    g_prev_system_time = current_system_time;
    g_has_previous = true;

    return filled;
}

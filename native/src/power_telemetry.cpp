#include "process_info.h"

#include <windows.h>
#include <winioctl.h>
#include <psapi.h>
#include <setupapi.h>
#include <devguid.h>
#include <batclass.h>
#include <vector>
#include <cstring>
#include <cmath>

#pragma comment(lib, "setupapi.lib")

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

            buffer[filled].pid = curr.pid;
            buffer[filled].cpu_percent = cpu_pct;
            buffer[filled].battery_percent = battery_pct;
            buffer[filled].energy_uj = static_cast<uint64_t>(delta_proc / 10);
            buffer[filled].power_watts = (cpu_pct / total_cpu_percent_sum) * actual_system_watts;
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

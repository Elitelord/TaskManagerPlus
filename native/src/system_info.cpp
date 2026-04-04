#include "process_info.h"

#include <initguid.h>
#include <windows.h>
#include <psapi.h>
#include <pdh.h>
#include <setupapi.h>
#include <devguid.h>
#include <batclass.h>
#include <vector>
#include <cstring>

#pragma comment(lib, "pdh.lib")
#pragma comment(lib, "setupapi.lib")

#ifndef PDH_MORE_DATA
#define PDH_MORE_DATA ((LONG)0x800007D2L)
#endif

// {72631E54-78A4-11D0-BCF7-00AA00B7B32A}
DEFINE_GUID(GUID_DEVINTERFACE_BATTERY_SYS, 0x72631e54, 0x78a4, 0x11d0, 0xbc, 0xf7, 0x00, 0xaa, 0x00, 0xb7, 0xb3, 0x2a);

// PDH queries for system-level metrics
static PDH_HQUERY g_cpuQuery = nullptr;
static PDH_HCOUNTER g_cpuCounter = nullptr;
static bool g_cpuInitialized = false;

static PDH_HQUERY g_diskQuery = nullptr;
static PDH_HCOUNTER g_diskReadCounter = nullptr;
static PDH_HCOUNTER g_diskWriteCounter = nullptr;
static bool g_diskInitialized = false;

static PDH_HQUERY g_netQuery = nullptr;
static PDH_HCOUNTER g_netSendCounter = nullptr;
static PDH_HCOUNTER g_netRecvCounter = nullptr;
static bool g_netInitialized = false;

static PDH_HQUERY g_gpuQuery = nullptr;
static PDH_HCOUNTER g_gpuCounter = nullptr;
static bool g_gpuSysInitialized = false;
static bool g_gpuSysAvailable = false;

static void init_counters() {
    // CPU
    if (!g_cpuInitialized) {
        if (PdhOpenQueryW(nullptr, 0, &g_cpuQuery) == ERROR_SUCCESS) {
            if (PdhAddEnglishCounterW(g_cpuQuery,
                    L"\\Processor(_Total)\\% Processor Time",
                    0, &g_cpuCounter) == ERROR_SUCCESS) {
                PdhCollectQueryData(g_cpuQuery);
                g_cpuInitialized = true;
            }
        }
    }

    // Disk
    if (!g_diskInitialized) {
        if (PdhOpenQueryW(nullptr, 0, &g_diskQuery) == ERROR_SUCCESS) {
            bool ok = true;
            if (PdhAddEnglishCounterW(g_diskQuery,
                    L"\\PhysicalDisk(_Total)\\Disk Read Bytes/sec",
                    0, &g_diskReadCounter) != ERROR_SUCCESS) ok = false;
            if (PdhAddEnglishCounterW(g_diskQuery,
                    L"\\PhysicalDisk(_Total)\\Disk Write Bytes/sec",
                    0, &g_diskWriteCounter) != ERROR_SUCCESS) ok = false;
            if (ok) {
                PdhCollectQueryData(g_diskQuery);
                g_diskInitialized = true;
            }
        }
    }

    // Network
    if (!g_netInitialized) {
        if (PdhOpenQueryW(nullptr, 0, &g_netQuery) == ERROR_SUCCESS) {
            bool ok = true;
            if (PdhAddEnglishCounterW(g_netQuery,
                    L"\\Network Interface(*)\\Bytes Sent/sec",
                    0, &g_netSendCounter) != ERROR_SUCCESS) ok = false;
            if (PdhAddEnglishCounterW(g_netQuery,
                    L"\\Network Interface(*)\\Bytes Received/sec",
                    0, &g_netRecvCounter) != ERROR_SUCCESS) ok = false;
            if (ok) {
                PdhCollectQueryData(g_netQuery);
                g_netInitialized = true;
            }
        }
    }

    // GPU
    if (!g_gpuSysInitialized) {
        g_gpuSysInitialized = true;
        if (PdhOpenQueryW(nullptr, 0, &g_gpuQuery) == ERROR_SUCCESS) {
            if (PdhAddEnglishCounterW(g_gpuQuery,
                    L"\\GPU Engine(*)\\Utilization Percentage",
                    0, &g_gpuCounter) == ERROR_SUCCESS) {
                PdhCollectQueryData(g_gpuQuery);
                g_gpuSysAvailable = true;
            }
        }
    }
}

static double get_pdh_double(PDH_HQUERY query, PDH_HCOUNTER counter) {
    if (PdhCollectQueryData(query) == ERROR_SUCCESS) {
        PDH_FMT_COUNTERVALUE val;
        if (PdhGetFormattedCounterValue(counter, PDH_FMT_DOUBLE, nullptr, &val) == ERROR_SUCCESS) {
            return val.doubleValue;
        }
    }
    return 0.0;
}

// Sum all instances of a wildcard counter
static double get_pdh_wildcard_sum(PDH_HQUERY query, PDH_HCOUNTER counter) {
    if (PdhCollectQueryData(query) != ERROR_SUCCESS) return 0.0;

    DWORD bufSize = 0;
    DWORD itemCount = 0;
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

// ---------------------------------------------------------------------------
// Battery power query via IOCTL
// ---------------------------------------------------------------------------

static double g_prev_batt_pct = -1.0;
static ULONGLONG g_prev_batt_tick = 0;
static double g_est_power_watts = 0.0;

static void get_sys_battery_wattage(double& out_draw, double& out_charge) {
    out_draw = 0.0; out_charge = 0.0;
    HDEVINFO hdev = SetupDiGetClassDevsW(&GUID_DEVINTERFACE_BATTERY_SYS, 0, 0, DIGCF_PRESENT | DIGCF_DEVICEINTERFACE);
    if (hdev == INVALID_HANDLE_VALUE) return;
    SP_DEVICE_INTERFACE_DATA did = {0};
    did.cbSize = sizeof(did);
    for (int i = 0; SetupDiEnumDeviceInterfaces(hdev, 0, &GUID_DEVINTERFACE_BATTERY_SYS, i, &did); i++) {
        DWORD size = 0;
        SetupDiGetDeviceInterfaceDetailW(hdev, &did, 0, 0, &size, NULL);
        if (GetLastError() != ERROR_INSUFFICIENT_BUFFER) continue;
        std::vector<BYTE> buf(size);
        PSP_DEVICE_INTERFACE_DETAIL_DATA_W pdidd = reinterpret_cast<PSP_DEVICE_INTERFACE_DETAIL_DATA_W>(buf.data());
        pdidd->cbSize = sizeof(SP_DEVICE_INTERFACE_DETAIL_DATA_W);
        if (SetupDiGetDeviceInterfaceDetailW(hdev, &did, pdidd, size, &size, NULL)) {
            HANDLE hBat = CreateFileW(pdidd->DevicePath, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
            if (hBat != INVALID_HANDLE_VALUE) {
                ULONG tag = 0; DWORD out = 0;
                if (DeviceIoControl(hBat, IOCTL_BATTERY_QUERY_TAG, NULL, 0, &tag, sizeof(tag), &out, NULL) && tag) {
                    BATTERY_WAIT_STATUS bws = {0}; bws.BatteryTag = tag;
                    BATTERY_STATUS bs = {0};
                    if (DeviceIoControl(hBat, IOCTL_BATTERY_QUERY_STATUS, &bws, sizeof(bws), &bs, sizeof(bs), &out, NULL)) {
                        if (bs.Rate != BATTERY_UNKNOWN_RATE && bs.Rate != 0) {
                            double w = static_cast<double>(abs(bs.Rate)) / 1000.0;
                            if (bs.PowerState & BATTERY_DISCHARGING) out_draw += w;
                            else if (bs.PowerState & BATTERY_CHARGING) out_charge += w;
                        }
                    }
                }
                CloseHandle(hBat);
            }
        }
    }
    SetupDiDestroyDeviceInfoList(hdev);
}

// ---------------------------------------------------------------------------
// get_system_info
// ---------------------------------------------------------------------------

extern "C" DLL_EXPORT int32_t get_system_info(SystemInfoData* info) {
    if (!info) return -1;

    memset(info, 0, sizeof(SystemInfoData));
    init_counters();

    // Memory
    MEMORYSTATUSEX memStatus;
    memStatus.dwLength = sizeof(memStatus);
    if (GlobalMemoryStatusEx(&memStatus)) {
        info->total_ram_mb = memStatus.ullTotalPhys / (1024 * 1024);
        info->used_ram_mb = (memStatus.ullTotalPhys - memStatus.ullAvailPhys) / (1024 * 1024);
    }

    // CPU
    if (g_cpuInitialized) {
        info->cpu_usage_percent = get_pdh_double(g_cpuQuery, g_cpuCounter);
        if (info->cpu_usage_percent > 100.0) info->cpu_usage_percent = 100.0;
    }

    // Disk
    if (g_diskInitialized) {
        if (PdhCollectQueryData(g_diskQuery) == ERROR_SUCCESS) {
            PDH_FMT_COUNTERVALUE val;
            if (PdhGetFormattedCounterValue(g_diskReadCounter, PDH_FMT_DOUBLE, nullptr, &val) == ERROR_SUCCESS)
                info->total_disk_read_per_sec = val.doubleValue;
            if (PdhGetFormattedCounterValue(g_diskWriteCounter, PDH_FMT_DOUBLE, nullptr, &val) == ERROR_SUCCESS)
                info->total_disk_write_per_sec = val.doubleValue;
        }
    }

    // Network (sum of all interfaces)
    if (g_netInitialized) {
        if (PdhCollectQueryData(g_netQuery) == ERROR_SUCCESS) {
            DWORD bufSize = 0, itemCount = 0;
            PDH_STATUS status;
            status = PdhGetFormattedCounterArray(g_netSendCounter, PDH_FMT_DOUBLE, &bufSize, &itemCount, nullptr);
            if (status == PDH_MORE_DATA && bufSize > 0) {
                std::vector<BYTE> buf(bufSize);
                auto* items = reinterpret_cast<PDH_FMT_COUNTERVALUE_ITEM_W*>(buf.data());
                if (PdhGetFormattedCounterArray(g_netSendCounter, PDH_FMT_DOUBLE, &bufSize, &itemCount, items) == ERROR_SUCCESS) {
                    for (DWORD i = 0; i < itemCount; i++)
                        info->total_net_send_per_sec += items[i].FmtValue.doubleValue;
                }
            }
            bufSize = 0; itemCount = 0;
            status = PdhGetFormattedCounterArray(g_netRecvCounter, PDH_FMT_DOUBLE, &bufSize, &itemCount, nullptr);
            if (status == PDH_MORE_DATA && bufSize > 0) {
                std::vector<BYTE> buf(bufSize);
                auto* items = reinterpret_cast<PDH_FMT_COUNTERVALUE_ITEM_W*>(buf.data());
                if (PdhGetFormattedCounterArray(g_netRecvCounter, PDH_FMT_DOUBLE, &bufSize, &itemCount, items) == ERROR_SUCCESS) {
                    for (DWORD i = 0; i < itemCount; i++)
                        info->total_net_recv_per_sec += items[i].FmtValue.doubleValue;
                }
            }
        }
    }

    // GPU
    if (g_gpuSysAvailable) {
        info->gpu_usage_percent = get_pdh_wildcard_sum(g_gpuQuery, g_gpuCounter);
        if (info->gpu_usage_percent > 100.0) info->gpu_usage_percent = 100.0;
    }

    // Battery / Power
    SYSTEM_POWER_STATUS powerStatus;
    if (GetSystemPowerStatus(&powerStatus)) {
        if (powerStatus.BatteryLifePercent != 255)
            info->battery_percent = static_cast<double>(powerStatus.BatteryLifePercent);
        else
            info->battery_percent = 100.0;
        info->is_charging = (powerStatus.ACLineStatus == 1) ? 1 : 0;

        // 1. Get real wattage via IOCTL
        double ioctl_draw = 0.0, ioctl_charge = 0.0;
        get_sys_battery_wattage(ioctl_draw, ioctl_charge);

        // 2. Estimation fallback
        ULONGLONG now = GetTickCount64();
        double currentPct = info->battery_percent;
        double estimated_draw = 0.0;
        if (g_prev_batt_pct >= 0.0 && g_prev_batt_tick > 0) {
            ULONGLONG elapsed_ms = now - g_prev_batt_tick;
            if (elapsed_ms > 1000) {
                double delta = g_prev_batt_pct - currentPct;
                double hours = static_cast<double>(elapsed_ms) / 3600000.0;
                if (hours > 0.0) estimated_draw = (delta / 100.0) * 50.0 / hours; // 50Wh assumed
                if (estimated_draw < 0.0) estimated_draw = 0.0;
            }
        }
        g_prev_batt_pct = currentPct;
        g_prev_batt_tick = now;

        double baseline = (info->cpu_usage_percent / 100.0) * 15.0 + 5.0;

        if (ioctl_draw > 0.01) info->power_draw_watts = ioctl_draw;
        else if (info->is_charging) info->power_draw_watts = baseline;
        else if (estimated_draw > 0.01) {
            g_est_power_watts = g_est_power_watts * 0.8 + estimated_draw * 0.2;
            info->power_draw_watts = g_est_power_watts;
        } else info->power_draw_watts = baseline;

        // When on AC power and battery isn't actively discharging, the wall
        // is supplying at least as much as the system draws.
        if (info->is_charging && ioctl_charge < 0.01 && ioctl_draw < 0.01) {
            // Battery full or maintaining — wall supplies all power
            info->charge_rate_watts = info->power_draw_watts;
        } else {
            info->charge_rate_watts = (ioctl_charge > 0.01) ? ioctl_charge : 0.0;
            // If charging and we know the charge rate, wall = draw + charge
            if (info->is_charging && info->charge_rate_watts > 0.01) {
                info->charge_rate_watts += info->power_draw_watts;
            }
        }
    }

    // Process count
    DWORD pids[1024];
    DWORD bytes_returned = 0;
    if (EnumProcesses(pids, sizeof(pids), &bytes_returned)) {
        info->process_count = bytes_returned / sizeof(DWORD);
    }

    return 0;
}

#include "process_info.h"

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <psapi.h>
#include <pdh.h>
#include <vector>
#include <unordered_map>
#include <cstring>
#include <string>

#pragma comment(lib, "pdh.lib")

#ifndef PDH_MORE_DATA
#define PDH_MORE_DATA ((LONG)0x800007D2L)
#endif

// GPU telemetry using PDH (Performance Data Helper) counters.
// Available on Windows 10 1709+ via the "GPU Engine" counter set.
// This gives per-process GPU utilization without undocumented APIs.

static PDH_HQUERY g_gpuQuery = nullptr;
static bool g_gpuInitialized = false;
static bool g_gpuAvailable = false;

// We use a wildcard counter to capture all GPU engine instances
static PDH_HCOUNTER g_gpuUtilCounter = nullptr;

static void init_gpu_counters() {
    if (g_gpuInitialized) return;
    g_gpuInitialized = true;

    if (PdhOpenQueryW(nullptr, 0, &g_gpuQuery) != ERROR_SUCCESS) {
        return;
    }

    // Try adding the GPU Engine wildcard counter
    PDH_STATUS status = PdhAddEnglishCounterW(g_gpuQuery,
        L"\\GPU Engine(*)\\Utilization Percentage",
        0, &g_gpuUtilCounter);

    if (status == ERROR_SUCCESS) {
        PdhCollectQueryData(g_gpuQuery); // Initial collection
        g_gpuAvailable = true;
    }
}

extern "C" DLL_EXPORT int32_t get_process_gpu_list(ProcessGpuInfo* buffer, int32_t max_count) {
    init_gpu_counters();

    DWORD pids[1024];
    DWORD bytes_returned = 0;
    if (!EnumProcesses(pids, sizeof(pids), &bytes_returned)) {
        return 0;
    }
    DWORD num_processes = bytes_returned / sizeof(DWORD);

    if (buffer == nullptr) {
        return static_cast<int32_t>(num_processes);
    }

    // Collect GPU data per PID
    std::unordered_map<DWORD, double> pid_gpu_usage;

    if (g_gpuAvailable) {
        if (PdhCollectQueryData(g_gpuQuery) == ERROR_SUCCESS) {
            // Expand the wildcard counter to get all instances
            DWORD bufSize = 0;
            DWORD itemCount = 0;

            PDH_STATUS status = PdhGetFormattedCounterArray(
                g_gpuUtilCounter, PDH_FMT_DOUBLE,
                &bufSize, &itemCount, nullptr);

            if (status == PDH_MORE_DATA && bufSize > 0) {
                std::vector<BYTE> rawBuf(bufSize);
                auto* items = reinterpret_cast<PDH_FMT_COUNTERVALUE_ITEM_W*>(rawBuf.data());

                status = PdhGetFormattedCounterArray(
                    g_gpuUtilCounter, PDH_FMT_DOUBLE,
                    &bufSize, &itemCount, items);

                if (status == ERROR_SUCCESS) {
                    for (DWORD i = 0; i < itemCount; i++) {
                        // Instance name format: "pid_XXXX_luid_0xYYYY_..."
                        // Extract PID from the instance name
                        std::wstring name(items[i].szName);
                        size_t pid_pos = name.find(L"pid_");
                        if (pid_pos != std::wstring::npos) {
                            DWORD pid = 0;
                            try {
                                pid = std::stoul(name.substr(pid_pos + 4));
                            } catch (...) {
                                continue;
                            }
                            if (pid > 0) {
                                pid_gpu_usage[pid] += items[i].FmtValue.doubleValue;
                            }
                        }
                    }
                }
            }
        }
    }

    int32_t filled = 0;
    for (DWORD i = 0; i < num_processes && filled < max_count; i++) {
        DWORD pid = pids[i];
        if (pid == 0) continue;

        buffer[filled].pid = pid;

        auto it = pid_gpu_usage.find(pid);
        if (it != pid_gpu_usage.end()) {
            buffer[filled].gpu_usage_percent = it->second;
        } else {
            buffer[filled].gpu_usage_percent = 0.0;
        }

        // GPU dedicated memory - query via process handle
        buffer[filled].gpu_memory_bytes = 0;

        filled++;
    }

    return filled;
}

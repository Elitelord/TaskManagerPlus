#include "process_info.h"

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <psapi.h>
#include <pdh.h>
#include <vector>
#include <unordered_map>
#include <cstring>
#include <cstdlib>
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
// Per-process dedicated VRAM (PDH "GPU Process Memory" set). Optional —
// when absent (older Windows or driver issues) we just leave bytes at 0.
static PDH_HCOUNTER g_gpuProcDedMemCounter = nullptr;
static bool g_gpuProcDedMemAvailable = false;

// 1C — the GPU Engine(*) wildcard is the worst instance-churn source: one
// instance per (pid, luid, engine) tuple, added forever as processes come and
// go. Recycle the whole query on a timer so the retired instances are dropped.
static ULONGLONG g_gpuQueryCreatedTick = 0;

// Default 15 min; shares the TMP_PDH_RECYCLE_MS override with the perf query.
static ULONGLONG gpu_query_max_age_ms() {
    static const ULONGLONG cached = [] {
        char buf[32];
        size_t len = 0;
        if (getenv_s(&len, buf, sizeof(buf), "TMP_PDH_RECYCLE_MS") == 0 && len > 1) {
            unsigned long long v = strtoull(buf, nullptr, 10);
            if (v >= 1000ULL) return static_cast<ULONGLONG>(v);
        }
        return 15ULL * 60ULL * 1000ULL;
    }();
    return cached;
}

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
        g_gpuAvailable = true;
    }

    // Per-process dedicated VRAM. Instance names share the same
    // "pid_<PID>_luid_<HI>_<LO>_phys_<N>_eng_<N>" shape as the engine
    // counter, so we reuse the same PID parser below.
    if (PdhAddEnglishCounterW(g_gpuQuery,
            L"\\GPU Process Memory(*)\\Dedicated Usage",
            0, &g_gpuProcDedMemCounter) == ERROR_SUCCESS) {
        g_gpuProcDedMemAvailable = true;
    }

    // Single initial sample so PDH can compute deltas / first values cleanly.
    if (g_gpuAvailable || g_gpuProcDedMemAvailable) {
        PdhCollectQueryData(g_gpuQuery);
    }
    g_gpuQueryCreatedTick = GetTickCount64();
}

// Tear down the query so the next init_gpu_counters() rebuilds fresh, dropping
// the accumulated GPU Engine(*) instance table. PdhCloseQuery frees the query
// and its counters together.
static void close_gpu_counters() {
    if (g_gpuQuery) {
        PdhCloseQuery(g_gpuQuery);
        g_gpuQuery = nullptr;
    }
    g_gpuUtilCounter = nullptr;
    g_gpuProcDedMemCounter = nullptr;
    g_gpuAvailable = false;
    g_gpuProcDedMemAvailable = false;
    g_gpuInitialized = false;
    g_gpuQueryCreatedTick = 0;
}

static void maybe_recycle_gpu_query() {
    if (!g_gpuInitialized || g_gpuQueryCreatedTick == 0) return;
    if (GetTickCount64() - g_gpuQueryCreatedTick >= gpu_query_max_age_ms()) {
        close_gpu_counters();
    }
}

extern "C" DLL_EXPORT int32_t get_process_gpu_list(ProcessGpuInfo* buffer, int32_t max_count) {
    maybe_recycle_gpu_query(); // 1C — drop the stale GPU Engine(*) instance table periodically
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
    std::unordered_map<DWORD, uint64_t> pid_gpu_ded_mem;

    // Pull both counters from a single PdhCollectQueryData() call so the
    // engine % and the dedicated VRAM bytes are sampled at the same instant.
    if ((g_gpuAvailable || g_gpuProcDedMemAvailable)
        && PdhCollectQueryData(g_gpuQuery) == ERROR_SUCCESS) {

        // Helper lambda: parses "pid_<N>_luid_..." style instance names. PDH
        // hands us the same name shape for both Engine and Process Memory
        // counters, so one parser handles both.
        auto extract_pid = [](const wchar_t* sz) -> DWORD {
            std::wstring name(sz);
            size_t p = name.find(L"pid_");
            if (p == std::wstring::npos) return 0;
            try { return std::stoul(name.substr(p + 4)); }
            catch (...) { return 0; }
        };

        // ---- GPU engine % per PID ----
        if (g_gpuAvailable) {
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
                        DWORD pid = extract_pid(items[i].szName);
                        if (pid > 0) {
                            double v = items[i].FmtValue.doubleValue;
                            if (v < 0.0) v = 0.0;
                            auto& slot = pid_gpu_usage[pid];
                            if (v > slot) slot = v;
                        }
                    }
                }
            }
        }

        // ---- Per-process dedicated VRAM (bytes) ----
        // PDH "GPU Process Memory" exposes one instance per (PID, GPU
        // adapter, segment), so we sum across instances belonging to the
        // same PID (covers multi-adapter cases where one process has
        // resources on two GPUs).
        if (g_gpuProcDedMemAvailable) {
            DWORD bufSize = 0;
            DWORD itemCount = 0;
            PDH_STATUS status = PdhGetFormattedCounterArray(
                g_gpuProcDedMemCounter, PDH_FMT_LARGE,
                &bufSize, &itemCount, nullptr);
            if (status == PDH_MORE_DATA && bufSize > 0) {
                std::vector<BYTE> rawBuf(bufSize);
                auto* items = reinterpret_cast<PDH_FMT_COUNTERVALUE_ITEM_W*>(rawBuf.data());
                status = PdhGetFormattedCounterArray(
                    g_gpuProcDedMemCounter, PDH_FMT_LARGE,
                    &bufSize, &itemCount, items);
                if (status == ERROR_SUCCESS) {
                    for (DWORD i = 0; i < itemCount; i++) {
                        DWORD pid = extract_pid(items[i].szName);
                        if (pid == 0) continue;
                        LONGLONG v = items[i].FmtValue.largeValue;
                        if (v < 0) v = 0;
                        pid_gpu_ded_mem[pid] += static_cast<uint64_t>(v);
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
        buffer[filled].gpu_usage_percent =
            (it != pid_gpu_usage.end()) ? it->second : 0.0;

        auto m = pid_gpu_ded_mem.find(pid);
        buffer[filled].gpu_memory_bytes =
            (m != pid_gpu_ded_mem.end()) ? m->second : 0;

        filled++;
    }

    return filled;
}

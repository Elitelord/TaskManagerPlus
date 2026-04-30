#include "process_info.h"
#include "nt_process_io.h"

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <unordered_map>
#include <vector>
#include <cstring>

struct PrevIoData {
    DWORD pid;
    uint64_t read_bytes;
    uint64_t write_bytes;
};

static std::vector<PrevIoData> g_prev_io;
static ULONGLONG g_prev_io_time = 0;
static bool g_has_prev_io = false;

static ULONGLONG GetCurrentTimeULL() {
    FILETIME ft;
    GetSystemTimeAsFileTime(&ft);
    return (static_cast<ULONGLONG>(ft.dwHighDateTime) << 32) | ft.dwLowDateTime;
}

extern "C" DLL_EXPORT int32_t get_process_disk_list(ProcessDiskInfo* buffer, int32_t max_count) {
    // Single kernel call returns I/O counters for every process — replaces a
    // per-PID OpenProcess + GetProcessIoCounters loop that ran ~500 syscalls
    // per tick on busy machines and silently dropped elevated/protected PIDs
    // we couldn't open. NtQSI sees them all.
    std::unordered_map<DWORD, ProcessIoSnapshot> snaps;
    get_process_io_snapshots(snaps);

    // Count-only call: return count WITHOUT touching saved state.
    if (buffer == nullptr) {
        return static_cast<int32_t>(snaps.size());
    }

    ULONGLONG current_time = GetCurrentTimeULL();
    int32_t filled = 0;

    if (g_has_prev_io && g_prev_io_time > 0) {
        double dt_sec = static_cast<double>(current_time - g_prev_io_time) / 10000000.0;
        if (dt_sec <= 0.0) dt_sec = 1.0;

        // Build a quick lookup from prev vector — tick rate keeps it small (~hundreds).
        std::unordered_map<DWORD, std::pair<uint64_t, uint64_t>> prev_map;
        prev_map.reserve(g_prev_io.size());
        for (const auto& prev : g_prev_io) {
            prev_map[prev.pid] = { prev.read_bytes, prev.write_bytes };
        }

        for (const auto& [pid, snap] : snaps) {
            if (filled >= max_count) break;

            uint64_t prev_read = 0, prev_write = 0;
            auto it = prev_map.find(pid);
            if (it != prev_map.end()) {
                prev_read = it->second.first;
                prev_write = it->second.second;
            }

            double read_delta = (snap.read_bytes >= prev_read)
                ? static_cast<double>(snap.read_bytes - prev_read) : 0;
            double write_delta = (snap.write_bytes >= prev_write)
                ? static_cast<double>(snap.write_bytes - prev_write) : 0;

            buffer[filled].pid = pid;
            buffer[filled].read_bytes_per_sec = read_delta / dt_sec;
            buffer[filled].write_bytes_per_sec = write_delta / dt_sec;
            buffer[filled].total_read_bytes = snap.read_bytes;
            buffer[filled].total_write_bytes = snap.write_bytes;
            filled++;
        }
    } else {
        for (const auto& [pid, snap] : snaps) {
            if (filled >= max_count) break;
            buffer[filled].pid = pid;
            buffer[filled].read_bytes_per_sec = 0;
            buffer[filled].write_bytes_per_sec = 0;
            buffer[filled].total_read_bytes = snap.read_bytes;
            buffer[filled].total_write_bytes = snap.write_bytes;
            filled++;
        }
    }

    g_prev_io.clear();
    g_prev_io.reserve(snaps.size());
    for (const auto& [pid, snap] : snaps) {
        g_prev_io.push_back({ pid, snap.read_bytes, snap.write_bytes });
    }
    g_prev_io_time = current_time;
    g_has_prev_io = true;

    return filled;
}

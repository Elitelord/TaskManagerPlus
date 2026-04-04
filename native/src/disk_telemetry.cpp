#include "process_info.h"

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <psapi.h>
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

    ULONGLONG current_time = GetCurrentTimeULL();

    struct CurrentIo {
        DWORD pid;
        uint64_t read_bytes;
        uint64_t write_bytes;
    };

    std::vector<CurrentIo> current_io;
    current_io.reserve(num_processes);

    for (DWORD i = 0; i < num_processes; i++) {
        DWORD pid = pids[i];
        if (pid == 0) continue;

        HANDLE hProcess = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if (!hProcess) continue;

        IO_COUNTERS ioc = {0};
        if (GetProcessIoCounters(hProcess, &ioc)) {
            current_io.push_back({pid, ioc.ReadTransferCount, ioc.WriteTransferCount});
        }

        CloseHandle(hProcess);
    }

    int32_t filled = 0;

    if (g_has_prev_io && g_prev_io_time > 0) {
        double dt_sec = static_cast<double>(current_time - g_prev_io_time) / 10000000.0;
        if (dt_sec <= 0.0) dt_sec = 1.0;

        for (size_t i = 0; i < current_io.size() && filled < max_count; i++) {
            const auto& curr = current_io[i];

            uint64_t prev_read = 0, prev_write = 0;
            for (const auto& prev : g_prev_io) {
                if (prev.pid == curr.pid) {
                    prev_read = prev.read_bytes;
                    prev_write = prev.write_bytes;
                    break;
                }
            }

            double read_delta = (curr.read_bytes >= prev_read) ? static_cast<double>(curr.read_bytes - prev_read) : 0;
            double write_delta = (curr.write_bytes >= prev_write) ? static_cast<double>(curr.write_bytes - prev_write) : 0;

            buffer[filled].pid = curr.pid;
            buffer[filled].read_bytes_per_sec = read_delta / dt_sec;
            buffer[filled].write_bytes_per_sec = write_delta / dt_sec;
            buffer[filled].total_read_bytes = curr.read_bytes;
            buffer[filled].total_write_bytes = curr.write_bytes;
            filled++;
        }
    } else {
        for (size_t i = 0; i < current_io.size() && filled < max_count; i++) {
            buffer[filled].pid = current_io[i].pid;
            buffer[filled].read_bytes_per_sec = 0;
            buffer[filled].write_bytes_per_sec = 0;
            buffer[filled].total_read_bytes = current_io[i].read_bytes;
            buffer[filled].total_write_bytes = current_io[i].write_bytes;
            filled++;
        }
    }

    // Only save state on fill calls
    g_prev_io.clear();
    for (const auto& c : current_io)
        g_prev_io.push_back({c.pid, c.read_bytes, c.write_bytes});
    g_prev_io_time = current_time;
    g_has_prev_io = true;

    return filled;
}

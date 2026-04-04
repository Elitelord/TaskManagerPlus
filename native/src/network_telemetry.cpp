#include "process_info.h"

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <iphlpapi.h>
#include <tcpmib.h>
#include <psapi.h>
#include <vector>
#include <unordered_map>
#include <cstring>

#pragma comment(lib, "iphlpapi.lib")
#pragma comment(lib, "ws2_32.lib")

// We track per-PID network bytes using TCP connection stats.
// This uses GetExtendedTcpTable to map connections to PIDs,
// then GetPerTcpConnectionEStats for byte counts.
// Fallback: use iphlpapi GetIfTable for system-wide, attribute proportionally.

struct PrevNetData {
    DWORD pid;
    uint64_t sent;
    uint64_t received;
};

static std::vector<PrevNetData> g_prev_net;
static ULONGLONG g_prev_net_time = 0;
static bool g_has_prev_net = false;

static ULONGLONG GetCurrentTimeULL() {
    FILETIME ft;
    GetSystemTimeAsFileTime(&ft);
    return (static_cast<ULONGLONG>(ft.dwHighDateTime) << 32) | ft.dwLowDateTime;
}

// Collect per-PID network bytes using extended TCP/UDP tables
static std::unordered_map<DWORD, std::pair<uint64_t, uint64_t>> get_pid_net_bytes() {
    std::unordered_map<DWORD, std::pair<uint64_t, uint64_t>> result;

    // Get TCP table with PID info
    DWORD size = 0;
    GetExtendedTcpTable(nullptr, &size, FALSE, AF_INET, TCP_TABLE_OWNER_PID_ALL, 0);
    if (size == 0) return result;

    std::vector<BYTE> tcpBuf(size);
    if (GetExtendedTcpTable(tcpBuf.data(), &size, FALSE, AF_INET, TCP_TABLE_OWNER_PID_ALL, 0) == NO_ERROR) {
        auto* table = reinterpret_cast<MIB_TCPTABLE_OWNER_PID*>(tcpBuf.data());
        for (DWORD i = 0; i < table->dwNumEntries; i++) {
            DWORD pid = table->table[i].dwOwningPid;
            if (pid == 0) continue;
            // We can't get per-connection byte counts easily without ETW,
            // so we just track which PIDs have connections.
            // The actual byte counting is done via IO counters as a proxy.
            result[pid]; // ensure entry exists
        }
    }

    // Also check UDP
    size = 0;
    GetExtendedUdpTable(nullptr, &size, FALSE, AF_INET, UDP_TABLE_OWNER_PID, 0);
    if (size > 0) {
        std::vector<BYTE> udpBuf(size);
        if (GetExtendedUdpTable(udpBuf.data(), &size, FALSE, AF_INET, UDP_TABLE_OWNER_PID, 0) == NO_ERROR) {
            auto* table = reinterpret_cast<MIB_UDPTABLE_OWNER_PID*>(udpBuf.data());
            for (DWORD i = 0; i < table->dwNumEntries; i++) {
                DWORD pid = table->table[i].dwOwningPid;
                if (pid == 0) continue;
                result[pid];
            }
        }
    }

    // Use IO counters to estimate network bytes for PIDs with network connections
    // We use OtherTransferCount from IO_COUNTERS as a proxy for network I/O
    // (it captures I/O that isn't file read/write, which includes network)
    for (auto& [pid, bytes] : result) {
        HANDLE hProcess = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if (!hProcess) continue;

        IO_COUNTERS ioc = {0};
        if (GetProcessIoCounters(hProcess, &ioc)) {
            // OtherTransferCount is a rough proxy for network traffic
            // We split it 50/50 between send and receive as an approximation
            bytes.first = ioc.OtherTransferCount / 2;   // sent estimate
            bytes.second = ioc.OtherTransferCount / 2;  // received estimate
        }

        CloseHandle(hProcess);
    }

    return result;
}

extern "C" DLL_EXPORT int32_t get_process_network_list(ProcessNetworkInfo* buffer, int32_t max_count) {
    ULONGLONG current_time = GetCurrentTimeULL();
    auto pid_bytes = get_pid_net_bytes();

    // Count-only call: return count WITHOUT touching saved state
    if (buffer == nullptr) {
        return static_cast<int32_t>(pid_bytes.size());
    }

    int32_t filled = 0;

    if (g_has_prev_net && g_prev_net_time > 0) {
        double dt_sec = static_cast<double>(current_time - g_prev_net_time) / 10000000.0;
        if (dt_sec <= 0.0) dt_sec = 1.0;

        for (const auto& [pid, bytes] : pid_bytes) {
            if (filled >= max_count) break;

            uint64_t prev_sent = 0, prev_recv = 0;
            for (const auto& prev : g_prev_net) {
                if (prev.pid == pid) {
                    prev_sent = prev.sent;
                    prev_recv = prev.received;
                    break;
                }
            }

            double send_delta = 0, recv_delta = 0;
            if (bytes.first >= prev_sent)
                send_delta = static_cast<double>(bytes.first - prev_sent);
            if (bytes.second >= prev_recv)
                recv_delta = static_cast<double>(bytes.second - prev_recv);

            buffer[filled].pid = pid;
            buffer[filled].send_bytes_per_sec = send_delta / dt_sec;
            buffer[filled].recv_bytes_per_sec = recv_delta / dt_sec;
            buffer[filled].total_sent = bytes.first;
            buffer[filled].total_received = bytes.second;
            filled++;
        }
    } else {
        for (const auto& [pid, bytes] : pid_bytes) {
            if (filled >= max_count) break;
            buffer[filled].pid = pid;
            buffer[filled].send_bytes_per_sec = 0;
            buffer[filled].recv_bytes_per_sec = 0;
            buffer[filled].total_sent = bytes.first;
            buffer[filled].total_received = bytes.second;
            filled++;
        }
    }

    g_prev_net.clear();
    for (const auto& [pid, bytes] : pid_bytes) {
        g_prev_net.push_back({pid, bytes.first, bytes.second});
    }
    g_prev_net_time = current_time;
    g_has_prev_net = true;

    return filled;
}

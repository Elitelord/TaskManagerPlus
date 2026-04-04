#include "process_info.h"

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <psapi.h>
#include <tlhelp32.h>
#include <winternl.h>
#include <vector>
#include <unordered_map>
#include <cstring>

// Terminate a process by PID
extern "C" DLL_EXPORT int32_t terminate_process(uint32_t pid) {
    HANDLE hProcess = OpenProcess(PROCESS_TERMINATE, FALSE, pid);
    if (!hProcess) {
        return -1;
    }

    BOOL result = TerminateProcess(hProcess, 1);
    CloseHandle(hProcess);

    return result ? 0 : -1;
}

// Sets process priority class. Returns 0 on success, -1 on failure.
extern "C" DLL_EXPORT int32_t set_process_priority(uint32_t pid, int32_t priority_class) {
    HANDLE hProcess = OpenProcess(PROCESS_SET_INFORMATION, FALSE, pid);
    if (!hProcess) {
        return -1;
    }

    // Windows 11 Efficiency Mode / Eco Mode also involves ProcessPowerThrottling
    // But for a generic priority switcher, SetPriorityClass is the standard.
    // Task Manager: 
    //   Low = 0x00000040 (IDLE_PRIORITY_CLASS)
    //   Below Normal = 0x00004000 (BELOW_NORMAL_PRIORITY_CLASS)
    //   Normal = 0x00000020 (NORMAL_PRIORITY_CLASS)
    //   Above Normal = 0x00008000 (ABOVE_NORMAL_PRIORITY_CLASS)
    //   High = 0x00000080 (HIGH_PRIORITY_CLASS)
    //   Realtime = 0x00000100 (REALTIME_PRIORITY_CLASS)

    BOOL result = SetPriorityClass(hProcess, (DWORD)priority_class);
    
    // Additionally try to set Power Throttling for "Eco Mode" if it's IDLE_PRIORITY_CLASS
    // This is optional and might fail on older Windows versions
    if (priority_class == 0x00000040) { // IDLE_PRIORITY_CLASS
        // We could use SetProcessInformation with ProcessPowerThrottling here if target SDK allows
    }

    CloseHandle(hProcess);
    return result ? 0 : -1;
}

typedef NTSTATUS(NTAPI* NtQueryInformationThreadFn)(
    HANDLE ThreadHandle,
    ULONG ThreadInformationClass,
    PVOID ThreadInformation,
    ULONG ThreadInformationLength,
    PULONG ReturnLength
);

extern "C" DLL_EXPORT int32_t get_process_status_list(ProcessStatusInfo* buffer, int32_t max_count) {
    DWORD pids[1024];
    DWORD bytes_returned = 0;

    if (!EnumProcesses(pids, sizeof(pids), &bytes_returned)) {
        return 0;
    }

    DWORD num_processes = bytes_returned / sizeof(DWORD);

    if (buffer == nullptr) {
        return static_cast<int32_t>(num_processes);
    }

    // Take ONE thread snapshot for all processes
    HANDLE hSnapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);

    // Build a map: PID -> is_suspended
    // A process is suspended if ALL its threads have suspend count > 0
    std::unordered_map<DWORD, bool> suspended_map;

    if (hSnapshot != INVALID_HANDLE_VALUE) {
        HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
        auto NtQueryInformationThread = ntdll ?
            reinterpret_cast<NtQueryInformationThreadFn>(
                GetProcAddress(ntdll, "NtQueryInformationThread")) : nullptr;

        if (NtQueryInformationThread) {
            // First pass: mark all PIDs as potentially suspended
            // We'll track: has_threads and has_non_suspended_thread
            struct PidState {
                bool has_threads = false;
                bool has_non_suspended = false;
            };
            std::unordered_map<DWORD, PidState> pid_states;

            THREADENTRY32 te;
            te.dwSize = sizeof(te);

            if (Thread32First(hSnapshot, &te)) {
                do {
                    DWORD pid = te.th32OwnerProcessID;
                    if (pid == 0) continue;

                    auto& state = pid_states[pid];
                    state.has_threads = true;

                    // Skip if we already know it's not suspended
                    if (state.has_non_suspended) continue;

                    HANDLE hThread = OpenThread(THREAD_QUERY_LIMITED_INFORMATION, FALSE, te.th32ThreadID);
                    if (hThread) {
                        ULONG suspendCount = 0;
                        NTSTATUS status = NtQueryInformationThread(
                            hThread, 35, &suspendCount, sizeof(suspendCount), nullptr);
                        if (status >= 0 && suspendCount == 0) {
                            state.has_non_suspended = true;
                        }
                        CloseHandle(hThread);
                    } else {
                        state.has_non_suspended = true; // Can't query = assume running
                    }
                } while (Thread32Next(hSnapshot, &te));
            }

            for (const auto& [pid, state] : pid_states) {
                if (state.has_threads && !state.has_non_suspended) {
                    suspended_map[pid] = true;
                }
            }
        }

        CloseHandle(hSnapshot);
    }

    int32_t filled = 0;
    for (DWORD i = 0; i < num_processes && filled < max_count; i++) {
        DWORD pid = pids[i];
        if (pid == 0) continue;

        buffer[filled].pid = pid;
        buffer[filled].status = suspended_map.count(pid) ? 2 : 1;
        filled++;
    }

    return filled;
}

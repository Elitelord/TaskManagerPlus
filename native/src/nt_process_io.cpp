#include "nt_process_io.h"

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <vector>
#include <mutex>

namespace {

// Local mirror of the Win 8.1+ SYSTEM_PROCESS_INFORMATION layout. We only
// need the I/O counter tail; everything before it is included so the offsets
// match what the kernel writes. (memory_telemetry.cpp has its own copy with
// the same shape — kept separate so each translation unit stays independent;
// the wire format is stable across Windows builds we support.)
typedef struct _UNICODE_STRING_LOCAL {
    USHORT Length;
    USHORT MaximumLength;
    PWSTR  Buffer;
} UNICODE_STRING_LOCAL;

typedef struct _SYSTEM_PROCESS_INFORMATION_LOCAL {
    ULONG NextEntryOffset;
    ULONG NumberOfThreads;
    LARGE_INTEGER WorkingSetPrivateSize;
    ULONG HardFaultCount;
    ULONG NumberOfThreadsHighWatermark;
    ULONGLONG CycleTime;
    LARGE_INTEGER CreateTime;
    LARGE_INTEGER UserTime;
    LARGE_INTEGER KernelTime;
    UNICODE_STRING_LOCAL ImageName;
    LONG  BasePriority;
    HANDLE UniqueProcessId;
    HANDLE InheritedFromUniqueProcessId;
    ULONG HandleCount;
    ULONG SessionId;
    ULONG_PTR UniqueProcessKey;
    SIZE_T PeakVirtualSize;
    SIZE_T VirtualSize;
    ULONG PageFaultCount;
    SIZE_T PeakWorkingSetSize;
    SIZE_T WorkingSetSize;
    SIZE_T QuotaPeakPagedPoolUsage;
    SIZE_T QuotaPagedPoolUsage;
    SIZE_T QuotaPeakNonPagedPoolUsage;
    SIZE_T QuotaNonPagedPoolUsage;
    SIZE_T PagefileUsage;
    SIZE_T PeakPagefileUsage;
    SIZE_T PrivatePageCount;
    LARGE_INTEGER ReadOperationCount;
    LARGE_INTEGER WriteOperationCount;
    LARGE_INTEGER OtherOperationCount;
    LARGE_INTEGER ReadTransferCount;
    LARGE_INTEGER WriteTransferCount;
    LARGE_INTEGER OtherTransferCount;
    // SYSTEM_THREAD_INFORMATION Threads[1];
} SYSTEM_PROCESS_INFORMATION_LOCAL;

typedef LONG (WINAPI *NtQuerySystemInformation_t)(
    ULONG SystemInformationClass,
    PVOID SystemInformation,
    ULONG SystemInformationLength,
    PULONG ReturnLength);

NtQuerySystemInformation_t g_pNtQSI = nullptr;
std::once_flag g_ntdll_flag;

void load_ntdll() {
    HMODULE h = GetModuleHandleW(L"ntdll.dll");
    if (!h) h = LoadLibraryW(L"ntdll.dll");
    if (!h) return;
    g_pNtQSI = reinterpret_cast<NtQuerySystemInformation_t>(
        GetProcAddress(h, "NtQuerySystemInformation"));
}

} // namespace

void get_process_io_snapshots(std::unordered_map<DWORD, ProcessIoSnapshot>& out) {
    out.clear();
    std::call_once(g_ntdll_flag, load_ntdll);
    if (!g_pNtQSI) return;

    constexpr ULONG SystemProcessInformation = 5;
    constexpr LONG STATUS_INFO_LENGTH_MISMATCH = (LONG)0xC0000004L;

    // Same growth strategy as memory_telemetry: 512 KB initial, double on
    // length mismatch, hard cap at 16 MB.
    std::vector<BYTE> buf(512 * 1024);
    for (int attempt = 0; attempt < 6; ++attempt) {
        ULONG retLen = 0;
        LONG status = g_pNtQSI(
            SystemProcessInformation,
            buf.data(),
            static_cast<ULONG>(buf.size()),
            &retLen);
        if (status == 0) {
            BYTE* p = buf.data();
            for (;;) {
                auto* spi = reinterpret_cast<SYSTEM_PROCESS_INFORMATION_LOCAL*>(p);
                DWORD pid = static_cast<DWORD>(reinterpret_cast<uintptr_t>(spi->UniqueProcessId));
                if (pid != 0) {
                    ProcessIoSnapshot snap{};
                    snap.read_bytes  = static_cast<uint64_t>(spi->ReadTransferCount.QuadPart);
                    snap.write_bytes = static_cast<uint64_t>(spi->WriteTransferCount.QuadPart);
                    snap.other_bytes = static_cast<uint64_t>(spi->OtherTransferCount.QuadPart);
                    out.emplace(pid, snap);
                }
                if (spi->NextEntryOffset == 0) break;
                p += spi->NextEntryOffset;
            }
            return;
        }
        if (status != STATUS_INFO_LENGTH_MISMATCH) return;
        size_t newSize = (retLen > 0) ? (retLen + 64 * 1024) : (buf.size() * 2);
        if (newSize > 16 * 1024 * 1024) return;
        buf.resize(newSize);
    }
}

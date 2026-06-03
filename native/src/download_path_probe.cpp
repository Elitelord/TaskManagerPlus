#include "process_info.h"

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <vector>
#include <string>
#include <algorithm>
#include <cwctype>
#include <mutex>

namespace {

constexpr ULONG kSystemExtendedHandleInformation = 64;

typedef struct _SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX {
    PVOID     Object;
    ULONG_PTR UniqueProcessId;
    ULONG_PTR HandleValue;
    ULONG     GrantedAccess;
    USHORT    CreatorBackTraceIndex;
    USHORT    ObjectTypeIndex;
    ULONG     HandleAttributes;
    ULONG     Reserved;
} SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX;

typedef struct _SYSTEM_HANDLE_INFORMATION_EX {
    ULONG_PTR NumberOfHandles;
    ULONG_PTR Reserved;
    SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX Handles[1];
} SYSTEM_HANDLE_INFORMATION_EX;

typedef LONG (WINAPI *NtQuerySystemInformation_t)(
    ULONG SystemInformationClass,
    PVOID SystemInformation,
    ULONG SystemInformationLength,
    PULONG ReturnLength);

NtQuerySystemInformation_t g_pNtQSI = nullptr;
std::once_flag g_nt_once;

void load_nt() {
    HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    if (!ntdll) ntdll = LoadLibraryW(L"ntdll.dll");
    if (!ntdll) return;
    g_pNtQSI = reinterpret_cast<NtQuerySystemInformation_t>(
        GetProcAddress(ntdll, "NtQuerySystemInformation"));
}

void try_enable_debug_privilege() {
    HANDLE token = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &token))
        return;
    LUID luid{};
    if (!LookupPrivilegeValueW(nullptr, SE_DEBUG_NAME, &luid)) {
        CloseHandle(token);
        return;
    }
    TOKEN_PRIVILEGES tp{};
    tp.PrivilegeCount = 1;
    tp.Privileges[0].Luid = luid;
    tp.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
    AdjustTokenPrivileges(token, FALSE, &tp, sizeof(tp), nullptr, nullptr);
    CloseHandle(token);
}

static std::wstring to_lower(std::wstring s) {
    for (auto& c : s) c = static_cast<wchar_t>(towlower(c));
    return s;
}

static bool contains_icase(const std::wstring& hay, const wchar_t* needle) {
    return to_lower(hay).find(needle) != std::wstring::npos;
}

static bool is_noise_path(const std::wstring& path) {
    if (path.empty()) return true;
    if (contains_icase(path, L"\\windows\\")) return true;
    if (contains_icase(path, L"\\system32\\")) return true;
    if (contains_icase(path, L"\\winsxs\\")) return true;
    if (contains_icase(path, L"\\program files\\windowsapps\\")) return true;
    if (contains_icase(path, L"\\$recycle.bin\\")) return true;
    if (contains_icase(path, L"\\pagefile.sys")) return true;
    if (contains_icase(path, L"\\hiberfil.sys")) return true;
    if (contains_icase(path, L"\\swapfile.sys")) return true;
    return false;
}

static int score_download_path(const std::wstring& path, const FILETIME& writeTime) {
    int score = 0;
    const std::wstring lower = to_lower(path);

    if (contains_icase(path, L"\\downloads\\")) score += 40;
    if (contains_icase(path, L"\\programdata\\")) score += 25;
    if (contains_icase(path, L"\\appdata\\")) score += 20;
    if (contains_icase(path, L"\\steam\\")) score += 30;
    if (contains_icase(path, L"\\battle.net\\")) score += 35;
    if (contains_icase(path, L"\\epic games\\")) score += 30;
    if (contains_icase(path, L"\\origin\\")) score += 25;
    if (contains_icase(path, L"\\ubisoft")) score += 25;
    if (contains_icase(path, L"\\xboxgames\\")) score += 30;

    if (lower.ends_with(L".tmp") || lower.ends_with(L".download") ||
        lower.ends_with(L".part") || lower.ends_with(L".crdownload") ||
        lower.ends_with(L".partial") || lower.ends_with(L".pak") ||
        lower.ends_with(L".bin") || lower.ends_with(L".dat")) {
        score += 25;
    }

    ULARGE_INTEGER wt{}, now{};
    wt.LowPart = writeTime.dwLowDateTime;
    wt.HighPart = writeTime.dwHighDateTime;
    GetSystemTimeAsFileTime(reinterpret_cast<FILETIME*>(&now));
    if (wt.QuadPart > 0 && now.QuadPart > wt.QuadPart) {
        const ULONGLONG ageSec = (now.QuadPart - wt.QuadPart) / 10'000'000ULL;
        if (ageSec < 120) score += 30;
        else if (ageSec < 600) score += 15;
    }

    // Prefer deeper paths under data dirs (game patches often nest deeply).
    const size_t depth = std::count(path.begin(), path.end(), L'\\');
    if (depth >= 4) score += static_cast<int>(std::min<size_t>(depth, 12));

    return score;
}

struct Candidate {
    std::wstring path;
    int score = 0;
};

} // namespace

extern "C" DLL_EXPORT int32_t probe_process_download_path(
    uint32_t pid,
    wchar_t* path_out,
    int32_t path_chars
) {
    if (!path_out || path_chars < 8 || pid == 0) return 0;
    path_out[0] = L'\0';

    std::call_once(g_nt_once, load_nt);
    if (!g_pNtQSI) return 0;

    static std::once_flag debug_once;
    std::call_once(debug_once, try_enable_debug_privilege);

    HANDLE hProcess = OpenProcess(PROCESS_DUP_HANDLE, FALSE, pid);
    if (!hProcess) {
        hProcess = OpenProcess(PROCESS_DUP_HANDLE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    }
    if (!hProcess) return 0;

    std::vector<BYTE> buf;
    ULONG retLen = 0;
    // NTSTATUS — not pulled in with WIN32_LEAN_AND_MEAN; NtQSI returns LONG.
    LONG status = -1;
    for (int attempt = 0; attempt < 4; ++attempt) {
        status = g_pNtQSI(kSystemExtendedHandleInformation, buf.data(),
                          static_cast<ULONG>(buf.size()), &retLen);
        if (status == 0) break;
        if (retLen == 0) break;
        buf.resize(retLen + 0x10000);
    }

    if (status != 0 || buf.empty()) {
        CloseHandle(hProcess);
        return 0;
    }

    auto* info = reinterpret_cast<SYSTEM_HANDLE_INFORMATION_EX*>(buf.data());
    const ULONG_PTR count = info->NumberOfHandles;

    const DWORD writeMask =
        FILE_WRITE_DATA | FILE_APPEND_DATA | GENERIC_WRITE | FILE_GENERIC_WRITE;

    std::vector<Candidate> candidates;
    candidates.reserve(32);

    for (ULONG_PTR i = 0; i < count; ++i) {
        const auto& e = info->Handles[i];
        if (static_cast<DWORD>(e.UniqueProcessId) != pid) continue;
        if ((e.GrantedAccess & writeMask) == 0) continue;

        HANDLE hDup = nullptr;
        if (!DuplicateHandle(
                hProcess,
                reinterpret_cast<HANDLE>(e.HandleValue),
                GetCurrentProcess(),
                &hDup,
                0,
                FALSE,
                DUPLICATE_SAME_ACCESS)) {
            continue;
        }

        if (GetFileType(hDup) != FILE_TYPE_DISK) {
            CloseHandle(hDup);
            continue;
        }

        wchar_t path[MAX_PATH * 4] = {};
        const DWORD got = GetFinalPathNameByHandleW(
            hDup, path, static_cast<DWORD>(std::size(path)), FILE_NAME_NORMALIZED);
        CloseHandle(hDup);

        if (got == 0 || got >= std::size(path)) continue;

        std::wstring wpath(path, got);
        // `\\?\C:\...` → `C:\...`
        if (wpath.rfind(L"\\\\?\\", 0) == 0) {
            wpath = wpath.substr(4);
        }

        if (is_noise_path(wpath)) continue;

        DWORD attrs = GetFileAttributesW(wpath.c_str());
        if (attrs == INVALID_FILE_ATTRIBUTES) continue;
        if (attrs & FILE_ATTRIBUTE_DIRECTORY) continue;

        WIN32_FILE_ATTRIBUTE_DATA fad{};
        FILETIME writeTime{};
        if (GetFileAttributesExW(wpath.c_str(), GetFileExInfoStandard, &fad)) {
            writeTime = fad.ftLastWriteTime;
        }

        Candidate c;
        c.path = std::move(wpath);
        c.score = score_download_path(c.path, writeTime);

        LARGE_INTEGER size{};
        HANDLE hFile = CreateFileW(
            c.path.c_str(), GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (hFile != INVALID_HANDLE_VALUE) {
            if (GetFileSizeEx(hFile, &size) && size.QuadPart > 0) {
                // Growing files score higher — cap contribution.
                const int mb = static_cast<int>(std::min<ULONGLONG>(size.QuadPart / (1024 * 1024), 50));
                c.score += mb;
            }
            CloseHandle(hFile);
        }

        if (c.score > 0) candidates.push_back(std::move(c));
    }

    CloseHandle(hProcess);

    if (candidates.empty()) return 0;

    std::sort(candidates.begin(), candidates.end(),
              [](const Candidate& a, const Candidate& b) { return a.score > b.score; });

    const std::wstring& best = candidates[0].path;
    if (best.empty()) return 0;

    wcsncpy_s(path_out, static_cast<size_t>(path_chars), best.c_str(), _TRUNCATE);
    return 1;
}

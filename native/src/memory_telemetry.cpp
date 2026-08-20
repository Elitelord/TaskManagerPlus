#include "process_info.h"

// Do not define WIN32_LEAN_AND_MEAN here so GDI+ gets the PROPID and OLE definitions it needs
#include <windows.h>
#include <psapi.h>
#include <vector>
#include <cstring>
#include <objbase.h>
#include <gdiplus.h>
#include <shlobj.h>
#include <commoncontrols.h>    // IImageList (for SHIL_JUMBO 256px icons)
#include <wincrypt.h>
#include <mutex>
#include <cwctype>
#include <unordered_map>
#include <string>

#pragma comment(lib, "comctl32.lib")

// ---------------------------------------------------------------------------
// NtQuerySystemInformation — primary process enumeration source.
//
// EnumProcesses() + OpenProcess() misses several OS-protected processes whose
// memory still counts toward `used_ram` from MEMORYSTATUSEX:
//   - "Memory Compression" (often 1-3 GB of compressed cold pages)
//   - "System"             (kernel threads + driver-mapped pages, PID 4)
//   - "Secure System"      (VBS / VTL1 secure kernel)
//   - "Registry"           (system hive cache)
//   - "vmmem" / "vmmemWSL" (Hyper-V / WSL2 VM memory)
//
// NtQuerySystemInformation(SystemProcessInformation) is filled by the kernel
// directly so it returns ALL processes including the ones above, with their
// authoritative WorkingSetSize and (Win 8.1+) WorkingSetPrivateSize. We use it
// as the primary source of truth, then enrich each entry with icon + version
// info via OpenProcess where possible.
// ---------------------------------------------------------------------------

namespace {

typedef struct _UNICODE_STRING_LOCAL {
    USHORT Length;
    USHORT MaximumLength;
    PWSTR  Buffer;
} UNICODE_STRING_LOCAL;

// Layout matches Windows 8.1+ SYSTEM_PROCESS_INFORMATION. We declare it locally
// so we don't pull in <winternl.h>'s redacted version and so WorkingSetPrivateSize
// is available on every SDK we might compile against.
typedef struct _SYSTEM_PROCESS_INFORMATION_LOCAL {
    ULONG NextEntryOffset;
    ULONG NumberOfThreads;
    LARGE_INTEGER WorkingSetPrivateSize;     // Win 8+ — sized field, not a pointer
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
    SIZE_T PagefileUsage;                    // ≈ PrivateUsage
    SIZE_T PeakPagefileUsage;
    SIZE_T PrivatePageCount;                 // PrivateUsage in pages
    LARGE_INTEGER ReadOperationCount;
    LARGE_INTEGER WriteOperationCount;
    LARGE_INTEGER OtherOperationCount;
    LARGE_INTEGER ReadTransferCount;
    LARGE_INTEGER WriteTransferCount;
    LARGE_INTEGER OtherTransferCount;
    // SYSTEM_THREAD_INFORMATION Threads[1];  — variable-length, we don't read threads
} SYSTEM_PROCESS_INFORMATION_LOCAL;

typedef LONG (WINAPI *NtQuerySystemInformation_t)(
    ULONG SystemInformationClass,
    PVOID SystemInformation,
    ULONG SystemInformationLength,
    PULONG ReturnLength
);

static NtQuerySystemInformation_t g_pNtQSI = nullptr;
static std::once_flag g_ntdll_flag;

static void load_ntdll() {
    HMODULE h = GetModuleHandleW(L"ntdll.dll");
    if (!h) h = LoadLibraryW(L"ntdll.dll");
    if (!h) return;
    g_pNtQSI = reinterpret_cast<NtQuerySystemInformation_t>(
        GetProcAddress(h, "NtQuerySystemInformation"));
}

// Per-PID kernel-reported memory snapshot. Sourced from one
// NtQuerySystemInformation call so the values are consistent with each other.
struct KernelProcSnapshot {
    uint64_t working_set;
    uint64_t private_working_set;
    uint64_t pagefile_usage;
    uint64_t page_faults;
    std::wstring image_name;            // raw kernel name e.g. "Memory Compression"
};

// Returns a PID → KernelProcSnapshot map. Empty on failure.
static std::unordered_map<DWORD, KernelProcSnapshot> enumerate_via_nt() {
    std::call_once(g_ntdll_flag, load_ntdll);
    std::unordered_map<DWORD, KernelProcSnapshot> out;
    if (!g_pNtQSI) return out;

    constexpr ULONG SystemProcessInformation = 5;
    constexpr LONG STATUS_INFO_LENGTH_MISMATCH = (LONG)0xC0000004L;

    // Grow buffer until the call fits. 512 KB is enough for ~1500 processes.
    std::vector<BYTE> buf(512 * 1024);
    for (int attempt = 0; attempt < 6; ++attempt) {
        ULONG retLen = 0;
        LONG status = g_pNtQSI(
            SystemProcessInformation,
            buf.data(),
            static_cast<ULONG>(buf.size()),
            &retLen);
        if (status == 0) {
            // Walk the linked list of variable-length entries.
            BYTE* p = buf.data();
            for (;;) {
                auto* spi = reinterpret_cast<SYSTEM_PROCESS_INFORMATION_LOCAL*>(p);
                DWORD pid = static_cast<DWORD>(reinterpret_cast<uintptr_t>(spi->UniqueProcessId));
                if (pid != 0) {
                    KernelProcSnapshot snap{};
                    snap.working_set = static_cast<uint64_t>(spi->WorkingSetSize);
                    snap.private_working_set = static_cast<uint64_t>(spi->WorkingSetPrivateSize.QuadPart);
                    snap.pagefile_usage = static_cast<uint64_t>(spi->PagefileUsage);
                    snap.page_faults = spi->PageFaultCount;
                    if (spi->ImageName.Buffer && spi->ImageName.Length > 0) {
                        snap.image_name.assign(
                            spi->ImageName.Buffer,
                            spi->ImageName.Length / sizeof(wchar_t));
                    }
                    out.emplace(pid, std::move(snap));
                }
                if (spi->NextEntryOffset == 0) break;
                p += spi->NextEntryOffset;
            }
            return out;
        }
        if (status != STATUS_INFO_LENGTH_MISMATCH) return out;
        // Grow and retry.
        size_t newSize = (retLen > 0) ? (retLen + 64 * 1024) : (buf.size() * 2);
        if (newSize > 16 * 1024 * 1024) return out;  // sanity cap @ 16 MB
        buf.resize(newSize);
    }
    return out;
}

// Friendly display name for OS-protected processes that have no exe path / icon.
// Returns nullptr if the name isn't a known special-case, in which case the
// caller falls back to the kernel-reported image name.
static const wchar_t* friendly_protected_name(const wchar_t* image_name) {
    if (!image_name || !*image_name) return nullptr;
    struct Entry { const wchar_t* key; const wchar_t* friendly; };
    static const Entry table[] = {
        { L"System",              L"System (Kernel + drivers)" },
        { L"Secure System",       L"Secure System (VBS / VTL1)" },
        { L"Memory Compression",  L"Memory Compression (compressed cold pages)" },
        { L"Registry",            L"Registry (system hive cache)" },
        { L"vmmem",               L"vmmem (Hyper-V / WSL2 VM)" },
        { L"vmmemWSL",            L"WSL2 Linux VM" },
    };
    for (const auto& e : table) {
        if (_wcsicmp(image_name, e.key) == 0) return e.friendly;
    }
    return nullptr;
}

} // namespace

static std::once_flag gdiplus_flag;
static ULONG_PTR gdiplusToken = 0;

void InitGdiplus() {
    Gdiplus::GdiplusStartupInput gdiplusStartupInput;
    Gdiplus::GdiplusStartup(&gdiplusToken, &gdiplusStartupInput, NULL);
}

// Extract the highest-quality icon the shell image list can provide for a
// given file. Returns an HICON owned by the caller (must DestroyIcon) or NULL.
//
// Falls back through SHIL_JUMBO (256) -> SHIL_EXTRALARGE (48) -> SHIL_LARGE (32)
// -> ExtractIconExW. Apps like Chrome, VS Code, Discord etc. embed 256px icon
// groups that ExtractIconExW / SHGetFileInfo won't return at high res — only
// the shell image list preserves them.
static HICON ExtractHiResIcon(const WCHAR* path) {
    HICON hIcon = NULL;

    // Step 1: resolve the file's system icon index.
    SHFILEINFOW sfi = {0};
    if (SHGetFileInfoW(path, 0, &sfi, sizeof(sfi), SHGFI_SYSICONINDEX) == 0) {
        return NULL;
    }
    int iconIndex = sfi.iIcon;

    // Step 2: pull successively smaller image lists until one yields an icon.
    const int sizes[] = { SHIL_JUMBO, SHIL_EXTRALARGE, SHIL_LARGE };
    for (int shil : sizes) {
        IImageList* pImgList = nullptr;
        HRESULT hr = SHGetImageList(shil, IID_IImageList, reinterpret_cast<void**>(&pImgList));
        if (SUCCEEDED(hr) && pImgList) {
            // ILD_PRESERVEALPHA keeps the icon's 32-bit alpha channel. With
            // ILD_TRANSPARENT alone the shell renders against the AND mask
            // instead, so every semi-transparent or transparent pixel comes
            // back opaque black — which is invisible against the dark theme's
            // near-black page and shows up as a black box in light mode.
            pImgList->GetIcon(iconIndex, ILD_TRANSPARENT | ILD_PRESERVEALPHA, &hIcon);
            pImgList->Release();
            if (hIcon) return hIcon;
        }
    }

    // Step 3: legacy fallback (32px).
    ExtractIconExW(path, 0, &hIcon, NULL, 1);
    return hIcon;
}

static int GetEncoderClsid(const WCHAR* format, CLSID* pClsid);

// ---------------------------------------------------------------------------
// Per-exe enrichment cache.
//
// Version resources (FileDescription / CompanyName / ProductName) and icons
// are immutable for a given image path while the file exists, but extracting
// them opens the exe on disk 3-4 times (GetFileVersionInfo* twice, the shell
// icon-index lookup, the ExtractIconExW fallback). Doing that for every
// process on every poll tick (~420 processes / 2 s) sustained ~800 file
// opens/sec — Defender mirrors each open, and the kernel's deferred-close
// path can't drain at that rate, so File/FMfn pool objects pile up by the
// millions until every Chromium-based window on the machine freezes.
// Caching by path means each unique exe is opened once per app run.
// Extraction failures are cached too, so unreadable images aren't retried
// every tick. An in-place exe update shows a stale icon until app restart —
// acceptable for what it buys.
// ---------------------------------------------------------------------------
struct ExeEnrichment {
    std::wstring display_name;   // version-resource FileDescription
    std::wstring company_name;
    std::wstring product_name;
    std::string  icon_base64;    // empty when no icon could be extracted
};

static std::wstring enrichment_key(const WCHAR* path) {
    std::wstring key(path);
    for (auto& c : key) c = towlower(c);
    return key;
}

// Extracts version metadata + icon for one image path. This is the slow,
// file-opening work — call only on cache miss.
static ExeEnrichment build_enrichment(const WCHAR* imagePath) {
    ExeEnrichment e;

    // Version-resource metadata. FileDescription drives display_name;
    // CompanyName / ProductName feed the workload detector's metadata
    // keyword matching (see src/lib/insights.ts).
    DWORD dummy;
    DWORD verSize = GetFileVersionInfoSizeW(imagePath, &dummy);
    if (verSize > 0) {
        std::vector<BYTE> verData(verSize);
        if (GetFileVersionInfoW(imagePath, 0, verSize, verData.data())) {
            struct LANGANDCODEPAGE {
                WORD wLanguage;
                WORD wCodePage;
            } *lpTranslate;
            UINT cbTranslate;
            if (VerQueryValueW(verData.data(), L"\\VarFileInfo\\Translation", (LPVOID*)&lpTranslate, &cbTranslate)
                && cbTranslate >= sizeof(LANGANDCODEPAGE)) {
                auto queryField = [&](const wchar_t* field, std::wstring& dest) {
                    WCHAR subBlock[256];
                    wsprintfW(subBlock, L"\\StringFileInfo\\%04x%04x\\%s",
                        lpTranslate[0].wLanguage, lpTranslate[0].wCodePage, field);
                    LPWSTR value = NULL;
                    UINT valLen = 0;
                    if (VerQueryValueW(verData.data(), subBlock, (LPVOID*)&value, &valLen) && valLen > 0) {
                        dest.assign(value);
                    }
                };
                queryField(L"FileDescription", e.display_name);
                queryField(L"CompanyName",     e.company_name);
                queryField(L"ProductName",     e.product_name);
            }
        }
    }

    // Icon: highest-res the shell can give us (256px for modern apps),
    // downscaled to 64x64 in GDI+ with HighQualityBicubic interpolation.
    // Rendering the source at ~4x the DOM display size keeps it crisp at
    // 2x DPI, while staying well under the 16 KB base64 buffer
    // (typically ~5-10 KB PNG).
    std::call_once(gdiplus_flag, InitGdiplus);
    HICON hIcon = ExtractHiResIcon(imagePath);
    if (hIcon) {
        Gdiplus::Bitmap* src = Gdiplus::Bitmap::FromHICON(hIcon);
        if (src) {
            const int kTargetSize = 64;
            Gdiplus::Bitmap dst(kTargetSize, kTargetSize, PixelFormat32bppARGB);
            {
                Gdiplus::Graphics g(&dst);
                g.SetInterpolationMode(Gdiplus::InterpolationModeHighQualityBicubic);
                g.SetSmoothingMode(Gdiplus::SmoothingModeHighQuality);
                g.SetPixelOffsetMode(Gdiplus::PixelOffsetModeHighQuality);
                g.SetCompositingQuality(Gdiplus::CompositingQualityHighQuality);
                g.Clear(Gdiplus::Color(0, 0, 0, 0));
                g.DrawImage(src, 0, 0, kTargetSize, kTargetSize);
            }

            CLSID pngClsid;
            if (GetEncoderClsid(L"image/png", &pngClsid) != -1) {
                IStream* stream = NULL;
                if (CreateStreamOnHGlobal(NULL, TRUE, &stream) == S_OK) {
                    if (dst.Save(stream, &pngClsid, NULL) == Gdiplus::Ok) {
                        HGLOBAL hGlobal = NULL;
                        GetHGlobalFromStream(stream, &hGlobal);
                        if (hGlobal) {
                            LPVOID pData = GlobalLock(hGlobal);
                            SIZE_T size = GlobalSize(hGlobal);
                            if (pData && size > 0) {
                                DWORD strLen = 0;
                                CryptBinaryToStringA((const BYTE*)pData, (DWORD)size, CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, NULL, &strLen);
                                if (strLen > 0 && strLen < 16384) {
                                    e.icon_base64.resize(strLen);
                                    CryptBinaryToStringA((const BYTE*)pData, (DWORD)size, CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, e.icon_base64.data(), &strLen);
                                    // CryptBinaryToStringA's returned length includes
                                    // the NUL; trim to the actual string.
                                    e.icon_base64.resize(strnlen(e.icon_base64.c_str(), strLen));
                                }
                            }
                            if (pData) GlobalUnlock(hGlobal);
                        }
                    }
                    stream->Release();
                }
            }
            delete src;
        }
        DestroyIcon(hIcon);
    }

    return e;
}

// Cache lookup. Entries are never mutated after insertion and unordered_map
// never invalidates references on insert, so returning a const& is safe even
// with concurrent callers inserting other keys.
static const ExeEnrichment& enrichment_for_path(const WCHAR* imagePath) {
    static std::mutex g_enrich_mutex;
    static std::unordered_map<std::wstring, ExeEnrichment> g_enrich_cache;

    std::wstring key = enrichment_key(imagePath);
    {
        std::lock_guard<std::mutex> lock(g_enrich_mutex);
        auto it = g_enrich_cache.find(key);
        if (it != g_enrich_cache.end()) return it->second;
    }

    // Slow path outside the lock. If two threads race on the same new exe,
    // emplace keeps the first result and the duplicate work is discarded.
    ExeEnrichment built = build_enrichment(imagePath);
    std::lock_guard<std::mutex> lock(g_enrich_mutex);
    return g_enrich_cache.emplace(std::move(key), std::move(built)).first->second;
}

static int GetEncoderClsid(const WCHAR* format, CLSID* pClsid) {
    UINT num = 0;
    UINT size = 0;
    Gdiplus::GetImageEncodersSize(&num, &size);
    if (size == 0) return -1;
    Gdiplus::ImageCodecInfo* pImageCodecInfo = (Gdiplus::ImageCodecInfo*)(malloc(size));
    if (pImageCodecInfo == NULL) return -1;
    Gdiplus::GetImageEncoders(num, size, pImageCodecInfo);
    for (UINT j = 0; j < num; ++j) {
        if (wcscmp(pImageCodecInfo[j].MimeType, format) == 0) {
            *pClsid = pImageCodecInfo[j].Clsid;
            free(pImageCodecInfo);
            return j;
        }
    }
    free(pImageCodecInfo);
    return -1;
}

// Row count from the last fill call, so a count-only probe can answer without
// re-running the full NtQuerySystemInformation enumeration. The memory list
// keeps no other per-tick state, so this single value is all we cache.
static size_t g_last_mem_count = 0;

extern "C" DLL_EXPORT int32_t get_process_memory_list(ProcessMemoryInfo* buffer, int32_t max_count) {
    // Count-only probe: answer with the last fill's row count instead of
    // re-running enumerate_via_nt(). May be stale by one tick; the caller
    // (load_list) probes only on its first call per symbol or a possible
    // truncation, and the fill clamps to max_count. First-ever call (count
    // still 0) falls through so the count is exact.
    if (buffer == nullptr && g_last_mem_count > 0) {
        return static_cast<int32_t>(g_last_mem_count);
    }

    // Primary enumeration: NtQuerySystemInformation. Returns ALL processes
    // including OS-protected ones (Memory Compression, System, Secure System,
    // Registry, vmmem) that EnumProcesses + OpenProcess can't see.
    auto nt_map = enumerate_via_nt();

    if (nt_map.empty()) {
        // Fallback to EnumProcesses if NT API unavailable (very old Windows or
        // ntdll missing). We lose the protected processes but at least get
        // user-mode coverage.
        DWORD pids[1024];
        DWORD bytes_returned = 0;
        if (!EnumProcesses(pids, sizeof(pids), &bytes_returned)) return 0;
        DWORD num = bytes_returned / sizeof(DWORD);
        for (DWORD i = 0; i < num; ++i) {
            if (pids[i] != 0) {
                nt_map.emplace(pids[i], KernelProcSnapshot{});
            }
        }
    }

    // Null buffer = caller is asking for the count.
    if (buffer == nullptr) {
        return static_cast<int32_t>(nt_map.size());
    }

    int32_t filled = 0;

    for (const auto& kv : nt_map) {
        if (filled >= max_count) break;
        DWORD pid = kv.first;
        if (pid == 0) continue;  // Skip System Idle Process
        const KernelProcSnapshot& snap = kv.second;

        // Try to open for icon + version info enrichment. Failures are expected
        // for protected processes — we still include them using NT-snapshot data.
        HANDLE hProcess = OpenProcess(
            PROCESS_QUERY_INFORMATION | PROCESS_VM_READ,
            FALSE,
            pid
        );
        if (!hProcess) {
            hProcess = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        }

        ProcessMemoryInfo& info = buffer[filled];
        memset(&info, 0, sizeof(ProcessMemoryInfo));
        info.pid = pid;

        // Get process name and path. Prefer OpenProcess-derived path so we can
        // extract icons + version metadata; fall back to NT image name otherwise.
        WCHAR imagePath[MAX_PATH] = {0};
        bool hasPath = false;

        if (hProcess) {
            HMODULE hMod;
            DWORD cbNeeded;
            if (EnumProcessModules(hProcess, &hMod, sizeof(hMod), &cbNeeded)) {
                GetModuleBaseNameW(hProcess, hMod, info.name, 260);
                if (GetModuleFileNameExW(hProcess, hMod, imagePath, MAX_PATH)) {
                    hasPath = true;
                }
            } else {
                DWORD pathLen = MAX_PATH;
                if (QueryFullProcessImageNameW(hProcess, 0, imagePath, &pathLen)) {
                    hasPath = true;
                    const wchar_t* lastSlash = wcsrchr(imagePath, L'\\');
                    if (lastSlash) wcscpy_s(info.name, 260, lastSlash + 1);
                    else           wcscpy_s(info.name, 260, imagePath);
                }
            }
        }

        // If we still have no name, take it from the NT snapshot.
        if (info.name[0] == L'\0') {
            if (!snap.image_name.empty()) {
                wcsncpy_s(info.name, 260, snap.image_name.c_str(), _TRUNCATE);
            } else {
                wsprintfW(info.name, L"PID %u", pid);
            }
        }

        // 1. Display name + version-resource metadata + image path + icon,
        //    all served from the per-exe cache (opened at most once per
        //    unique path per app run — see ExeEnrichment above). image_path
        //    lets the workload detector match install-path hints
        //    (e.g. "steamapps").
        info.display_name[0] = L'\0';
        info.company_name[0] = L'\0';
        info.product_name[0] = L'\0';
        info.image_path[0]   = L'\0';
        info.icon_base64[0]  = '\0';
        if (hasPath) {
            wcsncpy_s(info.image_path, 260, imagePath, _TRUNCATE);
            const ExeEnrichment& enrich = enrichment_for_path(imagePath);
            if (!enrich.display_name.empty())
                wcsncpy_s(info.display_name, 260, enrich.display_name.c_str(), _TRUNCATE);
            if (!enrich.company_name.empty())
                wcsncpy_s(info.company_name, 260, enrich.company_name.c_str(), _TRUNCATE);
            if (!enrich.product_name.empty())
                wcsncpy_s(info.product_name, 260, enrich.product_name.c_str(), _TRUNCATE);
            if (!enrich.icon_base64.empty())
                strncpy_s(info.icon_base64, 16384, enrich.icon_base64.c_str(), _TRUNCATE);
        }

        // Fallback: friendly name for OS-protected processes ("Memory
        // Compression", "System", "Secure System", "Registry", "vmmem*"), then
        // capitalized exe name for everything else.
        if (info.display_name[0] == L'\0') {
            const wchar_t* friendly = friendly_protected_name(info.name);
            if (friendly) {
                wcscpy_s(info.display_name, 260, friendly);
            } else {
                WCHAR temp[260];
                wcscpy_s(temp, 260, info.name);
                WCHAR* dot = wcsrchr(temp, L'.');
                if (dot) *dot = L'\0';
                if (temp[0] >= L'a' && temp[0] <= L'z') {
                    temp[0] = temp[0] - (L'a' - L'A');
                }
                wcscpy_s(info.display_name, 260, temp);
            }
        }

        // Get memory info. We use PROCESS_MEMORY_COUNTERS_EX2 (Win10 1709+)
        // so we can report PrivateWorkingSetSize — the exact metric Task
        // Manager shows in its default "Memory" column. The legacy
        // PrivateUsage field (committed virtual memory) massively overstates
        // real footprint for Chromium-based apps because V8 reserves huge
        // virtual heaps; using it for the UI made our own app report ~3 GB
        // while Task Manager said ~200 MB.
        //
        // We define the struct inline in case the installed SDK is older.
        struct PMC_EX2 {
            DWORD   cb;
            DWORD   PageFaultCount;
            SIZE_T  PeakWorkingSetSize;
            SIZE_T  WorkingSetSize;
            SIZE_T  QuotaPeakPagedPoolUsage;
            SIZE_T  QuotaPagedPoolUsage;
            SIZE_T  QuotaPeakNonPagedPoolUsage;
            SIZE_T  QuotaNonPagedPoolUsage;
            SIZE_T  PagefileUsage;
            SIZE_T  PeakPagefileUsage;
            SIZE_T  PrivateUsage;
            ULONG64 PrivateWorkingSetSize;
            ULONG64 SharedCommitUsage;
        };
        bool got_mem = false;
        if (hProcess) {
            PMC_EX2 pmc2 = {0};
            pmc2.cb = sizeof(PMC_EX2);
            bool have_ex2 = GetProcessMemoryInfo(
                hProcess,
                reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&pmc2),
                sizeof(PMC_EX2)) != 0;

            if (have_ex2) {
                info.private_bytes = pmc2.PrivateUsage;
                info.working_set = pmc2.WorkingSetSize;
                info.private_working_set = static_cast<uint64_t>(pmc2.PrivateWorkingSetSize);
                if (pmc2.WorkingSetSize > pmc2.PrivateUsage) {
                    info.shared_bytes = pmc2.WorkingSetSize - pmc2.PrivateUsage;
                } else {
                    info.shared_bytes = 0;
                }
                info.page_faults = pmc2.PageFaultCount;
                got_mem = true;
            } else {
                PROCESS_MEMORY_COUNTERS_EX pmc = {0};
                pmc.cb = sizeof(pmc);
                if (GetProcessMemoryInfo(hProcess, reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&pmc), sizeof(pmc))) {
                    info.private_bytes = pmc.PrivateUsage;
                    info.working_set = pmc.WorkingSetSize;
                    info.private_working_set = pmc.WorkingSetSize;
                    info.shared_bytes = 0;
                    info.page_faults = pmc.PageFaultCount;
                    got_mem = true;
                }
            }
        }

        // Protected processes (Memory Compression, System, Secure System,
        // Registry, vmmem*) — OpenProcess fails so we fall back to the
        // kernel-reported NT snapshot. PagefileUsage ≈ PrivateUsage.
        if (!got_mem) {
            info.private_bytes = snap.pagefile_usage;
            info.working_set = snap.working_set;
            info.private_working_set = snap.private_working_set
                ? snap.private_working_set
                : snap.working_set;
            if (snap.working_set > snap.pagefile_usage) {
                info.shared_bytes = snap.working_set - snap.pagefile_usage;
            } else {
                info.shared_bytes = 0;
            }
            info.page_faults = static_cast<DWORD>(snap.page_faults);
        }

        if (hProcess) CloseHandle(hProcess);
        filled++;
    }

    // Remember the row count so the next count-only probe can skip enumeration.
    g_last_mem_count = static_cast<size_t>(filled);
    return filled;
}

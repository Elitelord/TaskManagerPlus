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

#pragma comment(lib, "comctl32.lib")

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
            pImgList->GetIcon(iconIndex, ILD_TRANSPARENT, &hIcon);
            pImgList->Release();
            if (hIcon) return hIcon;
        }
    }

    // Step 3: legacy fallback (32px).
    ExtractIconExW(path, 0, &hIcon, NULL, 1);
    return hIcon;
}

int GetEncoderClsid(const WCHAR* format, CLSID* pClsid) {
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

extern "C" DLL_EXPORT int32_t get_process_memory_list(ProcessMemoryInfo* buffer, int32_t max_count) {
    // Get list of all process IDs
    DWORD pids[1024];
    DWORD bytes_returned = 0;

    if (!EnumProcesses(pids, sizeof(pids), &bytes_returned)) {
        return 0;
    }

    DWORD num_processes = bytes_returned / sizeof(DWORD);

    // If buffer is null, just return the count
    if (buffer == nullptr) {
        return static_cast<int32_t>(num_processes);
    }

    int32_t filled = 0;

    for (DWORD i = 0; i < num_processes && filled < max_count; i++) {
        DWORD pid = pids[i];
        if (pid == 0) continue; // Skip System Idle Process

        HANDLE hProcess = OpenProcess(
            PROCESS_QUERY_INFORMATION | PROCESS_VM_READ,
            FALSE,
            pid
        );

        if (!hProcess) {
            // Try with limited access for name at least
            hProcess = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
            if (!hProcess) continue;
        }

        ProcessMemoryInfo& info = buffer[filled];
        memset(&info, 0, sizeof(ProcessMemoryInfo));
        info.pid = pid;

        std::call_once(gdiplus_flag, InitGdiplus);

        // Get process name and path
        HMODULE hMod;
        DWORD cbNeeded;
        WCHAR imagePath[MAX_PATH] = {0};
        bool hasPath = false;

        if (EnumProcessModules(hProcess, &hMod, sizeof(hMod), &cbNeeded)) {
            GetModuleBaseNameW(hProcess, hMod, info.name, 260);
            if (GetModuleFileNameExW(hProcess, hMod, imagePath, MAX_PATH)) {
                hasPath = true;
            }
        } else {
            // Fallback: try GetProcessImageFileName or just use PID
            DWORD pathLen = MAX_PATH;
            if (QueryFullProcessImageNameW(hProcess, 0, imagePath, &pathLen)) {
                hasPath = true;
                // Extract just the filename
                const wchar_t* lastSlash = wcsrchr(imagePath, L'\\');
                if (lastSlash) {
                    wcscpy_s(info.name, 260, lastSlash + 1);
                } else {
                    wcscpy_s(info.name, 260, imagePath);
                }
            } else {
                wsprintfW(info.name, L"PID %u", pid);
            }
        }

        // 1. Get Display Name
        info.display_name[0] = L'\0';
        if (hasPath) {
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
                    if (VerQueryValueW(verData.data(), L"\\VarFileInfo\\Translation", (LPVOID*)&lpTranslate, &cbTranslate)) {
                        WCHAR subBlock[256];
                        wsprintfW(subBlock, L"\\StringFileInfo\\%04x%04x\\FileDescription",
                            lpTranslate[0].wLanguage, lpTranslate[0].wCodePage);
                        LPWSTR fileDesc = NULL;
                        UINT descLen = 0;
                        if (VerQueryValueW(verData.data(), subBlock, (LPVOID*)&fileDesc, &descLen) && descLen > 0) {
                            wcsncpy_s(info.display_name, 260, fileDesc, _TRUNCATE);
                        }
                    }
                }
            }
        }
        
        // Fallback: if empty, use capitalized exe name
        if (info.display_name[0] == L'\0') {
            // strip .exe
            WCHAR temp[260];
            wcscpy_s(temp, 260, info.name);
            WCHAR* dot = wcsrchr(temp, L'.');
            if (dot) *dot = L'\0';
            // capitalize first letter
            if (temp[0] >= L'a' && temp[0] <= L'z') {
                temp[0] = temp[0] - (L'a' - L'A');
            }
            wcscpy_s(info.display_name, 260, temp);
        }

        // 2. Get Icon Base64
        //
        // We pull the highest-res icon the shell can give us (256px for modern
        // apps) and then downscale to 64x64 in GDI+ with HighQualityBicubic
        // interpolation. Rendering the source at ~4x the DOM display size
        // keeps it crisp at 2x DPI and on any future upscale, while staying
        // well under the 16 KB base64 buffer (typically ~5-10 KB PNG).
        info.icon_base64[0] = '\0';
        if (hasPath) {
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
                                            CryptBinaryToStringA((const BYTE*)pData, (DWORD)size, CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, info.icon_base64, &strLen);
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
            // Keep legacy shared_bytes approximation (working_set - private_bytes,
            // usually 0 for Chromium processes where private_bytes >> working_set).
            // Frontend sums private_mb + shared_mb for the memory column, matching
            // the original "Private Bytes" metric.
            if (pmc2.WorkingSetSize > pmc2.PrivateUsage) {
                info.shared_bytes = pmc2.WorkingSetSize - pmc2.PrivateUsage;
            } else {
                info.shared_bytes = 0;
            }
            info.page_faults = pmc2.PageFaultCount;
        } else {
            // Fallback for Windows 10 pre-1709 or if EX2 failed for any reason.
            PROCESS_MEMORY_COUNTERS_EX pmc = {0};
            pmc.cb = sizeof(pmc);
            if (GetProcessMemoryInfo(hProcess, reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&pmc), sizeof(pmc))) {
                info.private_bytes = pmc.PrivateUsage;
                info.working_set = pmc.WorkingSetSize;
                info.private_working_set = pmc.WorkingSetSize;  // best approximation
                info.shared_bytes = 0;
                info.page_faults = pmc.PageFaultCount;
            }
        }

        CloseHandle(hProcess);
        filled++;
    }

    return filled;
}

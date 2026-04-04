#include "process_info.h"

// Do not define WIN32_LEAN_AND_MEAN here so GDI+ gets the PROPID and OLE definitions it needs
#include <windows.h>
#include <psapi.h>
#include <vector>
#include <cstring>
#include <objbase.h>
#include <gdiplus.h>
#include <shlobj.h>
#include <wincrypt.h>
#include <mutex>
#include <cwctype>

static std::once_flag gdiplus_flag;
static ULONG_PTR gdiplusToken = 0;

void InitGdiplus() {
    Gdiplus::GdiplusStartupInput gdiplusStartupInput;
    Gdiplus::GdiplusStartup(&gdiplusToken, &gdiplusStartupInput, NULL);
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
        info.icon_base64[0] = '\0';
        if (hasPath) {
            HICON hIcon = NULL;
            // First try ExtractIconExW
            ExtractIconExW(imagePath, 0, NULL, &hIcon, 1);
            if (!hIcon) {
                SHFILEINFOW sfi = {0};
                if (SHGetFileInfoW(imagePath, 0, &sfi, sizeof(sfi), SHGFI_ICON | SHGFI_SMALLICON)) {
                    hIcon = sfi.hIcon;
                }
            }

            if (hIcon) {
                Gdiplus::Bitmap* bmp = Gdiplus::Bitmap::FromHICON(hIcon);
                if (bmp) {
                    CLSID pngClsid;
                    if (GetEncoderClsid(L"image/png", &pngClsid) != -1) {
                        IStream* stream = NULL;
                        if (CreateStreamOnHGlobal(NULL, TRUE, &stream) == S_OK) {
                            if (bmp->Save(stream, &pngClsid, NULL) == Gdiplus::Ok) {
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
                    delete bmp;
                }
                DestroyIcon(hIcon);
            }
        }

        // Get memory info
        PROCESS_MEMORY_COUNTERS_EX pmc = {0};
        pmc.cb = sizeof(pmc);
        if (GetProcessMemoryInfo(hProcess, reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&pmc), sizeof(pmc))) {
            info.private_bytes = pmc.PrivateUsage;
            info.working_set = pmc.WorkingSetSize;
            // Approximate shared memory: working set minus private working set
            // Note: For a more accurate split we'd need QueryWorkingSetEx,
            // but this gives a reasonable approximation
            if (info.working_set > info.private_bytes) {
                info.shared_bytes = info.working_set - info.private_bytes;
            } else {
                info.shared_bytes = 0;
            }
            info.page_faults = pmc.PageFaultCount;
        }

        CloseHandle(hProcess);
        filled++;
    }

    return filled;
}

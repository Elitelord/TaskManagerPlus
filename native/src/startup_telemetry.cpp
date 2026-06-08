#include "startup_info.h"

#include <windows.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <shellapi.h>
#include <commoncontrols.h>
#include <gdiplus.h>
#include <wincrypt.h>
#include <objbase.h>
#include <shobjidl.h>
#include <string>
#include <vector>

#pragma comment(lib, "shlwapi.lib")

namespace {

ULONG_PTR gdiplusToken = 0;
bool gdiplusReady = false;

void EnsureGdiplus() {
    if (gdiplusReady) return;
    Gdiplus::GdiplusStartupInput input;
    if (Gdiplus::GdiplusStartup(&gdiplusToken, &input, nullptr) == Gdiplus::Ok) {
        gdiplusReady = true;
    }
}

static HICON ExtractHiResIcon(const WCHAR* path) {
    HICON hIcon = NULL;
    SHFILEINFOW sfi = {0};
    if (SHGetFileInfoW(path, 0, &sfi, sizeof(sfi), SHGFI_SYSICONINDEX) == 0) {
        return NULL;
    }
    const int sizes[] = { SHIL_JUMBO, SHIL_EXTRALARGE, SHIL_LARGE };
    for (int shil : sizes) {
        IImageList* pImgList = nullptr;
        if (SUCCEEDED(SHGetImageList(shil, IID_IImageList, reinterpret_cast<void**>(&pImgList))) && pImgList) {
            pImgList->GetIcon(sfi.iIcon, ILD_TRANSPARENT, &hIcon);
            pImgList->Release();
            if (hIcon) return hIcon;
        }
    }
    ExtractIconExW(path, 0, &hIcon, NULL, 1);
    return hIcon;
}

static int GetEncoderClsid(const WCHAR* format, CLSID* pClsid) {
    UINT num = 0, size = 0;
    Gdiplus::GetImageEncodersSize(&num, &size);
    if (size == 0) return -1;
    Gdiplus::ImageCodecInfo* info = (Gdiplus::ImageCodecInfo*)malloc(size);
    if (!info) return -1;
    Gdiplus::GetImageEncoders(num, size, info);
    for (UINT j = 0; j < num; ++j) {
        if (wcscmp(info[j].MimeType, format) == 0) {
            *pClsid = info[j].Clsid;
            free(info);
            return (int)j;
        }
    }
    free(info);
    return -1;
}

static void ReadVersionString(const wchar_t* path, const wchar_t* key, wchar_t* out, int outChars) {
    out[0] = L'\0';
    DWORD handle = 0;
    DWORD size = GetFileVersionInfoSizeW(path, &handle);
    if (size == 0) return;
    std::vector<BYTE> data(size);
    if (!GetFileVersionInfoW(path, handle, size, data.data())) return;
    struct LANGANDCODEPAGE { WORD wLanguage; WORD wCodePage; };
    LANGANDCODEPAGE* translate = nullptr;
    UINT translateLen = 0;
    if (!VerQueryValueW(data.data(), L"\\VarFileInfo\\Translation", (LPVOID*)&translate, &translateLen)) return;
    if (translateLen < sizeof(LANGANDCODEPAGE)) return;
    wchar_t subBlock[128];
    swprintf_s(subBlock, L"\\StringFileInfo\\%04x%04x\\%s",
        translate[0].wLanguage, translate[0].wCodePage, key);
    wchar_t* value = nullptr;
    UINT valueLen = 0;
    if (VerQueryValueW(data.data(), subBlock, (LPVOID*)&value, &valueLen) && value) {
        wcsncpy_s(out, outChars, value, _TRUNCATE);
    }
}

// When an app has no true high-resolution icon, the shell image lists (notably
// SHIL_JUMBO, 256px) place the small icon in the TOP-LEFT of a large transparent
// canvas instead of scaling it. Rendered with object-fit, the glyph then looks
// tiny and corner-pinned. Trim the fully-transparent margins and return a tight
// square crop so the glyph fills its frame. Returns nullptr when no trim is
// useful (icon already fills the bitmap, or it's fully transparent); caller then
// uses the original bitmap.
static Gdiplus::Bitmap* TrimTransparentMargins(Gdiplus::Bitmap* src) {
    if (!src) return nullptr;
    const int w = (int)src->GetWidth();
    const int h = (int)src->GetHeight();
    if (w <= 0 || h <= 0) return nullptr;

    Gdiplus::Rect rect(0, 0, w, h);
    Gdiplus::BitmapData data;
    if (src->LockBits(&rect, Gdiplus::ImageLockModeRead, PixelFormat32bppARGB, &data) != Gdiplus::Ok) {
        return nullptr;
    }
    int minX = w, minY = h, maxX = -1, maxY = -1;
    BYTE* base = (BYTE*)data.Scan0;
    for (int y = 0; y < h; ++y) {
        BYTE* row = base + (size_t)y * data.Stride;
        for (int x = 0; x < w; ++x) {
            if (row[x * 4 + 3] > 16) { // alpha
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
    }
    src->UnlockBits(&data);

    if (maxX < minX || maxY < minY) return nullptr; // fully transparent
    const int cw = maxX - minX + 1;
    const int ch = maxY - minY + 1;
    // Already (nearly) fills the bitmap — no trim needed.
    if (cw >= w - 2 && ch >= h - 2) return nullptr;

    // Square crop centred on the content, clamped to the bitmap.
    int side = cw > ch ? cw : ch;
    const int cx = minX + cw / 2;
    const int cy = minY + ch / 2;
    int sx = cx - side / 2;
    int sy = cy - side / 2;
    if (sx < 0) sx = 0;
    if (sy < 0) sy = 0;
    if (sx + side > w) side = w - sx;
    if (sy + side > h) side = h - sy;
    if (side <= 0) return nullptr;
    return src->Clone(sx, sy, side, side, PixelFormat32bppARGB);
}

static void IconToBase64(HICON hIcon, char* out, int outLen) {
    out[0] = '\0';
    if (!hIcon) return;
    EnsureGdiplus();
    Gdiplus::Bitmap* src = Gdiplus::Bitmap::FromHICON(hIcon);
    if (!src) return;

    // Trim transparent margins first (handles the SHIL_JUMBO "small glyph in the
    // top-left of a 256px canvas" case), then redraw onto a fixed 64x64 ARGB
    // canvas with high-quality scaling — the same approach the Processes page
    // uses, which renders crisp, consistently-sized icons.
    Gdiplus::Bitmap* trimmed = TrimTransparentMargins(src);
    Gdiplus::Bitmap* glyph = trimmed ? trimmed : src;

    const int kTargetSize = 64;
    Gdiplus::Bitmap dst(kTargetSize, kTargetSize, PixelFormat32bppARGB);
    {
        Gdiplus::Graphics g(&dst);
        g.SetInterpolationMode(Gdiplus::InterpolationModeHighQualityBicubic);
        g.SetSmoothingMode(Gdiplus::SmoothingModeHighQuality);
        g.SetPixelOffsetMode(Gdiplus::PixelOffsetModeHighQuality);
        g.SetCompositingQuality(Gdiplus::CompositingQualityHighQuality);
        g.Clear(Gdiplus::Color(0, 0, 0, 0));
        g.DrawImage(glyph, 0, 0, kTargetSize, kTargetSize);
    }

    CLSID clsid;
    if (GetEncoderClsid(L"image/png", &clsid) < 0) {
        delete trimmed;
        delete src;
        return;
    }
    IStream* stream = nullptr;
    if (CreateStreamOnHGlobal(NULL, TRUE, &stream) != S_OK) {
        delete trimmed;
        delete src;
        return;
    }
    if (dst.Save(stream, &clsid, NULL) == Gdiplus::Ok) {
        STATSTG stat = {};
        stream->Stat(&stat, STATFLAG_NONAME);
        ULONG size = (ULONG)stat.cbSize.QuadPart;
        std::vector<BYTE> bytes(size);
        LARGE_INTEGER zero = {};
        stream->Seek(zero, STREAM_SEEK_SET, NULL);
        ULONG read = 0;
        stream->Read(bytes.data(), size, &read);
        DWORD strLen = outLen;
        CryptBinaryToStringA(bytes.data(), read, CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, out, &strLen);
    }
    stream->Release();
    delete trimmed;
    delete src;
}

static void StripIconIndex(wchar_t* path, int chars) {
    if (!path || path[0] == L'\0') return;
    wchar_t* comma = wcsrchr(path, L',');
    if (comma && comma > path) {
        *comma = L'\0';
    }
    if (path[0] == L'"') {
        size_t len = wcslen(path);
        if (len >= 2 && path[len - 1] == L'"') {
            wmemmove(path, path + 1, len - 2);
            path[len - 2] = L'\0';
        }
    }
}

} // namespace

extern "C" DLL_EXPORT int32_t resolve_shortcut_path(
    const wchar_t* shortcut_path,
    wchar_t* out_path,
    int32_t out_path_chars
) {
    if (!shortcut_path || !out_path || out_path_chars < 2) return 0;
    out_path[0] = L'\0';
    HRESULT hr = CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
    bool coInit = SUCCEEDED(hr);

    IShellLinkW* link = nullptr;
    IPersistFile* file = nullptr;
    int32_t ok = 0;
    if (SUCCEEDED(CoCreateInstance(CLSID_ShellLink, NULL, CLSCTX_INPROC_SERVER, IID_IShellLinkW, (void**)&link))) {
        if (SUCCEEDED(link->QueryInterface(IID_IPersistFile, (void**)&file))) {
            if (SUCCEEDED(file->Load(shortcut_path, STGM_READ))) {
                wchar_t target[MAX_PATH] = {0};
                if (SUCCEEDED(link->GetPath(target, MAX_PATH, NULL, SLGP_UNCPRIORITY))) {
                    wcsncpy_s(out_path, out_path_chars, target, _TRUNCATE);
                    ok = out_path[0] ? 1 : 0;
                }
            }
            file->Release();
        }
        link->Release();
    }
    if (coInit) CoUninitialize();
    return ok;
}

extern "C" DLL_EXPORT int32_t get_file_shell_info(const wchar_t* path, FileShellInfo* out) {
    if (!out) return -1;
    ZeroMemory(out, sizeof(FileShellInfo));
    if (!path || path[0] == L'\0') return -1;

    wchar_t resolved[520] = {0};
    wcsncpy_s(resolved, path, _TRUNCATE);
    StripIconIndex(resolved, 520);

    if (PathFileExistsW(resolved)) {
        wcsncpy_s(out->resolved_path, resolved, _TRUNCATE);
    } else {
        wcsncpy_s(out->resolved_path, path, _TRUNCATE);
    }

    const wchar_t* iconPath = out->resolved_path[0] ? out->resolved_path : path;
    HICON hIcon = ExtractHiResIcon(iconPath);
    if (hIcon) {
        IconToBase64(hIcon, out->icon_base64, sizeof(out->icon_base64));
        DestroyIcon(hIcon);
    }

    if (PathFileExistsW(iconPath)) {
        ReadVersionString(iconPath, L"FileDescription", out->display_name, 260);
        ReadVersionString(iconPath, L"CompanyName", out->company_name, 260);
        ReadVersionString(iconPath, L"ProductName", out->product_name, 260);
    }

    if (out->display_name[0] == L'\0') {
        const wchar_t* leaf = wcsrchr(iconPath, L'\\');
        wcsncpy_s(out->display_name, leaf ? leaf + 1 : iconPath, _TRUNCATE);
    }
    return 0;
}

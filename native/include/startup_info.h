#pragma once

#include <stdint.h>

#ifdef BUILDING_DLL
  #define DLL_EXPORT __declspec(dllexport)
#else
  #define DLL_EXPORT __declspec(dllimport)
#endif

// Metadata for a startup entry's resolved executable or shortcut target.
struct FileShellInfo {
    wchar_t  display_name[260];
    wchar_t  company_name[260];
    wchar_t  product_name[260];
    wchar_t  resolved_path[520];
    char     icon_base64[16384];
};

extern "C" {
    // Resolve a .lnk shortcut to its target path + working directory ignored.
    // Returns 1 on success (path written to out_path), 0 on failure.
    DLL_EXPORT int32_t resolve_shortcut_path(
        const wchar_t* shortcut_path,
        wchar_t* out_path,
        int32_t out_path_chars
    );

    // Extract shell icon (base64 PNG) + version-resource metadata for a file.
    // Returns 0 on success, -1 on failure (out struct zeroed).
    DLL_EXPORT int32_t get_file_shell_info(
        const wchar_t* path,
        FileShellInfo* out
    );
}

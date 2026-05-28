#include "process_info.h"

#include <stddef.h>
#include <stdint.h>

// Compile-time guards — if these fail, update INSTALLED_APP_INFO_ABI_VERSION,
// the Rust `RawInstalledAppInfo` mirror, and `INSTALLED_APP_INFO_ABI_VERSION`
// in src-tauri/src/ffi.rs together.
static_assert(sizeof(InstalledAppInfo) % 8 == 0,
              "InstalledAppInfo must stay 8-byte aligned for u64 fields");
static_assert(offsetof(InstalledAppInfo, install_bytes) == 1976,
              "install_bytes offset drifted — bump ABI version and sync Rust");
static_assert(offsetof(InstalledAppInfo, data_bytes) == 1984,
              "data_bytes offset drifted — bump ABI version and sync Rust");
static_assert(offsetof(InstalledAppInfo, size_source) == 1992,
              "size_source offset drifted — bump ABI version and sync Rust");
static_assert(sizeof(InstalledAppInfo) == 2000,
              "InstalledAppInfo size drifted — bump ABI version and sync Rust");

extern "C" DLL_EXPORT InstalledAppInfoAbiLayout get_installed_app_info_abi_layout(void) {
    InstalledAppInfoAbiLayout layout = {};
    layout.version = INSTALLED_APP_INFO_ABI_VERSION;
    layout.struct_size = static_cast<uint32_t>(sizeof(InstalledAppInfo));
    layout.offset_install_bytes = static_cast<uint32_t>(offsetof(InstalledAppInfo, install_bytes));
    layout.offset_data_bytes = static_cast<uint32_t>(offsetof(InstalledAppInfo, data_bytes));
    layout.offset_size_source = static_cast<uint32_t>(offsetof(InstalledAppInfo, size_source));
    return layout;
}

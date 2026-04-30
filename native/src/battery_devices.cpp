#include "battery_devices.h"

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <setupapi.h>
#include <initguid.h>
#include <devguid.h>
#include <mutex>

#pragma comment(lib, "setupapi.lib")

namespace {

// Standard battery device interface class. Same GUID was previously
// declared three times under different local names (BATTERY,
// BATTERY_PWR, BATTERY_SYS). Defined once here.
const GUID kBatteryInterfaceGuid =
    { 0x72631e54, 0x78a4, 0x11d0, { 0xbc, 0xf7, 0x00, 0xaa, 0x00, 0xb7, 0xb3, 0x2a } };

constexpr ULONGLONG kCacheTtlMs = 30'000;

std::mutex g_mu;
std::vector<std::wstring> g_paths;
ULONGLONG g_cache_tick = 0;
bool g_have_cache = false;

void enumerate_locked() {
    g_paths.clear();
    HDEVINFO hdev = SetupDiGetClassDevsW(
        &kBatteryInterfaceGuid, 0, 0,
        DIGCF_PRESENT | DIGCF_DEVICEINTERFACE);
    if (hdev == INVALID_HANDLE_VALUE) return;

    SP_DEVICE_INTERFACE_DATA did = {0};
    did.cbSize = sizeof(did);

    for (int i = 0; SetupDiEnumDeviceInterfaces(
            hdev, 0, &kBatteryInterfaceGuid, i, &did); i++) {
        DWORD size = 0;
        SetupDiGetDeviceInterfaceDetailW(hdev, &did, 0, 0, &size, nullptr);
        if (GetLastError() != ERROR_INSUFFICIENT_BUFFER) continue;

        std::vector<BYTE> buf(size);
        auto* pdidd = reinterpret_cast<PSP_DEVICE_INTERFACE_DETAIL_DATA_W>(buf.data());
        pdidd->cbSize = sizeof(SP_DEVICE_INTERFACE_DETAIL_DATA_W);

        if (SetupDiGetDeviceInterfaceDetailW(hdev, &did, pdidd, size, &size, nullptr)) {
            g_paths.emplace_back(pdidd->DevicePath);
        }
    }
    SetupDiDestroyDeviceInfoList(hdev);
}

} // namespace

void get_battery_device_paths(std::vector<std::wstring>& out) {
    std::lock_guard<std::mutex> lk(g_mu);
    ULONGLONG now = GetTickCount64();
    if (!g_have_cache || (now - g_cache_tick) >= kCacheTtlMs) {
        enumerate_locked();
        g_cache_tick = now;
        g_have_cache = true;
    }
    out = g_paths;
}

void invalidate_battery_device_cache() {
    std::lock_guard<std::mutex> lk(g_mu);
    g_have_cache = false;
    g_paths.clear();
}

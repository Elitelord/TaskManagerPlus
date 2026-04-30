#pragma once

// See note in nt_process_io.h about include order vs. winsock2.h. Same
// applies here, though battery callers don't currently mix with winsock.
#include <windows.h>
#include <string>
#include <vector>

// Cached enumeration of battery device interface paths.
//
// Three telemetry modules (system_info, power_telemetry, performance_telemetry)
// were each calling SetupDiGetClassDevsW + SetupDiEnumDeviceInterfaces +
// SetupDiGetDeviceInterfaceDetailW every tick to discover battery handles.
// Battery topology is essentially static at runtime — even on dockable
// devices, a swap event is rare and shows up to the IOCTL as a failure we
// can react to. So we cache the paths for ~30 s and re-enumerate either
// when the TTL expires or when the caller signals a stale path via
// invalidate_battery_device_cache().
//
// Callers continue to CreateFileW + DeviceIoControl + CloseHandle each tick
// (handle open/close on a battery device is cheap; it's the SetupDi class
// walk that was expensive).
void get_battery_device_paths(std::vector<std::wstring>& out);

// Force the next call to get_battery_device_paths() to re-enumerate. Call
// this when a CreateFileW on a cached path returns INVALID_HANDLE_VALUE,
// which usually means the device disappeared (battery removed, docking
// station detached).
void invalidate_battery_device_cache();

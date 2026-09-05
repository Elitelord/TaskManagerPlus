cmake_minimum_required(VERSION 3.20)
project(taskmanager_native LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(taskmanager_native SHARED
    src/dll_abi.cpp
    src/dll_main.cpp
    src/memory_telemetry.cpp
    src/network_power_estimate.cpp
    src/nt_process_io.cpp
    src/battery_devices.cpp
    src/power_telemetry.cpp
    src/disk_telemetry.cpp
    src/network_telemetry.cpp
    src/download_path_probe.cpp
    src/gpu_engine_util.cpp
    src/gpu_telemetry.cpp
    src/npu_telemetry.cpp
    src/process_control.cpp
    src/system_info.cpp
    src/performance_telemetry.cpp
    src/storage_telemetry.cpp
    src/startup_telemetry.cpp
)

target_include_directories(taskmanager_native PRIVATE include)
target_link_libraries(taskmanager_native PRIVATE psapi pdh iphlpapi ws2_32 shell32 gdiplus ole32 oleaut32 version crypt32 setupapi dxgi dxcore wbemuuid)
target_compile_definitions(taskmanager_native PRIVATE BUILDING_DLL UNICODE _UNICODE)

set_target_properties(taskmanager_native PROPERTIES
    WINDOWS_EXPORT_ALL_SYMBOLS OFF
)

# Standalone unit tests for the pure path/name helpers (storage_paths.hpp).
# NOT linked into the DLL and not built by the normal release build; opt in with
#   cmake --build native/build --config Release --target storage_paths_tests
# then run the produced exe. Header-only + assert-based, so no test framework.
add_executable(storage_paths_tests EXCLUDE_FROM_ALL tests/storage_paths_tests.cpp)
target_include_directories(storage_paths_tests PRIVATE include)
target_compile_definitions(storage_paths_tests PRIVATE UNICODE _UNICODE)

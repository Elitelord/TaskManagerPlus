cmake_minimum_required(VERSION 3.20)
project(taskmanager_native LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(taskmanager_native SHARED
    src/dll_main.cpp
    src/memory_telemetry.cpp
    src/network_power_estimate.cpp
    src/power_telemetry.cpp
    src/disk_telemetry.cpp
    src/network_telemetry.cpp
    src/gpu_telemetry.cpp
    src/npu_telemetry.cpp
    src/process_control.cpp
    src/system_info.cpp
    src/performance_telemetry.cpp
)

target_include_directories(taskmanager_native PRIVATE include)
target_link_libraries(taskmanager_native PRIVATE psapi pdh iphlpapi ws2_32 shell32 gdiplus ole32 oleaut32 version crypt32 setupapi dxgi dxcore wbemuuid)
target_compile_definitions(taskmanager_native PRIVATE BUILDING_DLL UNICODE _UNICODE)

set_target_properties(taskmanager_native PROPERTIES
    WINDOWS_EXPORT_ALL_SYMBOLS OFF
)

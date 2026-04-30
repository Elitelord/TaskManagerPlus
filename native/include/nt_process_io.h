#pragma once

// NOTE: callers that also use winsock2.h must include <winsock2.h> BEFORE
// this header — windows.h pulls in the legacy winsock.h otherwise, which
// conflicts with winsock2.h's redefinitions. We don't WIN32_LEAN_AND_MEAN
// here because doing so strips winioctl.h / NOMINMAX-sensitive macros that
// other consumers (power_telemetry.cpp, system_info.cpp) rely on.
#include <windows.h>
#include <unordered_map>
#include <cstdint>

// One-shot per-PID I/O counter snapshot, sourced from a single
// NtQuerySystemInformation(SystemProcessInformation) call. This replaces
// per-PID OpenProcess + GetProcessIoCounters loops in disk/network telemetry
// (which were ~500 syscalls/tick on a busy machine and silently dropped
// elevated/protected processes that OpenProcess refused to open).
//
// The numbers are the same fields IO_COUNTERS exposes — just sourced once
// from the kernel for every PID instead of per-handle.
struct ProcessIoSnapshot {
    uint64_t read_bytes;    // == IO_COUNTERS::ReadTransferCount
    uint64_t write_bytes;   // == IO_COUNTERS::WriteTransferCount
    uint64_t other_bytes;   // == IO_COUNTERS::OtherTransferCount (network proxy)
};

// Populates `out` with one entry per running process. Clears `out` first.
// On failure (NtQSI unavailable, buffer growth limit exceeded), returns with
// `out` empty — callers should treat that as "no telemetry this tick" and
// preserve the prior frame, which is what a failed enumeration loop would
// have produced anyway.
void get_process_io_snapshots(std::unordered_map<DWORD, ProcessIoSnapshot>& out);

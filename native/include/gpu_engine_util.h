#pragma once

#include <stdint.h>
#include <windows.h>
#include <pdh.h>

// DXGI "best" adapter — same heuristic as performance_telemetry VRAM block.
struct PerfDxgiBestGpu {
    LUID     luid;
    uint64_t dedicated_video_bytes;
    uint64_t shared_system_bytes;
    int32_t  is_integrated;
    WCHAR    name[128];
    uint64_t adapter_score;
};

bool perf_pick_best_dxgi_gpu(PerfDxgiBestGpu* out);

// Task Manager headline = max engine % on the adapter; secondary = sum (uncapped).
// 3D / Compute = max among instances whose PDH engtype_* matches.
void perf_aggregate_gpu_engine_util(
    PDH_HCOUNTER counter,
    const LUID* filter_luid_or_null,
    double* out_max_all,
    double* out_sum_all,
    double* out_max_3d,
    double* out_max_compute);

#include "gpu_engine_util.h"

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <dxgi.h>
#include <pdh.h>

#ifndef PDH_MORE_DATA
#define PDH_MORE_DATA ((LONG)0x800007D2L)
#endif
#include <shlwapi.h>
#include <vector>
#include <cstring>

#pragma comment(lib, "shlwapi.lib")
#pragma comment(lib, "dxgi.lib")

bool perf_pick_best_dxgi_gpu(PerfDxgiBestGpu* out) {
    if (!out) return false;
    memset(out, 0, sizeof(*out));
    IDXGIFactory* factory = nullptr;
    if (!SUCCEEDED(CreateDXGIFactory(__uuidof(IDXGIFactory), (void**)&factory)) || !factory)
        return false;

    IDXGIAdapter* bestAdapter = nullptr;
    uint64_t bestScore = 0;

    IDXGIAdapter* adapter = nullptr;
    for (UINT i = 0; factory->EnumAdapters(i, &adapter) != DXGI_ERROR_NOT_FOUND; i++) {
        DXGI_ADAPTER_DESC desc;
        if (SUCCEEDED(adapter->GetDesc(&desc))) {
            uint64_t dedicated = static_cast<uint64_t>(desc.DedicatedVideoMemory);
            uint64_t shared = static_cast<uint64_t>(desc.SharedSystemMemory);
            uint64_t score = dedicated + shared / 2;
            bool isIntegrated = (dedicated < (1ULL << 30)) && (shared > dedicated * 2);
            if (score > bestScore) {
                bestScore = score;
                out->luid = desc.AdapterLuid;
                out->dedicated_video_bytes = dedicated;
                out->shared_system_bytes = shared;
                out->is_integrated = isIntegrated ? 1 : 0;
                wcsncpy_s(out->name, desc.Description, _TRUNCATE);
                if (bestAdapter) bestAdapter->Release();
                bestAdapter = adapter;
                continue;
            }
        }
        adapter->Release();
    }
    factory->Release();
    if (bestAdapter) bestAdapter->Release();

    out->adapter_score = bestScore;
    return bestScore > 0;
}

static bool perf_gpu_instance_matches_luid(const wchar_t* name, const LUID& luid) {
    if (!name) return false;
    wchar_t expected[64];
    swprintf_s(expected, L"luid_0x%08lX_0x%08lX",
               static_cast<unsigned long>(luid.HighPart),
               static_cast<unsigned long>(luid.LowPart));
    return StrStrIW(name, expected) != nullptr;
}

void perf_aggregate_gpu_engine_util(
    PDH_HCOUNTER counter,
    const LUID* filter_luid_or_null,
    double* out_max_all,
    double* out_sum_all,
    double* out_max_3d,
    double* out_max_compute) {
    if (out_max_all) *out_max_all = 0.0;
    if (out_sum_all) *out_sum_all = 0.0;
    if (out_max_3d) *out_max_3d = 0.0;
    if (out_max_compute) *out_max_compute = 0.0;
    if (!counter) return;

    DWORD bufSize = 0, itemCount = 0;
    PDH_STATUS status = PdhGetFormattedCounterArray(counter, PDH_FMT_DOUBLE, &bufSize, &itemCount, nullptr);
    if (status != PDH_MORE_DATA || bufSize == 0) return;

    std::vector<BYTE> buf(bufSize);
    auto* items = reinterpret_cast<PDH_FMT_COUNTERVALUE_ITEM_W*>(buf.data());
    status = PdhGetFormattedCounterArray(counter, PDH_FMT_DOUBLE, &bufSize, &itemCount, items);
    if (status != ERROR_SUCCESS) return;

    double maxAll = 0.0, sumAll = 0.0, max3d = 0.0, maxCompute = 0.0;

    for (DWORD i = 0; i < itemCount; i++) {
        const wchar_t* name = items[i].szName;
        if (!name) continue;
        if (filter_luid_or_null) {
            if (!perf_gpu_instance_matches_luid(name, *filter_luid_or_null))
                continue;
        }

        double v = items[i].FmtValue.doubleValue;
        if (v < 0.0) v = 0.0;
        if (v > maxAll) maxAll = v;
        sumAll += v;

        if (StrStrIW(name, L"engtype_3D") != nullptr) {
            if (v > max3d) max3d = v;
        } else {
            const wchar_t* et = StrStrIW(name, L"engtype_");
            if (et) {
                et += 8;
                const bool computePrefix = (_wcsnicmp(et, L"Compute", 7) == 0);
                const wchar_t tail = et[7];
                const bool tailOk = (tail == L'\0' || tail == L'_' || (tail >= L'0' && tail <= L'9'));
                if (computePrefix && tailOk) {
                    if (v > maxCompute) maxCompute = v;
                }
            }
        }
    }

    if (out_max_all) *out_max_all = maxAll;
    if (out_sum_all) *out_sum_all = sumAll;
    if (out_max_3d) *out_max_3d = max3d;
    if (out_max_compute) *out_max_compute = maxCompute;
}

#include "process_info.h"

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <initguid.h>
#include <pdh.h>
#include <psapi.h>
#include <shlwapi.h>
#include <vector>
#include <unordered_map>
#include <string>
#include <cstring>
#include <cstdio>

#include <comdef.h>
#include <Wbemidl.h>
#include <shlobj.h>

#pragma comment(lib, "pdh.lib")
#pragma comment(lib, "shlwapi.lib")

#if defined(__has_include)
#  if __has_include(<dxcore.h>)
#    include <dxcore.h>
#    include <dxcore_interface.h>
#    define TMN_HAS_DXCORE 1
#  endif
#endif
#ifndef TMN_HAS_DXCORE
#  define TMN_HAS_DXCORE 0
#endif

#ifndef PDH_MORE_DATA
#define PDH_MORE_DATA ((LONG)0x800007D2L)
#endif

// ---------------------------------------------------------------------------
// DXCore discovery (NPU / ML adapter LUID + description + memory totals)
// ---------------------------------------------------------------------------

static LUID     g_npu_luid = {};
static bool     g_npu_luid_valid = false;
static wchar_t  g_npu_desc_wide[256] = {};
static wchar_t  g_npu_hwid_wide[80] = {}; // e.g. VEN_1002&DEV_17F0 (for MCDM / AMD)
static uint64_t g_npu_ded_total = 0;
static uint64_t g_npu_shr_total = 0;
static bool     g_npu_discovery_done = false;
static bool     g_wmi_npu_tried = false;

#if TMN_HAS_DXCORE
#pragma comment(lib, "dxcore.lib")

using PFN_CreateDXCoreFactory = HRESULT(WINAPI*)(REFIID riid, void** ppvFactory);

static HRESULT create_dxcore_factory(REFIID riid, void** ppv) {
    static PFN_CreateDXCoreFactory pfn = nullptr;
    static bool resolved = false;
    if (!resolved) {
        resolved = true;
        HMODULE mod = LoadLibraryW(L"dxcore.dll");
        if (mod) {
            pfn = reinterpret_cast<PFN_CreateDXCoreFactory>(
                GetProcAddress(mod, "CreateDXCoreFactory"));
        }
    }
    if (!pfn) return E_FAIL;
    return pfn(riid, ppv);
}
#endif

static void wide_to_utf8_field(const wchar_t* w, char* out, size_t outsz) {
    if (!out || outsz == 0) return;
    out[0] = '\0';
    if (!w || w[0] == L'\0') return;
    WideCharToMultiByte(CP_UTF8, 0, w, -1, out, static_cast<int>(outsz), nullptr, nullptr);
    out[outsz - 1] = '\0';
}

static uint32_t g_npu_pci_vendor = 0;
static uint32_t g_npu_pci_device = 0;

#if TMN_HAS_DXCORE
static void try_fill_hardware_id_parts(IDXCoreAdapter* adapter) {
    g_npu_hwid_wide[0] = L'\0';
    g_npu_pci_vendor = 0;
    g_npu_pci_device = 0;
    if (!adapter || !adapter->IsPropertySupported(DXCoreAdapterProperty::HardwareIDParts))
        return;
    DXCoreHardwareIDParts parts{};
    if (FAILED(adapter->GetProperty(DXCoreAdapterProperty::HardwareIDParts, sizeof(parts), &parts)))
        return;
    g_npu_pci_vendor = parts.vendorID;
    g_npu_pci_device = parts.deviceID;
    swprintf_s(g_npu_hwid_wide, _countof(g_npu_hwid_wide), L"VEN_%04X&DEV_%04X",
        static_cast<unsigned>(parts.vendorID & 0xFFFFu),
        static_cast<unsigned>(parts.deviceID & 0xFFFFu));
}
#endif // TMN_HAS_DXCORE

static void extract_ven_dev_from_pnp_id(const wchar_t* str, wchar_t* out, size_t outChars) {
    if (!str || !out || outChars < 12) return;
    out[0] = L'\0';
    const wchar_t* ven = StrStrIW(str, L"VEN_");
    const wchar_t* dev = StrStrIW(str, L"DEV_");
    if (!ven || !dev) return;
    unsigned v = 0, d = 0;
    if (swscanf_s(ven, L"VEN_%4x", &v) != 1) return;
    if (swscanf_s(dev, L"DEV_%4x", &d) != 1) return;
    swprintf_s(out, static_cast<int>(outChars), L"VEN_%04X&DEV_%04X", v, d);
    g_npu_pci_vendor = v;
    g_npu_pci_device = d;
}

static bool wmi_row_looks_like_npu(const wchar_t* name, const wchar_t* devid) {
    if (!devid || devid[0] == L'\0') return false;
    if (StrStrIW(devid, L"USB\\") != nullptr) return false;
    if (StrStrIW(devid, L"HID\\") != nullptr) return false;
    if (StrStrIW(devid, L"PCI\\VEN_") != nullptr) {
        if (StrStrIW(devid, L"VEN_1002&DEV_17F") != nullptr)
            return true;
        if (name) {
            if (StrStrIW(name, L"Neural") != nullptr) return true;
            if (StrStrIW(name, L"NPU") != nullptr) return true;
            if (StrStrIW(name, L"XDNA") != nullptr) return true;
            if (StrStrIW(name, L"AMD IPU") != nullptr) return true;
            if (StrStrIW(name, L"Ryzen") != nullptr && StrStrIW(name, L"AI") != nullptr) return true;
            if (StrStrIW(name, L"AI Boost") != nullptr) return true;
            if (StrStrIW(name, L"Hexagon") != nullptr) return true;
        }
        return false;
    }
    if (StrStrIW(devid, L"SWD\\") != nullptr && name && StrStrIW(name, L"Neural") != nullptr)
        return true;
    return false;
}

static void try_wmi_pnp_npu_identity() {
    if (g_wmi_npu_tried) return;
    g_wmi_npu_tried = true;

    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const bool did_com_init = (hr == S_OK);
    if (FAILED(hr) && hr != RPC_E_CHANGED_MODE && hr != S_FALSE) return;

    IWbemLocator* pLoc = nullptr;
    IWbemServices* pSvc = nullptr;
    IEnumWbemClassObject* pEnum = nullptr;

    hr = CoCreateInstance(CLSID_WbemLocator, nullptr, CLSCTX_INPROC_SERVER,
        IID_IWbemLocator, reinterpret_cast<void**>(&pLoc));
    if (FAILED(hr) || !pLoc) goto done;

    hr = pLoc->ConnectServer(_bstr_t(L"ROOT\\CIMV2"), nullptr, nullptr, nullptr, 0,
        nullptr, nullptr, &pSvc);
    if (FAILED(hr) || !pSvc) goto done;

    CoSetProxyBlanket(pSvc, RPC_C_AUTHN_WINNT, RPC_C_AUTHZ_NONE, nullptr,
        RPC_C_AUTHN_LEVEL_CALL, RPC_C_IMP_LEVEL_IMPERSONATE, nullptr, EOAC_NONE);

    hr = pSvc->ExecQuery(
        _bstr_t(L"WQL"),
        _bstr_t(L"SELECT Name, DeviceID FROM Win32_PnPEntity WHERE "
                L"Name LIKE '%Neural%' OR Name LIKE '%NPU%' OR Name LIKE '%XDNA%' OR Name LIKE '%AMD IPU%' "
                L"OR (Name LIKE '%Ryzen%' AND Name LIKE '%AI%') OR Service = 'amdxdna' "
                L"OR Name LIKE '%AI Boost%' OR Name LIKE '%Hexagon%' "
                L"OR DeviceID LIKE '%VEN_1002&DEV_17F%'"),
        WBEM_FLAG_FORWARD_ONLY | WBEM_FLAG_RETURN_IMMEDIATELY,
        nullptr,
        &pEnum);
    if (FAILED(hr) || !pEnum) goto done;

    for (;;) {
        IWbemClassObject* pObj = nullptr;
        ULONG ret = 0;
        hr = pEnum->Next(WBEM_INFINITE, 1, &pObj, &ret);
        if (FAILED(hr) || ret == 0 || !pObj) break;

        VARIANT vn{};
        VARIANT vd{};
        const wchar_t* nm = nullptr;
        const wchar_t* did = nullptr;
        if (SUCCEEDED(pObj->Get(L"Name", 0, &vn, nullptr, nullptr)) && vn.vt == VT_BSTR && vn.bstrVal)
            nm = vn.bstrVal;
        if (SUCCEEDED(pObj->Get(L"DeviceID", 0, &vd, nullptr, nullptr)) && vd.vt == VT_BSTR && vd.bstrVal)
            did = vd.bstrVal;

        if (!wmi_row_looks_like_npu(nm, did)) {
            VariantClear(&vn);
            VariantClear(&vd);
            pObj->Release();
            continue;
        }

        if (g_npu_desc_wide[0] == L'\0' && nm) {
            wcsncpy_s(g_npu_desc_wide, _countof(g_npu_desc_wide), nm, _TRUNCATE);
        }
        if (g_npu_hwid_wide[0] == L'\0' && did) {
            extract_ven_dev_from_pnp_id(did, g_npu_hwid_wide, _countof(g_npu_hwid_wide));
        }
        VariantClear(&vn);
        VariantClear(&vd);
        pObj->Release();
        if (g_npu_desc_wide[0] != L'\0' && g_npu_hwid_wide[0] != L'\0') break;
    }

done:
    if (pEnum) pEnum->Release();
    if (pSvc) pSvc->Release();
    if (pLoc) pLoc->Release();
    if (did_com_init) CoUninitialize();
}

#if TMN_HAS_DXCORE

static bool read_adapter_memory_totals(IDXCoreAdapter* adapter) {
    uint64_t ded = 0, shr = 0;
    if (adapter->IsPropertySupported(DXCoreAdapterProperty::DedicatedAdapterMemory)) {
        if (FAILED(adapter->GetProperty(DXCoreAdapterProperty::DedicatedAdapterMemory,
                sizeof(ded), &ded)))
            ded = 0;
    }
    if (adapter->IsPropertySupported(DXCoreAdapterProperty::SharedSystemMemory)) {
        if (FAILED(adapter->GetProperty(DXCoreAdapterProperty::SharedSystemMemory,
                sizeof(shr), &shr)))
            shr = 0;
    }
    g_npu_ded_total = ded;
    g_npu_shr_total = shr;
    return true;
}

static bool try_fill_from_adapter(IDXCoreAdapter* adapter) {
    if (!adapter || !adapter->IsValid()) return false;

    LUID luid = {};
    if (!adapter->IsPropertySupported(DXCoreAdapterProperty::InstanceLuid))
        return false;
    if (FAILED(adapter->GetProperty(DXCoreAdapterProperty::InstanceLuid, sizeof(luid), &luid)))
        return false;

    g_npu_luid = luid;
    g_npu_luid_valid = true;

    g_npu_desc_wide[0] = L'\0';
    if (adapter->IsPropertySupported(DXCoreAdapterProperty::DriverDescription)) {
        size_t need = 0;
        if (adapter->GetPropertySize(DXCoreAdapterProperty::DriverDescription, &need) == S_OK
            && need > 0) {
            std::vector<wchar_t> buf(need / sizeof(wchar_t) + 2, 0);
            if (SUCCEEDED(adapter->GetProperty(DXCoreAdapterProperty::DriverDescription,
                    buf.size() * sizeof(wchar_t), buf.data()))) {
                wcsncpy_s(g_npu_desc_wide, _countof(g_npu_desc_wide), buf.data(), _TRUNCATE);
            }
        }
    }

    read_adapter_memory_totals(adapter);
    try_fill_hardware_id_parts(adapter);
    return true;
}

static void discover_npu_adapter_dxcore() {
    if (g_npu_discovery_done) return;
    g_npu_discovery_done = true;

    IDXCoreAdapterFactory* factory = nullptr;
    if (FAILED(create_dxcore_factory(IID_PPV_ARGS(&factory))) || !factory) {
        try_wmi_pnp_npu_identity();
        return;
    }

    // Prefer Factory1 workload list (NPU + ML).
    IDXCoreAdapterFactory1* factory1 = nullptr;
    if (SUCCEEDED(factory->QueryInterface(IID_PPV_ARGS(&factory1))) && factory1) {
        IDXCoreAdapterList* list = nullptr;
        HRESULT hr = factory1->CreateAdapterListByWorkload(
            DXCoreWorkload::MachineLearning,
            DXCoreRuntimeFilterFlags::D3D12,
            DXCoreHardwareTypeFilterFlags::NPU,
            IID_PPV_ARGS(&list));
        if (SUCCEEDED(hr) && list && list->GetAdapterCount() > 0) {
            IDXCoreAdapter* adapter = nullptr;
            if (SUCCEEDED(list->GetAdapter(0, IID_PPV_ARGS(&adapter))) && adapter) {
                try_fill_from_adapter(adapter);
                adapter->Release();
            }
        }
        if (list) list->Release();
        factory1->Release();
    }

    // Fallback: any D3D12 Generic ML adapter that reports the NPU hardware attribute.
    if (!g_npu_luid_valid) {
        const GUID filter = DXCORE_ADAPTER_ATTRIBUTE_D3D12_GENERIC_ML;
        IDXCoreAdapterList* list = nullptr;
        if (SUCCEEDED(factory->CreateAdapterList(1, &filter, IID_PPV_ARGS(&list))) && list) {
            const uint32_t n = list->GetAdapterCount();
            for (uint32_t i = 0; i < n && !g_npu_luid_valid; i++) {
                IDXCoreAdapter* adapter = nullptr;
                if (FAILED(list->GetAdapter(i, IID_PPV_ARGS(&adapter))) || !adapter)
                    continue;
                if (adapter->IsAttributeSupported(DXCORE_HARDWARE_TYPE_ATTRIBUTE_NPU)) {
                    try_fill_from_adapter(adapter);
                }
                adapter->Release();
            }
            list->Release();
        }
    }

    factory->Release();

    // DriverDescription is often empty on AMD MCDM NPUs; PnP / WMI usually has the friendly name.
    if (g_npu_desc_wide[0] == L'\0' || g_npu_hwid_wide[0] == L'\0') {
        try_wmi_pnp_npu_identity();
    }
}

#else

static void discover_npu_adapter_dxcore() {
    g_npu_discovery_done = true;
    try_wmi_pnp_npu_identity();
}

#endif

static void wide_desc_to_utf8(char* out, size_t out_size) {
    if (!out || out_size == 0) return;
    out[0] = '\0';
    if (g_npu_desc_wide[0] == L'\0') return;
    WideCharToMultiByte(CP_UTF8, 0, g_npu_desc_wide, -1, out,
        static_cast<int>(out_size), nullptr, nullptr);
    out[out_size - 1] = '\0';
}

// ---------------------------------------------------------------------------
// PDH: NPU Engine (or GPU Engine filtered by NPU LUID), adapter/process memory
// ---------------------------------------------------------------------------

enum class NpuEngineKind : int { None = 0, NpuEngine = 1, GpuEngineFiltered = 2 };
// Tracks whether a given memory counter came from the native NPU counter family
// (all instances belong to the NPU, so no LUID filtering is needed) or the GPU
// counter family (must filter by NPU LUID to avoid summing real GPU memory).
enum class NpuMemKind : int { None = 0, Native = 1, GpuFiltered = 2 };

static PDH_HQUERY   g_npuQuery = nullptr;
static PDH_HCOUNTER g_npuEngUtil = nullptr;
static PDH_HCOUNTER g_npuAdapterDed = nullptr;
static PDH_HCOUNTER g_npuAdapterShr = nullptr;
static PDH_HCOUNTER g_npuProcDed = nullptr;
static PDH_HCOUNTER g_npuProcShr = nullptr;
static bool         g_npuPdhInited = false;
static bool         g_npuEngAvailable = false;
static bool         g_npuAdDedAvail = false;
static bool         g_npuAdShrAvail = false;
static bool         g_npuPmDedAvail = false;
static bool         g_npuPmShrAvail = false;
static NpuEngineKind g_npuEngKind = NpuEngineKind::None;
static NpuMemKind   g_npuAdDedKind = NpuMemKind::None;
static NpuMemKind   g_npuAdShrKind = NpuMemKind::None;
static NpuMemKind   g_npuPmDedKind = NpuMemKind::None;
static NpuMemKind   g_npuPmShrKind = NpuMemKind::None;

static void swprintf_luid_token(const LUID& luid, wchar_t* buf, size_t buf_elems) {
    swprintf_s(buf, static_cast<int>(buf_elems), L"luid_0x%08lX_0x%08lX",
        static_cast<unsigned long>(luid.HighPart),
        static_cast<unsigned long>(luid.LowPart));
}

static bool parse_luid_from_instance(const wchar_t* name, LUID* out) {
    if (!name || !out) return false;
    const wchar_t* s = StrStrIW(name, L"luid_");
    if (!s) return false;
    s += 5;
    unsigned long hi = 0, lo = 0;
    if (swscanf_s(s, L"0x%08lX_0x%08lX", &hi, &lo) != 2)
        return false;
    out->HighPart = static_cast<LONG>(hi);
    out->LowPart = static_cast<ULONG>(lo);
    return true;
}

static void maybe_learn_luid_from_instance(const wchar_t* name) {
    if (g_npu_luid_valid) return;
    LUID tmp{};
    if (!parse_luid_from_instance(name, &tmp)) return;
    g_npu_luid = tmp;
    g_npu_luid_valid = true;
}

// Fallback LUID discovery: scan the GPU Engine counter instances, group by LUID,
// and pick the LUID whose engine types are exclusively "Compute" (no 3D / Copy /
// Video / etc.). That's the signature of an NPU adapter — both AMD XDNA, Intel
// AI Boost, and Qualcomm Hexagon register as D3D12 Generic ML adapters whose
// engine list contains only compute engines.
static void try_learn_npu_luid_from_engine_shape() {
    if (g_npu_luid_valid) return;
    if (!g_npuEngUtil) return;

    DWORD bufSize = 0, itemCount = 0;
    PDH_STATUS st = PdhGetFormattedCounterArray(g_npuEngUtil, PDH_FMT_DOUBLE, &bufSize, &itemCount, nullptr);
    if (st != PDH_MORE_DATA || bufSize == 0) return;
    std::vector<BYTE> raw(bufSize);
    auto* items = reinterpret_cast<PDH_FMT_COUNTERVALUE_ITEM_W*>(raw.data());
    st = PdhGetFormattedCounterArray(g_npuEngUtil, PDH_FMT_DOUBLE, &bufSize, &itemCount, items);
    if (st != ERROR_SUCCESS) return;

    // Per-LUID flags: seen at all, seen a compute engine, seen a non-compute engine.
    struct Shape { bool seen = false; bool compute = false; bool non_compute = false; };
    std::unordered_map<uint64_t, Shape> shapes;

    for (DWORD i = 0; i < itemCount; i++) {
        const wchar_t* name = items[i].szName;
        if (!name) continue;
        LUID l{};
        if (!parse_luid_from_instance(name, &l)) continue;
        uint64_t key = (static_cast<uint64_t>(static_cast<uint32_t>(l.HighPart)) << 32)
                     | static_cast<uint32_t>(l.LowPart);
        const wchar_t* engtype = StrStrIW(name, L"engtype_");
        if (!engtype) continue;
        engtype += 8;
        Shape& s = shapes[key];
        s.seen = true;
        // "Compute" (with optional index) counts as compute. Anything else disqualifies.
        if (StrStrIW(engtype, L"Compute") == engtype) {
            s.compute = true;
        } else {
            s.non_compute = true;
        }
    }

    // Pick the first LUID whose engines are *only* compute.
    for (const auto& kv : shapes) {
        if (kv.second.seen && kv.second.compute && !kv.second.non_compute) {
            g_npu_luid.HighPart = static_cast<LONG>((kv.first >> 32) & 0xFFFFFFFFULL);
            g_npu_luid.LowPart  = static_cast<ULONG>(kv.first & 0xFFFFFFFFULL);
            g_npu_luid_valid = true;
            return;
        }
    }
}

// When DXCore did not yield an LUID, match GPU/NPU Adapter Memory PDH instance
// strings against the PCI VEN/DEV we got from WMI or DXCore HardwareIDParts.
static void try_learn_npu_luid_from_adapter_memory_counters() {
    if (g_npu_luid_valid) return;

    wchar_t venDevPat[48] = {};
    if (g_npu_hwid_wide[0] != L'\0') {
        wcsncpy_s(venDevPat, _countof(venDevPat), g_npu_hwid_wide, _TRUNCATE);
    } else if (g_npu_pci_vendor != 0) {
        swprintf_s(venDevPat, _countof(venDevPat), L"VEN_%04X&DEV_%04X",
            static_cast<unsigned>(g_npu_pci_vendor & 0xFFFFu),
            static_cast<unsigned>(g_npu_pci_device & 0xFFFFu));
    } else {
        return;
    }

    const PDH_HCOUNTER counters[] = { g_npuAdapterDed, g_npuAdapterShr };
    for (PDH_HCOUNTER c : counters) {
        if (!c) continue;
        DWORD bufSize = 0, itemCount = 0;
        PDH_STATUS st = PdhGetFormattedCounterArray(c, PDH_FMT_LARGE, &bufSize, &itemCount, nullptr);
        if (st != PDH_MORE_DATA || bufSize == 0) continue;
        std::vector<BYTE> raw(bufSize);
        auto* items = reinterpret_cast<PDH_FMT_COUNTERVALUE_ITEM_W*>(raw.data());
        st = PdhGetFormattedCounterArray(c, PDH_FMT_LARGE, &bufSize, &itemCount, items);
        if (st != ERROR_SUCCESS) continue;
        for (DWORD i = 0; i < itemCount; i++) {
            const wchar_t* name = items[i].szName;
            if (!name || !StrStrIW(name, venDevPat)) continue;
            LUID tmp{};
            if (!parse_luid_from_instance(name, &tmp)) continue;
            g_npu_luid = tmp;
            g_npu_luid_valid = true;
            return;
        }
    }
}

static void init_npu_pdh_counters() {
    if (g_npuPdhInited) return;
    g_npuPdhInited = true;

    discover_npu_adapter_dxcore();

    if (PdhOpenQueryW(nullptr, 0, &g_npuQuery) != ERROR_SUCCESS) {
        g_npuQuery = nullptr;
        return;
    }

    if (PdhAddEnglishCounterW(g_npuQuery,
            L"\\NPU Engine(*)\\Utilization Percentage",
            0, &g_npuEngUtil) == ERROR_SUCCESS) {
        g_npuEngAvailable = true;
        g_npuEngKind = NpuEngineKind::NpuEngine;
    } else if (PdhAddEnglishCounterW(g_npuQuery,
            L"\\GPU Engine(*)\\Utilization Percentage",
            0, &g_npuEngUtil) == ERROR_SUCCESS) {
        g_npuEngAvailable = true;
        g_npuEngKind = NpuEngineKind::GpuEngineFiltered;
    }

    if (PdhAddEnglishCounterW(g_npuQuery,
            L"\\NPU Adapter Memory(*)\\Dedicated Usage",
            0, &g_npuAdapterDed) == ERROR_SUCCESS) {
        g_npuAdDedAvail = true;
        g_npuAdDedKind = NpuMemKind::Native;
    } else if (PdhAddEnglishCounterW(g_npuQuery,
            L"\\GPU Adapter Memory(*)\\Dedicated Usage",
            0, &g_npuAdapterDed) == ERROR_SUCCESS) {
        g_npuAdDedAvail = true;
        g_npuAdDedKind = NpuMemKind::GpuFiltered;
    }
    if (PdhAddEnglishCounterW(g_npuQuery,
            L"\\NPU Adapter Memory(*)\\Shared Usage",
            0, &g_npuAdapterShr) == ERROR_SUCCESS) {
        g_npuAdShrAvail = true;
        g_npuAdShrKind = NpuMemKind::Native;
    } else if (PdhAddEnglishCounterW(g_npuQuery,
            L"\\GPU Adapter Memory(*)\\Shared Usage",
            0, &g_npuAdapterShr) == ERROR_SUCCESS) {
        g_npuAdShrAvail = true;
        g_npuAdShrKind = NpuMemKind::GpuFiltered;
    }
    if (PdhAddEnglishCounterW(g_npuQuery,
            L"\\NPU Process Memory(*)\\Dedicated Usage",
            0, &g_npuProcDed) == ERROR_SUCCESS) {
        g_npuPmDedAvail = true;
        g_npuPmDedKind = NpuMemKind::Native;
    } else if (PdhAddEnglishCounterW(g_npuQuery,
            L"\\GPU Process Memory(*)\\Dedicated Usage",
            0, &g_npuProcDed) == ERROR_SUCCESS) {
        g_npuPmDedAvail = true;
        g_npuPmDedKind = NpuMemKind::GpuFiltered;
    }
    if (PdhAddEnglishCounterW(g_npuQuery,
            L"\\NPU Process Memory(*)\\Shared Usage",
            0, &g_npuProcShr) == ERROR_SUCCESS) {
        g_npuPmShrAvail = true;
        g_npuPmShrKind = NpuMemKind::Native;
    } else if (PdhAddEnglishCounterW(g_npuQuery,
            L"\\GPU Process Memory(*)\\Shared Usage",
            0, &g_npuProcShr) == ERROR_SUCCESS) {
        g_npuPmShrAvail = true;
        g_npuPmShrKind = NpuMemKind::GpuFiltered;
    }

    if (g_npuQuery) {
        PdhCollectQueryData(g_npuQuery);
        try_learn_npu_luid_from_adapter_memory_counters();
        try_learn_npu_luid_from_engine_shape();
    }
}

static double sum_engine_util_for_npu(PDH_HCOUNTER counter) {
    if (!counter || !g_npuEngAvailable) return 0.0;

    wchar_t luidTok[64] = {};
    if (g_npuEngKind == NpuEngineKind::GpuEngineFiltered && g_npu_luid_valid) {
        swprintf_luid_token(g_npu_luid, luidTok, _countof(luidTok));
    }

    DWORD bufSize = 0, itemCount = 0;
    PDH_STATUS st = PdhGetFormattedCounterArray(counter, PDH_FMT_DOUBLE, &bufSize, &itemCount, nullptr);
    if (st != PDH_MORE_DATA || bufSize == 0) return 0.0;

    std::vector<BYTE> raw(bufSize);
    auto* items = reinterpret_cast<PDH_FMT_COUNTERVALUE_ITEM_W*>(raw.data());
    st = PdhGetFormattedCounterArray(counter, PDH_FMT_DOUBLE, &bufSize, &itemCount, items);
    if (st != ERROR_SUCCESS) return 0.0;

    double total = 0.0;
    for (DWORD i = 0; i < itemCount; i++) {
        const wchar_t* name = items[i].szName;
        if (!name) continue;

        if (g_npuEngKind == NpuEngineKind::NpuEngine) {
            maybe_learn_luid_from_instance(name);
            total += items[i].FmtValue.doubleValue;
        } else if (g_npuEngKind == NpuEngineKind::GpuEngineFiltered) {
            if (!g_npu_luid_valid) continue;
            if (StrStrIW(name, luidTok) == nullptr) continue;
            total += items[i].FmtValue.doubleValue;
        }
    }
    if (total > 100.0) total = 100.0;
    return total;
}

static uint64_t sum_large_mem(PDH_HCOUNTER counter, NpuMemKind kind) {
    if (!counter || kind == NpuMemKind::None) return 0;

    wchar_t expected[64] = {};
    const bool needs_luid_filter = (kind == NpuMemKind::GpuFiltered);
    if (needs_luid_filter) {
        if (!g_npu_luid_valid) return 0;
        swprintf_luid_token(g_npu_luid, expected, _countof(expected));
    }

    DWORD bufSize = 0, itemCount = 0;
    PDH_STATUS st = PdhGetFormattedCounterArray(counter, PDH_FMT_LARGE, &bufSize, &itemCount, nullptr);
    if (st != PDH_MORE_DATA || bufSize == 0) return 0;

    std::vector<BYTE> raw(bufSize);
    auto* items = reinterpret_cast<PDH_FMT_COUNTERVALUE_ITEM_W*>(raw.data());
    st = PdhGetFormattedCounterArray(counter, PDH_FMT_LARGE, &bufSize, &itemCount, items);
    if (st != ERROR_SUCCESS) return 0;

    uint64_t sum = 0;
    for (DWORD i = 0; i < itemCount; i++) {
        const wchar_t* name = items[i].szName;
        if (!name) continue;
        if (needs_luid_filter && StrStrIW(name, expected) == nullptr) continue;
        if (kind == NpuMemKind::Native) {
            // Native NPU counters: learn LUID from instance name if we don't have one yet,
            // so process-level memory aggregation (which needs LUID) still works.
            maybe_learn_luid_from_instance(name);
        }
        int64_t v = items[i].FmtValue.largeValue;
        if (v > 0) sum += static_cast<uint64_t>(v);
    }
    return sum;
}

static void aggregate_engine_usage_by_pid(std::unordered_map<DWORD, double>& out) {
    out.clear();
    if (!g_npuEngUtil || !g_npuEngAvailable) return;

    wchar_t luidTok[64] = {};
    if (g_npu_luid_valid) {
        swprintf_luid_token(g_npu_luid, luidTok, _countof(luidTok));
    }

    DWORD bufSize = 0, itemCount = 0;
    PDH_STATUS st = PdhGetFormattedCounterArray(g_npuEngUtil, PDH_FMT_DOUBLE, &bufSize, &itemCount, nullptr);
    if (st != PDH_MORE_DATA || bufSize == 0) return;

    std::vector<BYTE> raw(bufSize);
    auto* items = reinterpret_cast<PDH_FMT_COUNTERVALUE_ITEM_W*>(raw.data());
    st = PdhGetFormattedCounterArray(g_npuEngUtil, PDH_FMT_DOUBLE, &bufSize, &itemCount, items);
    if (st != ERROR_SUCCESS) return;

    for (DWORD i = 0; i < itemCount; i++) {
        const wchar_t* name = items[i].szName;
        if (!name) continue;

        if (g_npuEngKind == NpuEngineKind::NpuEngine) {
            maybe_learn_luid_from_instance(name);
        } else if (g_npuEngKind == NpuEngineKind::GpuEngineFiltered) {
            if (!g_npu_luid_valid) continue;
            if (StrStrIW(name, luidTok) == nullptr) continue;
        }

        std::wstring wname(name);
        size_t pid_pos = wname.find(L"pid_");
        if (pid_pos == std::wstring::npos) continue;
        DWORD pid = 0;
        try {
            pid = static_cast<DWORD>(std::stoul(wname.substr(pid_pos + 4)));
        } catch (...) {
            continue;
        }
        if (pid == 0) continue;
        out[pid] += items[i].FmtValue.doubleValue;
    }
}

static void aggregate_proc_mem_by_pid(
    PDH_HCOUNTER counter,
    bool available,
    NpuMemKind kind,
    std::unordered_map<DWORD, uint64_t>& out)
{
    if (!counter || !available || kind == NpuMemKind::None) return;

    wchar_t expected[64] = {};
    const bool needs_luid_filter = (kind == NpuMemKind::GpuFiltered);
    if (needs_luid_filter) {
        if (!g_npu_luid_valid) return;
        swprintf_luid_token(g_npu_luid, expected, _countof(expected));
    }

    DWORD bufSize = 0, itemCount = 0;
    PDH_STATUS st = PdhGetFormattedCounterArray(counter, PDH_FMT_LARGE, &bufSize, &itemCount, nullptr);
    if (st != PDH_MORE_DATA || bufSize == 0) return;

    std::vector<BYTE> raw(bufSize);
    auto* items = reinterpret_cast<PDH_FMT_COUNTERVALUE_ITEM_W*>(raw.data());
    st = PdhGetFormattedCounterArray(counter, PDH_FMT_LARGE, &bufSize, &itemCount, items);
    if (st != ERROR_SUCCESS) return;

    for (DWORD i = 0; i < itemCount; i++) {
        const wchar_t* name = items[i].szName;
        if (!name) continue;
        if (needs_luid_filter && StrStrIW(name, expected) == nullptr) continue;

        std::wstring wname(name);
        size_t pid_pos = wname.find(L"pid_");
        if (pid_pos == std::wstring::npos) continue;
        DWORD pid = 0;
        try {
            pid = static_cast<DWORD>(std::stoul(wname.substr(pid_pos + 4)));
        } catch (...) {
            continue;
        }
        if (pid == 0) continue;
        int64_t v = items[i].FmtValue.largeValue;
        if (v > 0) out[pid] += static_cast<uint64_t>(v);
    }
}

static bool utf8_npu_name_suspicious_usb(const char* s) {
    if (!s || !s[0]) return false;
    return StrStrIA(s, "USB") != nullptr && StrStrIA(s, "Input") != nullptr;
}

static void normalize_npu_display(PerformanceSnapshot* snap) {
    if (!snap) return;
    if (snap->npu_name[0] == '\0' || utf8_npu_name_suspicious_usb(snap->npu_name)) {
        if (snap->cpu_name[0] != '\0')
            strncpy_s(snap->npu_name, sizeof(snap->npu_name), snap->cpu_name, _TRUNCATE);
        else if (utf8_npu_name_suspicious_usb(snap->npu_name))
            snap->npu_name[0] = '\0';
    }
}

static void npu_write_debug_dump_once() {
    static bool dumped = false;
    if (dumped) return;
    dumped = true;

    wchar_t appdata[MAX_PATH] = {};
    if (FAILED(SHGetFolderPathW(nullptr, CSIDL_LOCAL_APPDATA, nullptr, 0, appdata))) return;
    wchar_t dir[MAX_PATH], path[MAX_PATH];
    swprintf_s(dir, L"%s\\TaskManagerPlus", appdata);
    CreateDirectoryW(dir, nullptr);
    swprintf_s(path, L"%s\\npu_debug.txt", dir);

    FILE* f = nullptr;
    if (_wfopen_s(&f, path, L"w") != 0 || !f) return;

    fwprintf(f, L"=== NPU diagnostic dump ===\n");
    fwprintf(f, L"DXCore luid_valid=%d  luid=0x%08lX_0x%08lX\n",
        g_npu_luid_valid ? 1 : 0,
        static_cast<unsigned long>(g_npu_luid.HighPart),
        static_cast<unsigned long>(g_npu_luid.LowPart));
    fwprintf(f, L"DXCore desc='%ls'\n", g_npu_desc_wide);
    fwprintf(f, L"DXCore hwid='%ls'  PCI VEN=%04X DEV=%04X\n",
        g_npu_hwid_wide, g_npu_pci_vendor, g_npu_pci_device);
    fwprintf(f, L"DXCore ded_total=%llu  shr_total=%llu\n",
        (unsigned long long)g_npu_ded_total, (unsigned long long)g_npu_shr_total);

    auto kind_name = [](NpuMemKind k) {
        return k == NpuMemKind::Native ? L"Native"
             : k == NpuMemKind::GpuFiltered ? L"GpuFiltered" : L"None";
    };
    fwprintf(f, L"\nPDH counter registration:\n");
    fwprintf(f, L"  Engine       : avail=%d kind=%s\n", g_npuEngAvailable,
        g_npuEngKind == NpuEngineKind::NpuEngine ? L"NpuEngine"
      : g_npuEngKind == NpuEngineKind::GpuEngineFiltered ? L"GpuEngineFiltered" : L"None");
    fwprintf(f, L"  AdapterDed   : avail=%d kind=%s\n", g_npuAdDedAvail, kind_name(g_npuAdDedKind));
    fwprintf(f, L"  AdapterShr   : avail=%d kind=%s\n", g_npuAdShrAvail, kind_name(g_npuAdShrKind));
    fwprintf(f, L"  ProcDed      : avail=%d kind=%s\n", g_npuPmDedAvail, kind_name(g_npuPmDedKind));
    fwprintf(f, L"  ProcShr      : avail=%d kind=%s\n", g_npuPmShrAvail, kind_name(g_npuPmShrKind));

    auto dump_instances = [&](const wchar_t* label, PDH_HCOUNTER c) {
        fwprintf(f, L"\n-- %ls instances --\n", label);
        if (!c) { fwprintf(f, L"(counter not registered)\n"); return; }
        DWORD bufSize = 0, itemCount = 0;
        PDH_STATUS st = PdhGetFormattedCounterArray(c, PDH_FMT_LARGE, &bufSize, &itemCount, nullptr);
        if (st != PDH_MORE_DATA || bufSize == 0) { fwprintf(f, L"(no data, st=0x%lX)\n", (unsigned long)st); return; }
        std::vector<BYTE> raw(bufSize);
        auto* items = reinterpret_cast<PDH_FMT_COUNTERVALUE_ITEM_W*>(raw.data());
        st = PdhGetFormattedCounterArray(c, PDH_FMT_LARGE, &bufSize, &itemCount, items);
        if (st != ERROR_SUCCESS) { fwprintf(f, L"(array fetch failed 0x%lX)\n", (unsigned long)st); return; }
        for (DWORD i = 0; i < itemCount; i++) {
            fwprintf(f, L"  [%lu] %lld  name='%ls'\n",
                (unsigned long)i,
                (long long)items[i].FmtValue.largeValue,
                items[i].szName ? items[i].szName : L"(null)");
        }
    };
    dump_instances(L"AdapterDed", g_npuAdapterDed);
    dump_instances(L"AdapterShr", g_npuAdapterShr);
    dump_instances(L"ProcDed",    g_npuProcDed);
    dump_instances(L"ProcShr",    g_npuProcShr);

    // Engine dumps as DOUBLE
    fwprintf(f, L"\n-- Engine instances (DOUBLE) --\n");
    if (g_npuEngUtil) {
        DWORD bufSize = 0, itemCount = 0;
        PDH_STATUS st = PdhGetFormattedCounterArray(g_npuEngUtil, PDH_FMT_DOUBLE, &bufSize, &itemCount, nullptr);
        if (st == PDH_MORE_DATA && bufSize > 0) {
            std::vector<BYTE> raw(bufSize);
            auto* items = reinterpret_cast<PDH_FMT_COUNTERVALUE_ITEM_W*>(raw.data());
            if (PdhGetFormattedCounterArray(g_npuEngUtil, PDH_FMT_DOUBLE, &bufSize, &itemCount, items) == ERROR_SUCCESS) {
                for (DWORD i = 0; i < itemCount; i++) {
                    fwprintf(f, L"  [%lu] %.2f  name='%ls'\n",
                        (unsigned long)i,
                        items[i].FmtValue.doubleValue,
                        items[i].szName ? items[i].szName : L"(null)");
                }
            }
        } else {
            fwprintf(f, L"(no data, st=0x%lX)\n", (unsigned long)st);
        }
    } else {
        fwprintf(f, L"(counter not registered)\n");
    }

    fclose(f);
}

extern "C" void npu_collect_and_fill_snapshot(PerformanceSnapshot* snapshot) {
    if (!snapshot) return;

    init_npu_pdh_counters();

    snapshot->npu_present = 0;
    snapshot->npu_usage_percent = 0.0;
    snapshot->npu_dedicated_total_bytes = 0;
    snapshot->npu_dedicated_used_bytes = 0;
    snapshot->npu_shared_total_bytes = 0;
    snapshot->npu_shared_used_bytes = 0;
    snapshot->npu_name[0] = '\0';
    snapshot->npu_hardware_id[0] = '\0';

    const bool haveEng = g_npuEngAvailable;
    const bool haveMemCounters = g_npuAdDedAvail || g_npuAdShrAvail || g_npuPmDedAvail || g_npuPmShrAvail;
    const bool discovered = g_npu_luid_valid || (g_npu_desc_wide[0] != L'\0') || (g_npu_hwid_wide[0] != L'\0');

    wide_desc_to_utf8(snapshot->npu_name, sizeof(snapshot->npu_name));
    wide_to_utf8_field(g_npu_hwid_wide, snapshot->npu_hardware_id, sizeof(snapshot->npu_hardware_id));
    normalize_npu_display(snapshot);

    if (!g_npuQuery) {
        snapshot->npu_dedicated_total_bytes = g_npu_ded_total;
        snapshot->npu_shared_total_bytes = g_npu_shr_total;
        if (discovered || g_npu_ded_total > 0 || g_npu_shr_total > 0) {
            snapshot->npu_present = 1;
        }
        return;
    }

    PdhCollectQueryData(g_npuQuery);

    if (!haveEng && !haveMemCounters && !discovered) return;

    if (haveEng) {
        snapshot->npu_usage_percent = sum_engine_util_for_npu(g_npuEngUtil);
    }

    try_learn_npu_luid_from_adapter_memory_counters();
    try_learn_npu_luid_from_engine_shape();

    if (g_npuAdDedAvail && (g_npuAdDedKind == NpuMemKind::Native || g_npu_luid_valid)) {
        snapshot->npu_dedicated_used_bytes = sum_large_mem(g_npuAdapterDed, g_npuAdDedKind);
    }
    if (g_npuAdShrAvail && (g_npuAdShrKind == NpuMemKind::Native || g_npu_luid_valid)) {
        snapshot->npu_shared_used_bytes = sum_large_mem(g_npuAdapterShr, g_npuAdShrKind);
    }

    snapshot->npu_dedicated_total_bytes = g_npu_ded_total;
    snapshot->npu_shared_total_bytes = g_npu_shr_total;

    if (g_npu_luid_valid || haveEng || haveMemCounters || snapshot->npu_name[0] != '\0'
        || snapshot->npu_hardware_id[0] != '\0') {
        snapshot->npu_present = 1;
    }

    // One-shot diagnostic so we can see why memory is reading 0.
    npu_write_debug_dump_once();
}

extern "C" DLL_EXPORT int32_t get_process_npu_list(ProcessNpuInfo* buffer, int32_t max_count) {
    init_npu_pdh_counters();

    DWORD pids[1024];
    DWORD bytes_returned = 0;
    if (!EnumProcesses(pids, sizeof(pids), &bytes_returned)) {
        return 0;
    }
    DWORD num_processes = bytes_returned / sizeof(DWORD);

    if (buffer == nullptr) {
        return static_cast<int32_t>(num_processes);
    }

    if (!g_npuQuery) {
        return 0;
    }

    PdhCollectQueryData(g_npuQuery);
    try_learn_npu_luid_from_adapter_memory_counters();
    try_learn_npu_luid_from_engine_shape();

    std::unordered_map<DWORD, double> pid_util;
    aggregate_engine_usage_by_pid(pid_util);

    std::unordered_map<DWORD, uint64_t> pid_ded, pid_shr;
    aggregate_proc_mem_by_pid(g_npuProcDed, g_npuPmDedAvail, g_npuPmDedKind, pid_ded);
    aggregate_proc_mem_by_pid(g_npuProcShr, g_npuPmShrAvail, g_npuPmShrKind, pid_shr);

    int32_t filled = 0;
    for (DWORD i = 0; i < num_processes && filled < max_count; i++) {
        DWORD pid = pids[i];
        if (pid == 0) continue;

        buffer[filled].pid = pid;
        auto it = pid_util.find(pid);
        buffer[filled].npu_usage_percent = (it != pid_util.end()) ? it->second : 0.0;
        auto d = pid_ded.find(pid);
        auto s = pid_shr.find(pid);
        buffer[filled].npu_dedicated_bytes = (d != pid_ded.end()) ? d->second : 0;
        buffer[filled].npu_shared_bytes = (s != pid_shr.end()) ? s->second : 0;
        filled++;
    }

    return filled;
}

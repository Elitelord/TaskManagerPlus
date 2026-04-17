#include "process_info.h"

#include <windows.h>
#include <winioctl.h>
#include <shellapi.h>
#include <shlobj.h>
#include <pdh.h>
#include <pdhmsg.h>
#include <string>
#include <vector>
#include <algorithm>
#include <mutex>
#include <filesystem>
#include <system_error>
#include <unordered_set>

#pragma comment(lib, "pdh.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "version.lib")

namespace fs = std::filesystem;

// ---------------------------------------------------------------------------
// Bus / media classification
// ---------------------------------------------------------------------------
// We try IOCTL_STORAGE_QUERY_PROPERTY with access=0 first (works for most
// fixed drives without admin). If that fails we fall back to GetDriveTypeW
// which at least distinguishes fixed/removable/network/optical.

enum MediaKind {
    MK_UNKNOWN = 0, MK_HDD = 1, MK_SSD = 2, MK_NVME = 3,
    MK_USB = 4, MK_NETWORK = 5, MK_OPTICAL = 6, MK_VIRTUAL = 7,
};

static int classify_by_ioctl(wchar_t letter) {
    wchar_t path[8];
    swprintf_s(path, L"\\\\.\\%c:", letter);
    HANDLE h = CreateFileW(path, 0,
        FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
        OPEN_EXISTING, 0, nullptr);
    if (h == INVALID_HANDLE_VALUE) return -1;

    int kind = MK_UNKNOWN;

    // 1) Bus type via StorageAdapterProperty.
    STORAGE_PROPERTY_QUERY q = {};
    q.PropertyId = StorageAdapterProperty;
    q.QueryType  = PropertyStandardQuery;
    STORAGE_ADAPTER_DESCRIPTOR ad = {};
    DWORD ret = 0;
    if (DeviceIoControl(h, IOCTL_STORAGE_QUERY_PROPERTY, &q, sizeof(q),
                        &ad, sizeof(ad), &ret, nullptr)) {
        switch (ad.BusType) {
            case BusTypeUsb:        kind = MK_USB;     break;
            case BusTypeNvme:       kind = MK_NVME;    break;
            case BusTypeSd:
            case BusTypeMmc:        kind = MK_USB;     break;
            case BusTypeVirtual:
            case BusTypeFileBackedVirtual: kind = MK_VIRTUAL; break;
            // leave SATA/SAS/SCSI unknown here — need seek-penalty query
            default: break;
        }
    }

    // 2) SSD vs HDD via seek-penalty descriptor (if still ambiguous).
    if (kind == MK_UNKNOWN || kind == MK_HDD) {
        STORAGE_PROPERTY_QUERY sq = {};
        sq.PropertyId = StorageDeviceSeekPenaltyProperty;
        sq.QueryType  = PropertyStandardQuery;
        DEVICE_SEEK_PENALTY_DESCRIPTOR sp = {};
        if (DeviceIoControl(h, IOCTL_STORAGE_QUERY_PROPERTY, &sq, sizeof(sq),
                            &sp, sizeof(sp), &ret, nullptr)) {
            kind = sp.IncursSeekPenalty ? MK_HDD : MK_SSD;
        }
    }

    CloseHandle(h);
    return kind;
}

static int classify_media(wchar_t letter, UINT driveType) {
    int k = classify_by_ioctl(letter);
    if (k > 0) return k;
    switch (driveType) {
        case DRIVE_REMOVABLE: return MK_USB;
        case DRIVE_REMOTE:    return MK_NETWORK;
        case DRIVE_CDROM:     return MK_OPTICAL;
        case DRIVE_RAMDISK:   return MK_VIRTUAL;
        case DRIVE_FIXED:     return MK_UNKNOWN; // we tried, got nothing; show as generic fixed
        default:              return MK_UNKNOWN;
    }
}

// ---------------------------------------------------------------------------
// PDH live I/O per-volume, cached across calls so rates are delta-based.
// ---------------------------------------------------------------------------
struct VolumeIO {
    double read_bps = 0, write_bps = 0, active_pct = 0, queue = 0;
};
static std::mutex g_pdh_mtx;
static PDH_HQUERY g_pdh_query = nullptr;
struct PerVolCounters { PDH_HCOUNTER read, write, active, queue; };
static std::vector<std::pair<std::wstring, PerVolCounters>> g_pdh_counters;
static bool g_pdh_primed = false;

static void ensure_pdh(const std::vector<wchar_t>& letters) {
    if (g_pdh_query) return;
    if (PdhOpenQueryW(nullptr, 0, &g_pdh_query) != ERROR_SUCCESS) {
        g_pdh_query = nullptr;
        return;
    }
    for (wchar_t L : letters) {
        wchar_t inst[8];
        swprintf_s(inst, L"%c:", L);
        PerVolCounters c{};
        wchar_t p[128];
        swprintf_s(p, L"\\LogicalDisk(%s)\\Disk Read Bytes/sec", inst);
        PdhAddEnglishCounterW(g_pdh_query, p, 0, &c.read);
        swprintf_s(p, L"\\LogicalDisk(%s)\\Disk Write Bytes/sec", inst);
        PdhAddEnglishCounterW(g_pdh_query, p, 0, &c.write);
        swprintf_s(p, L"\\LogicalDisk(%s)\\%% Disk Time", inst);
        PdhAddEnglishCounterW(g_pdh_query, p, 0, &c.active);
        swprintf_s(p, L"\\LogicalDisk(%s)\\Current Disk Queue Length", inst);
        PdhAddEnglishCounterW(g_pdh_query, p, 0, &c.queue);
        g_pdh_counters.emplace_back(inst, c);
    }
    // First sample primes the counters; rates are only meaningful on second call.
    PdhCollectQueryData(g_pdh_query);
}

static VolumeIO fetch_io(const wchar_t* inst) {
    VolumeIO io{};
    for (auto& kv : g_pdh_counters) {
        if (kv.first != inst) continue;
        PDH_FMT_COUNTERVALUE v;
        if (PdhGetFormattedCounterValue(kv.second.read, PDH_FMT_DOUBLE, nullptr, &v) == ERROR_SUCCESS) io.read_bps = v.doubleValue;
        if (PdhGetFormattedCounterValue(kv.second.write, PDH_FMT_DOUBLE, nullptr, &v) == ERROR_SUCCESS) io.write_bps = v.doubleValue;
        if (PdhGetFormattedCounterValue(kv.second.active, PDH_FMT_DOUBLE, nullptr, &v) == ERROR_SUCCESS) io.active_pct = v.doubleValue;
        if (PdhGetFormattedCounterValue(kv.second.queue, PDH_FMT_DOUBLE, nullptr, &v) == ERROR_SUCCESS) io.queue = v.doubleValue;
        break;
    }
    return io;
}

// ---------------------------------------------------------------------------
// Public: volume list
// ---------------------------------------------------------------------------
extern "C" DLL_EXPORT int32_t get_storage_volume_list(StorageVolumeInfo* buffer, int32_t max_count) {
    DWORD drives = GetLogicalDrives();
    std::vector<wchar_t> letters;
    for (int i = 0; i < 26; ++i) if (drives & (1u << i)) letters.push_back(L'A' + i);
    if (!buffer) return static_cast<int32_t>(letters.size());

    // Capture %SystemRoot% drive once to mark "is_system".
    wchar_t sysroot[MAX_PATH] = {0};
    GetWindowsDirectoryW(sysroot, MAX_PATH);
    wchar_t sysLetter = (sysroot[0] >= L'A' && sysroot[0] <= L'Z') ? sysroot[0]
                      : (sysroot[0] >= L'a' && sysroot[0] <= L'z') ? (wchar_t)(sysroot[0] - (L'a' - L'A')) : L'C';

    {
        std::lock_guard<std::mutex> lock(g_pdh_mtx);
        ensure_pdh(letters);
        if (g_pdh_query) {
            // Second sample is needed for rates; the previous ensure_pdh() primed it.
            PdhCollectQueryData(g_pdh_query);
        }
    }

    int32_t filled = 0;
    for (wchar_t L : letters) {
        if (filled >= max_count) break;
        StorageVolumeInfo& v = buffer[filled];
        memset(&v, 0, sizeof(v));
        v.letter = L;

        wchar_t rootPath[8];
        swprintf_s(rootPath, L"%c:\\", L);
        UINT dt = GetDriveTypeW(rootPath);

        // Skip pure optical/removable with no media; they'd show up as 0/0 confusingly.
        if (dt == DRIVE_NO_ROOT_DIR) continue;

        v.media_kind = classify_media(L, dt);
        v.is_system  = (L == sysLetter) ? 1 : 0;

        // Volume info (label + fs). Missing drives (empty CD tray) return FALSE; skip.
        DWORD serial = 0, maxLen = 0, fsFlags = 0;
        wchar_t label[64] = {0}, fsName[16] = {0};
        BOOL okvi = GetVolumeInformationW(rootPath, label, 64, &serial, &maxLen, &fsFlags, fsName, 16);
        if (okvi) {
            wcscpy_s(v.label, 64, label[0] ? label : L"");
            wcscpy_s(v.filesystem, 16, fsName);
            v.is_readonly = (fsFlags & FILE_READ_ONLY_VOLUME) ? 1 : 0;
        }

        ULARGE_INTEGER freeAvail{}, total{}, totalFree{};
        if (GetDiskFreeSpaceExW(rootPath, &freeAvail, &total, &totalFree)) {
            v.total_bytes = total.QuadPart;
            v.free_bytes  = totalFree.QuadPart;
        }

        if (g_pdh_query) {
            wchar_t inst[8];
            swprintf_s(inst, L"%c:", L);
            VolumeIO io;
            { std::lock_guard<std::mutex> lock(g_pdh_mtx); io = fetch_io(inst); }
            v.read_bytes_per_sec  = io.read_bps;
            v.write_bytes_per_sec = io.write_bps;
            v.active_percent      = (io.active_pct > 100.0) ? 100.0 : io.active_pct;
            v.queue_length        = io.queue;
        }

        filled++;
    }
    return filled;
}

// ---------------------------------------------------------------------------
// Folder size scan (depth=1). Skips reparse points and common noisy roots we
// definitely don't want to recurse into ($Recycle.Bin, System Volume Information).
// This is synchronous — caller (Tauri worker thread) must accept latency.
// ---------------------------------------------------------------------------

static uint64_t scan_dir_recursive(const fs::path& dir, int64_t& file_count, int depth_left) {
    if (depth_left < 0) return 0;
    uint64_t total = 0;
    std::error_code ec;
    fs::directory_iterator it(dir, fs::directory_options::skip_permission_denied, ec);
    if (ec) return 0;
    for (; it != fs::directory_iterator(); it.increment(ec)) {
        if (ec) { ec.clear(); continue; }
        const auto& ent = *it;
        auto status = ent.symlink_status(ec);
        if (ec) { ec.clear(); continue; }
        // Skip reparse points (junctions, symlinks, OneDrive placeholders).
        if (fs::is_symlink(status)) continue;
        try {
            if (ent.is_directory(ec) && !ec) {
                total += scan_dir_recursive(ent.path(), file_count, depth_left - 1);
            } else if (ent.is_regular_file(ec) && !ec) {
                auto sz = ent.file_size(ec);
                if (!ec) { total += sz; file_count++; }
            }
        } catch (...) { /* silently skip unreadable entries */ }
    }
    return total;
}

extern "C" DLL_EXPORT int32_t get_storage_top_folders(const wchar_t* root_utf16, StorageFolderInfo* buffer, int32_t max_count) {
    if (!root_utf16 || !buffer || max_count <= 0) return 0;

    fs::path root(root_utf16);
    std::error_code ec;
    if (!fs::exists(root, ec)) return 0;

    struct Entry { std::wstring path, leaf; uint64_t size; int64_t files; };
    std::vector<Entry> entries;

    // Enumerate top-level children only, then recurse into each.
    // We include well-known user-side roots expanded one level deeper so the
    // breakdown is useful. For C:\ we also drill AppData\Local and Users\<me>.
    std::vector<fs::path> scan_roots;
    scan_roots.push_back(root);

    // Users\<current user>: also expand second level so AppData / Documents /
    // Downloads each get their own entry instead of being lumped under "Users".
    wchar_t profile[MAX_PATH] = {0};
    DWORD plen = MAX_PATH;
    GetEnvironmentVariableW(L"USERPROFILE", profile, plen);
    if (profile[0]) {
        fs::path up(profile);
        // Include if on same drive as root
        if (_wcsnicmp(up.c_str(), root.c_str(), 1) == 0) scan_roots.push_back(up);
    }

    for (const auto& sr : scan_roots) {
        fs::directory_iterator it(sr, fs::directory_options::skip_permission_denied, ec);
        if (ec) { ec.clear(); continue; }
        for (; it != fs::directory_iterator(); it.increment(ec)) {
            if (ec) { ec.clear(); continue; }
            const auto& ent = *it;
            auto status = ent.symlink_status(ec);
            if (ec || fs::is_symlink(status)) { ec.clear(); continue; }

            std::wstring leaf = ent.path().filename().wstring();
            // Skip obviously uninteresting / harmful roots.
            if (_wcsicmp(leaf.c_str(), L"$Recycle.Bin") == 0) continue;
            if (_wcsicmp(leaf.c_str(), L"System Volume Information") == 0) continue;
            if (_wcsicmp(leaf.c_str(), L"pagefile.sys") == 0) continue; // file, handled separately
            if (_wcsicmp(leaf.c_str(), L"hiberfil.sys") == 0) continue;

            uint64_t sz = 0;
            int64_t files = 0;
            if (ent.is_directory(ec) && !ec) {
                sz = scan_dir_recursive(ent.path(), files, /*depth=*/8);
            } else if (ent.is_regular_file(ec) && !ec) {
                sz = ent.file_size(ec); if (!ec) files = 1;
            }
            if (sz == 0) continue;

            Entry e;
            e.path = ent.path().wstring();
            // Friendly display: "Users\Samee" → show parent + leaf when from scan_roots[1+]
            if (&sr != &scan_roots[0]) {
                e.leaf = sr.filename().wstring() + L"\\" + leaf;
            } else {
                e.leaf = leaf;
            }
            e.size = sz;
            e.files = files;
            entries.push_back(std::move(e));
        }
    }

    std::sort(entries.begin(), entries.end(),
              [](const Entry& a, const Entry& b){ return a.size > b.size; });

    int32_t filled = 0;
    for (size_t i = 0; i < entries.size() && filled < max_count; ++i) {
        StorageFolderInfo& f = buffer[filled];
        memset(&f, 0, sizeof(f));
        wcsncpy_s(f.path, 520, entries[i].path.c_str(), _TRUNCATE);
        wcsncpy_s(f.display_name, 128, entries[i].leaf.c_str(), _TRUNCATE);
        f.size_bytes = entries[i].size;
        f.file_count = entries[i].files;
        filled++;
    }
    return filled;
}

// ---------------------------------------------------------------------------
// Installed apps — registry enumeration of three standard Uninstall hives.
// ---------------------------------------------------------------------------
struct AppEntry {
    std::wstring name, publisher, version, install_date, install_location;
    uint64_t size;
};

static void read_reg_string(HKEY hk, const wchar_t* name, std::wstring& out) {
    wchar_t buf[1024]; DWORD cb = sizeof(buf); DWORD type = 0;
    if (RegQueryValueExW(hk, name, nullptr, &type, (LPBYTE)buf, &cb) == ERROR_SUCCESS
        && (type == REG_SZ || type == REG_EXPAND_SZ)) {
        out.assign(buf, cb / sizeof(wchar_t));
        while (!out.empty() && out.back() == L'\0') out.pop_back();
    }
}

static void enumerate_hive(HKEY root, const wchar_t* subkey, std::vector<AppEntry>& out) {
    HKEY hive;
    if (RegOpenKeyExW(root, subkey, 0, KEY_READ | KEY_WOW64_64KEY, &hive) != ERROR_SUCCESS) return;
    wchar_t keyName[256]; DWORD keyNameLen;
    for (DWORD idx = 0;; ++idx) {
        keyNameLen = 256;
        if (RegEnumKeyExW(hive, idx, keyName, &keyNameLen, nullptr, nullptr, nullptr, nullptr) != ERROR_SUCCESS) break;
        HKEY sub;
        if (RegOpenKeyExW(hive, keyName, 0, KEY_READ, &sub) != ERROR_SUCCESS) continue;

        AppEntry e{};
        read_reg_string(sub, L"DisplayName", e.name);
        if (!e.name.empty()) {
            read_reg_string(sub, L"Publisher", e.publisher);
            read_reg_string(sub, L"DisplayVersion", e.version);
            read_reg_string(sub, L"InstallDate", e.install_date);
            read_reg_string(sub, L"InstallLocation", e.install_location);

            DWORD size_kb = 0, cb = sizeof(size_kb), type = 0;
            if (RegQueryValueExW(sub, L"EstimatedSize", nullptr, &type, (LPBYTE)&size_kb, &cb) == ERROR_SUCCESS
                && type == REG_DWORD) {
                e.size = (uint64_t)size_kb * 1024ull;
            }

            // Skip system-component / updates / parent-flagged entries — these
            // are KB installers and framework bits that clutter the list.
            DWORD systemComp = 0; cb = sizeof(systemComp);
            RegQueryValueExW(sub, L"SystemComponent", nullptr, &type, (LPBYTE)&systemComp, &cb);
            std::wstring parentKey;
            read_reg_string(sub, L"ParentKeyName", parentKey);
            if (systemComp == 0 && parentKey.empty()) {
                out.push_back(std::move(e));
            }
        }
        RegCloseKey(sub);
    }
    RegCloseKey(hive);
}

// ---------------------------------------------------------------------------
// PE version info extraction — pulls FileDescription, CompanyName,
// ProductVersion from an .exe's VERSIONINFO resource.
// ---------------------------------------------------------------------------
struct PeVersionInfo {
    std::wstring description;   // FileDescription → used as app name
    std::wstring company;       // CompanyName → publisher
    std::wstring version;       // ProductVersion
};

static PeVersionInfo read_pe_version(const fs::path& exe) {
    PeVersionInfo vi{};
    DWORD dummy = 0;
    DWORD size = GetFileVersionInfoSizeW(exe.c_str(), &dummy);
    if (!size) return vi;

    std::vector<BYTE> buf(size);
    if (!GetFileVersionInfoW(exe.c_str(), 0, size, buf.data())) return vi;

    // Try the common \StringFileInfo\040904B0\ (English-US, Unicode) block first,
    // then fall back to whatever translation is available.
    struct { WORD lang; WORD codepage; }* translations = nullptr;
    UINT tLen = 0;
    VerQueryValueW(buf.data(), L"\\VarFileInfo\\Translation",
                   (void**)&translations, &tLen);

    auto query = [&](const wchar_t* key, std::wstring& out) {
        UINT cnt = tLen / sizeof(*translations);
        if (cnt == 0) cnt = 1; // try default block
        for (UINT i = 0; i < cnt && out.empty(); ++i) {
            wchar_t sub[128];
            WORD lang = (translations && i < tLen / sizeof(*translations))
                            ? translations[i].lang : 0x0409;
            WORD cp   = (translations && i < tLen / sizeof(*translations))
                            ? translations[i].codepage : 0x04B0;
            swprintf_s(sub, L"\\StringFileInfo\\%04X%04X\\%s", lang, cp, key);
            wchar_t* val = nullptr; UINT vLen = 0;
            if (VerQueryValueW(buf.data(), sub, (void**)&val, &vLen) && val && vLen > 0) {
                out.assign(val);
                while (!out.empty() && out.back() == L'\0') out.pop_back();
            }
        }
    };
    query(L"FileDescription", vi.description);
    query(L"CompanyName", vi.company);
    query(L"ProductVersion", vi.version);
    return vi;
}

// ---------------------------------------------------------------------------
// Shallow folder size (depth ≤ 2 to stay fast). Used for backfilling
// size_bytes on registry entries that have InstallLocation but no
// EstimatedSize, and for Program Files discovery entries.
// ---------------------------------------------------------------------------
static uint64_t quick_folder_size(const fs::path& dir) {
    uint64_t total = 0;
    std::error_code ec;
    fs::recursive_directory_iterator it(dir,
        fs::directory_options::skip_permission_denied, ec);
    if (ec) return 0;
    int limit = 10000; // cap iteration to keep it fast
    for (; it != fs::recursive_directory_iterator() && limit > 0; it.increment(ec), --limit) {
        if (ec) { ec.clear(); continue; }
        if (it.depth() > 2) { it.disable_recursion_pending(); continue; }
        auto st = it->symlink_status(ec);
        if (ec || fs::is_symlink(st)) { ec.clear(); continue; }
        if (it->is_regular_file(ec) && !ec) {
            auto sz = it->file_size(ec);
            if (!ec) total += sz;
        }
    }
    return total;
}

// ---------------------------------------------------------------------------
// Find the "main" .exe in a directory — the one most likely to be the app.
// Prefers .exe in the root, then the largest .exe up to depth 1.
// ---------------------------------------------------------------------------
static fs::path find_main_exe(const fs::path& dir) {
    std::error_code ec;
    fs::path best;
    uint64_t bestSize = 0;

    // Pass 1: root-level .exe files
    for (auto& ent : fs::directory_iterator(dir, fs::directory_options::skip_permission_denied, ec)) {
        if (ec) { ec.clear(); continue; }
        if (!ent.is_regular_file(ec) || ec) { ec.clear(); continue; }
        auto ext = ent.path().extension().wstring();
        for (auto& c : ext) c = towlower(c);
        if (ext != L".exe") continue;
        auto sz = ent.file_size(ec);
        if (!ec && sz > bestSize) { bestSize = sz; best = ent.path(); }
    }
    if (!best.empty()) return best;

    // Pass 2: one level deeper (e.g. "app/bin/app.exe")
    for (auto& sub : fs::directory_iterator(dir, fs::directory_options::skip_permission_denied, ec)) {
        if (ec) { ec.clear(); continue; }
        if (!sub.is_directory(ec) || ec) { ec.clear(); continue; }
        for (auto& ent : fs::directory_iterator(sub.path(), fs::directory_options::skip_permission_denied, ec)) {
            if (ec) { ec.clear(); continue; }
            if (!ent.is_regular_file(ec) || ec) { ec.clear(); continue; }
            auto ext = ent.path().extension().wstring();
            for (auto& c : ext) c = towlower(c);
            if (ext != L".exe") continue;
            auto sz = ent.file_size(ec);
            if (!ec && sz > bestSize) { bestSize = sz; best = ent.path(); }
        }
    }
    return best;
}

// ---------------------------------------------------------------------------
// Program Files scanner — discovers apps that installed into Program Files
// but never registered in Add/Remove Programs.
// ---------------------------------------------------------------------------
static void discover_program_files(const std::vector<AppEntry>& registry_apps,
                                   std::vector<AppEntry>& out) {
    // Build a set of known install locations (lowered, trimmed trailing slash)
    // so we can skip folders that are already covered by a registry entry.
    std::unordered_set<std::wstring> known_locs;
    std::unordered_set<std::wstring> known_names;
    for (auto& a : registry_apps) {
        if (!a.install_location.empty()) {
            std::wstring loc = a.install_location;
            while (!loc.empty() && (loc.back() == L'\\' || loc.back() == L'/')) loc.pop_back();
            for (auto& c : loc) c = towlower(c);
            known_locs.insert(loc);
        }
        std::wstring ln = a.name;
        for (auto& c : ln) c = towlower(c);
        known_names.insert(ln);
    }

    wchar_t pf64[MAX_PATH] = {}, pf32[MAX_PATH] = {};
    ExpandEnvironmentStringsW(L"%ProgramFiles%", pf64, MAX_PATH);
    ExpandEnvironmentStringsW(L"%ProgramFiles(x86)%", pf32, MAX_PATH);

    auto scan = [&](const fs::path& pfRoot) {
        std::error_code ec;
        for (auto& ent : fs::directory_iterator(pfRoot, fs::directory_options::skip_permission_denied, ec)) {
            if (ec) { ec.clear(); continue; }
            if (!ent.is_directory(ec) || ec) { ec.clear(); continue; }

            // Check if already known by install location
            std::wstring loc = ent.path().wstring();
            while (!loc.empty() && loc.back() == L'\\') loc.pop_back();
            std::wstring locLow = loc;
            for (auto& c : locLow) c = towlower(c);
            if (known_locs.count(locLow)) continue;

            // Check if already known by name (folder name ≈ app name)
            std::wstring leaf = ent.path().filename().wstring();
            std::wstring leafLow = leaf;
            for (auto& c : leafLow) c = towlower(c);
            if (known_names.count(leafLow)) continue;

            // Skip very common non-app directories
            if (_wcsicmp(leaf.c_str(), L"Common Files") == 0) continue;
            if (_wcsicmp(leaf.c_str(), L"WindowsApps") == 0) continue;
            if (_wcsicmp(leaf.c_str(), L"Windows Defender") == 0) continue;
            if (_wcsicmp(leaf.c_str(), L"Windows NT") == 0) continue;
            if (_wcsicmp(leaf.c_str(), L"Windows Mail") == 0) continue;
            if (_wcsicmp(leaf.c_str(), L"Windows Photo Viewer") == 0) continue;
            if (_wcsicmp(leaf.c_str(), L"Windows Sidebar") == 0) continue;
            if (_wcsicmp(leaf.c_str(), L"Windows Portable Devices") == 0) continue;
            if (_wcsicmp(leaf.c_str(), L"Windows Multimedia Platform") == 0) continue;
            if (_wcsicmp(leaf.c_str(), L"desktop.ini") == 0) continue;
            if (_wcsicmp(leaf.c_str(), L"Uninstall Information") == 0) continue;
            if (_wcsicmp(leaf.c_str(), L"Reference Assemblies") == 0) continue;
            if (_wcsicmp(leaf.c_str(), L"MSBuild") == 0) continue;
            if (_wcsicmp(leaf.c_str(), L"Microsoft.NET") == 0) continue;

            // Find main executable and extract version info
            fs::path exe = find_main_exe(ent.path());
            if (exe.empty()) continue;

            PeVersionInfo vi = read_pe_version(exe);

            AppEntry e{};
            e.name = vi.description.empty() ? leaf : vi.description;
            e.publisher = vi.company;
            e.version = vi.version;
            e.install_location = ent.path().wstring();
            e.size = quick_folder_size(ent.path());
            if (e.size == 0) continue; // skip empty folders

            // Final dedup check against the display name we extracted
            std::wstring namelow = e.name;
            for (auto& c : namelow) c = towlower(c);
            if (known_names.count(namelow)) continue;

            known_names.insert(namelow);
            known_locs.insert(locLow);
            out.push_back(std::move(e));
        }
    };

    if (pf64[0]) scan(fs::path(pf64));
    if (pf32[0] && _wcsicmp(pf32, pf64) != 0) scan(fs::path(pf32));
}

// ---------------------------------------------------------------------------
// Backfill: for registry apps with InstallLocation but EstimatedSize==0,
// measure actual folder size. Capped to keep the call fast.
// ---------------------------------------------------------------------------
static void backfill_sizes(std::vector<AppEntry>& apps) {
    int budget = 50; // max folders to measure
    for (auto& a : apps) {
        if (budget <= 0) break;
        if (a.size > 0 || a.install_location.empty()) continue;
        std::error_code ec;
        fs::path loc(a.install_location);
        if (!fs::is_directory(loc, ec) || ec) continue;
        a.size = quick_folder_size(loc);
        --budget;
    }
}

extern "C" DLL_EXPORT int32_t get_installed_apps(InstalledAppInfo* buffer, int32_t max_count) {
    std::vector<AppEntry> apps;
    enumerate_hive(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall", apps);
    enumerate_hive(HKEY_LOCAL_MACHINE, L"SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall", apps);
    enumerate_hive(HKEY_CURRENT_USER,  L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall", apps);

    // Dedupe by (name + version). Same app appears in both 64-bit and WOW6432 views.
    std::sort(apps.begin(), apps.end(), [](const AppEntry& a, const AppEntry& b){
        if (a.name != b.name) return a.name < b.name;
        return a.version < b.version;
    });
    apps.erase(std::unique(apps.begin(), apps.end(), [](const AppEntry& a, const AppEntry& b){
        return a.name == b.name && a.version == b.version;
    }), apps.end());

    // Backfill sizes for registry entries missing EstimatedSize
    backfill_sizes(apps);

    // Discover apps in Program Files not covered by registry
    discover_program_files(apps, apps);

    // Primary sort: size desc (0-size apps trail alphabetically).
    std::sort(apps.begin(), apps.end(), [](const AppEntry& a, const AppEntry& b){
        if (a.size != b.size) return a.size > b.size;
        return a.name < b.name;
    });

    if (!buffer) return static_cast<int32_t>(apps.size());
    int32_t filled = 0;
    for (size_t i = 0; i < apps.size() && filled < max_count; ++i) {
        InstalledAppInfo& r = buffer[filled];
        memset(&r, 0, sizeof(r));
        wcsncpy_s(r.name, 256, apps[i].name.c_str(), _TRUNCATE);
        wcsncpy_s(r.publisher, 128, apps[i].publisher.c_str(), _TRUNCATE);
        wcsncpy_s(r.version, 64, apps[i].version.c_str(), _TRUNCATE);
        wcsncpy_s(r.install_date, 16, apps[i].install_date.c_str(), _TRUNCATE);
        wcsncpy_s(r.install_location, 520, apps[i].install_location.c_str(), _TRUNCATE);
        r.size_bytes = apps[i].size;
        filled++;
    }
    return filled;
}

// ---------------------------------------------------------------------------
// Recycle bin
// ---------------------------------------------------------------------------
extern "C" DLL_EXPORT uint64_t get_recycle_bin_size() {
    SHQUERYRBINFO info = {};
    info.cbSize = sizeof(info);
    // Passing NULL queries all drives.
    if (SHQueryRecycleBinW(nullptr, &info) == S_OK) {
        return (uint64_t)info.i64Size;
    }
    return 0;
}

extern "C" DLL_EXPORT int32_t empty_recycle_bin() {
    // No UI, no progress, no confirmation — the frontend shows its own confirm dialog.
    HRESULT hr = SHEmptyRecycleBinW(nullptr, nullptr,
        SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI | SHERB_NOSOUND);
    return SUCCEEDED(hr) ? 0 : -1;
}

// ---------------------------------------------------------------------------
// Smart Organizer — file-type classification scanner
// ---------------------------------------------------------------------------
// Classifies files under a folder (depth=6, 20k file cap) into ~10 categories
// via extension + filename heuristics. Used by the Smart Organizer panel on
// the Storage page to build composition bars, misplaced-file findings, and
// cleanup suggestions.
//
// The scan is synchronous but always invoked from a Tauri worker thread.
// Skips reparse points, $Recycle.Bin, System Volume Information, and the
// .git / node_modules / target / build directories that would otherwise
// balloon the file count without adding useful signal.

enum OrganizerCategory {
    OC_DOCUMENTS = 0,
    OC_IMAGES,
    OC_VIDEOS,
    OC_AUDIO,
    OC_ARCHIVES,
    OC_CODE,
    OC_EXECUTABLES,
    OC_INSTALLERS,   // subset of executables: *setup*, *install*, MSI/MSP
    OC_SCREENSHOTS,  // subset of images: name starts with "Screenshot"/"Screen Shot"
    OC_OTHER,
    OC_COUNT
};

static const wchar_t* kCategoryName[OC_COUNT] = {
    L"documents", L"images", L"videos", L"audio", L"archives",
    L"code", L"executables", L"installers", L"screenshots", L"other",
};

// Returns true if ext matches any of the comma-separated lowercase entries.
static bool ext_is_any(const std::wstring& ext, std::initializer_list<const wchar_t*> list) {
    for (auto e : list) if (ext == e) return true;
    return false;
}

static int classify_extension(const std::wstring& ext) {
    if (ext.empty()) return OC_OTHER;
    if (ext_is_any(ext, {L".pdf", L".docx", L".doc", L".xlsx", L".xls",
                          L".pptx", L".ppt", L".txt", L".csv", L".md",
                          L".rtf", L".odt", L".ods", L".odp", L".epub"}))
        return OC_DOCUMENTS;
    if (ext_is_any(ext, {L".jpg", L".jpeg", L".png", L".gif", L".webp",
                          L".svg", L".bmp", L".tiff", L".tif", L".ico",
                          L".heic", L".heif", L".raw", L".cr2", L".nef"}))
        return OC_IMAGES;
    if (ext_is_any(ext, {L".mp4", L".mkv", L".avi", L".mov", L".wmv",
                          L".webm", L".flv", L".m4v", L".mpg", L".mpeg"}))
        return OC_VIDEOS;
    if (ext_is_any(ext, {L".mp3", L".wav", L".flac", L".aac", L".ogg",
                          L".m4a", L".wma", L".opus", L".aiff", L".ape"}))
        return OC_AUDIO;
    if (ext_is_any(ext, {L".zip", L".rar", L".7z", L".tar", L".gz",
                          L".bz2", L".xz", L".iso", L".dmg", L".tgz"}))
        return OC_ARCHIVES;
    if (ext_is_any(ext, {L".py", L".js", L".ts", L".tsx", L".jsx",
                          L".cpp", L".cc", L".c", L".h", L".hpp", L".rs",
                          L".java", L".kt", L".go", L".cs", L".vb",
                          L".html", L".htm", L".css", L".scss", L".sass",
                          L".json", L".yaml", L".yml", L".toml", L".xml",
                          L".rb", L".php", L".swift", L".lua", L".sh"}))
        return OC_CODE;
    if (ext_is_any(ext, {L".msi", L".msp", L".msix", L".msixbundle",
                          L".appx", L".appxbundle"}))
        return OC_INSTALLERS;
    if (ext_is_any(ext, {L".exe", L".bat", L".cmd", L".ps1", L".com"}))
        return OC_EXECUTABLES;
    return OC_OTHER;
}

static std::wstring lower_copy(const std::wstring& s) {
    std::wstring out = s;
    for (auto& c : out) c = towlower(c);
    return out;
}

// Directories we never recurse into — they either loop, are system-managed,
// or contain build artifacts that aren't meaningful for clutter analysis.
static bool is_skip_dir(const std::wstring& leaf_lower) {
    return leaf_lower == L"$recycle.bin"
        || leaf_lower == L"system volume information"
        || leaf_lower == L"node_modules"
        || leaf_lower == L".git"
        || leaf_lower == L".svn"
        || leaf_lower == L".hg"
        || leaf_lower == L"target"            // Rust build
        || leaf_lower == L"build"             // generic build
        || leaf_lower == L"dist"
        || leaf_lower == L"__pycache__"
        || leaf_lower == L".venv"
        || leaf_lower == L"venv";
}

struct CategoryRollup {
    uint64_t total_bytes = 0;
    int64_t  file_count = 0;
    int64_t  oldest_ts = 0;
    int64_t  newest_ts = 0;
};

static int64_t file_time_to_unix(FILETIME ft) {
    ULARGE_INTEGER ul; ul.LowPart = ft.dwLowDateTime; ul.HighPart = ft.dwHighDateTime;
    // FILETIME is 100-ns intervals since 1601. Unix epoch = 1970.
    // 116444736000000000 = number of 100-ns intervals between 1601 and 1970.
    if (ul.QuadPart < 116444736000000000ULL) return 0;
    return static_cast<int64_t>((ul.QuadPart - 116444736000000000ULL) / 10000000ULL);
}

static void scan_file_types_recursive(
    const fs::path& dir,
    int depth_left,
    int& file_budget,
    CategoryRollup* rollups)
{
    if (depth_left < 0 || file_budget <= 0) return;
    std::error_code ec;
    fs::directory_iterator it(dir, fs::directory_options::skip_permission_denied, ec);
    if (ec) return;

    for (; it != fs::directory_iterator() && file_budget > 0; it.increment(ec)) {
        if (ec) { ec.clear(); continue; }
        const auto& ent = *it;
        auto status = ent.symlink_status(ec);
        if (ec) { ec.clear(); continue; }
        if (fs::is_symlink(status)) continue;

        try {
            if (ent.is_directory(ec) && !ec) {
                std::wstring leaf_lower = lower_copy(ent.path().filename().wstring());
                if (is_skip_dir(leaf_lower)) continue;
                scan_file_types_recursive(ent.path(), depth_left - 1, file_budget, rollups);
            } else if (ent.is_regular_file(ec) && !ec) {
                --file_budget;
                auto sz = ent.file_size(ec);
                if (ec) { ec.clear(); continue; }

                std::wstring ext_lower = lower_copy(ent.path().extension().wstring());
                std::wstring name_lower = lower_copy(ent.path().stem().wstring());
                int cat = classify_extension(ext_lower);

                // Name-based overrides layered on top of extension classification.
                if (cat == OC_EXECUTABLES || cat == OC_ARCHIVES) {
                    if (name_lower.find(L"setup") != std::wstring::npos
                     || name_lower.find(L"install") != std::wstring::npos
                     || name_lower.find(L"_setup") != std::wstring::npos) {
                        cat = OC_INSTALLERS;
                    }
                } else if (cat == OC_IMAGES) {
                    if (name_lower.rfind(L"screenshot", 0) == 0
                     || name_lower.rfind(L"screen shot", 0) == 0
                     || name_lower.rfind(L"screen_shot", 0) == 0) {
                        cat = OC_SCREENSHOTS;
                    }
                }

                auto& r = rollups[cat];
                r.total_bytes += sz;
                r.file_count  += 1;

                // Last-write time via Win32 (std::filesystem clock epoch is fiddly on Windows).
                HANDLE h = CreateFileW(ent.path().c_str(), 0,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr);
                if (h != INVALID_HANDLE_VALUE) {
                    FILETIME ftc{}, fta{}, ftw{};
                    if (GetFileTime(h, &ftc, &fta, &ftw)) {
                        int64_t ts = file_time_to_unix(ftw);
                        if (ts > 0) {
                            if (r.oldest_ts == 0 || ts < r.oldest_ts) r.oldest_ts = ts;
                            if (ts > r.newest_ts) r.newest_ts = ts;
                        }
                    }
                    CloseHandle(h);
                }
            }
        } catch (...) { /* skip unreadable entries */ }
    }
}

extern "C" DLL_EXPORT int32_t scan_folder_file_types(
    const wchar_t* folder_utf16, FileTypeStat* buffer, int32_t max_count)
{
    if (!folder_utf16 || !buffer || max_count <= 0) return 0;
    fs::path folder(folder_utf16);
    std::error_code ec;
    if (!fs::exists(folder, ec) || !fs::is_directory(folder, ec)) return 0;

    CategoryRollup rollups[OC_COUNT] = {};
    int file_budget = 20000;
    scan_file_types_recursive(folder, /*depth=*/6, file_budget, rollups);

    std::wstring folder_str = folder.wstring();
    int32_t filled = 0;
    for (int i = 0; i < OC_COUNT && filled < max_count; ++i) {
        if (rollups[i].file_count == 0) continue;
        FileTypeStat& r = buffer[filled++];
        memset(&r, 0, sizeof(r));
        wcsncpy_s(r.folder_path, 520, folder_str.c_str(), _TRUNCATE);
        wcsncpy_s(r.category, 32, kCategoryName[i], _TRUNCATE);
        r.total_bytes = rollups[i].total_bytes;
        r.file_count  = rollups[i].file_count;
        r.oldest_modified_ts = rollups[i].oldest_ts;
        r.newest_modified_ts = rollups[i].newest_ts;
    }
    return filled;
}

// ---------------------------------------------------------------------------
// Smart Organizer — project detection
// ---------------------------------------------------------------------------
// Walks to depth 4 under `root` looking for project marker files. Once a
// project is found at a given folder we STOP recursing into it — a Git repo
// that also happens to contain a package.json shouldn't be reported twice.

static const wchar_t* detect_project_markers(const fs::path& dir, std::error_code& ec) {
    // Directory markers take priority (they imply the repo root is here even
    // if the file markers below belong to a subproject).
    if (fs::exists(dir / L".git", ec)) return L"git";
    // Single-pass scan for the remaining file markers.
    fs::directory_iterator it(dir, fs::directory_options::skip_permission_denied, ec);
    if (ec) { ec.clear(); return nullptr; }
    bool has_package_json = false, has_cargo_toml = false;
    bool has_csproj_or_sln = false, has_pyproject = false;
    for (; it != fs::directory_iterator(); it.increment(ec)) {
        if (ec) { ec.clear(); continue; }
        if (!it->is_regular_file(ec) || ec) { ec.clear(); continue; }
        std::wstring leaf = lower_copy(it->path().filename().wstring());
        std::wstring ext  = lower_copy(it->path().extension().wstring());
        if (leaf == L"package.json") has_package_json = true;
        else if (leaf == L"cargo.toml") has_cargo_toml = true;
        else if (leaf == L"pyproject.toml" || leaf == L"setup.py") has_pyproject = true;
        else if (ext == L".sln" || ext == L".csproj") has_csproj_or_sln = true;
    }
    if (has_cargo_toml) return L"rust";
    if (has_csproj_or_sln) return L"dotnet";
    if (has_package_json) return L"nodejs";
    if (has_pyproject) return L"python";
    return nullptr;
}

struct ProjectEntry {
    std::wstring path, type, display_name;
    uint64_t size;
    int64_t files;
};

static void detect_projects_recursive(
    const fs::path& dir,
    int depth_left,
    std::vector<ProjectEntry>& out,
    int& dir_budget)
{
    if (depth_left < 0 || dir_budget <= 0) return;
    if (out.size() >= 200) return;  // absolute cap

    std::error_code ec;
    const wchar_t* proj_type = detect_project_markers(dir, ec);
    if (proj_type) {
        ProjectEntry e{};
        e.path = dir.wstring();
        e.type = proj_type;
        e.display_name = dir.filename().wstring();
        int64_t fc = 0;
        // Only measure size if the project is small enough to matter for ranking —
        // a shallow scan here keeps the overall walk snappy. Don't count node_modules.
        e.size = scan_dir_recursive(dir, fc, /*depth=*/4);
        e.files = fc;
        out.push_back(std::move(e));
        --dir_budget;
        return;  // don't recurse into a detected project
    }

    fs::directory_iterator it(dir, fs::directory_options::skip_permission_denied, ec);
    if (ec) return;
    for (; it != fs::directory_iterator(); it.increment(ec)) {
        if (ec) { ec.clear(); continue; }
        if (!it->is_directory(ec) || ec) { ec.clear(); continue; }
        auto st = it->symlink_status(ec);
        if (ec || fs::is_symlink(st)) { ec.clear(); continue; }
        std::wstring leaf_lower = lower_copy(it->path().filename().wstring());
        if (is_skip_dir(leaf_lower)) continue;
        --dir_budget;
        detect_projects_recursive(it->path(), depth_left - 1, out, dir_budget);
        if (dir_budget <= 0 || out.size() >= 200) return;
    }
}

extern "C" DLL_EXPORT int32_t detect_projects(
    const wchar_t* root_utf16, DetectedProject* buffer, int32_t max_count)
{
    if (!root_utf16 || !buffer || max_count <= 0) return 0;
    fs::path root(root_utf16);
    std::error_code ec;
    if (!fs::exists(root, ec) || !fs::is_directory(root, ec)) return 0;

    std::vector<ProjectEntry> projects;
    int dir_budget = 2000;  // bound the walk even on pathological trees
    detect_projects_recursive(root, /*depth=*/4, projects, dir_budget);

    std::sort(projects.begin(), projects.end(),
              [](const ProjectEntry& a, const ProjectEntry& b){ return a.size > b.size; });

    int32_t filled = 0;
    for (size_t i = 0; i < projects.size() && filled < max_count; ++i) {
        DetectedProject& d = buffer[filled++];
        memset(&d, 0, sizeof(d));
        wcsncpy_s(d.path, 520, projects[i].path.c_str(), _TRUNCATE);
        wcsncpy_s(d.project_type, 32, projects[i].type.c_str(), _TRUNCATE);
        wcsncpy_s(d.display_name, 128, projects[i].display_name.c_str(), _TRUNCATE);
        d.size_bytes = projects[i].size;
        d.file_count = projects[i].files;
    }
    return filled;
}

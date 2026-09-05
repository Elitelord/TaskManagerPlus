// Pure, Windows-API-free path/name helpers shared by storage_telemetry.cpp and
// the standalone storage_paths_tests target. Header-only (`inline`) so both TUs
// get one definition. Keeping these here — instead of buried as `static` in the
// DLL source — is what lets them be unit-tested without loading the DLL or
// touching the filesystem, which matters most for the ancestor-walk logic that
// B1/B2 introduced: a single missing separator check silently returns wrong
// bytes (e.g. treating "c:\users2" as nested under "c:\users").
//
// Only genuinely pure helpers belong here. Anything calling Win32
// (ExpandEnvironmentStringsW, FindFirstFileW, …) stays in the .cpp.
#pragma once

#include <string>
#include <set>
#include <filesystem>
#include <cwctype>
#include <wchar.h>

namespace storage_paths {

inline std::wstring trim_trailing_slash(std::wstring s) {
    while (!s.empty() && (s.back() == L'\\' || s.back() == L'/')) s.pop_back();
    return s;
}

inline std::wstring path_lower(const std::wstring& s) {
    std::wstring out = s;
    for (auto& c : out) c = towlower(c);
    return out;
}

// Returns true if `candidate` is a (case-insensitive) prefix of `prefix`-length
// bytes — a raw prefix compare, NOT boundary-aware. Used only for the
// UninstallString-inside-AppData check where that's the intended semantics.
inline bool path_starts_with(const std::wstring& candidate, const std::wstring& prefix) {
    if (candidate.size() < prefix.size()) return false;
    return _wcsnicmp(candidate.c_str(), prefix.c_str(), prefix.size()) == 0;
}

// Boundary-aware ancestor test over already-lowercased, trailing-slash-trimmed
// paths. True when `anc` == `desc` or `desc` is strictly nested under `anc`. The
// separator check is what distinguishes "c:\users" (ancestor of "c:\users\me")
// from the classic prefix-compare bug that also matches "c:\users2".
inline bool path_is_ancestor(const std::wstring& anc, const std::wstring& desc) {
    if (desc.size() < anc.size()) return false;
    if (_wcsnicmp(desc.c_str(), anc.c_str(), anc.size()) != 0) return false;
    return desc.size() == anc.size() || desc[anc.size()] == L'\\';
}

// A volume root such as "C:\" — a root name plus root directory and nothing
// after it. Drill-down calls pass a nested folder here, for which this is false.
inline bool is_volume_root(const std::filesystem::path& p) {
    return p.has_root_name() && p.has_root_directory() && p.relative_path().empty();
}

inline std::wstring path_key(const std::filesystem::path& p) {
    return path_lower(trim_trailing_slash(p.wstring()));
}

// `key` equals, or is nested under, some entry in `s`.
inline bool has_self_or_ancestor_in(const std::set<std::wstring>& s, const std::wstring& key) {
    std::wstring cur = key;
    for (;;) {
        if (s.count(cur)) return true;
        auto pos = cur.find_last_of(L'\\');
        if (pos == std::wstring::npos) break;
        cur.resize(pos);
        if (cur.empty()) break;
    }
    return false;
}

// `s` contains an entry strictly nested under `key` (i.e. `key` is an ancestor).
inline bool has_descendant_in(const std::set<std::wstring>& s, const std::wstring& key) {
    auto it = s.lower_bound(key + L"\\");
    return it != s.end() && path_is_ancestor(key, *it);
}

// Absolute-depth budget for the top-folders scan: how many levels below an entry
// at `abs_depth` (from the volume root) we may still recurse, capped so every
// emitted row — child or expanded grandchild — looks equally deep. Never < 0.
inline int depth_budget(int max_abs_depth, int abs_depth) {
    int d = max_abs_depth - abs_depth;
    return d < 0 ? 0 : d;
}

// Strip noisy publisher suffixes so a company name matches an AppData leaf.
//   "Microsoft Corporation" -> "Microsoft", "Discord Inc." -> "Discord"
inline std::wstring normalize_publisher(const std::wstring& raw) {
    std::wstring s = raw;
    while (!s.empty() && (s.back() == L'.' || s.back() == L',' || iswspace(s.back()))) s.pop_back();
    static const wchar_t* kSuffixes[] = {
        L", Inc", L" Inc", L", LLC", L" LLC", L" Ltd", L", Ltd",
        L" Corporation", L" Corp", L" Co", L" AB", L" GmbH", L" SA",
        L" Limited", L" Software", L" Software, Inc",
    };
    for (auto* sfx : kSuffixes) {
        size_t slen = wcslen(sfx);
        if (s.size() > slen && _wcsicmp(s.c_str() + s.size() - slen, sfx) == 0) {
            s.resize(s.size() - slen);
            while (!s.empty() && (s.back() == L'.' || s.back() == L',' || iswspace(s.back()))) s.pop_back();
        }
    }
    return s;
}

// Strip a trailing parenthetical bit-width/version marker.
//   "…Redistributable (x64)" -> "…Redistributable", "Discord (User)" -> "Discord"
inline std::wstring normalize_app_name(const std::wstring& raw) {
    std::wstring s = raw;
    auto paren = s.find(L'(');
    if (paren != std::wstring::npos) s.resize(paren);
    while (!s.empty() && iswspace(s.back())) s.pop_back();
    return s;
}

} // namespace storage_paths

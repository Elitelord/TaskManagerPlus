// Standalone assert-based tests for the pure helpers in storage_paths.hpp.
// No test framework: each check is a CHECK() macro that prints and tracks
// failures, and main() returns non-zero if any failed. Build + run:
//   cmake --build native/build --config Release --target storage_paths_tests
//   ./native/build/Release/storage_paths_tests.exe
//
// These cover the ancestor-walk logic B1/B2 introduced — the kind of
// off-by-one-separator bug that silently returns wrong bytes and that no
// higher-level test would localise.
#include "storage_paths.hpp"

#include <cstdio>
#include <set>
#include <string>

using namespace storage_paths;

static int g_failures = 0;
static int g_checks = 0;

#define CHECK(cond)                                                       \
    do {                                                                  \
        ++g_checks;                                                       \
        if (!(cond)) {                                                    \
            ++g_failures;                                                 \
            std::printf("FAIL line %d: %s\n", __LINE__, #cond);          \
        }                                                                 \
    } while (0)

static std::set<std::wstring> make_set(std::initializer_list<const wchar_t*> xs) {
    std::set<std::wstring> s;
    for (auto* x : xs) s.insert(x);
    return s;
}

int main() {
    // --- trim / lower --------------------------------------------------------
    CHECK(trim_trailing_slash(L"C:\\Users\\") == L"C:\\Users");
    CHECK(trim_trailing_slash(L"C:\\Users//") == L"C:\\Users");
    CHECK(trim_trailing_slash(L"C:\\Users") == L"C:\\Users");
    CHECK(path_lower(L"C:\\Users\\SAMEE") == L"c:\\users\\samee");

    // --- path_is_ancestor: the separator boundary is the whole point ---------
    CHECK(path_is_ancestor(L"c:\\users", L"c:\\users"));          // equal
    CHECK(path_is_ancestor(L"c:\\users", L"c:\\users\\samee"));   // nested
    CHECK(!path_is_ancestor(L"c:\\users", L"c:\\users2"));        // NOT the prefix bug
    CHECK(!path_is_ancestor(L"c:\\users\\samee", L"c:\\users"));  // child is not ancestor of parent
    CHECK(!path_is_ancestor(L"c:\\users2", L"c:\\users"));

    // --- has_self_or_ancestor_in: the Steam fix ------------------------------
    // install_locs holds "…\steam"; claiming "…\steam\steamapps" must be rejected.
    auto installs = make_set({L"c:\\program files (x86)\\steam"});
    CHECK(has_self_or_ancestor_in(installs, L"c:\\program files (x86)\\steam\\steamapps"));
    CHECK(has_self_or_ancestor_in(installs, L"c:\\program files (x86)\\steam")); // exact
    CHECK(!has_self_or_ancestor_in(installs, L"c:\\program files (x86)\\steamvr")); // sibling, not nested
    CHECK(!has_self_or_ancestor_in(installs, L"c:\\games"));

    // --- has_descendant_in: reverse-order JetBrains/Adobe fix ----------------
    // A child is already claimed; claiming the parent must be rejected.
    auto claimed = make_set({L"c:\\users\\me\\appdata\\roaming\\jetbrains\\pycharm2024.1"});
    CHECK(has_descendant_in(claimed, L"c:\\users\\me\\appdata\\roaming\\jetbrains"));
    CHECK(!has_descendant_in(claimed, L"c:\\users\\me\\appdata\\roaming\\adobe")); // unrelated
    CHECK(!has_descendant_in(claimed, L"c:\\users\\me\\appdata\\roaming\\jetbrains\\pycharm2024.1")); // exact is not a *strict* descendant

    // --- is_volume_root ------------------------------------------------------
    CHECK(is_volume_root(std::filesystem::path(L"C:\\")));
    CHECK(!is_volume_root(std::filesystem::path(L"C:\\Users")));
    CHECK(!is_volume_root(std::filesystem::path(L"C:\\Users\\Samee")));

    // --- path_key ------------------------------------------------------------
    CHECK(path_key(std::filesystem::path(L"C:\\Users\\SAMEE\\")) == L"c:\\users\\samee");

    // --- depth_budget (B1 absolute-depth arithmetic) -------------------------
    CHECK(depth_budget(12, 1) == 11);   // direct child of volume root
    CHECK(depth_budget(12, 3) == 9);    // expanded profile grandchild
    CHECK(depth_budget(12, 12) == 0);
    CHECK(depth_budget(12, 20) == 0);   // never negative

    // --- normalize_publisher / normalize_app_name ----------------------------
    CHECK(normalize_publisher(L"Microsoft Corporation") == L"Microsoft");
    CHECK(normalize_publisher(L"Discord Inc.") == L"Discord");
    CHECK(normalize_app_name(L"Microsoft Visual C++ 2022 Redistributable (x64)")
          == L"Microsoft Visual C++ 2022 Redistributable");
    CHECK(normalize_app_name(L"Discord (User)") == L"Discord");

    // --- path_starts_with (raw prefix, intentionally NOT boundary-aware) -----
    CHECK(path_starts_with(L"c:\\users\\me\\file", L"c:\\users"));
    CHECK(!path_starts_with(L"c:\\win", L"c:\\windows"));

    std::printf("\n%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}

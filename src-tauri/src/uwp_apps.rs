//! UWP / Microsoft Store app enumeration for the Storage page.
//!
//! Win32 apps in the Add/Remove Programs registry are handled by the C++
//! DLL (`get_installed_apps`); Store apps live in `C:\Program Files\
//! WindowsApps` which the DLL deliberately skips because the folder's ACLs
//! block unprivileged enumeration. Instead we read the per-user app-model
//! registry repository — it lists every package installed for the current
//! user, with the package's display name, full name, family name, and
//! install location. No admin required.
//!
//! Sizes are measured by walking:
//!   * `PackageRootFolder`             (when readable — usually only readable
//!                                      for sideloaded / dev-mode packages
//!                                      and many system apps fall back to 0)
//!   * `%LOCALAPPDATA%\Packages\{FamilyName}` (always readable — this is
//!                                      where each app keeps its writable
//!                                      LocalState / RoamingState / Caches)
//!
//! Results are tagged with `size_source = measured_total` when both walks
//! succeeded, or `measured_install` if only the install side resolved, or
//! `partial` if either walk was cut short by the shared deadline.

#![cfg(windows)]

use std::path::{Path, PathBuf};
use std::time::Instant;

use crate::ffi::InstalledAppInfo;

use windows::Win32::Foundation::ERROR_NO_MORE_ITEMS;
use windows::Win32::System::Registry::{
    RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY,
    HKEY_CURRENT_USER, KEY_READ, REG_VALUE_TYPE,
};
use windows::core::{PCWSTR, PWSTR};

/// Registry path that lists every package installed for the current user.
/// Lives under `HKCU\Software\Classes\Local Settings\...` so it doesn't
/// require admin to read. Each subkey is a *full package name* — e.g.
/// `Microsoft.WindowsCalculator_11.2402.4.0_x64__8wekyb3d8bbwe`.
const PACKAGE_REPO_SUBKEY: &str =
    r"Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages";

#[derive(Debug, Clone)]
struct UwpPackage {
    full_name: String,    // Microsoft.Foo_1.2.3.4_x64__hash
    family_name: String,  // Microsoft.Foo_hash
    display_name: String,
    publisher: String,
    install_path: String, // PackageRootFolder
    version: String,
}

/// Public entry point. Enumerates current-user UWP packages, measures their
/// install + LocalState folders within `deadline`, and returns
/// `InstalledAppInfo` rows ready to merge into the Win32 list.
///
/// Returns an empty vec on any registry error — Store apps are a bonus,
/// not a hard requirement.
pub fn enumerate_uwp_apps(deadline: Instant) -> Vec<InstalledAppInfo> {
    let packages = match read_uwp_packages() {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };

    let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let mut out = Vec::with_capacity(packages.len());

    for pkg in packages {
        if Instant::now() >= deadline { break; }

        // Skip obvious system / framework packages — they're not what the
        // user thinks of as "installed apps" and just clutter the list.
        if is_system_or_framework_package(&pkg.full_name) { continue; }
        if pkg.display_name.is_empty() { continue; }

        let mut install_bytes: u64 = 0;
        let mut data_bytes: u64 = 0;
        let mut install_partial = false;
        let mut data_partial = false;

        // Install measure — frequently fails with 0 because WindowsApps has
        // restrictive ACLs. We accept that and just report data_bytes.
        if !pkg.install_path.is_empty() {
            let (sz, hit_cap) = measure_with_deadline(Path::new(&pkg.install_path), deadline);
            install_bytes = sz;
            install_partial = hit_cap;
        }
        if Instant::now() >= deadline {
            // Time's up — push what we have with PARTIAL flag.
            out.push(build_info(&pkg, install_bytes, data_bytes, "partial"));
            continue;
        }
        if !local_app_data.is_empty() {
            let data_root: PathBuf = Path::new(&local_app_data)
                .join("Packages")
                .join(&pkg.family_name);
            if data_root.is_dir() {
                let (sz, hit_cap) = measure_with_deadline(&data_root, deadline);
                data_bytes = sz;
                data_partial = hit_cap;
            }
        }

        if install_bytes == 0 && data_bytes == 0 { continue; }

        let source = if install_partial || data_partial {
            "partial"
        } else if install_bytes > 0 && data_bytes > 0 {
            "measured_total"
        } else {
            "measured_install"
        };
        out.push(build_info(&pkg, install_bytes, data_bytes, source));
    }
    out
}

fn build_info(pkg: &UwpPackage, install_bytes: u64, data_bytes: u64, source: &str) -> InstalledAppInfo {
    InstalledAppInfo {
        name: pkg.display_name.clone(),
        publisher: pkg.publisher.clone(),
        version: pkg.version.clone(),
        install_date: String::new(),
        size_bytes: install_bytes + data_bytes,
        install_location: pkg.install_path.clone(),
        install_bytes,
        data_bytes,
        size_source: source.to_string(),
    }
}

/// Reject packages we don't want surfaced in the Installed Apps list. The
/// `Microsoft.*Framework*`, `*Runtime*`, `*VCLibs*` packages are shared
/// dependencies, not user-facing apps; the .NET / WebView / DirectX
/// runtimes are similar; and any package starting with a Microsoft inbox
/// prefix like `windows.immersivecontrolpanel` is system UI.
fn is_system_or_framework_package(full_name: &str) -> bool {
    let lower = full_name.to_lowercase();
    const PATTERNS: &[&str] = &[
        ".framework",
        ".vclibs",
        ".net.native",
        ".netnative",
        ".webview",
        ".directx",
        "microsoft.ui.xaml",
        "microsoft.services.store.engagement",
        "microsoft.advertising",
        "windows.immersivecontrolpanel",
        "windows.cbs",
        "windows.printdialog",
    ];
    PATTERNS.iter().any(|p| lower.contains(p))
}

/// Walks `root` summing file sizes. Returns `(total_bytes, hit_deadline)`.
/// Symlinks/reparse points are skipped (matches the C++ measure routine).
fn measure_with_deadline(root: &Path, deadline: Instant) -> (u64, bool) {
    if !root.is_dir() { return (0, false); }
    let mut size: u64 = 0;
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    let mut hit = false;
    while let Some(dir) = stack.pop() {
        if Instant::now() >= deadline { hit = true; break; }
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            if Instant::now() >= deadline { hit = true; break; }
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_symlink() { continue; }
            let path = entry.path();
            if ft.is_dir() {
                stack.push(path);
            } else if ft.is_file() {
                if let Ok(meta) = entry.metadata() {
                    size += meta.len();
                }
            }
        }
    }
    (size, hit)
}

// -----------------------------------------------------------------------
// Registry enumeration
// -----------------------------------------------------------------------

fn read_uwp_packages() -> Result<Vec<UwpPackage>, String> {
    let mut hive: HKEY = HKEY::default();
    let subkey_wide = wide(PACKAGE_REPO_SUBKEY);
    unsafe {
        let res = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR::from_raw(subkey_wide.as_ptr()),
            0,
            KEY_READ,
            &mut hive,
        );
        if res.is_err() {
            return Err(format!("RegOpenKeyExW failed: {res:?}"));
        }
    }

    let mut out = Vec::new();
    let mut idx: u32 = 0;
    loop {
        let mut name_buf = [0u16; 512];
        let mut name_len: u32 = name_buf.len() as u32;
        let res = unsafe {
            RegEnumKeyExW(
                hive,
                idx,
                PWSTR::from_raw(name_buf.as_mut_ptr()),
                &mut name_len,
                None,
                PWSTR::null(),
                None,
                None,
            )
        };
        if res == ERROR_NO_MORE_ITEMS { break; }
        if res.is_err() { break; }

        let full_name = String::from_utf16_lossy(&name_buf[..name_len as usize]);
        idx += 1;
        // Skip provisional / placeholder rows the OS sometimes leaves around.
        if full_name.is_empty() { continue; }

        if let Some(pkg) = read_package_key(hive, &full_name) {
            out.push(pkg);
        }
    }
    unsafe { let _ = RegCloseKey(hive); }
    Ok(out)
}

fn read_package_key(parent: HKEY, full_name: &str) -> Option<UwpPackage> {
    let mut sub: HKEY = HKEY::default();
    let name_wide = wide(full_name);
    let res = unsafe {
        RegOpenKeyExW(parent, PCWSTR::from_raw(name_wide.as_ptr()), 0, KEY_READ, &mut sub)
    };
    if res.is_err() { return None; }

    let display_name = reg_query_string(sub, "DisplayName")
        .or_else(|| reg_query_string(sub, "Name"))
        .unwrap_or_default();
    let publisher = reg_query_string(sub, "PublisherDisplayName")
        .or_else(|| reg_query_string(sub, "Publisher"))
        .unwrap_or_default();
    let install_path = reg_query_string(sub, "PackageRootFolder").unwrap_or_default();

    unsafe { let _ = RegCloseKey(sub); }

    let (family_name, version) = parse_full_name(full_name);
    Some(UwpPackage {
        full_name: full_name.to_string(),
        family_name,
        display_name,
        publisher,
        install_path,
        version,
    })
}

/// Package full name format: `Name_Version_Arch__PublisherHash` (note the
/// double underscore before the publisher hash). Family name is just
/// `Name_PublisherHash` — derived without another registry lookup.
fn parse_full_name(full: &str) -> (String, String) {
    // Split on the literal "__" separator that always precedes the publisher hash.
    // If it's absent the name is malformed (no publisher hash); fall back to the
    // bare leading `Name` segment and an empty version rather than echoing the
    // whole string back as the family.
    let Some(double) = full.find("__") else {
        let name = full.split('_').next().unwrap_or(full);
        return (name.to_string(), String::new());
    };
    let before = &full[..double];
    let after = &full[double + 2..]; // publisher hash, possibly with trailing junk
    let publisher_hash = after.split('_').next().unwrap_or("");

    // `before` is `Name_Version_Arch` — three underscore-separated parts.
    let parts: Vec<&str> = before.split('_').collect();
    let name = parts.first().copied().unwrap_or("");
    let version = parts.get(1).copied().unwrap_or("");
    let family = if publisher_hash.is_empty() {
        name.to_string()
    } else {
        format!("{name}_{publisher_hash}")
    };
    (family, version.to_string())
}

fn reg_query_string(hk: HKEY, name: &str) -> Option<String> {
    let name_wide = wide(name);
    let mut kind: REG_VALUE_TYPE = REG_VALUE_TYPE::default();
    let mut len: u32 = 0;
    let res = unsafe {
        RegQueryValueExW(
            hk,
            PCWSTR::from_raw(name_wide.as_ptr()),
            None,
            Some(&mut kind),
            None,
            Some(&mut len),
        )
    };
    if res.is_err() || len == 0 { return None; }

    // RegQueryValueExW returns bytes; reserve enough wchars to hold the
    // string plus its null terminator.
    let mut buf = vec![0u16; (len as usize / 2) + 1];
    let mut len_out = (buf.len() * 2) as u32;
    let res = unsafe {
        RegQueryValueExW(
            hk,
            PCWSTR::from_raw(name_wide.as_ptr()),
            None,
            Some(&mut kind),
            Some(buf.as_mut_ptr() as *mut u8),
            Some(&mut len_out),
        )
    };
    if res.is_err() { return None; }

    let wchars = (len_out as usize) / 2;
    let mut s = String::from_utf16_lossy(&buf[..wchars]);
    while s.ends_with('\0') { s.pop(); }
    if s.is_empty() { None } else { Some(s) }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_full_name_extracts_family_and_version() {
        let (family, version) = parse_full_name(
            "Microsoft.WindowsCalculator_11.2402.4.0_x64__8wekyb3d8bbwe",
        );
        assert_eq!(family, "Microsoft.WindowsCalculator_8wekyb3d8bbwe");
        assert_eq!(version, "11.2402.4.0");
    }

    #[test]
    fn parse_full_name_handles_missing_publisher() {
        let (family, version) = parse_full_name("Foo_1.0.0_neutral");
        assert_eq!(family, "Foo");
        assert_eq!(version, "");
    }

    #[test]
    fn system_packages_are_filtered() {
        assert!(is_system_or_framework_package(
            "Microsoft.VCLibs.140.00_14.0.30704.0_x64__8wekyb3d8bbwe"
        ));
        assert!(is_system_or_framework_package(
            "Microsoft.NET.Native.Framework.2.2_2.2.29512.0_x64__8wekyb3d8bbwe"
        ));
        assert!(!is_system_or_framework_package(
            "Microsoft.WindowsCalculator_11.2402.4.0_x64__8wekyb3d8bbwe"
        ));
    }
}

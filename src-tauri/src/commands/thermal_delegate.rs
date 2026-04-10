//! Detect OEM thermal / fan control apps (G-Helper, Vantage, etc.) from WMI + common install paths.

use serde::Deserialize;
use serde::Serialize;
use std::path::PathBuf;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ThermalDelegateInfo {
    pub manufacturer: String,
    pub model: String,
    pub is_likely_laptop: bool,
    /// Short name shown in UI, e.g. "G-Helper"
    pub suggested_app_name: String,
    pub detail_line: String,
    pub button_label: String,
    /// True if an executable was found on disk for this suggestion
    pub has_installed_app: bool,
}

#[derive(Debug, Deserialize)]
struct WmiBrief {
    #[serde(rename = "M")]
    manufacturer: Option<String>,
    #[serde(rename = "Model")]
    model: Option<String>,
    #[serde(rename = "C")]
    chassis: Option<serde_json::Value>,
}

#[derive(Clone, Debug)]
struct ResolvedTarget {
    info: ThermalDelegateInfo,
    exe: Option<PathBuf>,
    https_fallback: Option<&'static str>,
    settings_uri: &'static str,
}

fn norm(s: &str) -> String {
    s.trim().to_lowercase()
}

fn chassis_vec(v: &serde_json::Value) -> Vec<u32> {
    match v {
        serde_json::Value::Array(a) => a
            .iter()
            .filter_map(|x| x.as_u64().map(|u| u as u32))
            .collect(),
        serde_json::Value::Number(n) => n.as_u64().map(|u| vec![u as u32]).unwrap_or_default(),
        _ => vec![],
    }
}

/// SMBIOS chassis types; 9/10/14 are common for laptops. 3–7 often desktops / towers.
fn is_likely_laptop_chassis(types: &[u32]) -> bool {
    if types.is_empty() {
        return true;
    }
    if types.iter().any(|t| matches!(t, 9 | 10 | 14)) {
        return true;
    }
    if types.iter().any(|t| matches!(t, 3 | 4 | 5 | 6 | 7 | 15 | 16)) {
        return false;
    }
    true
}

#[cfg(windows)]
fn read_wmi() -> WmiBrief {
    let script = r#"try {
  $cs = Get-CimInstance -ClassName Win32_ComputerSystem
  $en = Get-CimInstance -ClassName Win32_SystemEnclosure
  @{ M = [string]$cs.Manufacturer; Model = [string]$cs.Model; C = @([int[]]@($en.ChassisTypes)) } | ConvertTo-Json -Compress
} catch {
  '{}'
}"#;

    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    let Ok(out) = output else {
        return WmiBrief {
            manufacturer: None,
            model: None,
            chassis: None,
        };
    };

    let text = String::from_utf8_lossy(&out.stdout);
    let trimmed = text.trim().trim_start_matches('\u{feff}');
    serde_json::from_str::<WmiBrief>(trimmed).unwrap_or(WmiBrief {
        manufacturer: None,
        model: None,
        chassis: None,
    })
}

#[cfg(not(windows))]
fn read_wmi() -> WmiBrief {
    WmiBrief {
        manufacturer: None,
        model: None,
        chassis: None,
    }
}

fn first_existing(paths: &[PathBuf]) -> Option<PathBuf> {
    paths.iter().find(|p| p.is_file()).cloned()
}

/// Common locations + Scoop/Chocolatey-style paths (G-Helper is often portable).
#[cfg(windows)]
fn push_ghelper_dir(v: &mut Vec<PathBuf>, dir: PathBuf) {
    v.push(dir.join("GHelper.exe"));
    v.push(dir.join("G-Helper.exe"));
}

/// Common locations + Scoop/Chocolatey-style paths (G-Helper is often portable).
#[cfg(windows)]
fn ghelper_static_paths() -> Vec<PathBuf> {
    let mut v = Vec::new();

    if let Ok(user) = std::env::var("USERPROFILE") {
        let u = PathBuf::from(&user);
        push_ghelper_dir(&mut v, u.join("GHelper"));
        v.push(u.join("GHelper.exe"));
        v.push(u.join("G-Helper.exe"));
        push_ghelper_dir(&mut v, u.join("Downloads").join("GHelper"));
        v.push(u.join("Downloads").join("GHelper.exe"));
        v.push(u.join("Downloads").join("G-Helper.exe"));
        push_ghelper_dir(&mut v, u.join("Desktop").join("GHelper"));
        push_ghelper_dir(&mut v, u.join("Documents").join("GHelper"));
        push_ghelper_dir(
            &mut v,
            u.join("OneDrive").join("Desktop").join("GHelper"),
        );
        push_ghelper_dir(
            &mut v,
            u.join("scoop").join("apps").join("g-helper").join("current"),
        );
        push_ghelper_dir(
            &mut v,
            u.join("scoop").join("apps").join("GHelper").join("current"),
        );
        v.push(u.join("scoop").join("shims").join("GHelper.exe"));
        v.push(u.join("scoop").join("shims").join("ghelper.exe"));
    }

    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let l = PathBuf::from(&local);
        push_ghelper_dir(&mut v, l.join("GHelper"));
        push_ghelper_dir(&mut v, l.join("Programs").join("GHelper"));
        push_ghelper_dir(&mut v, l.join("Programs").join("g-helper"));
    }

    if let Ok(ad) = std::env::var("APPDATA") {
        push_ghelper_dir(&mut v, PathBuf::from(ad).join("GHelper"));
    }

    if let Ok(pf) = std::env::var("PROGRAMFILES") {
        let p = PathBuf::from(&pf);
        push_ghelper_dir(&mut v, p.join("GHelper"));
        push_ghelper_dir(&mut v, p.join("G-Helper"));
    }

    if let Ok(pfx86) = std::env::var("PROGRAMFILES(X86)")
        .or_else(|_| std::env::var("ProgramFiles(x86)"))
    {
        let p = PathBuf::from(&pfx86);
        push_ghelper_dir(&mut v, p.join("GHelper"));
    }

    if let Ok(pd) = std::env::var("ProgramData") {
        let p = PathBuf::from(&pd);
        v.push(p.join("chocolatey").join("bin").join("ghelper.exe"));
        push_ghelper_dir(
            &mut v,
            p.join("chocolatey").join("lib").join("g-helper").join("tools"),
        );
        push_ghelper_dir(
            &mut v,
            p.join("chocolatey").join("lib").join("ghelper").join("tools"),
        );
    }

    v
}

#[cfg(windows)]
fn find_executable_on_path(file_name: &str) -> Option<PathBuf> {
    let sysroot = std::env::var("SystemRoot").ok()?;
    let where_exe = PathBuf::from(sysroot).join("System32").join("where.exe");
    let output = std::process::Command::new(&where_exe)
        .args([file_name])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        let p = PathBuf::from(t);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// Registry (Uninstall / DisplayIcon) + shallow search under Downloads and Desktop.
#[cfg(windows)]
fn find_ghelper_via_powershell() -> Option<PathBuf> {
    let script = r#"$ErrorActionPreference = 'SilentlyContinue'
function Hit($p) {
  if ($p -and (Test-Path -LiteralPath $p)) { Write-Output $p; exit 0 }
}
$unroots = @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'
)
foreach ($ur in $unroots) {
  $keys = Get-ChildItem -LiteralPath $ur -ErrorAction SilentlyContinue
  foreach ($key in $keys) {
    $p = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
    if ($null -eq $p) { continue }
    $dn = [string]$p.DisplayName
    if ($dn -notmatch 'G-Helper|GHelper') { continue }
    if ($p.InstallLocation) {
      Hit (Join-Path $p.InstallLocation 'GHelper.exe')
      Hit (Join-Path $p.InstallLocation 'G-Helper.exe')
    }
    $us = [string]$p.UninstallString
    if ($us -match '"([^"]+\.exe)"') { Hit $matches[1] }
    elseif ($us -match '([A-Za-z]:\\[^\s]+\.exe)') { Hit $matches[1] }
    $di = [string]$p.DisplayIcon
    if ($di -match '^"?([^"]+\.exe)') { Hit ($matches[1].Trim()) }
  }
}
foreach ($root in @("$env:USERPROFILE\Downloads", "$env:USERPROFILE\Desktop")) {
  if (-not (Test-Path -LiteralPath $root)) { continue }
  foreach ($pat in @('GHelper.exe','G-Helper.exe')) {
    $hit = Get-ChildItem -LiteralPath $root -Filter $pat -File -Recurse -Depth 6 -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { Write-Output $hit.FullName; exit 0 }
  }
}
$wg = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
if (Test-Path -LiteralPath $wg) {
  foreach ($pat in @('GHelper.exe','G-Helper.exe')) {
    $hit = Get-ChildItem -LiteralPath $wg -Filter $pat -File -Recurse -Depth 10 -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { Write-Output $hit.FullName; exit 0 }
  }
}
"#;

    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    let line = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if line.is_empty() {
        return None;
    }
    let p = PathBuf::from(line.lines().next().unwrap_or("").trim());
    p.is_file().then_some(p)
}

#[cfg(windows)]
fn resolve_ghelper_executable() -> Option<PathBuf> {
    if let Some(p) = first_existing(&ghelper_static_paths()) {
        return Some(p);
    }
    if let Some(p) = find_executable_on_path("GHelper.exe") {
        return Some(p);
    }
    if let Some(p) = find_executable_on_path("G-Helper.exe") {
        return Some(p);
    }
    find_executable_on_path("ghelper.exe").or_else(find_ghelper_via_powershell)
}

#[cfg(not(windows))]
fn resolve_ghelper_executable() -> Option<PathBuf> {
    None
}

#[cfg(windows)]
fn thermal_candidate_paths() -> Vec<PathBuf> {
    let mut v = ghelper_static_paths();

    let pf = std::env::var("PROGRAMFILES").ok().map(PathBuf::from);
    let pfx86 = std::env::var("PROGRAMFILES(X86)")
        .ok()
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var("ProgramFiles(x86)")
                .ok()
                .map(PathBuf::from)
        });

    if let Some(ref p) = pf {
        v.push(
            p.join("ASUS")
                .join("Armoury Crate SE")
                .join("Armoury Crate.exe"),
        );
        v.push(p.join("ASUS").join("Armoury Crate").join("Armoury Crate.exe"));
        v.push(
            p.join("Alienware")
                .join("Alienware Command Center")
                .join("Alienware Command Center.exe"),
        );
        v.push(
            p.join("Dell")
                .join("Alienware Command Center")
                .join("Alienware Command Center.exe"),
        );
        v.push(p.join("HP").join("OMEN Command Center").join("OmenCommandCenter.exe"));
        v.push(
            p.join("Razer")
                .join("Razer Synapse 3")
                .join("Razer Synapse 3.exe"),
        );
        v.push(
            p.join("Lenovo")
                .join("Lenovo Vantage")
                .join("LenovoVantage.exe"),
        );
        v.push(p.join("MSI").join("MSI Center").join("MSI Center.exe"));
    }
    if let Some(ref p) = pfx86 {
        v.push(
            p.join("Lenovo")
                .join("Lenovo Vantage")
                .join("LenovoVantage.exe"),
        );
        v.push(p.join("MSI").join("MSI Center").join("MSI Center.exe"));
    }

    v
}

#[cfg(not(windows))]
fn thermal_candidate_paths() -> Vec<PathBuf> {
    vec![]
}

fn resolve_for_vendor(manufacturer: &str, model: &str, laptop: bool) -> ResolvedTarget {
    let m = norm(manufacturer);
    let paths = thermal_candidate_paths();

    let generic = || {
        let detail = if laptop {
            "Fan curves and performance modes are controlled by your PC manufacturer or Windows power options."
                .to_string()
        } else {
            "Adjust sleep, power plans, and related options in Windows settings.".to_string()
        };
        ResolvedTarget {
            info: ThermalDelegateInfo {
                manufacturer: manufacturer.to_string(),
                model: model.to_string(),
                is_likely_laptop: laptop,
                suggested_app_name: "Windows".to_string(),
                detail_line: detail,
                button_label: "Open Power & battery".to_string(),
                has_installed_app: false,
            },
            exe: None,
            https_fallback: None,
            settings_uri: "ms-settings:powersleep",
        }
    };

    // ASUS / ROG — prefer G-Helper, then Armoury Crate if present
    if m.contains("asus") || m.contains("asustek") {
        let armoury_paths: Vec<PathBuf> = paths
            .iter()
            .filter(|p| p.to_string_lossy().to_lowercase().contains("armoury"))
            .cloned()
            .collect();

        if let Some(exe) = resolve_ghelper_executable() {
            return ResolvedTarget {
                info: ThermalDelegateInfo {
                    manufacturer: manufacturer.to_string(),
                    model: model.to_string(),
                    is_likely_laptop: laptop,
                    suggested_app_name: "G-Helper".to_string(),
                    detail_line:
                        "G-Helper is installed — use it to apply Silent / Performance / Turbo and fan behavior on ASUS laptops."
                            .to_string(),
                    button_label: "Open G-Helper".to_string(),
                    has_installed_app: true,
                },
                exe: Some(exe),
                https_fallback: Some("https://github.com/seerge/g-helper/releases"),
                settings_uri: "ms-settings:powersleep",
            };
        }

        if let Some(exe) = first_existing(&armoury_paths) {
            return ResolvedTarget {
                info: ThermalDelegateInfo {
                    manufacturer: manufacturer.to_string(),
                    model: model.to_string(),
                    is_likely_laptop: laptop,
                    suggested_app_name: "Armoury Crate".to_string(),
                    detail_line:
                        "Armoury Crate is installed — use it for ASUS performance and fan modes on supported models."
                            .to_string(),
                    button_label: "Open Armoury Crate".to_string(),
                    has_installed_app: true,
                },
                exe: Some(exe),
                https_fallback: None,
                settings_uri: "ms-settings:powersleep",
            };
        }

        return ResolvedTarget {
            info: ThermalDelegateInfo {
                manufacturer: manufacturer.to_string(),
                model: model.to_string(),
                is_likely_laptop: laptop,
                suggested_app_name: "G-Helper".to_string(),
                detail_line:
                    "For ASUS and ROG laptops, G-Helper can control performance modes and fans. It was not found (PATH, common folders, Downloads/Desktop, or uninstall registry)."
                        .to_string(),
                button_label: "Get G-Helper".to_string(),
                has_installed_app: false,
            },
            exe: None,
            https_fallback: Some("https://github.com/seerge/g-helper/releases"),
            settings_uri: "ms-settings:powersleep",
        };
    }

    // Lenovo
    if m.contains("lenovo") {
        let candidates: Vec<PathBuf> = paths
            .iter()
            .filter(|p| {
                p.to_string_lossy()
                    .to_lowercase()
                    .contains("lenovo vantage")
            })
            .cloned()
            .collect();
        let exe = first_existing(&candidates);
        let has = exe.is_some();
        return ResolvedTarget {
            info: ThermalDelegateInfo {
                manufacturer: manufacturer.to_string(),
                model: model.to_string(),
                is_likely_laptop: laptop,
                suggested_app_name: "Lenovo Vantage".to_string(),
                detail_line: if has {
                    "Open Lenovo Vantage to change thermal mode and fan behavior where your model supports it."
                        .to_string()
                } else {
                    "Lenovo Vantage was not found. Install it from the Microsoft Store to access thermal modes on many Lenovo laptops."
                        .to_string()
                },
                button_label: if has {
                    "Open Lenovo Vantage".to_string()
                } else {
                    "Open Store — Lenovo Vantage".to_string()
                },
                has_installed_app: has,
            },
            exe,
            https_fallback: Some("https://apps.microsoft.com/detail/9wzdncrfj4mv"),
            settings_uri: "ms-settings:powersleep",
        };
    }

    // Dell / Alienware
    if m.contains("dell") {
        let candidates: Vec<PathBuf> = paths
            .iter()
            .filter(|p| {
                let s = p.to_string_lossy().to_lowercase();
                s.contains("alienware command center")
            })
            .cloned()
            .collect();
        let exe = first_existing(&candidates);
        let has = exe.is_some();
        return ResolvedTarget {
            info: ThermalDelegateInfo {
                manufacturer: manufacturer.to_string(),
                model: model.to_string(),
                is_likely_laptop: laptop,
                suggested_app_name: if has {
                    "Alienware Command Center".to_string()
                } else {
                    "Dell power & support".to_string()
                },
                detail_line: if has {
                    "Use Alienware Command Center for power and thermal profiles on supported Dell / Alienware systems."
                        .to_string()
                } else {
                    "Dell thermal controls vary by model (Alienware Command Center, SupportAssist, or BIOS). None were detected in standard paths."
                        .to_string()
                },
                button_label: if has {
                    "Open Alienware CC".to_string()
                } else {
                    "Dell support (thermal help)".to_string()
                },
                has_installed_app: has,
            },
            exe,
            https_fallback: Some("https://www.dell.com/support/manuals"),
            settings_uri: "ms-settings:powersleep",
        };
    }

    // HP
    if m.contains("hp") || m.contains("hewlett") {
        let candidates: Vec<PathBuf> = paths
            .iter()
            .filter(|p| {
                p.to_string_lossy()
                    .to_lowercase()
                    .contains("omencommandcenter")
            })
            .cloned()
            .collect();
        let exe = first_existing(&candidates);
        let has = exe.is_some();
        return ResolvedTarget {
            info: ThermalDelegateInfo {
                manufacturer: manufacturer.to_string(),
                model: model.to_string(),
                is_likely_laptop: laptop,
                suggested_app_name: if has {
                    "OMEN Command Center".to_string()
                } else {
                    "HP support".to_string()
                },
                detail_line: if has {
                    "Use OMEN Command Center for performance and cooling options on supported HP systems."
                        .to_string()
                } else {
                    "HP OMEN / Gaming Hub was not found in the default path. Check the Microsoft Store or HP Support for your model."
                        .to_string()
                },
                button_label: if has {
                    "Open OMEN Command Center".to_string()
                } else {
                    "HP support".to_string()
                },
                has_installed_app: has,
            },
            exe,
            https_fallback: Some("https://support.hp.com"),
            settings_uri: "ms-settings:powersleep",
        };
    }

    // MSI
    if m.contains("msi") || model.to_lowercase().contains("msi") {
        let candidates: Vec<PathBuf> = paths
            .iter()
            .filter(|p| p.to_string_lossy().to_lowercase().contains("msi center"))
            .cloned()
            .collect();
        let exe = first_existing(&candidates);
        let has = exe.is_some();
        return ResolvedTarget {
            info: ThermalDelegateInfo {
                manufacturer: manufacturer.to_string(),
                model: model.to_string(),
                is_likely_laptop: laptop,
                suggested_app_name: "MSI Center".to_string(),
                detail_line: if has {
                    "Open MSI Center to adjust user scenario / cooler boost where available.".to_string()
                } else {
                    "MSI Center was not found. Install it from MSI for fan and performance options on many MSI laptops."
                        .to_string()
                },
                button_label: if has {
                    "Open MSI Center".to_string()
                } else {
                    "MSI Center download".to_string()
                },
                has_installed_app: has,
            },
            exe,
            https_fallback: Some("https://www.msi.com/Landing/MSI-Center"),
            settings_uri: "ms-settings:powersleep",
        };
    }

    // Razer
    if m.contains("razer") {
        let candidates: Vec<PathBuf> = paths
            .iter()
            .filter(|p| {
                p.to_string_lossy()
                    .to_lowercase()
                    .contains("razer synapse")
            })
            .cloned()
            .collect();
        let exe = first_existing(&candidates);
        let has = exe.is_some();
        return ResolvedTarget {
            info: ThermalDelegateInfo {
                manufacturer: manufacturer.to_string(),
                model: model.to_string(),
                is_likely_laptop: laptop,
                suggested_app_name: "Razer Synapse".to_string(),
                detail_line: if has {
                    "Use Razer Synapse for performance and fan modes on supported Razer laptops.".to_string()
                } else {
                    "Razer Synapse was not found. Install it from Razer for thermal and performance controls on Blade laptops."
                        .to_string()
                },
                button_label: if has {
                    "Open Razer Synapse".to_string()
                } else {
                    "Razer Synapse".to_string()
                },
                has_installed_app: has,
            },
            exe,
            https_fallback: Some("https://www.razer.com/synapse-3"),
            settings_uri: "ms-settings:powersleep",
        };
    }

    // Unknown OEM: scan for common thermal tools we know paths for
    let known: Vec<PathBuf> = paths
        .iter()
        .filter(|p| {
            let s = p.to_string_lossy().to_lowercase();
            s.contains("ghelper")
                || s.contains("armoury")
                || s.contains("lenovovantage")
                || s.contains("omencommandcenter")
                || s.contains("msi center")
                || s.contains("razer synapse")
                || s.contains("alienware command center")
        })
        .cloned()
        .collect();
    let any = resolve_ghelper_executable().or_else(|| first_existing(&known));
    if let Some(ref p) = any {
        let name = p
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("OEM tool");
        let label = if name.eq_ignore_ascii_case("GHelper") {
            "G-Helper"
        } else {
            name
        };
        return ResolvedTarget {
            info: ThermalDelegateInfo {
                manufacturer: manufacturer.to_string(),
                model: model.to_string(),
                is_likely_laptop: laptop,
                suggested_app_name: label.to_string(),
                detail_line: format!(
                    "Found {} — use it for fan and performance options if your hardware supports them.",
                    label
                ),
                button_label: format!("Open {}", label),
                has_installed_app: true,
            },
            exe: any.clone(),
            https_fallback: None,
            settings_uri: "ms-settings:powersleep",
        };
    }

    generic()
}

fn resolve_internal() -> ResolvedTarget {
    let wmi = read_wmi();
    let manufacturer = wmi
        .manufacturer
        .unwrap_or_else(|| "Unknown".to_string());
    let model = wmi.model.unwrap_or_else(|| "Unknown".to_string());
    let chassis = wmi.chassis.as_ref().map(chassis_vec).unwrap_or_default();
    let laptop = is_likely_laptop_chassis(&chassis);

    resolve_for_vendor(&manufacturer, &model, laptop)
}

#[tauri::command]
pub fn get_thermal_delegate_info() -> Result<ThermalDelegateInfo, String> {
    Ok(resolve_internal().info)
}

#[tauri::command]
pub fn launch_thermal_delegate() -> Result<(), String> {
    #[cfg(not(windows))]
    {
        return Err("Thermal delegate is only supported on Windows.".to_string());
    }

    #[cfg(windows)]
    {
        let r = resolve_internal();
        if let Some(exe) = r.exe {
            if exe.is_file() {
                return super::thermal_delegate_win::launch_exe_singleton_aware(&exe);
            }
        }
        if let Some(url) = r.https_fallback {
            std::process::Command::new("cmd")
                .args(["/C", "start", "", url])
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .map_err(|e| format!("Failed to open link: {e}"))?;
            return Ok(());
        }
        open_settings_uri(r.settings_uri)
    }
}

#[cfg(windows)]
fn open_settings_uri(uri: &str) -> Result<(), String> {
    std::process::Command::new("cmd")
        .args(["/C", "start", "", uri])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("Failed to open settings: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn laptop_chassis() {
        assert!(is_likely_laptop_chassis(&[10]));
        assert!(!is_likely_laptop_chassis(&[3]));
        assert!(is_likely_laptop_chassis(&[]));
    }
}

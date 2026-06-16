//! Update-helper backend (Phase 1). Read-only firmware/system identity for the
//! "System & driver health" card. The driver list it pairs with comes from
//! `crash::get_device_drivers` (shared). The Windows Update *scan* (a WUA COM
//! call) is Phase 2; P1 only surfaces versions/dates so the card can flag
//! staleness and link out to Windows Update / the OEM.

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct BiosInfo {
    pub version: String,
    /// BIOS release date, epoch ms (UTC), when known.
    pub date_ms: Option<i64>,
    pub manufacturer: String,
    pub model: String,
}

#[tauri::command]
pub async fn get_bios_info() -> Result<BiosInfo, String> {
    #[cfg(not(windows))]
    {
        return Ok(BiosInfo::default());
    }

    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(query_bios_info)
            .await
            .map_err(|e| format!("join error: {e}"))?
    }
}

#[cfg(windows)]
fn query_bios_info() -> Result<BiosInfo, String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let script = r#"
$ErrorActionPreference = 'SilentlyContinue'
$b = Get-CimInstance Win32_BIOS
$c = Get-CimInstance Win32_ComputerSystem
[PSCustomObject]@{
  Version      = [string]$b.SMBIOSBIOSVersion
  Date         = if ($b.ReleaseDate) { $b.ReleaseDate.ToUniversalTime().ToString('o') } else { $null }
  Manufacturer = [string]$c.Manufacturer
  Model        = [string]$c.Model
} | ConvertTo-Json -Compress
"#;

    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Failed to run PowerShell: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(parse_bios(&text))
}

fn parse_bios(json: &str) -> BiosInfo {
    let value: serde_json::Value = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(_) => return BiosInfo::default(),
    };
    let s = |k: &str| {
        value
            .get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string()
    };
    BiosInfo {
        version: s("Version"),
        date_ms: value
            .get("Date")
            .and_then(|v| v.as_str())
            .and_then(parse_rfc3339_ms),
        manufacturer: s("Manufacturer"),
        model: s("Model"),
    }
}

fn parse_rfc3339_ms(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

// ===========================================================================
// Phase 2 — Windows Update scan. Read-only: counts pending updates via the
// Windows Update Agent COM API (no install, ever). Surfaces the "updates
// available" card when the user is behind. Can be slow (seconds, hits MS
// servers), so it runs on the blocking pool and the frontend caches + polls
// it on a slow cadence.
// ===========================================================================

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct WindowsUpdateStatus {
    /// False when the scan couldn't run (WU service down, offline, policy).
    pub ok: bool,
    pub driver_updates: u32,
    pub other_updates: u32,
}

#[tauri::command]
pub async fn get_windows_update_status() -> Result<WindowsUpdateStatus, String> {
    #[cfg(not(windows))]
    {
        return Ok(WindowsUpdateStatus::default());
    }

    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(query_windows_update_status)
            .await
            .map_err(|e| format!("join error: {e}"))?
    }
}

#[cfg(windows)]
fn query_windows_update_status() -> Result<WindowsUpdateStatus, String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    // Pure scan via WUA COM. UpdateType: 1 = Software, 2 = Driver. The try/catch
    // means a broken WU service yields Ok=$false rather than a crash.
    let script = r#"
try {
  $session = New-Object -ComObject Microsoft.Update.Session
  $searcher = $session.CreateUpdateSearcher()
  $result = $searcher.Search("IsInstalled=0 and IsHidden=0")
  $drivers = 0; $other = 0
  foreach ($u in $result.Updates) {
    if ($u.Type -eq 2) { $drivers++ } else { $other++ }
  }
  [PSCustomObject]@{ Ok = $true; DriverUpdates = $drivers; OtherUpdates = $other } | ConvertTo-Json -Compress
} catch {
  [PSCustomObject]@{ Ok = $false; DriverUpdates = 0; OtherUpdates = 0 } | ConvertTo-Json -Compress
}
"#;

    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Failed to run PowerShell: {e}"))?;
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(parse_wu_status(&text))
}

fn parse_wu_status(json: &str) -> WindowsUpdateStatus {
    let value: serde_json::Value = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(_) => return WindowsUpdateStatus::default(),
    };
    let u = |k: &str| value.get(k).and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    WindowsUpdateStatus {
        ok: value.get("Ok").and_then(|v| v.as_bool()).unwrap_or(false),
        driver_updates: u("DriverUpdates"),
        other_updates: u("OtherUpdates"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bios_json() {
        let json = r#"{"Version":"316","Date":"2026-03-05T00:00:00Z","Manufacturer":"ASUSTeK COMPUTER INC.","Model":"Vivobook ASUS Laptop M5406WA"}"#;
        let b = parse_bios(json);
        assert_eq!(b.version, "316");
        assert!(b.date_ms.is_some());
        assert!(b.manufacturer.contains("ASUS"));
        assert!(b.model.contains("M5406WA"));
    }

    #[test]
    fn bad_json_is_default() {
        assert_eq!(parse_bios("nonsense"), BiosInfo::default());
        assert_eq!(parse_bios(""), BiosInfo::default());
    }

    #[test]
    fn parses_wu_status() {
        let json = r#"{"Ok":true,"DriverUpdates":2,"OtherUpdates":3}"#;
        let s = parse_wu_status(json);
        assert!(s.ok);
        assert_eq!(s.driver_updates, 2);
        assert_eq!(s.other_updates, 3);
    }

    #[test]
    fn wu_failure_is_not_ok() {
        let s = parse_wu_status(r#"{"Ok":false,"DriverUpdates":0,"OtherUpdates":0}"#);
        assert!(!s.ok);
        // Garbage also yields a not-ok default.
        assert!(!parse_wu_status("boom").ok);
    }
}

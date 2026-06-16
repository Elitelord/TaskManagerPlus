//! Unexpected-shutdown / crash detection (Phase 1).
//!
//! Windows records every dirty shutdown to the **System** event log on the
//! next boot. We read three event IDs and collapse them into "incidents":
//!
//!   * **6008** (EventLog)     — "the previous shutdown was unexpected".
//!   * **41**   (Kernel-Power) — rebooted without a clean shutdown; its
//!                               `BugcheckCode` data field is non-zero on a
//!                               bugcheck (BSOD), zero on a hard power loss.
//!   * **1001** (BugCheck)     — an actual BSOD; the stop code is in the
//!                               message text (`0x000000xx`).
//!
//! A single BSOD typically logs all three within a few seconds, so the raw
//! events are deduped by time-proximity into one incident, keeping the most
//! specific classification.
//!
//! Read-only and unprivileged: the System log is readable by the built-in
//! Users group, so no elevation is needed. The data never leaves the device.

use serde::Serialize;

/// One detected shutdown incident, surfaced to the frontend.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShutdownEvent {
    /// Unix epoch milliseconds (UTC) of the incident.
    pub timestamp_ms: i64,
    /// "bsod" | "power_loss" | "unexpected_shutdown".
    pub kind: String,
    /// BSOD stop code (e.g. "0x0000007E") when known.
    pub bugcheck_code: Option<String>,
    /// Short human-readable cause line.
    pub detail: String,
}

#[tauri::command]
pub async fn get_unexpected_shutdowns(
    since_days: Option<u32>,
) -> Result<Vec<ShutdownEvent>, String> {
    let days = since_days.unwrap_or(30).clamp(1, 365);

    #[cfg(not(windows))]
    {
        let _ = days;
        return Ok(Vec::new());
    }

    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || query_event_log(days))
            .await
            .map_err(|e| format!("join error: {e}"))?
    }
}

#[cfg(windows)]
fn query_event_log(days: u32) -> Result<Vec<ShutdownEvent>, String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    // `-ErrorAction SilentlyContinue` is essential: Get-WinEvent *throws* a
    // terminating error ("No events were found...") when the filter matches
    // nothing, which is the common, healthy case.
    let script = format!(
        r#"
$ErrorActionPreference = 'SilentlyContinue'
$start = (Get-Date).AddDays(-{days})
$ev = Get-WinEvent -FilterHashtable @{{ LogName='System'; Id=41,6008,1001; StartTime=$start }} -MaxEvents 200
$out = foreach ($e in $ev) {{
  $code = $null
  try {{
    $x = [xml]$e.ToXml()
    $code = ($x.Event.EventData.Data | Where-Object {{ $_.Name -eq 'BugcheckCode' }} | Select-Object -First 1).'#text'
  }} catch {{}}
  [PSCustomObject]@{{
    Id   = $e.Id
    Time = $e.TimeCreated.ToUniversalTime().ToString('o')
    Bugcheck = $code
    Msg  = [string]$e.Message
  }}
}}
$out | ConvertTo-Json -Compress
"#
    );

    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Failed to run PowerShell: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(process_events(&text))
}

/// Parse the Get-WinEvent JSON and collapse it into deduped incidents. Pure
/// (no Windows API) so it's unit-testable on any platform.
fn process_events(json: &str) -> Vec<ShutdownEvent> {
    if json.is_empty() {
        return Vec::new();
    }
    let value: serde_json::Value = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    // ConvertTo-Json emits a bare object (not an array) for a single event.
    let rows = match value {
        serde_json::Value::Array(a) => a,
        serde_json::Value::Object(_) => vec![value],
        _ => return Vec::new(),
    };

    let mut classified: Vec<RawIncident> =
        rows.iter().filter_map(classify_row).collect();
    // Newest first.
    classified.sort_by(|a, b| b.timestamp_ms.cmp(&a.timestamp_ms));
    build_incidents(classified)
}

/// Intermediate per-event classification before time-dedup.
#[derive(Debug, Clone)]
struct RawIncident {
    timestamp_ms: i64,
    kind: &'static str,
    code: Option<String>,
}

fn classify_row(row: &serde_json::Value) -> Option<RawIncident> {
    let id = row.get("Id").and_then(|v| v.as_i64())?;
    let time = row.get("Time").and_then(|v| v.as_str())?;
    let timestamp_ms = parse_rfc3339_ms(time)?;
    let msg = row.get("Msg").and_then(|v| v.as_str()).unwrap_or("");
    // Kernel-Power BugcheckCode is a decimal string ("0", "126", ...).
    let bugcheck_decimal = row
        .get("Bugcheck")
        .and_then(|v| match v {
            serde_json::Value::String(s) => s.trim().parse::<u64>().ok(),
            serde_json::Value::Number(n) => n.as_u64(),
            _ => None,
        });

    let (kind, code) = match id {
        1001 => ("bsod", extract_stop_code(msg)),
        41 => match bugcheck_decimal {
            Some(c) if c != 0 => ("bsod", Some(format!("0x{c:08X}"))),
            _ => ("power_loss", None),
        },
        6008 => ("unexpected_shutdown", None),
        _ => return None,
    };

    Some(RawIncident {
        timestamp_ms,
        kind,
        code,
    })
}

/// Collapse events within `DEDUP_WINDOW_MS` of each other into a single
/// incident, keeping the most specific classification and any stop code.
/// `rows` must be sorted newest-first.
fn build_incidents(rows: Vec<RawIncident>) -> Vec<ShutdownEvent> {
    const DEDUP_WINDOW_MS: i64 = 5 * 60 * 1000;
    let mut incidents: Vec<RawIncident> = Vec::new();

    for row in rows {
        // Belongs to an existing incident if it's within the window of one.
        let merged = incidents.iter_mut().find(|inc| {
            (inc.timestamp_ms - row.timestamp_ms).abs() <= DEDUP_WINDOW_MS
        });
        match merged {
            Some(inc) => {
                if kind_rank(row.kind) > kind_rank(inc.kind) {
                    inc.kind = row.kind;
                }
                if inc.code.is_none() {
                    if let Some(c) = row.code {
                        inc.code = Some(c);
                    }
                }
            }
            None => incidents.push(row),
        }
    }

    incidents
        .into_iter()
        .map(|inc| ShutdownEvent {
            detail: detail_for(inc.kind, inc.code.as_deref()),
            timestamp_ms: inc.timestamp_ms,
            kind: inc.kind.to_string(),
            bugcheck_code: inc.code,
        })
        .collect()
}

fn kind_rank(kind: &str) -> u8 {
    match kind {
        "bsod" => 3,
        "power_loss" => 2,
        _ => 1,
    }
}

fn detail_for(kind: &str, code: Option<&str>) -> String {
    match kind {
        "bsod" => match code {
            Some(c) => format!("Blue-screen crash (stop code {c})"),
            None => "Blue-screen crash".to_string(),
        },
        "power_loss" => "Lost power or was forced off (no crash dump)".to_string(),
        _ => "Shut down unexpectedly".to_string(),
    }
}

/// Pull the first `0x........` stop code out of a BugCheck message.
fn extract_stop_code(msg: &str) -> Option<String> {
    let bytes = msg.as_bytes();
    let mut i = 0;
    while i + 2 <= bytes.len() {
        if bytes[i] == b'0' && (bytes[i + 1] == b'x' || bytes[i + 1] == b'X') {
            let start = i;
            let mut j = i + 2;
            while j < bytes.len() && (bytes[j] as char).is_ascii_hexdigit() {
                j += 1;
            }
            if j - (start + 2) >= 4 {
                let hex = &msg[start + 2..j];
                return Some(format!("0x{}", hex.to_uppercase()));
            }
        }
        i += 1;
    }
    None
}

/// Parse an RFC3339 timestamp (PowerShell's round-trip 'o' format, UTC) to
/// epoch milliseconds.
fn parse_rfc3339_ms(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

// ===========================================================================
// C — implicated-driver lookup. The crash card maps a stop code to a
// subsystem (gpu / wifi / storage / ...) and shows the matching device + its
// driver date so the user sees "likely area: MediaTek MT7922 — driver a year
// old" without running Get-NetAdapter themselves.
// ===========================================================================

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DriverInfo {
    /// "gpu" | "wifi" | "network" | "storage" — matches the frontend CrashClass.
    pub class: String,
    pub name: String,
    pub version: String,
    /// Driver date, epoch ms (UTC), when known.
    pub date_ms: Option<i64>,
    /// Driver provider (e.g. "Microsoft", "Advanced Micro Devices, Inc."). Lets
    /// the UI treat Windows-inbox drivers (ancient dates by design) as built-in
    /// rather than "out of date".
    pub provider: String,
}

#[tauri::command]
pub async fn get_device_drivers() -> Result<Vec<DriverInfo>, String> {
    #[cfg(not(windows))]
    {
        return Ok(Vec::new());
    }

    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(query_device_drivers)
            .await
            .map_err(|e| format!("join error: {e}"))?
    }
}

#[cfg(windows)]
fn query_device_drivers() -> Result<Vec<DriverInfo>, String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    // Win32_PnPSignedDriver covers display/network/disk in one pass. Slow-ish
    // (enumerates all signed drivers) but this is a one-shot, cached call.
    let script = r#"
$ErrorActionPreference = 'SilentlyContinue'
Get-CimInstance Win32_PnPSignedDriver |
  Where-Object { $_.DeviceClass -in @('DISPLAY','NET','DISKDRIVE') -and $_.DeviceName } |
  ForEach-Object {
    [PSCustomObject]@{
      Class    = [string]$_.DeviceClass
      Name     = [string]$_.DeviceName
      Version  = [string]$_.DriverVersion
      Provider = [string]$_.DriverProviderName
      Date     = if ($_.DriverDate) { $_.DriverDate.ToUniversalTime().ToString('o') } else { $null }
    }
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
    Ok(parse_drivers(&text))
}

/// Names that mean "not a real physical adapter" — filtered out of the NET class.
const VIRTUAL_NET_MARKERS: &[&str] = &[
    "miniport", "virtual", "loopback", "bluetooth", "vpn", "tap-", "tap ",
    "tunnel", "kernel debug", "wan ", "teredo", "isatap", "npcap", "wireguard",
    "wfp", "qos packet",
];

fn parse_drivers(json: &str) -> Vec<DriverInfo> {
    if json.is_empty() {
        return Vec::new();
    }
    let value: serde_json::Value = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let rows = match value {
        serde_json::Value::Array(a) => a,
        serde_json::Value::Object(_) => vec![value],
        _ => return Vec::new(),
    };

    let mut out: Vec<DriverInfo> = Vec::new();
    let mut seen: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
    for row in &rows {
        let device_class = row.get("Class").and_then(|v| v.as_str()).unwrap_or("");
        let name = row.get("Name").and_then(|v| v.as_str()).unwrap_or("").trim();
        if name.is_empty() {
            continue;
        }
        let name_lower = name.to_lowercase();
        let class = match device_class.to_ascii_uppercase().as_str() {
            "DISPLAY" => "gpu",
            "DISKDRIVE" => "storage",
            "NET" => {
                if VIRTUAL_NET_MARKERS.iter().any(|m| name_lower.contains(m)) {
                    continue;
                }
                if ["wireless", "wi-fi", "wifi", "wlan", "802.11"]
                    .iter()
                    .any(|m| name_lower.contains(m))
                {
                    "wifi"
                } else {
                    "network"
                }
            }
            _ => continue,
        };
        let version = row
            .get("Version")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let date_ms = row
            .get("Date")
            .and_then(|v| v.as_str())
            .and_then(parse_rfc3339_ms);
        let provider = row
            .get("Provider")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let key = (class.to_string(), name_lower);
        if !seen.insert(key) {
            continue;
        }
        out.push(DriverInfo {
            class: class.to_string(),
            name: name.to_string(),
            version,
            date_ms,
            provider,
        });
    }
    out
}

// ===========================================================================
// D + E — crash context. Around the incidents we surface high-signal
// neighbours from the event log (GPU TDRs that *name* the display driver,
// WHEA hardware errors, disk errors), plus the machine's sleep-state config
// (Modern Standby vs S3) so power-class crashes get the right framing.
// ===========================================================================

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContextEvent {
    pub timestamp_ms: i64,
    /// "gpu_tdr" | "whea" | "disk".
    pub source: String,
    pub detail: String,
    /// Driver name parsed from the message (GPU TDRs only), when present.
    pub driver: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CrashContext {
    pub events: Vec<ContextEvent>,
    /// True when the machine uses Modern Standby (S0 low-power idle).
    pub modern_standby: bool,
    /// True when classic S3 sleep is available.
    pub s3_available: bool,
}

#[tauri::command]
pub async fn get_crash_context(since_days: Option<u32>) -> Result<CrashContext, String> {
    let days = since_days.unwrap_or(30).clamp(1, 365);

    #[cfg(not(windows))]
    {
        let _ = days;
        return Ok(CrashContext::default());
    }

    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let events = query_context_events(days).unwrap_or_default();
            let (modern_standby, s3_available) = query_power_states();
            Ok(CrashContext {
                events,
                modern_standby,
                s3_available,
            })
        })
        .await
        .map_err(|e| format!("join error: {e}"))?
    }
}

#[cfg(windows)]
fn query_context_events(days: u32) -> Result<Vec<ContextEvent>, String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let script = format!(
        r#"
$ErrorActionPreference = 'SilentlyContinue'
$start = (Get-Date).AddDays(-{days})
$rows = @()
$rows += Get-WinEvent -FilterHashtable @{{ LogName='System'; ProviderName='Display'; Id=4101; StartTime=$start }} -MaxEvents 50 |
  ForEach-Object {{ [PSCustomObject]@{{ Source='gpu_tdr'; Time=$_.TimeCreated.ToUniversalTime().ToString('o'); Detail=[string]$_.Message }} }}
$rows += Get-WinEvent -FilterHashtable @{{ LogName='System'; ProviderName='Microsoft-Windows-WHEA-Logger'; StartTime=$start }} -MaxEvents 50 |
  ForEach-Object {{ [PSCustomObject]@{{ Source='whea'; Time=$_.TimeCreated.ToUniversalTime().ToString('o'); Detail=[string]$_.Message }} }}
$rows += Get-WinEvent -FilterHashtable @{{ LogName='System'; ProviderName='disk'; Id=7,11,51,153; StartTime=$start }} -MaxEvents 50 |
  ForEach-Object {{ [PSCustomObject]@{{ Source='disk'; Time=$_.TimeCreated.ToUniversalTime().ToString('o'); Detail=[string]$_.Message }} }}
$rows | ConvertTo-Json -Compress
"#
    );

    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Failed to run PowerShell: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(parse_context_events(&text))
}

fn parse_context_events(json: &str) -> Vec<ContextEvent> {
    if json.is_empty() {
        return Vec::new();
    }
    let value: serde_json::Value = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let rows = match value {
        serde_json::Value::Array(a) => a,
        serde_json::Value::Object(_) => vec![value],
        _ => return Vec::new(),
    };

    let mut out: Vec<ContextEvent> = rows
        .iter()
        .filter_map(|row| {
            let source = row.get("Source").and_then(|v| v.as_str())?.to_string();
            let time = row.get("Time").and_then(|v| v.as_str())?;
            let timestamp_ms = parse_rfc3339_ms(time)?;
            let detail = row
                .get("Detail")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let driver = if source == "gpu_tdr" {
                extract_tdr_driver(&detail)
            } else {
                None
            };
            Some(ContextEvent {
                timestamp_ms,
                source,
                detail: first_line(&detail),
                driver,
            })
        })
        .collect();
    out.sort_by(|a, b| b.timestamp_ms.cmp(&a.timestamp_ms));
    out
}

/// Keep context messages to their first line — event Messages are often
/// multi-paragraph and we only want the headline.
fn first_line(s: &str) -> String {
    s.lines().next().unwrap_or("").trim().to_string()
}

/// Pull the display-driver name out of a TDR message like
/// "Display driver amdwddmg stopped responding and has successfully recovered."
fn extract_tdr_driver(msg: &str) -> Option<String> {
    let lower = msg.to_lowercase();
    let marker = "display driver ";
    let start = lower.find(marker)? + marker.len();
    let rest = &msg[start..];
    let end = rest
        .find(" stopped")
        .or_else(|| rest.find(" Stopped"))
        .unwrap_or(rest.len());
    let name = rest[..end].trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

/// Detect sleep states from `powercfg /a`. Returns (modern_standby, s3_available).
#[cfg(windows)]
fn query_power_states() -> (bool, bool) {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let output = Command::new("powercfg")
        .arg("/a")
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    match output {
        Ok(o) if o.status.success() => {
            parse_power_states(&String::from_utf8_lossy(&o.stdout))
        }
        _ => (false, false),
    }
}

/// Parse `powercfg /a` text. Only the *available* section (before the "not
/// available" heading) counts toward what the machine actually supports.
fn parse_power_states(text: &str) -> (bool, bool) {
    let lower = text.to_lowercase();
    let available = match lower.find("not available") {
        Some(idx) => &lower[..idx],
        None => &lower[..],
    };
    let modern_standby = available.contains("s0 low power idle");
    let s3_available = available.contains("standby (s3)");
    (modern_standby, s3_available)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drivers_parsed_and_net_classified() {
        let json = r#"[
            {"Class":"DISPLAY","Name":"AMD Radeon 890M","Version":"32.0.1","Date":"2025-06-30T00:00:00Z"},
            {"Class":"NET","Name":"MediaTek Wi-Fi 6E MT7922 (RZ616)","Version":"3.4.2","Date":"2025-06-30T00:00:00Z"},
            {"Class":"NET","Name":"WAN Miniport (IP)","Version":"10.0","Date":null},
            {"Class":"DISKDRIVE","Name":"Samsung SSD 990 PRO","Version":"5.1","Date":null}
        ]"#;
        let d = parse_drivers(json);
        assert!(d.iter().any(|x| x.class == "gpu" && x.name.contains("Radeon")));
        let wifi = d.iter().find(|x| x.class == "wifi").expect("wifi row");
        assert!(wifi.name.contains("MT7922"));
        assert!(wifi.date_ms.is_some());
        assert!(d.iter().any(|x| x.class == "storage"));
        // Virtual NET adapter filtered out.
        assert!(!d.iter().any(|x| x.name.contains("Miniport")));
    }

    #[test]
    fn tdr_driver_name_extracted() {
        assert_eq!(
            extract_tdr_driver(
                "Display driver amdwddmg stopped responding and has successfully recovered."
            ),
            Some("amdwddmg".to_string())
        );
        assert_eq!(extract_tdr_driver("unrelated message"), None);
    }

    #[test]
    fn context_events_parsed_sorted_and_first_line() {
        let json = r#"[
            {"Source":"disk","Time":"2026-06-10T08:00:00Z","Detail":"The device has a bad block."},
            {"Source":"gpu_tdr","Time":"2026-06-11T09:00:00Z","Detail":"Display driver amdwddmg stopped responding and has successfully recovered.\nsecond line"}
        ]"#;
        let ev = parse_context_events(json);
        assert_eq!(ev.len(), 2);
        assert_eq!(ev[0].source, "gpu_tdr"); // newest first
        assert_eq!(ev[0].driver.as_deref(), Some("amdwddmg"));
        assert!(!ev[0].detail.contains("second line"));
    }

    #[test]
    fn power_states_parsed_from_real_output() {
        // The exact shape `powercfg /a` returns on a Modern Standby laptop.
        let sample = "The following sleep states are available on this system:\n\
            \x20   Standby (S0 Low Power Idle) Network Disconnected\n\
            \x20   Hibernate\n\
            \x20   Fast Startup\n\n\
            The following sleep states are not available on this system:\n\
            \x20   Standby (S1)\n\
            \x20   Standby (S3)\n";
        let (s0, s3) = parse_power_states(sample);
        assert!(s0, "Modern Standby should be detected");
        assert!(!s3, "S3 is only in the not-available section");
    }

    #[test]
    fn stop_code_extracted_and_uppercased() {
        assert_eq!(
            extract_stop_code("The bugcheck was: 0x0000007e (0xffff...)"),
            Some("0x0000007E".to_string())
        );
        assert_eq!(extract_stop_code("no code here"), None);
    }

    #[test]
    fn single_object_parses() {
        let json = r#"{"Id":6008,"Time":"2026-06-10T08:00:00Z","Bugcheck":null,"Msg":"unexpected"}"#;
        let out = process_events(json);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, "unexpected_shutdown");
    }

    #[test]
    fn bsod_triplet_collapses_to_one_incident() {
        // A real BSOD logs 1001 + 41 + 6008 within seconds. Expect ONE
        // incident, classified as a bsod with the stop code preserved.
        let json = r#"[
            {"Id":1001,"Time":"2026-06-10T08:00:05Z","Bugcheck":null,"Msg":"bugcheck was: 0x0000007E (..)"},
            {"Id":41,"Time":"2026-06-10T08:00:03Z","Bugcheck":"126","Msg":"kernel power"},
            {"Id":6008,"Time":"2026-06-10T08:00:01Z","Bugcheck":null,"Msg":"previous shutdown unexpected"}
        ]"#;
        let out = process_events(json);
        assert_eq!(out.len(), 1, "triplet should collapse");
        assert_eq!(out[0].kind, "bsod");
        assert_eq!(out[0].bugcheck_code.as_deref(), Some("0x0000007E"));
    }

    #[test]
    fn distant_events_stay_separate() {
        let json = r#"[
            {"Id":6008,"Time":"2026-06-10T08:00:00Z","Bugcheck":null,"Msg":"a"},
            {"Id":6008,"Time":"2026-06-09T08:00:00Z","Bugcheck":null,"Msg":"b"}
        ]"#;
        let out = process_events(json);
        assert_eq!(out.len(), 2);
        // Sorted newest-first.
        assert!(out[0].timestamp_ms > out[1].timestamp_ms);
    }

    #[test]
    fn power_loss_when_bugcheck_zero() {
        let json = r#"{"Id":41,"Time":"2026-06-10T08:00:00Z","Bugcheck":"0","Msg":"kernel power"}"#;
        let out = process_events(json);
        assert_eq!(out[0].kind, "power_loss");
        assert_eq!(out[0].bugcheck_code, None);
    }

    #[test]
    fn empty_input_is_empty() {
        assert!(process_events("").is_empty());
        assert!(process_events("not json").is_empty());
    }
}

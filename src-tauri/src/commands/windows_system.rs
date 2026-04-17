//! Windows-only helpers: open `ms-settings:` URLs and read `powercfg /batteryreport /xml`.

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
use chrono::{Duration, NaiveDateTime, NaiveTime, Timelike};

#[derive(serde::Serialize, Clone, Debug)]
pub struct BatteryHourBucket {
    pub bucket_start_local: String,
    pub drain_wh: f64,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct BatteryDayDrain {
    pub day: String,
    pub drain_wh: f64,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct WindowsBatteryUsage {
    pub hourly_24h: Vec<BatteryHourBucket>,
    pub daily_7d: Vec<BatteryDayDrain>,
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn uri_open_allowed(uri: &str) -> bool {
    uri.starts_with("ms-settings:")
        || uri.starts_with("http://")
        || uri.starts_with("https://")
        || uri.starts_with("mailto:")
        || uri.starts_with("shell:")
        || is_local_path(uri)
}

fn is_local_path(uri: &str) -> bool {
    let bytes = uri.as_bytes();
    bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && (bytes[2] == b'\\' || bytes[2] == b'/')
}

#[tauri::command]
pub fn open_windows_uri(uri: String) -> Result<(), String> {
    #[cfg(not(windows))]
    {
        let _ = uri;
        return Err("open_windows_uri is only supported on Windows.".to_string());
    }

    #[cfg(windows)]
    {
        if uri.is_empty() || uri.len() > 1024 || !uri_open_allowed(&uri) {
            return Err("Invalid or disallowed URI.".to_string());
        }

        std::process::Command::new("cmd")
            .args(["/C", "start", "", uri.as_str()])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("Failed to open URI: {e}"))?;
        Ok(())
    }
}

#[tauri::command]
pub fn get_windows_battery_usage() -> Result<WindowsBatteryUsage, String> {
    #[cfg(not(windows))]
    {
        return Ok(WindowsBatteryUsage {
            hourly_24h: vec![],
            daily_7d: vec![],
        });
    }

    #[cfg(windows)]
    {
        use std::fs;
        use std::process::Command;

        let tmp = std::env::temp_dir().join(format!(
            "taskmanagerplus-battery-report-{}.xml",
            std::process::id()
        ));
        let _ = fs::remove_file(&tmp);

        let status = Command::new("powercfg")
            .args([
                "/batteryreport",
                "/output",
                tmp.to_str().ok_or("Invalid temp path")?,
                "/xml",
            ])
            .status()
            .map_err(|e| format!("powercfg failed to start: {e}"))?;

        if !status.success() {
            return Err(
                "powercfg /batteryreport failed (desktop without battery, or access denied)."
                    .to_string(),
            );
        }

        let xml = fs::read_to_string(&tmp).map_err(|e| format!("Read battery report: {e}"))?;
        let _ = fs::remove_file(&tmp);

        Ok(parse_battery_report(&xml))
    }
}

#[cfg(windows)]
fn extract_local_scan_time(xml: &str) -> NaiveDateTime {
    let tag = "<LocalScanTime>";
    if let Some(i) = xml.find(tag) {
        let rest = &xml[i + tag.len()..];
        if let Some(j) = rest.find("</LocalScanTime>") {
            let inner = rest[..j].trim();
            if let Ok(dt) = NaiveDateTime::parse_from_str(inner, "%Y-%m-%dT%H:%M:%S") {
                return dt;
            }
        }
    }
    chrono::Local::now().naive_local()
}

#[cfg(windows)]
fn parse_attr<'a>(block: &'a str, name: &str) -> Option<&'a str> {
    let needle = format!("{name}=\"");
    let start = block.find(&needle)? + needle.len();
    let end = block[start..].find('"')?;
    Some(&block[start..start + end])
}

#[cfg(windows)]
fn floor_to_hour(dt: NaiveDateTime) -> NaiveDateTime {
    NaiveDateTime::new(
        dt.date(),
        NaiveTime::from_hms_opt(dt.hour(), 0, 0).unwrap_or_else(|| NaiveTime::from_hms_opt(0, 0, 0).unwrap()),
    )
}

#[cfg(windows)]
fn parse_battery_report(xml: &str) -> WindowsBatteryUsage {
    use std::collections::HashMap;

    let scan = extract_local_scan_time(xml);
    let scan_floor = floor_to_hour(scan);
    let hour_start = scan_floor - Duration::hours(23);

    let mut hourly: HashMap<String, f64> = HashMap::new();
    let mut daily: HashMap<String, f64> = HashMap::new();

    for chunk in xml.split("<UsageEntry") {
        if !chunk.contains("Ac=\"0\"") {
            continue;
        }
        let Some(disch_s) = parse_attr(chunk, "Discharge") else {
            continue;
        };
        let Ok(disch) = disch_s.parse::<i64>() else {
            continue;
        };
        if disch <= 0 {
            continue;
        }
        let Some(ts) = parse_attr(chunk, "LocalTimestamp") else {
            continue;
        };
        let Some(entry_time) = NaiveDateTime::parse_from_str(ts, "%Y-%m-%dT%H:%M:%S").ok() else {
            continue;
        };

        let wh = disch as f64 / 1000.0;
        let day_key = entry_time.format("%Y-%m-%d").to_string();
        *daily.entry(day_key).or_insert(0.0) += wh;

        if entry_time >= hour_start && entry_time <= scan {
            let b = floor_to_hour(entry_time);
            let hk = b.format("%Y-%m-%dT%H:00:00").to_string();
            *hourly.entry(hk).or_insert(0.0) += wh;
        }
    }

    let mut hourly_24h: Vec<BatteryHourBucket> = Vec::with_capacity(24);
    for i in 0..24 {
        let t = hour_start + Duration::hours(i);
        let key = t.format("%Y-%m-%dT%H:00:00").to_string();
        hourly_24h.push(BatteryHourBucket {
            bucket_start_local: key.clone(),
            drain_wh: hourly.get(&key).copied().unwrap_or(0.0),
        });
    }

    let mut daily_7d: Vec<BatteryDayDrain> = daily
        .into_iter()
        .map(|(day, drain_wh)| BatteryDayDrain { day, drain_wh })
        .collect();
    daily_7d.sort_by(|a, b| a.day.cmp(&b.day));

    WindowsBatteryUsage {
        hourly_24h,
        daily_7d,
    }
}

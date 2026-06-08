//! Parse Windows Diagnostics Infrastructure StartupInfo XML for boot impact.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ImpactLevel {
    Low,
    Medium,
    High,
    NotMeasured,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct BootTraceEntry {
    pub name: String,
    pub exe_path: String,
    pub start_offset_ms: u64,
    pub cpu_ms: u64,
    pub disk_bytes: u64,
    pub impact: ImpactLevel,
}

#[derive(Debug, Clone, Default)]
pub struct WdiProcessImpact {
    pub cpu_ms: u64,
    pub disk_bytes: u64,
}

pub fn classify_impact(cpu_ms: u64, disk_bytes: u64) -> ImpactLevel {
    const HIGH_CPU: u64 = 1000;
    const MED_CPU: u64 = 300;
    const HIGH_DISK: u64 = 3 * 1024 * 1024;
    const MED_DISK: u64 = 300 * 1024;

    if cpu_ms > HIGH_CPU || disk_bytes > HIGH_DISK {
        ImpactLevel::High
    } else if cpu_ms >= MED_CPU || disk_bytes >= MED_DISK {
        ImpactLevel::Medium
    } else if cpu_ms > 0 || disk_bytes > 0 {
        ImpactLevel::Low
    } else {
        ImpactLevel::NotMeasured
    }
}

#[cfg(windows)]
pub fn load_wdi_impacts() -> (HashMap<String, WdiProcessImpact>, Vec<BootTraceEntry>, bool) {
    use std::fs;
    let sid = match current_user_sid_string() {
        Some(s) => s,
        None => return (HashMap::new(), Vec::new(), false),
    };

    let dir = PathBuf::from(r"C:\Windows\System32\wdi\LogFiles\StartupInfo");
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return (HashMap::new(), Vec::new(), false),
    };

    let prefix = format!("{sid}_");
    let mut newest: Option<PathBuf> = None;
    let mut newest_mtime = std::time::SystemTime::UNIX_EPOCH;

    for ent in entries.flatten() {
        let name = ent.file_name().to_string_lossy().to_string();
        if !name.starts_with(&prefix) || !name.ends_with(".xml") {
            continue;
        }
        if let Ok(meta) = ent.metadata() {
            if let Ok(modified) = meta.modified() {
                if modified > newest_mtime {
                    newest_mtime = modified;
                    newest = Some(ent.path());
                }
            }
        }
    }

    let Some(xml_path) = newest else {
        return (HashMap::new(), Vec::new(), false);
    };

    let raw = match fs::read(&xml_path) {
        Ok(b) => b,
        Err(_) => return (HashMap::new(), Vec::new(), false),
    };

    let text = decode_utf16_xml(&raw);
    parse_startup_xml(&text)
}

#[cfg(not(windows))]
pub fn load_wdi_impacts() -> (HashMap<String, WdiProcessImpact>, Vec<BootTraceEntry>, bool) {
    (HashMap::new(), Vec::new(), false)
}

#[cfg(windows)]
fn current_user_sid_string() -> Option<String> {
    use windows::Win32::Foundation::{CloseHandle, HANDLE, HLOCAL, LocalFree};
    use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows::Win32::Security::{
        GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return None;
        }
        let mut len = 0u32;
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut len);
        if len == 0 {
            let _ = CloseHandle(token);
            return None;
        }
        let mut buf = vec![0u8; len as usize];
        if GetTokenInformation(
            token,
            TokenUser,
            Some(buf.as_mut_ptr() as *mut _),
            len,
            &mut len,
        )
        .is_err()
        {
            let _ = CloseHandle(token);
            return None;
        }
        let tu = &*(buf.as_ptr() as *const TOKEN_USER);
        let mut sid_str = windows::core::PWSTR::null();
        if ConvertSidToStringSidW(tu.User.Sid, &mut sid_str).is_err() {
            let _ = CloseHandle(token);
            return None;
        }
        let s = sid_str.to_string().ok();
        let _ = LocalFree(HLOCAL(sid_str.0 as _));
        let _ = CloseHandle(token);
        s
    }
}

fn decode_utf16_xml(raw: &[u8]) -> String {
    if raw.len() >= 2 && raw[0] == 0xFF && raw[1] == 0xFE {
        let u16s: Vec<u16> = raw[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&u16s);
    }
    String::from_utf8_lossy(raw).into_owned()
}

fn parse_startup_xml(text: &str) -> (HashMap<String, WdiProcessImpact>, Vec<BootTraceEntry>, bool) {
    let mut map: HashMap<String, WdiProcessImpact> = HashMap::new();
    let mut trace = Vec::new();

    for block in text.split("<Process").skip(1) {
        let end = block.find("</Process>").unwrap_or(block.len());
        let chunk = &block[..end];
        let name = extract_attr(chunk, "Name")
            .or_else(|| extract_tag_text(chunk, "Name"))
            .unwrap_or_default();
        let command = extract_tag_text(chunk, "CommandLine").unwrap_or_default();
        let image = extract_attr(chunk, "ImagePath")
            .or_else(|| extract_tag_text(chunk, "ImagePath"))
            .unwrap_or_else(|| exe_from_command(&command));
        let cpu_raw = extract_tag_u64(chunk, "CpuUsage")
            .or_else(|| extract_tag_u64(chunk, "CpuTime"))
            .or_else(|| extract_attr_u64(chunk, "CpuUsage"));
        let disk = extract_tag_u64(chunk, "DiskUsage")
            .or_else(|| extract_tag_u64(chunk, "DiskIO"))
            .or_else(|| extract_attr_u64(chunk, "DiskUsage"));
        let offset_ms = extract_tag_u64(chunk, "StartedInTraceSec")
            .map(|s| s * 1000)
            .or_else(|| extract_tag_u64(chunk, "StartTime"))
            .unwrap_or(0);

        // CpuUsage is stored in microseconds in StartupInfo XML.
        let cpu_ms = cpu_raw.unwrap_or(0) / 1000;
        let disk_bytes = disk.unwrap_or(0);
        let impact = classify_impact(cpu_ms, disk_bytes);

        let impact_entry = WdiProcessImpact {
            cpu_ms,
            disk_bytes,
        };
        let key = normalize_match_key(&image, &name);
        if !key.is_empty() {
            map.entry(key.clone())
                .and_modify(|e| {
                    e.cpu_ms += cpu_ms;
                    e.disk_bytes += disk_bytes;
                })
                .or_insert_with(|| impact_entry.clone());
        }
        let name_key = name.trim().to_lowercase();
        if !name_key.is_empty() && name_key != key {
            map.entry(name_key)
                .and_modify(|e| {
                    e.cpu_ms += cpu_ms;
                    e.disk_bytes += disk_bytes;
                })
                .or_insert(impact_entry);
        }

        if !name.is_empty() && (cpu_ms > 0 || disk_bytes > 0) {
            trace.push(BootTraceEntry {
                name: name.clone(),
                exe_path: image.clone(),
                start_offset_ms: offset_ms,
                cpu_ms,
                disk_bytes,
                impact,
            });
        }
    }

    trace.sort_by(|a, b| b.cpu_ms.cmp(&a.cpu_ms).then(b.disk_bytes.cmp(&a.disk_bytes)));
    trace.truncate(20);
    let available = !map.is_empty() || !trace.is_empty();
    (map, trace, available)
}

fn extract_tag_text(block: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}");
    let start = block.find(&open)?;
    let after_open = block[start..].find('>')? + start + 1;
    let close = format!("</{tag}>");
    let end = block[after_open..].find(&close)? + after_open;
    let inner = block[after_open..end].trim();
    let inner = inner
        .strip_prefix("<![CDATA[")
        .and_then(|s| s.strip_suffix("]]>"))
        .unwrap_or(inner)
        .trim();
    if inner.is_empty() {
        None
    } else {
        Some(inner.to_string())
    }
}

fn extract_attr(block: &str, attr: &str) -> Option<String> {
    let needle = format!("{attr}=\"");
    let start = block.find(&needle)? + needle.len();
    let end = block[start..].find('"')? + start;
    let val = block[start..end].trim();
    if val.is_empty() {
        None
    } else {
        Some(val.to_string())
    }
}

fn exe_from_command(cmd: &str) -> String {
    let s = cmd.trim();
    if s.is_empty() {
        return String::new();
    }
    if s.starts_with('"') {
        if let Some(end) = s[1..].find('"') {
            return s[1..1 + end].to_string();
        }
    }
    s.split_whitespace().next().unwrap_or(s).to_string()
}

fn extract_tag_u64(block: &str, tag: &str) -> Option<u64> {
    extract_tag_text(block, tag)?.parse().ok()
}

fn extract_attr_u64(text: &str, attr: &str) -> Option<u64> {
    let needle = format!("{attr}=\"");
    let start = text.find(&needle)? + needle.len();
    let end = text[start..].find('"')? + start;
    text[start..end].parse().ok()
}

pub fn normalize_match_key(image_path: &str, name: &str) -> String {
    let path = image_path.trim();
    if !path.is_empty() {
        return Path::new(path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(path)
            .to_lowercase();
    }
    name.trim().to_lowercase()
}

pub fn match_wdi_impact(
    impacts: &HashMap<String, WdiProcessImpact>,
    exe_path: &str,
    name: &str,
) -> Option<WdiProcessImpact> {
    let key = normalize_match_key(exe_path, name);
    if !key.is_empty() {
        if let Some(v) = impacts.get(&key) {
            return Some(v.clone());
        }
        for (k, v) in impacts {
            if key.contains(k) || k.contains(&key) {
                return Some(v.clone());
            }
        }
    }
    let name_key = name.trim().to_lowercase();
    if !name_key.is_empty() {
        if let Some(v) = impacts.get(&name_key) {
            return Some(v.clone());
        }
        for (k, v) in impacts {
            if name_key.contains(k) || k.contains(&name_key) {
                return Some(v.clone());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn impact_thresholds() {
        assert_eq!(classify_impact(1500, 0), ImpactLevel::High);
        assert_eq!(classify_impact(0, 4 * 1024 * 1024), ImpactLevel::High);
        assert_eq!(classify_impact(500, 500 * 1024), ImpactLevel::Medium);
        assert_eq!(classify_impact(100, 100 * 1024), ImpactLevel::Low);
    }
}

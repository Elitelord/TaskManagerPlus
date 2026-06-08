//! Windows startup application enumeration and control.

#[cfg(windows)]
mod approve;
#[cfg(windows)]
mod task_scheduler;
#[cfg(windows)]
mod wdi_startup_info;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static STARTUP_APP_CACHE: Mutex<Vec<StartupAppInfo>> = Mutex::new(Vec::new());
#[cfg(windows)]
pub use task_scheduler::LogonScheduledTaskInfo;
#[cfg(windows)]
pub use wdi_startup_info::BootTraceEntry;

#[cfg(windows)]
use approve::{decode_approve_status, encode_approve_status};
#[cfg(windows)]
use wdi_startup_info::{classify_impact, load_wdi_impacts, match_wdi_impact, ImpactLevel};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StartupSource {
    RegistryRun,
    RegistryRun32,
    StartupFolder,
    Packaged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StartupImpact {
    None,
    Low,
    Medium,
    High,
    NotMeasured,
}

#[cfg(not(windows))]
#[derive(Debug, Clone, serde::Serialize)]
pub struct BootTraceEntry {
    pub name: String,
    pub exe_path: String,
    pub start_offset_ms: u64,
    pub cpu_ms: u64,
    pub disk_bytes: u64,
    pub impact: StartupImpact,
}

#[cfg(not(windows))]
#[derive(Debug, Clone, serde::Serialize)]
pub struct LogonScheduledTaskInfo {
    pub name: String,
    pub path: String,
    pub author: String,
    pub trigger: String,
    pub exe_path: String,
    pub enabled: bool,
}

#[cfg(windows)]
impl From<ImpactLevel> for StartupImpact {
    fn from(v: ImpactLevel) -> Self {
        match v {
            ImpactLevel::Low => StartupImpact::Low,
            ImpactLevel::Medium => StartupImpact::Medium,
            ImpactLevel::High => StartupImpact::High,
            ImpactLevel::NotMeasured => StartupImpact::NotMeasured,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StartupScope {
    User,
    Machine,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct StartupAppInfo {
    pub id: String,
    pub name: String,
    pub publisher: String,
    pub command: String,
    pub exe_path: String,
    pub icon_base64: String,
    pub source: StartupSource,
    pub scope: StartupScope,
    pub enabled: bool,
    pub editable: bool,
    pub impact: StartupImpact,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_at_startup_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disk_at_startup_bytes: Option<u64>,
    pub approve_registry_path: String,
    pub approve_value_name: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct StartupAppsResponse {
    pub apps: Vec<StartupAppInfo>,
    pub impact_available: bool,
    pub boot_trace: Vec<BootTraceEntry>,
    pub logon_tasks: Vec<LogonScheduledTaskInfo>,
}

#[derive(Debug, Clone)]
struct RawStartupEntry {
    name: String,
    command: String,
    source: StartupSource,
    scope: StartupScope,
    approve_registry_path: String,
    approve_value_name: String,
}

const PROTECTED_DISABLE_DENYLIST: &[&str] = &[
    "explorer.exe",
    "securityhealthsystray.exe",
    "ctfmon.exe",
    "sihost.exe",
    "taskhostw.exe",
    "userinit.exe",
];

#[cfg(windows)]
pub fn list_startup_apps() -> StartupAppsResponse {
    let mut raw: Vec<RawStartupEntry> = Vec::new();
    enumerate_registry_run(&mut raw);
    enumerate_approved_registry_entries(&mut raw);
    enumerate_startup_folders(&mut raw);
    enumerate_startup_folder_approved(&mut raw);
    enumerate_packaged_startup(&mut raw);
    enumerate_wmi_startup(&mut raw);

    let installed = load_installed_publishers();
    let (wdi_map, boot_trace, impact_available) = load_wdi_impacts();
    let logon_tasks = task_scheduler::enumerate_logon_tasks();

    let mut apps: Vec<StartupAppInfo> = Vec::new();
    let mut seen: HashMap<String, usize> = HashMap::new();

    for entry in raw {
        let (exe_path, icon_base64, display_name, company) = enrich_entry(&entry.command);
        let name = if !display_name.is_empty() {
            display_name
        } else {
            entry.name.clone()
        };
        let publisher = if !company.is_empty() {
            company
        } else {
            lookup_publisher(&exe_path, &installed)
        };

        let approve_registry_path = normalize_approve_registry_path(&entry.approve_registry_path);
        let approve_value_name =
            resolve_approve_value_name(&approve_registry_path, &entry.approve_value_name)
                .unwrap_or_else(|| entry.approve_value_name.clone());
        let approve_bytes = read_approve_blob(&approve_registry_path, &approve_value_name);
        let status = decode_approve_status(approve_bytes.as_deref());

        let mut impact = StartupImpact::NotMeasured;
        let mut cpu_ms = None;
        let mut disk_bytes = None;
        if let Some(wdi) = match_wdi_impact(&wdi_map, &exe_path, &name) {
            impact = classify_impact(wdi.cpu_ms, wdi.disk_bytes).into();
            cpu_ms = Some(wdi.cpu_ms);
            disk_bytes = Some(wdi.disk_bytes);
        } else if !status.enabled {
            impact = StartupImpact::None;
        }

        let id = make_id(
            &exe_path,
            &entry.approve_value_name,
            &approve_registry_path,
        );

        if let Some(&idx) = seen.get(&id) {
            let existing = &mut apps[idx];
            if existing.command.is_empty() {
                existing.command = entry.command.clone();
            }
            continue;
        }

        let row = StartupAppInfo {
            id: id.clone(),
            name,
            publisher,
            command: entry.command,
            exe_path,
            icon_base64,
            source: entry.source,
            scope: entry.scope,
            enabled: status.enabled,
            editable: status.editable,
            impact,
            cpu_at_startup_ms: cpu_ms,
            disk_at_startup_bytes: disk_bytes,
            approve_registry_path,
            approve_value_name,
        };
        seen.insert(id, apps.len());
        apps.push(row);
    }

    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    if let Ok(mut cache) = STARTUP_APP_CACHE.lock() {
        *cache = apps.clone();
    }

    StartupAppsResponse {
        apps,
        impact_available,
        boot_trace,
        logon_tasks,
    }
}

#[cfg(not(windows))]
pub fn list_startup_apps() -> StartupAppsResponse {
    StartupAppsResponse {
        apps: Vec::new(),
        impact_available: false,
        boot_trace: Vec::new(),
        logon_tasks: Vec::new(),
    }
}

#[cfg(windows)]
pub fn set_startup_enabled(id: &str, enabled: bool) -> Result<(), String> {
    let app = {
        let cache = STARTUP_APP_CACHE
            .lock()
            .map_err(|_| "Startup cache lock poisoned".to_string())?;
        cache.iter().find(|a| a.id == id).cloned()
    };
    let app = app.or_else(|| {
        list_startup_apps()
            .apps
            .into_iter()
            .find(|a| a.id == id)
    });
    let app = app.ok_or_else(|| format!("Startup entry '{id}' not found"))?;

    if !app.editable {
        return Err("This startup entry is managed by policy and cannot be changed.".into());
    }
    if app.approve_registry_path.is_empty() || app.approve_value_name.is_empty() {
        return Err("This startup entry cannot be toggled from TaskManager+.".into());
    }

    let exe_leaf = Path::new(&app.exe_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    if PROTECTED_DISABLE_DENYLIST.iter().any(|p| *p == exe_leaf) {
        return Err(format!("'{exe_leaf}' is protected and cannot be disabled."));
    }

    if app.scope == StartupScope::Machine && !is_elevated_token() {
        return Err("elevation_required:Machine-wide startup entries require administrator privileges.".into());
    }

    let approve_path = normalize_approve_registry_path(&app.approve_registry_path);
    let value_name = resolve_approve_value_name(&approve_path, &app.approve_value_name)
        .ok_or_else(|| {
            format!(
                "Cannot resolve startup approval value for '{}'",
                app.name
            )
        })?;
    let blob = encode_approve_status(enabled, true);
    write_approve_blob(&approve_path, &value_name, &blob)?;
    let written = read_approve_blob(&approve_path, &value_name);
    let status = decode_approve_status(written.as_deref());
    if status.enabled != enabled {
        return Err(format!(
            "Registry write did not stick for '{}'. Try again as administrator.",
            app.name
        ));
    }
    if let Ok(mut cache) = STARTUP_APP_CACHE.lock() {
        if let Some(row) = cache.iter_mut().find(|a| a.id == id) {
            row.enabled = enabled;
            row.approve_value_name = value_name;
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn set_startup_enabled(_id: &str, _enabled: bool) -> Result<(), String> {
    Err("Startup control is only supported on Windows.".into())
}

#[cfg(windows)]
pub fn set_logon_task_enabled(path: &str, name: &str, enabled: bool) -> Result<(), String> {
    task_scheduler::set_logon_task_enabled(path, name, enabled)
}

#[cfg(not(windows))]
pub fn set_logon_task_enabled(_path: &str, _name: &str, _enabled: bool) -> Result<(), String> {
    Err("Scheduled task control is only supported on Windows.".into())
}

#[cfg(windows)]
fn enumerate_registry_run(out: &mut Vec<RawStartupEntry>) {
    use windows::Win32::System::Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

    let pairs = [
        (
            HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Run",
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run",
            StartupSource::RegistryRun,
            StartupScope::User,
        ),
        (
            HKEY_LOCAL_MACHINE,
            r"Software\Microsoft\Windows\CurrentVersion\Run",
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run",
            StartupSource::RegistryRun,
            StartupScope::Machine,
        ),
        (
            HKEY_LOCAL_MACHINE,
            r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run",
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run32",
            StartupSource::RegistryRun32,
            StartupScope::Machine,
        ),
    ];

    for (hive, run_sub, approve_sub, source, scope) in pairs {
        read_run_values(hive, run_sub, approve_sub, source, scope, out);
    }
}

#[cfg(windows)]
fn enumerate_approved_registry_entries(out: &mut Vec<RawStartupEntry>) {
    use windows::Win32::System::Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

    let configs = [
        (
            HKEY_CURRENT_USER,
            "HKCU",
            r"Software\Microsoft\Windows\CurrentVersion\Run",
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run",
            StartupSource::RegistryRun,
            StartupScope::User,
        ),
        (
            HKEY_LOCAL_MACHINE,
            "HKLM",
            r"Software\Microsoft\Windows\CurrentVersion\Run",
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run",
            StartupSource::RegistryRun,
            StartupScope::Machine,
        ),
        (
            HKEY_LOCAL_MACHINE,
            "HKLM",
            r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run",
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run32",
            StartupSource::RegistryRun32,
            StartupScope::Machine,
        ),
    ];

    for (hive, prefix, run_sub, approve_sub, source, scope) in configs {
        merge_approved_run_entries(hive, prefix, run_sub, approve_sub, source, scope, out);
    }
}

#[cfg(windows)]
fn merge_approved_run_entries(
    hive: windows::Win32::System::Registry::HKEY,
    hive_prefix: &str,
    run_subkey: &str,
    approve_subkey: &str,
    source: StartupSource,
    scope: StartupScope,
    out: &mut Vec<RawStartupEntry>,
) {
    let approve_path = format!("{hive_prefix}\\{approve_subkey}");
    let run_commands: HashMap<String, String> = enum_registry_strings(hive, run_subkey)
        .into_iter()
        .collect();

    for (name, _) in enum_registry_values(hive, approve_subkey) {
        if name.is_empty() {
            continue;
        }
        let already = out.iter().any(|e| {
            e.approve_registry_path == approve_path && e.approve_value_name == name
        });
        if already {
            continue;
        }
        let command = run_commands.get(&name).cloned().unwrap_or_default();
        out.push(RawStartupEntry {
            name: name.clone(),
            command,
            source,
            scope,
            approve_registry_path: approve_path.clone(),
            approve_value_name: name,
        });
    }
}

#[cfg(windows)]
fn enumerate_startup_folder_approved(out: &mut Vec<RawStartupEntry>) {
    let folders = [
        (
            user_startup_approve_path(),
            StartupScope::User,
        ),
        (
            machine_startup_approve_path(),
            StartupScope::Machine,
        ),
    ];
    for (approve_path, scope) in folders {
        let Some((hive, sub)) = parse_registry_path(&approve_path) else {
            continue;
        };
        for (value_name, _) in enum_registry_values(hive, &sub) {
            if value_name.is_empty() {
                continue;
            }
            // Valid StartupFolder approval names are bare .lnk filenames.
            // Skip any full-path value (legacy data written by an earlier
            // bug, or anything malformed) so it can't shadow the real
            // filename-keyed entry or spawn a phantom row.
            if value_name.contains('\\') || value_name.contains('/') {
                continue;
            }
            let already = out.iter().any(|e| {
                e.approve_registry_path == approve_path && e.approve_value_name == value_name
            });
            if already {
                continue;
            }
            let file_name = Path::new(&value_name)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(&value_name)
                .trim_end_matches(".lnk")
                .to_string();
            out.push(RawStartupEntry {
                name: file_name,
                command: value_name.clone(),
                source: StartupSource::StartupFolder,
                scope,
                approve_registry_path: approve_path.clone(),
                approve_value_name: value_name,
            });
        }
    }
}

#[cfg(windows)]
fn enumerate_wmi_startup(out: &mut Vec<RawStartupEntry>) {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let script = r#"
$ErrorActionPreference = 'SilentlyContinue'
Get-CimInstance Win32_StartupCommand | ForEach-Object {
  [PSCustomObject]@{
    Name = [string]$_.Name
    Command = [string]$_.Command
    Location = [string]$_.Location
    User = [string]$_.User
  }
} | ConvertTo-Json -Compress
"#;
    let Ok(output) = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    else {
        return;
    };
    if !output.status.success() {
        return;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        return;
    }
    merge_wmi_startup_json(&text, out);
}

#[cfg(windows)]
fn merge_wmi_startup_json(text: &str, out: &mut Vec<RawStartupEntry>) {
    let value: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return,
    };
    let rows = match value {
        serde_json::Value::Array(a) => a,
        serde_json::Value::Object(_) => vec![value],
        _ => return,
    };
    for row in rows {
        let Some(name) = row.get("Name").and_then(|v| v.as_str()) else {
            continue;
        };
        if name.is_empty() {
            continue;
        }
        let command = row
            .get("Command")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let location = row
            .get("Location")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let user = row
            .get("User")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let Some((source, scope, approve_path, approve_name)) =
            map_wmi_location(&location, name, &command, &user)
        else {
            continue;
        };
        let approve_path = normalize_approve_registry_path(&approve_path);
        let already = out.iter().any(|e| {
            e.approve_registry_path == approve_path && e.approve_value_name == approve_name
        });
        if already || out.iter().any(|e| commands_match(&e.command, &command)) {
            continue;
        }
        out.push(RawStartupEntry {
            name: name.to_string(),
            command,
            source,
            scope,
            approve_registry_path: approve_path,
            approve_value_name: approve_name,
        });
    }
}

#[cfg(windows)]
fn map_wmi_location(
    location: &str,
    name: &str,
    command: &str,
    user: &str,
) -> Option<(StartupSource, StartupScope, String, String)> {
    let loc = location.replace('/', "\\");
    let loc_lower = loc.to_lowercase();
    if loc_lower.contains("startupapproved\\startupfolder") || loc_lower.ends_with("\\startup") {
        let scope = if loc_lower.contains("programdata") || user.eq_ignore_ascii_case(".default") {
            StartupScope::Machine
        } else {
            StartupScope::User
        };
        let approve = if scope == StartupScope::Machine {
            machine_startup_approve_path()
        } else {
            user_startup_approve_path()
        };
        let approve_name = if command.to_ascii_lowercase().ends_with(".lnk") {
            command.to_string()
        } else if !loc.is_empty() && !name.is_empty() {
            format!("{}\\{}", loc.trim_end_matches('\\'), name)
        } else {
            command.to_string()
        };
        return Some((
            StartupSource::StartupFolder,
            scope,
            approve,
            approve_name,
        ));
    }
    if loc_lower.contains("\\run") {
        let scope = if loc_lower.starts_with("hklm") || user.eq_ignore_ascii_case(".default") {
            StartupScope::Machine
        } else {
            StartupScope::User
        };
        let source = if loc_lower.contains("wow6432node") {
            StartupSource::RegistryRun32
        } else {
            StartupSource::RegistryRun
        };
        let approve_sub = if source == StartupSource::RegistryRun32 {
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run32"
        } else {
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"
        };
        let prefix = if scope == StartupScope::Machine {
            "HKLM"
        } else {
            "HKCU"
        };
        return Some((
            source,
            scope,
            format!("{prefix}\\{approve_sub}"),
            name.to_string(),
        ));
    }
    None
}

#[cfg(windows)]
fn enumerate_startup_folders(out: &mut Vec<RawStartupEntry>) {
    let user_startup = std::env::var("APPDATA")
        .ok()
        .map(|p| {
            PathBuf::from(p).join(
                r"Microsoft\Windows\Start Menu\Programs\Startup",
            )
        });
    if let Some(dir) = user_startup {
        let approve = user_startup_approve_path();
        scan_startup_dir(&dir, &approve, StartupScope::User, out);
    }

    if let Ok(pd) = std::env::var("ProgramData") {
        let dir = PathBuf::from(pd).join(r"Microsoft\Windows\Start Menu\Programs\Startup");
        let approve = machine_startup_approve_path();
        scan_startup_dir(&dir, &approve, StartupScope::Machine, out);
    }
}

#[cfg(windows)]
fn enumerate_packaged_startup(out: &mut Vec<RawStartupEntry>) {
    let approve = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupApproved";
    let values = enum_registry_values(
        windows::Win32::System::Registry::HKEY_CURRENT_USER,
        approve,
    );
    for (name, _data) in values {
        if name.is_empty() {
            continue;
        }
        let display = name.replace('!', " — ");
        out.push(RawStartupEntry {
            name: display,
            command: name.clone(),
            source: StartupSource::Packaged,
            scope: StartupScope::User,
            approve_registry_path: format!("HKCU\\{approve}"),
            approve_value_name: name,
        });
    }
}

#[cfg(windows)]
fn read_run_values(
    hive: windows::Win32::System::Registry::HKEY,
    run_subkey: &str,
    approve_subkey: &str,
    source: StartupSource,
    scope: StartupScope,
    out: &mut Vec<RawStartupEntry>,
) {
    let hive_prefix = hive_to_prefix(hive);
    let approve_path = format!("{hive_prefix}\\{approve_subkey}");
    for (name, command) in enum_registry_strings(hive, run_subkey) {
        out.push(RawStartupEntry {
            name: name.clone(),
            command,
            source,
            scope,
            approve_registry_path: approve_path.clone(),
            approve_value_name: name,
        });
    }
}

#[cfg(windows)]
fn scan_startup_dir(
    dir: &Path,
    approve_registry_path: &str,
    scope: StartupScope,
    out: &mut Vec<RawStartupEntry>,
) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let approve_path = approve_registry_path.to_string();
    for ent in entries.flatten() {
        let path = ent.path();
        let file_name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if file_name.is_empty() {
            continue;
        }
        let command = path.to_string_lossy().to_string();
        out.push(RawStartupEntry {
            name: file_name.trim_end_matches(".lnk").to_string(),
            command,
            source: StartupSource::StartupFolder,
            scope,
            approve_registry_path: approve_path.clone(),
            // Windows keys StartupApproved\StartupFolder by the bare .lnk
            // filename (e.g. "TickTick.lnk"), NOT the full path. Writing the
            // full path creates a value Windows ignores while the real entry
            // stays enabled. The full path is still kept in `command` for
            // shortcut resolution and "Open file location".
            approve_value_name: file_name,
        });
    }
}

#[cfg(windows)]
fn user_startup_approve_path() -> String {
    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder"
        .to_string()
}

fn normalize_approve_registry_path(path: &str) -> String {
    let p = path.replace('/', "\\");
    if let Some(rest) = p.strip_prefix("HKCU\\HKU\\") {
        return format!("HKU\\{rest}");
    }
    if let Some(rest) = p.strip_prefix("HKCU\\HKLM\\") {
        return format!("HKLM\\{rest}");
    }
    if p.starts_with("HKU\\") {
        if let Some(sid) = current_user_sid_for_approve() {
            let marker = format!("HKU\\{sid}\\");
            if let Some(rest) = p.strip_prefix(&marker) {
                return format!("HKCU\\{rest}");
            }
        }
    }
    p
}

#[cfg(windows)]
fn machine_startup_approve_path() -> String {
    r"HKLM\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder".to_string()
}

#[cfg(windows)]
fn current_user_sid_for_approve() -> Option<String> {
    use windows::Win32::Foundation::{CloseHandle, HLOCAL, LocalFree};
    use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows::Win32::Security::{
        GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token = windows::Win32::Foundation::HANDLE::default();
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

#[cfg(windows)]
fn hive_to_prefix(hive: windows::Win32::System::Registry::HKEY) -> &'static str {
    use windows::Win32::System::Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    if hive == HKEY_CURRENT_USER {
        "HKCU"
    } else if hive == HKEY_LOCAL_MACHINE {
        "HKLM"
    } else {
        "HKCU"
    }
}

#[cfg(windows)]
fn enum_registry_strings(
    hive: windows::Win32::System::Registry::HKEY,
    subkey: &str,
) -> Vec<(String, String)> {
    enum_registry_values(hive, subkey)
        .into_iter()
        .filter_map(|(name, data)| {
            let s = String::from_utf16_lossy(
                &data.chunks_exact(2)
                    .map(|c| u16::from_le_bytes([c[0], c[1]]))
                    .collect::<Vec<_>>(),
            );
            let trimmed = s.trim_end_matches('\0').to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some((name, trimmed))
            }
        })
        .collect()
}

#[cfg(windows)]
fn enum_registry_values(
    hive: windows::Win32::System::Registry::HKEY,
    subkey: &str,
) -> Vec<(String, Vec<u8>)> {
    use windows::Win32::Foundation::ERROR_NO_MORE_ITEMS;
    use windows::Win32::System::Registry::{RegCloseKey, RegEnumValueW, RegOpenKeyExW, KEY_READ};
    use windows::core::{PCWSTR, PWSTR};

    let sub_wide: Vec<u16> = subkey.encode_utf16().chain(std::iter::once(0)).collect();
    let mut hk = hive;
    let open = unsafe {
        RegOpenKeyExW(
            hive,
            PCWSTR::from_raw(sub_wide.as_ptr()),
            0,
            KEY_READ,
            &mut hk,
        )
    };
    if open.is_err() {
        return Vec::new();
    }

    let mut out = Vec::new();
    let mut idx = 0u32;
    loop {
        let mut name_buf = [0u16; 2048];
        let mut name_len = name_buf.len() as u32;
        let mut kind: u32 = 0;
        let mut data_len = 0u32;
        let res = unsafe {
            RegEnumValueW(
                hk,
                idx,
                PWSTR::from_raw(name_buf.as_mut_ptr()),
                &mut name_len,
                None,
                Some(&mut kind),
                None,
                Some(&mut data_len),
            )
        };
        if res == ERROR_NO_MORE_ITEMS {
            break;
        }
        if res.is_err() {
            idx += 1;
            continue;
        }
        // The size-query call above set `name_len` to the name's length
        // (without the null terminator). RegEnumValueW requires the in/out
        // length to be the *buffer capacity* on entry, so reset it — otherwise
        // the data-fetch call below sees a name buffer "too small" for the
        // terminator, returns ERROR_MORE_DATA, and the value is silently
        // skipped. (This made every registry read return nothing.)
        let mut data = vec![0u8; data_len as usize];
        name_len = name_buf.len() as u32;
        let res2 = unsafe {
            RegEnumValueW(
                hk,
                idx,
                PWSTR::from_raw(name_buf.as_mut_ptr()),
                &mut name_len,
                None,
                Some(&mut kind),
                Some(data.as_mut_ptr()),
                Some(&mut data_len),
            )
        };
        if res2.is_ok() {
            data.truncate(data_len as usize);
            let name = String::from_utf16_lossy(&name_buf[..name_len as usize]);
            out.push((name, data));
        }
        idx += 1;
    }
    unsafe {
        let _ = RegCloseKey(hk);
    }
    out
}

#[cfg(windows)]
fn parse_registry_path(path: &str) -> Option<(windows::Win32::System::Registry::HKEY, String)> {
    use windows::Win32::System::Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, HKEY_USERS};
    if let Some(rest) = path.strip_prefix("HKCU\\") {
        return Some((HKEY_CURRENT_USER, rest.to_string()));
    }
    if let Some(rest) = path.strip_prefix("HKLM\\") {
        return Some((HKEY_LOCAL_MACHINE, rest.to_string()));
    }
    if let Some(rest) = path.strip_prefix("HKU\\") {
        let parts: Vec<&str> = rest.splitn(2, '\\').collect();
        if parts.len() == 2 {
            return Some((HKEY_USERS, format!("{}\\{}", parts[0], parts[1])));
        }
    }
    None
}

#[cfg(windows)]
fn is_elevated_token() -> bool {
    crate::commands::oem::is_elevated()
}

#[cfg(windows)]
fn read_approve_blob(path: &str, value_name: &str) -> Option<Vec<u8>> {
    let resolved = resolve_approve_value_name(path, value_name)?;
    let (hive, sub) = parse_registry_path(path)?;
    for (name, data) in enum_registry_values(hive, &sub) {
        if name == resolved {
            return Some(data);
        }
    }
    None
}

fn resolve_approve_value_name(path: &str, proposed: &str) -> Option<String> {
    if proposed.is_empty() {
        return None;
    }
    let (hive, sub) = parse_registry_path(path)?;
    let values = enum_registry_values(hive, &sub);
    if values.iter().any(|(name, _)| name == proposed) {
        return Some(proposed.to_string());
    }
    for (name, _) in &values {
        if name.eq_ignore_ascii_case(proposed) {
            return Some(name.clone());
        }
    }
    let proposed_norm = normalize_path_key(proposed);
    if !proposed_norm.is_empty() {
        for (name, _) in &values {
            if normalize_path_key(name) == proposed_norm {
                return Some(name.clone());
            }
        }
        if let Some(leaf) = Path::new(proposed)
            .file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.to_lowercase())
        {
            for (name, _) in &values {
                let name_leaf = Path::new(name)
                    .file_name()
                    .and_then(|s| s.to_str())
                    .map(|s| s.to_lowercase());
                if name_leaf.as_deref() == Some(leaf.as_str()) {
                    return Some(name.clone());
                }
            }
        }
    }
    // Run-key entries: allow creating a new approval value with the proposed name.
    if !proposed.contains('\\') {
        return Some(proposed.to_string());
    }
    if values.is_empty() {
        return Some(proposed.to_string());
    }
    None
}

fn normalize_path_key(path: &str) -> String {
    path.replace('/', "\\").trim().to_lowercase()
}

fn commands_match(a: &str, b: &str) -> bool {
    if a.eq_ignore_ascii_case(b) {
        return true;
    }
    normalize_path_key(a) == normalize_path_key(b)
}

#[cfg(windows)]
fn write_approve_blob(path: &str, value_name: &str, blob: &[u8; 12]) -> Result<(), String> {
    use windows::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegSetValueExW, HKEY_LOCAL_MACHINE, KEY_SET_VALUE,
        KEY_WOW64_64KEY, REG_BINARY,
    };
    use windows::core::PCWSTR;

    let (hive, sub) = parse_registry_path(path).ok_or("Invalid approve registry path")?;
    let sub_wide: Vec<u16> = sub.encode_utf16().chain(std::iter::once(0)).collect();
    let mut access = KEY_SET_VALUE;
    if hive == HKEY_LOCAL_MACHINE {
        access |= KEY_WOW64_64KEY;
    }
    let mut hk = hive;
    let open = unsafe {
        RegOpenKeyExW(
            hive,
            PCWSTR::from_raw(sub_wide.as_ptr()),
            0,
            access,
            &mut hk,
        )
    };
    if open.is_err() {
        return Err(format!("Cannot open registry key for write: {path}"));
    }
    let name_wide: Vec<u16> = value_name.encode_utf16().chain(std::iter::once(0)).collect();
    let res = unsafe {
        RegSetValueExW(
            hk,
            PCWSTR::from_raw(name_wide.as_ptr()),
            0,
            REG_BINARY,
            Some(blob.as_slice()),
        )
    };
    unsafe {
        let _ = RegCloseKey(hk);
    }
    if res.is_err() {
        return Err(format!("RegSetValueExW failed: {res:?}"));
    }
    Ok(())
}

fn make_id(_exe_path: &str, approve_name: &str, approve_path: &str) -> String {
    format!("{approve_path}::{approve_name}").to_lowercase()
}

fn enrich_entry(command: &str) -> (String, String, String, String) {
    let resolved = resolve_command_to_path(command);
    let shell = crate::ffi::get_file_shell_info(&resolved);
    (
        shell.resolved_path,
        shell.icon_base64,
        shell.display_name,
        shell.company_name,
    )
}

fn resolve_command_to_path(command: &str) -> String {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.to_ascii_lowercase().ends_with(".lnk") {
        if let Some(target) = crate::ffi::resolve_shortcut_path(trimmed) {
            return target;
        }
    }
    parse_exe_from_command(trimmed)
}

fn parse_exe_from_command(cmd: &str) -> String {
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

fn load_installed_publishers() -> HashMap<String, String> {
    let mut map = HashMap::new();
    if let Ok(apps) = crate::ffi::load_installed_apps() {
        for app in apps {
            let publisher = app.publisher.clone();
            let key = app.install_location.to_lowercase();
            if !key.is_empty() {
                map.insert(key, publisher.clone());
            }
            map.insert(app.name.to_lowercase(), publisher);
        }
    }
    map
}

fn lookup_publisher(exe_path: &str, installed: &HashMap<String, String>) -> String {
    if exe_path.is_empty() {
        return String::new();
    }
    let lower = exe_path.to_lowercase();
    for (k, v) in installed {
        if !k.is_empty() && lower.contains(k) {
            return v.clone();
        }
    }
    Path::new(exe_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .and_then(|stem| installed.get(&stem.to_lowercase()))
        .cloned()
        .unwrap_or_default()
}

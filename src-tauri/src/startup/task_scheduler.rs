//! Logon / boot scheduled tasks (read-only; separate from Run-key startup list).

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct LogonScheduledTaskInfo {
    pub name: String,
    pub path: String,
    pub author: String,
    pub trigger: String,
    pub exe_path: String,
    pub enabled: bool,
}

#[cfg(windows)]
pub fn enumerate_logon_tasks() -> Vec<LogonScheduledTaskInfo> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let script = r#"
$ErrorActionPreference = 'SilentlyContinue'
Get-ScheduledTask |
  Where-Object {
    $_.State -ne 'Disabled' -and $_.TaskPath -notlike '\Microsoft\*'
  } |
  ForEach-Object {
    $t = $_
    $triggers = @($t.Triggers | ForEach-Object { $_.CimClass.CimClassName })
    $isLogon = $false
    foreach ($tr in $triggers) {
      if ($tr -match 'Logon|Boot|SessionStateChange') { $isLogon = $true; break }
    }
    if (-not $isLogon) { return }
    $action = ($t.Actions | Select-Object -First 1)
    $exe = ''
    if ($action) { $exe = [string]$action.Execute }
    [PSCustomObject]@{
      Name = [string]$t.TaskName
      Path = [string]$t.TaskPath
      Author = [string]$t.Author
      Trigger = ($triggers -join ',')
      ExePath = $exe
      Enabled = ($t.State -eq 'Ready' -or $t.State -eq 'Running')
    }
  } |
  ConvertTo-Json -Compress
"#;

    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    let Ok(out) = output else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        return Vec::new();
    }
    parse_task_json(&text)
}

#[cfg(not(windows))]
pub fn enumerate_logon_tasks() -> Vec<LogonScheduledTaskInfo> {
    Vec::new()
}

#[cfg(windows)]
fn parse_task_json(text: &str) -> Vec<LogonScheduledTaskInfo> {
    let value: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let arr = match value {
        serde_json::Value::Array(a) => a,
        serde_json::Value::Object(_) => vec![value],
        _ => return Vec::new(),
    };
    arr.into_iter()
        .filter_map(|row| {
            let name = row.get("Name")?.as_str()?.to_string();
            if name.is_empty() {
                return None;
            }
            Some(LogonScheduledTaskInfo {
                name,
                path: row
                    .get("Path")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                author: row
                    .get("Author")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                trigger: row
                    .get("Trigger")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                exe_path: row
                    .get("ExePath")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                enabled: row
                    .get("Enabled")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true),
            })
        })
        .collect()
}

#[cfg(windows)]
pub fn set_logon_task_enabled(path: &str, name: &str, enabled: bool) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    if name.is_empty() {
        return Err("Scheduled task name is required.".into());
    }
    let task_path = if path.is_empty() { "\\" } else { path };
    let name_esc = name.replace('\'', "''");
    let path_esc = task_path.replace('\'', "''");
    let verb = if enabled { "Enable-ScheduledTask" } else { "Disable-ScheduledTask" };
    let script = format!(
        "$ErrorActionPreference = 'Stop'; {verb} -TaskName '{name_esc}' -TaskPath '{path_esc}' | Out-Null"
    );
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Failed to run PowerShell: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        format!("Failed to {} scheduled task '{name}'", if enabled { "enable" } else { "disable" })
    } else {
        stderr
    })
}

#[cfg(not(windows))]
pub fn set_logon_task_enabled(_path: &str, _name: &str, _enabled: bool) -> Result<(), String> {
    Err("Scheduled task control is only supported on Windows.".into())
}

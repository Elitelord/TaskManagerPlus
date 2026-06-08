#[cfg(windows)]
use crate::startup::{self, StartupAppsResponse};

#[cfg(not(windows))]
use crate::startup::StartupAppsResponse;

// async + spawn_blocking so the registry/WDI/PowerShell work doesn't block the
// Tauri main thread. Matches the pattern used by get_processes / get_installed_apps.
#[tauri::command]
pub async fn get_startup_apps() -> StartupAppsResponse {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(startup::list_startup_apps)
            .await
            .unwrap_or_else(|_| StartupAppsResponse {
                apps: vec![],
                impact_available: false,
                boot_trace: vec![],
                logon_tasks: vec![],
            })
    }
    #[cfg(not(windows))]
    {
        StartupAppsResponse {
            apps: vec![],
            impact_available: false,
            boot_trace: vec![],
            logon_tasks: vec![],
        }
    }
}

#[tauri::command]
pub async fn set_logon_task_enabled(
    path: String,
    name: String,
    enabled: bool,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            startup::set_logon_task_enabled(&path, &name, enabled)
        })
        .await
        .map_err(|e| format!("join error: {e}"))?
    }
    #[cfg(not(windows))]
    {
        let _ = (path, name, enabled);
        Err("Scheduled task control is only supported on Windows.".into())
    }
}

#[tauri::command]
pub async fn set_startup_enabled(id: String, enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || startup::set_startup_enabled(&id, enabled))
            .await
            .map_err(|e| format!("join error: {e}"))?
    }
    #[cfg(not(windows))]
    {
        let _ = (id, enabled);
        Err("Startup control is only supported on Windows.".into())
    }
}

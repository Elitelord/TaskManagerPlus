// Z1-A — persistent config the MCP sidecar reads at startup to decide
// which tools to register.
//
// Today there's exactly one flag: `destructive_enabled`. When true, the
// sidecar exposes end_process, recycle_files, and empty_recycle_bin.
// When false (default), those tools are not registered at all — the AI
// cannot discover or call them.
//
// Read/write split:
//   * Settings UI writes the file via the Tauri command in
//     `commands::mcp_config_cmd` (current app process, has AppHandle).
//   * Sidecar binary reads it at startup via
//     `config_path_from_localappdata` (no AppHandle available).
// Sidecar reads ONCE at startup, so toggling the flag requires the user
// to restart their MCP client to pick up the change. We document that
// next to the toggle.
//
// Failure mode: any read/parse error returns `McpConfig::default()` —
// which has `destructive_enabled: false`. Corrupt or absent config can
// never accidentally enable destructive tools.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const CONFIG_FILENAME: &str = "mcp_config.json";
const APP_DATA_DIR_NAME: &str = "com.taskmanagerplus.app";

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct McpConfig {
    /// Master switch for the destructive tool group.
    /// Defaults to `false` everywhere (default-derived, missing field
    /// in JSON, missing file). Flipping it requires a Settings-page
    /// click + MCP client restart.
    #[serde(default)]
    pub destructive_enabled: bool,
}

/// Resolve the config file path under `%LOCALAPPDATA%\com.taskmanagerplus.app\`.
/// Used by the sidecar binary (no AppHandle available).
pub fn config_path_from_localappdata() -> Result<PathBuf, String> {
    let base = std::env::var("LOCALAPPDATA")
        .map_err(|e| format!("no LOCALAPPDATA: {e}"))?;
    Ok(PathBuf::from(base)
        .join(APP_DATA_DIR_NAME)
        .join(CONFIG_FILENAME))
}

/// Resolve the config file path given an explicit app-data base.
/// Used by the Tauri command layer where `app.path().app_local_data_dir()`
/// already resolved the per-app directory.
pub fn config_path_at(base: &Path) -> PathBuf {
    base.join(CONFIG_FILENAME)
}

pub fn load(path: &Path) -> McpConfig {
    let Ok(text) = std::fs::read_to_string(path) else {
        return McpConfig::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

pub fn save(path: &Path, config: &McpConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create_dir_all {}: {e}", parent.display()))?;
    }
    let text =
        serde_json::to_string_pretty(config).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(path, text).map_err(|e| format!("write {}: {e}", path.display()))
}

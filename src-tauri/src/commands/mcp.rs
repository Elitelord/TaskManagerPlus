// Y2-A — settings-UI support for MCP. The MCP server itself lives in
// the standalone `tmp_mcp` sidecar binary; this module exposes one
// Tauri command so the settings page can show users the exact path
// they need to paste into their MCP client config (Claude Desktop,
// Claude Code, Cursor, ...).
//
// Path varies: in dev the sidecar is alongside the dev exe in
// target/{debug,release}/; once installed Tauri places bundled
// resources under `<install>/resources/`. We probe both and return
// whichever resolves first.

use std::path::PathBuf;

use tauri::{path::BaseDirectory, AppHandle, Manager};

/// Absolute path to the bundled `tmp_mcp.exe` sidecar, or `None` if it
/// can't be located (dev build that wasn't `cargo build --bin tmp_mcp`,
/// for example). Returning None lets the UI show a "build the sidecar
/// first" hint in dev rather than a misleading wrong-path snippet.
#[tauri::command]
pub fn mcp_sidecar_path(app: AppHandle) -> Option<String> {
    // Probe each candidate; first one that exists wins. Order matters:
    // bundled resource → same-profile sibling → cross-profile sibling.
    // The cross-profile probe is what makes `tauri dev` (which runs the
    // app in target/debug/) find a tmp_mcp.exe the user built via
    // `cargo build --release --bin tmp_mcp` (target/release/).
    let cur_exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(PathBuf::from));
    let cross_profile_dir = cur_exe_dir.as_deref().and_then(|d| match d.file_name()?.to_str()? {
        "debug" => d.parent().map(|p| p.join("release")),
        "release" => d.parent().map(|p| p.join("debug")),
        _ => None,
    });

    let candidates: Vec<PathBuf> = [
        // Installed bundle: alongside the main exe under resources/.
        app.path()
            .resolve("tmp_mcp.exe", BaseDirectory::Resource)
            .ok(),
        // Dev / portable: sibling of the running exe under the same
        // profile dir (target/debug/ or target/release/).
        cur_exe_dir.as_ref().map(|d| d.join("tmp_mcp.exe")),
        // Dev convenience: the opposite profile dir, so `tauri dev` +
        // `cargo build --release --bin tmp_mcp` works without users
        // having to rebuild the sidecar in debug mode.
        cross_profile_dir.map(|d| d.join("tmp_mcp.exe")),
    ]
    .into_iter()
    .flatten()
    .collect();

    candidates
        .into_iter()
        .find(|p| p.exists())
        .map(|p| strip_extended_prefix(&p.to_string_lossy()))
}

/// Strip Windows' `\\?\` extended-length path prefix so the snippet
/// shown to users / pasted into client configs reads cleanly. The
/// prefix is correct (paths over 260 chars need it) but Windows
/// handles its absence transparently for normal-length paths, and
/// some shells / JSON tooling mishandle the backslash escaping. We
/// only strip the verbatim ASCII prefix, not the UNC form
/// (`\\?\UNC\server\share`) — those are rare for our use case
/// (local exe paths) and round-tripping them is messier.
fn strip_extended_prefix(s: &str) -> String {
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        // UNC under verbatim is `\\?\UNC\...` — leave that alone.
        if !rest.starts_with("UNC\\") {
            return rest.to_string();
        }
    }
    s.to_string()
}

// =============================================================
// Y2-A automation — one-click install for known MCP clients. The
// settings card surfaces these as buttons when the corresponding
// client is detected; users without those clients still see the
// copy-paste snippets unchanged.
// =============================================================

/// Reports which MCP clients we can offer one-click install for on
/// this machine. Cheap to call (one PATH lookup + one dir stat).
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpClientAvailability {
    pub claude_code: bool,
    pub claude_desktop: bool,
}

#[tauri::command]
pub fn mcp_clients_available() -> McpClientAvailability {
    McpClientAvailability {
        claude_code: which_claude_cli().is_some(),
        claude_desktop: claude_desktop_config_path().is_some(),
    }
}

fn which_claude_cli() -> Option<std::path::PathBuf> {
    // `where` on Windows is the moral equivalent of `which`; first
    // line of stdout is the resolved path. CreateNoWindow flag keeps
    // a console window from blinking during the lookup.
    use std::os::windows::process::CommandExt;
    let output = std::process::Command::new("where")
        .arg("claude")
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let first = std::str::from_utf8(&output.stdout)
        .ok()?
        .lines()
        .next()?
        .trim();
    if first.is_empty() {
        None
    } else {
        Some(std::path::PathBuf::from(first))
    }
}

fn claude_desktop_config_path() -> Option<std::path::PathBuf> {
    // %APPDATA% only exists when Claude Desktop has been launched
    // at least once (the installer creates the directory the first
    // time it runs). Use that as the availability signal — if the
    // dir doesn't exist, the user doesn't have Claude Desktop set
    // up and our "install" would just create orphan files.
    let appdata = std::env::var_os("APPDATA")?;
    let dir = std::path::PathBuf::from(appdata).join("Claude");
    if dir.exists() {
        Some(dir.join("claude_desktop_config.json"))
    } else {
        None
    }
}

/// One-click install for Claude Code via the `claude mcp add` CLI.
/// User-scoped install (visible across all of their Claude Code
/// projects). The CLI handles config-file merging for us, so this
/// is the safer of the two automation paths.
#[tauri::command]
pub fn mcp_install_claude_code(app: AppHandle) -> Result<(), String> {
    let sidecar = mcp_sidecar_path(app).ok_or_else(|| {
        "Sidecar binary not found. In a dev build, run \
         `cargo build --release --bin tmp_mcp` from src-tauri/ first."
            .to_string()
    })?;
    if which_claude_cli().is_none() {
        return Err(
            "Claude Code CLI not found on PATH. Install Claude Code or paste \
             the snippet manually."
                .to_string(),
        );
    }

    // Claude Code's installer drops a `claude.cmd` (or `.ps1`) shim on
    // PATH rather than a `.exe`, so invoking it directly via
    // CreateProcess hits ERROR_BAD_EXE_FORMAT (error 193). Going
    // through `cmd /C` lets the shell handle PATHEXT lookup, which is
    // what it's for. The trailing args are passed through unchanged.
    use std::os::windows::process::CommandExt;
    let output = std::process::Command::new("cmd")
        .args([
            "/C",
            "claude",
            "mcp",
            "add",
            "taskmanagerplus",
            "--scope",
            "user",
            &sidecar,
        ])
        .creation_flags(0x08000000)
        .output()
        .map_err(|e| format!("failed to invoke claude CLI: {e}"))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        // `claude mcp add` returns non-zero if a server with the same
        // name already exists. Surface a friendlier message in that case.
        if err.contains("already exists") {
            return Err("taskmanagerplus is already configured in Claude Code. \
                        Restart Claude Code to pick up any changes."
                .into());
        }
        return Err(format!("claude mcp add failed: {}", err.trim()));
    }
    Ok(())
}

/// One-click install for Claude Desktop. Reads the existing config,
/// merges our `mcpServers.taskmanagerplus` entry, writes it back.
/// Backs up the previous contents to `claude_desktop_config.json.bak`
/// before overwriting so a malformed merge is recoverable.
#[tauri::command]
pub fn mcp_install_claude_desktop(app: AppHandle) -> Result<(), String> {
    let sidecar = mcp_sidecar_path(app).ok_or_else(|| {
        "Sidecar binary not found. In a dev build, run \
         `cargo build --release --bin tmp_mcp` from src-tauri/ first."
            .to_string()
    })?;
    let config_path = claude_desktop_config_path().ok_or_else(|| {
        "Claude Desktop config directory not found. Install Claude Desktop \
         and launch it at least once before using this button."
            .to_string()
    })?;

    // Read existing config; treat "doesn't exist" + "exists-but-empty"
    // as starting from a fresh empty object.
    let existing = std::fs::read_to_string(&config_path).unwrap_or_default();
    let mut root: serde_json::Value = if existing.trim().is_empty() {
        serde_json::json!({})
    } else {
        // Don't silently destroy a malformed config — back it up + bail.
        serde_json::from_str(&existing).map_err(|e| {
            let _ = std::fs::write(config_path.with_extension("json.bak"), &existing);
            format!(
                "Claude Desktop config is not valid JSON ({e}). \
                 Original copied to claude_desktop_config.json.bak; fix it \
                 manually or paste the snippet."
            )
        })?
    };

    // Make sure mcpServers exists and is an object.
    let mcp_servers = root
        .as_object_mut()
        .ok_or_else(|| "Claude Desktop config root is not a JSON object.".to_string())?
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}));
    let servers_obj = mcp_servers
        .as_object_mut()
        .ok_or_else(|| "Claude Desktop `mcpServers` is not an object.".to_string())?;
    servers_obj.insert(
        "taskmanagerplus".to_string(),
        serde_json::json!({ "command": sidecar }),
    );

    // Back up the pre-change file (idempotent — overwrites a prior
    // .bak so users always have the most recent baseline).
    if !existing.is_empty() {
        let _ = std::fs::write(config_path.with_extension("json.bak"), &existing);
    }
    let serialized = serde_json::to_string_pretty(&root)
        .map_err(|e| format!("failed to serialize merged config: {e}"))?;
    std::fs::write(&config_path, serialized).map_err(|e| {
        format!("failed to write {}: {e}", config_path.display())
    })?;
    Ok(())
}

// Y2-A — MCP sidecar binary. Bundled alongside the main app via
// tauri.conf.json `resources` and configured into a user's MCP client
// directly (Claude Desktop / Cursor / Cline / Claude Code).
//
// Console subsystem on purpose — `taskmanagerplus.exe` runs with
// `windows_subsystem = "windows"` (no console), but MCP-over-stdio
// needs working stdin/stdout, which we get for free on a console exe.
// No console window appears because the MCP client launches us
// non-interactively (its child process inherits no console window).
//
// Logging goes to stderr per MCP protocol — stdout is the JSON-RPC
// channel. Tracing format keeps ANSI off in case the client redirects
// stderr to a log file.

#[cfg(windows)]
use anyhow::Result;

#[cfg(windows)]
#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();
    taskmanagerplus_lib::mcp::serve_stdio().await
}

// Non-Windows: stub. The lib's mcp module is `#[cfg(windows)]`, so this
// binary has nothing to do off Windows. Keeps cross-compile sanity.
#[cfg(not(windows))]
fn main() {
    eprintln!("tmp_mcp is Windows-only.");
    std::process::exit(1);
}

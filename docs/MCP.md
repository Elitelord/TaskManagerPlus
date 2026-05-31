# TaskManager+ MCP Server

TaskManager+ ships an optional **Model Context Protocol** server that
lets MCP-compatible AI assistants (Claude Desktop, Claude Code, Cursor,
Cline, Zed, Continue.dev, …) read system telemetry on demand.

Once configured, an assistant can answer questions like *"what's eating
my disk?"* or *"which processes are using the most memory right now?"*
by calling into the same data sources the TaskManager+ UI uses.

The integration is **read-only and opt-in**. The server runs as a small
sidecar binary (`tmp_mcp.exe`) that the MCP client launches directly
over stdio. TaskManager+ itself never sends data anywhere — what the
connected client does with the data is governed by the client's own
privacy settings.

---

## Quick start

1. Open TaskManager+ → **Settings** → **AI Assistant Integration (MCP)**.
2. Toggle on **"Show connection instructions for AI clients"**.
3. Copy the snippet for your client and paste it into that client's
   config.
4. Restart the client (Claude Desktop, etc. — Claude Code picks up
   changes on the next session).

That's it. No daemon, no port to open, no token to manage. The MCP
client spawns the sidecar when it connects, and tears it down when it
disconnects.

---

## Tool surface

All tools are **read-only**. Destructive operations (ending processes,
moving files, emptying the recycle bin) are not exposed in this
release; a future minor version will add them behind a separate opt-in
toggle with per-operation confirmation.

| Tool | Args | What it returns |
| --- | --- | --- |
| `get_processes` | `limit?: number` (default 25) | Top processes by private memory: PID, name, display_name, private + working-set MB, company_name, product_name, image_path, window_title, process_type. Icon data is stripped server-side so chat output stays readable. |
| `get_performance_snapshot` | — | One snapshot: CPU % + base/max frequency, RAM totals + commit + cache breakdown, disk read/write + active %, network up/down + link speed, GPU + NPU usage, battery state, thermal + fan, cache sizes. |
| `get_storage_volumes` | — | All mounted volumes: drive letter, label, filesystem, media kind (hdd/ssd/nvme/usb/network/optical/virtual), total + free bytes, current read/write/active %. |
| `get_top_folders` | `root: string`, `max?: number` (default 15) | Top N folders under `root` by size on disk. Walks recursively, de-duplicates parent-vs-child so a single chain doesn't fill the result. Returns path, display_name, size_bytes, file_count. |
| `get_installed_apps` | — | Installed Win32 + UWP apps: name, publisher, version, install_date, install_location, on-disk size with attribution (`measured_total`, `measured_install`, `registry`, …), install_bytes vs data_bytes split. |
| `get_system_info` | — | Condensed top-line system state: RAM in use, CPU %, battery, process count, total disk + network throughput. A low-cost "is the system busy?" check before drilling in. |
| `detect_projects` | `root: string` | Dev projects under `root`, found via marker files (`.git`, `package.json`, `Cargo.toml`, `pyproject.toml`, …). Returns path, project_type, display_name, size_bytes, file_count. |

The sidecar primes its performance counters at startup (one throwaway
sample + ~750 ms pause) so the first `get_performance_snapshot` call
returns a sane CPU %. Without that warm-up, PDH counters have no
previous sample to diff against and CPU % would read as 100 % on the
first call.

---

## Client-specific setup

### Claude Code (terminal)

```powershell
claude mcp add taskmanagerplus "<path-to-tmp_mcp.exe>"
```

Paste the path the Settings card shows you. Then open a fresh `claude`
session — MCP servers attach at session start, so the current session
won't see it.

Verify with:

```powershell
claude mcp list
```

`taskmanagerplus` should appear with status `✓ Connected`.

### Claude Desktop

Edit `%APPDATA%\Claude\claude_desktop_config.json`. If the file
doesn't exist, create it. Merge into your existing config — don't
overwrite — keeping any `mcpServers` your other servers use:

```json
{
  "mcpServers": {
    "taskmanagerplus": {
      "command": "<path-to-tmp_mcp.exe>"
    }
  }
}
```

Then fully quit Claude Desktop (the tray icon too, not just the
window) and relaunch.

### Cursor, Cline, Continue.dev, Zed

These clients also support local stdio MCP servers. The exact config
file differs (`~/.cursor/config.json`, `.continue/config.json`, …) but
the shape is the same — point `command` at the sidecar path the
Settings card shows.

---

## Privacy and security

- **TaskManager+ does not call out to the network.** No telemetry is
  sent from the app. The MCP path is in-process between TaskManager+
  and your MCP client.
- **What flows out of the device is the client's responsibility.** If
  the MCP client you connect (e.g. Claude Desktop) forwards your
  conversation to a hosted model, the tool results are part of that
  conversation. Whether that happens is governed by the client's
  privacy settings, not TaskManager+'s.
- **All exposed tools are read-only.** This release of the MCP server
  does not expose `end_process`, `move_files`, `recycle_files`, or any
  other mutating operation. A future minor will add them as a separate
  opt-in toggle with per-call confirmation.
- **The sidecar runs only when a client connects.** It's not a
  background service. Closing the client closes the sidecar.
- **The connection is local.** Stdio transport — no socket, no port
  open to the network or even to localhost listeners.

---

## Troubleshooting

**Tool doesn't appear in the client's tool list.**
Make sure you restarted the client after editing config. Claude
Desktop needs a full quit including the tray icon. Claude Code attaches
MCP servers per-session, so open a new terminal.

**Client logs an error launching the server.**
Verify the path in your config matches what the TaskManager+ Settings
card shows. Backslashes need to be doubled in JSON
(`"C:\\Users\\…"`); shells take them single. If TaskManager+ was
moved or reinstalled, the path may have changed.

**`get_performance_snapshot` returns 100 % CPU on the first call.**
You're running an outdated sidecar. The warm-up that fixes this
landed in v2.0.0; update.

**Tool calls hang.**
Check that the binary is `tmp_mcp.exe`, not the main `taskmanagerplus.exe`.
The main exe is GUI-subsystem and has no working stdin/stdout; only
the sidecar can speak MCP over stdio.

---

## What this is not (yet)

- **Destructive operations.** No `end_process`, no file mutation.
  Planned for a follow-up release behind a separate consent gate.
- **HTTP transport.** Stdio only for now. If a client needs HTTP+SSE,
  file an issue with the use case.
- **Persistent state.** Each tool call is independent; the sidecar
  doesn't remember previous queries within a session.
- **Auth or rate limiting.** Stdio is point-to-point with the client,
  so neither is meaningful here. If/when an HTTP transport lands,
  bearer-token auth comes with it.

// Y2-A — MCP server runtime. Exposes a curated read-only subset of the
// app's telemetry (processes, performance snapshot, ...) to MCP clients
// over stdio. Driven by the `tmp_mcp` sidecar binary (`src/bin/tmp_mcp.rs`)
// which gets bundled into the installer; MCP clients launch that binary
// directly and talk JSON-RPC over its stdin/stdout.
//
// The Phase 6 Y2 spike (scripts/ml/mcp_probe/) validated this exact
// `rmcp` + `#[tool_router]` + stdio pattern end-to-end with Claude Code.
// Production differences from the spike:
//   - Data sources are `ffi.rs` (real Windows telemetry), not `sysinfo`.
//   - icon_base64 is stripped from process info before serialization —
//     useless to a calling LLM and bloats every response by 10-100 KB.
//   - FFI calls run on `spawn_blocking` so the MCP async runtime isn't
//     starved by synchronous Win32 work.
//
// Privacy contract: every tool here is read-only. Destructive operations
// (end_process, move_files, recycle_files) are NOT exposed in Y2-A. They
// land in Y2-B behind a separate user opt-in with per-call confirmation.

#![cfg(windows)]

use std::sync::Arc;

use anyhow::Result;
use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{ServerCapabilities, ServerInfo},
    tool, tool_handler, tool_router,
    transport::stdio,
    ServerHandler, ServiceExt,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::ffi;

// ---------------------------------------------------------------------------
// Tool response shapes.
//
// Mirrors `ffi::ProcessInfo` / `ffi::PerformanceSnapshot` minus fields that
// would waste tokens in a chat client. The serde rename layer keeps the
// snake_case JSON the rest of the app emits, so MCP output is consistent
// with what users see in DevTools.
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
struct McpProcess {
    pid: u32,
    name: String,
    display_name: String,
    private_mb: f64,
    working_set_mb: f64,
    company_name: String,
    product_name: String,
    image_path: String,
    window_title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    process_type: Option<String>,
}

impl From<ffi::ProcessInfo> for McpProcess {
    fn from(p: ffi::ProcessInfo) -> Self {
        // icon_base64 + page_faults + shared_mb + private_working_set_mb are
        // intentionally dropped — chat clients render a few KB per process
        // row at most before going unreadable, and an LLM doesn't get value
        // from per-process page-fault counters.
        Self {
            pid: p.pid,
            name: p.name,
            display_name: p.display_name,
            private_mb: p.private_mb,
            working_set_mb: p.working_set_mb,
            company_name: p.company_name,
            product_name: p.product_name,
            image_path: p.image_path,
            window_title: p.window_title,
            process_type: p.process_type,
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
struct GetProcessesArgs {
    /// Maximum number of processes to return, sorted by private memory
    /// descending. Defaults to 25 when omitted — keeps chat output compact.
    /// Set to 0 for "no limit" (returns everything; can be ~200+ rows).
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct GetTopFoldersArgs {
    /// Root folder to scan (e.g. "C:\\Users\\Samee\\Documents"). Required.
    /// The scan walks immediate children only — it doesn't recurse beyond
    /// the first level. To explore deeper, call again with a child path.
    root: String,
    /// Maximum number of folders to return, sorted by size descending.
    /// Defaults to 15.
    #[serde(default)]
    max: Option<i32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct DetectProjectsArgs {
    /// Root folder to walk looking for dev projects (presence of `.git`,
    /// `package.json`, `Cargo.toml`, `pyproject.toml`, etc.). Required.
    /// Recurses up to a fixed depth — does not walk the whole drive.
    root: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct GetRecentFilesArgs {
    /// Root folder to scan. Required. Scan is recursive but capped at
    /// a fixed depth and file count so it doesn't run away on /Users.
    root: String,
    /// Maximum number of files to return, sorted by mtime descending
    /// (most recent first). Defaults to 25.
    #[serde(default)]
    max: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct GetTopProcessesByArgs {
    /// What to sort by: "memory" | "cpu" | "disk" | "network" | "gpu".
    /// "memory" is the same as get_processes's default ordering.
    by: String,
    /// Maximum number of processes to return. Defaults to 10.
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Serialize, Clone, Debug)]
struct RecentFile {
    path: String,
    size_bytes: u64,
    modified_unix_secs: i64,
}

#[derive(Serialize, Clone, Debug)]
struct TopProcessByMetric {
    pid: u32,
    name: String,
    /// The metric value for the requested sort. Units differ by `by`:
    ///   memory → MB private
    ///   cpu    → percent (0-100, averaged over the sample window the
    ///            DLL maintains)
    ///   disk   → bytes/sec read+write
    ///   network→ bytes/sec sent+received
    ///   gpu    → percent across engines
    metric_value: f64,
    /// Human label of the unit so the AI doesn't have to guess.
    metric_unit: &'static str,
}

// ---------------------------------------------------------------------------
// Server state. Mutex is currently unused but reserved for Y2-B caches
// (e.g. memoizing a recent storage scan across tool calls).
// ---------------------------------------------------------------------------

#[derive(Clone, Default)]
struct McpState {
    _reserved: Arc<Mutex<()>>,
}

#[derive(Clone)]
pub struct McpServer {
    _state: McpState,
    tool_router: ToolRouter<McpServer>,
}

impl McpServer {
    pub fn new() -> Self {
        Self {
            _state: McpState::default(),
            tool_router: Self::tool_router(),
        }
    }
}

impl Default for McpServer {
    fn default() -> Self {
        Self::new()
    }
}

#[tool_router]
impl McpServer {
    #[tool(
        description = "List running Windows processes. Returns PID, executable name, \
                       display name, private/working-set memory in MB, publisher \
                       (company_name + product_name from the PE version resource), \
                       full image path, and the best top-level window title (empty \
                       for services/background helpers). Sorted by private memory \
                       descending. Read-only; safe to call repeatedly."
    )]
    async fn get_processes(
        &self,
        Parameters(args): Parameters<GetProcessesArgs>,
    ) -> Result<String, String> {
        let limit = args.limit.unwrap_or(25);
        // ffi::load_process_list is synchronous Win32 work that can take a
        // few hundred ms on busy systems; keep it off the async pool.
        let processes = tokio::task::spawn_blocking(ffi::load_process_list)
            .await
            .map_err(|e| format!("join error: {e}"))?
            .map_err(|e| format!("load_process_list: {e}"))?;
        let mut procs: Vec<McpProcess> = processes.into_iter().map(McpProcess::from).collect();
        procs.sort_by(|a, b| {
            b.private_mb
                .partial_cmp(&a.private_mb)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        if limit > 0 {
            procs.truncate(limit);
        }
        serde_json::to_string_pretty(&procs).map_err(|e| e.to_string())
    }

    #[tool(
        description = "Snapshot of system-wide performance counters: CPU %, core/thread \
                       count, CPU frequency (current/base/max), RAM totals + commit + \
                       cache breakdown, disk read/write/active%, network up/down + link \
                       speed, GPU usage + memory (dedicated + shared), NPU presence + \
                       usage, battery state, thermal/fan, total handle/thread counts, \
                       cache sizes. One sample, not a stream. Mirrors what the app's \
                       performance pages display."
    )]
    async fn get_performance_snapshot(&self) -> Result<String, String> {
        let snap = tokio::task::spawn_blocking(ffi::load_performance_snapshot)
            .await
            .map_err(|e| format!("join error: {e}"))?
            .map_err(|e| format!("load_performance_snapshot: {e}"))?;
        serde_json::to_string_pretty(&snap).map_err(|e| e.to_string())
    }

    #[tool(
        description = "List all mounted volumes: drive letter, label, filesystem (NTFS/\
                       ReFS/exFAT/...), media kind (hdd/ssd/nvme/usb/network/optical/\
                       virtual), total/free bytes, current read/write/active%, queue \
                       depth, whether the volume is the system drive and whether it's \
                       read-only. Returns ALL drives, not a sample. Read-only."
    )]
    async fn get_storage_volumes(&self) -> Result<String, String> {
        let vols = tokio::task::spawn_blocking(ffi::load_storage_volumes)
            .await
            .map_err(|e| format!("join error: {e}"))?
            .map_err(|e| format!("load_storage_volumes: {e}"))?;
        serde_json::to_string_pretty(&vols).map_err(|e| e.to_string())
    }

    #[tool(
        description = "Top N folders under `root` (anywhere in the tree, not just \
                       immediate children) by total size on disk. Returns path, \
                       display_name (path relative to root), size_bytes, file_count \
                       for each. Useful for 'what's eating my disk under Users\\Me?' \
                       — entries are de-duplicated parent-vs-child so a single chain \
                       doesn't fill the result list. Read-only enumeration."
    )]
    async fn get_top_folders(
        &self,
        Parameters(args): Parameters<GetTopFoldersArgs>,
    ) -> Result<String, String> {
        let max = args.max.unwrap_or(15);
        let folders = tokio::task::spawn_blocking(move || ffi::load_top_folders(&args.root, max))
            .await
            .map_err(|e| format!("join error: {e}"))?
            .map_err(|e| format!("load_top_folders: {e}"))?;
        serde_json::to_string_pretty(&folders).map_err(|e| e.to_string())
    }

    #[tool(
        description = "All installed Windows applications (both Win32 from the registry \
                       and UWP/Microsoft Store apps): name, publisher, version, install \
                       date, on-disk size, install location, install vs data footprint \
                       split, and size source ('measured_total' is real walks, \
                       'registry' is the registry's own estimate). Useful for 'what \
                       can I uninstall to reclaim space?'. Read-only."
    )]
    async fn get_installed_apps(&self) -> Result<String, String> {
        let apps = tokio::task::spawn_blocking(ffi::load_installed_apps)
            .await
            .map_err(|e| format!("join error: {e}"))?
            .map_err(|e| format!("load_installed_apps: {e}"))?;
        serde_json::to_string_pretty(&apps).map_err(|e| e.to_string())
    }

    #[tool(
        description = "Top-line system info: RAM in use, CPU %, battery state, process \
                       count, total disk and network throughput. A condensed version of \
                       get_performance_snapshot, useful as a low-cost 'is the system \
                       busy?' check before drilling in. Read-only."
    )]
    async fn get_system_info(&self) -> Result<String, String> {
        let info = tokio::task::spawn_blocking(ffi::load_system_info)
            .await
            .map_err(|e| format!("join error: {e}"))?
            .map_err(|e| format!("load_system_info: {e}"))?;
        serde_json::to_string_pretty(&info).map_err(|e| e.to_string())
    }

    #[tool(
        description = "Heuristically detect dev/code projects under `root` by looking \
                       for telltale files (.git, package.json, Cargo.toml, \
                       pyproject.toml, *.csproj, etc.). Returns path, project_type, \
                       display_name, size_bytes, file_count. Recurses to a fixed depth \
                       — not a whole-drive scan. Useful for 'what projects do I have?' \
                       and 'which take the most disk?'. Read-only."
    )]
    async fn detect_projects(
        &self,
        Parameters(args): Parameters<DetectProjectsArgs>,
    ) -> Result<String, String> {
        let projects = tokio::task::spawn_blocking(move || ffi::load_detected_projects(&args.root))
            .await
            .map_err(|e| format!("join error: {e}"))?
            .map_err(|e| format!("load_detected_projects: {e}"))?;
        serde_json::to_string_pretty(&projects).map_err(|e| e.to_string())
    }

    #[tool(
        description = "One-shot 'tell me about this computer' snapshot. Bundles the \
                       top 10 processes by memory, the system-wide performance snapshot \
                       (CPU/RAM/disk/network/GPU/NPU/battery), and all mounted volumes \
                       into a single JSON object. Saves the AI from chaining three \
                       separate tool calls for 'what's going on with my system?' Read-only."
    )]
    async fn system_snapshot(&self) -> Result<String, String> {
        // Run all three in one blocking task — they're independent reads
        // and we'd serialise them anyway because the underlying DLL holds
        // a write lock for each call.
        let bundle = tokio::task::spawn_blocking(|| -> Result<serde_json::Value, String> {
            let processes = ffi::load_process_list()
                .map_err(|e| format!("load_process_list: {e}"))?;
            let mut top_procs: Vec<McpProcess> =
                processes.into_iter().map(McpProcess::from).collect();
            top_procs.sort_by(|a, b| {
                b.private_mb
                    .partial_cmp(&a.private_mb)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            top_procs.truncate(10);

            let perf = ffi::load_performance_snapshot()
                .map_err(|e| format!("load_performance_snapshot: {e}"))?;
            let volumes = ffi::load_storage_volumes()
                .map_err(|e| format!("load_storage_volumes: {e}"))?;

            Ok(serde_json::json!({
                "top_processes": top_procs,
                "performance": perf,
                "storage_volumes": volumes,
            }))
        })
        .await
        .map_err(|e| format!("join error: {e}"))??;
        serde_json::to_string_pretty(&bundle).map_err(|e| e.to_string())
    }

    #[tool(
        description = "List the most recently modified files under `root`, sorted by \
                       mtime descending. Recursive but capped (max 50k files visited, \
                       max depth 6) so it doesn't run away on /Users. Returns absolute \
                       path, size in bytes, and modified time as a Unix timestamp. \
                       Useful for 'what did I work on this week?' and 'which file did \
                       I just save?'. Read-only."
    )]
    async fn get_recent_files(
        &self,
        Parameters(args): Parameters<GetRecentFilesArgs>,
    ) -> Result<String, String> {
        let max = args.max.unwrap_or(25).clamp(1, 500);
        let root = args.root;
        let files = tokio::task::spawn_blocking(move || -> Result<Vec<RecentFile>, String> {
            let mut acc: Vec<RecentFile> = Vec::new();
            walk_recent_files(std::path::Path::new(&root), 0, &mut acc, 50_000);
            acc.sort_by(|a, b| b.modified_unix_secs.cmp(&a.modified_unix_secs));
            acc.truncate(max);
            Ok(acc)
        })
        .await
        .map_err(|e| format!("join error: {e}"))??;
        serde_json::to_string_pretty(&files).map_err(|e| e.to_string())
    }

    #[tool(
        description = "Top processes ranked by a single resource. `by` is one of \
                       'memory' (private MB), 'cpu' (%), 'disk' (read+write bytes/s), \
                       'network' (sent+recv bytes/s), 'gpu' (% across engines). Lets the \
                       AI ask 'what's eating my CPU?' or 'who's saturating my disk?' \
                       without enumerating the full process list. Defaults limit to 10. \
                       Read-only."
    )]
    async fn get_top_processes_by(
        &self,
        Parameters(args): Parameters<GetTopProcessesByArgs>,
    ) -> Result<String, String> {
        let limit = args.limit.unwrap_or(10).clamp(1, 200);
        let by = args.by.to_ascii_lowercase();
        let rows = tokio::task::spawn_blocking(move || -> Result<Vec<TopProcessByMetric>, String> {
            // We always need the process list — it gives us name+pid map.
            let processes = ffi::load_process_list()
                .map_err(|e| format!("load_process_list: {e}"))?;
            let name_for: std::collections::HashMap<u32, String> = processes
                .iter()
                .map(|p| (p.pid, p.name.clone()))
                .collect();

            let mut rows: Vec<TopProcessByMetric> = match by.as_str() {
                "memory" | "mem" => processes
                    .iter()
                    .map(|p| TopProcessByMetric {
                        pid: p.pid,
                        name: p.name.clone(),
                        metric_value: p.private_mb,
                        metric_unit: "MB private",
                    })
                    .collect(),
                "cpu" => ffi::load_power_list()
                    .map_err(|e| format!("load_power_list: {e}"))?
                    .into_iter()
                    .map(|p| TopProcessByMetric {
                        pid: p.pid,
                        name: name_for.get(&p.pid).cloned().unwrap_or_default(),
                        metric_value: p.cpu_percent,
                        metric_unit: "% CPU",
                    })
                    .collect(),
                "disk" => ffi::load_disk_list()
                    .map_err(|e| format!("load_disk_list: {e}"))?
                    .into_iter()
                    .map(|p| TopProcessByMetric {
                        pid: p.pid,
                        name: name_for.get(&p.pid).cloned().unwrap_or_default(),
                        metric_value: p.read_bytes_per_sec + p.write_bytes_per_sec,
                        metric_unit: "bytes/s read+write",
                    })
                    .collect(),
                "network" | "net" => ffi::load_network_list()
                    .map_err(|e| format!("load_network_list: {e}"))?
                    .into_iter()
                    .map(|p| TopProcessByMetric {
                        pid: p.pid,
                        name: name_for.get(&p.pid).cloned().unwrap_or_default(),
                        metric_value: p.send_bytes_per_sec + p.recv_bytes_per_sec,
                        metric_unit: "bytes/s sent+recv",
                    })
                    .collect(),
                "gpu" => ffi::load_gpu_list()
                    .map_err(|e| format!("load_gpu_list: {e}"))?
                    .into_iter()
                    .map(|p| TopProcessByMetric {
                        pid: p.pid,
                        name: name_for.get(&p.pid).cloned().unwrap_or_default(),
                        metric_value: p.gpu_usage_percent,
                        metric_unit: "% GPU",
                    })
                    .collect(),
                other => return Err(format!(
                    "unknown 'by' value: '{other}'. Must be memory, cpu, disk, network, or gpu."
                )),
            };
            rows.sort_by(|a, b| {
                b.metric_value
                    .partial_cmp(&a.metric_value)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            rows.truncate(limit);
            Ok(rows)
        })
        .await
        .map_err(|e| format!("join error: {e}"))??;
        serde_json::to_string_pretty(&rows).map_err(|e| e.to_string())
    }
}

// Walks a directory tree collecting files with their mtime. Bounded by
// `remaining_budget` (file-count cap that decrements across the recursive
// frames so /Users doesn't take 30 seconds) and a fixed depth limit so we
// stop before hitting node_modules / .git / Windows symlink cycles.
fn walk_recent_files(
    dir: &std::path::Path,
    depth: u32,
    out: &mut Vec<RecentFile>,
    mut remaining_budget: usize,
) -> usize {
    const MAX_DEPTH: u32 = 6;
    if depth > MAX_DEPTH || remaining_budget == 0 {
        return remaining_budget;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(it) => it,
        Err(_) => return remaining_budget,
    };
    for entry in entries.flatten() {
        if remaining_budget == 0 {
            break;
        }
        let path = entry.path();
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_dir() {
            // Skip the usual suspects so a Documents walk doesn't choke
            // on dependency trees / VCS history / Windows reparse loops.
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if matches!(
                name_str.as_ref(),
                "node_modules" | ".git" | "target" | ".gradle" | ".cache" | "$RECYCLE.BIN"
            ) {
                continue;
            }
            remaining_budget = walk_recent_files(&path, depth + 1, out, remaining_budget);
        } else if meta.is_file() {
            let modified_unix_secs = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            out.push(RecentFile {
                path: path.to_string_lossy().into_owned(),
                size_bytes: meta.len(),
                modified_unix_secs,
            });
            remaining_budget -= 1;
        }
    }
    remaining_budget
}

#[tool_handler]
impl ServerHandler for McpServer {
    fn get_info(&self) -> ServerInfo {
        // ServerInfo is #[non_exhaustive] across the crate boundary;
        // mutate fields on a default value instead of using a struct literal.
        let mut info = ServerInfo::default();
        info.capabilities = ServerCapabilities::builder().enable_tools().build();
        info.instructions = Some(
            "TaskManagerPlus — read-only system telemetry. \
             Tools: get_processes, get_performance_snapshot, get_storage_volumes, \
             get_top_folders, get_installed_apps, get_system_info, detect_projects, \
             system_snapshot, get_recent_files, get_top_processes_by. \
             All tools read-only. Destructive operations (end_process, recycle_files, \
             etc.) are intentionally not exposed in this version."
                .into(),
        );
        info
    }
}

/// Prime the C++ DLL's PDH performance counters so the first real MCP call
/// returns sane CPU/disk/network/GPU usage numbers.
///
/// `get_performance_snapshot` in the native DLL diffs the current PDH sample
/// against the previous one to compute % utilization. From a fresh process
/// there IS no previous sample — the kernel returns the cumulative
/// since-boot value, which gets misread as "100% busy for the entire
/// sample interval." The running app doesn't show this because it polls
/// once per second, so the second poll onward always has a baseline. The
/// sidecar takes one shot per tool call, so we need to manufacture that
/// baseline at startup.
///
/// Spec: one throwaway snapshot + 750 ms pause. 750 ms is the smallest
/// gap that consistently produces stable CPU% across our test boxes
/// (300-500 ms still showed jitter on heavily loaded systems). User waits
/// ~750 ms longer for the sidecar to be "ready"; not user-visible since
/// the MCP client only displays tool output, not server startup latency.
fn warm_up_counters() {
    let _ = ffi::load_performance_snapshot();
    std::thread::sleep(std::time::Duration::from_millis(750));
}

/// Run the MCP server over stdio. Returns when the client disconnects (EOF
/// on stdin, typically when the client window closes). Called from the
/// `tmp_mcp` sidecar binary's `main`.
pub async fn serve_stdio() -> Result<()> {
    tracing::info!("tmp_mcp warming PDH counters");
    // Run the blocking warm-up off the async runtime so we don't park the
    // tokio worker for 750 ms before the first MCP message can be parsed.
    tokio::task::spawn_blocking(warm_up_counters)
        .await
        .map_err(|e| anyhow::anyhow!("warm-up join error: {e}"))?;
    tracing::info!("tmp_mcp starting on stdio");
    let service = McpServer::new().serve(stdio()).await?;
    service.waiting().await?;
    Ok(())
}

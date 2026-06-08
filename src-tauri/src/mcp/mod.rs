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
use crate::mcp_config;
use crate::path_validate::{classify_str, PathVerdict};
use crate::process_workload::{self, WorkloadInput};

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
struct FindFilesByIntentArgs {
    /// Natural-language description of the file the user is looking
    /// for. Examples: "the document about Q3 budget", "my CV from
    /// 2024", "lecture notes about transformers". Embedded via the
    /// app's on-device embedding model and matched against the cached
    /// file embeddings; the query never leaves the machine.
    query: String,
    /// Max number of matches to return, sorted by relevance descending.
    /// Defaults to 15.
    #[serde(default)]
    limit: Option<usize>,
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

// ---------------------------------------------------------------------------
// Z1-B/C/D — destructive tool arg structs. Wired only when the user has
// flipped `destructive_enabled` in the Settings UI. The two-phase
// `dry_run` / `confirm` pattern gives the LLM a cheap "look before you
// leap" call so it can surface what's about to happen for human approval
// before the irreversible step. The flag is necessary but not sufficient:
// the backend still hard-refuses critical PIDs and forbidden paths.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, JsonSchema)]
struct EndProcessArgs {
    /// Process ID to terminate. Resolve PIDs with `get_processes` or
    /// `get_top_processes_by` first — passing a stale PID returns an
    /// error rather than killing whatever new process inherited it.
    pid: u32,
    /// When true (default), the tool only returns what WOULD be killed
    /// — current process name, image path, window title — and does not
    /// touch the process. Set to false in a follow-up call to actually
    /// terminate. Two-phase so the LLM can show the user the target
    /// before pulling the trigger.
    #[serde(default)]
    dry_run: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct SetStartupEnabledArgs {
    /// Stable startup entry id from `get_startup_apps`.
    id: String,
    /// true to enable at sign-in, false to disable.
    enabled: bool,
    #[serde(default)]
    dry_run: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct RecycleFilesArgs {
    /// Absolute file or folder paths to send to the Windows Recycle
    /// Bin. Each path is independently classified — safe ones get
    /// recycled, forbidden ones get refused, sensitive ones get
    /// refused unless `allow_unsafe` is also true.
    paths: Vec<String>,
    /// Lets sensitive paths (the user's Documents/Downloads/Desktop
    /// roots themselves, project trees) be recycled. Default false.
    /// Drive roots, Windows directories, Program Files are ALWAYS
    /// refused regardless of this flag.
    #[serde(default)]
    allow_unsafe: Option<bool>,
    /// When true (default), classify each path and return what WOULD
    /// happen without touching the filesystem. Set to false to commit.
    #[serde(default)]
    dry_run: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct EmptyRecycleBinArgs {
    /// Must be `true` to actually empty the bin. When false or omitted
    /// the tool returns the current bin size as a dry-run preview so
    /// the LLM can show the user how much will be freed before they
    /// confirm. Once committed the bin's contents are unrecoverable
    /// through Windows' normal restore UI.
    #[serde(default)]
    confirm: Option<bool>,
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
    /// Reflects whether destructive tools were registered. Surfaced
    /// through `get_info().instructions` so MCP clients (and the LLMs
    /// driving them) see an accurate tool catalog in their system
    /// prompt rather than discovering missing tools at call-time.
    destructive_enabled: bool,
    tool_router: ToolRouter<McpServer>,
}

impl McpServer {
    /// Build a server with the read-only tool set always registered.
    /// When `destructive_enabled` is true, the destructive router
    /// (end_process / recycle_files / empty_recycle_bin) is merged in.
    /// Defaults to OFF; flipped only by the user via the Settings UI.
    pub fn new(destructive_enabled: bool) -> Self {
        let mut router = Self::readonly_router();
        if destructive_enabled {
            router += Self::destructive_router();
        }
        Self {
            _state: McpState::default(),
            destructive_enabled,
            tool_router: router,
        }
    }
}

impl Default for McpServer {
    fn default() -> Self {
        Self::new(false)
    }
}

#[tool_router(router = readonly_router)]
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
        description = "Windows startup applications: name, publisher, enabled state, \
                       startup impact (low/medium/high from last boot), source (registry, \
                       startup folder, Store app), and optional boot trace. Read-only."
    )]
    async fn get_startup_apps(&self) -> Result<String, String> {
        let res = tokio::task::spawn_blocking(crate::startup::list_startup_apps)
            .await
            .map_err(|e| format!("join error: {e}"))?;
        serde_json::to_string_pretty(&res).map_err(|e| e.to_string())
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
        description = "Best-effort guess at what the user is currently doing on this \
                       computer. Aggregates the top processes by CPU+GPU weight, classifies \
                       each against a regex catalog of known apps (games, IDEs, creative \
                       tools, browsers, communicators, media players), and returns the \
                       dominant category plus the top contributing processes. Categories: \
                       gaming / editing / development / streaming / communication / browsing \
                       / other. `confidence` is the fraction of matched processes that \
                       voted for the dominant category. Read-only."
    )]
    async fn get_workload(&self) -> Result<String, String> {
        // Process list provides name + memory; per-process CPU/GPU come
        // from the separate power/gpu loaders (same FFI calls used by
        // get_top_processes_by). Joining by PID keeps the input to
        // workload classification rich enough to weight properly.
        let agg = tokio::task::spawn_blocking(
            || -> Result<process_workload::WorkloadAggregate, String> {
                let processes = ffi::load_process_list()
                    .map_err(|e| format!("load_process_list: {e}"))?;
                let mem_by_pid: std::collections::HashMap<u32, (String, f64)> = processes
                    .iter()
                    .map(|p| (p.pid, (p.name.clone(), p.private_mb)))
                    .collect();
                let cpu = ffi::load_power_list()
                    .map_err(|e| format!("load_power_list: {e}"))?;
                let cpu_by_pid: std::collections::HashMap<u32, f64> =
                    cpu.into_iter().map(|p| (p.pid, p.cpu_percent)).collect();
                let gpu = ffi::load_gpu_list()
                    .map_err(|e| format!("load_gpu_list: {e}"))?;
                let gpu_by_pid: std::collections::HashMap<u32, f64> = gpu
                    .into_iter()
                    .map(|p| (p.pid, p.gpu_usage_percent))
                    .collect();

                let inputs: Vec<WorkloadInput> = mem_by_pid
                    .iter()
                    .map(|(pid, (name, mem))| WorkloadInput {
                        pid: *pid,
                        name: name.clone(),
                        cpu_percent: cpu_by_pid.get(pid).copied().unwrap_or(0.0),
                        gpu_percent: gpu_by_pid.get(pid).copied().unwrap_or(0.0),
                        memory_mb: *mem,
                    })
                    .collect();
                Ok(process_workload::aggregate(&inputs))
            },
        )
        .await
        .map_err(|e| format!("join error: {e}"))??;
        serde_json::to_string_pretty(&agg).map_err(|e| e.to_string())
    }

    #[tool(
        description = "Semantic file search across the on-device embedding index. \
                       Embeds the natural-language query, then ranks every indexed file \
                       by cosine similarity. Returns top matches as `{ path, score }` \
                       pairs (score in [-1, 1], higher = more similar). When the index \
                       is empty (Standard or Enhanced AI tier never enabled, or no \
                       Storage scan yet), returns a structured hint instead of silent \
                       zero results. The query never leaves the machine — embedding \
                       happens on-device, search runs in-process against the local cache."
    )]
    async fn find_files_by_intent(
        &self,
        Parameters(args): Parameters<FindFilesByIntentArgs>,
    ) -> Result<String, String> {
        let query = args.query.trim().to_string();
        if query.is_empty() {
            return serde_json::to_string_pretty(&serde_json::json!({
                "results": [],
                "hint": "Provide a non-empty query.",
            }))
            .map_err(|e| e.to_string());
        }
        let limit = args.limit.unwrap_or(15).clamp(1, 100);

        // The MCP sidecar runs without a Tauri AppHandle, so it
        // resolves `app_local_data_dir` directly from %LOCALAPPDATA%.
        // The bundle identifier is fixed at `com.taskmanagerplus.app`
        // per tauri.conf.json — using it as a literal here is safe
        // because changing it would require also changing the
        // installer + every other path-based resolver in the app.
        let base = std::env::var("LOCALAPPDATA")
            .map_err(|e| format!("no LOCALAPPDATA: {e}"))?;
        let app_data = std::path::PathBuf::from(base).join("com.taskmanagerplus.app");
        let models = crate::ai::model_download::models_dir_at(&app_data)?;
        let cache_path = crate::ai::embedding_cache::cache_path_at(&app_data)?;

        let result = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
            // Cold-cache check first: if the cache file is missing or
            // empty, the user hasn't run a scan yet — return the hint
            // structurally so AI clients can prompt the user.
            if !cache_path.exists() {
                return Ok(serde_json::json!({
                    "results": [],
                    "hint": "No file embedding index yet. Open the Storage page in TaskManagerPlus, enable Standard or Enhanced AI in Settings, and let it run a scan first.",
                }));
            }
            let cache = crate::ai::embedding_cache::EmbeddingCache::load(&cache_path);
            if cache.len() == 0 {
                return Ok(serde_json::json!({
                    "results": [],
                    "hint": "File embedding index is empty. Run a Storage scan with AI enabled to populate it.",
                }));
            }

            // Embed the query — uses the non-blocking variant so a
            // concurrent in-app scan doesn't block this call.
            let mut vecs =
                crate::ai::embeddings::try_embed_texts(&models, &[query.clone()])?;
            let query_vec = vecs.pop().ok_or_else(|| "empty query embedding".to_string())?;

            // Same ranker the in-app intent search uses (lexical +
            // cosine combined), so MCP results match what the user
            // sees in the app.
            let hits = crate::commands::ai::rank_cache_by_vector(
                &cache,
                Some(&query),
                &query_vec,
                limit,
                None,
            );
            Ok(serde_json::json!({ "results": hits }))
        })
        .await
        .map_err(|e| format!("join error: {e}"))??;
        serde_json::to_string_pretty(&result).map_err(|e| e.to_string())
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

// ---------------------------------------------------------------------------
// Z1 — destructive router. Registered only when the user has flipped
// `destructive_enabled` in the app's Settings UI. The flag persists in
// %LOCALAPPDATA%\com.taskmanagerplus.app\mcp_config.json; the sidecar
// reads it ONCE at startup. Toggling requires an MCP-client restart so
// the new tool catalog gets renegotiated — documented next to the toggle.
//
// Each tool follows a deliberate two-phase pattern:
//   1. dry_run / confirm=false  →  classify the request, return a
//      preview ("this would kill PID 12345 = chrome.exe"), no side
//      effects.
//   2. dry_run / confirm=true   →  perform the irreversible action.
//
// The pattern is for the LLM, not for security. An LLM that hallucinates
// past dry_run can still trigger the destructive call — security comes
// from the backend hard-refusing critical PIDs (Z1-B) and forbidden
// paths (Z1-C, via the same `path_validate` classifier the Smart
// Organizer uses).
// ---------------------------------------------------------------------------

#[tool_router(router = destructive_router)]
impl McpServer {
    #[tool(
        description = "Terminate a running process by PID. DESTRUCTIVE — requires the \
                       user to have enabled destructive MCP tools in TaskManager+ \
                       Settings. Default `dry_run=true` returns the target process \
                       info (name, image path, window title) WITHOUT killing — call \
                       again with `dry_run=false` to commit. Refuses critical Windows \
                       processes (PID 0/4, csrss/wininit/services/lsass/winlogon/smss) \
                       and the MCP sidecar's own PID regardless of dry_run."
    )]
    async fn end_process(
        &self,
        Parameters(args): Parameters<EndProcessArgs>,
    ) -> Result<String, String> {
        let pid = args.pid;
        let dry = args.dry_run.unwrap_or(true);

        // PID-level refusal: System Idle / System / sidecar self.
        // Catching these at our layer (instead of relying on the
        // kernel's access-denied) gives the LLM a clear, actionable
        // error message instead of "Failed to terminate process 4".
        let self_pid = std::process::id();
        if pid == 0 || pid == 4 {
            return Err(format!(
                "Refusing to terminate PID {pid}: Windows kernel/idle process."
            ));
        }
        if pid == self_pid {
            return Err(format!(
                "Refusing to terminate PID {pid}: that's the MCP sidecar itself."
            ));
        }

        // Look up the target. Doing this BEFORE the kill gives the
        // dry_run path useful output and ensures the !dry_run path
        // returns the name in the result payload (caller's audit log
        // shouldn't have to re-resolve the PID after it's gone).
        let processes = tokio::task::spawn_blocking(ffi::load_process_list)
            .await
            .map_err(|e| format!("join error: {e}"))?
            .map_err(|e| format!("load_process_list: {e}"))?;
        let target = processes.iter().find(|p| p.pid == pid).cloned();
        let target = match target {
            Some(t) => t,
            None => {
                return Err(format!(
                    "PID {pid} not running. Refresh with get_processes before retrying."
                ))
            }
        };

        // Name-based refusal for the small set of processes whose loss
        // immediately reboots Windows. These ARE also refused by the
        // OS — but the OS message ("Access denied") doesn't tell the
        // LLM why it's blocked, and a sane error helps the LLM stop
        // trying.
        const CRITICAL_NAMES: &[&str] = &[
            "csrss.exe",
            "wininit.exe",
            "services.exe",
            "lsass.exe",
            "winlogon.exe",
            "smss.exe",
            "system",
        ];
        let name_lower = target.name.to_ascii_lowercase();
        if CRITICAL_NAMES.iter().any(|n| name_lower == *n) {
            return Err(format!(
                "Refusing to terminate '{}' (PID {pid}): critical Windows process.",
                target.name
            ));
        }

        if dry {
            return serde_json::to_string_pretty(&serde_json::json!({
                "dry_run": true,
                "would_terminate": {
                    "pid": pid,
                    "name": target.name,
                    "display_name": target.display_name,
                    "image_path": target.image_path,
                    "window_title": target.window_title,
                    "private_mb": target.private_mb,
                },
                "next_step": "Re-call with dry_run=false to actually terminate.",
            }))
            .map_err(|e| e.to_string());
        }

        // Commit. ffi::kill_process holds the DLL write-lock for the
        // duration of the Win32 TerminateProcess call; spawn_blocking
        // keeps the tokio worker free.
        let name_for_result = target.name.clone();
        tokio::task::spawn_blocking(move || ffi::kill_process(pid))
            .await
            .map_err(|e| format!("join error: {e}"))??;

        serde_json::to_string_pretty(&serde_json::json!({
            "terminated": {
                "pid": pid,
                "name": name_for_result,
            }
        }))
        .map_err(|e| e.to_string())
    }

    #[tool(
        description = "Enable or disable a Windows startup application by id from \
                       `get_startup_apps`. DESTRUCTIVE — requires destructive MCP tools \
                       enabled. Default `dry_run=true` previews the change without writing \
                       registry StartupApproved values."
    )]
    async fn set_startup_enabled(
        &self,
        Parameters(args): Parameters<SetStartupEnabledArgs>,
    ) -> Result<String, String> {
        let dry = args.dry_run.unwrap_or(true);
        let id = args.id.clone();
        let enabled = args.enabled;
        if dry {
            return serde_json::to_string_pretty(&serde_json::json!({
                "dry_run": true,
                "would_set": { "id": id, "enabled": enabled },
                "next_step": "Re-call with dry_run=false to apply.",
            }))
            .map_err(|e| e.to_string());
        }
        let id_for_result = id.clone();
        tokio::task::spawn_blocking(move || crate::startup::set_startup_enabled(&id, enabled))
            .await
            .map_err(|e| format!("join error: {e}"))??;
        serde_json::to_string_pretty(&serde_json::json!({
            "updated": { "id": id_for_result, "enabled": enabled },
        }))
        .map_err(|e| e.to_string())
    }

    #[tool(
        description = "Send files or folders to the Windows Recycle Bin. DESTRUCTIVE \
                       but recoverable — items can be restored from the bin until \
                       it's emptied. Requires destructive MCP tools enabled in \
                       Settings. Each path is independently classified: drive roots, \
                       Windows / Program Files, and other system locations are ALWAYS \
                       refused; the user's profile root and well-known top-level \
                       folders (Documents, Downloads, ...) are refused unless \
                       `allow_unsafe=true`. Default `dry_run=true` returns the \
                       per-path verdict (safe/sensitive/forbidden) without touching \
                       the filesystem."
    )]
    async fn recycle_files(
        &self,
        Parameters(args): Parameters<RecycleFilesArgs>,
    ) -> Result<String, String> {
        let allow_unsafe = args.allow_unsafe.unwrap_or(false);
        let dry = args.dry_run.unwrap_or(true);
        let paths = args.paths;

        if paths.is_empty() {
            return Err("`paths` must contain at least one path.".into());
        }

        // Classify everything up front — same classifier used by the
        // Smart Organizer and the Tauri command path. Single source of
        // truth for "is this path dangerous?" across the codebase.
        let mut classifications: Vec<(String, &'static str, &'static str)> = paths
            .iter()
            .map(|p| {
                let v = classify_str(p);
                let verdict = match v {
                    PathVerdict::Safe => "safe",
                    PathVerdict::Sensitive => "sensitive",
                    PathVerdict::Forbidden => "forbidden",
                };
                let action = match v {
                    PathVerdict::Forbidden => "blocked (system or protected location)",
                    PathVerdict::Sensitive if !allow_unsafe => {
                        "blocked (sensitive; pass allow_unsafe=true to override)"
                    }
                    PathVerdict::Sensitive => "would recycle (allow_unsafe accepted)",
                    PathVerdict::Safe => "would recycle",
                };
                (p.clone(), verdict, action)
            })
            .collect();

        if dry {
            let preview: Vec<serde_json::Value> = classifications
                .drain(..)
                .map(|(path, verdict, action)| {
                    serde_json::json!({ "path": path, "verdict": verdict, "action": action })
                })
                .collect();
            return serde_json::to_string_pretty(&serde_json::json!({
                "dry_run": true,
                "paths": preview,
                "next_step": "Re-call with dry_run=false to recycle the safe entries.",
            }))
            .map_err(|e| e.to_string());
        }

        // Commit. Mirrors the Tauri command in commands::storage but
        // doesn't share code with it — that command is annotated with
        // #[tauri::command] and pulls in AppHandle plumbing the sidecar
        // doesn't have. The classifier is the only shared surface.
        let commit_result =
            tokio::task::spawn_blocking(move || -> serde_json::Value {
                let mut recycled = 0u32;
                let mut errors: Vec<String> = Vec::new();
                for (path, verdict, action) in classifications {
                    if verdict != "safe" && !(verdict == "sensitive" && allow_unsafe) {
                        errors.push(format!("{path}: {action}"));
                        continue;
                    }
                    let p = std::path::Path::new(&path);
                    if !p.exists() {
                        errors.push(format!("{path}: not found"));
                        continue;
                    }
                    match trash::delete(p) {
                        Ok(()) => recycled += 1,
                        Err(e) => errors.push(format!("{path}: {e}")),
                    }
                }
                serde_json::json!({
                    "recycled": recycled,
                    "errors": errors,
                })
            })
            .await
            .map_err(|e| format!("join error: {e}"))?;

        serde_json::to_string_pretty(&commit_result).map_err(|e| e.to_string())
    }

    #[tool(
        description = "Empty the Windows Recycle Bin permanently. DESTRUCTIVE and \
                       NOT recoverable through Windows' restore UI. Requires \
                       destructive MCP tools enabled in Settings. Default \
                       `confirm=false` returns the current bin size so the LLM can \
                       show the user how much would be freed; pass `confirm=true` \
                       to actually empty. No path-based refusals apply — this is the \
                       Shell-level 'empty trash' equivalent."
    )]
    async fn empty_recycle_bin(
        &self,
        Parameters(args): Parameters<EmptyRecycleBinArgs>,
    ) -> Result<String, String> {
        let confirm = args.confirm.unwrap_or(false);

        if !confirm {
            let size = tokio::task::spawn_blocking(ffi::load_recycle_bin_size)
                .await
                .map_err(|e| format!("join error: {e}"))?
                .map_err(|e| format!("load_recycle_bin_size: {e}"))?;
            return serde_json::to_string_pretty(&serde_json::json!({
                "dry_run": true,
                "current_bin_bytes": size,
                "next_step": "Re-call with confirm=true to empty the bin permanently.",
            }))
            .map_err(|e| e.to_string());
        }

        // Capture size BEFORE emptying so the result includes "freed N bytes".
        let pre_size = tokio::task::spawn_blocking(ffi::load_recycle_bin_size)
            .await
            .map_err(|e| format!("join error: {e}"))?
            .map_err(|e| format!("load_recycle_bin_size: {e}"))?;

        tokio::task::spawn_blocking(ffi::empty_recycle_bin)
            .await
            .map_err(|e| format!("join error: {e}"))??;

        serde_json::to_string_pretty(&serde_json::json!({
            "emptied": true,
            "freed_bytes": pre_size,
        }))
        .map_err(|e| e.to_string())
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

#[tool_handler(router = self.tool_router)]
impl ServerHandler for McpServer {
    fn get_info(&self) -> ServerInfo {
        // ServerInfo is #[non_exhaustive] across the crate boundary;
        // mutate fields on a default value instead of using a struct literal.
        let mut info = ServerInfo::default();
        info.capabilities = ServerCapabilities::builder().enable_tools().build();
        info.instructions = Some(if self.destructive_enabled {
            // Destructive tools ON — list everything plus the safety
            // contract so the LLM knows what guards are in place. The
            // "dry_run first" hint nudges chat models toward the
            // two-phase preview pattern these tools are designed for.
            "TaskManagerPlus — read-only system telemetry plus opt-in destructive \
             actions. Read-only tools: get_processes, get_performance_snapshot, \
             get_storage_volumes, get_top_folders, get_installed_apps, \
             get_system_info, detect_projects, system_snapshot, get_recent_files, \
             get_top_processes_by, get_workload, find_files_by_intent. \
             Destructive tools (enabled by the user in TaskManager+ Settings): \
             end_process, recycle_files, empty_recycle_bin. \
             Destructive tools default to dry_run/confirm=false — call once to \
             preview the action, then call again with dry_run=false (or \
             confirm=true for empty_recycle_bin) to commit. Critical Windows \
             processes and system paths are refused regardless of confirm flags."
                .into()
        } else {
            "TaskManagerPlus — read-only system telemetry. \
             Tools: get_processes, get_performance_snapshot, get_storage_volumes, \
             get_top_folders, get_installed_apps, get_system_info, detect_projects, \
             system_snapshot, get_recent_files, get_top_processes_by, get_workload, \
             find_files_by_intent. \
             All tools read-only. Destructive operations (end_process, recycle_files, \
             empty_recycle_bin) are gated behind a toggle in TaskManager+ Settings \
             and are NOT exposed in this session."
                .into()
        });
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
    // Prime every per-process PDH counter we expose through MCP tools.
    // PDH counters need a previous sample to diff against — without
    // these throwaway calls, the FIRST get_workload / get_top_processes_by
    // call gets all-zero CPU/GPU values (no baseline → no delta).
    // Cheap relative to the 750 ms baseline-pause that follows.
    let _ = ffi::load_performance_snapshot();
    let _ = ffi::load_power_list();
    let _ = ffi::load_gpu_list();
    let _ = ffi::load_disk_list();
    let _ = ffi::load_network_list();
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

    // Z1 — read the destructive opt-in flag. The sidecar reads ONCE at
    // startup so toggling the Settings switch requires the user to
    // restart their MCP client (Claude Desktop, Cursor, ...) to
    // renegotiate the tool catalog. Missing file / parse error → off,
    // by design: a corrupt config can never silently enable destructive
    // tools.
    let destructive_enabled = mcp_config::config_path_from_localappdata()
        .map(|p| mcp_config::load(&p).destructive_enabled)
        .unwrap_or(false);
    tracing::info!(
        "tmp_mcp starting on stdio (destructive tools: {})",
        if destructive_enabled { "ENABLED" } else { "off" }
    );
    let service = McpServer::new(destructive_enabled).serve(stdio()).await?;
    service.waiting().await?;
    Ok(())
}

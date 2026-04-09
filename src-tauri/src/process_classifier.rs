//! Classifies multi-process application child processes (Chrome tabs, VS Code extension host, etc.)
//! by reading their command-line arguments via Windows APIs (WMI batch query).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

/// Cache for command-line data to avoid running PowerShell on every refresh.
/// Command lines don't change for a process, so we only need to fetch new PIDs.
static CMDLINE_CACHE: Mutex<Option<CmdlineCache>> = Mutex::new(None);

struct CmdlineCache {
    data: HashMap<u32, String>,
    last_full_refresh: Instant,
}

const FULL_REFRESH_INTERVAL_SECS: u64 = 10;

/// Classification result for a process
#[derive(Debug, Clone)]
pub struct ProcessClassification {
    /// Enriched display name (e.g., "Chrome (GPU Process)")
    pub display_name: Option<String>,
    /// Process sub-type for UI display
    pub process_type: Option<String>,
}

/// Known multi-process application patterns
struct AppPattern {
    /// Executable names to match (lowercase)
    exe_names: &'static [&'static str],
    /// Base display name
    base_name: &'static str,
    /// Classification rules based on command line
    rules: &'static [ClassifyRule],
}

struct ClassifyRule {
    /// String to search for in command line
    pattern: &'static str,
    /// Label to apply
    label: &'static str,
    /// Process type tag
    proc_type: &'static str,
}

static APP_PATTERNS: &[AppPattern] = &[
    // Chromium-based browsers
    AppPattern {
        exe_names: &["chrome.exe"],
        base_name: "Google Chrome",
        rules: &CHROMIUM_RULES,
    },
    AppPattern {
        exe_names: &["msedge.exe"],
        base_name: "Microsoft Edge",
        rules: &CHROMIUM_RULES,
    },
    AppPattern {
        exe_names: &["brave.exe"],
        base_name: "Brave",
        rules: &CHROMIUM_RULES,
    },
    AppPattern {
        exe_names: &["opera.exe"],
        base_name: "Opera",
        rules: &CHROMIUM_RULES,
    },
    AppPattern {
        exe_names: &["vivaldi.exe"],
        base_name: "Vivaldi",
        rules: &CHROMIUM_RULES,
    },
    // VS Code / Electron
    AppPattern {
        exe_names: &["code.exe", "code - insiders.exe"],
        base_name: "Visual Studio Code",
        rules: &VSCODE_RULES,
    },
    // Firefox
    AppPattern {
        exe_names: &["firefox.exe"],
        base_name: "Firefox",
        rules: &FIREFOX_RULES,
    },
    // Visual Studio
    AppPattern {
        exe_names: &["devenv.exe"],
        base_name: "Visual Studio",
        rules: &[],
    },
    // Discord (Electron)
    AppPattern {
        exe_names: &["discord.exe"],
        base_name: "Discord",
        rules: &ELECTRON_RULES,
    },
    // Slack (Electron)
    AppPattern {
        exe_names: &["slack.exe"],
        base_name: "Slack",
        rules: &ELECTRON_RULES,
    },
    // Spotify (Chromium-based)
    AppPattern {
        exe_names: &["spotify.exe"],
        base_name: "Spotify",
        rules: &ELECTRON_RULES,
    },
    // Teams
    AppPattern {
        exe_names: &["ms-teams.exe", "teams.exe"],
        base_name: "Microsoft Teams",
        rules: &ELECTRON_RULES,
    },
];

static CHROMIUM_RULES: &[ClassifyRule] = &[
    ClassifyRule {
        pattern: "--type=gpu-process",
        label: "GPU Process",
        proc_type: "gpu",
    },
    ClassifyRule {
        pattern: "--type=crashpad-handler",
        label: "Crash Handler",
        proc_type: "crashpad",
    },
    ClassifyRule {
        pattern: "--extension-process",
        label: "Extension",
        proc_type: "extension",
    },
    ClassifyRule {
        pattern: "--utility-sub-type=network.mojom.NetworkService",
        label: "Network Service",
        proc_type: "utility-network",
    },
    ClassifyRule {
        pattern: "--utility-sub-type=storage.mojom.StorageService",
        label: "Storage Service",
        proc_type: "utility-storage",
    },
    ClassifyRule {
        pattern: "--utility-sub-type=audio.mojom.AudioService",
        label: "Audio Service",
        proc_type: "utility-audio",
    },
    ClassifyRule {
        pattern: "--utility-sub-type=video_capture.mojom.VideoCaptureService",
        label: "Video Capture",
        proc_type: "utility-video",
    },
    ClassifyRule {
        pattern: "--utility-sub-type=",
        label: "Utility",
        proc_type: "utility",
    },
    ClassifyRule {
        pattern: "--type=utility",
        label: "Utility",
        proc_type: "utility",
    },
    ClassifyRule {
        pattern: "--type=renderer",
        label: "Tab",
        proc_type: "renderer",
    },
];

static VSCODE_RULES: &[ClassifyRule] = &[
    ClassifyRule {
        pattern: "--type=gpu-process",
        label: "GPU Process",
        proc_type: "gpu",
    },
    ClassifyRule {
        pattern: "extensionHost",
        label: "Extension Host",
        proc_type: "extension-host",
    },
    ClassifyRule {
        pattern: "ptyHost",
        label: "Terminal",
        proc_type: "pty-host",
    },
    ClassifyRule {
        pattern: "watcherService",
        label: "File Watcher",
        proc_type: "watcher",
    },
    ClassifyRule {
        pattern: "--vscode-window-kind=shared-process",
        label: "Shared Process",
        proc_type: "shared",
    },
    ClassifyRule {
        pattern: "--type=utility",
        label: "Utility",
        proc_type: "utility",
    },
    ClassifyRule {
        pattern: "--type=renderer",
        label: "Window",
        proc_type: "renderer",
    },
    ClassifyRule {
        pattern: "--crashpad-handler",
        label: "Crash Handler",
        proc_type: "crashpad",
    },
    ClassifyRule {
        pattern: "--type=crashpad-handler",
        label: "Crash Handler",
        proc_type: "crashpad",
    },
];

static FIREFOX_RULES: &[ClassifyRule] = &[
    ClassifyRule {
        pattern: "-contentproc",
        label: "Content Process",
        proc_type: "content",
    },
    // More specific content types (these appear after -contentproc in args)
    ClassifyRule {
        pattern: "\"gpu\"",
        label: "GPU Process",
        proc_type: "gpu",
    },
    ClassifyRule {
        pattern: "\"rdd\"",
        label: "Media Decoder",
        proc_type: "rdd",
    },
    ClassifyRule {
        pattern: "\"socket\"",
        label: "Network",
        proc_type: "socket",
    },
];

static ELECTRON_RULES: &[ClassifyRule] = &[
    ClassifyRule {
        pattern: "--type=gpu-process",
        label: "GPU Process",
        proc_type: "gpu",
    },
    ClassifyRule {
        pattern: "--type=utility",
        label: "Utility",
        proc_type: "utility",
    },
    ClassifyRule {
        pattern: "--type=renderer",
        label: "Renderer",
        proc_type: "renderer",
    },
    ClassifyRule {
        pattern: "--type=crashpad-handler",
        label: "Crash Handler",
        proc_type: "crashpad",
    },
];

/// Visual Studio ServiceHub process patterns (matched by exe name, not command line)
static SERVICEHUB_LABELS: &[(&str, &str)] = &[
    ("servicehub.host.clr.x64.exe", "VS ServiceHub (.NET x64)"),
    ("servicehub.host.clr.x86.exe", "VS ServiceHub (.NET x86)"),
    ("servicehub.host.node.x86.exe", "VS ServiceHub (Node.js)"),
    ("servicehub.indexingservice.exe", "VS Indexing Service"),
    ("servicehub.identityhost.exe", "VS Identity Service"),
    ("servicehub.settingshost.exe", "VS Settings Service"),
    ("servicehub.vsdetouredhost.exe", "VS Detoured Host"),
    ("vbcscompiler.exe", "VS Roslyn Compiler"),
    ("perfwatson2.exe", "VS Performance Monitor"),
    ("msbuild.exe", "MSBuild"),
    ("vstest.console.exe", "VS Test Runner"),
    // JetBrains
    ("fsnotifier64.exe", "JetBrains File Watcher"),
    ("fsnotifier.exe", "JetBrains File Watcher"),
    ("jcef_helper.exe", "JetBrains Browser"),
];

/// Batch-classify processes using WMI to get command lines efficiently.
/// Returns a map of PID -> classification.
pub fn classify_processes(pids: &[u32], exe_names: &[String]) -> HashMap<u32, ProcessClassification> {
    let mut results = HashMap::new();

    // First: classify processes that can be identified by exe name alone
    for (i, pid) in pids.iter().enumerate() {
        let exe_lower = exe_names.get(i).map(|n| n.to_lowercase()).unwrap_or_default();

        // Check ServiceHub / known utility processes
        for &(pattern_exe, label) in SERVICEHUB_LABELS {
            if exe_lower == pattern_exe {
                results.insert(*pid, ProcessClassification {
                    display_name: Some(label.to_string()),
                    process_type: Some("service".to_string()),
                });
                break;
            }
        }
    }

    // Build set of PIDs that need command-line analysis
    let multi_process_exes: Vec<&str> = APP_PATTERNS
        .iter()
        .flat_map(|p| p.exe_names.iter().copied())
        .collect();

    let pids_needing_cmdline: Vec<(u32, usize)> = pids
        .iter()
        .enumerate()
        .filter_map(|(i, &pid)| {
            if results.contains_key(&pid) {
                return None;
            }
            let exe_lower = exe_names.get(i).map(|n| n.to_lowercase()).unwrap_or_default();
            if multi_process_exes.contains(&exe_lower.as_str()) {
                Some((pid, i))
            } else {
                None
            }
        })
        .collect();

    if pids_needing_cmdline.is_empty() {
        return results;
    }

    // Use cached command lines, only fetching new/unknown PIDs
    let pids_to_query: Vec<u32> = pids_needing_cmdline.iter().map(|&(pid, _)| pid).collect();
    let cmdlines = get_cached_command_lines(&pids_to_query);

    // Classify each process
    for &(pid, idx) in &pids_needing_cmdline {
        let exe_lower = exe_names.get(idx).map(|n| n.to_lowercase()).unwrap_or_default();
        let cmdline = cmdlines.get(&pid).map(|s| s.as_str()).unwrap_or("");

        // Find matching app pattern
        for pattern in APP_PATTERNS {
            if !pattern.exe_names.contains(&exe_lower.as_str()) {
                continue;
            }

            // Try each classification rule (ordered from most specific to least)
            let mut matched = false;
            for rule in pattern.rules {
                if cmdline.contains(rule.pattern) {
                    results.insert(pid, ProcessClassification {
                        display_name: Some(format!("{} ({})", pattern.base_name, rule.label)),
                        process_type: Some(rule.proc_type.to_string()),
                    });
                    matched = true;
                    break;
                }
            }

            // If no rule matched and there IS a command line, it's likely the main/browser process
            if !matched {
                // Check if this is the main process (no --type flag)
                if !cmdline.contains("--type=") && !cmdline.contains("-contentproc") {
                    results.insert(pid, ProcessClassification {
                        display_name: Some(format!("{} (Main)", pattern.base_name)),
                        process_type: Some("main".to_string()),
                    });
                }
            }
            break;
        }
    }

    results
}

/// Get command lines using a cache. Only queries PowerShell for PIDs not yet in cache.
/// Does a full refresh every FULL_REFRESH_INTERVAL_SECS to handle PID reuse.
fn get_cached_command_lines(pids: &[u32]) -> HashMap<u32, String> {
    let mut cache_guard = CMDLINE_CACHE.lock().unwrap_or_else(|e| e.into_inner());

    let now = Instant::now();
    let needs_full_refresh = match &*cache_guard {
        None => true,
        Some(cache) => now.duration_since(cache.last_full_refresh).as_secs() >= FULL_REFRESH_INTERVAL_SECS,
    };

    if needs_full_refresh {
        // Full refresh: query all requested PIDs
        let fresh = batch_get_command_lines(pids);
        let result = fresh.clone();
        *cache_guard = Some(CmdlineCache {
            data: fresh,
            last_full_refresh: now,
        });
        return result;
    }

    let cache = cache_guard.as_mut().unwrap();

    // Find PIDs not in cache
    let unknown_pids: Vec<u32> = pids
        .iter()
        .filter(|pid| !cache.data.contains_key(pid))
        .copied()
        .collect();

    if !unknown_pids.is_empty() {
        let new_data = batch_get_command_lines(&unknown_pids);
        for (pid, cmdline) in new_data {
            cache.data.insert(pid, cmdline);
        }
    }

    // Return only the requested PIDs from cache
    pids.iter()
        .filter_map(|pid| cache.data.get(pid).map(|cmd| (*pid, cmd.clone())))
        .collect()
}

/// Fetch command lines for a batch of PIDs using PowerShell + CIM.
/// Uses a TAB delimiter to avoid conflicts with commas in command-line arguments.
#[cfg(windows)]
fn batch_get_command_lines(pids: &[u32]) -> HashMap<u32, String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    let mut result = HashMap::new();
    if pids.is_empty() {
        return result;
    }

    // Build a PowerShell filter for the specific PIDs (chunks to avoid cmd length limits)
    for chunk in pids.chunks(80) {
        let where_clause = chunk
            .iter()
            .map(|p| format!("ProcessId={}", p))
            .collect::<Vec<_>>()
            .join(" OR ");

        // PowerShell one-liner: get processes by PID, output "PID<TAB>CommandLine" per line
        let ps_script = format!(
            "Get-CimInstance Win32_Process -Filter '{}' | ForEach-Object {{ \"$($_.ProcessId)`t$($_.CommandLine)\" }}",
            where_clause
        );

        let output = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NoLogo",
                "-NonInteractive",
                "-Command",
                &ps_script,
            ])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output();

        if let Ok(output) = output {
            let text = String::from_utf8_lossy(&output.stdout);
            for line in text.lines() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                // Format: "PID\tCommandLine"
                if let Some(tab_pos) = line.find('\t') {
                    let pid_str = &line[..tab_pos];
                    let cmdline = &line[tab_pos + 1..];
                    if let Ok(pid) = pid_str.parse::<u32>() {
                        if !cmdline.is_empty() {
                            result.insert(pid, cmdline.to_string());
                        }
                    }
                }
            }
        }
    }

    result
}

#[cfg(not(windows))]
fn batch_get_command_lines(_pids: &[u32]) -> HashMap<u32, String> {
    HashMap::new()
}

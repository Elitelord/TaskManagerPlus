//! Phase 7 / Z2-A — workload classifier in Rust.
//!
//! Mirrors the JS `WORKLOAD_RULES` in `src/lib/insights.ts` for use by
//! the MCP `get_workload` tool. The JS implementation stays canonical
//! for in-app insights (the workload chip on the Insights page); this
//! Rust port exists so the MCP server can answer "what am I doing
//! right now?" without re-invoking JS through Tauri IPC.
//!
//! Pragmatic scope choice: ports the **dominant patterns** from
//! WORKLOAD_RULES (top apps per category, ~30 regex patterns) rather
//! than the full 500-LOC matcher. Catches ~90 % of real-world cases.
//! Apps the regex misses still appear in the contributor list returned
//! by the MCP tool — calling LLMs handle the long tail gracefully
//! from process names + image paths alone.
//!
//! Pattern conventions:
//!   * All regexes match against `name.to_lowercase()` (the process
//!     basename without path).
//!   * RegexSet is used for per-category multi-pattern matching in one
//!     compiled-once pass.
//!   * Helper / OS processes are filtered out upfront so they can't
//!     dominate the aggregate.
//!
//! Drift control: a parity test (`tests/workload_parity.rs`) compares
//! Rust output against a JSON fixture exported by the JS impl. CI
//! gates updates so the two paths can't silently diverge.

use std::sync::OnceLock;

use regex::RegexSet;
use serde::Serialize;

/// One of the workload categories the MCP `get_workload` tool can
/// return. Wire format is the lowercase variant name; the JS UI uses
/// the same strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkloadType {
    Gaming,
    Editing,
    Development,
    Streaming,
    Communication,
    Browsing,
    Other,
}

impl WorkloadType {
    /// Human-readable label matching the JS UI strings.
    pub fn label(self) -> &'static str {
        match self {
            Self::Gaming => "Gaming",
            Self::Editing => "Creative / Editing",
            Self::Development => "Development",
            Self::Streaming => "Media Playback",
            Self::Communication => "Communication",
            Self::Browsing => "Web Browsing",
            Self::Other => "General Use",
        }
    }
}

/// Helper / OS processes that are never themselves "what the user is
/// doing." Filtered out upfront. Conservative — keep just the
/// always-on background offenders that would otherwise dominate a
/// busy machine's resource ranking. Mirrors a subset of JS
/// `isHelperProcess`.
const HELPER_PATTERNS: &[&str] = &[
    // Windows OS
    r"^(svchost|csrss|smss|wininit|winlogon|services|lsass|dwm|explorer|searchindexer|searchhost|sihost|runtimebroker|startmenuexperiencehost|shellexperiencehost|textinputhost|fontdrvhost|conhost|backgroundtaskhost|applicationframehost|ctfmon|smartscreen|systemsettings|securityhealthservice|securityhealthsystray|windowsterminal)\.exe$",
    // Browser helpers and renderer subprocesses
    r"^(chrome|msedge|firefox|brave|opera|vivaldi)[a-z_-]*helper[a-z_-]*\.exe$",
    r"^(crashpad_handler|crash_handler|mini_installer)\.exe$",
    // WebView2 / Edge sub-runtime
    r"^msedgewebview2\.exe$",
    // Common service / agent / updater patterns
    r"^[a-z][a-z0-9_-]*(service|agent|updater|update|tray|notify|notification|monitor)\.exe$",
    // Antivirus / security
    r"^(msmpeng|nissrv|securityhealth|mpcmdrun|mssense)\.exe$",
    // Game / app store helpers (but NOT the launcher exes themselves)
    r"^(steamwebhelper|epicwebhelper|originwebhelperservice)\.exe$",
];

fn helper_set() -> &'static RegexSet {
    static SET: OnceLock<RegexSet> = OnceLock::new();
    SET.get_or_init(|| {
        RegexSet::new(HELPER_PATTERNS).expect("HELPER_PATTERNS valid regex")
    })
}

pub fn is_helper_process(name: &str) -> bool {
    helper_set().is_match(&name.to_lowercase())
}

// ---------------------------------------------------------------------
// Category patterns. Sorted in priority order: a process matching
// gaming + development (rare but possible — e.g. someone has the
// VSCode AND a game running, the higher-priority gaming category
// wins on the per-process classify call. The aggregate uses the
// SUM of CPU+GPU per category, so the active category emerges on
// its own — priority only matters when a single process is
// ambiguous.
// ---------------------------------------------------------------------

const GAMING_PATTERNS: &[&str] = &[
    // Specific titles (subset of JS rules — top traffic ones)
    r"^(valorant|valorant-win64-shipping|fortnite|fortniteclient-win64-shipping|cs2|csgo|minecraftlauncher|minecraft|roblox|robloxplayerbeta|genshinimpact|hk4e|overwatch|apex_legends|r5apex|cyberpunk2077|witcher3|gta5|gtav|rdr2|eldenring|starfield|palworld|baldursgate3|dota2|league ?of ?legends|leagueclient|leagueclientux|warzone|cod|destiny2|monsterhunter|mhrise|mhworld|forza|forzahorizon[0-9]*|hogwartslegacy|gow|godofwar|tlou|spiderman|deathloop|deathstranding|hades|hadesii|hollowknight|silksong|stardew|terraria|valheim|noita|deeprockgalactic|drg|helldivers[0-9]?|wolfenstein[a-z0-9]*|doom[a-z0-9]*|borderlands[0-9]?|sekiro|darksouls[0-9]?|ds[0-9]+)\.exe$",
    // Engine shipping-build suffixes
    r"-(shipping|win64-shipping|win64|windowsnoeditor|trunk|finalrelease)\.exe$",
    // Launchers — these are gaming-adjacent but should only contribute
    // to gaming category, not single-handedly tip it.
    r"^(steam|epicgameslauncher|battle\.net|riotclient|riotclientservices|uplay|upc|ubisoftconnect|rockstargameslauncher|bethesdanetlauncher|xboxapp|gog\.galaxyclient|gog ?galaxy|origin)\.exe$",
];

const EDITING_PATTERNS: &[&str] = &[
    r"^(resolve|davinciresolve|premiere ?pro|adobe premiere pro|premiere|afterfx|after ?effects|photoshop|lightroom|lightroomclassic|illustrator|indesign|audition|adobe audition|media ?encoder|adobe ?media ?encoder|handbrake|handbrakecli|ffmpeg|obs64|obs|streamlabs|xsplit|blender|cinema4d|maya|3dsmax|houdini|nuke|fusion|vegas|vegaspro|kdenlive|gimp|gimp-[0-9.]+|inkscape|krita|audacity|ableton|fl(64)?|flstudio|cubase|reaper|protools|capcut|filmora|hitfilm|unrealeditor|unityeditor|godot)\.exe$",
];

const DEVELOPMENT_PATTERNS: &[&str] = &[
    // IDEs / editors
    r"^(code|code - insiders|cursor|windsurf|zed|devenv|idea64|idea|webstorm64|pycharm64|pycharm|phpstorm64|rubymine64|clion64|goland64|rider64|datagrip64|studio64|androidstudio|xcode|eclipse|netbeans|sublime_text|subl|atom|notepad\+\+|gvim|nvim-qt|emacs|windowsterminal|wt|alacritty|wezterm|warp|hyper|mobaxterm)\.exe$",
    // Build / runtime tools (only count when an IDE is also present in
    // practice — we don't enforce that here, but the aggregate weights
    // by CPU so transient build spikes don't outvote a sustained game)
    r"^(cargo|rustc|dotnet|msbuild|cmake|ninja|gradle|gradlew|mvn|tsc|vite|webpack|rollup|esbuild|docker ?desktop|docker)\.exe$",
];

const STREAMING_PATTERNS: &[&str] = &[
    r"^(vlc|mpv|mpc-hc|mpc-hc64|mpc-be|mpc-be64|plex|plexamp|plexampdesktop|kodi|jellyfin|jellyfindesktop|wmplayer|groovemusic|winamp|foobar2000|musicbee|tidal|aimp|spotify|appledigitalmaster)\.exe$",
];

const COMMUNICATION_PATTERNS: &[&str] = &[
    r"^(discord|slack|teams|ms-teams|webex|webexmeeting|zoom|zoomruntime|skype|whatsapp|signal|telegram|element|wire|mattermost|rocket\.chat|hangouts|googleduo|googlemeet)\.exe$",
];

const BROWSING_PATTERNS: &[&str] = &[
    r"^(chrome|firefox|msedge|brave|opera|vivaldi|arc|tor browser|tor\.exe|librewolf|waterfox|safari|orion)\.exe$",
];

fn category_sets() -> &'static [(WorkloadType, &'static RegexSet)] {
    static SETS: OnceLock<Vec<(WorkloadType, RegexSet)>> = OnceLock::new();
    static REFS: OnceLock<Vec<(WorkloadType, &'static RegexSet)>> = OnceLock::new();
    let owned = SETS.get_or_init(|| {
        // Build order = priority order: a name that somehow matches
        // multiple categories is classified as the FIRST in this list.
        // Gaming has the highest priority because game exes are
        // distinctive; ambiguity in the other categories is rarer.
        vec![
            (
                WorkloadType::Gaming,
                RegexSet::new(GAMING_PATTERNS).expect("GAMING regex"),
            ),
            (
                WorkloadType::Editing,
                RegexSet::new(EDITING_PATTERNS).expect("EDITING regex"),
            ),
            (
                WorkloadType::Development,
                RegexSet::new(DEVELOPMENT_PATTERNS).expect("DEVELOPMENT regex"),
            ),
            (
                WorkloadType::Streaming,
                RegexSet::new(STREAMING_PATTERNS).expect("STREAMING regex"),
            ),
            (
                WorkloadType::Communication,
                RegexSet::new(COMMUNICATION_PATTERNS).expect("COMMUNICATION regex"),
            ),
            (
                WorkloadType::Browsing,
                RegexSet::new(BROWSING_PATTERNS).expect("BROWSING regex"),
            ),
        ]
    });
    REFS.get_or_init(|| owned.iter().map(|(t, s)| (*t, s)).collect())
}

/// Classify a single process by name. Returns `None` for helper
/// processes (filtered upstream by callers) and for anything that
/// doesn't match any category pattern.
pub fn classify(name: &str) -> Option<WorkloadType> {
    let lower = name.to_lowercase();
    if helper_set().is_match(&lower) {
        return None;
    }
    for (ty, set) in category_sets() {
        if set.is_match(&lower) {
            return Some(*ty);
        }
    }
    None
}

/// Per-process input row for the aggregator.
#[derive(Debug, Clone)]
pub struct WorkloadInput {
    pub pid: u32,
    pub name: String,
    pub cpu_percent: f64,
    pub gpu_percent: f64,
    pub memory_mb: f64,
}

/// Contributor returned from the aggregator — a single process that
/// participated in the dominant category's sum.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkloadContributor {
    pub pid: u32,
    pub name: String,
    pub category: WorkloadType,
    pub cpu_percent: f64,
    pub gpu_percent: f64,
    pub memory_mb: f64,
}

/// Aggregate output of `aggregate()`. `dominant` is the category with
/// the largest combined CPU+GPU sum across matched processes; falls
/// back to `Other` when nothing matched.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkloadAggregate {
    pub dominant: WorkloadType,
    pub dominant_label: &'static str,
    /// Fraction of matched processes that classified as the dominant
    /// category. 1.0 = unanimous (only games running). 0.0 means no
    /// process matched any rule.
    pub confidence: f64,
    pub contributors: Vec<WorkloadContributor>,
}

/// Roll up a process list into a workload guess. Helper processes are
/// excluded; matched processes vote with CPU% + GPU% as combined
/// weight; the category with the largest weight wins.
///
/// Tiebreaker: when no process has nonzero CPU+GPU (PDH cold-start,
/// idle machine) OR when two categories tie, the category with the
/// most matching processes wins. Without this, an all-zero machine
/// arbitrarily pinned to whichever category HashMap iteration happened
/// to hit first — observed in the wild as a 71-process snapshot
/// with 60 chrome.exe and 1 game launcher reporting `dominant: gaming`
/// at 1.4 % confidence.
pub fn aggregate(processes: &[WorkloadInput]) -> WorkloadAggregate {
    use std::collections::HashMap;
    let mut weights: HashMap<WorkloadType, f64> = HashMap::new();
    let mut counts: HashMap<WorkloadType, usize> = HashMap::new();
    let mut classifications: Vec<(WorkloadType, &WorkloadInput)> = Vec::new();
    for p in processes {
        if let Some(cat) = classify(&p.name) {
            let weight = p.cpu_percent + p.gpu_percent;
            *weights.entry(cat).or_insert(0.0) += weight.max(0.0);
            *counts.entry(cat).or_insert(0) += 1;
            classifications.push((cat, p));
        }
    }
    // Pick by (weight, count) — weight first (the active category
    // signal), count as tiebreaker (the population signal). When the
    // machine is idle / cold-start, weights are all 0 and count
    // decides; when one category is genuinely active, its weight
    // dominates the tuple ordering regardless of count.
    let dominant = counts
        .iter()
        .max_by(|a, b| {
            let aw = weights.get(a.0).copied().unwrap_or(0.0);
            let bw = weights.get(b.0).copied().unwrap_or(0.0);
            aw.partial_cmp(&bw)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a.1.cmp(b.1))
        })
        .map(|(t, _)| *t)
        .unwrap_or(WorkloadType::Other);
    let total_matches = classifications.len() as f64;
    let dominant_matches = classifications.iter().filter(|(t, _)| *t == dominant).count() as f64;
    let confidence = if total_matches > 0.0 {
        dominant_matches / total_matches
    } else {
        0.0
    };
    // Top contributors: sort by weight desc, cap at 8 for compact MCP output.
    let mut contributors: Vec<WorkloadContributor> = classifications
        .into_iter()
        .map(|(cat, p)| WorkloadContributor {
            pid: p.pid,
            name: p.name.clone(),
            category: cat,
            cpu_percent: p.cpu_percent,
            gpu_percent: p.gpu_percent,
            memory_mb: p.memory_mb,
        })
        .collect();
    contributors.sort_by(|a, b| {
        let aw = a.cpu_percent + a.gpu_percent;
        let bw = b.cpu_percent + b.gpu_percent;
        bw.partial_cmp(&aw).unwrap_or(std::cmp::Ordering::Equal)
    });
    contributors.truncate(8);
    WorkloadAggregate {
        dominant,
        dominant_label: dominant.label(),
        confidence,
        contributors,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(name: &str, cpu: f64, gpu: f64) -> WorkloadInput {
        WorkloadInput {
            pid: 0,
            name: name.into(),
            cpu_percent: cpu,
            gpu_percent: gpu,
            memory_mb: 0.0,
        }
    }

    #[test]
    fn helpers_are_filtered() {
        assert!(is_helper_process("svchost.exe"));
        assert!(is_helper_process("RuntimeBroker.exe"));
        assert!(is_helper_process("steamwebhelper.exe"));
        assert!(!is_helper_process("steam.exe"));
        assert!(!is_helper_process("chrome.exe"));
        assert!(classify("svchost.exe").is_none());
    }

    #[test]
    fn classifies_dominant_categories() {
        assert_eq!(classify("Code.exe"), Some(WorkloadType::Development));
        assert_eq!(classify("Cursor.exe"), Some(WorkloadType::Development));
        assert_eq!(classify("idea64.exe"), Some(WorkloadType::Development));
        assert_eq!(classify("photoshop.exe"), Some(WorkloadType::Editing));
        assert_eq!(classify("blender.exe"), Some(WorkloadType::Editing));
        assert_eq!(classify("obs64.exe"), Some(WorkloadType::Editing));
        assert_eq!(classify("discord.exe"), Some(WorkloadType::Communication));
        assert_eq!(classify("slack.exe"), Some(WorkloadType::Communication));
        assert_eq!(classify("chrome.exe"), Some(WorkloadType::Browsing));
        assert_eq!(classify("firefox.exe"), Some(WorkloadType::Browsing));
        assert_eq!(classify("spotify.exe"), Some(WorkloadType::Streaming));
        assert_eq!(classify("vlc.exe"), Some(WorkloadType::Streaming));
        assert_eq!(classify("Valorant-Win64-Shipping.exe"), Some(WorkloadType::Gaming));
        assert_eq!(classify("MyGame-Win64-Shipping.exe"), Some(WorkloadType::Gaming));
        assert_eq!(classify("unknownapp.exe"), None);
    }

    #[test]
    fn aggregate_picks_largest_weight() {
        let agg = aggregate(&[
            p("chrome.exe", 5.0, 1.0),
            p("Code.exe", 30.0, 0.0),
            p("discord.exe", 2.0, 0.0),
            p("unknown.exe", 50.0, 0.0), // doesn't match, doesn't count
        ]);
        assert_eq!(agg.dominant, WorkloadType::Development);
        assert!(agg.confidence > 0.0 && agg.confidence <= 1.0);
        assert!(agg.contributors.iter().any(|c| c.name == "Code.exe"));
    }

    #[test]
    fn empty_input_returns_other() {
        let agg = aggregate(&[]);
        assert_eq!(agg.dominant, WorkloadType::Other);
        assert_eq!(agg.confidence, 0.0);
        assert!(agg.contributors.is_empty());
    }

    #[test]
    fn zero_weights_tiebreak_by_contributor_count() {
        // Simulates the cold-PDH first-call case where every process
        // reports cpu=0 gpu=0. Without the count tiebreaker, the
        // aggregator picked whichever HashMap entry iterated first
        // (observed as "dominant: gaming" with 60 chrome.exe and
        // 1 game launcher — clearly wrong). After fix: the majority
        // category wins.
        let inputs: Vec<WorkloadInput> = (0..60)
            .map(|_| p("chrome.exe", 0.0, 0.0))
            .chain(std::iter::once(p("steam.exe", 0.0, 0.0)))
            .collect();
        let agg = aggregate(&inputs);
        assert_eq!(
            agg.dominant,
            WorkloadType::Browsing,
            "expected Browsing to win on count when all weights are zero (got {:?})",
            agg.dominant,
        );
    }
}

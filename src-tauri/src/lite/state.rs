//! Shared telemetry state + the background poll thread.
//!
//! THE GATE (same as the tray widget): a single background thread polls the
//! native DLL once per `refresh_ms` and calls `ctx.request_repaint()`. The UI
//! thread otherwise sleeps — there is deliberately no `request_repaint()` in the
//! per-frame `update()`, so the window does not free-run at the display rate.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use eframe::egui;
use taskmanagerplus_lib::ffi::{self, CoreCpuInfo, PerformanceSnapshot};

/// One merged process row for the table: identity + memory (from the process
/// list) joined with CPU% (from the power list) by PID.
#[derive(Clone)]
pub struct Proc {
    pub pid: u32,
    pub name: String,
    pub memory_mb: f64,
    pub cpu_percent: f64,
    pub gpu_percent: f64,
    pub disk_bps: f64, // read + write bytes/s
    pub net_bps: f64,  // send + recv bytes/s
    /// Multi-process role slug from the classifier (`renderer`, `gpu`,
    /// `utility`, …); labels the child rows of an expanded group.
    pub process_type: Option<String>,
    /// Best visible-window title for this PID (empty for background/helper
    /// processes) — shown to distinguish instances inside an expanded group.
    pub window_title: String,
}

/// A fixed-length rolling series for one graph line.
#[derive(Clone, Default)]
pub struct Series {
    pub points: VecDeque<f64>,
}

impl Series {
    pub const CAP: usize = 120; // ~2 min at the 1 s default cadence

    pub fn push(&mut self, v: f64) {
        if self.points.len() >= Self::CAP {
            self.points.pop_front();
        }
        self.points.push_back(v);
    }
}

/// Rolling history for the Performance page graphs.
#[derive(Clone, Default)]
pub struct History {
    pub cpu: Series,          // %
    pub mem: Series,          // %
    pub disk: Series,         // bytes/s (read+write)
    pub net: Series,          // bytes/s (send+recv)
    pub gpu: Series,          // %
    pub npu: Series,          // %
}

impl History {
    fn record(&mut self, s: &PerformanceSnapshot) {
        let mem_pct = if s.total_ram_bytes > 0 {
            s.used_ram_bytes as f64 / s.total_ram_bytes as f64 * 100.0
        } else {
            0.0
        };
        self.cpu.push(s.cpu_usage_percent);
        self.mem.push(mem_pct);
        self.disk.push(s.disk_read_per_sec + s.disk_write_per_sec);
        self.net.push(s.net_send_per_sec + s.net_recv_per_sec);
        self.gpu.push(s.gpu_usage_percent);
        self.npu.push(s.npu_usage_percent);
    }
}

/// Everything the UI reads each frame. Written only by the poll thread.
#[derive(Default)]
pub struct Shared {
    pub snap: Option<PerformanceSnapshot>,
    pub procs: Vec<Proc>,
    /// Per-core CPU usage (for the Performance page's core grid).
    pub per_core: Vec<CoreCpuInfo>,
    pub history: History,
    pub last_error: Option<String>,
    /// Bumped every successful poll so the UI can tell "no data yet" apart from
    /// "stale but present".
    pub tick: u64,
}

pub type SharedState = Arc<Mutex<Shared>>;

/// Shared, live-adjustable poll cadence in milliseconds. The Settings page
/// writes it; the poll loop reads it each iteration so a change takes effect on
/// the next tick without restarting the thread.
pub type PollInterval = Arc<AtomicU64>;

/// Spawn the reactive-repaint poll loop. Owns a clone of the egui context to
/// wake the UI exactly when fresh telemetry lands.
pub fn spawn_poller(ctx: egui::Context, state: SharedState, interval: PollInterval) {
    thread::spawn(move || loop {
        let snap = ffi::load_performance_snapshot();
        let procs = merged_processes();
        let per_core = ffi::load_per_core_cpu().unwrap_or_default();

        if let Ok(mut g) = state.lock() {
            match snap {
                Ok(s) => {
                    g.history.record(&s);
                    g.snap = Some(s);
                    g.last_error = None;
                }
                Err(e) => g.last_error = Some(e),
            }
            if let Some(p) = procs {
                g.procs = p;
            }
            g.per_core = per_core;
            g.tick = g.tick.wrapping_add(1);
        }
        ctx.request_repaint();

        let ms = interval.load(Ordering::Relaxed).clamp(250, 10_000);
        thread::sleep(Duration::from_millis(ms));
    });
}

/// Join the process list (name + memory) with the power list (CPU%) by PID.
/// Returns None if the process list itself fails, so the UI keeps the last good
/// snapshot instead of flickering to empty.
fn merged_processes() -> Option<Vec<Proc>> {
    use std::collections::HashMap;
    let list = ffi::load_process_list().ok()?;
    // The per-metric lists are all best-effort; a missing one just means that
    // column reads 0 for this tick rather than dropping the whole table.
    let mut cpu_by_pid: HashMap<u32, f64> = HashMap::new();
    for p in ffi::load_power_list().unwrap_or_default() {
        cpu_by_pid.insert(p.pid, p.cpu_percent);
    }
    let mut gpu_by_pid: HashMap<u32, f64> = HashMap::new();
    for p in ffi::load_gpu_list().unwrap_or_default() {
        *gpu_by_pid.entry(p.pid).or_default() += p.gpu_usage_percent;
    }
    let mut disk_by_pid: HashMap<u32, f64> = HashMap::new();
    for p in ffi::load_disk_list().unwrap_or_default() {
        disk_by_pid.insert(p.pid, p.read_bytes_per_sec + p.write_bytes_per_sec);
    }
    let mut net_by_pid: HashMap<u32, f64> = HashMap::new();
    for p in ffi::load_network_list().unwrap_or_default() {
        net_by_pid.insert(p.pid, p.send_bytes_per_sec + p.recv_bytes_per_sec);
    }

    Some(
        list.into_iter()
            .map(|p| {
                let name = if p.display_name.is_empty() {
                    p.name
                } else {
                    p.display_name
                };
                Proc {
                    pid: p.pid,
                    name,
                    memory_mb: p.private_working_set_mb,
                    cpu_percent: cpu_by_pid.get(&p.pid).copied().unwrap_or(0.0),
                    gpu_percent: gpu_by_pid.get(&p.pid).copied().unwrap_or(0.0),
                    disk_bps: disk_by_pid.get(&p.pid).copied().unwrap_or(0.0),
                    net_bps: net_by_pid.get(&p.pid).copied().unwrap_or(0.0),
                    process_type: p.process_type,
                    window_title: p.window_title,
                }
            })
            .collect(),
    )
}

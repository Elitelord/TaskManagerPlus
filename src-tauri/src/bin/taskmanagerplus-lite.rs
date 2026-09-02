// GUI subsystem: no console window when launched from the app or a shortcut.
#![windows_subsystem = "windows"]

//! Phase A (lite mode): `taskmanagerplus-lite.exe` — the full native window.
//!
//! A normal decorated eframe/egui window that reuses the entire Rust backend by
//! calling `taskmanagerplus_lib::ffi` directly (no `invoke`, no webview). Runs as
//! its own process, exactly like the Phase 0 tray widget. Covers the core pages
//! a task manager earns its keep on — Processes, Performance graphs, Battery,
//! Settings — and leaves the heavy pages (Storage, Insights, AI) to the webview.
//!
//! Module layout (all UI stays in this bin so the main app never links eframe):
//!   theme      palette / fonts / egui style, ported from tokens.css
//!   fmt        byte + rate formatting helpers
//!   state      shared telemetry + the reactive-repaint poll thread (THE GATE)
//!   processes  the virtualized process table
//!   app        window shell: sidebar nav, header strip, view dispatch

// The UI submodules live in `src/lite/`, one level up and OUTSIDE `src/bin/`.
// That placement is load-bearing, not cosmetic: Tauri's bundler enumerates
// binaries with `read_dir("src/bin")` and takes `file_stem()` of every entry —
// directories included. A `src/bin/lite/` subdirectory therefore invented a
// phantom binary named `lite`, and bundling died with "failed to bundle
// project: when getting size of ...\lite.exe" (v2.7.0, twice). Keep `src/bin/`
// containing nothing but the entry-point `.rs` files.
//
// `#[path]` is relative to the containing file's directory (`src/bin/`), hence
// the `../`.
#[path = "../lite/theme.rs"]
mod theme;
#[path = "../lite/fmt.rs"]
mod fmt;
#[path = "../lite/state.rs"]
mod state;
#[path = "../lite/processes.rs"]
mod processes;
#[path = "../lite/perf.rs"]
mod perf;
#[path = "../lite/battery.rs"]
mod battery;
#[path = "../lite/settings.rs"]
mod settings;
#[path = "../lite/app.rs"]
mod app;

use std::sync::{Arc, Mutex};

use eframe::egui;

use app::LiteApp;
use state::{Shared, SharedState};

fn main() -> eframe::Result<()> {
    // Loaded here (not just in LiteApp) so window-creation options — always on
    // top — can be honored before the viewport is built.
    let saved = settings::LiteSettings::load();

    let mut viewport = egui::ViewportBuilder::default()
        .with_inner_size([1100.0, 740.0])
        .with_min_inner_size([720.0, 480.0])
        .with_title("TaskManagerPlus Lite");
    if saved.always_on_top {
        viewport = viewport.with_always_on_top();
    }

    // NOTE: hardware GL is required — see the Phase 0 note in tmp_widget.rs.
    // HardwareAcceleration::Off fails to create a context on Windows.
    let options = eframe::NativeOptions {
        viewport,
        ..Default::default()
    };

    let state: SharedState = Arc::new(Mutex::new(Shared::default()));
    eframe::run_native(
        "TaskManagerPlus Lite",
        options,
        Box::new(move |cc| Ok(Box::new(LiteApp::new(cc, state, saved)))),
    )
}

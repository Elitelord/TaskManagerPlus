// GUI subsystem: no console window flashes when the tray launches this.
#![windows_subsystem = "windows"]

//! Phase 0 (lite mode): native egui tray widget.
//!
//! Replaces the old webview tray popup — which spawned a whole second WebView2
//! renderer (~100-180 MB) to draw a 320x400 panel. This is a native eframe/egui
//! window instead, run as a SEPARATE PROCESS so there's no event-loop conflict
//! with the Tauri app.
//!
//! Two things this proves for the wider lite-mode effort:
//!   1. THE GATE — reactive repaint. A background thread fetches telemetry once
//!      per REFRESH_MS and calls `request_repaint()`; the UI thread otherwise
//!      sleeps. There is deliberately NO `request_repaint()` in `update()`, so
//!      the widget does NOT free-run at the display refresh rate.
//!   2. The direct-call data path — `taskmanagerplus_lib::ffi::load_performance_snapshot()`
//!      called directly, no `invoke`, no JSON, no IPC round-trip.
//!
//! Launched by the tray with `--pos <x> <y>` (physical pixels) to anchor near
//! the tray icon; falls back to OS-default placement if omitted.

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use eframe::egui;
use taskmanagerplus_lib::ffi::{self, PerformanceSnapshot};

/// Poll cadence. Phase 0 hardcodes 1 s; Phase A shares the app's `refreshRate`
/// via a common on-disk settings store (the React side keeps it in localStorage
/// today, which this process can't read).
const REFRESH_MS: u64 = 1000;
const WIDTH: f32 = 320.0;
/// Start generous so nothing is clipped on the first frames; the window then
/// auto-shrinks to exactly fit the content (see `update`), so the final height
/// is content-driven and there's neither empty space nor clipping.
const INITIAL_HEIGHT: f32 = 420.0;
/// Small breathing room below the footer once auto-fitted.
const BOTTOM_MARGIN: f32 = 8.0;
/// Grab band at the window edges for manual resize (undecorated windows have no
/// OS resize handles).
const RESIZE_MARGIN: f32 = 6.0;

// Palette pulled from src/styles/tokens.css (dark theme). Solid approximations
// of the alpha tokens, which read the same over the near-black background.
const BG: egui::Color32 = egui::Color32::from_rgb(10, 10, 10); // --bg-elevated #0a0a0a
const TEXT_PRIMARY: egui::Color32 = egui::Color32::from_rgb(234, 237, 242); // --text-primary
const TEXT_SECONDARY: egui::Color32 = egui::Color32::from_rgb(138, 143, 160); // --text-secondary
const ACCENT: egui::Color32 = egui::Color32::from_rgb(91, 156, 246); // --accent-primary
const BAR_TRACK: egui::Color32 = egui::Color32::from_rgb(34, 34, 38);
const BTN_FILL: egui::Color32 = egui::Color32::from_rgb(22, 22, 24); // ~rgba(255,255,255,0.04) on black
const BTN_BORDER: egui::Color32 = egui::Color32::from_rgb(48, 48, 52); // ~--border-strong on black
const GREEN: egui::Color32 = egui::Color32::from_rgb(0x22, 0xc5, 0x5e);
const ORANGE: egui::Color32 = egui::Color32::from_rgb(0xf5, 0x9e, 0x0b);
const RED: egui::Color32 = egui::Color32::from_rgb(0xef, 0x44, 0x44);

type SharedSnap = Arc<Mutex<Option<PerformanceSnapshot>>>;

struct WidgetApp {
    snap: SharedSnap,
    /// Set once we've resized the window to fit the real (data-populated) layout.
    fitted: bool,
}

impl WidgetApp {
    fn new(cc: &eframe::CreationContext<'_>, snap: SharedSnap) -> Self {
        install_fonts(&cc.egui_ctx);
        cc.egui_ctx.set_visuals(egui::Visuals::dark());

        // Reactive-repaint driver (THE GATE). Owns a clone of the egui Context so
        // it can wake the UI exactly when fresh telemetry lands, and nothing else.
        let ctx = cc.egui_ctx.clone();
        let snap_bg = snap.clone();
        thread::spawn(move || loop {
            if let Ok(s) = ffi::load_performance_snapshot() {
                if let Ok(mut g) = snap_bg.lock() {
                    *g = Some(s);
                }
                ctx.request_repaint();
            }
            thread::sleep(Duration::from_millis(REFRESH_MS));
        });

        Self { snap, fitted: false }
    }
}

impl eframe::App for WidgetApp {
    fn clear_color(&self, _visuals: &egui::Visuals) -> [f32; 4] {
        let c = BG;
        [
            c.r() as f32 / 255.0,
            c.g() as f32 / 255.0,
            c.b() as f32 / 255.0,
            1.0,
        ]
    }

    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        let snap = self.snap.lock().ok().and_then(|g| g.clone());
        let has_data = snap.is_some();
        let content_h = egui::CentralPanel::default()
            .frame(egui::Frame::none().fill(BG).inner_margin(egui::Margin::same(0.0)))
            .show(ctx, |ui| {
                draw_widget(ui, snap.as_ref());
                // The cursor's top (captured before CentralPanel expands its
                // min_rect to fill the window) is the true content bottom.
                ui.cursor().top()
            })
            .inner;

        // Auto-fit the window to the content, once, after real data has laid out
        // (so we size to the full six-row + footer layout, not the spinner).
        if !self.fitted && has_data {
            self.fitted = true;
            ctx.send_viewport_cmd(egui::ViewportCommand::InnerSize(
                egui::vec2(WIDTH, content_h + BOTTOM_MARGIN),
            ));
        }

        handle_edge_resize(ctx);
        // Intentionally NO request_repaint() here — reactive mode.
    }
}

// -----------------------------------------------------------------------------
// Fonts — match the main app: Segoe UI (system-ui) for text, Consolas for the
// monospace numeric values (src/styles/tokens.css --font-mono fallback).
// -----------------------------------------------------------------------------
fn install_fonts(ctx: &egui::Context) {
    let mut fonts = egui::FontDefinitions::default();
    if let Ok(bytes) = std::fs::read(r"C:\Windows\Fonts\segoeui.ttf") {
        fonts.font_data.insert("segoe".into(), egui::FontData::from_owned(bytes).into());
        fonts
            .families
            .entry(egui::FontFamily::Proportional)
            .or_default()
            .insert(0, "segoe".into());
    }
    if let Ok(bytes) = std::fs::read(r"C:\Windows\Fonts\consola.ttf") {
        fonts.font_data.insert("consolas".into(), egui::FontData::from_owned(bytes).into());
        fonts
            .families
            .entry(egui::FontFamily::Monospace)
            .or_default()
            .insert(0, "consolas".into());
    }
    ctx.set_fonts(fonts);
}

// -----------------------------------------------------------------------------
// UI
// -----------------------------------------------------------------------------

fn threshold(pct: f64, warn: f64, crit: f64) -> egui::Color32 {
    if pct > crit { RED } else if pct > warn { ORANGE } else { GREEN }
}

fn format_rate(bps: f64) -> String {
    if bps < 1024.0 { format!("{:.0} B/s", bps) }
    else if bps < 1_048_576.0 { format!("{:.1} KB/s", bps / 1024.0) }
    else { format!("{:.1} MB/s", bps / 1_048_576.0) }
}

fn open_button(ui: &mut egui::Ui) {
    // egui's default button_padding is only 1px vertically, which leaves the
    // text's line-box sitting high inside the border. Symmetric padding centers it.
    ui.spacing_mut().button_padding = egui::vec2(10.0, 5.0);
    let btn = egui::Button::new(egui::RichText::new("Open").size(11.0).color(TEXT_SECONDARY))
        .fill(BTN_FILL)
        .stroke(egui::Stroke::new(1.0, BTN_BORDER))
        .rounding(6.0);
    if ui.add(btn).clicked() {
        open_main_window();
    }
}

fn draw_widget(ui: &mut egui::Ui, snap: Option<&PerformanceSnapshot>) {
    // Whole-window drag: the undecorated popup has no title bar, so dragging the
    // interior moves it. Suppressed at the edges (those resize) and, because the
    // Open button is a later widget on top, over the button.
    let drag = ui.interact(ui.max_rect(), ui.id().with("window-drag"), egui::Sense::drag());
    if drag.dragged() && edge_hit(ui.ctx()).is_none() {
        ui.ctx().send_viewport_cmd(egui::ViewportCommand::StartDrag);
    }

    ui.add_space(10.0);
    ui.horizontal(|ui| {
        ui.add_space(12.0);
        ui.label(egui::RichText::new("TaskManager").size(16.0).strong().color(TEXT_PRIMARY));
        ui.label(egui::RichText::new("+").size(16.0).strong().color(ACCENT));
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            ui.add_space(12.0);
            open_button(ui);
        });
    });
    ui.add_space(8.0);
    separator(ui);

    let Some(s) = snap else {
        ui.add_space(24.0);
        ui.vertical_centered(|ui| {
            ui.spinner();
            ui.add_space(6.0);
            ui.label(egui::RichText::new("Reading system data…").color(TEXT_SECONDARY));
        });
        return;
    };

    let cpu = s.cpu_usage_percent;
    let ram_pct = if s.total_ram_bytes > 0 {
        (s.used_ram_bytes as f64 / s.total_ram_bytes as f64) * 100.0
    } else { 0.0 };
    let gpu = s.gpu_usage_percent;
    let battery = s.battery_percent;

    metric_row(ui, "CPU", &format!("{:.1}%", cpu), Some(cpu), threshold(cpu, 50.0, 80.0));
    metric_row(
        ui, "Memory",
        &format!("{:.1} / {:.1} GB",
            s.used_ram_bytes as f64 / 1.073_741_824e9,
            s.total_ram_bytes as f64 / 1.073_741_824e9),
        Some(ram_pct), threshold(ram_pct, 60.0, 85.0),
    );
    metric_row(ui, "GPU", &format!("{:.1}%", gpu), Some(gpu), threshold(gpu, 50.0, 80.0));
    metric_row(ui, "Disk", &format_rate(s.disk_read_per_sec + s.disk_write_per_sec), None, ACCENT);
    metric_row(ui, "Network", &format_rate(s.net_send_per_sec + s.net_recv_per_sec), None, ACCENT);
    metric_row(
        ui, "Battery",
        &format!("{:.0}%{}", battery, if s.is_charging { " (AC)" } else { "" }),
        Some(battery),
        if battery < 20.0 { RED } else if battery < 50.0 { ORANGE } else { GREEN },
    );

    ui.add_space(10.0);
    separator(ui);
    ui.add_space(2.0);
    ui.horizontal(|ui| {
        ui.add_space(12.0);
        ui.label(egui::RichText::new(format!("{} processes", s.process_count)).color(TEXT_SECONDARY));
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            ui.add_space(12.0);
            ui.label(egui::RichText::new(format!("{:.1} W", s.power_draw_watts)).monospace().color(TEXT_SECONDARY));
        });
    });
}

/// Which resize edge/corner (if any) the pointer is over, with the cursor to show.
fn edge_hit(ctx: &egui::Context) -> Option<(egui::viewport::ResizeDirection, egui::CursorIcon)> {
    use egui::viewport::ResizeDirection as RD;
    use egui::CursorIcon as CI;

    let rect = ctx.screen_rect();
    let p = ctx.pointer_hover_pos()?;
    let m = RESIZE_MARGIN;
    let (left, right) = (p.x <= rect.left() + m, p.x >= rect.right() - m);
    let (top, bottom) = (p.y <= rect.top() + m, p.y >= rect.bottom() - m);

    match (left, right, top, bottom) {
        (true, _, true, _) => Some((RD::NorthWest, CI::ResizeNwSe)),
        (_, true, true, _) => Some((RD::NorthEast, CI::ResizeNeSw)),
        (true, _, _, true) => Some((RD::SouthWest, CI::ResizeNeSw)),
        (_, true, _, true) => Some((RD::SouthEast, CI::ResizeNwSe)),
        (true, _, _, _) => Some((RD::West, CI::ResizeHorizontal)),
        (_, true, _, _) => Some((RD::East, CI::ResizeHorizontal)),
        (_, _, true, _) => Some((RD::North, CI::ResizeVertical)),
        (_, _, _, true) => Some((RD::South, CI::ResizeVertical)),
        _ => None,
    }
}

/// Manual edge/corner resize for the undecorated window: show the resize cursor
/// in the edge grab band and, on press, hand off to the OS resize loop.
/// `resizable(true)` alone gives no handles on a borderless window.
fn handle_edge_resize(ctx: &egui::Context) {
    if let Some((dir, cursor)) = edge_hit(ctx) {
        ctx.set_cursor_icon(cursor);
        if ctx.input(|i| i.pointer.primary_pressed()) {
            ctx.send_viewport_cmd(egui::ViewportCommand::BeginResize(dir));
        }
    }
}

fn separator(ui: &mut egui::Ui) {
    let rect = ui.max_rect();
    let y = ui.cursor().top();
    ui.painter().hline(
        rect.left()..=rect.right(),
        y,
        egui::Stroke::new(1.0, egui::Color32::from_rgb(28, 28, 30)),
    );
}

fn metric_row(ui: &mut egui::Ui, label: &str, value: &str, percent: Option<f64>, color: egui::Color32) {
    ui.add_space(8.0);
    ui.horizontal(|ui| {
        ui.add_space(12.0);
        ui.label(egui::RichText::new(label).color(TEXT_SECONDARY));
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            ui.add_space(12.0);
            // Numeric values in monospace + tabular feel, matching --font-mono.
            ui.label(egui::RichText::new(value).monospace().color(TEXT_PRIMARY));
        });
    });
    if let Some(pct) = percent {
        ui.add_space(4.0);
        let frac = (pct / 100.0).clamp(0.0, 1.0) as f32;
        ui.horizontal(|ui| {
            ui.add_space(12.0);
            // Width-adaptive so bars stretch when the window is resized.
            let bar_w = (ui.available_width() - 12.0).max(40.0);
            let (rect, _) = ui.allocate_exact_size(
                egui::vec2(bar_w, 5.0),
                egui::Sense::hover(),
            );
            let painter = ui.painter();
            painter.rect_filled(rect, 2.5, BAR_TRACK);
            let mut fill = rect;
            fill.set_width(rect.width() * frac);
            painter.rect_filled(fill, 2.5, color);
        });
    }
}

// -----------------------------------------------------------------------------
// "Open" → reveal the main Tauri window.
//
// Phase 0 best-effort: find the main window by title and show/focus it via Win32.
// KNOWN LIMITATION: this bypasses the app's `main-tray-background` event, so the
// React side's poller may stay paused (it resumes on that event). Wiring a
// proper widget→app signal is a Phase A task; for Phase 0 this proves the button.
// -----------------------------------------------------------------------------
#[cfg(windows)]
fn open_main_window() {
    use windows::core::{w, PCWSTR};
    use windows::Win32::UI::WindowsAndMessaging::{
        FindWindowW, SetForegroundWindow, ShowWindow, SW_SHOW,
    };
    unsafe {
        if let Ok(hwnd) = FindWindowW(PCWSTR::null(), w!("TaskManagerPlus")) {
            if !hwnd.0.is_null() {
                let _ = ShowWindow(hwnd, SW_SHOW);
                let _ = SetForegroundWindow(hwnd);
            }
        }
    }
}

#[cfg(not(windows))]
fn open_main_window() {}

// -----------------------------------------------------------------------------

fn parse_position() -> Option<egui::Pos2> {
    let args: Vec<String> = std::env::args().collect();
    let i = args.iter().position(|a| a == "--pos")?;
    let x: f32 = args.get(i + 1)?.parse().ok()?;
    let y: f32 = args.get(i + 2)?.parse().ok()?;
    Some(egui::pos2(x, y))
}

fn main() -> eframe::Result<()> {
    let mut viewport = egui::ViewportBuilder::default()
        .with_inner_size([WIDTH, INITIAL_HEIGHT])
        // Min size keeps the fixed content from overflowing when the user
        // resizes; height floor sits just under the auto-fitted content.
        .with_min_inner_size([280.0, 348.0])
        // Resizable so the runtime auto-fit `InnerSize` command takes effect
        // (resizable(false) blocks it). The window is undecorated, so there are
        // no user-facing resize handles regardless.
        .with_resizable(true)
        .with_decorations(false)
        // A tray flyout shouldn't appear in the taskbar/alt-tab (which also
        // removes the stray default window icon).
        .with_taskbar(false)
        .with_always_on_top();
    if let Some(pos) = parse_position() {
        viewport = viewport.with_position(pos);
    }

    // NOTE: hardware GL is required — HardwareAcceleration::Off fails to create a
    // context on Windows (egui needs GL 3.3+; the OS software GL is 1.1). So the
    // ~62 MB AMD OpenGL driver (atio6axx.dll) loads regardless, which is the bulk
    // of the widget's ~140 MB footprint. See the Phase 0 memory note.
    let options = eframe::NativeOptions {
        viewport,
        ..Default::default()
    };

    let snap: SharedSnap = Arc::new(Mutex::new(None));
    eframe::run_native(
        "TaskManagerPlus Widget",
        options,
        Box::new(move |cc| Ok(Box::new(WidgetApp::new(cc, snap)))),
    )
}

//! The lite window shell: sidebar navigation, a live header strip, and dispatch
//! to the per-page views.

use std::sync::atomic::AtomicU64;
use std::sync::Arc;

use eframe::egui;

use super::processes::ProcessesView;
use super::settings::{LiteSettings, SettingsView};
use super::state::{spawn_poller, PollInterval, SharedState};
use super::{battery, fmt, perf, theme};

#[derive(Clone, Copy, PartialEq)]
enum Tab {
    Processes,
    Performance,
    Battery,
    Settings,
}

pub struct LiteApp {
    state: SharedState,
    tab: Tab,
    processes: ProcessesView,
    settings: SettingsView,
    poll_interval: PollInterval,
}

impl LiteApp {
    pub fn new(cc: &eframe::CreationContext<'_>, state: SharedState, saved: LiteSettings) -> Self {
        theme::install_fonts(&cc.egui_ctx);
        theme::apply_style(&cc.egui_ctx);

        // THE GATE: reactive repaint driven from the poll thread. The cadence is
        // a shared atomic the Settings page updates live.
        let poll_interval: PollInterval = Arc::new(AtomicU64::new(saved.refresh_ms));
        spawn_poller(cc.egui_ctx.clone(), state.clone(), poll_interval.clone());

        let tab = tab_from(&saved.default_page);
        Self {
            state,
            tab,
            processes: ProcessesView::default(),
            settings: SettingsView::new(saved),
            poll_interval,
        }
    }
}

fn tab_from(page: &str) -> Tab {
    match page {
        "performance" => Tab::Performance,
        "battery" => Tab::Battery,
        "settings" => Tab::Settings,
        _ => Tab::Processes,
    }
}

impl eframe::App for LiteApp {
    fn clear_color(&self, _v: &egui::Visuals) -> [f32; 4] {
        let c = theme::BG_PAGE;
        [c.r() as f32 / 255.0, c.g() as f32 / 255.0, c.b() as f32 / 255.0, 1.0]
    }

    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        // Snapshot the shared state under a short lock, then release before drawing.
        let (snap, procs, history, per_core, poll_error) = {
            let g = self.state.lock().unwrap();
            (
                g.snap.clone(),
                g.procs.clone(),
                g.history.clone(),
                g.per_core.clone(),
                g.last_error.clone(),
            )
        };
        let has_data = snap.is_some();

        self.sidebar(ctx);
        self.header(ctx, snap.as_ref());

        egui::CentralPanel::default()
            .frame(egui::Frame::none().fill(theme::BG_PAGE).inner_margin(egui::Margin::same(14.0)))
            .show(ctx, |ui| {
                if !has_data {
                    ui.add_space(40.0);
                    ui.vertical_centered(|ui| {
                        ui.spinner();
                        ui.add_space(8.0);
                        ui.label(
                            egui::RichText::new("Reading system data…").color(theme::TEXT_SECONDARY),
                        );
                        if let Some(e) = &poll_error {
                            ui.add_space(8.0);
                            ui.label(egui::RichText::new(e).color(theme::RED));
                        }
                    });
                    return;
                }
                match self.tab {
                    Tab::Processes => self.processes.ui(ui, &procs),
                    Tab::Performance => {
                        if let Some(s) = &snap {
                            perf::ui(ui, s, &history, &per_core);
                        }
                    }
                    Tab::Battery => {
                        if let Some(s) = &snap {
                            battery::ui(ui, s);
                        }
                    }
                    Tab::Settings => self.settings.ui(ui, &self.poll_interval),
                }
            });
        // Intentionally NO request_repaint() — reactive mode.
    }
}

impl LiteApp {
    fn sidebar(&mut self, ctx: &egui::Context) {
        egui::SidePanel::left("nav")
            .exact_width(168.0)
            .resizable(false)
            .frame(
                egui::Frame::none()
                    .fill(theme::BG_SIDEBAR)
                    .inner_margin(egui::Margin::symmetric(10.0, 14.0)),
            )
            .show(ctx, |ui| {
                ui.horizontal(|ui| {
                    ui.add_space(4.0);
                    ui.label(egui::RichText::new("TaskManager").size(16.0).strong().color(theme::TEXT_PRIMARY));
                    ui.label(egui::RichText::new("+").size(16.0).strong().color(theme::ACCENT));
                });
                ui.add_space(16.0);

                self.nav_item(ui, Tab::Processes, "Processes");
                self.nav_item(ui, Tab::Performance, "Performance");
                self.nav_item(ui, Tab::Battery, "Battery");
                self.nav_item(ui, Tab::Settings, "Settings");
            });
    }

    fn nav_item(&mut self, ui: &mut egui::Ui, tab: Tab, label: &str) {
        let selected = self.tab == tab;
        let (bg, fg) = if selected {
            (theme::ROW_SELECTED, theme::TEXT_PRIMARY)
        } else {
            (egui::Color32::TRANSPARENT, theme::TEXT_SECONDARY)
        };
        let resp = egui::Frame::none()
            .fill(bg)
            .rounding(6.0)
            .inner_margin(egui::Margin::symmetric(10.0, 7.0))
            .show(ui, |ui| {
                ui.allocate_space(egui::vec2(ui.available_width(), 0.0));
                ui.label(egui::RichText::new(label).color(fg));
            })
            .response
            .interact(egui::Sense::click());
        if resp.hovered() {
            ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
        }
        if resp.clicked() {
            self.tab = tab;
        }
        ui.add_space(2.0);
    }

    fn header(&self, ctx: &egui::Context, snap: Option<&taskmanagerplus_lib::ffi::PerformanceSnapshot>) {
        egui::TopBottomPanel::top("header")
            .exact_height(46.0)
            .frame(
                egui::Frame::none()
                    .fill(theme::BG_ELEVATED)
                    .inner_margin(egui::Margin::symmetric(16.0, 0.0)),
            )
            .show(ctx, |ui| {
                ui.horizontal_centered(|ui| {
                    let Some(s) = snap else {
                        ui.label(egui::RichText::new("—").color(theme::TEXT_MUTED));
                        return;
                    };
                    let mem_pct = if s.total_ram_bytes > 0 {
                        s.used_ram_bytes as f64 / s.total_ram_bytes as f64 * 100.0
                    } else {
                        0.0
                    };
                    stat(ui, "CPU", &format!("{:.0}%", s.cpu_usage_percent), theme::threshold(s.cpu_usage_percent, 50.0, 80.0));
                    stat(ui, "Memory", &format!("{mem_pct:.0}%"), theme::threshold(mem_pct, 60.0, 85.0));
                    stat(ui, "GPU", &format!("{:.0}%", s.gpu_usage_percent), theme::threshold(s.gpu_usage_percent, 50.0, 80.0));
                    stat(ui, "Disk", &fmt::rate(s.disk_read_per_sec + s.disk_write_per_sec), theme::ACCENT);
                    stat(ui, "Net", &fmt::rate(s.net_send_per_sec + s.net_recv_per_sec), theme::ACCENT);
                });
            });
    }
}

fn stat(ui: &mut egui::Ui, label: &str, value: &str, color: egui::Color32) {
    // Label and value are laid out as one galley (a single text line) so the
    // proportional label and the monospace value share a baseline — separate
    // `ui.label`s vertically-centered in a row don't, because the two fonts have
    // different line-box heights.
    // Both runs share one monospace FontId: identical metrics guarantee a common
    // baseline (mixing proportional + monospace does not), and mono keeps the
    // value from changing width — and shifting the following stats — each second.
    let font = egui::FontId::monospace(12.5);
    let mut job = egui::text::LayoutJob::default();
    job.append(
        label,
        0.0,
        egui::TextFormat {
            font_id: font.clone(),
            color: theme::TEXT_MUTED,
            ..Default::default()
        },
    );
    job.append(
        &format!("  {value}"),
        0.0,
        egui::TextFormat {
            font_id: font,
            color,
            ..Default::default()
        },
    );
    ui.label(job);
    ui.add_space(20.0);
}


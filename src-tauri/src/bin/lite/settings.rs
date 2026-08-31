//! Settings page (Phase A3 + A4 flesh-out).
//!
//! Lite keeps its own small settings file at
//! `%LOCALAPPDATA%\com.taskmanagerplus.app\lite-settings.json`. It is
//! deliberately self-contained: the React app still keeps its settings in
//! `localStorage` (see `src/lib/settings.ts`), which a separate native process
//! can't read. Unifying the two behind one on-disk store is a larger
//! cross-cutting change to the main app, tracked as follow-up.
//!
//! Full-width rows (label + description left, control right), matching the main
//! app's settings layout.

use std::sync::atomic::Ordering;

use eframe::egui;
use serde::{Deserialize, Serialize};

use super::state::PollInterval;
use super::theme;

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct LiteSettings {
    /// Telemetry poll cadence, milliseconds.
    pub refresh_ms: u64,
    /// Which page opens on launch: processes | performance | battery | settings.
    pub default_page: String,
    /// Keep the window above others (applied at launch).
    pub always_on_top: bool,
}

impl Default for LiteSettings {
    fn default() -> Self {
        Self {
            refresh_ms: 1000,
            default_page: "processes".into(),
            always_on_top: false,
        }
    }
}

fn config_path() -> Option<std::path::PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    let dir = std::path::PathBuf::from(base).join("com.taskmanagerplus.app");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("lite-settings.json"))
}

impl LiteSettings {
    pub fn load() -> Self {
        config_path()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn save(&self) {
        if let Some(p) = config_path() {
            if let Ok(json) = serde_json::to_string_pretty(self) {
                let _ = std::fs::write(p, json);
            }
        }
    }
}

pub struct SettingsView {
    pub settings: LiteSettings,
}

impl SettingsView {
    pub fn new(settings: LiteSettings) -> Self {
        Self { settings }
    }

    pub fn ui(&mut self, ui: &mut egui::Ui, interval: &PollInterval) {
        ui.heading(egui::RichText::new("Settings").color(theme::TEXT_PRIMARY));
        ui.add_space(4.0);
        ui.label(
            egui::RichText::new("Preferences for the lite window. Stored separately from the main app.")
                .color(theme::TEXT_SECONDARY),
        );
        ui.add_space(16.0);

        let mut changed = false;
        let cur_refresh = self.settings.refresh_ms;
        let cur_page = self.settings.default_page.clone();
        let cur_top = self.settings.always_on_top;
        let mut new_refresh = cur_refresh;
        let mut new_page = cur_page.clone();
        let mut new_top = cur_top;

        card(ui, |ui| {
            setting_row(
                ui,
                "Refresh rate",
                "How often telemetry is polled. Slower saves CPU.",
                |ui| {
                    for (label, ms) in [("0.5 s", 500u64), ("1 s", 1000), ("2 s", 2000), ("5 s", 5000)] {
                        if pill(ui, label, cur_refresh == ms).clicked() {
                            new_refresh = ms;
                            changed = true;
                        }
                    }
                },
            );
            divider(ui);
            setting_row(
                ui,
                "Default page",
                "Which page opens when the lite window launches.",
                |ui| {
                    for (label, key) in [
                        ("Processes", "processes"),
                        ("Performance", "performance"),
                        ("Battery", "battery"),
                    ] {
                        if pill(ui, label, cur_page == key).clicked() {
                            new_page = key.to_string();
                            changed = true;
                        }
                    }
                },
            );
            divider(ui);
            setting_row(
                ui,
                "Always on top",
                "Keep the lite window above other windows (applies on next launch).",
                |ui| {
                    if toggle(ui, cur_top).clicked() {
                        new_top = !cur_top;
                        changed = true;
                    }
                },
            );
        });

        if changed {
            self.settings.refresh_ms = new_refresh;
            self.settings.default_page = new_page;
            self.settings.always_on_top = new_top;
            interval.store(self.settings.refresh_ms, Ordering::Relaxed);
            self.settings.save();
        }
    }
}

fn card(ui: &mut egui::Ui, add: impl FnOnce(&mut egui::Ui)) {
    egui::Frame::none()
        .fill(theme::BG_ELEVATED)
        .stroke(egui::Stroke::new(1.0, theme::BORDER_SUBTLE))
        .rounding(8.0)
        .inner_margin(egui::Margin::same(4.0))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            add(ui);
        });
}

/// A full-width setting row: title + description on the left, control(s) pushed
/// to the right edge.
fn setting_row(ui: &mut egui::Ui, title: &str, desc: &str, control: impl FnOnce(&mut egui::Ui)) {
    egui::Frame::none()
        .inner_margin(egui::Margin::symmetric(10.0, 10.0))
        .show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.vertical(|ui| {
                    ui.label(egui::RichText::new(title).strong().color(theme::TEXT_PRIMARY));
                    ui.label(egui::RichText::new(desc).size(12.0).color(theme::TEXT_SECONDARY));
                });
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), control);
            });
        });
}

fn divider(ui: &mut egui::Ui) {
    let rect = ui.max_rect();
    let y = ui.cursor().top();
    ui.painter().hline(
        (rect.left() + 10.0)..=(rect.right() - 10.0),
        y,
        egui::Stroke::new(1.0, theme::BORDER_SUBTLE),
    );
}

/// A selectable pill button.
fn pill(ui: &mut egui::Ui, label: &str, selected: bool) -> egui::Response {
    let (bg, fg, border) = if selected {
        (theme::ROW_SELECTED, theme::TEXT_PRIMARY, theme::ACCENT)
    } else {
        (theme::BG_TERTIARY, theme::TEXT_SECONDARY, theme::BORDER_STRONG)
    };
    let btn = egui::Button::new(egui::RichText::new(label).color(fg))
        .fill(bg)
        .stroke(egui::Stroke::new(1.0, border))
        .rounding(6.0);
    let r = ui.add(btn);
    if r.hovered() {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    r
}

/// A painter-drawn on/off switch.
fn toggle(ui: &mut egui::Ui, on: bool) -> egui::Response {
    let (rect, resp) = ui.allocate_exact_size(egui::vec2(36.0, 20.0), egui::Sense::click());
    let track = if on { theme::ACCENT } else { theme::BG_TERTIARY };
    let p = ui.painter();
    p.rect_filled(rect, 10.0, track);
    let knob_x = if on { rect.right() - 10.0 } else { rect.left() + 10.0 };
    p.circle_filled(egui::pos2(knob_x, rect.center().y), 7.0, egui::Color32::WHITE);
    if resp.hovered() {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    resp
}

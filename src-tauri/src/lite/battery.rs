//! Battery page (Phase A3 + A4 flesh-out).
//!
//! Two-column layout that fills the page width: the left column has the charge
//! headline, a charge bar, the triple power-flow bar (input / output / net
//! charge) and a battery-health bar; the right column lists the numeric detail.
//! All read straight from the performance snapshot.

use eframe::egui;
use taskmanagerplus_lib::ffi::PerformanceSnapshot;

use super::theme;

pub fn ui(ui: &mut egui::Ui, s: &PerformanceSnapshot) {
    ui.heading(egui::RichText::new("Battery").color(theme::TEXT_PRIMARY));
    ui.add_space(12.0);

    let has_battery = s.battery_design_capacity_mwh > 0
        || s.battery_full_charge_capacity_mwh > 0
        || s.battery_percent > 0.0;
    if !has_battery {
        ui.label(egui::RichText::new("No battery detected.").color(theme::TEXT_SECONDARY));
        return;
    }

    let pct = s.battery_percent;
    let charge_color = if pct < 20.0 {
        theme::RED
    } else if pct < 50.0 {
        theme::ORANGE
    } else {
        theme::GREEN
    };

    ui.columns(2, |cols| {
        // ---- Left: visuals ------------------------------------------------
        card(&mut cols[0], |ui| {
            ui.horizontal(|ui| {
                ui.label(egui::RichText::new(format!("{pct:.0}%")).size(30.0).strong().color(charge_color));
                ui.add_space(10.0);
                ui.label(
                    egui::RichText::new(if s.is_charging { "Charging" } else { "On battery" })
                        .color(theme::TEXT_SECONDARY),
                );
            });
            ui.add_space(8.0);
            bar(ui, (pct / 100.0) as f32, charge_color, 10.0);

            ui.add_space(16.0);
            ui.label(egui::RichText::new("Power flow").strong().color(theme::TEXT_PRIMARY));
            ui.add_space(6.0);
            // System draw is the output; when charging the adapter also supplies
            // the charge power, so input = draw + charge rate. Net is battery flow
            // (+ into the battery when charging, − when discharging).
            let output = s.power_draw_watts;
            let (input, net) = if s.is_charging {
                (s.charge_rate_watts + output, s.charge_rate_watts)
            } else {
                (0.0, -output)
            };
            let scale = input.max(output).max(net.abs()).max(1.0);
            flow_row(ui, "Input", input, scale, theme::GREEN);
            flow_row(ui, "Output", output, scale, theme::ORANGE);
            flow_row(ui, "Net", net, scale, if net >= 0.0 { theme::GREEN } else { theme::RED });

            if s.battery_design_capacity_mwh > 0 && s.battery_full_charge_capacity_mwh > 0 {
                let health = s.battery_full_charge_capacity_mwh as f64
                    / s.battery_design_capacity_mwh as f64
                    * 100.0;
                let hc = if health < 60.0 {
                    theme::RED
                } else if health < 80.0 {
                    theme::ORANGE
                } else {
                    theme::GREEN
                };
                ui.add_space(16.0);
                ui.horizontal(|ui| {
                    ui.label(egui::RichText::new("Battery health").strong().color(theme::TEXT_PRIMARY));
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        ui.label(egui::RichText::new(format!("{health:.0}%")).monospace().color(hc));
                    });
                });
                ui.add_space(6.0);
                bar(ui, (health / 100.0) as f32, hc, 8.0);
            }
        });

        // ---- Right: detail ------------------------------------------------
        card(&mut cols[1], |ui| {
            ui.label(egui::RichText::new("Details").strong().color(theme::TEXT_PRIMARY));
            ui.add_space(8.0);
            if !s.is_charging && s.battery_time_remaining > 0 {
                stat_row(ui, "Estimated time left", &fmt_secs(s.battery_time_remaining));
            }
            if s.is_charging && s.charge_rate_watts > 0.5 {
                stat_row(ui, "Charge rate", &format!("{:.1} W", s.charge_rate_watts));
            }
            if s.power_draw_watts > 0.0 {
                stat_row(ui, "System power draw", &format!("{:.1} W", s.power_draw_watts));
            }
            if s.battery_full_charge_capacity_mwh > 0 {
                stat_row(ui, "Full charge capacity", &format!("{:.1} Wh", s.battery_full_charge_capacity_mwh as f64 / 1000.0));
            }
            if s.battery_design_capacity_mwh > 0 {
                stat_row(ui, "Design capacity", &format!("{:.1} Wh", s.battery_design_capacity_mwh as f64 / 1000.0));
            }
            if s.battery_cycle_count > 0 {
                stat_row(ui, "Cycle count", &s.battery_cycle_count.to_string());
            }
            if s.battery_voltage > 0.0 {
                stat_row(ui, "Voltage", &format!("{:.2} V", s.battery_voltage));
            }
        });
    });
}

// -----------------------------------------------------------------------------

fn card(ui: &mut egui::Ui, add: impl FnOnce(&mut egui::Ui)) {
    egui::Frame::none()
        .fill(theme::BG_ELEVATED)
        .stroke(egui::Stroke::new(1.0, theme::BORDER_SUBTLE))
        .rounding(8.0)
        .inner_margin(egui::Margin::same(14.0))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.set_min_height(1.0);
            add(ui);
        });
}

fn stat_row(ui: &mut egui::Ui, label: &str, value: &str) {
    ui.horizontal(|ui| {
        ui.label(egui::RichText::new(label).color(theme::TEXT_SECONDARY));
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            ui.label(egui::RichText::new(value).monospace().color(theme::TEXT_PRIMARY));
        });
    });
    ui.add_space(7.0);
}

/// One power-flow row: label · bar · watt value.
fn flow_row(ui: &mut egui::Ui, label: &str, watts: f64, scale: f64, color: egui::Color32) {
    ui.horizontal(|ui| {
        ui.add_sized(
            egui::vec2(52.0, 16.0),
            egui::Label::new(egui::RichText::new(label).color(theme::TEXT_SECONDARY)),
        );
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            ui.add_sized(
                egui::vec2(56.0, 16.0),
                egui::Label::new(egui::RichText::new(format!("{watts:.1} W")).monospace().color(color)),
            );
            ui.add_space(8.0);
            let w = ui.available_width().max(20.0);
            let (rect, _) = ui.allocate_exact_size(egui::vec2(w, 10.0), egui::Sense::hover());
            let p = ui.painter();
            p.rect_filled(rect, 5.0, theme::BG_TERTIARY);
            let frac = (watts.abs() / scale).clamp(0.0, 1.0) as f32;
            let mut fill = rect;
            fill.set_width(rect.width() * frac);
            p.rect_filled(fill, 5.0, color);
        });
    });
    ui.add_space(6.0);
}

fn bar(ui: &mut egui::Ui, frac: f32, color: egui::Color32, height: f32) {
    let (rect, _) = ui.allocate_exact_size(egui::vec2(ui.available_width(), height), egui::Sense::hover());
    let p = ui.painter();
    p.rect_filled(rect, height / 2.0, theme::BG_TERTIARY);
    let mut fill = rect;
    fill.set_width(rect.width() * frac.clamp(0.0, 1.0));
    p.rect_filled(fill, height / 2.0, color);
}

fn fmt_secs(secs: i32) -> String {
    let h = secs / 3600;
    let m = (secs % 3600) / 60;
    if h > 0 {
        format!("{h}h {m}m")
    } else {
        format!("{m}m")
    }
}

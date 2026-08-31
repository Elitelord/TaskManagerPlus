//! Performance page (Phase A2 + A4 flesh-out) — resource detail.
//!
//! One full-width card per subsystem (CPU, Memory, GPU, Disk, Network, and NPU
//! when present). Each pairs an `egui_plot` sparkline over the rolling `History`
//! ring buffer with the detail the main app's Performance page shows: per-core
//! CPU, a Windows-style memory composition bar, device identity / clocks /
//! temps / capacities, and the read/write, send/recv, active% breakdowns.

use eframe::egui;
use egui_plot::{Line, Plot, PlotPoints};
use taskmanagerplus_lib::ffi::{CoreCpuInfo, PerformanceSnapshot};

use super::state::{History, Series};
use super::{fmt, theme};

pub fn ui(ui: &mut egui::Ui, s: &PerformanceSnapshot, hist: &History, per_core: &[CoreCpuInfo]) {
    egui::ScrollArea::vertical()
        .auto_shrink([false, false])
        .show(ui, |ui| {
            cpu_card(ui, s, hist, per_core);
            ui.add_space(10.0);
            memory_card(ui, s, hist);
            ui.add_space(10.0);
            gpu_card(ui, s, hist);
            ui.add_space(10.0);
            disk_card(ui, s, hist);
            ui.add_space(10.0);
            network_card(ui, s, hist);
            if s.npu_present {
                ui.add_space(10.0);
                npu_card(ui, s, hist);
            }
            ui.add_space(4.0);
        });
}

// -----------------------------------------------------------------------------
// Cards
// -----------------------------------------------------------------------------

fn cpu_card(ui: &mut egui::Ui, s: &PerformanceSnapshot, hist: &History, per_core: &[CoreCpuInfo]) {
    card(ui, |ui| {
        head(ui, "CPU", &format!("{:.1}%", s.cpu_usage_percent), theme::CPU_COLOR, &s.cpu_name);
        sparkline(ui, "spark_cpu", &hist.cpu, theme::CPU_COLOR, true);
        ui.add_space(8.0);
        ui.horizontal_wrapped(|ui| {
            kv(ui, "Cores", &s.core_count.to_string());
            kv(ui, "Threads", &s.thread_count.to_string());
            if s.cpu_base_frequency_mhz > 0.0 {
                kv(ui, "Base", &ghz(s.cpu_base_frequency_mhz));
            }
            if s.cpu_frequency_mhz > 0.0 {
                kv(ui, "Current", &ghz(s.cpu_frequency_mhz));
            }
            if s.cpu_max_frequency_mhz > 0.0 {
                kv(ui, "Max", &ghz(s.cpu_max_frequency_mhz));
            }
            let l1 = s.l1d_cache_kb + s.l1i_cache_kb;
            if l1 > 0 {
                kv(ui, "L1", &kb(l1));
            }
            if s.l2_cache_kb > 0 {
                kv(ui, "L2", &kb(s.l2_cache_kb));
            }
            if s.l3_cache_kb > 0 {
                kv(ui, "L3", &kb(s.l3_cache_kb));
            }
        });
        if !per_core.is_empty() {
            ui.add_space(8.0);
            core_grid(ui, per_core);
        }
    });
}

fn memory_card(ui: &mut egui::Ui, s: &PerformanceSnapshot, hist: &History) {
    let pct = if s.total_ram_bytes > 0 {
        s.used_ram_bytes as f64 / s.total_ram_bytes as f64 * 100.0
    } else {
        0.0
    };
    card(ui, |ui| {
        head(
            ui,
            "Memory",
            &format!("{:.1} / {:.1} GB  ·  {pct:.0}%", gb(s.used_ram_bytes), gb(s.total_ram_bytes)),
            theme::MEM_COLOR,
            "",
        );
        sparkline(ui, "spark_mem", &hist.mem, theme::MEM_COLOR, true);
        ui.add_space(8.0);

        // Windows-style composition: In use / Modified / Cached (standby) / Free.
        let total = s.total_ram_bytes as f64;
        let avail = s.available_ram_bytes as f64;
        let modified = s.modified_pages_bytes as f64;
        let cached = s.cached_bytes as f64;
        let in_use = (total - avail - modified).max(0.0);
        let free = (avail - cached).max(0.0);
        let segs = [
            ("In use", in_use, theme::ACCENT),
            ("Modified", modified, theme::ORANGE),
            ("Cached", cached, theme::TEAL),
            ("Free", free, theme::BG_TERTIARY),
        ];
        stacked_bar(ui, &segs, total.max(1.0));
        ui.add_space(6.0);
        ui.horizontal_wrapped(|ui| {
            for (label, val, color) in segs {
                legend_dot(ui, color);
                kv(ui, label, &fmt::bytes(val));
            }
        });
        ui.add_space(6.0);
        ui.horizontal_wrapped(|ui| {
            kv(ui, "Available", &fmt::bytes(avail));
            if s.commit_limit_bytes > 0 {
                kv(
                    ui,
                    "Committed",
                    &format!("{} / {}", fmt::bytes(s.committed_bytes as f64), fmt::bytes(s.commit_limit_bytes as f64)),
                );
            }
            if s.paged_pool_bytes > 0 {
                kv(ui, "Paged pool", &fmt::bytes(s.paged_pool_bytes as f64));
            }
            if s.non_paged_pool_bytes > 0 {
                kv(ui, "Non-paged pool", &fmt::bytes(s.non_paged_pool_bytes as f64));
            }
        });
    });
}

fn gpu_card(ui: &mut egui::Ui, s: &PerformanceSnapshot, hist: &History) {
    card(ui, |ui| {
        head(ui, "GPU", &format!("{:.1}%", s.gpu_usage_percent), theme::GPU_COLOR, &s.gpu_name);
        sparkline(ui, "spark_gpu", &hist.gpu, theme::GPU_COLOR, true);
        ui.add_space(8.0);
        ui.horizontal_wrapped(|ui| {
            kv(ui, "Type", if s.gpu_is_integrated { "Integrated" } else { "Discrete" });
            if s.gpu_memory_total > 0 {
                kv(
                    ui,
                    "VRAM",
                    &format!("{} / {}", fmt::bytes(s.gpu_memory_used as f64), fmt::bytes(s.gpu_memory_total as f64)),
                );
            }
            if s.gpu_shared_memory_total > 0 {
                kv(
                    ui,
                    "Shared",
                    &format!("{} / {}", fmt::bytes(s.gpu_shared_memory_used as f64), fmt::bytes(s.gpu_shared_memory_total as f64)),
                );
            }
            if s.gpu_temperature > 0.0 {
                kv(ui, "Temp", &format!("{:.0}°C", s.gpu_temperature));
            }
            if s.gpu_usage_3d_percent > 0.0 {
                kv(ui, "3D", &format!("{:.0}%", s.gpu_usage_3d_percent));
            }
            if s.gpu_usage_compute_percent > 0.0 {
                kv(ui, "Compute", &format!("{:.0}%", s.gpu_usage_compute_percent));
            }
        });
    });
}

fn disk_card(ui: &mut egui::Ui, s: &PerformanceSnapshot, hist: &History) {
    card(ui, |ui| {
        head(
            ui,
            "Disk",
            &fmt::rate(s.disk_read_per_sec + s.disk_write_per_sec),
            theme::DISK_COLOR,
            "",
        );
        sparkline(ui, "spark_disk", &hist.disk, theme::DISK_COLOR, false);
        ui.add_space(8.0);
        ui.horizontal_wrapped(|ui| {
            kv(ui, "Read", &fmt::rate(s.disk_read_per_sec));
            kv(ui, "Write", &fmt::rate(s.disk_write_per_sec));
            kv(ui, "Active", &format!("{:.0}%", s.disk_active_percent));
            kv(ui, "Queue", &format!("{:.2}", s.disk_queue_length as f64));
        });
    });
}

fn network_card(ui: &mut egui::Ui, s: &PerformanceSnapshot, hist: &History) {
    card(ui, |ui| {
        head(
            ui,
            "Network",
            &fmt::rate(s.net_send_per_sec + s.net_recv_per_sec),
            theme::NET_COLOR,
            "",
        );
        sparkline(ui, "spark_net", &hist.net, theme::NET_COLOR, false);
        ui.add_space(8.0);
        ui.horizontal_wrapped(|ui| {
            kv(ui, "Send", &fmt::rate(s.net_send_per_sec));
            kv(ui, "Receive", &fmt::rate(s.net_recv_per_sec));
            if s.net_link_speed_bps > 0.0 {
                kv(ui, "Link speed", &fmt::rate(s.net_link_speed_bps));
            }
        });
    });
}

fn npu_card(ui: &mut egui::Ui, s: &PerformanceSnapshot, hist: &History) {
    card(ui, |ui| {
        head(ui, "NPU", &format!("{:.1}%", s.npu_usage_percent), theme::NPU_COLOR, &s.npu_name);
        sparkline(ui, "spark_npu", &hist.npu, theme::NPU_COLOR, true);
        ui.add_space(8.0);
        ui.horizontal_wrapped(|ui| {
            if s.npu_dedicated_total_bytes > 0 {
                kv(
                    ui,
                    "Dedicated",
                    &format!("{} / {}", fmt::bytes(s.npu_dedicated_used_bytes as f64), fmt::bytes(s.npu_dedicated_total_bytes as f64)),
                );
            }
            if s.npu_shared_total_bytes > 0 {
                kv(
                    ui,
                    "Shared",
                    &format!("{} / {}", fmt::bytes(s.npu_shared_used_bytes as f64), fmt::bytes(s.npu_shared_total_bytes as f64)),
                );
            }
        });
    });
}

// -----------------------------------------------------------------------------
// Building blocks
// -----------------------------------------------------------------------------

fn card(ui: &mut egui::Ui, add: impl FnOnce(&mut egui::Ui)) {
    egui::Frame::none()
        .fill(theme::BG_ELEVATED)
        .stroke(egui::Stroke::new(1.0, theme::BORDER_SUBTLE))
        .rounding(8.0)
        .inner_margin(egui::Margin::same(14.0))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            add(ui);
        });
}

/// Card header: title left; big current value + optional device name right.
fn head(ui: &mut egui::Ui, title: &str, value: &str, color: egui::Color32, subtitle: &str) {
    ui.horizontal(|ui| {
        ui.label(egui::RichText::new(title).size(14.0).strong().color(theme::TEXT_PRIMARY));
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            ui.label(egui::RichText::new(value).size(15.0).monospace().color(color));
            if !subtitle.is_empty() {
                ui.add_space(10.0);
                ui.label(egui::RichText::new(subtitle).size(12.0).color(theme::TEXT_MUTED));
            }
        });
    });
    ui.add_space(6.0);
}

fn sparkline(ui: &mut egui::Ui, id: &str, series: &Series, color: egui::Color32, percent: bool) {
    let points: PlotPoints = series
        .points
        .iter()
        .enumerate()
        .map(|(i, v)| [i as f64, *v])
        .collect();
    let line = Line::new(points).color(color).fill(0.0).width(1.5);
    let mut p = Plot::new(id)
        .height(56.0)
        .show_axes([false, false])
        .show_grid([false, false])
        .show_x(false)
        .show_y(false)
        .allow_zoom(false)
        .allow_drag(false)
        .allow_scroll(false)
        .allow_boxed_zoom(false)
        .include_x(0.0)
        .include_x((Series::CAP - 1) as f64)
        .include_y(0.0);
    if percent {
        p = p.include_y(100.0);
    }
    p.show(ui, |pui| pui.line(line));
}

/// One inline key→value pair as a single galley so it wraps as a unit.
fn kv(ui: &mut egui::Ui, key: &str, value: &str) {
    let mut job = egui::text::LayoutJob::default();
    job.append(
        key,
        0.0,
        egui::TextFormat {
            font_id: egui::FontId::proportional(11.5),
            color: theme::TEXT_MUTED,
            ..Default::default()
        },
    );
    job.append(
        &format!("  {value}"),
        0.0,
        egui::TextFormat {
            font_id: egui::FontId::monospace(11.5),
            color: theme::TEXT_SECONDARY,
            ..Default::default()
        },
    );
    ui.label(job);
    ui.add_space(14.0);
}

fn legend_dot(ui: &mut egui::Ui, color: egui::Color32) {
    let (rect, _) = ui.allocate_exact_size(egui::vec2(9.0, 9.0), egui::Sense::hover());
    ui.painter().rect_filled(rect, 2.0, color);
    ui.add_space(3.0);
}

/// A single horizontal stacked bar of proportional segments.
fn stacked_bar(ui: &mut egui::Ui, segs: &[(&str, f64, egui::Color32)], total: f64) {
    let (rect, _) = ui.allocate_exact_size(egui::vec2(ui.available_width(), 14.0), egui::Sense::hover());
    let p = ui.painter();
    p.rect_filled(rect, 3.0, theme::BG_TERTIARY);
    let mut x = rect.left();
    for (_, val, color) in segs {
        let w = (val / total) as f32 * rect.width();
        if w <= 0.5 {
            continue;
        }
        let seg = egui::Rect::from_min_size(egui::pos2(x, rect.top()), egui::vec2(w, rect.height()));
        p.rect_filled(seg, 0.0, *color);
        x += w;
    }
}

/// Compact per-core usage as a wrapped row of vertical bars.
fn core_grid(ui: &mut egui::Ui, cores: &[CoreCpuInfo]) {
    let bar_w = 12.0;
    let gap = 4.0;
    let h = 32.0;
    let avail = ui.available_width();
    let per_row = (((avail + gap) / (bar_w + gap)).floor() as usize).max(1);
    for chunk in cores.chunks(per_row) {
        ui.horizontal(|ui| {
            for c in chunk {
                let (rect, resp) =
                    ui.allocate_exact_size(egui::vec2(bar_w, h), egui::Sense::hover());
                let p = ui.painter();
                p.rect_filled(rect, 2.0, theme::BG_TERTIARY);
                let frac = (c.usage_percent / 100.0).clamp(0.0, 1.0) as f32;
                let fh = rect.height() * frac;
                let fill = egui::Rect::from_min_max(
                    egui::pos2(rect.left(), rect.bottom() - fh),
                    egui::pos2(rect.right(), rect.bottom()),
                );
                let color = theme::threshold(c.usage_percent, 50.0, 80.0);
                p.rect_filled(fill, 2.0, color);
                let kind = if c.is_performance_core != 0 { "P" } else { "E" };
                resp.on_hover_text(format!("Core {} ({kind}): {:.0}%", c.core_index, c.usage_percent));
            }
        });
        ui.add_space(gap);
    }
}

// -----------------------------------------------------------------------------
// Formatting
// -----------------------------------------------------------------------------

fn gb(bytes: u64) -> f64 {
    bytes as f64 / 1_073_741_824.0
}

fn ghz(mhz: f64) -> String {
    format!("{:.2} GHz", mhz / 1000.0)
}

fn kb(kb: u32) -> String {
    if kb >= 1024 {
        format!("{:.0} MB", kb as f64 / 1024.0)
    } else {
        format!("{kb} KB")
    }
}

//! Process table — the core lite page.
//!
//! Virtualized with `egui_extras::TableBuilder` (only visible rows are laid
//! out), mirroring what `@tanstack/react-virtual` does for the React
//! `ProcessTable`. Processes are grouped by name (Chrome's many helper PIDs
//! collapse under one "Google Chrome" row) with aggregate CPU / memory / GPU /
//! disk / network and an expander to reveal the individual instances. Sortable
//! columns, a name filter, selection, and End task via
//! `process_guard::guarded_kill` — the same guarded path the Tauri `end_task`
//! command and the MCP `end_process` tool use, so lite can't kill anything the
//! main app wouldn't.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use eframe::egui;
use egui_extras::{Column, TableBuilder, TableRow};

use super::state::Proc;
use super::{fmt, theme};

#[derive(Clone, Copy, PartialEq)]
enum SortKey {
    Name,
    Cpu,
    Memory,
    Gpu,
    Disk,
    Net,
}

#[derive(Clone, PartialEq)]
enum Selection {
    Group(String),
    Pid(u32),
}

pub struct ProcessesView {
    filter: String,
    sort: SortKey,
    ascending: bool,
    selected: Option<Selection>,
    expanded: HashSet<String>,
    /// PIDs per group name from the last frame, so End task on a group selection
    /// acts on exactly the instances that were displayed.
    last_pids_for: HashMap<String, Vec<u32>>,
    /// Last End-task error, shown as a dismissable banner.
    error: Option<String>,
}

impl Default for ProcessesView {
    fn default() -> Self {
        Self {
            filter: String::new(),
            sort: SortKey::Cpu,
            ascending: false,
            selected: None,
            expanded: HashSet::new(),
            last_pids_for: HashMap::new(),
            error: None,
        }
    }
}

/// A name-grouped bucket of processes with aggregate metrics.
struct Group<'a> {
    name: String,
    procs: Vec<&'a Proc>,
    cpu: f64,
    mem: f64,
    gpu: f64,
    disk: f64,
    net: f64,
}

/// A flattened row for the virtualized body: a group header, or (when expanded)
/// one of the group's child instances.
enum Row<'a> {
    Group(usize),
    Child(&'a Proc),
}

impl ProcessesView {
    pub fn ui(&mut self, ui: &mut egui::Ui, procs: &[Proc]) {
        let total = procs.len();
        let groups = self.build_groups(procs);

        self.toolbar(ui, total, groups.len());
        if let Some(err) = self.error.clone() {
            error_banner(ui, &err, || self.error = None);
        }
        ui.add_space(4.0);

        self.table(ui, &groups);
    }

    /// Filter → group by name → aggregate → sort (deterministic, name-tiebroken).
    fn build_groups<'a>(&self, procs: &'a [Proc]) -> Vec<Group<'a>> {
        let needle = self.filter.to_lowercase();
        let mut by_name: HashMap<&str, Group<'a>> = HashMap::new();
        for p in procs {
            if !needle.is_empty() && !p.name.to_lowercase().contains(&needle) {
                continue;
            }
            let g = by_name.entry(p.name.as_str()).or_insert_with(|| Group {
                name: p.name.clone(),
                procs: Vec::new(),
                cpu: 0.0,
                mem: 0.0,
                gpu: 0.0,
                disk: 0.0,
                net: 0.0,
            });
            g.procs.push(p);
            g.cpu += p.cpu_percent;
            g.mem += p.memory_mb;
            g.gpu += p.gpu_percent;
            g.disk += p.disk_bps;
            g.net += p.net_bps;
        }
        let mut groups: Vec<Group<'a>> = by_name.into_values().collect();

        // Deterministic total order: numeric direction first, then always
        // name-ascending as a tiebreak. Without the tiebreak, the many 0-valued
        // ties fall back to HashMap iteration order, which is randomized per poll
        // and makes the rows visibly churn.
        let asc = self.ascending;
        let by_name = |a: &Group, b: &Group| a.name.to_lowercase().cmp(&b.name.to_lowercase());
        let num = |x: f64, y: f64, a: &Group, b: &Group| {
            let o = x.partial_cmp(&y).unwrap_or(Ordering::Equal);
            let o = if asc { o } else { o.reverse() };
            o.then_with(|| by_name(a, b))
        };
        match self.sort {
            SortKey::Name => groups.sort_by(|a, b| {
                let o = by_name(a, b);
                if asc {
                    o
                } else {
                    o.reverse()
                }
            }),
            SortKey::Cpu => groups.sort_by(|a, b| num(a.cpu, b.cpu, a, b)),
            SortKey::Memory => groups.sort_by(|a, b| num(a.mem, b.mem, a, b)),
            SortKey::Gpu => groups.sort_by(|a, b| num(a.gpu, b.gpu, a, b)),
            SortKey::Disk => groups.sort_by(|a, b| num(a.disk, b.disk, a, b)),
            SortKey::Net => groups.sort_by(|a, b| num(a.net, b.net, a, b)),
        }
        // Within a group, biggest CPU first.
        for g in &mut groups {
            g.procs.sort_by(|a, b| {
                b.cpu_percent
                    .partial_cmp(&a.cpu_percent)
                    .unwrap_or(Ordering::Equal)
            });
        }
        groups
    }

    fn toolbar(&mut self, ui: &mut egui::Ui, total: usize, group_count: usize) {
        ui.horizontal(|ui| {
            ui.add(
                egui::TextEdit::singleline(&mut self.filter)
                    .hint_text("Filter by name…")
                    .desired_width(220.0),
            );
            if !self.filter.is_empty() && clear_button(ui).clicked() {
                self.filter.clear();
            }
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                let enabled = self.selected.is_some();
                let btn = egui::Button::new(
                    egui::RichText::new("End task").color(if enabled {
                        theme::RED
                    } else {
                        theme::TEXT_MUTED
                    }),
                )
                .stroke(egui::Stroke::new(1.0, theme::BORDER_STRONG));
                if ui.add_enabled(enabled, btn).clicked() {
                    self.kill_selection();
                }
                ui.add_space(8.0);
                ui.label(
                    egui::RichText::new(format!("{group_count} apps · {total} processes"))
                        .color(theme::TEXT_SECONDARY),
                );
            });
        });
    }

    /// Kill the current selection: a single PID, or every instance in a group.
    fn kill_selection(&mut self) {
        let pids: Vec<u32> = match &self.selected {
            Some(Selection::Pid(p)) => vec![*p],
            Some(Selection::Group(name)) => self.last_pids_for.get(name).cloned().unwrap_or_default(),
            None => return,
        };
        let mut first_err = None;
        for pid in pids {
            if let Err(e) = taskmanagerplus_lib::process_guard::guarded_kill(pid) {
                first_err.get_or_insert(e);
            }
        }
        self.error = first_err;
        self.selected = None;
    }

    fn table(&mut self, ui: &mut egui::Ui, groups: &[Group<'_>]) {
        // Snapshot everything the closures need so they never borrow `self` (the
        // header mutates sort state; the body reads selection — egui can't hold
        // both borrows across the builder). Interactions are collected into
        // locals and applied to `self` afterward.
        self.last_pids_for.clear();
        for g in groups {
            self.last_pids_for
                .insert(g.name.clone(), g.procs.iter().map(|p| p.pid).collect());
        }
        let sort = self.sort;
        let ascending = self.ascending;
        let selected = self.selected.clone();
        let expanded = self.expanded.clone();

        let mut display: Vec<Row> = Vec::with_capacity(groups.len());
        for (gi, g) in groups.iter().enumerate() {
            display.push(Row::Group(gi));
            if g.procs.len() > 1 && expanded.contains(&g.name) {
                for p in &g.procs {
                    display.push(Row::Child(p));
                }
            }
        }

        let mut sort_click: Option<SortKey> = None;
        let mut toggle: Option<String> = None;
        let mut select: Option<Selection> = None;
        let mut kill: Option<Selection> = None;

        TableBuilder::new(ui)
            .striped(true)
            .resizable(false)
            .cell_layout(egui::Layout::left_to_right(egui::Align::Center))
            .column(Column::remainder().at_least(200.0)) // name
            .column(Column::exact(66.0)) // cpu
            .column(Column::exact(92.0)) // memory
            .column(Column::exact(58.0)) // gpu
            .column(Column::exact(92.0)) // disk
            .column(Column::exact(92.0)) // network
            .sense(egui::Sense::click())
            .header(26.0, |mut header| {
                header.col(|ui| {
                    if header_label(ui, "Name", sort == SortKey::Name, ascending, false) {
                        sort_click = Some(SortKey::Name);
                    }
                });
                for (label, key) in [
                    ("CPU", SortKey::Cpu),
                    ("Memory", SortKey::Memory),
                    ("GPU", SortKey::Gpu),
                    ("Disk", SortKey::Disk),
                    ("Network", SortKey::Net),
                ] {
                    header.col(|ui| {
                        if header_label(ui, label, sort == key, ascending, true) {
                            sort_click = Some(key);
                        }
                    });
                }
            })
            .body(|body| {
                body.rows(22.0, display.len(), |mut row| match &display[row.index()] {
                    Row::Group(gi) => {
                        let g = &groups[*gi];
                        let multi = g.procs.len() > 1;
                        let this = if multi {
                            Selection::Group(g.name.clone())
                        } else {
                            Selection::Pid(g.procs[0].pid)
                        };
                        row.set_selected(selected.as_ref() == Some(&this));

                        row.col(|ui| {
                            ui.add_space(2.0);
                            if multi {
                                let open = expanded.contains(&g.name);
                                if expander(ui, open).clicked() {
                                    toggle = Some(g.name.clone());
                                }
                                ui.add_space(2.0);
                            } else {
                                ui.add_space(16.0);
                            }
                            ui.label(egui::RichText::new(&g.name).color(theme::TEXT_PRIMARY));
                            if multi {
                                ui.label(
                                    egui::RichText::new(format!("({})", g.procs.len()))
                                        .color(theme::TEXT_MUTED),
                                );
                            }
                        });
                        pct_cell(&mut row, g.cpu, true);
                        mem_cell(&mut row, g.mem);
                        pct_cell(&mut row, g.gpu, false);
                        rate_cell(&mut row, g.disk);
                        rate_cell(&mut row, g.net);

                        let resp = row.response();
                        if resp.clicked() {
                            select = Some(this.clone());
                        }
                        let menu_sel = this;
                        let pid_opt = if multi { None } else { Some(g.procs[0].pid) };
                        context_menu(&resp, &g.name, pid_opt, multi, g.procs.len(), || {
                            kill = Some(menu_sel.clone());
                        });
                    }
                    Row::Child(p) => {
                        row.set_selected(selected == Some(Selection::Pid(p.pid)));
                        row.col(|ui| {
                            ui.add_space(30.0);
                            let role = p.process_type.as_deref().map(type_label);
                            let title = truncate(&p.window_title, 48);
                            match (role, title.is_empty()) {
                                (Some(t), false) => {
                                    ui.label(egui::RichText::new(t).color(theme::TEXT_SECONDARY));
                                    ui.label(
                                        egui::RichText::new(format!("— {title}"))
                                            .color(theme::TEXT_MUTED),
                                    );
                                }
                                (Some(t), true) => {
                                    ui.label(egui::RichText::new(t).color(theme::TEXT_SECONDARY));
                                }
                                (None, false) => {
                                    ui.label(egui::RichText::new(title).color(theme::TEXT_SECONDARY));
                                }
                                (None, true) => {
                                    ui.label(
                                        egui::RichText::new("Process").color(theme::TEXT_MUTED),
                                    );
                                }
                            }
                        });
                        pct_cell(&mut row, p.cpu_percent, true);
                        mem_cell(&mut row, p.memory_mb);
                        pct_cell(&mut row, p.gpu_percent, false);
                        rate_cell(&mut row, p.disk_bps);
                        rate_cell(&mut row, p.net_bps);

                        let resp = row.response();
                        if resp.clicked() {
                            select = Some(Selection::Pid(p.pid));
                        }
                        let pid = p.pid;
                        context_menu(&resp, &p.name, Some(pid), false, 1, || {
                            kill = Some(Selection::Pid(pid));
                        });
                    }
                });
            });

        // Apply collected interactions.
        if let Some(k) = sort_click {
            if self.sort == k {
                self.ascending = !self.ascending;
            } else {
                self.sort = k;
                self.ascending = matches!(k, SortKey::Name);
            }
        }
        if let Some(name) = toggle {
            if !self.expanded.remove(&name) {
                self.expanded.insert(name);
            }
        }
        if let Some(s) = select {
            self.selected = Some(s);
        }
        if let Some(s) = kill {
            self.selected = Some(s);
            self.kill_selection();
        }
    }
}

/// A sortable column header. Returns true when clicked. The sort-direction
/// arrow is painter-drawn (small, sized to the text) rather than a font glyph,
/// which rendered oversized.
fn header_label(ui: &mut egui::Ui, text: &str, active: bool, ascending: bool, right: bool) -> bool {
    let color = if active { theme::TEXT_PRIMARY } else { theme::TEXT_SECONDARY };
    let widget =
        egui::Label::new(egui::RichText::new(text).color(color).strong()).sense(egui::Sense::click());
    if right {
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            ui.add_space(8.0);
            if active {
                sort_arrow(ui, ascending);
            }
            ui.add(widget).clicked()
        })
        .inner
    } else {
        let clicked = ui.add(widget).clicked();
        if active {
            sort_arrow(ui, ascending);
        }
        clicked
    }
}

/// Small painter-drawn sort triangle (▲ ascending / ▼ descending).
fn sort_arrow(ui: &mut egui::Ui, ascending: bool) {
    let (rect, _) = ui.allocate_exact_size(egui::vec2(9.0, 14.0), egui::Sense::hover());
    let r = rect.shrink2(egui::vec2(1.5, 4.5));
    let pts = if ascending {
        vec![
            egui::pos2(r.center().x, r.top()),
            egui::pos2(r.left(), r.bottom()),
            egui::pos2(r.right(), r.bottom()),
        ]
    } else {
        vec![
            egui::pos2(r.left(), r.top()),
            egui::pos2(r.right(), r.top()),
            egui::pos2(r.center().x, r.bottom()),
        ]
    };
    ui.painter()
        .add(egui::Shape::convex_polygon(pts, theme::TEXT_PRIMARY, egui::Stroke::NONE));
}

/// Truncate to `max` chars with an ellipsis, on a char boundary.
fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max.saturating_sub(1)).collect();
        format!("{cut}…")
    }
}

/// Friendly label for a multi-process role slug (from the classifier).
fn type_label(slug: &str) -> &str {
    match slug {
        "renderer" => "Tab",
        "gpu" => "GPU",
        "utility" => "Utility",
        "utility-video" => "Video",
        "utility-audio" => "Audio",
        "utility-storage" => "Storage",
        "utility-network" => "Network",
        "crashpad" => "Crash Handler",
        "socket" => "Socket",
        "rdd" => "Media",
        "content" => "Content",
        "shared" => "Shared Process",
        "watcher" => "File Watcher",
        "pty-host" => "Terminal",
        "extension-host" => "Extension Host",
        "extension" => "Extension",
        "main" => "Main",
        "service" => "Service",
        other => other,
    }
}

/// Painter-drawn expand/collapse triangle (▸ / ▾) — no font glyph dependency.
fn expander(ui: &mut egui::Ui, open: bool) -> egui::Response {
    let (rect, resp) = ui.allocate_exact_size(egui::vec2(14.0, 14.0), egui::Sense::click());
    let color = if resp.hovered() {
        theme::TEXT_SECONDARY
    } else {
        theme::TEXT_MUTED
    };
    let r = rect.shrink(3.5);
    let pts = if open {
        vec![
            egui::pos2(r.left(), r.top()),
            egui::pos2(r.right(), r.top()),
            egui::pos2(r.center().x, r.bottom()),
        ]
    } else {
        vec![
            egui::pos2(r.left(), r.top()),
            egui::pos2(r.right(), r.center().y),
            egui::pos2(r.left(), r.bottom()),
        ]
    };
    ui.painter()
        .add(egui::Shape::convex_polygon(pts, color, egui::Stroke::NONE));
    if resp.hovered() {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    resp
}

/// Painter-drawn circle-with-✕ clear affordance — no font glyph dependency.
fn clear_button(ui: &mut egui::Ui) -> egui::Response {
    let (rect, resp) = ui.allocate_exact_size(egui::vec2(18.0, 18.0), egui::Sense::click());
    let color = if resp.hovered() {
        theme::TEXT_SECONDARY
    } else {
        theme::TEXT_MUTED
    };
    let c = rect.center();
    let p = ui.painter();
    p.circle_stroke(c, 7.0, egui::Stroke::new(1.0, color));
    let d = 2.8;
    let s = egui::Stroke::new(1.2, color);
    p.line_segment([c + egui::vec2(-d, -d), c + egui::vec2(d, d)], s);
    p.line_segment([c + egui::vec2(d, -d), c + egui::vec2(-d, d)], s);
    if resp.hovered() {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    resp
}

/// Right-aligned percentage cell. `show_zero`=false blanks near-zero values
/// (used for GPU, which is 0 for almost every process).
fn pct_cell(row: &mut TableRow<'_, '_>, value: f64, show_zero: bool) {
    row.col(|ui| {
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            ui.add_space(8.0);
            if value < 0.05 && !show_zero {
                return;
            }
            let c = theme::threshold(value, 25.0, 60.0);
            ui.label(egui::RichText::new(format!("{value:.1}%")).monospace().color(c));
        });
    });
}

fn mem_cell(row: &mut TableRow<'_, '_>, mem_mb: f64) {
    row.col(|ui| {
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            ui.add_space(8.0);
            ui.label(
                egui::RichText::new(fmt::mb(mem_mb))
                    .monospace()
                    .color(theme::TEXT_SECONDARY),
            );
        });
    });
}

/// Right-aligned bytes/sec cell; blank when idle to keep the columns quiet.
fn rate_cell(row: &mut TableRow<'_, '_>, bps: f64) {
    row.col(|ui| {
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            ui.add_space(8.0);
            if bps < 1.0 {
                return;
            }
            ui.label(
                egui::RichText::new(fmt::rate(bps))
                    .monospace()
                    .color(theme::ACCENT),
            );
        });
    });
}

fn context_menu(
    resp: &egui::Response,
    title: &str,
    pid: Option<u32>,
    is_group: bool,
    count: usize,
    mut on_kill: impl FnMut(),
) {
    resp.context_menu(|ui| {
        ui.label(egui::RichText::new(title).color(theme::TEXT_SECONDARY));
        if let Some(pid) = pid {
            ui.label(egui::RichText::new(format!("PID {pid}")).monospace().color(theme::TEXT_MUTED));
        }
        ui.separator();
        let label = if is_group {
            format!("End task (all {count})")
        } else {
            "End task".to_string()
        };
        if ui.button(egui::RichText::new(label).color(theme::RED)).clicked() {
            on_kill();
            ui.close_menu();
        }
    });
}

fn error_banner(ui: &mut egui::Ui, msg: &str, mut dismiss: impl FnMut()) {
    egui::Frame::none()
        .fill(egui::Color32::from_rgb(40, 20, 20))
        .stroke(egui::Stroke::new(1.0, theme::RED))
        .rounding(6.0)
        .inner_margin(egui::Margin::symmetric(10.0, 6.0))
        .show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.label(egui::RichText::new(msg).color(theme::TEXT_PRIMARY));
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui.button("Dismiss").clicked() {
                        dismiss();
                    }
                });
            });
        });
}

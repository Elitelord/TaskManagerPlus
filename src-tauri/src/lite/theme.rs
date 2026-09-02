//! Palette, fonts and egui style for lite mode — ported from
//! `src/styles/tokens.css` (dark theme). The alpha tokens (borders, row hover)
//! are flattened to solid approximations over the near-black page background,
//! which read the same on screen and avoid per-widget compositing.

use eframe::egui;
use egui::Color32;

// Backgrounds
pub const BG_PAGE: Color32 = Color32::from_rgb(0, 0, 0); // --bg-primary
pub const BG_ELEVATED: Color32 = Color32::from_rgb(10, 10, 10); // --bg-elevated (cards)
pub const BG_TERTIARY: Color32 = Color32::from_rgb(26, 26, 26); // --bg-tertiary
pub const BG_SIDEBAR: Color32 = Color32::from_rgb(6, 6, 7); // slight lift off pure black
pub const ROW_SELECTED: Color32 = Color32::from_rgb(24, 30, 42); // accent-subtle on black

// Text
pub const TEXT_PRIMARY: Color32 = Color32::from_rgb(234, 237, 242); // --text-primary
pub const TEXT_SECONDARY: Color32 = Color32::from_rgb(138, 143, 160); // --text-secondary
pub const TEXT_MUTED: Color32 = Color32::from_rgb(85, 89, 104); // --text-muted

// Accents
pub const ACCENT: Color32 = Color32::from_rgb(91, 156, 246); // --accent-primary
pub const GREEN: Color32 = Color32::from_rgb(52, 211, 153); // --accent-green
pub const ORANGE: Color32 = Color32::from_rgb(245, 158, 11); // --accent-orange
pub const RED: Color32 = Color32::from_rgb(239, 68, 68); // --accent-red
pub const PURPLE: Color32 = Color32::from_rgb(167, 139, 250); // --accent-purple
pub const TEAL: Color32 = Color32::from_rgb(13, 148, 136); // --accent-teal

// Borders
pub const BORDER_STRONG: Color32 = Color32::from_rgb(51, 51, 52); // --border-strong on black
pub const BORDER_SUBTLE: Color32 = Color32::from_rgb(23, 23, 24); // --border-subtle on black

/// Per-metric colors, matching the React series palette used on the graphs.
pub const CPU_COLOR: Color32 = ACCENT;
pub const MEM_COLOR: Color32 = PURPLE;
pub const DISK_COLOR: Color32 = GREEN;
pub const NET_COLOR: Color32 = ORANGE;
pub const GPU_COLOR: Color32 = Color32::from_rgb(0xf4, 0x72, 0xb6); // pink
pub const NPU_COLOR: Color32 = TEAL;

/// Green→orange→red by how loaded a percentage metric is.
pub fn threshold(pct: f64, warn: f64, crit: f64) -> Color32 {
    if pct > crit {
        RED
    } else if pct > warn {
        ORANGE
    } else {
        GREEN
    }
}

/// Match the main app: Segoe UI for text, Consolas for the monospace numerics.
/// Falls back silently to egui's bundled fonts if the system files are absent.
pub fn install_fonts(ctx: &egui::Context) {
    let mut fonts = egui::FontDefinitions::default();
    if let Ok(bytes) = std::fs::read(r"C:\Windows\Fonts\segoeui.ttf") {
        fonts
            .font_data
            .insert("segoe".into(), egui::FontData::from_owned(bytes).into());
        fonts
            .families
            .entry(egui::FontFamily::Proportional)
            .or_default()
            .insert(0, "segoe".into());
    }
    if let Ok(bytes) = std::fs::read(r"C:\Windows\Fonts\consola.ttf") {
        fonts
            .font_data
            .insert("consolas".into(), egui::FontData::from_owned(bytes).into());
        fonts
            .families
            .entry(egui::FontFamily::Monospace)
            .or_default()
            .insert(0, "consolas".into());
    }
    // Segoe UI Symbol as a *fallback* (appended) so any geometric/dingbat glyphs
    // — sort arrows ▲▼ and the like — resolve instead of rendering as tofu boxes;
    // Segoe UI proper and Consolas don't cover that range. Interactive glyphs
    // (expander, clear ✕) are painter-drawn instead, so they don't depend on this.
    if let Ok(bytes) = std::fs::read(r"C:\Windows\Fonts\seguisym.ttf") {
        fonts
            .font_data
            .insert("seguisym".into(), egui::FontData::from_owned(bytes).into());
        for fam in [egui::FontFamily::Proportional, egui::FontFamily::Monospace] {
            fonts.families.entry(fam).or_default().push("seguisym".into());
        }
    }
    ctx.set_fonts(fonts);
}

/// Dark visuals tuned to the app's tokens: near-black surfaces, accent selection,
/// subtle borders. Called once at startup.
pub fn apply_style(ctx: &egui::Context) {
    let mut visuals = egui::Visuals::dark();
    visuals.override_text_color = Some(TEXT_PRIMARY);
    visuals.panel_fill = BG_PAGE;
    visuals.window_fill = BG_ELEVATED;
    visuals.extreme_bg_color = BG_PAGE;
    visuals.faint_bg_color = BG_ELEVATED;
    visuals.selection.bg_fill = ROW_SELECTED;
    visuals.selection.stroke = egui::Stroke::new(1.0, ACCENT);
    visuals.hyperlink_color = ACCENT;
    visuals.widgets.noninteractive.bg_stroke = egui::Stroke::new(1.0, BORDER_SUBTLE);
    visuals.widgets.inactive.bg_fill = BG_TERTIARY;
    visuals.widgets.inactive.weak_bg_fill = BG_ELEVATED;
    visuals.widgets.hovered.bg_fill = BG_TERTIARY;
    visuals.widgets.active.bg_fill = BG_TERTIARY;
    ctx.set_visuals(visuals);

    let mut style = (*ctx.style()).clone();
    style.spacing.item_spacing = egui::vec2(8.0, 6.0);
    style.spacing.button_padding = egui::vec2(10.0, 5.0);
    style.spacing.scroll = egui::style::ScrollStyle::solid();
    ctx.set_style(style);
}

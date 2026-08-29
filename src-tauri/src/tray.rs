use std::process::{Child, Command};
use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

const WIDGET_WIDTH: f64 = 320.0;
// The native egui widget auto-fits to ~352 px + margin; used only to anchor the
// popup above the tray icon.
const WIDGET_HEIGHT: f64 = 360.0;

/// Phase 0 (lite mode): the tray popup is a native egui process (`tmp_widget.exe`)
/// instead of a second WebView2 window. Track its handle so a second tray click
/// toggles it closed (spawn ↔ kill).
static WIDGET_CHILD: Mutex<Option<Child>> = Mutex::new(None);

/// Resolve the widget executable — next to the main app exe (dev: `target/…`,
/// release: alongside the installed binary). Returns None if it isn't present,
/// in which case the tray click is a no-op rather than an error.
///
/// ORDER MATTERS, and it is the shipped name first. `tauri.conf.json` bundles
/// this as `tmp_widget.resource.exe`; only a dev build leaves a bare
/// `tmp_widget.exe` in `target/`. Checking the bare name first would mean a
/// stale copy from an older build silently shadowing the installed one — which
/// is exactly the bug that made v2.6.5's native fixes do nothing in production
/// (see `find_dll_path` in ffi.rs). Same shape, so same precedence.
fn widget_exe_path() -> Option<std::path::PathBuf> {
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    for name in ["tmp_widget.resource.exe", "tmp_widget.exe"] {
        let candidate = dir.join(name);
        if candidate.exists() {
            log::info!("tray: widget exe -> {}", candidate.display());
            return Some(candidate);
        }
    }
    log::warn!(
        "tray: no widget exe next to {} — tray popup disabled",
        dir.display()
    );
    None
}

/// Kill the widget process if one is running. Returns true if it was running.
fn close_widget() -> bool {
    let mut guard = WIDGET_CHILD.lock().unwrap();
    if let Some(child) = guard.as_mut() {
        let running = matches!(child.try_wait(), Ok(None));
        if running {
            let _ = child.kill();
        }
        *guard = None;
        return running;
    }
    false
}

/// Widget position anchored above the tray icon, clamped to screen bounds.
///
/// Returns **logical** points (device-independent), which is what egui's
/// `ViewportBuilder::with_position` expects. The tray click and monitor bounds
/// arrive in physical pixels, so everything is divided by the monitor's scale
/// factor — without this the popup lands offset on any scaled (>100%) display.
fn widget_position(app: &tauri::AppHandle, click_x: f64, click_y: f64) -> (f64, f64) {
    // Monitor under the click: physical bounds + scale factor.
    let (px, py, pw, ph, scale) = app
        .get_webview_window("main")
        .and_then(|w| w.available_monitors().ok())
        .and_then(|monitors| {
            monitors.into_iter().find(|m| {
                let pos = m.position();
                let size = m.size();
                let (sx, sy) = (pos.x as f64, pos.y as f64);
                let (sw, sh) = (size.width as f64, size.height as f64);
                click_x >= sx && click_x < sx + sw && click_y >= sy && click_y < sy + sh
            })
        })
        .map(|m| {
            let pos = m.position();
            let size = m.size();
            (pos.x as f64, pos.y as f64, size.width as f64, size.height as f64, m.scale_factor())
        })
        .unwrap_or((0.0, 0.0, 1920.0, 1080.0, 1.0));

    let s = if scale > 0.1 { scale } else { 1.0 };
    // Convert click + monitor bounds to logical points.
    let (clx, cly) = (click_x / s, click_y / s);
    let (mlx, mly, mlw, mlh) = (px / s, py / s, pw / s, ph / s);

    // Center horizontally on the click, sit above it (12 pt gap).
    let mut x = clx - WIDGET_WIDTH / 2.0;
    let mut y = cly - WIDGET_HEIGHT - 12.0;

    // Clamp within the monitor (all logical).
    if x < mlx {
        x = mlx + 8.0;
    }
    if x + WIDGET_WIDTH > mlx + mlw {
        x = mlx + mlw - WIDGET_WIDTH - 8.0;
    }
    if y < mly {
        y = cly + 12.0; // no room above → drop below the click
    }
    if y + WIDGET_HEIGHT > mly + mlh {
        y = mly + mlh - WIDGET_HEIGHT - 8.0;
    }

    (x, y)
}

pub fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&quit_i])?;

    let _tray = TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("TaskManagerPlus")
        .menu(&menu)
        .on_menu_event(|app, event| {
            if event.id.as_ref() == "quit" {
                app.exit(0);
            }
        })
        .on_tray_icon_event(|tray_icon, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                position,
                ..
            } = event
            {
                let app = tray_icon.app_handle();

                // Toggle: if the native widget is already up, close it and stop.
                if close_widget() {
                    return;
                }

                // Otherwise spawn it anchored above the tray icon.
                let (x, y) = widget_position(app, position.x, position.y);
                if let Some(exe) = widget_exe_path() {
                    if let Ok(child) = Command::new(exe)
                        .arg("--pos")
                        .arg((x.round() as i32).to_string())
                        .arg((y.round() as i32).to_string())
                        .spawn()
                    {
                        *WIDGET_CHILD.lock().unwrap() = Some(child);
                    }
                }
            } else if let TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } = event
            {
                // Double-click opens the main window
                let app = tray_icon.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = app.emit(
                        "main-tray-background",
                        serde_json::json!({ "hidden": false }),
                    );
                }
                // Close the native widget popup if it's open.
                close_widget();
            }
        })
        .build(app)?;
    Ok(())
}

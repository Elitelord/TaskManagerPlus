use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};

const WIDGET_WIDTH: f64 = 320.0;
const WIDGET_HEIGHT: f64 = 400.0;

/// Calculate widget position anchored above the tray icon, clamped to screen bounds
fn widget_position(app: &tauri::AppHandle, click_x: f64, click_y: f64) -> (f64, f64) {
    // Try to get the monitor at the click position
    let (screen_x, screen_y, screen_w, screen_h) = if let Some(monitor) = app
        .get_webview_window("main")
        .and_then(|w| w.available_monitors().ok())
        .and_then(|monitors| {
            monitors.into_iter().find(|m| {
                let pos = m.position();
                let size = m.size();
                let sx = pos.x as f64;
                let sy = pos.y as f64;
                let sw = size.width as f64;
                let sh = size.height as f64;
                click_x >= sx && click_x < sx + sw && click_y >= sy && click_y < sy + sh
            })
        }) {
        let pos = monitor.position();
        let size = monitor.size();
        (pos.x as f64, pos.y as f64, size.width as f64, size.height as f64)
    } else {
        // Fallback: assume primary monitor at 0,0 with 1920x1080
        (0.0, 0.0, 1920.0, 1080.0)
    };

    // Center horizontally on click, position above click point
    let mut x = click_x - (WIDGET_WIDTH / 2.0);
    let mut y = click_y - WIDGET_HEIGHT - 12.0; // 12px gap above tray

    // Clamp to screen bounds
    if x < screen_x {
        x = screen_x + 8.0;
    }
    if x + WIDGET_WIDTH > screen_x + screen_w {
        x = screen_x + screen_w - WIDGET_WIDTH - 8.0;
    }
    if y < screen_y {
        // If no room above, show below the click point
        y = click_y + 12.0;
    }
    if y + WIDGET_HEIGHT > screen_y + screen_h {
        y = screen_y + screen_h - WIDGET_HEIGHT - 8.0;
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
                let (x, y) = widget_position(app, position.x, position.y);

                // Toggle the widget popup near the tray icon
                if let Some(widget) = app.get_webview_window("widget") {
                    if widget.is_visible().unwrap_or(false) {
                        let _ = widget.hide();
                    } else {
                        let _ = widget.set_position(tauri::Position::Physical(
                            tauri::PhysicalPosition { x: x as i32, y: y as i32 },
                        ));
                        let _ = widget.show();
                        let _ = widget.set_focus();
                    }
                } else {
                    // Create the widget window
                    if let Ok(widget) = WebviewWindowBuilder::new(
                        app,
                        "widget",
                        WebviewUrl::App("index.html".into()),
                    )
                    .title("TaskManagerPlus Widget")
                    .inner_size(WIDGET_WIDTH, WIDGET_HEIGHT)
                    .position(x, y)
                    .resizable(false)
                    .decorations(false)
                    .always_on_top(true)
                    .skip_taskbar(true)
                    .transparent(true)
                    .build()
                    {
                        let _ = widget.set_focus();
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
                // Hide widget if visible
                if let Some(widget) = app.get_webview_window("widget") {
                    let _ = widget.hide();
                }
            }
        })
        .build(app)?;
    Ok(())
}

//! Per-process visible-window titles, mapped PID → title.
//!
//! Feeds the AI process/workload features (P5 semantic process explanation,
//! P6 semantic workload classification): a window title like
//! "main.rs — my-project — Visual Studio Code" carries far more signal about
//! what a process actually IS than its bare exe name. Captured locally; the
//! title text never leaves the device (same no-telemetry contract as the
//! rest of the AI subsystem).
//!
//! Cost is negligible: one `EnumWindows` pass over the top-level windows
//! (dozens, occasionally low hundreds), reading each title with an in-process
//! `GetWindowTextW` — no process handle to open. Called once per process-list
//! refresh and merged into `ProcessInfo`.

use std::collections::HashMap;

/// Collect a map of PID → best visible window title for the current desktop.
///
/// "Best" = the longest non-empty title among a process's visible, unowned
/// top-level windows. A process can own several windows (a main window plus
/// transient dialogs / tooltips); the longest title is almost always the
/// document-bearing main window, which is the most informative for the AI
/// features. Returns an empty map on non-Windows targets.
#[cfg(windows)]
pub fn collect_window_titles() -> HashMap<u32, String> {
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM, TRUE};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
        IsWindowVisible, GW_OWNER,
    };

    let mut titles: HashMap<u32, String> = HashMap::new();

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let map = &mut *(lparam.0 as *mut HashMap<u32, String>);

        // Only visible, top-level (unowned) windows. Tooltips, owned dialogs,
        // and hidden message-only windows carry no useful workload signal and
        // would pollute the map.
        if !IsWindowVisible(hwnd).as_bool() {
            return TRUE;
        }
        if let Ok(owner) = GetWindow(hwnd, GW_OWNER) {
            if !owner.is_invalid() {
                return TRUE;
            }
        }

        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return TRUE;
        }
        // +1 for the terminating NUL the API writes.
        let mut buf = vec![0u16; len as usize + 1];
        let written = GetWindowTextW(hwnd, &mut buf);
        if written <= 0 {
            return TRUE;
        }
        let title = String::from_utf16_lossy(&buf[..written as usize]);
        let title = title.trim();
        if title.is_empty() {
            return TRUE;
        }

        let mut pid = 0u32;
        let _ = GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return TRUE;
        }

        // Keep the longest title seen for this PID.
        match map.get(&pid) {
            Some(existing) if existing.chars().count() >= title.chars().count() => {}
            _ => {
                map.insert(pid, title.to_string());
            }
        }
        TRUE
    }

    unsafe {
        let _ = EnumWindows(
            Some(enum_proc),
            LPARAM(&mut titles as *mut HashMap<u32, String> as isize),
        );
    }

    titles
}

/// Non-Windows stub — the app only ships on Windows, but keeping the symbol
/// available unconditionally lets `ffi.rs` call it without `cfg` noise.
#[cfg(not(windows))]
pub fn collect_window_titles() -> HashMap<u32, String> {
    HashMap::new()
}

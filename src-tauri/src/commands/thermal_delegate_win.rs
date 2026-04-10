//! Second launch of some OEM tools (e.g. G-Helper) can tear down the running instance.
//! If the same executable is already running, skip `spawn` and try to restore/focus a top-level window.

use std::os::windows::ffi::OsStringExt;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};

use windows::core::PWSTR;

const CREATE_NO_WINDOW: u32 = 0x08000000;
use windows::Win32::Foundation::{CloseHandle, FALSE, HWND, LPARAM, TRUE};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindow, GetWindowThreadProcessId, IsWindowVisible, SetForegroundWindow, ShowWindow,
    GW_OWNER, SW_RESTORE,
};

fn exe_name_lower(path: &Path) -> Option<String> {
    path.file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_lowercase())
}

fn u16_prefix_to_string(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

fn pids_with_exe_filename(want_lower: &str) -> Vec<u32> {
    let mut out = Vec::new();
    unsafe {
        let snap = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            Ok(h) => h,
            Err(_) => return out,
        };
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snap, &mut entry).is_err() {
            let _ = CloseHandle(snap);
            return out;
        }
        loop {
            let name = u16_prefix_to_string(&entry.szExeFile);
            if name.to_lowercase() == want_lower {
                out.push(entry.th32ProcessID);
            }
            if Process32NextW(snap, &mut entry).is_err() {
                break;
            }
        }
        let _ = CloseHandle(snap);
    }
    out
}

fn image_path_for_pid(pid: u32) -> Option<PathBuf> {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = vec![0u16; 2048];
        let mut len = buf.len() as u32;
        QueryFullProcessImageNameW(
            h,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut len,
        )
        .ok()?;
        let _ = CloseHandle(h);
        Some(PathBuf::from(std::ffi::OsString::from_wide(
            &buf[..len as usize],
        )))
    }
}

fn paths_same_executable(a: &Path, b: &Path) -> bool {
    a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
}

/// True if we should not spawn again (instance already running for this exe).
fn already_running_same_executable(target: &Path) -> bool {
    let Some(want_name) = exe_name_lower(target) else {
        return false;
    };
    let pids = pids_with_exe_filename(&want_name);
    if pids.is_empty() {
        return false;
    }

    let mut got_any_path = false;
    for pid in &pids {
        if let Some(img) = image_path_for_pid(*pid) {
            got_any_path = true;
            if paths_same_executable(target, &img) {
                return true;
            }
        }
    }

    if got_any_path {
        return false;
    }

    pids.len() == 1
}

struct EnumWinCtx {
    pids: Vec<u32>,
    found: Option<HWND>,
}

unsafe extern "system" fn enum_visible_top_level(hwnd: HWND, lparam: LPARAM) -> windows::Win32::Foundation::BOOL {
    let ctx = &mut *(lparam.0 as *mut EnumWinCtx);
    if !IsWindowVisible(hwnd).as_bool() {
        return TRUE;
    }
    if let Ok(owner) = GetWindow(hwnd, GW_OWNER) {
        if !owner.is_invalid() {
            return TRUE;
        }
    }
    let mut pid = 0u32;
    let _ = GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if ctx.pids.contains(&pid) {
        ctx.found = Some(hwnd);
        return FALSE;
    }
    TRUE
}

fn try_focus_running_instance(target: &Path) {
    let Some(want_name) = exe_name_lower(target) else {
        return;
    };
    let pids = pids_with_exe_filename(&want_name);
    if pids.is_empty() {
        return;
    }

    let mut ctx = EnumWinCtx { pids, found: None };
    unsafe {
        let _ = EnumWindows(
            Some(enum_visible_top_level),
            LPARAM(&mut ctx as *mut EnumWinCtx as isize),
        );
        if let Some(hwnd) = ctx.found {
            let _ = ShowWindow(hwnd, SW_RESTORE);
            let _ = SetForegroundWindow(hwnd);
        }
    }
}

/// Launch `exe`, or focus an existing instance if it is already running.
///
/// Uses `cmd /C start` (which routes through `ShellExecuteEx`) so that apps
/// whose manifests request admin elevation (G-Helper, Armoury Crate, Lenovo
/// Vantage, etc.) properly trigger a UAC prompt instead of failing silently
/// with `ERROR_ELEVATION_REQUIRED` (which is what `CreateProcess` does).
pub fn launch_exe_singleton_aware(exe: &Path) -> Result<(), String> {
    if !exe.is_file() {
        return Err(format!("Not a file: {}", exe.display()));
    }

    if already_running_same_executable(exe) {
        try_focus_running_instance(exe);
        return Ok(());
    }

    let exe_str = exe.to_string_lossy().to_string();
    let working_dir = exe.parent().map(|p| p.to_path_buf());

    let mut cmd = std::process::Command::new("cmd");
    cmd.args(["/C", "start", "", &exe_str])
        .creation_flags(CREATE_NO_WINDOW);
    if let Some(dir) = working_dir {
        cmd.current_dir(dir);
    }
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to start {}: {e}", exe.display()))
}

//! Single source of truth for "is this PID safe to terminate?".
//!
//! Both the UI `end_task` command and the MCP `end_process` tool route their
//! kills through these checks so the two paths can't drift apart (previously
//! only the MCP tool refused critical processes). The guards are
//! belt-and-suspenders: the kernel already refuses to kill the truly
//! load-bearing processes (PID 0/4, lsass, csrss, ...), but a raw "Access
//! denied" tells the user — or a steered LLM — nothing. Refusing here yields
//! an actionable message and stops a UI bug or hallucinated call from even
//! trying.

/// Names whose termination immediately bluescreens or logs out Windows.
/// Compared case-insensitively against the process image name.
pub const CRITICAL_NAMES: &[&str] = &[
    "csrss.exe",
    "wininit.exe",
    "services.exe",
    "lsass.exe",
    "winlogon.exe",
    "smss.exe",
    "system",
];

/// Reject PIDs that are never valid termination targets regardless of name
/// (the kernel / system-idle pseudo-processes).
pub fn ensure_pid_killable(pid: u32) -> Result<(), String> {
    if pid == 0 || pid == 4 {
        return Err(format!(
            "Refusing to terminate PID {pid}: Windows kernel/idle process."
        ));
    }
    Ok(())
}

/// Reject the small set of processes whose loss reboots or locks Windows.
pub fn ensure_name_killable(pid: u32, name: &str) -> Result<(), String> {
    let lower = name.to_ascii_lowercase();
    if CRITICAL_NAMES.iter().any(|n| lower == *n) {
        return Err(format!(
            "Refusing to terminate '{name}' (PID {pid}): critical Windows process."
        ));
    }
    Ok(())
}

/// Resolve `pid` to its image name, apply both guards, then terminate. Used
/// by the UI `end_task` command, which (unlike the MCP tool) has no dry-run
/// phase and so needs the whole sequence in one call. Blocking — call from a
/// worker thread.
pub fn guarded_kill(pid: u32) -> Result<(), String> {
    ensure_pid_killable(pid)?;
    // Best-effort name resolution. If the PID has already exited we let
    // `kill_process` report "not found" rather than failing here.
    if let Ok(processes) = crate::ffi::load_process_list() {
        if let Some(target) = processes.iter().find(|p| p.pid == pid) {
            ensure_name_killable(pid, &target.name)?;
        }
    }
    crate::ffi::kill_process(pid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kernel_pids_refused() {
        assert!(ensure_pid_killable(0).is_err());
        assert!(ensure_pid_killable(4).is_err());
        assert!(ensure_pid_killable(1234).is_ok());
    }

    #[test]
    fn critical_names_refused_case_insensitively() {
        assert!(ensure_name_killable(100, "lsass.exe").is_err());
        assert!(ensure_name_killable(100, "LSASS.EXE").is_err());
        assert!(ensure_name_killable(100, "System").is_err());
        assert!(ensure_name_killable(100, "chrome.exe").is_ok());
    }
}

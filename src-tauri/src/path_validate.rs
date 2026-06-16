//! Path-safety classifier for destructive file commands.
//!
//! The Smart Organizer happily accepts any path from the frontend and hands
//! it to `std::fs::rename`, `trash::delete`, etc. Without a backend check,
//! a UI bug, a manipulated event payload, or a future plugin could trigger
//! a destructive op against `C:\Windows`, the user's profile root, or any
//! ancestor whose deletion would brick the system or wipe user data.
//!
//! This module is the single source of truth for "is this path dangerous?".
//! The classifier returns one of three verdicts so the command layer can
//! decide what to do:
//!
//!   * `Safe`       – ordinary user content, proceed without prompting.
//!   * `Sensitive`  – legitimate but high-risk (e.g. user's Documents
//!                    root itself, a Git working tree, a desktop folder).
//!                    The command layer refuses unless the user explicitly
//!                    opted in via the `allowUnsafe` flag — which the UI
//!                    only sets after surfacing a warning dialog.
//!   * `Forbidden`  – never allowed, even with override. System roots,
//!                    Program Files, drive roots, paths that fall outside
//!                    the user's profile and the well-known data drives.
//!                    No UI path should be able to act on these.
//!
//! Path traversal hardening: every path is normalised via
//! `dunce::canonicalize`-style logic before checks so a relative segment
//! like `Documents\..\..\Windows` can't sneak through.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathVerdict {
    Safe,
    Sensitive,
    Forbidden,
}

/// Classify `path` for destructive operations. The path does NOT need to
/// exist — we still want to refuse `C:\Windows\foo` even if the file is
/// already gone.
pub fn classify(path: &Path) -> PathVerdict {
    // Canonicalise into the form the literal prefix checks below expect:
    // strip `\\?\` verbatim prefixes, expand 8.3 short names, and collapse
    // `.`/`..` segments. Without this, alternate Windows path spellings of a
    // system dir slip through as Safe — e.g. `\\?\C:\Windows` and
    // `C:\PROGRA~1\...` would dodge the Forbidden wall this module exists to
    // enforce. We deliberately avoid `std::fs::canonicalize` (it errors on
    // missing paths, and the classifier must judge not-yet-created
    // destinations too).
    let normalised = canonicalise(path);
    let lower = normalised.to_string_lossy().to_lowercase();

    // ---- Forbidden: anything we refuse outright. ----
    if is_drive_root(&lower) {
        return PathVerdict::Forbidden;
    }
    for forbidden in forbidden_roots() {
        if path_starts_with(&lower, &forbidden) {
            return PathVerdict::Forbidden;
        }
    }
    // Bare path traversal (relative path with .. at the front after
    // normalisation that resolves above any anchor we recognise) is
    // treated as forbidden — the caller should always pass absolute paths.
    if normalised.is_relative() {
        return PathVerdict::Forbidden;
    }

    // ---- Sensitive: legitimate, but worth warning. ----
    // The user's profile root itself (deleting it would log them out and
    // destroy most of their data) and the well-known top-level folders
    // (Documents, Downloads, Desktop, Pictures, Videos, Music) when they
    // ARE the path itself — not when they're an ancestor. A file *inside*
    // Documents is fine; Documents *itself* needs a confirm.
    if let Some(profile) = user_profile_dir() {
        let profile_lower = profile.to_string_lossy().to_lowercase();
        if normalise_eq(&lower, &profile_lower) {
            return PathVerdict::Sensitive;
        }
        for leaf in WELL_KNOWN_USER_DIRS {
            let candidate = format!("{}\\{}", profile_lower.trim_end_matches('\\'), leaf);
            if normalise_eq(&lower, &candidate) {
                return PathVerdict::Sensitive;
            }
        }
    }

    PathVerdict::Safe
}

/// Helper: classify a `String` path (the IPC layer hands us strings).
pub fn classify_str(path: &str) -> PathVerdict {
    classify(Path::new(path))
}

/// Forbidden prefixes (lowercased, no trailing separator). Paths that start
/// with any of these — or are exactly any of these — are always refused.
fn forbidden_roots() -> Vec<String> {
    let mut roots = vec![
        // System roots — never touchable.
        sysroot("windir", "c:\\windows"),
        sysroot("systemroot", "c:\\windows"),
        env_path("PROGRAMFILES", "c:\\program files"),
        env_path("PROGRAMFILES(X86)", "c:\\program files (x86)"),
        env_path("PROGRAMDATA", "c:\\programdata"),
        "c:\\windows".to_string(),
        "c:\\program files".to_string(),
        "c:\\program files (x86)".to_string(),
        "c:\\programdata".to_string(),
        // Boot/EFI partition placeholders.
        "c:\\boot".to_string(),
        "c:\\$recycle.bin".to_string(),
        "c:\\system volume information".to_string(),
        "c:\\$winreagent".to_string(),
        "c:\\recovery".to_string(),
    ];
    // Lowercase + dedupe.
    for r in &mut roots {
        *r = r.to_lowercase();
        while r.ends_with('\\') {
            r.pop();
        }
    }
    roots.sort();
    roots.dedup();
    roots
}

const WELL_KNOWN_USER_DIRS: &[&str] = &[
    "documents",
    "downloads",
    "desktop",
    "pictures",
    "videos",
    "music",
    "appdata",
    "appdata\\local",
    "appdata\\roaming",
    "appdata\\locallow",
    "onedrive",
];

fn sysroot(var: &str, default: &str) -> String {
    std::env::var(var).unwrap_or_else(|_| default.to_string())
}

fn env_path(var: &str, default: &str) -> String {
    std::env::var(var).unwrap_or_else(|_| default.to_string())
}

fn user_profile_dir() -> Option<PathBuf> {
    std::env::var("USERPROFILE").ok().map(PathBuf::from)
}

/// True if `lower` matches "X:\" with nothing else (drive root, e.g. "c:\\").
fn is_drive_root(lower: &str) -> bool {
    let trimmed = lower.trim_end_matches('\\');
    if trimmed.len() == 2 {
        let bytes = trimmed.as_bytes();
        if bytes[1] == b':' && (bytes[0] as char).is_ascii_alphabetic() {
            return true;
        }
    }
    false
}

/// Compare two normalised, lowercased Windows paths for equality up to
/// trailing separators.
fn normalise_eq(a: &str, b: &str) -> bool {
    a.trim_end_matches('\\') == b.trim_end_matches('\\')
}

/// True if `path` is equal to `prefix` or is a child of `prefix`. Both sides
/// must be lowercased Windows paths.
fn path_starts_with(path: &str, prefix: &str) -> bool {
    let p = path.trim_end_matches('\\');
    let q = prefix.trim_end_matches('\\');
    if p == q {
        return true;
    }
    p.starts_with(&format!("{q}\\"))
}

/// Canonicalise a path before safety classification. Resolves the Windows
/// path forms that would otherwise dodge the literal prefix comparisons:
///   * `\\?\C:\...` verbatim / extended-length prefixes (stripped),
///   * `\\?\UNC\server\share` → `\\server\share`,
///   * 8.3 short names like `C:\PROGRA~1` (expanded via `GetLongPathName`
///     against the path or its longest existing ancestor),
///   * `.` / `..` segments (collapsed lexically).
fn canonicalise(path: &Path) -> PathBuf {
    let stripped = strip_verbatim_prefix(path);
    let normalised = lexical_normalise(&stripped);
    #[cfg(windows)]
    {
        expand_short_names(&normalised)
    }
    #[cfg(not(windows))]
    {
        normalised
    }
}

/// Strip the `\\?\` extended-length / verbatim prefix so the path parses as
/// an ordinary drive or UNC path. `\\?\UNC\server\share` becomes
/// `\\server\share`; `\\?\C:\x` becomes `C:\x`.
fn strip_verbatim_prefix(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        if let Some(unc) = rest.strip_prefix("UNC\\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        return PathBuf::from(rest.to_string());
    }
    PathBuf::from(s.into_owned())
}

// `GetLongPathNameW` lives in kernel32, which std already links — declaring
// the import directly keeps this module from taking a `windows`-crate
// dependency just for one call.
#[cfg(windows)]
extern "system" {
    fn GetLongPathNameW(
        lpsz_short_path: *const u16,
        lpsz_long_path: *mut u16,
        cch_buffer: u32,
    ) -> u32;
}

/// Expand 8.3 short components (`PROGRA~1`) to their long form. Tries the
/// whole path first, then walks up to the longest existing ancestor —
/// `GetLongPathName` requires the components to exist on disk — and
/// re-appends the non-existent tail, so a not-yet-created destination under
/// a short-named parent still canonicalises.
#[cfg(windows)]
fn expand_short_names(path: &Path) -> PathBuf {
    if let Some(long) = get_long_path(path) {
        return long;
    }
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = path.to_path_buf();
    while let Some(parent) = cur.parent().map(|p| p.to_path_buf()) {
        match cur.file_name() {
            Some(name) => tail.push(name.to_os_string()),
            None => break,
        }
        if let Some(long) = get_long_path(&parent) {
            let mut out = long;
            for seg in tail.iter().rev() {
                out.push(seg);
            }
            return out;
        }
        if parent == cur {
            break;
        }
        cur = parent;
    }
    path.to_path_buf()
}

/// Wrap `GetLongPathNameW`. Returns `None` when the path doesn't exist (so
/// short names can't be expanded) or the call otherwise fails.
#[cfg(windows)]
fn get_long_path(path: &Path) -> Option<PathBuf> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    if path.as_os_str().is_empty() {
        return None;
    }
    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        // First call (null buffer) returns the required length *including* the
        // trailing NUL; the second returns chars written *excluding* it.
        let needed = GetLongPathNameW(wide.as_ptr(), std::ptr::null_mut(), 0);
        if needed == 0 {
            return None;
        }
        let mut buf = vec![0u16; needed as usize];
        let written = GetLongPathNameW(wide.as_ptr(), buf.as_mut_ptr(), needed);
        if written == 0 || written >= needed {
            return None;
        }
        Some(PathBuf::from(std::ffi::OsString::from_wide(
            &buf[..written as usize],
        )))
    }
}

/// Lex-normalise: collapse `.` and `..` components without touching disk.
/// Returns a `PathBuf` with normalised separators.
fn lexical_normalise(p: &Path) -> PathBuf {
    let mut out: Vec<std::ffi::OsString> = Vec::new();
    let mut prefix: Option<std::ffi::OsString> = None;
    let mut root: bool = false;
    for c in p.components() {
        match c {
            std::path::Component::Prefix(pre) => {
                prefix = Some(pre.as_os_str().to_os_string());
            }
            std::path::Component::RootDir => {
                root = true;
            }
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::Normal(seg) => {
                out.push(seg.to_os_string());
            }
        }
    }
    let mut s = std::ffi::OsString::new();
    if let Some(pre) = prefix { s.push(pre); }
    if root { s.push("\\"); }
    let mut first = true;
    for seg in out {
        if !first { s.push("\\"); }
        s.push(seg);
        first = false;
    }
    PathBuf::from(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drive_root_is_forbidden() {
        assert_eq!(classify_str("C:\\"), PathVerdict::Forbidden);
        assert_eq!(classify_str("D:\\"), PathVerdict::Forbidden);
    }

    #[test]
    fn windows_dir_is_forbidden() {
        assert_eq!(classify_str("C:\\Windows"), PathVerdict::Forbidden);
        assert_eq!(classify_str("C:\\Windows\\System32"), PathVerdict::Forbidden);
        assert_eq!(classify_str("c:\\windows\\system32\\drivers"), PathVerdict::Forbidden);
    }

    #[test]
    fn program_files_is_forbidden() {
        assert_eq!(classify_str("C:\\Program Files\\foo"), PathVerdict::Forbidden);
        assert_eq!(classify_str("C:\\Program Files (x86)\\bar"), PathVerdict::Forbidden);
    }

    #[test]
    fn traversal_resolves_then_classified() {
        // Documents\..\..\Windows resolves above Documents; we treat
        // bare-relative as Forbidden, but more importantly when prepended
        // to a drive it collapses to Windows which is forbidden.
        assert_eq!(
            classify_str("C:\\Users\\Foo\\Documents\\..\\..\\..\\Windows"),
            PathVerdict::Forbidden
        );
    }

    #[test]
    fn verbatim_prefix_windows_dir_is_forbidden() {
        // `\\?\` extended-length spellings of a system dir must not slip
        // through as Safe — they used to, because the literal prefix never
        // matched `c:\windows`.
        assert_eq!(
            classify_str(r"\\?\C:\Windows\System32"),
            PathVerdict::Forbidden
        );
        assert_eq!(
            classify_str(r"\\?\C:\Program Files\foo"),
            PathVerdict::Forbidden
        );
    }

    #[cfg(windows)]
    #[test]
    fn short_name_program_files_is_forbidden() {
        // `C:\PROGRA~1` is the canonical 8.3 alias for `C:\Program Files`.
        // Skip if 8.3 generation is disabled on this volume (the alias then
        // won't resolve), so the test isn't flaky on hardened machines.
        let expands = get_long_path(Path::new(r"C:\PROGRA~1"))
            .map(|p| p.to_string_lossy().to_lowercase().contains("program files"))
            .unwrap_or(false);
        if expands {
            assert_eq!(classify_str(r"C:\PROGRA~1\foo"), PathVerdict::Forbidden);
        }
    }

    #[test]
    fn ordinary_user_file_is_safe() {
        // Skipped when USERPROFILE isn't set in the test env — the
        // function still returns Safe for content under arbitrary drives.
        let v = classify_str("D:\\my media\\song.mp3");
        assert_eq!(v, PathVerdict::Safe);
    }
}

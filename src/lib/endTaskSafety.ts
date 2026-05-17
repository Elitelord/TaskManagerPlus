// End-task safety classification (feature P2) — pure, framework-free,
// unit-testable.
//
// Grades how dangerous it is to end a process into three levels so the
// UI can block the truly-fatal ones and warn appropriately on the rest.
// Replaces the old binary "protected process" name list with a graded
// check that also reads PE version-resource metadata (CompanyName) and
// the install path — so an OS binary that isn't in the hardcoded list is
// still recognised as system plumbing.
//
// Threat model note: CompanyName can be spoofed, but that only ever makes
// this MORE cautious (a faked "Microsoft" company name pushes a process
// toward "caution"). The goal here is preventing accidental termination
// of real system processes, not detecting malware — so trusting the
// version resource is fine.

export type EndTaskSafety =
  | "critical"  // OS core — ending it crashes Windows or logs the user out
  | "caution"   // system process — ending it disrupts the desktop session
                //   but Windows recovers (or a sign-out fixes it)
  | "normal";   // ordinary application — safe to end

/** OS-core processes. Ending any of these bluescreens Windows or forcibly
 *  ends the session. The UI must refuse outright. */
const CRITICAL_NAMES = new Set([
  "system", "system idle process", "registry", "secure system",
  "memory compression", "ntoskrnl.exe",
  "smss.exe", "csrss.exe", "wininit.exe", "winlogon.exe",
  "services.exe", "lsass.exe", "lsaiso.exe",
]);

/** System processes that disrupt the desktop/session when ended but that
 *  Windows restarts automatically, or that a sign-out repairs. */
const CAUTION_NAMES = new Set([
  "svchost.exe", "dwm.exe", "explorer.exe", "fontdrvhost.exe",
  "sihost.exe", "ctfmon.exe", "runtimebroker.exe", "conhost.exe",
  "dllhost.exe", "taskhostw.exe", "spoolsv.exe", "audiodg.exe",
  "logonui.exe", "userinit.exe", "wmiprvse.exe", "wudfhost.exe",
  "shellexperiencehost.exe", "startmenuexperiencehost.exe",
  "textinputhost.exe", "searchhost.exe", "searchindexer.exe",
  "lockapp.exe", "applicationframehost.exe",
]);

/** True when the image lives in a Windows system directory. */
function inWindowsSystemDir(imagePath: string): boolean {
  const p = imagePath.toLowerCase().replace(/\//g, "\\");
  return (
    p.includes("\\windows\\system32\\") ||
    p.includes("\\windows\\syswow64\\") ||
    p.includes("\\windows\\systemapps\\") ||
    p.includes("\\windows\\winsxs\\")
  );
}

/** True when the version-resource CompanyName indicates a Microsoft binary. */
function isMicrosoftCompany(companyName: string): boolean {
  return /\bmicrosoft\b/i.test(companyName);
}

/**
 * Classify how safe it is to end a process. Works with just the exe name
 * (the hardcoded sets); `company_name` / `image_path` (PE metadata, may be
 * absent) refine the result — a Microsoft-published binary running from a
 * Windows system directory is treated as `caution` even when it isn't in
 * any list.
 */
export function classifyEndTaskSafety(p: {
  name: string;
  company_name?: string;
  image_path?: string;
}): EndTaskSafety {
  const name = p.name.trim().toLowerCase();
  if (CRITICAL_NAMES.has(name)) return "critical";
  if (CAUTION_NAMES.has(name)) return "caution";

  // Metadata-driven (P2): OS plumbing not covered by the lists above.
  const path = p.image_path ?? "";
  const company = p.company_name ?? "";
  if (path && company && inWindowsSystemDir(path) && isMicrosoftCompany(company)) {
    return "caution";
  }
  return "normal";
}

/** Human-readable warning shown in the end-task confirm dialog. `null`
 *  for `normal` processes — the dialog uses its generic message then. */
export function endTaskWarning(safety: EndTaskSafety): string | null {
  switch (safety) {
    case "critical":
      return "This is a core Windows process. Ending it will crash or " +
        "freeze Windows.";
    case "caution":
      return "This is a Windows system process. Ending it can make the " +
        "desktop unstable until you sign out and back in.";
    case "normal":
      return null;
  }
}

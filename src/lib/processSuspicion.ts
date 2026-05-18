// Suspicious-process soft flag (feature P3) — pure, framework-free, testable.
//
// A LOW-CONFIDENCE "this looks unusual" signal — explicitly NOT malware
// detection. TaskManagerPlus is not an antivirus; this only nudges the user
// to look closer at a process whose run location is atypical.
//
// Honest scope note (spike S-7, see docs/AI_INTEGRATION_PLAN.md §7.8): the
// P3 spec also lists CPU-spikes-during-idle, Authenticode-signature, and
// network-destination signals. None of those exist in `ProcessInfo` today —
// per-process CPU history, code-signing status, and per-process network are
// not plumbed through the native FFI. Surfacing them is a native/Rust
// effort out of scope for this Lite rules pass, so P3 ships with the one
// signal the data model already carries — where the executable runs from —
// and the behavioural signals are deferred.
//
// Conservative by design: `unusual` is true only on a location signal
// (temp / Downloads / Recycle Bin). A blank publisher field is far too
// common among legitimate software to flag on its own, so it is only ever
// added as a secondary reason once the location has already flagged.

import { classifyRunLocation, type ProcessLike } from "./processExplain";
import { isSystemProcessName } from "./insights";

export interface SuspicionVerdict {
  /** True when the process is worth a second look. Soft signal only. */
  unusual: boolean;
  /** Plain-language reasons, in priority order. Empty when `unusual` is false. */
  reasons: string[];
}

/**
 * Flag a process whose run location is atypical. Windows system processes
 * are never flagged. Returns `{ unusual: false, reasons: [] }` for anything
 * ordinary.
 */
export function flagSuspiciousProcess(p: ProcessLike): SuspicionVerdict {
  const loc = classifyRunLocation(p.image_path ?? "");

  // Never flag OS plumbing — system dirs and the known system-process set.
  if (loc === "system" || isSystemProcessName(p.name)) {
    return { unusual: false, reasons: [] };
  }

  const reasons: string[] = [];
  if (loc === "temp") {
    reasons.push("Runs from a temporary folder");
  } else if (loc === "downloads") {
    reasons.push("Runs straight from the Downloads folder");
  } else if (loc === "recycle-bin") {
    reasons.push("Runs from inside the Recycle Bin");
  }

  if (reasons.length === 0) {
    return { unusual: false, reasons: [] };
  }

  // Compounding factor — meaningful only now the location has flagged.
  const company = (p.company_name ?? "").trim();
  const product = (p.product_name ?? "").trim();
  if (!company && !product) {
    reasons.push("The file carries no publisher information");
  }

  return { unusual: true, reasons };
}

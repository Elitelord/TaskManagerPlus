// Unknown-process explanation (feature P1) — pure, framework-free, testable.
//
// Produces a single human-readable line answering "what is this process?"
// for a user who doesn't recognise an executable name. Rules over the
// metadata the process list already carries — the version-resource
// ProductName / CompanyName, the image path, the Chromium `process_type` —
// the same enhanced-rules approach as I3 and P2, no model. Ships for all
// users (it's rules, not AI), not tier-gated.

import { classifyEndTaskSafety } from "./endTaskSafety";
import { isHelperProcess, isSystemProcessName } from "./insights";

/** The subset of `ProcessInfo` the P1/P3 process heuristics need. Kept as a
 *  loose shape so callers can pass a `ProcessInfo` directly. */
export interface ProcessLike {
  name: string;
  process_type?: string;
  company_name?: string;
  product_name?: string;
  image_path?: string;
}

/** Where an executable is running from — a coarse, security-relevant bucket. */
export type RunLocation =
  | "system"        // a Windows system directory
  | "program-files" // a normal install under Program Files
  | "appdata"       // a per-user install under AppData
  | "temp"          // a temp / tmp folder
  | "downloads"     // the Downloads folder
  | "recycle-bin"   // inside $Recycle.Bin
  | "other";

/** Bucket an image path by where it lives. Order matters — `temp` sits
 *  inside `AppData`, so it must be checked first. */
export function classifyRunLocation(imagePath: string): RunLocation {
  const p = (imagePath ?? "").toLowerCase().replace(/\//g, "\\");
  if (!p) return "other";
  if (p.includes("\\$recycle.bin\\")) return "recycle-bin";
  if (
    p.includes("\\windows\\system32\\") ||
    p.includes("\\windows\\syswow64\\") ||
    p.includes("\\windows\\systemapps\\") ||
    p.includes("\\windows\\winsxs\\")
  ) return "system";
  if (p.includes("\\temp\\") || p.includes("\\tmp\\")) return "temp";
  if (p.includes("\\downloads\\")) return "downloads";
  if (p.includes("\\program files\\") || p.includes("\\program files (x86)\\")) {
    return "program-files";
  }
  if (p.includes("\\appdata\\")) return "appdata";
  return "other";
}

/** Friendly label for a Chromium-style subprocess `process_type`. */
const SUBPROCESS_ROLE: Record<string, string> = {
  renderer: "Renderer process",
  gpu: "GPU process",
  "gpu-process": "GPU process",
  utility: "Utility process",
  "extension-host": "Extension host",
  zygote: "Sandbox helper",
  ppapi: "Plugin process",
  broker: "Broker process",
  "crashpad-handler": "Crash-reporter process",
};

/**
 * Return a one-line, plain-language explanation of what a process is.
 * Never empty — falls back to an honest "no publisher information" line.
 *
 * `opts.asGroup` is set when explaining a *collapsed group row* rather than
 * one process. A group represents a whole application, so the subprocess
 * and helper branches are skipped — a Chrome group must read as "Google
 * Chrome", never as "Renderer process of Chrome" just because the first
 * child in the group happened to be a tab. See `explainProcessGroup`.
 */
export function explainProcess(
  p: ProcessLike,
  opts: { asGroup?: boolean } = {},
): string {
  const name = p.name.trim();
  const company = (p.company_name ?? "").trim();
  const product = (p.product_name ?? "").trim();
  const ptype = (p.process_type ?? "").trim().toLowerCase();

  // 1. OS processes — reuse the end-task safety grading as the source of truth.
  const safety = classifyEndTaskSafety({
    name,
    company_name: company,
    image_path: p.image_path ?? "",
  });
  if (safety === "critical") {
    return "Core Windows process — essential; the system depends on it.";
  }
  if (safety === "caution" || isSystemProcessName(name)) {
    return "Windows system process — part of the OS, runs in the background.";
  }

  // 2. Chromium-style subprocess — the `process_type` field names the role.
  //    Skipped for a group: the group IS the application, not a subprocess.
  if (!opts.asGroup && ptype && ptype !== "main") {
    const role = SUBPROCESS_ROLE[ptype] ?? `${ptype} subprocess`;
    const owner = product || company;
    return owner
      ? `${role} of ${owner} — one of its background subprocesses.`
      : `${role} — a background subprocess of a larger application.`;
  }

  // 3. Helper / launcher / service process — also skipped for a group.
  if (!opts.asGroup && isHelperProcess(name)) {
    const owner = product || company;
    return owner
      ? `Background helper for ${owner}.`
      : "Background helper process belonging to another application.";
  }

  // 4. Version-resource metadata — the most informative case.
  if (product && company) return `${product} — published by ${company}.`;
  if (product) return `Part of ${product}.`;
  if (company) return `Published by ${company}.`;

  // 5. No metadata — fall back to where the file runs from.
  switch (classifyRunLocation(p.image_path ?? "")) {
    case "program-files":
      return "An installed desktop application.";
    case "appdata":
      return "An application installed for your user account.";
    case "temp":
      return "Running from a temporary folder — unusual for a program you keep open.";
    case "downloads":
      return "Running straight from your Downloads folder.";
    case "recycle-bin":
      return "Running from inside the Recycle Bin — this is unusual.";
    default:
      return "Unrecognised program — the file carries no publisher information.";
  }
}

/**
 * Explain a *collapsed group row* — one application that owns several
 * processes (a browser and its tabs, an app and its background helpers).
 *
 * Picks the application's MAIN process as the representative — not just
 * `children[0]`, which for a browser is an arbitrary renderer tab — and
 * explains it `asGroup`, so the row reads as the application itself. A
 * group flagged `isSystem` is described as OS plumbing directly, without
 * depending on any child's metadata.
 */
export function explainProcessGroup(
  children: ProcessLike[],
  isSystem: boolean,
): string {
  if (isSystem) {
    return "Windows system processes — part of the OS, running in the background.";
  }
  if (children.length === 0) {
    return "Application made up of several background processes.";
  }
  // The main process is the one that is NOT a Chromium-style subprocess.
  const isMain = (c: ProcessLike) => {
    const t = (c.process_type ?? "").trim().toLowerCase();
    return !t || t === "main" || t === "browser";
  };
  const hasMeta = (c: ProcessLike) =>
    !!(c.product_name?.trim() || c.company_name?.trim());
  const rep =
    children.find((c) => isMain(c) && hasMeta(c)) ??
    children.find(isMain) ??
    children.find(hasMeta) ??
    children[0];
  return explainProcess(rep, { asGroup: true });
}

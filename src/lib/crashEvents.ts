/**
 * Crash / unexpected-shutdown helpers (Phase 1).
 *
 * Pure logic shared by the Insights crash card and the desktop notifier:
 * classification labels and "is there a crash the user hasn't seen yet?"
 * selection. The raw events come from the `get_unexpected_shutdowns` Tauri
 * command (see lib/ipc.ts), which already deduped the event-log triplets into
 * incidents sorted newest-first.
 */

import {
  lookupStopCode,
  remediationFor,
  type CrashClass,
  type CrashPresentation,
  type StopCodeInfo,
  type RemediationStep,
} from "./stopCodes";

export type ShutdownKind = "bsod" | "power_loss" | "unexpected_shutdown";

export interface ShutdownEvent {
  /** Unix epoch milliseconds (UTC). */
  timestampMs: number;
  kind: ShutdownKind | string;
  /** BSOD stop code (e.g. "0x0000007E") when known. */
  bugcheckCode?: string | null;
  /** Short human-readable cause line from the backend. */
  detail: string;
}

export interface IncidentClassification {
  presentation: CrashPresentation;
  klass: CrashClass;
  /** The recognised stop code, when we have one. */
  stopInfo: StopCodeInfo | null;
}

/**
 * Resolve an incident to how it presented + which subsystem it implicates.
 * Prefers the specific stop-code reference; otherwise infers from the
 * backend's coarse `kind` so even unknown/dumpless crashes are categorised.
 */
export function classifyIncident(e: ShutdownEvent): IncidentClassification {
  const stopInfo = lookupStopCode(e.bugcheckCode);
  if (stopInfo) {
    return { presentation: stopInfo.presentation, klass: stopInfo.klass, stopInfo };
  }
  switch (e.kind) {
    case "bsod":
      return { presentation: "bluescreen", klass: "driver", stopInfo: null };
    case "power_loss":
      return { presentation: "power_loss", klass: "power", stopInfo: null };
    default:
      return { presentation: "unknown", klass: "unknown", stopInfo: null };
  }
}

/** Human label for a presentation — the headline that stops calling a silent
 *  power hang a "blue screen". */
export function presentationTitle(p: CrashPresentation): string {
  switch (p) {
    case "bluescreen":
      return "Blue-screen crash";
    case "hang":
      return "System hang / freeze";
    case "power_loss":
      return "Power loss or forced shutdown";
    case "thermal":
      return "Thermal shutdown";
    default:
      return "Unexpected shutdown";
  }
}

/** Short card title for an incident (presentation label; the stop code is
 *  shown separately as a chip). */
export function causeTitle(e: ShutdownEvent): string {
  return presentationTitle(classifyIncident(e).presentation);
}

/** Ordered "what to try" steps for an incident, from its implicated class. */
export function incidentRemediation(e: ShutdownEvent): RemediationStep[] {
  return remediationFor(classifyIncident(e).klass);
}

/** Stable key for clustering recurring incidents: the stop code when known,
 *  else the coarse kind. Drives the "Nth time you've hit this" signal. */
export function incidentKey(e: ShutdownEvent): string {
  const info = lookupStopCode(e.bugcheckCode);
  return info ? info.code : e.kind;
}

/** How many incidents in `events` are the same class of failure as `e`. */
export function sameKindCount(events: ShutdownEvent[], e: ShutdownEvent): number {
  const key = incidentKey(e);
  return events.filter((x) => incidentKey(x) === key).length;
}

/** Plain-English explanation of what a given incident kind means. */
export function causeExplanation(e: ShutdownEvent): string {
  switch (e.kind) {
    case "bsod":
      return "Windows hit a fatal error and restarted. The stop code names the component that failed — a code that keeps recurring usually points to a specific driver or failing hardware.";
    case "power_loss":
      return "The system lost power or was switched off without shutting down, and no crash dump was recorded. On a laptop this is most often a drained battery; on a desktop, a power interruption or a held power button.";
    default:
      return "Windows didn't shut down cleanly. This can be a crash, a power loss, or the power button being held — the event log didn't capture enough to say which.";
  }
}

/** Coarse relative-day label ("today" / "yesterday" / "N days ago"). */
export function describeWhen(ms: number, nowMs: number = Date.now()): string {
  const startOfDay = (t: number) => {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const days = Math.round((startOfDay(nowMs) - startOfDay(ms)) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  const weeks = Math.round(days / 7);
  return `${weeks} week${weeks !== 1 ? "s" : ""} ago`;
}

/**
 * The newest incident strictly newer than `thresholdMs`, or null. Events are
 * already sorted newest-first by the backend, but we don't rely on that — we
 * scan for the max so a caller passing an unsorted list still gets the right
 * answer.
 */
export function newestNewerThan(
  events: ShutdownEvent[],
  thresholdMs: number,
): ShutdownEvent | null {
  let best: ShutdownEvent | null = null;
  for (const e of events) {
    if (e.timestampMs <= thresholdMs) continue;
    if (!best || e.timestampMs > best.timestampMs) best = e;
  }
  return best;
}

// --- Implicated-driver + event-context helpers (card items C/D/E) ---

export interface DriverInfo {
  class: CrashClass | string;
  name: string;
  version: string;
  dateMs?: number | null;
  /** Driver provider; "Microsoft" marks a Windows-inbox driver. */
  provider?: string;
}

export interface ContextEvent {
  timestampMs: number;
  /** "gpu_tdr" | "whea" | "disk". */
  source: string;
  detail: string;
  /** GPU TDRs carry the display-driver name. */
  driver?: string | null;
}

export interface CrashContext {
  events: ContextEvent[];
  modernStandby: boolean;
  s3Available: boolean;
}

/** Pick the device most relevant to an incident's implicated subsystem, or
 *  null when the class doesn't map to a single device (memory, CPU, etc.). */
export function pickDriverForClass(
  drivers: DriverInfo[],
  klass: CrashClass,
): DriverInfo | null {
  const find = (c: string) => drivers.find((d) => d.class === c) ?? null;
  switch (klass) {
    case "gpu":
      return find("gpu");
    case "wifi":
      return find("wifi") ?? find("network");
    case "network":
      return find("network") ?? find("wifi");
    case "storage":
      return find("storage");
    case "power":
      // Power-state hangs are usually Wi-Fi or GPU power drivers.
      return find("wifi") ?? find("gpu") ?? find("network");
    default:
      return null;
  }
}

/** Coarse driver-age label ("18 days old" / "7 months old" / "1 yr 2 mo old"). */
export function ageLabel(dateMs?: number | null, nowMs: number = Date.now()): string | null {
  if (!dateMs) return null;
  const days = Math.floor((nowMs - dateMs) / 86_400_000);
  if (days < 0) return null;
  if (days < 45) return `${days} day${days !== 1 ? "s" : ""} old`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} months old`;
  const years = Math.floor(days / 365);
  const remMonths = Math.floor((days - years * 365) / 30);
  if (years < 3 && remMonths > 0) return `${years} yr ${remMonths} mo old`;
  return `${years} year${years !== 1 ? "s" : ""} old`;
}

/** Context events within `windowMs` of an incident timestamp. */
export function contextNear(
  events: ContextEvent[],
  timestampMs: number,
  windowMs: number = 10 * 60 * 1000,
): ContextEvent[] {
  return events.filter((e) => Math.abs(e.timestampMs - timestampMs) <= windowMs);
}

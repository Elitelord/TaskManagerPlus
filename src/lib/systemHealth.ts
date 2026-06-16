/**
 * System & driver health helpers (Update Helper — Phase 1).
 *
 * Pure logic for the persistent health card: which drivers count as "key",
 * which look stale, the OEM support link for a given manufacturer, and the
 * dismiss signature that controls when a dismissed card re-appears. The actual
 * Windows Update *scan* (a pending-update count) is Phase 2.
 */
import type { DriverInfo } from "./crashEvents";

export interface BiosInfo {
  version: string;
  dateMs?: number | null;
  manufacturer: string;
  model: string;
}

const MONTH_MS = 30 * 86_400_000;
/** Drivers older than this are flagged for review. */
export const STALE_MONTHS = 18;

/** True when a driver/firmware date is older than `months`. */
export function isStale(
  dateMs?: number | null,
  nowMs: number = Date.now(),
  months: number = STALE_MONTHS,
): boolean {
  if (!dateMs) return false;
  return nowMs - dateMs > months * MONTH_MS;
}

/** A Windows-inbox (Microsoft-provided) driver. These carry deliberately
 *  ancient dates (e.g. 2006 for the generic disk driver), so age-based
 *  staleness is meaningless — the user can't "update" them outside of Windows. */
export function isInbox(d: DriverInfo): boolean {
  return (d.provider ?? "").toLowerCase().includes("microsoft");
}

// Crash-relevant driver classes, in display order.
const KEY_CLASSES = ["gpu", "wifi", "network", "storage"];

/** The key crash-relevant drivers, ordered GPU → Wi-Fi → network → storage. */
export function keyDrivers(drivers: DriverInfo[]): DriverInfo[] {
  const order = new Map(KEY_CLASSES.map((c, i) => [c, i] as const));
  return drivers
    .filter((d) => order.has(String(d.class)))
    .slice()
    .sort((a, b) => (order.get(String(a.class)) ?? 99) - (order.get(String(b.class)) ?? 99));
}

/** Key drivers that look out of date. Windows-inbox drivers are excluded —
 *  their ancient dates aren't "staleness" the user can act on. */
export function staleDrivers(drivers: DriverInfo[], nowMs: number = Date.now()): DriverInfo[] {
  return keyDrivers(drivers).filter((d) => !isInbox(d) && isStale(d.dateMs, nowMs));
}

export interface OemLink {
  label: string;
  url: string;
}

/** Best-effort OEM support/driver landing page for a manufacturer string.
 *  Stable homepages only — we don't fabricate model-specific deep links. */
export function oemSupportLink(manufacturer: string): OemLink | null {
  const m = manufacturer.toLowerCase();
  if (m.includes("asus")) return { label: "ASUS support", url: "https://www.asus.com/support/" };
  if (m.includes("dell")) return { label: "Dell support", url: "https://www.dell.com/support/home" };
  if (m.includes("hewlett") || m.startsWith("hp"))
    return { label: "HP support", url: "https://support.hp.com/us-en/drivers" };
  if (m.includes("lenovo")) return { label: "Lenovo support", url: "https://support.lenovo.com/" };
  if (m.includes("acer")) return { label: "Acer support", url: "https://www.acer.com/us-en/support" };
  if (m.includes("micro-star") || m.includes("msi"))
    return { label: "MSI support", url: "https://www.msi.com/support/" };
  if (m.includes("microsoft"))
    return { label: "Microsoft support", url: "https://support.microsoft.com/" };
  if (m.includes("razer")) return { label: "Razer support", url: "https://mysupport.razer.com/" };
  if (m.includes("samsung")) return { label: "Samsung support", url: "https://www.samsung.com/us/support/" };
  if (m.includes("gigabyte")) return { label: "Gigabyte support", url: "https://www.gigabyte.com/Support" };
  if (m.includes("framework")) return { label: "Framework support", url: "https://knowledgebase.frame.work/" };
  return null;
}

/**
 * Dismiss high-water-mark signature. Changes when the actionable state changes
 * — a key driver goes stale, a stale one gets updated, etc. — so a dismissed
 * card re-appears only when there's something new to see. Always non-empty so
 * the default-empty dismissed value shows the card on first run.
 */
export function healthSignature(drivers: DriverInfo[], nowMs: number = Date.now()): string {
  const stale = staleDrivers(drivers, nowMs)
    .map((d) => `${d.class}:${d.name}:${d.dateMs ?? 0}`)
    .sort();
  return `v1|${stale.join("|")}`;
}

// --- Windows Update status (Phase 2) ---

export interface WindowsUpdateStatus {
  /** False when the scan couldn't run. */
  ok: boolean;
  driverUpdates: number;
  otherUpdates: number;
}

/** Total pending updates, or 0 when the scan failed / found nothing. */
export function totalUpdates(s?: WindowsUpdateStatus): number {
  if (!s || !s.ok) return 0;
  return s.driverUpdates + s.otherUpdates;
}

/** Dismiss signature for the "updates available" card — changes when the
 *  pending counts change, so the card re-appears as new updates land. */
export function updatesSignature(s?: WindowsUpdateStatus): string {
  if (!s || !s.ok) return "none";
  return `d${s.driverUpdates}-o${s.otherUpdates}`;
}

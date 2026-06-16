/**
 * One-shot desktop notification for a newly-detected crash / unexpected
 * shutdown (Phase 1). Separate from `insightNotifier` because crash events
 * come from a one-time event-log query, not the per-tick insight stream — but
 * it follows the same permission-caching pattern so we never spam prompts.
 *
 * Gated on `desktopNotifications` and de-duplicated via `lastNotifiedCrashMs`
 * in settings so a given incident toasts at most once, even across app
 * restarts.
 */
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { getSettings, updateSettings } from "./settings";
import { causeTitle, newestNewerThan, type ShutdownEvent } from "./crashEvents";

let permissionPromise: Promise<boolean> | null = null;

async function ensurePermission(): Promise<boolean> {
  if (permissionPromise) return permissionPromise;
  permissionPromise = (async () => {
    try {
      if (await isPermissionGranted()) return true;
      return (await requestPermission()) === "granted";
    } catch (e) {
      console.warn("[crashNotifier] permission check failed:", e);
      return false;
    }
  })();
  return permissionPromise;
}

/**
 * Fire a desktop toast for the newest crash the user hasn't been notified
 * about yet, then advance the high-water mark. No-op when notifications are
 * disabled or nothing new is present. Returns the event that was notified (or
 * null) — handy for tests / callers that want to react.
 */
export async function maybeNotifyCrash(
  events: ShutdownEvent[],
): Promise<ShutdownEvent | null> {
  const settings = getSettings();
  const newest = newestNewerThan(events, settings.lastNotifiedCrashMs);
  if (!newest) return null;

  // Always advance the mark, even if the user has notifications off, so
  // re-enabling later doesn't replay an old crash.
  updateSettings({ lastNotifiedCrashMs: newest.timestampMs });

  if (!settings.desktopNotifications) return null;

  const granted = await ensurePermission();
  if (!granted) return null;

  try {
    const when = new Date(newest.timestampMs).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
    const code = newest.bugcheckCode ? ` (${newest.bugcheckCode})` : "";
    sendNotification({
      title: "TaskManager+ · Unexpected shutdown",
      body: `${causeTitle(newest)}${code}\n${when}`,
    });
  } catch (e) {
    console.warn("[crashNotifier] sendNotification failed:", e);
  }
  return newest;
}

/** Reset cached permission state — mirrors `resetInsightNotifier`. */
export function resetCrashNotifier() {
  permissionPromise = null;
}

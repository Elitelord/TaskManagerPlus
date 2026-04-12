/**
 * Desktop notification bridge for the insights engine.
 *
 * Subscribes to the `notify()` stream from `insightsEngine` (via `useInsights`
 * being called during render — but we don't need React for this). Instead, we
 * hook into the raw engine by exposing `subscribeInsightNotifications` here
 * and calling it once from App.
 *
 * The notifier is de-duplicated by insight id so a persistent condition (e.g.
 * a memory leak that stays active for hours) only fires ONE desktop toast the
 * first time it's detected. Dismissing and re-detecting does fire again.
 */
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import type { Insight, InsightSeverity } from "./insights";
import { getSettings } from "./settings";

const SEVERITY_ORDER: Record<InsightSeverity, number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

const SEVERITY_PREFIX: Record<InsightSeverity, string> = {
  info: "Info",
  warning: "Warning",
  critical: "Critical",
};

/** Insight ids that have already been notified during this run. */
const notifiedIds = new Set<string>();

/** Ids seen in the previous analysis tick — used to detect "new" insights. */
let previousIds = new Set<string>();

/** Resolved once on first call — avoids spamming permission prompts. */
let permissionPromise: Promise<boolean> | null = null;

async function ensurePermission(): Promise<boolean> {
  if (permissionPromise) return permissionPromise;
  permissionPromise = (async () => {
    try {
      if (await isPermissionGranted()) return true;
      const res = await requestPermission();
      return res === "granted";
    } catch (e) {
      console.warn("[insightNotifier] permission check failed:", e);
      return false;
    }
  })();
  return permissionPromise;
}

/**
 * Process a freshly-computed insight list. Should be called from the engine
 * after `runAnalysis` finishes.
 */
export async function handleInsightTick(insights: Insight[]) {
  const settings = getSettings();
  if (!settings.desktopNotifications) {
    // User disabled notifications — keep tracking ids so we don't spam when
    // they re-enable, but don't fire anything.
    previousIds = new Set(insights.map(i => i.id));
    return;
  }

  const minRank = SEVERITY_ORDER[settings.notificationMinSeverity];

  // Find insights that are NEW this tick (not in previousIds) and haven't
  // already been notified in this session.
  const newOnes: Insight[] = [];
  for (const i of insights) {
    if (previousIds.has(i.id)) continue;
    if (notifiedIds.has(i.id)) continue;
    if (SEVERITY_ORDER[i.severity] < minRank) continue;
    newOnes.push(i);
  }

  // Update the "seen" snapshot before any await so rapid successive ticks
  // don't re-enqueue the same items.
  previousIds = new Set(insights.map(i => i.id));

  if (newOnes.length === 0) return;

  const granted = await ensurePermission();
  if (!granted) return;

  // Batch: if > 2 new issues popped at once, send one aggregate toast instead
  // of spamming the tray.
  if (newOnes.length > 2) {
    const top = newOnes
      .slice()
      .sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity])[0];
    try {
      sendNotification({
        title: `TaskManager+ · ${newOnes.length} new issues`,
        body: `${SEVERITY_PREFIX[top.severity]}: ${top.title}${
          top.metric ? ` (${top.metric})` : ""
        }`,
      });
      for (const i of newOnes) notifiedIds.add(i.id);
    } catch (e) {
      console.warn("[insightNotifier] sendNotification failed:", e);
    }
    return;
  }

  for (const i of newOnes) {
    try {
      sendNotification({
        title: `TaskManager+ · ${SEVERITY_PREFIX[i.severity]}`,
        body: `${i.title}${i.metric ? ` — ${i.metric}` : ""}\n${i.description}`,
      });
      notifiedIds.add(i.id);
    } catch (e) {
      console.warn("[insightNotifier] sendNotification failed:", e);
    }
  }
}

/** Clear notifier state — used by settings "reset" actions. */
export function resetInsightNotifier() {
  notifiedIds.clear();
  previousIds = new Set();
  permissionPromise = null;
}

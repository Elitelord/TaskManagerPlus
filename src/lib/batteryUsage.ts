import type { PerformanceSnapshot } from "./types";

type TopPowerEntry = { name: string; value: number };

/** Rolling in-app data for per-app Wh (last ~24h on battery only). */
interface BatteryHourlyStoreV2 {
  v: 2;
  lastTs?: number;
  lastOnBattery?: boolean;
  lastSystemWatts?: number;
  lastTopPower?: TopPowerEntry[];
  hours: Record<string, { systemWh: number; appsWh: Record<string, number> }>;
}

const STORAGE_KEY = "taskmanagerplus-battery-hourly-v2";
const MAX_GAP_MS = 10 * 60 * 1000;
const PRUNE_HOURS = 26;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function hourKeyLocal(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}`;
}

function hourKeyToStartMs(hk: string): number {
  const [datePart, hPart] = hk.split("T");
  const [y, mo, da] = datePart.split("-").map(Number);
  return new Date(y, mo - 1, da, Number(hPart), 0, 0, 0).getTime();
}

function safeParse(raw: string | null): BatteryHourlyStoreV2 | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (!obj || obj.v !== 2 || typeof obj.hours !== "object") return null;
    return obj as BatteryHourlyStoreV2;
  } catch {
    return null;
  }
}

function loadStore(): BatteryHourlyStoreV2 {
  const existing = safeParse(localStorage.getItem(STORAGE_KEY));
  return existing ?? { v: 2, hours: {} };
}

function saveStore(store: BatteryHourlyStoreV2) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // ignore
  }
}

function pruneHours(store: BatteryHourlyStoreV2) {
  const cutoff = Date.now() - PRUNE_HOURS * 3600000;
  for (const k of Object.keys(store.hours)) {
    if (hourKeyToStartMs(k) < cutoff) delete store.hours[k];
  }
}

function clampWatts(w: number): number {
  if (!Number.isFinite(w)) return 0;
  if (w < 0) return 0;
  if (w > 300) return 300;
  return w;
}

function normalizeTopPower(list: TopPowerEntry[] | undefined): TopPowerEntry[] {
  if (!list || list.length === 0) return [];
  return list
    .filter((e) => e && typeof e.name === "string" && Number.isFinite(e.value) && e.value > 0)
    .map((e) => ({ name: e.name, value: clampWatts(e.value) }))
    .slice(0, 16);
}

/** Integrate per tick while on battery — powers 24h per-app list (in-app estimate). */
export function recordBatteryHourlySample(args: {
  timestamp: number;
  snapshot: PerformanceSnapshot;
  topPower?: TopPowerEntry[];
}) {
  const { timestamp: ts, snapshot } = args;
  const onBattery = !snapshot.is_charging;
  const systemWatts = clampWatts(snapshot.power_draw_watts ?? 0);
  const topPower = normalizeTopPower(args.topPower);

  const store = loadStore();
  const prevTs = store.lastTs;

  if (prevTs !== undefined) {
    const dtMs = ts - prevTs;
    if (dtMs > 0 && dtMs <= MAX_GAP_MS) {
      const dtHours = dtMs / 3600000;
      if (store.lastOnBattery) {
        const prevW = clampWatts(store.lastSystemWatts ?? 0);
        const wh = prevW * dtHours;
        const key = hourKeyLocal(prevTs);
        const hour = (store.hours[key] ??= { systemWh: 0, appsWh: {} });
        hour.systemWh += wh;

        const prevApps = normalizeTopPower(store.lastTopPower);
        for (const app of prevApps) {
          hour.appsWh[app.name] = (hour.appsWh[app.name] ?? 0) + app.value * dtHours;
        }
      }
    }
  }

  store.lastTs = ts;
  store.lastOnBattery = onBattery;
  store.lastSystemWatts = systemWatts;
  store.lastTopPower = topPower;
  pruneHours(store);
  saveStore(store);
}

export function clearBatteryHourlyHistory() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

const WINDOW_MS = 24 * 3600000;

/** Per-app Wh over the last 24 hours (only while TaskManager+ was running on battery). */
export function getLast24HoursAppsWh(limit = 10): { name: string; wh: number }[] {
  const store = loadStore();
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const totals = new Map<string, number>();

  for (const [hk, data] of Object.entries(store.hours)) {
    if (hourKeyToStartMs(hk) < cutoff) continue;
    for (const [name, wh] of Object.entries(data.appsWh ?? {})) {
      totals.set(name, (totals.get(name) ?? 0) + (wh ?? 0));
    }
  }

  return [...totals.entries()]
    .map(([name, wh]) => ({ name, wh }))
    .filter((x) => x.wh > 0.01)
    .sort((a, b) => b.wh - a.wh)
    .slice(0, limit);
}

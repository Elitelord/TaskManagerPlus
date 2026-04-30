/**
 * Persisted UI preferences for the Devices page.
 *
 * Stored fields — sort + category filter. The search query is deliberately
 * not persisted: it resets to empty each time the page is visited, so users
 * don't re-open the app with an old filter hiding all their devices.
 */

const STORAGE_KEY = "taskmanagerplus-devices-prefs";

export type DevicePrefsSortKey = "name" | "category" | "status" | "source";
export type DevicePrefsSortDir = "asc" | "desc";

export interface DevicePrefs {
  sortKey: DevicePrefsSortKey;
  sortDir: DevicePrefsSortDir;
  activeCategory: string; // Category | "all" — validated on read
}

const DEFAULT_PREFS: DevicePrefs = {
  sortKey: "status",
  sortDir: "desc",
  activeCategory: "all",
};

const SORT_KEYS = new Set<DevicePrefsSortKey>(["name", "category", "status", "source"]);
const SORT_DIRS = new Set<DevicePrefsSortDir>(["asc", "desc"]);

export function loadDevicePrefs(): DevicePrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<DevicePrefs>;
    return {
      sortKey: SORT_KEYS.has(parsed.sortKey as DevicePrefsSortKey)
        ? (parsed.sortKey as DevicePrefsSortKey)
        : DEFAULT_PREFS.sortKey,
      sortDir: SORT_DIRS.has(parsed.sortDir as DevicePrefsSortDir)
        ? (parsed.sortDir as DevicePrefsSortDir)
        : DEFAULT_PREFS.sortDir,
      activeCategory:
        typeof parsed.activeCategory === "string" && parsed.activeCategory
          ? parsed.activeCategory
          : DEFAULT_PREFS.activeCategory,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function saveDevicePrefs(prefs: DevicePrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* localStorage quota / disabled — silent no-op */
  }
}

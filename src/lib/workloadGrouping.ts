// Workload app-list grouping — pure, framework-free, unit-testable.
//
// Collapses the per-workload running-app roster so an application's helper /
// launcher / backend processes show as a single row instead of several.
// Extracted from InsightsPage so it can be tested without pulling React.

import type { RunningAppRow } from "./insightsEngine";

/**
 * A collapsed app entry under a workload — one or more processes that share
 * the same friendly name (e.g. "Spotify" + "SpotifyLauncher", or "Docker
 * Desktop" + its backend) folded into a single row. `names` holds every
 * member exe name so a recategorize action can be applied to all of them.
 */
export interface AppGroup {
  key: string;            // lowercased grouping key
  label: string;          // friendly name shown to the user
  names: string[];        // member exe names
  cpuPercent: number;     // summed across members
  memoryMb: number;       // summed across members
  isBackground: boolean;  // true only when every member is a background app
}

/** Prettify a raw exe name for display when no version info is available. */
export function prettifyExeName(name: string): string {
  const stem = name.replace(/\.exe$/i, "");
  return stem.length > 0 ? stem.charAt(0).toUpperCase() + stem.slice(1) : name;
}

/**
 * Collapse a list of running-app rows into groups keyed by friendly name, so
 * an application's helper / launcher / backend processes show as one row
 * instead of several. Sorted heaviest-first (same weighting as the roster).
 */
export function groupRunningApps(rows: RunningAppRow[]): AppGroup[] {
  const byKey = new Map<string, AppGroup>();
  for (const r of rows) {
    const label = r.displayName || prettifyExeName(r.name);
    const key = label.toLowerCase();
    let g = byKey.get(key);
    if (!g) {
      g = { key, label, names: [], cpuPercent: 0, memoryMb: 0, isBackground: true };
      byKey.set(key, g);
    }
    g.names.push(r.name);
    g.cpuPercent += r.cpuPercent;
    g.memoryMb += r.memoryMb;
    if (!r.isBackground) g.isBackground = false;
  }
  return [...byKey.values()].sort(
    (a, b) => (b.cpuPercent + b.memoryMb / 500) - (a.cpuPercent + a.memoryMb / 500),
  );
}

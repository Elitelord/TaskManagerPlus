/**
 * Tracks when the main window is hidden to the system tray (vs open on screen).
 * Used to throttle monitoring and skip per-tick React updates while still feeding
 * the insights engine so desktop notifications keep working.
 */

let mainTrayHidden = false;
const listeners = new Set<() => void>();

export function getMainTrayHidden(): boolean {
  return mainTrayHidden;
}

export function setMainTrayHidden(hidden: boolean): void {
  if (mainTrayHidden === hidden) return;
  mainTrayHidden = hidden;
  for (const fn of listeners) fn();
}

export function subscribeMainTrayHidden(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

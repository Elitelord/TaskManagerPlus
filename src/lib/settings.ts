import { useState, useEffect, useCallback } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

export type GraphSize = "small" | "medium" | "large";

export interface AppSettings {
  theme: "dark" | "light";
  accentColor: string;
  refreshRate: number; // ms
  /** Column ids hidden in the process table. Also hides the matching sidebar
   *  resource row — one toggle affects both places. */
  hiddenColumns: string[];
  showBattery: boolean; // show battery in sidebar (desktop PCs don't have one)
  showGpu: boolean; // show GPU in sidebar
  showNpu: boolean; // show NPU in sidebar when hardware is present
  /** Mini sparklines in the sidebar resource rows */
  showSidebarSparklines: boolean;
  minimizeToTray: boolean;
  confirmEndTask: boolean;
  graphSize: GraphSize;
  temperatureUnit: "celsius" | "fahrenheit";
  displayMode: "percent" | "values";
  /** Send desktop notifications for new critical/warning insights. */
  desktopNotifications: boolean;
  /** Minimum severity that fires a desktop notification. */
  notificationMinSeverity: "critical" | "warning" | "info";
  /** Enable OEM battery charge limit controls. Requires admin; app will prompt to relaunch elevated. */
  enableChargeLimit: boolean;
  /**
   * Manually pinned "main workload" — the workload TYPE the user considers
   * their primary use case. When set, every app classified under this workload
   * (after applying `appCategoryOverrides`) is exempt from the "high memory
   * while idle" warning, since foreground apps frequently sit at 0% CPU
   * between user input.
   *
   * Empty string = auto-detect (default — picks the highest-priority detected
   * workload). Stored as the workload type key (e.g. "development", "gaming").
   */
  mainWorkloadType: string;
  /**
   * Per-app workload category overrides. Keyed by lowercase process name
   * (e.g. "notepad.exe"), value is an ARRAY of workload types the app should
   * belong to (e.g. ["office", "communication"] for an app that is both).
   * - Empty array `[]` or missing key = auto-detect via the regex rules.
   * - Single-element array `["none"]` = exclude from every workload.
   * - Multiple types = the app appears under each listed workload's chip.
   *
   * Legacy format note: older builds stored a single string here. The migration
   * in `load()` rewrites string values to single-element arrays so existing
   * users don't lose overrides on upgrade.
   */
  appCategoryOverrides: Record<string, string[]>;
}

const DEFAULTS: AppSettings = {
  theme: "dark",
  accentColor: "#5b9cf6",
  refreshRate: 1000,
  hiddenColumns: [],
  showBattery: true,
  showGpu: true,
  showNpu: true,
  showSidebarSparklines: true,
  minimizeToTray: true,
  confirmEndTask: true,
  graphSize: "medium",
  temperatureUnit: "celsius",
  displayMode: "percent",
  desktopNotifications: true,
  notificationMinSeverity: "warning",
  enableChargeLimit: false,
  mainWorkloadType: "",
  appCategoryOverrides: {},
};

export const GRAPH_HEIGHTS: Record<GraphSize, number> = {
  small: 140,
  medium: 200,
  large: 300,
};

const STORAGE_KEY = "taskmanagerplus-settings";

function load(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const merged: AppSettings = { ...DEFAULTS, ...parsed };
      // Migrate legacy single-string overrides → single-element arrays.
      // Older builds stored Record<string, string>; if we read one of those
      // verbatim TypeScript would still typecheck (because the persisted JSON
      // has no static type) but the consumer code would call .includes / .map
      // on a plain string and crash. Normalize here at the boundary.
      if (merged.appCategoryOverrides) {
        const out: Record<string, string[]> = {};
        for (const [k, v] of Object.entries(merged.appCategoryOverrides)) {
          if (Array.isArray(v)) out[k] = v;
          else if (typeof v === "string" && v) out[k] = [v];
        }
        merged.appCategoryOverrides = out;
      }
      return merged;
    }
  } catch { /* ignore */ }
  return { ...DEFAULTS };
}

function save(settings: AppSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch { /* ignore */ }
}

// Global listeners for cross-component reactivity
type Listener = (s: AppSettings) => void;
const listeners = new Set<Listener>();
let currentSettings = load();

/** Parse #rgb / #rrggbb to RGB components. */
export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const h = hex.trim();
  const m6 = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(h);
  if (m6) {
    return { r: parseInt(m6[1], 16), g: parseInt(m6[2], 16), b: parseInt(m6[3], 16) };
  }
  const m3 = /^#?([a-f\d])([a-f\d])([a-f\d])$/i.exec(h);
  if (m3) {
    return {
      r: parseInt(m3[1] + m3[1], 16),
      g: parseInt(m3[2] + m3[2], 16),
      b: parseInt(m3[3] + m3[3], 16),
    };
  }
  return null;
}

export function hexToRgba(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return `rgba(91, 156, 246, ${alpha})`;
  return `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})`;
}

// Apply theme + accent to DOM
function applyTheme(settings: AppSettings) {
  const root = document.documentElement;
  if (settings.theme === "light") {
    root.setAttribute("data-theme", "light");
  } else {
    root.removeAttribute("data-theme");
  }

  // Sync the OS-drawn titlebar (decorations:true) with the app theme. On
  // Windows this flips the title-bar / min-max-close row to immersive dark
  // mode (or back to light), so it stops looking out-of-band against the app
  // body when the user toggles theme. Wrapped because non-Tauri test envs
  // (Vite preview, jsdom) don't have a window IPC channel.
  try {
    const win = getCurrentWebviewWindow();
    void win.setTheme(settings.theme).catch(() => { /* ignore */ });
  } catch { /* not in Tauri */ }
  const hex = settings.accentColor;
  root.style.setProperty("--accent-primary", hex);
  root.style.setProperty("--accent-blue", hex);
  root.style.setProperty("--accent", hex);

  const rgb = hexToRgb(hex);
  if (rgb) {
    const { r, g, b } = rgb;
    root.style.setProperty("--accent-primary-muted", `rgba(${r},${g},${b},0.14)`);
    root.style.setProperty("--accent-primary-subtle", `rgba(${r},${g},${b},0.08)`);
    root.style.setProperty("--accent-primary-strong", `rgba(${r},${g},${b},0.22)`);
    root.style.setProperty("--accent-border", `rgba(${r},${g},${b},0.32)`);
    root.style.setProperty("--accent-focus-ring", `rgba(${r},${g},${b},0.28)`);
  }
}

// Initialize on load
applyTheme(currentSettings);

export function getSettings(): AppSettings {
  return currentSettings;
}

export function updateSettings(partial: Partial<AppSettings>) {
  currentSettings = { ...currentSettings, ...partial };
  save(currentSettings);
  applyTheme(currentSettings);
  listeners.forEach(fn => fn(currentSettings));
}

export function useSettings(): [AppSettings, (partial: Partial<AppSettings>) => void] {
  const [settings, setSettings] = useState<AppSettings>(currentSettings);

  useEffect(() => {
    const handler: Listener = (s) => setSettings({ ...s });
    listeners.add(handler);
    return () => { listeners.delete(handler); };
  }, []);

  const update = useCallback((partial: Partial<AppSettings>) => {
    updateSettings(partial);
  }, []);

  return [settings, update];
}

// All available process table columns
export const ALL_COLUMNS = [
  { id: "name", label: "Name", alwaysVisible: true },
  { id: "cpu", label: "CPU %" },
  { id: "memory", label: "Memory" },
  { id: "disk", label: "Disk I/O" },
  { id: "network", label: "Network" },
  { id: "gpu", label: "GPU %" },
  { id: "npu", label: "NPU %" },
  { id: "battery", label: "Power (W)" },
] as const;

// Accent color presets
export const ACCENT_PRESETS = [
  { label: "Blue", value: "#5b9cf6" },
  { label: "Green", value: "#45d483" },
  { label: "Purple", value: "#a78bfa" },
  { label: "Orange", value: "#f5a524" },
  { label: "Red", value: "#ef5350" },
  { label: "Cyan", value: "#22d3ee" },
  { label: "Pink", value: "#f472b6" },
  { label: "Yellow", value: "#ffd600" },
] as const;

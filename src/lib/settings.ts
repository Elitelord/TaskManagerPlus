import { useState, useEffect, useCallback } from "react";

export type GraphSize = "small" | "medium" | "large";

export interface AppSettings {
  theme: "dark" | "light";
  accentColor: string;
  refreshRate: number; // ms
  hiddenColumns: string[]; // columns hidden in process table
  showBattery: boolean; // show battery in sidebar (desktop PCs don't have one)
  showGpu: boolean; // show GPU in sidebar
  minimizeToTray: boolean;
  confirmEndTask: boolean;
  graphSize: GraphSize;
  temperatureUnit: "celsius" | "fahrenheit";
  displayMode: "percent" | "values";
}

const DEFAULTS: AppSettings = {
  theme: "dark",
  accentColor: "#5b9cf6",
  refreshRate: 1000,
  hiddenColumns: [],
  showBattery: true,
  showGpu: true,
  minimizeToTray: true,
  confirmEndTask: true,
  graphSize: "medium",
  temperatureUnit: "celsius",
  displayMode: "percent",
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
      return { ...DEFAULTS, ...parsed };
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

// Apply theme + accent to DOM
function applyTheme(settings: AppSettings) {
  const root = document.documentElement;
  if (settings.theme === "light") {
    root.setAttribute("data-theme", "light");
  } else {
    root.removeAttribute("data-theme");
  }
  // Override the primary accent color used throughout the app
  root.style.setProperty("--accent-blue", settings.accentColor);
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

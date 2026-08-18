import { useState, useEffect, useCallback } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { AiTier } from "./ai/types";
import { invalidatePalette } from "./seriesPalette";

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
  /** Show the Startup page + nav item. When off, the page is hidden and its
   *  background work (startup enumeration, WDI impact, logon-task/WMI scans,
   *  and the startup insight detectors) stops running entirely. */
  showStartup: boolean;
  /** Mini sparklines in the sidebar resource rows */
  showSidebarSparklines: boolean;
  minimizeToTray: boolean;
  confirmEndTask: boolean;
  /** Confirm before disabling a startup application. */
  confirmBeforeDisableStartup: boolean;
  graphSize: GraphSize;
  temperatureUnit: "celsius" | "fahrenheit";
  displayMode: "percent" | "values";
  /** Send desktop notifications for new critical/warning insights. */
  desktopNotifications: boolean;
  /** Minimum severity that fires a desktop notification. */
  notificationMinSeverity: "critical" | "warning" | "info";
  /**
   * Surface a "large download in progress" insight with speed-optimization
   * suggestions when a sustained, disk-backed download is detected. Defaults
   * on; turn off to suppress the detector entirely (it stops running, not
   * just rendering).
   */
  downloadAssist: boolean;
  /** Enable OEM battery charge limit controls. Requires admin; app will prompt to relaunch elevated. */
  enableChargeLimit: boolean;
  /** Enable ASUS OEM fan RPM telemetry (read-only WMI). */
  enableOemPerformance: boolean;
  /**
   * Enable the WMI fan-sensor fallback (LibreHardwareMonitor /
   * OpenHardwareMonitor / Win32_Fan). Defaults OFF: on machines without such a
   * sensor these probes are pure waste (three failed WMI connects per sample).
   * The GPU-driver-reported fan (D3DKMT) is always on regardless of this. Turn
   * on only if you run a sensor app like LibreHardwareMonitor.
   */
  fanSensorEnabled: boolean;
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
  /**
   * Local AI feature tier — governs the semantic embedding model only.
   *   off      — no embedding model (default).
   *   standard — a small embedding model (~30–50 MB).
   *   enhanced — a larger embedding model (~110–160 MB, downloaded first use).
   *
   * The bundled leak classifier runs at every tier — it is not gated. The
   * retired "lite" tier migrates to "off" on load (see `load()`).
   *
   * No data ever leaves the device regardless of tier. The only network
   * call AI ever makes is the one-time Enhanced model file download
   * from GitHub release assets. See README's Privacy section.
   */
  aiTier: AiTier;
  /**
   * Y2-A — show the MCP integration card in Settings and surface the
   * sidecar's launch instructions to the user. The MCP sidecar
   * (`tmp_mcp.exe`) is always present on disk regardless of this flag —
   * it's a separate binary that an MCP client launches directly, not a
   * background service we start or stop. This toggle controls
   * *discoverability* + *consent*: the connection snippets only appear
   * after the user explicitly opts in, signalling they understand that
   * an MCP client will receive read-only TaskManagerPlus telemetry.
   *
   * Defaults off so the feature doesn't surprise people on first launch.
   * Privacy copy on the card spells out the data boundary.
   */
  mcpEnabled: boolean;
  /**
   * Y1-A — preferred backend for the generative model (smart rename,
   * file summaries, folder naming, "what's in this folder").
   *   "auto"   — use GPU/Vulkan when the DLL bundle is installed, CPU otherwise
   *   "cpu"    — never use GPU even if the bundle is installed
   *   "vulkan" — force GPU; falls back to CPU if init fails or DLLs missing
   *
   * Resolved per-process at first inference call; the active backend is
   * sticky until restart (matches how the CPU model load is sticky
   * today). Defaults to "auto" so users on machines without the Vulkan
   * bundle keep the existing CPU path with zero configuration.
   */
  genlmBackend: "auto" | "cpu" | "vulkan" | "ollama";
  /**
   * Z3 — BYO Ollama endpoint + model. Only consulted when
   * `genlmBackend === "ollama"`. Defaults point at a stock local
   * Ollama install (loopback :11434) with no model selected, forcing
   * the user to pick one before generation runs.
   */
  ollamaBaseUrl: string;
  ollamaModel: string;
  /**
   * Z4 — preferred backend for the embedding model (used by file
   * intent search, scan-based clustering, the find_files_by_intent
   * MCP tool, etc.). Distinct from the *generative* backend —
   * embeddings run a tiny ONNX model and the dispatcher choice is
   * independent.
   *   "cpu"      — pure-Rust tract on CPU (default, no extra install)
   *   "directml" — ORT runtime on the GPU via DirectML EP; requires
   *                the ORT runtime bundle to be downloaded first.
   */
  embedderBackend: "cpu" | "directml";
  /**
   * Crash detection (Phase 1). Two high-water marks keyed by incident
   * timestamp (epoch ms), so each unexpected shutdown only surfaces once:
   *   - `lastAcknowledgedCrashMs` gates the Insights crash card. The card
   *     shows only when the newest incident is newer than this; "Dismiss"
   *     advances it to that incident's time.
   *   - `lastNotifiedCrashMs` gates the one-shot desktop notification, kept
   *     separate so the toast fires when a crash is first detected even
   *     before the user dismisses (or ever opens) the card.
   * Both default to 0 (no crash seen yet).
   */
  lastAcknowledgedCrashMs: number;
  lastNotifiedCrashMs: number;
  /**
   * Update Helper — dismiss high-water-mark for the persistent "System &
   * driver health" card. Stores the health signature at dismiss time; the card
   * re-appears only when the signature changes (a key driver goes stale, a
   * stale one gets updated). Empty = never dismissed.
   */
  healthCardDismissed: string;
  /**
   * Update Helper — run the periodic Windows Update scan (read-only count of
   * pending updates via the Windows Update Agent). Surfaces an "updates
   * available" card when you're behind. Default on; turn off to stop the scan
   * entirely (it hits Microsoft's update servers, like Windows Update itself).
   */
  windowsUpdateScan: boolean;
  /** Dismiss high-water-mark for the "updates available" card (pending counts). */
  updatesCardDismissed: string;
}

const DEFAULTS: AppSettings = {
  theme: "dark",
  accentColor: "#5b9cf6",
  refreshRate: 1000,
  hiddenColumns: [],
  showBattery: true,
  showGpu: true,
  showNpu: true,
  showStartup: true,
  showSidebarSparklines: true,
  minimizeToTray: true,
  confirmEndTask: true,
  confirmBeforeDisableStartup: true,
  graphSize: "medium",
  temperatureUnit: "celsius",
  displayMode: "percent",
  desktopNotifications: true,
  notificationMinSeverity: "warning",
  downloadAssist: true,
  enableChargeLimit: false,
  enableOemPerformance: false,
  fanSensorEnabled: false,
  mainWorkloadType: "",
  appCategoryOverrides: {},
  aiTier: "off",
  mcpEnabled: false,
  genlmBackend: "auto",
  ollamaBaseUrl: "http://localhost:11434",
  ollamaModel: "",
  embedderBackend: "cpu",
  lastAcknowledgedCrashMs: 0,
  lastNotifiedCrashMs: 0,
  healthCardDismissed: "",
  windowsUpdateScan: true,
  updatesCardDismissed: "",
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
      // Migrate the retired "lite" AI tier (shipped in v1.5.0). The leak
      // classifier it used to gate now runs at every tier, so a Lite user
      // wanted nothing the embedding tiers add — they map cleanly to "off".
      if ((merged.aiTier as string) === "lite") merged.aiTier = "off";
      // Migrate the short-lived standalone generative toggle (Phase 5 early
      // build) into the "enhanced" tier, which now means embeddings + the
      // generative model. If a user had it on, give them Enhanced.
      if ((parsed as { aiGenerative?: boolean }).aiGenerative === true
          && merged.aiTier !== "enhanced") {
        merged.aiTier = "enhanced";
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

// Push the saved AI tier to the Rust backend so the in-memory state on both
// sides starts in sync. Fire-and-forget — non-Tauri environments (Vite
// preview, jsdom tests) won't have the command available and we just skip.
// We import lazily so this module's import graph doesn't pull the AI API
// when consumers (e.g. tray code) don't need it.
function pushAiTierToBackend(tier: AppSettings["aiTier"]) {
  void import("./ai/api")
    .then(async (m) => {
      await m.aiSetTier(tier);
      // Pre-warm the embedder when the tier is on so the first user
      // search after app launch (or Off→Standard switch) doesn't pay the
      // 2-5 second cold model-load cost while holding the embedder
      // mutex (which would otherwise reject any concurrent search with
      // EMBEDDER_BUSY). Fire-and-forget; no-op if model isn't installed.
      // These two are awaited in sequence, never fired together. Each lands on
      // its own `spawn_blocking` thread, and on the Enhanced tier with GPU
      // acceleration on they bring up two different GPU runtimes — DirectML
      // (D3D12) for the embedder, Vulkan for the generative model. Starting
      // both at once on the same adapter crashed the process with
      // STATUS_ACCESS_VIOLATION moments after both reported success. The Rust
      // side now enforces this with `ai::GPU_INIT_LOCK`; sequencing here means
      // we don't park a blocking thread on that lock just to wait.
      if (tier !== "off") {
        // model not installed yet — fine
        await m.aiPrewarmEmbedder().catch(() => {});
      }
      // Enhanced also loads the generative model — warm it so the first
      // smart-rename isn't cold-load slow. No-op if it isn't installed yet.
      if (tier === "enhanced") {
        await m.aiPrewarmGenlm().catch(() => {});
      }
    })
    .catch(() => { /* not in Tauri or backend not ready — ignore */ });
}
// Y1-A — keep the Rust dispatcher's backend preference in sync with the
// persisted UI choice. Same lazy-import pattern as the tier push so the
// settings module doesn't yank the AI API into unrelated consumers.
function pushGenlmBackendToBackend(backend: AppSettings["genlmBackend"]) {
  void import("./ai/api")
    .then((m) => m.aiSetGenlmBackend(backend))
    .catch(() => { /* not in Tauri or backend not ready — ignore */ });
}
pushGenlmBackendToBackend(currentSettings.genlmBackend);

// Z3 — sync the persisted Ollama config to the Rust backend at startup
// so a user who set it last session doesn't need to re-enter on every
// launch. The backend's static stays at defaults until this push lands.
function pushOllamaConfigToBackend(url: string, model: string) {
  if (!url || !(url.startsWith("http://") || url.startsWith("https://"))) {
    // Avoid surfacing a backend validation error at startup for a
    // legitimately-empty default; the user will configure it via the
    // Settings card before they ever flip the radio to Ollama.
    return;
  }
  void import("./ai/api")
    .then((m) => m.aiSetOllamaConfig(url, model))
    .catch(() => { /* not in Tauri or backend not ready — ignore */ });
}
pushOllamaConfigToBackend(currentSettings.ollamaBaseUrl, currentSettings.ollamaModel);

// Z4 — same lazy-import pattern for the embedder backend. Keeps the
// Rust dispatcher's preference in sync with the persisted UI choice
// so a first-launch embed runs through whatever the user last picked.
function pushEmbedderBackendToBackend(backend: AppSettings["embedderBackend"]) {
  void import("./ai/api")
    .then((m) => m.aiSetEmbedderBackend(backend))
    .catch(() => { /* not in Tauri or backend not ready — ignore */ });
}
pushEmbedderBackendToBackend(currentSettings.embedderBackend);

// Sync the WMI fan-sensor toggle to the native DLL. The DLL defaults it OFF, so
// this startup push only matters for users who opted in — but we push
// unconditionally so both sides stay in lockstep regardless of value. Lazy
// import of ipc keeps non-Tauri consumers (tray, tests) from pulling it in.
function pushFanSensorEnabledToBackend(enabled: boolean) {
  void import("./ipc")
    .then((m) => m.setFanSensorEnabled(enabled))
    .catch(() => { /* not in Tauri or backend not ready — ignore */ });
}
pushFanSensorEnabledToBackend(currentSettings.fanSensorEnabled);

// Z4 — push the AI tier LAST so the prewarm it triggers runs against
// the just-pushed backend prefs. Previously this fired first and
// raced: prewarm loaded the embedder with the default Cpu preference,
// then the embedder-backend push cleared ACTIVE_EMBEDDER back to
// None, leaving the UI stuck at "Running on: not yet loaded" because
// nothing re-triggered an embed. Same ordering hazard exists for
// genlm (set_backend_preference clears ACTIVE), but Smart Rename /
// summary calls always re-evaluate via pick_backend, so it stays
// hidden there. Order matters here even if it didn't before.
pushAiTierToBackend(currentSettings.aiTier);

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

  // Chart code caches resolved token values (getComputedStyle is too costly to
  // call inside a draw loop). This is the only place theme or accent changes,
  // so it owns the invalidation.
  invalidatePalette();
}

// Initialize on load
applyTheme(currentSettings);

export function getSettings(): AppSettings {
  return currentSettings;
}

export function updateSettings(partial: Partial<AppSettings>) {
  const prevAiTier = currentSettings.aiTier;
  const prevGenlmBackend = currentSettings.genlmBackend;
  const prevOllamaUrl = currentSettings.ollamaBaseUrl;
  const prevOllamaModel = currentSettings.ollamaModel;
  const prevEmbedderBackend = currentSettings.embedderBackend;
  const prevFanSensorEnabled = currentSettings.fanSensorEnabled;
  currentSettings = { ...currentSettings, ...partial };
  save(currentSettings);
  applyTheme(currentSettings);
  // Tier change pushes to the backend AND warms the right models (embedder
  // for Standard/Enhanced, generative for Enhanced) — see pushAiTierToBackend.
  if (partial.aiTier && partial.aiTier !== prevAiTier) {
    pushAiTierToBackend(currentSettings.aiTier);
  }
  // Y1-A — propagate the GPU/CPU preference. The backend caches the
  // active backend after first inference, so subsequent flips require a
  // restart to take effect (matches the existing model-load caching).
  if (partial.genlmBackend && partial.genlmBackend !== prevGenlmBackend) {
    pushGenlmBackendToBackend(currentSettings.genlmBackend);
  }
  // Z3 — propagate Ollama config changes. We push on either field
  // changing so the user can flip URL alone (reuses the same model)
  // or model alone (reuses the same URL).
  if (
    (partial.ollamaBaseUrl !== undefined && partial.ollamaBaseUrl !== prevOllamaUrl)
    || (partial.ollamaModel !== undefined && partial.ollamaModel !== prevOllamaModel)
  ) {
    pushOllamaConfigToBackend(currentSettings.ollamaBaseUrl, currentSettings.ollamaModel);
  }
  // Z4 — embedder backend toggle.
  if (partial.embedderBackend && partial.embedderBackend !== prevEmbedderBackend) {
    pushEmbedderBackendToBackend(currentSettings.embedderBackend);
  }
  // WMI fan-sensor toggle — pushes the gate into the native DLL. Off->on there
  // also re-runs source discovery, so flipping this on picks up a sensor app
  // the user just launched.
  if (
    partial.fanSensorEnabled !== undefined
    && partial.fanSensorEnabled !== prevFanSensorEnabled
  ) {
    pushFanSensorEnabledToBackend(currentSettings.fanSensorEnabled);
  }
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

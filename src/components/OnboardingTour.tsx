import { useEffect, useState } from "react";
import {
  Sparkles,
  Lightbulb,
  Battery,
  MonitorSmartphone,
  Cpu,
  HardDrive,
  ListOrdered,
  Sun,
  Moon,
  Bell,
  ChevronRight,
  ChevronLeft,
  Check,
} from "lucide-react";
import { useSettings, ACCENT_PRESETS } from "../lib/settings";

/**
 * First-run onboarding tour.
 *
 * Two kinds of step:
 *   - "modal" — full-screen backdrop, centred dialog. Used for content that
 *     doesn't relate to a specific page (welcome, personalize, background
 *     behaviour, done).
 *   - "spotlight" — small floating panel anchored to the bottom of the
 *     viewport with a soft backdrop. The page behind it stays fully
 *     interactive-looking, and the tour navigates the app to the relevant
 *     page on entry. This is the "actually take the user to each page"
 *     behaviour — the previous version just listed the pages in a modal,
 *     which a user could blow past without realising it was a tour.
 *
 * Renders only on first launch (gated by `taskmanagerplus-onboarding-completed`
 * in localStorage). Triggered again from Settings → Behavior → "Show tour
 * again" via the exported `reopenOnboarding()` helper, which clears the flag
 * and dispatches a window event the mounted instance listens for.
 */

const ONBOARDING_STORAGE_KEY = "taskmanagerplus-onboarding-completed";
const ONBOARDING_REOPEN_EVENT = "taskmanagerplus:onboarding-reopen";

export function reopenOnboarding() {
  try {
    localStorage.removeItem(ONBOARDING_STORAGE_KEY);
  } catch { /* ignore */ }
  try {
    window.dispatchEvent(new CustomEvent(ONBOARDING_REOPEN_EVENT));
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Step descriptors
// ---------------------------------------------------------------------------

interface SpotlightStep {
  kind: "spotlight";
  /** Sidebar tab id to navigate to when this step becomes active. */
  tabId: string;
  icon: React.ReactNode;
  title: string;
  desc: string;
  callout?: string;
}

interface ModalStep {
  kind: "modal";
  /** Renderer for modal-style steps (custom layout per step). */
  render: () => React.ReactNode;
}

type Step = SpotlightStep | ModalStep;

interface OnboardingTourProps {
  /** Wired to the App-level `setActiveTab` so spotlight steps can move the
   *  user between pages. Optional so the component can still mount in tests
   *  / preview environments without the real router. */
  onNavigate?: (tabId: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function OnboardingTour({ onNavigate }: OnboardingTourProps = {}) {
  const [settings, updateSettings] = useSettings();
  const [open, setOpen] = useState<boolean | null>(null);
  const [step, setStep] = useState(0);

  useEffect(() => {
    try {
      const seen = localStorage.getItem(ONBOARDING_STORAGE_KEY);
      setOpen(seen !== "1");
    } catch {
      setOpen(false);
    }
    const onReopen = () => {
      setStep(0);
      setOpen(true);
    };
    window.addEventListener(ONBOARDING_REOPEN_EVENT, onReopen);
    return () => window.removeEventListener(ONBOARDING_REOPEN_EVENT, onReopen);
  }, []);

  const finish = () => {
    try {
      localStorage.setItem(ONBOARDING_STORAGE_KEY, "1");
    } catch { /* ignore */ }
    setOpen(false);
  };

  // Build the step list inside the render so the modal-step closures see
  // the latest `settings` / `updateSettings` from the hook.
  const steps: Step[] = [
    // ── 0 — Welcome ────────────────────────────────────────────
    {
      kind: "modal",
      render: () => (
        <>
          <div className="onboarding-hero">
            <Sparkles size={28} className="onboarding-hero-icon" />
            <h2 className="onboarding-title">Welcome to TaskManager+</h2>
            <p className="onboarding-subtitle">
              A modern Windows task manager with insights, devices, and per-process power tracking.
              The next few steps will walk you through the main views and let you set a couple of preferences.
            </p>
          </div>
          <ul className="onboarding-bullets">
            <li>
              <span className="onboarding-bullet-mark">•</span>
              <span>Live CPU / GPU / RAM / disk / network graphs with per-process top consumers</span>
            </li>
            <li>
              <span className="onboarding-bullet-mark">•</span>
              <span>Per-process battery draw, charge ETAs, and OEM thermal / fan controls</span>
            </li>
            <li>
              <span className="onboarding-bullet-mark">•</span>
              <span>Insights engine that learns your routine and surfaces issues before they bite</span>
            </li>
          </ul>
        </>
      ),
    },

    // ── 1 — Processes (spotlight) ──────────────────────────────
    {
      kind: "spotlight",
      tabId: "processes",
      icon: <ListOrdered size={16} />,
      title: "Processes",
      desc: "Every running process on the system. Sortable by CPU, memory, network, GPU, NPU, or estimated power draw. Right-click a row to end the task or set its priority.",
      callout: "This is the default landing view.",
    },

    // ── 2 — Resource pages (spotlight, CPU as example) ─────────
    {
      kind: "spotlight",
      tabId: "cpu",
      icon: <Cpu size={16} />,
      title: "Resource pages",
      desc: "Click any resource in the sidebar — CPU, GPU, NPU, Memory, Disk, Network, Battery — for live graphs, per-core breakdown, top consumers, and silicon-level specs. CPU is shown as an example.",
    },

    // ── 3 — Insights (spotlight) ───────────────────────────────
    {
      kind: "spotlight",
      tabId: "insights",
      icon: <Lightbulb size={16} />,
      title: "Insights",
      desc: "The brain. System-health gauge, detected workloads (gaming / dev / streaming / …), learned daily schedule, and proactive cards when something needs attention. Comes alive after a few hours of observation.",
    },

    // ── 4 — Devices (spotlight) ────────────────────────────────
    {
      kind: "spotlight",
      tabId: "devices",
      icon: <MonitorSmartphone size={16} />,
      title: "Devices",
      desc: "Bluetooth + USB unified into one categorised, searchable list. Disconnect Bluetooth devices in-app, jump to Windows settings, see VID/PID for every USB device.",
    },

    // ── 5 — Storage (spotlight) ────────────────────────────────
    {
      kind: "spotlight",
      tabId: "storage",
      icon: <HardDrive size={16} />,
      title: "Storage & Smart Organizer",
      desc: "Per-volume health and a Smart Organizer that finds true duplicate files and dead build artifacts (node_modules, .next, target, …) — the kind of cleanup that knows the difference between cache and your code. Turn on AI in Settings, then press Ctrl+K anywhere to search your files by content — \"meeting recordings\", \"old installers\", \"lecture notes\" — all matched right on your device.",
    },

    // ── 6 — Battery (spotlight) ────────────────────────────────
    {
      kind: "spotlight",
      tabId: "battery",
      icon: <Battery size={16} />,
      title: "Battery",
      desc: "Per-process power draw, charging vs system-draw breakdown, time-to-full / time-to-empty ETAs, and battery health (cycle count, design vs current capacity).",
    },

    // ── 6 — Personalize (modal) ────────────────────────────────
    {
      kind: "modal",
      render: () => (
        <>
          <h2 className="onboarding-title">Make it yours</h2>
          <p className="onboarding-subtitle">
            All of this lives in Settings — change it any time.
          </p>

          <div className="onboarding-section">
            <label className="onboarding-section-label">Accent colour</label>
            <div className="onboarding-accent-row">
              {ACCENT_PRESETS.map(preset => (
                <button
                  key={preset.value}
                  type="button"
                  className={
                    "onboarding-accent-swatch"
                    + (settings.accentColor === preset.value ? " is-selected" : "")
                  }
                  style={{ background: preset.value }}
                  onClick={() => updateSettings({ accentColor: preset.value })}
                  title={preset.label}
                  aria-label={`${preset.label}${settings.accentColor === preset.value ? " (selected)" : ""}`}
                >
                  {settings.accentColor === preset.value && <Check size={14} />}
                </button>
              ))}
            </div>
          </div>

          <div className="onboarding-section onboarding-section--two-col">
            <div>
              <label className="onboarding-section-label">Theme</label>
              <div className="onboarding-segmented">
                <button
                  type="button"
                  className={"onboarding-segmented-btn" + (settings.theme === "dark" ? " is-active" : "")}
                  onClick={() => updateSettings({ theme: "dark" })}
                >
                  <Moon size={13} /> Dark
                </button>
                <button
                  type="button"
                  className={"onboarding-segmented-btn" + (settings.theme === "light" ? " is-active" : "")}
                  onClick={() => updateSettings({ theme: "light" })}
                >
                  <Sun size={13} /> Light
                </button>
              </div>
            </div>
            <div>
              <label className="onboarding-section-label">Temperature</label>
              <div className="onboarding-segmented">
                <button
                  type="button"
                  className={"onboarding-segmented-btn" + (settings.temperatureUnit === "celsius" ? " is-active" : "")}
                  onClick={() => updateSettings({ temperatureUnit: "celsius" })}
                >
                  °C
                </button>
                <button
                  type="button"
                  className={"onboarding-segmented-btn" + (settings.temperatureUnit === "fahrenheit" ? " is-active" : "")}
                  onClick={() => updateSettings({ temperatureUnit: "fahrenheit" })}
                >
                  °F
                </button>
              </div>
            </div>
          </div>
        </>
      ),
    },

    // ── 7 — Background (modal) ─────────────────────────────────
    {
      kind: "modal",
      render: () => (
        <>
          <h2 className="onboarding-title">Background behaviour</h2>
          <p className="onboarding-subtitle">
            TaskManager+ keeps watching even when the window is closed, so insights stay current and notifications can fire.
          </p>

          <label className="onboarding-toggle-row">
            <div className="onboarding-toggle-text">
              <span className="onboarding-toggle-title">
                <MonitorSmartphone size={14} /> Minimise to system tray
              </span>
              <span className="onboarding-toggle-desc">
                Closing the window hides it instead of quitting. Right-click the tray icon to fully exit.
              </span>
            </div>
            <input
              type="checkbox"
              className="onboarding-toggle-checkbox"
              checked={settings.minimizeToTray}
              onChange={e => updateSettings({ minimizeToTray: e.target.checked })}
            />
          </label>

          <label className="onboarding-toggle-row">
            <div className="onboarding-toggle-text">
              <span className="onboarding-toggle-title">
                <Bell size={14} /> Desktop notifications for insights
              </span>
              <span className="onboarding-toggle-desc">
                Gentle pings when the engine spots something worth your attention. Severity threshold and per-category mutes live in Settings.
              </span>
            </div>
            <input
              type="checkbox"
              className="onboarding-toggle-checkbox"
              checked={settings.desktopNotifications}
              onChange={e => updateSettings({ desktopNotifications: e.target.checked })}
            />
          </label>
        </>
      ),
    },

    // ── 8 — Done (modal) ───────────────────────────────────────
    {
      kind: "modal",
      render: () => (
        <div className="onboarding-hero">
          <div className="onboarding-done-mark" style={{ background: settings.accentColor }}>
            <Check size={28} strokeWidth={3} />
          </div>
          <h2 className="onboarding-title">You're all set</h2>
          <p className="onboarding-subtitle">
            Everything's tweakable later from Settings (you can replay this tour from Settings → Behavior).
            Have a look around — and check Insights after the app's been running a few hours, that's where it gets fun.
          </p>
        </div>
      ),
    },
  ];

  const totalSteps = steps.length;
  const next = () => (step >= totalSteps - 1 ? finish() : setStep(s => s + 1));
  const back = () => setStep(s => Math.max(0, s - 1));
  const current = steps[step];

  // Spotlight steps: navigate the app to the relevant page on entry.
  // Runs every time the step index changes, so backing into a spotlight
  // step also re-routes correctly.
  useEffect(() => {
    if (open !== true) return;
    if (current?.kind === "spotlight" && onNavigate) {
      onNavigate(current.tabId);
    }
  }, [step, open, current, onNavigate]);

  if (open !== true) return null;

  // ── Stepper + footer (shared between modal and spotlight) ────────────────
  const Stepper = (
    <div className="onboarding-stepper-row">
      <span className="onboarding-stepper-label">Step {step + 1} of {totalSteps}</span>
      <div className="onboarding-stepper" aria-label="Tour progress">
        {Array.from({ length: totalSteps }).map((_, i) => (
          <button
            key={i}
            type="button"
            disabled={i > step}
            className={
              "onboarding-stepper-dot"
              + (i === step ? " is-current" : "")
              + (i < step ? " is-done" : "")
            }
            onClick={() => i <= step && setStep(i)}
            aria-label={`Step ${i + 1}`}
          />
        ))}
      </div>
    </div>
  );

  const Footer = (
    <div className="onboarding-footer">
      <button type="button" className="onboarding-btn onboarding-btn--ghost" onClick={finish}>
        Skip tour
      </button>
      <div className="onboarding-footer-right">
        {step > 0 && (
          <button type="button" className="onboarding-btn onboarding-btn--secondary" onClick={back}>
            <ChevronLeft size={14} /> Back
          </button>
        )}
        <button type="button" className="onboarding-btn onboarding-btn--primary" onClick={next}>
          {step === 0
            ? "Get started"
            : step === totalSteps - 1
              ? "Start using TaskManager+"
              : "Next"}
          {step === totalSteps - 1 ? <Check size={14} /> : <ChevronRight size={14} />}
        </button>
      </div>
    </div>
  );

  // ── Render — modal vs spotlight ─────────────────────────────────────────
  if (current.kind === "modal") {
    return (
      <div
        className="onboarding-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
      >
        <div className="onboarding-dialog">
          {Stepper}
          <div className="onboarding-step">
            {current.render()}
            {Footer}
          </div>
        </div>
      </div>
    );
  }

  // Spotlight: small bottom-anchored panel, lighter backdrop. Page behind
  // is dimmed but still visible — that's the whole point (the user can
  // see what we're describing).
  return (
    <div className="onboarding-spotlight-overlay" role="dialog" aria-modal="false">
      <div className="onboarding-spotlight-panel">
        <div className="onboarding-spotlight-header">
          <span className="onboarding-spotlight-icon" style={{ color: settings.accentColor }}>
            {current.icon}
          </span>
          <div className="onboarding-spotlight-titles">
            <span className="onboarding-spotlight-title">{current.title}</span>
            {current.callout && (
              <span className="onboarding-spotlight-callout">{current.callout}</span>
            )}
          </div>
          <span className="onboarding-spotlight-step">{step + 1} / {totalSteps}</span>
        </div>
        <p className="onboarding-spotlight-desc">{current.desc}</p>
        <div className="onboarding-spotlight-progress">
          {steps.map((_, i) => (
            <span
              key={i}
              className={
                "onboarding-spotlight-progress-dot"
                + (i === step ? " is-current" : "")
                + (i < step ? " is-done" : "")
              }
            />
          ))}
        </div>
        {Footer}
      </div>
    </div>
  );
}

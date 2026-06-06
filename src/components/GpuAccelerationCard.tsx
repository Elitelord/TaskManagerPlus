// Y1-A — Settings card for GPU acceleration of the generative LM
// (smart rename, file summaries, folder naming, "what's in this
// folder"). Wraps three concerns:
//   1. The user's backend preference (Auto / CPU / Vulkan) which
//      flows through to `genlm::set_backend_preference()` on the Rust
//      side and decides which path the dispatcher routes new
//      generations through.
//   2. The Vulkan DLL bundle install state. The bundle (~63 MB, six
//      prebuilt llama.cpp DLLs) downloads on demand via the existing
//      `aiDownloadModel` flow; without it, the dispatcher silently
//      stays on CPU even when "Auto" or "Vulkan" is selected.
//   3. Active-backend feedback. After the first inference the
//      dispatcher's choice is sticky, so the card surfaces "Running
//      on: GPU" / "Running on: CPU" so users can confirm the toggle
//      actually took effect (it won't until next app restart if a
//      session has already loaded a model).
//
// Lives next to McpServerCard in SettingsPage's AI section.

import { useEffect, useMemo, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { useSettings } from "../lib/settings";
import {
  aiDownloadModel,
  aiDeleteModel,
  aiGenlmRuntimeStatus,
  aiModelStatus,
  aiTestOllama,
  type GenlmRuntimeStatus,
  type ModelStatus,
} from "../lib/ai/api";

const BUNDLE_ID = "llama-vulkan-b9433";

type ProgressPayload = {
  modelId: string;
  fileName: string;
  downloadedBytes: number;
  totalBytes: number;
  done: boolean;
};

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function GpuAccelerationCard() {
  const [settings, update] = useSettings();
  const [bundle, setBundle] = useState<ModelStatus | null>(null);
  const [runtime, setRuntime] = useState<GenlmRuntimeStatus | null>(null);
  const [progress, setProgress] = useState<Record<string, ProgressPayload>>({});
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Z3 — Ollama "Test connection" state. Lives in the card, not in
  // settings.ts, because it's transient feedback for the most recent
  // probe (not a setting the user wants persisted).
  type OllamaProbeState =
    | { kind: "idle" }
    | { kind: "testing" }
    | { kind: "ok"; models: string[] }
    | { kind: "error"; message: string };
  const [ollamaProbe, setOllamaProbe] = useState<OllamaProbeState>({ kind: "idle" });

  const refresh = async () => {
    try {
      const all = await aiModelStatus();
      const b = all.find((m) => m.modelId === BUNDLE_ID) ?? null;
      setBundle(b);
    } catch { /* non-Tauri or backend not ready */ }
    try {
      const r = await aiGenlmRuntimeStatus();
      setRuntime(r);
    } catch { /* same */ }
  };

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    (async () => {
      await refresh();
      try {
        // Reuse the same event channel `AiModelInstall` listens on; the
        // payload's modelId discriminates which spec a tick belongs to.
        unlisten = await listen<ProgressPayload>("ai-model-download", (event) => {
          const p = event.payload;
          if (p.modelId !== BUNDLE_ID) return;
          setProgress((prev) => ({ ...prev, [p.fileName]: p }));
          if (p.done && !cancelled) {
            // Last-file done event refreshes the install state.
            void refresh();
          }
        });
      } catch { /* no event channel in this env */ }
    })();
    // Poll runtime status so the "Running on" label updates the
    // moment the dispatcher resolves an active backend (which only
    // happens on first generation). Without this the user has to
    // navigate away and back to see the flip from "not yet loaded"
    // to "CPU" / "GPU (Vulkan)" / "Ollama".
    const interval = window.setInterval(() => {
      if (!cancelled) void refresh();
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Aggregate progress across the six DLLs. totalBytes is bundle-wide
  // when we know the full size from `bundle.sizeBytes`; per-file ticks
  // sum into `downloaded` for the rolling animation.
  const totals = useMemo(() => {
    const downloaded = Object.values(progress).reduce((a, p) => a + p.downloadedBytes, 0);
    const total = bundle?.sizeBytes ?? Object.values(progress).reduce((a, p) => a + p.totalBytes, 0);
    return { downloaded, total };
  }, [progress, bundle?.sizeBytes]);

  const pct = totals.total > 0
    ? Math.min(100, Math.round((totals.downloaded / totals.total) * 100))
    : 0;

  const onDownload = async () => {
    setError(null);
    setDownloading(true);
    setProgress({});
    try {
      await aiDownloadModel(BUNDLE_ID);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloading(false);
    }
  };

  const onDelete = async () => {
    setError(null);
    try {
      await aiDeleteModel(BUNDLE_ID);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const installed = bundle?.installed ?? false;
  const backendPref = settings.genlmBackend;
  const activeLabel = runtime?.activeBackend === "vulkan"
    ? "Running on: GPU (Vulkan)"
    : runtime?.activeBackend === "cpu"
      ? "Running on: CPU"
      : runtime?.activeBackend === "ollama"
        ? `Running on: Ollama (${settings.ollamaModel || "no model"})`
        : "Running on: not yet loaded";

  const onTestOllama = async () => {
    setOllamaProbe({ kind: "testing" });
    try {
      const result = await aiTestOllama(settings.ollamaBaseUrl);
      if (result.reachable) {
        setOllamaProbe({ kind: "ok", models: result.installedModels });
      } else {
        setOllamaProbe({
          kind: "error",
          message: result.error ?? "Unknown error",
        });
      }
    } catch (e) {
      setOllamaProbe({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <div className="info-panel">
      <h3 className="section-title">AI Writing Acceleration (GPU)</h3>
      <p className="setting-description">
        The writing model (smart rename, file summaries, folder naming)
        runs on CPU by default. With the optional GPU acceleration
        bundle installed, supported Windows GPUs run it via Vulkan —
        typically <strong>4–6× faster</strong> on real workloads.
      </p>
      <p className="setting-description setting-privacy-note">
        <strong>Privacy:</strong> the bundle is a runtime accelerator,
        not a new model. It only changes <em>where</em> the same
        local Qwen2.5-0.5B model evaluates — still 100 % on your
        device, no data leaves.
      </p>

      <div className="setting-radio-group">
        {(["auto", "cpu", "vulkan", "ollama"] as const).map((opt) => (
          <label
            key={opt}
            className={`setting-radio-row ${backendPref === opt ? "active" : ""}`}
          >
            <input
              type="radio"
              name="genlmBackend"
              value={opt}
              checked={backendPref === opt}
              onChange={() => update({ genlmBackend: opt })}
            />
            <span className="setting-label">
              {opt === "auto" && "Auto — use GPU when bundle is installed"}
              {opt === "cpu" && "CPU only"}
              {opt === "vulkan" && "Force GPU (Vulkan)"}
              {opt === "ollama" && "Use a local Ollama instance (bring your own model)"}
            </span>
          </label>
        ))}
      </div>

      {/* Z3 — Ollama config form. Only visible when the radio is on
          Ollama; we keep the inputs unmounted otherwise so the user
          doesn't see (or fill out) fields that don't apply. The "Test
          connection" button is the source of truth for whether the
          current settings work end-to-end. */}
      {backendPref === "ollama" && (
        <div
          className="settings-details-body"
          style={{
            marginTop: "0.75rem",
            padding: "0.75rem",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 6,
          }}
        >
          <p className="setting-description" style={{ margin: 0 }}>
            Point TaskManager+ at a local Ollama server. The app will
            send chat completions to that endpoint instead of running
            the bundled Qwen2.5-0.5B model. Anything you can{" "}
            <code>ollama pull</code> works — pick something that fits
            your RAM.
          </p>
          <p
            className="setting-description setting-privacy-note"
            style={{ margin: "0.5rem 0 0" }}
          >
            <strong>Privacy:</strong> requests go to the URL below.
            Loopback (<code>localhost</code>) keeps data on this
            machine — that's the default. If you point at a LAN host
            or a remote URL, that host receives your prompts.
          </p>

          <label
            className="setting-label"
            style={{ display: "block", marginTop: "0.75rem" }}
          >
            Base URL
            <input
              type="text"
              value={settings.ollamaBaseUrl}
              placeholder="http://localhost:11434"
              onChange={(e) => update({ ollamaBaseUrl: e.target.value })}
              className="setting-text-input"
              style={{ width: "100%", marginTop: "0.25rem" }}
            />
          </label>

          <label
            className="setting-label"
            style={{ display: "block", marginTop: "0.5rem" }}
          >
            Model name
            <input
              type="text"
              value={settings.ollamaModel}
              placeholder="llama3.2"
              onChange={(e) => update({ ollamaModel: e.target.value })}
              className="setting-text-input"
              style={{ width: "100%", marginTop: "0.25rem" }}
              list="ollama-model-suggestions"
            />
            {/* Datalist driven by the most recent successful probe;
                lets the user pick from what's actually installed instead
                of guessing at tag spellings. */}
            <datalist id="ollama-model-suggestions">
              {ollamaProbe.kind === "ok"
                && ollamaProbe.models.map((m) => <option key={m} value={m} />)}
            </datalist>
          </label>

          <div style={{ display: "flex", gap: 8, marginTop: "0.75rem" }}>
            <button
              type="button"
              className="copy-btn"
              onClick={onTestOllama}
              disabled={ollamaProbe.kind === "testing"}
            >
              {ollamaProbe.kind === "testing" ? "Testing…" : "Test connection"}
            </button>
          </div>

          {ollamaProbe.kind === "ok" && (
            <p
              className="setting-description"
              style={{ marginTop: "0.5rem", color: "var(--accent-primary)" }}
            >
              ✓ Reachable.{" "}
              {ollamaProbe.models.length === 0
                ? "No models pulled yet — run `ollama pull <model>` first."
                : `Installed: ${ollamaProbe.models.join(", ")}.`}
            </p>
          )}
          {ollamaProbe.kind === "error" && (
            <p
              className="setting-description"
              style={{ marginTop: "0.5rem", color: "var(--danger, #e8836a)" }}
            >
              {ollamaProbe.message}
            </p>
          )}
        </div>
      )}

      <p className="setting-description" style={{ marginTop: "0.75rem" }}>
        <em>{activeLabel}</em>
        {runtime?.activeBackend && backendPref !== runtime.activeBackend && (
          <>
            {" "}— restart the app for the new preference to take
            effect.
          </>
        )}
      </p>

      <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", margin: "1rem 0" }} />

      <p className="setting-description" style={{ marginBottom: "0.5rem" }}>
        <strong>GPU acceleration bundle</strong>{" "}
        {bundle && (
          <span style={{ opacity: 0.7 }}>
            ({formatMb(bundle.sizeBytes)})
          </span>
        )}
      </p>

      {!installed && !downloading && (
        <button type="button" className="copy-btn" onClick={onDownload}>
          Download bundle
        </button>
      )}

      {downloading && (
        <>
          <div className="ai-model-progress-track">
            <div
              className="ai-model-progress-fill"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="setting-description" style={{ marginTop: "0.25rem" }}>
            Downloading… {formatMb(totals.downloaded)} / {formatMb(totals.total)} ({pct}%)
          </p>
        </>
      )}

      {installed && !downloading && (
        <>
          <p className="setting-description" style={{ marginBottom: "0.5rem" }}>
            ✓ Installed.
          </p>
          <button type="button" className="copy-btn" onClick={onDelete}>
            Remove bundle ({bundle ? formatMb(bundle.sizeBytes) : "—"})
          </button>
        </>
      )}

      {error && (
        <p className="setting-description" style={{ color: "var(--danger, #e8836a)" }}>
          {error}
        </p>
      )}
    </div>
  );
}

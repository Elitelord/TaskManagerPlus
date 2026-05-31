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
    return () => {
      cancelled = true;
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
      : "Running on: not yet loaded";

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
        {(["auto", "cpu", "vulkan"] as const).map((opt) => (
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
            </span>
          </label>
        ))}
      </div>

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

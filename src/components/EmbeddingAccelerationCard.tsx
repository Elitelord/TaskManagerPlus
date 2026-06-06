// Z4 — Settings card for GPU acceleration of the *embedding* model
// (file intent search, "find files about X", folder clustering, the
// find_files_by_intent MCP tool). Independent of the generative LM
// acceleration above — they're separate models with separate runtimes.
//
// Mirrors the structure of GpuAccelerationCard:
//   1. Preference radio (CPU / DirectML) → pushes to the Rust
//      `embeddings` dispatcher's preference static.
//   2. ORT + DirectML runtime bundle install state. Without it, the
//      DirectML path falls back to CPU on first embed.
//   3. Active-backend feedback so users can verify the toggle landed.
//
// CPU stays the default. DirectML is opt-in via the radio plus the
// bundle download; nothing about embeddings changes for users who
// don't engage either.

import { useEffect, useMemo, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { useSettings } from "../lib/settings";
import {
  aiDownloadModel,
  aiDeleteModel,
  aiEmbedderRuntimeStatus,
  aiModelStatus,
  type EmbedderRuntimeStatus,
  type ModelStatus,
} from "../lib/ai/api";

const BUNDLE_ID = "onnxruntime-dml-v1";

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

export function EmbeddingAccelerationCard() {
  const [settings, update] = useSettings();
  const [bundle, setBundle] = useState<ModelStatus | null>(null);
  const [runtime, setRuntime] = useState<EmbedderRuntimeStatus | null>(null);
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
      const r = await aiEmbedderRuntimeStatus();
      setRuntime(r);
    } catch { /* same */ }
  };

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    (async () => {
      await refresh();
      try {
        // Reuse the shared `ai-model-download` channel — the modelId
        // discriminates which spec each tick belongs to so two cards
        // listening at once don't conflict.
        unlisten = await listen<ProgressPayload>("ai-model-download", (event) => {
          const p = event.payload;
          if (p.modelId !== BUNDLE_ID) return;
          setProgress((prev) => ({ ...prev, [p.fileName]: p }));
          if (p.done && !cancelled) {
            void refresh();
          }
        });
      } catch { /* no event channel in this env */ }
    })();
    // Poll runtime status while the card is mounted so the
    // "Running on" label updates the moment the first embed call
    // populates the dispatcher's active backend — without forcing
    // the user to navigate away and back to see it.
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

  const totals = useMemo(() => {
    const downloaded = Object.values(progress).reduce((a, p) => a + p.downloadedBytes, 0);
    const total =
      bundle?.sizeBytes ?? Object.values(progress).reduce((a, p) => a + p.totalBytes, 0);
    return { downloaded, total };
  }, [progress, bundle?.sizeBytes]);

  const pct =
    totals.total > 0 ? Math.min(100, Math.round((totals.downloaded / totals.total) * 100)) : 0;

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
  const backendPref = settings.embedderBackend;
  const activeLabel =
    runtime?.activeBackend === "directml"
      ? "Running on: GPU (DirectML)"
      : runtime?.activeBackend === "cpu"
        ? "Running on: CPU"
        : "Running on: not yet loaded";

  return (
    <div className="info-panel">
      <h3 className="section-title">AI Search Acceleration (GPU)</h3>
      <p className="setting-description">
        The embedding model (intent search, &ldquo;find files about
        X&rdquo;, folder clustering) runs on CPU by default. With the
        optional DirectML runtime installed, supported Windows GPUs
        run it via DirectML — meaningfully faster on large scans where
        thousands of files get embedded at once.
      </p>
      <p className="setting-description setting-privacy-note">
        <strong>Privacy:</strong> the runtime is a local DLL bundle.
        Inference still happens 100 % on your device — no network
        call, no data leaves. Same as the CPU path.
      </p>

      <div className="setting-radio-group">
        {(["cpu", "directml"] as const).map((opt) => (
          <label
            key={opt}
            className={`setting-radio-row ${backendPref === opt ? "active" : ""}`}
          >
            <input
              type="radio"
              name="embedderBackend"
              value={opt}
              checked={backendPref === opt}
              onChange={() => update({ embedderBackend: opt })}
            />
            <span className="setting-label">
              {opt === "cpu" && "CPU (default)"}
              {opt === "directml" && "Use DirectML when bundle is installed"}
            </span>
          </label>
        ))}
      </div>

      <p className="setting-description" style={{ marginTop: "0.75rem" }}>
        <em>{activeLabel}</em>
        {runtime?.activeBackend && backendPref !== runtime.activeBackend && (
          <> — restart the app for the new preference to take effect.</>
        )}
      </p>

      <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", margin: "1rem 0" }} />

      <p className="setting-description" style={{ marginBottom: "0.5rem" }}>
        <strong>DirectML runtime bundle</strong>{" "}
        {bundle && <span style={{ opacity: 0.7 }}>({formatMb(bundle.sizeBytes)})</span>}
      </p>

      {!installed && !downloading && (
        <button type="button" className="copy-btn" onClick={onDownload}>
          Download bundle
        </button>
      )}

      {downloading && (
        <>
          <div className="ai-model-progress-track">
            <div className="ai-model-progress-fill" style={{ width: `${pct}%` }} />
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

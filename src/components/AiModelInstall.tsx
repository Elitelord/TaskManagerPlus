// Phase 3 — model installation panel. Appears in Settings under the AI
// tier selector when the user has picked Standard. Shows install status,
// offers a one-click download that triggers `ai_download_model`, and
// streams progress from the `ai-model-download` Tauri event channel.
//
// Failure modes are explicit: the panel never silently hangs — non-Tauri
// envs (vite preview / tests) drop straight to "Checking model status…"
// and stay there harmlessly.

import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  aiClearEmbeddingCache,
  aiDownloadModel,
  aiEmbeddingCacheStats,
  aiModelStatus,
  type ModelStatus,
} from "../lib/ai/api";

const MODEL_ID = "bge-small-en-v1.5";

interface ProgressPayload {
  modelId: string;
  fileName: string;
  downloadedBytes: number;
  totalBytes: number;
  done: boolean;
}

function fmtMb(b: number): string {
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

export function AiModelInstall() {
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<Record<string, ProgressPayload>>({});
  const [error, setError] = useState<string | null>(null);
  const [sizeBytes, setSizeBytes] = useState<number>(0);
  // Stage D — embedding cache stats. Reflects what's on disk and updates
  // after a Clear action.
  const [cachedEntries, setCachedEntries] = useState<number>(0);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    (async () => {
      try {
        const statuses: ModelStatus[] = await aiModelStatus();
        const me = statuses.find((s) => s.modelId === MODEL_ID);
        if (!cancelled && me) {
          setInstalled(me.installed);
          setSizeBytes(me.sizeBytes);
        }
      } catch {
        /* non-Tauri / backend not ready — UI stays in "checking" state. */
      }
      try {
        const n = await aiEmbeddingCacheStats();
        if (!cancelled) setCachedEntries(n);
      } catch {
        /* cache stats are non-critical — leave at 0. */
      }
      try {
        unlisten = await listen<ProgressPayload>("ai-model-download", (event) => {
          const p = event.payload;
          if (p.modelId !== MODEL_ID) return;
          setProgress((prev) => ({ ...prev, [p.fileName]: p }));
        });
      } catch {
        /* no event channel — progress simply won't animate. */
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const onClearCache = async () => {
    setClearing(true);
    try {
      await aiClearEmbeddingCache();
      setCachedEntries(0);
    } catch (e) {
      setError(String(e));
    } finally {
      setClearing(false);
    }
  };

  const onInstall = async () => {
    setError(null);
    setDownloading(true);
    setProgress({});
    try {
      await aiDownloadModel(MODEL_ID);
      const statuses = await aiModelStatus();
      const me = statuses.find((s) => s.modelId === MODEL_ID);
      setInstalled(me?.installed ?? false);
    } catch (e) {
      setError(String(e));
    } finally {
      setDownloading(false);
    }
  };

  // Sum progress across the bundle's files.
  const totals = Object.values(progress).reduce(
    (acc, p) => ({ d: acc.d + p.downloadedBytes, t: acc.t + p.totalBytes }),
    { d: 0, t: 0 },
  );
  const pct = totals.t > 0 ? Math.min(100, (totals.d / totals.t) * 100) : 0;

  return (
    <div className="ai-model-install">
      {installed === null && (
        <p className="setting-description">Checking model status…</p>
      )}

      {installed === true && (
        <p className="setting-description">
          ✓ Embedding model installed ({fmtMb(sizeBytes)}).
        </p>
      )}

      {installed === false && !downloading && (
        <>
          <p className="setting-description">
            The embedding model isn't installed yet. Standard-tier features
            need it (~{fmtMb(sizeBytes || 35_000_000)}, one-time download from
            GitHub release assets, BLAKE3-verified on arrival).
          </p>
          <button className="theme-btn active" onClick={onInstall}>
            Install model
          </button>
        </>
      )}

      {downloading && (
        <>
          <p className="setting-description">
            Downloading model — {pct.toFixed(0)}% ({fmtMb(totals.d)} of {fmtMb(totals.t)})
          </p>
          <div className="ai-model-progress-track">
            <div
              className="ai-model-progress-fill"
              style={{ width: `${pct}%` }}
            />
          </div>
        </>
      )}

      {error && (
        <p className="setting-description" style={{ color: "var(--accent-red, #ef4444)" }}>
          Install failed: {error}
        </p>
      )}

      {/* Stage D — on-disk embedding cache. Only meaningful when the
          model is installed AND the cache has entries. The "Clear" button
          forces a cold re-embed on the next scan, which is the right
          escape hatch if the user wants to re-do the analysis on changed
          source files without waiting for mtime detection. */}
      {installed === true && cachedEntries > 0 && (
        <div className="ai-model-cache-row">
          <span className="setting-description">
            {cachedEntries.toLocaleString()} embeddings cached on this device
          </span>
          <button
            className="btn-sm"
            onClick={onClearCache}
            disabled={clearing}
            title="Drop every cached embedding. Next scan re-embeds from scratch."
          >
            {clearing ? "Clearing…" : "Clear cache"}
          </button>
        </div>
      )}
    </div>
  );
}

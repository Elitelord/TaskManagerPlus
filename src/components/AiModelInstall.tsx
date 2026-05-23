// Phase 3 + 4 — model install + management panel under Settings → AI.
//
// Renders whenever either:
//   • the user has selected AI tier Standard (install affordance), OR
//   • the model file is on disk (cache + delete affordances).
//
// That second condition matters because a user who turned AI back to Off
// after downloading shouldn't be stuck with a 33 MB blob they have no way
// to delete from inside the app. The panel adapts its content based on
// the (tier, installed) tuple.
//
// Failure modes are explicit: the panel never silently hangs — non-Tauri
// envs (vite preview / tests) drop straight to "Checking model status…"
// and stay there harmlessly.

import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  aiClearEmbeddingCache,
  aiDeleteModel,
  aiDownloadModel,
  aiEmbeddingCacheStats,
  aiModelStatus,
  type ModelStatus,
} from "../lib/ai/api";
import { getSettings } from "../lib/settings";
import { tierEnablesEmbeddings } from "../lib/ai/types";

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
  // Delete affordance state. `deleting` blocks reentry; `deleted` is a
  // momentary success ack.
  const [deleting, setDeleting] = useState(false);

  // Snapshot the tier at render time so we can adapt the UI. Settings
  // re-renders this component on tier change, so a stale snapshot can't
  // get stuck.
  const tierActive = tierEnablesEmbeddings(getSettings().aiTier);

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

  const onDelete = async () => {
    // Plain confirm() is good enough for v1 — the action is reversible
    // (re-download is one click) and the destructive scope is small.
    const ok = window.confirm(
      `Delete the AI model (${fmtMb(sizeBytes || 35_000_000)})?\n\n` +
      "AI features (file search, grouping related files, and finding " +
      "duplicates) will stop working until you re-download it. The saved " +
      "index will be cleared too.",
    );
    if (!ok) return;
    setError(null);
    setDeleting(true);
    try {
      // Clear the cache first — orphaned embeddings without a model are
      // useless and would just waste disk.
      await aiClearEmbeddingCache().catch(() => { /* non-fatal */ });
      setCachedEntries(0);
      await aiDeleteModel(MODEL_ID);
      setInstalled(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setDeleting(false);
    }
  };

  // Sum progress across the bundle's files.
  const totals = Object.values(progress).reduce(
    (acc, p) => ({ d: acc.d + p.downloadedBytes, t: acc.t + p.totalBytes }),
    { d: 0, t: 0 },
  );
  const pct = totals.t > 0 ? Math.min(100, (totals.d / totals.t) * 100) : 0;

  // Don't render at all when AI is off AND the model isn't installed —
  // there's nothing to manage. (SettingsPage uses the same condition to
  // decide whether to mount the component, but check defensively here
  // too so the panel can't render in a useless state.)
  if (!tierActive && installed !== true) return null;

  return (
    <div className="ai-model-install">
      {installed === null && (
        <p className="setting-description">Checking model status…</p>
      )}

      {installed === true && tierActive && (
        <p className="setting-description">
          ✓ Embedding model installed ({fmtMb(sizeBytes)}).
        </p>
      )}

      {/* The "AI off but model still installed" case — explicit so the
          user knows the model is taking disk and can reclaim it. */}
      {installed === true && !tierActive && (
        <p className="setting-description">
          The AI model ({fmtMb(sizeBytes)}) is still on disk even though AI
          features are turned off. You can delete it to free up the space —
          it'll re-download in seconds if you turn AI back on.
        </p>
      )}

      {installed === false && !downloading && tierActive && (
        <>
          <p className="setting-description">
            The AI model isn't installed yet. AI features need it (a
            one-time ~{fmtMb(sizeBytes || 35_000_000)} download, nothing
            leaves your device after that).
          </p>
          <button className="theme-btn active" onClick={onInstall}>
            Install model
          </button>
        </>
      )}

      {downloading && (
        <>
          <p className="setting-description">
            Downloading — {pct.toFixed(0)}% ({fmtMb(totals.d)} of {fmtMb(totals.t)})
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
          {error}
        </p>
      )}

      {/* Cache row — only meaningful when the model is installed AND the
          cache has entries. The "Clear" button forces a cold re-embed on
          the next scan. */}
      {installed === true && cachedEntries > 0 && (
        <div className="ai-model-cache-row">
          <span className="setting-description">
            {cachedEntries.toLocaleString()} files indexed for AI features
          </span>
          <button
            className="btn-sm"
            onClick={onClearCache}
            disabled={clearing || deleting}
            title="Clear the saved index. The next scan rebuilds it from scratch."
          >
            {clearing ? "Clearing…" : "Clear cache"}
          </button>
        </div>
      )}

      {/* Delete-model row — surfaces whenever the model is installed, so
          the user can reclaim ~33 MB regardless of current tier. Sits at
          the bottom of the panel so it's the deliberate last-resort
          action, not the first thing a user clicks. */}
      {installed === true && (
        <div className="ai-model-cache-row">
          <span className="setting-description">
            Reclaim {fmtMb(sizeBytes || 35_000_000)} by deleting the model
          </span>
          <button
            className="btn-sm"
            onClick={onDelete}
            disabled={deleting || downloading}
            title="Remove the AI model from disk. You can re-download it anytime."
          >
            {deleting ? "Deleting…" : "Delete model"}
          </button>
        </div>
      )}
    </div>
  );
}

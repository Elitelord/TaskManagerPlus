// Phase 3–5 — unified AI model install + management panel under Settings → AI.
//
// Tier-aware: it knows which downloaded models the current tier needs and
// installs them with ONE button.
//   • Standard → the embedding model (search / grouping / duplicates)
//   • Enhanced → the embedding model + the generative "writing" model
// If the embedding model is already on disk (e.g. user went Standard →
// Enhanced), the single Install button only fetches what's missing.
//
// Also manages the embedding index cache and per-model deletion, so a user
// who turned AI back to Off can still reclaim the disk.

import { useEffect, useMemo, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  aiClearEmbeddingCache,
  aiDeleteModel,
  aiDownloadModel,
  aiEmbeddingCacheStats,
  aiModelStatus,
  aiPrewarmEmbedder,
  aiPrewarmGenlm,
  type ModelStatus,
} from "../lib/ai/api";
import { getSettings } from "../lib/settings";
import { tierEnablesEmbeddings, tierEnablesGenerative } from "../lib/ai/types";

const EMBED_ID = "bge-small-en-v1.5";
const GEN_ID = "qwen2.5-0.5b-instruct";

/** Friendly, jargon-free name per model id (shown to the user). */
const MODEL_LABEL: Record<string, string> = {
  [EMBED_ID]: "search & grouping model",
  [GEN_ID]: "writing model",
};

interface ProgressPayload {
  modelId: string;
  fileName: string;
  downloadedBytes: number;
  totalBytes: number;
  done: boolean;
}

function fmtMb(b: number): string {
  return `${(b / (1024 * 1024)).toFixed(0)} MB`;
}

export function AiModelInstall() {
  const [statuses, setStatuses] = useState<Record<string, ModelStatus>>({});
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<Record<string, ProgressPayload>>({});
  const [error, setError] = useState<string | null>(null);
  const [cachedEntries, setCachedEntries] = useState<number>(0);
  const [clearing, setClearing] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const tier = getSettings().aiTier;
  // Models the current tier requires, in install order (embedding first).
  const requiredIds = useMemo(() => {
    const ids: string[] = [];
    if (tierEnablesEmbeddings(tier)) ids.push(EMBED_ID);
    if (tierEnablesGenerative(tier)) ids.push(GEN_ID);
    return ids;
  }, [tier]);

  const refreshStatuses = async () => {
    const list: ModelStatus[] = await aiModelStatus();
    const map: Record<string, ModelStatus> = {};
    for (const s of list) map[s.modelId] = s;
    setStatuses(map);
    return map;
  };

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    (async () => {
      try {
        await refreshStatuses();
        if (!cancelled) setReady(true);
      } catch {
        /* non-Tauri / backend not ready — stays in "checking" state. */
      }
      try {
        const n = await aiEmbeddingCacheStats();
        if (!cancelled) setCachedEntries(n);
      } catch {
        /* non-critical. */
      }
      try {
        unlisten = await listen<ProgressPayload>("ai-model-download", (event) => {
          const p = event.payload;
          setProgress((prev) => ({ ...prev, [`${p.modelId}/${p.fileName}`]: p }));
        });
      } catch {
        /* no event channel — progress won't animate. */
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const missingRequired = requiredIds.filter((id) => statuses[id] && !statuses[id].installed);
  const missingBytes = missingRequired.reduce((a, id) => a + (statuses[id]?.sizeBytes ?? 0), 0);
  const installedRequired = requiredIds.filter((id) => statuses[id]?.installed);
  const anyInstalled = Object.values(statuses).some((s) => s.installed);

  const onInstall = async () => {
    setError(null);
    setDownloading(true);
    setProgress({});
    try {
      // Fetch only what's missing, embedding first.
      for (const id of missingRequired) {
        await aiDownloadModel(id);
      }
      await refreshStatuses();
      // Warm whatever the tier uses so first use isn't cold-load slow.
      if (tierEnablesEmbeddings(tier)) aiPrewarmEmbedder().catch(() => {});
      if (tierEnablesGenerative(tier)) aiPrewarmGenlm().catch(() => {});
    } catch (e) {
      setError(String(e));
    } finally {
      setDownloading(false);
    }
  };

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

  const onDelete = async (id: string) => {
    const sz = statuses[id]?.sizeBytes ?? 0;
    const ok = window.confirm(
      `Delete the ${MODEL_LABEL[id] ?? "AI model"} (${fmtMb(sz)})?\n\n` +
        "The features that use it will stop working until you re-download it.",
    );
    if (!ok) return;
    setError(null);
    setDeleting(id);
    try {
      if (id === EMBED_ID) {
        // Orphaned embeddings without their model are useless — clear them.
        await aiClearEmbeddingCache().catch(() => {});
        setCachedEntries(0);
      }
      await aiDeleteModel(id);
      await refreshStatuses();
    } catch (e) {
      setError(String(e));
    } finally {
      setDeleting(null);
    }
  };

  // Combined progress across every file of every model being fetched.
  const totals = Object.values(progress).reduce(
    (acc, p) => ({ d: acc.d + p.downloadedBytes, t: acc.t + p.totalBytes }),
    { d: 0, t: 0 },
  );
  const pct = totals.t > 0 ? Math.min(100, (totals.d / totals.t) * 100) : 0;

  // Nothing to manage when the tier needs no models and none are on disk.
  if (requiredIds.length === 0 && !anyInstalled) return null;
  if (!ready) {
    return <p className="setting-description">Checking model status…</p>;
  }

  return (
    <div className="ai-model-install">
      {/* Install affordance — one button for everything the tier still needs. */}
      {missingRequired.length > 0 && !downloading && (
        <>
          <p className="setting-description">
            {installedRequired.length > 0
              ? `One more model to download for this tier (~${fmtMb(missingBytes)}).`
              : `This tier needs a one-time ~${fmtMb(missingBytes)} download. ` +
                "Everything runs on your device after that."}
          </p>
          <button className="theme-btn active" onClick={onInstall}>
            {requiredIds.length > 1 ? "Install AI models" : "Install model"}
          </button>
        </>
      )}

      {missingRequired.length === 0 && installedRequired.length > 0 && (
        <p className="setting-description">
          ✓ All set — {installedRequired.map((id) => MODEL_LABEL[id] ?? id).join(" + ")} installed.
        </p>
      )}

      {downloading && (
        <>
          <p className="setting-description">
            Downloading — {pct.toFixed(0)}% ({fmtMb(totals.d)} of {fmtMb(totals.t)})
          </p>
          <div className="ai-model-progress-track">
            <div className="ai-model-progress-fill" style={{ width: `${pct}%` }} />
          </div>
        </>
      )}

      {error && (
        <p className="setting-description" style={{ color: "var(--accent-red, #ef4444)" }}>
          {error}
        </p>
      )}

      {/* Embedding index cache — only when the embedding model is installed. */}
      {statuses[EMBED_ID]?.installed && cachedEntries > 0 && (
        <div className="ai-model-cache-row">
          <span className="setting-description">
            {cachedEntries.toLocaleString()} files indexed for AI features
          </span>
          <button
            className="btn-sm"
            onClick={onClearCache}
            disabled={clearing || deleting !== null}
            title="Clear the saved index. The next scan rebuilds it from scratch."
          >
            {clearing ? "Clearing…" : "Clear cache"}
          </button>
        </div>
      )}

      {/* Per-model delete — surfaces for any installed model so the user can
          reclaim disk regardless of the current tier. */}
      {Object.values(statuses)
        .filter((s) => s.installed)
        .map((s) => (
          <div className="ai-model-cache-row" key={s.modelId}>
            <span className="setting-description">
              Reclaim {fmtMb(s.sizeBytes)} by deleting the {MODEL_LABEL[s.modelId] ?? "model"}
            </span>
            <button
              className="btn-sm"
              onClick={() => onDelete(s.modelId)}
              disabled={deleting !== null || downloading}
              title="Remove this model from disk. You can re-download it anytime."
            >
              {deleting === s.modelId ? "Deleting…" : "Delete"}
            </button>
          </div>
        ))}
    </div>
  );
}

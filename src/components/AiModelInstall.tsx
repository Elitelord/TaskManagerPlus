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
  aiDiskUsage,
  aiDownloadModel,
  aiEmbeddingCacheStats,
  aiGenlmRuntimeStatus,
  aiModelStatus,
  aiPrewarmEmbedder,
  aiPrewarmGenlm,
  type AiDiskUsage,
  type GenlmRuntimeStatus,
  type ModelStatus,
} from "../lib/ai/api";
import { revealInExplorer } from "../lib/ipc";
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

/** Pretty byte-size formatter for the disk-usage card. Picks the right
 *  unit so the user sees "12 MB" rather than "0 GB" for the cache file. */
function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(b < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function AiModelInstall() {
  const [statuses, setStatuses] = useState<Record<string, ModelStatus>>({});
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<Record<string, ProgressPayload>>({});
  const [error, setError] = useState<string | null>(null);
  const [cachedEntries, setCachedEntries] = useState<number>(0);
  // v2.1 — absorbed from the (now-removed) standalone AiDiagnosticsCard.
  // Lets the AI section show which generative backend is in use without
  // a separate panel. Polled alongside the other status calls.
  const [runtime, setRuntime] = useState<GenlmRuntimeStatus | null>(null);
  const [clearing, setClearing] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [disk, setDisk] = useState<AiDiskUsage | null>(null);

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

  /** Re-read the on-disk footprint. Wired into the same lifecycle events
   *  that change disk state (install, delete, clear cache) so the UI stays
   *  in sync without a hard refresh. Failures are non-fatal — the card just
   *  doesn't render when `disk` is null. */
  const refreshDiskUsage = async () => {
    try {
      const u = await aiDiskUsage();
      setDisk(u);
    } catch {
      setDisk(null);
    }
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
        const r = await aiGenlmRuntimeStatus();
        if (!cancelled) setRuntime(r);
      } catch {
        /* non-critical — backend will fill in once available. */
      }
      if (!cancelled) await refreshDiskUsage();
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
      await refreshDiskUsage();
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
      await refreshDiskUsage();
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
      await refreshDiskUsage();
    } catch (e) {
      setError(String(e));
    } finally {
      setDeleting(null);
    }
  };

  /** Open the AI data folder (or the embedding cache file's parent) in
   *  Explorer. Useful when the user wants to back up their indexed scans,
   *  check exactly what's on disk, or manually delete a stray file. */
  const onOpenFolder = async (path: string) => {
    try {
      await revealInExplorer(path);
    } catch (e) {
      setError(String(e));
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

      {/* v2.1 — Everything post-install (cache, per-model delete, disk
          usage paths, diagnostics) under a single dropdown. Without
          it the "All set" line was followed by ~12 vertical rows of
          management UI nobody needs to look at after the initial
          install. Only rendered when at least one model is on disk
          OR diagnostics-relevant runtime info exists — keeps the
          card otherwise minimal. */}
      {(installedRequired.length > 0 || (disk && (disk.modelsBytes > 0 || disk.cacheBytes > 0))) && (
        <details className="settings-details">
          <summary>Manage installed models</summary>
          <div className="settings-details-body">

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

            {/* Per-model delete — surfaces for any installed model so the
                user can reclaim disk regardless of the current tier. */}
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

            {/* AI disk usage — paths + open-in-Explorer for the models dir
                and embedding cache file. */}
            {disk && (disk.modelsBytes > 0 || disk.cacheBytes > 0) && (
              <div className="ai-disk-usage">
                <div className="ai-disk-usage-header">
                  <span className="setting-label">AI disk usage</span>
                  <span className="setting-description">
                    {fmtBytes(disk.modelsBytes + disk.cacheBytes)} total
                  </span>
                </div>
                <div className="ai-disk-usage-row">
                  <div className="ai-disk-usage-info">
                    <div className="ai-disk-usage-label">Models</div>
                    <div className="ai-disk-usage-path" title={disk.modelsDir}>
                      {disk.modelsDir}
                    </div>
                  </div>
                  <div className="ai-disk-usage-right">
                    <span className="ai-disk-usage-size">{fmtBytes(disk.modelsBytes)}</span>
                    <button
                      className="btn-sm"
                      onClick={() => onOpenFolder(disk.modelsDir)}
                      title="Open the AI models folder in Explorer."
                    >
                      Open
                    </button>
                  </div>
                </div>
                <div className="ai-disk-usage-row">
                  <div className="ai-disk-usage-info">
                    <div className="ai-disk-usage-label">Search index cache</div>
                    <div className="ai-disk-usage-path" title={disk.cacheFile}>
                      {disk.cacheFile}
                    </div>
                  </div>
                  <div className="ai-disk-usage-right">
                    <span className="ai-disk-usage-size">{fmtBytes(disk.cacheBytes)}</span>
                    <button
                      className="btn-sm"
                      onClick={() => onOpenFolder(disk.cacheFile)}
                      title="Reveal the embedding cache file in Explorer."
                      disabled={disk.cacheBytes === 0}
                    >
                      Open
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Runtime diagnostics — absorbed from the (deleted)
                standalone AiDiagnosticsCard. Useful for bug-report
                triage; reads from existing endpoints, no new state. */}
            <dl className="ai-diagnostics-list" style={{ marginTop: 10 }}>
              <dt>AI tier</dt>
              <dd>{tier}</dd>
              <dt>Writing-model backend</dt>
              <dd>
                {runtime?.activeBackend
                  ? runtime.activeBackend === "vulkan"
                    ? "GPU (Vulkan)"
                    : "CPU"
                  : "not loaded yet"}
              </dd>
              <dt>GPU bundle installed</dt>
              <dd>{runtime?.vulkanBundleInstalled ? "yes" : "no"}</dd>
            </dl>

          </div>
        </details>
      )}
    </div>
  );
}

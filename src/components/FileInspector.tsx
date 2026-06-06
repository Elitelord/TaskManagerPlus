// Phase 5 — the item inspector: one consistent surface for the generative
// AI actions on a file (or folder). Opened by left-clicking a file anywhere
// (search results, duplicates, …) via the `tmp:open-inspector` event, so the
// many different row/chip representations all funnel into one reviewable
// panel instead of each growing its own buttons.
//
// File mode: one-line summary (B2), suggested names → apply (smart rename),
// find-similar (S9), and Open in Explorer.
//
// Folder mode adds a drill-down browser: the biggest subfolders and files
// living directly under the folder, sorted by size. Clicking a folder dives
// in; clicking a file re-targets the inspector to that file. A breadcrumb at
// the top lets the user climb back up to any ancestor folder. This turns the
// inspector into a lightweight "what's eating space here" explorer without
// leaving the app.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  revealInExplorer, renameFile,
  listFolderChildren, sizeFolderPaths,
} from "../lib/ipc";
import {
  setSubCache, mergeCachedSizes,
  contentEntriesToCache, normCachePath,
  type DrillContentEntry,
} from "../lib/folderDrillCache";
import {
  tryGenerateSummary, tryGenerateSmartRename,
  trySummarizeFolder, trySuggestFolderNames,
} from "../lib/ai/tierGate";
import { aiGenlmRuntimeStatus } from "../lib/ai/api";
import { getCachedResult, setCachedResult } from "../lib/aiResultCache";
import { getSettings } from "../lib/settings";
import { tierEnablesGenerative } from "../lib/ai/types";

export interface InspectorTarget {
  path: string;
  kind: "file" | "folder";
}

/** One entry in the folder drill-down list. */
type ContentEntry = DrillContentEntry;

function sortContentEntries(entries: ContentEntry[]): ContentEntry[] {
  return [...entries].sort((a, b) => {
    const aKnown = a.sizeKnown;
    const bKnown = b.sizeKnown;
    if (aKnown && bKnown && a.size !== b.size) return b.size - a.size;
    if (aKnown !== bKnown) return aKnown ? -1 : 1;
    if (a.kind !== b.kind) return a.kind === "file" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

/** Stable display order: folders first (alpha), then files by size. Sizes
 *  update in place during background enrichment without jumping rows. */
function initialDisplayOrder(entries: ContentEntry[]): ContentEntry[] {
  const folders = entries.filter((e) => e.kind === "folder")
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const files = entries.filter((e) => e.kind === "file")
    .sort((a, b) => b.size - a.size);
  return [...folders, ...files];
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(i + 1) : p;
}
function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(0, i) : "";
}

function formatBytes(n: number): string {
  if (!n || n < 1) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i < 2 ? 0 : 1)} ${units[i]}`;
}

/** Build clickable breadcrumb segments from a path. Each segment carries the
 *  cumulative path up to and including it, so clicking navigates to that
 *  ancestor folder. The final segment is the current item itself. */
function breadcrumbSegments(path: string): { label: string; path: string }[] {
  const norm = path.replace(/\//g, "\\").replace(/\\+$/, "");
  const parts = norm.split("\\").filter((p) => p.length > 0);
  const out: { label: string; path: string }[] = [];
  let acc = "";
  for (let i = 0; i < parts.length; i++) {
    // First segment on Windows is the drive ("C:") — append a backslash so the
    // cumulative path is a valid root ("C:\").
    acc = i === 0 ? `${parts[i]}\\` : `${acc.replace(/\\+$/, "")}\\${parts[i]}`;
    out.push({ label: parts[i] || acc, path: acc });
  }
  return out;
}

const FOLDER_ICON = "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z";
const FILE_ICON = "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6";

export function FileInspector({
  target,
  onClose,
}: {
  target: InspectorTarget | null;
  onClose: () => void;
}) {
  // `current` is the item actually being inspected. It starts as `target`
  // (the entry point fired by the open-inspector event) but the user can
  // navigate within the panel (drill into folders / climb the breadcrumb)
  // without firing new global events.
  const [current, setCurrent] = useState<InspectorTarget | null>(target);
  const [path, setPath] = useState("");
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  // Y1-A — which backend produced the most recent generation. Polled
  // after summary load completes so users can see whether the GPU
  // bundle is actually doing work without leaving the inspector.
  const [activeBackend, setActiveBackend] = useState<"cpu" | "vulkan" | "ollama" | null>(null);
  const [names, setNames] = useState<string[] | null>(null);
  const [namesLoading, setNamesLoading] = useState(false);
  const [renamed, setRenamed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Folder drill-down state.
  const [contents, setContents] = useState<ContentEntry[] | null>(null);
  const [contentsLoading, setContentsLoading] = useState(false);
  const [sizingFolders, setSizingFolders] = useState(false);
  const contentsLoadGen = useRef(0);

  // A new external target resets the internal navigation to that entry point.
  useEffect(() => { setCurrent(target); }, [target]);

  const navigate = useCallback((next: InspectorTarget) => {
    setCurrent(next);
  }, []);

  // The AI sections (summary, rename, find-similar) only do anything on the
  // generative tier. The drill-down browser below is pure filesystem, so the
  // inspector now opens for *any* folder click — we just hide the AI sections
  // when the tier can't fulfil them rather than showing upsell noise.
  const genEnabled = tierEnablesGenerative(getSettings().aiTier);

  // Keep `path` (used by the title, reveal button, rename) in sync with the
  // current item on every navigation — independent of the AI tier.
  useEffect(() => {
    if (current) setPath(current.path);
  }, [current]);

  // (Re)load AI summary + name suggestions whenever the *current* item
  // changes (external open OR internal navigation). Skipped entirely when
  // the tier doesn't enable generative AI.
  useEffect(() => {
    if (!current || !genEnabled) return;
    setSummary(null);
    setNames(null);
    setRenamed(null);
    setError(null);
    let cancelled = false;
    const isFolder = current.kind === "folder";
    const sumKey = `summary:${current.kind}:${current.path}`;
    const namesKey = `names:${current.kind}:${current.path}`;

    const cachedSum = getCachedResult<string>(sumKey);
    if (typeof cachedSum === "string") {
      setSummary(cachedSum);
    } else {
      setSummaryLoading(true);
      (isFolder ? trySummarizeFolder(current.path) : tryGenerateSummary(current.path))
        .then((s) => {
          if (cancelled) return;
          setSummary(s ?? "");
          if (typeof s === "string") setCachedResult(sumKey, s);
        })
        .catch((e) => { if (!cancelled) setError(String(e)); })
        .finally(() => {
          if (cancelled) return;
          setSummaryLoading(false);
          // Y1-A — after the generation completes, ask the backend
          // which path actually served it. Result is sticky for the
          // process so we only need one poll; if the user enables
          // GPU later, they'll see the change on next inspector open.
          aiGenlmRuntimeStatus()
            .then((r) => {
              if (!cancelled) setActiveBackend(r.activeBackend);
            })
            .catch(() => { /* non-Tauri or backend unavailable */ });
        });
    }

    const cachedNames = getCachedResult<string[]>(namesKey);
    if (Array.isArray(cachedNames)) {
      setNames(cachedNames);
    } else {
      setNamesLoading(true);
      (isFolder ? trySuggestFolderNames(current.path) : tryGenerateSmartRename(current.path))
        .then((n) => {
          if (cancelled) return;
          setNames(n ?? []);
          if (Array.isArray(n)) setCachedResult(namesKey, n);
        })
        .catch(() => { /* names are best-effort */ })
        .finally(() => { if (!cancelled) setNamesLoading(false); });
    }

    return () => { cancelled = true; };
  }, [current]);

  // Load folder contents for folder targets.
  // Always list every immediate child (fast). Merge cached sizes, then size
  // any remaining folders one-by-one so sizes trickle in without blocking.
  useEffect(() => {
    if (!current || current.kind !== "folder") {
      setContents(null);
      setContentsLoading(false);
      setSizingFolders(false);
      return;
    }

    const folderPath = current.path;
    const gen = ++contentsLoadGen.current;
    const isStale = () => gen !== contentsLoadGen.current;

    setContents(null);
    setContentsLoading(true);
    setSizingFolders(false);

    (async () => {
      try {
        const shallow = await listFolderChildren(folderPath);
        if (isStale()) return;

        let entries: ContentEntry[] = shallow.map((e) => ({
          kind: e.kind,
          name: e.name,
          path: e.path,
          size: e.size_bytes,
          sizeKnown: e.kind === "file",
        }));
        entries = mergeCachedSizes(entries, folderPath);
        setContents(initialDisplayOrder(entries));
        setContentsLoading(false);

        const pending = entries.filter((e) => e.kind === "folder" && !e.sizeKnown);
        if (pending.length === 0) {
          const { folders, files } = contentEntriesToCache(entries);
          setSubCache(folderPath, folders, files);
          return;
        }

        setSizingFolders(true);
        for (const folder of pending) {
          if (isStale()) return;
          try {
            const [result] = await sizeFolderPaths([folder.path]);
            if (isStale()) return;
            setContents((prev) => {
              if (!prev) return prev;
              return prev.map((e) =>
                normCachePath(e.path) === normCachePath(folder.path)
                  ? {
                      ...e,
                      size: result?.size_bytes ?? 0,
                      fileCount: result?.file_count,
                      sizeKnown: true,
                    }
                  : e,
              );
            });
          } catch {
            if (isStale()) return;
            // Unreadable folder — stop showing the spinner for this row.
            setContents((prev) => {
              if (!prev) return prev;
              return prev.map((e) =>
                normCachePath(e.path) === normCachePath(folder.path)
                  ? { ...e, sizeKnown: true }
                  : e,
              );
            });
          }
        }

        if (isStale()) return;
        setSizingFolders(false);
        setContents((prev) => {
          if (!prev) return prev;
          const sorted = sortContentEntries(prev);
          const { folders, files } = contentEntriesToCache(sorted);
          setSubCache(folderPath, folders, files);
          return sorted;
        });
      } catch {
        if (!isStale()) {
          setContents([]);
          setContentsLoading(false);
          setSizingFolders(false);
        }
      }
    })();
  }, [current]);

  // Esc closes.
  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target, onClose]);

  if (!target || !current) return null;

  const applyRename = async (stem: string) => {
    try {
      const newPath = await renameFile(path, stem);
      setPath(newPath);
      setRenamed(basename(newPath));
      setNames(null);
      // Keep `current` in sync so the breadcrumb + contents reflect the new
      // name without firing a fresh AI pass on the stale path.
      setCurrent((c) => (c ? { ...c, path: newPath } : c));
    } catch (e) {
      setError(String(e));
    }
  };

  const findSimilar = () => {
    window.dispatchEvent(new CustomEvent("tmp:open-similar-palette", { detail: { seedPath: path } }));
    onClose();
  };

  const crumbs = breadcrumbSegments(current.path);
  const parentPath = dirOf(current.path);
  const isFolder = current.kind === "folder";

  return (
    <div className="file-inspector-backdrop" onClick={onClose}>
      <div className="file-inspector" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="File details">
        <div className="file-inspector-head">
          <div className="file-inspector-title" title={path}>{basename(path)}</div>
          <button className="file-inspector-close" onClick={onClose} title="Close (Esc)" aria-label="Close">✕</button>
        </div>

        {/* Breadcrumb — every ancestor is a clickable folder. The last crumb
            is the current item (highlighted, not clickable). */}
        <nav className="file-inspector-crumbs" aria-label="Path">
          {crumbs.map((c, i) => {
            const isLast = i === crumbs.length - 1;
            return (
              <span key={c.path} className="file-inspector-crumb-wrap">
                {isLast
                  ? <span className="file-inspector-crumb is-current" title={c.path}>{c.label}</span>
                  : <button
                      type="button"
                      className="file-inspector-crumb"
                      title={c.path}
                      onClick={() => navigate({ path: c.path, kind: "folder" })}
                    >
                      {c.label}
                    </button>}
                {!isLast && <span className="file-inspector-crumb-sep">›</span>}
              </span>
            );
          })}
        </nav>

        {/* Up-one-level shortcut — quick climb without aiming at a crumb. */}
        {parentPath && (
          <button
            type="button"
            className="file-inspector-up"
            onClick={() => navigate({ path: parentPath, kind: "folder" })}
            title={parentPath}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5 12h14M5 12l6-6M5 12l6 6" />
            </svg>
            Up to {basename(parentPath) || parentPath}
          </button>
        )}

        <button className="cmd-palette-action file-inspector-reveal" onClick={() => revealInExplorer(path).catch(() => {})}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 20h16M4 20V8a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v10" />
          </svg>
          Open in File Explorer
        </button>

        {error && <div className="file-inspector-section file-inspector-err">{error}</div>}

        {/* Folder contents drill-down. */}
        {isFolder && (
          <div className="file-inspector-section file-inspector-contents-section">
            <div className="file-inspector-label">
              Contents
              {contents && contents.length > 0 && (
                <span className="file-inspector-label-meta">
                  {contents.length.toLocaleString()} items
                  {sizingFolders ? " · sizing folders…" : ""}
                </span>
              )}
            </div>
            {contentsLoading && <div className="file-inspector-muted">Reading folder…</div>}
            {!contentsLoading && contents && contents.length === 0 && (
              <div className="file-inspector-muted">This folder is empty or unreadable.</div>
            )}
            {!contentsLoading && contents && contents.length > 0 && (
              <ul className="file-inspector-contents">
                {contents.map((e) => (
                  <li key={e.path}>
                    <button
                      type="button"
                      className={`file-inspector-entry entry-${e.kind}`}
                      onClick={() => navigate({ path: e.path, kind: e.kind })}
                      title={e.path}
                    >
                      <svg className="entry-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d={e.kind === "folder" ? FOLDER_ICON : FILE_ICON} />
                      </svg>
                      <span className="entry-name">{e.name}</span>
                      <span className="entry-size">
                        {e.kind === "folder" && !e.sizeKnown ? "…" : formatBytes(e.size)}
                      </span>
                      {e.kind === "folder" && (
                        <svg className="entry-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M9 18l6-6-6-6" />
                        </svg>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {genEnabled && (
          <div className="file-inspector-section">
            <div className="file-inspector-label">
              Summary
              {/* Y1-A — small backend badge so users can see the GPU
                  bundle is actually in play. Only renders after the
                  first generation completes; cached summaries don't
                  trigger a new inference so the badge is omitted
                  there to avoid lying about what just happened. */}
              {activeBackend && !summaryLoading && summary && (
                <span className="file-inspector-backend-badge">
                  via {activeBackend === "vulkan"
                    ? "GPU"
                    : activeBackend === "ollama"
                      ? "Ollama"
                      : "CPU"}
                </span>
              )}
            </div>
            {summaryLoading
              ? <div className="file-inspector-muted">Summarizing…</div>
              : summary
                ? <div className="file-inspector-summary">{summary}</div>
                : <div className="file-inspector-muted">
                    {current.kind === "folder" ? "This folder has no files to summarize." : "No readable text to summarize."}
                  </div>}
          </div>
        )}

        {genEnabled && (
          <div className="file-inspector-section">
            <div className="file-inspector-label">{current.kind === "folder" ? "Rename folder to" : "Suggested names"}</div>
            {renamed && <div className="file-inspector-muted">Renamed to “{renamed}”.</div>}
            {!renamed && namesLoading && <div className="file-inspector-muted">Thinking of names…</div>}
            {!renamed && !namesLoading && names && names.length === 0 && (
              <div className="file-inspector-muted">No suggestions{current.kind === "folder" ? " for this folder" : " for this file"}.</div>
            )}
            {!renamed && !namesLoading && names && names.length > 0 && (
              <div className="file-inspector-chips">
                {names.map((n) => (
                  <button key={n} type="button" className="org-tag-chip" title={`Rename to “${n}”`} onClick={() => void applyRename(n)}>
                    {n}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {genEnabled && current.kind === "file" && (
          <button className="cmd-palette-action" onClick={findSimilar}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
            </svg>
            Find similar files
          </button>
        )}
      </div>
    </div>
  );
}

// Phase 5 — the item inspector: one consistent surface for the generative
// AI actions on a file (or folder). Opened by left-clicking a file anywhere
// (search results, duplicates, …) via the `tmp:open-inspector` event, so the
// many different row/chip representations all funnel into one reviewable
// panel instead of each growing its own buttons.
//
// File mode (the only mode wired so far): one-line summary (B2), suggested
// names → apply (smart rename), find-similar (S9), and Open in Explorer.
// Folder mode (B4 / folder rename) slots in here later behind `kind`.

import { useEffect, useState } from "react";
import { revealInExplorer, renameFile } from "../lib/ipc";
import {
  tryGenerateSummary, tryGenerateSmartRename,
  trySummarizeFolder, trySuggestFolderNames,
} from "../lib/ai/tierGate";
import { getCachedResult, setCachedResult } from "../lib/aiResultCache";

export interface InspectorTarget {
  path: string;
  kind: "file" | "folder";
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(i + 1) : p;
}
function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(0, i) : "";
}

export function FileInspector({
  target,
  onClose,
}: {
  target: InspectorTarget | null;
  onClose: () => void;
}) {
  const [path, setPath] = useState("");
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [names, setNames] = useState<string[] | null>(null);
  const [namesLoading, setNamesLoading] = useState(false);
  const [renamed, setRenamed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // (Re)load when a new target opens. Summary + name suggestions are fetched
  // up front — the panel IS the "inspect" action, so showing results without
  // another click is the point. Both are bounded single LM calls.
  useEffect(() => {
    if (!target) return;
    setPath(target.path);
    setSummary(null);
    setNames(null);
    setRenamed(null);
    setError(null);
    let cancelled = false;
    const isFolder = target.kind === "folder";
    const sumKey = `summary:${target.kind}:${target.path}`;
    const namesKey = `names:${target.kind}:${target.path}`;

    // Summary — serve from the persistent cache when present (a file/folder is
    // summarised at most once), otherwise generate and cache the result.
    const cachedSum = getCachedResult<string>(sumKey);
    if (typeof cachedSum === "string") {
      setSummary(cachedSum);
    } else {
      setSummaryLoading(true);
      (isFolder ? trySummarizeFolder(target.path) : tryGenerateSummary(target.path))
        .then((s) => {
          if (cancelled) return;
          setSummary(s ?? "");
          if (typeof s === "string") setCachedResult(sumKey, s);
        })
        .catch((e) => { if (!cancelled) setError(String(e)); })
        .finally(() => { if (!cancelled) setSummaryLoading(false); });
    }

    // Name suggestions (file rename / folder rename) — same cache treatment.
    const cachedNames = getCachedResult<string[]>(namesKey);
    if (Array.isArray(cachedNames)) {
      setNames(cachedNames);
    } else {
      setNamesLoading(true);
      (isFolder ? trySuggestFolderNames(target.path) : tryGenerateSmartRename(target.path))
        .then((n) => {
          if (cancelled) return;
          setNames(n ?? []);
          if (Array.isArray(n)) setCachedResult(namesKey, n);
        })
        .catch(() => { /* names are best-effort */ })
        .finally(() => { if (!cancelled) setNamesLoading(false); });
    }

    return () => { cancelled = true; };
  }, [target]);

  // Esc closes.
  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target, onClose]);

  if (!target) return null;

  const applyRename = async (stem: string) => {
    try {
      const newPath = await renameFile(path, stem);
      setPath(newPath);
      setRenamed(basename(newPath));
      setNames(null); // suggestions no longer apply to the new name
    } catch (e) {
      setError(String(e));
    }
  };

  const findSimilar = () => {
    window.dispatchEvent(new CustomEvent("tmp:open-similar-palette", { detail: { seedPath: path } }));
    onClose();
  };

  return (
    <div className="file-inspector-backdrop" onClick={onClose}>
      <div className="file-inspector" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="File details">
        <div className="file-inspector-head">
          <div className="file-inspector-title" title={path}>{basename(path)}</div>
          <button className="file-inspector-close" onClick={onClose} title="Close (Esc)" aria-label="Close">✕</button>
        </div>
        <div className="file-inspector-dir" title={dirOf(path)}>{dirOf(path)}</div>

        <button className="cmd-palette-action file-inspector-reveal" onClick={() => revealInExplorer(path).catch(() => {})}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 20h16M4 20V8a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v10" />
          </svg>
          Open in File Explorer
        </button>

        {error && <div className="file-inspector-section file-inspector-err">{error}</div>}

        <div className="file-inspector-section">
          <div className="file-inspector-label">Summary</div>
          {summaryLoading
            ? <div className="file-inspector-muted">Summarizing…</div>
            : summary
              ? <div className="file-inspector-summary">{summary}</div>
              : <div className="file-inspector-muted">
                  {target.kind === "folder" ? "This folder has no files to summarize." : "No readable text to summarize."}
                </div>}
        </div>

        <div className="file-inspector-section">
          <div className="file-inspector-label">{target.kind === "folder" ? "Rename folder to" : "Suggested names"}</div>
          {renamed && <div className="file-inspector-muted">Renamed to “{renamed}”.</div>}
          {!renamed && namesLoading && <div className="file-inspector-muted">Thinking of names…</div>}
          {!renamed && !namesLoading && names && names.length === 0 && (
            <div className="file-inspector-muted">No suggestions{target.kind === "folder" ? " for this folder" : " for this file"}.</div>
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

        {target.kind === "file" && (
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

// Phase 4 — global semantic file search (S7) and "files like this" (S9).
//
// Cmd/Ctrl-K opens a centered modal with a query input and a ranked list
// of files from the embedding cache. Tier-gated: when AI is Off the
// palette renders an empty-state explaining that Standard must be enabled
// + a recent scan must have populated the cache.
//
// Two modes:
//   • "search" — `query` is a natural-language string the user types
//   • "similar" — `seedPath` is a file path; results are files semantically
//     near that one (S9, opened from a right-click affordance elsewhere)
//
// The component is mounted at the app root (App.tsx) so the Ctrl-K
// shortcut works regardless of which page is active. State lives here;
// `onClose` triggers fade-out + unmount.

import { useEffect, useMemo, useRef, useState } from "react";
import { trySearchSimilar, trySearchText } from "../lib/ai/tierGate";
import type { SearchHit } from "../lib/ai/api";
import { getSettings, prewarmAiForIntent } from "../lib/settings";
import { tierEnablesEmbeddings } from "../lib/ai/types";

export type PaletteMode =
  /** Text-search mode. `initialQuery` (optional) pre-populates the input
   *  — used by S10 tag chips to launch a preset semantic search without
   *  the user having to re-type the tag's natural-language description. */
  | { kind: "search"; initialQuery?: string }
  /** S9 — "files like this" mode. Operates on the seed file's vector. */
  | { kind: "similar"; seedPath: string };

interface CommandPaletteProps {
  open: boolean;
  mode: PaletteMode;
  onClose: () => void;
}

/** Debounce delay for re-querying as the user types. Keeps embedding cost
 *  bounded — each query is one Rust embed call (~50ms warm) but the user
 *  shouldn't trigger one per keystroke. */
const SEARCH_DEBOUNCE_MS = 180;

/** Safety timeout on a search call. The embedder is behind a single
 *  process-wide Mutex; if a background scan is mid-embed of 200 files,
 *  a search would otherwise block behind it for many minutes. After
 *  this, give up and tell the user. The underlying Rust call keeps
 *  running and will complete eventually, but the UI moves on. */
const SEARCH_TIMEOUT_MS = 15_000;

/** Race a promise against a timeout. Resolves with the promise's value
 *  or rejects with the timeout error — whichever happens first. */
function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => { window.clearTimeout(t); resolve(v); },
      (e) => { window.clearTimeout(t); reject(e); },
    );
  });
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(i + 1) : p;
}

function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(0, i) : "";
}

export function CommandPalette({ open, mode, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  // null hits with this flag set means "AI is off / model missing" —
  // distinguishes from "empty array" (cache cold).
  const [tierBlocked, setTierBlocked] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  // Backend reported the embedder mutex was held — typically by a
  // background scan. Distinct from `timedOut` because we know exactly
  // why this one happened and can tell the user to wait + retry.
  const [busyDueToScan, setBusyDueToScan] = useState(false);
  // Backend returned an unexpected error (not "timed out", not "embedder
  // busy"). We surface the message verbatim instead of silently showing
  // "no matches" — which was the source of the "search returned nothing
  // until I backspace+retype" confusion: the first try hit some error,
  // got rendered as empty, the retype fired a fresh search that worked.
  const [unexpectedError, setUnexpectedError] = useState<string | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Open the inspector panel for a result (summary, rename, find-similar all
  // live there now) and close the palette.
  const openInspector = (path: string) => {
    window.dispatchEvent(new CustomEvent("tmp:open-inspector", { detail: { path, kind: "file" } }));
    onClose();
  };

  // Reset state when the palette opens, and auto-focus the input. For
  // similar-mode, the input is read-only and shows the seed filename.
  // Tier-block is checked eagerly from settings so the input is gated
  // from the first frame (no momentary "you can type, oh wait you can't"
  // flicker on tier-off).
  useEffect(() => {
    if (!open) return;
    // S10 tag chips and other preset-query openers can pass an
    // `initialQuery` so the palette opens with the search already
    // primed. The debounced search effect picks this up automatically.
    setQuery(mode.kind === "search" && mode.initialQuery ? mode.initialQuery : "");
    setHits(null);
    setSelectedIdx(0);
    setTimedOut(false);
    setBusyDueToScan(false);
    setUnexpectedError(null);
    const blocked = !tierEnablesEmbeddings(getSettings().aiTier);
    setTierBlocked(blocked);
    if (blocked) return;
    inputRef.current?.focus();

    // Warm the embedder here rather than at app launch. Opening the palette
    // is the earliest reliable signal that a search is coming, and it buys
    // most of the cold-load window back: the user still has to type, and the
    // query is debounced by SEARCH_DEBOUNCE_MS on top of that. Loading at
    // launch instead cost 813 MB for a search that often never happens.
    prewarmAiForIntent("search");

    if (mode.kind === "similar") {
      // Kick the similar search immediately — no user input needed.
      // Race against a watchdog timeout because the embedder Mutex can
      // be held by a background scan for many minutes.
      let cancelled = false;
      setLoading(true);
      withTimeout(
        trySearchSimilar(mode.seedPath, 30),
        SEARCH_TIMEOUT_MS,
        "search timed out",
      )
        .then((r) => {
          if (cancelled) return;
          if (r === null) { setTierBlocked(true); setHits([]); }
          else setHits(r);
        })
        .catch((err) => {
          if (cancelled) return;
          console.warn("[s9] searchSimilar failed:", err);
          const msg = String(err?.message ?? err);
          if (msg.includes("timed out")) setTimedOut(true);
          else if (msg.includes("embedder busy")) setBusyDueToScan(true);
          else setUnexpectedError(msg);
          setHits([]);
        })
        .finally(() => { if (!cancelled) setLoading(false); });
      return () => { cancelled = true; };
    }
  }, [open, mode]);

  // Debounced search-as-you-type for the text-search mode.
  useEffect(() => {
    if (!open || mode.kind !== "search") return;
    const q = query.trim();
    if (q === "") {
      setHits(null); setLoading(false); setTimedOut(false);
      setBusyDueToScan(false); setUnexpectedError(null);
      return;
    }

    let cancelled = false;
    setTimedOut(false);
    setBusyDueToScan(false);
    setUnexpectedError(null);
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      setLoading(true);
      withTimeout(trySearchText(q, 30), SEARCH_TIMEOUT_MS, "search timed out")
        .then((r) => {
          if (cancelled) return;
          if (r === null) { setTierBlocked(true); setHits([]); }
          else { setHits(r); setSelectedIdx(0); }
        })
        .catch((err) => {
          if (cancelled) return;
          console.warn("[s7] searchText failed:", err);
          const msg = String(err?.message ?? err);
          if (msg.includes("timed out")) setTimedOut(true);
          else if (msg.includes("embedder busy")) setBusyDueToScan(true);
          else setUnexpectedError(msg);
          setHits([]);
        })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, SEARCH_DEBOUNCE_MS);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [open, mode.kind, query]);

  // Keyboard navigation: Esc closes, ↑/↓ move selection, Enter opens.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (!hits || hits.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, hits.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const hit = hits[selectedIdx];
        if (hit) openInspector(hit.path);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, hits, selectedIdx, onClose]);

  // Scroll the selected row into view as the user arrows through.
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(
      `[data-result-idx="${selectedIdx}"]`,
    );
    node?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  const headerText = useMemo(() => {
    if (mode.kind === "similar") return `Files like "${basename(mode.seedPath)}"`;
    return "Search your files by content";
  }, [mode]);

  if (!open) return null;

  // Tier-blocked: the palette has nothing to do — no input, no results,
  // just the explainer + an Esc hint. Probe tier state on open so we
  // know up front (saves an unnecessary embed call for an empty cache).
  // The mode-switch effects above also set `tierBlocked` after an actual
  // call returns null; this short-circuits before any of that.
  if (tierBlocked) {
    return (
      <div className="cmd-palette-backdrop" onClick={onClose}>
        <div className="cmd-palette" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Semantic file search">
          <div className="cmd-palette-header">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <span className="cmd-palette-input cmd-palette-disabled-label">
              Semantic file search
            </span>
            <kbd className="cmd-palette-esc">Esc</kbd>
          </div>
          <div className="cmd-palette-empty">
            <strong>AI is not enabled.</strong> Open Settings &rarr; AI and turn
            on Standard to search your files by content.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="cmd-palette-backdrop" onClick={onClose}>
      <div className="cmd-palette" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Semantic file search">
        <div className="cmd-palette-header">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            className="cmd-palette-input"
            placeholder={
              mode.kind === "similar"
                ? "Showing similar files…"
                : "Describe what you're looking for — e.g. \"tax forms\", \"meeting recordings\", \"installers\""
            }
            value={mode.kind === "similar" ? basename(mode.seedPath) : query}
            readOnly={mode.kind === "similar"}
            onChange={(e) => setQuery(e.target.value)}
          />
          {loading && <span className="cmd-palette-spinner" aria-label="Searching" />}
          <kbd className="cmd-palette-esc">Esc</kbd>
        </div>

        <div className="cmd-palette-subhead">
          {headerText}
          <span className="cmd-palette-hint"> · nothing leaves your device</span>
        </div>

        <div className="cmd-palette-results" ref={listRef}>
          {busyDueToScan && !loading && (
            <div className="cmd-palette-empty">
              <strong>The AI is busy.</strong> If the Storage page shows
              <em> "Analyzing documents…"</em>, a scan is using it right now.
              Search frees up again within a few seconds — type another
              character or press Enter to retry.
            </div>
          )}

          {timedOut && !busyDueToScan && !loading && (
            <div className="cmd-palette-empty">
              <strong>Search took too long and was cancelled.</strong> If
              this keeps happening, the AI model may be stuck — try
              restarting the app, or Settings &rarr; AI &rarr; Clear cache
              to reset its state.
            </div>
          )}

          {unexpectedError && !loading && (
            <div className="cmd-palette-empty">
              <strong>Search failed.</strong> Something went wrong:{" "}
              <code style={{ background: "rgba(255,255,255,0.06)", padding: "1px 5px", borderRadius: 3 }}>{unexpectedError}</code>
              {" "}— try again in a moment.
            </div>
          )}

          {!timedOut && !busyDueToScan && !unexpectedError && hits !== null && hits.length === 0 && !loading && (
            <div className="cmd-palette-empty">
              {mode.kind === "search" && query.trim() !== ""
                ? (
                  <>
                    <strong>No matches.</strong> A couple of things to try:
                    <ul style={{ margin: "8px 0 0 18px", padding: 0 }}>
                      <li>Use a few different words.</li>
                      <li>
                        Haven't scanned recently? <strong>Run a Storage
                        scan</strong> — search only knows about files it has
                        seen.
                      </li>
                    </ul>
                  </>
                )
                : (
                  <>
                    <strong>No similar files found.</strong> Try running a
                    Storage scan first, then search again.
                  </>
                )}
            </div>
          )}

          {hits === null && mode.kind === "search" && (
            <div className="cmd-palette-empty cmd-palette-hint">
              Start typing to search your files by what's in them.
            </div>
          )}

          {hits && hits.map((hit, idx) => {
            return (
              <button
                key={hit.path}
                data-result-idx={idx}
                className={`cmd-palette-row${idx === selectedIdx ? " selected" : ""}`}
                onClick={() => openInspector(hit.path)}
                onMouseEnter={() => setSelectedIdx(idx)}
                type="button"
              >
                <span className="cmd-palette-row-name">{basename(hit.path)}</span>
                <span className="cmd-palette-row-dir">{dirOf(hit.path)}</span>
                <span className="cmd-palette-row-score" title={`${(hit.score * 100).toFixed(0)}% similar`}>
                  {(hit.score * 100).toFixed(0)}%
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

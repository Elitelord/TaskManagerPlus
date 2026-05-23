// Phase 4 / S7 — unified scan progress card.
//
// The Storage page used to have two "Rescan" buttons (one in the drive
// breakdown header, one in the Smart Organizer header) and a hidden
// post-scan "Analyzing documents…" indicator buried inside the
// organizer. None of those reflected the actual state of the multi-
// stage scan pipeline, and a search request firing while the post-scan
// embed pass was still running was indistinguishable from "no results."
//
// This component is the single source of truth: it shows which stage
// is currently running, lets the user start a scan, and is the only
// place a scan begins. The constituent stages, in order:
//
//   1. folders — drive folder enumeration ("What's using space on C:")
//   2. organizer — per-user-folder analysis (Smart Organizer)
//   3. semantic — post-scan AI embedding pass for clustering + search
//
// When idle, the card is compact — last-scanned timestamp plus a Scan
// button. When any stage is running, it expands to show all three
// stages with the current one highlighted and a running indicator on it.

import type { ReactNode } from "react";

export type ScanStage = "folders" | "organizer" | "semantic";

export interface ScanProgressProps {
  /** True while the drive folder enumeration is running. */
  foldersRunning: boolean;
  /** True while the Smart Organizer's per-folder analysis is running. */
  organizerRunning: boolean;
  /** True while the post-scan semantic embed pass is running. */
  semanticRunning: boolean;
  /** Timestamp (ms epoch) of the last completed scan, or 0 if never. */
  lastScanTs: number;
  /** Called when the user clicks the Scan button. */
  onScan: () => void;
}

function timeAgoShort(ts: number): string {
  if (ts <= 0) return "never";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

interface StageDescriptor {
  id: ScanStage;
  title: string;
  desc: string;
}

const STAGES: StageDescriptor[] = [
  {
    id: "folders",
    title: "Folder scan",
    desc: "Walking each drive's top-level folders to compute totals.",
  },
  {
    id: "organizer",
    title: "Organizer analysis",
    desc: "Looking through your folders for cleanup and tidy-up suggestions.",
  },
  {
    id: "semantic",
    title: "AI indexing",
    desc: "Reading your documents so search and grouping work. Search is available while this runs.",
  },
];

function stageStatus(
  id: ScanStage,
  current: ScanStage | null,
  finished: Set<ScanStage>,
): "pending" | "running" | "done" {
  if (finished.has(id)) return "done";
  if (current === id) return "running";
  return "pending";
}

function StageRow({
  stage, status, children,
}: {
  stage: StageDescriptor;
  status: "pending" | "running" | "done";
  children?: ReactNode;
}) {
  return (
    <div className={`scan-stage scan-stage-${status}`}>
      <span className="scan-stage-marker" aria-hidden="true">
        {status === "done" && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6L9 17l-5-5" />
          </svg>
        )}
        {status === "running" && <span className="scan-stage-spinner" />}
        {status === "pending" && <span className="scan-stage-dot" />}
      </span>
      <div className="scan-stage-text">
        <div className="scan-stage-title">{stage.title}</div>
        <div className="scan-stage-desc">{stage.desc}</div>
        {children}
      </div>
    </div>
  );
}

export function ScanProgressCard({
  foldersRunning,
  organizerRunning,
  semanticRunning,
  lastScanTs,
  onScan,
}: ScanProgressProps) {
  const anyRunning = foldersRunning || organizerRunning || semanticRunning;

  // Derive current stage and finished-set from the boolean flags. The
  // pipeline runs in order, so when "semantic" is running we know
  // "folders" and "organizer" must have finished — even if their flags
  // already flipped false. (The flags don't carry "has ever run this
  // session" semantics, but we can infer it from later stages.)
  let current: ScanStage | null = null;
  const finished = new Set<ScanStage>();
  if (foldersRunning) current = "folders";
  else if (organizerRunning) { current = "organizer"; finished.add("folders"); }
  else if (semanticRunning) { current = "semantic"; finished.add("folders"); finished.add("organizer"); }

  // Idle, compact view: status line + Scan button.
  if (!anyRunning) {
    return (
      <div className="scan-progress-card scan-progress-card-idle">
        <div className="scan-progress-summary">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
          <span className="scan-progress-label">
            <strong>Storage scan</strong>
            <span className="scan-progress-meta"> · last run {timeAgoShort(lastScanTs)}</span>
          </span>
        </div>
        <div className="scan-progress-actions">
          <button className="btn-sm btn-accent" onClick={onScan}>
            Start scan
          </button>
        </div>
      </div>
    );
  }

  // Active view: expanded stages with progress indicators.
  return (
    <div className="scan-progress-card scan-progress-card-active">
      <div className="scan-progress-header">
        <div className="scan-progress-summary">
          <span className="scan-stage-spinner scan-stage-spinner-large" aria-hidden="true" />
          <span className="scan-progress-label">
            <strong>Scanning…</strong>
            <span className="scan-progress-meta">
              {" "}· {STAGES.find((s) => s.id === current)?.title ?? "Working"}
            </span>
          </span>
        </div>
      </div>
      <div className="scan-progress-stages">
        {STAGES.map((s) => (
          <StageRow key={s.id} stage={s} status={stageStatus(s.id, current, finished)} />
        ))}
      </div>
    </div>
  );
}

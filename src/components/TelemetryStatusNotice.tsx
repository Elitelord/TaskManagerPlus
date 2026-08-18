import { useState } from "react";
import { AlertTriangle, Clock, Copy, Check } from "lucide-react";
import {
  useTelemetryStatus,
  PROBE_LABELS,
  type TelemetryStatus,
} from "../hooks/usePerformanceData";

/**
 * Shown in place of the endless "Loading processes…" spinner when telemetry
 * can't be read. Two failure shapes, both previously invisible to users:
 *
 *  - `error`   — a probe rejected, so we have a concrete reason to show.
 *  - `stalled` — nothing came back at all. A hang throws nothing, so the only
 *                signal is elapsed time plus *which* probes never returned.
 *
 * The goal is that a user can read this, understand roughly what's wrong, and
 * hand us something actionable — hence the copy-to-clipboard details block.
 */

/** Map a raw backend error onto something a non-developer can act on. */
function friendlyCause(detail: string): { cause: string; fix: string } {
  if (/DLL load failed/i.test(detail)) {
    return {
      cause:
        "The system-monitoring component (taskmanager_native.dll) couldn't be loaded.",
      fix: "It may be missing from the install folder, or blocked by antivirus. Reinstalling TaskManager+ usually fixes this.",
    };
  }
  if (/ABI mismatch/i.test(detail)) {
    return {
      cause:
        "The system-monitoring component doesn't match this version of the app.",
      fix: "This usually means a partial update. Reinstalling TaskManager+ will fix it.",
    };
  }
  if (/Symbol .* not found/i.test(detail)) {
    return {
      cause: "The system-monitoring component is out of date or incomplete.",
      fix: "Reinstalling TaskManager+ will replace it.",
    };
  }
  if (/lock/i.test(detail)) {
    return {
      cause: "The system-monitoring component stopped responding.",
      fix: "Restarting TaskManager+ should clear it.",
    };
  }
  return {
    cause: "TaskManager+ couldn't read system information from Windows.",
    fix: "Restarting the app usually helps. If it keeps happening, the details below are worth reporting.",
  };
}

function labelList(names: string[]): string {
  const pretty = names.map(n => PROBE_LABELS[n] ?? n);
  if (pretty.length === 0) return "system data";
  if (pretty.length === 1) return pretty[0];
  if (pretty.length === 2) return `${pretty[0]} and ${pretty[1]}`;
  return `${pretty.slice(0, -1).join(", ")}, and ${pretty[pretty.length - 1]}`;
}

function DetailsBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be unavailable; the text is selectable either way.
    }
  };

  return (
    <div className="telemetry-notice-details">
      <div className="telemetry-notice-details-bar">
        <button
          type="button"
          className="telemetry-notice-link"
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
        >
          {open ? "Hide technical details" : "Show technical details"}
        </button>
        <button type="button" className="telemetry-notice-link" onClick={copy}>
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? "Copied" : "Copy details"}
        </button>
      </div>
      {open && <pre className="telemetry-notice-pre">{text}</pre>}
    </div>
  );
}

function ErrorNotice({ status }: { status: Extract<TelemetryStatus, { kind: "error" }> }) {
  const { cause, fix } = friendlyCause(status.detail);
  return (
    <div className="telemetry-notice telemetry-notice--error" role="alert">
      <div className="telemetry-notice-icon"><AlertTriangle size={22} /></div>
      <h3 className="telemetry-notice-title">Can't read system data</h3>
      <p className="telemetry-notice-body">{cause}</p>
      <p className="telemetry-notice-body telemetry-notice-body--muted">{fix}</p>
      {status.failed.length > 0 && (
        <p className="telemetry-notice-affected">
          Affected: {labelList(status.failed)}
        </p>
      )}
      <DetailsBlock text={status.detail} />
    </div>
  );
}

function StalledNotice({ status }: { status: Extract<TelemetryStatus, { kind: "stalled" }> }) {
  // `pending` is the actual diagnosis: these are the reads that never came
  // back. Naming them turns "the app is frozen" into a specific report.
  const detail =
    `No response after ${status.seconds}s.\n` +
    `Waiting on: ${status.pending.length ? status.pending.join(", ") : "(unknown)"}`;

  return (
    <div className="telemetry-notice telemetry-notice--warn" role="status">
      <div className="telemetry-notice-icon"><Clock size={22} /></div>
      <h3 className="telemetry-notice-title">Still waiting on Windows</h3>
      <p className="telemetry-notice-body">
        TaskManager+ has been waiting {status.seconds} seconds for{" "}
        {labelList(status.pending)} and hasn't had a response.
      </p>
      <p className="telemetry-notice-body telemetry-notice-body--muted">
        This usually means a Windows system service is responding slowly on this
        PC. The app isn't crashed — it's still waiting. Restarting TaskManager+
        may help; if it happens every launch, the details below pinpoint which
        read is stuck.
      </p>
      <DetailsBlock text={detail} />
    </div>
  );
}

/**
 * Renders nothing while things are healthy or still starting up normally —
 * callers show their usual loading state in that case.
 */
export function TelemetryStatusNotice() {
  const status = useTelemetryStatus();
  if (status.kind === "error") return <ErrorNotice status={status} />;
  if (status.kind === "stalled") return <StalledNotice status={status} />;
  return null;
}

/** True when the notice will render something, so callers can swap out spinners. */
export function useHasTelemetryProblem(): boolean {
  const status = useTelemetryStatus();
  return status.kind === "error" || status.kind === "stalled";
}

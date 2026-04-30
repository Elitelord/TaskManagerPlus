import { useState, useCallback } from "react";

interface Props {
  privateMb: number;
  sharedMb: number;
  /** Kernel-exact shared portion of working set for this row (WS − private WS).
   *  Used only for the hover tooltip. Pass 0 (or omit) for synthetic system rows. */
  sharedWsMb?: number;
  maxMb: number;
  displayMode?: "percent" | "values";
  totalSystemMb?: number;
}

export function MemoryBar({
  privateMb,
  sharedMb,
  sharedWsMb = 0,
  maxMb,
  displayMode = "percent",
  totalSystemMb,
}: Props) {
  const scale = maxMb > 0 ? 100 / maxMb : 0;
  const privateWidth = privateMb * scale;
  const sharedWidth = sharedMb * scale;
  const totalMb = privateMb + sharedMb;

  let displayText: string;
  if (displayMode === "values") {
    displayText = `${totalMb.toFixed(1)}`;
  } else {
    const pct = totalSystemMb && totalSystemMb > 0 ? (totalMb / totalSystemMb) * 100 : 0;
    displayText = `${pct.toFixed(1)}%`;
  }

  // Tooltip is positioned with fixed coords so it escapes the .table-body
  // scroll container's clipping. Anchored to the value cell's top-center.
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);

  const handleEnter = useCallback((e: React.MouseEvent<HTMLSpanElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setTooltipPos({ x: rect.left + rect.width / 2, y: rect.top });
  }, []);
  const handleLeave = useCallback(() => setTooltipPos(null), []);

  const showShared = sharedWsMb > 0.5;  // hide for synthetic rows / processes with no shared WS

  return (
    <div className="memory-cell">
      <div className="memory-bar">
        <div className="private" style={{ width: `${privateWidth}%` }} />
        <div className="shared" style={{ width: `${sharedWidth}%` }} />
      </div>
      <span
        className="memory-value memory-value-hoverable"
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
      >
        {displayText}
      </span>
      {tooltipPos && (
        <div
          className="memory-tooltip"
          style={{ left: `${tooltipPos.x}px`, top: `${tooltipPos.y}px` }}
          role="tooltip"
        >
          <div className="memory-tooltip-title">Memory breakdown</div>
          <div className="memory-tooltip-row">
            <span className="memory-tooltip-swatch swatch-private" />
            <span className="memory-tooltip-label">Private</span>
            <span className="memory-tooltip-value">{privateMb.toFixed(1)} MB</span>
          </div>
          {showShared && (
            <>
              <div className="memory-tooltip-row">
                <span className="memory-tooltip-swatch swatch-shared" />
                <span className="memory-tooltip-label">Shared DLLs &amp; runtimes</span>
                <span className="memory-tooltip-value">~{sharedWsMb.toFixed(1)} MB</span>
              </div>
              <div className="memory-tooltip-note">
                Shared bytes are also used by other processes — closing this app may not
                free them all.
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

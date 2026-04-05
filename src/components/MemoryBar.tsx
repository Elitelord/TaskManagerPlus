interface Props {
  privateMb: number;
  sharedMb: number;
  maxMb: number;
  displayMode?: "percent" | "values";
  totalSystemMb?: number;
}

export function MemoryBar({ privateMb, sharedMb, maxMb, displayMode = "percent", totalSystemMb }: Props) {
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

  return (
    <div className="memory-cell">
      <div className="memory-bar">
        <div className="private" style={{ width: `${privateWidth}%` }} />
        <div className="shared" style={{ width: `${sharedWidth}%` }} />
      </div>
      <span className="memory-value">{displayText}</span>
    </div>
  );
}

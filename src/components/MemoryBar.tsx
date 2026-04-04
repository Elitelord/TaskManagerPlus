interface Props {
  privateMb: number;
  sharedMb: number;
  maxMb: number;
}

export function MemoryBar({ privateMb, sharedMb, maxMb }: Props) {
  const scale = maxMb > 0 ? 100 / maxMb : 0;
  const privateWidth = privateMb * scale;
  const sharedWidth = sharedMb * scale;

  return (
    <div className="memory-cell">
      <div className="memory-bar">
        <div className="private" style={{ width: `${privateWidth}%` }} />
        <div className="shared" style={{ width: `${sharedWidth}%` }} />
      </div>
      <span className="memory-value">{(privateMb + sharedMb).toFixed(1)}</span>
    </div>
  );
}

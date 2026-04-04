interface Props {
  percent: number;
}

export function BatteryImpact({ percent }: Props) {
  const level = percent > 10 ? "high" : percent > 3 ? "medium" : "low";

  return (
    <span className={`battery-badge ${level}`}>{percent.toFixed(1)}%</span>
  );
}

import { usePerformanceData, PerformanceHistory } from "../hooks/usePerformanceData";
import { RealtimeGraph } from "./RealtimeGraph";
import { useSettings, GRAPH_HEIGHTS } from "../lib/settings";

interface Props {
  metric: "cpu" | "memory" | "disk" | "network" | "gpu" | "battery";
  height?: number;
  label?: string;
  color?: string;
  fillColor?: string;
}

export function ResourceGraph({ metric, height, label, color, fillColor }: Props) {
  const { historyRef, generationRef } = usePerformanceData();
  const [settings] = useSettings();
  const resolvedHeight = height ?? GRAPH_HEIGHTS[settings.graphSize];

  const getValue = (point: PerformanceHistory) => {
    const s = point.snapshot;
    switch (metric) {
      case "cpu": return s.cpu_usage_percent;
      case "memory": return (s.used_ram_bytes / s.total_ram_bytes) * 100;
      case "disk": return s.disk_read_per_sec + s.disk_write_per_sec;
      case "network": return s.net_send_per_sec + s.net_recv_per_sec;
      case "gpu": return s.gpu_usage_percent;
      case "battery": return s.power_draw_watts;
      default: return 0;
    }
  };

  /**
   * Filter stacked values to only show processes that are significant enough
   * to be visually distinguishable on the graph. This prevents showing 7 tiny
   * slivers when total usage is low.
   */
  const filterBySignificance = (
    procs: { label: string; value: number }[],
    totalValue: number,
    maxScale: number,
    remainderLabel: string,
  ) => {
    // Minimum % of the graph scale a process must occupy to be shown individually
    const minPctOfScale = 1.5; // 1.5% of graph height
    const minValue = (minPctOfScale / 100) * maxScale;

    // Also limit count: more processes shown when usage is higher
    const usageFraction = totalValue / maxScale;
    const maxProcs = usageFraction > 0.5 ? 6 : usageFraction > 0.2 ? 4 : usageFraction > 0.08 ? 3 : 2;

    const significant: typeof procs = [];
    let collapsed = 0;

    // Already sorted by value descending from getTopGrouped
    for (const p of procs) {
      if (significant.length < maxProcs && p.value >= minValue) {
        significant.push(p);
      } else {
        collapsed += p.value;
      }
    }

    if (collapsed > 0.01) {
      significant.push({ label: remainderLabel, value: collapsed });
    }

    return significant;
  };

  // Only memory gets stacked area chart; others use simple line+fill
  const getStackedValues = metric !== "memory" ? undefined : (point: PerformanceHistory) => {
    const totalValue = getValue(point);
    const totalMb = point.snapshot.total_ram_bytes / 1048576;
    const procs = point.topMem.map(m => ({
      label: m.name,
      value: (m.value / totalMb) * 100
    }));
    const procSum = procs.reduce((s, r) => s + r.value, 0);

    // If process sum exceeds total used (private bytes can overlap), scale down proportionally
    if (procSum > totalValue && procSum > 0) {
      const scale = totalValue / procSum;
      for (const p of procs) p.value *= scale;
    }

    const scaledSum = procs.reduce((s, r) => s + r.value, 0);
    const remainder = Math.max(0, totalValue - scaledSum);
    if (remainder > 0.1) procs.push({ label: "System & Shared", value: remainder });
    return filterBySignificance(procs, totalValue, 100, "Other");
  };

  const getMaxValue = () => {
    if (metric === "cpu" || metric === "memory" || metric === "gpu") return 100;
    if (metric === "battery") {
      const data = historyRef.current?.toArray() ?? [];
      let peak = 15;
      for (const d of data) {
        if (d.snapshot.power_draw_watts > peak) peak = d.snapshot.power_draw_watts;
      }
      return Math.ceil(peak * 1.3);
    }
    // For disk and network, compute dynamic max from history
    const data = historyRef.current?.toArray() ?? [];
    if (data.length === 0) return metric === "disk" ? 1048576 : 102400;
    let peak = 0;
    for (const d of data) {
      const val = getValue(d);
      if (val > peak) peak = val;
    }
    return Math.max(peak * 1.2, metric === "disk" ? 1048576 : 102400);
  };

  const getUnit = () => {
    if (metric === "cpu" || metric === "memory" || metric === "gpu") return "percent" as const;
    if (metric === "battery") return "watts" as const;
    return undefined;
  };

  return (
    <RealtimeGraph
      historyRef={historyRef}
      generationRef={generationRef}
      getValue={getValue}
      getStackedValues={getStackedValues}
      maxValue={getMaxValue()}
      unit={getUnit()}
      height={resolvedHeight}
      label={label || metric.toUpperCase()}
      color={color}
      fillColor={fillColor}
      showLegend={metric === "memory"}
    />
  );
}

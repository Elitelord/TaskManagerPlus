import type { RefObject } from "react";
import { useMemo } from "react";
import { usePerformanceData, type PerformanceHistory } from "../hooks/usePerformanceData";
import { RealtimeGraph } from "./RealtimeGraph";
import { useSettings, GRAPH_HEIGHTS } from "../lib/settings";
import type { RingBuffer } from "../lib/ringBuffer";

export interface ResourceGraphProps {
  metric: "cpu" | "memory" | "disk" | "network" | "gpu" | "npu" | "battery";
  height?: number;
  label?: string;
  color?: string;
  fillColor?: string;
  /**
   * When the parent already calls `usePerformanceData()`, pass `historyRef` and `generationRef`
   * so this graph does not add a second per-tick subscription.
   */
  historyRef?: RefObject<RingBuffer<PerformanceHistory>>;
  generationRef?: RefObject<number>;
}

function filterBySignificance(
  procs: { label: string; value: number }[],
  totalValue: number,
  maxScale: number,
  remainderLabel: string,
) {
  const minPctOfScale = 1.5;
  const minValue = (minPctOfScale / 100) * maxScale;
  const usageFraction = totalValue / maxScale;
  const maxProcs = usageFraction > 0.5 ? 6 : usageFraction > 0.2 ? 4 : usageFraction > 0.08 ? 3 : 2;

  const significant: typeof procs = [];
  let collapsed = 0;

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
}

function makeGetValue(metric: ResourceGraphProps["metric"]) {
  return (point: PerformanceHistory) => {
    const s = point.snapshot;
    switch (metric) {
      case "cpu": return s.cpu_usage_percent;
      case "memory": return (s.used_ram_bytes / s.total_ram_bytes) * 100;
      case "disk": return s.disk_read_per_sec + s.disk_write_per_sec;
      case "network": return s.net_send_per_sec + s.net_recv_per_sec;
      case "gpu": return s.gpu_usage_percent;
      case "npu": return s.npu_usage_percent;
      case "battery": return s.power_draw_watts;
      default: return 0;
    }
  };
}

function makeGetStackedValues(metric: ResourceGraphProps["metric"]) {
  if (metric !== "memory") return undefined;
  return (point: PerformanceHistory) => {
    const totalValue = (point.snapshot.used_ram_bytes / point.snapshot.total_ram_bytes) * 100;
    const totalMb = point.snapshot.total_ram_bytes / 1048576;
    const procs = point.topMem.map(m => ({
      label: m.name,
      value: (m.value / totalMb) * 100,
    }));
    const procSum = procs.reduce((s, r) => s + r.value, 0);

    if (procSum > totalValue && procSum > 0) {
      const scale = totalValue / procSum;
      for (const p of procs) p.value *= scale;
    }

    const scaledSum = procs.reduce((s, r) => s + r.value, 0);
    const remainder = Math.max(0, totalValue - scaledSum);
    if (remainder > 0.1) procs.push({ label: "System & Shared", value: remainder });
    return filterBySignificance(procs, totalValue, 100, "Other");
  };
}

function computeMaxValue(
  metric: ResourceGraphProps["metric"],
  historyRef: RefObject<RingBuffer<PerformanceHistory>>,
) {
  if (metric === "cpu" || metric === "memory" || metric === "gpu" || metric === "npu") return 100;
  if (metric === "battery") {
    const data = historyRef.current?.toArray() ?? [];
    let peak = 15;
    for (const d of data) {
      if (d.snapshot.power_draw_watts > peak) peak = d.snapshot.power_draw_watts;
    }
    return Math.ceil(peak * 1.3);
  }
  const data = historyRef.current?.toArray() ?? [];
  const getVal = makeGetValue(metric);
  if (data.length === 0) return metric === "disk" ? 1048576 : 102400;
  let peak = 0;
  for (const d of data) {
    const val = getVal(d);
    if (val > peak) peak = val;
  }
  return Math.max(peak * 1.2, metric === "disk" ? 1048576 : 102400);
}

function resolveUnit(metric: ResourceGraphProps["metric"], maxValue: number) {
  if (metric === "cpu" || metric === "memory" || metric === "gpu" || metric === "npu") return "percent" as const;
  if (metric === "battery") return "watts" as const;
  return maxValue === 100 ? ("percent" as const) : ("bytes" as const);
}

function ResourceGraphCore({
  historyRef,
  generationRef,
  metric,
  height,
  label,
  color,
  fillColor,
}: Omit<ResourceGraphProps, "historyRef" | "generationRef"> & {
  historyRef: RefObject<RingBuffer<PerformanceHistory>>;
  generationRef?: RefObject<number>;
}) {
  const [settings] = useSettings();
  const resolvedHeight = height ?? GRAPH_HEIGHTS[settings.graphSize];

  const getValue = useMemo(() => makeGetValue(metric), [metric]);
  const getStackedValues = useMemo(() => makeGetStackedValues(metric), [metric]);
  const maxValue = useMemo(() => computeMaxValue(metric, historyRef), [metric, historyRef]);
  const unit = useMemo(() => resolveUnit(metric, maxValue), [metric, maxValue]);

  return (
    <RealtimeGraph
      historyRef={historyRef}
      generationRef={generationRef}
      getValue={getValue}
      getStackedValues={getStackedValues}
      maxValue={maxValue}
      unit={unit}
      height={resolvedHeight}
      label={label || metric.toUpperCase()}
      color={color}
      fillColor={fillColor}
      showLegend={metric === "memory"}
    />
  );
}

function ResourceGraphSubscribed(props: Omit<ResourceGraphProps, "historyRef" | "generationRef">) {
  const { historyRef, generationRef } = usePerformanceData();
  return <ResourceGraphCore {...props} historyRef={historyRef} generationRef={generationRef} />;
}

export function ResourceGraph(props: ResourceGraphProps) {
  const { historyRef, generationRef, ...rest } = props;
  if (historyRef) {
    return <ResourceGraphCore {...rest} historyRef={historyRef} generationRef={generationRef} />;
  }
  return <ResourceGraphSubscribed {...rest} />;
}

import type { RefObject } from "react";
import { useMemo } from "react";
import { usePerformanceData, type PerformanceHistory } from "../hooks/usePerformanceData";
import { RealtimeGraph } from "./RealtimeGraph";
import { useSettings, GRAPH_HEIGHTS } from "../lib/settings";
import {
  MEMORY_CACHE_TIER_COLORS,
  MEMORY_CACHED_FILES_AGGREGATE_COLOR,
  MEMORY_GPU_SHARED_SEGMENT_COLOR,
  MEMORY_KERNEL_SEGMENT_COLOR,
  MEMORY_MOD_PAGES_SEGMENT_COLOR,
} from "../lib/memoryCompositionColors";
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

const OTHER_ROLLUP_LABEL = "Other";
const DISPLAY_TOP_SEGMENTS = 5;
const OTHER_ROLLUP_COLOR = "#71717a";

type MemSeg = { label: string; value: number; color: string };

type SegmentColors = {
  cacheActive: string;
  cacheLaunch: string;
  cacheIdle: string;
  kernel: string;
  gpu: string;
  modPages: string;
  sharedOther: string;
};

function colorForAppLabel(label: string, palette: string[]): string {
  let h = 2166136261;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return palette[Math.abs(h | 0) % palette.length];
}

/** Full decomposition for one tick (apps + system); values are % of total RAM. */
function buildFullSegmentList(
  point: PerformanceHistory,
  palette: string[],
  colorOpts: SegmentColors,
): MemSeg[] {
  const s = point.snapshot;
  const totalB = s.total_ram_bytes;
  if (totalB <= 0) return [];
  const toPct = (b: number) => (b / totalB) * 100;
  const usedB = s.used_ram_bytes;
  const MB = 1048576;

  const kernelB = s.paged_pool_bytes + s.non_paged_pool_bytes;
  const cacheIdleB = s.cache_idle_bytes;
  const cacheActiveB = s.cache_active_bytes;
  const cacheLaunchB = s.cache_launch_bytes;
  const hasCacheBreakdown = (cacheIdleB + cacheActiveB + cacheLaunchB) > 0;
  const cacheTotalB = hasCacheBreakdown
    ? cacheIdleB + cacheActiveB + cacheLaunchB
    : s.cached_bytes;
  const modPagesB = s.modified_pages_bytes;
  const gpuSharedB = s.gpu_shared_memory_used;
  const namedSystemB = kernelB + cacheTotalB + modPagesB + gpuSharedB;

  const appBudgetB = Math.max(0, usedB - namedSystemB);

  const topApps = point.topMem.slice().sort((a, b) => b.value - a.value);
  const sumAppB = topApps.reduce((acc, a) => acc + a.value, 0) * MB;

  let scale = 1;
  if (sumAppB > appBudgetB && sumAppB > 0) scale = appBudgetB / sumAppB;
  const scaledAppBytes = topApps.map(a => ({
    label: a.name,
    bytes: a.value * MB * scale,
  }));
  const scaledSumB = scaledAppBytes.reduce((acc, a) => acc + a.bytes, 0);
  const sharedOtherB = Math.max(0, appBudgetB - scaledSumB);

  const segments: MemSeg[] = [];

  for (const a of scaledAppBytes) {
    segments.push({
      label: a.label,
      value: toPct(a.bytes),
      color: colorForAppLabel(a.label, palette),
    });
  }
  if (sharedOtherB > 0) {
    segments.push({
      label: "Shared & Other",
      value: toPct(sharedOtherB),
      color: colorOpts.sharedOther,
    });
  }

  segments.push({ label: "Kernel memory", value: toPct(kernelB), color: colorOpts.kernel });
  if (hasCacheBreakdown) {
    segments.push(
      { label: "Recent files in RAM", value: toPct(cacheActiveB), color: colorOpts.cacheActive },
      { label: "App quick-launch cache", value: toPct(cacheLaunchB), color: colorOpts.cacheLaunch },
      { label: "Free-to-reuse disk cache", value: toPct(cacheIdleB), color: colorOpts.cacheIdle },
    );
  } else {
    segments.push({
      label: "Cached files",
      value: toPct(cacheTotalB),
      color: MEMORY_CACHED_FILES_AGGREGATE_COLOR,
    });
  }
  segments.push(
    { label: "Pending disk writes", value: toPct(modPagesB), color: colorOpts.modPages },
    { label: "GPU shared memory", value: toPct(gpuSharedB), color: colorOpts.gpu },
  );

  return segments;
}

type FixedPlan = {
  top5: Set<string>;
  orderedLabels: string[];
  colorByLabel: Map<string, string>;
};

function computeFixedPlan(latest: PerformanceHistory, palette: string[], colorOpts: SegmentColors): FixedPlan {
  const full = buildFullSegmentList(latest, palette, colorOpts);
  const sorted = [...full].sort((a, b) =>
    b.value - a.value || a.label.localeCompare(b.label),
  );
  const top5Segs = sorted.slice(0, DISPLAY_TOP_SEGMENTS);
  const restSum = sorted.slice(DISPLAY_TOP_SEGMENTS).reduce((s, x) => s + x.value, 0);
  const top5 = new Set(top5Segs.map(t => t.label));

  const display: MemSeg[] = [...top5Segs];
  display.push({
    label: OTHER_ROLLUP_LABEL,
    value: restSum,
    color: OTHER_ROLLUP_COLOR,
  });
  display.sort((a, b) => b.value - a.value);

  const colorByLabel = new Map<string, string>();
  for (const s of display) {
    colorByLabel.set(s.label, s.color);
  }

  return {
    top5,
    orderedLabels: display.map(d => d.label),
    colorByLabel,
  };
}

function projectPointWithFixedPlan(
  point: PerformanceHistory,
  plan: FixedPlan,
  palette: string[],
  colorOpts: SegmentColors,
) {
  const full = buildFullSegmentList(point, palette, colorOpts);
  let otherVal = 0;
  for (const s of full) {
    if (!plan.top5.has(s.label)) otherVal += s.value;
  }

  const out: { label: string; value: number; color?: string }[] = [];
  for (const lbl of plan.orderedLabels) {
    if (lbl === OTHER_ROLLUP_LABEL) {
      out.push({
        label: lbl,
        value: otherVal,
        color: plan.colorByLabel.get(lbl),
      });
    } else {
      const seg = full.find(x => x.label === lbl);
      out.push({
        label: lbl,
        value: seg?.value ?? 0,
        color: plan.colorByLabel.get(lbl) ?? seg?.color,
      });
    }
  }
  return out;
}

/**
 * Memory graph: five largest contributors plus one "Other" rollup, stacked with
 * the largest usage at the bottom. The five names are chosen from the latest
 * sample so the legend stays stable over the visible history.
 */
function makeMemoryStackedValues(getLatest: () => PerformanceHistory | null) {
  const palette = [
    "#60a5fa", "#34d399", "#fb923c", "#f87171", "#22d3ee", "#a3e635", "#f472b6",
    "#fbbf24", "#0d9488", "#94a3b8", "#2dd4bf", "#06b6d4", "#ec4899",
  ];
  const colorOpts: SegmentColors = {
    cacheActive: MEMORY_CACHE_TIER_COLORS.recentFiles,
    cacheLaunch: MEMORY_CACHE_TIER_COLORS.quickLaunch,
    cacheIdle: MEMORY_CACHE_TIER_COLORS.freeToReuse,
    kernel: MEMORY_KERNEL_SEGMENT_COLOR,
    gpu: MEMORY_GPU_SHARED_SEGMENT_COLOR,
    modPages: MEMORY_MOD_PAGES_SEGMENT_COLOR,
    sharedOther: "rgba(148, 163, 184, 0.65)",
  };

  let cachedTs = -1;
  let cachedPlan: FixedPlan | null = null;

  return (point: PerformanceHistory) => {
    const latest = getLatest();
    if (!latest?.snapshot?.total_ram_bytes || !point.snapshot?.total_ram_bytes) return [];

    if (latest.timestamp !== cachedTs) {
      cachedTs = latest.timestamp;
      cachedPlan = computeFixedPlan(latest, palette, colorOpts);
    }
    if (!cachedPlan) return [];

    return projectPointWithFixedPlan(point, cachedPlan, palette, colorOpts);
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
  const getStackedValues = useMemo(
    () =>
      metric === "memory"
        ? makeMemoryStackedValues(() => {
            const arr = historyRef.current?.toArray() ?? [];
            return arr.length ? arr[arr.length - 1] : null;
          })
        : undefined,
    [metric, historyRef],
  );
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

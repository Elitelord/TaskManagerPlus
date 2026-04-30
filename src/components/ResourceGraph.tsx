import type { RefObject } from "react";
import { useMemo } from "react";
import { usePerformanceData, type PerformanceHistory } from "../hooks/usePerformanceData";
import { RealtimeGraph } from "./RealtimeGraph";
import { useSettings, GRAPH_HEIGHTS, hexToRgba } from "../lib/settings";
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

/**
 * Memory composition stacker. The graph stacks two kinds of bands:
 *
 *   - Per-app bands     : top processes by working-set memory (so users can
 *                         see which app is responsible for a spike).
 *   - System buckets    : the same buckets surfaced on the Memory page
 *                         composition bar AND on the Processes page synthetic
 *                         system rows, so the three views agree:
 *                           Kernel memory       (paged + non-paged pool)
 *                           Recent files in RAM (cache_active_bytes)
 *                           App quick-launch    (cache_launch_bytes)
 *                           Free-to-reuse cache (cache_idle_bytes)
 *                           Cached files        (fallback if no breakdown)
 *                           Pending disk writes (modified_pages_bytes)
 *                           GPU shared memory   (gpu_shared_memory_used)
 *
 * The named system buckets get fixed colors that match the composition bar.
 * Per-app bands fall back to RealtimeGraph's palette so different apps end up
 * visually distinct. The "Shared & Other" residual covers shared DLL pages and
 * anything Windows counts as in-use but doesn't attribute to a single process.
 *
 * All values are percent of total RAM. Total y-axis target is `getValue` =
 * (used/total)*100, and our stack-sum equals that by construction:
 *   apps_after_scaling + sharedAndOther + namedSystemBuckets == used.
 */
function makeMemoryStackedValues(accent: string) {
  const cacheActiveColor = hexToRgba(accent, 0.40);
  const cacheLaunchColor = hexToRgba(accent, 0.28);
  const cacheIdleColor = hexToRgba(accent, 0.55);
  const kernelColor = "#a78bfa";
  const gpuSharedColor = "#f59e0b";
  const modPagesColor = "#0ea5e9";
  const sharedOtherColor = "rgba(148, 163, 184, 0.65)";  // neutral slate

  // Cap per-app bands to avoid a 12-row legend; pick top N by current memory.
  // 5 leaves room for ~5 system bands on the busiest tick without crowding.
  const MAX_APP_BANDS = 5;

  return (point: PerformanceHistory) => {
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

    // Budget for app bands + shared-other = used minus everything explicitly
    // attributed to a system bucket. Clamp ≥0 in case the snapshot's named
    // buckets briefly over-account (rare, but the math allows it).
    const appBudgetB = Math.max(0, usedB - namedSystemB);

    // Pick top-N apps by current working-set memory. topMem entries are MB.
    const topApps = point.topMem
      .slice()
      .sort((a, b) => b.value - a.value)
      .slice(0, MAX_APP_BANDS);
    const sumAppB = topApps.reduce((s, a) => s + a.value, 0) * MB;

    // If the top apps' working sets exceed the app budget (working sets
    // double-count shared DLLs across processes), scale down proportionally
    // so apps fit inside the budget. The remaining gap is the "Shared & Other"
    // bucket: shared DLL pages, GPU carveouts, and anything the OS counts as
    // in-use but doesn't attribute to a single PID.
    let scale = 1;
    if (sumAppB > appBudgetB && sumAppB > 0) scale = appBudgetB / sumAppB;
    const scaledAppBytes = topApps.map(a => ({
      label: a.name,
      bytes: a.value * MB * scale,
    }));
    const scaledSumB = scaledAppBytes.reduce((s, a) => s + a.bytes, 0);
    const sharedOtherB = Math.max(0, appBudgetB - scaledSumB);

    const segments: { label: string; value: number; color?: string }[] = [];

    // Apps go first (bottom of the stack) so spikes from a single app are
    // easy to spot at the bottom of the chart.
    for (const a of scaledAppBytes) {
      segments.push({ label: a.label, value: toPct(a.bytes) });
    }
    if (sharedOtherB > 0.5 * MB) {
      segments.push({ label: "Shared & Other", value: toPct(sharedOtherB), color: sharedOtherColor });
    }

    // System buckets above. Color matches the composition bar.
    segments.push({ label: "Kernel memory", value: toPct(kernelB), color: kernelColor });
    if (hasCacheBreakdown) {
      segments.push(
        { label: "Recent files in RAM", value: toPct(cacheActiveB), color: cacheActiveColor },
        { label: "App quick-launch cache", value: toPct(cacheLaunchB), color: cacheLaunchColor },
        { label: "Free-to-reuse disk cache", value: toPct(cacheIdleB), color: cacheIdleColor },
      );
    } else {
      segments.push({ label: "Cached files", value: toPct(cacheTotalB), color: cacheActiveColor });
    }
    segments.push(
      { label: "Pending disk writes", value: toPct(modPagesB), color: modPagesColor },
      { label: "GPU shared memory", value: toPct(gpuSharedB), color: gpuSharedColor },
    );

    // Per-app bands always show (top N by working set is the user's signal).
    // System bands only show when meaningful: 1.5% of total RAM is roughly
    // 240 MB on 16 GB / 480 MB on 32 GB — small enough to surface real spikes
    // but large enough to keep the legend from being a wall of 0.x% buckets.
    // The "Shared & Other" residual gets the same gate; if everything fits
    // inside top apps + named system, we don't bother showing it.
    const SYSTEM_MIN_PCT = 1.5;
    const APP_NAMES = new Set(scaledAppBytes.map(a => a.label));
    return segments.filter(seg => {
      if (APP_NAMES.has(seg.label)) return seg.value > 0.05;
      return seg.value >= SYSTEM_MIN_PCT;
    });
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
  // Memory is the only metric with a stacked breakdown; we now stack by system
  // memory bucket (matches the composition bar on the Memory page) instead of
  // by top processes. Accent feeds the "Apps & shared libraries" band color so
  // the graph and the composition bar use the same hue per band.
  const getStackedValues = useMemo(
    () => (metric === "memory" ? makeMemoryStackedValues(settings.accentColor) : undefined),
    [metric, settings.accentColor],
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

import type { ReactNode, RefObject } from "react";
import { useMemo } from "react";
import { usePerformanceData, type PerformanceHistory } from "../hooks/usePerformanceData";
import { RealtimeGraph } from "./RealtimeGraph";
import { useSettings, GRAPH_HEIGHTS } from "../lib/settings";
import {
  MEMORY_APPS_SEGMENT_COLOR,
  MEMORY_CACHE_TIER_COLORS,
  MEMORY_CACHED_FILES_AGGREGATE_COLOR,
  MEMORY_GPU_SHARED_SEGMENT_COLOR,
  MEMORY_KERNEL_SEGMENT_COLOR,
  MEMORY_MOD_PAGES_SEGMENT_COLOR,
} from "../lib/memoryCompositionColors";
import type { RingBuffer } from "../lib/ringBuffer";
import { netBatteryPower } from "../lib/batteryNet";
import { seriesNeutral, shadesOf } from "../lib/seriesPalette";

export type BatteryGraphMode = "net" | "system_draw";

export interface ResourceGraphProps {
  metric: "cpu" | "memory" | "disk" | "network" | "gpu" | "gpuCombined" | "gpu3d" | "gpuCompute" | "npu" | "battery";
  /** Battery tab only: net signed power vs total estimated system draw (always ≥ 0). */
  batteryMode?: BatteryGraphMode;
  height?: number;
  label?: string;
  color?: string;
  fillColor?: string;
  /** When set, Y-axis eases when this value changes (e.g. GPU graph mode switch). */
  yScaleAnimationKey?: string | number;
  /**
   * When the parent already calls `usePerformanceData()`, pass `historyRef` and `generationRef`
   * so this graph does not add a second per-tick subscription.
   */
  historyRef?: RefObject<RingBuffer<PerformanceHistory>>;
  generationRef?: RefObject<number>;
  headerAccessory?: ReactNode;
}

function makeGetValue(metric: ResourceGraphProps["metric"], batteryMode?: BatteryGraphMode) {
  return (point: PerformanceHistory) => {
    const s = point.snapshot;
    switch (metric) {
      case "cpu": return s.cpu_usage_percent;
      case "memory": return (s.used_ram_bytes / s.total_ram_bytes) * 100;
      case "disk": return s.disk_read_per_sec + s.disk_write_per_sec;
      case "network": return s.net_send_per_sec + s.net_recv_per_sec;
      case "gpu": return s.gpu_usage_percent;
      case "gpuCombined": return s.gpu_engine_sum_percent;
      case "gpu3d": return s.gpu_usage_3d_percent;
      case "gpuCompute": return s.gpu_usage_compute_percent;
      case "npu": return s.npu_usage_percent;
      case "battery":
        return batteryMode === "system_draw" ? s.power_draw_watts : netBatteryPower(s);
      default: return 0;
    }
  };
}

const OTHER_ROLLUP_LABEL = "Other";
const DISPLAY_TOP_SEGMENTS = 5;

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

/**
 * Individual apps get shades of the fixed "user / process RAM" blue.
 *
 * The rainbow this replaced was an FNV-1a hash of the process name into an
 * unrelated 13-hue palette, so "chrome.exe" being pink meant nothing and could
 * land next to the kernel purple or the GPU orange. Shading one hue instead
 * makes the read immediate: the blue family is your apps, every other hue is a
 * system bucket — which is exactly the split memoryCompositionColors.ts
 * already declares for the composition bar, so the two now agree.
 *
 * MEMORY_APPS_SEGMENT_COLOR rather than the user accent, for the reason given
 * in that file: the accent is user-selectable and would collide with kernel
 * purple, GPU orange or a cache tier on some presets.
 *
 * Still hashed rather than ranked: colors are pinned per label across the
 * whole rendered history, and apps swap ranks between ticks, so a rank-ordered
 * ramp would make the bands flicker. Hashing keeps a given app's shade stable.
 */
const APP_RAMP_STEPS = 6;

function colorForAppLabel(label: string): string {
  let h = 2166136261;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return shadesOf(MEMORY_APPS_SEGMENT_COLOR, Math.abs(h | 0) % APP_RAMP_STEPS, APP_RAMP_STEPS);
}

/** Full decomposition for one tick (apps + system); values are % of total RAM. */
function buildFullSegmentList(
  point: PerformanceHistory,
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
      color: colorForAppLabel(a.label),
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

function computeFixedPlan(latest: PerformanceHistory, colorOpts: SegmentColors): FixedPlan {
  const full = buildFullSegmentList(latest, colorOpts);
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
    color: seriesNeutral(),
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
  colorOpts: SegmentColors,
) {
  const full = buildFullSegmentList(point, colorOpts);
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
  // The 13-hue palette that used to live here (a near-duplicate of another
  // 12-hue array in RealtimeGraph) is gone: it only fed colorForAppLabel, and
  // app segments are now drawn from the neutral ramp.
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
      cachedPlan = computeFixedPlan(latest, colorOpts);
    }
    if (!cachedPlan) return [];

    return projectPointWithFixedPlan(point, cachedPlan, colorOpts);
  };
}

function computeMaxValue(
  metric: ResourceGraphProps["metric"],
  historyRef: RefObject<RingBuffer<PerformanceHistory>>,
  batteryMode?: BatteryGraphMode,
) {
  if (metric === "gpuCombined") {
    const data = historyRef.current?.toArray() ?? [];
    const getVal = makeGetValue("gpuCombined");
    let peak = 100;
    for (const d of data) {
      const v = getVal(d);
      if (v > peak) peak = v;
    }
    return Math.max(100, Math.ceil(peak * 1.12));
  }
  if (metric === "cpu" || metric === "memory" || metric === "gpu" || metric === "gpu3d" || metric === "gpuCompute" || metric === "npu") return 100;
  if (metric === "battery") {
    const data = historyRef.current?.toArray() ?? [];
    let peak = 5;
    if (batteryMode === "system_draw") {
      for (const d of data) {
        const v = d.snapshot.power_draw_watts;
        if (v > peak) peak = v;
      }
    } else {
      for (const d of data) {
        const a = Math.abs(netBatteryPower(d.snapshot));
        if (a > peak) peak = a;
      }
    }
    return Math.max(5, Math.ceil(peak * 1.3));
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
  if (metric === "cpu" || metric === "memory" || metric === "gpu" || metric === "gpuCombined" || metric === "gpu3d" || metric === "gpuCompute" || metric === "npu") return "percent" as const;
  if (metric === "battery") return "watts" as const;
  return maxValue === 100 ? ("percent" as const) : ("bytes" as const);
}

function ResourceGraphCore({
  historyRef,
  generationRef,
  metric,
  batteryMode = "net",
  height,
  label,
  color,
  fillColor,
  headerAccessory,
  yScaleAnimationKey: yScaleAnimationKeyProp,
}: Omit<ResourceGraphProps, "historyRef" | "generationRef"> & {
  historyRef: RefObject<RingBuffer<PerformanceHistory>>;
  generationRef?: RefObject<number>;
}) {
  const [settings] = useSettings();
  const resolvedHeight = height ?? GRAPH_HEIGHTS[settings.graphSize];

  const getValue = useMemo(() => makeGetValue(metric, metric === "battery" ? batteryMode : undefined), [metric, batteryMode]);
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
  const maxValue = computeMaxValue(metric, historyRef, metric === "battery" ? batteryMode : undefined);
  const unit = resolveUnit(metric, maxValue);
  const yScaleAnimationKey =
    yScaleAnimationKeyProp !== undefined
      ? yScaleAnimationKeyProp
      : metric === "battery"
        ? batteryMode
        : undefined;

  const batterySemantic =
    metric === "battery"
      ? batteryMode === "system_draw"
        ? {
            color: "#a78bfa",
            fillColor: "rgba(167,139,250,0.15)",
          }
        : {
            bipolar: true as const,
            bipolarAreaFill: false as const,
            positiveColor: "#34d399",
            negativeColor: "#ef4444",
          }
      : {};

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
      headerAccessory={headerAccessory}
      yScaleAnimationKey={yScaleAnimationKey}
      {...batterySemantic}
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

import { usePerformanceData, PerformanceHistory } from "../hooks/usePerformanceData";
import { RealtimeGraph } from "./RealtimeGraph";

interface Props {
  metric: "cpu" | "memory" | "disk" | "network" | "gpu" | "battery";
  height?: number;
  label?: string;
  color?: string;
  fillColor?: string;
}

export function ResourceGraph({ metric, height = 200, label, color, fillColor }: Props) {
  const { historyRef, generationRef } = usePerformanceData();

  const getValue = (point: PerformanceHistory) => {
    const s = point.snapshot;
    switch (metric) {
      case "cpu": return s.cpu_usage_percent;
      case "memory": return (s.used_ram_bytes / s.total_ram_bytes) * 100;
      case "disk": return s.disk_read_per_sec + s.disk_write_per_sec;
      case "network": return s.net_send_per_sec + s.net_recv_per_sec;
      case "gpu": return s.gpu_usage_percent;
      case "battery": return s.battery_percent;
      default: return 0;
    }
  };

  const getStackedValues = metric === "gpu" ? undefined : (point: PerformanceHistory) => {
    const totalValue = getValue(point);

    switch (metric) {
      case "cpu": {
        const procs = point.topCpu.map(p => ({ label: p.name, value: p.value }));
        const procSum = procs.reduce((s, r) => s + r.value, 0);
        const remainder = Math.max(0, totalValue - procSum);
        if (remainder > 0.1) procs.push({ label: "System", value: remainder });
        return procs;
      }
      case "memory": {
        const totalMb = point.snapshot.total_ram_bytes / 1048576;
        // topMem uses private_mb — convert to % of total for the graph
        const procs = point.topMem.map(m => ({
          label: m.name,
          value: (m.value / totalMb) * 100
        }));
        const procSum = procs.reduce((s, r) => s + r.value, 0);
        const remainder = Math.max(0, totalValue - procSum);
        if (remainder > 0.1) procs.push({ label: "System & Shared", value: remainder });
        return procs;
      }
      case "disk": {
        const procs = point.topDisk.map(d => ({ label: d.name, value: d.value }));
        const procSum = procs.reduce((s, r) => s + r.value, 0);
        const remainder = Math.max(0, totalValue - procSum);
        if (remainder > 0.1) procs.push({ label: "System", value: remainder });
        return procs;
      }
      case "network": {
        const procs = point.topNet.map(n => ({ label: n.name, value: n.value }));
        const procSum = procs.reduce((s, r) => s + r.value, 0);
        const remainder = Math.max(0, totalValue - procSum);
        if (remainder > 0.1) procs.push({ label: "System", value: remainder });
        return procs;
      }
      case "battery": {
        const procs = point.topPower.map(p => ({ label: p.name, value: p.value }));
        const procSum = procs.reduce((s, r) => s + r.value, 0);
        const systemDraw = point.snapshot.power_draw_watts;
        const remainder = Math.max(0, systemDraw - procSum);
        if (remainder > 0.01) procs.push({ label: "System", value: remainder });
        return procs;
      }
      default: return [];
    }
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

  // For battery stacked graph, override getValue to show power_draw_watts (not charge %)
  const getValueForGraph = metric === "battery" && getStackedValues
    ? (point: PerformanceHistory) => point.snapshot.power_draw_watts
    : getValue;

  const getUnit = () => {
    if (metric === "cpu" || metric === "memory" || metric === "gpu") return "percent" as const;
    if (metric === "battery" && getStackedValues) return "watts" as const;
    return undefined;
  };

  return (
    <RealtimeGraph
      historyRef={historyRef}
      generationRef={generationRef}
      getValue={getValueForGraph}
      getStackedValues={getStackedValues}
      maxValue={getMaxValue()}
      unit={getUnit()}
      height={height}
      label={label || metric.toUpperCase()}
      color={color}
      fillColor={fillColor}
    />
  );
}

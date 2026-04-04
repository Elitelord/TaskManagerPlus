import { SparklineCanvas } from "./SparklineCanvas";
import type { RingBuffer } from "../lib/ringBuffer";
import type { PerformanceHistory } from "../hooks/usePerformanceData";
import type { PerformanceSnapshot } from "../lib/types";

export type ResourcePanel = "cpu" | "memory" | "disk" | "network" | "gpu" | "battery";

interface Props {
  activePanel: ResourcePanel;
  onPanelChange: (panel: ResourcePanel) => void;
  current: PerformanceSnapshot | undefined;
  historyRef: React.RefObject<RingBuffer<PerformanceHistory>>;
  generationRef: React.RefObject<number>;
}

function formatRate(bps: number): string {
  if (bps < 1024) return `${bps.toFixed(0)} B/s`;
  if (bps < 1048576) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / 1048576).toFixed(1)} MB/s`;
}

export function PerformanceSidebar({ activePanel, onPanelChange, current, historyRef, generationRef }: Props) {
  const items: { id: ResourcePanel; label: string; value: string; color: string; getValue: (p: PerformanceHistory) => number; maxValue: number }[] = [
    {
      id: "cpu", label: "CPU",
      value: `${(current?.cpu_usage_percent ?? 0).toFixed(0)}%`,
      color: "#4a9eff",
      getValue: (p) => p.snapshot.cpu_usage_percent,
      maxValue: 100,
    },
    {
      id: "memory", label: "Memory",
      value: current ? `${(current.used_ram_bytes / 1073741824).toFixed(1)}/${(current.total_ram_bytes / 1073741824).toFixed(1)} GB` : "--",
      color: "#9b59b6",
      getValue: (p) => (p.snapshot.used_ram_bytes / p.snapshot.total_ram_bytes) * 100,
      maxValue: 100,
    },
    {
      id: "disk", label: "Disk",
      value: current ? formatRate(current.disk_read_per_sec + current.disk_write_per_sec) : "--",
      color: "#2ecc71",
      getValue: (p) => p.snapshot.disk_active_percent,
      maxValue: 100,
    },
    {
      id: "network", label: "Network", // changed from Wi-Fi since we detect all interfaces
      value: current ? formatRate(current.net_send_per_sec + current.net_recv_per_sec) : "--",
      color: "#e67e22",
      getValue: (p) => p.snapshot.net_send_per_sec + p.snapshot.net_recv_per_sec,
      maxValue: Math.max((current?.net_link_speed_bps ?? 0) / 8, 1048576), // link speed in bytes or 1MB/s min
    },
    {
      id: "gpu", label: "GPU",
      value: `${(current?.gpu_usage_percent ?? 0).toFixed(0)}%`,
      color: "#e74c3c",
      getValue: (p) => p.snapshot.gpu_usage_percent,
      maxValue: 100,
    },
    {
      id: "battery", label: "Battery",
      value: current ? `${current.battery_percent.toFixed(0)}%${current.is_charging ? " \u26A1" : ""}` : "--",
      color: "#f1c40f",
      getValue: (p) => p.snapshot.battery_percent,
      maxValue: 100,
    },
  ];

  return (
    <div className="performance-sidebar">
      {items.map((item) => (
        <div
          key={item.id}
          className={`sidebar-item ${activePanel === item.id ? "active" : ""}`}
          onClick={() => onPanelChange(item.id)}
        >
          <div className="sidebar-item-info">
            <span className="sidebar-item-label">{item.label}</span>
            <span className="sidebar-item-value" style={{ color: item.color }}>{item.value}</span>
          </div>
          <SparklineCanvas
            historyRef={historyRef}
            generationRef={generationRef}
            getValue={item.getValue}
            maxValue={item.maxValue}
            color={item.color}
            width={60}
            height={24}
          />
        </div>
      ))}
    </div>
  );
}

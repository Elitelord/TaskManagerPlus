import { useRef, useEffect, useCallback } from "react";
import { useSystemInfo } from "../hooks/useSystemInfo";
import { usePerformanceData, PerformanceHistory } from "../hooks/usePerformanceData";
import type { RingBuffer } from "../lib/ringBuffer";
import appIcon from "../assets/app-icon.png";

function formatRate(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`;
  if (bytesPerSec < 1048576) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / 1048576).toFixed(1)} MB/s`;
}

/** Tiny inline sparkline drawn on a <canvas> */
function MiniSparkline({
  historyRef,
  generationRef,
  getValue,
  color,
  maxValue = 100,
  autoScale = false,
}: {
  historyRef: React.RefObject<RingBuffer<PerformanceHistory>>;
  generationRef: React.RefObject<number>;
  getValue: (p: PerformanceHistory) => number;
  color: string;
  maxValue?: number;
  autoScale?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastGenRef = useRef(-1);
  const animRef = useRef(0);
  const getValRef = useRef(getValue);
  useEffect(() => { getValRef.current = getValue; }, [getValue]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.scale(dpr, dpr);
    }
    ctx.clearRect(0, 0, w, h);
    const data = historyRef.current?.toArray();
    if (!data || data.length < 2) return;

    // Compute effective min/max for Y axis
    let yMin = 0;
    let yMax = maxValue > 0 ? maxValue : 1;

    if (autoScale) {
      // Auto-scale: zoom into the actual data range so small changes are visible
      let dataMin = Infinity;
      let dataMax = -Infinity;
      for (let i = 0; i < data.length; i++) {
        const v = getValRef.current(data[i]);
        if (v < dataMin) dataMin = v;
        if (v > dataMax) dataMax = v;
      }
      if (dataMin === Infinity) { dataMin = 0; dataMax = 1; }
      const range = dataMax - dataMin;
      // Use generous padding (50% of range) so the line uses most of the height
      const padding = Math.max(range * 0.5, 0.5); // at least 0.5 absolute units
      yMin = Math.max(0, dataMin - padding);
      yMax = Math.min(maxValue, dataMax + padding);
      // Ensure minimum visible range of 2 absolute units (e.g. 2%)
      if (yMax - yMin < 2) {
        const mid = (dataMin + dataMax) / 2;
        yMin = Math.max(0, mid - 1);
        yMax = Math.min(maxValue, mid + 1);
        if (yMax - yMin < 2) {
          // Edge: near 0 or near max
          yMin = Math.max(0, yMax - 2);
        }
      }
    }

    const effectiveRange = yMax - yMin || 1;
    const step = w / 59;
    const toX = (i: number) => w - (data.length - 1 - i) * step;
    const toY = (val: number) => {
      const clamped = Math.max(yMin, Math.min(val, yMax));
      return h - ((clamped - yMin) / effectiveRange) * h;
    };

    // Fill
    ctx.beginPath();
    ctx.moveTo(toX(0), h);
    for (let i = 0; i < data.length; i++) {
      ctx.lineTo(toX(i), toY(getValRef.current(data[i])));
    }
    ctx.lineTo(toX(data.length - 1), h);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, color + "40");
    grad.addColorStop(1, color + "08");
    ctx.fillStyle = grad;
    ctx.fill();

    // Line
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    for (let i = 0; i < data.length; i++) {
      const x = toX(i);
      const y = toY(getValRef.current(data[i]));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }, [historyRef, color, maxValue, autoScale]);

  useEffect(() => {
    let running = true;
    const tick = () => {
      if (!running) return;
      const gen = generationRef.current ?? 0;
      if (gen !== lastGenRef.current) {
        lastGenRef.current = gen;
        draw();
      }
      animRef.current = requestAnimationFrame(tick);
    };
    animRef.current = requestAnimationFrame(tick);
    return () => { running = false; cancelAnimationFrame(animRef.current); };
  }, [draw, generationRef]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: "100%", height: "28px", display: "block", borderRadius: "4px" }}
    />
  );
}

interface Props {
  activeTab: string;
  onTabChange: (tab: string) => void;
}

export function SystemOverview({ activeTab, onTabChange }: Props) {
  const { data: sys } = useSystemInfo();
  const { historyRef, generationRef } = usePerformanceData();

  const ramPercent = sys ? (sys.used_ram_mb / sys.total_ram_mb) * 100 : 0;
  const cpuPercent = sys?.cpu_usage_percent ?? 0;
  const batteryPercent = sys?.battery_percent ?? 0;
  const gpuPercent = sys?.gpu_usage_percent ?? 0;

  const items: {
    id: string;
    label: string;
    value: string;
    subValue?: string;
    color: string;
    percent?: number;
    getValue: (p: PerformanceHistory) => number;
    maxValue?: number;
    autoScale?: boolean;
  }[] = [
    {
      id: "cpu",
      label: "CPU",
      value: `${cpuPercent.toFixed(1)}%`,
      color: "#5b9cf6",
      percent: cpuPercent,
      getValue: (p) => p.snapshot.cpu_usage_percent,
      autoScale: true,
    },
    {
      id: "memory",
      label: "Memory",
      value: sys ? `${(sys.used_ram_mb / 1024).toFixed(1)} / ${(sys.total_ram_mb / 1024).toFixed(1)} GB` : "--",
      color: "#45d483",
      percent: ramPercent,
      getValue: (p) => (p.snapshot.used_ram_bytes / p.snapshot.total_ram_bytes) * 100,
      autoScale: true,
    },
    {
      id: "disk",
      label: "Disk",
      value: sys ? formatRate((sys.total_disk_read_per_sec ?? 0) + (sys.total_disk_write_per_sec ?? 0)) : "--",
      subValue: sys ? `R ${formatRate(sys.total_disk_read_per_sec ?? 0)}  W ${formatRate(sys.total_disk_write_per_sec ?? 0)}` : undefined,
      color: "#f5a524",
      getValue: (p) => p.snapshot.disk_read_per_sec + p.snapshot.disk_write_per_sec,
      maxValue: undefined, // dynamic
    },
    {
      id: "network",
      label: "Network",
      value: sys ? formatRate((sys.total_net_send_per_sec ?? 0) + (sys.total_net_recv_per_sec ?? 0)) : "--",
      subValue: sys ? `S ${formatRate(sys.total_net_send_per_sec ?? 0)}  R ${formatRate(sys.total_net_recv_per_sec ?? 0)}` : undefined,
      color: "#ef5350",
      getValue: (p) => p.snapshot.net_send_per_sec + p.snapshot.net_recv_per_sec,
      maxValue: undefined,
    },
    {
      id: "gpu",
      label: "GPU",
      value: `${gpuPercent.toFixed(1)}%`,
      color: "#ffd600",
      percent: gpuPercent,
      getValue: (p) => p.snapshot.gpu_usage_percent,
      autoScale: true,
    },
    {
      id: "battery",
      label: sys?.is_charging ? "Battery (AC)" : "Battery",
      value: `${batteryPercent.toFixed(0)}%`,
      subValue: `${(sys?.power_draw_watts ?? 0).toFixed(1)} W draw`,
      color: "#a78bfa",
      percent: batteryPercent,
      getValue: (p) => p.snapshot.battery_percent,
      autoScale: true,
    },
  ];

  // Compute dynamic max for disk/network from history
  const data = historyRef.current?.toArray() ?? [];
  for (const item of items) {
    if (item.maxValue === undefined) {
      let peak = 0;
      for (const d of data) {
        const v = item.getValue(d);
        if (v > peak) peak = v;
      }
      item.maxValue = Math.max(peak * 1.3, item.id === "disk" ? 1048576 : 102400);
    }
  }

  return (
    <div className="system-overview">
      <div className="sidebar-brand">
        <img className="brand-icon" src={appIcon} alt="TaskManager+" />
        <span className="brand-text">TaskManager<span className="brand-plus">+</span></span>
      </div>

      <div
        className={`nav-item ${activeTab === "processes" ? "active" : ""}`}
        onClick={() => onTabChange("processes")}
      >
        <div className="nav-item-header">
          <span className="nav-label">Processes</span>
          <span className="nav-value">{sys?.process_count ?? "--"}</span>
        </div>
      </div>

      <div className="nav-divider" />

      {items.map((item) => (
        <div
          key={item.id}
          className={`nav-item ${activeTab === item.id ? "active" : ""}`}
          onClick={() => onTabChange(item.id)}
        >
          <div className="nav-item-header">
            <span className="nav-label">{item.label}</span>
            <span className="nav-value">{item.value}</span>
          </div>
          {item.subValue && <div className="nav-sub-value">{item.subValue}</div>}
          {item.percent !== undefined && (
            <div className="nav-bar">
              <div
                className="nav-bar-fill"
                style={{
                  width: `${item.percent}%`,
                  background: item.color,
                }}
              />
            </div>
          )}
          <MiniSparkline
            historyRef={historyRef}
            generationRef={generationRef}
            getValue={item.getValue}
            color={item.color}
            maxValue={item.maxValue ?? 100}
            autoScale={item.autoScale}
          />
        </div>
      ))}

      <div className="nav-spacer" />

      <div
        className={`nav-item settings-nav ${activeTab === "settings" ? "active" : ""}`}
        onClick={() => onTabChange("settings")}
      >
        <div className="nav-item-header">
          <span className="nav-label">Settings</span>
          <span className="nav-value" style={{ fontSize: "14px" }}>&#9881;</span>
        </div>
      </div>
    </div>
  );
}

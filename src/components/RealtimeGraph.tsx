import { useRef, useEffect, useCallback, useState } from "react";
import type { RingBuffer } from "../lib/ringBuffer";
import type { PerformanceHistory } from "../hooks/usePerformanceData";
import { subscribeGeneration } from "../hooks/usePerformanceData";

interface Props {
  historyRef: React.RefObject<RingBuffer<PerformanceHistory>>;
  generationRef?: React.RefObject<number>; // kept for API compat, no longer used
  getValue: (point: PerformanceHistory) => number;
  getStackedValues?: (point: PerformanceHistory) => { label: string; value: number }[];
  maxValue?: number;
  unit?: "percent" | "bytes" | "watts" | "memory";
  color?: string;
  fillColor?: string;
  height?: number;
  label?: string;
  showGrid?: boolean;
  showLegend?: boolean;
  className?: string;
}

const palette = [
  "#60a5fa", "#34d399", "#fb923c", "#f87171", "#a78bfa",
  "#22d3ee", "#a3e635", "#f472b6", "#fbbf24", "#818cf8",
  "#94a3b8", "#2dd4bf",
];

function formatVal(val: number, unit: string): string {
  if (unit === "percent") return `${val.toFixed(1)}%`;
  if (unit === "watts") return `${val.toFixed(1)} W`;
  if (unit === "memory") {
    if (val >= 1024) return `${(val / 1024).toFixed(1)} GB`;
    return `${val.toFixed(0)} MB`;
  }
  if (val >= 1073741824) return `${(val / 1073741824).toFixed(1)} GB/s`;
  if (val >= 1048576) return `${(val / 1048576).toFixed(1)} MB/s`;
  if (val >= 1024) return `${(val / 1024).toFixed(1)} KB/s`;
  return `${val.toFixed(0)} B/s`;
}

export function RealtimeGraph({
  historyRef,
  getValue,
  getStackedValues,
  maxValue = 100,
  unit,
  color = "#5b9cf6",
  fillColor,
  height = 150,
  label,
  showGrid = true,
  showLegend = false,
  className = "",
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const getValueRef = useRef(getValue);
  const getStackedValuesRef = useRef(getStackedValues);

  const legendItemsRef = useRef<{ label: string; value: number; color: string }[]>([]);
  const [legendItems, setLegendItems] = useState<{ label: string; value: number; color: string }[]>([]);
  const currentValueRef = useRef<string>("");
  const [currentValue, setCurrentValue] = useState<string>("");

  useEffect(() => {
    getValueRef.current = getValue;
    getStackedValuesRef.current = getStackedValues;
  }, [getValue, getStackedValues]);

  const resolvedUnit = unit || (maxValue === 100 ? "percent" : "bytes");

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;

    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.scale(dpr, dpr);
    }

    const history = historyRef.current;
    if (!history) return;
    const data = history.toArray();

    const padLeft = 48;
    const padRight = 8;
    const padTop = 6;
    const padBottom = 18;
    const gw = w - padLeft - padRight;
    const gh = h - padTop - padBottom;

    // Background — match the new design system
    ctx.fillStyle = "rgba(20, 21, 23, 1)";
    ctx.fillRect(0, 0, w, h);

    const max = maxValue > 0 ? maxValue : 1;

    // Grid — faint dashed style
    if (showGrid) {
      const gridLines = 4;
      ctx.font = "500 9px system-ui, -apple-system, 'Segoe UI Variable', sans-serif";

      for (let i = 0; i <= gridLines; i++) {
        const frac = i / gridLines;
        const y = Math.round(padTop + frac * gh) + 0.5;
        const val = max * (1 - frac);

        ctx.setLineDash([3, 4]);
        ctx.strokeStyle = i === gridLines ? "rgba(255,255,255,0.07)" : "rgba(255,255,255,0.035)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padLeft, y);
        ctx.lineTo(w - padRight, y);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.textAlign = "right";
        ctx.fillStyle = "rgba(255,255,255,0.30)";
        ctx.fillText(formatVal(val, resolvedUnit), padLeft - 6, y + 3);
      }

      ctx.textAlign = "center";
      const vLines = 4;
      for (let i = 0; i <= vLines; i++) {
        const frac = i / vLines;
        const x = Math.round(padLeft + frac * gw) + 0.5;

        const secsAgo = Math.round(60 * (1 - frac));
        ctx.fillStyle = "rgba(255,255,255,0.20)";
        ctx.fillText(secsAgo > 0 ? `-${secsAgo}s` : "now", x, h - 3);
      }
      ctx.textAlign = "left";
    }

    if (data.length < 2) return;

    const step = gw / 59;
    const toX = (i: number) => padLeft + gw - (data.length - 1 - i) * step;
    const toY = (val: number) => padTop + gh - (Math.min(val, max) / max) * gh;

    const getStacked = getStackedValuesRef.current;
    const getVal = getValueRef.current;

    // === Stacked area chart (memory) ===
    if (getStacked) {
      // Build a clip path from the total value line — stacked fills can NEVER exceed it
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(toX(0), padTop + gh);
      for (let i = 0; i < data.length; i++) {
        ctx.lineTo(toX(i), toY(getVal(data[i])));
      }
      ctx.lineTo(toX(data.length - 1), padTop + gh);
      ctx.closePath();
      ctx.clip();

      // Compute stacked data
      const pointsWithStacks = data.map(p => {
        const stacks = getStacked(p);
        return new Map(stacks.map(s => [s.label, s.value]));
      });

      // Normalize per-point so stacks sum to total
      const normalizedStacks = data.map((p, i) => {
        const total = getVal(p);
        const raw = pointsWithStacks[i];
        let sum = 0;
        for (const v of raw.values()) sum += v;
        const scale = (sum > 0 && total > 0) ? total / sum : 1;
        const normalized = new Map<string, number>();
        for (const [k, v] of raw) normalized.set(k, v * scale);
        return normalized;
      });

      const latestStacks = getStacked(data[data.length - 1]);
      const labelOrder = latestStacks.map(s => s.label);
      const labelSet = new Set(labelOrder);
      for (const pm of normalizedStacks) {
        for (const key of pm.keys()) {
          if (!labelSet.has(key)) { labelSet.add(key); labelOrder.push(key); }
        }
      }

      // Draw stacks bottom-up
      const bottomYArr = new Array(data.length).fill(padTop + gh);

      for (let li = 0; li < labelOrder.length; li++) {
        const lbl = labelOrder[li];
        const baseColor = palette[li % palette.length];

        ctx.beginPath();
        ctx.moveTo(toX(data.length - 1), bottomYArr[data.length - 1]);
        for (let i = data.length - 1; i >= 0; i--) {
          const val = normalizedStacks[i].get(lbl) || 0;
          const y = bottomYArr[i] - (val / max) * gh;
          ctx.lineTo(toX(i), y);
        }
        for (let i = 0; i < data.length; i++) {
          ctx.lineTo(toX(i), bottomYArr[i]);
        }
        ctx.closePath();

        ctx.fillStyle = baseColor + "44";
        ctx.fill();

        // Top edge
        ctx.beginPath();
        for (let i = 0; i < data.length; i++) {
          const val = normalizedStacks[i].get(lbl) || 0;
          const y = bottomYArr[i] - (val / max) * gh;
          if (i === 0) ctx.moveTo(toX(i), y);
          else ctx.lineTo(toX(i), y);
        }
        ctx.strokeStyle = baseColor + "70";
        ctx.lineWidth = 1;
        ctx.lineJoin = "round";
        ctx.stroke();

        for (let i = 0; i < data.length; i++) {
          const val = normalizedStacks[i].get(lbl) || 0;
          bottomYArr[i] -= (val / max) * gh;
        }
      }

      ctx.restore(); // remove clip

      legendItemsRef.current = latestStacks.map((s, i) => ({
        label: s.label,
        value: s.value,
        color: palette[i % palette.length],
      }));

    } else {
      // === Single metric area fill with gradient ===
      ctx.beginPath();
      ctx.moveTo(toX(0), padTop + gh);
      for (let i = 0; i < data.length; i++) {
        ctx.lineTo(toX(i), toY(getVal(data[i])));
      }
      ctx.lineTo(toX(data.length - 1), padTop + gh);
      ctx.closePath();

      const areaGrad = ctx.createLinearGradient(0, padTop, 0, padTop + gh);
      areaGrad.addColorStop(0, color + "25");
      areaGrad.addColorStop(0.6, color + "08");
      areaGrad.addColorStop(1, "transparent");
      ctx.fillStyle = areaGrad;
      ctx.fill();

      legendItemsRef.current = [];
    }

    // === Total value line with gradient stroke ===
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (let i = 0; i < data.length; i++) {
      const x = toX(i);
      const y = toY(getVal(data[i]));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Current value dot — glow effect
    const lastX = toX(data.length - 1);
    const lastY = toY(getVal(data[data.length - 1]));

    const glowGrad = ctx.createRadialGradient(lastX, lastY, 0, lastX, lastY, 8);
    glowGrad.addColorStop(0, color + "40");
    glowGrad.addColorStop(1, "transparent");
    ctx.fillStyle = glowGrad;
    ctx.fillRect(lastX - 8, lastY - 8, 16, 16);

    ctx.beginPath();
    ctx.arc(lastX, lastY, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(lastX, lastY, 1.2, 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.fill();

    // Current value — update ref immediately, batch React state update
    const latestVal = getVal(data[data.length - 1]);
    currentValueRef.current = formatVal(latestVal, resolvedUnit);

    // Left accent line with gradient
    const accentGrad = ctx.createLinearGradient(0, padTop, 0, padTop + gh);
    accentGrad.addColorStop(0, color + "60");
    accentGrad.addColorStop(1, color + "10");
    ctx.fillStyle = accentGrad;
    ctx.fillRect(padLeft, padTop, 1.5, gh);

  }, [historyRef, maxValue, color, fillColor, showGrid, resolvedUnit]);

  // Subscribe to generation changes instead of continuous rAF polling
  useEffect(() => {
    const unsub = subscribeGeneration(() => {
      cancelAnimationFrame(animRef.current);
      animRef.current = requestAnimationFrame(() => {
        draw();
        // Batch React state updates — sync refs to state after draw
        setCurrentValue(currentValueRef.current);
        setLegendItems(legendItemsRef.current);
      });
    });
    return () => { unsub(); cancelAnimationFrame(animRef.current); };
  }, [draw]);

  useEffect(() => {
    draw();
    const handleResize = () => draw();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [draw]);

  return (
    <div className={`graph-wrapper ${className}`}>
      <div className="graph-header">
        <span className="graph-label">{label || ""}</span>
        <span className="graph-current-value" style={{ color }}>{currentValue}</span>
      </div>

      <canvas
        ref={canvasRef}
        className="realtime-graph"
        style={{ width: "100%", height: `${height}px`, display: "block" }}
      />

      {showLegend && legendItems.length > 0 && (
        <div className="graph-legend">
          {legendItems.map((item, i) => (
            <div key={i} className="graph-legend-item">
              <span className="legend-dot" style={{ background: item.color }} />
              <span className="legend-name">{item.label}</span>
              <span className="legend-value">{formatVal(item.value, resolvedUnit)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

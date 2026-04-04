import { useRef, useEffect, useCallback } from "react";
import type { RingBuffer } from "../lib/ringBuffer";
import type { PerformanceHistory } from "../hooks/usePerformanceData";

interface Props {
  historyRef: React.RefObject<RingBuffer<PerformanceHistory>>;
  generationRef: React.RefObject<number>;
  getValue: (point: PerformanceHistory) => number;
  getStackedValues?: (point: PerformanceHistory) => { label: string; value: number }[];
  maxValue?: number;
  unit?: "percent" | "bytes" | "watts" | "memory";
  color?: string;
  fillColor?: string;
  height?: number;
  label?: string;
  showGrid?: boolean;
  className?: string;
}

export function RealtimeGraph({
  historyRef,
  generationRef,
  getValue,
  getStackedValues,
  maxValue = 100,
  unit,
  color = "#4a9eff",
  fillColor,
  height = 150,
  label,
  showGrid = true,
  className = "",
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastGenRef = useRef(-1);
  const animRef = useRef<number>(0);

  const getValueRef = useRef(getValue);
  const getStackedValuesRef = useRef(getStackedValues);

  useEffect(() => {
    getValueRef.current = getValue;
    getStackedValuesRef.current = getStackedValues;
  }, [getValue, getStackedValues]);

  const resolvedUnit = unit || (maxValue === 100 ? "percent" : "bytes");

  const formatValue = useCallback((val: number) => {
    if (resolvedUnit === "percent") return `${val.toFixed(1)}%`;
    if (resolvedUnit === "watts") return `${val.toFixed(1)} W`;
    if (resolvedUnit === "memory") {
      if (val >= 1024) return `${(val / 1024).toFixed(1)} GB`;
      return `${val.toFixed(0)} MB`;
    }
    if (val >= 1073741824) return `${(val / 1073741824).toFixed(1)} GB/s`;
    if (val >= 1048576) return `${(val / 1048576).toFixed(1)} MB/s`;
    if (val >= 1024) return `${(val / 1024).toFixed(1)} KB/s`;
    return `${val.toFixed(0)} B/s`;
  }, [resolvedUnit]);

  const palette = [
    "#60a5fa", // Soft blue
    "#34d399", // Emerald
    "#fb923c", // Warm orange
    "#f87171", // Coral red
    "#a78bfa", // Violet
    "#22d3ee", // Cyan
    "#a3e635", // Lime
    "#f472b6", // Pink
    "#fbbf24", // Amber
    "#818cf8", // Indigo
    "#94a3b8", // Slate
    "#2dd4bf", // Teal
  ];

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

    // Padding for Y-axis labels
    const padLeft = 44;
    const padRight = 12;
    const padTop = 8;
    const padBottom = 20;
    const gw = w - padLeft - padRight; // graph area width
    const gh = h - padTop - padBottom; // graph area height

    // Background with subtle gradient
    const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
    bgGrad.addColorStop(0, "#0f1318");
    bgGrad.addColorStop(1, "#0a0e13");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    // Grid
    if (showGrid) {
      ctx.lineWidth = 1;
      const gridLines = 4;

      // Horizontal grid + Y-axis labels
      ctx.font = "10px 'Segoe UI', system-ui, sans-serif";
      ctx.textAlign = "right";
      for (let i = 0; i <= gridLines; i++) {
        const frac = i / gridLines;
        const y = padTop + frac * gh;

        // Grid line
        ctx.strokeStyle = "rgba(255,255,255,0.04)";
        ctx.beginPath();
        ctx.moveTo(padLeft, y);
        ctx.lineTo(w - padRight, y);
        ctx.stroke();

        // Y-axis label
        const val = maxValue * (1 - frac);
        ctx.fillStyle = "rgba(255,255,255,0.25)";
        ctx.fillText(formatValue(val), padLeft - 6, y + 3);
      }

      // Vertical grid + time labels
      ctx.textAlign = "center";
      const vLines = 6;
      for (let i = 0; i <= vLines; i++) {
        const frac = i / vLines;
        const x = padLeft + frac * gw;

        ctx.strokeStyle = "rgba(255,255,255,0.04)";
        ctx.beginPath();
        ctx.moveTo(x, padTop);
        ctx.lineTo(x, padTop + gh);
        ctx.stroke();

        // Time label
        const secsAgo = Math.round(60 * (1 - frac));
        if (secsAgo > 0) {
          ctx.fillStyle = "rgba(255,255,255,0.2)";
          ctx.fillText(`${secsAgo}s`, x, h - 4);
        } else {
          ctx.fillStyle = "rgba(255,255,255,0.3)";
          ctx.fillText("now", x, h - 4);
        }
      }
      ctx.textAlign = "left";
    }

    if (data.length < 2) return;

    const max = maxValue > 0 ? maxValue : 1;
    const step = gw / 59;

    const getStacked = getStackedValuesRef.current;
    const getVal = getValueRef.current;

    // Helper: data index to canvas X
    const toX = (i: number) => padLeft + gw - (data.length - 1 - i) * step;
    // Helper: value to canvas Y
    const toY = (val: number) => padTop + gh - (Math.min(val, max) / max) * gh;

    // Stacked area
    if (getStacked) {
      const pointsWithStacks = data.map(p => {
        const stacks = getStacked(p);
        return new Map(stacks.map(s => [s.label, s.value]));
      });

      const latestStacks = getStacked(data[data.length - 1]);
      const labelOrder = latestStacks.map(s => s.label);
      const labelSet = new Set(labelOrder);
      for (const pm of pointsWithStacks) {
        for (const key of pm.keys()) {
          if (!labelSet.has(key)) { labelSet.add(key); labelOrder.push(key); }
        }
      }

      const bottomYArr = new Array(data.length).fill(padTop + gh);

      for (let li = 0; li < labelOrder.length; li++) {
        const lbl = labelOrder[li];
        const baseColor = palette[li % palette.length];

        ctx.beginPath();
        ctx.moveTo(toX(data.length - 1), bottomYArr[data.length - 1]);

        for (let i = data.length - 1; i >= 0; i--) {
          const val = pointsWithStacks[i].get(lbl) || 0;
          const y = bottomYArr[i] - (val / max) * gh;
          ctx.lineTo(toX(i), y);
        }
        for (let i = 0; i < data.length; i++) {
          ctx.lineTo(toX(i), bottomYArr[i]);
        }
        ctx.closePath();

        // Gradient fill for each stack layer
        const grad = ctx.createLinearGradient(0, padTop, 0, padTop + gh);
        grad.addColorStop(0, baseColor + "cc");
        grad.addColorStop(1, baseColor + "33");
        ctx.fillStyle = grad;
        ctx.fill();

        // Thin border on top edge of each stack
        ctx.beginPath();
        for (let i = 0; i < data.length; i++) {
          const val = pointsWithStacks[i].get(lbl) || 0;
          const y = bottomYArr[i] - (val / max) * gh;
          if (i === 0) ctx.moveTo(toX(i), y);
          else ctx.lineTo(toX(i), y);
        }
        ctx.strokeStyle = baseColor + "60";
        ctx.lineWidth = 0.5;
        ctx.stroke();

        for (let i = 0; i < data.length; i++) {
          const val = pointsWithStacks[i].get(lbl) || 0;
          bottomYArr[i] -= (val / max) * gh;
        }
      }
    } else if (fillColor) {
      // Area fill with gradient
      ctx.beginPath();
      ctx.moveTo(toX(0), padTop + gh);
      for (let i = 0; i < data.length; i++) {
        ctx.lineTo(toX(i), toY(getVal(data[i])));
      }
      ctx.lineTo(toX(data.length - 1), padTop + gh);
      ctx.closePath();
      const areaGrad = ctx.createLinearGradient(0, padTop, 0, padTop + gh);
      areaGrad.addColorStop(0, color + "40");
      areaGrad.addColorStop(1, color + "05");
      ctx.fillStyle = areaGrad;
      ctx.fill();
    }

    // Total line with glow
    ctx.save();
    ctx.shadowColor = color + "80";
    ctx.shadowBlur = 6;
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
    ctx.restore();

    // Current value dot
    if (data.length > 0) {
      const lastX = toX(data.length - 1);
      const lastY = toY(getVal(data[data.length - 1]));
      ctx.beginPath();
      ctx.arc(lastX, lastY, 3, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(lastX, lastY, 5, 0, Math.PI * 2);
      ctx.strokeStyle = color + "60";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Top-left label
    if (label) {
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.font = "600 11px 'Segoe UI', system-ui, sans-serif";
      ctx.fillText(label, padLeft + 8, padTop + 16);
    }

    // Top-right current value (large)
    if (data.length > 0) {
      const latestVal = getVal(data[data.length - 1]);
      ctx.fillStyle = "#ffffff";
      ctx.font = "700 16px 'Segoe UI', system-ui, sans-serif";
      ctx.textAlign = "right";
      ctx.fillText(formatValue(latestVal), w - padRight - 4, padTop + 16);
      ctx.textAlign = "left";
    }

    // Legend for stacks (positioned below the label)
    if (getStacked && data.length > 0) {
      const latestPointStacks = getStacked(data[data.length - 1]);
      ctx.font = "10px 'Segoe UI', system-ui, sans-serif";
      let legendY = padTop + 30;

      for (let s = 0; s < latestPointStacks.length && s < 8; s++) {
        const sLabel = latestPointStacks[s].label;
        const sColor = palette[s % palette.length];

        // Color dot
        ctx.beginPath();
        ctx.arc(padLeft + 12, legendY - 2, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = sColor;
        ctx.fill();

        // Label text
        ctx.fillStyle = "rgba(255,255,255,0.5)";
        const formattedVal = formatValue(latestPointStacks[s].value);
        ctx.fillText(`${sLabel}`, padLeft + 20, legendY + 1);

        // Value right-aligned
        const nameWidth = ctx.measureText(sLabel).width;
        ctx.fillStyle = "rgba(255,255,255,0.7)";
        ctx.fillText(formattedVal, padLeft + 24 + nameWidth, legendY + 1);

        legendY += 14;
      }
    }

    // Subtle inner border
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  }, [historyRef, maxValue, color, fillColor, showGrid, label, formatValue]);

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
    return () => {
      running = false;
      cancelAnimationFrame(animRef.current);
    };
  }, [draw, generationRef]);

  useEffect(() => {
    draw();
    const handleResize = () => draw();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [draw]);

  return (
    <canvas
      ref={canvasRef}
      className={`realtime-graph ${className}`}
      style={{ width: "100%", height: `${height}px`, display: "block" }}
    />
  );
}

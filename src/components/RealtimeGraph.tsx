import { useRef, useEffect, useLayoutEffect, useCallback, useState, useMemo } from "react";
import type { RingBuffer } from "../lib/ringBuffer";
import type { PerformanceHistory } from "../hooks/usePerformanceData";
import { subscribeGeneration } from "../hooks/usePerformanceData";
import { useSettings, hexToRgba } from "../lib/settings";

interface Props {
  historyRef: React.RefObject<RingBuffer<PerformanceHistory>>;
  generationRef?: React.RefObject<number>; // kept for API compat, no longer used
  getValue: (point: PerformanceHistory) => number;
  getStackedValues?: (point: PerformanceHistory) => { label: string; value: number; color?: string }[];
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

// Avoid #a78bfa here — memory "Kernel memory" uses it as a fixed bucket color;
// palette-by-index was colliding with the 5th stacked band (index 4).
const palette = [
  "#60a5fa", "#34d399", "#fb923c", "#f87171", "#84cc16",
  "#22d3ee", "#a3e635", "#f472b6", "#fbbf24", "#0d9488",
  "#94a3b8", "#2dd4bf",
];

/** Stable fallback when a stack slice has no recorded color (hash by name, not stack index). */
function fallbackPaletteColor(label: string): string {
  let h = 2166136261;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return palette[Math.abs(h | 0) % palette.length];
}

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
  color: colorProp,
  fillColor,
  height = 150,
  label,
  showGrid = true,
  showLegend = false,
  className = "",
}: Props) {
  const [settings] = useSettings();
  const color = colorProp ?? settings.accentColor;
  const resolvedFill = useMemo(
    () => fillColor ?? hexToRgba(color, 0.12),
    [fillColor, color],
  );

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const getValueRef = useRef(getValue);
  const getStackedValuesRef = useRef(getStackedValues);

  /** getComputedStyle is expensive; theme CSS vars only need re-reading when theme toggles. */
  const graphThemeRef = useRef<{
    bgColor: string;
    gridFaint: string;
    gridStrong: string;
    axisText: string;
    axisTextDim: string;
  } | null>(null);

  const legendItemsRef = useRef<{ label: string; value: number; color: string }[]>([]);
  const [legendItems, setLegendItems] = useState<{ label: string; value: number; color: string }[]>([]);
  const currentValueRef = useRef<string>("");
  const [currentValue, setCurrentValue] = useState<string>("");

  useEffect(() => {
    getValueRef.current = getValue;
    getStackedValuesRef.current = getStackedValues;
  }, [getValue, getStackedValues]);

  useEffect(() => {
    graphThemeRef.current = null;
  }, [settings.theme]);

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

    let theme = graphThemeRef.current;
    if (!theme) {
      const cs = getComputedStyle(canvas);
      theme = {
        bgColor: cs.getPropertyValue("--graph-bg").trim() || "rgba(20,21,23,1)",
        gridFaint:
          cs.getPropertyValue("--graph-grid-line").trim() || "rgba(255,255,255,0.035)",
        gridStrong:
          cs.getPropertyValue("--graph-grid-line-strong").trim() ||
          "rgba(255,255,255,0.07)",
        axisText:
          cs.getPropertyValue("--graph-axis-text").trim() || "rgba(255,255,255,0.30)",
        axisTextDim:
          cs.getPropertyValue("--graph-axis-text-dim").trim() ||
          "rgba(255,255,255,0.20)",
      };
      graphThemeRef.current = theme;
    }
    const { bgColor, gridFaint, gridStrong, axisText, axisTextDim } = theme;

    // Background
    ctx.fillStyle = bgColor;
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
        ctx.strokeStyle = i === gridLines ? gridStrong : gridFaint;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padLeft, y);
        ctx.lineTo(w - padRight, y);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.textAlign = "right";
        ctx.fillStyle = axisText;
        ctx.fillText(formatVal(val, resolvedUnit), padLeft - 6, y + 3);
      }

      ctx.textAlign = "center";
      const vLines = 4;
      for (let i = 0; i <= vLines; i++) {
        const frac = i / vLines;
        const x = Math.round(padLeft + frac * gw) + 0.5;

        const secsAgo = Math.round(60 * (1 - frac));
        ctx.fillStyle = axisTextDim;
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
          if (!labelSet.has(key)) {
            labelSet.add(key);
            labelOrder.push(key);
          }
        }
      }

      // Build a label→color map. If the producer provided a `color` per stack
      // (memory composition buckets do), honor it so the graph bands match the
      // composition bar's colors. Otherwise fall back to palette-by-index.
      const labelColor = new Map<string, string>();
      for (const s of latestStacks) {
        if (s.color) labelColor.set(s.label, s.color);
      }
      // Labels only present on older ticks (e.g. process dropped out of top-N)
      // still need their recorded colors so bands match legend semantics.
      for (let hi = data.length - 1; hi >= 0; hi--) {
        for (const s of getStacked(data[hi])) {
          if (s.color && !labelColor.has(s.label)) labelColor.set(s.label, s.color);
        }
      }

      // Draw stacks bottom-up
      const bottomYArr = new Array(data.length).fill(padTop + gh);

      for (const lbl of labelOrder) {
        const baseColor = labelColor.get(lbl) ?? fallbackPaletteColor(lbl);

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

      legendItemsRef.current = latestStacks.map(s => ({
        label: s.label,
        value: s.value,
        color: labelColor.get(s.label) ?? fallbackPaletteColor(s.label),
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

      ctx.fillStyle = resolvedFill;
      ctx.fill();

      legendItemsRef.current = [];
    }

    // === Total value line with gradient stroke ===
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
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

    ctx.beginPath();
    ctx.arc(lastX, lastY, 2.25, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    // Current value — update ref immediately, batch React state update
    const latestVal = getVal(data[data.length - 1]);
    currentValueRef.current = formatVal(latestVal, resolvedUnit);

    ctx.fillStyle = hexToRgba(color, 0.22);
    ctx.fillRect(padLeft, padTop, 1.25, gh);

  }, [historyRef, maxValue, color, resolvedFill, showGrid, resolvedUnit, settings.theme]);

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

  // Synchronous initial draw so the existing history renders before paint,
  // eliminating any flash/reset when switching to a resource tab.
  useLayoutEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => {
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

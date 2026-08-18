import { useRef, useEffect, useLayoutEffect, useCallback, useState, useMemo, type ReactNode } from "react";
import type { RingBuffer } from "../lib/ringBuffer";
import type { PerformanceHistory } from "../hooks/usePerformanceData";
import { subscribeGeneration } from "../hooks/usePerformanceData";
import { useSettings, hexToRgba } from "../lib/settings";
import { seriesPalette, withAlpha } from "../lib/seriesPalette";

interface Props {
  historyRef: React.RefObject<RingBuffer<PerformanceHistory>>;
  generationRef?: React.RefObject<number>; // kept for API compat, no longer used
  getValue: (point: PerformanceHistory) => number;
  getStackedValues?: (point: PerformanceHistory) => { label: string; value: number; color?: string }[];
  maxValue?: number;
  unit?: "percent" | "bytes" | "watts" | "memory";
  color?: string;
  fillColor?: string;
  /** Signed series (e.g. net battery power): zero-centered axis, dual-tone fill/stroke */
  bipolar?: boolean;
  /** When false with bipolar, draws line only (no ± area fills). Battery uses false to avoid odd lobes when the series oscillates. */
  bipolarAreaFill?: boolean;
  positiveColor?: string;
  negativeColor?: string;
  height?: number;
  label?: string;
  showGrid?: boolean;
  showLegend?: boolean;
  className?: string;
  /** Optional control(s) in the graph header row after the label (e.g. battery mode switch) */
  headerAccessory?: ReactNode;
  /** When set (e.g. battery graph mode), Y-axis range eases when this key changes instead of snapping */
  yScaleAnimationKey?: string | number;
}

/** Stable fallback when a stack slice has no recorded color (hash by name, not stack index). */
function fallbackPaletteColor(label: string): string {
  let h = 2166136261;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const p = seriesPalette();
  return p[Math.abs(h | 0) % p.length];
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
  bipolar = false,
  bipolarAreaFill = true,
  positiveColor: positiveColorProp,
  negativeColor: negativeColorProp,
  height = 150,
  label,
  showGrid = true,
  showLegend = false,
  className = "",
  headerAccessory,
  yScaleAnimationKey,
}: Props) {
  const [settings] = useSettings();
  const color = colorProp ?? settings.accentColor;
  const positiveColor = positiveColorProp ?? "#34d399";
  const negativeColor = negativeColorProp ?? "#ef4444";
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
    gridFaint: string;
    gridStrong: string;
    axisText: string;
    axisTextDim: string;
    mono: string;
  } | null>(null);

  const legendItemsRef = useRef<{ label: string; value: number; color: string }[]>([]);
  const [legendItems, setLegendItems] = useState<{ label: string; value: number; color: string }[]>([]);
  const currentValueRef = useRef<string>("");
  const currentHeaderColorRef = useRef<string>(color);
  const [currentValue, setCurrentValue] = useState<string>("");
  const [headerColor, setHeaderColor] = useState<string>(color);

  const displayMaxRef = useRef(maxValue > 0 ? maxValue : 1);
  const maxValueTargetRef = useRef(maxValue > 0 ? maxValue : 1);
  const scaleKeyRef = useRef<typeof yScaleAnimationKey | "">("");
  const scaleAnimatingRef = useRef(false);
  const scaleRafRef = useRef(0);

  useEffect(() => {
    getValueRef.current = getValue;
    getStackedValuesRef.current = getStackedValues;
  }, [getValue, getStackedValues]);

  useEffect(() => {
    graphThemeRef.current = null;
  }, [settings.theme]);

  useEffect(() => {
    maxValueTargetRef.current = maxValue > 0 ? maxValue : 1;
  }, [maxValue]);

  const resolvedUnit = unit || (maxValue === 100 ? "percent" : "bytes");

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
        // Axis ticks are pure numerics, so they get the app's mono face like
        // every other machine readout. Read from the token rather than
        // re-stating a stack here, which is how this drifted before.
        mono: cs.getPropertyValue("--font-mono").trim() || "ui-monospace, monospace",
      };
      graphThemeRef.current = theme;
    }
    const { gridFaint, gridStrong, axisText, axisTextDim, mono } = theme;

    const targetMax = maxValue > 0 ? maxValue : 1;
    const max = scaleAnimatingRef.current
      ? Math.max(displayMaxRef.current, 1e-6)
      : (() => {
          displayMaxRef.current = targetMax;
          return targetMax;
        })();
    const midY = padTop + gh / 2;
    const toYUni = (val: number) => padTop + gh - (Math.min(val, max) / max) * gh;
    const toYBi = (val: number) => {
      const c = Math.min(Math.max(val, -max), max);
      return midY - (c / max) * (gh / 2);
    };

    // Grid — faint dashed style (bipolar: symmetric ticks around 0 at midY)
    if (showGrid) {
      const gridLines = 4;
      ctx.font = `500 10px ${mono}`;

      if (bipolar) {
        for (let i = 0; i <= gridLines; i++) {
          const frac = i / gridLines;
          const y = Math.round(padTop + frac * gh) + 0.5;
          const val = max * (1 - 2 * frac);
          const isZero = i === gridLines / 2;

          if (!isZero) {
            ctx.setLineDash([3, 4]);
            ctx.strokeStyle = i === 0 || i === gridLines ? gridStrong : gridFaint;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(padLeft, y);
            ctx.lineTo(w - padRight, y);
            ctx.stroke();
            ctx.setLineDash([]);
          }

          ctx.textAlign = "right";
          ctx.fillStyle = axisText;
          ctx.fillText(formatVal(val, resolvedUnit), padLeft - 6, y + 3);
        }
        // Solid baseline at net power = 0 (distinct from dashed grid)
        ctx.save();
        ctx.setLineDash([]);
        ctx.strokeStyle = axisText;
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 1.35;
        ctx.beginPath();
        ctx.moveTo(padLeft, midY + 0.5);
        ctx.lineTo(w - padRight, midY + 0.5);
        ctx.stroke();
        ctx.restore();
      } else {
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

    const getStacked = getStackedValuesRef.current;
    const getVal = getValueRef.current;

    // === Stacked area chart (memory) ===
    if (getStacked) {
      // Build a clip path from the total value line — stacked fills can NEVER exceed it
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(toX(0), padTop + gh);
      for (let i = 0; i < data.length; i++) {
        ctx.lineTo(toX(i), toYUni(getVal(data[i])));
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

        ctx.fillStyle = withAlpha(baseColor, 0.27);
        ctx.fill();

        // Top edge
        ctx.beginPath();
        for (let i = 0; i < data.length; i++) {
          const val = normalizedStacks[i].get(lbl) || 0;
          const y = bottomYArr[i] - (val / max) * gh;
          if (i === 0) ctx.moveTo(toX(i), y);
          else ctx.lineTo(toX(i), y);
        }
        ctx.strokeStyle = withAlpha(baseColor, 0.44);
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

    } else if (bipolar) {
      if (bipolarAreaFill) {
        type StripPt = { x: number; y: number; v: number };
        const strip: StripPt[] = [];
        for (let i = 0; i < data.length; i++) {
          const v = getVal(data[i]);
          strip.push({ x: toX(i), y: toYBi(v), v });
          if (i < data.length - 1) {
            const v2 = getVal(data[i + 1]);
            if (v !== 0 && v2 !== 0 && (v > 0) !== (v2 > 0)) {
              const x0 = toX(i);
              const x1 = toX(i + 1);
              const t = v / (v - v2);
              strip.push({ x: x0 + t * (x1 - x0), y: midY, v: 0 });
            }
          }
        }
        strip.sort((a, b) => a.x - b.x);

        let pi = 0;
        while (pi < strip.length) {
          while (pi < strip.length && strip[pi].v < 0) pi++;
          if (pi >= strip.length) break;
          const start = pi;
          while (pi < strip.length && strip[pi].v >= 0) pi++;
          const end = pi - 1;
          if (end < start) continue;
          ctx.beginPath();
          ctx.moveTo(strip[start].x, midY);
          for (let k = start; k <= end; k++) ctx.lineTo(strip[k].x, strip[k].y);
          ctx.lineTo(strip[end].x, midY);
          ctx.closePath();
          ctx.fillStyle = hexToRgba(positiveColor, 0.22);
          ctx.fill();
        }

        pi = 0;
        while (pi < strip.length) {
          while (pi < strip.length && strip[pi].v > 0) pi++;
          if (pi >= strip.length) break;
          const start = pi;
          while (pi < strip.length && strip[pi].v <= 0) pi++;
          const end = pi - 1;
          if (end < start) continue;
          ctx.beginPath();
          ctx.moveTo(strip[start].x, midY);
          for (let k = start; k <= end; k++) ctx.lineTo(strip[k].x, strip[k].y);
          ctx.lineTo(strip[end].x, midY);
          ctx.closePath();
          ctx.fillStyle = hexToRgba(negativeColor, 0.22);
          ctx.fill();
        }
      }

      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.lineWidth = 1.5;
      for (let i = 0; i < data.length - 1; i++) {
        const v0 = getVal(data[i]);
        const v1 = getVal(data[i + 1]);
        const x0 = toX(i);
        const x1 = toX(i + 1);
        if (v0 !== 0 && v1 !== 0 && (v0 > 0) !== (v1 > 0)) {
          const t = v0 / (v0 - v1);
          const xc = x0 + t * (x1 - x0);
          ctx.beginPath();
          ctx.strokeStyle = v0 > 0 ? positiveColor : negativeColor;
          ctx.moveTo(x0, toYBi(v0));
          ctx.lineTo(xc, midY);
          ctx.stroke();
          ctx.beginPath();
          ctx.strokeStyle = v1 > 0 ? positiveColor : negativeColor;
          ctx.moveTo(xc, midY);
          ctx.lineTo(x1, toYBi(v1));
          ctx.stroke();
        } else {
          const segColor = (v0 + v1) / 2 >= 0 ? positiveColor : negativeColor;
          ctx.beginPath();
          ctx.strokeStyle = segColor;
          ctx.moveTo(x0, toYBi(v0));
          ctx.lineTo(x1, toYBi(v1));
          ctx.stroke();
        }
      }

      const latestVal = getVal(data[data.length - 1]);
      const lastX = toX(data.length - 1);
      const lastY = toYBi(latestVal);
      const dotColor = latestVal >= 0 ? positiveColor : negativeColor;

      ctx.beginPath();
      ctx.arc(lastX, lastY, 2.25, 0, Math.PI * 2);
      ctx.fillStyle = dotColor;
      ctx.fill();

      currentValueRef.current = formatVal(latestVal, resolvedUnit);
      currentHeaderColorRef.current = dotColor;

      ctx.fillStyle = hexToRgba(dotColor, 0.22);
      ctx.fillRect(padLeft, padTop, 1.25, gh);

      legendItemsRef.current = [];
    } else {
      // === Single metric area fill with gradient ===
      ctx.beginPath();
      ctx.moveTo(toX(0), padTop + gh);
      for (let i = 0; i < data.length; i++) {
        ctx.lineTo(toX(i), toYUni(getVal(data[i])));
      }
      ctx.lineTo(toX(data.length - 1), padTop + gh);
      ctx.closePath();

      ctx.fillStyle = resolvedFill;
      ctx.fill();

      legendItemsRef.current = [];

      // === Total value line ===
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      for (let i = 0; i < data.length; i++) {
        const x = toX(i);
        const y = toYUni(getVal(data[i]));
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      const lastX = toX(data.length - 1);
      const lastY = toYUni(getVal(data[data.length - 1]));

      ctx.beginPath();
      ctx.arc(lastX, lastY, 2.25, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      const latestVal = getVal(data[data.length - 1]);
      currentValueRef.current = formatVal(latestVal, resolvedUnit);
      currentHeaderColorRef.current = color;

      ctx.fillStyle = hexToRgba(color, 0.22);
      ctx.fillRect(padLeft, padTop, 1.25, gh);
    }

    if (getStacked) {
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      for (let i = 0; i < data.length; i++) {
        const x = toX(i);
        const y = toYUni(getVal(data[i]));
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      const lastX = toX(data.length - 1);
      const lastY = toYUni(getVal(data[data.length - 1]));

      ctx.beginPath();
      ctx.arc(lastX, lastY, 2.25, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      const latestVal = getVal(data[data.length - 1]);
      currentValueRef.current = formatVal(latestVal, resolvedUnit);
      currentHeaderColorRef.current = color;

      ctx.fillStyle = hexToRgba(color, 0.22);
      ctx.fillRect(padLeft, padTop, 1.25, gh);
    }

  }, [historyRef, maxValue, color, resolvedFill, showGrid, resolvedUnit, settings.theme, bipolar, bipolarAreaFill, positiveColor, negativeColor]);

  useEffect(() => {
    const target = maxValue > 0 ? maxValue : 1;
    if (yScaleAnimationKey === undefined) {
      displayMaxRef.current = target;
      return;
    }
    if (scaleKeyRef.current === "") {
      scaleKeyRef.current = yScaleAnimationKey;
      displayMaxRef.current = target;
      return;
    }
    if (yScaleAnimationKey === scaleKeyRef.current) {
      if (!scaleAnimatingRef.current) {
        displayMaxRef.current = target;
      }
      return;
    }
    cancelAnimationFrame(scaleRafRef.current);
    const from = displayMaxRef.current;
    const to = target;
    scaleKeyRef.current = yScaleAnimationKey;
    scaleAnimatingRef.current = true;
    const t0 = performance.now();
    const duration = 280;
    const step = (now: number) => {
      const u = Math.min(1, (now - t0) / duration);
      const eased = 1 - (1 - u) ** 2;
      displayMaxRef.current = from + (to - from) * eased;
      draw();
      if (u < 1) {
        scaleRafRef.current = requestAnimationFrame(step);
      } else {
        displayMaxRef.current = maxValueTargetRef.current;
        scaleAnimatingRef.current = false;
        draw();
      }
    };
    scaleRafRef.current = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(scaleRafRef.current);
    };
  }, [yScaleAnimationKey, maxValue, draw]);

  // Subscribe to generation changes instead of continuous rAF polling
  useEffect(() => {
    const unsub = subscribeGeneration(() => {
      cancelAnimationFrame(animRef.current);
      animRef.current = requestAnimationFrame(() => {
        draw();
        // Batch React state updates — sync refs to state after draw
        setCurrentValue(currentValueRef.current);
        setHeaderColor(currentHeaderColorRef.current);
        setLegendItems(legendItemsRef.current);
      });
    });
    return () => { unsub(); cancelAnimationFrame(animRef.current); };
  }, [draw]);

  // Synchronous initial draw so the existing history renders before paint,
  // eliminating any flash/reset when switching to a resource tab.
  useLayoutEffect(() => {
    draw();
    setCurrentValue(currentValueRef.current);
    setHeaderColor(currentHeaderColorRef.current);
    setLegendItems(legendItemsRef.current);
  }, [draw]);

  useEffect(() => {
    const handleResize = () => draw();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [draw]);

  return (
    <div className={`graph-wrapper ${className}`}>
      <div className="graph-header">
        <div className="graph-header-start">
          <span className="graph-label">{label || ""}</span>
          {headerAccessory}
        </div>
        <span className="graph-current-value" style={{ color: headerColor }}>{currentValue}</span>
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

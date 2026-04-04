import { useRef, useEffect, useCallback } from "react";
import type { RingBuffer } from "../lib/ringBuffer";
import type { PerformanceHistory } from "../hooks/usePerformanceData";

interface Props {
  historyRef: React.RefObject<RingBuffer<PerformanceHistory>>;
  generationRef: React.RefObject<number>;
  getValue: (point: PerformanceHistory) => number;
  maxValue?: number;
  color?: string;
  width?: number;
  height?: number;
}

export function SparklineCanvas({
  historyRef,
  generationRef,
  getValue,
  maxValue = 100,
  color = "#4a9eff",
  width = 60,
  height = 24,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastGenRef = useRef(-1);
  const animRef = useRef<number>(0);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.scale(dpr, dpr);
    }

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.fillRect(0, 0, width, height);

    const history = historyRef.current;
    if (!history) return;
    const data = history.toArray();
    if (data.length < 2) return;

    const max = maxValue > 0 ? maxValue : 1;
    const step = width / 59;

    // Area fill
    ctx.beginPath();
    ctx.moveTo(width - (data.length - 1) * step, height);
    for (let i = 0; i < data.length; i++) {
      const x = width - (data.length - 1 - i) * step;
      const val = Math.min(getValue(data[i]), max);
      const y = height - (val / max) * height;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(width, height);
    ctx.closePath();
    ctx.fillStyle = color + "33";
    ctx.fill();

    // Line
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    for (let i = 0; i < data.length; i++) {
      const x = width - (data.length - 1 - i) * step;
      const val = Math.min(getValue(data[i]), max);
      const y = height - (val / max) * height;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }, [historyRef, getValue, maxValue, color, width, height]);

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

  return (
    <canvas
      ref={canvasRef}
      style={{ width: `${width}px`, height: `${height}px`, display: "block", borderRadius: "3px" }}
    />
  );
}

import { useCallback, useRef, useEffect } from "react";
import { RealtimeGraph } from "../RealtimeGraph";
import type { RingBuffer } from "../../lib/ringBuffer";
import type { PerformanceHistory } from "../../hooks/usePerformanceData";
import type { PerformanceSnapshot, CoreCpuInfo } from "../../lib/types";

interface Props {
  current: PerformanceSnapshot | undefined;
  cores: CoreCpuInfo[] | undefined;
  historyRef: React.RefObject<RingBuffer<PerformanceHistory>>;
  generationRef: React.RefObject<number>;
}

function CoreSparkline({ coreIndex, historyRef, generationRef, isPerformanceCore }: {
  coreIndex: number;
  historyRef: React.RefObject<RingBuffer<PerformanceHistory>>;
  generationRef: React.RefObject<number>;
  isPerformanceCore: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastGenRef = useRef(-1);
  const animRef = useRef<number>(0);

  useEffect(() => {
    let running = true;
    const tick = () => {
      if (!running) return;
      const gen = generationRef.current ?? 0;
      if (gen !== lastGenRef.current) {
        lastGenRef.current = gen;
        const canvas = canvasRef.current;
        if (!canvas) { animRef.current = requestAnimationFrame(tick); return; }
        const ctx = canvas.getContext("2d");
        if (!ctx) { animRef.current = requestAnimationFrame(tick); return; }

        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
          canvas.width = w * dpr;
          canvas.height = h * dpr;
          ctx.scale(dpr, dpr);
        }

        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = "#0d1117";
        ctx.fillRect(0, 0, w, h);

        const history = historyRef.current;
        if (history) {
          const data = history.toArray();
          if (data.length >= 2) {
            const step = w / 59;
            const color = isPerformanceCore === 1 ? "#4a9eff" : isPerformanceCore === 0 ? "#2ecc71" : "#4a9eff";

            ctx.beginPath();
            ctx.moveTo(w - (data.length - 1) * step, h);
            for (let i = 0; i < data.length; i++) {
              const x = w - (data.length - 1 - i) * step;
              const core = data[i].cores?.find(c => c.core_index === coreIndex);
              const val = Math.min(core?.usage_percent ?? 0, 100);
              const y = h - (val / 100) * h;
              ctx.lineTo(x, y);
            }
            ctx.lineTo(w, h);
            ctx.closePath();
            ctx.fillStyle = color + "33";
            ctx.fill();

            ctx.beginPath();
            ctx.strokeStyle = color;
            ctx.lineWidth = 1;
            for (let i = 0; i < data.length; i++) {
              const x = w - (data.length - 1 - i) * step;
              const core = data[i].cores?.find(c => c.core_index === coreIndex);
              const val = Math.min(core?.usage_percent ?? 0, 100);
              const y = h - (val / 100) * h;
              if (i === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            }
            ctx.stroke();
          }
        }

        ctx.strokeStyle = "rgba(255,255,255,0.08)";
        ctx.lineWidth = 1;
        ctx.strokeRect(0, 0, w, h);
      }
      animRef.current = requestAnimationFrame(tick);
    };
    animRef.current = requestAnimationFrame(tick);
    return () => { running = false; cancelAnimationFrame(animRef.current); };
  }, [coreIndex, historyRef, generationRef, isPerformanceCore]);

  return <canvas ref={canvasRef} className="core-sparkline" style={{ width: "100%", height: "40px", display: "block" }} />;
}

export function CpuPanel({ current, cores, historyRef, generationRef }: Props) {
  const getCpuValue = useCallback((p: PerformanceHistory) => p.snapshot.cpu_usage_percent, []);

  return (
    <div className="perf-panel">
      <div className="perf-panel-header">
        <h2>CPU</h2>
        <span className="perf-panel-subtitle">
          {current ? `${current.cpu_frequency_mhz.toFixed(0)} MHz` : ""}
        </span>
      </div>

      <div className="perf-graph-container">
        <div className="perf-graph-label">% Utilization over 60 seconds</div>
        <RealtimeGraph
          historyRef={historyRef}
          generationRef={generationRef}
          getValue={getCpuValue}
          maxValue={100}
          color="#4a9eff"
          fillColor="rgba(74, 158, 255, 0.15)"
          height={180}
          label="CPU"
        />
      </div>

      {cores && cores.length > 0 && (
        <div className="core-grid-section">
          <h3>Logical Processors</h3>
          <div className="core-grid" style={{
            gridTemplateColumns: `repeat(${Math.min(cores.length, cores.length <= 8 ? 4 : cores.length <= 16 ? 8 : 12)}, 1fr)`
          }}>
            {cores.map((core) => (
              <div key={core.core_index} className="core-cell">
                <div className="core-header">
                  <span className="core-label">Core {core.core_index}</span>
                  {core.is_performance_core !== -1 && (
                    <span className={`core-badge ${core.is_performance_core === 1 ? "p-core" : "e-core"}`}>
                      {core.is_performance_core === 1 ? "P" : "E"}
                    </span>
                  )}
                </div>
                <CoreSparkline
                  coreIndex={core.core_index}
                  historyRef={historyRef}
                  generationRef={generationRef}
                  isPerformanceCore={core.is_performance_core}
                />
                <span className="core-value">{core.usage_percent.toFixed(0)}%</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="perf-stats-grid">
        <div className="perf-stat">
          <span className="perf-stat-label">Utilization</span>
          <span className="perf-stat-value">{(current?.cpu_usage_percent ?? 0).toFixed(1)}%</span>
        </div>
        <div className="perf-stat">
          <span className="perf-stat-label">Speed</span>
          <span className="perf-stat-value">{((current?.cpu_frequency_mhz ?? 0) / 1000).toFixed(2)} GHz</span>
        </div>
        <div className="perf-stat">
          <span className="perf-stat-label">Base speed</span>
          <span className="perf-stat-value">{((current?.cpu_base_frequency_mhz ?? 0) / 1000).toFixed(2)} GHz</span>
        </div>
        <div className="perf-stat">
          <span className="perf-stat-label">Processes</span>
          <span className="perf-stat-value">{current?.process_count ?? 0}</span>
        </div>
        <div className="perf-stat">
          <span className="perf-stat-label">Threads</span>
          <span className="perf-stat-value">{current?.thread_total_count ?? 0}</span>
        </div>
        <div className="perf-stat">
          <span className="perf-stat-label">Handles</span>
          <span className="perf-stat-value">{current?.handle_count ?? 0}</span>
        </div>
        <div className="perf-stat">
          <span className="perf-stat-label">Cores</span>
          <span className="perf-stat-value">{current?.core_count ?? 0}</span>
        </div>
      </div>
    </div>
  );
}

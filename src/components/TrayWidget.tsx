import { emitTo } from "@tauri-apps/api/event";
import { WebviewWindow, getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useSystemInfo } from "../hooks/useSystemInfo";

function formatRate(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`;
  if (bytesPerSec < 1048576) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / 1048576).toFixed(1)} MB/s`;
}

interface MetricRowProps {
  label: string;
  value: string;
  percent?: number;
  color: string;
}

function MetricRow({ label, value, percent, color }: MetricRowProps) {
  return (
    <div className="widget-metric">
      <div className="widget-metric-header">
        <span className="widget-metric-label">{label}</span>
        <span className="widget-metric-value">{value}</span>
      </div>
      {percent !== undefined && (
        <div className="widget-bar">
          <div
            className="widget-bar-fill"
            style={{ width: `${Math.min(percent, 100)}%`, background: color }}
          />
        </div>
      )}
    </div>
  );
}

export function TrayWidget() {
  const { data: sys } = useSystemInfo();

  const cpuPct = sys?.cpu_usage_percent ?? 0;
  const ramPct = sys ? (sys.used_ram_mb / sys.total_ram_mb) * 100 : 0;
  const gpuPct = sys?.gpu_usage_percent ?? 0;
  const batteryPct = sys?.battery_percent ?? 0;

  const handleOpenMain = async () => {
    const win = getCurrentWebviewWindow();
    await win.hide();
    try {
      const main = await WebviewWindow.getByLabel("main");
      if (main) {
        await main.show();
        await main.setFocus();
        await emitTo("main", "main-tray-background", { hidden: false });
      }
    } catch {}
  };

  return (
    <div className="tray-widget" data-tauri-drag-region>
      <div className="widget-header" data-tauri-drag-region>
        <span className="widget-title">TaskManager<span className="widget-plus">+</span></span>
        <button className="widget-open-btn" onClick={handleOpenMain}>Open</button>
      </div>

      <div className="widget-metrics">
        <MetricRow
          label="CPU"
          value={`${cpuPct.toFixed(1)}%`}
          percent={cpuPct}
          color={cpuPct > 80 ? "var(--accent-red)" : cpuPct > 50 ? "var(--accent-orange)" : "var(--accent-green)"}
        />
        <MetricRow
          label="Memory"
          value={sys ? `${(sys.used_ram_mb / 1024).toFixed(1)} / ${(sys.total_ram_mb / 1024).toFixed(1)} GB` : "--"}
          percent={ramPct}
          color={ramPct > 85 ? "var(--accent-red)" : ramPct > 60 ? "var(--accent-orange)" : "var(--accent-green)"}
        />
        <MetricRow
          label="GPU"
          value={`${gpuPct.toFixed(1)}%`}
          percent={gpuPct}
          color={gpuPct > 80 ? "var(--accent-red)" : gpuPct > 50 ? "var(--accent-orange)" : "var(--accent-green)"}
        />
        <MetricRow
          label="Disk"
          value={sys ? formatRate((sys.total_disk_read_per_sec ?? 0) + (sys.total_disk_write_per_sec ?? 0)) : "--"}
          color="var(--accent-primary)"
        />
        <MetricRow
          label="Network"
          value={sys ? formatRate((sys.total_net_send_per_sec ?? 0) + (sys.total_net_recv_per_sec ?? 0)) : "--"}
          color="var(--accent-primary)"
        />
        <MetricRow
          label="Battery"
          value={`${batteryPct.toFixed(0)}% ${sys?.is_charging ? "(AC)" : ""}`}
          percent={batteryPct}
          color={batteryPct < 20 ? "var(--accent-red)" : batteryPct < 50 ? "var(--accent-orange)" : "var(--accent-green)"}
        />
      </div>

      <div className="widget-footer">
        <span className="widget-proc-count">{sys?.process_count ?? "--"} processes</span>
        <span className="widget-power">{(sys?.power_draw_watts ?? 0).toFixed(1)} W</span>
      </div>
    </div>
  );
}

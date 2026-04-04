import { useSystemInfo } from "../hooks/useSystemInfo";

function formatRate(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`;
  if (bytesPerSec < 1048576) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / 1048576).toFixed(1)} MB/s`;
}

interface Props {
  activeTab: string;
  onTabChange: (tab: string) => void;
  displayMode: "percent" | "values";
}

export function SystemOverview({ activeTab, onTabChange, displayMode }: Props) {
  const { data: sys } = useSystemInfo();

  const ramPercent = sys ? (sys.used_ram_mb / sys.total_ram_mb) * 100 : 0;
  const cpuPercent = sys?.cpu_usage_percent ?? 0;
  const batteryPercent = sys?.battery_percent ?? 0;
  const gpuPercent = sys?.gpu_usage_percent ?? 0;

  return (
    <div className="system-overview">
      <div 
        className={`stat-card clickable ${activeTab === "processes" ? "active" : ""}`}
        onClick={() => onTabChange("processes")}
      >
        <span className="label">Processes</span>
        <span className="value">{sys?.process_count ?? "--"}</span>
      </div>

      <div 
        className={`stat-card clickable ${activeTab === "cpu" ? "active" : ""}`}
        onClick={() => onTabChange("cpu")}
      >
        <span className="label">CPU</span>
        <span className="value">{cpuPercent.toFixed(1)}%</span>
        <div className="stat-bar">
          <div
            className="stat-bar-fill"
            style={{
              width: `${cpuPercent}%`,
              background: cpuPercent > 80 ? "var(--accent-red)" : cpuPercent > 50 ? "var(--accent-orange)" : "var(--accent-blue)",
            }}
          />
        </div>
      </div>

      <div 
        className={`stat-card clickable ${activeTab === "memory" ? "active" : ""}`}
        onClick={() => onTabChange("memory")}
      >
        <span className="label">Memory</span>
        <span className="value">{sys ? `${(sys.used_ram_mb / 1024).toFixed(1)} GB` : "--"}</span>
        <span className="sub-value">
          {sys ? `${(sys.used_ram_mb / 1024).toFixed(1)} / ${(sys.total_ram_mb / 1024).toFixed(1)} GB` : ""}
        </span>
        <div className="stat-bar">
          <div
            className="stat-bar-fill"
            style={{
              width: `${ramPercent}%`,
              background: ramPercent > 85 ? "var(--accent-red)" : ramPercent > 60 ? "var(--accent-orange)" : "var(--accent-green)",
            }}
          />
        </div>
      </div>

      <div 
        className={`stat-card clickable ${activeTab === "disk" ? "active" : ""}`}
        onClick={() => onTabChange("disk")}
      >
        <span className="label">Disk</span>
        <span className="value">{sys ? formatRate((sys.total_disk_read_per_sec ?? 0) + (sys.total_disk_write_per_sec ?? 0)) : "--"}</span>
        <span className="sub-value">
          {sys ? `R: ${formatRate(sys.total_disk_read_per_sec ?? 0)} W: ${formatRate(sys.total_disk_write_per_sec ?? 0)}` : ""}
        </span>
      </div>

      <div 
        className={`stat-card clickable ${activeTab === "network" ? "active" : ""}`}
        onClick={() => onTabChange("network")}
      >
        <span className="label">Network</span>
        <span className="value">{sys ? formatRate((sys.total_net_send_per_sec ?? 0) + (sys.total_net_recv_per_sec ?? 0)) : "--"}</span>
        <span className="sub-value">
          {sys ? `S: ${formatRate(sys.total_net_send_per_sec ?? 0)} R: ${formatRate(sys.total_net_recv_per_sec ?? 0)}` : ""}
        </span>
      </div>

      <div 
        className={`stat-card clickable ${activeTab === "gpu" ? "active" : ""}`}
        onClick={() => onTabChange("gpu")}
      >
        <span className="label">GPU</span>
        <span className="value">{gpuPercent.toFixed(1)}%</span>
        <div className="stat-bar">
          <div
            className="stat-bar-fill"
            style={{
              width: `${gpuPercent}%`,
              background: gpuPercent > 80 ? "var(--accent-red)" : gpuPercent > 50 ? "var(--accent-orange)" : "var(--accent-blue)",
            }}
          />
        </div>
      </div>

      <div 
        className={`stat-card clickable ${activeTab === "battery" ? "active" : ""}`}
        onClick={() => onTabChange("battery")}
      >
        <span className="label">Battery {sys?.is_charging ? "(AC)" : ""}</span>
        {displayMode === "percent" ? (
          <span className="value">{batteryPercent.toFixed(0)}%</span>
        ) : (
          <span className="value">{(sys?.charge_rate_watts || sys?.power_draw_watts || 0).toFixed(1)} W</span>
        )}
        <div className="stat-bar">
          <div
            className="stat-bar-fill"
            style={{
              width: `${batteryPercent}%`,
              background: batteryPercent < 20 ? "var(--accent-red)" : batteryPercent < 50 ? "var(--accent-orange)" : "var(--accent-green)",
            }}
          />
        </div>
      </div>
    </div>
  );
}

import { useInsights, dismissInsight } from "../../lib/insightsEngine";
import { usePerformanceData } from "../../hooks/usePerformanceData";
import { endTask } from "../../lib/ipc";
import { useProcesses } from "../../hooks/useProcesses";
import { useSettings } from "../../lib/settings";
import type { Insight, InsightAction, WorkloadProfile } from "../../lib/insights";

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function PerformanceGauge({ score }: { score: number }) {
  const radius = 54;
  const stroke = 7;
  const circumference = 2 * Math.PI * radius;
  const progress = (score / 100) * circumference;
  const color = score >= 80 ? "#34d399" : score >= 50 ? "#f59e0b" : "#ef4444";
  const bgColor = score >= 80 ? "rgba(52,211,153,0.08)" : score >= 50 ? "rgba(245,158,11,0.08)" : "rgba(239,68,68,0.08)";
  const label = score >= 80 ? "Optimal" : score >= 50 ? "Fair" : "Poor";

  return (
    <div className="health-gauge" style={{ background: bgColor }}>
      <svg width="130" height="130" viewBox="0 0 130 130">
        <circle cx="65" cy="65" r={radius} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={stroke} />
        <circle
          cx="65" cy="65" r={radius}
          fill="none" stroke={color} strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${progress} ${circumference}`}
          transform="rotate(-90 65 65)"
          style={{ transition: "stroke-dasharray 0.8s ease, stroke 0.5s ease" }}
        />
      </svg>
      <div className="health-gauge-text">
        <span className="health-score" style={{ color }}>{score}</span>
        <span className="health-label">{label}</span>
      </div>
    </div>
  );
}

function QuickStat({ label, value, status, accent }: { label: string; value: string; status: "good" | "warn" | "bad"; accent: string }) {
  const borderColors = { good: accent, warn: "#f59e0b", bad: "#ef4444" };
  const textColors = { good: accent, warn: "#f59e0b", bad: "#ef4444" };
  const bgs = { good: hexToRgba(accent, 0.08), warn: "rgba(245,158,11,0.08)", bad: "rgba(239,68,68,0.08)" };
  return (
    <div className="quick-stat" style={{ borderColor: borderColors[status], background: bgs[status] }}>
      <span className="quick-stat-value" style={{ color: textColors[status] }}>{value}</span>
      <span className="quick-stat-label">{label}</span>
    </div>
  );
}

const SEVERITY_CONFIG = {
  critical: { color: "#ef4444", bg: "rgba(239,68,68,0.06)", border: "rgba(239,68,68,0.3)" },
  warning: { color: "#f59e0b", bg: "rgba(245,158,11,0.06)", border: "rgba(245,158,11,0.25)" },
  info: { color: "#3b82f6", bg: "rgba(59,130,246,0.06)", border: "rgba(59,130,246,0.2)" },
};

const CATEGORY_ICONS: Record<string, string> = {
  memory: "🧠", cpu: "⚙", disk: "💾", network: "🌐", gpu: "🎮", battery: "🔋", general: "📊",
};

function InsightCard({ insight, onAction }: { insight: Insight; onAction: (insight: Insight, action: InsightAction) => void }) {
  const config = SEVERITY_CONFIG[insight.severity];
  return (
    <div
      className="insight-card"
      style={{
        background: config.bg,
        borderLeft: `3px solid ${config.border}`,
        borderTop: `1px solid ${config.border}`,
        borderRight: `1px solid rgba(255,255,255,0.04)`,
        borderBottom: `1px solid rgba(255,255,255,0.04)`,
      }}
    >
      <div className="insight-card-header">
        <span className="insight-icon">{CATEGORY_ICONS[insight.category] || "📊"}</span>
        <span className="insight-title">{insight.title}</span>
        {insight.metric && (
          <span className="insight-metric" style={{ color: config.color, background: `${config.color}1a` }}>
            {insight.metric}
          </span>
        )}
      </div>
      <p className="insight-description">{insight.description}</p>
      {insight.actions.length > 0 && (
        <div className="insight-actions">
          {insight.actions.map((action, i) => (
            <button
              key={i}
              className={`insight-btn ${action.type === "end-task" ? "danger" : "ghost"}`}
              onClick={() => onAction(insight, action)}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const FAN_COLORS = {
  silent: { color: "#34d399", bg: "rgba(52,211,153,0.08)", border: "rgba(52,211,153,0.2)" },
  balanced: { color: "#3b82f6", bg: "rgba(59,130,246,0.08)", border: "rgba(59,130,246,0.2)" },
  performance: { color: "#f59e0b", bg: "rgba(245,158,11,0.08)", border: "rgba(245,158,11,0.2)" },
  turbo: { color: "#ef4444", bg: "rgba(239,68,68,0.08)", border: "rgba(239,68,68,0.2)" },
};

function WorkloadChip({ workload }: { workload: WorkloadProfile }) {
  return (
    <div className="workload-chip">
      <span className="workload-chip-icon">{workload.icon}</span>
      <span className="workload-chip-label">{workload.label}</span>
      {workload.matchedApps.length > 0 && (
        <span className="workload-chip-apps">
          {workload.matchedApps.slice(0, 2).map((a: string) => a.replace(/\.exe$/i, "")).join(", ")}
          {workload.matchedApps.length > 2 && ` +${workload.matchedApps.length - 2}`}
        </span>
      )}
    </div>
  );
}

export function InsightsPage() {
  const { insights, healthScore, calibrated, workloads, workloadSuggestions } = useInsights();
  const { current: snapshot } = usePerformanceData();
  const { data: processes } = useProcesses();
  const [settings] = useSettings();
  const accent = settings.accentColor;

  const handleAction = async (insight: Insight, action: InsightAction) => {
    if (action.type === "dismiss") {
      dismissInsight(insight.id);
    } else if (action.type === "end-task" && action.processName && processes) {
      const pids = processes
        .filter(p => (p.display_name || p.name) === action.processName || p.name === action.processName)
        .map(p => p.pid);
      for (const pid of pids) {
        try { await endTask(pid); } catch { /* ignore */ }
      }
      dismissInsight(insight.id);
    }
  };

  const handleCloseSuggestion = async (names: string[]) => {
    if (!processes) return;
    for (const name of names) {
      const pids = processes.filter(p => p.name === name).map(p => p.pid);
      for (const pid of pids) {
        try { await endTask(pid); } catch { /* ignore */ }
      }
    }
  };

  if (!snapshot) return <div className="loading-overlay">Initializing Insights...</div>;

  const cpuStatus: "good" | "warn" | "bad" = snapshot.cpu_usage_percent > 85 ? "bad" : snapshot.cpu_usage_percent > 60 ? "warn" : "good";
  const memUsedPct = (snapshot.used_ram_bytes / snapshot.total_ram_bytes) * 100;
  const memStatus: "good" | "warn" | "bad" = memUsedPct > 90 ? "bad" : memUsedPct > 75 ? "warn" : "good";
  const diskStatus: "good" | "warn" | "bad" = snapshot.disk_active_percent > 90 ? "bad" : snapshot.disk_active_percent > 60 ? "warn" : "good";
  const gpuStatus: "good" | "warn" | "bad" = snapshot.gpu_temperature > 85 ? "bad" : snapshot.gpu_temperature > 75 ? "warn" : "good";

  const criticals = insights.filter(i => i.severity === "critical");
  const warnings = insights.filter(i => i.severity === "warning");
  const infos = insights.filter(i => i.severity === "info");

  // Determine primary fan recommendation (highest priority workload)
  const primaryWorkload = workloads.length > 0 ? workloads[0] : null;
  const fanStyle = primaryWorkload ? (FAN_COLORS[primaryWorkload.fanProfile as keyof typeof FAN_COLORS] || FAN_COLORS.balanced) : FAN_COLORS.balanced;

  return (
    <div className="resource-page insights-page">
      <div className="page-header">
        <div className="header-main">
          <h2>Insights</h2>
          <div className="header-meta">
            <span className="meta-item">
              {!calibrated
                ? "Calibrating..."
                : `${insights.length} active insight${insights.length !== 1 ? "s" : ""}`
              }
            </span>
          </div>
        </div>
      </div>

      <div className="page-content">
        {/* Performance Score + Quick Stats */}
        <div className="insights-summary">
          <PerformanceGauge score={healthScore} />
          <div className="quick-stats-grid">
            <QuickStat label="CPU" value={`${snapshot.cpu_usage_percent.toFixed(0)}%`} status={cpuStatus} accent={accent} />
            <QuickStat label="Memory" value={`${memUsedPct.toFixed(0)}%`} status={memStatus} accent={accent} />
            <QuickStat label="Disk" value={`${snapshot.disk_active_percent.toFixed(0)}%`} status={diskStatus} accent={accent} />
            <QuickStat label="GPU Temp" value={snapshot.gpu_temperature > 0 ? `${snapshot.gpu_temperature.toFixed(0)}°C` : "N/A"} status={gpuStatus} accent={accent} />
          </div>
        </div>

        {/* Workload Detection */}
        <div className="workload-section">
          <div className="workload-card">
            <div className="workload-detected">
              <div className="workload-info">
                <span className="workload-type">Detected Workloads</span>
                {workloads.length > 0 ? (
                  <div className="workload-chips">
                    {workloads.map((wl, i) => <WorkloadChip key={i} workload={wl} />)}
                  </div>
                ) : (
                  <span className="workload-label" style={{ color: "var(--text-muted)" }}>
                    {calibrated ? "No specific workload detected" : "Calibrating..."}
                  </span>
                )}
              </div>
            </div>

            {primaryWorkload && (
              <div className="fan-recommendation" style={{ background: fanStyle.bg, borderColor: fanStyle.border }}>
                <div className="fan-header">
                  <span className="fan-icon">🌀</span>
                  <span className="fan-profile-label">Suggested Fan Profile</span>
                  <span className="fan-profile-badge" style={{ color: fanStyle.color, background: `${fanStyle.color}1a` }}>
                    {primaryWorkload.fanProfile.charAt(0).toUpperCase() + primaryWorkload.fanProfile.slice(1)}
                  </span>
                </div>
                <p className="fan-description">{primaryWorkload.fanDescription}</p>
              </div>
            )}

            {workloadSuggestions.length > 0 && (
              <div className="workload-suggestions">
                <span className="suggestion-title">Optimization Suggestions</span>
                {workloadSuggestions.map((s, i) => (
                  <div key={i} className="suggestion-row">
                    <span className="suggestion-reason">{s.reason}</span>
                    <button
                      className="insight-btn danger"
                      onClick={() => handleCloseSuggestion(s.close)}
                    >
                      Close {s.close.length > 1 ? `(${s.close.length})` : s.close[0].replace(/\.exe$/i, "")}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* All Clear State */}
        {insights.length === 0 && calibrated && (
          <div className="insights-clear" style={{ background: hexToRgba(accent, 0.04), borderColor: hexToRgba(accent, 0.15) }}>
            <div className="clear-icon" style={{ background: hexToRgba(accent, 0.12), color: accent }}>✓</div>
            <h3 style={{ color: accent }}>System Running Smoothly</h3>
            <p>No issues detected. TaskManager+ is continuously monitoring your system for performance problems, memory leaks, and optimization opportunities.</p>
          </div>
        )}

        {criticals.length > 0 && (
          <div className="insight-group">
            <h3 className="section-title" style={{ color: "#ef4444" }}>Critical Issues</h3>
            {criticals.map(i => <InsightCard key={i.id} insight={i} onAction={handleAction} />)}
          </div>
        )}

        {warnings.length > 0 && (
          <div className="insight-group">
            <h3 className="section-title" style={{ color: "#f59e0b" }}>Warnings</h3>
            {warnings.map(i => <InsightCard key={i.id} insight={i} onAction={handleAction} />)}
          </div>
        )}

        {infos.length > 0 && (
          <div className="insight-group">
            <h3 className="section-title" style={{ color: "#3b82f6" }}>Recommendations</h3>
            {infos.map(i => <InsightCard key={i.id} insight={i} onAction={handleAction} />)}
          </div>
        )}
      </div>
    </div>
  );
}

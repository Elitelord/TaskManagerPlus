import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getStartupApps,
  setStartupEnabled,
  setLogonTaskEnabled,
  revealInExplorer,
  openWindowsSettingsUri,
  isElevated,
  relaunchAsAdmin,
  getInstalledApps,
  WINDOWS_STARTUP_SETTINGS_URI,
} from "../../lib/ipc";
import type {
  StartupAppInfo,
  StartupAppsResponse,
  StartupImpact,
  StartupSource,
} from "../../lib/types";
import { useSettings } from "../../lib/settings";
import { useProcesses } from "../../hooks/useProcesses";
import { getFrequentApps, formatDuration } from "../../lib/appUsage";
import { explainProcess } from "../../lib/processExplain";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

const IMPACT_LABEL: Record<StartupImpact, string> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  not_measured: "Not measured",
};

const IMPACT_CLASS: Record<StartupImpact, string> = {
  none: "startup-impact-none",
  low: "startup-impact-low",
  medium: "startup-impact-medium",
  high: "startup-impact-high",
  not_measured: "startup-impact-unknown",
};

const SOURCE_LABEL: Record<StartupSource, string> = {
  registry_run: "Registry (Run)",
  registry_run32: "Registry (32-bit)",
  startup_folder: "Startup folder",
  packaged: "Microsoft Store",
};

type SortKey = "name" | "status" | "impact" | "source" | "cpu" | "disk";
type SortDir = "asc" | "desc";

// Only Name flexes; every other column is fixed so headers stay aligned over
// their values and no gap opens up in the middle of the table.
const STARTUP_GRID_DETAIL =
  "minmax(240px, 1fr) 200px 116px 104px 188px 84px 84px 96px";
const STARTUP_GRID_COMPACT =
  "minmax(240px, 1fr) 200px 116px 104px 188px 96px";

interface Props {
  initialFilter?: string;
}

function buildExplanation(app: StartupAppInfo): string {
  return explainProcess({
    name: app.exe_path.split(/[/\\]/).pop() ?? app.name,
    company_name: app.publisher,
    product_name: app.name,
    image_path: app.exe_path,
  });
}

export function StartupPage({ initialFilter = "" }: Props) {
  const queryClient = useQueryClient();
  const [settings] = useSettings();
  const { data: processes } = useProcesses();
  const [filter, setFilter] = useState(() => {
    try {
      return sessionStorage.getItem("tmp:startup-filter") ?? initialFilter;
    } catch {
      return initialFilter;
    }
  });
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [showDetailCols, setShowDetailCols] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elevated, setElevated] = useState(true);
  const [expandedExplainId, setExpandedExplainId] = useState<string | null>(null);
  const [logonOpen, setLogonOpen] = useState(false);
  const [busyTaskKey, setBusyTaskKey] = useState<string | null>(null);

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["startup-apps"],
    queryFn: getStartupApps,
    staleTime: 60_000,
  });

  const { data: installedApps } = useQuery({
    queryKey: ["installed-apps"],
    queryFn: getInstalledApps,
    staleTime: 120_000,
  });

  useEffect(() => {
    isElevated().then(setElevated).catch(() => setElevated(true));
  }, []);

  const frequentByExe = useMemo(() => {
    const map = new Map<string, { weekSeconds: number; totalSeconds: number }>();
    for (const app of getFrequentApps(250, { includeServices: true })) {
      map.set(app.name.toLowerCase(), {
        weekSeconds: app.weekSeconds,
        totalSeconds: app.totalSeconds,
      });
    }
    return map;
  }, [data?.apps.length]);

  const installedByPath = useMemo(() => {
    const map = new Map<string, number>();
    for (const app of installedApps ?? []) {
      if (app.install_location) {
        map.set(app.install_location.toLowerCase().replace(/\\/g, "/"), app.size_bytes);
      }
      map.set(app.name.toLowerCase(), app.size_bytes);
    }
    return map;
  }, [installedApps]);

  const processByExe = useMemo(() => {
    const map = new Map<string, { cpu: number; mem: number }>();
    for (const p of processes ?? []) {
      const key = (p.image_path || p.name).toLowerCase();
      const cur = map.get(key) ?? { cpu: 0, mem: 0 };
      cur.mem += p.private_working_set_mb;
      map.set(key, cur);
    }
    return map;
  }, [processes]);

  const apps = data?.apps ?? [];
  const enabledCount = apps.filter((a) => a.enabled).length;
  const highImpactCount = apps.filter((a) => a.enabled && a.impact === "high").length;
  const hasMachineScope = apps.some((a) => a.scope === "machine");

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    let rows = apps;
    if (q) {
      rows = rows.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          a.publisher.toLowerCase().includes(q) ||
          a.exe_path.toLowerCase().includes(q),
      );
    }
    const impactRank = (i: StartupImpact) =>
      i === "high" ? 4 : i === "medium" ? 3 : i === "low" ? 2 : i === "none" ? 1 : 0;
    rows = [...rows].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "name":
          cmp = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
          break;
        case "status":
          cmp = Number(b.enabled) - Number(a.enabled);
          break;
        case "impact":
          cmp = impactRank(b.impact) - impactRank(a.impact);
          break;
        case "source":
          cmp = a.source.localeCompare(b.source);
          break;
        case "cpu":
          cmp = (b.cpu_at_startup_ms ?? -1) - (a.cpu_at_startup_ms ?? -1);
          break;
        case "disk":
          cmp = (b.disk_at_startup_bytes ?? -1) - (a.disk_at_startup_bytes ?? -1);
          break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return rows;
  }, [apps, filter, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(key === "name" ? "asc" : "desc");
    }
  };

  const onToggle = useCallback(
    async (app: StartupAppInfo, next: boolean) => {
      if (!next && settings.confirmBeforeDisableStartup) {
        const ok = window.confirm(`Disable "${app.name}" at startup?`);
        if (!ok) return;
      }
      setBusyId(app.id);
      setError(null);
      try {
        await setStartupEnabled(app.id, next);
        queryClient.setQueryData<StartupAppsResponse>(
          ["startup-apps"],
          (old) =>
            old
              ? {
                  ...old,
                  apps: old.apps.map((a) =>
                    a.id === app.id ? { ...a, enabled: next } : a,
                  ),
                }
              : old,
        );
      } catch (e: unknown) {
        const msg = String(e);
        if (msg.includes("elevation_required")) {
          setError("Machine-wide startup entries require administrator privileges.");
          setElevated(false);
        } else {
          setError(msg);
        }
      } finally {
        setBusyId(null);
        // Re-read the real registry state regardless of outcome. The optimistic
        // update above keeps the toggle snappy, but this guarantees the UI
        // reflects what actually landed on disk — even if the write partially
        // succeeded or another tool changed it.
        void queryClient.invalidateQueries({ queryKey: ["startup-apps"] });
      }
    },
    [queryClient, settings.confirmBeforeDisableStartup],
  );

  const openLocation = async (app: StartupAppInfo) => {
    const path = app.exe_path || app.command;
    if (!path) return;
    try {
      await revealInExplorer(path);
    } catch (e: unknown) {
      setError(String(e));
    }
  };

  const usageLabel = (app: StartupAppInfo): string | null => {
    const leaf = app.exe_path.split(/[/\\]/).pop()?.toLowerCase() ?? "";
    if (!leaf) return null;
    const usage = frequentByExe.get(leaf);
    if (!usage) return "Not opened in 14 days";
    if (usage.weekSeconds <= 0) return "Not opened this week";
    return `Used ${formatDuration(usage.weekSeconds)} this week`;
  };

  const installedSize = (app: StartupAppInfo): string | null => {
    const pathKey = app.exe_path.toLowerCase().replace(/\\/g, "/");
    const dir = pathKey.includes("/") ? pathKey.slice(0, pathKey.lastIndexOf("/")) : "";
    const bytes = installedByPath.get(dir) ?? installedByPath.get(app.name.toLowerCase());
    return bytes && bytes > 0 ? formatBytes(bytes) : null;
  };

  const liveCost = (app: StartupAppInfo): string | null => {
    const key = app.exe_path.toLowerCase();
    const p = processByExe.get(key);
    if (!p || p.mem < 1) return null;
    return `${p.mem.toFixed(0)} MB RAM now`;
  };

  const tableClass = showDetailCols ? "startup-table--detail" : "startup-table--compact";
  const gridStyle = {
    gridTemplateColumns: showDetailCols ? STARTUP_GRID_DETAIL : STARTUP_GRID_COMPACT,
  } as const;

  const sortArrow = (key: SortKey) => {
    if (sortKey !== key) return null;
    return <span className="sort-arrow">{sortDir === "asc" ? "▲" : "▼"}</span>;
  };

  const onToggleLogonTask = async (path: string, name: string, enabled: boolean) => {
    const key = `${path}::${name}`;
    setBusyTaskKey(key);
    setError(null);
    try {
      await setLogonTaskEnabled(path, name, enabled);
      await queryClient.invalidateQueries({ queryKey: ["startup-apps"] });
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setBusyTaskKey(null);
    }
  };

  return (
    <div className="resource-page startup-page">
      <div className="page-header">
        <div className="header-main">
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <h2>Startup</h2>
            <div className="header-subtitle">
              <span className="adapter-name">Apps that run when you sign in</span>
            </div>
          </div>
          <div className="header-meta">
            <span className="meta-item">
              Total: <strong>{apps.length}</strong>
            </span>
            <span className="meta-item">
              Enabled: <strong>{enabledCount}</strong>
            </span>
            {highImpactCount > 0 && data?.impact_available && (
              <span className="meta-item">
                High impact: <strong>{highImpactCount}</strong>
              </span>
            )}
            <button
              type="button"
              className="btn-secondary"
              onClick={() => refetch()}
              disabled={isFetching}
            >
              {isFetching ? "Refreshing…" : "Refresh"}
            </button>
            <button
              type="button"
              className="btn-sm"
              onClick={() => openWindowsSettingsUri(WINDOWS_STARTUP_SETTINGS_URI)}
            >
              Windows Settings
            </button>
          </div>
        </div>
      </div>

      <div className="page-content">
        {!elevated && hasMachineScope && (
          <div className="info-panel startup-elevation-banner">
            <p className="setting-description" style={{ margin: 0 }}>
              Some machine-wide startup entries require administrator privileges to enable or disable.
            </p>
            <button
              type="button"
              className="btn-sm"
              onClick={async () => {
                try {
                  await relaunchAsAdmin();
                } catch (e: unknown) {
                  setError(String(e));
                }
              }}
            >
              Restart as Administrator
            </button>
          </div>
        )}

        {error && <div className="info-panel startup-error">{error}</div>}

        <div className="startup-toolbar">
          <div className="filter-search-wrap">
            <input
              type="text"
              placeholder="Filter startup apps…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <label className="startup-detail-toggle">
            <input
              type="checkbox"
              checked={showDetailCols}
              onChange={(e) => setShowDetailCols(e.target.checked)}
            />
            <span className="toggle-track">
              <span className="toggle-thumb" />
            </span>
            Show CPU / disk at startup
          </label>
        </div>

        {isLoading ? (
          <div className="loading-overlay">Loading startup apps…</div>
        ) : (
          <div className="info-panel startup-table-panel">
            <div className={`startup-table-wrap ${tableClass}`}>
              <div className="startup-table-header" style={gridStyle}>
                <button
                  type="button"
                  className={`startup-th startup-th-name ${sortKey === "name" ? "active" : ""}`}
                  onClick={() => toggleSort("name")}
                >
                  Name {sortArrow("name")}
                </button>
                <span className="startup-th startup-th-publisher">Publisher</span>
                <button
                  type="button"
                  className={`startup-th startup-th-status ${sortKey === "status" ? "active" : ""}`}
                  onClick={() => toggleSort("status")}
                >
                  Status {sortArrow("status")}
                </button>
                <button
                  type="button"
                  className={`startup-th startup-th-impact ${sortKey === "impact" ? "active" : ""}`}
                  onClick={() => toggleSort("impact")}
                >
                  Impact {sortArrow("impact")}
                </button>
                <button
                  type="button"
                  className={`startup-th startup-th-source ${sortKey === "source" ? "active" : ""}`}
                  onClick={() => toggleSort("source")}
                >
                  Source {sortArrow("source")}
                </button>
                {showDetailCols && (
                  <button
                    type="button"
                    className={`startup-th startup-th-metric ${sortKey === "cpu" ? "active" : ""}`}
                    onClick={() => toggleSort("cpu")}
                  >
                    {sortArrow("cpu")} CPU
                  </button>
                )}
                {showDetailCols && (
                  <button
                    type="button"
                    className={`startup-th startup-th-metric ${sortKey === "disk" ? "active" : ""}`}
                    onClick={() => toggleSort("disk")}
                  >
                    {sortArrow("disk")} Disk
                  </button>
                )}
                <span className="startup-th startup-th-actions">Actions</span>
              </div>
              {filtered.map((app) => (
                <StartupRow
                  key={app.id}
                  app={app}
                  gridStyle={gridStyle}
                  busy={busyId === app.id}
                  showDetailCols={showDetailCols}
                  explainOpen={expandedExplainId === app.id}
                  usageLabel={usageLabel(app)}
                  installedSize={installedSize(app)}
                  liveCost={liveCost(app)}
                  onToggle={onToggle}
                  onOpenLocation={() => openLocation(app)}
                  onToggleExplain={() =>
                    setExpandedExplainId((id) => (id === app.id ? null : app.id))
                  }
                />
              ))}
              {!filtered.length && (
                <div className="startup-empty">
                  {apps.length === 0
                    ? "No startup apps detected on this PC."
                    : "No startup apps match that filter."}
                </div>
              )}
            </div>
          </div>
        )}

        {data?.impact_available && (
          <p className="startup-footnote">
            Impact reflects your last sign-in. Reboot to refresh measurements.
          </p>
        )}

        {data?.logon_tasks && data.logon_tasks.length > 0 && (
          <div className="info-panel startup-logon-tasks">
            <div className="startup-logon-header">
              <button
                type="button"
                className="startup-logon-toggle"
                onClick={() => setLogonOpen((o) => !o)}
              >
                <span className={`toggle-chevron ${logonOpen ? "is-open" : ""}`}>▸</span>
                Logon scheduled tasks ({data.logon_tasks.length})
              </button>
              <button
                type="button"
                className="btn-sm"
                onClick={() => openWindowsSettingsUri("C:\\Windows\\System32\\taskschd.msc")}
              >
                Open Task Scheduler
              </button>
            </div>
            {logonOpen && (
              <div className="startup-logon-list">
              {data.logon_tasks.map((t) => {
                const taskKey = `${t.path}::${t.name}`;
                const busy = busyTaskKey === taskKey;
                return (
                  <div key={taskKey} className="startup-logon-row">
                    <div className="startup-logon-main">
                      <div className="startup-logon-name-row">
                        <span className="startup-logon-name">{t.name}</span>
                        <span
                          className={`startup-status-chip ${t.enabled ? "on" : "off"}`}
                        >
                          {t.enabled ? "Enabled" : "Disabled"}
                        </span>
                      </div>
                      <div className="startup-logon-meta">
                        {t.trigger || "logon"} · {t.exe_path || "—"}
                      </div>
                    </div>
                    <div className="startup-logon-actions">
                      <label className="startup-enable-toggle" title="Enable at logon">
                        <input
                          type="checkbox"
                          checked={t.enabled}
                          disabled={busy}
                          onChange={(e) =>
                            onToggleLogonTask(t.path, t.name, e.target.checked)
                          }
                        />
                        <span className="toggle-track">
                          <span className="toggle-thumb" />
                        </span>
                      </label>
                      {t.exe_path && (
                        <button
                          type="button"
                          className="insight-btn ghost"
                          onClick={() => revealInExplorer(t.exe_path).catch((e) => setError(String(e)))}
                        >
                          Open
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function StartupRow({
  app,
  gridStyle,
  busy,
  showDetailCols,
  explainOpen,
  usageLabel,
  installedSize,
  liveCost,
  onToggle,
  onOpenLocation,
  onToggleExplain,
}: {
  app: StartupAppInfo;
  gridStyle: CSSProperties;
  busy: boolean;
  showDetailCols: boolean;
  explainOpen: boolean;
  usageLabel: string | null;
  installedSize: string | null;
  liveCost: string | null;
  onToggle: (app: StartupAppInfo, enabled: boolean) => void;
  onOpenLocation: () => void;
  onToggleExplain: () => void;
}) {
  // Only built when this row is expanded — avoids running the explainer for
  // every row on each parent re-render (filter typing, sort, toggle).
  const explanation = useMemo(() => buildExplanation(app), [app]);
  const metaText = [
    usageLabel,
    installedSize ? `${installedSize} installed` : null,
    liveCost,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="startup-row-group">
      <div
        className={`startup-row ${explainOpen ? "is-expanded" : ""}`}
        style={gridStyle}
        onClick={onToggleExplain}
        title="Click for details"
      >
        <div className="startup-col-name">
          <span className="startup-icon-wrap">
            {app.icon_base64 ? (
              <img
                className="startup-icon"
                src={`data:image/png;base64,${app.icon_base64}`}
                alt=""
              />
            ) : (
              <span className="startup-icon-fallback">{app.name.charAt(0)}</span>
            )}
          </span>
          <div className="startup-name-block">
            <span className="startup-name">{app.name}</span>
            {metaText && <span className="startup-meta">{metaText}</span>}
          </div>
        </div>
      <span className="startup-col-publisher startup-td-publisher">{app.publisher || "—"}</span>
      <span className="startup-td-status">
        <label
          className={`startup-status-toggle ${app.enabled ? "on" : "off"}`}
          title={
            !app.editable
              ? "Managed by your organization"
              : app.enabled
                ? "Disable at startup"
                : "Enable at startup"
          }
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={app.enabled}
            disabled={!app.editable || busy}
            onChange={(e) => onToggle(app, e.target.checked)}
          />
          <span className="toggle-track">
            <span className="toggle-thumb" />
          </span>
          <span className="startup-status-text">
            {app.enabled ? "Enabled" : "Disabled"}
          </span>
        </label>
      </span>
      <span className="startup-td-impact">
        <span className={`startup-impact-badge ${IMPACT_CLASS[app.impact]}`}>
          {IMPACT_LABEL[app.impact]}
        </span>
      </span>
      <span className="startup-source startup-td-source">
        {SOURCE_LABEL[app.source]} · {app.scope === "machine" ? "All users" : "User"}
      </span>
      {showDetailCols && (
        <span className="startup-metric startup-td-metric">
          {app.cpu_at_startup_ms != null ? `${app.cpu_at_startup_ms} ms` : "—"}
        </span>
      )}
      {showDetailCols && (
        <span className="startup-metric startup-td-metric">
          {app.disk_at_startup_bytes != null ? formatBytes(app.disk_at_startup_bytes) : "—"}
        </span>
      )}
      <div className="startup-actions startup-td-actions">
          <button
            type="button"
            className="insight-btn ghost"
            onClick={(e) => {
              e.stopPropagation();
              onOpenLocation();
            }}
            disabled={!app.exe_path && !app.command}
          >
            Open
          </button>
        </div>
      </div>
      {explainOpen && <div className="startup-explain-wrap">{explanation}</div>}
    </div>
  );
}

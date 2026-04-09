import { useMemo, useRef, useCallback, useState, useEffect } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useProcesses } from "../hooks/useProcesses";
import { usePowerData } from "../hooks/usePowerData";
import { useDiskData } from "../hooks/useDiskData";
import { useNetworkData } from "../hooks/useNetworkData";
import { useGpuData } from "../hooks/useGpuData";
import { useStatusData } from "../hooks/useStatusData";
import { useSystemInfo } from "../hooks/useSystemInfo";
import { MemoryBar } from "./MemoryBar";
import { BatteryImpact } from "./BatteryImpact";
import { endTask } from "../lib/ipc";
import { useSettings } from "../lib/settings";
import type { ProcessRow, ProcessGroup, DisplayRow } from "../lib/types";
import type { SortField, SortDirection } from "../App";

interface Props {
  searchFilter: string;
  sortField: SortField;
  onSortFieldChange: (field: SortField) => void;
  sortDirection: SortDirection;
  onSortDirectionChange: (dir: SortDirection) => void;
}

function formatBytes(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`;
  if (bytesPerSec < 1048576) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / 1048576).toFixed(1)} MB/s`;
}

function getSortValue(group: ProcessGroup, field: SortField): number | string {
  switch (field) {
    case "cpu": return group.total_cpu_percent;
    case "memory": return group.total_private_mb + group.total_shared_mb;
    case "disk": return group.total_disk_read + group.total_disk_write;
    case "network": return group.total_net_send + group.total_net_recv;
    case "gpu": return group.total_gpu_percent;
    case "battery": return group.total_battery_percent;
    case "name": return group.display_name;
    default: return 0;
  }
}

function getChildSortValue(proc: ProcessRow, field: SortField): number | string {
  switch (field) {
    case "cpu": return proc.cpu_percent;
    case "memory": return proc.private_mb + proc.shared_mb;
    case "disk": return proc.disk_read_per_sec + proc.disk_write_per_sec;
    case "network": return proc.net_send_per_sec + proc.net_recv_per_sec;
    case "gpu": return proc.gpu_percent;
    case "battery": return proc.battery_percent;
    case "name": return proc.display_name || proc.name;
    default: return 0;
  }
}

function sortItems<T>(items: T[], field: SortField, direction: SortDirection, getValue: (item: T, field: SortField) => number | string): T[] {
  return [...items].sort((a, b) => {
    const va = getValue(a, field);
    const vb = getValue(b, field);
    if (field === "name") {
      const cmp = (va as string).localeCompare(vb as string);
      return direction === "asc" ? cmp : -cmp;
    }
    const diff = (va as number) - (vb as number);
    return direction === "asc" ? diff : -diff;
  });
}

// Process type chip labels
const TYPE_LABELS: Record<string, string> = {
  "main": "Main",
  "renderer": "Renderer",
  "gpu": "GPU",
  "extension": "Extension",
  "extension-host": "Extensions",
  "utility": "Utility",
  "utility-network": "Network",
  "utility-storage": "Storage",
  "utility-audio": "Audio",
  "utility-video": "Video",
  "crashpad": "Crash Handler",
  "content": "Content",
  "rdd": "Media",
  "socket": "Network",
  "pty-host": "Terminal",
  "watcher": "File Watcher",
  "shared": "Shared",
  "service": "Service",
};

// Browser exe names where "renderer" means a tab
const BROWSER_EXES = new Set(["chrome.exe", "msedge.exe", "brave.exe", "opera.exe", "vivaldi.exe", "firefox.exe"]);

function processTypeLabel(type: string, exeName?: string): string {
  if (type === "renderer" && exeName && BROWSER_EXES.has(exeName.toLowerCase())) {
    return "Tab";
  }
  return TYPE_LABELS[type] || type;
}

// EMA smoothing for per-process CPU/power values to reduce visual jitter
const CPU_EMA_ALPHA = 0.35; // higher = more responsive, lower = smoother

export function ProcessTable({
  searchFilter,
  sortField,
  onSortFieldChange,
  sortDirection,
  onSortDirectionChange,
}: Props) {
  const { data: processes, isLoading, error } = useProcesses();
  const { data: powerData } = usePowerData();
  const { data: diskData } = useDiskData();
  const { data: networkData } = useNetworkData();
  const { data: gpuData } = useGpuData();
  const { data: statusData } = useStatusData();
  const { data: sysInfo } = useSystemInfo();
  const [settings] = useSettings();
  const displayMode = settings.displayMode;
  const parentRef = useRef<HTMLDivElement>(null);

  // EMA state for smoothing CPU and power per PID
  const cpuEmaRef = useRef(new Map<number, number>());
  const powerEmaRef = useRef(new Map<number, number>());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ pid: number; name: string; x: number; y: number } | null>(null);
  const [confirmEnd, setConfirmEnd] = useState<{ pid: number; name: string } | null>(null);
  const hiddenCols = new Set(settings.hiddenColumns);
  const contextMenuRef = useRef(contextMenu);
  contextMenuRef.current = contextMenu;

  const toggleGroup = useCallback((name: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  // Critical system processes that should never be killed
  const PROTECTED_PROCESSES = useMemo(() => new Set([
    "explorer.exe", "csrss.exe", "wininit.exe", "winlogon.exe",
    "services.exe", "lsass.exe", "smss.exe", "svchost.exe",
    "dwm.exe", "system", "system idle process", "registry",
    "ntoskrnl.exe", "conhost.exe", "fontdrvhost.exe",
    "memory compression", "secure system",
  ]), []);

  const isProtected = useCallback((name: string) => {
    return PROTECTED_PROCESSES.has(name.toLowerCase());
  }, [PROTECTED_PROCESSES]);

  const handleEndTask = useCallback(async (pid: number, name: string) => {
    setContextMenu(null);
    if (PROTECTED_PROCESSES.has(name.toLowerCase())) {
      alert(`Cannot end "${name}" — it is a critical system process. Terminating it could crash or freeze Windows.`);
      return;
    }
    if (settings.confirmEndTask) {
      setConfirmEnd({ pid, name });
    } else {
      try { await endTask(pid); } catch (e) { alert(`Failed to end ${name}: ${e}`); }
    }
  }, [PROTECTED_PROCESSES, settings.confirmEndTask]);

  const confirmEndTask = useCallback(async () => {
    if (!confirmEnd) return;
    try {
      await endTask(confirmEnd.pid);
    } catch (e) {
      alert(`Failed to end ${confirmEnd.name} (PID ${confirmEnd.pid}): ${e}`);
    }
    setConfirmEnd(null);
  }, [confirmEnd]);

  const handleContextMenu = useCallback((e: React.MouseEvent, pid: number, name: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ pid, name, x: e.clientX, y: e.clientY });
  }, []);

  // Dismiss context menu on left-click anywhere or right-click elsewhere
  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = (e: MouseEvent) => {
      // Don't dismiss on the right-click that opened it
      if (e.button === 2) return;
      setContextMenu(null);
    };
    const dismissOnScroll = () => setContextMenu(null);
    // Use mousedown so it fires before onClick handlers
    window.addEventListener("mousedown", dismiss);
    window.addEventListener("scroll", dismissOnScroll, true);
    return () => {
      window.removeEventListener("mousedown", dismiss);
      window.removeEventListener("scroll", dismissOnScroll, true);
    };
  }, [contextMenu]);

  const groups: ProcessGroup[] = useMemo(() => {
    if (!processes) return [];

    const powerMap = new Map((powerData ?? []).map((p) => [p.pid, p]));
    const diskMap = new Map((diskData ?? []).map((p) => [p.pid, p]));
    const netMap = new Map((networkData ?? []).map((p) => [p.pid, p]));
    const gpuMap = new Map((gpuData ?? []).map((p) => [p.pid, p]));
    const statusMap = new Map((statusData ?? []).map((p) => [p.pid, p]));

    // Apply EMA smoothing to CPU and power values to reduce jitter
    const cpuEma = cpuEmaRef.current;
    const powerEma = powerEmaRef.current;
    const seenPids = new Set<number>();

    let merged: ProcessRow[] = processes.map((proc) => {
      const power = powerMap.get(proc.pid);
      const disk = diskMap.get(proc.pid);
      const net = netMap.get(proc.pid);
      const gpu = gpuMap.get(proc.pid);
      const st = statusMap.get(proc.pid);

      const rawCpu = power?.cpu_percent ?? 0;
      const rawPower = power?.power_watts ?? 0;
      seenPids.add(proc.pid);

      // EMA: smooth = alpha * new + (1 - alpha) * previous
      const prevCpu = cpuEma.get(proc.pid);
      const smoothedCpu = prevCpu !== undefined
        ? CPU_EMA_ALPHA * rawCpu + (1 - CPU_EMA_ALPHA) * prevCpu
        : rawCpu;
      cpuEma.set(proc.pid, smoothedCpu);

      const prevPow = powerEma.get(proc.pid);
      const smoothedPow = prevPow !== undefined
        ? CPU_EMA_ALPHA * rawPower + (1 - CPU_EMA_ALPHA) * prevPow
        : rawPower;
      powerEma.set(proc.pid, smoothedPow);

      return {
        ...proc,
        cpu_percent: smoothedCpu,
        battery_percent: power?.battery_percent ?? 0,
        energy_uj: power?.energy_uj ?? 0,
        power_watts: smoothedPow,
        disk_read_per_sec: disk?.read_bytes_per_sec ?? 0,
        disk_write_per_sec: disk?.write_bytes_per_sec ?? 0,
        net_send_per_sec: net?.send_bytes_per_sec ?? 0,
        net_recv_per_sec: net?.recv_bytes_per_sec ?? 0,
        gpu_percent: gpu?.gpu_usage_percent ?? 0,
        status: st?.status ?? "unknown",
      };
    });

    // Clean up EMA maps for processes that no longer exist
    for (const pid of cpuEma.keys()) {
      if (!seenPids.has(pid)) { cpuEma.delete(pid); powerEma.delete(pid); }
    }

    if (searchFilter) {
      const lower = searchFilter.toLowerCase();
      merged = merged.filter(
        (r) => r.name.toLowerCase().includes(lower) || r.pid.toString().includes(lower),
      );
    }

    const groupMap = new Map<string, ProcessRow[]>();
    for (const proc of merged) {
      const gName = proc.display_name || proc.name;
      const existing = groupMap.get(gName);
      if (existing) existing.push(proc);
      else groupMap.set(gName, [proc]);
    }

    const result: ProcessGroup[] = [];
    for (const [name, children] of groupMap) {
      const hasAnySuspended = children.some((c) => c.status === "suspended");
      const allSuspended = children.every((c) => c.status === "suspended");
      result.push({
        name,
        display_name: name,
        count: children.length,
        total_private_mb: children.reduce((s, c) => s + c.private_mb, 0),
        total_shared_mb: children.reduce((s, c) => s + c.shared_mb, 0),
        total_working_set_mb: children.reduce((s, c) => s + c.working_set_mb, 0),
        total_battery_percent: children.reduce((s, c) => s + c.battery_percent, 0),
        total_energy_uj: children.reduce((s, c) => s + c.energy_uj, 0),
        total_cpu_percent: children.reduce((s, c) => s + c.cpu_percent, 0),
        total_disk_read: children.reduce((s, c) => s + c.disk_read_per_sec, 0),
        total_disk_write: children.reduce((s, c) => s + c.disk_write_per_sec, 0),
        total_net_send: children.reduce((s, c) => s + c.net_send_per_sec, 0),
        total_net_recv: children.reduce((s, c) => s + c.net_recv_per_sec, 0),
        total_gpu_percent: children.reduce((s, c) => s + c.gpu_percent, 0),
        total_power_watts: children.reduce((s, c) => s + c.power_watts, 0),
        status: allSuspended ? "suspended" : hasAnySuspended ? "running" : children[0]?.status ?? "unknown",
        children: sortItems(children, sortField, sortDirection, getChildSortValue),
      });
    }

    return sortItems(result, sortField, sortDirection, getSortValue);
  }, [processes, powerData, diskData, networkData, gpuData, statusData, searchFilter, sortField, sortDirection]);

  const displayRows: DisplayRow[] = useMemo(() => {
    const rows: DisplayRow[] = [];
    for (const group of groups) {
      const expanded = expandedGroups.has(group.name);
      rows.push({ type: "group", group, expanded });
      if (expanded) {
        for (const child of group.children) {
          rows.push({ type: "child", process: child, groupName: group.name });
        }
      }
    }
    return rows;
  }, [groups, expandedGroups]);

  const maxMemory = useMemo(
    () => groups.reduce((max, g) => Math.max(max, g.total_private_mb + g.total_shared_mb), 1),
    [groups],
  );

  const maxChildMemory = useMemo(
    () => groups.reduce((max, g) => g.children.reduce((m, c) => Math.max(m, c.private_mb + c.shared_mb), max), 1),
    [groups],
  );

  const virtualizer = useVirtualizer({
    count: displayRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: useCallback(() => 36, []),
    overscan: 20,
  });

  if (isLoading) {
    return <div className="loading-overlay">Loading processes...</div>;
  }

  if (error) {
    return <div className="error-message">Failed to load processes: {String(error)}</div>;
  }

  // Build dynamic grid-template-columns based on hidden columns
  // Base: name(1fr) status(74px) cpu(60px) memory(120px) disk(82px) network(82px) gpu(50px) battery(64px) actions(64px)
  const gridCols: string[] = ["1fr", "74px"];
  if (!hiddenCols.has("cpu")) gridCols.push("60px");
  if (!hiddenCols.has("memory")) gridCols.push("120px");
  if (!hiddenCols.has("disk")) gridCols.push("82px");
  if (!hiddenCols.has("network")) gridCols.push("82px");
  if (!hiddenCols.has("gpu")) gridCols.push("50px");
  if (!hiddenCols.has("battery")) gridCols.push("64px");
  gridCols.push("64px");
  const gridStyle: React.CSSProperties = { gridTemplateColumns: gridCols.join(" ") };

  const colClass = (field: SortField) => `col ${sortField === field ? "active" : ""}`;

  const handleSortClick = (field: SortField) => {
    if (sortField === field) {
      onSortDirectionChange(sortDirection === "asc" ? "desc" : "asc");
    } else {
      onSortFieldChange(field);
      onSortDirectionChange(field === "name" ? "asc" : "desc");
    }
  };

  const sortArrow = (field: SortField) => {
    if (sortField !== field) return null;
    return <span className="sort-arrow">{sortDirection === "asc" ? "▲" : "▼"}</span>;
  };

  return (
    <div className="table-container">
      <div className="table-header" style={gridStyle}>
        <div className={colClass("name")} onClick={() => handleSortClick("name")}>Name {sortArrow("name")}</div>
        <div className="col">Status</div>
        {!hiddenCols.has("cpu") && <div className={colClass("cpu")} onClick={() => handleSortClick("cpu")}>CPU {sortArrow("cpu")}</div>}
        {!hiddenCols.has("memory") && <div className={colClass("memory")} onClick={() => handleSortClick("memory")}>Memory {sortArrow("memory")}</div>}
        {!hiddenCols.has("disk") && <div className={colClass("disk")} onClick={() => handleSortClick("disk")}>Disk {sortArrow("disk")}</div>}
        {!hiddenCols.has("network") && <div className={colClass("network")} onClick={() => handleSortClick("network")}>Network {sortArrow("network")}</div>}
        {!hiddenCols.has("gpu") && <div className={colClass("gpu")} onClick={() => handleSortClick("gpu")}>GPU {sortArrow("gpu")}</div>}
        {!hiddenCols.has("battery") && <div className={colClass("battery")} onClick={() => handleSortClick("battery")}>Battery {sortArrow("battery")}</div>}
        <div className="col"></div>
      </div>

      <div className="table-body" ref={parentRef}>
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: "100%",
            position: "relative",
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = displayRows[virtualRow.index];

            if (row.type === "group") {
              const { group, expanded } = row;
              const isSingle = group.count === 1;
              const child = group.children[0];

              return (
                <div
                  key={`g-${group.name}`}
                  className={`table-row group-row ${expanded ? "expanded" : ""} ${group.status === "suspended" ? "suspended" : ""}`}
                  style={{
                    ...gridStyle,
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                  onClick={() => !isSingle && toggleGroup(group.name)}
                  onContextMenu={(e) => handleContextMenu(e, child.pid, group.display_name)}
                >
                  <span className="name" title={group.display_name} style={{display: 'flex', alignItems: 'center'}}>
                    <span className="expand-toggle" style={{marginRight: '6px', width: '16px', display: 'inline-block'}}>{isSingle ? "" : (expanded ? "\u25BC" : "\u25B6")}</span>
                    {child.icon_base64 && <img className="process-icon" src={`data:image/png;base64,${child.icon_base64}`} alt="icon" />}
                    <span>{group.display_name}</span>
                    {!isSingle && <span className="group-count">({group.count})</span>}
                  </span>
                  <span className={`status-badge ${group.status}`}>
                    {group.status === "suspended" ? "Suspended" : ""}
                  </span>
                  {!hiddenCols.has("cpu") && <span className="metric-value cpu-value">
                    {(isSingle ? child.cpu_percent : group.total_cpu_percent).toFixed(1)}{displayMode === "percent" ? "%" : ""}
                  </span>}
                  {!hiddenCols.has("memory") && <MemoryBar
                    privateMb={isSingle ? child.private_mb : group.total_private_mb}
                    sharedMb={isSingle ? child.shared_mb : group.total_shared_mb}
                    maxMb={maxMemory}
                    displayMode={displayMode}
                    totalSystemMb={sysInfo?.total_ram_mb}
                  />}
                  {!hiddenCols.has("disk") && <span className="metric-value">
                    {formatBytes(isSingle ? child.disk_read_per_sec + child.disk_write_per_sec : group.total_disk_read + group.total_disk_write)}
                  </span>}
                  {!hiddenCols.has("network") && <span className="metric-value">
                    {formatBytes(isSingle ? child.net_send_per_sec + child.net_recv_per_sec : group.total_net_send + group.total_net_recv)}
                  </span>}
                  {!hiddenCols.has("gpu") && <span className="metric-value">
                    {(isSingle ? child.gpu_percent : group.total_gpu_percent).toFixed(1)}{displayMode === "percent" ? "%" : ""}
                  </span>}
                  {!hiddenCols.has("battery") && (displayMode === "percent" ? (
                    <BatteryImpact percent={isSingle ? child.battery_percent : group.total_battery_percent} />
                  ) : (
                    <span className="metric-value">
                      {(isSingle ? child.power_watts : group.total_power_watts).toFixed(2)} W
                    </span>
                  ))}
                  <span className="end-task-cell">
                    {isSingle && !isProtected(child.name) && (
                      <button
                        className="end-task-btn"
                        onClick={(e) => { e.stopPropagation(); handleEndTask(child.pid, child.name); }}
                        title="End Task"
                      >
                        End task
                      </button>
                    )}
                  </span>
                </div>
              );
            }

            const { process: proc } = row;
            return (
              <div
                key={`c-${proc.pid}`}
                className={`table-row child-row ${proc.status === "suspended" ? "suspended" : ""}`}
                style={{
                  ...gridStyle,
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: `${virtualRow.size}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                onContextMenu={(e) => handleContextMenu(e, proc.pid, proc.name)}
              >
                <span className="name child-name" title={proc.display_name} style={{display: 'flex', alignItems: 'center', paddingLeft: '22px'}}>
                  {proc.icon_base64 && <img className="process-icon" src={`data:image/png;base64,${proc.icon_base64}`} alt="icon" />}
                  <span>{proc.display_name || proc.name}</span>
                  {proc.process_type && <span className={`process-type-chip ${proc.process_type}`}>{processTypeLabel(proc.process_type, proc.name)}</span>}
                </span>
                <span className={`status-badge ${proc.status}`}>
                  {proc.status === "suspended" ? "Suspended" : ""}
                </span>
                {!hiddenCols.has("cpu") && <span className="metric-value cpu-value">{proc.cpu_percent.toFixed(1)}{displayMode === "percent" ? "%" : ""}</span>}
                {!hiddenCols.has("memory") && <MemoryBar privateMb={proc.private_mb} sharedMb={proc.shared_mb} maxMb={maxChildMemory} displayMode={displayMode} totalSystemMb={sysInfo?.total_ram_mb} />}
                {!hiddenCols.has("disk") && <span className="metric-value">{formatBytes(proc.disk_read_per_sec + proc.disk_write_per_sec)}</span>}
                {!hiddenCols.has("network") && <span className="metric-value">{formatBytes(proc.net_send_per_sec + proc.net_recv_per_sec)}</span>}
                {!hiddenCols.has("gpu") && <span className="metric-value">{proc.gpu_percent.toFixed(1)}{displayMode === "percent" ? "%" : ""}</span>}
                {!hiddenCols.has("battery") && (displayMode === "percent" ? (
                  <BatteryImpact percent={proc.battery_percent} />
                ) : (
                  <span className="metric-value">{proc.power_watts.toFixed(2)} W</span>
                ))}
                <span className="end-task-cell">
                  {!isProtected(proc.name) && (
                    <button
                      className="end-task-btn"
                      onClick={(e) => { e.stopPropagation(); handleEndTask(proc.pid, proc.name); }}
                      title="End Task"
                    >
                      End task
                    </button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {contextMenu && (
        <div
          className="context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="context-menu-header">{contextMenu.name} (PID {contextMenu.pid})</div>
          <button
            className="context-menu-item"
            onClick={async () => {
              const { setPriority } = await import("../lib/ipc");
              try {
                await setPriority(contextMenu.pid, 0x00000040); // IDLE_PRIORITY_CLASS
                setContextMenu(null);
              } catch (e) {
                alert(`Failed to set Eco Mode: ${e}`);
              }
            }}
          >
            Efficiency Mode (Eco)
          </button>
          {isProtected(contextMenu.name) ? (
            <span className="context-menu-item" style={{ color: "var(--text-muted)", cursor: "default" }}>
              Protected Process
            </span>
          ) : (
            <button
              className="context-menu-item danger"
              onClick={() => handleEndTask(contextMenu.pid, contextMenu.name)}
            >
              End Task
            </button>
          )}
        </div>
      )}

      {confirmEnd && (
        <div className="confirm-overlay" onClick={() => setConfirmEnd(null)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-title">End Task</div>
            <div className="confirm-message">
              Are you sure you want to end <strong>{confirmEnd.name}</strong> (PID {confirmEnd.pid})?
              <br />
              <span className="confirm-warning">Unsaved data in this application may be lost.</span>
            </div>
            <div className="confirm-actions">
              <button className="confirm-btn cancel" onClick={() => setConfirmEnd(null)}>Cancel</button>
              <button className="confirm-btn danger" onClick={confirmEndTask}>End Task</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

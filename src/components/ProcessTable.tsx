import { useMemo, useRef, useCallback, useState, useEffect } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useProcesses } from "../hooks/useProcesses";
import { usePowerData } from "../hooks/usePowerData";
import { useDiskData } from "../hooks/useDiskData";
import { useNetworkData } from "../hooks/useNetworkData";
import { useGpuData } from "../hooks/useGpuData";
import { useNpuData } from "../hooks/useNpuData";
import { useStatusData } from "../hooks/useStatusData";
import { useSystemInfo } from "../hooks/useSystemInfo";
import { getCachedSnapshot } from "../hooks/usePerformanceData";
import { TelemetryStatusNotice, useHasTelemetryProblem } from "./TelemetryStatusNotice";
import { MemoryBar } from "./MemoryBar";
import { BatteryImpact } from "./BatteryImpact";
import { endTask } from "../lib/ipc";
import {
  classifyEndTaskSafety,
  endTaskWarning,
  type EndTaskSafety,
} from "../lib/endTaskSafety";
import { explainProcess, explainProcessGroup, isLowInfoExplanation } from "../lib/processExplain";
import { flagSuspiciousProcess } from "../lib/processSuspicion";
import { useSettings } from "../lib/settings";
import { tryExplainProcess } from "../lib/ai/tierGate";
import { tierEnablesEmbeddings } from "../lib/ai/types";
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
    case "memory": return group.total_private_working_set_mb;
    case "disk": return group.total_disk_read + group.total_disk_write;
    case "network": return group.total_net_send + group.total_net_recv;
    case "gpu": return group.total_gpu_percent;
    case "npu": return group.total_npu_percent;
    case "battery": return group.total_battery_percent;
    case "name": return group.display_name;
    default: return 0;
  }
}

function getChildSortValue(proc: ProcessRow, field: SortField): number | string {
  switch (field) {
    case "cpu": return proc.cpu_percent;
    case "memory": return proc.private_working_set_mb;
    case "disk": return proc.disk_read_per_sec + proc.disk_write_per_sec;
    case "network": return proc.net_send_per_sec + proc.net_recv_per_sec;
    case "gpu": return proc.gpu_percent;
    case "npu": return proc.npu_percent;
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
  const hasTelemetryProblem = useHasTelemetryProblem();
  const { data: powerData } = usePowerData();
  const { data: diskData } = useDiskData();
  const { data: networkData } = useNetworkData();
  const { data: gpuData } = useGpuData();
  const { data: npuData } = useNpuData();
  const { data: statusData } = useStatusData();
  const { data: sysInfo } = useSystemInfo();
  const [settings] = useSettings();
  const displayMode = settings.displayMode;
  const parentRef = useRef<HTMLDivElement>(null);

  // EMA state for smoothing CPU and power per PID
  const cpuEmaRef = useRef(new Map<number, number>());
  const powerEmaRef = useRef(new Map<number, number>());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ pid: number; name: string; company_name?: string; image_path?: string; x: number; y: number } | null>(null);
  const [confirmEnd, setConfirmEnd] = useState<{ pid: number; name: string; safety: EndTaskSafety } | null>(null);
  const cancelEndRef = useRef<HTMLButtonElement>(null);

  // Esc dismisses the end-task confirm and the context menu. Neither had any
  // key handling at all — the dialog could only be dismissed by clicking, so
  // the backdrop click was the sole escape route. Same window-listener pattern
  // as FileInspector and StoragePage's ConfirmDialog.
  useEffect(() => {
    if (!confirmEnd && !contextMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (confirmEnd) setConfirmEnd(null);
      else setContextMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmEnd, contextMenu]);

  // Move focus into the dialog when it opens, so Esc and Tab act on it rather
  // than on whatever was focused in the table behind it.
  useEffect(() => {
    if (confirmEnd) cancelEndRef.current?.focus();
  }, [confirmEnd]);

  // P5 — semantic explanations for processes the rule-based explainer can't
  // identify (no publisher info, unknown name). Filled lazily when the user
  // hovers a row, keyed by the process descriptor. The `pending` ref dedupes
  // in-flight / already-resolved lookups so each unknown process is asked at
  // most once. Only runs when the AI tier enables embeddings.
  const aiEnabled = tierEnablesEmbeddings(settings.aiTier);
  const [aiExplain, setAiExplain] = useState<Map<string, string>>(new Map());
  const aiExplainPending = useRef<Set<string>>(new Set());

  // Build the text we hand the embedding model. The window title is the
  // strongest signal ("Invoice 2024 — FastBooks" tells you far more than
  // "fastbooks.exe"), followed by the display/exe name and the parent folder.
  const aiDescriptor = useCallback((p: ProcessRow): string => {
    const folder = (p.image_path || "")
      .replace(/\\/g, "/")
      .split("/")
      .slice(-2, -1)[0] ?? "";
    return [p.window_title, p.display_name || p.name, p.product_name, p.company_name, folder]
      .map((s) => (s || "").trim())
      .filter(Boolean)
      .join(" · ");
  }, []);

  const maybeExplainAi = useCallback((p: ProcessRow) => {
    if (!aiEnabled || !isLowInfoExplanation(p)) return;
    const key = aiDescriptor(p);
    if (!key || aiExplainPending.current.has(key)) return;
    aiExplainPending.current.add(key);
    tryExplainProcess(key)
      .then((desc) => { if (desc) setAiExplain((m) => new Map(m).set(key, desc)); })
      .catch(() => {});
  }, [aiEnabled, aiDescriptor]);

  // The explanation line for a process tooltip. When a P5 semantic
  // explanation has resolved for a low-info process, it REPLACES the generic
  // rule-based line ("Unrecognised program…") rather than stacking on top of
  // it, and is attributed so the user knows it was AI-derived rather than read
  // straight from the file's metadata.
  //
  // This used to be a "✨" prefix. The provenance is worth surfacing, but a
  // sparkle is a glyph the reader has to already know the meaning of, and it
  // reads as decoration. The tooltip is a native title= (plain text, already
  // multi-line), so an attribution line says it outright.
  const explanationFor = useCallback((p: ProcessRow): string => {
    const ai = aiEnabled ? aiExplain.get(aiDescriptor(p)) : undefined;
    return ai ? `${ai}\nAI-generated description.` : explainProcess(p);
  }, [aiEnabled, aiExplain, aiDescriptor]);
  // Sidebar "Show GPU/NPU/Battery" toggles are folded into hiddenColumns so a
  // single toggle (either the column toggle or the sidebar toggle) hides the
  // metric in the sidebar and the process table, and stops the backend fetch
  // for GPU/NPU (see usePerformanceData).
  const hiddenCols = new Set(settings.hiddenColumns);
  if (!settings.showGpu) hiddenCols.add("gpu");
  if (!settings.showNpu) hiddenCols.add("npu");
  if (!settings.showBattery) hiddenCols.add("battery");
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

  // End-task safety (feature P2): grade how dangerous ending a process is
  // from its name + PE metadata. `critical` is refused outright; `caution`
  // and `normal` go through the confirm dialog with an appropriate warning.
  const handleEndTask = useCallback(async (target: {
    pid: number;
    name: string;
    company_name?: string;
    image_path?: string;
  }) => {
    setContextMenu(null);
    const safety = classifyEndTaskSafety(target);
    if (safety === "critical") {
      alert(`Cannot end "${target.name}" — ${endTaskWarning("critical")}`);
      return;
    }
    if (settings.confirmEndTask) {
      setConfirmEnd({ pid: target.pid, name: target.name, safety });
    } else {
      try { await endTask(target.pid); } catch (e) { alert(`Failed to end ${target.name}: ${e}`); }
    }
  }, [settings.confirmEndTask]);

  const confirmEndTask = useCallback(async () => {
    if (!confirmEnd) return;
    try {
      await endTask(confirmEnd.pid);
    } catch (e) {
      alert(`Failed to end ${confirmEnd.name} (PID ${confirmEnd.pid}): ${e}`);
    }
    setConfirmEnd(null);
  }, [confirmEnd]);

  const handleContextMenu = useCallback((
    e: React.MouseEvent,
    pid: number,
    name: string,
    company_name?: string,
    image_path?: string,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ pid, name, company_name, image_path, x: e.clientX, y: e.clientY });
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
    const npuMap = new Map((npuData ?? []).map((p) => [p.pid, p]));
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
      const npu = npuMap.get(proc.pid);
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
        npu_percent: npu?.npu_usage_percent ?? 0,
        npu_dedicated_bytes: npu?.npu_dedicated_bytes ?? 0,
        npu_shared_bytes: npu?.npu_shared_bytes ?? 0,
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
        total_private_working_set_mb: children.reduce((s, c) => s + c.private_working_set_mb, 0),
        total_battery_percent: children.reduce((s, c) => s + c.battery_percent, 0),
        total_energy_uj: children.reduce((s, c) => s + c.energy_uj, 0),
        total_cpu_percent: children.reduce((s, c) => s + c.cpu_percent, 0),
        total_disk_read: children.reduce((s, c) => s + c.disk_read_per_sec, 0),
        total_disk_write: children.reduce((s, c) => s + c.disk_write_per_sec, 0),
        total_net_send: children.reduce((s, c) => s + c.net_send_per_sec, 0),
        total_net_recv: children.reduce((s, c) => s + c.net_recv_per_sec, 0),
        total_gpu_percent: children.reduce((s, c) => s + c.gpu_percent, 0),
        total_npu_percent: children.reduce((s, c) => s + c.npu_percent, 0),
        total_npu_dedicated_bytes: children.reduce((s, c) => s + c.npu_dedicated_bytes, 0),
        total_npu_shared_bytes: children.reduce((s, c) => s + c.npu_shared_bytes, 0),
        total_power_watts: children.reduce((s, c) => s + c.power_watts, 0),
        status: allSuspended ? "suspended" : hasAnySuspended ? "running" : children[0]?.status ?? "unknown",
        children: sortItems(children, sortField, sortDirection, getChildSortValue),
      });
    }

    // --- Synthetic "System" pseudo-rows ---
    // Task Manager's per-process "Memory" column excludes kernel/driver memory,
    // file cache, and the shared DLL pages mapped into multiple processes. Summing
    // Private Working Sets therefore *never* reaches total RAM used. We surface
    // that gap explicitly as three rows so the user can see where their RAM went.
    //
    //   Kernel          = paged pool + non-paged pool (driver + OS data structures)
    //   File Cache      = standby list / cached_bytes (disk cache — reclaimable)
    //   Shared & Other  = remainder: used_ram − Σ(private WS) − kernel − cache
    //                     (shared DLL pages, GPU carveouts, unattributed)
    //
    // Only inserted when searchFilter is empty (otherwise they'd feel noisy), and
    // only when the snapshot is actually available.
    if (!searchFilter) {
      const snap = getCachedSnapshot();
      if (snap) {
        const MB = 1024 * 1024;
        const kernelMb = (snap.paged_pool_bytes + snap.non_paged_pool_bytes) / MB;
        const cacheMb = snap.cached_bytes / MB;
        const modPagesMb = snap.modified_pages_bytes / MB;
        // GPU shared system memory IS counted in MEMORYSTATUSEX::ullTotalPhys
        // (it lives in regular system RAM, just lent to the GPU), so subtract
        // it from the residual to avoid double-counting against "Shared & Other".
        // Dedicated VRAM on iGPUs is BIOS-carved before Windows boots and is
        // NOT in MEMORYSTATUSEX, so we don't subtract it.
        const gpuSharedMb = snap.gpu_shared_memory_used / MB;
        const totalPrivateWsMb = result.reduce((s, g) => s + g.total_private_working_set_mb, 0);
        const usedMb = snap.used_ram_bytes / MB;
        // Subtract everything we've explicitly accounted for; the remainder is
        // shared DLL pages and anything else Windows counts as "in use" but
        // doesn't attribute to a single process.
        const sharedMb = Math.max(
          0,
          usedMb - totalPrivateWsMb - kernelMb - cacheMb - modPagesMb - gpuSharedMb,
        );

        const makeSystem = (name: string, memMb: number, pid: number, explanation: string): ProcessGroup => {
          const child: ProcessRow = {
            pid,
            name,
            display_name: name,
            icon_base64: "",
            private_mb: memMb,
            shared_mb: 0,
            working_set_mb: memMb,
            private_working_set_mb: memMb,
            page_faults: 0,
            company_name: "",
            product_name: "",
            image_path: "",
            window_title: "",
            battery_percent: 0,
            energy_uj: 0,
            cpu_percent: 0,
            power_watts: 0,
            disk_read_per_sec: 0,
            disk_write_per_sec: 0,
            net_send_per_sec: 0,
            net_recv_per_sec: 0,
            gpu_percent: 0,
            npu_percent: 0,
            npu_dedicated_bytes: 0,
            npu_shared_bytes: 0,
            status: "running",
          };
          return {
            name,
            display_name: name,
            count: 1,
            total_private_mb: memMb,
            total_shared_mb: 0,
            total_working_set_mb: memMb,
            total_private_working_set_mb: memMb,
            total_battery_percent: 0,
            total_energy_uj: 0,
            total_cpu_percent: 0,
            total_disk_read: 0,
            total_disk_write: 0,
            total_net_send: 0,
            total_net_recv: 0,
            total_gpu_percent: 0,
            total_npu_percent: 0,
            total_npu_dedicated_bytes: 0,
            total_npu_shared_bytes: 0,
            total_power_watts: 0,
            status: "running",
            is_system: true,
            explanation,
            children: [child],
          };
        };

        if (kernelMb > 0) result.push(makeSystem(
          "System — Kernel Memory", kernelMb, -1,
          "Memory used by the Windows kernel and device drivers — core OS data structures, not an application.",
        ));

        // File cache breakdown. If the priority fields are all 0 (unsupported or
        // query failed), fall back to the combined "Cached Files" row so users
        // still see their cache accounted for.
        const idleMb = snap.cache_idle_bytes / MB;
        const activeMb = snap.cache_active_bytes / MB;
        const launchMb = snap.cache_launch_bytes / MB;
        const hasBreakdown = idleMb + activeMb + launchMb > 0;
        if (hasBreakdown) {
          // Friendly names that hint at what these buckets actually mean:
          //   "Free-to-reuse disk cache" — Windows will hand this RAM to any app that asks
          //   "Recent files in RAM"      — content Windows is keeping handy for reopens
          //   "App quick-launch cache"   — SuperFetch pages that speed up launching your apps
          if (idleMb > 0)   result.push(makeSystem(
            "System — Free-to-reuse disk cache", idleMb, -2,
            "Disk data cached in RAM that Windows will instantly reclaim for any app that needs it — effectively free memory.",
          ));
          if (activeMb > 0) result.push(makeSystem(
            "System — Recent files in RAM", activeMb, -4,
            "Contents of recently-used files kept in RAM so they reopen instantly. Reclaimable when apps need the space.",
          ));
          if (launchMb > 0) result.push(makeSystem(
            "System — App quick-launch cache", launchMb, -5,
            "SuperFetch data Windows preloads to make your common apps launch faster. Reclaimable when apps need the space.",
          ));
        } else if (cacheMb > 0) {
          result.push(makeSystem(
            "System — Cached Files", cacheMb, -2,
            "Disk data cached in RAM to speed up file access. Reclaimable when apps need the space.",
          ));
        }

        const modMb = snap.modified_pages_bytes / MB;
        if (modMb > 1) result.push(makeSystem(
          "System — Pending disk writes", modMb, -6,
          "Modified data held in RAM that is waiting to be written out to disk.",
        ));

        // GPU shared memory — system RAM lent to the GPU. On iGPUs this can be
        // multiple GB; calling it out keeps "Shared & Other" focused on what's
        // actually unattributable.
        if (gpuSharedMb > 1) result.push(makeSystem(
          "System — GPU shared memory", gpuSharedMb, -7,
          "System RAM currently lent to the GPU as shared video memory.",
        ));

        if (sharedMb > 0) result.push(makeSystem(
          "System — Shared & Other", sharedMb, -3,
          "Shared library (DLL) memory and RAM Windows counts as in-use but doesn't attribute to any single process.",
        ));
      }
    }

    const sorted = sortItems(result, sortField, sortDirection, getSortValue);
    // When sorting by anything other than memory, system rows have no meaningful
    // value in that dimension — sink them to the bottom (preserving memory-order
    // amongst themselves) so they don't clutter the top of CPU/GPU/Disk sorts.
    if (sortField !== "memory") {
      const regular = sorted.filter((g) => !g.is_system);
      const system = sorted
        .filter((g) => g.is_system)
        .sort((a, b) => b.total_private_working_set_mb - a.total_private_working_set_mb);
      return [...regular, ...system];
    }
    return sorted;
  }, [processes, powerData, diskData, networkData, gpuData, npuData, statusData, searchFilter, sortField, sortDirection]);

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
    () => groups.reduce((max, g) => Math.max(max, g.total_private_working_set_mb), 1),
    [groups],
  );

  const maxChildMemory = useMemo(
    () => groups.reduce((max, g) => g.children.reduce((m, c) => Math.max(m, c.private_working_set_mb), max), 1),
    [groups],
  );

  const virtualizer = useVirtualizer({
    count: displayRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: useCallback(() => 36, []),
    overscan: 20,
  });

  if (isLoading) {
    // A failed or stalled telemetry read used to leave this spinner up forever
    // with no explanation. Show the reason instead when there is one.
    if (hasTelemetryProblem) {
      return <TelemetryStatusNotice />;
    }
    return <div className="loading-overlay">Loading processes...</div>;
  }

  if (error) {
    return <div className="error-message">Failed to load processes: {String(error)}</div>;
  }

  // Build dynamic grid-template-columns based on hidden columns
  // Base: name(minmax(0,1fr)) status(74px) cpu(60px) memory(120px) disk(82px) network(82px) gpu(50px) battery(64px) actions(64px)
  // minmax(0,1fr) (instead of plain 1fr) lets the name track shrink past its
  // intrinsic min-content width when the window is narrow — without this, long
  // process names refuse to ellipsize and push every other column out of
  // alignment with the static-width header.
  const gridCols: string[] = ["minmax(0, 1fr)", "74px"];
  if (!hiddenCols.has("cpu")) gridCols.push("60px");
  if (!hiddenCols.has("memory")) gridCols.push("120px");
  if (!hiddenCols.has("disk")) gridCols.push("82px");
  if (!hiddenCols.has("network")) gridCols.push("82px");
  if (!hiddenCols.has("gpu")) gridCols.push("50px");
  if (!hiddenCols.has("npu")) gridCols.push("50px");
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

  /**
   * Sortable column header.
   *
   * These were <div onClick> with no tab stop and no key handler, so the table
   * could only be sorted with a mouse. A real <button> fixes that.
   *
   * The sort state goes in the accessible name rather than aria-sort, because
   * aria-sort is only meaningful on a role="columnheader" inside a table/grid
   * role — and this is a CSS grid of divs wrapping a virtualized list, not a
   * table. Announcing it in the label is honest; a lone aria-sort would not be.
   *
   * Written as a function rather than a component so React doesn't remount
   * every header on each render.
   */
  const sortHeader = (field: SortField, label: string) => (
    <button
      type="button"
      className={colClass(field)}
      onClick={() => handleSortClick(field)}
      aria-label={
        sortField === field
          ? `${label}, sorted ${sortDirection === "asc" ? "ascending" : "descending"}. Activate to reverse.`
          : `Sort by ${label}`
      }
    >
      {label} {sortArrow(field)}
    </button>
  );

  return (
    <div className="table-container">
      <div className="table-header" style={gridStyle}>
        {sortHeader("name", "Name")}
        <div className="col">Status</div>
        {!hiddenCols.has("cpu") && sortHeader("cpu", "CPU")}
        {!hiddenCols.has("memory") && sortHeader("memory", "Memory")}
        {!hiddenCols.has("disk") && sortHeader("disk", "Disk")}
        {!hiddenCols.has("network") && sortHeader("network", "Network")}
        {!hiddenCols.has("gpu") && sortHeader("gpu", "GPU")}
        {!hiddenCols.has("npu") && sortHeader("npu", "NPU")}
        {!hiddenCols.has("battery") && sortHeader("battery", "Battery")}
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
              // P1/P3 — a one-line explanation tooltip + soft "unusual" flag,
              // keyed off the representative child process.
              const groupSusp = flagSuspiciousProcess(child);

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
                  onContextMenu={(e) => {
                    if (group.is_system) { e.preventDefault(); return; }
                    handleContextMenu(e, child.pid, group.display_name, child.company_name, child.image_path);
                  }}
                >
                  <span className="name" onMouseEnter={isSingle ? () => maybeExplainAi(child) : undefined} title={`${group.display_name}\n${group.explanation ?? (isSingle ? explanationFor(child) : explainProcessGroup(group.children, !!group.is_system))}`} style={{display: 'flex', alignItems: 'center', minWidth: 0}}>
                    {/* The disclosure triangle carries the keyboard affordance
                        rather than the row itself: the row also contains an
                        end-task button, and role="button" on a container that
                        holds a button is invalid nesting. Row-wide click stays
                        as a mouse convenience, hence stopPropagation here so
                        the two handlers don't cancel each other out. */}
                    {isSingle ? (
                      <span className="expand-toggle" aria-hidden="true" style={{marginRight: '6px', width: '16px', display: 'inline-block'}} />
                    ) : (
                      <button
                        type="button"
                        className="expand-toggle"
                        style={{marginRight: '6px', width: '16px', display: 'inline-block'}}
                        aria-expanded={expanded}
                        aria-label={`${expanded ? "Collapse" : "Expand"} ${group.display_name}, ${group.count} processes`}
                        onClick={(e) => { e.stopPropagation(); toggleGroup(group.name); }}
                      >
                        {expanded ? "\u25BC" : "\u25B6"}
                      </button>
                    )}
                    {child.icon_base64
                      ? <img className="process-icon" src={`data:image/png;base64,${child.icon_base64}`} alt="icon" />
                      : <span className="process-icon-placeholder" aria-hidden="true" />}
                    <span className="name-text">{group.display_name}</span>
                    {!isSingle && <span className="group-count">({group.count})</span>}
                    {groupSusp.unusual && (
                      <span className="suspicious-badge" title={`Looks unusual \u2014 ${groupSusp.reasons.join("; ")}. Not a malware verdict; just worth a look.`}>
                        unusual
                      </span>
                    )}
                  </span>
                  <span className={`status-badge ${group.status}`}>
                    {group.status === "suspended" ? "Suspended" : ""}
                  </span>
                  {!hiddenCols.has("cpu") && <span className="metric-value cpu-value">
                    {(isSingle ? child.cpu_percent : group.total_cpu_percent).toFixed(1)}%
                  </span>}
                  {!hiddenCols.has("memory") && <MemoryBar
                    privateMb={isSingle ? child.private_working_set_mb : group.total_private_working_set_mb}
                    sharedMb={0}
                    sharedWsMb={
                      group.is_system
                        ? 0
                        : isSingle
                          ? Math.max(0, child.working_set_mb - child.private_working_set_mb)
                          : Math.max(0, group.total_working_set_mb - group.total_private_working_set_mb)
                    }
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
                    {(isSingle ? child.gpu_percent : group.total_gpu_percent).toFixed(1)}%
                  </span>}
                  {!hiddenCols.has("npu") && <span className="metric-value">
                    {(isSingle ? child.npu_percent : group.total_npu_percent).toFixed(1)}%
                  </span>}
                  {!hiddenCols.has("battery") && (displayMode === "percent" ? (
                    <BatteryImpact percent={isSingle ? child.battery_percent : group.total_battery_percent} />
                  ) : (
                    <span className="metric-value">
                      {(isSingle ? child.power_watts : group.total_power_watts).toFixed(2)} W
                    </span>
                  ))}
                  <span className="end-task-cell">
                    {isSingle && !group.is_system && classifyEndTaskSafety(child) !== "critical" && (
                      <button
                        className="end-task-btn"
                        onClick={(e) => { e.stopPropagation(); handleEndTask(child); }}
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
            const procSusp = flagSuspiciousProcess(proc);
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
                onContextMenu={(e) => handleContextMenu(e, proc.pid, proc.name, proc.company_name, proc.image_path)}
              >
                <span className="name child-name" onMouseEnter={() => maybeExplainAi(proc)} title={`${proc.display_name || proc.name}\n${explanationFor(proc)}`} style={{display: 'flex', alignItems: 'center', paddingLeft: '22px', minWidth: 0}}>
                  {proc.icon_base64
                    ? <img className="process-icon" src={`data:image/png;base64,${proc.icon_base64}`} alt="icon" />
                    : <span className="process-icon-placeholder" aria-hidden="true" />}
                  <span className="name-text">{proc.display_name || proc.name}</span>
                  {proc.process_type && <span className={`process-type-chip ${proc.process_type}`}>{processTypeLabel(proc.process_type, proc.name)}</span>}
                  {procSusp.unusual && (
                    <span className="suspicious-badge" title={`Looks unusual — ${procSusp.reasons.join("; ")}. Not a malware verdict; just worth a look.`}>
                      unusual
                    </span>
                  )}
                </span>
                <span className={`status-badge ${proc.status}`}>
                  {proc.status === "suspended" ? "Suspended" : ""}
                </span>
                {!hiddenCols.has("cpu") && <span className="metric-value cpu-value">{proc.cpu_percent.toFixed(1)}%</span>}
                {!hiddenCols.has("memory") && <MemoryBar
                  privateMb={proc.private_working_set_mb}
                  sharedMb={0}
                  sharedWsMb={Math.max(0, proc.working_set_mb - proc.private_working_set_mb)}
                  maxMb={maxChildMemory}
                  displayMode={displayMode}
                  totalSystemMb={sysInfo?.total_ram_mb}
                />}
                {!hiddenCols.has("disk") && <span className="metric-value">{formatBytes(proc.disk_read_per_sec + proc.disk_write_per_sec)}</span>}
                {!hiddenCols.has("network") && <span className="metric-value">{formatBytes(proc.net_send_per_sec + proc.net_recv_per_sec)}</span>}
                {!hiddenCols.has("gpu") && <span className="metric-value">{proc.gpu_percent.toFixed(1)}%</span>}
                {!hiddenCols.has("npu") && <span className="metric-value">{proc.npu_percent.toFixed(1)}%</span>}
                {!hiddenCols.has("battery") && (displayMode === "percent" ? (
                  <BatteryImpact percent={proc.battery_percent} />
                ) : (
                  <span className="metric-value">{proc.power_watts.toFixed(2)} W</span>
                ))}
                <span className="end-task-cell">
                  {classifyEndTaskSafety(proc) !== "critical" && (
                    <button
                      className="end-task-btn"
                      onClick={(e) => { e.stopPropagation(); handleEndTask(proc); }}
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
          {classifyEndTaskSafety(contextMenu) === "critical" ? (
            <span className="context-menu-item" style={{ color: "var(--text-muted)", cursor: "default" }}>
              Protected Process
            </span>
          ) : (
            <button
              className="context-menu-item danger"
              onClick={() => handleEndTask(contextMenu)}
            >
              End Task
            </button>
          )}
        </div>
      )}

      {confirmEnd && (
        <div className="confirm-overlay" onClick={() => setConfirmEnd(null)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="end-task-title">
            <div className="confirm-title" id="end-task-title">End Task</div>
            <div className="confirm-message">
              Are you sure you want to end <strong>{confirmEnd.name}</strong> (PID {confirmEnd.pid})?
              <br />
              <span className="confirm-warning">
                {endTaskWarning(confirmEnd.safety) ?? "Unsaved data in this application may be lost."}
              </span>
            </div>
            <div className="confirm-actions">
              {/* Cancel takes initial focus, not the destructive action: this
                  dialog can be opened from a context menu, and landing focus
                  on "End Task" would make a stray Enter kill the process. */}
              <button className="confirm-btn cancel" ref={cancelEndRef} onClick={() => setConfirmEnd(null)}>Cancel</button>
              <button className="confirm-btn danger" onClick={confirmEndTask}>End Task</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

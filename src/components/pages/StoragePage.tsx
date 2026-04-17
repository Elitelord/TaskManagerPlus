import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  getStorageVolumes,
  getTopFolders,
  getInstalledApps,
  getRecycleBinSize,
  emptyRecycleBin,
  openWindowsSettingsUri,
  scanFileTypes,
  detectProjects,
  getUserFolders,
  getPerformanceSnapshot,
} from "../../lib/ipc";
import type {
  StorageVolumeInfo,
  StorageFolderInfo,
  InstalledAppInfo,
  FileTypeStat,
  DetectedProject,
  OrganizerCategory,
} from "../../lib/types";
import {
  runOrganizerAnalysis,
  scoreLabel,
  CATEGORY_COLORS,
  CATEGORY_LABELS,
  type FindingGroup,
  type FolderComposition,
  type SubfolderSuggestion,
  type OrganizerAnalysis,
} from "../../lib/smartOrganizer";

// ─── helpers ────────────────────────────────────────────────────────────────

function formatBytes(bytes: number, digits = 1): string {
  if (!bytes || bytes < 1) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i < 2 ? 0 : digits)} ${units[i]}`;
}

function formatRate(bps: number): string {
  if (!bps) return "0 B/s";
  if (bps < 1024) return `${bps.toFixed(0)} B/s`;
  if (bps < 1048576) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / 1048576).toFixed(1)} MB/s`;
}

function mediaLabel(kind: StorageVolumeInfo["media_kind"]): string {
  switch (kind) {
    case "nvme": return "NVMe SSD";
    case "ssd": return "SSD";
    case "hdd": return "HDD";
    case "usb": return "USB / Removable";
    case "network": return "Network";
    case "optical": return "Optical";
    case "virtual": return "Virtual";
    default: return "Drive";
  }
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

// ─── localStorage scan cache ────────────────────────────────────────────────

const CACHE_KEY = "taskmanagerplus-storage-scan";

interface ScanCache {
  version: 1;
  scans: Record<string, { folders: StorageFolderInfo[]; ts: number }>;
}

function loadCache(): ScanCache {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) { const p = JSON.parse(raw); if (p?.version === 1) return p; }
  } catch { /* ignore */ }
  return { version: 1, scans: {} };
}

function saveCache(cache: ScanCache) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch { /* quota */ }
}

function getCachedScan(root: string): { folders: StorageFolderInfo[]; ts: number } | null {
  return loadCache().scans[root] ?? null;
}

function setCachedScan(root: string, folders: StorageFolderInfo[]) {
  const cache = loadCache();
  cache.scans[root] = { folders, ts: Date.now() };
  saveCache(cache);
}

// ─── SVG icons ──────────────────────────────────────────────────────────────

function DriveGlyph({ kind }: { kind: StorageVolumeInfo["media_kind"] }) {
  const common = { width: 28, height: 28, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (kind) {
    case "nvme": case "ssd":
      return (<svg {...common}><rect x="3" y="6" width="18" height="12" rx="2" /><circle cx="7" cy="12" r="1" fill="currentColor" /><path d="M11 10h7M11 14h7" /></svg>);
    case "hdd":
      return (<svg {...common}><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="2.5" /><path d="M12 4v2M12 18v2" /></svg>);
    case "usb":
      return (<svg {...common}><path d="M12 3v12" /><circle cx="12" cy="18" r="2" /><path d="M9 8l3-3 3 3" /><rect x="10" y="10" width="4" height="3" /></svg>);
    case "network":
      return (<svg {...common}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" /></svg>);
    default:
      return (<svg {...common}><rect x="3" y="6" width="18" height="12" rx="2" /></svg>);
  }
}

function usageColor(pct: number): string {
  if (pct >= 90) return "var(--accent-red)";
  if (pct >= 75) return "var(--accent-orange)";
  return "var(--accent-primary)";
}

// ─── Donut ──────────────────────────────────────────────────────────────────

function UsageDonut({ usedPct, color, size = 68 }: { usedPct: number; color: string; size?: number }) {
  const r = (size - 8) / 2;
  const c = 2 * Math.PI * r;
  const dash = (Math.min(100, Math.max(0, usedPct)) / 100) * c;
  return (
    <svg width={size} height={size} style={{ display: "block" }}>
      <circle cx={size / 2} cy={size / 2} r={r} stroke="var(--border-color)" strokeWidth={6} fill="none" />
      <circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={6} fill="none"
        strokeDasharray={`${dash} ${c - dash}`} strokeDashoffset={c / 4}
        strokeLinecap="round" transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      <text x="50%" y="52%" textAnchor="middle" dominantBaseline="middle"
        fontSize={size * 0.26} fontWeight={600} fill="var(--text-primary)">
        {Math.round(usedPct)}%
      </text>
    </svg>
  );
}

// ─── Pie chart (donut style) ────────────────────────────────────────────────

const PIE_COLORS = [
  "#5b9cf6", "#45d483", "#f5a524", "#ef5350", "#a78bfa",
  "#22d3ee", "#f472b6", "#facc15", "#0d9488", "#8b5cf6",
  "#fb923c", "#94a3b8",
];

function PieDonut({ slices, size = 240, centerTop, centerBottom }: {
  slices: { label: string; value: number; color: string }[];
  size?: number;
  centerTop?: string;
  centerBottom?: string;
}) {
  const total = slices.reduce((s, sl) => s + sl.value, 0);
  if (total === 0) return null;
  const cx = size / 2, cy = size / 2, outerR = size / 2 - 2, innerR = outerR * 0.55;
  let cumAngle = -Math.PI / 2;

  const arcs = slices.map((sl) => {
    const angle = (sl.value / total) * 2 * Math.PI;
    const gap = 0.015;
    const startAngle = cumAngle + gap / 2;
    const endAngle = cumAngle + angle - gap / 2;
    cumAngle += angle;

    const x1o = cx + outerR * Math.cos(startAngle), y1o = cy + outerR * Math.sin(startAngle);
    const x2o = cx + outerR * Math.cos(endAngle), y2o = cy + outerR * Math.sin(endAngle);
    const x1i = cx + innerR * Math.cos(endAngle), y1i = cy + innerR * Math.sin(endAngle);
    const x2i = cx + innerR * Math.cos(startAngle), y2i = cy + innerR * Math.sin(startAngle);
    const large = angle - gap > Math.PI ? 1 : 0;

    return (
      <path key={sl.label}
        d={`M${x1o},${y1o} A${outerR},${outerR} 0 ${large} 1 ${x2o},${y2o} L${x1i},${y1i} A${innerR},${innerR} 0 ${large} 0 ${x2i},${y2i} Z`}
        fill={sl.color} />
    );
  });

  return (
    <svg width={size} height={size} style={{ display: "block", flexShrink: 0 }}>
      {arcs}
      <text x="50%" y="48%" textAnchor="middle" dominantBaseline="middle"
        fontSize={20} fontWeight={700} fill="var(--text-primary)">
        {centerTop ?? formatBytes(total)}
      </text>
      <text x="50%" y="59%" textAnchor="middle" dominantBaseline="middle"
        fontSize={11} fill="var(--text-secondary)">
        {centerBottom ?? "used"}
      </text>
    </svg>
  );
}

// ─── Drive card ─────────────────────────────────────────────────────────────

function DriveCard({ vol, selected, onSelect }: { vol: StorageVolumeInfo; selected: boolean; onSelect: () => void }) {
  const used = vol.total_bytes - vol.free_bytes;
  const pct = vol.total_bytes > 0 ? (used / vol.total_bytes) * 100 : 0;
  const color = usageColor(pct);
  const busy = vol.read_bytes_per_sec + vol.write_bytes_per_sec > 1024;
  return (
    <button className={`storage-drive-card ${selected ? "is-selected" : ""}`} onClick={onSelect} type="button">
      <div className="drive-card-head">
        <div className="drive-icon" style={{ color }}><DriveGlyph kind={vol.media_kind} /></div>
        <div className="drive-head-text">
          <div className="drive-letter-row">
            <span className="drive-letter">{vol.letter}:</span>
            {vol.is_system && <span className="drive-chip">System</span>}
            {vol.is_readonly && <span className="drive-chip drive-chip-muted">Read-only</span>}
          </div>
          <div className="drive-sub">{vol.label || "Local Disk"} · {mediaLabel(vol.media_kind)} · {vol.filesystem || "—"}</div>
        </div>
      </div>
      <div className="drive-card-body">
        <UsageDonut usedPct={pct} color={color} />
        <div className="drive-usage-info">
          <div className="drive-usage-main"><strong>{formatBytes(used)}</strong><span className="drive-usage-sep"> / </span><span className="drive-total">{formatBytes(vol.total_bytes)}</span></div>
          <div className="drive-usage-free">{formatBytes(vol.free_bytes)} free</div>
          <div className={`drive-io-line ${busy ? "is-busy" : ""}`}>
            <span>R {formatRate(vol.read_bytes_per_sec)}</span>
            <span>W {formatRate(vol.write_bytes_per_sec)}</span>
          </div>
        </div>
      </div>
    </button>
  );
}

// ─── Recycle bin (compact card for top row) ──────────────────────────────────

function RecycleBinCard() {
  const { data, refetch } = useQuery({ queryKey: ["recycle-bin-size"], queryFn: getRecycleBinSize, refetchInterval: 15_000 });
  const [busy, setBusy] = useState(false);
  const size = data ?? 0;
  const handleEmpty = async () => {
    if (busy) return;
    if (!window.confirm("Permanently delete everything in the Recycle Bin?")) return;
    setBusy(true);
    try { await emptyRecycleBin(); await refetch(); } catch (e) { console.error(e); } finally { setBusy(false); }
  };
  return (
    <div className="info-panel top-row-card">
      <div className="top-row-card-body">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--accent-orange)", flexShrink: 0 }}>
          <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
          <path d="M10 11v6M14 11v6" />
        </svg>
        <div className="top-row-card-text">
          <div className="top-row-card-title">Recycle Bin</div>
          <div className="top-row-card-detail">{formatBytes(size)}</div>
        </div>
        <button className="btn-sm" onClick={() => openWindowsSettingsUri("shell:RecycleBinFolder").catch(() => { })} title="Open in Explorer">Open</button>
        <button className="btn-sm btn-danger" onClick={handleEmpty} disabled={busy || size === 0}>{busy ? "…" : "Empty"}</button>
      </div>
    </div>
  );
}

// ─── OneDrive card (compact for top row) ────────────────────────────────────

function OneDriveCard({ folders }: { folders: StorageFolderInfo[] }) {
  const od = folders.find((f) => f.display_name.toLowerCase().includes("onedrive"));
  return (
    <div className="info-panel top-row-card">
      <div className="top-row-card-body">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ color: "#0078d4", flexShrink: 0 }}>
          <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
        </svg>
        <div className="top-row-card-text">
          <div className="top-row-card-title">OneDrive</div>
          <div className="top-row-card-detail">
            {od ? `${formatBytes(od.size_bytes)} · ${od.file_count.toLocaleString()} files` : "Not detected"}
          </div>
        </div>
        {od && <button className="btn-sm" onClick={() => openWindowsSettingsUri(od.path).catch(() => { })} title="Open folder">Open</button>}
        {od && <button className="btn-sm" onClick={() => openWindowsSettingsUri("ms-settings:sync").catch(() => { })}>Settings</button>}
      </div>
    </div>
  );
}

// ─── Full-width storage breakdown (pie/list toggle) ─────────────────────────

function StorageBreakdown({ root, folders, scanTs, isFetching, onRescan, volume }: {
  root: string;
  folders: StorageFolderInfo[];
  scanTs: number;
  isFetching: boolean;
  onRescan: () => void;
  volume?: StorageVolumeInfo;
}) {
  const [viewMode, setViewMode] = useState<"pie" | "list">("pie");
  const hasData = folders.length > 0;
  const isStale = scanTs > 0 && Date.now() - scanTs > 3_600_000;

  const pieSlices = useMemo(() => {
    const top = folders.slice(0, 10);
    const rest = folders.slice(10).reduce((s, f) => s + f.size_bytes, 0);
    const slices = top.map((f, i) => ({
      label: f.display_name.split("\\").pop() ?? f.display_name,
      value: f.size_bytes,
      color: PIE_COLORS[i % PIE_COLORS.length],
    }));
    if (rest > 0) slices.push({ label: "Other", value: rest, color: "#4b5563" });
    return slices;
  }, [folders]);

  if (!hasData && !isFetching) {
    return (
      <div className="info-panel">
        <div className="panel-head-row">
          <h3 className="section-title">What's using space on {root.charAt(0)}:</h3>
        </div>
        <div className="scan-prompt">
          <p>Folder scan can take a moment on large drives.</p>
          <button className="btn-secondary" onClick={onRescan} disabled={isFetching}>Scan Now</button>
        </div>
      </div>
    );
  }

  if (isFetching && !hasData) {
    return (
      <div className="info-panel">
        <div className="panel-head-row"><h3 className="section-title">What's using space on {root.charAt(0)}:</h3></div>
        <div className="empty-state scan-loading"><div className="spinner" /> Scanning {root} — this may take a moment…</div>
      </div>
    );
  }

  const maxSize = Math.max(1, ...folders.map((f) => f.size_bytes));

  return (
    <div className="info-panel">
      <div className="folder-breakdown-toolbar">
        <div className="scan-status">
          <h3 className="section-title" style={{ margin: 0 }}>What's using space on {root.charAt(0)}:</h3>
          {scanTs > 0 && <span className={`scan-age ${isStale ? "is-stale" : ""}`}>
            {isStale ? "Outdated" : "Scanned"} · {timeAgo(scanTs)}
          </span>}
          <button className="btn-sm" onClick={onRescan} disabled={isFetching}>
            {isFetching ? "Scanning…" : "Rescan"}
          </button>
        </div>
        <div className="view-toggle">
          <button className={`toggle-btn ${viewMode === "pie" ? "is-active" : ""}`} onClick={() => setViewMode("pie")} type="button">Chart</button>
          <button className={`toggle-btn ${viewMode === "list" ? "is-active" : ""}`} onClick={() => setViewMode("list")} type="button">List</button>
        </div>
      </div>

      {viewMode === "pie" ? (
        <div className="pie-section">
          <PieDonut slices={pieSlices} size={240}
            centerTop={volume ? formatBytes(volume.total_bytes - volume.free_bytes) : undefined}
            centerBottom={volume ? `of ${formatBytes(volume.total_bytes)} used` : "used"} />
          <div className="pie-legend">
            {pieSlices.map((sl) => (
              <div key={sl.label} className="legend-row">
                <span className="legend-swatch" style={{ background: sl.color }} />
                <span className="legend-label">{sl.label}</span>
                <span className="legend-size">{formatBytes(sl.value)}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="folder-breakdown-list">
          {folders.map((f) => (
            <div key={f.path} className="folder-row" title={f.path}>
              <div className="folder-row-head">
                <span className="folder-name">{f.display_name}</span>
                <span className="folder-size">{formatBytes(f.size_bytes)}</span>
              </div>
              <div className="folder-bar-track">
                <div className="folder-bar-fill" style={{ width: `${(f.size_bytes / maxSize) * 100}%`, background: "var(--accent-primary)" }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── User folder explorer (tabbed card — Documents, Downloads, etc.) ────────

const USER_FOLDERS: { key: string; label: string; icon: string }[] = [
  { key: "Documents", label: "Documents", icon: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6" },
  { key: "Downloads", label: "Downloads", icon: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3" },
  { key: "Desktop", label: "Desktop", icon: "M2 3h20v14H2z M8 21h8 M12 17v4" },
  { key: "Pictures", label: "Pictures", icon: "M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z" },
  { key: "Videos", label: "Videos", icon: "M23 7l-7 5 7 5V7z M14 5H3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z" },
  { key: "Music", label: "Music", icon: "M9 18V5l12-2v13 M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0z M21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z" },
];

const SUB_CACHE_KEY = "taskmanagerplus-subfolder-cache";

interface SubFolderCacheEntry {
  folders: StorageFolderInfo[];
  ts: number;
}

function getSubCache(path: string): SubFolderCacheEntry | null {
  try {
    const raw = localStorage.getItem(SUB_CACHE_KEY);
    if (raw) {
      const cache = JSON.parse(raw);
      const entry = cache?.[path];
      if (!entry) return null;
      if (Array.isArray(entry)) return { folders: entry, ts: 0 };
      if (Array.isArray(entry.folders)) return { folders: entry.folders, ts: entry.ts ?? 0 };
    }
  } catch { /* ignore */ }
  return null;
}

function setSubCache(path: string, folders: StorageFolderInfo[]) {
  try {
    const raw = localStorage.getItem(SUB_CACHE_KEY);
    const cache = raw ? JSON.parse(raw) : {};
    cache[path] = { folders, ts: Date.now() };
    localStorage.setItem(SUB_CACHE_KEY, JSON.stringify(cache));
  } catch { /* quota */ }
}

function UserFolderExplorer({ folders }: { folders: StorageFolderInfo[] }) {
  const [activeTab, setActiveTab] = useState(USER_FOLDERS[0].key);
  const [subFolders, setSubFolders] = useState<StorageFolderInfo[]>([]);
  const [subScanning, setSubScanning] = useState(false);
  const [scannedPath, setScannedPath] = useState<string | null>(null);
  const [lastScannedTs, setLastScannedTs] = useState(0);

  const tabFolderByName = useMemo(() => {
    const map = new Map<string, StorageFolderInfo>();
    for (const f of folders) {
      const leaf = (f.display_name.split("\\").pop() ?? "").toLowerCase();
      if (!map.has(leaf)) map.set(leaf, f);
    }
    return map;
  }, [folders]);

  const guessedUserRoot = useMemo(() => {
    // Infer C:\Users\<name> from any known user folder path.
    for (const f of folders) {
      const leaf = (f.display_name.split("\\").pop() ?? "").toLowerCase();
      if (!USER_FOLDERS.some((u) => u.key.toLowerCase() === leaf)) continue;
      const idx = f.path.toLowerCase().lastIndexOf(`\\${leaf}`);
      if (idx > 2) return f.path.slice(0, idx);
    }
    return "";
  }, [folders]);

  const activeFolderPath = useMemo(() => {
    const fromScan = tabFolderByName.get(activeTab.toLowerCase())?.path;
    if (fromScan) return fromScan;
    if (!guessedUserRoot) return "";
    return `${guessedUserRoot}\\${activeTab}`;
  }, [activeTab, guessedUserRoot, tabFolderByName]);
  const oneDriveRoot = useMemo(() => {
    const od = folders.find((f) => f.display_name.toLowerCase().includes("onedrive"));
    return od?.path ? od.path.replace(/\\$/, "") : "";
  }, [folders]);

  const matchedFolder = tabFolderByName.get(activeTab.toLowerCase());

  useEffect(() => {
    if (!activeFolderPath) {
      setSubFolders([]);
      setScannedPath(null);
      return;
    }
    const cached = getSubCache(activeFolderPath);
    if (cached && cached.folders.length > 0) {
      const parentNorm = activeFolderPath.replace(/\\$/, "").toLowerCase() + "\\";
      const valid = cached.folders.every((f) => f.path.replace(/\\$/, "").toLowerCase().startsWith(parentNorm));
      if (valid) {
        setSubFolders(cached.folders);
        setScannedPath(activeFolderPath);
        setLastScannedTs(cached.ts ?? 0);
        return;
      }
    }
    setSubFolders([]);
    setScannedPath(null);
    setLastScannedTs(0);
  }, [activeFolderPath]);

  const runSubScan = async () => {
    if (!activeFolderPath || subScanning) return;
    setSubScanning(true);
    try {
      const candidates: string[] = [];
      const add = (p: string) => {
        const norm = p.replace(/\//g, "\\").replace(/\\$/, "");
        if (!norm) return;
        if (!candidates.some((c) => c.toLowerCase() === norm.toLowerCase())) candidates.push(norm);
      };
      add(activeFolderPath);
      if (guessedUserRoot) add(`${guessedUserRoot}\\${activeTab}`);
      if (oneDriveRoot) add(`${oneDriveRoot}\\${activeTab}`);

      let filtered: StorageFolderInfo[] = [];
      let winningPath = activeFolderPath;
      for (const candidate of candidates) {
        const result = await getTopFolders(candidate, 20);
        const parentNorm = candidate.replace(/\\$/, "").toLowerCase() + "\\";
        const scoped = result.filter((f) => f.path.replace(/\\$/, "").toLowerCase().startsWith(parentNorm));
        if (scoped.length > 0) {
          filtered = scoped;
          winningPath = candidate;
          break;
        }
      }
      const sorted = filtered.sort((a, b) => b.size_bytes - a.size_bytes);
      setSubFolders(sorted);
      setScannedPath(winningPath);
      setSubCache(winningPath, sorted);
      setLastScannedTs(Date.now());
    } catch {
      setSubFolders([]);
    } finally {
      setSubScanning(false);
    }
  };

  if (!USER_FOLDERS.length) {
    return (
      <div className="info-panel">
        <h3 className="section-title">User Folders</h3>
        <div className="empty-state">Run a scan to see folder details.</div>
      </div>
    );
  }

  return (
    <div className="info-panel user-folder-explorer">
      <div className="panel-head-row">
        <h3 className="section-title" style={{ margin: 0 }}>User Folders</h3>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {lastScannedTs > 0 && (
            <span className="panel-head-meta">Last scan {timeAgo(lastScannedTs)}</span>
          )}
          <button
            className="btn-sm"
            onClick={() => activeFolderPath && openWindowsSettingsUri(activeFolderPath).catch(() => {})}
            disabled={!activeFolderPath}
            title="Open folder in File Explorer"
          >
            Open
          </button>
          <button className="btn-sm" onClick={runSubScan} disabled={!activeFolderPath || subScanning}>
            {subScanning ? "Scanning…" : (scannedPath === activeFolderPath ? "Rescan" : "Scan")}
          </button>
        </div>
      </div>
      <div className="folder-tabs">
        {USER_FOLDERS.map((bf) => (
          <button key={bf.key}
            className={`folder-tab ${activeTab === bf.key ? "is-active" : ""}`}
            onClick={() => setActiveTab(bf.key)} type="button">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d={bf.icon} />
            </svg>
            {bf.label}
          </button>
        ))}
      </div>
      <div className="folder-tab-content">
        <>
          <div className="folder-tab-summary">
            <span className="folder-tab-size">{matchedFolder ? formatBytes(matchedFolder.size_bytes) : "Not scanned"}</span>
            <span className="folder-tab-files">{matchedFolder ? `${matchedFolder.file_count.toLocaleString()} files` : "Click Scan to load"}</span>
          </div>
          {subScanning ? (
            <div className="empty-state scan-loading"><div className="spinner" /> Scanning subfolders…</div>
          ) : subFolders.length > 0 ? (
            <div className="folder-breakdown-list" style={{ maxHeight: 260 }}>
              {subFolders.map((f) => {
                const leaf = f.display_name.split("\\").pop() ?? f.display_name;
                const base = Math.max(matchedFolder?.size_bytes ?? subFolders[0]?.size_bytes ?? 1, 1);
                return (
                  <div key={f.path} className="folder-row" title={f.path}>
                    <div className="folder-row-head">
                      <span className="folder-name">{leaf}</span>
                      <span className="folder-size">{formatBytes(f.size_bytes)}</span>
                    </div>
                    <div className="folder-bar-track">
                      <div className="folder-bar-fill" style={{
                        width: `${(f.size_bytes / base) * 100}%`,
                        background: "var(--accent-primary)",
                      }} />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="empty-state" style={{ padding: "12px 0", fontSize: 12 }}>
              {activeFolderPath ? "No cached data yet. Click Scan to load this folder." : "Folder path not available on this drive."}
            </div>
          )}
        </>
      </div>
    </div>
  );
}

// ─── Installed apps ─────────────────────────────────────────────────────────

function InstalledAppsPanel() {
  const { data, isLoading } = useQuery({ queryKey: ["installed-apps"], queryFn: getInstalledApps, staleTime: 120_000 });
  const [filter, setFilter] = useState("");
  const apps: InstalledAppInfo[] = data ?? [];
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const base = q ? apps.filter((a) => a.name.toLowerCase().includes(q) || a.publisher.toLowerCase().includes(q)) : apps;
    return base.slice(0, 50);
  }, [apps, filter]);
  const totalKnown = apps.reduce((sum, a) => sum + (a.size_bytes || 0), 0);

  return (
    <div className="info-panel">
      <div className="panel-head-row">
        <h3 className="section-title">Installed Apps</h3>
        <span className="panel-head-meta">{apps.length ? `${apps.length} apps · ${formatBytes(totalKnown)}` : ""}</span>
      </div>
      {isLoading ? (
        <div className="empty-state scan-loading"><div className="spinner" /> Loading apps…</div>
      ) : (<>
        <input className="storage-filter" placeholder="Filter by name or publisher…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="installed-apps-list">
          {filtered.map((a, i) => (
            <div key={`${a.name}-${a.version}-${i}`} className="installed-app-row">
              <div className="installed-app-main">
                <span className="installed-app-name">{a.name}</span>
                <span className="installed-app-meta">{a.publisher || "Unknown publisher"}{a.version ? ` · v${a.version}` : ""}</span>
              </div>
              <span className="installed-app-size">{a.size_bytes > 0 ? formatBytes(a.size_bytes) : "—"}</span>
            </div>
          ))}
          {!filtered.length && <div className="empty-state">No apps match that filter.</div>}
        </div>
      </>)}
    </div>
  );
}

// ─── Recommendations (actionable, pointing to specific culprits) ────────────

interface Recommendation {
  icon: string;
  title: string;
  detail: string;
  action?: () => void;
  actionLabel?: string;
  severity: "info" | "warning" | "critical";
}

function StorageRecommendations({ volumes, recycleBinSize, folders, apps }: {
  volumes: StorageVolumeInfo[];
  recycleBinSize: number;
  folders: StorageFolderInfo[];
  apps: InstalledAppInfo[];
}) {
  const recs = useMemo(() => {
    const list: Recommendation[] = [];

    // Top 3 largest installed apps (>2GB) — actionable, specific
    const bigApps = apps.filter((a) => a.size_bytes > 2 * 1024 ** 3).slice(0, 3);
    if (bigApps.length > 0) {
      const detail = bigApps.map((a) => `${a.name} (${formatBytes(a.size_bytes)})`).join(", ");
      list.push({
        icon: "M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z",
        title: "Largest installed apps",
        detail: `These apps consume the most storage: ${detail}. Consider uninstalling ones you don't use.`,
        severity: "info",
        action: () => openWindowsSettingsUri("ms-settings:appsfeatures").catch(() => { }),
        actionLabel: "Apps & Features",
      });
    }

    // Large recycle bin
    if (recycleBinSize > 500 * 1024 * 1024) {
      list.push({
        icon: "M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6",
        title: `Recycle Bin is using ${formatBytes(recycleBinSize)}`,
        detail: "Empty it to reclaim space instantly.",
        severity: recycleBinSize > 2 * 1024 ** 3 ? "warning" : "info",
      });
    }

    // Large Downloads folder
    const downloads = folders.find((f) => (f.display_name.split("\\").pop() ?? "").toLowerCase() === "downloads");
    if (downloads && downloads.size_bytes > 5 * 1024 ** 3) {
      list.push({
        icon: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3",
        title: `Downloads folder is ${formatBytes(downloads.size_bytes)}`,
        detail: `${downloads.file_count.toLocaleString()} files — review and delete old installers, archives, and downloads.`,
        severity: downloads.size_bytes > 20 * 1024 ** 3 ? "warning" : "info",
      });
    }

    // Large Videos folder
    const videos = folders.find((f) => (f.display_name.split("\\").pop() ?? "").toLowerCase() === "videos");
    if (videos && videos.size_bytes > 10 * 1024 ** 3) {
      list.push({
        icon: "M23 7l-7 5 7 5V7z M14 5H3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z",
        title: `Videos folder is ${formatBytes(videos.size_bytes)}`,
        detail: "Large video files are often the biggest space consumers. Consider moving to external storage or cloud.",
        severity: "info",
      });
    }

    // Large temp/cache folders
    for (const f of folders) {
      const name = f.display_name.toLowerCase();
      if ((name.includes("temp") || name.includes("cache") || name.includes("tmp")) && f.size_bytes > 1024 ** 3) {
        list.push({
          icon: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z",
          title: `${f.display_name} is ${formatBytes(f.size_bytes)}`,
          detail: "Temporary/cache files can usually be safely cleaned up.",
          severity: f.size_bytes > 5 * 1024 ** 3 ? "warning" : "info",
          action: () => openWindowsSettingsUri("ms-settings:storagesense").catch(() => { }),
          actionLabel: "Clean up",
        });
      }
    }

    // Critically full drives — with biggest folder reference
    for (const v of volumes) {
      const pct = v.total_bytes > 0 ? ((v.total_bytes - v.free_bytes) / v.total_bytes) * 100 : 0;
      const freeGB = v.free_bytes / (1024 ** 3);
      if (pct >= 95 || freeGB < 5) {
        const biggestFolder = folders.length > 0 ? folders[0] : null;
        const biggestApp = apps.length > 0 ? apps[0] : null;
        let hints = "";
        if (biggestFolder) hints += ` Largest folder: "${biggestFolder.display_name.split("\\").pop()}" (${formatBytes(biggestFolder.size_bytes)}).`;
        if (biggestApp && biggestApp.size_bytes > 0) hints += ` Largest app: "${biggestApp.name}" (${formatBytes(biggestApp.size_bytes)}).`;
        list.push({
          icon: "M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z",
          title: `${v.letter}: is critically full (${formatBytes(v.free_bytes)} free)`,
          detail: `Performance will degrade.${hints}`,
          severity: "critical",
          action: () => openWindowsSettingsUri("ms-settings:storagesense").catch(() => { }),
          actionLabel: "Storage Sense",
        });
      }
    }

    if (list.length === 0) {
      list.push({
        icon: "M22 11.08V12a10 10 0 1 1-5.93-9.14 M22 4L12 14.01l-3-3",
        title: "Storage looks healthy",
        detail: "All drives have adequate free space and no major cleanup is needed.",
        severity: "info",
      });
    }

    return list;
  }, [volumes, recycleBinSize, folders, apps]);

  return (
    <div className="storage-recommendations">
      <h3 className="section-title">Recommendations</h3>
      <div className="rec-list">
        {recs.map((rec, i) => (
          <div key={i} className={`rec-card rec-${rec.severity}`}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d={rec.icon} />
            </svg>
            <div className="rec-text">
              <div className="rec-title">{rec.title}</div>
              <div className="rec-detail">{rec.detail}</div>
            </div>
            {rec.action && rec.actionLabel && (
              <button className="btn-sm" onClick={rec.action}>{rec.actionLabel}</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Smart Organizer ────────────────────────────────────────────────────────
// Scans the user's well-known folders (Documents, Downloads, Desktop,
// Pictures, Videos, Music), classifies files by type + name heuristics via
// the C++ DLL, then surfaces:
//   • a composition row per folder (stacked bar),
//   • up to 6 collapsible finding groups (installers lingering, desktop
//     clutter, misplaced videos/audio, etc.),
//   • up to 3 softer "create a subfolder" suggestions (GitHub folder,
//     Screenshots folder, Installers folder).
//
// All actions are non-destructive — we only OPEN folders in Explorer or link
// to Windows Settings. The scan respects idle detection so it never steals
// cycles while the user is doing something else.

const ORGANIZER_CACHE_KEY = "taskmanagerplus-organizer-scan";
const ORGANIZER_CACHE_VERSION = 1;

// Re-run the scan if the cache is older than this (6h, matches the design doc).
const ORGANIZER_MAX_AGE_MS = 6 * 60 * 60 * 1000;
// Initial delay before the first *auto* scan after app start (2 min).
const ORGANIZER_INITIAL_DELAY_MS = 2 * 60 * 1000;
// Idle criteria: CPU must stay below this many % for this many consecutive
// samples (one sample ≈ 5s — we poll the performance snapshot ourselves).
const ORGANIZER_IDLE_CPU_THRESHOLD = 15;
const ORGANIZER_IDLE_SAMPLES = 6;
const ORGANIZER_POLL_INTERVAL_MS = 5000;

interface OrganizerCache {
  version: typeof ORGANIZER_CACHE_VERSION;
  ts: number;
  stats: FileTypeStat[];
  projects: DetectedProject[];
}

function loadOrganizerCache(): OrganizerCache | null {
  try {
    const raw = localStorage.getItem(ORGANIZER_CACHE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (p?.version === ORGANIZER_CACHE_VERSION) return p;
  } catch { /* ignore corrupt cache */ }
  return null;
}

function saveOrganizerCache(cache: OrganizerCache) {
  try { localStorage.setItem(ORGANIZER_CACHE_KEY, JSON.stringify(cache)); }
  catch { /* quota */ }
}

function StackedBar({ comp, totalRef }: { comp: FolderComposition; totalRef: number }) {
  // Width of the full bar is relative to the LARGEST folder's total so bars
  // are comparable across rows (rather than each normalized to its own 100%).
  const pctOfMax = totalRef > 0 ? (comp.totalBytes / totalRef) * 100 : 0;
  return (
    <div className="org-comp-row" title={comp.folderPath}>
      <span className="org-comp-label">{comp.key}</span>
      <div className="org-bar-track" style={{ width: `${Math.max(4, pctOfMax)}%` }}>
        {comp.categories.map((c) => {
          const segPct = comp.totalBytes > 0 ? (c.bytes / comp.totalBytes) * 100 : 0;
          if (segPct < 0.5) return null;
          return (
            <div
              key={c.category}
              className="org-bar-segment"
              style={{
                width: `${segPct}%`,
                background: CATEGORY_COLORS[c.category as OrganizerCategory] ?? "#4b5563",
              }}
              title={`${CATEGORY_LABELS[c.category as OrganizerCategory] ?? c.category} · ${formatBytes(c.bytes)} · ${c.files.toLocaleString()} files`}
            />
          );
        })}
      </div>
      <span className="org-comp-size">{formatBytes(comp.totalBytes)}</span>
    </div>
  );
}

function OrgScoreGauge({ score }: { score: number }) {
  const r = 32;
  const c = 2 * Math.PI * r;
  const dash = (score / 100) * c;
  const color = score >= 70 ? "var(--accent-green)" : score >= 50 ? "var(--accent-orange)" : "var(--accent-red)";
  return (
    <div className="org-score" aria-label={`Organization score ${score} out of 100`}>
      <svg width={80} height={80} viewBox="0 0 80 80">
        <circle cx="40" cy="40" r={r} stroke="var(--border-color)" strokeWidth={6} fill="none" />
        <circle cx="40" cy="40" r={r} stroke={color} strokeWidth={6} fill="none"
          strokeDasharray={`${dash} ${c - dash}`} strokeDashoffset={c / 4}
          strokeLinecap="round" transform="rotate(-90 40 40)" />
        <text x="40" y="43" textAnchor="middle" dominantBaseline="middle"
          fontSize={20} fontWeight={700} fill="var(--text-primary)">{score}</text>
      </svg>
      <span className="org-score-label">{scoreLabel(score)}</span>
    </div>
  );
}

function FindingRow({ group }: { group: FindingGroup }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={`finding-group finding-${group.severity} ${expanded ? "is-expanded" : ""}`}>
      <button className="finding-head" onClick={() => setExpanded(!expanded)} type="button">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="finding-icon">
          <path d={group.icon} />
        </svg>
        <span className="finding-title">{group.title}</span>
        <span className="finding-summary">{group.summary}</span>
        <span className="finding-caret" aria-hidden>{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div className="finding-body">
          <div className="finding-detail">{group.detail}</div>
          {group.items.length > 0 && (
            <ul className="finding-items">
              {group.items.map((it, i) => (
                <li key={`${it.label}-${i}`} className="finding-item" title={it.path ?? it.label}>
                  <span className="finding-item-label">{it.label}</span>
                  {it.detail && <span className="finding-item-meta">{it.detail}</span>}
                </li>
              ))}
            </ul>
          )}
          {group.folderPath && (
            <div className="finding-actions">
              <button className="btn-sm" onClick={() => openWindowsSettingsUri(group.folderPath).catch(() => { })}>
                Open folder
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SuggestionRow({ s }: { s: SubfolderSuggestion }) {
  return (
    <div className="suggestion-item">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="suggestion-icon">
        <path d="M9 18h6 M10 22h4 M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z" />
      </svg>
      <div className="suggestion-text">
        <div className="suggestion-title">
          Create a <strong>"{s.suggestedName}"</strong> folder
        </div>
        <div className="suggestion-reason">{s.reason}</div>
      </div>
      {s.parentPath && (
        <button className="btn-sm" onClick={() => openWindowsSettingsUri(s.parentPath).catch(() => { })}>
          Open parent
        </button>
      )}
    </div>
  );
}

/**
 * Runs one full organizer scan: kicks off `scanFileTypes` for each user folder
 * in parallel + `detectProjects` for the user root, writes the combined result
 * to localStorage, and returns it.
 */
async function performOrganizerScan(): Promise<OrganizerCache> {
  const folders = await getUserFolders();
  const targets = [
    folders.documents, folders.downloads, folders.desktop,
    folders.pictures, folders.videos, folders.music,
  ].filter(Boolean);

  // Run all folder scans in parallel. `spawn_blocking` on the Rust side gives
  // each one its own thread, so the DLL can parallelise heavy folders.
  const scanResults = await Promise.allSettled(targets.map((p) => scanFileTypes(p)));
  const stats: FileTypeStat[] = [];
  for (const r of scanResults) {
    if (r.status === "fulfilled") stats.push(...r.value);
  }

  // Project detection is cheaper — one call scoped to the user profile.
  let projects: DetectedProject[] = [];
  try { projects = await detectProjects(folders.home); } catch { /* non-fatal */ }

  const cache: OrganizerCache = {
    version: ORGANIZER_CACHE_VERSION,
    ts: Date.now(),
    stats,
    projects,
  };
  saveOrganizerCache(cache);
  return cache;
}

interface SmartOrganizerPanelProps {
  /** Increments when the parent requests a fresh organizer scan. The panel
   *  compares this against the value it saw on its previous render; when the
   *  value changes (non-initially) it triggers its own scan in lockstep with
   *  the drive-level scan. 0 means "no external trigger yet". */
  rescanSignal: number;
  /** Fired when the user clicks the panel's own Rescan button. The parent
   *  handler should also kick off the drive-breakdown rescan so both views
   *  refresh together. */
  onUserRescan: () => void;
}

function SmartOrganizerPanel({ rescanSignal, onUserRescan }: SmartOrganizerPanelProps) {
  const [cache, setCache] = useState<OrganizerCache | null>(() => loadOrganizerCache());
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Idle detection bookkeeping — counts consecutive low-CPU samples.
  const idleSamplesRef = useRef(0);
  const mountTimeRef = useRef(Date.now());
  // Track the last rescanSignal we reacted to so we can distinguish "new
  // external trigger" from "initial mount" without firing a duplicate scan.
  const lastSignalRef = useRef(rescanSignal);

  const runScan = useCallback(async () => {
    if (scanning) return;
    setScanning(true);
    setError(null);
    try {
      const next = await performOrganizerScan();
      setCache(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  }, [scanning]);

  // React to external rescan requests (drive-breakdown "Rescan" button).
  useEffect(() => {
    if (rescanSignal === lastSignalRef.current) return; // initial mount
    lastSignalRef.current = rescanSignal;
    runScan();
    // runScan intentionally omitted — it's stable enough via useCallback and
    // we only want to fire on signal change, not when the scan closure updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rescanSignal]);

  // Background idle-detection poll. We do this ourselves (rather than reuse
  // usePerformanceData) because we only need one number every 5 seconds, and
  // don't want to force the Performance page's expensive polling pipeline
  // whenever the Storage page is open.
  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      try {
        const snap = await getPerformanceSnapshot();
        // Only auto-scan when the machine is plugged in — per the design doc,
        // we never drain the battery for background organization work.
        if (!snap.is_charging) {
          idleSamplesRef.current = 0;
          return;
        }
        if (snap.cpu_usage_percent < ORGANIZER_IDLE_CPU_THRESHOLD) {
          idleSamplesRef.current += 1;
        } else {
          idleSamplesRef.current = 0;
        }
        const elapsed = Date.now() - mountTimeRef.current;
        const currentCache = loadOrganizerCache();
        const cacheAge = currentCache ? Date.now() - currentCache.ts : Infinity;

        const initialDelayPassed = elapsed > ORGANIZER_INITIAL_DELAY_MS;
        const idle = idleSamplesRef.current >= ORGANIZER_IDLE_SAMPLES;
        const stale = cacheAge > ORGANIZER_MAX_AGE_MS;

        // Kick off a scan only when BOTH (initial delay OR cache stale) AND the
        // system has been idle for long enough.
        if (idle && !scanning && (initialDelayPassed || stale)) {
          if (!currentCache || stale) {
            idleSamplesRef.current = 0;  // reset so we don't fire again immediately
            runScan();
          }
        }
      } catch { /* ignore snapshot errors — just don't auto-scan */ }
    };

    const interval = setInterval(tick, ORGANIZER_POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(interval); };
  }, [runScan, scanning]);

  const analysis: OrganizerAnalysis | null = useMemo(() => {
    if (!cache) return null;
    return runOrganizerAnalysis(cache.stats, cache.projects);
  }, [cache]);

  const maxTotal = useMemo(
    () => Math.max(1, ...(analysis?.compositions.map((c) => c.totalBytes) ?? [1])),
    [analysis],
  );

  const scanAge = cache ? Date.now() - cache.ts : 0;
  const scanAgeLabel = cache ? (
    scanAge < 60_000 ? "just now"
    : scanAge < 3_600_000 ? `${Math.round(scanAge / 60_000)}m ago`
    : scanAge < 86_400_000 ? `${Math.round(scanAge / 3_600_000)}h ago`
    : `${Math.round(scanAge / 86_400_000)}d ago`
  ) : "never";

  const hasData = analysis !== null && analysis.compositions.length > 0;
  const reclaimableBytes = analysis?.reclaimableBytes ?? 0;

  return (
    <div className="info-panel smart-organizer">
      <div className="panel-head-row">
        <h3 className="section-title" style={{ margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--accent-primary)" }}>
            <path d="M3 6l3 12a2 2 0 0 0 2 1.6h8a2 2 0 0 0 2-1.6l3-12" />
            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            <path d="M3 6h18" />
          </svg>
          Smart Organizer
        </h3>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {cache && (
            <span className={`scan-age ${scanAge > ORGANIZER_MAX_AGE_MS ? "is-stale" : ""}`}>
              Last analyzed {scanAgeLabel}
            </span>
          )}
          {scanning && <span className="scan-idle-indicator" title="Scanning user folders…" />}
          <button
            className="btn-sm"
            onClick={onUserRescan}
            disabled={scanning}
            title="Rescans drive folders and user-folder organization — may take 30–60 seconds"
          >
            {scanning ? "Scanning…" : "Rescan"}
          </button>
        </div>
      </div>

      {error && <div className="empty-state" style={{ color: "var(--accent-red)" }}>{error}</div>}

      {!hasData && !scanning && !error && (
        <div className="scan-prompt">
          <p>Scan your user folders to see file composition, clutter, and organization suggestions.</p>
          <button className="btn-secondary" onClick={onUserRescan}>Analyze now</button>
        </div>
      )}

      {!hasData && scanning && (
        <div className="empty-state scan-loading"><div className="spinner" /> Scanning your user folders…</div>
      )}

      {hasData && analysis && (
        <>
          <div className="org-top-row">
            <OrgScoreGauge score={analysis.orgScore} />
            <div className="org-composition">
              <div className="org-comp-title">File Composition</div>
              {analysis.compositions.map((comp) => (
                <StackedBar key={comp.key} comp={comp} totalRef={maxTotal} />
              ))}
              {analysis.compositions.length === 0 && (
                <div className="empty-state" style={{ padding: 8 }}>
                  No files detected in user folders.
                </div>
              )}
            </div>
          </div>

          {analysis.findings.length > 0 && (
            <div className="org-findings">
              <div className="org-subheading">Findings ({analysis.findings.length})</div>
              <div className="finding-list">
                {analysis.findings.map((g) => <FindingRow key={g.id} group={g} />)}
              </div>
            </div>
          )}

          {analysis.suggestions.length > 0 && (
            <div className="org-suggestions">
              <div className="org-subheading">Suggestions</div>
              <div className="suggestion-list">
                {analysis.suggestions.map((s) => <SuggestionRow key={s.id} s={s} />)}
              </div>
            </div>
          )}

          {analysis.findings.length === 0 && analysis.suggestions.length === 0 && (
            <div className="org-all-clear">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--accent-green)" }}>
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <path d="M22 4L12 14.01l-3-3" />
              </svg>
              Your user folders look well organized.
            </div>
          )}

          {reclaimableBytes > 0 && (
            <div className="reclaimable-badge">
              Cleanup potential: ~{formatBytes(reclaimableBytes)} reclaimable
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Main page ──────────────────────────────────────────────────────────────

export function StoragePage() {
  const { data: volumes, isLoading } = useQuery({
    queryKey: ["storage-volumes"],
    queryFn: getStorageVolumes,
    refetchInterval: 10_000,
    staleTime: 8_000,
  });
  const { data: recycleBinSize } = useQuery({ queryKey: ["recycle-bin-size"], queryFn: getRecycleBinSize, refetchInterval: 15_000 });

  const [selectedLetter, setSelectedLetter] = useState<string | null>(null);

  const selectedRoot = selectedLetter ? `${selectedLetter}:\\` : "";

  const cached = useMemo(() => getCachedScan(selectedRoot), [selectedRoot]);
  const { data: freshFolders, isFetching: foldersFetching, refetch: rescanFolders } = useQuery({
    queryKey: ["storage-top-folders", selectedRoot],
    queryFn: async () => {
      const result = await getTopFolders(selectedRoot, 24);
      setCachedScan(selectedRoot, result);
      return result;
    },
    staleTime: 120_000,
    enabled: false,
  });

  const scanFolders: StorageFolderInfo[] = freshFolders ?? cached?.folders ?? [];
  const scanTs = freshFolders ? Date.now() : cached?.ts ?? 0;

  // Shared rescan epoch — incremented whenever ANY rescan button is clicked
  // (drive breakdown OR smart-organizer). Both panels watch this via effects
  // and refresh in lockstep, so the user sees up-to-date drive breakdown and
  // organizer findings from a single click.
  const [rescanEpoch, setRescanEpoch] = useState(0);
  const triggerFullRescan = useCallback(() => {
    setRescanEpoch((e) => e + 1);
    rescanFolders();
  }, [rescanFolders]);

  // Installed apps for recommendations
  const { data: installedApps } = useQuery({ queryKey: ["installed-apps"], queryFn: getInstalledApps, staleTime: 120_000 });
  const apps: InstalledAppInfo[] = installedApps ?? [];

  useEffect(() => {
    if (!selectedLetter && volumes && volumes.length) {
      const sys = volumes.find((v) => v.is_system) ?? volumes[0];
      setSelectedLetter(sys.letter);
    }
  }, [volumes, selectedLetter]);

  if (isLoading && !volumes) {
    return <div className="loading-overlay">Scanning drives…</div>;
  }

  const vols = volumes ?? [];
  const totalCapacity = vols.reduce((s, v) => s + v.total_bytes, 0);
  const totalFree = vols.reduce((s, v) => s + v.free_bytes, 0);
  const totalUsed = totalCapacity - totalFree;

  return (
    <div className="resource-page storage-page">
      <div className="page-header">
        <div className="header-main">
          <h2>Storage</h2>
          <div className="header-meta">
            <span className="meta-item">Drives: <strong>{vols.length}</strong></span>
            <span className="meta-item">Used: <strong>{formatBytes(totalUsed)}</strong></span>
            <span className="meta-item">Free: <strong>{formatBytes(totalFree)}</strong></span>
            <span className="meta-item">Total: <strong>{formatBytes(totalCapacity)}</strong></span>
          </div>
        </div>
      </div>

      <div className="page-content">
        {/* Row 1: Drive cards + Recycle Bin + OneDrive all in one row */}
        <div className="storage-top-row">
          <div className="storage-drive-grid">
            {vols.map((v) => (
              <DriveCard key={v.letter} vol={v} selected={v.letter === selectedLetter} onSelect={() => setSelectedLetter(v.letter)} />
            ))}
          </div>
          <div className="storage-side-cards">
            <RecycleBinCard />
            <OneDriveCard folders={scanFolders} />
          </div>
        </div>

        {/* Row 2: Storage breakdown + user folder explorer */}
        <div className="two-col-grid storage-two-col">
          <StorageBreakdown
            root={selectedRoot}
            folders={scanFolders}
            scanTs={scanTs}
            isFetching={foldersFetching}
            onRescan={triggerFullRescan}
            volume={vols.find((v) => v.letter === selectedLetter)}
          />
          <UserFolderExplorer folders={scanFolders} />
        </div>

        {/* Row 3: Installed apps */}
        <InstalledAppsPanel />

        {/* Row 4: Recommendations */}
        <StorageRecommendations
          volumes={vols}
          recycleBinSize={recycleBinSize ?? 0}
          folders={scanFolders}
          apps={apps}
        />

        {/* Row 5: Smart Organizer */}
        <SmartOrganizerPanel rescanSignal={rescanEpoch} onUserRescan={triggerFullRescan} />
      </div>
    </div>
  );
}

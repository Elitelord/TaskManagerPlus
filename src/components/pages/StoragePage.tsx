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
  createFolder,
  moveItemsToFolder,
  recycleFiles,
  listFilesByExtensions,
  checkPathExists,
  revealInExplorer,
} from "../../lib/ipc";
import type { FoundFile } from "../../lib/ipc";
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
  ALL_CREATIVE_EXTENSIONS,
  type FindingGroup,
  type FolderComposition,
  type SubfolderSuggestion,
  type OrganizerAnalysis,
  type CreativeFileRecord,
  type LargeFileRecord,
  type LogTempFileRecord,
  type HistorySnapshot,
} from "../../lib/smartOrganizer";
import {
  scanBuildArtifacts,
  findDuplicateFiles,
} from "../../lib/ipc";
import type { BuildArtifact, DuplicateGroup } from "../../lib/types";

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
            <div
              key={f.path}
              className="folder-row folder-row-clickable"
              title={`Open ${f.path} in File Explorer`}
              role="button"
              tabIndex={0}
              onClick={() => openWindowsSettingsUri(f.path).catch(() => {})}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  openWindowsSettingsUri(f.path).catch(() => {});
                }
              }}
            >
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

// ─── Drill-down cache (biggest subfolders + biggest files per user folder) ──
// Used by the Smart Organizer's expandable composition rows. Previously backed
// a now-removed "User Folders" tabbed card; the cache shape + key still apply
// so pre-existing entries still populate on first expand.

// Cache key bumped to v2 when we added `files` to each entry — existing v1
// entries (folders-only) are still read via the legacy array / { folders, ts }
// shapes but will be replaced on the next scan.
const SUB_CACHE_KEY = "taskmanagerplus-subfolder-cache-v2";
const LEGACY_SUB_CACHE_KEY = "taskmanagerplus-subfolder-cache";

interface SubFolderCacheEntry {
  folders: StorageFolderInfo[];
  files: FoundFile[];
  ts: number;
}

function getSubCache(path: string): SubFolderCacheEntry | null {
  try {
    const raw = localStorage.getItem(SUB_CACHE_KEY) ?? localStorage.getItem(LEGACY_SUB_CACHE_KEY);
    if (raw) {
      const cache = JSON.parse(raw);
      const entry = cache?.[path];
      if (!entry) return null;
      if (Array.isArray(entry)) return { folders: entry, files: [], ts: 0 };
      if (Array.isArray(entry.folders)) {
        return {
          folders: entry.folders,
          files: Array.isArray(entry.files) ? entry.files : [],
          ts: entry.ts ?? 0,
        };
      }
    }
  } catch { /* ignore */ }
  return null;
}

function setSubCache(path: string, folders: StorageFolderInfo[], files: FoundFile[]) {
  try {
    const raw = localStorage.getItem(SUB_CACHE_KEY);
    const cache = raw ? JSON.parse(raw) : {};
    cache[path] = { folders, files, ts: Date.now() };
    localStorage.setItem(SUB_CACHE_KEY, JSON.stringify(cache));
  } catch { /* quota */ }
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
          {filtered.map((a, i) => {
            const loc = a.install_location?.trim();
            const clickable = !!loc;
            const openLoc = () => { if (loc) openWindowsSettingsUri(loc).catch(() => {}); };
            return (
              <div
                key={`${a.name}-${a.version}-${i}`}
                className={`installed-app-row${clickable ? " installed-app-row-clickable" : ""}`}
                title={clickable ? `Open ${loc} in File Explorer` : "Install location unknown"}
                role={clickable ? "button" : undefined}
                tabIndex={clickable ? 0 : undefined}
                onClick={clickable ? openLoc : undefined}
                onKeyDown={clickable ? (e) => {
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openLoc(); }
                } : undefined}
              >
                <div className="installed-app-main">
                  <span className="installed-app-name">{a.name}</span>
                  <span className="installed-app-meta">{a.publisher || "Unknown publisher"}{a.version ? ` · v${a.version}` : ""}</span>
                </div>
                <span className="installed-app-size">{a.size_bytes > 0 ? formatBytes(a.size_bytes) : "—"}</span>
              </div>
            );
          })}
          {!filtered.length && <div className="empty-state">No apps match that filter.</div>}
        </div>
      </>)}
    </div>
  );
}


// ─── Dismissed-card tracking ────────────────────────────────────────────────
// Each finding / suggestion / recommendation has a stable id. The user can
// click ✕ to dismiss any card; we persist the id set in localStorage so the
// card stays hidden across scans and app restarts. A "Show dismissed (N)"
// link at the bottom of the organizer brings them back.

const ORGANIZER_DISMISSED_KEY = "taskmanagerplus-organizer-dismissed";

function loadDismissedIds(): Set<string> {
  try {
    const raw = localStorage.getItem(ORGANIZER_DISMISSED_KEY);
    if (raw) return new Set<string>(JSON.parse(raw));
  } catch { /* ignore corrupt cache */ }
  return new Set<string>();
}

function saveDismissedIds(ids: Set<string>) {
  try { localStorage.setItem(ORGANIZER_DISMISSED_KEY, JSON.stringify([...ids])); }
  catch { /* quota */ }
}

// ─── Intent chips + target-mode persistence ────────────────────────────────
// The chip row above the findings list filters by *intent* — what the user
// is trying to do right now (reclaim space, organize files, hunt duplicates,
// …). The last-chosen intent persists across reloads so the panel reopens in
// the same view. The free-up-X target stores its last value too, but we do
// NOT auto-activate target mode on next visit — the user has to explicitly
// click a preset / set a custom GB.

// "reclaim" used to be its own chip but the dedicated Free-up-space panel
// covers that flow more directly, so we dropped the chip. The remaining
// chips are *browsing* filters — what kind of finding to look at — not
// goal selectors.
type Intent = "all" | "organize" | "duplicates" | "downloads" | "old" | "large";

const ALL_INTENTS: Intent[] = ["all", "organize", "duplicates", "downloads", "old", "large"];

const INTENT_LABEL: Record<Intent, string> = {
  all: "All",
  organize: "Organize",
  duplicates: "Duplicates",
  downloads: "Downloads",
  old: "Old & stale",
  large: "Large",
};

// Empty-state copy shown when filtering by an intent yields zero findings.
const INTENT_EMPTY_COPY: Record<Intent, string> = {
  all: "Your user folders look well organized.",
  organize: "Nothing looks misplaced — your folders are well organized.",
  duplicates: "No duplicates found above 50 MB.",
  downloads: "Your Downloads folder looks clean.",
  old: "No stale files or build artifacts to clean up.",
  large: "No oversized files found.",
};

const ORGANIZER_INTENT_KEY = "organizer.intent";
const ORGANIZER_TARGET_GB_KEY = "organizer.targetGB";

function loadIntent(): Intent {
  try {
    const raw = localStorage.getItem(ORGANIZER_INTENT_KEY);
    if (raw && (ALL_INTENTS as string[]).includes(raw)) return raw as Intent;
  } catch { /* ignore */ }
  return "all";
}
function saveIntent(intent: Intent) {
  try { localStorage.setItem(ORGANIZER_INTENT_KEY, intent); } catch { /* quota */ }
}

function loadTargetGB(): number {
  try {
    const raw = localStorage.getItem(ORGANIZER_TARGET_GB_KEY);
    if (raw) {
      const n = parseFloat(raw);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch { /* ignore */ }
  return 5;
}
function saveTargetGB(gb: number) {
  try { localStorage.setItem(ORGANIZER_TARGET_GB_KEY, String(gb)); } catch { /* quota */ }
}

// Tier definitions for the free-up-X target picker. Each tier defines a pool
// of finding ids/tags eligible for that tier; the picker greedily sums their
// reclaimableBytes and picks the lowest tier that hits the target.
//
//   easy   — Downloads + log/temp + recycle bin
//   medium — easy + duplicates + stale build artifacts + large lone files
//   heavy  — medium + installed apps (all sizable apps, not just "unused")
//
// We try the lightest pool first; if it can't hit the target we widen to
// the next one. The detector emits one finding per app so the picker can
// select an individual app whose size best matches the target, rather
// than bundling everything into a single overshoot-prone entry.
//
// Banner copy uses the literal token "{X}" for the requested target and
// "{Y}" for the maximum we could actually free (used in the unreachable
// case). The renderer does the substitution.

function inEasyPool(f: FindingGroup): boolean {
  const tags = f.tags ?? [];
  if (!tags.includes("reclaim")) return false;
  return tags.includes("downloads") || f.id === "log-temp-files" || f.id === "recycle-bin-bloat";
}
function inMediumPool(f: FindingGroup): boolean {
  if (inEasyPool(f)) return true;
  return f.id === "duplicate-files" || f.id === "stale-build-artifacts" || f.id === "large-lone-files";
}
function inHeavyPool(f: FindingGroup): boolean {
  if (inMediumPool(f)) return true;
  return (f.tags ?? []).includes("app");
}

/** Pick the tightest set of findings that covers the target.
 *
 *  Strategy:
 *   1. If any single finding is on its own ≥ the target, pick the *smallest*
 *      such finding. This avoids the "user wants 10 GB → picker selects a
 *      50 GB app because it sorted biggest-first" overshoot.
 *   2. Otherwise no single finding covers it; fall back to biggest-first
 *      accumulation until the target is reached.
 *
 *  Findings with reclaimableBytes ≤ 0 are skipped in both branches. */
function greedyPick(pool: FindingGroup[], targetBytes: number): { ids: Set<string>; total: number } {
  const positive = pool.filter((f) => f.reclaimableBytes > 0);

  // Step 1 — best single-item fit.
  const singleFits = positive
    .filter((f) => f.reclaimableBytes >= targetBytes)
    .sort((a, b) => a.reclaimableBytes - b.reclaimableBytes);
  if (singleFits.length > 0) {
    const pick = singleFits[0];
    return { ids: new Set([pick.id]), total: pick.reclaimableBytes };
  }

  // Step 2 — biggest-first combination.
  const sorted = [...positive].sort((a, b) => b.reclaimableBytes - a.reclaimableBytes);
  const ids = new Set<string>();
  let total = 0;
  for (const f of sorted) {
    ids.add(f.id);
    total += f.reclaimableBytes;
    if (total >= targetBytes) break;
  }
  return { ids, total };
}

type PickDepth = "easy" | "medium" | "heavy";

interface TierResult {
  depth: PickDepth;
  pool: FindingGroup[];
  pickedIds: Set<string>;
  pickedTotal: number;
  reachable: boolean;
  /** Banner template with {X} (target) / {Y} (max possible) placeholders. */
  banner: string;
  bannerVariant: "info" | "warn" | "heavy" | "unreachable";
}

function pickTier(allFindings: FindingGroup[], targetBytes: number): TierResult {
  const easy = allFindings.filter(inEasyPool);
  const medium = allFindings.filter(inMediumPool);
  const heavy = allFindings.filter(inHeavyPool);

  const ge = greedyPick(easy, targetBytes);
  if (ge.total >= targetBytes) {
    return {
      depth: "easy", pool: easy, pickedIds: ge.ids, pickedTotal: ge.total, reachable: true,
      banner: "Clearing Downloads, logs, and the Recycle Bin gets you to {X}.",
      bannerVariant: "info",
    };
  }
  const gm = greedyPick(medium, targetBytes);
  if (gm.total >= targetBytes) {
    return {
      depth: "medium", pool: medium, pickedIds: gm.ids, pickedTotal: gm.total, reachable: true,
      banner: "Downloads alone won't get you to {X} — duplicates and stale build folders fill the gap.",
      bannerVariant: "warn",
    };
  }
  const gh = greedyPick(heavy, targetBytes);
  if (gh.total >= targetBytes) {
    return {
      depth: "heavy", pool: heavy, pickedIds: gh.ids, pickedTotal: gh.total, reachable: true,
      banner: "Most of {X} is in installed apps — uninstalling one or two gets you there.",
      bannerVariant: "heavy",
    };
  }
  // Can't hit the target with anything we found. Show all positive contributors
  // so the user can see what would help; the unreachable banner explains the gap.
  const allReclaimIds = new Set(heavy.filter((f) => f.reclaimableBytes > 0).map((f) => f.id));
  return {
    depth: "heavy", pool: heavy, pickedIds: allReclaimIds, pickedTotal: gh.total, reachable: false,
    banner: "We can free {Y} from this drive — short of {X}. The rest will need to come from somewhere else.",
    bannerVariant: "unreachable",
  };
}

// ─── Drive-aware advisory: shift / external suggestions ──────────────────
// When the target is a serious fraction of the system drive (>1/2 capacity),
// we surface concrete alternatives:
//   • Other connected local/USB drives with enough free space → "move to D:"
//   • No alternatives → "consider an external drive"
// This banner sits above the picker banner so the structural advice comes
// first — no point grinding through 80 GB of duplicates if half of it could
// just live on the second drive the user already has plugged in.

interface DriveAdvisory {
  kind: "shift" | "external" | null;
  systemLetter: string;
  systemTotal: number;
  candidates: { letter: string; label: string; freeBytes: number; mediaKind: string }[];
}

function computeDriveAdvisory(volumes: StorageVolumeInfo[], targetBytes: number): DriveAdvisory {
  const localKinds = new Set(["nvme", "ssd", "hdd"]);
  const local = volumes.filter((v) => localKinds.has(v.media_kind));
  const sys = local.find((v) => v.is_system) ?? [...local].sort((a, b) => b.total_bytes - a.total_bytes)[0];
  if (!sys) return { kind: null, systemLetter: "", systemTotal: 0, candidates: [] };

  const halfSys = sys.total_bytes / 2;
  if (targetBytes < halfSys) {
    return { kind: null, systemLetter: sys.letter, systemTotal: sys.total_bytes, candidates: [] };
  }

  // "A serious chunk." Look for other drives the user could shift files to.
  // Include external/USB — they're explicit alternatives the user already has.
  const otherKinds = new Set(["nvme", "ssd", "hdd", "usb"]);
  const candidates = volumes
    .filter((v) => v.letter !== sys.letter && otherKinds.has(v.media_kind) && !v.is_readonly)
    // Need at least half the target free to be a useful destination; below
    // that we're recommending a drive that can't hold a meaningful slice.
    .filter((v) => v.free_bytes >= targetBytes / 2)
    .sort((a, b) => b.free_bytes - a.free_bytes)
    .slice(0, 3)
    .map((v) => ({ letter: v.letter, label: v.label || `${v.letter}:`, freeBytes: v.free_bytes, mediaKind: v.media_kind }));

  return {
    kind: candidates.length > 0 ? "shift" : "external",
    systemLetter: sys.letter,
    systemTotal: sys.total_bytes,
    candidates,
  };
}

// ─── ConfirmDialog (reusable) ───────────────────────────────────────────────
// Replaces `window.confirm()` so confirmations match the rest of the app and
// can carry richer content (paths on their own line, danger styling, etc.).
// Usage: render <ConfirmDialog ... /> when a pending-action state is set;
// the component handles Enter / Escape and traps focus on the primary button.

interface ConfirmDialogProps {
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "danger";
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmDialog({
  title, message,
  confirmLabel = "Confirm", cancelLabel = "Cancel",
  variant = "default",
  onConfirm, onCancel,
}: ConfirmDialogProps) {
  const primaryRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    // Autofocus primary button so Enter confirms immediately.
    primaryRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      else if (e.key === "Enter") { e.preventDefault(); onConfirm(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onConfirm, onCancel]);

  return (
    <div className="confirm-overlay" onClick={onCancel}>
      <div className="confirm-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
        <div className="confirm-title" id="confirm-dialog-title">{title}</div>
        <div className="confirm-message">{message}</div>
        <div className="confirm-actions">
          <button className="confirm-btn cancel" onClick={onCancel}>{cancelLabel}</button>
          <button
            ref={primaryRef}
            className={`confirm-btn ${variant === "danger" ? "danger" : "primary"}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

interface Recommendation {
  /** Stable id used for dismissal persistence. */
  id: string;
  icon: string;
  title: string;
  detail: string;
  action?: () => void;
  actionLabel?: string;
  severity: "info" | "warning" | "critical";
  /** Heuristic bytes this recommendation is about — used to sort the unified
   *  Cleanup list alongside findings. Zero for informational items. */
  bytesHint: number;
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
// Bumped to 5 when we added the extended detector inputs (`buildArtifacts`,
// `duplicates`, `largeFiles`, `logTempFiles`, `recycleBinSize`, `installedApps`,
// `history`). v4 caches are discarded rather than migrated — the extra scan
// passes are cheap relative to the primary file-type walk, so a forced
// rescan is preferable to a half-populated UI.
const ORGANIZER_CACHE_VERSION = 5;
// How many historical snapshots we retain for the growth-detection detector.
// Each snapshot is tiny (7 numbers), but >12 becomes visual noise when
// debugging localStorage — we only need two+ samples spanning enough time.
const ORGANIZER_HISTORY_MAX = 12;

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
  /** Absolute paths of top folders under the user profile, used by the
   *  organizer to detect already-existing named folders (e.g. "GitHub",
   *  "Projects", "Pictures\Screenshots") so we don't suggest creating
   *  folders the user already has. */
  subfolderPaths: string[];
  /** Creative workflow files (3D, art, video/audio projects, RAW photos,
   *  CAD, game projects) enumerated via `list_files_by_extensions` per user
   *  folder. Fed into `generateCreativeSuggestions` to nudge the user into
   *  grouping their creative work under a dedicated home folder. */
  creativeFiles: CreativeFileRecord[];
  /** Per-folder scan completion timestamps (Date.now()). Keyed by the
   *  absolute folder path (e.g. "C:\Users\Me\Downloads"). Populated as each
   *  folder's scan completes during a streamed run, and updated by the
   *  per-folder refresh button. */
  folderTimestamps?: Record<string, number>;
  /** Set to true while a streamed scan is in flight so the UI can show a
   *  "filling in" state. Cleared when the scan fully completes. */
  partial?: boolean;
  // ─── v5 extended detector inputs ──────────────────────────────────────
  /** node_modules / target/ / __pycache__ / .venv / dormant .git folders
   *  found under detected projects. Fed into `detectStaleDevArtifacts`. */
  buildArtifacts?: BuildArtifact[];
  /** Content-identical file groups (BLAKE3) across user folders. Fed into
   *  `detectDuplicates`. */
  duplicates?: DuplicateGroup[];
  /** Individual files ≥ 1 GB enumerated under user folders (any extension).
   *  Fed into `detectLargeFiles`. */
  largeFiles?: LargeFileRecord[];
  /** Log / temp / dump / etl / .old files enumerated under user folders.
   *  Fed into `detectLogAndTempFiles`. */
  logTempFiles?: LogTempFileRecord[];
  /** Total bytes currently held in the Recycle Bin. Fed into
   *  `detectRecycleBinBloat`. */
  recycleBinSize?: number;
  /** Installed apps (from `get_installed_apps`). Used by
   *  `detectUnusedInstalledApps` to flag large apps installed long ago. */
  installedApps?: InstalledAppInfo[];
  /** Rolling history of past scans (capped at ORGANIZER_HISTORY_MAX). Fed
   *  into `detectTimeSeriesGrowth` to spot folders doubling in size. */
  history?: HistorySnapshot[];
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

interface DrillDown {
  folders: StorageFolderInfo[];
  files: FoundFile[];
  ts: number;
}

function StackedBar({
  comp, totalRef, onRefresh, refreshing, lastRefreshed,
}: {
  comp: FolderComposition;
  totalRef: number;
  onRefresh?: () => void;
  refreshing?: boolean;
  lastRefreshed?: number;
}) {
  // Width of the full bar is relative to the LARGEST folder's total so bars
  // are comparable across rows (rather than each normalized to its own 100%).
  const pctOfMax = totalRef > 0 ? (comp.totalBytes / totalRef) * 100 : 0;
  const refreshTitle = refreshing
    ? `Re-scanning ${comp.key}…`
    : lastRefreshed
      ? `Re-scan just ${comp.key} (last: ${relativeTimeLabel(Date.now() - lastRefreshed)})`
      : `Re-scan just ${comp.key}`;

  // Drill-down state (biggest subfolders + biggest files inside this folder).
  // Lazily populated on first expand; re-fetched after a `refreshing` pass so
  // the drill-down doesn't show stale counts.
  const [expanded, setExpanded] = useState(false);
  const [drill, setDrill] = useState<DrillDown | null>(null);
  const [drillLoading, setDrillLoading] = useState(false);

  // When the parent signals a re-scan of this row, drop the cached drill-down
  // so re-expanding re-fetches.
  const wasRefreshing = useRef(false);
  useEffect(() => {
    if (wasRefreshing.current && !refreshing) setDrill(null);
    wasRefreshing.current = !!refreshing;
  }, [refreshing]);

  // On first expand (or re-expand after refresh), load from cache then fall
  // back to a live scan of the folder. NOTE: `drillLoading` is intentionally
  // NOT in the deps — flipping it re-ran this effect whose cleanup cancelled
  // the in-flight fetch, so non-cached folders stayed loading forever. A ref
  // guards against overlapping fetches instead.
  const fetchingPathRef = useRef<string | null>(null);
  useEffect(() => {
    if (!expanded || drill) return;
    const cached = getSubCache(comp.folderPath);
    if (cached && (cached.folders.length > 0 || cached.files.length > 0)) {
      setDrill({ folders: cached.folders, files: cached.files, ts: cached.ts });
      return;
    }
    if (fetchingPathRef.current === comp.folderPath) return; // already fetching this folder
    fetchingPathRef.current = comp.folderPath;
    setDrillLoading(true);
    (async () => {
      try {
        const parentNorm = comp.folderPath.replace(/\\$/, "").toLowerCase() + "\\";
        const [foldersRes, filesRes] = await Promise.allSettled([
          getTopFolders(comp.folderPath, 12),
          listFilesByExtensions(comp.folderPath, [], 2, 20),
        ]);
        const folders = foldersRes.status === "fulfilled"
          ? foldersRes.value
              .filter((f) => f.path.replace(/\\$/, "").toLowerCase().startsWith(parentNorm))
              .sort((a, b) => b.size_bytes - a.size_bytes)
              .slice(0, 8)
          : [];
        const files = filesRes.status === "fulfilled"
          ? filesRes.value
              .filter((f) => f.path.replace(/\\$/, "").toLowerCase().startsWith(parentNorm))
              .sort((a, b) => b.size_bytes - a.size_bytes)
              .slice(0, 12)
          : [];
        setDrill({ folders, files, ts: Date.now() });
        setSubCache(comp.folderPath, folders, files);
      } finally {
        setDrillLoading(false);
        fetchingPathRef.current = null;
      }
    })();
  }, [expanded, drill, comp.folderPath]);

  const drillEmpty = !drillLoading && drill && drill.folders.length === 0 && drill.files.length === 0;

  return (
    <div className="org-comp-group">
      <div
        className={`org-comp-row is-expandable${expanded ? " is-expanded" : ""}`}
        title={comp.folderPath}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
      >
        <span className="org-comp-label">
          <svg
            className={`org-comp-chevron${expanded ? " is-open" : ""}`}
            width="10" height="10" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M9 6l6 6-6 6" />
          </svg>
          {comp.key}
        </span>
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
        {onRefresh && (
          <button
            className={`org-comp-refresh btn-icon${refreshing ? " is-spinning" : ""}`}
            onClick={(e) => { e.stopPropagation(); onRefresh(); }}
            disabled={refreshing}
            title={refreshTitle}
            aria-label={`Re-scan ${comp.key}`}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 12a9 9 0 1 1-3-6.7" />
              <path d="M21 4v5h-5" />
            </svg>
          </button>
        )}
      </div>
      {expanded && (
        <div className="org-comp-drilldown">
          {drillLoading && (
            <div className="org-drill-loading">
              <div className="spinner spinner-sm" /> Scanning folder contents…
            </div>
          )}
          {!drillLoading && drill && drill.folders.length > 0 && (
            <div>
              <div className="org-drill-heading">Biggest subfolders</div>
              <div className="org-drill-list">
                {drill.folders.map((f) => {
                  const leaf = f.display_name.split("\\").pop() ?? f.display_name;
                  return (
                    <div
                      key={f.path}
                      className="org-drill-row"
                      role="button"
                      tabIndex={0}
                      title={`Open ${f.path} in File Explorer`}
                      onClick={(e) => { e.stopPropagation(); revealInExplorer(f.path).catch(() => {}); }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          e.stopPropagation();
                          revealInExplorer(f.path).catch(() => {});
                        }
                      }}
                    >
                      <span className="org-drill-name">{leaf}</span>
                      <span className="org-drill-size">{formatBytes(f.size_bytes)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {!drillLoading && drill && drill.files.length > 0 && (
            <div>
              <div className="org-drill-heading">Biggest files</div>
              <div className="org-drill-list">
                {drill.files.map((f) => (
                  <div
                    key={f.path}
                    className="org-drill-row"
                    role="button"
                    tabIndex={0}
                    title={`Reveal ${f.path} in File Explorer`}
                    onClick={(e) => { e.stopPropagation(); revealInExplorer(f.path).catch(() => {}); }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        e.stopPropagation();
                        revealInExplorer(f.path).catch(() => {});
                      }
                    }}
                  >
                    <span className="org-drill-name">{f.name}</span>
                    <span className="org-drill-size">{formatBytes(f.size_bytes)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {drillEmpty && (
            <div className="org-drill-empty">No subfolders or files found in this folder.</div>
          )}
        </div>
      )}
    </div>
  );
}

/** Tiny humanizer for "just now / 5m / 2h / 3d". */
function relativeTimeLabel(ms: number): string {
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

function OrgScoreGauge({ score }: { score: number }) {
  const r = 32;
  const c = 2 * Math.PI * r;
  const dash = (score / 100) * c;
  const color = score >= 70 ? "var(--accent-green)" : score >= 50 ? "var(--accent-orange)" : "var(--accent-red)";
  const tooltip =
    "Organization score (0–100). Higher is better. " +
    "We look at how cluttered your user folders are (lots of loose files), " +
    "how much space temp/cache and Recycle Bin are using, and how full your drives are.";
  return (
    <div
      className="org-score"
      aria-label={`Organization score ${score} out of 100`}
      title={tooltip}
    >
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

function FindingRow({
  group, onActionDone, onDismiss, userFolders,
}: {
  group: FindingGroup;
  onActionDone?: () => void;
  onDismiss?: (id: string) => void;
  userFolders?: Record<string, string>;
}) {
  const [busy, setBusy] = useState(false);
  const [actionResult, setActionResult] = useState<string | null>(null);
  const [showFiles, setShowFiles] = useState(false);
  const [files, setFiles] = useState<FoundFile[] | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  // Selected paths; null before load. Defaults to "all selected" on load so
  // the primary action matches the old behavior, but the user can uncheck
  // rows to narrow the set before confirming.
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [pendingAction, setPendingAction] = useState<"recycle" | "move" | "emptyRecycleBin" | "duplicates" | null>(null);
  // For shift-click range selection — mirrors Windows Explorer convention.
  const [anchorIdx, setAnchorIdx] = useState<number | null>(null);

  const hasFileAction = group.actionType === "recycle" || group.actionType === "move";
  const isDuplicates = group.actionType === "duplicates";
  const isEmptyRecycleBin = group.actionType === "emptyRecycleBin";

  // Determine the target folder for "move" actions
  const targetFolder = group.targetFolderKey && userFolders
    ? userFolders[group.targetFolderKey.toLowerCase()] ?? ""
    : "";

  // Auto-load files eagerly for action-capable findings. This was previously
  // lazy (click "Show files" to populate), but that made the action buttons
  // unclickable on first render — the button was disabled until files loaded,
  // which required a user click to trigger. Eager loading enables the button
  // as soon as enumeration finishes.
  useEffect(() => {
    let cancelled = false;
    if (!hasFileAction) return;
    if (files !== null) return; // already loaded

    // Fast path: the finding carries the exact paths inline (build-artifacts,
    // large-lone-files, log/temp findings). No backend call needed — just
    // synthesise a FoundFile-shaped list so the existing selection + recycle
    // flow below works unchanged.
    if (group.directPaths && group.directPaths.length > 0) {
      const synth: FoundFile[] = group.directPaths.map((d) => ({
        path: d.path,
        name: d.label ?? d.path.slice(Math.max(d.path.lastIndexOf("\\"), d.path.lastIndexOf("/")) + 1),
        size_bytes: d.size_bytes,
        modified_ts: 0,
      }));
      setFiles(synth);
      setSelected(new Set(synth.map((f) => f.path)));
      return;
    }

    if (!group.extensions || !group.folderPath) return;
    setFilesLoading(true);
    const sourceFolders = group.items.filter((it) => it.path).map((it) => it.path!);
    const folders = sourceFolders.length > 0 ? sourceFolders : [group.folderPath];
    const all: FoundFile[] = [];
    Promise.all(
      folders.map((f) =>
        listFilesByExtensions(f, group.extensions!, 2, 100)
          .then((r) => { all.push(...r); })
          .catch(() => { /* ignore errors for individual folders */ })
      ),
    ).then(() => {
      if (cancelled) return;
      all.sort((a, b) => b.size_bytes - a.size_bytes);
      const capped = all.slice(0, 100);
      setFiles(capped);
      setSelected(new Set(capped.map((f) => f.path)));
    }).finally(() => { if (!cancelled) setFilesLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group.id]);

  const fileCount = files?.length ?? 0;
  const selectedCount = selected?.size ?? 0;
  const selectedFiles = useMemo(
    () => (files ?? []).filter((f) => selected?.has(f.path)),
    [files, selected],
  );
  const selectedBytes = useMemo(
    () => selectedFiles.reduce((n, f) => n + f.size_bytes, 0),
    [selectedFiles],
  );

  // Checkbox header state: "all" | "none" | "some" (indeterminate)
  const headerState = !files || files.length === 0 ? "none"
    : selectedCount === 0 ? "none"
    : selectedCount === files.length ? "all"
    : "some";

  const toggleOne = (path: string, idx: number, shift: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev ?? []);
      if (shift && anchorIdx !== null && files) {
        const [lo, hi] = anchorIdx < idx ? [anchorIdx, idx] : [idx, anchorIdx];
        const turningOn = !next.has(files[idx].path);
        for (let i = lo; i <= hi; i++) {
          if (turningOn) next.add(files[i].path);
          else next.delete(files[i].path);
        }
      } else {
        if (next.has(path)) next.delete(path);
        else next.add(path);
      }
      return next;
    });
    setAnchorIdx(idx);
  };

  const toggleAll = () => {
    if (!files) return;
    setSelected((prev) => {
      if (prev && prev.size === files.length) return new Set();
      return new Set(files.map((f) => f.path));
    });
    setAnchorIdx(null);
  };

  const doRecycle = async () => {
    setPendingAction(null);
    if (busy) return;
    const paths = selectedFiles.map((f) => f.path);
    if (paths.length === 0) return;
    setBusy(true);
    setActionResult(null);
    try {
      const r = await recycleFiles(paths);
      const parts: string[] = [];
      if (r.recycled > 0) parts.push(`${r.recycled} sent to Recycle Bin`);
      if (r.errors.length > 0) parts.push(`${r.errors.length} couldn't be moved`);
      setActionResult(parts.join(" · ") || "Done");
      if (r.recycled > 0) {
        // Remove the now-deleted paths from the local list so the card
        // reflects reality without forcing a full rescan.
        setFiles((prev) => prev?.filter((f) => !paths.includes(f.path)) ?? null);
        setSelected((prev) => {
          const next = new Set(prev ?? []);
          for (const p of paths) next.delete(p);
          return next;
        });
        onActionDone?.();
      }
    } catch (e) { setActionResult(friendlyError(e)); }
    finally { setBusy(false); }
  };

  const doMove = async () => {
    setPendingAction(null);
    if (busy || !targetFolder) return;
    const paths = selectedFiles.map((f) => f.path);
    if (paths.length === 0) return;
    setBusy(true);
    setActionResult(null);
    try {
      const r = await moveItemsToFolder(paths, targetFolder);
      const parts: string[] = [];
      if (r.moved > 0) parts.push(`${r.moved} moved`);
      if (r.skipped.length > 0) parts.push(`${r.skipped.length} skipped (already there)`);
      if (r.errors.length > 0) parts.push(`${r.errors.length} couldn't be moved`);
      setActionResult(parts.join(" · ") || "Done");
      if (r.moved > 0) {
        setFiles((prev) => prev?.filter((f) => !paths.includes(f.path)) ?? null);
        setSelected((prev) => {
          const next = new Set(prev ?? []);
          for (const p of paths) next.delete(p);
          return next;
        });
        onActionDone?.();
      }
    } catch (e) { setActionResult(friendlyError(e)); }
    finally { setBusy(false); }
  };

  // ─── Duplicates-picker state ────────────────────────────────────────────
  // For "duplicates" findings, each group has its own chosen keeper index.
  // The detector pre-picks a sensible default; the user can override via
  // radios before clicking the action button. Everything that ISN'T the
  // keeper gets sent to the Recycle Bin on confirm.
  const [keeperByGroup, setKeeperByGroup] = useState<Record<string, number> | null>(null);
  // Initialise keeperByGroup from group.duplicates on first render of a
  // duplicates finding. We want this to survive re-renders of the card but
  // reset if the underlying finding changes (id differs).
  useEffect(() => {
    if (!isDuplicates || !group.duplicates) return;
    const init: Record<string, number> = {};
    for (const d of group.duplicates) init[d.hash] = d.defaultKeeperIndex;
    setKeeperByGroup(init);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group.id]);

  const duplicateRecyclePaths = useMemo(() => {
    if (!isDuplicates || !group.duplicates || !keeperByGroup) return [] as string[];
    const out: string[] = [];
    for (const d of group.duplicates) {
      const keep = keeperByGroup[d.hash] ?? d.defaultKeeperIndex;
      d.copies.forEach((c, i) => { if (i !== keep) out.push(c.path); });
    }
    return out;
  }, [isDuplicates, group.duplicates, keeperByGroup]);

  const duplicateReclaimBytes = useMemo(() => {
    if (!isDuplicates || !group.duplicates) return 0;
    return group.duplicates.reduce(
      (n, d) => n + d.size_bytes * (d.copies.length - 1),
      0,
    );
  }, [isDuplicates, group.duplicates]);

  const doDuplicateRecycle = async () => {
    setPendingAction(null);
    if (busy || duplicateRecyclePaths.length === 0) return;
    setBusy(true);
    setActionResult(null);
    try {
      const r = await recycleFiles(duplicateRecyclePaths);
      const parts: string[] = [];
      if (r.recycled > 0) parts.push(`${r.recycled} duplicate copies sent to Recycle Bin`);
      if (r.errors.length > 0) parts.push(`${r.errors.length} couldn't be removed`);
      setActionResult(parts.join(" · ") || "Done");
      if (r.recycled > 0) onActionDone?.();
    } catch (e) { setActionResult(friendlyError(e)); }
    finally { setBusy(false); }
  };

  // ─── Empty-recycle-bin action ───────────────────────────────────────────
  const doEmptyRecycleBin = async () => {
    setPendingAction(null);
    if (busy) return;
    setBusy(true);
    setActionResult(null);
    try {
      await emptyRecycleBin();
      setActionResult("Recycle Bin emptied");
      onActionDone?.();
    } catch (e) { setActionResult(friendlyError(e)); }
    finally { setBusy(false); }
  };

  const disableAction = busy || filesLoading || selectedCount === 0;
  const actionLabel = (() => {
    if (busy) {
      return group.actionType === "recycle" ? "Sending…" : "Moving…";
    }
    if (filesLoading) return "Loading files…";
    if (!files) return group.actionType === "recycle" ? "Send to Recycle Bin" : `Move to ${group.targetFolderKey ?? "folder"}`;
    const countLabel = selectedCount === files.length
      ? `${selectedCount} ${selectedCount === 1 ? "file" : "files"}`
      : `${selectedCount} of ${files.length}`;
    if (group.actionType === "recycle") return `Send ${countLabel} to Recycle Bin`;
    return `Move ${countLabel} to ${group.targetFolderKey ?? "folder"}`;
  })();

  return (
    <div className={`finding-card finding-${group.severity}`}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="finding-icon">
        <path d={group.icon} />
      </svg>
      <div className="finding-card-body">
        <div className="finding-card-top">
          <div className="finding-card-info">
            <span className="finding-title">{group.title}</span>
            <span className="finding-summary">{group.summary}</span>
          </div>
          <div className="finding-actions">
            {group.folderPath && (
              <button className="btn-sm" onClick={() => revealInExplorer(group.folderPath).catch(() => { })} title="Open this folder in File Explorer">
                Open folder
              </button>
            )}
            {group.actionType === "recycle" && (
              <button
                className="btn-sm btn-danger"
                onClick={() => setPendingAction("recycle")}
                disabled={disableAction}
                title={selectedCount > 0 ? `Move ${selectedCount} file(s) — ${formatBytes(selectedBytes)} — to the Recycle Bin` : "Select files to recycle"}
              >
                {actionLabel}
              </button>
            )}
            {group.actionType === "move" && targetFolder && (
              <button
                className="btn-sm btn-accent"
                onClick={() => setPendingAction("move")}
                disabled={disableAction}
                title={selectedCount > 0 ? `Move ${selectedCount} file(s) into ${group.targetFolderKey}` : "Select files to move"}
              >
                {actionLabel}
              </button>
            )}
            {isEmptyRecycleBin && (
              <button
                className="btn-sm btn-danger"
                onClick={() => setPendingAction("emptyRecycleBin")}
                disabled={busy}
                title="Permanently empty the Recycle Bin"
              >
                {busy ? "Emptying…" : "Empty Recycle Bin"}
              </button>
            )}
            {isDuplicates && (
              <button
                className="btn-sm btn-danger"
                onClick={() => setPendingAction("duplicates")}
                disabled={busy || duplicateRecyclePaths.length === 0}
                title={
                  duplicateRecyclePaths.length === 0
                    ? "Pick a keeper per group first"
                    : `Send ${duplicateRecyclePaths.length} duplicate copies to Recycle Bin`
                }
              >
                {busy
                  ? "Recycling duplicates…"
                  : `Recycle ${duplicateRecyclePaths.length} duplicate ${duplicateRecyclePaths.length === 1 ? "copy" : "copies"} · ${formatBytes(duplicateReclaimBytes)}`
                }
              </button>
            )}
            {onDismiss && (
              <button
                className="btn-icon finding-dismiss"
                onClick={() => onDismiss(group.id)}
                title="Hide this card"
                aria-label="Hide this card"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>
        <div className="finding-detail">{group.detail}</div>
        {group.cloudProvider && (
          <div className="finding-cloud-note">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 10h-1.3A8 8 0 0 0 6.4 13.4 6 6 0 0 0 7 23h11a5 5 0 0 0 0-10" />
            </svg>
            <span>Synced to {group.cloudProvider} — removal propagates to the cloud copy.</span>
          </div>
        )}
        {actionResult && <div className="finding-action-result">{actionResult}</div>}
        {isDuplicates && group.duplicates && keeperByGroup && (
          <div className="finding-duplicate-picker">
            {group.duplicates.map((dup) => {
              const keeperIdx = keeperByGroup[dup.hash] ?? dup.defaultKeeperIndex;
              return (
                <div key={dup.hash} className="dup-group">
                  <div className="dup-group-header">
                    <span className="dup-group-size">{formatBytes(dup.size_bytes)}</span>
                    <span className="dup-group-count">{dup.copies.length} copies</span>
                    <span className="dup-group-waste">
                      reclaim {formatBytes(dup.wastedBytes)}
                    </span>
                  </div>
                  <ul className="dup-copy-list">
                    {dup.copies.map((copy, i) => {
                      const isKeeper = i === keeperIdx;
                      return (
                        <li
                          key={`${dup.hash}-${i}`}
                          className={`dup-copy-item${isKeeper ? " is-keeper" : " is-removing"}`}
                          title={copy.path}
                        >
                          <label className="dup-copy-label">
                            <input
                              type="radio"
                              name={`dup-keeper-${dup.hash}`}
                              checked={isKeeper}
                              onChange={() => setKeeperByGroup((prev) => ({
                                ...(prev ?? {}),
                                [dup.hash]: i,
                              }))}
                              aria-label={`Keep ${copy.label}`}
                            />
                            <span className="dup-copy-leaf">{copy.label}</span>
                            <span className="dup-copy-dir">{copy.directory}</span>
                          </label>
                          <div className="dup-copy-tags">
                            {copy.cloudProvider && (
                              <span className={`dup-tag dup-tag-cloud${copy.isCloudMirror ? " is-mirror" : ""}`}>
                                {copy.cloudProvider}{copy.isCloudMirror ? " mirror" : ""}
                              </span>
                            )}
                            <span className={`dup-tag ${isKeeper ? "dup-tag-keep" : "dup-tag-remove"}`}>
                              {isKeeper ? "Keep" : "Remove"}
                            </span>
                            <button
                              className="btn-sm"
                              onClick={() => revealInExplorer(copy.path).catch(() => {})}
                              title="Show in File Explorer"
                            >
                              Reveal
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
        {hasFileAction && group.extensions && (
          <>
            <button
              className="finding-file-toggle"
              onClick={() => setShowFiles((v) => !v)}
              type="button"
              disabled={filesLoading}
            >
              {filesLoading ? "Loading file list…" : (
                showFiles
                  ? `▾ Hide files${fileCount > 0 ? ` (${fileCount})` : ""}`
                  : `▸ Review files${fileCount > 0 ? ` (${fileCount})` : ""}`
              )}
            </button>
            {showFiles && files && files.length > 0 && (
              <div className="finding-file-section">
                <div className="finding-file-header">
                  <label className="finding-file-selectall">
                    <input
                      type="checkbox"
                      checked={headerState === "all"}
                      ref={(el) => { if (el) el.indeterminate = headerState === "some"; }}
                      onChange={toggleAll}
                      aria-label={headerState === "all" ? "Deselect all" : "Select all"}
                    />
                    <span>
                      {selectedCount === files.length
                        ? `All ${files.length} selected · ${formatBytes(selectedBytes)}`
                        : `${selectedCount} of ${files.length} selected · ${formatBytes(selectedBytes)}`}
                    </span>
                  </label>
                  <span className="finding-file-hint">Shift-click for range · click row to toggle</span>
                </div>
                <ul className="finding-file-list">
                  {files.map((f, i) => {
                    const isSelected = selected?.has(f.path) ?? false;
                    return (
                      <li
                        key={`${f.path}-${i}`}
                        className={`finding-file-item${isSelected ? " is-selected" : ""}`}
                        onClick={(e) => {
                          // Don't double-toggle when the user clicks the
                          // checkbox or the Reveal button — they handle
                          // themselves.
                          const t = e.target as HTMLElement;
                          if (t.closest("button") || t.closest("input")) return;
                          toggleOne(f.path, i, e.shiftKey);
                        }}
                      >
                        <input
                          type="checkbox"
                          className="finding-file-check"
                          checked={isSelected}
                          onChange={(e) => toggleOne(f.path, i, (e.nativeEvent as MouseEvent).shiftKey)}
                          onClick={(e) => e.stopPropagation()}
                          aria-label={`Select ${f.name}`}
                        />
                        <span className="finding-file-name" title={f.path}>{f.name}</span>
                        <span className="finding-file-size">{formatBytes(f.size_bytes)}</span>
                        <button
                          className="btn-sm"
                          onClick={(e) => { e.stopPropagation(); revealInExplorer(f.path).catch(() => { }); }}
                          title="Show in File Explorer"
                        >
                          Reveal
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            {showFiles && files && files.length === 0 && (
              <div className="finding-file-empty">No matching files found.</div>
            )}
          </>
        )}
      </div>
      {pendingAction === "recycle" && (
        <ConfirmDialog
          title="Send to Recycle Bin?"
          variant="danger"
          confirmLabel={`Send ${selectedCount} ${selectedCount === 1 ? "file" : "files"}`}
          message={
            <>
              <p style={{ margin: "0 0 10px 0" }}>
                {selectedCount} {selectedCount === 1 ? "file" : "files"} ({formatBytes(selectedBytes)}) will be sent to the Recycle Bin.
              </p>
              <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 12 }}>
                Nothing is permanently deleted — you can restore files from the Recycle Bin at any time.
              </p>
            </>
          }
          onConfirm={doRecycle}
          onCancel={() => setPendingAction(null)}
        />
      )}
      {pendingAction === "move" && (
        <ConfirmDialog
          title={`Move to ${group.targetFolderKey}?`}
          confirmLabel={`Move ${selectedCount} ${selectedCount === 1 ? "file" : "files"}`}
          message={
            <>
              <p style={{ margin: "0 0 10px 0" }}>
                {selectedCount} {selectedCount === 1 ? "file" : "files"} ({formatBytes(selectedBytes)}) will be moved into:
              </p>
              <code style={{ display: "block", fontSize: 11, color: "var(--text-secondary)", wordBreak: "break-all" }}>{targetFolder}</code>
            </>
          }
          onConfirm={doMove}
          onCancel={() => setPendingAction(null)}
        />
      )}
      {pendingAction === "emptyRecycleBin" && (
        <ConfirmDialog
          title="Empty the Recycle Bin?"
          variant="danger"
          confirmLabel="Empty Recycle Bin"
          message={
            <>
              <p style={{ margin: "0 0 10px 0" }}>
                This will <strong>permanently delete</strong> every item in the Recycle Bin.
              </p>
              <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 12 }}>
                Unlike "Send to Recycle Bin", this step is not reversible — the files are gone for good.
              </p>
            </>
          }
          onConfirm={doEmptyRecycleBin}
          onCancel={() => setPendingAction(null)}
        />
      )}
      {pendingAction === "duplicates" && (
        <ConfirmDialog
          title="Recycle duplicate copies?"
          variant="danger"
          confirmLabel={`Recycle ${duplicateRecyclePaths.length} ${duplicateRecyclePaths.length === 1 ? "copy" : "copies"}`}
          message={
            <>
              <p style={{ margin: "0 0 10px 0" }}>
                {duplicateRecyclePaths.length} non-keeper {duplicateRecyclePaths.length === 1 ? "copy" : "copies"}
                {" "}({formatBytes(duplicateReclaimBytes)}) will be sent to the Recycle Bin.
                Your chosen keeper stays untouched.
              </p>
              <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 12 }}>
                Nothing is permanently deleted — you can restore any file from the Recycle Bin.
              </p>
            </>
          }
          onConfirm={doDuplicateRecycle}
          onCancel={() => setPendingAction(null)}
        />
      )}
    </div>
  );
}

/** Best-effort conversion of a thrown value or Rust error string into a
 *  friendlier message for the UI. Keeps the technical details available in
 *  a `details` suffix for debugging. */
function friendlyError(e: unknown): string {
  const raw = String(e);
  if (raw.includes("Access is denied")) return "Windows blocked the change (permission denied). Try running as administrator.";
  if (raw.includes("being used by another process")) return "A file is open in another app — close it and try again.";
  if (raw.includes("not found")) return "That file no longer exists. It may have been moved or deleted already.";
  return `Something went wrong. ${raw}`;
}

function SuggestionRow({
  s, onActionDone, onDismiss,
}: {
  s: SubfolderSuggestion;
  onActionDone?: () => void;
  onDismiss?: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [actionResult, setActionResult] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<"create" | "create-move" | "move" | null>(null);

  // "Create folder" = creates parentPath\suggestedName
  const folderToCreate = s.parentPath ? `${s.parentPath.replace(/\\$/, "")}\\${s.suggestedName}` : "";
  // "Consolidate" suggestions target a folder the user already has (repos or
  // a creative home like "Blender"/"Photos"), so the UI should offer "Move
  // items" instead of "Create folder".
  const isConsolidate = s.id === "consolidate-repos" || s.id.startsWith("consolidate-creative-");
  const hasRelated = s.relatedItems.length > 0;
  const movePaths = s.relatedItems.filter((it) => it.path).map((it) => it.path!);

  const doCreateFolder = async () => {
    setPendingAction(null);
    if (busy || !folderToCreate) return;
    setBusy(true); setActionResult(null);
    try {
      await createFolder(folderToCreate);
      setActionResult("Folder created");
      onActionDone?.();
    } catch (e) { setActionResult(friendlyError(e)); }
    finally { setBusy(false); }
  };

  const doCreateAndMove = async () => {
    setPendingAction(null);
    if (busy || !folderToCreate || movePaths.length === 0) return;
    setBusy(true); setActionResult(null);
    try {
      if (!isConsolidate) await createFolder(folderToCreate);
      const r = await moveItemsToFolder(movePaths, isConsolidate ? s.parentPath : folderToCreate);
      const parts: string[] = [];
      if (r.moved > 0) parts.push(`${r.moved} moved`);
      if (r.skipped.length > 0) parts.push(`${r.skipped.length} skipped (already there)`);
      if (r.errors.length > 0) parts.push(`${r.errors.length} couldn't be moved`);
      setActionResult(parts.join(" · ") || "Done");
      if (r.moved > 0) onActionDone?.();
    } catch (e) { setActionResult(friendlyError(e)); }
    finally { setBusy(false); }
  };

  const doMoveOnly = async () => {
    setPendingAction(null);
    if (busy || movePaths.length === 0) return;
    setBusy(true); setActionResult(null);
    try {
      const r = await moveItemsToFolder(movePaths, s.parentPath);
      const parts: string[] = [];
      if (r.moved > 0) parts.push(`${r.moved} moved`);
      if (r.skipped.length > 0) parts.push(`${r.skipped.length} skipped (already there)`);
      if (r.errors.length > 0) parts.push(`${r.errors.length} couldn't be moved`);
      setActionResult(parts.join(" · ") || "Done");
      if (r.moved > 0) onActionDone?.();
    } catch (e) { setActionResult(friendlyError(e)); }
    finally { setBusy(false); }
  };

  const primaryHandler: () => void =
    isConsolidate && movePaths.length > 0
      ? () => setPendingAction("move")
      : hasRelated && movePaths.length > 0
      ? () => setPendingAction("create-move")
      : () => setPendingAction("create");
  const primaryLabel =
    busy ? "Working…"
    : isConsolidate && movePaths.length > 0 ? `Move ${movePaths.length} ${movePaths.length === 1 ? "item" : "items"}`
    : hasRelated && movePaths.length > 0 ? "Create folder & move"
    : "Create folder";

  return (
    <div className="suggestion-item">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="suggestion-icon">
        <path d="M9 18h6 M10 22h4 M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z" />
      </svg>
      <div className="suggestion-text">
        <div className="suggestion-title">
          {isConsolidate
            ? <>Move into <strong>"{s.suggestedName}"</strong></>
            : <>Create a <strong>"{s.suggestedName}"</strong> folder</>}
        </div>
        <div className="suggestion-reason">{s.reason}</div>
        {hasRelated && (
          <div className="suggestion-related">
            {s.relatedItems.slice(0, 6).map((it, i) => (
              <span key={`${it.label}-${i}`} className="suggestion-related-chip" title={it.path ?? it.label}>
                {it.label}{it.detail ? ` (${it.detail})` : ""}
              </span>
            ))}
            {s.relatedItems.length > 6 && (
              <span className="suggestion-related-chip">+{s.relatedItems.length - 6} more</span>
            )}
          </div>
        )}
        {actionResult && (
          <div className="suggestion-action-result">{actionResult}</div>
        )}
      </div>
      <div className="suggestion-actions">
        {s.parentPath && (
          <button className="btn-sm" onClick={() => revealInExplorer(s.parentPath).catch(() => { })} title="Open this folder in File Explorer">
            Open
          </button>
        )}
        {(folderToCreate || (isConsolidate && movePaths.length > 0)) && (
          <button className="btn-sm btn-accent" onClick={primaryHandler} disabled={busy} title={primaryLabel}>
            {primaryLabel}
          </button>
        )}
        {onDismiss && (
          <button
            className="btn-icon suggestion-dismiss"
            onClick={() => onDismiss(s.id)}
            title="Hide this suggestion"
            aria-label="Hide this suggestion"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
      {pendingAction === "create" && (
        <ConfirmDialog
          title="Create folder?"
          confirmLabel="Create"
          message={
            <>
              <p style={{ margin: "0 0 10px 0" }}>A new folder will be created at:</p>
              <code style={{ display: "block", fontSize: 11, color: "var(--text-secondary)", wordBreak: "break-all" }}>{folderToCreate}</code>
            </>
          }
          onConfirm={doCreateFolder}
          onCancel={() => setPendingAction(null)}
        />
      )}
      {pendingAction === "create-move" && (
        <ConfirmDialog
          title={`Create "${s.suggestedName}" and move items?`}
          confirmLabel={`Create & move ${movePaths.length}`}
          message={
            <>
              <p style={{ margin: "0 0 10px 0" }}>
                A new folder will be created, then {movePaths.length} {movePaths.length === 1 ? "item" : "items"} will be moved into it.
              </p>
              <code style={{ display: "block", fontSize: 11, color: "var(--text-secondary)", wordBreak: "break-all" }}>{folderToCreate}</code>
              <p style={{ margin: "10px 0 0 0", color: "var(--text-muted)", fontSize: 12 }}>
                You can undo this by moving items back in File Explorer.
              </p>
            </>
          }
          onConfirm={doCreateAndMove}
          onCancel={() => setPendingAction(null)}
        />
      )}
      {pendingAction === "move" && (
        <ConfirmDialog
          title={`Move into "${s.suggestedName}"?`}
          confirmLabel={`Move ${movePaths.length}`}
          message={
            <>
              <p style={{ margin: "0 0 10px 0" }}>
                {movePaths.length} {movePaths.length === 1 ? "item" : "items"} will be moved into:
              </p>
              <code style={{ display: "block", fontSize: 11, color: "var(--text-secondary)", wordBreak: "break-all" }}>{s.parentPath}</code>
            </>
          }
          onConfirm={doMoveOnly}
          onCancel={() => setPendingAction(null)}
        />
      )}
    </div>
  );
}

/**
 * Runs one full organizer scan. Each user folder's file-type classification +
 * creative-file enumeration is paired into a single "unit" that emits a
 * partial-cache snapshot via `onPartial` the moment it completes — so the
 * panel can render compositions, findings, and creative-file contributions
 * one folder at a time instead of waiting for all six to land. The final
 * (non-partial) cache is written to localStorage and returned.
 */
async function performOrganizerScan(
  onProgress?: (label: string) => void,
  onPartial?: (cache: OrganizerCache) => void,
): Promise<OrganizerCache> {
  const folders = await getUserFolders();

  // Each scanned user folder is a labeled unit: scanFileTypes (composition
  // + findings) and listFilesByExtensions (creative-file enumeration) run
  // together so the unit lands as an atomic UI update.
  const unitPlan: { path: string; label: string }[] = [];
  if (folders.documents) unitPlan.push({ path: folders.documents, label: "Documents" });
  if (folders.downloads) unitPlan.push({ path: folders.downloads, label: "Downloads" });
  if (folders.desktop)   unitPlan.push({ path: folders.desktop,   label: "Desktop"   });
  if (folders.pictures)  unitPlan.push({ path: folders.pictures,  label: "Pictures"  });
  if (folders.videos)    unitPlan.push({ path: folders.videos,    label: "Videos"    });
  if (folders.music)     unitPlan.push({ path: folders.music,     label: "Music"     });

  // Mutable accumulator — every unit mutates this, then we clone into the
  // partial-callback so React sees stable new references per notification.
  // History from the *previous* scan is carried over; this scan appends to
  // it at completion time.
  const priorCache = loadOrganizerCache();
  const accumulator: OrganizerCache = {
    version: ORGANIZER_CACHE_VERSION,
    ts: Date.now(),
    stats: [],
    projects: [],
    subfolderPaths: [],
    creativeFiles: [],
    folderTimestamps: {},
    partial: true,
    buildArtifacts: [],
    duplicates: [],
    largeFiles: [],
    logTempFiles: [],
    recycleBinSize: 0,
    installedApps: [],
    history: priorCache?.history ?? [],
  };

  const activeFolderNames = new Set<string>();
  const emitProgress = () => {
    if (!onProgress) return;
    if (activeFolderNames.size === 0) {
      onProgress("Almost done…");
    } else {
      const names = [...activeFolderNames];
      const shown = names.slice(0, 3).join(", ");
      const more = names.length > 3 ? ` +${names.length - 3}` : "";
      onProgress(`Scanning ${shown}${more}…`);
    }
  };
  const emitPartial = () => {
    if (!onPartial) return;
    // Shallow-clone the mutable arrays/objects so the panel's useMemo chain
    // correctly re-runs — without the clones, identity-equality skips the
    // re-analysis.
    onPartial({
      ...accumulator,
      stats: [...accumulator.stats],
      projects: [...accumulator.projects],
      subfolderPaths: [...accumulator.subfolderPaths],
      creativeFiles: [...accumulator.creativeFiles],
      folderTimestamps: { ...(accumulator.folderTimestamps ?? {}) },
      buildArtifacts: [...(accumulator.buildArtifacts ?? [])],
      duplicates: [...(accumulator.duplicates ?? [])],
      largeFiles: [...(accumulator.largeFiles ?? [])],
      logTempFiles: [...(accumulator.logTempFiles ?? [])],
      installedApps: [...(accumulator.installedApps ?? [])],
      history: [...(accumulator.history ?? [])],
    });
  };

  const folderUnits = unitPlan.map(async ({ path, label }) => {
    activeFolderNames.add(label);
    emitProgress();
    try {
      // Per-folder work is bundled so one folder lands atomically in the UI:
      //   fileTypeRes  — category rollup (stacked bar + findings).
      //   creativeRes  — creative-workflow files (Blender/Premiere/FL/etc).
      //   logTempRes   — log/tmp/dmp/etl/.old pileups (→ detectLogAndTempFiles).
      //   allFilesRes  — unfiltered top-sized files (→ detectLargeFiles after
      //                  a ≥ LARGE_FILE_MIN_BYTES JS-side filter).
      const [fileTypeRes, creativeRes, logTempRes, allFilesRes] = await Promise.allSettled([
        scanFileTypes(path),
        listFilesByExtensions(path, ALL_CREATIVE_EXTENSIONS, 2, 200),
        listFilesByExtensions(path, [".log", ".tmp", ".etl", ".dmp", ".old"], 3, 200),
        listFilesByExtensions(path, [], 2, 60),
      ]);
      // Diagnostic: log per-folder scan outcomes so we can tell why a folder
      // might not appear in the UI (fulfilled-but-empty vs. rejected vs. OK).
      const fileTypeCount = fileTypeRes.status === "fulfilled" ? fileTypeRes.value.length : -1;
      const creativeCount = creativeRes.status === "fulfilled" ? creativeRes.value.length : -1;
      console.log(
        `[organizer-scan] ${label}: file-type ${fileTypeRes.status} (${fileTypeCount}), ` +
        `creative ${creativeRes.status} (${creativeCount})`,
      );
      if (fileTypeRes.status === "rejected") {
        console.warn(`[organizer-scan] ${label} file-type error:`, fileTypeRes.reason);
      }
      if (creativeRes.status === "rejected") {
        console.warn(`[organizer-scan] ${label} creative error:`, creativeRes.reason);
      }
      if (fileTypeRes.status === "fulfilled") {
        accumulator.stats.push(...fileTypeRes.value);
      }
      if (creativeRes.status === "fulfilled") {
        for (const f of creativeRes.value) {
          const dotIdx = f.path.lastIndexOf(".");
          const ext = dotIdx >= 0 ? f.path.slice(dotIdx).toLowerCase() : "";
          if (!ext) continue;
          accumulator.creativeFiles.push({
            path: f.path, ext, size_bytes: f.size_bytes, parent_folder: label,
          });
        }
      }
      // Log / temp / dump files — normalise extension, store with parent label.
      if (logTempRes.status === "fulfilled") {
        for (const f of logTempRes.value) {
          const dotIdx = f.path.lastIndexOf(".");
          const ext = dotIdx >= 0 ? f.path.slice(dotIdx).toLowerCase() : "";
          if (!ext) continue;
          accumulator.logTempFiles!.push({
            path: f.path,
            size_bytes: f.size_bytes,
            modified_ts: f.modified_ts,
            ext,
            parent_folder: label,
          });
        }
      }
      // Large lone files — keep anything ≥ 500 MB here (detectLargeFiles raises
      // the real threshold to 1 GB, but retaining 500 MB+ files in the cache
      // gives headroom for future threshold tweaks without a rescan).
      if (allFilesRes.status === "fulfilled") {
        for (const f of allFilesRes.value) {
          if (f.size_bytes < 500 * 1024 * 1024) continue;
          accumulator.largeFiles!.push({
            path: f.path,
            size_bytes: f.size_bytes,
            modified_ts: f.modified_ts,
            parent_folder: label,
          });
        }
      }
      if (!accumulator.folderTimestamps) accumulator.folderTimestamps = {};
      accumulator.folderTimestamps[path] = Date.now();
      // Persist partial progress to localStorage so closing the app mid-scan
      // doesn't discard the folders we've already walked.
      saveOrganizerCache(accumulator);
      emitPartial();
    } finally {
      activeFolderNames.delete(label);
      emitProgress();
    }
  });

  // Project detection + top-folder enumeration + path-exists probes. These
  // are cheap relative to the per-folder scans and don't benefit from
  // per-folder streaming, so we bundle them into one structural pass.
  const codeHomeNames = ["GitHub", "Projects", "Repos", "Repositories", "GitLab", "Bitbucket", "Workspace", "Dev", "Code"];
  const structural = (async () => {
    const [
      projectsRaw,
      homeTopFoldersRaw,
      picturesTopFoldersRaw,
      codeHomeProbesRaw,
      screenshotsProbeRaw,
    ] = await Promise.all([
      detectProjects(folders.home).catch(() => [] as DetectedProject[]),
      folders.home
        ? getTopFolders(folders.home, 40).catch(() => [])
        : Promise.resolve([]),
      folders.pictures
        ? getTopFolders(folders.pictures, 20).catch(() => [])
        : Promise.resolve([]),
      folders.home
        ? Promise.allSettled(
            codeHomeNames.map(async (name) => {
              const p = `${folders.home.replace(/\\$/, "")}\\${name}`;
              const exists = await checkPathExists(p).catch(() => false);
              return { path: p, exists };
            }),
          )
        : Promise.resolve([] as PromiseSettledResult<{ path: string; exists: boolean }>[]),
      folders.pictures
        ? checkPathExists(`${folders.pictures.replace(/\\$/, "")}\\Screenshots`).catch(() => false)
        : Promise.resolve(false),
    ]);

    accumulator.projects = projectsRaw;

    const subfolderPaths: string[] = [];
    for (const f of homeTopFoldersRaw) if (f.path) subfolderPaths.push(f.path);
    for (const f of picturesTopFoldersRaw) if (f.path) subfolderPaths.push(f.path);
    for (const r of codeHomeProbesRaw) {
      if (r.status !== "fulfilled") continue;
      const { path, exists } = r.value;
      if (exists && !subfolderPaths.some((sp) => sp.toLowerCase() === path.toLowerCase())) {
        subfolderPaths.push(path);
      }
    }
    if (screenshotsProbeRaw && folders.pictures) {
      const ssPath = `${folders.pictures.replace(/\\$/, "")}\\Screenshots`;
      if (!subfolderPaths.some((sp) => sp.toLowerCase() === ssPath.toLowerCase())) {
        subfolderPaths.push(ssPath);
      }
    }
    accumulator.subfolderPaths = subfolderPaths;
    emitPartial();
  })();

  await Promise.all([...folderUnits, structural]);

  // ─── Tier 2 — build artifacts, duplicates, recycle bin, installed apps ──
  //
  // These depend on state populated by the two phases above (we need the list
  // of detected project roots to scan for build artifacts, and the enumerated
  // large/creative files form the candidate pool for duplicate hashing). We
  // run them after the fact rather than inline with the per-folder units so
  // the first partial snapshots can paint without waiting on hashing.
  activeFolderNames.add("Projects");
  emitProgress();
  try {
    const projectPaths = accumulator.projects.map((p) => p.path);
    // Duplicate candidates — everything large-enough to be worth hashing.
    // 10 MB minimum matches `find_duplicate_files`' default backend floor.
    const dupCandidates: string[] = [];
    const seen = new Set<string>();
    const pushOnce = (p: string) => {
      const key = p.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      dupCandidates.push(p);
    };
    for (const f of accumulator.largeFiles ?? []) pushOnce(f.path);
    for (const f of accumulator.creativeFiles ?? []) if (f.size_bytes >= 10 * 1024 * 1024) pushOnce(f.path);

    const [buildArtsRes, dupGroupsRes, recycleSizeRes, installedAppsRes] = await Promise.allSettled([
      projectPaths.length > 0
        ? scanBuildArtifacts(projectPaths)
        : Promise.resolve([] as BuildArtifact[]),
      dupCandidates.length >= 2
        ? findDuplicateFiles(dupCandidates, 10 * 1024 * 1024)
        : Promise.resolve([] as DuplicateGroup[]),
      getRecycleBinSize(),
      getInstalledApps(),
    ]);

    if (buildArtsRes.status === "fulfilled") {
      accumulator.buildArtifacts = buildArtsRes.value;
    } else {
      console.warn("[organizer-scan] scan_build_artifacts failed:", buildArtsRes.reason);
    }
    if (dupGroupsRes.status === "fulfilled") {
      accumulator.duplicates = dupGroupsRes.value;
    } else {
      console.warn("[organizer-scan] find_duplicate_files failed:", dupGroupsRes.reason);
    }
    if (recycleSizeRes.status === "fulfilled") {
      accumulator.recycleBinSize = recycleSizeRes.value;
    }
    if (installedAppsRes.status === "fulfilled") {
      accumulator.installedApps = installedAppsRes.value;
    }
    emitPartial();
  } finally {
    activeFolderNames.delete("Projects");
    emitProgress();
  }

  // ─── History — append a compact snapshot for time-series growth ─────────
  // Per-user-folder byte totals only (tiny payload). We cap retention at
  // ORGANIZER_HISTORY_MAX to bound localStorage size.
  const folderTotals: HistorySnapshot["folderTotals"] = {};
  const userFolderLeaves = ["Documents", "Downloads", "Desktop", "Pictures", "Videos", "Music"] as const;
  type Leaf = typeof userFolderLeaves[number];
  for (const s of accumulator.stats) {
    const leaf = (s.folder_path.replace(/\\+$/, "").split("\\").pop() ?? "") as Leaf;
    if (!userFolderLeaves.includes(leaf)) continue;
    folderTotals[leaf] = (folderTotals[leaf] ?? 0) + s.total_bytes;
  }
  const nextHistory = [...(accumulator.history ?? []), { ts: Date.now(), folderTotals }];
  // Drop oldest entries over the cap. Also drop any >180 days old — stale
  // samples hurt the growth detector more than they help.
  const cutoff = Date.now() - 180 * 86_400_000;
  accumulator.history = nextHistory
    .filter((h) => h.ts >= cutoff)
    .slice(-ORGANIZER_HISTORY_MAX);

  accumulator.partial = false;
  accumulator.ts = Date.now();
  // Count unique folder_paths in the final stats — useful for diagnosing
  // "only one folder showed up" reports without needing a debugger.
  const uniqueFolders = new Set(accumulator.stats.map((s) => s.folder_path));
  console.log(
    `[organizer-scan] DONE — stats=${accumulator.stats.length} ` +
    `(${uniqueFolders.size} unique folders), creative=${accumulator.creativeFiles.length}, ` +
    `projects=${accumulator.projects.length}`,
  );
  saveOrganizerCache(accumulator);
  return accumulator;
}

/**
 * Re-scans a single user folder (scanFileTypes + creative-file enumeration)
 * and merges the fresh results into `currentCache`. Used by the per-row
 * refresh button — avoids the 30–60s wait of a full rescan when the user
 * just wants to confirm their Downloads cleanup registered.
 */
async function refreshSingleFolder(
  currentCache: OrganizerCache,
  folderPath: string,
  label: string,
): Promise<OrganizerCache> {
  const [fileTypeRes, creativeRes] = await Promise.allSettled([
    scanFileTypes(folderPath),
    listFilesByExtensions(folderPath, ALL_CREATIVE_EXTENSIONS, 2, 200),
  ]);

  const pathLower = folderPath.toLowerCase();
  // FileTypeStat entries are emitted one per category per folder, so there
  // can be several rows tagged with the same folder_path. Drop them all
  // before re-inserting the new set.
  const keptStats = currentCache.stats.filter(
    (s) => (s.folder_path ?? "").toLowerCase() !== pathLower,
  );
  if (fileTypeRes.status === "fulfilled") keptStats.push(...fileTypeRes.value);

  // CreativeFileRecord.parent_folder is the label ("Downloads", etc.), which
  // is stable across scans.
  const keptCreative = currentCache.creativeFiles.filter((c) => c.parent_folder !== label);
  if (creativeRes.status === "fulfilled") {
    for (const f of creativeRes.value) {
      const dotIdx = f.path.lastIndexOf(".");
      const ext = dotIdx >= 0 ? f.path.slice(dotIdx).toLowerCase() : "";
      if (!ext) continue;
      keptCreative.push({ path: f.path, ext, size_bytes: f.size_bytes, parent_folder: label });
    }
  }

  const next: OrganizerCache = {
    ...currentCache,
    ts: Date.now(),
    stats: keptStats,
    creativeFiles: keptCreative,
    folderTimestamps: {
      ...(currentCache.folderTimestamps ?? {}),
      [folderPath]: Date.now(),
    },
    partial: false,
  };
  saveOrganizerCache(next);
  return next;
}

// ─── IntentChips: row of exclusive filter chips above the findings list ────
interface IntentChipsProps {
  intent: Intent;
  onChange: (next: Intent) => void;
  /** Live count per intent — shown next to each chip label as "Reclaim · 4". */
  counts: Record<Intent, number>;
  /** When true, chips are visually muted because the free-up-X target mode
   *  is active and overrides chip filtering. Clicking a chip exits target
   *  mode (handled by parent via onChange). */
  muted: boolean;
}

function IntentChips({ intent, onChange, counts, muted }: IntentChipsProps) {
  return (
    <div className={`org-chip-row ${muted ? "is-muted" : ""}`} role="tablist" aria-label="Filter findings by intent">
      {ALL_INTENTS.map((key) => {
        const active = !muted && intent === key;
        const count = counts[key];
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={active}
            className={`org-chip ${active ? "is-active" : ""}`}
            onClick={() => onChange(key)}
            title={key === "all" ? "Show every finding" : `Show only ${INTENT_LABEL[key].toLowerCase()} findings`}
          >
            <span className="org-chip-label">{INTENT_LABEL[key]}</span>
            <span className="org-chip-count">· {count}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── TargetMode: free-up-X presets, progress bar, banner ───────────────────
interface TargetModeProps {
  active: boolean;
  targetGB: number;
  onActivate: (gb: number) => void;
  onExit: () => void;
  /** Picker output — null when target mode is inactive. */
  tier: TierResult | null;
  /** Bytes already counted toward target (sum of reclaimableBytes for the
   *  currently-shown findings — i.e. what the user "would clear if they
   *  acted on these"). */
  cumulativeBytes: number;
  /** Total potential reclaim across every finding. Shown as a big anchor
   *  number when target mode is inactive ("up to ~120 GB available"). */
  potentialReclaimBytes: number;
  /** Drive-aware advisory: surfaces "move to D:" or "consider an external
   *  drive" when the target is a serious chunk of the system drive. */
  advisory: DriveAdvisory;
}

const TARGET_PRESETS = [1, 5, 20, 50];

function TargetMode({
  active, targetGB, onActivate, onExit, tier,
  cumulativeBytes, potentialReclaimBytes, advisory,
}: TargetModeProps) {
  const [customDraft, setCustomDraft] = useState<string>("");
  const targetBytes = targetGB * 1024 ** 3;
  const pct = active && targetBytes > 0 ? Math.min(100, (cumulativeBytes / targetBytes) * 100) : 0;
  const hit = active && cumulativeBytes >= targetBytes && tier?.reachable;

  // Substitution helper. {X} = requested target, {Y} = actual maximum we
  // could free across everything we found.
  const renderBanner = (template: string): string =>
    template
      .replace("{X}", formatBytes(targetBytes))
      .replace("{Y}", formatBytes(tier?.pickedTotal ?? 0));

  return (
    <section
      className={`org-freeup ${active ? "is-active" : ""}`}
      aria-label="Free up space"
    >
      {/* Headline — the whole reason this section exists. Big enough to
          read across the room; the preset buttons sit right below. */}
      <header className="org-freeup-head">
        <div className="org-freeup-title-block">
          <h4 className="org-freeup-title">Free up space</h4>
          <p className="org-freeup-sub">
            {active
              ? <>Aiming to free <strong>{formatBytes(targetBytes)}</strong>.</>
              : potentialReclaimBytes > 0
                ? <>Up to <strong>{formatBytes(potentialReclaimBytes)}</strong> available across what we found. Pick a target to plan a cleanup.</>
                : <>Pick a target and we&rsquo;ll plan the cleanup that reaches it.</>}
          </p>
        </div>
        {active && (
          <button type="button" className="btn-link org-freeup-exit" onClick={onExit}>
            Exit
          </button>
        )}
      </header>

      <div className="org-freeup-presets" role="group" aria-label="Target size">
        {TARGET_PRESETS.map((gb) => (
          <button
            key={gb}
            type="button"
            className={`org-freeup-preset ${active && targetGB === gb ? "is-active" : ""}`}
            onClick={() => onActivate(gb)}
          >
            {gb} GB
          </button>
        ))}
        <div className="org-freeup-custom">
          <input
            type="number"
            min={1}
            max={4096}
            step={1}
            placeholder="custom"
            value={customDraft}
            onChange={(e) => setCustomDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const n = parseFloat(customDraft);
                if (Number.isFinite(n) && n > 0) onActivate(n);
              }
            }}
            aria-label="Custom target in GB"
          />
          <span className="org-freeup-custom-unit">GB</span>
          <button
            type="button"
            className="btn-sm"
            onClick={() => {
              const n = parseFloat(customDraft);
              if (Number.isFinite(n) && n > 0) onActivate(n);
            }}
            disabled={!customDraft || !Number.isFinite(parseFloat(customDraft)) || parseFloat(customDraft) <= 0}
          >
            Plan
          </button>
        </div>
      </div>

      {active && tier && (
        <>
          {/* Drive-aware advisory comes first — if the user can sidestep the
              whole cleanup by moving files to another drive, we want them to
              see that before grinding through individual findings. */}
          {advisory.kind === "shift" && (
            <div className="org-freeup-advisory advisory-shift" role="status">
              <strong>{formatBytes(targetBytes)} is over half of {advisory.systemLetter}:.</strong>{" "}
              You already have {advisory.candidates.length === 1 ? "another drive" : "other drives"} connected — moving large files there is faster than cleaning up:
              <ul className="org-freeup-drive-list">
                {advisory.candidates.map((d) => (
                  <li key={d.letter}>
                    <strong>{d.letter}:</strong> {d.label} — {formatBytes(d.freeBytes)} free
                  </li>
                ))}
              </ul>
            </div>
          )}
          {advisory.kind === "external" && (
            <div className="org-freeup-advisory advisory-external" role="status">
              <strong>{formatBytes(targetBytes)} is over half of your {advisory.systemLetter}: drive.</strong>{" "}
              An external drive is usually a better fix than deleting that much — even a $50 portable SSD will hold {formatBytes(targetBytes)} comfortably.
            </div>
          )}

          <div className={`org-freeup-progress ${hit ? "is-hit" : ""}`}>
            <div className="org-freeup-progress-text">
              <span>
                Cleared so far if you act on these:{" "}
                <strong>{formatBytes(cumulativeBytes)}</strong> / {formatBytes(targetBytes)}
              </span>
              {hit && (
                <span className="org-freeup-hit-pill" title="Target reachable">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                  Target reachable
                </span>
              )}
            </div>
            <div className="org-freeup-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
              <div className="org-freeup-bar-fill" style={{ width: `${pct}%` }} />
            </div>
          </div>

          <p className={`org-freeup-banner banner-${tier.bannerVariant}`} role="status">
            {renderBanner(tier.banner)}
          </p>
        </>
      )}
    </section>
  );
}

interface SmartOrganizerPanelProps {
  rescanSignal: number;
  onUserRescan: () => void;
  /** Data needed for the merged recommendations section. */
  volumes: StorageVolumeInfo[];
  recycleBinSize: number;
  folders: StorageFolderInfo[];
  apps: InstalledAppInfo[];
}

function SmartOrganizerPanel({ rescanSignal, onUserRescan, volumes, recycleBinSize, folders: pageTopFolders, apps }: SmartOrganizerPanelProps) {
  const [cache, setCache] = useState<OrganizerCache | null>(() => loadOrganizerCache());
  const [scanning, setScanning] = useState(false);
  const [scanStatus, setScanStatus] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [userFolders, setUserFolders] = useState<Record<string, string>>({});
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => loadDismissedIds());
  const [showDismissed, setShowDismissed] = useState(false);
  // Intent chip filter — persisted across reloads so the panel reopens in
  // the user's last view. Default "all" preserves existing 6-cap behaviour.
  const [intent, setIntentState] = useState<Intent>(() => loadIntent());
  const setIntent = useCallback((next: Intent) => {
    setIntentState(next);
    saveIntent(next);
  }, []);
  // Free-up-X target mode. Last X is persisted, but target mode itself is
  // NOT auto-activated on next visit — the user has to click a preset.
  const [targetActive, setTargetActive] = useState(false);
  const [targetGB, setTargetGBState] = useState<number>(() => loadTargetGB());
  const activateTarget = useCallback((gb: number) => {
    setTargetGBState(gb);
    saveTargetGB(gb);
    setTargetActive(true);
  }, []);
  const exitTarget = useCallback(() => setTargetActive(false), []);
  // Paths currently being re-scanned via the per-row ↻ button. Used to
  // disable the button + show a spinning state. Keyed by absolute folder
  // path (same key as `folderTimestamps`).
  const [refreshingFolders, setRefreshingFolders] = useState<Set<string>>(new Set());

  const dismiss = useCallback((id: string) => {
    setDismissedIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      saveDismissedIds(next);
      return next;
    });
  }, []);
  const restoreAll = useCallback(() => {
    setDismissedIds(new Set());
    saveDismissedIds(new Set());
    setShowDismissed(false);
  }, []);

  // Load user folder paths on mount for FindingRow move targets
  useEffect(() => {
    getUserFolders().then((f) => setUserFolders({
      videos: f.videos, music: f.music, pictures: f.pictures,
      documents: f.documents, downloads: f.downloads, desktop: f.desktop,
    })).catch(() => {});
  }, []);

  // Idle detection bookkeeping — counts consecutive low-CPU samples.
  const idleSamplesRef = useRef(0);
  const mountTimeRef = useRef(Date.now());
  // Track the last rescanSignal we reacted to so we can distinguish "new
  // external trigger" from "initial mount" without firing a duplicate scan.
  const lastSignalRef = useRef(rescanSignal);

  const runScan = useCallback(async () => {
    if (scanning) return;
    setScanning(true);
    setScanStatus("Starting scan…");
    setError(null);
    try {
      // Stream partial snapshots into `cache` as each folder finishes so the
      // panel fills in progressively rather than appearing all-at-once.
      let partialCount = 0;
      const next = await performOrganizerScan(setScanStatus, (partial) => {
        partialCount++;
        const uniq = new Set(partial.stats.map((s) => s.folder_path)).size;
        console.log(
          `[organizer-scan] partial #${partialCount}: stats=${partial.stats.length} ` +
          `(${uniq} folders), creative=${partial.creativeFiles.length}`,
        );
        setCache(partial);
      });
      console.log(
        `[organizer-scan] setCache(final): stats=${next.stats.length}, creative=${next.creativeFiles.length}`,
      );
      // Force a fresh top-level reference + cloned arrays so React can't bail
      // on shallow-equal state with the last partial snapshot.
      setCache({
        ...next,
        stats: [...next.stats],
        projects: [...next.projects],
        subfolderPaths: [...next.subfolderPaths],
        creativeFiles: [...next.creativeFiles],
        folderTimestamps: { ...(next.folderTimestamps ?? {}) },
        buildArtifacts: [...(next.buildArtifacts ?? [])],
        duplicates: [...(next.duplicates ?? [])],
        largeFiles: [...(next.largeFiles ?? [])],
        logTempFiles: [...(next.logTempFiles ?? [])],
        installedApps: [...(next.installedApps ?? [])],
        history: [...(next.history ?? [])],
      });
    } catch (e) {
      console.error("[organizer-scan] runScan error:", e);
      setError(String(e));
    } finally {
      setScanning(false);
      setScanStatus("");
    }
  }, [scanning]);

  /** Per-row refresh: re-scan a single user folder and merge results into
   *  the cache without touching the other folders. Much faster than a full
   *  rescan for the "I just cleaned Downloads, verify" workflow. */
  const refreshOne = useCallback(async (folderPath: string, label: string) => {
    // Guard against double-clicks and overlapping full rescans.
    if (!cache || refreshingFolders.has(folderPath) || scanning) return;
    setRefreshingFolders((prev) => {
      const next = new Set(prev);
      next.add(folderPath);
      return next;
    });
    try {
      const next = await refreshSingleFolder(cache, folderPath, label);
      setCache(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setRefreshingFolders((prev) => {
        const next = new Set(prev);
        next.delete(folderPath);
        return next;
      });
    }
  }, [cache, refreshingFolders, scanning]);

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
    return runOrganizerAnalysis(
      cache.stats,
      cache.projects,
      cache.subfolderPaths ?? [],
      cache.creativeFiles ?? [],
      {
        buildArtifacts: cache.buildArtifacts ?? [],
        duplicates: cache.duplicates ?? [],
        largeFiles: cache.largeFiles ?? [],
        logTempFiles: cache.logTempFiles ?? [],
        recycleBinSize: cache.recycleBinSize ?? 0,
        installedApps: cache.installedApps ?? [],
        history: cache.history ?? [],
      },
    );
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
  const isStale = !!cache && scanAge > ORGANIZER_MAX_AGE_MS;

  // ── Recommendations (folded into the unified Cleanup section below) ──
  const recs = useMemo(() => {
    const list: Recommendation[] = [];

    const bigApps = apps.filter((a) => a.size_bytes > 2 * 1024 ** 3).slice(0, 3);
    if (bigApps.length > 0) {
      const detail = bigApps.map((a) => `${a.name} (${formatBytes(a.size_bytes)})`).join(", ");
      list.push({
        id: "rec-big-apps",
        icon: "M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z",
        title: "Largest installed apps",
        detail: `These apps take up the most space: ${detail}. Uninstall any you no longer use.`,
        severity: "info",
        action: () => openWindowsSettingsUri("ms-settings:appsfeatures").catch(() => { }),
        actionLabel: "Open Apps & Features",
        bytesHint: bigApps.reduce((n, a) => n + a.size_bytes, 0),
      });
    }
    if (recycleBinSize > 500 * 1024 * 1024) {
      list.push({
        id: "rec-recycle-bin",
        icon: "M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6",
        title: `Your Recycle Bin is holding ${formatBytes(recycleBinSize)}`,
        detail: "Empty it to free that space right away.",
        severity: recycleBinSize > 2 * 1024 ** 3 ? "warning" : "info",
        bytesHint: recycleBinSize,
      });
    }
    const downloads = pageTopFolders.find((f) => (f.display_name.split("\\").pop() ?? "").toLowerCase() === "downloads");
    if (downloads && downloads.size_bytes > 5 * 1024 ** 3) {
      list.push({
        id: "rec-downloads-big",
        icon: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3",
        title: `Your Downloads folder has grown to ${formatBytes(downloads.size_bytes)}`,
        detail: `${downloads.file_count.toLocaleString()} files. Review and delete old installers, archives, and downloads you don't need.`,
        severity: downloads.size_bytes > 20 * 1024 ** 3 ? "warning" : "info",
        bytesHint: downloads.size_bytes,
      });
    }
    for (const f of pageTopFolders) {
      const name = f.display_name.toLowerCase();
      if ((name.includes("temp") || name.includes("cache") || name.includes("tmp")) && f.size_bytes > 1024 ** 3) {
        list.push({
          id: `rec-temp-${f.path.toLowerCase()}`,
          icon: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z",
          title: `${f.display_name} is using ${formatBytes(f.size_bytes)}`,
          detail: "Temporary and cache files are usually safe to clean up — Windows Storage Sense can handle this automatically.",
          severity: f.size_bytes > 5 * 1024 ** 3 ? "warning" : "info",
          action: () => openWindowsSettingsUri("ms-settings:storagesense").catch(() => { }),
          actionLabel: "Open Storage Sense",
          bytesHint: f.size_bytes,
        });
      }
    }
    for (const v of volumes) {
      const pct = v.total_bytes > 0 ? ((v.total_bytes - v.free_bytes) / v.total_bytes) * 100 : 0;
      const freeGB = v.free_bytes / (1024 ** 3);
      if (pct >= 95 || freeGB < 5) {
        const biggestFolder = pageTopFolders.length > 0 ? pageTopFolders[0] : null;
        const biggestApp = apps.length > 0 ? apps[0] : null;
        let hints = "";
        if (biggestFolder) hints += ` Largest folder: "${biggestFolder.display_name.split("\\").pop()}" (${formatBytes(biggestFolder.size_bytes)}).`;
        if (biggestApp && biggestApp.size_bytes > 0) hints += ` Largest app: "${biggestApp.name}" (${formatBytes(biggestApp.size_bytes)}).`;
        list.push({
          id: `rec-disk-full-${v.letter}`,
          icon: "M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z",
          title: `${v.letter}: is almost full — only ${formatBytes(v.free_bytes)} free`,
          detail: `Your computer may slow down or fail to update.${hints}`,
          severity: "critical",
          action: () => openWindowsSettingsUri("ms-settings:storagesense").catch(() => { }),
          actionLabel: "Open Storage Sense",
          bytesHint: v.total_bytes - v.free_bytes,
        });
      }
    }
    return list;
  }, [volumes, recycleBinSize, pageTopFolders, apps]);

  // ── Unified Cleanup list: findings (from the scan) + recommendations
  // (from drive / apps / recycle-bin heuristics), sorted so the most
  // impactful item appears first. Dismissed ids are filtered out but
  // kept in the total count so the user can restore them if they change
  // their mind.
  type CleanupItem =
    | { kind: "finding"; severity: "critical" | "warning" | "info"; bytes: number; id: string; finding: FindingGroup }
    | { kind: "rec"; severity: "critical" | "warning" | "info"; bytes: number; id: string; rec: Recommendation };

  const cleanupItems: CleanupItem[] = useMemo(() => {
    const list: CleanupItem[] = [];
    if (analysis) {
      for (const f of analysis.findings) {
        // FindingGroup severity is "warning" | "info" | "suggestion"; map
        // suggestion→info so they sort sensibly alongside recommendations.
        const sev: "critical" | "warning" | "info" =
          f.severity === "warning" ? "warning" : "info";
        list.push({ kind: "finding", severity: sev, bytes: f.reclaimableBytes, id: f.id, finding: f });
      }
    }
    for (const r of recs) {
      list.push({ kind: "rec", severity: r.severity, bytes: r.bytesHint, id: r.id, rec: r });
    }
    const weight = { critical: 3, warning: 2, info: 1 } as const;
    list.sort((a, b) => {
      const sw = weight[b.severity] - weight[a.severity];
      if (sw !== 0) return sw;
      return b.bytes - a.bytes;
    });
    return list;
  }, [analysis, recs]);

  // Live finding-only list (no recs) used by chip counts + tier picker.
  const allFindings: FindingGroup[] = useMemo(
    () => (analysis?.findings ?? []).filter((f) => !dismissedIds.has(f.id)),
    [analysis, dismissedIds],
  );

  // Live count per chip — shown next to each label as "Reclaim · 4". Counts
  // include only findings (recs aren't filtered by chips). All-chip counts
  // every visible finding regardless of tag.
  const intentCounts = useMemo<Record<Intent, number>>(() => {
    const counts: Record<Intent, number> = {
      all: allFindings.length,
      organize: 0, duplicates: 0, downloads: 0, old: 0, large: 0,
    };
    for (const f of allFindings) {
      const tags = f.tags ?? [];
      for (const k of ALL_INTENTS) {
        if (k === "all") continue;
        if (tags.includes(k)) counts[k] += 1;
      }
    }
    return counts;
  }, [allFindings]);

  // Tier picker output — only computed when target mode is active. Uses the
  // live (non-dismissed) findings so a dismissed item doesn't keep counting.
  const tierResult: TierResult | null = useMemo(() => {
    if (!targetActive) return null;
    const targetBytes = targetGB * 1024 ** 3;
    return pickTier(allFindings, targetBytes);
  }, [targetActive, targetGB, allFindings]);

  // Findings to actually render in the cleanup list. The decision tree:
  //   • target mode active → show non-app findings in the tier pool, plus
  //     a focused subset of app findings (picker's selection plus the
  //     closest-by-size alternatives). Capped at max(numPicked, 3) so the
  //     list isn't drowned by the 12-app candidate set the detector emits.
  //   • intent === "all"  → preserve the original 6-cap behaviour.
  //   • intent !== "all"  → filter by tag, slice to 6 (UI-side cap, per spec).
  const filteredFindings: FindingGroup[] = useMemo(() => {
    if (tierResult) {
      const targetBytes = targetGB * 1024 ** 3;
      const isApp = (f: FindingGroup) => (f.tags ?? []).includes("app");
      const nonApps = tierResult.pool.filter((f) => !isApp(f));
      const apps = tierResult.pool.filter(isApp);
      const pickedApps = apps.filter((f) => tierResult.pickedIds.has(f.id));

      // No apps in the picker's selection → don't surface app candidates
      // at all. Either we're at easy/medium tier (no apps in pool), or
      // we're at heavy but the non-app findings already cover the target.
      if (pickedApps.length === 0) return nonApps;

      const proximity = (f: FindingGroup) => Math.abs(f.reclaimableBytes - targetBytes);
      let visibleApps: FindingGroup[];
      if (tierResult.reachable) {
        // Reachable: keep every picked app, then fill up to a cap of 3 with
        // the closest-by-size alternatives. If picker genuinely needed > 3
        // apps to reach the target, we honour that and show all of them.
        const cap = Math.max(3, pickedApps.length);
        const slotsLeft = Math.max(0, cap - pickedApps.length);
        const alternatives = apps
          .filter((f) => !tierResult.pickedIds.has(f.id))
          .sort((a, b) => proximity(a) - proximity(b))
          .slice(0, slotsLeft);
        visibleApps = [...pickedApps, ...alternatives];
      } else {
        // Unreachable: picker marks every positive contributor. Cap to the
        // 3 apps with sizes closest to the target so the list stays useful.
        visibleApps = [...pickedApps].sort((a, b) => proximity(a) - proximity(b)).slice(0, 3);
      }
      return [...nonApps, ...visibleApps];
    }
    if (intent === "all") return allFindings.slice(0, 6);
    return allFindings.filter((f) => (f.tags ?? []).includes(intent)).slice(0, 6);
  }, [tierResult, intent, allFindings, targetGB]);

  const filteredFindingIds = useMemo(
    () => new Set(filteredFindings.map((f) => f.id)),
    [filteredFindings],
  );

  // Cleanup list = findings that survived intent/tier filtering, plus recs.
  // Recs always render (they aren't tag-filtered) unless target mode is on,
  // in which case we hide them too — they'd dilute the "what gets us to X"
  // narrative.
  const visibleCleanup = useMemo(() => {
    return cleanupItems.filter((c) => {
      if (dismissedIds.has(c.id)) return false;
      if (c.kind === "finding") return filteredFindingIds.has(c.id);
      // rec
      return !targetActive;
    });
  }, [cleanupItems, dismissedIds, filteredFindingIds, targetActive]);

  // For dismissed-counts we use the unfiltered list so the "Show hidden (N)"
  // counter doesn't change as the user flips chips.
  const dismissedCleanupCount = cleanupItems.filter((c) => dismissedIds.has(c.id)).length;
  const visibleSuggestions = (analysis?.suggestions ?? []).filter((s) => !dismissedIds.has(s.id));
  const dismissedSuggCount = (analysis?.suggestions.length ?? 0) - visibleSuggestions.length;
  const totalDismissedShown = dismissedCleanupCount + dismissedSuggCount;

  // Bytes that count toward target = sum of reclaimableBytes for the
  // currently-shown findings. The progress bar in TargetMode renders this.
  const cumulativeTargetBytes = useMemo(() => {
    if (!tierResult) return 0;
    let n = 0;
    for (const f of filteredFindings) n += f.reclaimableBytes;
    return n;
  }, [tierResult, filteredFindings]);

  // Total reclaimable across every finding — shown as the anchor number when
  // target mode is inactive ("up to ~120 GB available across what we found").
  const potentialReclaimBytes = useMemo(
    () => allFindings.reduce((n, f) => n + f.reclaimableBytes, 0),
    [allFindings],
  );

  // Drive-aware advisory: surfaces a "shift to D:" or "consider an external
  // drive" hint when the requested target is more than half the system drive.
  const driveAdvisory = useMemo(
    () => computeDriveAdvisory(volumes, targetGB * 1024 ** 3),
    [volumes, targetGB],
  );

  // When the user clicks "Show hidden", resurrect everything so they don't
  // have to hunt for individual items — simpler mental model.
  const hiddenCleanup = showDismissed ? cleanupItems.filter((c) => dismissedIds.has(c.id)) : [];
  const hiddenSuggestions = showDismissed
    ? (analysis?.suggestions ?? []).filter((s) => dismissedIds.has(s.id))
    : [];

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
            <span className={`scan-age ${isStale ? "is-stale" : ""}`}>
              Last analyzed {scanAgeLabel}
            </span>
          )}
          {scanning && <span className="scan-idle-indicator" title="Scanning user folders…" />}
          <button
            className={`btn-sm ${isStale ? "stale" : ""}`}
            onClick={onUserRescan}
            disabled={scanning}
            title={
              isStale
                ? "Results are over an hour old — click to refresh"
                : "Rescans drive folders and user-folder organization — may take 30–60 seconds"
            }
          >
            {scanning ? "Scanning…" : "Rescan"}
          </button>
        </div>
      </div>

      {error && (
        <div className="org-error" role="alert">
          <svg className="org-error-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
          <div className="org-error-body">
            <div className="org-error-title">We couldn't finish analyzing your folders.</div>
            <div className="org-error-hint">Try running the scan again. If it keeps failing, restart TaskManagerPlus.</div>
            <details className="org-error-detail">
              <summary>Technical details</summary>
              <pre>{error}</pre>
            </details>
          </div>
          <button className="btn-sm" onClick={onUserRescan} disabled={scanning}>
            {scanning ? "Scanning…" : "Try again"}
          </button>
        </div>
      )}

      {!hasData && !scanning && !error && (
        <div className="scan-prompt">
          <p>Scan your user folders to see what's taking up space, what's cluttered, and what you can safely clean up.</p>
          <button className="btn-secondary" onClick={onUserRescan}>Analyze now</button>
        </div>
      )}

      {!hasData && scanning && (
        <div className="empty-state scan-loading">
          <div className="spinner" />
          <span>{scanStatus || "Scanning your user folders…"}</span>
        </div>
      )}

      {hasData && analysis && (
        <>
          <div className="org-top-row">
            <OrgScoreGauge
              score={analysis.orgScore}
            />
            <div className="org-composition">
              <div
                className="org-comp-title"
                title="Shows how each of your main folders is split between Videos, Pictures, Documents, and other file types."
              >
                What's in your folders
              </div>
              {analysis.compositions.map((comp) => {
                const rowRefreshing = refreshingFolders.has(comp.folderPath) || scanning;
                return (
                  <StackedBar
                    key={comp.key}
                    comp={comp}
                    totalRef={maxTotal}
                    onRefresh={() => refreshOne(comp.folderPath, comp.key)}
                    refreshing={rowRefreshing}
                    lastRefreshed={cache?.folderTimestamps?.[comp.folderPath]}
                  />
                );
              })}
              {analysis.compositions.length === 0 && (
                <div className="empty-state" style={{ padding: 8 }}>
                  No files detected in user folders.
                </div>
              )}
            </div>
          </div>

          {scanning && scanStatus && (
            <div className="org-scan-strip">
              <div className="spinner spinner-sm" />
              <span>{scanStatus}</span>
            </div>
          )}

          {/* Intent chip row + free-up-X target mode. Both sit above the
              findings list so users see the filter context before the list
              itself. Activating target mode mutes the chip row visually. */}
          <IntentChips
            intent={intent}
            onChange={(next) => {
              if (targetActive) exitTarget();
              setIntent(next);
            }}
            counts={intentCounts}
            muted={targetActive}
          />
          <TargetMode
            active={targetActive}
            targetGB={targetGB}
            onActivate={activateTarget}
            onExit={exitTarget}
            tier={tierResult}
            cumulativeBytes={cumulativeTargetBytes}
            potentialReclaimBytes={potentialReclaimBytes}
            advisory={driveAdvisory}
          />

          {visibleCleanup.length > 0 && (
            <div className="org-cleanup">
              <div className="org-cleanup-header">
                <div className="org-subheading">
                  Cleanup ({visibleCleanup.length})
                </div>
                <div className="org-reassurance" title="Files you remove here go to the Windows Recycle Bin, not permanent deletion.">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  </svg>
                  Nothing is permanently deleted — items go to your Recycle Bin.
                </div>
              </div>
              <div className="cleanup-list">
                {visibleCleanup.map((item) => {
                  if (item.kind === "finding") {
                    // In target mode, mark the greedy-selected findings with
                    // a "counts toward target" badge so the user can tell which
                    // items the picker prioritised vs. which are "also-options".
                    const countsTowardTarget =
                      tierResult?.pickedIds.has(item.id) ?? false;
                    return (
                      <div
                        key={item.id}
                        className={`finding-wrap ${countsTowardTarget ? "counts-toward-target" : ""}`}
                      >
                        {tierResult && countsTowardTarget && (
                          <span className="org-target-badge" title="Greedy picker selected this to count toward your target">
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M20 6L9 17l-5-5" />
                            </svg>
                            counts toward target
                          </span>
                        )}
                        <FindingRow
                          group={item.finding}
                          onActionDone={onUserRescan}
                          userFolders={userFolders}
                          onDismiss={dismiss}
                        />
                      </div>
                    );
                  }
                  const rec = item.rec;
                  return (
                    <div key={item.id} className={`rec-card rec-${rec.severity}`}>
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
                      <button
                        className="btn-icon finding-dismiss"
                        onClick={() => dismiss(rec.id)}
                        title="Hide this for now"
                        aria-label="Hide recommendation"
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {visibleSuggestions.length > 0 && (
            <div className="org-suggestions">
              <div className="org-subheading">Ways to organize ({visibleSuggestions.length})</div>
              <div className="suggestion-list">
                {visibleSuggestions.map((s) => (
                  <SuggestionRow
                    key={s.id}
                    s={s}
                    onActionDone={onUserRescan}
                    onDismiss={dismiss}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Per-intent / per-tier empty state. We split the original
              "all clear" message into three buckets:
                • intent === "all" and target inactive AND nothing visible
                  AND nothing dismissed → green "all good" pill (original).
                • Chip filtered to a specific intent that yields 0 findings
                  → chip-specific empty copy (e.g. "No duplicates above 50 MB").
                • Target mode active with empty pool → variant of unreachable
                  banner (handled inside TargetMode itself, so no copy here). */}
          {visibleCleanup.length === 0 && visibleSuggestions.length === 0 &&
            totalDismissedShown === 0 && intent === "all" && !targetActive && (
              <div className="org-all-clear">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--accent-green)" }}>
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                  <path d="M22 4L12 14.01l-3-3" />
                </svg>
                Your user folders look well organized.
              </div>
          )}
          {visibleCleanup.length === 0 && intent !== "all" && !targetActive && (
            <div className="org-chip-empty">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <path d="M22 4L12 14.01l-3-3" />
              </svg>
              {INTENT_EMPTY_COPY[intent]}
            </div>
          )}
          {visibleCleanup.length === 0 && targetActive && tierResult && (
            <div className="org-chip-empty">
              No findings match this target tier yet — try a smaller target or rescan.
            </div>
          )}

          {totalDismissedShown > 0 && (
            <div className="org-dismissed-controls">
              <button
                className="btn-link"
                onClick={() => setShowDismissed((v) => !v)}
              >
                {showDismissed ? "Hide hidden items" : `Show hidden (${totalDismissedShown})`}
              </button>
              {showDismissed && (
                <button className="btn-link" onClick={restoreAll}>
                  Restore all
                </button>
              )}
            </div>
          )}

          {showDismissed && (hiddenCleanup.length > 0 || hiddenSuggestions.length > 0) && (
            <div className="org-hidden">
              <div className="org-subheading-sub">Hidden items</div>
              <div className="cleanup-list">
                {hiddenCleanup.map((item) => {
                  if (item.kind === "finding") {
                    return (
                      <FindingRow
                        key={item.id}
                        group={item.finding}
                        onActionDone={onUserRescan}
                        userFolders={userFolders}
                        onDismiss={dismiss}
                      />
                    );
                  }
                  const rec = item.rec;
                  return (
                    <div key={item.id} className={`rec-card rec-${rec.severity} is-hidden`}>
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
                  );
                })}
                {hiddenSuggestions.map((s) => (
                  <SuggestionRow
                    key={s.id}
                    s={s}
                    onActionDone={onUserRescan}
                    onDismiss={dismiss}
                  />
                ))}
              </div>
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

        {/* Row 2: Storage breakdown + installed apps (side-by-side) */}
        <div className="two-col-grid storage-two-col">
          <StorageBreakdown
            root={selectedRoot}
            folders={scanFolders}
            scanTs={scanTs}
            isFetching={foldersFetching}
            onRescan={triggerFullRescan}
            volume={vols.find((v) => v.letter === selectedLetter)}
          />
          <InstalledAppsPanel />
        </div>

        {/* Row 3: Smart Organizer (composition bars expand to show
            biggest subfolders + biggest files per user folder). */}
        <SmartOrganizerPanel
          rescanSignal={rescanEpoch}
          onUserRescan={triggerFullRescan}
          volumes={vols}
          recycleBinSize={recycleBinSize ?? 0}
          folders={scanFolders}
          apps={apps}
        />
      </div>
    </div>
  );
}

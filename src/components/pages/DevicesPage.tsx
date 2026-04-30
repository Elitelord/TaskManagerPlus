import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useBluetoothDevices, useUsbDevices } from "../../hooks/useBluetoothDevices";
import {
  bluetoothRemoveDevice,
  openBluetoothSettings,
  type BluetoothDeviceSnapshot,
  type UsbDeviceInfo,
} from "../../lib/ipc";
import { bestManufacturerName } from "../../lib/usbVendors";
import { loadDevicePrefs, saveDevicePrefs } from "../../lib/devicePrefs";

// ─── Unified device model ──────────────────────────────────────────────────

type Category =
  | "audio"
  | "input"
  | "phone"
  | "storage"
  | "network"
  | "display"
  | "printing"
  | "computer"
  | "other";

const CATEGORIES: { id: Category | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "audio", label: "Audio" },
  { id: "input", label: "Input" },
  { id: "phone", label: "Phone" },
  { id: "storage", label: "Storage" },
  { id: "network", label: "Network" },
  { id: "display", label: "Display" },
  { id: "printing", label: "Printing" },
  { id: "computer", label: "Computer" },
  { id: "other", label: "Other" },
];

interface UnifiedDevice {
  key: string;
  source: "bluetooth" | "usb";
  name: string;
  subtitle: string;
  category: Category;
  connected: boolean;
  statusLabel: string;
  bt?: BluetoothDeviceSnapshot;
  usb?: UsbDeviceInfo;
  /** For composite USB devices collapsed by VID:PID — total interface count. */
  interfaceCount?: number;
}

type SortKey = "name" | "category" | "status" | "source";
type SortDir = "asc" | "desc";

const SORT_OPTIONS: { id: SortKey; label: string }[] = [
  { id: "name", label: "Name" },
  { id: "category", label: "Category" },
  { id: "status", label: "Status" },
  { id: "source", label: "Source" },
];

// Category priority for picking the "primary" category of a composite USB
// device. "Other" is last — if any child has a specific category, use it.
const CATEGORY_PRIORITY: Category[] = [
  "audio", "input", "phone", "storage", "display", "printing", "network", "computer", "other",
];

function pickCategory(cats: Category[]): Category {
  for (const p of CATEGORY_PRIORITY) if (cats.includes(p)) return p;
  return "other";
}


// BT major-class → category. Major class is bits 12–8 of class-of-device.
function btCategory(d: BluetoothDeviceSnapshot): Category {
  const major = (d.class_of_device >> 8) & 0x1f;
  switch (major) {
    case 0x01: return "computer";
    case 0x02: return "phone";
    case 0x03: return "network";
    case 0x04: return "audio";
    case 0x05: return "input";
    case 0x06: return "printing";
    default: return "other";
  }
}

// USB Windows device-class → user-facing category. Fallbacks peek at the
// description for a few common OEM cases filed under generic class names.
function usbCategory(d: UsbDeviceInfo): Category {
  const cls = d.class.toLowerCase();
  const desc = d.description.toLowerCase();
  if (cls === "hidclass" || cls === "keyboard" || cls === "mouse") return "input";
  if (cls === "audioendpoint" || cls === "media" || cls === "sound") return "audio";
  if (cls === "diskdrive" || (cls === "usb" && desc.includes("mass storage"))) return "storage";
  if (cls === "wpd" || cls === "portable devices") return "phone";
  if (cls === "net") return "network";
  if (cls === "monitor" || cls === "display") return "display";
  if (cls === "printer" || cls === "image") return "printing";
  if (cls === "computer" || cls === "system") return "computer";
  if (desc.includes("webcam") || desc.includes("camera")) return "input";
  if (desc.includes("headset") || desc.includes("headphone") || desc.includes("speaker")) return "audio";
  if (desc.includes("keyboard") || desc.includes("mouse") || desc.includes("trackpad")) return "input";
  return "other";
}

// ─── Icons (inline SVG) ────────────────────────────────────────────────────

function CategoryIcon({ cat }: { cat: Category }) {
  const common = {
    width: 22, height: 22, viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", strokeWidth: 1.6,
    strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
  };
  switch (cat) {
    case "audio":
      return (<svg {...common}><path d="M4 10v4a1 1 0 0 0 1 1h3l4 4V5L8 9H5a1 1 0 0 0-1 1z" /><path d="M15 9a4 4 0 0 1 0 6" /></svg>);
    case "input":
      return (<svg {...common}><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10" /></svg>);
    case "phone":
      return (<svg {...common}><rect x="7" y="3" width="10" height="18" rx="2" /><path d="M11 18h2" /></svg>);
    case "storage":
      return (<svg {...common}><rect x="3" y="7" width="18" height="10" rx="2" /><circle cx="7" cy="12" r="1" fill="currentColor" /><path d="M11 12h7" /></svg>);
    case "network":
      return (<svg {...common}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" /></svg>);
    case "display":
      return (<svg {...common}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>);
    case "printing":
      return (<svg {...common}><path d="M6 9V4h12v5" /><rect x="4" y="9" width="16" height="8" rx="2" /><rect x="7" y="15" width="10" height="5" /></svg>);
    case "computer":
      return (<svg {...common}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M2 20h20M9 16v4M15 16v4" /></svg>);
    default:
      return (<svg {...common}><circle cx="12" cy="12" r="8" /><path d="M12 8v4M12 16h.01" /></svg>);
  }
}

function SourceBadge({ source }: { source: "bluetooth" | "usb" }) {
  return <span className={`device-source-chip ${source}`}>{source === "bluetooth" ? "Bluetooth" : "USB"}</span>;
}

function SortChevron({ dir }: { dir: "asc" | "desc" }) {
  return (
    <svg
      className="device-sort-chevron"
      width="8"
      height="8"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {dir === "asc" ? <path d="M2 6.5 L5 3.5 L8 6.5" /> : <path d="M2 3.5 L5 6.5 L8 3.5" />}
    </svg>
  );
}

function formatLastUsed(unix: number): string {
  if (!unix) return "";
  const ms = unix * 1000;
  const ageSec = (Date.now() - ms) / 1000;
  if (ageSec < 60) return "just now";
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`;
  if (ageSec < 86400) return `${Math.floor(ageSec / 3600)}h ago`;
  if (ageSec < 86400 * 30) return `${Math.floor(ageSec / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}

// ─── Page ──────────────────────────────────────────────────────────────────

export function DevicesPage() {
  const queryClient = useQueryClient();
  const bt = useBluetoothDevices();
  const usb = useUsbDevices();

  // One-shot fetch on mount — the hooks have refetchOnMount: false so we
  // trigger explicitly here. Makes the "no implicit background work"
  // contract very visible.
  useEffect(() => {
    queryClient.invalidateQueries({ queryKey: ["bluetooth-snapshot"] });
    queryClient.invalidateQueries({ queryKey: ["usb-snapshot"] });
  }, [queryClient]);

  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Load persisted sort + filter once, then mirror every change back to storage.
  const initialPrefs = useMemo(() => loadDevicePrefs(), []);
  const [activeCategory, setActiveCategory] = useState<Category | "all">(
    (initialPrefs.activeCategory as Category | "all") ?? "all",
  );
  const [sortKey, setSortKey] = useState<SortKey>(initialPrefs.sortKey);
  const [sortDir, setSortDir] = useState<SortDir>(initialPrefs.sortDir);
  const [searchQuery, setSearchQuery] = useState("");
  const [scanDurationMs, setScanDurationMs] = useState<number | null>(null);
  const [toastName, setToastName] = useState<string | null>(null);

  useEffect(() => {
    saveDevicePrefs({ sortKey, sortDir, activeCategory });
  }, [sortKey, sortDir, activeCategory]);

  const handleSortClick = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "status" ? "desc" : "asc");
    }
  };

  const refreshAll = async () => {
    const t0 = performance.now();
    await Promise.all([bt.refetch(), usb.refetch()]);
    setScanDurationMs(Math.round(performance.now() - t0));
  };

  const devices: UnifiedDevice[] = useMemo(() => {
    const list: UnifiedDevice[] = [];
    if (bt.data?.devices) {
      for (const d of bt.data.devices) {
        const cat = btCategory(d);
        const status = d.connected ? "Connected" : d.authenticated ? "Paired" : "Remembered";
        const sub = [d.minor_class, "Bluetooth"].filter(Boolean).join(" · ");
        list.push({
          key: `bt:${d.address}`,
          source: "bluetooth",
          name: d.name || "(unnamed device)",
          subtitle: sub,
          category: cat,
          connected: d.connected,
          statusLabel: status,
          bt: d,
        });
      }
    }
    if (usb.data?.devices) {
      // Group by VID:PID — what Windows shows as N device nodes for a composite
      // device (e.g. a headset exposing HID + audio + composite parent) is one
      // physical peripheral to the user.
      const raw = usb.data.devices;
      const groups = new Map<string, UsbDeviceInfo[]>();
      const singletons: UsbDeviceInfo[] = [];
      for (const d of raw) {
        if (d.vendor_id === 0 && d.product_id === 0) {
          singletons.push(d);
          continue;
        }
        const k = `${d.vendor_id.toString(16)}:${d.product_id.toString(16)}`;
        const b = groups.get(k);
        if (b) b.push(d); else groups.set(k, [d]);
      }
      for (const bucket of groups.values()) {
        // Representative: prefer non-generic class + longest name.
        bucket.sort((a, b) => {
          const aGen = a.class.toLowerCase() === "usb" ? 1 : 0;
          const bGen = b.class.toLowerCase() === "usb" ? 1 : 0;
          if (aGen !== bGen) return aGen - bGen;
          return b.name.length - a.name.length;
        });
        const primary = bucket[0];
        const cat = pickCategory(bucket.map(usbCategory));
        // Prefer the best non-generic manufacturer string across the bucket;
        // fall back to VID lookup when all children report a generic string.
        const rawMfg =
          bucket.map((d) => d.manufacturer).find((m) => m.trim()) ?? "";
        const mfg = bestManufacturerName(rawMfg, primary.vendor_id);
        const classLabel = primary.class || "USB";
        const sub = [mfg, classLabel].filter(Boolean).join(" · ");
        list.push({
          key: `usb:${primary.vendor_id}:${primary.product_id}`,
          source: "usb",
          name: primary.name || primary.description || "(unnamed device)",
          subtitle: sub,
          category: cat,
          connected: true,
          statusLabel: "Plugged in",
          usb: primary,
          interfaceCount: bucket.length,
        });
      }
      // VID=0 devices can't be safely merged — keep separate.
      for (const d of singletons) {
        const cat = usbCategory(d);
        const mfg = bestManufacturerName(d.manufacturer, d.vendor_id);
        const sub = [mfg, d.class].filter(Boolean).join(" · ");
        list.push({
          key: `usb:${d.hardware_id}`,
          source: "usb",
          name: d.name || d.description || "(unnamed device)",
          subtitle: sub,
          category: cat,
          connected: true,
          statusLabel: "Plugged in",
          usb: d,
        });
      }
    }
    return list;
  }, [bt.data, usb.data]);

  // Priority for status ordering (higher = sorts first when desc).
  const statusRank = (d: UnifiedDevice): number => {
    if (d.connected) return 3;
    if (d.bt?.authenticated) return 2;
    if (d.bt?.remembered) return 1;
    return 0;
  };

  const sortedDevices = useMemo(() => {
    const mul = sortDir === "asc" ? 1 : -1;
    const list = [...devices];
    list.sort((a, b) => {
      let primary = 0;
      switch (sortKey) {
        case "name": primary = a.name.localeCompare(b.name) * mul; break;
        case "category": primary = a.category.localeCompare(b.category) * mul; break;
        case "status": primary = (statusRank(a) - statusRank(b)) * mul; break;
        case "source": primary = a.source.localeCompare(b.source) * mul; break;
      }
      if (primary !== 0) return primary;
      // Stable tie-break: always by name ascending.
      return a.name.localeCompare(b.name);
    });
    return list;
  }, [devices, sortKey, sortDir]);

  const countsByCategory = useMemo(() => {
    const m = new Map<Category, number>();
    for (const d of devices) m.set(d.category, (m.get(d.category) ?? 0) + 1);
    return m;
  }, [devices]);

  // Recent-disconnect toast: diff the BT snapshot across refreshes and raise a
  // transient banner when we see a connected→not-connected transition. Stored
  // on a ref, not state, so the diff doesn't re-render on every poll wake.
  const prevBtRef = useRef<BluetoothDeviceSnapshot[] | null>(null);
  useEffect(() => {
    const curr = bt.data?.devices ?? null;
    const prev = prevBtRef.current;
    if (curr && prev) {
      for (const p of prev) {
        if (!p.connected) continue;
        const match = curr.find((c) => c.address === p.address);
        if (match && !match.connected) {
          setToastName(p.name || "(unnamed device)");
          break;
        }
      }
    }
    prevBtRef.current = curr;
  }, [bt.data]);

  useEffect(() => {
    if (!toastName) return;
    const id = window.setTimeout(() => setToastName(null), 5000);
    return () => window.clearTimeout(id);
  }, [toastName]);

  // Search applied before category filter so the chip counts reflect everything.
  const searchMatches = (d: UnifiedDevice, q: string): boolean => {
    if (!q) return true;
    const needle = q.toLowerCase();
    const haystack: string[] = [
      d.name,
      d.subtitle,
      d.category,
      d.statusLabel,
      d.source,
    ];
    if (d.bt) {
      haystack.push(d.bt.address, d.bt.major_class, d.bt.minor_class);
    }
    if (d.usb) {
      haystack.push(
        d.usb.manufacturer,
        d.usb.class,
        d.usb.description,
        d.usb.hardware_id,
        d.usb.vendor_id.toString(16).padStart(4, "0"),
        d.usb.product_id.toString(16).padStart(4, "0"),
      );
    }
    return haystack.some((s) => s && s.toLowerCase().includes(needle));
  };

  const visibleDevices = sortedDevices
    .filter((d) => searchMatches(d, searchQuery.trim()))
    .filter((d) => activeCategory === "all" || d.category === activeCategory);

  // Connect *and* Disconnect are escape hatches: the classic Win32 Bluetooth
  // API doesn't reliably reach modern audio / BLE / HID stacks
  // (ERROR_INVALID_PARAMETER on connect; silent no-op on disconnect for audio
  // devices like the WH-1000XM5 because A2DP/HFP session state lives in the
  // audio bus driver, not BluetoothAPIs). Doing it properly needs WinRT
  // (`AudioPlaybackConnection`, GATT). Until then we route both buttons to
  // the Windows panel where the real paths live.
  const handleOpenSettings = async () => {
    setActionError(null);
    try {
      await openBluetoothSettings();
    } catch (e) {
      setActionError(`Opening Bluetooth settings failed: ${String(e)}`);
    }
  };

  const handleRemove = async (dev: UnifiedDevice) => {
    if (!dev.bt) return;
    const ok = window.confirm(
      `Unpair "${dev.name}"?\n\nYou'll need to re-pair the device to use it again.`,
    );
    if (!ok) return;
    setActionError(null);
    setBusyKey(dev.key);
    try {
      await bluetoothRemoveDevice(dev.bt.address);
      await bt.refetch();
    } catch (e) {
      setActionError(`Unpair failed: ${String(e)}`);
    } finally {
      setBusyKey(null);
    }
  };

  const isLoading = (bt.isLoading && !bt.data) || (usb.isLoading && !usb.data);
  const isFetching = bt.isFetching || usb.isFetching;

  if (isLoading) {
    return <div className="loading-overlay">Loading devices…</div>;
  }

  const btRadio = bt.data?.radios?.[0];
  const btRadioPresent = !!bt.data?.radio_present;
  const btDeviceCount = bt.data?.devices.length ?? 0;
  const usbDeviceCount = usb.data?.devices.length ?? 0;
  const connectedCount = devices.filter((d) => d.connected).length;

  return (
    <div className="resource-page devices-page">
      <div className="page-header">
        <div className="header-main">
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <h2>Devices</h2>
            <div className="header-subtitle">
              <span className="adapter-name">Bluetooth &amp; USB peripherals</span>
            </div>
          </div>
          <div className="header-meta">
            <span className="meta-item">Total: <strong>{devices.length}</strong></span>
            <span className="meta-item">Connected: <strong>{connectedCount}</strong></span>
            {scanDurationMs !== null && !isFetching && (
              <span className="meta-item device-scan-duration" title="Last refresh duration">
                Scanned in {scanDurationMs} ms
              </span>
            )}
            <button className="btn-secondary" onClick={refreshAll} disabled={isFetching}>
              {isFetching ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>
      </div>

      <div className="page-content">
        <div className="devices-top-row">
          <div className="info-panel top-row-card">
            <div className="top-row-card-body">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--accent-primary)", flexShrink: 0 }}>
                <path d="M7 7l10 10-5 5V2l5 5L7 17" />
              </svg>
              <div className="top-row-card-text">
                <div className="top-row-card-title">Bluetooth</div>
                <div className="top-row-card-detail">
                  {btRadioPresent
                    ? `${btRadio?.name || "Adapter"} · ${btDeviceCount} paired`
                    : "No radio detected"}
                </div>
              </div>
              <button className="btn-sm" onClick={() => openBluetoothSettings()}>Settings</button>
            </div>
          </div>

          <div className="info-panel top-row-card">
            <div className="top-row-card-body">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--accent-teal)", flexShrink: 0 }}>
                <path d="M12 3v12" />
                <circle cx="12" cy="18" r="2" />
                <path d="M9 8l3-3 3 3" />
                <rect x="10" y="10" width="4" height="3" />
              </svg>
              <div className="top-row-card-text">
                <div className="top-row-card-title">USB</div>
                <div className="top-row-card-detail">
                  {usbDeviceCount} {usbDeviceCount === 1 ? "device" : "devices"} connected
                </div>
              </div>
            </div>
          </div>
        </div>

        {(bt.data?.error || usb.data?.error || actionError) && (
          <div className="info-panel devices-error-panel">
            {bt.data?.error && <div>Bluetooth: {bt.data.error}</div>}
            {usb.data?.error && <div>USB: {usb.data.error}</div>}
            {actionError && <div>{actionError}</div>}
          </div>
        )}

        {toastName && (
          <div className="device-toast" role="status">
            <span>Disconnected from <strong>{toastName}</strong></span>
            <button
              className="device-toast-dismiss"
              onClick={() => setToastName(null)}
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        )}

        <div className="filter-toolbar device-search">
          <div className="filter-search-wrap">
            <input
              type="text"
              placeholder="Search devices by name, manufacturer, VID/PID…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                type="button"
                className="filter-search-clear"
                onClick={() => setSearchQuery("")}
                aria-label="Clear search"
              >
                ×
              </button>
            )}
          </div>
        </div>

        <div className="device-filters">
          {CATEGORIES.map((c) => {
            const count = c.id === "all"
              ? devices.length
              : countsByCategory.get(c.id as Category) ?? 0;
            if (c.id !== "all" && count === 0) return null;
            const active = activeCategory === c.id;
            return (
              <button
                key={c.id}
                type="button"
                className={`device-chip ${active ? "is-active" : ""}`}
                onClick={() => setActiveCategory(c.id)}
              >
                {c.label}
                <span className="device-chip-count">{count}</span>
              </button>
            );
          })}
        </div>

        <div className="info-panel">
          <div className="device-list-header">
            <div className="device-list-heading-group">
              <h3 className="section-title" style={{ margin: 0 }}>
                {activeCategory === "all"
                  ? "All devices"
                  : CATEGORIES.find((c) => c.id === activeCategory)?.label}
              </h3>
              {(() => {
                const parts: string[] = [];
                const btPaired = bt.data?.devices.length ?? 0;
                const usbCount = usb.data?.devices.length ?? 0;
                if (btPaired > 0) parts.push(`${btPaired} Bluetooth paired`);
                if (usbCount > 0) parts.push(`${usbCount} USB`);
                const highlight: Category[] = ["audio", "input", "phone"];
                for (const cat of highlight) {
                  const n = countsByCategory.get(cat) ?? 0;
                  if (n > 0) parts.push(`${n} ${cat}`);
                }
                if (searchQuery.trim()) {
                  parts.push(`${visibleDevices.length} matching "${searchQuery.trim()}"`);
                }
                if (parts.length === 0) return null;
                return <div className="device-summary-line">{parts.join(" · ")}</div>;
              })()}
            </div>
            <div className="device-sort">
              <span className="device-sort-label">Sort</span>
              <div className="view-toggle">
                {SORT_OPTIONS.map((o) => {
                  const active = sortKey === o.id;
                  return (
                    <button
                      key={o.id}
                      type="button"
                      className={`toggle-btn ${active ? "is-active" : ""}`}
                      onClick={() => handleSortClick(o.id)}
                      title={active ? `Click to switch to ${sortDir === "asc" ? "descending" : "ascending"}` : `Sort by ${o.label}`}
                    >
                      {o.label}
                      {active && <SortChevron dir={sortDir} />}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {visibleDevices.length === 0 ? (
            <div className="empty-state">
              {devices.length === 0
                ? "No devices detected. Click Refresh to re-scan."
                : "No devices in this category."}
            </div>
          ) : (
            <ul className="device-list">
              {visibleDevices.map((d) => {
                const lastUsed = d.source === "bluetooth" && d.bt?.last_used_unix
                  ? formatLastUsed(d.bt.last_used_unix) : "";
                const vidPid = d.source === "usb" && d.usb?.vendor_id
                  ? `VID ${d.usb.vendor_id.toString(16).toUpperCase().padStart(4, "0")} · PID ${d.usb.product_id.toString(16).toUpperCase().padStart(4, "0")}`
                  : "";
                return (
                  <li key={d.key} className={`device-row ${d.connected ? "is-connected" : ""}`}>
                    <div className="device-icon-wrap"><CategoryIcon cat={d.category} /></div>
                    <div className="device-main-col">
                      <div className="device-name-row">
                        <span className="device-name">{d.name}</span>
                        <SourceBadge source={d.source} />
                      </div>
                      <div className="device-sub">
                        <span>{d.subtitle}</span>
                        {d.interfaceCount && d.interfaceCount > 1 && (
                          <span className="device-sub-dim"> · {d.interfaceCount} interfaces</span>
                        )}
                        {lastUsed && <span className="device-sub-dim"> · last used {lastUsed}</span>}
                        {vidPid && <span className="device-sub-dim"> · {vidPid}</span>}
                      </div>
                    </div>
                    <div className="device-status-col">
                      <span className={`device-status-chip ${d.connected ? "is-on" : ""}`}>
                        {d.statusLabel}
                      </span>
                    </div>
                    <div className="device-actions-col">
                      {d.source === "bluetooth" && d.connected && (
                        <button
                          className="btn-sm"
                          onClick={handleOpenSettings}
                          title="Opens Windows Bluetooth settings — disconnect from there"
                        >
                          Disconnect…
                        </button>
                      )}
                      {d.source === "bluetooth" && !d.connected && d.bt?.authenticated && (
                        <button
                          className="btn-sm"
                          onClick={handleOpenSettings}
                          title="Opens Windows Bluetooth settings — reconnect from there"
                        >
                          Connect…
                        </button>
                      )}
                      {d.source === "bluetooth" && (
                        <button className="btn-sm btn-danger" disabled={busyKey === d.key} onClick={() => handleRemove(d)}>
                          Unpair
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

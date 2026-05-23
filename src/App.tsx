import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SystemOverview } from "./components/SystemOverview";
import { FilterToolbar } from "./components/FilterToolbar";
import { ProcessTable } from "./components/ProcessTable";
import { CpuPage } from "./components/pages/CpuPage";
import { MemoryPage } from "./components/pages/MemoryPage";
import { DiskPage } from "./components/pages/DiskPage";
import { StoragePage } from "./components/pages/StoragePage";
import { NetworkPage } from "./components/pages/NetworkPage";
import { GpuPage } from "./components/pages/GpuPage";
import { NpuPage } from "./components/pages/NpuPage";
import { BatteryPage } from "./components/pages/BatteryPage";
import { DevicesPage } from "./components/pages/DevicesPage";
import { SettingsPage } from "./components/pages/SettingsPage";
import { InsightsPage } from "./components/pages/InsightsPage";
import { PowerWarner } from "./components/PowerWarner";
import { InsightsFeeder } from "./components/InsightsFeeder";
import { TrayWidget } from "./components/TrayWidget";
import { UpdateChecker } from "./components/UpdateChecker";
import { OnboardingTour } from "./components/OnboardingTour";
import { AiIntroModal } from "./components/AiIntroModal";
import { CommandPalette, type PaletteMode } from "./components/CommandPalette";
import { useState, useEffect } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen } from "@tauri-apps/api/event";
import { setMainTrayHidden } from "./lib/mainTrayBackground";
import { wakeAfterTrayShow } from "./hooks/usePerformanceData";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
    },
  },
});

export type SortField =
  | "memory"
  | "battery"
  | "name"
  | "cpu"
  | "disk"
  | "network"
  | "gpu"
  | "npu";

export type SortDirection = "asc" | "desc";
export type DisplayMode = "percent" | "values";

function App() {
  const [isWidget, setIsWidget] = useState(false);
  const [searchFilter, setSearchFilter] = useState("");
  const [sortField, setSortField] = useState<SortField>("memory");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [activeTab, setActiveTab] = useState("processes");
  // Phase 4 — global Ctrl-K command palette state. `paletteMode` is null
  // when the palette is closed; setting it to `{kind:"search"}` opens text
  // search, `{kind:"similar", seedPath}` opens "files like this" (S9).
  const [paletteMode, setPaletteMode] = useState<PaletteMode | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    try {
      const win = getCurrentWebviewWindow();
      if (win.label === "widget") {
        setIsWidget(true);
        return () => {};
      }
      listen<{ hidden: boolean }>("main-tray-background", (e) => {
        if (cancelled) return;
        setMainTrayHidden(e.payload.hidden);
        if (!e.payload.hidden) {
          wakeAfterTrayShow();
        }
      }).then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      }).catch(() => {});
    } catch {
      /* e.g. Vite without Tauri */
    }
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Phase 4 — global Ctrl-K opens the command palette in text-search
  // mode. Skipped for the widget window because it has no AI surface.
  useEffect(() => {
    if (isWidget) return;
    function onKey(e: KeyboardEvent) {
      // Ctrl-K (or ⌘-K on macOS, though we ship Windows-only currently).
      // Match VS Code / Slack / Linear conventions.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteMode((cur) => cur ? null : { kind: "search" });
      }
    }
    // Custom event lets pages (StoragePage) open the palette in similar
    // mode for S9 ("files like this") without prop-drilling through every
    // intermediate component.
    function onOpenSimilar(e: Event) {
      const detail = (e as CustomEvent<{ seedPath: string }>).detail;
      if (detail?.seedPath) setPaletteMode({ kind: "similar", seedPath: detail.seedPath });
    }
    // Same idea but for text-search mode — fired by the explicit "Search"
    // button on the Storage page so users can find S7 without knowing
    // the keyboard shortcut. The optional `initialQuery` lets callers
    // pre-populate the palette with a preset query — S10 tag chips use
    // this to launch a tag-themed search without forcing the user to
    // re-type the tag's natural-language description.
    function onOpenSearch(e: Event) {
      const detail = (e as CustomEvent<{ initialQuery?: string } | null>).detail;
      setPaletteMode({ kind: "search", initialQuery: detail?.initialQuery });
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("tmp:open-similar-palette", onOpenSimilar as EventListener);
    window.addEventListener("tmp:open-search-palette", onOpenSearch as EventListener);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("tmp:open-similar-palette", onOpenSimilar as EventListener);
      window.removeEventListener("tmp:open-search-palette", onOpenSearch as EventListener);
    };
  }, [isWidget]);

  const renderContent = () => {
    switch (activeTab) {
      case "processes":
        return (
          <>
            <FilterToolbar
              searchFilter={searchFilter}
              onSearchChange={setSearchFilter}
            />
            <ProcessTable
              searchFilter={searchFilter}
              sortField={sortField}
              onSortFieldChange={setSortField}
              sortDirection={sortDirection}
              onSortDirectionChange={setSortDirection}
            />
          </>
        );
      case "cpu": return <CpuPage />;
      case "memory": return <MemoryPage />;
      case "disk": return <DiskPage />;
      case "storage": return <StoragePage />;
      case "network": return <NetworkPage />;
      case "gpu": return <GpuPage />;
      case "npu": return <NpuPage />;
      case "battery": return <BatteryPage />;
      case "devices": return <DevicesPage />;
      case "insights": return <InsightsPage onNavigate={setActiveTab} />;
      case "settings": return <SettingsPage />;
      default: return null;
    }
  };

  if (isWidget) {
    return (
      <QueryClientProvider client={queryClient}>
        <TrayWidget />
      </QueryClientProvider>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <div className="app">
        <SystemOverview activeTab={activeTab} onTabChange={setActiveTab} />
        <div className="content-area">
          {renderContent()}
        </div>
        <PowerWarner />
        <InsightsFeeder />
        <UpdateChecker />
        <OnboardingTour onNavigate={setActiveTab} />
        <AiIntroModal onNavigate={setActiveTab} />
        <CommandPalette
          open={paletteMode !== null}
          mode={paletteMode ?? { kind: "search" }}
          onClose={() => setPaletteMode(null)}
        />
      </div>
    </QueryClientProvider>
  );
}

export default App;

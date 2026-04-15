import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SystemOverview } from "./components/SystemOverview";
import { FilterToolbar } from "./components/FilterToolbar";
import { ProcessTable } from "./components/ProcessTable";
import { CpuPage } from "./components/pages/CpuPage";
import { MemoryPage } from "./components/pages/MemoryPage";
import { DiskPage } from "./components/pages/DiskPage";
import { NetworkPage } from "./components/pages/NetworkPage";
import { GpuPage } from "./components/pages/GpuPage";
import { NpuPage } from "./components/pages/NpuPage";
import { BatteryPage } from "./components/pages/BatteryPage";
import { SettingsPage } from "./components/pages/SettingsPage";
import { InsightsPage } from "./components/pages/InsightsPage";
import { PowerWarner } from "./components/PowerWarner";
import { InsightsFeeder } from "./components/InsightsFeeder";
import { TrayWidget } from "./components/TrayWidget";
import { UpdateChecker } from "./components/UpdateChecker";
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
      case "network": return <NetworkPage />;
      case "gpu": return <GpuPage />;
      case "npu": return <NpuPage />;
      case "battery": return <BatteryPage />;
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
      </div>
    </QueryClientProvider>
  );
}

export default App;

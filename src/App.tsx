import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SystemOverview } from "./components/SystemOverview";
import { FilterToolbar } from "./components/FilterToolbar";
import { ProcessTable } from "./components/ProcessTable";
import { CpuPage } from "./components/pages/CpuPage";
import { MemoryPage } from "./components/pages/MemoryPage";
import { DiskPage } from "./components/pages/DiskPage";
import { NetworkPage } from "./components/pages/NetworkPage";
import { GpuPage } from "./components/pages/GpuPage";
import { BatteryPage } from "./components/pages/BatteryPage";
import { PowerWarner } from "./components/PowerWarner";
import { useState } from "react";

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
  | "gpu";

export type SortDirection = "asc" | "desc";
export type DisplayMode = "percent" | "values";

function App() {
  const [searchFilter, setSearchFilter] = useState("");
  const [sortField, setSortField] = useState<SortField>("memory");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [displayMode, setDisplayMode] = useState<DisplayMode>("percent");
  const [activeTab, setActiveTab] = useState("processes");

  const renderContent = () => {
    switch (activeTab) {
      case "processes":
        return (
          <>
            <FilterToolbar
              searchFilter={searchFilter}
              onSearchChange={setSearchFilter}
              displayMode={displayMode}
              onDisplayModeChange={setDisplayMode}
            />
            <ProcessTable 
              searchFilter={searchFilter} 
              sortField={sortField} 
              onSortFieldChange={setSortField}
              sortDirection={sortDirection}
              onSortDirectionChange={setSortDirection}
              displayMode={displayMode}
            />
          </>
        );
      case "cpu": return <CpuPage />;
      case "memory": return <MemoryPage />;
      case "disk": return <DiskPage />;
      case "network": return <NetworkPage />;
      case "gpu": return <GpuPage />;
      case "battery": return <BatteryPage />;
      default: return null;
    }
  };

  return (
    <QueryClientProvider client={queryClient}>
      <div className="app">
        <SystemOverview activeTab={activeTab} onTabChange={setActiveTab} displayMode={displayMode} />
        <div className="content-area">
          {renderContent()}
        </div>
        <PowerWarner />
      </div>
    </QueryClientProvider>
  );
}

export default App;

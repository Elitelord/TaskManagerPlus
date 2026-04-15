import { useState } from "react";
import { CpuPage } from "./pages/CpuPage";
import { MemoryPage } from "./pages/MemoryPage";
import { DiskPage } from "./pages/DiskPage";
import { NetworkPage } from "./pages/NetworkPage";
import { GpuPage } from "./pages/GpuPage";
import { NpuPage } from "./pages/NpuPage";
import { BatteryPage } from "./pages/BatteryPage";

export type ResourcePanel = "cpu" | "memory" | "disk" | "network" | "gpu" | "npu" | "battery";

export function PerformanceView() {
  const [activePanel, _setActivePanel] = useState<ResourcePanel>("cpu");

  const renderPanel = () => {
    switch (activePanel) {
      case "cpu": return <CpuPage />;
      case "memory": return <MemoryPage />;
      case "disk": return <DiskPage />;
      case "network": return <NetworkPage />;
      case "gpu": return <GpuPage />;
      case "npu": return <NpuPage />;
      case "battery": return <BatteryPage />;
    }
  };

  return (
    <div className="performance-view">
      {renderPanel()}
    </div>
  );
}

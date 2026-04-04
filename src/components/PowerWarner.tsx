import { useState, useEffect } from "react";
import { usePowerData } from "../hooks/usePowerData";
import { useProcesses } from "../hooks/useProcesses";
import { setPriority } from "../lib/ipc";

export function PowerWarner() {
  const { data: powerData } = usePowerData();
  const { data: processes } = useProcesses();
  const [alerts, setAlerts] = useState<{ pid: number; name: string; watts: number }[]>([]);

  useEffect(() => {
    if (!powerData || !processes) return;

    const procMap = new Map(processes.map(p => [p.pid, p]));
    const highPower = powerData
      .filter(p => p.power_watts > 15.0) // 15W threshold
      .map(p => ({
        pid: p.pid,
        name: procMap.get(p.pid)?.display_name || procMap.get(p.pid)?.name || "Unknown",
        watts: p.power_watts
      }))
      .sort((a, b) => b.watts - a.watts);

    setAlerts(highPower.slice(0, 3)); // Show top 3 offenders
  }, [powerData, processes]);

  const handleEco = async (pid: number) => {
    try {
      await setPriority(pid, 0x00000040); // IDLE_PRIORITY_CLASS
      // Remove from alerts locally for immediate feedback
      setAlerts(prev => prev.filter(a => a.pid !== pid));
    } catch (e) {
      console.error(e);
    }
  };

  if (alerts.length === 0) return null;

  return (
    <div className="power-warner">
      <div className="warner-header">
        <span className="icon">⚠️</span>
        <span className="title">High Power Usage Detected</span>
      </div>
      <div className="warner-list">
        {alerts.map(alert => (
          <div key={alert.pid} className="warner-item">
            <div className="warner-info">
              <span className="name">{alert.name}</span>
              <span className="watts">{alert.watts.toFixed(1)} W</span>
            </div>
            <button className="eco-btn" onClick={() => handleEco(alert.pid)}>
              Eco Mode
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

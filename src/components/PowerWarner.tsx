import { useState, useEffect, useRef } from "react";
import { usePowerData } from "../hooks/usePowerData";
import { useProcesses } from "../hooks/useProcesses";
import { setPriority } from "../lib/ipc";

// Per-process power fluctuates heavily tick-to-tick, so we smooth with an EMA
// and require a sustained crossing before the banner appears/disappears.
// Without this the alert list flickers every second as values oscillate around
// the threshold.
const HIGH_WATTS = 15.0;
const LOW_WATTS = 10.0; // hysteresis — drop below this to clear
const EMA_ALPHA = 0.25; // lower = more smoothing
const SUSTAIN_ENTER_MS = 6000; // must stay above HIGH for this long to alert
const SUSTAIN_EXIT_MS = 8000; // must stay below LOW for this long to clear

interface PowerTrack {
  emaWatts: number;
  aboveSince: number | null;
  belowSince: number | null;
  alerting: boolean;
}

export function PowerWarner() {
  const { data: powerData } = usePowerData();
  const { data: processes } = useProcesses();
  const [alerts, setAlerts] = useState<{ pid: number; name: string; watts: number }[]>([]);
  const tracksRef = useRef<Map<number, PowerTrack>>(new Map());

  useEffect(() => {
    if (!powerData || !processes) return;

    const procMap = new Map(processes.map(p => [p.pid, p]));
    const tracks = tracksRef.current;
    const now = Date.now();
    const seen = new Set<number>();

    for (const p of powerData) {
      seen.add(p.pid);
      let t = tracks.get(p.pid);
      if (!t) {
        t = { emaWatts: p.power_watts, aboveSince: null, belowSince: null, alerting: false };
        tracks.set(p.pid, t);
      } else {
        t.emaWatts = EMA_ALPHA * p.power_watts + (1 - EMA_ALPHA) * t.emaWatts;
      }

      if (t.emaWatts >= HIGH_WATTS) {
        t.belowSince = null;
        if (t.aboveSince == null) t.aboveSince = now;
        if (!t.alerting && now - t.aboveSince >= SUSTAIN_ENTER_MS) {
          t.alerting = true;
        }
      } else if (t.emaWatts <= LOW_WATTS) {
        t.aboveSince = null;
        if (t.alerting) {
          if (t.belowSince == null) t.belowSince = now;
          if (now - t.belowSince >= SUSTAIN_EXIT_MS) {
            t.alerting = false;
          }
        }
      } else {
        // In the hysteresis band — keep current state; clear pending timers.
        t.aboveSince = null;
        t.belowSince = null;
      }
    }

    // Drop tracks for processes that disappeared.
    for (const pid of tracks.keys()) {
      if (!seen.has(pid)) tracks.delete(pid);
    }

    const active = [...tracks.entries()]
      .filter(([, t]) => t.alerting)
      .map(([pid, t]) => ({
        pid,
        name: procMap.get(pid)?.display_name || procMap.get(pid)?.name || "Unknown",
        watts: t.emaWatts,
      }))
      .sort((a, b) => b.watts - a.watts)
      .slice(0, 3);

    // Skip state updates when the visible list hasn't changed — prevents a
    // re-render every tick just because EMA watts drifted by 0.1W.
    setAlerts(prev => {
      if (prev.length !== active.length) return active;
      for (let i = 0; i < active.length; i++) {
        if (prev[i].pid !== active[i].pid) return active;
        if (Math.abs(prev[i].watts - active[i].watts) > 0.5) return active;
      }
      return prev;
    });
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

/**
 * Invisible component that feeds data into the global insights engine.
 * Mounted at the App level so it runs regardless of which tab is active.
 */
import { useEffect } from "react";
import { usePerformanceData } from "../hooks/usePerformanceData";
import { useProcesses } from "../hooks/useProcesses";
import { usePowerData } from "../hooks/usePowerData";
import { feedData, startEngine } from "../lib/insightsEngine";

export function InsightsFeeder() {
  const { current: snapshot, historyRef, generationRef } = usePerformanceData();
  const { data: processes } = useProcesses();
  const { data: powerData } = usePowerData();

  // Start the analysis engine once
  useEffect(() => {
    startEngine();
  }, []);

  // Feed data on every new snapshot
  useEffect(() => {
    if (!snapshot) return;
    const arr = historyRef.current?.toArray() ?? [];
    const latest = arr[arr.length - 1];
    const topPower = latest?.topPower ?? [];
    feedData(snapshot, generationRef.current, processes, powerData, topPower);
  }, [snapshot, processes, powerData, generationRef, historyRef]);

  return null;
}

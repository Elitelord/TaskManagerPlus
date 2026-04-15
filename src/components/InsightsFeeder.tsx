/**
 * Starts the global insights analysis interval. Snapshot/process feeds run from
 * the performance tick (see usePerformanceData) so this component does not
 * subscribe to every refresh (avoids extra React work per tick).
 */
import { useEffect } from "react";
import { startEngine } from "../lib/insightsEngine";

export function InsightsFeeder() {
  useEffect(() => {
    startEngine();
  }, []);

  return null;
}

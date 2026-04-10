import { useState, useEffect } from "react";
import { getCachedProcesses, subscribeGeneration, useEngineLifecycle } from "./usePerformanceData";
import type { ProcessInfo } from "../lib/types";

/**
 * Reads from the singleton performance engine instead of duplicating IPC fetches.
 * Returns a React-Query-compatible shape so existing call sites need no changes.
 */
export function useProcesses() {
  useEngineLifecycle();
  const [data, setData] = useState<ProcessInfo[] | undefined>(getCachedProcesses());

  useEffect(() => {
    // Re-sync once on mount in case data arrived between render and effect
    setData(getCachedProcesses());
    const unsub = subscribeGeneration(() => {
      setData(getCachedProcesses());
    });
    return unsub;
  }, []);

  return {
    data,
    isLoading: data === undefined,
    error: undefined as unknown,
  };
}

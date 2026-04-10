import { useState, useEffect } from "react";
import { getCachedSystemInfo, subscribeGeneration, useEngineLifecycle } from "./usePerformanceData";
import type { SystemInfo } from "../lib/types";

export function useSystemInfo() {
  useEngineLifecycle();
  const [data, setData] = useState<SystemInfo | undefined>(getCachedSystemInfo());

  useEffect(() => {
    setData(getCachedSystemInfo());
    const unsub = subscribeGeneration(() => {
      setData(getCachedSystemInfo());
    });
    return unsub;
  }, []);

  return { data, isLoading: data === undefined, error: undefined as unknown };
}

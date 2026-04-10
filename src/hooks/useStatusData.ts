import { useState, useEffect } from "react";
import { getCachedStatus, subscribeGeneration, useEngineLifecycle } from "./usePerformanceData";
import type { ProcessStatusInfo } from "../lib/types";

export function useStatusData() {
  useEngineLifecycle();
  const [data, setData] = useState<ProcessStatusInfo[] | undefined>(getCachedStatus());

  useEffect(() => {
    setData(getCachedStatus());
    const unsub = subscribeGeneration(() => {
      setData(getCachedStatus());
    });
    return unsub;
  }, []);

  return { data, isLoading: data === undefined, error: undefined as unknown };
}

import { useState, useEffect } from "react";
import { getCachedGpu, subscribeGeneration, useEngineLifecycle } from "./usePerformanceData";
import type { ProcessGpuInfo } from "../lib/types";

export function useGpuData() {
  useEngineLifecycle();
  const [data, setData] = useState<ProcessGpuInfo[] | undefined>(getCachedGpu());

  useEffect(() => {
    setData(getCachedGpu());
    const unsub = subscribeGeneration(() => {
      setData(getCachedGpu());
    });
    return unsub;
  }, []);

  return { data, isLoading: data === undefined, error: undefined as unknown };
}

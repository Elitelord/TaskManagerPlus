import { useState, useEffect } from "react";
import { getCachedNpu, subscribeGeneration, useEngineLifecycle } from "./usePerformanceData";
import type { ProcessNpuInfo } from "../lib/types";

export function useNpuData() {
  useEngineLifecycle();
  const [data, setData] = useState<ProcessNpuInfo[] | undefined>(getCachedNpu());

  useEffect(() => {
    setData(getCachedNpu());
    const unsub = subscribeGeneration(() => {
      setData(getCachedNpu());
    });
    return unsub;
  }, []);

  return { data, isLoading: data === undefined, error: undefined as unknown };
}

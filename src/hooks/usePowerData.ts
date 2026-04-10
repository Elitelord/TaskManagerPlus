import { useState, useEffect } from "react";
import { getCachedPower, subscribeGeneration, useEngineLifecycle } from "./usePerformanceData";
import type { ProcessPowerInfo } from "../lib/types";

export function usePowerData() {
  useEngineLifecycle();
  const [data, setData] = useState<ProcessPowerInfo[] | undefined>(getCachedPower());

  useEffect(() => {
    setData(getCachedPower());
    const unsub = subscribeGeneration(() => {
      setData(getCachedPower());
    });
    return unsub;
  }, []);

  return { data, isLoading: data === undefined, error: undefined as unknown };
}

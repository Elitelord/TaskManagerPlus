import { useState, useEffect } from "react";
import { getCachedNetwork, subscribeGeneration, useEngineLifecycle } from "./usePerformanceData";
import type { ProcessNetworkInfo } from "../lib/types";

export function useNetworkData() {
  useEngineLifecycle();
  const [data, setData] = useState<ProcessNetworkInfo[] | undefined>(getCachedNetwork());

  useEffect(() => {
    setData(getCachedNetwork());
    const unsub = subscribeGeneration(() => {
      setData(getCachedNetwork());
    });
    return unsub;
  }, []);

  return { data, isLoading: data === undefined, error: undefined as unknown };
}

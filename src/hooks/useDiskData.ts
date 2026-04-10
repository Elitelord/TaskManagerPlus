import { useState, useEffect } from "react";
import { getCachedDisk, subscribeGeneration, useEngineLifecycle } from "./usePerformanceData";
import type { ProcessDiskInfo } from "../lib/types";

export function useDiskData() {
  useEngineLifecycle();
  const [data, setData] = useState<ProcessDiskInfo[] | undefined>(getCachedDisk());

  useEffect(() => {
    setData(getCachedDisk());
    const unsub = subscribeGeneration(() => {
      setData(getCachedDisk());
    });
    return unsub;
  }, []);

  return { data, isLoading: data === undefined, error: undefined as unknown };
}

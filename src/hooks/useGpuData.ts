import { getCachedGpu } from "./usePerformanceData";
import { useCachedSubscription } from "./useCachedSubscription";
import type { ProcessGpuInfo } from "../lib/types";

export function useGpuData() {
  const data = useCachedSubscription<ProcessGpuInfo[] | undefined>(getCachedGpu);
  return { data, isLoading: data === undefined, error: undefined as unknown };
}

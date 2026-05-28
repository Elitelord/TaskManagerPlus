import { getCachedNpu } from "./usePerformanceData";
import { useCachedSubscription } from "./useCachedSubscription";
import type { ProcessNpuInfo } from "../lib/types";

export function useNpuData() {
  const data = useCachedSubscription<ProcessNpuInfo[] | undefined>(getCachedNpu);
  return { data, isLoading: data === undefined, error: undefined as unknown };
}

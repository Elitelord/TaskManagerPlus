import { getCachedStatus } from "./usePerformanceData";
import { useCachedSubscription } from "./useCachedSubscription";
import type { ProcessStatusInfo } from "../lib/types";

export function useStatusData() {
  const data = useCachedSubscription<ProcessStatusInfo[] | undefined>(getCachedStatus);
  return { data, isLoading: data === undefined, error: undefined as unknown };
}

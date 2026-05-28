import { getCachedSystemInfo } from "./usePerformanceData";
import { useCachedSubscription } from "./useCachedSubscription";
import type { SystemInfo } from "../lib/types";

export function useSystemInfo() {
  const data = useCachedSubscription<SystemInfo | undefined>(getCachedSystemInfo);
  return { data, isLoading: data === undefined, error: undefined as unknown };
}

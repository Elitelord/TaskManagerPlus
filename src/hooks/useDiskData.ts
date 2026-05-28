import { getCachedDisk } from "./usePerformanceData";
import { useCachedSubscription } from "./useCachedSubscription";
import type { ProcessDiskInfo } from "../lib/types";

export function useDiskData() {
  const data = useCachedSubscription<ProcessDiskInfo[] | undefined>(getCachedDisk);
  return { data, isLoading: data === undefined, error: undefined as unknown };
}

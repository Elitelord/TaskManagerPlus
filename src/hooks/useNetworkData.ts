import { getCachedNetwork } from "./usePerformanceData";
import { useCachedSubscription } from "./useCachedSubscription";
import type { ProcessNetworkInfo } from "../lib/types";

export function useNetworkData() {
  const data = useCachedSubscription<ProcessNetworkInfo[] | undefined>(getCachedNetwork);
  return { data, isLoading: data === undefined, error: undefined as unknown };
}

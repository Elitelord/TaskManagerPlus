import { getCachedPower } from "./usePerformanceData";
import { useCachedSubscription } from "./useCachedSubscription";
import type { ProcessPowerInfo } from "../lib/types";

export function usePowerData() {
  const data = useCachedSubscription<ProcessPowerInfo[] | undefined>(getCachedPower);
  return { data, isLoading: data === undefined, error: undefined as unknown };
}

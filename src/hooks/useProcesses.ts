import { getCachedProcesses } from "./usePerformanceData";
import { useCachedSubscription } from "./useCachedSubscription";
import type { ProcessInfo } from "../lib/types";

/**
 * Reads from the singleton performance engine instead of duplicating IPC fetches.
 * Returns a React-Query-compatible shape so existing call sites need no changes.
 */
export function useProcesses() {
  const data = useCachedSubscription<ProcessInfo[] | undefined>(getCachedProcesses);
  return {
    data,
    isLoading: data === undefined,
    error: undefined as unknown,
  };
}

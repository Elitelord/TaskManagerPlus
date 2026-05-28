import { useState, useEffect } from "react";
import { subscribeGeneration, useEngineLifecycle } from "./usePerformanceData";

/**
 * Shared hook for `use*Data` consumers of the singleton performance engine.
 *
 * The engine already does reference-equality work via `seriesEquality.ts`:
 * if a tick produces metrics that barely moved, `currentX` is left pointing
 * at the prior array. Without the guard below, every hook would still call
 * `setData(getCachedX())` every tick, handing React a "new" snapshot and
 * forcing a render-pass on every consumer (incl. global components like
 * PowerWarner that render even on Storage/Settings tabs).
 *
 * With the guard, React skips the bail-out when the reference matches, so
 * non-changing tickers cost only the subscribe callback + one identity check.
 */
export function useCachedSubscription<T>(getCached: () => T): T {
  useEngineLifecycle();
  const [data, setData] = useState<T>(getCached);

  useEffect(() => {
    // Re-sync once on mount in case data arrived between render and effect.
    setData((prev) => {
      const next = getCached();
      return prev === next ? prev : next;
    });
    const unsub = subscribeGeneration(() => {
      setData((prev) => {
        const next = getCached();
        return prev === next ? prev : next;
      });
    });
    return unsub;
    // `getCached` is a stable module-level function in every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return data;
}

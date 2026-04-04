import { useQuery } from "@tanstack/react-query";
import { getPowerData } from "../lib/ipc";

export function usePowerData(intervalMs = 2000) {
  return useQuery({
    queryKey: ["power"],
    queryFn: getPowerData,
    refetchInterval: intervalMs,
    staleTime: intervalMs - 200,
  });
}

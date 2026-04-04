import { useQuery } from "@tanstack/react-query";
import { getNetworkData } from "../lib/ipc";

export function useNetworkData(intervalMs = 3000) {
  return useQuery({
    queryKey: ["network"],
    queryFn: getNetworkData,
    refetchInterval: intervalMs,
    staleTime: intervalMs - 200,
  });
}

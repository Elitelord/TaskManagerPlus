import { useQuery } from "@tanstack/react-query";
import { getStatusData } from "../lib/ipc";

export function useStatusData(intervalMs = 5000) {
  return useQuery({
    queryKey: ["status"],
    queryFn: getStatusData,
    refetchInterval: intervalMs,
    staleTime: intervalMs - 200,
  });
}

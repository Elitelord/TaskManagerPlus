import { useQuery } from "@tanstack/react-query";
import { getGpuData } from "../lib/ipc";

export function useGpuData(intervalMs = 3000) {
  return useQuery({
    queryKey: ["gpu"],
    queryFn: getGpuData,
    refetchInterval: intervalMs,
    staleTime: intervalMs - 200,
  });
}

import { useQuery } from "@tanstack/react-query";
import { getDiskData } from "../lib/ipc";

export function useDiskData(intervalMs = 2000) {
  return useQuery({
    queryKey: ["disk"],
    queryFn: getDiskData,
    refetchInterval: intervalMs,
    staleTime: intervalMs - 200,
  });
}

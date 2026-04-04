import { useQuery } from "@tanstack/react-query";
import { getProcesses } from "../lib/ipc";

export function useProcesses(intervalMs = 2000) {
  return useQuery({
    queryKey: ["processes"],
    queryFn: getProcesses,
    refetchInterval: intervalMs,
    staleTime: intervalMs - 200,
  });
}

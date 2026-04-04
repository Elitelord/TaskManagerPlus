import { useQuery } from "@tanstack/react-query";
import { getSystemInfo } from "../lib/ipc";

export function useSystemInfo(intervalMs = 3000) {
  return useQuery({
    queryKey: ["systemInfo"],
    queryFn: getSystemInfo,
    refetchInterval: intervalMs,
    staleTime: intervalMs - 200,
  });
}

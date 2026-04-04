import { useQuery } from "@tanstack/react-query";
import { useRef, useEffect } from "react";
import { getPerformanceSnapshot, getPerCoreCpu, getProcesses, getPowerData, getDiskData, getNetworkData } from "../lib/ipc";
import { RingBuffer } from "../lib/ringBuffer";
import type { PerformanceSnapshot, CoreCpuInfo } from "../lib/types";

export interface PerformanceHistory {
  snapshot: PerformanceSnapshot;
  cores: CoreCpuInfo[];
  topCpu: { pid: number, name: string, value: number }[];
  topMem: { pid: number, name: string, value: number }[];
  topDisk: { pid: number, name: string, value: number }[];
  topNet: { pid: number, name: string, value: number }[];
  topPower: { pid: number, name: string, value: number }[];
  timestamp: number;
}

export function usePerformanceData() {
  const historyRef = useRef(new RingBuffer<PerformanceHistory>(60));
  const generationRef = useRef(0);

  const { data: snapshot } = useQuery({
    queryKey: ["performanceSnapshot"],
    queryFn: getPerformanceSnapshot,
    refetchInterval: 1000,
    staleTime: 800,
  });

  const { data: cores } = useQuery({
    queryKey: ["perCoreCpu"],
    queryFn: getPerCoreCpu,
    refetchInterval: 1000,
    staleTime: 800,
  });

  const { data: processes } = useQuery({ queryKey: ["processes"], queryFn: getProcesses, refetchInterval: 2000 });
  const { data: power } = useQuery({ queryKey: ["powerData"], queryFn: getPowerData, refetchInterval: 1000 });
  const { data: disk } = useQuery({ queryKey: ["diskData"], queryFn: getDiskData, refetchInterval: 1000 });
  const { data: network } = useQuery({ queryKey: ["networkData"], queryFn: getNetworkData, refetchInterval: 1000 });

  useEffect(() => {
    if (snapshot && cores && processes && power) {
      const procMap = new Map(processes.map(p => [p.pid, p]));

      // Group by display_name (matching process table bundling), then pick top entries
      const getTopGrouped = (data: any[], valFn: (p: any) => number, limit = 5) => {
        // First: group by display_name
        const groups = new Map<string, number>();
        for (const d of data) {
          const val = valFn(d);
          if (val <= 0.001) continue;
          const name = procMap.get(d.pid)?.display_name || procMap.get(d.pid)?.name || `PID ${d.pid}`;
          groups.set(name, (groups.get(name) || 0) + val);
        }

        // Sort by total value descending
        const sorted = [...groups.entries()]
          .map(([name, value]) => ({ pid: -1, name, value }))
          .sort((a, b) => b.value - a.value);

        const top = sorted.slice(0, limit);
        const otherSum = sorted.slice(limit).reduce((sum, d) => sum + d.value, 0);

        if (otherSum > 0.01) {
          top.push({ pid: -1, name: "Other", value: otherSum });
        }

        return top;
      };

      historyRef.current.push({
        snapshot,
        cores,
        topCpu: getTopGrouped(power, p => p.cpu_percent),
        topMem: getTopGrouped(processes, p => p.private_mb),
        topDisk: getTopGrouped(disk || [], p => p.read_bytes_per_sec + p.write_bytes_per_sec),
        topNet: getTopGrouped(network || [], p => p.send_bytes_per_sec + p.recv_bytes_per_sec),
        topPower: getTopGrouped(power, p => p.power_watts),
        timestamp: Date.now(),
      });
      generationRef.current++;
    }
  }, [snapshot, cores, processes, power, disk, network]);

  return {
    current: snapshot,
    cores,
    historyRef,
    generationRef,
  };
}

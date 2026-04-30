import { useQuery } from "@tanstack/react-query";
import { getBluetoothSnapshot, getUsbDevices } from "../lib/ipc";

/**
 * Devices snapshot hooks — deliberately NOT wired into `usePerformanceData`.
 *
 * Both Bluetooth (paired-device enumeration) and USB (SetupAPI) take non-trivial
 * time relative to the 1s performance poll loop and touch driver stacks, so we
 * never run them in the background. Fetches happen only:
 *   - Once when the Devices page mounts (page explicitly triggers invalidate)
 *   - When the user clicks Refresh (via `refetch()`)
 *   - After a disconnect/unpair action, to reflect the new state
 */

const noAutoRefresh = {
  staleTime: Infinity,
  gcTime: 5 * 60 * 1000,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  refetchOnMount: false,
  retry: false,
} as const;

export function useBluetoothDevices() {
  return useQuery({
    queryKey: ["bluetooth-snapshot"],
    queryFn: getBluetoothSnapshot,
    ...noAutoRefresh,
  });
}

export function useUsbDevices() {
  return useQuery({
    queryKey: ["usb-snapshot"],
    queryFn: getUsbDevices,
    ...noAutoRefresh,
  });
}

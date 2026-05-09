import { useEffect, useState } from "react";
import {
  getOemThermalCapabilities,
  getOemThermalStatus,
  type OemThermalCapabilities,
  type OemThermalStatus,
} from "../lib/ipc";
import { getSettings } from "../lib/settings";

type Listener = () => void;
const listeners = new Set<Listener>();

let caps: OemThermalCapabilities | null = null;
let status: OemThermalStatus | null = null;
let error: string | null = null;
let mountedCount = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let failCount = 0;

/* Max RPM per fan used to scale the UI bars. ASUS WMI doesn't expose a
 * max-RPM register, so we anchor at a sensible default for typical ASUS
 * laptop fans (~8000 RPM full-speed) and let the session-observed peak push
 * it higher if the hardware ever exceeds that. Exported for callers that
 * want to render current/max bars (CPU page, GPU page, Insights). */
const RPM_DEFAULT_MAX = 8000;
let maxCpuFanRpm = RPM_DEFAULT_MAX;
let maxGpuFanRpm = RPM_DEFAULT_MAX;

export function getSessionMaxFanRpm(): { cpu: number; gpu: number } {
  return { cpu: maxCpuFanRpm, gpu: maxGpuFanRpm };
}

function notify() {
  listeners.forEach((fn) => fn());
}

function shouldRun() {
  return getSettings().enableOemPerformance;
}

async function pollStatus() {
  if (!shouldRun()) {
    caps = null;
    status = null;
    error = null;
    failCount = 0;
    notify();
    return;
  }
  try {
    if (!caps) {
      caps = await getOemThermalCapabilities();
    }
    if (!caps || caps.vendor !== "asus" || (!caps.supports_perf_mode && !caps.supports_fan_rpm)) {
      status = null;
      error = null;
      failCount = 0;
      notify();
      return;
    }
    status = await getOemThermalStatus();
    if (status.cpu_fan_rpm != null && status.cpu_fan_rpm > maxCpuFanRpm) {
      maxCpuFanRpm = status.cpu_fan_rpm;
    }
    if (status.gpu_fan_rpm != null && status.gpu_fan_rpm > maxGpuFanRpm) {
      maxGpuFanRpm = status.gpu_fan_rpm;
    }
    error = status.error;
    failCount = 0;
    notify();
  } catch (e) {
    failCount += 1;
    error = String(e);
    if (failCount >= 3) {
      status = {
        supported: false,
        current_mode_id: null,
        cpu_fan_rpm: null,
        gpu_fan_rpm: null,
        error: "Thermal telemetry unavailable on this model.",
      };
      caps = null;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    }
    notify();
  }
}

function startPolling() {
  if (timer) return;
  void pollStatus();
  timer = setInterval(() => {
    void pollStatus();
  }, 8000);
}

function stopPolling() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

export function useOemThermal() {
  const [, setTick] = useState(0);

  useEffect(() => {
    const listener = () => setTick((x) => x + 1);
    listeners.add(listener);
    mountedCount += 1;
    if (mountedCount === 1) startPolling();
    return () => {
      listeners.delete(listener);
      mountedCount -= 1;
      if (mountedCount === 0) stopPolling();
    };
  }, []);

  const enabled = shouldRun();
  const exposedCaps =
    enabled && caps && caps.vendor === "asus" && (caps.supports_perf_mode || caps.supports_fan_rpm)
      ? caps
      : null;

  return {
    capabilities: exposedCaps,
    status: exposedCaps ? status : null,
    error,
    maxCpuFanRpm,
    maxGpuFanRpm,
  };
}

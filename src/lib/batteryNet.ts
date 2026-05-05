import type { PerformanceSnapshot } from "./types";

/**
 * Net power associated with the battery pack (W): positive while charging (energy
 * into cells per backend `charge_rate_watts`), negative on battery (system draw
 * from pack). Single definition for graphs and Power Flow — adjust only if the FFI
 * contract changes (see native IOCTL / estimation).
 */
export function netBatteryPower(s: PerformanceSnapshot): number {
  return s.is_charging ? s.charge_rate_watts : -s.power_draw_watts;
}

// Workload tie-breaker (feature I2) — pure, framework-free, testable.
//
// The regex + metadata WORKLOAD_RULES are the primary workload detector and
// stay primary. They cover known apps well but say nothing about an app
// they have never seen. I2 is the fallback: when NO rule matched but the
// machine is clearly busy, guess the workload from BEHAVIOUR instead of
// reporting a generic "General Use".
//
// Deliberately narrow. The one behavioural signal strong enough to act on
// is sustained GPU use by a non-helper process. A browser or media player
// would already have matched a WORKLOAD_RULE, so an *unmatched* process
// pushing real GPU load is most likely a game the regex list doesn't know
// yet. CPU-only load is intentionally left alone — a compile, a CPU render
// and a busy spreadsheet all look identical from CPU% — so those stay
// "General Use". Heuristic, not a model; not tier-gated.

export interface WorkloadGuessInput {
  name: string;
  cpuPercent: number;
  gpuPercent: number;
  memoryMb: number;
}

export interface WorkloadGuess {
  /** I2 only ever infers `gaming` — the one workload behaviour pins down. */
  type: "gaming";
  /** 0..1 — confidence, scaled from the GPU load. */
  confidence: number;
}

/** A non-helper process must sustain at least this GPU% for the tie-breaker
 *  to call it gaming. Set well above idle desktop-compositor load. */
export const GAMING_GPU_THRESHOLD = 25;

/**
 * Guess the active workload from process behaviour, for use ONLY when no
 * WORKLOAD_RULE matched. Returns `null` when nothing is confident enough —
 * callers then fall back to "General Use".
 *
 * `isHelper` is required (not defaulted) so this module never imports
 * `insights.ts` — that would form an import cycle. The workload detector
 * passes its own `isHelperProcess`.
 */
export function guessWorkload(
  processes: WorkloadGuessInput[],
  isHelper: (name: string) => boolean,
): WorkloadGuess | null {
  let maxGpu = 0;
  for (const p of processes) {
    if (isHelper(p.name)) continue;
    if (p.gpuPercent > maxGpu) maxGpu = p.gpuPercent;
  }
  if (maxGpu < GAMING_GPU_THRESHOLD) return null;
  // Confidence ramps from ~0.5 at the threshold toward a 0.95 ceiling.
  const confidence = Math.min(0.95, 0.5 + (maxGpu - GAMING_GPU_THRESHOLD) / 100);
  return { type: "gaming", confidence };
}

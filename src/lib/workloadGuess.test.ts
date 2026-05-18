import { describe, it, expect } from "vitest";
import { guessWorkload, GAMING_GPU_THRESHOLD } from "./workloadGuess";

const never = () => false;

function proc(name: string, cpuPercent: number, gpuPercent: number, memoryMb = 500) {
  return { name, cpuPercent, gpuPercent, memoryMb };
}

describe("guessWorkload", () => {
  it("returns null when nothing uses meaningful GPU", () => {
    const g = guessWorkload(
      [proc("a.exe", 40, 2), proc("b.exe", 30, 5)],
      never,
    );
    expect(g).toBeNull();
  });

  it("guesses gaming when an unmatched process sustains high GPU", () => {
    const g = guessWorkload([proc("mystery.exe", 60, 80)], never);
    expect(g?.type).toBe("gaming");
    expect(g!.confidence).toBeGreaterThan(0.5);
  });

  it("scales confidence with GPU load", () => {
    const low = guessWorkload([proc("x.exe", 20, GAMING_GPU_THRESHOLD + 1)], never);
    const high = guessWorkload([proc("x.exe", 20, 95)], never);
    expect(high!.confidence).toBeGreaterThan(low!.confidence);
    expect(high!.confidence).toBeLessThanOrEqual(0.95);
  });

  it("ignores GPU load attributed to helper processes", () => {
    // A helper pegging the GPU should not trigger a 'gaming' guess.
    const isHelper = (n: string) => n === "dwm.exe";
    const g = guessWorkload([proc("dwm.exe", 5, 90)], isHelper);
    expect(g).toBeNull();
  });

  it("still fires when a real process is GPU-heavy alongside helpers", () => {
    const isHelper = (n: string) => n === "dwm.exe";
    const g = guessWorkload(
      [proc("dwm.exe", 5, 8), proc("game.exe", 70, 75)],
      isHelper,
    );
    expect(g?.type).toBe("gaming");
  });

  it("does not fire just below the GPU threshold", () => {
    expect(guessWorkload([proc("x.exe", 50, GAMING_GPU_THRESHOLD - 1)], never))
      .toBeNull();
  });
});

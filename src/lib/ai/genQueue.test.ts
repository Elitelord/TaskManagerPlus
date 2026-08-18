import { describe, it, expect, beforeEach } from "vitest";
import { enqueueGeneration, resetGenerationQueue } from "./genQueue";

beforeEach(() => { resetGenerationQueue(); });

/** Resolves after `ms`, recording enter/exit into `log`. */
function tracked(log: string[], id: string, ms = 5) {
  return async () => {
    log.push(`${id}:start`);
    await new Promise((r) => setTimeout(r, ms));
    log.push(`${id}:end`);
    return id;
  };
}

describe("enqueueGeneration", () => {
  it("never overlaps two tasks", async () => {
    const log: string[] = [];
    await Promise.all([
      enqueueGeneration(tracked(log, "a")),
      enqueueGeneration(tracked(log, "b")),
      enqueueGeneration(tracked(log, "c")),
    ]);

    // Strict start/end pairing proves nothing ran concurrently.
    expect(log).toEqual([
      "a:start", "a:end",
      "b:start", "b:end",
      "c:start", "c:end",
    ]);
  });

  it("runs tasks in the order they were enqueued", async () => {
    const results = await Promise.all([
      enqueueGeneration(async () => 1),
      enqueueGeneration(async () => 2),
      enqueueGeneration(async () => 3),
    ]);
    expect(results).toEqual([1, 2, 3]);
  });

  it("skips a task cancelled while it waited in the queue", async () => {
    const log: string[] = [];
    let cancelled = false;

    const first = enqueueGeneration(tracked(log, "first"));
    const second = enqueueGeneration(tracked(log, "second"), () => cancelled);
    // Cancel before `second` gets its turn — the point of the queue.
    cancelled = true;

    expect(await first).toBe("first");
    expect(await second).toBeNull();
    expect(log).toEqual(["first:start", "first:end"]);
  });

  it("checks cancellation at run time, not enqueue time", async () => {
    let cancelled = true;
    // Cancelled at enqueue, un-cancelled before its turn: it should still run.
    const p = enqueueGeneration(async () => "ran", () => cancelled);
    cancelled = false;
    expect(await p).toBe("ran");
  });

  it("keeps draining after a task rejects", async () => {
    const failing = enqueueGeneration(async () => { throw new Error("boom"); });
    await expect(failing).rejects.toThrow("boom");

    // A rejection must not strand everything queued behind it.
    await expect(enqueueGeneration(async () => "after")).resolves.toBe("after");
  });

  it("propagates the task's resolved value to its own caller", async () => {
    const [a, b] = await Promise.all([
      enqueueGeneration(async () => ["x"]),
      enqueueGeneration(async () => ["y", "z"]),
    ]);
    expect(a).toEqual(["x"]);
    expect(b).toEqual(["y", "z"]);
  });
});

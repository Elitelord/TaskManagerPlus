// Client-side serialisation for on-device generative calls.
//
// The Rust side already serialises inference on `ModelHandle::gen_lock` — it
// has to, because the prebuilt Vulkan DLLs fault when two threads build
// contexts on the same model at once. But that lock is the *last* line of
// defence, and reaching it 12 times over is expensive in its own right:
//
//   - each queued call holds a `spawn_blocking` thread from Tauri's pool for
//     the entire wait, not just its own inference;
//   - each generation builds and tears down a fresh 4096-token GPU context, so
//     N suggestions cost N × (context setup + decode) serially anyway;
//   - work whose UI has already gone away still runs to completion.
//
// The Smart Organizer hit all three at once: every folder-creating suggestion
// requested an AI folder name from its own mount effect, so a dozen
// suggestions rendered a dozen concurrent requests and the page sat busy for
// ~25 seconds generating names for rows the user may never look at.
//
// Queuing here fixes the first and third problems (one blocking thread at a
// time, and queued work can be dropped before it starts) and makes the second
// explicit rather than accidental.

/** Tail of the queue. Every enqueued task chains onto this. */
let tail: Promise<unknown> = Promise.resolve();

/**
 * Run `task` after all previously-enqueued generative work has settled.
 *
 * `isCancelled` is checked immediately before `task` starts, not when it is
 * enqueued — that's the point. A suggestion that unmounts while sitting in the
 * queue never spends a model call. Returns `null` when the task was skipped.
 *
 * A rejected task doesn't poison the queue: the chain always continues.
 */
export function enqueueGeneration<T>(
  task: () => Promise<T>,
  isCancelled?: () => boolean,
): Promise<T | null> {
  const run = tail.then(async () => {
    if (isCancelled?.()) return null;
    return await task();
  });
  // Keep the chain alive regardless of how this task settles, so one failure
  // doesn't strand everything queued behind it.
  tail = run.catch(() => undefined);
  return run;
}

/** Test seam — drops any pending chain so cases don't leak into each other. */
export function resetGenerationQueue() {
  tail = Promise.resolve();
}

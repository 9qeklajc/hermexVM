/**
 * Stall-watched consumption of a live event stream.
 *
 * The bridge writes a `keepalive` frame at least every ~25s while a turn is
 * quiet, so a live CEP-41 stream that goes silent far past that cadence is not
 * "the agent thinking" — it is a dead stream (relay drop, socket teardown on
 * background, hot-swapped transport). Waiting it out freezes the conversation
 * screen until the user leaves and re-enters. This helper turns that silence
 * into an actionable outcome so the caller can abort and re-attach.
 */

export type StreamWatchOutcome = "done" | "stalled" | "aborted" | "error";

/**
 * Resolve a stream's terminal result without ever hanging on a half-open
 * transport. Rejections and timeouts both become `null`; the timer is cleared
 * immediately when the result settles first.
 */
export async function awaitResultWithin<T>(
  result: Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      result.catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Consumes `events`, forwarding each frame to `onEvent`, until the stream
 * ends, errors, is aborted via `signal`, or goes silent for `stallMs`.
 * Never throws: transport/iterator errors are reported as `"error"`.
 *
 * On a non-clean outcome the iterator's `return()` is invoked (fire and
 * forget) so the underlying stream is released instead of dangling.
 */
export async function consumeEventsWithStallWatch<T>(
  events: AsyncIterable<T>,
  onEvent: (event: T) => void,
  opts: { stallMs: number; signal?: AbortSignal },
): Promise<StreamWatchOutcome> {
  const iterator = events[Symbol.asyncIterator]();
  let outcome: StreamWatchOutcome = "done";
  try {
    while (true) {
      if (opts.signal?.aborted) {
        outcome = "aborted";
        break;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stall = new Promise<"__stall">((resolve) => {
        timer = setTimeout(() => resolve("__stall"), opts.stallMs);
      });
      let next: IteratorResult<T> | "__stall";
      try {
        next = await Promise.race([iterator.next(), stall]);
      } finally {
        clearTimeout(timer);
      }
      if (next === "__stall") {
        outcome = "stalled";
        break;
      }
      if (next.done) {
        outcome = "done";
        break;
      }
      onEvent(next.value);
    }
  } catch {
    outcome = "error";
  } finally {
    if (outcome !== "done") {
      // Release the stream without blocking on it — the caller's own abort()
      // path performs the real teardown, and return() may itself hang on a
      // dead transport.
      try {
        void iterator.return?.(undefined).catch(() => undefined);
      } catch {
        // iterator.return threw synchronously — already released.
      }
    }
  }
  return outcome;
}

import { describe, expect, it } from "vitest";
import {
  awaitResultWithin,
  consumeEventsWithStallWatch,
  type StreamWatchOutcome,
} from "./stream";

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function* of<T>(values: T[]): AsyncGenerator<T> {
  for (const value of values) {
    yield value;
  }
}

describe("awaitResultWithin", () => {
  it("returns a settled result", async () => {
    await expect(
      awaitResultWithin(Promise.resolve("done"), 1000),
    ).resolves.toBe("done");
  });

  it("turns a rejected result into null", async () => {
    await expect(
      awaitResultWithin(Promise.reject(new Error("closed")), 1000),
    ).resolves.toBeNull();
  });

  it("times out a result that never settles", async () => {
    const never = new Promise<string>(() => undefined);
    await expect(awaitResultWithin(never, 20)).resolves.toBeNull();
  });
});

describe("consumeEventsWithStallWatch", () => {
  it("consumes every event and reports done when the stream ends", async () => {
    const seen: number[] = [];
    const outcome = await consumeEventsWithStallWatch(
      of([1, 2, 3]),
      (event) => seen.push(event),
      { stallMs: 1000 },
    );
    expect(seen).toEqual([1, 2, 3]);
    expect(outcome).toBe<StreamWatchOutcome>("done");
  });

  it("reports stalled when no frame arrives within the window", async () => {
    // A stream that never yields and never ends — a dead transport.
    const never = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<number>>(() => undefined),
        return: () => Promise.resolve({ done: true, value: undefined }),
      }),
    };
    const startedAt = Date.now();
    const outcome = await consumeEventsWithStallWatch(never, () => undefined, {
      stallMs: 25,
    });
    expect(outcome).toBe<StreamWatchOutcome>("stalled");
    // The stall resolved promptly rather than hanging on the dead iterator.
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });

  it("resets the stall window on every received frame", async () => {
    // Frames keep arriving just under the stall window — must never stall.
    async function* slowButAlive(): AsyncGenerator<number> {
      for (let i = 0; i < 5; i++) {
        await sleep(20);
        yield i;
      }
    }
    const seen: number[] = [];
    const outcome = await consumeEventsWithStallWatch(
      slowButAlive(),
      (event) => seen.push(event),
      { stallMs: 40 },
    );
    expect(seen).toEqual([0, 1, 2, 3, 4]);
    expect(outcome).toBe<StreamWatchOutcome>("done");
  });

  it("reports error when the stream throws", async () => {
    async function* exploding(): AsyncGenerator<number> {
      yield 1;
      throw new Error("relay exploded");
    }
    const outcome = await consumeEventsWithStallWatch(
      exploding(),
      () => undefined,
      { stallMs: 1000 },
    );
    expect(outcome).toBe<StreamWatchOutcome>("error");
  });

  it("reports aborted when the signal is already tripped", async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await consumeEventsWithStallWatch(
      of([1, 2]),
      () => undefined,
      { stallMs: 1000, signal: controller.signal },
    );
    expect(outcome).toBe<StreamWatchOutcome>("aborted");
  });

  it("releases the iterator via return() when it stalls", async () => {
    let returned = false;
    const never = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<number>>(() => undefined),
        return: () => {
          returned = true;
          return Promise.resolve({ done: true, value: undefined });
        },
      }),
    };
    const outcome = await consumeEventsWithStallWatch(never, () => undefined, {
      stallMs: 20,
    });
    expect(outcome).toBe<StreamWatchOutcome>("stalled");
    // return() was invoked synchronously before the helper resolved.
    expect(returned).toBe(true);
  });
});

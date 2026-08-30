import { describe, expect, it, vi } from "vitest";
import { ActivityTracker } from "./activity.js";
import type { HermesActivityEvent } from "@contexcgi/protocol";

describe("ActivityTracker", () => {
  it("announces starts and completions to subscribers", () => {
    const tracker = new ActivityTracker();
    const events: HermesActivityEvent[] = [];
    tracker.subscribe((event) => events.push(event));

    tracker.start("coder", "chat1");
    expect(tracker.snapshot()).toMatchObject({
      type: "activity.snapshot",
      turns: [{ agentId: "coder", chatId: "chat1" }],
    });
    tracker.complete("coder", "chat1", { preview: "done!" });

    expect(events.map((event) => event.type)).toEqual([
      "turn.started",
      "turn.completed",
    ]);
    expect(events[1]).toMatchObject({ preview: "done!" });
    expect(tracker.activeCount).toBe(0);
  });

  it("ignores duplicate completions", () => {
    const tracker = new ActivityTracker();
    const listener = vi.fn();
    tracker.subscribe(listener);
    tracker.start("coder", "chat1");
    tracker.complete("coder", "chat1");
    tracker.complete("coder", "chat1");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("fails every running turn when the gateway dies", () => {
    const tracker = new ActivityTracker();
    const events: HermesActivityEvent[] = [];
    tracker.subscribe((event) => events.push(event));
    tracker.start("coder", "a");
    tracker.start("default", "b");
    tracker.failAll("hermes gateway restarted");
    const completed = events.filter((event) => event.type === "turn.completed");
    expect(completed).toHaveLength(2);
    expect(completed[0]).toMatchObject({
      failureReason: "hermes gateway restarted",
    });
    expect(tracker.activeCount).toBe(0);
  });

  it("evicts the oldest listener when the cap is reached, not the newcomer", () => {
    const tracker = new ActivityTracker();
    const seen: string[][] = [];
    for (let i = 0; i < 21; i++) {
      const bucket: string[] = [];
      seen.push(bucket);
      tracker.subscribe((event) => bucket.push(event.type));
    }
    tracker.start("coder", "chat1");
    // The 21st (newest) subscriber still receives events…
    expect(seen[20]).toEqual(["turn.started"]);
    // …while the oldest was evicted to make room.
    expect(seen[0]).toEqual([]);
  });

  it("keeps other subscribers alive when one throws", () => {
    const tracker = new ActivityTracker();
    const seen: string[] = [];
    tracker.subscribe(() => {
      throw new Error("boom");
    });
    tracker.subscribe((event) => seen.push(event.type));
    tracker.start("coder", "chat1");
    expect(seen).toEqual(["turn.started"]);
  });
});

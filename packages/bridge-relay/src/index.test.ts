import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResilientRelayPool } from "./index.js";

type TestPool = {
  relays: Array<{ url: string; connected: boolean }>;
  subscriptions: Map<string, unknown>;
  rebuildInFlight?: Promise<void>;
  rebuild: (reason: string) => void;
  checkDegraded: () => void;
};

const URLS = ["wss://a.example", "wss://b.example", "wss://c.example"];

function makePool(): { pool: TestPool; rebuild: ReturnType<typeof vi.fn> } {
  const pool = new ResilientRelayPool(URLS) as unknown as TestPool & {
    watchdogTimer?: ReturnType<typeof setInterval>;
  };
  // Drive checkDegraded() manually so the constructor's interval can't fire
  // mid-test when fake timers advance.
  clearInterval(pool.watchdogTimer);
  pool.watchdogTimer = undefined;
  const rebuild = vi.fn();
  pool.rebuild = rebuild;
  pool.relays = URLS.map((url) => ({ url, connected: true }));
  pool.subscriptions = new Map([["sub", {}]]);
  return { pool, rebuild };
}

describe("ResilientRelayPool watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not rebuild while all relays are connected", () => {
    const { pool, rebuild } = makePool();
    for (let i = 0; i < 10; i++) pool.checkDegraded();
    expect(rebuild).not.toHaveBeenCalled();
  });

  it("rebuilds after sustained partial disconnection", () => {
    const { pool, rebuild } = makePool();
    pool.relays[1]!.connected = false;
    pool.checkDegraded();
    pool.checkDegraded();
    expect(rebuild).not.toHaveBeenCalled();
    pool.checkDegraded();
    expect(rebuild).toHaveBeenCalledWith("watchdog-degraded");
  });

  it("resets the degraded count when the pool recovers", () => {
    const { pool, rebuild } = makePool();
    pool.relays[1]!.connected = false;
    pool.checkDegraded();
    pool.checkDegraded();
    pool.relays[1]!.connected = true;
    pool.checkDegraded();
    pool.relays[1]!.connected = false;
    pool.checkDegraded();
    pool.checkDegraded();
    expect(rebuild).not.toHaveBeenCalled();
  });

  it("respects the rebuild cooldown for permanently dead relays", () => {
    const { pool, rebuild } = makePool();
    pool.relays[1]!.connected = false;
    for (let i = 0; i < 12; i++) pool.checkDegraded();
    expect(rebuild).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(11 * 60_000);
    for (let i = 0; i < 3; i++) pool.checkDegraded();
    expect(rebuild).toHaveBeenCalledTimes(2);
  });

  it("ignores idle pools with no subscriptions", () => {
    const { pool, rebuild } = makePool();
    pool.subscriptions = new Map();
    pool.relays.forEach((r) => (r.connected = false));
    for (let i = 0; i < 10; i++) pool.checkDegraded();
    expect(rebuild).not.toHaveBeenCalled();
  });

  it("skips checks while a rebuild is in flight", () => {
    const { pool, rebuild } = makePool();
    pool.relays[1]!.connected = false;
    pool.rebuildInFlight = Promise.resolve();
    for (let i = 0; i < 10; i++) pool.checkDegraded();
    expect(rebuild).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HermesChatClient } from "@contexcgi/client";
import type { ConnectionStatus } from "./store";

const lifecycle = vi.hoisted(() => ({
  cleanup: undefined as (() => void) | undefined,
  native: undefined as ((state: { isActive: boolean }) => void) | undefined,
  remove: vi.fn(),
  focus: vi.fn(),
}));
vi.mock("react", () => ({
  useEffect: (effect: () => () => void) => {
    lifecycle.cleanup = effect();
  },
}));
vi.mock("@capacitor/app", () => ({
  App: {
    addListener: (_: string, listener: typeof lifecycle.native) => {
      lifecycle.native = listener;
      return Promise.resolve({ remove: lifecycle.remove });
    },
  },
}));
vi.mock("@tanstack/react-query", () => ({
  focusManager: { setFocused: lifecycle.focus },
}));

import { useConnectionResume } from "./use-connection-resume";

function ResumeHarness() {
  const ping = vi.fn().mockResolvedValue(undefined);
  const clientRef = { current: { ping } as unknown as HermesChatClient | null };
  const statusRef = { current: "connected" as ConnectionStatus };
  const isActiveRef = { current: true };
  const reconnect = vi.fn();
  const transportReplacingRef = { current: false };
  useConnectionResume({
    clientRef,
    statusRef,
    isActiveRef,
    transportReplacingRef,
    reconnect,
  });
  return {
    ping,
    clientRef,
    statusRef,
    isActiveRef,
    transportReplacingRef,
    reconnect,
  };
}

function native(isActive: boolean) {
  lifecycle.native?.({ isActive });
}
function visibility(visible: boolean) {
  Object.defineProperty(document, "visibilityState", {
    value: visible ? "visible" : "hidden",
    configurable: true,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  const document = new EventTarget();
  Object.defineProperty(document, "visibilityState", {
    value: "visible",
    configurable: true,
  });
  vi.stubGlobal("document", document);
});
afterEach(() => {
  lifecycle.cleanup?.();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useConnectionResume", () => {
  it("retains a healthy transport and its streams after briefly leaving the app", async () => {
    const state = ResumeHarness();
    const original = state.clientRef.current;
    native(false);
    await vi.advanceTimersByTimeAsync(100);
    native(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(state.reconnect).not.toHaveBeenCalled();
    expect(state.transportReplacingRef.current).toBe(false);
    expect(state.ping).toHaveBeenCalledOnce();
    expect(state.clientRef.current).toBe(original);
    expect(lifecycle.focus).toHaveBeenLastCalledWith(true);
  });
  it("replaces a rejected transport immediately without the old 1500ms delay", async () => {
    const state = ResumeHarness();
    state.ping.mockRejectedValue(new Error("Not connected"));
    native(false);
    native(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.reconnect).toHaveBeenCalledOnce();
    expect(lifecycle.focus).not.toHaveBeenCalledWith(true);
  });

  it("shares one probe across native and visibility foreground events", async () => {
    const state = ResumeHarness();
    native(false);
    visibility(false);
    native(true);
    visibility(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.ping).toHaveBeenCalledOnce();
    expect(state.reconnect).not.toHaveBeenCalled();
  });

  it("handles visibility-only resumes, including long suspensions", async () => {
    const state = ResumeHarness();
    visibility(false);
    await vi.advanceTimersByTimeAsync(600_000);
    visibility(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.ping).toHaveBeenCalledOnce();
    expect(lifecycle.focus).toHaveBeenLastCalledWith(true);
    expect(state.reconnect).not.toHaveBeenCalled();
  });

  it.each(["connecting", "replacing"])(
    "does not restart an ongoing %s",
    async (phase) => {
      const state = ResumeHarness();
      if (phase === "connecting") state.statusRef.current = "connecting";
      else state.transportReplacingRef.current = true;
      native(false);
      native(true);
      await vi.advanceTimersByTimeAsync(3000);
      expect(state.ping).not.toHaveBeenCalled();
      expect(state.reconnect).not.toHaveBeenCalled();
      expect(lifecycle.focus).not.toHaveBeenCalledWith(true);
    },
  );

  it("retries an offline saved session immediately on resume", () => {
    const state = ResumeHarness();
    state.clientRef.current = null;
    state.statusRef.current = "error";
    native(false);
    native(true);
    expect(state.reconnect).toHaveBeenCalledOnce();
  });

  it.each(["background", "switch", "disconnect", "replace", "unmount"])(
    "ignores stale successful or failed probes after %s",
    async (change) => {
      for (const fails of [false, true]) {
        const state = ResumeHarness();
        let resolve!: () => void;
        let reject!: (error: Error) => void;
        state.ping.mockImplementation(
          () =>
            new Promise<void>((yes, no) => {
              resolve = yes;
              reject = no;
            }),
        );
        native(false);
        native(true);
        const signal = state.ping.mock.calls[0]?.[0] as AbortSignal;
        if (change === "background") native(false);
        if (change === "switch")
          state.clientRef.current = {} as HermesChatClient;
        if (change === "disconnect") state.clientRef.current = null;
        if (change === "replace") state.transportReplacingRef.current = true;
        if (change === "unmount") lifecycle.cleanup?.();
        if (fails) reject(new Error("stale failure"));
        else resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(state.reconnect).not.toHaveBeenCalled();
        expect(lifecycle.focus).not.toHaveBeenCalledWith(true);
        if (change === "background" || change === "unmount")
          expect(signal.aborted).toBe(true);
        lifecycle.cleanup?.();
      }
    },
  );

  it("ignores foreground events that were not preceded by backgrounding", () => {
    const state = ResumeHarness();
    native(true);
    visibility(true);
    expect(state.ping).not.toHaveBeenCalled();
    expect(state.reconnect).not.toHaveBeenCalled();
  });
});

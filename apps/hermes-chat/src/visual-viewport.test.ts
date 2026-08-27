import { describe, expect, it, vi } from "vitest";
import { bindVisualViewportTop } from "./visual-viewport";

type Listener = () => void;

function fakeViewport(offsetTop = 0) {
  const listeners = new Map<string, Set<Listener>>();
  return {
    offsetTop,
    addEventListener(type: string, listener: Listener) {
      const bucket = listeners.get(type) ?? new Set<Listener>();
      bucket.add(listener);
      listeners.set(type, bucket);
    },
    removeEventListener(type: string, listener: Listener) {
      listeners.get(type)?.delete(listener);
    },
    emit(type: string) {
      for (const listener of listeners.get(type) ?? []) listener();
    },
    listenerCount(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

describe("bindVisualViewportTop", () => {
  it("keeps a fixed header aligned with the visible viewport during keyboard pan", () => {
    const viewport = fakeViewport();
    const onTopChange = vi.fn();
    const cleanup = bindVisualViewportTop(viewport, onTopChange);

    expect(onTopChange).toHaveBeenLastCalledWith(0);

    viewport.offsetTop = 184;
    viewport.emit("scroll");
    expect(onTopChange).toHaveBeenLastCalledWith(184);

    viewport.offsetTop = 96;
    viewport.emit("resize");
    expect(onTopChange).toHaveBeenLastCalledWith(96);

    cleanup();
    expect(viewport.listenerCount("scroll")).toBe(0);
    expect(viewport.listenerCount("resize")).toBe(0);
  });

  it("never moves the header above the layout viewport", () => {
    const viewport = fakeViewport(-12);
    const onTopChange = vi.fn();

    bindVisualViewportTop(viewport, onTopChange);

    expect(onTopChange).toHaveBeenCalledWith(0);
  });
});

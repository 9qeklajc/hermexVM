export interface VisualViewportTopSource {
  readonly offsetTop: number;
  addEventListener(type: "resize" | "scroll", listener: () => void): void;
  removeEventListener(type: "resize" | "scroll", listener: () => void): void;
}

/**
 * Tracks the top edge of the browser's *visible* viewport.
 *
 * Android WebView can pan its visual viewport when the IME focuses the chat
 * textarea even when the Activity requests adjustResize. CSS position:fixed is
 * anchored to the larger layout viewport in that state, so a header at top:0
 * moves above the keyboard-visible area. Consumers use this value as the fixed
 * header's top offset.
 */
export function bindVisualViewportTop(
  viewport: VisualViewportTopSource,
  onTopChange: (top: number) => void,
): () => void {
  const sync = () => onTopChange(Math.max(0, viewport.offsetTop));

  sync();
  viewport.addEventListener("resize", sync);
  viewport.addEventListener("scroll", sync);

  return () => {
    viewport.removeEventListener("resize", sync);
    viewport.removeEventListener("scroll", sync);
  };
}

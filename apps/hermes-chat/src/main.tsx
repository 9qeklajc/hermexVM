import { Buffer } from "buffer";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// The ContextVM SDK / nostr-tools expect Node's Buffer in the browser.
if (!globalThis.Buffer) globalThis.Buffer = Buffer;

// Deliberately aborting a CEP-41 stream (on disconnect / navigation) rejects an
// internal SDK promise with OpenStreamAbortError. It's benign teardown noise —
// swallow it so it doesn't surface as an app error.
window.addEventListener("unhandledrejection", (event) => {
  const name = (event.reason as { name?: string } | undefined)?.name;
  if (name === "OpenStreamAbortError") event.preventDefault();
  // MCP SDK rejects in-flight callTool promises with McpError(ConnectionClosed)
  // when the transport tears down mid-request (relay drop, hot-swap reconnect).
  // This is benign — the app already handles it in the send() catch. Swallow
  // the unhandled rejection so it doesn't surface as a console error.
  if (name === "McpError") {
    const code = (event.reason as { code?: number } | undefined)?.code;
    if (code === -32000) event.preventDefault();
  }
});

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

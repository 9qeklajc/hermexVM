import { useEffect, type RefObject } from "react";
import { App as CapApp } from "@capacitor/app";
import { focusManager } from "@tanstack/react-query";
import type { HermesChatClient } from "@contexcgi/client";
import type { ConnectionStatus } from "./store";

/** Validate the existing session before replacing sockets or interrupting streams. */
export function useConnectionResume({
  clientRef,
  statusRef,
  isActiveRef,
  transportReplacingRef,
  reconnect,
}: {
  clientRef: RefObject<HermesChatClient | null>;
  statusRef: RefObject<ConnectionStatus>;
  isActiveRef: RefObject<boolean>;
  transportReplacingRef: RefObject<boolean>;
  reconnect: () => void;
}) {
  useEffect(() => {
    let wasBackgrounded = false;
    let probe: AbortController | null = null;
    const onBackground = () => {
      wasBackgrounded = true;
      probe?.abort();
      probe = null;
      focusManager.setFocused(false);
    };
    const onForeground = () => {
      if (!wasBackgrounded) return;
      wasBackgrounded = false;
      if (statusRef.current === "connecting" || transportReplacingRef.current)
        return;
      const client = clientRef.current;
      if (!client || statusRef.current !== "connected") {
        reconnect();
        return;
      }
      // A socket can still look OPEN after the OS suspended it. An MCP ping
      // checks the entire encrypted bridge round trip, not just the relay.
      // Keep streams and the composer intact while checking; only failed
      // probes enter replacement. Query refetch waits for proof of liveness.
      const controller = new AbortController();
      probe = controller;
      const isCurrent = () =>
        !controller.signal.aborted &&
        isActiveRef.current &&
        clientRef.current === client &&
        statusRef.current === "connected" &&
        !transportReplacingRef.current;
      void client.ping(controller.signal).then(
        () => {
          if (isCurrent()) focusManager.setFocused(true);
        },
        () => {
          if (isCurrent()) reconnect();
        },
      );
    };
    const handle = CapApp.addListener("appStateChange", ({ isActive }) => {
      isActiveRef.current = isActive;
      if (isActive) onForeground();
      else onBackground();
    });
    // Some WebViews emit only visibilitychange. Both sources share the same
    // transition/probe so duplicate foreground events cannot restart recovery.
    const onVisibility = () => {
      const visible = document.visibilityState === "visible";
      isActiveRef.current = visible;
      if (visible) onForeground();
      else onBackground();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      probe?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
      void handle.then((listener) => listener.remove());
    };
  }, [clientRef, statusRef, isActiveRef, transportReplacingRef, reconnect]);
}

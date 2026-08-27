import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Preferences } from "@capacitor/preferences";
import { App as CapApp } from "@capacitor/app";
import {
  DEFAULT_CONFIG,
  makeClient,
  probeRelays,
  type HermesConfig,
} from "./api";
import {
  restoreConnectionConfig,
  type HermesActivityEvent,
  type HermesActivityStream,
  type HermesChatClient,
} from "@contexcgi/client";
import { displayAgentName } from "./chat";
import { initNotifications, notificationId, notify } from "./notify";

// ---------------------------------------------------------------------------
// Navigation — a simple mobile screen stack with Android back support.
// ---------------------------------------------------------------------------

export type Screen =
  | { kind: "connect" }
  | { kind: "agents" }
  | { kind: "chats"; agentId: string; agentName: string }
  | {
      kind: "chat";
      agentId: string;
      agentName: string;
      /** null → a brand-new conversation; the first send fills it in. */
      chatId: string | null;
      title?: string;
    };

interface NavState {
  stack: Screen[];
  push: (screen: Screen) => void;
  pop: () => void;
  replaceTop: (screen: Screen) => void;
  reset: (screen: Screen) => void;
}

const NavContext = createContext<NavState | null>(null);

export function useNav(): NavState {
  const value = useContext(NavContext);
  if (!value) throw new Error("NavContext missing");
  return value;
}

// ---------------------------------------------------------------------------
// Connection — persisted ContextVM identity + connected client.
// ---------------------------------------------------------------------------

export type ConnectionStatus = "idle" | "connecting" | "connected" | "error";

interface ConnectionState {
  config: HermesConfig | null;
  client: HermesChatClient | null;
  waitForClient: (options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
    forceReconnect?: boolean;
  }) => Promise<HermesChatClient>;
  ready: boolean; // persisted config has been loaded
  status: ConnectionStatus;
  error: string | null;
  connect: (config: HermesConfig) => void;
  reconnect: () => void;
  disconnect: () => void;
  /**
   * Monotonic counter bumped on every background→foreground transition —
   * screens depend on it to revalidate stale state even when the reconnect
   * itself is skipped or the client object survives the transition unchanged
   * (in which case no client-change effect would ever fire).
   */
  resumedAt: number;
}

const ConnectionContext = createContext<ConnectionState | null>(null);

export function useConnection(): {
  client: HermesChatClient;
  waitForClient: (options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
    forceReconnect?: boolean;
  }) => Promise<HermesChatClient>;
} {
  const value = useContext(ConnectionContext);
  if (!value?.client) throw new Error("Not connected");
  return {
    client: value.client,
    waitForClient: value.waitForClient,
  };
}

export function useConnectionState(): ConnectionState {
  const value = useContext(ConnectionContext);
  if (!value) throw new Error("ConnectionContext missing");
  return value;
}

const STORAGE_KEY = "hermes.chat.connection.contextvm";

/**
 * Two configs point at the same bridge/session when their identity + relays
 * match — used to distinguish a background→foreground reconnect (same session,
 * → hot-swap: keep the old client alive) from a genuine config change (→ full
 * teardown). Deep-equal on the relays array so reordering doesn't count.
 */
function sameConnection(a: HermesConfig, b: HermesConfig): boolean {
  if (a.privateKey !== b.privateKey) return false;
  if (a.serverPubkey !== b.serverPubkey) return false;
  if (a.relays.length !== b.relays.length) return false;
  return a.relays.every((r, i) => r === b.relays[i]);
}

/**
 * Restores the persisted connection. Any config that uses the shipped single-user
 * identity (default privateKey + serverPubkey) is treated as the auto-connect
 * config and force-updated to the current DEFAULT_RELAYS — so a relay-set change
 * (e.g. dropping nostr.mom, adding vetted trusted relays) propagates to devices
 * that already have a stored config. A genuinely custom connection is preserved.
 */
function restoreStoredConfig(value: string | null): HermesConfig {
  const restored = restoreConnectionConfig(value, DEFAULT_CONFIG);
  if (
    restored.privateKey === DEFAULT_CONFIG.privateKey &&
    restored.serverPubkey === DEFAULT_CONFIG.serverPubkey
  ) {
    return DEFAULT_CONFIG;
  }
  return restored;
}

// ---------------------------------------------------------------------------
// Activity — app-wide "who is working right now", fed by the bridge's
// hermes.events.stream. Powers the working indicators on every screen and the
// native notification when a reply lands somewhere the user isn't looking.
// ---------------------------------------------------------------------------

export const activityKey = (agentId: string, chatId: string): string =>
  `${agentId}\u0000${chatId}`;

export type CompletedTurn = {
  agentId: string;
  chatId: string;
  at: number;
  preview?: string;
  failureReason?: string;
  /** Monotonic, so effects can react to each completion exactly once. */
  seq: number;
};

export interface ActivityState {
  /** `activityKey(agentId, chatId)` for every turn running right now. */
  running: ReadonlySet<string>;
  /** Agent ids with at least one running turn. */
  runningAgents: ReadonlySet<string>;
  /** The most recent completion seen (null before the first one). */
  lastCompleted: CompletedTurn | null;
  /**
   * Bumped on every activity-stream snapshot (each (re)open of the stream
   * starts with one) — the "bridge ground truth just refreshed" signal open
   * screens use to reconcile stale local state after a reconnect.
   */
  snapshotSeq: number;
}

const EMPTY_ACTIVITY: ActivityState = {
  running: new Set(),
  runningAgents: new Set(),
  lastCompleted: null,
  snapshotSeq: 0,
};

const ActivityContext = createContext<ActivityState>(EMPTY_ACTIVITY);

export function useActivity(): ActivityState {
  return useContext(ActivityContext);
}

function withRunning(
  previous: ActivityState,
  running: Set<string>,
  lastCompleted: CompletedTurn | null = previous.lastCompleted,
): ActivityState {
  const runningAgents = new Set<string>();
  for (const key of running) {
    const agentId = key.split("\u0000")[0];
    if (agentId) runningAgents.add(agentId);
  }
  return {
    running,
    runningAgents,
    lastCompleted,
    snapshotSeq: previous.snapshotSeq,
  };
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<HermesConfig | null>(null);
  const [client, setClient] = useState<HermesChatClient | null>(null);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [stack, setStack] = useState<Screen[]>([{ kind: "connect" }]);
  // Bumped to force a full reconnect (fresh transport + relay sockets) — e.g.
  // when the app returns from the background, where the OS may have killed the
  // WebSockets, leaving a dead client that silently times out.
  const [generation, setGeneration] = useState(0);
  const [activity, setActivity] = useState<ActivityState>(EMPTY_ACTIVITY);
  const [resumedAt, setResumedAt] = useState(0);
  const isActiveRef = useRef(true);
  const stackRef = useRef<Screen[]>(stack);
  stackRef.current = stack;
  const completedSeqRef = useRef(0);
  // Tracks the live client so a background→foreground reconnect can hot-swap
  // a fresh transport without ever dropping hasClient to false (which would
  // unmount ChatScreen and lose the open conversation).
  const clientRef = useRef<HermesChatClient | null>(null);
  const clientWaitersRef = useRef(
    new Set<(client: HermesChatClient) => void>(),
  );
  // Detects whether the effect re-ran because config changed (→ full teardown)
  // or because generation bumped (→ hot-swap, same config).
  const prevConfigRef = useRef<HermesConfig | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;
  const reconnect = useCallback(() => {
    setConfig((current) => {
      if (current) setGeneration((value) => value + 1);
      return current;
    });
  }, []);
  const lastReconnectAtRef = useRef(0);
  const reconnectOnce = useCallback(() => {
    const now = Date.now();
    if (now - lastReconnectAtRef.current < 1500) return;
    lastReconnectAtRef.current = now;
    reconnect();
  }, [reconnect]);

  // Restore the on-device identity and auto-connect. The shipped single-user
  // config is only a first-run/corrupt-storage fallback; a successful manual
  // connection must survive WebView recreation and app restarts.
  useEffect(() => {
    void Preferences.get({ key: STORAGE_KEY })
      .then(({ value }) => setConfig(restoreStoredConfig(value)))
      .catch(() => setConfig(DEFAULT_CONFIG))
      .finally(() => setReady(true));
  }, []);

  // Establish (or tear down) the ContextVM connection whenever config changes.
  // On a background→foreground reconnect (generation bump, same config) the
  // OLD client is kept alive until the NEW one is ready, so hasClient never
  // drops to false — the ChatScreen never unmounts and the open conversation
  // survives a screen lock. On a genuine config change the old client is torn
  // down up front.
  useEffect(() => {
    const isHotSwap =
      prevConfigRef.current &&
      config &&
      sameConnection(prevConfigRef.current, config);
    prevConfigRef.current = config;

    const previousClient = isHotSwap ? clientRef.current : null;
    if (!isHotSwap) {
      // Full teardown (config change or disconnect): retire the old client
      // here, in the body — NOT in the cleanup, so a hot-swap run can still
      // adopt it as previousClient before we touch it.
      void clientRef.current?.close().catch(() => undefined);
      setClient(null);
      clientRef.current = null;
    }

    if (!config) {
      setStatus("idle");
      return;
    }
    let cancelled = false;
    let activeClient: HermesChatClient | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // Only show the connecting/loading gate when there is no client to fall
    // back on. During a hot-swap the previous client stays live so the user
    // keeps seeing their conversation.
    if (!previousClient) setStatus("connecting");
    setError(null);

    // The ContextVM handshake over remote relays is occasionally lossy on
    // mobile networks. Retry a few short attempts, closing each failed client
    // so nothing lingers, before surfacing an error.
    const PER_ATTEMPT_MS = 12_000;
    const MAX_ATTEMPTS = 4;
    const sleep = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));

    void (async () => {
      let lastError: unknown = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS && !cancelled; attempt++) {
        const candidate = makeClient(config);
        try {
          await Promise.race([
            candidate.connect(),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error("connect attempt timed out")),
                PER_ATTEMPT_MS,
              ),
            ),
          ]);
          if (cancelled) {
            void candidate.close().catch(() => undefined);
            return;
          }
          activeClient = candidate;
          clientRef.current = candidate;
          setClient(candidate);
          for (const waiter of clientWaitersRef.current) waiter(candidate);
          clientWaitersRef.current.clear();
          setStatus("connected");
          // Now that the fresh client is live, retire the previous one used as
          // a hot-swap fallback. Its open streams will reject; consumers (e.g.
          // ChatScreen.send) treat that as a non-fatal interruption.
          void previousClient?.close().catch(() => undefined);
          return;
        } catch (cause) {
          lastError = cause;
          // Fully tear down (await!) before retrying: the next attempt reuses
          // the same pubkey, so a lingering relay subscription from this
          // attempt would collide and swallow the next response.
          await candidate.close().catch(() => undefined);
          if (cancelled) return;
          if (attempt < MAX_ATTEMPTS) await sleep(1500);
        }
      }
      if (cancelled) return;
      // All attempts failed. During a hot-swap, keep the previous client live
      // rather than dropping the user into a recovery screen — schedule a
      // delayed retry so we don't sit on a dead transport forever.
      if (previousClient) {
        clientRef.current = previousClient;
        setClient(previousClient);
        if (statusRef.current === "connected") setStatus("connected");
        // Bump generation again after a delay to force another hot-swap
        // attempt.
        retryTimer = setTimeout(() => {
          if (!cancelled) setGeneration((g) => g + 1);
        }, 5000);
        return;
      }
      setStatus("error");
      const base =
        lastError instanceof Error &&
        lastError.message !== "connect attempt timed out"
          ? lastError.message
          : "Couldn't reach the bridge after several tries. Check the bridge is running.";
      void probeRelays(config.relays)
        .then((results) => {
          if (cancelled) return;
          const summary = results
            .map(
              (r) =>
                `${r.url.replace(/^wss?:\/\//, "")} ${r.ok ? `✓ ${r.ms}ms` : "✗"}`,
            )
            .join("  ·  ");
          const reachable = results.filter((r) => r.ok).length;
          setError(
            reachable === 0
              ? `${base}\n\nThis device could not reach any relay:\n${summary}\n\nCheck the phone's internet/firewall.`
              : `${base}\n\nRelays reachable from this device:\n${summary}`,
          );
        })
        .catch(() => {
          if (!cancelled) setError(base);
        });
    })();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      // Never close clientRef.current here — a hot-swap run needs to adopt it
      // as its previousClient. Only close a candidate that lost the race
      // (never became active, or was a failed retry attempt the loop already
      // closed — closing again is a harmless no-op).
      if (activeClient && activeClient !== clientRef.current) {
        void activeClient.close().catch(() => undefined);
      }
    };
  }, [config, generation]);

  // Reconnect after the app has genuinely been backgrounded and comes back —
  // the OS tears down WebSockets in the background. Only on a real
  // background→foreground transition, and never mid-handshake.
  useEffect(() => {
    let wasBackgrounded = false;
    let resumeTimer: ReturnType<typeof setTimeout> | null = null;
    const onBackground = () => {
      wasBackgrounded = true;
      if (resumeTimer) {
        clearTimeout(resumeTimer);
        resumeTimer = null;
      }
    };
    const onForeground = () => {
      if (!wasBackgrounded) return;
      wasBackgrounded = false;
      // Let open screens revalidate immediately — even if the reconnect below
      // ends up skipped or fails over to the same client object, in which
      // case no client-change effect would ever fire.
      setResumedAt((value) => value + 1);
      resumeTimer = setTimeout(() => {
        resumeTimer = null;
        if (statusRef.current !== "connecting") reconnect();
      }, 1500);
    };
    const handle = CapApp.addListener("appStateChange", ({ isActive }) => {
      isActiveRef.current = isActive;
      if (isActive) onForeground();
      else onBackground();
    });
    // Web-standard fallback: some devices/routes (split-screen, PiP, quick
    // recents swipe, WebView re-attach) fire visibilitychange without a
    // matching appStateChange — and the OS tears down WebSockets in both.
    const onVisibility = () => {
      const visible = document.visibilityState === "visible";
      isActiveRef.current = visible;
      if (visible) onForeground();
      else onBackground();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (resumeTimer) clearTimeout(resumeTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      void handle.then((listener) => listener.remove());
    };
  }, [reconnect]);

  // A transport failure is not logout. Keep retrying the stored session and
  // preserve its navigation until the user explicitly disconnects.
  useEffect(() => {
    if (!config || status !== "error") return;
    const timer = setTimeout(reconnect, 5000);
    return () => clearTimeout(timer);
  }, [config, status, reconnect]);

  // App-wide activity stream: reopen with a short backoff for as long as this
  // client lives; each (re)open starts from the bridge's snapshot so the
  // indicators can never go stale across reconnects.
  useEffect(() => {
    if (!client) {
      setActivity(EMPTY_ACTIVITY);
      return;
    }
    let cancelled = false;
    let current: HermesActivityStream | null = null;
    void initNotifications();

    const handleEvent = (event: HermesActivityEvent) => {
      if (event.type === "activity.snapshot") {
        setActivity((previous) => ({
          ...withRunning(
            previous,
            new Set(
              event.turns.map((turn) => activityKey(turn.agentId, turn.chatId)),
            ),
          ),
          snapshotSeq: previous.snapshotSeq + 1,
        }));
        return;
      }
      if (event.type === "turn.started") {
        setActivity((previous) => {
          const running = new Set(previous.running);
          running.add(activityKey(event.agentId, event.chatId));
          return withRunning(previous, running);
        });
        return;
      }
      if (event.type !== "turn.completed") return;

      const completed: CompletedTurn = {
        agentId: event.agentId,
        chatId: event.chatId,
        at: event.at,
        preview: event.preview,
        failureReason: event.failureReason,
        seq: ++completedSeqRef.current,
      };
      setActivity((previous) => {
        const running = new Set(previous.running);
        running.delete(activityKey(event.agentId, event.chatId));
        return withRunning(previous, running, completed);
      });

      // Notify unless the user is actively looking at that very conversation.
      const top = stackRef.current[stackRef.current.length - 1];
      const viewingThisChat =
        isActiveRef.current &&
        top?.kind === "chat" &&
        top.agentId === event.agentId &&
        top.chatId === event.chatId;
      if (viewingThisChat) return;
      const agentName = displayAgentName(event.agentId);
      void notify(
        notificationId(activityKey(event.agentId, event.chatId)),
        event.failureReason
          ? `${agentName} — turn failed`
          : `${agentName} replied`,
        event.preview ??
          event.failureReason ??
          "Open the conversation to read it.",
      );
    };

    void (async () => {
      while (!cancelled) {
        try {
          const stream = await client.streamActivity();
          if (cancelled) {
            void stream.abort("teardown");
            return;
          }
          current = stream;
          for await (const event of stream.events) {
            if (cancelled) break;
            handleEvent(event);
          }
        } catch {
          // transient relay hiccup — retry below
        }
        current = null;
        if (cancelled) break;
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    })();

    return () => {
      cancelled = true;
      void current?.abort("teardown");
    };
  }, [client]);

  useEffect(() => {
    if (status === "connected") {
      setStack((current) =>
        current[0]?.kind === "connect" ? [{ kind: "agents" }] : current,
      );
    } else if (!config && status === "idle") {
      setStack([{ kind: "connect" }]);
    }
  }, [config, status]);

  const push = useCallback((screen: Screen) => {
    setStack((current) => [...current, screen]);
  }, []);

  const pop = useCallback(() => {
    setStack((current) =>
      current.length > 1 ? current.slice(0, -1) : current,
    );
  }, []);

  const replaceTop = useCallback((screen: Screen) => {
    setStack((current) =>
      current.length ? [...current.slice(0, -1), screen] : [screen],
    );
  }, []);

  const reset = useCallback((screen: Screen) => {
    setStack([screen]);
  }, []);

  useEffect(() => {
    const listener = CapApp.addListener("backButton", () => {
      setStack((current) => {
        if (current.length > 1) return current.slice(0, -1);
        void CapApp.exitApp();
        return current;
      });
    });
    return () => {
      void listener.then((handle) => handle.remove());
    };
  }, []);

  const connect = useCallback((next: HermesConfig) => {
    void Preferences.set({ key: STORAGE_KEY, value: JSON.stringify(next) });
    setConfig(next);
  }, []);

  const disconnect = useCallback(() => {
    void Preferences.remove({ key: STORAGE_KEY });
    setConfig(null);
    setStack([{ kind: "connect" }]);
  }, []);

  const nav = useMemo(
    () => ({ stack, push, pop, replaceTop, reset }),
    [stack, push, pop, replaceTop, reset],
  );
  const waitForClient = useCallback(
    (
      options: {
        timeoutMs?: number;
        signal?: AbortSignal;
        forceReconnect?: boolean;
      } = {},
    ) => {
      const timeoutMs = options.timeoutMs ?? 30_000;
      if (clientRef.current && !options.forceReconnect) {
        return Promise.resolve(clientRef.current);
      }
      // Keep the stale client mounted while a fresh candidate connects. The
      // hot-swap effect retires it only after replacement, so ChatScreen and
      // the in-flight resumable upload are not unmounted/aborted.
      reconnectOnce();
      return new Promise<HermesChatClient>((resolve, reject) => {
        let settled = false;
        const waiter = (next: HermesChatClient) => {
          if (settled) return;
          settled = true;
          clientWaitersRef.current.delete(waiter);
          options.signal?.removeEventListener("abort", onAbort);
          clearTimeout(timer);
          resolve(next);
        };
        const onAbort = () => {
          if (settled) return;
          settled = true;
          clientWaitersRef.current.delete(waiter);
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        };
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          clientWaitersRef.current.delete(waiter);
          options.signal?.removeEventListener("abort", onAbort);
          reject(new Error("Timed out reconnecting to the bridge"));
        }, timeoutMs);
        clientWaitersRef.current.add(waiter);
        options.signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
    [reconnectOnce],
  );

  const connection = useMemo(
    () => ({
      config,
      client,
      waitForClient,
      ready,
      status,
      error,
      connect,
      reconnect,
      disconnect,
      resumedAt,
    }),
    [
      config,
      client,
      waitForClient,
      ready,
      status,
      error,
      connect,
      reconnect,
      disconnect,
      resumedAt,
    ],
  );

  return (
    <ConnectionContext.Provider value={connection}>
      <ActivityContext.Provider value={activity}>
        <NavContext.Provider value={nav}>{children}</NavContext.Provider>
      </ActivityContext.Provider>
    </ConnectionContext.Provider>
  );
}

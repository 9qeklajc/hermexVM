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
import { focusManager, useQueryClient } from "@tanstack/react-query";
import { makeClient, probeRelays, type HermesConfig } from "./api";
import {
  type HermesActivityEvent,
  type HermesActivityStream,
  type HermesChatClient,
} from "@contexcgi/client";
import { displayAgentName } from "./chat";
import { initNotifications, notificationId, notify } from "./notify";
import {
  activeBridgeProfile,
  addBridgeProfile,
  createStoredConnections,
  deleteBridgeProfile,
  parseStoredConnections,
  sameBridgeIdentity,
  switchBridgeProfile,
  updateBridgeProfile,
  type BridgeProfile,
  type StoredConnections,
} from "./bridge-profiles";
import {
  UI_CACHE_STORAGE_KEY,
  cacheRoute,
  clearUiRouteCache,
  configureUiRouteCache,
  getCachedRoute,
  parseUiRouteCache,
  type CachedRoute,
  type UiRouteCache,
} from "./ui-cache";
import {
  clearAllQueryCache,
  queryKeys,
  removeBridgeQueryCache,
  saveQueryCache,
} from "./query";
import { isCurrentTransport, shouldRunActivityStream } from "./mobile-state";

// ---------------------------------------------------------------------------
// Navigation — a simple mobile screen stack with Android back support.
// ---------------------------------------------------------------------------

export type Screen =
  | { kind: "connect" }
  | { kind: "agents" }
  | { kind: "settings" }
  | {
      kind: "profile-settings";
      agentId: string;
      agentName: string;
      currentModel?: string;
    }
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
  bridges: BridgeProfile[];
  activeBridgeId: string | null;
  activeBridgeName: string | null;
  client: HermesChatClient | null;
  waitForClient: (options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
    forceReconnect?: boolean;
  }) => Promise<HermesChatClient>;
  ready: boolean; // persisted config has been loaded
  status: ConnectionStatus;
  /** True while a retained foreground client is read-only pending replacement. */
  transportReplacing: boolean;
  /** Synchronous boundary check for results issued by a specific client. */
  isClientCurrent: (candidate: HermesChatClient) => boolean;
  error: string | null;
  connect: (config: HermesConfig, name?: string) => Promise<void>;
  addBridge: (name: string, config: HermesConfig) => void;
  updateBridge: (
    id: string,
    name: string,
    config: HermesConfig,
  ) => Promise<void>;
  switchBridge: (id: string) => void;
  deleteBridge: (id: string) => Promise<void>;
  reconnect: () => void;
  disconnect: () => Promise<void>;
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

// v2 intentionally invalidates the legacy build's shared embedded identity.
const STORAGE_KEY = "hermexvm.connections.contextvm.v3";
const LEGACY_STORAGE_KEY = "hermexvm.connection.contextvm.v2";

/**
 * Two configs point at the same bridge/session when their identity + relays
 * match — used to distinguish a background→foreground reconnect (same session,
 * → hot-swap: keep the old client alive) from a genuine config change (→ full
 * teardown). Deep-equal on the relays array so reordering doesn't count.
 */
function cachedRouteStack(route: CachedRoute | null): Screen[] {
  if (!route || route.kind === "agents") return [{ kind: "agents" }];
  const chats: Screen = {
    kind: "chats",
    agentId: route.agentId,
    agentName: route.agentName,
  };
  if (route.kind === "chats") return [{ kind: "agents" }, chats];
  return [{ kind: "agents" }, chats, route];
}

function sameConnection(a: HermesConfig, b: HermesConfig): boolean {
  if (a.privateKey !== b.privateKey) return false;
  if (a.serverPubkey !== b.serverPubkey) return false;
  if (a.relays.length !== b.relays.length) return false;
  return a.relays.every((r, i) => r === b.relays[i]);
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
  const queryClient = useQueryClient();
  const [connections, setConnections] = useState<StoredConnections | null>(
    null,
  );
  const [config, setConfig] = useState<HermesConfig | null>(null);
  const [client, setClient] = useState<HermesChatClient | null>(null);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [transportReplacing, setTransportReplacing] = useState(false);
  const transportReplacingRef = useRef(false);
  const setTransportReplacement = useCallback(
    (replacing: boolean) => {
      transportReplacingRef.current = replacing;
      if (replacing) {
        const bridgeId = connections?.activeId;
        if (bridgeId) {
          void queryClient.cancelQueries(
            { queryKey: queryKeys.bridge(bridgeId) },
            { silent: true },
          );
        }
      }
      setTransportReplacing(replacing);
    },
    [connections?.activeId, queryClient],
  );
  const [error, setError] = useState<string | null>(null);
  const [stack, setStack] = useState<Screen[]>([{ kind: "connect" }]);
  // Bumped to force a full reconnect (fresh transport + relay sockets) — e.g.
  // when the app returns from the background, where the OS may have killed the
  // WebSockets, leaving a dead client that silently times out.
  const [generation, setGeneration] = useState(0);
  const [activity, setActivity] = useState<ActivityState>(EMPTY_ACTIVITY);
  const writeRouteCache = useCallback(
    (cache: UiRouteCache) =>
      Preferences.set({
        key: UI_CACHE_STORAGE_KEY,
        value: JSON.stringify(cache),
      }),
    [],
  );
  const activateRouteCache = useCallback(
    async (bridgeId: string) => {
      configureUiRouteCache(bridgeId, null, writeRouteCache);
      await cacheRoute({ kind: "agents" });
    },
    [writeRouteCache],
  );
  const isActiveRef = useRef(true);
  const stackRef = useRef<Screen[]>(stack);
  stackRef.current = stack;
  const completedSeqRef = useRef(0);
  // Tracks the live client so a background→foreground reconnect can hot-swap
  // a fresh transport without ever dropping hasClient to false (which would
  // unmount ChatScreen and lose the open conversation).
  const clientRef = useRef<HermesChatClient | null>(null);
  const isClientCurrent = useCallback(
    (candidate: HermesChatClient) =>
      isCurrentTransport(
        candidate,
        clientRef.current,
        transportReplacingRef.current,
      ),
    [],
  );
  const clientWaitersRef = useRef(
    new Set<(client: HermesChatClient) => void>(),
  );
  // Detects whether the effect re-ran because config changed (→ full teardown)
  // or because generation bumped (→ hot-swap, same config).
  const prevConfigRef = useRef<HermesConfig | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;
  const reconnect = useCallback(() => {
    if (clientRef.current) setTransportReplacement(true);
    focusManager.setFocused(false);
    setConfig((current) => {
      if (current) setGeneration((value) => value + 1);
      return current;
    });
  }, [setTransportReplacement]);
  const lastReconnectAtRef = useRef(0);
  const reconnectOnce = useCallback(() => {
    const now = Date.now();
    if (now - lastReconnectAtRef.current < 1500) return;
    lastReconnectAtRef.current = now;
    reconnect();
  }, [reconnect]);

  // Restore a successful on-device connection. Fresh or corrupt installs stay
  // disconnected and show setup, where a unique client identity is generated.
  useEffect(() => {
    void Promise.all([
      Preferences.get({ key: STORAGE_KEY }),
      Preferences.get({ key: LEGACY_STORAGE_KEY }),
      Preferences.get({ key: UI_CACHE_STORAGE_KEY }),
    ])
      .then(([current, legacy, cachedUi]) => {
        const restored =
          parseStoredConnections(current.value) ??
          parseStoredConnections(legacy.value);
        const active = activeBridgeProfile(restored);
        setConnections(restored);
        setConfig(active?.config ?? null);
        if (active) {
          configureUiRouteCache(
            active.id,
            parseUiRouteCache(cachedUi.value, active.id),
            writeRouteCache,
          );
          setStack(cachedRouteStack(getCachedRoute()));
        }
        if (restored && !current.value) {
          void Preferences.set({
            key: STORAGE_KEY,
            value: JSON.stringify(restored),
          });
          void Preferences.remove({ key: LEGACY_STORAGE_KEY });
        }
      })
      .catch(() => {
        setConnections(null);
        setConfig(null);
      })
      .finally(() => setReady(true));
  }, [writeRouteCache]);

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
    setTransportReplacement(Boolean(previousClient));
    if (!isHotSwap) {
      // Full teardown (config change or disconnect): retire the old client
      // here, in the body — NOT in the cleanup, so a hot-swap run can still
      // adopt it as previousClient before we touch it.
      void clientRef.current?.close().catch(() => undefined);
      setClient(null);
      clientRef.current = null;
    }

    if (!config) {
      setTransportReplacement(false);
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
          setTransportReplacement(false);
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
      setTransportReplacement(false);
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
  }, [config, generation, setTransportReplacement]);

  // Restore Query focus only after React has committed the replacement client.
  // Foreground events leave focus false so no query reaches the retained stale
  // socket during the reconnect window.
  useEffect(() => {
    focusManager.setFocused(
      isActiveRef.current &&
        status === "connected" &&
        Boolean(client) &&
        !transportReplacing,
    );
  }, [client, status, transportReplacing]);

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
      if (clientRef.current) setTransportReplacement(true);
      focusManager.setFocused(false);
      resumeTimer = setTimeout(() => {
        resumeTimer = null;
        if (statusRef.current !== "connecting") reconnect();
      }, 1500);
    };
    const handle = CapApp.addListener("appStateChange", ({ isActive }) => {
      isActiveRef.current = isActive;
      if (isActive) onForeground();
      else {
        focusManager.setFocused(false);
        onBackground();
      }
    });
    // Web-standard fallback: some devices/routes (split-screen, PiP, quick
    // recents swipe, WebView re-attach) fire visibilitychange without a
    // matching appStateChange — and the OS tears down WebSockets in both.
    const onVisibility = () => {
      const visible = document.visibilityState === "visible";
      isActiveRef.current = visible;
      if (visible) onForeground();
      else {
        focusManager.setFocused(false);
        onBackground();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (resumeTimer) clearTimeout(resumeTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      void handle.then((listener) => listener.remove());
    };
  }, [reconnect, setTransportReplacement]);

  // A transport failure is not logout. Keep retrying the stored session and
  // preserve its navigation until the user explicitly disconnects.
  useEffect(() => {
    if (!config || status !== "error") return;
    const timer = setTimeout(reconnect, 5000);
    return () => clearTimeout(timer);
  }, [config, status, reconnect]);

  // App-wide activity stream: reopen with a short backoff for as long as the
  // committed client is usable. Entering replacement reruns this effect, whose
  // cleanup aborts the retained client's stream before a stale snapshot can
  // trigger screen reconciliation.
  useEffect(() => {
    if (!client) {
      setActivity(EMPTY_ACTIVITY);
      return;
    }
    if (!shouldRunActivityStream(true, transportReplacing)) return;
    let cancelled = false;
    let current: HermesActivityStream | null = null;
    void initNotifications();

    const handleEvent = (event: HermesActivityEvent) => {
      if (!isClientCurrent(client)) return;
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
        if (!isClientCurrent(client)) break;
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
  }, [client, isClientCurrent, transportReplacing]);

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

  const persistConnections = useCallback((next: StoredConnections | null) => {
    if (next) {
      void Preferences.set({ key: STORAGE_KEY, value: JSON.stringify(next) });
    } else {
      void Preferences.remove({ key: STORAGE_KEY });
    }
    setConnections(next);
    setConfig(activeBridgeProfile(next)?.config ?? null);
  }, []);

  const connect = useCallback(
    async (next: HermesConfig, name?: string) => {
      const active = activeBridgeProfile(connections);
      const identityChanged = Boolean(
        active && !sameBridgeIdentity(active.config, next),
      );
      if (active && identityChanged) {
        removeBridgeQueryCache(queryClient, active.id);
        await saveQueryCache(queryClient);
      }
      const updated = connections
        ? updateBridgeProfile(
            connections,
            connections.activeId,
            name?.trim() || active?.name || "My bridge",
            next,
          )
        : createStoredConnections(name?.trim() || "My bridge", next);
      if (!active || identityChanged) {
        await activateRouteCache(updated.activeId);
        setStack([{ kind: "agents" }]);
      }
      persistConnections(updated);
    },
    [activateRouteCache, connections, persistConnections, queryClient],
  );

  const addBridge = useCallback(
    (name: string, next: HermesConfig) => {
      const updated = connections
        ? addBridgeProfile(connections, name, next)
        : createStoredConnections(name, next);
      void activateRouteCache(updated.activeId);
      persistConnections(updated);
      setStack([{ kind: "agents" }]);
    },
    [activateRouteCache, connections, persistConnections],
  );

  const updateBridge = useCallback(
    async (id: string, name: string, next: HermesConfig) => {
      if (!connections) throw new Error("No bridge profile is loaded");
      const current = connections.profiles.find((profile) => profile.id === id);
      if (!current) throw new Error("Bridge profile was not found");

      const relaysChanged =
        current.config.relays.length !== next.relays.length ||
        current.config.relays.some(
          (relay, index) => relay !== next.relays[index],
        );
      const identityUnchanged = sameBridgeIdentity(current.config, next);
      if (id === connections.activeId && relaysChanged && identityUnchanged) {
        const activeClient = clientRef.current;
        if (activeClient) {
          await activeClient.ensureBridgeRelays(next.relays);
        }
      }

      if (!identityUnchanged) {
        removeBridgeQueryCache(queryClient, id);
        await saveQueryCache(queryClient);
      }
      const updated = updateBridgeProfile(connections, id, name, next);
      if (!identityUnchanged && id === connections.activeId) {
        await activateRouteCache(id);
        setStack([{ kind: "agents" }]);
      }
      persistConnections(updated);
    },
    [activateRouteCache, connections, persistConnections, queryClient],
  );

  const switchBridge = useCallback(
    (id: string) => {
      if (!connections || id === connections.activeId) return;
      void activateRouteCache(id);
      persistConnections(switchBridgeProfile(connections, id));
      setStack([{ kind: "agents" }]);
    },
    [activateRouteCache, connections, persistConnections],
  );

  const deleteBridge = useCallback(
    async (id: string) => {
      if (!connections) return;
      const updated = deleteBridgeProfile(connections, id);
      if (updated) {
        removeBridgeQueryCache(queryClient, id);
        await saveQueryCache(queryClient);
        if (id === connections.activeId) {
          await activateRouteCache(updated.activeId);
        }
      } else {
        await clearAllQueryCache(queryClient);
        await Preferences.remove({ key: UI_CACHE_STORAGE_KEY });
        clearUiRouteCache();
      }
      persistConnections(updated);
      setStack([{ kind: updated ? "agents" : "connect" }]);
    },
    [activateRouteCache, connections, persistConnections, queryClient],
  );

  const disconnect = useCallback(async () => {
    await clearAllQueryCache(queryClient);
    await Promise.all([
      Preferences.remove({ key: STORAGE_KEY }),
      Preferences.remove({ key: LEGACY_STORAGE_KEY }),
      Preferences.remove({ key: UI_CACHE_STORAGE_KEY }),
    ]);
    clearUiRouteCache();
    setConnections(null);
    setConfig(null);
    setStack([{ kind: "connect" }]);
  }, [queryClient]);

  useEffect(() => {
    const top = stack[stack.length - 1];
    if (!top) return;
    if (top.kind === "agents" || top.kind === "chats") {
      void cacheRoute(top);
    } else if (top.kind === "chat" && top.chatId) {
      void cacheRoute({ ...top, chatId: top.chatId });
    }
  }, [stack]);

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
      if (
        clientRef.current &&
        !transportReplacingRef.current &&
        !options.forceReconnect
      ) {
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
      bridges: connections?.profiles ?? [],
      activeBridgeId: connections?.activeId ?? null,
      activeBridgeName: activeBridgeProfile(connections)?.name ?? null,
      client,
      waitForClient,
      ready,
      status,
      transportReplacing,
      isClientCurrent,
      error,
      connect,
      addBridge,
      updateBridge,
      switchBridge,
      deleteBridge,
      reconnect,
      disconnect,
    }),
    [
      config,
      connections,
      client,
      waitForClient,
      ready,
      status,
      transportReplacing,
      isClientCurrent,
      error,
      connect,
      addBridge,
      updateBridge,
      switchBridge,
      deleteBridge,
      reconnect,
      disconnect,
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

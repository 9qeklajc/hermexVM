import { useState, type ReactNode } from "react";
import { Preferences } from "@capacitor/preferences";
import { QueryClient } from "@tanstack/react-query";
import type {
  HermesChatClient,
  HermesChatHistoryResult,
} from "@contexcgi/client";
import {
  PersistQueryClientProvider,
  persistQueryClientSave,
  type PersistedClient,
  type Persister,
} from "@tanstack/react-query-persist-client";
import { isTransientTransportError } from "./errors";

const DAY_MS = 24 * 60 * 60 * 1000;
const QUERY_CACHE_KEY = "hermexvm.react-query.v1";
const QUERY_CACHE_BUSTER = "hermes-chat-v1";

export type QueryCacheStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<unknown>;
  removeItem(key: string): Promise<unknown>;
};

/**
 * A throttled Query persister with an immediate, serialized destructive-write
 * path. The shared write queue guarantees a purge/flush lands after any write
 * already in progress; cancelling the timer prevents an older queued snapshot
 * from being restored after identity rotation or logout.
 */
export function createQueryCachePersistence(
  storage: QueryCacheStorage,
  {
    key = QUERY_CACHE_KEY,
    throttleMs = 1000,
  }: { key?: string; throttleMs?: number } = {},
): {
  persister: Persister;
  saveNow(queryClient: QueryClient): Promise<void>;
  clearNow(queryClient: QueryClient): Promise<void>;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: PersistedClient | null = null;
  let writes = Promise.resolve<unknown>(undefined);

  const cancelPending = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = null;
  };
  const enqueue = (write: () => Promise<unknown>): Promise<void> => {
    const next = writes.then(write, write);
    writes = next.catch(() => undefined);
    return next.then(() => undefined);
  };
  const writeClient = (client: PersistedClient) =>
    enqueue(() => storage.setItem(key, JSON.stringify(client)));
  const immediatePersister: Persister = {
    persistClient(client) {
      cancelPending();
      return writeClient(client);
    },
    async restoreClient() {
      const value = await storage.getItem(key);
      return value ? (JSON.parse(value) as PersistedClient) : undefined;
    },
    removeClient() {
      cancelPending();
      return enqueue(() => storage.removeItem(key));
    },
  };
  const persister: Persister = {
    persistClient(client) {
      pending = client;
      if (timer) return Promise.resolve();
      timer = setTimeout(() => {
        timer = null;
        const next = pending;
        pending = null;
        if (next) void writeClient(next);
      }, throttleMs);
      return Promise.resolve();
    },
    restoreClient: immediatePersister.restoreClient,
    removeClient: immediatePersister.removeClient,
  };

  return {
    persister,
    async saveNow(queryClient) {
      await persistQueryClientSave({
        queryClient,
        persister: immediatePersister,
        buster: QUERY_CACHE_BUSTER,
      });
    },
    async clearNow(queryClient) {
      queryClient.clear();
      await immediatePersister.removeClient();
    },
  };
}

const queryCachePersistence = createQueryCachePersistence({
  async getItem(key) {
    return (await Preferences.get({ key })).value;
  },
  async setItem(key, value) {
    await Preferences.set({ key, value });
  },
  async removeItem(key) {
    await Preferences.remove({ key });
  },
});

export const queryKeys = {
  bridge: (bridgeId: string) => ["bridge", bridgeId] as const,
  agents: (bridgeId: string) => ["bridge", bridgeId, "agents"] as const,
  chats: (bridgeId: string, agentId: string) =>
    ["bridge", bridgeId, "agents", agentId, "chats"] as const,
  history: (bridgeId: string, agentId: string, chatId: string) =>
    ["bridge", bridgeId, "agents", agentId, "chats", chatId] as const,
};

export function removeBridgeQueryCache(
  queryClient: QueryClient,
  bridgeId: string,
): void {
  queryClient.removeQueries({ queryKey: queryKeys.bridge(bridgeId) });
}

export function saveQueryCache(queryClient: QueryClient): Promise<void> {
  return queryCachePersistence.saveNow(queryClient);
}

export function clearAllQueryCache(queryClient: QueryClient): Promise<void> {
  return queryCachePersistence.clearNow(queryClient);
}

export function visibleQueryError(
  dataPresent: boolean,
  error: unknown,
): string | null {
  if (dataPresent || !error || isTransientTransportError(error)) return null;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read history across a completion/mutation boundary without joining an older
 * Query or client-level request. Cache only while the issuing client is still
 * current, so a retired mobile socket cannot overwrite its replacement.
 */
export async function fetchAuthoritativeHistory({
  queryClient,
  client,
  bridgeId,
  agentId,
  chatId,
  isCurrent,
}: {
  queryClient: QueryClient;
  client: Pick<HermesChatClient, "chatHistory">;
  bridgeId: string;
  agentId: string;
  chatId: string;
  isCurrent: () => boolean;
}): Promise<HermesChatHistoryResult | null> {
  const queryKey = queryKeys.history(bridgeId, agentId, chatId);
  await queryClient.cancelQueries({ queryKey }, { silent: true });
  const history = await client.chatHistory(agentId, chatId, undefined, {
    fresh: true,
  });
  if (!isCurrent()) return null;
  queryClient.setQueryData(queryKey, history);
  return history;
}

export function QueryProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            gcTime: DAY_MS,
            networkMode: "offlineFirst",
            retry: false,
            refetchOnWindowFocus: true,
            refetchOnReconnect: true,
          },
        },
      }),
  );

  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister: queryCachePersistence.persister,
        maxAge: DAY_MS,
        buster: QUERY_CACHE_BUSTER,
      }}
    >
      {children}
    </PersistQueryClientProvider>
  );
}

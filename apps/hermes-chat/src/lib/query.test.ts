import { QueryClient, dehydrate, hydrate } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { HermesChatHistoryResult } from "./api";
import {
  createQueryCachePersistence,
  fetchAuthoritativeHistory,
  queryKeys,
  removeBridgeQueryCache,
  visibleQueryError,
} from "./query";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const history = (text: string): HermesChatHistoryResult => ({
  agentId: "default",
  chatId: "chat-1",
  messages: [{ role: "assistant", text, ordinal: 1 }],
});

describe("persisted query helpers", () => {
  it("bypasses and supersedes an older in-flight history query", async () => {
    const queryClient = new QueryClient();
    const key = queryKeys.history("bridge-1", "default", "chat-1");
    const old = deferred<HermesChatHistoryResult>();
    const oldRequest = queryClient.fetchQuery({
      queryKey: key,
      queryFn: () => old.promise,
    });
    const client = {
      chatHistory: vi.fn(async () => history("fresh")),
    };

    await expect(
      fetchAuthoritativeHistory({
        queryClient,
        client,
        bridgeId: "bridge-1",
        agentId: "default",
        chatId: "chat-1",
        isCurrent: () => true,
      }),
    ).resolves.toEqual(history("fresh"));

    expect(client.chatHistory).toHaveBeenCalledWith(
      "default",
      "chat-1",
      undefined,
      { fresh: true },
    );
    expect(queryClient.getQueryData(key)).toEqual(history("fresh"));

    old.resolve(history("old"));
    await oldRequest.catch(() => undefined);
    expect(queryClient.getQueryData(key)).toEqual(history("fresh"));
  });

  it("keeps an older pending request cancelled when the newest boundary read fails, then caches its bounded retry", async () => {
    const queryClient = new QueryClient();
    const key = queryKeys.history("bridge-1", "default", "chat-1");
    const old = deferred<HermesChatHistoryResult>();
    const oldRequest = queryClient.fetchQuery({
      queryKey: key,
      queryFn: () => old.promise,
    });
    const client = {
      chatHistory: vi
        .fn()
        .mockRejectedValueOnce(new Error("Request timed out"))
        .mockResolvedValueOnce(history("retried")),
    };
    const options = {
      queryClient,
      client,
      bridgeId: "bridge-1",
      agentId: "default",
      chatId: "chat-1",
      isCurrent: () => true,
    };

    await expect(fetchAuthoritativeHistory(options)).rejects.toThrow(
      "Request timed out",
    );
    old.resolve(history("old"));
    await oldRequest.catch(() => undefined);
    expect(queryClient.getQueryData(key)).toBeUndefined();

    await expect(fetchAuthoritativeHistory(options)).resolves.toEqual(
      history("retried"),
    );
    expect(queryClient.getQueryData(key)).toEqual(history("retried"));
  });

  it("drops a response from a retired client without caching it", async () => {
    const queryClient = new QueryClient();
    const pending = deferred<HermesChatHistoryResult>();
    const client = { chatHistory: vi.fn(() => pending.promise) };
    let current = true;

    const request = fetchAuthoritativeHistory({
      queryClient,
      client,
      bridgeId: "bridge-1",
      agentId: "default",
      chatId: "chat-1",
      isCurrent: () => current,
    });
    current = false;
    pending.resolve(history("stale"));

    await expect(request).resolves.toBeNull();
    expect(
      queryClient.getQueryData(
        queryKeys.history("bridge-1", "default", "chat-1"),
      ),
    ).toBeUndefined();
  });

  it("removes only the selected bridge cache prefix", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.agents("bridge-1"), ["one"]);
    queryClient.setQueryData(queryKeys.agents("bridge-2"), ["two"]);

    removeBridgeQueryCache(queryClient, "bridge-1");

    expect(
      queryClient.getQueryData(queryKeys.agents("bridge-1")),
    ).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.agents("bridge-2"))).toEqual([
      "two",
    ]);
  });

  it("cancels a pending throttled snapshot before an immediate scoped purge", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: vi.fn(async (key: string) => values.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        values.delete(key);
      }),
    };
    const persistence = createQueryCachePersistence(storage, {
      key: "test-cache",
      throttleMs: 60_000,
    });
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.agents("bridge-1"), ["one"]);
    queryClient.setQueryData(queryKeys.agents("bridge-2"), ["two"]);
    void persistence.persister.persistClient({
      timestamp: 1,
      buster: "old",
      clientState: dehydrate(queryClient),
    });

    removeBridgeQueryCache(queryClient, "bridge-1");
    await persistence.saveNow(queryClient);

    expect(storage.setItem).toHaveBeenCalledTimes(1);
    const restored = await persistence.persister.restoreClient();
    const hydrated = new QueryClient();
    hydrate(hydrated, restored!.clientState);
    expect(hydrated.getQueryData(queryKeys.agents("bridge-1"))).toBeUndefined();
    expect(hydrated.getQueryData(queryKeys.agents("bridge-2"))).toEqual([
      "two",
    ]);
  });

  it("serializes clear after an already-running stale write", async () => {
    const values = new Map<string, string>();
    const writeStarted = deferred<void>();
    const releaseWrite = deferred<void>();
    const storage = {
      getItem: vi.fn(async (key: string) => values.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        writeStarted.resolve();
        await releaseWrite.promise;
        values.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        values.delete(key);
      }),
    };
    const persistence = createQueryCachePersistence(storage, {
      key: "test-cache",
      throttleMs: 0,
    });
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.agents("bridge-1"), ["secret"]);
    void persistence.persister.persistClient({
      timestamp: 1,
      buster: "old",
      clientState: dehydrate(queryClient),
    });
    await writeStarted.promise;

    const clearing = persistence.clearNow(queryClient);
    releaseWrite.resolve();
    await clearing;

    expect(values.has("test-cache")).toBe(false);
    expect(storage.removeItem).toHaveBeenCalledOnce();
  });

  it("keeps cached/loading UI for transient query failures", () => {
    expect(visibleQueryError(false, new Error("Request timed out"))).toBeNull();
    expect(visibleQueryError(true, new Error("bad response"))).toBeNull();
    expect(visibleQueryError(false, new Error("bad response"))).toBe(
      "bad response",
    );
  });
});

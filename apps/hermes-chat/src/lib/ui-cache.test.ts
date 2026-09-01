import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cacheRoute,
  configureUiRouteCache,
  getCachedRoute,
  parseUiRouteCache,
  UI_ROUTE_CACHE_MAX_AGE_MS,
  type UiRouteCache,
} from "./ui-cache";

const bridgeId = "bridge-1";
const now = 1_700_000_000_000;
const base: UiRouteCache = {
  version: 2,
  bridgeId,
  updatedAt: now,
  route: { kind: "agents" },
};

describe("UI route cache", () => {
  beforeEach(() => configureUiRouteCache(bridgeId, null, vi.fn()));

  it("restores only a current route belonging to the active bridge", () => {
    expect(parseUiRouteCache(JSON.stringify(base), bridgeId, now)).toEqual(
      base,
    );
    expect(parseUiRouteCache(JSON.stringify(base), "bridge-2", now)).toBeNull();
    expect(parseUiRouteCache("not-json", bridgeId, now)).toBeNull();
  });

  it("rejects expired and previous-version routes", () => {
    expect(
      parseUiRouteCache(
        JSON.stringify(base),
        bridgeId,
        now + UI_ROUTE_CACHE_MAX_AGE_MS + 1,
      ),
    ).toBeNull();
    expect(
      parseUiRouteCache(JSON.stringify({ ...base, version: 1 }), bridgeId, now),
    ).toBeNull();
  });

  it("persists the last useful route", async () => {
    const write = vi.fn();
    configureUiRouteCache(bridgeId, base, write);

    await cacheRoute({
      kind: "chat",
      agentId: "default",
      agentName: "Hermes",
      chatId: "chat-1",
      title: "Fast startup",
    });

    expect(getCachedRoute()).toMatchObject({ kind: "chat", chatId: "chat-1" });
    expect(write).toHaveBeenCalledOnce();
  });
});

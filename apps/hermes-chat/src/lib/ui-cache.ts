export const UI_CACHE_STORAGE_KEY = "hermexvm.ui-route.v2";
export const UI_ROUTE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type CachedRoute =
  | { kind: "agents" }
  | { kind: "chats"; agentId: string; agentName: string }
  | {
      kind: "chat";
      agentId: string;
      agentName: string;
      chatId: string;
      title?: string;
    };

export type UiRouteCache = {
  version: 2;
  bridgeId: string;
  updatedAt: number;
  route: CachedRoute;
};

type Persist = (cache: UiRouteCache) => void | Promise<void>;

let current: UiRouteCache | null = null;
let persist: Persist | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCachedRoute(value: unknown): value is CachedRoute {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "agents") return true;
  if (value.kind === "chats") {
    return (
      typeof value.agentId === "string" && typeof value.agentName === "string"
    );
  }
  return (
    value.kind === "chat" &&
    typeof value.agentId === "string" &&
    typeof value.agentName === "string" &&
    typeof value.chatId === "string" &&
    (value.title === undefined || typeof value.title === "string")
  );
}

export function parseUiRouteCache(
  value: string | null,
  bridgeId: string,
  now = Date.now(),
): UiRouteCache | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !isRecord(parsed) ||
      parsed.version !== 2 ||
      parsed.bridgeId !== bridgeId ||
      typeof parsed.updatedAt !== "number" ||
      !Number.isFinite(parsed.updatedAt) ||
      now - parsed.updatedAt > UI_ROUTE_CACHE_MAX_AGE_MS ||
      !isCachedRoute(parsed.route)
    ) {
      return null;
    }
    return parsed as UiRouteCache;
  } catch {
    return null;
  }
}

export function configureUiRouteCache(
  bridgeId: string,
  restored: UiRouteCache | null,
  write: Persist,
): void {
  current = restored ?? {
    version: 2,
    bridgeId,
    updatedAt: Date.now(),
    route: { kind: "agents" },
  };
  persist = write;
}

export function clearUiRouteCache(): void {
  current = null;
  persist = null;
}

export function getCachedRoute(): CachedRoute | null {
  return current?.route ?? null;
}

export async function cacheRoute(route: CachedRoute): Promise<void> {
  if (!current) return;
  current = { ...current, route, updatedAt: Date.now() };
  await persist?.(current);
}

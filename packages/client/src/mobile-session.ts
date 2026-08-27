export type ContextVmConnectionConfig = {
  privateKey: string;
  serverPubkey: string;
  relays: string[];
};

/**
 * Restores a previously saved mobile connection, using the shipped connection
 * only when no valid on-device session exists.
 */
export function restoreConnectionConfig<T extends ContextVmConnectionConfig>(
  value: string | null,
  fallback: T,
): T {
  if (!value) return fallback;
  try {
    const parsed: unknown = JSON.parse(value);
    if (isConnectionConfig(parsed)) return parsed as T;
  } catch {
    // Corrupt preferences should not prevent the app from starting.
  }
  return fallback;
}

export type MobileConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "error";

export type ConnectionGate =
  | "loading"
  | "login"
  | "reconnecting"
  | "recovery"
  | "content";

export type ConnectionGateInput = {
  ready: boolean;
  hasConfig: boolean;
  hasClient: boolean;
  status: MobileConnectionStatus;
};

/**
 * Keeps authentication separate from transient transport state. A configured
 * session must never return to login merely because an unlock-time reconnect
 * is still running or failed.
 */
export function connectionGate(input: ConnectionGateInput): ConnectionGate {
  if (!input.ready) return "loading";
  if (!input.hasConfig) return "login";
  if (input.hasClient) return "content";
  return input.status === "error" ? "recovery" : "reconnecting";
}

/** True while startup or a background-to-foreground reconnect is in flight. */
export function isConnectionPending(input: ConnectionGateInput): boolean {
  const gate = connectionGate(input);
  return gate === "loading" || gate === "reconnecting";
}

function isConnectionConfig(
  value: unknown,
): value is ContextVmConnectionConfig {
  if (typeof value !== "object" || value === null) return false;
  const config = value as Record<string, unknown>;
  return (
    typeof config.privateKey === "string" &&
    config.privateKey.length > 0 &&
    typeof config.serverPubkey === "string" &&
    config.serverPubkey.length > 0 &&
    Array.isArray(config.relays) &&
    config.relays.length > 0 &&
    config.relays.every(
      (relay) => typeof relay === "string" && relay.length > 0,
    )
  );
}

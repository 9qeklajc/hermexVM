import type { HermesConfig } from "./api";

export interface BridgeProfile {
  id: string;
  name: string;
  config: HermesConfig;
}

export function sameBridgeIdentity(
  left: HermesConfig,
  right: HermesConfig,
): boolean {
  return (
    left.privateKey === right.privateKey &&
    left.serverPubkey === right.serverPubkey
  );
}

export interface StoredConnections {
  version: 3;
  activeId: string;
  profiles: BridgeProfile[];
}

function validConfig(value: unknown): value is HermesConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as Partial<HermesConfig>;
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

function validProfile(value: unknown): value is BridgeProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as Partial<BridgeProfile>;
  return (
    typeof profile.id === "string" &&
    profile.id.length > 0 &&
    typeof profile.name === "string" &&
    profile.name.trim().length > 0 &&
    validConfig(profile.config)
  );
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `bridge-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function parseStoredConnections(
  value: string | null,
): StoredConnections | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (validConfig(parsed)) {
      const profile: BridgeProfile = {
        id: newId(),
        name: "My bridge",
        config: parsed,
      };
      return { version: 3, activeId: profile.id, profiles: [profile] };
    }
    if (!parsed || typeof parsed !== "object") return null;
    const state = parsed as Partial<StoredConnections>;
    if (
      state.version !== 3 ||
      typeof state.activeId !== "string" ||
      !Array.isArray(state.profiles) ||
      state.profiles.length === 0 ||
      !state.profiles.every(validProfile) ||
      !state.profiles.some((profile) => profile.id === state.activeId)
    ) {
      return null;
    }
    return state as StoredConnections;
  } catch {
    return null;
  }
}

export function createStoredConnections(
  name: string,
  config: HermesConfig,
): StoredConnections {
  const profile: BridgeProfile = {
    id: newId(),
    name: name.trim(),
    config,
  };
  return { version: 3, activeId: profile.id, profiles: [profile] };
}

export function addBridgeProfile(
  state: StoredConnections,
  name: string,
  config: HermesConfig,
): StoredConnections {
  const profile: BridgeProfile = { id: newId(), name: name.trim(), config };
  return {
    ...state,
    activeId: profile.id,
    profiles: [...state.profiles, profile],
  };
}

export function updateBridgeProfile(
  state: StoredConnections,
  id: string,
  name: string,
  config: HermesConfig,
): StoredConnections {
  return {
    ...state,
    profiles: state.profiles.map((profile) =>
      profile.id === id ? { ...profile, name: name.trim(), config } : profile,
    ),
  };
}

export function switchBridgeProfile(
  state: StoredConnections,
  id: string,
): StoredConnections {
  return state.profiles.some((profile) => profile.id === id)
    ? { ...state, activeId: id }
    : state;
}

export function deleteBridgeProfile(
  state: StoredConnections,
  id: string,
): StoredConnections | null {
  const profiles = state.profiles.filter((profile) => profile.id !== id);
  if (profiles.length === 0) return null;
  return {
    ...state,
    profiles,
    activeId: state.activeId === id ? profiles[0]!.id : state.activeId,
  };
}

export function activeBridgeProfile(
  state: StoredConnections | null,
): BridgeProfile | null {
  return (
    state?.profiles.find((profile) => profile.id === state.activeId) ?? null
  );
}

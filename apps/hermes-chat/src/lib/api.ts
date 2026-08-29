import { HermesChatClient } from "@contexcgi/client";
import { getPublicKey, nip19 } from "nostr-tools";
import { hexToBytes } from "nostr-tools/utils";

export { HermesChatClient } from "@contexcgi/client";
export type {
  HermesAgentProfile,
  HermesChatEvent,
  HermesChatMessage,
  HermesChatSummary,
  HermesChatTurn,
  HermesClarifyAnswerResult,
  HermesConversationRef,
  HermesHandoffMessageRef,
  HermesHandoffPreview,
  HermesHandoffPreviewInput,
  HermesHandoffRecord,
  HermesHandoffSendInput,
  HermesHandoffSendResult,
  HermesModelOptions,
  HermesModelProvider,
  HermesModelSwitchResult,
  HermesSendResult,
  HermesProject,
  HermesProjectLane,
  HermesProjectRepo,
  HermesProjectsResult,
  HermesSetCwdResult,
  HermesSetTitleResult,
  HermesSkill,
  HermesSkillsResult,
  FileTransferDescriptor,
  ListFileTransfersRequest,
} from "@contexcgi/client";

/** What the app persists and connects with — a ContextVM identity, not HTTP. */
export type HermesConfig = {
  /** Client Nostr secret key (hex or nsec). */
  privateKey: string;
  /** The bridge's Nostr public key (hex, npub, or nprofile). */
  serverPubkey: string;
  /** Relay URLs the bridge is reachable on. */
  relays: string[];
};

// Non-secret deployment defaults may be injected at build time. Client secret
// keys must never be supplied through Vite env: VITE_* values are bundled into
// the public app. Each install generates and persists its own client identity.
export const DEFAULT_RELAYS = parseRelays(
  import.meta.env.VITE_HERMEX_DEFAULT_RELAYS ?? "wss://relay.contextvm.org",
);
export const DEFAULT_SERVER_PUBKEY =
  import.meta.env.VITE_HERMEX_DEFAULT_SERVER_PUBKEY?.trim() ?? "";

function privateKeyBytes(privateKey: string): Uint8Array | null {
  const value = privateKey.trim();
  try {
    const secret = value.startsWith("nsec1")
      ? (() => {
          const decoded = nip19.decode(value);
          if (decoded.type !== "nsec") return null;
          return decoded.data;
        })()
      : hexToBytes(value);
    if (!(secret instanceof Uint8Array) || secret.length !== 32) return null;
    // Also reject out-of-range secp256k1 scalars.
    getPublicKey(secret);
    return secret;
  } catch {
    return null;
  }
}

export function clientNpubFromPrivateKey(privateKey: string): string | null {
  const secret = privateKeyBytes(privateKey);
  return secret ? nip19.npubEncode(getPublicKey(secret)) : null;
}

/** Return the canonical nsec representation used by the settings screen. */
export function clientNsecFromPrivateKey(privateKey: string): string | null {
  const secret = privateKeyBytes(privateKey);
  return secret ? nip19.nsecEncode(secret) : null;
}

/** Normalize a bridge hex/npub/nprofile public key for display and copying. */
export function npubFromPublicKey(publicKey: string): string | null {
  const value = publicKey.trim();
  try {
    if (value.startsWith("npub1")) {
      const decoded = nip19.decode(value);
      return decoded.type === "npub" ? nip19.npubEncode(decoded.data) : null;
    }
    if (value.startsWith("nprofile1")) {
      const decoded = nip19.decode(value);
      return decoded.type === "nprofile"
        ? nip19.npubEncode(decoded.data.pubkey)
        : null;
    }
    if (!/^[0-9a-f]{64}$/i.test(value)) return null;
    return nip19.npubEncode(value.toLowerCase());
  } catch {
    return null;
  }
}

export function parseRelays(input: string): string[] {
  return input
    .split(/[\n,]/)
    .map((relay) => relay.trim())
    .filter(Boolean);
}

export type RelayReachability = {
  url: string;
  ok: boolean;
  ms: number;
  error?: string;
};

/**
 * Open a raw WebSocket to each relay from *this device* and report which ones
 * actually connect — turns a blind "timed out" into a per-relay diagnosis.
 */
export function probeRelays(
  relays: string[],
  timeoutMs = 6000,
): Promise<RelayReachability[]> {
  return Promise.all(
    relays.map(
      (url) =>
        new Promise<RelayReachability>((resolve) => {
          const started = Date.now();
          let settled = false;
          let ws: WebSocket | null = null;
          const done = (ok: boolean, error?: string) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try {
              ws?.close();
            } catch {
              // ignore
            }
            resolve({ url, ok, ms: Date.now() - started, error });
          };
          const timer = setTimeout(
            () => done(false, "no connection within timeout"),
            timeoutMs,
          );
          try {
            ws = new WebSocket(url);
            ws.onopen = () => done(true);
            ws.onerror = () => done(false, "connection error");
          } catch (cause) {
            done(
              false,
              cause instanceof Error ? cause.message : "invalid relay URL",
            );
          }
        }),
    ),
  );
}

export function makeClient(config: HermesConfig): HermesChatClient {
  return new HermesChatClient({
    privateKey: config.privateKey,
    serverPubkey: config.serverPubkey,
    relays: config.relays,
  });
}

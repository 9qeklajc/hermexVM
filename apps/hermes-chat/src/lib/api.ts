import { HermesChatClient } from "@contexcgi/client";

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

// Every relay here MUST answer EOSE quickly — the ContextVM client waits for
// EOSE from ALL relays during connect, so one slow/non-EOSE relay stalls every
// connection. Vetted 2026-08-26: dropped nostr.mom (now requires 28-bit PoW to
// publish, so the bridge can't deliver ContextVM data through it) in favour of
// high-trust, publish-accepting relays. Keep in sync with HERMES_BRIDGE_RELAYS
// in ~/.hermes-bridge/svc.sh.
export const DEFAULT_RELAYS = [
  "wss://relay.contextvm.org",
  "wss://relay.primal.net",
  "wss://relay.otrta.me",
  "wss://relay.ordoplay.com",
  "wss://nostr.azzamo.net",
  "wss://nostr.oxtr.dev",
  "wss://nostr.hifish.org",
];

// Single-user deployment: hardcode the bridge identity and a fixed device
// identity so the app just auto-connects — no typing, no per-attempt random
// key. Mirrors the Paperclip Ops app; the bridge runs as the systemd --user
// unit hermes-bridge.service with its key in ~/.hermes-bridge/bridge.sec.
/** The Hermes bridge's Nostr public key (hex). */
export const DEFAULT_SERVER_PUBKEY =
  "d1b87ad28b1177e58b86c11db2a64d2cae70657383797557840d69d173f83d0f";
/** This device's fixed Nostr secret key — stable identity for this one user. */
export const DEFAULT_CLIENT_KEY =
  "bf64b6a678e022a4cca90c9ad33b66e9cc7604964f808775a1a911b665ebb14c";

/** The auto-connect configuration this build ships with. */
export const DEFAULT_CONFIG: HermesConfig = {
  privateKey: DEFAULT_CLIENT_KEY,
  serverPubkey: DEFAULT_SERVER_PUBKEY,
  relays: DEFAULT_RELAYS,
};

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

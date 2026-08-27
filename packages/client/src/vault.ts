import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ApplesauceRelayPool,
  EncryptionMode,
  NostrClientTransport,
  PrivateKeySigner,
} from "@contextvm/sdk";
import {
  VAULT_PAIR_REQUEST_TOOL_NAME,
  VAULT_PAIR_STATUS_TOOL_NAME,
  VAULT_STATUS_TOOL_NAME,
  VAULT_WALLET_BALANCE_TOOL_NAME,
  VAULT_WALLET_HISTORY_TOOL_NAME,
  VAULT_WALLET_MINTS_TOOL_NAME,
  VAULT_WALLET_RECEIVE_TOOL_NAME,
  VAULT_WALLET_SEND_TOOL_NAME,
  VAULT_WALLET_SYNC_TOOL_NAME,
  type VaultPairRequestInput,
  type VaultPairRequestResult,
  type VaultPairStatusResult,
  type VaultStatus,
  type VaultWalletBalance,
  type VaultWalletHistoryEntry,
  type VaultWalletMint,
  type VaultWalletReceiveResult,
  type VaultWalletSendResult,
} from "@contexcgi/protocol";
import { normalizePrivateKey, normalizePublicKey } from "./index.js";

export type VaultClientConfig = {
  privateKey: string;
  serverPubkey: string;
  relays: string[];
};
export class VaultClient {
  private readonly mcp = new Client({
    name: "nostr-vault-device",
    version: "0.1.0",
  });
  private readonly transport: NostrClientTransport;
  constructor(config: VaultClientConfig) {
    const relays = config.relays;
    this.transport = new NostrClientTransport({
      signer: new PrivateKeySigner(normalizePrivateKey(config.privateKey)),
      relayHandler: new ApplesauceRelayPool(relays, {
        pingFrequencyMs: 2_147_400_000,
      }),
      discoveryRelayUrls: [],
      fallbackOperationalRelayUrls: relays,
      serverPubkey: normalizePublicKey(config.serverPubkey),
      encryptionMode: EncryptionMode.REQUIRED,
    });
    const target = this.transport as unknown as {
      createSubscriptionFilters(
        target: string,
        additional?: Record<string, unknown>,
      ): Array<Record<string, unknown> & { since?: number }>;
    };
    const original = target.createSubscriptionFilters.bind(target);
    target.createSubscriptionFilters = (key, extra = {}) =>
      original(key, extra).map((filter) => ({
        ...filter,
        since: Math.max(
          0,
          (filter.since ?? Math.floor(Date.now() / 1000)) - 3600,
        ),
      }));
  }
  connect(): Promise<void> {
    return this.mcp.connect(this.transport);
  }
  close(): Promise<void> {
    return this.mcp.close();
  }
  requestPairing(
    input: VaultPairRequestInput,
  ): Promise<VaultPairRequestResult> {
    return this.call(VAULT_PAIR_REQUEST_TOOL_NAME, input);
  }
  pairingStatus(requestId: string): Promise<VaultPairStatusResult> {
    return this.call(VAULT_PAIR_STATUS_TOOL_NAME, { requestId });
  }
  status(): Promise<VaultStatus> {
    return this.call(VAULT_STATUS_TOOL_NAME);
  }
  balance(): Promise<VaultWalletBalance> {
    return this.call(VAULT_WALLET_BALANCE_TOOL_NAME);
  }
  async mints(): Promise<VaultWalletMint[]> {
    return this.unwrap(
      await this.call<{ items?: VaultWalletMint[] }>(
        VAULT_WALLET_MINTS_TOOL_NAME,
      ),
    );
  }
  async history(): Promise<VaultWalletHistoryEntry[]> {
    return this.unwrap(
      await this.call<{ items?: VaultWalletHistoryEntry[] }>(
        VAULT_WALLET_HISTORY_TOOL_NAME,
      ),
    );
  }
  // List tools wrap arrays as { items } because structured MCP content must be
  // an object; unwrap them back into plain arrays for callers.
  private unwrap<T>(value: { items?: T[] }): T[] {
    return Array.isArray(value.items) ? value.items : [];
  }
  sync(): Promise<VaultStatus> {
    return this.call(VAULT_WALLET_SYNC_TOOL_NAME);
  }
  // Mutations wait on mint swaps plus relay publishes, so they get a longer
  // deadline than the read tools.
  receive(token: string): Promise<VaultWalletReceiveResult> {
    return this.call(VAULT_WALLET_RECEIVE_TOOL_NAME, { token }, 120_000);
  }
  send(amountSats: number, mint?: string): Promise<VaultWalletSendResult> {
    return this.call(
      VAULT_WALLET_SEND_TOOL_NAME,
      { amountSats, ...(mint ? { mint } : {}) },
      120_000,
    );
  }
  private async call<T>(
    name: string,
    args: Record<string, unknown> = {},
    timeout = 30_000,
  ): Promise<T> {
    const result = await this.mcp.callTool(
      { name, arguments: args },
      undefined,
      { timeout },
    );
    const text = Array.isArray(result.content)
      ? result.content
          .filter(
            (item): item is { type: "text"; text: string } =>
              item.type === "text",
          )
          .map((item) => item.text)
          .join("\n")
      : "";
    if (result.isError) throw new Error(text || `${name} failed`);
    return result.structuredContent as T;
  }
}

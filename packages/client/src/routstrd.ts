import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  ApplesauceRelayPool,
  EncryptionMode,
  NostrClientTransport,
  PrivateKeySigner,
} from "@contextvm/sdk";
import {
  ROUTSTRD_STATUS_TOOL_NAME,
  ROUTSTRD_PING_TOOL_NAME,
  ROUTSTRD_BALANCE_TOOL_NAME,
  ROUTSTRD_WALLET_STATUS_TOOL_NAME,
  ROUTSTRD_WALLET_UNLOCK_TOOL_NAME,
  ROUTSTRD_WALLET_BALANCE_TOOL_NAME,
  ROUTSTRD_WALLET_MINTS_TOOL_NAME,
  ROUTSTRD_WALLET_MINTS_ADD_TOOL_NAME,
  ROUTSTRD_WALLET_MINTS_INFO_TOOL_NAME,
  ROUTSTRD_WALLET_RECEIVE_BOLT11_TOOL_NAME,
  ROUTSTRD_WALLET_SEND_CASHU_TOOL_NAME,
  ROUTSTRD_WALLET_SEND_BOLT11_TOOL_NAME,
  ROUTSTRD_RECEIVE_TOOL_NAME,
  ROUTSTRD_SEND_TOOL_NAME,
  ROUTSTRD_NWC_STATUS_TOOL_NAME,
  ROUTSTRD_NWC_CONNECT_TOOL_NAME,
  ROUTSTRD_NWC_DISCONNECT_TOOL_NAME,
  ROUTSTRD_NWC_FUND_TOOL_NAME,
  ROUTSTRD_NWC_AUTO_REFILL_TOOL_NAME,
  ROUTSTRD_CLIENTS_LIST_TOOL_NAME,
  ROUTSTRD_CLIENTS_ADD_TOOL_NAME,
  ROUTSTRD_CLIENTS_DELETE_TOOL_NAME,
  ROUTSTRD_KEYS_BALANCE_TOOL_NAME,
  ROUTSTRD_PROVIDERS_LIST_TOOL_NAME,
  ROUTSTRD_PROVIDERS_DISABLE_TOOL_NAME,
  ROUTSTRD_PROVIDERS_ENABLE_TOOL_NAME,
  ROUTSTRD_PROVIDERS_REFRESH_TOOL_NAME,
  ROUTSTRD_MODELS_LIST_TOOL_NAME,
  ROUTSTRD_MODEL_PROVIDERS_TOOL_NAME,
  ROUTSTRD_USAGE_TOOL_NAME,
  ROUTSTRD_USAGE_SUMMARY_TOOL_NAME,
  ROUTSTRD_CHAT_COMPLETIONS_TOOL_NAME,
  ROUTSTRD_REFUND_TOOL_NAME,
  ROUTSTRD_REFUND_XCASHU_TOOL_NAME,
  type RoutstrdStatus,
  type RoutstrdWalletBalance,
  type RoutstrdMint,
  type RoutstrdClient as RoutstrdClientRecord,
  type RoutstrdClientBalance,
  type RoutstrdProvider,
  type RoutstrdModel,
  type RoutstrdUsageRecord,
  type RoutstrdUsageSummary,
  type RoutstrdChatCompletionResult,
} from "@contexcgi/protocol";
import { normalizePrivateKey, normalizePublicKey } from "./index.js";

export type RoutstrdClientConfig = {
  privateKey: string;
  serverPubkey: string;
  relays?: string[];
  encryption?: EncryptionMode;
};

export class RoutstrdClient {
  private readonly mcpClient: Client;
  private readonly transport: NostrClientTransport;

  constructor(config: RoutstrdClientConfig) {
    const relays = config.relays ?? [];
    this.transport = new NostrClientTransport({
      signer: new PrivateKeySigner(normalizePrivateKey(config.privateKey)),
      relayHandler: new ApplesauceRelayPool(relays, {
        pingFrequencyMs: 2_147_400_000,
      }),
      discoveryRelayUrls: [],
      fallbackOperationalRelayUrls: relays,
      serverPubkey: normalizePublicKey(config.serverPubkey),
      encryptionMode: config.encryption ?? EncryptionMode.OPTIONAL,
      openStream: {
        enabled: true,
        policy: {
          closeGracePeriodMs: 120_000,
          idleTimeoutMs: 600_000,
          probeTimeoutMs: 60_000,
          maxBufferedChunksPerStream: 5_000,
          maxBufferedBytesPerStream: 64 * 1024 * 1024,
        },
      },
      oversizedTransfer: {
        enabled: true,
        thresholdBytes: 48_000,
        chunkSizeBytes: 48_000,
        policy: {
          maxTransferBytes: 16 * 1024 * 1024,
          maxTransferChunks: 10_000,
        },
      },
    });

    // A phone clock even slightly ahead of the bridge can make the relay drop
    // every response against the SDK's exact `since` filter. Match the guard
    // used by the Paperclip, Hermes and Quran clients.
    const SINCE_GUARD_SECONDS = 3600;
    type SubFilter = Record<string, unknown> & { since?: number };
    const patchTarget = this.transport as unknown as {
      createSubscriptionFilters: (
        targetPubkey: string,
        additionalFilters?: Record<string, unknown>,
      ) => SubFilter[];
    };
    const buildFilters =
      patchTarget.createSubscriptionFilters.bind(patchTarget);
    patchTarget.createSubscriptionFilters = (
      targetPubkey,
      additionalFilters = {},
    ) =>
      buildFilters(targetPubkey, additionalFilters).map((filter) => ({
        ...filter,
        since: Math.max(
          0,
          (filter.since ?? Math.floor(Date.now() / 1000)) - SINCE_GUARD_SECONDS,
        ),
      }));

    this.mcpClient = new Client({ name: "routstrd-client", version: "0.1.0" });
  }

  async connect(): Promise<void> {
    await this.mcpClient.connect(this.transport);
  }
  async close(): Promise<void> {
    await this.mcpClient.close();
  }

  private async call<T>(
    name: string,
    args: Record<string, unknown> = {},
    options?: RequestOptions,
  ): Promise<T> {
    const result = await this.mcpClient.callTool(
      { name, arguments: args },
      undefined,
      { timeout: 30_000, ...options },
    );
    if (result.isError) {
      const content = Array.isArray(result.content) ? result.content : [];
      const message = content
        .filter(
          (item): item is { type: "text"; text: string } =>
            item.type === "text" && typeof item.text === "string",
        )
        .map((item) => item.text)
        .join("\n");
      throw new Error(message || `${name} failed`);
    }
    return readStructured<T>(result);
  }

  status(): Promise<RoutstrdStatus> {
    return this.call(ROUTSTRD_STATUS_TOOL_NAME);
  }
  ping(): Promise<unknown> {
    return this.call(ROUTSTRD_PING_TOOL_NAME);
  }
  balance(): Promise<unknown> {
    return this.call(ROUTSTRD_BALANCE_TOOL_NAME);
  }
  walletStatus(): Promise<unknown> {
    return this.call(ROUTSTRD_WALLET_STATUS_TOOL_NAME);
  }
  walletUnlock(passphrase: string): Promise<unknown> {
    return this.call(ROUTSTRD_WALLET_UNLOCK_TOOL_NAME, { passphrase });
  }
  walletBalance(): Promise<RoutstrdWalletBalance> {
    return this.call(ROUTSTRD_WALLET_BALANCE_TOOL_NAME);
  }
  walletMints(): Promise<RoutstrdMint[]> {
    return this.call(ROUTSTRD_WALLET_MINTS_TOOL_NAME);
  }
  walletMintsAdd(url: string): Promise<unknown> {
    return this.call(ROUTSTRD_WALLET_MINTS_ADD_TOOL_NAME, { url });
  }
  walletMintsInfo(url: string): Promise<unknown> {
    return this.call(ROUTSTRD_WALLET_MINTS_INFO_TOOL_NAME, { url });
  }
  walletReceiveBolt11(
    amountSats: number,
    mintUrl?: string,
  ): Promise<{ invoice?: string }> {
    return this.call(ROUTSTRD_WALLET_RECEIVE_BOLT11_TOOL_NAME, {
      amountSats,
      mintUrl,
    });
  }
  walletSendCashu(amountSats: number, mintUrl?: string): Promise<unknown> {
    return this.call(ROUTSTRD_WALLET_SEND_CASHU_TOOL_NAME, {
      amountSats,
      mintUrl,
    });
  }
  walletSendBolt11(bolt11: string): Promise<unknown> {
    return this.call(ROUTSTRD_WALLET_SEND_BOLT11_TOOL_NAME, { bolt11 });
  }
  receive(value: string, mintUrl?: string): Promise<unknown> {
    return this.call(ROUTSTRD_RECEIVE_TOOL_NAME, { value, mintUrl });
  }
  send(target: string, mintUrl?: string): Promise<unknown> {
    return this.call(ROUTSTRD_SEND_TOOL_NAME, { target, mintUrl });
  }
  nwcStatus(): Promise<unknown> {
    return this.call(ROUTSTRD_NWC_STATUS_TOOL_NAME);
  }
  nwcConnect(connectionString: string): Promise<unknown> {
    return this.call(ROUTSTRD_NWC_CONNECT_TOOL_NAME, { connectionString });
  }
  nwcDisconnect(): Promise<unknown> {
    return this.call(ROUTSTRD_NWC_DISCONNECT_TOOL_NAME);
  }
  nwcFund(amountSats: number): Promise<unknown> {
    return this.call(ROUTSTRD_NWC_FUND_TOOL_NAME, { amountSats });
  }
  nwcAutoRefill(input: {
    enabled: boolean;
    thresholdSats?: number;
    amountSats?: number;
  }): Promise<unknown> {
    return this.call(ROUTSTRD_NWC_AUTO_REFILL_TOOL_NAME, input);
  }
  listClients(): Promise<RoutstrdClientRecord[]> {
    return this.call(ROUTSTRD_CLIENTS_LIST_TOOL_NAME);
  }
  addClient(input: {
    name: string;
    id: string;
  }): Promise<RoutstrdClientRecord> {
    return this.call(ROUTSTRD_CLIENTS_ADD_TOOL_NAME, input);
  }
  deleteClient(id: string): Promise<void> {
    return this.call(ROUTSTRD_CLIENTS_DELETE_TOOL_NAME, { id });
  }
  keysBalance(): Promise<RoutstrdClientBalance[]> {
    return this.call(ROUTSTRD_KEYS_BALANCE_TOOL_NAME);
  }
  listProviders(): Promise<RoutstrdProvider[]> {
    return this.call(ROUTSTRD_PROVIDERS_LIST_TOOL_NAME);
  }
  disableProviders(indices: number[]): Promise<void> {
    return this.call(ROUTSTRD_PROVIDERS_DISABLE_TOOL_NAME, { indices });
  }
  enableProviders(indices: number[]): Promise<void> {
    return this.call(ROUTSTRD_PROVIDERS_ENABLE_TOOL_NAME, { indices });
  }
  refreshProviders(): Promise<RoutstrdProvider[]> {
    return this.call(ROUTSTRD_PROVIDERS_REFRESH_TOOL_NAME);
  }
  listModels(refresh?: boolean): Promise<RoutstrdModel[]> {
    return this.call(ROUTSTRD_MODELS_LIST_TOOL_NAME, { refresh });
  }
  modelProviders(modelId: string): Promise<RoutstrdProvider[]> {
    return this.call(ROUTSTRD_MODEL_PROVIDERS_TOOL_NAME, { modelId });
  }
  usage(limit?: number): Promise<RoutstrdUsageRecord[]> {
    return this.call(ROUTSTRD_USAGE_TOOL_NAME, { limit });
  }
  usageSummary(): Promise<RoutstrdUsageSummary> {
    return this.call(ROUTSTRD_USAGE_SUMMARY_TOOL_NAME);
  }
  refund(mintUrl?: string): Promise<unknown> {
    return this.call(ROUTSTRD_REFUND_TOOL_NAME, { mintUrl });
  }
  refundXcashu(): Promise<unknown> {
    return this.call(ROUTSTRD_REFUND_XCASHU_TOOL_NAME);
  }
  chatCompletion(input: {
    model: string;
    messages: Array<{ role: string; content: string }>;
    maxTokens?: number;
  }): Promise<RoutstrdChatCompletionResult> {
    return this.call(ROUTSTRD_CHAT_COMPLETIONS_TOOL_NAME, input);
  }
}

function readStructured<T>(result: unknown): T {
  const structured = (result as { structuredContent?: unknown })
    .structuredContent;
  if (
    structured &&
    typeof structured === "object" &&
    !Array.isArray(structured) &&
    "items" in structured
  ) {
    return (structured as { items: T }).items;
  }
  return structured as T;
}

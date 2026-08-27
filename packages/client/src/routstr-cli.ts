import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  ApplesauceRelayPool,
  EncryptionMode,
  NostrClientTransport,
  PrivateKeySigner,
} from "@contextvm/sdk";
import {
  ROUTSTRCLI_STATUS_TOOL_NAME,
  ROUTSTRCLI_CONFIG_SHOW_TOOL_NAME,
  ROUTSTRCLI_CONFIG_GET_TOOL_NAME,
  ROUTSTRCLI_CONFIG_SET_TOOL_NAME,
  ROUTSTRCLI_MODELS_LIST_TOOL_NAME,
  ROUTSTRCLI_PROVIDERS_LIST_TOOL_NAME,
  ROUTSTRCLI_PROVIDERS_ADD_TOOL_NAME,
  ROUTSTRCLI_PROVIDERS_REMOVE_TOOL_NAME,
  ROUTSTRCLI_PROVIDERS_TEST_TOOL_NAME,
  ROUTSTRCLI_PROVIDERS_SHOW_TOOL_NAME,
  ROUTSTRCLI_PROVIDERS_UPDATE_TOOL_NAME,
  ROUTSTRCLI_PROVIDERS_ENABLE_TOOL_NAME,
  ROUTSTRCLI_PROVIDERS_DISABLE_TOOL_NAME,
  ROUTSTRCLI_PROVIDER_MODELS_LIST_TOOL_NAME,
  ROUTSTRCLI_PROVIDER_MODELS_SHOW_TOOL_NAME,
  ROUTSTRCLI_PROVIDER_MODELS_UPDATE_TOOL_NAME,
  ROUTSTRCLI_INSTRUCT_TOOL_NAME,
  ROUTSTRCLI_SCHEMA_TOOL_NAME,
  ROUTSTRCLI_MONITOR_TOOL_NAME,
  ROUTSTRCLI_LOGS_LIST_TOOL_NAME,
  ROUTSTRCLI_LOGS_DATES_TOOL_NAME,
  ROUTSTRCLI_BALANCE_TOOL_NAME,
  ROUTSTRCLI_NODES_LIST_TOOL_NAME,
  ROUTSTRCLI_NODES_SHOW_TOOL_NAME,
  ROUTSTRCLI_NODES_ADD_TOOL_NAME,
  ROUTSTRCLI_NODES_REMOVE_TOOL_NAME,
  ROUTSTRCLI_NODES_SELECT_TOOL_NAME,
  ROUTSTRCLI_WALLET_BALANCE_TOOL_NAME,
  ROUTSTRCLI_WALLET_SEND_TOOL_NAME,
  ROUTSTRCLI_WALLET_RECEIVE_TOOL_NAME,
  ROUTSTRCLI_SERVE_TOOL_NAME,
  type RoutstrCliNodesListResult,
  type RoutstrCliNode,
  type RoutstrCliNodeInfo,
  type RoutstrCliModel,
  type RoutstrCliProvider,
  type RoutstrCliProviderModelsResult,
  type RoutstrCliAdminModel,
  type RoutstrCliInstructResult,
  type RoutstrCliMonitorResult,
  type RoutstrCliLogsListResult,
  type RoutstrCliLogDatesResult,
  type RoutstrCliBalanceResult,
} from "@contexcgi/protocol";
import { normalizePrivateKey, normalizePublicKey } from "./index.js";

export type RoutstrCliClientConfig = {
  privateKey: string;
  serverPubkey: string;
  relays?: string[];
  encryption?: EncryptionMode;
};

export class RoutstrCliClient {
  private readonly mcpClient: Client;
  private readonly transport: NostrClientTransport;

  constructor(config: RoutstrCliClientConfig) {
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

    // Phone clock skew guard — mirrors the other ContexCGI clients.
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

    this.mcpClient = new Client({
      name: "routstr-cli-client",
      version: "0.1.0",
    });
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

  // ── Multi-node registry ────────────────────────────────────────────────
  nodesList(): Promise<RoutstrCliNodesListResult> {
    return this.call(ROUTSTRCLI_NODES_LIST_TOOL_NAME);
  }
  nodeShow(node: string): Promise<{ node: RoutstrCliNode; active: boolean }> {
    return this.call(ROUTSTRCLI_NODES_SHOW_TOOL_NAME, { node });
  }
  nodeAdd(input: {
    node: string;
    nodeUrl: string;
    token?: string;
    name?: string;
  }): Promise<unknown> {
    return this.call(ROUTSTRCLI_NODES_ADD_TOOL_NAME, input);
  }
  nodeRemove(node: string): Promise<unknown> {
    return this.call(ROUTSTRCLI_NODES_REMOVE_TOOL_NAME, { node });
  }
  nodeSelect(node: string): Promise<unknown> {
    return this.call(ROUTSTRCLI_NODES_SELECT_TOOL_NAME, { node });
  }

  // ── CLI commands (each takes optional `node` override) ─────────────────
  status(node?: string): Promise<RoutstrCliNodeInfo> {
    return this.call(ROUTSTRCLI_STATUS_TOOL_NAME, { node });
  }
  configShow(node?: string): Promise<RoutstrCliNodeInfo> {
    return this.call(ROUTSTRCLI_CONFIG_SHOW_TOOL_NAME, { node });
  }
  configGet(
    key: string,
    node?: string,
  ): Promise<{ key: string; value: unknown }> {
    return this.call(ROUTSTRCLI_CONFIG_GET_TOOL_NAME, { key, node });
  }
  configSet(key: string, value: string, node?: string): Promise<unknown> {
    return this.call(ROUTSTRCLI_CONFIG_SET_TOOL_NAME, {
      key,
      value,
      node,
    });
  }
  modelsList(
    opts: { provider?: string; node?: string } = {},
  ): Promise<RoutstrCliModel[]> {
    return this.call(ROUTSTRCLI_MODELS_LIST_TOOL_NAME, opts);
  }
  providersList(node?: string): Promise<RoutstrCliProvider[]> {
    return this.call(ROUTSTRCLI_PROVIDERS_LIST_TOOL_NAME, { node });
  }
  providerAdd(input: {
    name: string;
    apiKey?: string;
    baseUrl?: string;
    slug?: string;
    node?: string;
  }): Promise<unknown> {
    return this.call(ROUTSTRCLI_PROVIDERS_ADD_TOOL_NAME, input);
  }
  providerRemove(provider: string, node?: string): Promise<unknown> {
    return this.call(ROUTSTRCLI_PROVIDERS_REMOVE_TOOL_NAME, {
      provider,
      node,
    });
  }
  providerTest(provider: string, node?: string): Promise<unknown> {
    return this.call(ROUTSTRCLI_PROVIDERS_TEST_TOOL_NAME, { provider, node });
  }
  providerShow(provider: string, node?: string): Promise<RoutstrCliProvider> {
    return this.call(ROUTSTRCLI_PROVIDERS_SHOW_TOOL_NAME, { provider, node });
  }
  providerUpdate(
    provider: string,
    input: Record<string, unknown>,
    node?: string,
  ): Promise<unknown> {
    return this.call(ROUTSTRCLI_PROVIDERS_UPDATE_TOOL_NAME, {
      provider,
      node,
      ...input,
    });
  }
  providerEnable(provider: string, node?: string): Promise<unknown> {
    return this.call(ROUTSTRCLI_PROVIDERS_ENABLE_TOOL_NAME, {
      provider,
      node,
    });
  }
  providerDisable(provider: string, node?: string): Promise<unknown> {
    return this.call(ROUTSTRCLI_PROVIDERS_DISABLE_TOOL_NAME, {
      provider,
      node,
    });
  }
  providerModelsList(
    provider: string,
    opts: { source?: "all" | "db" | "remote"; node?: string } = {},
  ): Promise<RoutstrCliProviderModelsResult> {
    return this.call(ROUTSTRCLI_PROVIDER_MODELS_LIST_TOOL_NAME, {
      provider,
      ...opts,
    });
  }
  providerModelShow(
    provider: string,
    modelId: string,
    node?: string,
  ): Promise<RoutstrCliAdminModel> {
    return this.call(ROUTSTRCLI_PROVIDER_MODELS_SHOW_TOOL_NAME, {
      provider,
      modelId,
      node,
    });
  }
  providerModelUpdate(
    provider: string,
    modelId: string,
    input: Record<string, unknown>,
    node?: string,
  ): Promise<unknown> {
    return this.call(ROUTSTRCLI_PROVIDER_MODELS_UPDATE_TOOL_NAME, {
      provider,
      modelId,
      node,
      ...input,
    });
  }
  instruct(
    opts: { format?: "text" | "json" | "openai"; node?: string } = {},
  ): Promise<RoutstrCliInstructResult | string> {
    return this.call(ROUTSTRCLI_INSTRUCT_TOOL_NAME, opts);
  }
  schema(): Promise<unknown> {
    return this.call(ROUTSTRCLI_SCHEMA_TOOL_NAME);
  }
  monitor(node?: string): Promise<RoutstrCliMonitorResult> {
    return this.call(ROUTSTRCLI_MONITOR_TOOL_NAME, { node });
  }
  logsList(
    opts: {
      date?: string;
      level?: string;
      request_id?: string;
      search?: string;
      status_codes?: string;
      methods?: string;
      endpoints?: string;
      limit?: number;
      node?: string;
    } = {},
  ): Promise<RoutstrCliLogsListResult> {
    return this.call(ROUTSTRCLI_LOGS_LIST_TOOL_NAME, opts);
  }
  logDates(node?: string): Promise<RoutstrCliLogDatesResult> {
    return this.call(ROUTSTRCLI_LOGS_DATES_TOOL_NAME, { node });
  }
  balance(node?: string): Promise<RoutstrCliBalanceResult> {
    return this.call(ROUTSTRCLI_BALANCE_TOOL_NAME, { node });
  }
  walletBalance(node?: string): Promise<unknown> {
    return this.call(ROUTSTRCLI_WALLET_BALANCE_TOOL_NAME, { node });
  }
  walletSend(node?: string): Promise<unknown> {
    return this.call(ROUTSTRCLI_WALLET_SEND_TOOL_NAME, { node });
  }
  walletReceive(node?: string): Promise<unknown> {
    return this.call(ROUTSTRCLI_WALLET_RECEIVE_TOOL_NAME, { node });
  }
  serve(node?: string): Promise<unknown> {
    return this.call(ROUTSTRCLI_SERVE_TOOL_NAME, { node });
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

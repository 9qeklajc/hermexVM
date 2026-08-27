import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requireAllowedPublicKeys } from "@contexcgi/bridge-auth";
import {
  EncryptionMode,
  NostrServerTransport,
  PrivateKeySigner,
} from "@contextvm/sdk";
import { ResilientRelayPool } from "@contexcgi/bridge-relay";
import {
  HermesGateway,
  hermesGatewayCommand,
  type GatewayCommand,
} from "./gateway.js";
import { registerHermesTools } from "./tools.js";
import {
  WhisperTranscriptionService,
  type WhisperTranscriptionConfig,
} from "./transcription.js";
import { ChunkedUploadBuffer } from "./upload-buffer.js";
import { HandoffStore } from "./handoff-store.js";
import {
  FileTransferRegistry,
  registerFileTransferTools,
} from "@contexcgi/file-transfer";

export type HermesBridgeConfig = {
  /** Nostr secret key (hex) that identifies this bridge to clients. */
  privateKey: string;
  relays: string[];
  /** Hermes source root (the hermes-agent checkout with its venv). */
  agentRoot: string;
  /** Root HERMES_HOME (default profile); named profiles live under it. */
  hermesHome: string;
  /** Bridge-owned durable metadata root (never Hermes state.db). */
  dataRoot?: string;
  public?: boolean;
  requireEncryption?: boolean;
  /** Authorized ContextVM client identities, normalized to hex pubkeys. */
  allowedPublicKeys: string[];
  /** Test seam: launch a fake gateway child instead of the real one. */
  gatewayCommand?: GatewayCommand;
  /** Local voice transcription (whisper.cpp). Omit or leave disabled to skip it. */
  transcription?: WhisperTranscriptionConfig;
  /** Root directory for file transfer uploads. When set, file transfer tools are registered. */
  fileTransferRoot?: string;
};

export async function startHermesBridge(config: HermesBridgeConfig): Promise<{
  server: McpServer;
  transport: NostrServerTransport;
  gateway: HermesGateway;
  publicKey: string;
  transcription: WhisperTranscriptionService;
  close(): Promise<void>;
}> {
  const signer = new PrivateKeySigner(config.privateKey);
  const publicKey = await signer.getPublicKey();
  const allowedPublicKeys = requireAllowedPublicKeys(config.allowedPublicKeys);

  const server = new McpServer({ name: "hermes-bridge", version: "0.1.0" });
  const gateway = new HermesGateway({
    command:
      config.gatewayCommand ??
      hermesGatewayCommand(config.agentRoot, config.hermesHome),
  });
  const transcription = new WhisperTranscriptionService(
    config.transcription ?? { enabled: false },
  );
  const uploadBuffer = new ChunkedUploadBuffer();
  const handoffStore = new HandoffStore(
    config.dataRoot ?? `${config.hermesHome}/../.hermes-bridge/data`,
  );
  await handoffStore.recoverStartup();
  // File transfer registry is created up front when a root is configured so
  // the Hermes voice tools can transcribe recordings uploaded through the
  // resumable contexcgi.fileTransfer.* tools.
  const fileTransferRegistry = config.fileTransferRoot
    ? new FileTransferRegistry({ root: config.fileTransferRoot })
    : undefined;
  registerHermesTools(
    server,
    gateway,
    { hermesHome: config.hermesHome, handoffStore, fileTransferRegistry },
    transcription,
    uploadBuffer,
  );

  // Register file transfer tools (upload/download/list/delete) so the app
  // can upload arbitrary files through the bridge. The registry persists
  // uploads to disk; the agent can read them via the absolutePath metadata.
  if (fileTransferRegistry) {
    registerFileTransferTools({
      server,
      registry: fileTransferRegistry,
      getClientPubkey: (extra: { _meta?: Record<string, unknown> }) => {
        const meta = extra._meta as { clientPubkey?: unknown } | undefined;
        return typeof meta?.clientPubkey === "string" &&
          meta.clientPubkey.length > 0
          ? meta.clientPubkey
          : undefined;
      },
    });
  }

  const transport = new NostrServerTransport({
    signer,
    // Disable the pool's liveness ping/rebuild: some relays (nostr.chaima.info)
    // never EOSE the `limit:0` ping, so the default 20s timeout rebuilds the
    // pool every ~2min and drops in-flight responses / live streams. See the
    // matching note in packages/client/src/hermes.ts.
    // Use the SDK default liveness ping (120s) so the pool detects and
    // rebuilds stale/dead websocket connections. A ~never ping leaves zombie
    // sockets that silently drop tool calls after ~12h.
    relayHandler: new ResilientRelayPool(config.relays),
    encryptionMode: config.requireEncryption
      ? EncryptionMode.REQUIRED
      : EncryptionMode.OPTIONAL,
    isAnnouncedServer: config.public ?? false,
    publishRelayList: config.public ?? false,
    relayListUrls: config.relays,
    allowedPublicKeys,
    serverInfo: {
      name: "Hermes Bridge",
      about:
        "ContextVM bridge to a local Hermes Agent install (agent profiles, conversations, live-streamed chat turns).",
    },
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
      policy: { maxTransferBytes: 64 * 1024 * 1024, maxTransferChunks: 10_000 },
    },
    injectClientPubkey: true,
  });

  await server.connect(transport);
  return {
    server,
    transport,
    gateway,
    publicKey,
    transcription,
    close: async () => {
      await server.close();
      await gateway.stop();
      uploadBuffer.dispose();
    },
  };
}

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  ApplesauceRelayPool,
  callToolStream,
  EncryptionMode,
  NostrClientTransport,
  PrivateKeySigner,
} from "@contextvm/sdk";
import { normalizePrivateKey, normalizePublicKey } from "./index.js";
import {
  PI_CHATS_CREATE_TOOL_NAME,
  PI_CHATS_DELETE_TOOL_NAME,
  PI_CHATS_HISTORY_TOOL_NAME,
  PI_CHATS_LIST_TOOL_NAME,
  PI_CHAT_INTERRUPT_TOOL_NAME,
  PI_CHAT_SEND_TOOL_NAME,
  PI_CHAT_WATCH_TOOL_NAME,
  PI_EVENTS_STREAM_TOOL_NAME,
  PI_HANDOFF_GET_TOOL_NAME,
  PI_HANDOFF_PREVIEW_TOOL_NAME,
  PI_HANDOFF_SEND_TOOL_NAME,
  PI_HANDOFFS_LIST_TOOL_NAME,
  PI_MODELS_LIST_TOOL_NAME,
  PI_MODEL_SWITCH_TOOL_NAME,
  PI_REPOSITORIES_LIST_TOOL_NAME,
  PI_TRANSCRIBE_AUDIO_TOOL_NAME,
  PI_TRANSCRIPTION_CANCEL_TOOL_NAME,
  PI_TRANSCRIPTION_CAPABILITIES_TOOL_NAME,
  PI_TRANSCRIPTION_CHUNK_TOOL_NAME,
  parsePiActivityChunk,
  parsePiChatChunk,
  type PiActivityEvent,
  type PiChatEvent,
  type PiChatHistory,
  type PiChatSummary,
  type PiHandoffPreview,
  type PiHandoffPreviewInput,
  type PiHandoffRecord,
  type PiHandoffSendInput,
  type PiHandoffSendResult,
  type PiModelOptions,
  type PiModelSwitchResult,
  type PiRepository,
  type PiSendResult,
  type PiTranscribeAudioErrorCode,
  type PiTranscribeAudioResult,
  type PiTranscriptionCapabilities,
  type PiTranscriptionChunkResult,
  type PiTranscriptionLanguage,
} from "@contexcgi/protocol";
export type {
  PiActivityEvent,
  PiChatEvent,
  PiChatHistory,
  PiChatMessage,
  PiChatSummary,
  PiSubagentTask,
  PiHandoffMessageRef,
  PiHandoffPreview,
  PiHandoffPreviewInput,
  PiHandoffRecord,
  PiHandoffSendInput,
  PiHandoffSendResult,
  PiModelOptions,
  PiModelSwitchResult,
  PiRepository,
  PiSendResult,
  PiTranscriptionCapabilities,
  PiTranscriptionLanguage,
} from "@contexcgi/protocol";
export type PiChatClientConfig = {
  privateKey: string;
  serverPubkey: string;
  relays?: string[];
  discoveryRelays?: string[];
  fallbackRelays?: string[];
  encryption?: EncryptionMode;
};
export type PiChatTurn = {
  events: AsyncIterable<PiChatEvent>;
  result: Promise<PiSendResult>;
  abort(reason?: string): Promise<void>;
};
export type PiActivityStream = {
  events: AsyncIterable<PiActivityEvent>;
  done: Promise<void>;
  abort(reason?: string): Promise<void>;
};
export class PiTranscriptionError extends Error {
  constructor(
    readonly code: PiTranscribeAudioErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "PiTranscriptionError";
  }
}
const CHUNK_SIZE = 24_000,
  TRANSCRIBE_TIMEOUT = 240_000;
export class PiChatClient {
  private readonly mcpClient: Client;
  private readonly transport: NostrClientTransport;
  constructor(config: PiChatClientConfig) {
    const relays =
      config.relays ?? config.discoveryRelays ?? config.fallbackRelays ?? [];
    this.transport = new NostrClientTransport({
      signer: new PrivateKeySigner(normalizePrivateKey(config.privateKey)),
      relayHandler: new ApplesauceRelayPool(relays, {
        pingFrequencyMs: 2_147_400_000,
      }),
      discoveryRelayUrls: config.discoveryRelays ?? [],
      fallbackOperationalRelayUrls: config.fallbackRelays ?? config.relays,
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
    applyClockSkewGuard(this.transport);
    this.mcpClient = new Client({ name: "pi-chat-client", version: "0.2.0" });
  }
  async connect() {
    await this.mcpClient.connect(this.transport);
  }
  async close() {
    await this.mcpClient.close();
  }
  async listChats(limit = 100): Promise<PiChatSummary[]> {
    return (
      (
        await this.call<{ items: PiChatSummary[] }>(PI_CHATS_LIST_TOOL_NAME, {
          limit: Math.min(limit, 100),
        })
      ).items ?? []
    );
  }
  createChat(cwd?: string, selection?: { provider?: string; model?: string }) {
    return this.call<{ chatId: string }>(PI_CHATS_CREATE_TOOL_NAME, {
      ...(cwd ? { cwd } : {}),
      ...(selection?.provider ? { provider: selection.provider } : {}),
      ...(selection?.model ? { model: selection.model } : {}),
    });
  }
  chatHistory(chatId: string): Promise<PiChatHistory> {
    return this.call(PI_CHATS_HISTORY_TOOL_NAME, { chatId });
  }
  async deleteChat(chatId: string) {
    await this.call(PI_CHATS_DELETE_TOOL_NAME, { chatId });
  }
  async listRepositories(): Promise<PiRepository[]> {
    return (
      (
        await this.call<{ repositories: PiRepository[] }>(
          PI_REPOSITORIES_LIST_TOOL_NAME,
        )
      ).repositories ?? []
    );
  }
  listModels(input: { chatId?: string } = {}): Promise<PiModelOptions> {
    return this.call(
      PI_MODELS_LIST_TOOL_NAME,
      input.chatId ? { chatId: input.chatId } : {},
    );
  }
  switchModel(input: {
    chatId: string;
    provider: string;
    model: string;
  }): Promise<PiModelSwitchResult> {
    return this.call(PI_MODEL_SWITCH_TOOL_NAME, input);
  }
  interrupt(chatId: string): Promise<{ chatId: string; interrupted: boolean }> {
    return this.call(PI_CHAT_INTERRUPT_TOOL_NAME, { chatId });
  }
  async sendMessage(input: {
    chatId: string;
    text: string;
  }): Promise<PiChatTurn> {
    return this.openTurn(PI_CHAT_SEND_TOOL_NAME, input);
  }
  async watchTurn(chatId: string) {
    const call = await callToolStream<unknown>({
      client: this.mcpClient,
      transport: this.transport,
      name: PI_CHAT_WATCH_TOOL_NAME,
      arguments: { chatId },
    });
    return {
      events: readChatEvents(call.stream),
      result: call.result.then((v) =>
        readStructured<PiSendResult & { running: boolean }>(v),
      ),
      abort: safeAbort(call.abort),
    };
  }
  async streamActivity(): Promise<PiActivityStream> {
    const call = await callToolStream<unknown>({
      client: this.mcpClient,
      transport: this.transport,
      name: PI_EVENTS_STREAM_TOOL_NAME,
      arguments: {},
    });
    return {
      events: readActivityEvents(call.stream),
      done: call.result.then(
        () => undefined,
        () => undefined,
      ),
      abort: safeAbort(call.abort),
    };
  }
  transcriptionCapabilities(): Promise<PiTranscriptionCapabilities> {
    return this.call(PI_TRANSCRIPTION_CAPABILITIES_TOOL_NAME);
  }
  async transcribeAudio(
    input: {
      contentBase64: string;
      mimeType: string;
      durationMs?: number;
      language?: PiTranscriptionLanguage;
    },
    opts: { signal?: AbortSignal } = {},
  ): Promise<{ transcript: string; durationSeconds: number }> {
    const uploadId = generateUploadId(),
      totalChunks = Math.max(
        1,
        Math.ceil(input.contentBase64.length / CHUNK_SIZE),
      );
    try {
      for (let index = 0; index < totalChunks; index++) {
        if (opts.signal?.aborted)
          throw new DOMException("Aborted", "AbortError");
        const r = await this.call<PiTranscriptionChunkResult>(
          PI_TRANSCRIPTION_CHUNK_TOOL_NAME,
          {
            uploadId,
            index,
            totalChunks,
            contentBase64: input.contentBase64.slice(
              index * CHUNK_SIZE,
              (index + 1) * CHUNK_SIZE,
            ),
          },
          { timeout: TRANSCRIBE_TIMEOUT, signal: opts.signal },
        );
        if (r.status === "error")
          throw new PiTranscriptionError(r.code, r.message, r.retryable);
      }
      const r = await this.call<PiTranscribeAudioResult>(
        PI_TRANSCRIBE_AUDIO_TOOL_NAME,
        {
          uploadId,
          mimeType: input.mimeType,
          durationMs: input.durationMs,
          ...(input.language && input.language !== "auto"
            ? { language: input.language }
            : {}),
        },
        { timeout: TRANSCRIBE_TIMEOUT, signal: opts.signal },
      );
      if (r.status === "error")
        throw new PiTranscriptionError(r.code, r.message, r.retryable);
      return { transcript: r.transcript, durationSeconds: r.durationSeconds };
    } catch (error) {
      void this.call(PI_TRANSCRIPTION_CANCEL_TOOL_NAME, { uploadId }).catch(
        () => undefined,
      );
      throw error;
    }
  }
  previewHandoff(input: PiHandoffPreviewInput): Promise<PiHandoffPreview> {
    return this.call(PI_HANDOFF_PREVIEW_TOOL_NAME, input);
  }
  async listHandoffs(
    input: { chatId?: string; limit?: number } = {},
  ): Promise<PiHandoffRecord[]> {
    return (
      (
        await this.call<{ items: PiHandoffRecord[] }>(
          PI_HANDOFFS_LIST_TOOL_NAME,
          input,
        )
      ).items ?? []
    );
  }
  getHandoff(requestId: string): Promise<PiHandoffRecord> {
    return this.call(PI_HANDOFF_GET_TOOL_NAME, { requestId });
  }
  async sendHandoff(input: PiHandoffSendInput) {
    const call = await callToolStream<unknown>({
      client: this.mcpClient,
      transport: this.transport,
      name: PI_HANDOFF_SEND_TOOL_NAME,
      arguments: input,
    });
    return {
      events: readChatEvents(call.stream),
      result: call.result.then((v) => readStructured<PiHandoffSendResult>(v)),
      abort: safeAbort(call.abort),
    };
  }
  private async openTurn(
    name: string,
    args: Record<string, unknown>,
  ): Promise<PiChatTurn> {
    const call = await callToolStream<unknown>({
      client: this.mcpClient,
      transport: this.transport,
      name,
      arguments: args,
    });
    return {
      events: readChatEvents(call.stream),
      result: call.result.then((v) => readStructured<PiSendResult>(v)),
      abort: safeAbort(call.abort),
    };
  }
  private async call<T>(
    name: string,
    args: Record<string, unknown> = {},
    options?: RequestOptions,
  ): Promise<T> {
    const result = await this.mcpClient.callTool(
      { name, arguments: args },
      undefined,
      options,
    );
    return readStructured<T>(result);
  }
}
const safeAbort =
  (abort: (reason?: string) => Promise<unknown>) => async (reason?: string) => {
    try {
      await abort(reason);
    } catch {
      /* expected */
    }
  };
async function* readChatEvents(stream: AsyncIterable<{ value: string }>) {
  let buffered = "";
  for await (const chunk of stream) {
    buffered += chunk.value;
    const at = buffered.lastIndexOf("\n");
    if (at < 0) continue;
    const ready = buffered.slice(0, at + 1);
    buffered = buffered.slice(at + 1);
    yield* parsePiChatChunk(ready);
  }
  if (buffered.trim()) yield* parsePiChatChunk(buffered);
}
async function* readActivityEvents(stream: AsyncIterable<{ value: string }>) {
  let buffered = "";
  for await (const chunk of stream) {
    buffered += chunk.value;
    const at = buffered.lastIndexOf("\n");
    if (at < 0) continue;
    const ready = buffered.slice(0, at + 1);
    buffered = buffered.slice(at + 1);
    yield* parsePiActivityChunk(ready);
  }
}
function readStructured<T>(value: unknown): T {
  if (isObject(value) && value.isError === true) {
    const content = value.content;
    if (Array.isArray(content)) {
      const text = content
        .map((i) => (isObject(i) && typeof i.text === "string" ? i.text : ""))
        .filter(Boolean)
        .join("\n");
      if (text) throw new Error(text);
    }
  }
  if (isObject(value) && isObject(value.structuredContent))
    return value.structuredContent as T;
  throw new Error("Pi bridge tool result did not include structuredContent");
}
function applyClockSkewGuard(transport: NostrClientTransport) {
  const target = transport as unknown as {
    createSubscriptionFilters: (
      pk: string,
      f?: Record<string, unknown>,
    ) => Array<Record<string, unknown> & { since?: number }>;
  };
  const build = target.createSubscriptionFilters.bind(target);
  target.createSubscriptionFilters = (pk, f = {}) =>
    build(pk, f).map((x) => ({
      ...x,
      since: Math.max(0, (x.since ?? Math.floor(Date.now() / 1000)) - 3600),
    }));
}
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;
function generateUploadId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`
  );
}

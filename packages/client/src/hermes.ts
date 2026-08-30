import { sha256 as createSha256 } from "@noble/hashes/sha2.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  ApplesauceRelayPool,
  callToolStream,
  EncryptionMode,
  NostrClientTransport,
  PrivateKeySigner,
} from "@contextvm/sdk";
import {
  HERMES_AGENTS_LIST_TOOL_NAME,
  HERMES_CHAT_APPROVE_TOOL_NAME,
  HERMES_CHAT_CLARIFY_ANSWER_TOOL_NAME,
  HERMES_CHAT_HISTORY_TOOL_NAME,
  HERMES_CHAT_INTERRUPT_TOOL_NAME,
  HERMES_CHAT_SEND_TOOL_NAME,
  HERMES_CHAT_SET_TITLE_TOOL_NAME,
  HERMES_CHAT_WATCH_TOOL_NAME,
  HERMES_CHATS_DELETE_TOOL_NAME,
  HERMES_CHATS_LIST_TOOL_NAME,
  HERMES_EVENTS_STREAM_TOOL_NAME,
  HERMES_HANDOFF_GET_TOOL_NAME,
  HERMES_HANDOFF_PREVIEW_TOOL_NAME,
  HERMES_HANDOFF_SEND_TOOL_NAME,
  HERMES_HANDOFFS_LIST_TOOL_NAME,
  HERMES_MODELS_LIST_TOOL_NAME,
  HERMES_MODEL_SWITCH_TOOL_NAME,
  HERMES_PROFILE_UPDATE_TOOL_NAME,
  HERMES_PROJECTS_LIST_TOOL_NAME,
  HERMES_RELAYS_ENSURE_TOOL_NAME,
  HERMES_SESSION_CWD_SET_TOOL_NAME,
  HERMES_SKILLS_LIST_TOOL_NAME,
  HERMES_TRANSCRIBE_AUDIO_TOOL_NAME,
  HERMES_TRANSCRIBE_FILE_TOOL_NAME,
  HERMES_TRANSCRIPTION_CANCEL_TOOL_NAME,
  HERMES_TRANSCRIPTION_CAPABILITIES_TOOL_NAME,
  HERMES_TRANSCRIPTION_CHUNK_TOOL_NAME,
  FILE_TRANSFER_DELETE_TOOL_NAME,
  FILE_TRANSFER_LIST_TOOL_NAME,
  FILE_TRANSFER_UPLOAD_CANCEL_TOOL_NAME,
  FILE_TRANSFER_UPLOAD_CHUNK_TOOL_NAME,
  FILE_TRANSFER_UPLOAD_FINALIZE_TOOL_NAME,
  FILE_TRANSFER_UPLOAD_INIT_TOOL_NAME,
  FILE_TRANSFER_UPLOAD_STATUS_TOOL_NAME,
  CONTEXTVM_OVERSIZED_TEXT_TRANSFER,
  HermesChatEventDecoder,
  parseHermesActivityChunk,
  type HermesActivityEvent,
  type HermesAgentProfile,
  type HermesChatEvent,
  type HermesChatHistoryResult,
  type HermesClarifyAnswerResult,
  type HermesChatSummary,
  type HermesHandoffPreview,
  type HermesHandoffPreviewInput,
  type HermesHandoffRecord,
  type HermesHandoffSendInput,
  type HermesHandoffSendResult,
  type HermesModelOptions,
  type HermesModelSwitchResult,
  type HermesProjectsResult,
  type HermesRelaysEnsureResult,
  type HermesSendResult,
  type HermesSetCwdResult,
  type HermesSetTitleResult,
  type HermesSkillsResult,
  type HermesTranscribeAudioErrorCode,
  type HermesTranscribeAudioResult,
  type HermesTranscriptionCapabilities,
  type HermesTranscriptionLanguage,
  type HermesTranscriptionChunkResult,
  type FileTransferDescriptor,
  type FileTransferUploadFinalizeResult,
  type FileTransferUploadInitResult,
  type FileTransferUploadStatusResult,
  type ListFileTransfersRequest,
  type ListFileTransfersResult,
} from "@contexcgi/protocol";
import { normalizePrivateKey, normalizePublicKey } from "./index.js";

export type HermesChatClientConfig = {
  privateKey: string;
  serverPubkey: string;
  relays?: string[];
  discoveryRelays?: string[];
  fallbackRelays?: string[];
  encryption?: EncryptionMode;
};

/** Random-access byte source for bounded-memory, resumable uploads. */
export type HermesUploadSource = {
  sizeBytes: number;
  read(startBytes: number, endBytes: number): Promise<Uint8Array>;
};

export type HermesUploadOptions = {
  signal?: AbortSignal;
  resumeUploadId?: string;
  preserveForResume?: boolean;
  onUploadInitialized?: (
    state: FileTransferUploadInitResult & { sha256: string },
  ) => void;
};

type UploadProgressCallback = (progress: {
  phase: "uploading" | "finalizing" | "done";
  uploadedChunks: number;
  totalChunks: number;
  percent: number;
}) => void;

/** A structured, retryable-aware failure from `hermes.transcription.transcribe`. */
export class HermesTranscriptionError extends Error {
  constructor(
    readonly code: HermesTranscribeAudioErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "HermesTranscriptionError";
  }
}

// whisper.cpp on a small-server CPU can take much longer than the MCP SDK's
// 60s default request timeout for up to 60s of audio. Keep comfortably above
// the bridge's own transcription budget (default 180s).
const TRANSCRIBE_REQUEST_TIMEOUT_MS = 240_000;

// Each chunk call is its own small, independently-encrypted MCP message, kept
// well under NIP-44's 65535-byte plaintext ceiling once JSON/MCP framing
// overhead is included (24000 bytes + a few hundred bytes of framing).
const TRANSCRIBE_CHUNK_SIZE = 24_000;

/** Coarse progress for the recorder UI (upload %, then transcribing). */
export type HermesTranscribeProgress = {
  phase: "uploading" | "transcribing";
  percent: number;
};

function generateUploadId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export type HermesActivityStream = {
  /** JSONL activity frames: a snapshot first, then turn starts/completions. */
  events: AsyncIterable<HermesActivityEvent>;
  /** Settles when the bridge closes the stream (never rejects). */
  done: Promise<void>;
  abort(reason?: string): Promise<void>;
};

export type HermesChatTurn = {
  /** JSONL frames of the live turn, in order. */
  events: AsyncIterable<HermesChatEvent>;
  /** Resolves with the final turn summary once the bridge closes the stream. */
  result: Promise<HermesSendResult>;
  /** Stop listening (the agent keeps working; reopen via history). */
  abort(reason?: string): Promise<void>;
};

/**
 * ContextVM client for a Hermes bridge. Speaks MCP-over-Nostr only; the bridge
 * spawns and owns the local Hermes gateway. Mirrors the app surface: agent
 * profiles, conversations, live-streamed chat turns.
 */
export class HermesChatClient {
  private mcpClient: Client;
  private transport: NostrClientTransport;
  private readonly config: HermesChatClientConfig;
  private reconnecting: Promise<void> | null = null;

  constructor(config: HermesChatClientConfig) {
    this.config = config;
    const { mcpClient, transport } = this.createConnection(config);
    this.mcpClient = mcpClient;
    this.transport = transport;
  }

  private createConnection(config: HermesChatClientConfig): {
    mcpClient: Client;
    transport: NostrClientTransport;
  } {
    // Same transport posture as PaperclipOpsClient (see the notes there):
    // pinned relays, discovery disabled, liveness ping effectively never.
    const relays =
      config.relays ?? config.discoveryRelays ?? config.fallbackRelays ?? [];
    const relayPool = new ApplesauceRelayPool(relays, {
      pingFrequencyMs: 2_147_400_000,
    });
    const transport = new NostrClientTransport({
      signer: new PrivateKeySigner(normalizePrivateKey(config.privateKey)),
      relayHandler: relayPool,
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
      // CEP-22 fragments long user text and oversized final tool results into
      // independently encrypted requests/replies. Shared with the bridge so
      // other clients can adopt the exact same safe transport contract.
      oversizedTransfer: CONTEXTVM_OVERSIZED_TEXT_TRANSFER,
    });

    // Clock-skew guard — a phone clock even ~1s ahead of the bridge silently
    // filters out every reply. Same patch as PaperclipOpsClient.
    const SINCE_GUARD_SECONDS = 3600;
    type SubFilter = Record<string, unknown> & { since?: number };
    const patchTarget = transport as unknown as {
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

    const mcpClient = new Client({
      name: "hermes-chat-client",
      version: "0.1.0",
    });
    return { mcpClient, transport };
  }

  /**
   * Rebuilds the MCP client + relay sockets after a permanent transport close.
   * The MCP SDK's "Not connected" means there is no transport left to retry,
   * unlike -32000/timeout errors where the existing client can recover.
   */
  private async reconnectTransport(): Promise<void> {
    this.reconnecting ??= (async () => {
      const previous = this.mcpClient;
      await previous.close().catch(() => undefined);
      const { mcpClient, transport } = this.createConnection(this.config);
      this.mcpClient = mcpClient;
      this.transport = transport;
      await mcpClient.connect(transport);
    })();
    try {
      await this.reconnecting;
    } finally {
      this.reconnecting = null;
    }
  }

  async connect(): Promise<void> {
    await this.mcpClient.connect(this.transport);
  }

  ensureBridgeRelays(relays: string[]): Promise<HermesRelaysEnsureResult> {
    return this.call<HermesRelaysEnsureResult>(HERMES_RELAYS_ENSURE_TOOL_NAME, {
      relays,
    });
  }

  async close(): Promise<void> {
    await this.mcpClient.close();
  }

  private async call<T>(
    name: string,
    args: Record<string, unknown> = {},
    options?: RequestOptions,
  ): Promise<T> {
    // ContextVM SDK 0.11.8 loses small direct responses when an MCP progress
    // token is present. Keep ordinary Hermes calls token-free; large history
    // payloads still need pagination before CEP-22 can be re-enabled safely.
    const result = await this.mcpClient.callTool(
      { name, arguments: args },
      undefined,
      options,
    );
    if (result.isError) {
      const content = Array.isArray(result.content)
        ? (result.content as Array<{ type?: unknown; text?: unknown }>)
        : [];
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

  /**
   * Like `call` but retries on transient transport-loss errors (-32000
   * ConnectionClosed, the SDK protocol's "Not connected", and timeouts).
   * The Nostr transport auto-reconnects after a relay drop; a brief delay
   * gives the WebSocket time to re-establish before the retry. Up to 5
   * attempts with exponential backoff (1s, 2s, 4s, 8s, 16s).
   */
  private async callWithRetry<T>(
    name: string,
    args: Record<string, unknown> = {},
    options?: RequestOptions,
    maxAttempts = 5,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await this.call<T>(name, args, options);
      } catch (cause) {
        lastError = cause;
        const msg = cause instanceof Error ? cause.message : String(cause);
        // Only retry on transient transport loss, not real tool errors.
        // "Not connected" is terminal for the current MCP client: its transport
        // was closed (e.g. by a mobile background hot-swap), so a fresh client
        // must be created. -32000/timeouts remain recoverable on this client.
        if (msg.includes("Not connected")) {
          if (attempt >= maxAttempts - 1) throw cause;
          await this.reconnectTransport();
          continue;
        }
        if (
          !msg.includes("Connection closed") &&
          !msg.includes("-32000") &&
          !msg.includes("Request timed out")
        ) {
          throw cause;
        }
        if (attempt < maxAttempts - 1) {
          const delayMs = 1000 * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }
    throw lastError;
  }

  // -- agents ----------------------------------------------------------------
  async listAgents(): Promise<HermesAgentProfile[]> {
    const payload = await this.call<{ agents: HermesAgentProfile[] }>(
      HERMES_AGENTS_LIST_TOOL_NAME,
    );
    return payload.agents ?? [];
  }

  /** Persist the editable settings for one Hermes agent profile. */
  updateProfile(input: {
    agentId: string;
    model: string;
    provider?: string;
    confirmExpensiveModel?: boolean;
  }): Promise<HermesModelSwitchResult> {
    return this.call<HermesModelSwitchResult>(HERMES_PROFILE_UPDATE_TOOL_NAME, {
      agentId: input.agentId,
      model: input.model,
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.confirmExpensiveModel ? { confirmExpensiveModel: true } : {}),
    });
  }

  // -- conversations -----------------------------------------------------------
  async listChats(
    agentId: string,
    limit = 20,
    offset = 0,
  ): Promise<HermesChatSummary[]> {
    const payload = await this.call<{ items: HermesChatSummary[] }>(
      HERMES_CHATS_LIST_TOOL_NAME,
      { agentId, limit, offset },
    );
    return payload.items ?? [];
  }

  chatHistory(
    agentId: string,
    chatId: string,
    beforeOrdinal?: number,
  ): Promise<HermesChatHistoryResult> {
    return this.call<HermesChatHistoryResult>(HERMES_CHAT_HISTORY_TOOL_NAME, {
      agentId,
      chatId,
      ...(beforeOrdinal === undefined ? {} : { beforeOrdinal }),
    });
  }

  async deleteChat(agentId: string, chatId: string): Promise<void> {
    await this.call(HERMES_CHATS_DELETE_TOOL_NAME, { agentId, chatId });
  }

  interrupt(
    agentId: string,
    chatId: string,
  ): Promise<{ interrupted: boolean }> {
    return this.call<{ interrupted: boolean }>(
      HERMES_CHAT_INTERRUPT_TOOL_NAME,
      {
        agentId,
        chatId,
      },
    );
  }

  approve(
    agentId: string,
    chatId: string,
    choice: "once" | "session" | "always" | "deny",
  ): Promise<{ choice: string }> {
    return this.call<{ choice: string }>(HERMES_CHAT_APPROVE_TOOL_NAME, {
      agentId,
      chatId,
      choice,
    });
  }

  /**
   * Answers a pending mid-turn clarifying question the agent posed (a choice
   * from `choices` or a free-text answer). Unblocks the parked turn.
   */
  answerClarify(
    agentId: string,
    chatId: string,
    requestId: string,
    answer: string,
  ): Promise<HermesClarifyAnswerResult> {
    return this.call<HermesClarifyAnswerResult>(
      HERMES_CHAT_CLARIFY_ANSWER_TOOL_NAME,
      { agentId, chatId, requestId, answer },
    );
  }

  // -- conversation title ------------------------------------------------------
  /**
   * Sets the title of a conversation when `title` is provided, or reads the
   * current title when it is omitted. Setting a title before the first send
   * names a new conversation up front.
   */
  setChatTitle(
    agentId: string,
    chatId: string,
    title?: string,
  ): Promise<HermesSetTitleResult> {
    return this.call<HermesSetTitleResult>(HERMES_CHAT_SET_TITLE_TOOL_NAME, {
      agentId,
      chatId,
      ...(title === undefined ? {} : { title }),
    });
  }

  // -- model picker -----------------------------------------------------------
  /**
   * Lists every model available to this Hermes profile, grouped by provider —
   * the same payload the Hermes TUI/desktop picker renders. Pass `refresh` to
   * bust the per-provider model-id cache and re-fetch live catalogs.
   */
  listModels(input: {
    agentId: string;
    chatId?: string;
    refresh?: boolean;
    includeUnconfigured?: boolean;
  }): Promise<HermesModelOptions> {
    return this.call<HermesModelOptions>(HERMES_MODELS_LIST_TOOL_NAME, {
      agentId: input.agentId,
      ...(input.chatId ? { chatId: input.chatId } : {}),
      ...(input.refresh ? { refresh: true } : {}),
      ...(input.includeUnconfigured ? { includeUnconfigured: true } : {}),
    });
  }

  /**
   * Pins a new model (and optionally provider) for the next request in this
   * conversation. Session-scoped by default — other conversations keep their
   * own model. The switch takes effect on the next `sendMessage` call.
   */
  switchModel(input: {
    agentId: string;
    chatId: string;
    model: string;
    provider?: string;
    /** True to persist globally (across all conversations). */
    global?: boolean;
  }): Promise<HermesModelSwitchResult> {
    return this.call<HermesModelSwitchResult>(HERMES_MODEL_SWITCH_TOOL_NAME, {
      agentId: input.agentId,
      chatId: input.chatId,
      model: input.model,
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.global ? { global: true } : {}),
    });
  }

  // -- projects + session cwd -------------------------------------------------
  /**
   * Lists every project the agent has worked in — explicit (user-created) and
   * auto-discovered from session cwd history + git probing. Render as a
   * picker; selecting a project calls `setCwd` to pin it onto the conversation.
   */
  listProjects(agentId: string): Promise<HermesProjectsResult> {
    return this.call<HermesProjectsResult>(HERMES_PROJECTS_LIST_TOOL_NAME, {
      agentId,
    });
  }

  /**
   * Pins a working directory onto the conversation. The agent's terminal, file,
   * and search tools will operate in that directory for the rest of the
   * conversation, so the user doesn't need to tell it which project to work in
   * each time. The chat must already exist (have a chatId).
   */
  setCwd(input: {
    agentId: string;
    chatId: string;
    cwd: string;
  }): Promise<HermesSetCwdResult> {
    return this.call<HermesSetCwdResult>(HERMES_SESSION_CWD_SET_TOOL_NAME, {
      agentId: input.agentId,
      chatId: input.chatId,
      cwd: input.cwd,
    });
  }

  // -- skills ----------------------------------------------------------------
  /**
   * Lists every skill installed for a profile — name, description, and
   * category — scanned from the profile's skills/ directory. Use to render a
   * picker so the user can see what the agent can do and ask targeted questions.
   */
  async listSkills(agentId: string): Promise<HermesSkillsResult> {
    const skills: HermesSkillsResult["skills"] = [];
    let offset = 0;
    for (let page = 0; page < 100; page++) {
      const result = await this.call<HermesSkillsResult>(
        HERMES_SKILLS_LIST_TOOL_NAME,
        { agentId, offset, limit: 40 },
      );
      skills.push(...(result.skills ?? []));
      if (result.nextOffset === undefined) {
        return {
          agentId,
          skills,
          totalSkills: result.totalSkills ?? skills.length,
        };
      }
      if (result.nextOffset <= offset) {
        throw new Error("Hermes skills pagination did not advance");
      }
      offset = result.nextOffset;
    }
    throw new Error("Hermes skills pagination exceeded 100 pages");
  }

  // -- voice transcription (local whisper.cpp on the bridge) -----------------
  transcriptionCapabilities(): Promise<HermesTranscriptionCapabilities> {
    return this.call<HermesTranscriptionCapabilities>(
      HERMES_TRANSCRIPTION_CAPABILITIES_TOOL_NAME,
    );
  }

  /**
   * Transcribes a voice recording through the resumable, sha256-verified
   * file-transfer package (`contexcgi.fileTransfer.upload.*`), then
   * `hermes.transcription.transcribe_file` on the uploaded id. Every chunk is
   * retried on transient transport loss (-32000 ConnectionClosed, "Not
   * connected", timeouts) — the old path sent the recording as a long chain
   * of un-retried chunk calls, so a single relay hiccup mid-upload destroyed
   * the whole recording. On bridges without `transcribe_file`, falls back to
   * the legacy chunked transcription upload. Resolves with the transcript, or
   * rejects with a `HermesTranscriptionError` carrying a stable `code`.
   */
  async transcribeAudio(
    input: {
      contentBase64: string;
      mimeType: string;
      durationMs?: number;
      /** Force the spoken language ("en", "de", …); omit/"auto" to detect. */
      language?: HermesTranscriptionLanguage;
    },
    opts: {
      signal?: AbortSignal;
      onProgress?: (progress: HermesTranscribeProgress) => void;
    } = {},
  ): Promise<{ transcript: string; durationSeconds: number }> {
    try {
      return await this.transcribeViaFileTransfer(input, opts);
    } catch (cause) {
      // Older bridge (or file transfer disabled): no file-transfer tools, no
      // transcribe_file. Fall back to the legacy chunked upload path.
      if (isUnknownToolError(cause)) {
        return this.transcribeViaLegacyChunks(input, opts);
      }
      throw cause;
    }
  }

  /** New path: resumable checksum-verified upload, then transcribe by id. */
  private async transcribeViaFileTransfer(
    input: {
      contentBase64: string;
      mimeType: string;
      durationMs?: number;
      language?: HermesTranscriptionLanguage;
    },
    opts: {
      signal?: AbortSignal;
      onProgress?: (progress: HermesTranscribeProgress) => void;
    },
  ): Promise<{ transcript: string; durationSeconds: number }> {
    const bytes = base64ToBytes(input.contentBase64);
    if (bytes.byteLength === 0) {
      throw new HermesTranscriptionError(
        "INVALID_AUDIO",
        "Empty recording.",
        false,
      );
    }
    const filename = `voice-${Date.now()}.${voiceExtensionForMime(input.mimeType)}`;
    const descriptor = await this.uploadFile(
      {
        filename,
        data: bytes,
        mimeType: input.mimeType,
        category: "audio",
        description: "Voice recording for transcription (temporary)",
        metadata: {
          kind: "voice-transcription",
          ...(input.durationMs ? { durationMs: input.durationMs } : {}),
        },
      },
      (p) =>
        opts.onProgress?.({
          phase: "uploading",
          percent: p.percent,
        }),
      { signal: opts.signal },
    );

    try {
      if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      opts.onProgress?.({ phase: "transcribing", percent: 100 });
      const language =
        input.language && input.language !== "auto"
          ? { language: input.language }
          : {};
      const result = await this.callTranscribeFile(
        {
          id: descriptor.id,
          mimeType: input.mimeType,
          ...(input.durationMs ? { durationMs: input.durationMs } : {}),
          ...language,
        },
        opts,
      );
      if (result.status === "error") {
        throw new HermesTranscriptionError(
          result.code,
          result.message,
          result.retryable,
        );
      }
      return {
        transcript: result.transcript,
        durationSeconds: result.durationSeconds,
      };
    } finally {
      // The recording is a temp artifact — free it on the bridge once the
      // transcription attempt is over (success or terminal failure).
      void this.deleteFile(descriptor.id).catch(() => undefined);
    }
  }

  /**
   * `transcribe_file` with bounded retries: transport errors re-request the
   * call (the bridge aborts its whisper run when the request dies), and
   * retryable whisper outcomes (BUSY/TIMEOUT) wait briefly and re-run — the
   * recording is already safely on the bridge, so a retry costs only CPU.
   */
  private async callTranscribeFile(
    args: Record<string, unknown>,
    opts: { signal?: AbortSignal },
  ): Promise<HermesTranscribeAudioResult> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.callWithRetry<HermesTranscribeAudioResult>(
          HERMES_TRANSCRIBE_FILE_TOOL_NAME,
          args,
          { timeout: TRANSCRIBE_REQUEST_TIMEOUT_MS, signal: opts.signal },
          2,
        );
      } catch (cause) {
        lastError = cause;
        if (opts.signal?.aborted) throw cause;
        const retryable =
          cause instanceof HermesTranscriptionError && cause.retryable;
        if (retryable && attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 2500));
          continue;
        }
        throw cause;
      }
    }
    throw lastError;
  }

  /** Legacy path for bridges without file transfer / transcribe_file. */
  private async transcribeViaLegacyChunks(
    input: {
      contentBase64: string;
      mimeType: string;
      durationMs?: number;
      language?: HermesTranscriptionLanguage;
    },
    opts: {
      signal?: AbortSignal;
      onProgress?: (progress: HermesTranscribeProgress) => void;
    },
  ): Promise<{ transcript: string; durationSeconds: number }> {
    const uploadId = generateUploadId();
    const totalChunks = Math.max(
      1,
      Math.ceil(input.contentBase64.length / TRANSCRIBE_CHUNK_SIZE),
    );
    try {
      for (let index = 0; index < totalChunks; index++) {
        if (opts.signal?.aborted)
          throw new DOMException("Aborted", "AbortError");
        const contentBase64 = input.contentBase64.slice(
          index * TRANSCRIBE_CHUNK_SIZE,
          (index + 1) * TRANSCRIBE_CHUNK_SIZE,
        );
        // Chunks are idempotent on the bridge (an identical re-sent index is
        // ignored), so retrying transient transport loss is always safe.
        const chunkResult =
          await this.callWithRetry<HermesTranscriptionChunkResult>(
            HERMES_TRANSCRIPTION_CHUNK_TOOL_NAME,
            { uploadId, index, totalChunks, contentBase64 },
            { timeout: TRANSCRIBE_REQUEST_TIMEOUT_MS, signal: opts.signal },
          );
        if (chunkResult.status === "error") {
          throw new HermesTranscriptionError(
            chunkResult.code,
            chunkResult.message,
            chunkResult.retryable,
          );
        }
        opts.onProgress?.({
          phase: "uploading",
          percent: ((index + 1) / totalChunks) * 100,
        });
      }

      opts.onProgress?.({ phase: "transcribing", percent: 100 });
      const result = await this.call<HermesTranscribeAudioResult>(
        HERMES_TRANSCRIBE_AUDIO_TOOL_NAME,
        {
          uploadId,
          mimeType: input.mimeType,
          durationMs: input.durationMs,
          ...(input.language && input.language !== "auto"
            ? { language: input.language }
            : {}),
        },
        { timeout: TRANSCRIBE_REQUEST_TIMEOUT_MS, signal: opts.signal },
      );
      if (result.status === "error") {
        throw new HermesTranscriptionError(
          result.code,
          result.message,
          result.retryable,
        );
      }
      return {
        transcript: result.transcript,
        durationSeconds: result.durationSeconds,
      };
    } catch (cause) {
      // Fire-and-forget: free the bridge's buffered chunks without delaying
      // (or being blocked by) the error we're about to rethrow.
      void this.call(HERMES_TRANSCRIPTION_CANCEL_TOOL_NAME, {
        uploadId,
      }).catch(() => undefined);
      throw cause;
    }
  }

  // -- file transfer (upload arbitrary files through the bridge) --------------

  /**
   * Lists files previously uploaded (or placed) in the bridge's file
   * transfer root. Optional filters narrow by category/platform/etc.
   */
  async listFiles(
    input: ListFileTransfersRequest = {},
  ): Promise<FileTransferDescriptor[]> {
    const payload = await this.call<ListFileTransfersResult>(
      FILE_TRANSFER_LIST_TOOL_NAME,
      input,
    );
    return payload.files ?? [];
  }

  /** Uploads in-memory bytes through the same bounded source path used by Files. */
  async uploadFile(
    input: {
      filename: string;
      data: Uint8Array | Buffer;
      mimeType?: string;
      category?: ListFileTransfersRequest["category"];
      platform?: FileTransferDescriptor["platform"];
      architecture?: string;
      channel?: string;
      version?: string;
      description?: string;
      metadata?: Record<string, unknown>;
    },
    onProgress?: UploadProgressCallback,
    opts: HermesUploadOptions = {},
  ): Promise<FileTransferDescriptor> {
    const bytes =
      input.data instanceof Uint8Array
        ? input.data
        : new Uint8Array(input.data);
    return this.uploadFileSource(
      {
        ...input,
        source: {
          sizeBytes: bytes.byteLength,
          read: async (start, end) => bytes.slice(start, end),
        },
      },
      onProgress,
      opts,
    );
  }

  /** Hashes and reads bounded slices, then resumes by skipping accepted chunks. */
  async uploadFileSource(
    input: {
      filename: string;
      source: HermesUploadSource;
      mimeType?: string;
      category?: ListFileTransfersRequest["category"];
      platform?: FileTransferDescriptor["platform"];
      architecture?: string;
      channel?: string;
      version?: string;
      description?: string;
      metadata?: Record<string, unknown>;
    },
    onProgress?: UploadProgressCallback,
    opts: HermesUploadOptions = {},
  ): Promise<FileTransferDescriptor> {
    const sha256 = await hashUploadSource(input.source, opts.signal);
    const requestOptions = opts.signal ? { signal: opts.signal } : undefined;
    let init: FileTransferUploadInitResult;
    let received = new Set<number>();

    if (opts.resumeUploadId) {
      try {
        const status = await this.callWithRetry<FileTransferUploadStatusResult>(
          FILE_TRANSFER_UPLOAD_STATUS_TOOL_NAME,
          { uploadId: opts.resumeUploadId },
          requestOptions,
        );
        if (
          status.filename !== input.filename ||
          status.sizeBytes !== input.source.sizeBytes ||
          status.sha256 !== sha256
        ) {
          throw new Error("Selected file does not match the resumable upload");
        }
        init = status;
        received = new Set(status.receivedChunkIndices);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (
          !isUnknownToolError(cause) &&
          !/upload not found|expired/i.test(message)
        ) {
          throw cause;
        }
        init = await this.initializeFileUpload(input, sha256, requestOptions);
      }
    } else {
      init = await this.initializeFileUpload(input, sha256, requestOptions);
    }

    opts.onUploadInitialized?.({ ...init, sha256 });
    const { uploadId, chunkSizeBytes, totalChunks } = init;
    try {
      for (let index = 0; index < totalChunks; index++) {
        throwIfUploadAborted(opts.signal);
        if (!received.has(index)) {
          const start = index * chunkSizeBytes;
          const slice = await input.source.read(
            start,
            Math.min(start + chunkSizeBytes, input.source.sizeBytes),
          );
          await this.callWithRetry(
            FILE_TRANSFER_UPLOAD_CHUNK_TOOL_NAME,
            {
              uploadId,
              index,
              totalChunks,
              contentBase64: bytesToBase64(slice),
            },
            requestOptions,
          );
          received.add(index);
        }
        onProgress?.({
          phase: "uploading",
          uploadedChunks: received.size,
          totalChunks,
          percent: (received.size / totalChunks) * 100,
        });
      }
      onProgress?.({
        phase: "finalizing",
        uploadedChunks: totalChunks,
        totalChunks,
        percent: 100,
      });
      const result = await this.callWithRetry<FileTransferUploadFinalizeResult>(
        FILE_TRANSFER_UPLOAD_FINALIZE_TOOL_NAME,
        { uploadId },
        requestOptions,
      );
      onProgress?.({
        phase: "done",
        uploadedChunks: totalChunks,
        totalChunks,
        percent: 100,
      });
      return result.file;
    } catch (cause) {
      if (!opts.preserveForResume) {
        await this.cancelFileUpload(uploadId).catch(() => undefined);
      }
      throw cause;
    }
  }

  private initializeFileUpload(
    input: {
      filename: string;
      source: HermesUploadSource;
      mimeType?: string;
      category?: ListFileTransfersRequest["category"];
      platform?: FileTransferDescriptor["platform"];
      architecture?: string;
      channel?: string;
      version?: string;
      description?: string;
      metadata?: Record<string, unknown>;
    },
    sha256: string,
    requestOptions?: RequestOptions,
  ): Promise<FileTransferUploadInitResult> {
    return this.callWithRetry<FileTransferUploadInitResult>(
      FILE_TRANSFER_UPLOAD_INIT_TOOL_NAME,
      {
        requestId: createUploadRequestId(),
        filename: input.filename,
        sizeBytes: input.source.sizeBytes,
        sha256,
        mimeType: input.mimeType,
        category: input.category,
        platform: input.platform,
        architecture: input.architecture,
        channel: input.channel,
        version: input.version,
        description: input.description,
        metadata: input.metadata,
      },
      requestOptions,
    );
  }

  /** Cancels a pending upload, discarding any chunks already sent. */
  async cancelFileUpload(uploadId: string): Promise<void> {
    await this.call(FILE_TRANSFER_UPLOAD_CANCEL_TOOL_NAME, { uploadId });
  }

  /** Deletes a file from the bridge's transfer root. */
  async deleteFile(id: string): Promise<boolean> {
    const result = await this.call<{ id: string; deleted: boolean }>(
      FILE_TRANSFER_DELETE_TOOL_NAME,
      { id },
    );
    return result.deleted;
  }

  // -- durable cross-agent handoffs -------------------------------------------
  previewHandoff(
    input: HermesHandoffPreviewInput,
  ): Promise<HermesHandoffPreview> {
    return this.call<HermesHandoffPreview>(
      HERMES_HANDOFF_PREVIEW_TOOL_NAME,
      input,
    );
  }

  async listHandoffs(
    input: {
      agentId?: string;
      chatId?: string;
      limit?: number;
    } = {},
  ): Promise<HermesHandoffRecord[]> {
    const payload = await this.call<{ items: HermesHandoffRecord[] }>(
      HERMES_HANDOFFS_LIST_TOOL_NAME,
      input,
    );
    return payload.items ?? [];
  }

  getHandoff(requestId: string): Promise<HermesHandoffRecord> {
    return this.call<HermesHandoffRecord>(HERMES_HANDOFF_GET_TOOL_NAME, {
      requestId,
    });
  }

  async sendHandoff(input: HermesHandoffSendInput): Promise<{
    events: AsyncIterable<HermesChatEvent>;
    result: Promise<HermesHandoffSendResult>;
    abort(reason?: string): Promise<void>;
  }> {
    const call = await callToolStream<unknown>({
      client: this.mcpClient,
      transport: this.transport,
      name: HERMES_HANDOFF_SEND_TOOL_NAME,
      arguments: input,
    });
    return {
      events: readHermesEvents(call.stream),
      result: call.result.then((value) =>
        readStructured<HermesHandoffSendResult>(value),
      ),
      abort: async (reason?: string) => {
        try {
          await call.abort(reason);
        } catch {
          // expected on deliberate abort
        }
      },
    };
  }

  // -- live chat turn (CEP-41 stream) ------------------------------------------
  /**
   * Sends one message and streams the turn. Omit `chatId` to start a new
   * conversation — the first `chat.started` frame carries the durable id.
   */
  async sendMessage(input: {
    agentId: string;
    chatId?: string;
    text: string;
    /** Working directory to apply before this turn starts. */
    cwd?: string;
    /** Pin this conversation's model for the turn (session-scoped). */
    model?: string;
    /** Optional provider slug for the model switch. */
    provider?: string;
  }): Promise<HermesChatTurn> {
    const call = await callToolStream<unknown>({
      client: this.mcpClient,
      transport: this.transport,
      name: HERMES_CHAT_SEND_TOOL_NAME,
      arguments: {
        agentId: input.agentId,
        text: input.text,
        ...(input.chatId ? { chatId: input.chatId } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.provider ? { provider: input.provider } : {}),
      },
    });
    return {
      events: readHermesEvents(call.stream),
      result: call.result.then((value) =>
        readStructured<HermesSendResult>(value),
      ),
      // The SDK's abort rejects/throws OpenStreamAbortError by design; callers
      // just want the stream stopped, so absorb it.
      abort: async (reason?: string) => {
        try {
          await call.abort(reason);
        } catch {
          // expected on a deliberate abort
        }
      },
    };
  }

  /**
   * Re-attaches to a conversation's RUNNING turn and streams the rest of it —
   * combine with chatHistory()'s `inflight` snapshot for the part already
   * generated. The result's `running` is false when nothing was in flight.
   */
  async watchTurn(
    agentId: string,
    chatId: string,
  ): Promise<{
    events: AsyncIterable<HermesChatEvent>;
    result: Promise<HermesSendResult & { running: boolean }>;
    abort(reason?: string): Promise<void>;
  }> {
    const call = await callToolStream<unknown>({
      client: this.mcpClient,
      transport: this.transport,
      name: HERMES_CHAT_WATCH_TOOL_NAME,
      arguments: { agentId, chatId },
    });
    return {
      events: readHermesEvents(call.stream),
      result: call.result.then((value) =>
        readStructured<HermesSendResult & { running: boolean }>(value),
      ),
      abort: async (reason?: string) => {
        try {
          await call.abort(reason);
        } catch {
          // expected on a deliberate abort
        }
      },
    };
  }

  // -- app-wide activity (CEP-41 stream) --------------------------------------
  /**
   * Opens the long-lived activity stream: which conversations are running a
   * turn right now (snapshot first), then every turn start/completion — with
   * a reply preview — as it happens, across all of this bridge's clients.
   */
  async streamActivity(): Promise<HermesActivityStream> {
    const call = await callToolStream<unknown>({
      client: this.mcpClient,
      transport: this.transport,
      name: HERMES_EVENTS_STREAM_TOOL_NAME,
      arguments: {},
    });
    return {
      events: readActivityEvents(call.stream),
      done: call.result.then(
        () => undefined,
        () => undefined,
      ),
      // The SDK's abort rejects/throws OpenStreamAbortError by design; callers
      // just want the stream stopped, so absorb it.
      abort: async (reason?: string) => {
        try {
          await call.abort(reason);
        } catch {
          // expected on a deliberate abort
        }
      },
    };
  }
}

async function* readActivityEvents(
  stream: AsyncIterable<{ value: string }>,
): AsyncIterable<HermesActivityEvent> {
  for await (const chunk of stream) {
    yield* parseHermesActivityChunk(chunk.value);
  }
}

async function* readHermesEvents(
  stream: AsyncIterable<{ value: string }>,
): AsyncIterable<HermesChatEvent> {
  // CEP-41 does not apply CEP-22 to each open-stream chunk. Keep one decoder
  // for the stream so protocol-level JSONL batches can span many notifications.
  const decoder = new HermesChatEventDecoder();
  for await (const chunk of stream) {
    yield* decoder.push(chunk.value);
  }
}

function readStructured<T>(value: unknown): T {
  if (isObject(value) && isObject(value.structuredContent)) {
    return value.structuredContent as T;
  }
  // The MCP SDK returns { isError: true, content: [{ type: "text", text }] }
  // when a tool handler returns an error result. Surface that text instead of
  // a generic "no structuredContent" message so the caller (and the user)
  // sees the actual failure reason from the bridge.
  if (isObject(value) && value.isError === true) {
    const content = value.content;
    if (Array.isArray(content)) {
      const text = content
        .map((item) =>
          isObject(item) &&
          item.type === "text" &&
          typeof item.text === "string"
            ? item.text
            : "",
        )
        .filter(Boolean)
        .join("\n");
      if (text) throw new Error(text);
    }
  }
  throw new Error(
    "Hermes bridge tool result did not include structuredContent",
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createUploadRequestId(): string {
  return globalThis.crypto.randomUUID();
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return globalThis.btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** File extension for a voice recording's MIME type (transfer-root friendly). */
function voiceExtensionForMime(mimeType: string): string {
  const base = (mimeType.split(";")[0] ?? "").trim().toLowerCase();
  switch (base) {
    case "audio/webm":
      return "webm";
    case "audio/ogg":
      return "ogg";
    case "audio/mp4":
    case "audio/aac":
      return "m4a";
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    case "audio/mpeg":
      return "mp3";
    default:
      return "bin";
  }
}

/**
 * True when the error means "this bridge doesn't register that tool" — used to
 * fall back from the file-transfer voice path to the legacy chunk path on
 * older bridges. Matches the MCP SDK's `Unknown tool: <name>` error text and
 * JSON-RPC method-not-found, but never generic "file not found" failures.
 */
function isUnknownToolError(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  return /unknown tool|method not found/i.test(cause.message);
}

async function hashUploadSource(
  source: HermesUploadSource,
  signal?: AbortSignal,
): Promise<string> {
  const hash = createSha256.create();
  const hashChunkBytes = 1024 * 1024;
  for (let start = 0; start < source.sizeBytes; start += hashChunkBytes) {
    throwIfUploadAborted(signal);
    hash.update(
      await source.read(
        start,
        Math.min(start + hashChunkBytes, source.sizeBytes),
      ),
    );
  }
  return [...hash.digest()]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function throwIfUploadAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

export type {
  HermesActiveTurn,
  HermesActivityEvent,
  HermesAgentProfile,
  HermesChatEvent,
  HermesChatHistoryResult,
  HermesChatMessage,
  HermesChatSummary,
  HermesModelOptions,
  HermesModelProvider,
  HermesModelSwitchResult,
  HermesProject,
  HermesProjectLane,
  HermesProjectRepo,
  HermesProjectsResult,
  HermesSendResult,
  HermesSetCwdResult,
  HermesSetTitleResult,
  HermesSkill,
  HermesSkillsResult,
  HermesTranscribeAudioErrorCode,
  HermesTranscriptionCapabilities,
  HermesTranscriptionLanguage,
  FileTransferDescriptor,
  ListFileTransfersRequest,
} from "@contexcgi/protocol";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { nip19 } from "nostr-tools";
import {
  callToolStream,
  EncryptionMode,
  NostrClientTransport,
  PrivateKeySigner,
  type RelayHandler,
} from "@contextvm/sdk";
import {
  AGENTS_LIST_TOOL_NAME,
  BINARIES_DOWNLOAD_RANGE_TOOL_NAME,
  BINARIES_DOWNLOAD_STREAM_TOOL_NAME,
  BINARIES_DOWNLOAD_TOOL_NAME,
  BINARIES_GET_TOOL_NAME,
  BINARIES_LIST_TOOL_NAME,
  CONVERSATION_TOOL_NAME,
  FILE_TRANSFER_DELETE_TOOL_NAME,
  FILE_TRANSFER_DOWNLOAD_RANGE_TOOL_NAME,
  FILE_TRANSFER_DOWNLOAD_STREAM_TOOL_NAME,
  FILE_TRANSFER_DOWNLOAD_TOOL_NAME,
  FILE_TRANSFER_GET_TOOL_NAME,
  FILE_TRANSFER_LIST_TOOL_NAME,
  FILE_TRANSFER_UPLOAD_CANCEL_TOOL_NAME,
  FILE_TRANSFER_UPLOAD_CHUNK_TOOL_NAME,
  FILE_TRANSFER_UPLOAD_FINALIZE_TOOL_NAME,
  FILE_TRANSFER_UPLOAD_INIT_TOOL_NAME,
  DISCUSSIONS_GET_TOOL_NAME,
  DISCUSSIONS_LIST_TOOL_NAME,
  LOCAL_SESSIONS_GET_TOOL_NAME,
  LOCAL_SESSIONS_LIST_TOOL_NAME,
  MYLOCK_TEXT_GET_TOOL_NAME,
  MYLOCK_TEXT_LIST_TOOL_NAME,
  FILES_DIR_LIST_TOOL_NAME,
  FILES_READ_TOOL_NAME,
  parseStreamChunk,
  type AgentDescriptor,
  type BinaryDescriptor,
  type DeleteFileTransferResult,
  type FileTransferCategory,
  type FileTransferUploadId,
  type DownloadBinaryRangeResult,
  type DownloadBinaryResult,
  type DownloadBinaryStreamResult,
  type DownloadFileTransferRangeResult,
  type DownloadFileTransferResult,
  type DownloadFileTransferStreamResult,
  type FileTransferDescriptor,
  type FileTransferUploadFinalizeResult,
  type FileTransferUploadInitResult,
  type GetBinaryResult,
  type GetFileTransferResult,
  type ListBinariesRequest,
  type ListBinariesResult,
  type ListFileTransfersRequest,
  type ListFileTransfersResult,
  type ConversationStreamEvent,
  type ConversationTurnRequest,
  type ConversationTurnResult,
  type GetDiscussionResult,
  type ListAgentsResult,
  type GetLocalSessionResult,
  type GetMylockTextResult,
  type FilesEntry,
  type FilesEntryKind,
  type ListFilesDirRequest,
  type ListFilesDirResult,
  type ReadFileResult,
  type ListDiscussionsRequest,
  type ListDiscussionsResult,
  type ListLocalSessionsRequest,
  type ListLocalSessionsResult,
  type ListMylockTextsRequest,
  type ListMylockTextsResult,
  type LocalAgentSession,
  type LocalAgentSessionContent,
  type MylockTextDescriptor,
} from "@contexcgi/protocol";

export type ContexcgiClientConfig = {
  privateKey: string;
  serverPubkey: string;
  relays?: string[];
  /** Custom relay pool (e.g. a watchdog-backed one); takes precedence over `relays`. */
  relayHandler?: RelayHandler;
  discoveryRelays?: string[];
  fallbackRelays?: string[];
  encryption?: EncryptionMode;
};

export type ConversationStreamResult = {
  events: AsyncIterable<ConversationStreamEvent>;
  result: Promise<ConversationTurnResult>;
  abort(reason?: string): Promise<void>;
};

export type BinaryDownload = {
  binary: BinaryDescriptor;
  bytes: Uint8Array;
};

export type BinaryDownloadProgress = {
  binary: BinaryDescriptor;
  receivedBytes: number;
  totalBytes: number;
  percent: number;
};

export type FileDownload = {
  file: FileTransferDescriptor;
  bytes: Uint8Array;
};

export type FileDownloadProgress = {
  file: FileTransferDescriptor;
  receivedBytes: number;
  totalBytes: number;
  percent: number;
};

/** One validated range response, suitable for streaming directly to disk. */
export type FileDownloadRangeChunk = {
  file: FileTransferDescriptor;
  offsetBytes: number;
  lengthBytes: number;
  bytes: Uint8Array;
};

export class ContexcgiClient {
  private readonly mcpClient: Client;
  private readonly transport: NostrClientTransport;

  constructor(config: ContexcgiClientConfig) {
    this.transport = new NostrClientTransport({
      signer: new PrivateKeySigner(normalizePrivateKey(config.privateKey)),
      relayHandler: config.relayHandler ?? config.relays,
      discoveryRelayUrls: config.discoveryRelays,
      fallbackOperationalRelayUrls: config.fallbackRelays,
      serverPubkey: normalizePublicKey(config.serverPubkey),
      encryptionMode: config.encryption ?? EncryptionMode.OPTIONAL,
      openStream: {
        enabled: true,
        policy: {
          closeGracePeriodMs: 120_000,
          idleTimeoutMs: 180_000,
          probeTimeoutMs: 60_000,
          maxBufferedChunksPerStream: 2_000,
          maxBufferedBytesPerStream: 128 * 1024 * 1024,
        },
      },
      oversizedTransfer: {
        enabled: true,
        thresholdBytes: 48_000,
        chunkSizeBytes: 48_000,
        policy: {
          maxTransferBytes: 512 * 1024 * 1024,
          maxTransferChunks: 100_000,
        },
      },
    });
    // Clock-skew guard. The SDK subscribes for the bridge's replies with
    // `since: floor(Date.now()/1000)` taken from THIS device's clock, while the
    // bridge stamps its encrypted reply with ITS clock. A relay only delivers an
    // event when `created_at >= since`, so if the phone's clock runs even ~1s
    // ahead of the bridge, every reply is silently filtered out — connect
    // succeeds (session created) but the client never sees the response and
    // hangs. Shifting the subscription's `since` back by a generous band
    // tolerates a fast client clock without meaningfully widening replay.
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

    this.mcpClient = new Client({ name: "contexcgi-client", version: "0.1.0" });
  }

  async connect(): Promise<void> {
    await this.mcpClient.connect(this.transport);
  }

  async close(): Promise<void> {
    await this.mcpClient.close();
  }

  async listAgents(): Promise<AgentDescriptor[]> {
    const result = await this.mcpClient.callTool({
      name: AGENTS_LIST_TOOL_NAME,
      arguments: {},
    });
    return readStructured<ListAgentsResult>(result).agents;
  }

  async listDiscussions(
    input: ListDiscussionsRequest = {},
  ): Promise<ListDiscussionsResult["discussions"]> {
    const result = await this.mcpClient.callTool({
      name: DISCUSSIONS_LIST_TOOL_NAME,
      arguments: input,
    });
    return readStructured<ListDiscussionsResult>(result).discussions;
  }

  async getDiscussion(discussionId: string): Promise<GetDiscussionResult> {
    const result = await this.mcpClient.callTool({
      name: DISCUSSIONS_GET_TOOL_NAME,
      arguments: { discussionId },
    });
    return readStructured<GetDiscussionResult>(result);
  }

  async listLocalSessions(
    input: ListLocalSessionsRequest = {},
  ): Promise<ListLocalSessionsResult["sessions"]> {
    const result = await this.mcpClient.callTool({
      name: LOCAL_SESSIONS_LIST_TOOL_NAME,
      arguments: input,
    });
    return readStructured<ListLocalSessionsResult>(result).sessions;
  }

  async getLocalSessionContent(id: string): Promise<LocalAgentSessionContent> {
    const result = await this.mcpClient.callTool({
      name: LOCAL_SESSIONS_GET_TOOL_NAME,
      arguments: { id },
    });
    return readStructured<GetLocalSessionResult>(result).session;
  }

  async listBinaries(
    input: ListBinariesRequest = {},
  ): Promise<ListBinariesResult["binaries"]> {
    const result = await this.mcpClient.callTool({
      name: BINARIES_LIST_TOOL_NAME,
      arguments: input,
    });
    return readStructured<ListBinariesResult>(result).binaries;
  }

  async getBinary(id: string): Promise<BinaryDescriptor> {
    const result = await this.mcpClient.callTool({
      name: BINARIES_GET_TOOL_NAME,
      arguments: { id },
    });
    return readStructured<GetBinaryResult>(result).binary;
  }

  async downloadBinaryRange(
    id: string,
    onProgress?: (progress: BinaryDownloadProgress) => void,
  ): Promise<BinaryDownload> {
    const binary = await this.getBinary(id);
    const rangeBytes = 45 * 1024;
    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;

    for (let offsetBytes = 0; offsetBytes < binary.sizeBytes;) {
      const result = await this.mcpClient.callTool(
        {
          name: BINARIES_DOWNLOAD_RANGE_TOOL_NAME,
          arguments: {
            id,
            offsetBytes,
            lengthBytes: Math.min(rangeBytes, binary.sizeBytes - offsetBytes),
            encoding: "base64",
          },
        },
        undefined,
        { timeout: 180_000, resetTimeoutOnProgress: true },
      );
      const payload = readStructured<DownloadBinaryRangeResult>(result);
      const bytes = base64ToBytes(payload.contentBase64);
      chunks.push(bytes);
      offsetBytes += payload.lengthBytes;
      receivedBytes += bytes.byteLength;
      onProgress?.({
        binary,
        receivedBytes: Math.min(binary.sizeBytes, receivedBytes),
        totalBytes: binary.sizeBytes,
        percent:
          binary.sizeBytes > 0 ? (receivedBytes / binary.sizeBytes) * 100 : 0,
      });
    }

    const bytes = concatBytes(chunks, receivedBytes);
    const sha256 = await sha256Bytes(bytes);
    if (sha256 !== binary.sha256) {
      throw new Error(`Downloaded binary checksum mismatch for ${id}`);
    }
    return { binary, bytes };
  }

  async downloadBinaryStream(
    id: string,
    onProgress?: (progress: BinaryDownloadProgress) => void,
  ): Promise<BinaryDownload> {
    const binary = await this.getBinary(id);
    const call = await callToolStream<unknown>({
      client: this.mcpClient,
      transport: this.transport,
      name: BINARIES_DOWNLOAD_STREAM_TOOL_NAME,
      arguments: { id, encoding: "base64" },
    });

    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;
    for await (const chunk of call.stream) {
      const bytes = base64ToBytes(chunk.value);
      chunks.push(bytes);
      receivedBytes += bytes.byteLength;
      onProgress?.({
        binary,
        receivedBytes: Math.min(binary.sizeBytes, receivedBytes),
        totalBytes: binary.sizeBytes,
        percent:
          binary.sizeBytes > 0 ? (receivedBytes / binary.sizeBytes) * 100 : 0,
      });
    }

    const payload = readStructured<DownloadBinaryStreamResult>(
      await call.result,
    );
    const bytes = concatBytes(chunks, receivedBytes);
    const sha256 = await sha256Bytes(bytes);
    if (sha256 !== payload.sha256 || sha256 !== payload.binary.sha256) {
      throw new Error(`Downloaded binary checksum mismatch for ${id}`);
    }
    onProgress?.({
      binary: payload.binary,
      receivedBytes: payload.binary.sizeBytes,
      totalBytes: payload.binary.sizeBytes,
      percent: 100,
    });
    return { binary: payload.binary, bytes };
  }

  async downloadBinary(id: string): Promise<BinaryDownload> {
    const result = await this.mcpClient.callTool({
      name: BINARIES_DOWNLOAD_TOOL_NAME,
      arguments: { id, encoding: "base64" },
    });
    const payload = readStructured<DownloadBinaryResult>(result);
    const bytes = base64ToBytes(payload.contentBase64);
    const sha256 = await sha256Bytes(bytes);
    if (sha256 !== payload.sha256 || sha256 !== payload.binary.sha256) {
      throw new Error(`Downloaded binary checksum mismatch for ${id}`);
    }
    return { binary: payload.binary, bytes };
  }

  // --- MyLock shared text -------------------------------------------------

  async listSharedTexts(
    input: ListMylockTextsRequest = {},
  ): Promise<ListMylockTextsResult["texts"]> {
    const result = await this.mcpClient.callTool({
      name: MYLOCK_TEXT_LIST_TOOL_NAME,
      arguments: input,
    });
    const payload = readStructured<
      ListMylockTextsResult & { error?: { message?: unknown } }
    >(result);
    throwSharedTextToolError(payload.error);
    if (!Array.isArray(payload.texts)) {
      throw new Error("Shared text list response is invalid");
    }
    return payload.texts;
  }

  async getSharedText(id: string): Promise<GetMylockTextResult> {
    const result = await this.mcpClient.callTool({
      name: MYLOCK_TEXT_GET_TOOL_NAME,
      arguments: { id },
    });
    const payload = readStructured<
      GetMylockTextResult & { error?: { message?: unknown } }
    >(result);
    throwSharedTextToolError(payload.error);
    if (
      !payload.text ||
      typeof payload.text.id !== "string" ||
      typeof payload.content !== "string"
    ) {
      throw new Error("Shared text response is invalid");
    }
    return payload;
  }

  // --- Files bridge: filesystem navigation + read ------------------------

  async listDir(input: ListFilesDirRequest = {}): Promise<ListFilesDirResult> {
    const result = await this.mcpClient.callTool(
      {
        name: FILES_DIR_LIST_TOOL_NAME,
        arguments: input,
      },
      undefined,
      { timeout: 30_000 },
    );
    const payload = readStructured<
      ListFilesDirResult & { error?: { message?: unknown } }
    >(result);
    throwSharedTextToolError(payload.error);
    if (typeof payload.path !== "string" || !Array.isArray(payload.entries)) {
      throw new Error("Directory list response is invalid");
    }
    return {
      path: payload.path,
      entries: payload.entries,
      total: typeof payload.total === "number" ? payload.total : undefined,
      hasMore: payload.hasMore === true,
    };
  }

  async readFile(path: string): Promise<ReadFileResult> {
    const result = await this.mcpClient.callTool({
      name: FILES_READ_TOOL_NAME,
      arguments: { path },
    });
    const payload = readStructured<
      ReadFileResult & { error?: { message?: unknown } }
    >(result);
    throwSharedTextToolError(payload.error);
    if (
      typeof payload.path !== "string" ||
      typeof payload.name !== "string" ||
      typeof payload.sizeBytes !== "number"
    ) {
      throw new Error("File read response is invalid");
    }
    return payload;
  }

  // --- File transfer (generic file/APK/binary/upload support) -------------

  async listFiles(
    input: ListFileTransfersRequest = {},
  ): Promise<ListFileTransfersResult["files"]> {
    const result = await this.mcpClient.callTool({
      name: FILE_TRANSFER_LIST_TOOL_NAME,
      arguments: input,
    });
    return readStructured<ListFileTransfersResult>(result).files;
  }

  async getFile(id: string): Promise<FileTransferDescriptor> {
    const result = await this.mcpClient.callTool({
      name: FILE_TRANSFER_GET_TOOL_NAME,
      arguments: { id },
    });
    return readStructured<GetFileTransferResult>(result).file;
  }

  async deleteFile(id: string): Promise<DeleteFileTransferResult> {
    const result = await this.mcpClient.callTool({
      name: FILE_TRANSFER_DELETE_TOOL_NAME,
      arguments: { id },
    });
    return readStructured<DeleteFileTransferResult>(result);
  }

  async downloadFile(id: string): Promise<FileDownload> {
    const result = await this.mcpClient.callTool({
      name: FILE_TRANSFER_DOWNLOAD_TOOL_NAME,
      arguments: { id, encoding: "base64" },
    });
    const payload = readStructured<DownloadFileTransferResult>(result);
    const bytes = base64ToBytes(payload.contentBase64);
    const sha256 = await sha256Bytes(bytes);
    if (sha256 !== payload.sha256 || sha256 !== payload.file.sha256) {
      throw new Error(`Downloaded file checksum mismatch for ${id}`);
    }
    return { file: payload.file, bytes };
  }

  async downloadFileStream(
    id: string,
    onProgress?: (progress: FileDownloadProgress) => void,
  ): Promise<FileDownload> {
    const file = await this.getFile(id);
    const call = await callToolStream<unknown>({
      client: this.mcpClient,
      transport: this.transport,
      name: FILE_TRANSFER_DOWNLOAD_STREAM_TOOL_NAME,
      arguments: { id, encoding: "base64" },
    });

    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;
    for await (const chunk of call.stream) {
      const bytes = base64ToBytes(chunk.value);
      chunks.push(bytes);
      receivedBytes += bytes.byteLength;
      onProgress?.({
        file,
        receivedBytes: Math.min(file.sizeBytes, receivedBytes),
        totalBytes: file.sizeBytes,
        percent:
          file.sizeBytes > 0 ? (receivedBytes / file.sizeBytes) * 100 : 0,
      });
    }

    const payload = readStructured<DownloadFileTransferStreamResult>(
      await call.result,
    );
    const bytes = concatBytes(chunks, receivedBytes);
    const sha256 = await sha256Bytes(bytes);
    if (sha256 !== payload.sha256 || sha256 !== payload.file.sha256) {
      throw new Error(`Downloaded file checksum mismatch for ${id}`);
    }
    onProgress?.({
      file: payload.file,
      receivedBytes: payload.file.sizeBytes,
      totalBytes: payload.file.sizeBytes,
      percent: 100,
    });
    return { file: payload.file, bytes };
  }

  /**
   * Downloads and validates one bounded file range without retaining prior
   * ranges. This is the low-memory primitive for native disk-backed clients.
   */
  async downloadFileRangeChunk(
    id: string,
    offsetBytes: number,
    lengthBytes: number = 45 * 1024,
    expectedFile?: FileTransferDescriptor,
    options?: { timeoutMs?: number },
  ): Promise<FileDownloadRangeChunk> {
    if (!Number.isSafeInteger(offsetBytes) || offsetBytes < 0) {
      throw new Error("File range offset must be a non-negative safe integer");
    }
    if (
      !Number.isSafeInteger(lengthBytes) ||
      lengthBytes <= 0 ||
      lengthBytes > 48 * 1024
    ) {
      throw new Error("File range length must be between 1 and 49152 bytes");
    }
    const result = await this.mcpClient.callTool(
      {
        name: FILE_TRANSFER_DOWNLOAD_RANGE_TOOL_NAME,
        arguments: { id, offsetBytes, lengthBytes, encoding: "base64" },
      },
      undefined,
      { timeout: options?.timeoutMs ?? 180_000, resetTimeoutOnProgress: true },
    );
    const payload = readStructured<DownloadFileTransferRangeResult>(result);
    const bytes = base64ToBytes(payload.contentBase64);
    if (payload.file.id !== id || payload.offsetBytes !== offsetBytes) {
      throw new Error(`File range response identity/offset mismatch for ${id}`);
    }
    if (
      payload.lengthBytes !== bytes.byteLength ||
      payload.lengthBytes > lengthBytes ||
      offsetBytes + payload.lengthBytes > payload.file.sizeBytes
    ) {
      throw new Error(`File range response length mismatch for ${id}`);
    }
    if (offsetBytes < payload.file.sizeBytes && payload.lengthBytes === 0) {
      throw new Error(`File range response made no progress for ${id}`);
    }
    if (payload.sha256 !== payload.file.sha256) {
      throw new Error(
        `File range response checksum metadata mismatch for ${id}`,
      );
    }
    if (
      expectedFile &&
      (payload.file.id !== expectedFile.id ||
        payload.file.sizeBytes !== expectedFile.sizeBytes ||
        payload.file.sha256 !== expectedFile.sha256 ||
        payload.file.filename !== expectedFile.filename)
    ) {
      throw new Error(`File changed during range download for ${id}`);
    }
    return {
      file: payload.file,
      offsetBytes: payload.offsetBytes,
      lengthBytes: payload.lengthBytes,
      bytes,
    };
  }

  async downloadFileRange(
    id: string,
    onProgress?: (progress: FileDownloadProgress) => void,
  ): Promise<FileDownload> {
    const file = await this.getFile(id);
    const rangeBytes = 45 * 1024;
    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;

    for (let offsetBytes = 0; offsetBytes < file.sizeBytes;) {
      const chunk = await this.downloadFileRangeChunk(
        id,
        offsetBytes,
        Math.min(rangeBytes, file.sizeBytes - offsetBytes),
        file,
      );
      chunks.push(chunk.bytes);
      offsetBytes += chunk.lengthBytes;
      receivedBytes += chunk.bytes.byteLength;
      onProgress?.({
        file,
        receivedBytes: Math.min(file.sizeBytes, receivedBytes),
        totalBytes: file.sizeBytes,
        percent:
          file.sizeBytes > 0 ? (receivedBytes / file.sizeBytes) * 100 : 0,
      });
    }

    const bytes = concatBytes(chunks, receivedBytes);
    const sha256 = await sha256Bytes(bytes);
    if (sha256 !== file.sha256) {
      throw new Error(`Downloaded file checksum mismatch for ${id}`);
    }
    return { file, bytes };
  }

  /**
   * Uploads a file to the ContextVM host using resumable chunked uploads.
   * The file is split into base64 chunks, each sent as an independent
   * encrypted tool call, then finalized and verified by sha256.
   */
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
    onProgress?: (progress: {
      phase: "uploading" | "finalizing" | "done";
      uploadedChunks: number;
      totalChunks: number;
      percent: number;
    }) => void,
  ): Promise<FileTransferDescriptor> {
    const bytes =
      input.data instanceof Uint8Array
        ? input.data
        : new Uint8Array(input.data);
    const sha256 = await sha256Bytes(bytes);

    const initResult = await this.mcpClient.callTool({
      name: FILE_TRANSFER_UPLOAD_INIT_TOOL_NAME,
      arguments: {
        filename: input.filename,
        sizeBytes: bytes.byteLength,
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
    });
    const init = readStructured<FileTransferUploadInitResult>(initResult);
    const { uploadId, chunkSizeBytes, totalChunks } = init;

    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSizeBytes;
      const end = Math.min(start + chunkSizeBytes, bytes.byteLength);
      const slice = bytes.slice(start, end);
      await this.mcpClient.callTool({
        name: FILE_TRANSFER_UPLOAD_CHUNK_TOOL_NAME,
        arguments: {
          uploadId,
          index: i,
          totalChunks,
          contentBase64: bytesToBase64(slice),
        },
      });
      onProgress?.({
        phase: "uploading",
        uploadedChunks: i + 1,
        totalChunks,
        percent: ((i + 1) / totalChunks) * 100,
      });
    }

    onProgress?.({
      phase: "finalizing",
      uploadedChunks: totalChunks,
      totalChunks,
      percent: 100,
    });

    const finalizeResult = await this.mcpClient.callTool({
      name: FILE_TRANSFER_UPLOAD_FINALIZE_TOOL_NAME,
      arguments: { uploadId },
    });
    const payload =
      readStructured<FileTransferUploadFinalizeResult>(finalizeResult);
    onProgress?.({
      phase: "done",
      uploadedChunks: totalChunks,
      totalChunks,
      percent: 100,
    });
    return payload.file;
  }

  async cancelFileUpload(uploadId: string): Promise<void> {
    await this.mcpClient.callTool({
      name: FILE_TRANSFER_UPLOAD_CANCEL_TOOL_NAME,
      arguments: { uploadId },
    });
  }

  async streamLocalSessionContent(
    id: string,
  ): Promise<LocalAgentSessionContent> {
    const call = await callToolStream<unknown>({
      client: this.mcpClient,
      transport: this.transport,
      name: LOCAL_SESSIONS_GET_TOOL_NAME,
      arguments: { id },
    });

    let content = "";
    for await (const chunk of call.stream) {
      content += chunk.value;
    }

    const result = readStructured<GetLocalSessionResult>(await call.result);
    return {
      ...result.session,
      content: content || result.session.content,
    };
  }

  async sendMessage(
    request: ConversationTurnRequest,
  ): Promise<ConversationStreamResult> {
    const call = await callToolStream<unknown>({
      client: this.mcpClient,
      transport: this.transport,
      name: CONVERSATION_TOOL_NAME,
      arguments: request,
    });

    return {
      events: readConversationEvents(call.stream),
      result: call.result.then(readTurnResult),
      abort: call.abort,
    };
  }
}

export async function* readConversationEvents(
  stream: AsyncIterable<{ value: string }>,
): AsyncIterable<ConversationStreamEvent> {
  for await (const chunk of stream) {
    yield* parseStreamChunk(chunk.value);
  }
}

export function normalizePrivateKey(value: string): string {
  const trimmed = value.trim();
  if (isHexKey(trimmed)) return trimmed.toLowerCase();
  const decoded = nip19.decode(trimmed);
  if (decoded.type !== "nsec")
    throw new Error("Expected private key as hex or nsec");
  return bytesToHex(decoded.data);
}

export function normalizePublicKey(value: string): string {
  const trimmed = value.trim();
  if (isHexKey(trimmed)) return trimmed.toLowerCase();
  const decoded = nip19.decode(trimmed);
  if (decoded.type === "npub") return decoded.data;
  if (decoded.type === "nprofile") return decoded.data.pubkey;
  throw new Error("Expected server pubkey as hex, npub, or nprofile");
}

function throwSharedTextToolError(
  error: { message?: unknown } | undefined,
): void {
  if (error) {
    throw new Error(
      typeof error.message === "string"
        ? error.message
        : "Shared text tool returned an error",
    );
  }
}

function readTurnResult(value: unknown): ConversationTurnResult {
  return readStructured<ConversationTurnResult>(value);
}

function readStructured<T>(value: unknown): T {
  if (isObject(value) && isObject(value.structuredContent)) {
    return value.structuredContent as T;
  }
  throw new Error(
    "ContextVM tool result did not include a ContexCGI structuredContent payload",
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isHexKey(value: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(value);
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64ToBytes(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return globalThis.btoa(binary);
}

function concatBytes(chunks: Uint8Array[], sizeBytes: number): Uint8Array {
  const output = new Uint8Array(sizeBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const input = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(input).set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", input);
  return bytesToHex(new Uint8Array(digest));
}

export {
  PaperclipOpsClient,
  PaperclipTranscriptionError,
  type PaperclipOpsClientConfig,
  type CompanyEventStream,
} from "./paperclip.js";
export * from "./paperclip-types.js";
export type {
  PaperclipLiveEvent,
  PaperclipTranscribeAudioErrorCode,
  PaperclipTranscriptionCapabilities,
  PaperclipTranscriptionLanguage,
} from "@contexcgi/protocol";

export {
  HermesChatClient,
  HermesTranscriptionError,
  type HermesActivityStream,
  type HermesChatClientConfig,
  type HermesChatTurn,
  type HermesUploadOptions,
  type HermesUploadSource,
} from "./hermes.js";
export {
  PiChatClient,
  PiTranscriptionError,
  type PiActivityEvent,
  type PiActivityStream,
  type PiChatClientConfig,
  type PiChatEvent,
  type PiChatHistory,
  type PiChatMessage,
  type PiChatSummary,
  type PiChatTurn,
  type PiSubagentTask,
  type PiHandoffMessageRef,
  type PiHandoffPreview,
  type PiHandoffPreviewInput,
  type PiHandoffRecord,
  type PiHandoffSendInput,
  type PiHandoffSendResult,
  type PiModelOptions,
  type PiModelSwitchResult,
  type PiRepository,
  type PiSendResult,
  type PiTranscriptionCapabilities,
  type PiTranscriptionLanguage,
} from "./pi.js";
export {
  isHermesAutoContinueNote,
  isVisibleHermesHandoffMessage,
} from "@contexcgi/protocol";
export type {
  HermesActiveTurn,
  HermesActivityEvent,
  HermesAgentProfile,
  HermesChatEvent,
  HermesChatHistoryResult,
  HermesChatMessage,
  HermesChatSummary,
  HermesClarifyAnswerResult,
  HermesConversationRef,
  HermesHandoffMessage,
  HermesHandoffMessageRef,
  HermesHandoffMode,
  HermesHandoffPreview,
  HermesHandoffPreviewInput,
  HermesHandoffRecord,
  HermesHandoffSendInput,
  HermesHandoffSendResult,
  HermesHandoffStatus,
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
} from "@contexcgi/protocol";

export {
  QuranClient,
  QuranUserData,
  EMPTY_QURAN_USER_DATA,
  QURAN_BOOKMARKS_D,
  QURAN_BOOKMARKS_KIND,
  QURAN_HIGHLIGHT_KIND,
  QURAN_POSITION_D,
  QURAN_POSITION_KIND,
  highlightFromEvent,
  reassembleAudioPages,
  reduceUserDataEvents,
  type QuranBookmark,
  type QuranClientConfig,
  type QuranHighlight,
  type QuranPosition,
  type QuranUserDataConfig,
  type QuranUserDataState,
  type QuranVerse,
} from "./quran.js";
export type {
  QuranAudioAyah,
  QuranAudioPage,
  QuranAyah,
  QuranEdition,
  QuranEditionLanguage,
  QuranPage,
  QuranPageAyah,
  QuranReciter,
  QuranSurah,
  QuranSurahMeta,
  QuranSurahPage,
  QuranTafsirResult,
} from "@contexcgi/protocol";

export {
  connectionGate,
  isConnectionPending,
  restoreConnectionConfig,
  type ConnectionGate,
  type ConnectionGateInput,
  type ContextVmConnectionConfig,
  type MobileConnectionStatus,
} from "./mobile-session.js";

export { EncryptionMode } from "@contextvm/sdk";
export type {
  AgentDescriptor,
  BinaryDescriptor,
  ConversationStreamEvent,
  ConversationTurnRequest,
  ConversationTurnResult,
  DeleteFileTransferResult,
  FileTransferCategory,
  FileTransferDescriptor,
  FileTransferUploadId,
  GetDiscussionResult,
  GetFileTransferResult,
  GetLocalSessionResult,
  GetMylockTextResult,
  ListBinariesRequest,
  ListDiscussionsRequest,
  ListFileTransfersRequest,
  ListFileTransfersResult,
  ListLocalSessionsRequest,
  ListLocalSessionsResult,
  ListMylockTextsRequest,
  ListMylockTextsResult,
  LocalAgentSession,
  LocalAgentSessionContent,
  MylockTextDescriptor,
  FilesEntry,
  FilesEntryKind,
  ListFilesDirRequest,
  ListFilesDirResult,
  ReadFileResult,
};

export { RoutstrdClient } from "./routstrd.js";
export type { RoutstrdClientConfig } from "./routstrd.js";

export { RoutstrCliClient } from "./routstr-cli.js";
export type { RoutstrCliClientConfig } from "./routstr-cli.js";
export type {
  RoutstrCliNode,
  RoutstrCliNodeDetail,
  RoutstrCliNodesListResult,
  RoutstrCliNodeInfo,
  RoutstrCliModel,
  RoutstrCliProvider,
  RoutstrCliAdminModel,
  RoutstrCliProviderModelsResult,
  RoutstrCliInstructResult,
  RoutstrCliMonitorResult,
} from "@contexcgi/protocol";

export { VaultClient, type VaultClientConfig } from "./vault.js";
export type {
  VaultPairRequestInput,
  VaultPairRequestResult,
  VaultPairStatusResult,
  VaultRelayStatus,
  VaultScope,
  VaultStatus,
  VaultWalletBalance,
  VaultWalletHistoryEntry,
  VaultWalletMint,
  VaultWalletReceiveInput,
  VaultWalletReceiveResult,
  VaultWalletSendInput,
  VaultWalletSendResult,
} from "@contexcgi/protocol";

export { GiteaClient } from "./gitea.js";
export type { GiteaClientConfig } from "./gitea.js";
export type {
  GiteaUser,
  GiteaOrg,
  GiteaRepo,
  GiteaBranch,
  GiteaTag,
  GiteaMilestone,
  GiteaIssue,
  GiteaComment,
  GiteaLabel,
  GiteaPullRequest,
  GiteaPullFile,
  GiteaCommit,
  GiteaCompare,
  GiteaFile,
  GiteaRelease,
} from "@contexcgi/protocol";

export { GithubClient } from "./github.js";
export type { GithubClientConfig } from "./github.js";
export type {
  GithubUser,
  GithubOrg,
  GithubTag,
  GithubMilestone,
  GithubRepo,
  GithubBranch,
  GithubIssue,
  GithubComment,
  GithubPullRequest,
  GithubPullFile,
  GithubCommit,
  GithubCompare,
  GithubFile,
  GithubRelease,
  GithubReview,
  GithubCheckRun,
  GithubWorkflow,
  GithubRun,
} from "@contexcgi/protocol";

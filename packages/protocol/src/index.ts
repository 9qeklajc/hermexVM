export const CONVERSATION_TOOL_NAME = "contexcgi.conversation.send";
export const AGENTS_LIST_TOOL_NAME = "contexcgi.agents.list";
export const DISCUSSIONS_LIST_TOOL_NAME = "contexcgi.discussions.list";
export const DISCUSSIONS_GET_TOOL_NAME = "contexcgi.discussions.get";
export const LOCAL_SESSIONS_LIST_TOOL_NAME = "contexcgi.localSessions.list";
export const LOCAL_SESSIONS_GET_TOOL_NAME = "contexcgi.localSessions.get";
export const BINARIES_LIST_TOOL_NAME = "contexcgi.binaries.list";
export const BINARIES_GET_TOOL_NAME = "contexcgi.binaries.get";
export const BINARIES_DOWNLOAD_TOOL_NAME = "contexcgi.binaries.download";
export const BINARIES_DOWNLOAD_STREAM_TOOL_NAME =
  "contexcgi.binaries.downloadStream";
export const BINARIES_DOWNLOAD_RANGE_TOOL_NAME =
  "contexcgi.binaries.downloadRange";

export type AgentId = string;
export type DiscussionId = string;
export type MessageId = string;
export type RunId = string;

export type AgentDescriptor = {
  id: AgentId;
  label: string;
  adapterKind: string;
  description?: string;
  capabilities: {
    streaming: boolean;
    sessionResume: boolean;
    workspace: boolean;
    tools: boolean;
  };
  metadata?: Record<string, unknown>;
};

export type ListAgentsRequest = Record<string, never>;
export type ListAgentsResult = { agents: AgentDescriptor[] };

export type ConversationRole = "user" | "assistant" | "system" | "tool";

export type ConversationMessage = {
  id: MessageId;
  discussionId: DiscussionId;
  role: ConversationRole;
  content: string;
  agentId?: AgentId;
  runId?: RunId;
  createdAt: string;
};

export type Discussion = {
  id: DiscussionId;
  title?: string;
  createdAt: string;
  updatedAt: string;
  participantAgentIds: AgentId[];
  latestMessagePreview?: string;
};

export type StoredAgentSession = {
  id: string;
  discussionId: DiscussionId;
  agentId: AgentId;
  adapterKind: string;
  sessionKey: string;
  nativeSessionId?: string;
  nativeSessionPath?: string;
  workspacePath?: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string;
  status: "active" | "idle" | "failed" | "expired";
  metadata?: Record<string, unknown>;
};

export type ListDiscussionsRequest = {
  agentId?: AgentId;
  limit?: number;
};

export type ListDiscussionsResult = {
  discussions: Discussion[];
};

export type GetDiscussionRequest = {
  discussionId: DiscussionId;
};

export type GetDiscussionResult = {
  discussion: Discussion;
  messages: ConversationMessage[];
  sessions: StoredAgentSession[];
};

export type LocalAgentSession = {
  id: string;
  provider: "claude-code" | "codex" | "pi-agent" | "unknown";
  sessionId: string;
  path: string;
  relativePath: string;
  project?: string;
  workspacePath?: string;
  createdAt: string;
  updatedAt: string;
  sizeBytes: number;
  preview?: string;
  resumeCommand?: string;
};

export type ListLocalSessionsRequest = {
  limit?: number;
};

export type ListLocalSessionsResult = {
  sessions: LocalAgentSession[];
};

export type GetLocalSessionRequest = {
  id: string;
};

export type LocalAgentSessionContent = LocalAgentSession & {
  content: string;
};

export type GetLocalSessionResult = {
  session: LocalAgentSessionContent;
};

export type BinaryPlatform =
  "android" | "linux" | "darwin" | "windows" | "unknown";

export type BinaryDescriptor = {
  id: string;
  name: string;
  version: string;
  platform: BinaryPlatform;
  architecture?: string;
  channel?: "stable" | "beta" | "nightly" | "dev" | string;
  filename: string;
  sizeBytes: number;
  sha256: string;
  mimeType: string;
  createdAt: string;
  description?: string;
  metadata?: Record<string, unknown>;
};

export type ListBinariesRequest = {
  platform?: BinaryPlatform;
  architecture?: string;
  channel?: string;
};

export type ListBinariesResult = {
  binaries: BinaryDescriptor[];
};

export type GetBinaryRequest = {
  id: string;
};

export type GetBinaryResult = {
  binary: BinaryDescriptor;
};

export type DownloadBinaryRequest = {
  id: string;
  encoding?: "base64";
};

export type DownloadBinaryResult = {
  binary: BinaryDescriptor;
  encoding: "base64";
  contentBase64: string;
  sha256: string;
};

export type DownloadBinaryStreamResult = {
  binary: BinaryDescriptor;
  encoding: "base64";
  streamed: boolean;
  sha256: string;
};

export type DownloadBinaryRangeRequest = {
  id: string;
  offsetBytes: number;
  lengthBytes: number;
  encoding?: "base64";
};

export type DownloadBinaryRangeResult = {
  binary: BinaryDescriptor;
  encoding: "base64";
  offsetBytes: number;
  lengthBytes: number;
  contentBase64: string;
  sha256: string;
};
export const FILE_TRANSFER_LIST_TOOL_NAME = "contexcgi.fileTransfer.list";
export const FILE_TRANSFER_GET_TOOL_NAME = "contexcgi.fileTransfer.get";
export const FILE_TRANSFER_DOWNLOAD_TOOL_NAME =
  "contexcgi.fileTransfer.download";
export const FILE_TRANSFER_DOWNLOAD_STREAM_TOOL_NAME =
  "contexcgi.fileTransfer.downloadStream";
export const FILE_TRANSFER_DOWNLOAD_RANGE_TOOL_NAME =
  "contexcgi.fileTransfer.downloadRange";
export const FILE_TRANSFER_DELETE_TOOL_NAME = "contexcgi.fileTransfer.delete";
export const FILE_TRANSFER_UPLOAD_INIT_TOOL_NAME =
  "contexcgi.fileTransfer.upload.init";
export const FILE_TRANSFER_UPLOAD_STATUS_TOOL_NAME =
  "contexcgi.fileTransfer.upload.status";
export const FILE_TRANSFER_UPLOAD_CHUNK_TOOL_NAME =
  "contexcgi.fileTransfer.upload.chunk";
export const FILE_TRANSFER_UPLOAD_FINALIZE_TOOL_NAME =
  "contexcgi.fileTransfer.upload.finalize";
export const FILE_TRANSFER_UPLOAD_CANCEL_TOOL_NAME =
  "contexcgi.fileTransfer.upload.cancel";

export type FileTransferId = string;
export type FileTransferUploadId = string;

export type FileTransferCategory =
  | "binary"
  | "apk"
  | "archive"
  | "image"
  | "video"
  | "audio"
  | "document"
  | "other";

export type FileTransferDescriptor = {
  id: FileTransferId;
  name: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
  mimeType: string;
  category: FileTransferCategory;
  /** Platform hint inferred from extension (.apk/.exe/.dmg…); "unknown" when not applicable. */
  platform?: BinaryPlatform;
  architecture?: string;
  channel?: "stable" | "beta" | "nightly" | "dev" | string;
  version?: string;
  description?: string;
  createdAt: string;
  /** Last content modification (mtime). createdAt is the inode birthtime, which
   * survives in-place overwrites (cp onto an existing file), so refreshed
   * artifacts keep their original createdAt — display this instead. */
  updatedAt?: string;
  uploadedBy?: string;
  metadata?: Record<string, unknown>;
};

export type ListFileTransfersRequest = {
  category?: FileTransferCategory;
  platform?: BinaryPlatform;
  architecture?: string;
  channel?: string;
  limit?: number;
};

export type ListFileTransfersResult = {
  files: FileTransferDescriptor[];
};

export type GetFileTransferRequest = { id: FileTransferId };

export type GetFileTransferResult = { file: FileTransferDescriptor };

export type DownloadFileTransferRequest = {
  id: FileTransferId;
  encoding?: "base64";
};

export type DownloadFileTransferResult = {
  file: FileTransferDescriptor;
  encoding: "base64";
  contentBase64: string;
  sha256: string;
};

export type DownloadFileTransferStreamResult = {
  file: FileTransferDescriptor;
  encoding: "base64";
  streamed: boolean;
  sha256: string;
};

export type DownloadFileTransferRangeRequest = {
  id: FileTransferId;
  offsetBytes: number;
  lengthBytes: number;
  encoding?: "base64";
};

export type DownloadFileTransferRangeResult = {
  file: FileTransferDescriptor;
  encoding: "base64";
  offsetBytes: number;
  lengthBytes: number;
  contentBase64: string;
  sha256: string;
};

export type DeleteFileTransferRequest = { id: FileTransferId };

export type DeleteFileTransferResult = {
  id: FileTransferId;
  deleted: boolean;
};

export const MYLOCK_TEXT_LIST_TOOL_NAME = "mylock.text.list";
export const MYLOCK_TEXT_GET_TOOL_NAME = "mylock.text.get";
export const MYLOCK_TEXT_MAX_BYTES = 1024 * 1024;

export type MylockTextDescriptor = {
  id: string;
  name: string;
  sizeBytes: number;
  updatedAt: string;
  tooLarge: boolean;
};

export type ListMylockTextsRequest = { limit?: number };
export type ListMylockTextsResult = { texts: MylockTextDescriptor[] };
export type GetMylockTextRequest = { id: string };
export type GetMylockTextResult = {
  text: MylockTextDescriptor;
  content: string;
};

// --- files-bridge: filesystem navigation + read over ContextVM ---

export const FILES_DIR_LIST_TOOL_NAME = "files.dir.list";
export const FILES_READ_TOOL_NAME = "files.read";

/** Per-entry size cap for `files.read` text content (1 MiB). */
export const FILES_READ_MAX_BYTES = 1024 * 1024;

export type FilesEntryKind = "file" | "directory";

export type FilesEntry = {
  /** Path relative to the bridge root, using "/" separators. */
  path: string;
  name: string;
  kind: FilesEntryKind;
  sizeBytes: number;
  updatedAt: string;
  /** Inferred mime type for files; undefined for directories. */
  mimeType?: string;
};

export type ListFilesDirRequest = {
  /** Subdirectory relative to the bridge root; empty/omitted = root. */
  path?: string;
  /** Entry offset for pagination (0-based). */
  offset?: number;
  /** Max entries to return (default: all). */
  limit?: number;
};

export type ListFilesDirResult = {
  path: string;
  entries: FilesEntry[];
  /** Total entries in the directory (before pagination). */
  total?: number;
  /** True when more entries exist beyond this page. */
  hasMore?: boolean;
};

export type ReadFileRequest = {
  /** File path relative to the bridge root. */
  path: string;
};

export type ReadFileResult = {
  path: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  /** UTF-8 text content (only for text-class files; undefined otherwise). */
  content?: string;
  /** True when the file is binary and must be downloaded, not read as text. */
  binary: boolean;
  tooLarge: boolean;
};

/** Initializes a resumable chunked upload. The server reserves an upload slot. */
export type FileTransferUploadInitRequest = {
  /** Client-generated UUID that makes retried initialization idempotent. */
  requestId?: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
  mimeType?: string;
  category?: FileTransferCategory;
  platform?: BinaryPlatform;
  architecture?: string;
  channel?: string;
  version?: string;
  description?: string;
  metadata?: Record<string, unknown>;
};

export type FileTransferUploadInitResult = {
  uploadId: FileTransferUploadId;
  /** Server-imposed max bytes per chunk. */
  chunkSizeBytes: number;
  /** Total chunks the client must send. */
  totalChunks: number;
  /** Absolute deadline (epoch ms) by which the client must finalize. */
  expiresAt: number;
};

export type FileTransferUploadStatusRequest = {
  uploadId: FileTransferUploadId;
};

/** Durable upload state used to resume without resending accepted chunks. */
export type FileTransferUploadStatusResult = FileTransferUploadInitResult & {
  filename: string;
  sizeBytes: number;
  sha256: string;
  receivedChunks: number;
  receivedChunkIndices: number[];
};

/** One base64 slice of a file upload. Chunks are order-independent on the wire. */
export type FileTransferUploadChunkRequest = {
  uploadId: FileTransferUploadId;
  index: number;
  totalChunks: number;
  contentBase64: string;
};

export type FileTransferUploadChunkAck = {
  status: "ok";
  uploadId: FileTransferUploadId;
  receivedChunks: number;
  totalChunks: number;
};

/** Finalizes a fully-uploaded file; returns the resulting FileTransferDescriptor. */
export type FileTransferUploadFinalizeRequest = {
  uploadId: FileTransferUploadId;
};

export type FileTransferUploadFinalizeResult = {
  status: "ok";
  file: FileTransferDescriptor;
};

export type FileTransferUploadCancelRequest = {
  uploadId: FileTransferUploadId;
};
export type FileTransferUploadCancelResult = { status: "ok" };

export type ConversationTurnRequest = {
  discussionId: DiscussionId;
  content: string;
  targetAgentIds?: AgentId[];
  history?: ConversationMessage[];
  metadata?: Record<string, unknown>;
};

export type ConversationTurnResult = {
  discussionId: DiscussionId;
  messageId: MessageId;
  runId: RunId;
  agentId: AgentId;
  content: string;
  sessionKey: string;
};

export type ConversationStreamEvent =
  | {
      type: "run.started";
      discussionId: DiscussionId;
      runId: RunId;
      agentId: AgentId;
    }
  | {
      type: "assistant.delta";
      discussionId: DiscussionId;
      runId: RunId;
      agentId: AgentId;
      text: string;
    }
  | {
      type: "status";
      discussionId: DiscussionId;
      runId: RunId;
      agentId: AgentId;
      message: string;
    }
  | {
      type: "tool.call.started";
      discussionId: DiscussionId;
      runId: RunId;
      agentId: AgentId;
      name: string;
    }
  | {
      type: "tool.call.completed";
      discussionId: DiscussionId;
      runId: RunId;
      agentId: AgentId;
      name: string;
      output?: unknown;
    }
  | {
      type: "error";
      discussionId: DiscussionId;
      runId: RunId;
      agentId: AgentId;
      message: string;
      code?: string;
    }
  | {
      type: "run.completed";
      discussionId: DiscussionId;
      runId: RunId;
      agentId: AgentId;
      content: string;
    };

export function encodeStreamEvent(event: ConversationStreamEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export function parseStreamChunk(chunk: string): ConversationStreamEvent[] {
  return chunk
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ConversationStreamEvent);
}

// ---------------------------------------------------------------------------
// Paperclip bridge — ContextVM tools that proxy a Paperclip REST instance.
// The bridge server holds the Paperclip board API key; clients speak only
// ContextVM (MCP over Nostr) and never see the key or the REST endpoint.
// ---------------------------------------------------------------------------

export const PAPERCLIP_COMPANIES_LIST_TOOL_NAME = "paperclip.companies.list";
export const PAPERCLIP_COMPANIES_STATS_TOOL_NAME = "paperclip.companies.stats";
export const PAPERCLIP_AGENTS_LIST_TOOL_NAME = "paperclip.agents.list";
export const PAPERCLIP_AGENTS_GET_TOOL_NAME = "paperclip.agents.get";
export const PAPERCLIP_AGENTS_WAKE_TOOL_NAME = "paperclip.agents.wake";
export const PAPERCLIP_AGENTS_CONTROL_TOOL_NAME = "paperclip.agents.control";
export const PAPERCLIP_RUNS_LIST_TOOL_NAME = "paperclip.runs.list";
export const PAPERCLIP_RUNS_LIVE_TOOL_NAME = "paperclip.runs.live";
export const PAPERCLIP_RUNS_GET_TOOL_NAME = "paperclip.runs.get";
export const PAPERCLIP_RUNS_CANCEL_TOOL_NAME = "paperclip.runs.cancel";
export const PAPERCLIP_RUN_EVENTS_TOOL_NAME = "paperclip.runs.events";
export const PAPERCLIP_RUN_LOG_TOOL_NAME = "paperclip.runs.log";
export const PAPERCLIP_APPROVALS_LIST_TOOL_NAME = "paperclip.approvals.list";
export const PAPERCLIP_APPROVALS_GET_TOOL_NAME = "paperclip.approvals.get";
export const PAPERCLIP_APPROVALS_DECIDE_TOOL_NAME =
  "paperclip.approvals.decide";
export const PAPERCLIP_APPROVAL_COMMENTS_TOOL_NAME =
  "paperclip.approvals.comments";
export const PAPERCLIP_ISSUES_LIST_TOOL_NAME = "paperclip.issues.list";
export const PAPERCLIP_ISSUES_GET_TOOL_NAME = "paperclip.issues.get";
export const PAPERCLIP_ISSUE_COMMENTS_TOOL_NAME = "paperclip.issues.comments";
export const PAPERCLIP_ISSUE_COMMENT_TOOL_NAME = "paperclip.issues.comment";
export const PAPERCLIP_ISSUE_UPDATE_TOOL_NAME = "paperclip.issues.update";
export const PAPERCLIP_ISSUE_INTERACTIONS_TOOL_NAME =
  "paperclip.issues.interactions";
export const PAPERCLIP_ISSUE_INTERACTION_DECIDE_TOOL_NAME =
  "paperclip.issues.interaction.decide";
export const PAPERCLIP_ISSUE_APPROVALS_TOOL_NAME = "paperclip.issues.approvals";
export const PAPERCLIP_ISSUE_ACTIVITY_TOOL_NAME = "paperclip.issues.activity";
export const PAPERCLIP_ISSUE_RUNS_TOOL_NAME = "paperclip.issues.runs";
export const PAPERCLIP_ISSUE_CREATE_TOOL_NAME = "paperclip.issues.create";
export const PAPERCLIP_ISSUE_ATTACHMENTS_TOOL_NAME =
  "paperclip.issues.attachments";
export const PAPERCLIP_ISSUE_ATTACHMENT_DELETE_TOOL_NAME =
  "paperclip.issues.attachment.delete";
export const PAPERCLIP_ISSUE_WORK_PRODUCTS_TOOL_NAME =
  "paperclip.issues.work-products";
export const PAPERCLIP_ISSUE_COST_TOOL_NAME = "paperclip.issues.cost";
export const PAPERCLIP_ISSUE_DOCUMENTS_TOOL_NAME = "paperclip.issues.documents";
export const PAPERCLIP_ISSUE_DOCUMENT_GET_TOOL_NAME =
  "paperclip.issues.document.get";
export const PAPERCLIP_ISSUE_COMMENT_DELETE_TOOL_NAME =
  "paperclip.issues.comment.delete";
/** CEP-41 open-ended stream: bridges a company's live-events WebSocket. */
export const PAPERCLIP_EVENTS_STREAM_TOOL_NAME = "paperclip.events.stream";

/** A Paperclip live event, forwarded verbatim from the company WebSocket. */
export type PaperclipLiveEvent = {
  id: number;
  companyId: string;
  type: string;
  createdAt: string;
  payload: Record<string, unknown>;
};

export function encodePaperclipEvent(event: PaperclipLiveEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export function parsePaperclipChunk(chunk: string): PaperclipLiveEvent[] {
  return chunk
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PaperclipLiveEvent);
}

// ---------------------------------------------------------------------------
// Paperclip voice transcription — the bridge transcribes short recordings
// locally with whisper.cpp (no cloud service). A recording is uploaded as
// many small independently-encrypted `chunk` tool calls (each well under the
// relay transport's single-message ciphertext limit), then finalized by
// uploadId; the transcript is appended to whatever the user was typing.
// ---------------------------------------------------------------------------

export const PAPERCLIP_TRANSCRIPTION_CAPABILITIES_TOOL_NAME =
  "paperclip.transcription.capabilities";
export const PAPERCLIP_TRANSCRIPTION_CHUNK_TOOL_NAME =
  "paperclip.transcription.chunk";
/** Finalizes a completed chunk upload (by uploadId) and returns the transcript. */
export const PAPERCLIP_TRANSCRIBE_AUDIO_TOOL_NAME =
  "paperclip.transcription.transcribe";
export const PAPERCLIP_TRANSCRIPTION_CANCEL_TOOL_NAME =
  "paperclip.transcription.cancel";

/** What a client may record/send, and whether the bridge can transcribe right now. */
export type PaperclipTranscriptionCapabilities = {
  available: boolean;
  maxDurationSeconds: number;
  maxAudioBytes: number;
  acceptedMimeTypes: string[];
  /** Present only when `available` is false. Never contains paths or secrets. */
  reason?: string;
};

/** One small slice of a recording's base64 body. Chunks are order-independent on the wire. */
export type PaperclipTranscriptionChunkRequest = {
  uploadId: string;
  index: number;
  totalChunks: number;
  contentBase64: string;
};

export type PaperclipTranscriptionChunkAck = {
  status: "ok";
  uploadId: string;
  receivedChunks: number;
  totalChunks: number;
};

/** Finalizes a fully-uploaded recording; no audio travels in this call. */
export type PaperclipTranscriptionLanguage = "auto" | "de" | "en";

export type PaperclipTranscribeAudioRequest = {
  uploadId: string;
  mimeType: string;
  /** Spoken language. `auto` detects it; `de`/`en` prevent short clips being misclassified. */
  language?: PaperclipTranscriptionLanguage;
  /** Client-measured recording length, if known. Advisory only — the bridge re-derives it. */
  durationMs?: number;
};

export type PaperclipTranscribeAudioSuccess = {
  status: "ok";
  transcript: string;
  durationSeconds: number;
};

export type PaperclipTranscribeAudioErrorCode =
  | "UNSUPPORTED"
  | "INVALID_AUDIO"
  | "TOO_LARGE"
  | "TOO_LONG"
  | "BUSY"
  | "TIMEOUT"
  | "TRANSCRIPTION_FAILED"
  | "UPLOAD_NOT_FOUND";

export type PaperclipTranscribeAudioFailure = {
  status: "error";
  code: PaperclipTranscribeAudioErrorCode;
  message: string;
  /** Whether the client can usefully retry (e.g. BUSY/TIMEOUT) without changing anything. */
  retryable: boolean;
};

export type PaperclipTranscriptionChunkResult =
  PaperclipTranscriptionChunkAck | PaperclipTranscribeAudioFailure;

export type PaperclipTranscribeAudioResult =
  PaperclipTranscribeAudioSuccess | PaperclipTranscribeAudioFailure;

export type PaperclipTranscriptionCancelRequest = { uploadId: string };
/** Always succeeds — cancelling an unknown/already-finalized upload is a no-op. */
export type PaperclipTranscriptionCancelResult = { status: "ok" };

// ---------------------------------------------------------------------------
// Hermes bridge — ContextVM tools that proxy a local Hermes Agent install
// (https://hermes-agent.nousresearch.com). The bridge spawns Hermes's
// tui_gateway JSON-RPC child and re-publishes agent profiles, conversations,
// and live-streamed chat turns as ContextVM tools (CEP-41 for streaming).
// Clients speak only ContextVM and never see the Hermes host.
// ---------------------------------------------------------------------------

export const HERMES_AGENTS_LIST_TOOL_NAME = "hermes.agents.list";
export const HERMES_CHATS_LIST_TOOL_NAME = "hermes.chats.list";
export const HERMES_CHATS_DELETE_TOOL_NAME = "hermes.chats.delete";
export const HERMES_CHAT_HISTORY_TOOL_NAME = "hermes.chats.history";
/** CEP-41 stream: send one message, stream the whole agent turn live. */
export const HERMES_CHAT_SEND_TOOL_NAME = "hermes.chat.send";
/** CEP-41 stream: re-attach to a conversation's RUNNING turn and stream the rest. */
export const HERMES_CHAT_WATCH_TOOL_NAME = "hermes.chat.watch";
export const HERMES_CHAT_INTERRUPT_TOOL_NAME = "hermes.chat.interrupt";
/** Answer a pending mid-turn shell approval (choice: once/session/always/deny). */
export const HERMES_CHAT_APPROVE_TOOL_NAME = "hermes.chat.approve";
/** Answer a pending mid-turn clarifying question (agent asked the user to pick/type). */
export const HERMES_CHAT_CLARIFY_ANSWER_TOOL_NAME =
  "hermes.chat.clarify.answer";
/** Set or read the title of a conversation (proxies tui_gateway session.title). */
export const HERMES_CHAT_SET_TITLE_TOOL_NAME = "hermes.chat.title";
/** List every available model grouped by provider (proxies tui_gateway model.options). */
export const HERMES_MODELS_LIST_TOOL_NAME = "hermes.models.list";
/** Switch the conversation's model for the next request (proxies config.set model). */
export const HERMES_MODEL_SWITCH_TOOL_NAME = "hermes.model.switch";
/** Canonicalize and validate an immutable cross-agent handoff snapshot. */
export const HERMES_HANDOFF_PREVIEW_TOOL_NAME = "hermes.handoffs.preview";
/** CEP-41 stream: persist and deliver a confirmed cross-agent handoff. */
export const HERMES_HANDOFF_SEND_TOOL_NAME = "hermes.handoffs.send";
export const HERMES_HANDOFFS_LIST_TOOL_NAME = "hermes.handoffs.list";
export const HERMES_HANDOFF_GET_TOOL_NAME = "hermes.handoffs.get";

/** One Hermes profile, presented as a chattable agent ("contact"). */
export type HermesAgentProfile = {
  /** Stable agent id: "default" for the root HERMES_HOME, else the profile name. */
  id: string;
  name: string;
  /** Operator-facing description from profile.yaml (may be empty). */
  description: string;
  /** First lines of the profile's SOUL.md, for the contact card. */
  soulExcerpt?: string;
  /** The profile's configured default model, when readable. */
  model?: string;
  isDefault: boolean;
};

export type HermesListAgentsResult = { agents: HermesAgentProfile[] };

/** A persisted Hermes conversation (session row) for one agent profile. */
export type HermesChatSummary = {
  /** Durable chat id — the Hermes session key; stable across resumes. */
  id: string;
  agentId: string;
  title: string;
  preview: string;
  /** Epoch seconds. */
  startedAt: number;
  messageCount: number;
  /** Which surface started it (tui, telegram, contextvm, …). */
  source: string;
};

export type HermesChatRole = "user" | "assistant" | "system" | "tool";

export type HermesChatMessage = {
  role: HermesChatRole;
  text: string;
  /** Stable position within the filtered gateway transcript. */
  ordinal?: number;
  /** SHA-256 of the canonical role/text pair, used for stale-selection checks. */
  digest?: string;
  /** Tool name for role "tool" rows, when known. */
  name?: string;
  /** True when this row's text was clipped to keep the reply under NIP-44's ceiling. */
  truncated?: boolean;
};

export type HermesConversationContext = {
  /** The model currently active for this conversation. */
  model?: string;
  /** The provider currently active for this conversation. */
  provider?: string;
  /** The working directory currently pinned to this conversation. */
  cwd?: string;
};

export type HermesConversationRef = {
  agentId: string;
  chatId: string;
  title?: string;
};

export type HermesHandoffMessageRef = {
  ordinal: number;
  role: "user" | "assistant";
  digest: string;
};

export type HermesHandoffMessage = HermesHandoffMessageRef & { text: string };

export type HermesHandoffMode = "selected" | "full";

export type HermesHandoffPreviewInput = {
  source: HermesConversationRef;
  mode: HermesHandoffMode;
  selected?: HermesHandoffMessageRef[];
  destination:
    | { kind: "new"; agentId: string; title: string; cwd?: string }
    | { kind: "existing"; agentId: string; chatId: string; title?: string };
  instructions: string;
};

export type HermesHandoffPreview = {
  schemaVersion: 1;
  source: HermesConversationRef;
  destination: HermesHandoffPreviewInput["destination"];
  mode: HermesHandoffMode;
  messages: HermesHandoffMessage[];
  instructions: string;
  envelope: string;
  byteCount: number;
  previewDigest: string;
};

export type HermesHandoffStatus =
  "accepted" | "running" | "completed" | "failed" | "interrupted";

export type HermesHandoffRecord = {
  schemaVersion: 1;
  requestId: string;
  artifactId: string;
  source: HermesConversationRef;
  destination: HermesHandoffPreviewInput["destination"];
  destinationChatId?: string;
  mode: HermesHandoffMode;
  messageCount: number;
  instructions: string;
  previewDigest: string;
  status: HermesHandoffStatus;
  responseText?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type HermesHandoffSendInput = HermesHandoffPreviewInput & {
  requestId: string;
  previewDigest: string;
};

export type HermesHandoffSendResult = HermesSendResult & {
  requestId: string;
  artifactId: string;
  status: HermesHandoffStatus;
};

export type HermesChatHistoryResult = {
  agentId: string;
  chatId: string;
  messages: HermesChatMessage[];
  /** Effective model/provider/project context restored with the conversation. */
  context?: HermesConversationContext;
  /** True when a turn is running right now (watch it via hermes.chat.watch). */
  running?: boolean;
  /** Snapshot of the in-flight turn, so a reopened chat can render it. */
  inflight?: {
    /** The user message that started the running turn. */
    user?: string;
    /** Assistant text streamed so far. */
    assistant?: string;
  };
  /**
   * Present when the transcript did not fit in one ContextVM reply. NIP-44 caps
   * a message's plaintext at 65535 bytes, and the transport rejects the whole
   * reply rather than fragmenting it, so an oversized transcript would other-
   * wise never reach the client at all. The newest messages are kept.
   */
  truncated?: {
    /** How many older messages were dropped from the head of the transcript. */
    omittedMessages: number;
  };
};

/**
 * One JSONL frame of a live `hermes.chat.send` turn. Mirrors the Hermes
 * tui_gateway event stream, slimmed to what a chat UI renders.
 */
export type HermesChatEvent =
  | {
      type: "chat.started";
      agentId: string;
      /** Durable chat id (session key) — echo it back on the next send. */
      chatId: string;
      /** Whether this send created a brand-new conversation. */
      created: boolean;
    }
  | { type: "thinking.delta"; text?: string }
  | { type: "status"; text: string }
  | { type: "message.delta"; text: string }
  /** A mid-turn assistant message (e.g. before a tool call). */
  | { type: "message.interim"; text: string }
  | { type: "tool.start"; toolId: string; name?: string; argsText?: string }
  /** Live output/preview from a running tool (e.g. streaming command output). */
  | { type: "tool.progress"; name?: string; preview?: string }
  | {
      type: "tool.complete";
      toolId: string;
      name?: string;
      summary?: string;
      error?: string;
      durationSeconds?: number;
    }
  /** The agent wants to run a command and is blocked on an approval. */
  | {
      type: "approval.request";
      command: string;
      description?: string;
      choices?: string[];
    }
  /** The agent asked the user a question (pick a choice or type) and is blocked on an answer. */
  | {
      type: "clarify.request";
      question: string;
      choices?: string[];
      requestId: string;
    }
  /** Terminal frame of a successful turn — carries the full response text. */
  | { type: "message.complete"; text: string; failureReason?: string }
  | { type: "error"; message: string }
  | { type: "keepalive"; ts: number };

export function encodeHermesChatEvent(event: HermesChatEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export function parseHermesChatChunk(chunk: string): HermesChatEvent[] {
  return chunk
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as HermesChatEvent);
}

export type HermesSendResult = {
  agentId: string;
  chatId: string;
  /** Final assistant text (empty when the turn failed before responding). */
  text: string;
  interrupted: boolean;
};

/** Result of answering a pending mid-turn clarifying question. */
export type HermesClarifyAnswerResult = {
  agentId: string;
  chatId: string;
  /** The answer submitted to the agent. */
  answer: string;
};

// ---------------------------------------------------------------------------
// Hermes conversation title — set or read the human-facing title of one
// conversation. Setting a title before the first send lets the user name a
// new conversation up front instead of waiting for the auto-generated one.
// ---------------------------------------------------------------------------

export type HermesSetTitleResult = {
  agentId: string;
  chatId: string;
  title: string;
  /** True when the title was queued (not yet persisted) — always false when set. */
  pending: boolean;
};

// ---------------------------------------------------------------------------
// Hermes model picker — one CEP tool that lists every available model grouped
// by provider, mirroring the Hermes TUI/desktop model picker. The app renders
// this as a modal; selecting a model calls hermes.model.switch to pin it for
// the next request in this conversation.
// ---------------------------------------------------------------------------

/** One provider row in the model picker, with its curated model list. */
export type HermesModelProvider = {
  /** Stable provider slug (e.g. "openrouter", "anthropic", "custom:ollama"). */
  slug: string;
  /** Human-friendly provider name. */
  name: string;
  /** True when this provider is the currently active one for the session. */
  isCurrent: boolean;
  /** True when the provider has credentials configured and usable. */
  authenticated?: boolean;
  /** Curated model IDs available under this provider. */
  models: string[];
  /** Total model count (may exceed `models` when capped for display). */
  totalModels: number;
  /** Whether this is a user-defined custom endpoint. */
  isUserDefined?: boolean;
  /** Per-model capability hints, when available. */
  capabilities?: Record<string, { fast?: boolean; reasoning?: boolean }>;
};

/** The full model picker payload — providers, current selection. */
export type HermesModelOptions = {
  /** Every provider row, in display order. */
  providers: HermesModelProvider[];
  /** The currently active model id (may be empty before the first turn). */
  model: string;
  /** The currently active provider slug. */
  provider: string;
};

/** Result of switching the conversation's model. */
export type HermesModelSwitchResult = {
  /** The new model id that will be used on the next request. */
  value: string;
  /** Scope of the switch — "session" (this conversation only) or "global". */
  scope: string;
  /** Optional warning (e.g. expensive-model confirmation). */
  warning?: string;
  /** True when an explicit confirmation is required before the switch applies. */
  confirmRequired?: boolean;
  /** The confirmation prompt, when `confirmRequired` is true. */
  confirmMessage?: string;
};

// ---------------------------------------------------------------------------
// Hermes voice transcription — identical wire protocol to the Paperclip one
// (chunked base64 upload → finalize by uploadId → local whisper.cpp on the
// bridge, no cloud service); only the tool names differ. The payload shapes
// are shared with the Paperclip transcription types below/above.
// ---------------------------------------------------------------------------

export const HERMES_TRANSCRIPTION_CAPABILITIES_TOOL_NAME =
  "hermes.transcription.capabilities";
export const HERMES_TRANSCRIPTION_CHUNK_TOOL_NAME =
  "hermes.transcription.chunk";
/** Finalizes a completed chunk upload (by uploadId) and returns the transcript. */
export const HERMES_TRANSCRIBE_AUDIO_TOOL_NAME =
  "hermes.transcription.transcribe";
export const HERMES_TRANSCRIPTION_CANCEL_TOOL_NAME =
  "hermes.transcription.cancel";

export type HermesTranscriptionCapabilities =
  PaperclipTranscriptionCapabilities;
export type HermesTranscriptionChunkRequest =
  PaperclipTranscriptionChunkRequest;
export type HermesTranscriptionChunkResult = PaperclipTranscriptionChunkResult;
/** Spoken-language hint for hermes transcription; "auto" lets whisper detect. */
export type HermesTranscriptionLanguage =
  "auto" | "en" | "de" | "fr" | "ar" | "es" | "it";

export type HermesTranscribeAudioRequest = Omit<
  PaperclipTranscribeAudioRequest,
  "language"
> & {
  /** Force the transcription language instead of auto-detecting (never translates). */
  language?: HermesTranscriptionLanguage;
};
export type HermesTranscribeAudioResult = PaperclipTranscribeAudioResult;
export type HermesTranscribeAudioErrorCode = PaperclipTranscribeAudioErrorCode;

/**
 * Transcribes a voice recording previously uploaded through the resumable,
 * sha256-verified `contexcgi.fileTransfer.upload.*` tools. Preferred over the
 * legacy hermes.transcription.chunk + transcribe pair: the file-transfer path
 * is resumable, checksum-verified, and retries safely per chunk.
 */
export const HERMES_TRANSCRIBE_FILE_TOOL_NAME =
  "hermes.transcription.transcribe_file";

export type HermesTranscribeFileRequest = {
  /** File-transfer id of the uploaded recording (contexcgi.fileTransfer.*). */
  id: string;
  mimeType: string;
  /** Client-measured recording length, if known. Advisory only. */
  durationMs?: number;
  /** Force the transcription language instead of auto-detecting. */
  language?: HermesTranscriptionLanguage;
};

export type HermesTranscribeFileResult = PaperclipTranscribeAudioResult;

// ---------------------------------------------------------------------------
// Hermes activity stream — one CEP-41 stream per app instance announcing which
// conversations are running a turn right now, so every connected device can
// show live "working…" indicators and notify on replies it didn't stream
// itself. Covers turns started through this bridge (any client).
// ---------------------------------------------------------------------------

/** CEP-41 open-ended stream of turn activity across all agents/conversations. */
export const HERMES_EVENTS_STREAM_TOOL_NAME = "hermes.events.stream";

export type HermesActiveTurn = {
  agentId: string;
  chatId: string;
  /** Epoch ms when the turn was submitted. */
  startedAt: number;
};

export type HermesActivityEvent =
  /** First frame on every stream: the turns running at subscribe time. */
  | { type: "activity.snapshot"; turns: HermesActiveTurn[] }
  | { type: "turn.started"; agentId: string; chatId: string; at: number }
  | {
      type: "turn.completed";
      agentId: string;
      chatId: string;
      at: number;
      /** First ~160 chars of the reply, for the notification body. */
      preview?: string;
      failureReason?: string;
    }
  | { type: "keepalive"; ts: number };

export function encodeHermesActivityEvent(event: HermesActivityEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export function parseHermesActivityChunk(chunk: string): HermesActivityEvent[] {
  return chunk
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as HermesActivityEvent);
}

// ---------------------------------------------------------------------------
// Hermes projects — ContextVM tools that list every project the agent has ever
// worked in (from the session-store's `cwd` history + git probing), so the app
// can surface them as a picker. Selecting one pins it as the conversation's
// working directory via `hermes.session.cwd.set`, so the agent operates in
// that project without being told each time.
// ---------------------------------------------------------------------------

/** List projects the agent has worked in (proxies tui_gateway projects.tree). */
export const HERMES_PROJECTS_LIST_TOOL_NAME = "hermes.projects.list";

/** Set the conversation's working directory (proxies tui_gateway session.cwd.set). */
export const HERMES_SESSION_CWD_SET_TOOL_NAME = "hermes.session.cwd.set";

/** List every skill installed for a profile (scanned from SKILL.md frontmatter). */
export const HERMES_SKILLS_LIST_TOOL_NAME = "hermes.skills.list";

/** One lane (git branch / worktree) inside a repo. */
export type HermesProjectLane = {
  id: string;
  label: string;
  path: string;
  isMain: boolean;
  isKanban?: boolean;
};

/** One repo (git root or path grouping) inside a project. */
export type HermesProjectRepo = {
  id: string;
  label: string;
  path: string;
  sessionCount: number;
  lanes: HermesProjectLane[];
};

/** One project the agent has worked in — explicit (user-created) or auto-discovered. */
export type HermesProject = {
  /** Project id: `p_<hex>` for explicit, or the repo root path for auto. */
  id: string;
  /** Display name. */
  label: string;
  /** Primary path / root directory. */
  path: string;
  /** User-chosen color (explicit projects only). */
  color?: string;
  /** User-chosen icon (explicit projects only). */
  icon?: string;
  /** True when auto-discovered from session cwd history (not user-created). */
  isAuto: boolean;
  /** Total sessions in this project. */
  sessionCount: number;
  /** Epoch ms of the most recent session activity. */
  lastActive: number;
  /** Repos (git roots) inside this project. */
  repos: HermesProjectRepo[];
};

/** Result of `hermes.projects.list` — the full project tree for one profile. */
export type HermesProjectsResult = {
  agentId: string;
  projects: HermesProject[];
  /** The active project id, when one is set on the host. */
  activeId: string | null;
};

/** Result of `hermes.session.cwd.set` — the session info after setting the cwd. */
export type HermesSetCwdResult = {
  agentId: string;
  chatId: string;
  /** The new working directory. */
  cwd: string;
  /** Git branch detected for the new cwd, when available. */
  branch?: string;
  /** Project name detected for the new cwd, when available. */
  project?: string;
};

// ---------------------------------------------------------------------------
// Hermes skills — ContextVM tool that lists every skill installed for a
// profile, scanned directly from SKILL.md frontmatter on the bridge (no
// gateway round-trip). The app renders this as a picker so the user can see
// what the agent can do and ask targeted questions without guessing.
// ---------------------------------------------------------------------------

/** One skill installed for a Hermes profile. */
export type HermesSkill = {
  /** Skill name from SKILL.md frontmatter (or directory name as fallback). */
  name: string;
  /** One-line description from SKILL.md frontmatter. */
  description: string;
  /** Category — either from frontmatter or inferred from the parent directory. */
  category: string;
  /** The SKILL.md path, relative to the profile's skills root. */
  path: string;
};

/** Result of `hermes.skills.list` — all skills for one profile. */
export type HermesSkillsResult = {
  agentId: string;
  skills: HermesSkill[];
};

// ---------------------------------------------------------------------------
// Quran bridge — ContextVM tools that serve the Holy Quran in four editions
// (Arabic, English, German, French) plus per-verse tafsir. The bridge wraps
// public Quran APIs and caches the immutable text; clients speak only
// ContextVM (MCP over Nostr). User data (reading position, bookmarks,
// highlights) is NOT proxied — apps store it as Nostr events, boris-style.
// ---------------------------------------------------------------------------

export const QURAN_EDITIONS_LIST_TOOL_NAME = "quran.editions.list";
export const QURAN_SURAHS_LIST_TOOL_NAME = "quran.surahs.list";
export const QURAN_SURAH_GET_TOOL_NAME = "quran.surah.get";
export const QURAN_PAGE_GET_TOOL_NAME = "quran.page.get";
export const QURAN_VERSE_GET_TOOL_NAME = "quran.verse.get";
export const QURAN_TAFSIR_GET_TOOL_NAME = "quran.tafsir.get";
export const QURAN_AUDIO_RECITERS_LIST_TOOL_NAME = "quran.audio.reciters.list";
export const QURAN_AUDIO_SURAH_GET_TOOL_NAME = "quran.audio.surah.get";

export type QuranEditionLanguage = "ar" | "en" | "de" | "fr";

/** One translation/reading of the Quran the bridge can serve. */
export type QuranEdition = {
  /** Stable id used in every other tool call (e.g. "quran-uthmani"). */
  id: string;
  language: QuranEditionLanguage;
  /** Human label, e.g. "العربية — Uthmani" or "Deutsch — Bubenheim & Elyas". */
  name: string;
  /** Translator/revisor for non-Arabic editions. */
  translator?: string;
  direction: "rtl" | "ltr";
};

/** One chapter of the Quran, without its verses. */
export type QuranSurahMeta = {
  /** 1..114. */
  number: number;
  /** Arabic name, e.g. "سُورَةُ ٱلْفَاتِحَةِ". */
  name: string;
  /** Transliterated name, e.g. "Al-Faatiha". */
  englishName: string;
  /** Meaning of the name, e.g. "The Opening". */
  englishNameTranslation: string;
  revelationType: "Meccan" | "Medinan";
  ayahCount: number;
};

/** One verse. `numberInSurah` is the anchor highlights/bookmarks point at. */
export type QuranAyah = {
  numberInSurah: number;
  text: string;
  juz: number;
  page: number;
  hizbQuarter: number;
  sajda: boolean;
};

export type QuranSurah = QuranSurahMeta & { ayahs: QuranAyah[] };

/** One verse on a canonical Madani Mushaf page, with its chapter identity. */
export type QuranPageAyah = QuranAyah & { surah: QuranSurahMeta };

/** One canonical Madani Mushaf page (1..604), which may cross surah boundaries. */
export type QuranPage = {
  number: number;
  ayahs: QuranPageAyah[];
};

/** One Arabic recitation edition exposed by the Quran bridge. */
export type QuranReciter = {
  id: string;
  name: string;
  arabicName: string;
};

/** One directly streamable ayah recording; audio bytes never cross ContextVM. */
export type QuranAudioAyah = {
  surah: number;
  ayah: number;
  globalAyah: number;
  url: string;
  fallbackUrl?: string;
};

/** One bounded audio-manifest page; clients concatenate pages in ayah order. */
export type QuranAudioPage = {
  surah: number;
  reciter: string;
  ayahs: QuranAudioAyah[];
  fromAyah: number;
  nextAyah?: number;
};

/** One bounded transport page; clients concatenate pages into `QuranSurah`. */
export type QuranSurahPage = QuranSurahMeta & {
  ayahs: QuranAyah[];
  /** First ayah requested (1-based). */
  fromAyah: number;
  /** First ayah of the next page; absent when this is the final page. */
  nextAyah?: number;
};

/** Plain-text explanation of one verse, with language-fallback bookkeeping. */
export type QuranTafsirResult = {
  /** "2:255". */
  verseKey: string;
  requestedLanguage: QuranEditionLanguage;
  /** Actual language of the returned tafsir (differs on fallback). */
  language: string;
  /** True when no tafsir exists in the requested language and en/ar was used. */
  fallback: boolean;
  /** Tafsir work + author, e.g. "Tafsir Ibn Kathir (abridged)". */
  source: string;
  /** Plain text; the bridge strips all markup. */
  text: string;
};

/** Canonical reference a highlight/bookmark points at: quran://edition/surah/ayah. */
export function quranVerseRef(
  edition: string,
  surah: number,
  ayah: number,
): string {
  return `quran://${edition}/${surah}/${ayah}`;
}

export function parseQuranVerseRef(
  ref: string,
): { edition: string; surah: number; ayah: number } | null {
  const match = /^quran:\/\/([^/]+)\/(\d{1,3})\/(\d{1,3})$/.exec(ref);
  if (!match) return null;
  const surah = Number(match[2]);
  const ayah = Number(match[3]);
  if (
    !Number.isInteger(surah) ||
    surah < 1 ||
    surah > 114 ||
    !Number.isInteger(ayah) ||
    ayah < 1
  ) {
    return null;
  }
  return { edition: match[1] as string, surah, ayah };
}

// ---------------------------------------------------------------------------
// Routstrd bridge — ContextVM tools that proxy a local routstrd daemon's
// HTTP API. The bridge holds the daemon connection; clients speak only
// ContextVM and never see the daemon's port or any credentials.
// ---------------------------------------------------------------------------

// Status
export const ROUTSTRD_STATUS_TOOL_NAME = "routstrd.status";
export const ROUTSTRD_HEALTH_TOOL_NAME = "routstrd.health";

// Wallet
export const ROUTSTRD_WALLET_STATUS_TOOL_NAME = "routstrd.wallet.status";
export const ROUTSTRD_WALLET_BALANCE_TOOL_NAME = "routstrd.wallet.balance";
export const ROUTSTRD_WALLET_MINTS_TOOL_NAME = "routstrd.wallet.mints";
export const ROUTSTRD_WALLET_RECEIVE_CASHU_TOOL_NAME =
  "routstrd.wallet.receive.cashu";
export const ROUTSTRD_WALLET_RECEIVE_BOLT11_TOOL_NAME =
  "routstrd.wallet.receive.bolt11";
export const ROUTSTRD_WALLET_SEND_CASHU_TOOL_NAME =
  "routstrd.wallet.send.cashu";
export const ROUTSTRD_WALLET_SEND_BOLT11_TOOL_NAME =
  "routstrd.wallet.send.bolt11";

// NWC
export const ROUTSTRD_NWC_STATUS_TOOL_NAME = "routstrd.nwc.status";
export const ROUTSTRD_NWC_CONNECT_TOOL_NAME = "routstrd.nwc.connect";

// Clients
export const ROUTSTRD_CLIENTS_LIST_TOOL_NAME = "routstrd.clients.list";
export const ROUTSTRD_CLIENTS_ADD_TOOL_NAME = "routstrd.clients.add";
export const ROUTSTRD_CLIENTS_DELETE_TOOL_NAME = "routstrd.clients.delete";
export const ROUTSTRD_KEYS_BALANCE_TOOL_NAME = "routstrd.keys.balance";

// Providers
export const ROUTSTRD_PROVIDERS_LIST_TOOL_NAME = "routstrd.providers.list";
export const ROUTSTRD_PROVIDERS_DISABLE_TOOL_NAME =
  "routstrd.providers.disable";
export const ROUTSTRD_PROVIDERS_ENABLE_TOOL_NAME = "routstrd.providers.enable";

// Models
export const ROUTSTRD_MODELS_LIST_TOOL_NAME = "routstrd.models.list";
export const ROUTSTRD_MODEL_PROVIDERS_TOOL_NAME = "routstrd.models.providers";

// Usage
export const ROUTSTRD_USAGE_TOOL_NAME = "routstrd.usage";
export const ROUTSTRD_USAGE_SUMMARY_TOOL_NAME = "routstrd.usage.summary";

// Inference
export const ROUTSTRD_CHAT_COMPLETIONS_TOOL_NAME = "routstrd.chat.completions";

// Wallet shortcuts (receive/send — mirrors `routstrd receive`/`routstrd send`)
export const ROUTSTRD_RECEIVE_TOOL_NAME = "routstrd.receive";
export const ROUTSTRD_SEND_TOOL_NAME = "routstrd.send";

// Wallet unlock
export const ROUTSTRD_WALLET_UNLOCK_TOOL_NAME = "routstrd.wallet.unlock";

// NWC operations
export const ROUTSTRD_NWC_DISCONNECT_TOOL_NAME = "routstrd.nwc.disconnect";
export const ROUTSTRD_NWC_FUND_TOOL_NAME = "routstrd.nwc.fund";
export const ROUTSTRD_NWC_AUTO_REFILL_TOOL_NAME = "routstrd.nwc.autoRefill";

// Refund
export const ROUTSTRD_REFUND_TOOL_NAME = "routstrd.refund";
export const ROUTSTRD_REFUND_XCASHU_TOOL_NAME = "routstrd.refund.xcashu";

// Provider refresh
export const ROUTSTRD_PROVIDERS_REFRESH_TOOL_NAME =
  "routstrd.providers.refresh";

// Overall balance (wallet + API keys)
export const ROUTSTRD_BALANCE_TOOL_NAME = "routstrd.balance";

// Mint management
export const ROUTSTRD_WALLET_MINTS_ADD_TOOL_NAME = "routstrd.wallet.mints.add";
export const ROUTSTRD_WALLET_MINTS_INFO_TOOL_NAME =
  "routstrd.wallet.mints.info";

// Ping
export const ROUTSTRD_PING_TOOL_NAME = "routstrd.ping";

// --- Types ---

export type RoutstrdStatus = {
  daemon: string;
  wallet: string;
  walletState: string;
  mode: string;
  balances: Record<string, number>;
  provider?: string;
  uptime?: number;
  version?: string;
};

export type RoutstrdWalletBalance = {
  totalSats: number;
  mints: Array<{ url: string; balanceSats: number }>;
  activeMint?: string;
  walletState?: string;
};

export type RoutstrdMint = {
  url: string;
  balanceSats: number;
  active?: boolean;
  healthy?: boolean;
};

export type RoutstrdClient = {
  clientId: string;
  name: string;
  apiKey: string;
  createdAt?: string | number;
  lastUsed?: number | null;
};

export type RoutstrdClientBalance = {
  clientId: string;
  name: string;
  balanceSats: number;
};

export type RoutstrdProvider = {
  index: number;
  baseUrl: string;
  name?: string;
  disabled: boolean;
  models?: string[];
  latencyMs?: number;
};

export type RoutstrdModel = {
  id: string;
  name?: string;
  description?: string;
  provider?: string;
  contextWindow?: number;
  enabled?: boolean;
};

export type RoutstrdUsageRecord = {
  timestamp: number;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  costSats: number;
  clientId?: string;
};

export type RoutstrdUsageSummary = {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostSats: number;
  byModel: Record<string, { requests: number; costSats: number }>;
  byProvider: Record<string, { requests: number; costSats: number }>;
  byClient: Record<string, { requests: number; costSats: number }>;
};

export type RoutstrdChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type RoutstrdChatCompletionResult = {
  id: string;
  model: string;
  choices: Array<{ message: RoutstrdChatMessage; finishReason: string }>;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    /** Exact cost in millisatoshis (1 sat = 1000 msats). */
    totalMsats?: number;
    inputMsats?: number;
    outputMsats?: number;
    /** Exact cost in sats (totalMsats / 1000). */
    costSats?: number;
    /** USD cost if reported by the upstream provider. */
    costUsd?: number;
    /** Upstream provider that handled the request. */
    provider?: string;
  };
};

// ---------------------------------------------------------------------------
// Pi bridge — independent Pi RPC conversations. Pi intentionally has its own
// tool namespace and wire types; no Hermes identity or agent id crosses here.
// ---------------------------------------------------------------------------
export const PI_CHATS_LIST_TOOL_NAME = "pi.chats.list";
export const PI_CHATS_CREATE_TOOL_NAME = "pi.chats.create";
export const PI_CHATS_HISTORY_TOOL_NAME = "pi.chats.history";
export const PI_CHATS_DELETE_TOOL_NAME = "pi.chats.delete";
export const PI_CHAT_SEND_TOOL_NAME = "pi.chat.send";
export const PI_CHAT_WATCH_TOOL_NAME = "pi.chat.watch";
export const PI_CHAT_INTERRUPT_TOOL_NAME = "pi.chat.interrupt";
export const PI_EVENTS_STREAM_TOOL_NAME = "pi.events.stream";
export const PI_REPOSITORIES_LIST_TOOL_NAME = "pi.repositories.list";
export const PI_MODELS_LIST_TOOL_NAME = "pi.models.list";
export const PI_MODEL_SWITCH_TOOL_NAME = "pi.model.switch";
export const PI_TRANSCRIPTION_CAPABILITIES_TOOL_NAME =
  "pi.transcription.capabilities";
export const PI_TRANSCRIPTION_CHUNK_TOOL_NAME = "pi.transcription.chunk";
export const PI_TRANSCRIBE_AUDIO_TOOL_NAME = "pi.transcription.transcribe";
export const PI_TRANSCRIPTION_CANCEL_TOOL_NAME = "pi.transcription.cancel";
export const PI_HANDOFF_PREVIEW_TOOL_NAME = "pi.handoffs.preview";
export const PI_HANDOFF_SEND_TOOL_NAME = "pi.handoffs.send";
export const PI_HANDOFFS_LIST_TOOL_NAME = "pi.handoffs.list";
export const PI_HANDOFF_GET_TOOL_NAME = "pi.handoffs.get";

export type PiChatSummary = {
  id: string;
  title: string;
  preview: string;
  startedAt: number;
  messageCount: number;
  cwd: string;
};
export type PiChatMessage = {
  role: "user" | "assistant";
  text: string;
  ordinal?: number;
  digest?: string;
};
export type PiChatHistory = {
  chatId: string;
  messages: PiChatMessage[];
  context?: { model?: string; provider?: string; cwd?: string };
  running?: boolean;
  inflight?: { user?: string; assistant?: string };
};
export type PiChatEvent =
  | { type: "chat.started"; chatId: string; created: boolean }
  | { type: "thinking.delta"; text?: string }
  | { type: "status"; text: string }
  | { type: "message.delta"; text: string }
  | { type: "tool.start"; toolId: string; name?: string; argsText?: string }
  | { type: "tool.progress"; name?: string; preview?: string }
  | {
      type: "tool.complete";
      toolId: string;
      name?: string;
      summary?: string;
      error?: string;
      durationSeconds?: number;
    }
  | {
      type: "message.complete";
      text: string;
      failureReason?: string;
      chatId?: string;
    }
  | { type: "error"; message: string }
  | {
      type: "subagent.progress";
      subagents: PiSubagentTask[];
    }
  | { type: "keepalive"; ts: number };
export type PiSendResult = {
  chatId: string;
  text: string;
  interrupted: boolean;
  failureReason?: string;
};
export function encodePiChatEvent(event: PiChatEvent): string {
  return `${JSON.stringify(event)}\n`;
}
export function parsePiChatChunk(chunk: string): PiChatEvent[] {
  return chunk
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => JSON.parse(x) as PiChatEvent);
}

/**
 * One subagent run tracked under its parent turn. A subagent is a separate
 * `pi` process spawned by the `subagent` extension tool (single, parallel, or
 * chain mode). `task` is the delegated goal; `status` is the live state.
 */
export type PiSubagentTask = {
  /** Stable id derived from the parent toolCallId + index (or agent name). */
  id: string;
  /** Agent name from the subagent extension (e.g. "scout", "worker"). */
  agent: string;
  /** The task text delegated to this subagent. */
  task: string;
  /**
   * Lifecycle state:
   * - "running" — subprocess alive, streaming tool calls / text
   * - "completed" — exited cleanly (exit code 0, stopReason "end")
   * - "failed" — non-zero exit, LLM error, or abort
   */
  status: "running" | "completed" | "failed";
  /** Step number for chain mode (1-based); omitted for single/parallel. */
  step?: number;
  /** Preview of the latest assistant text or tool call from this subagent. */
  preview?: string;
  /** Failure reason, set when status is "failed". */
  failureReason?: string;
  /** Epoch ms when this subagent was first observed. */
  startedAt: number;
};

export type PiActiveTurn = {
  chatId: string;
  startedAt: number;
  /** Currently-tracked subagent runs spawned by this turn, if any. */
  subagents?: PiSubagentTask[];
};
export type PiActivityEvent =
  | { type: "activity.snapshot"; turns: PiActiveTurn[] }
  | { type: "turn.started"; chatId: string; at: number }
  | {
      type: "turn.moved";
      fromChatId: string;
      toChatId: string;
      at: number;
    }
  | {
      type: "turn.completed";
      chatId: string;
      at: number;
      preview?: string;
      failureReason?: string;
    }
  | {
      type: "subagent.started";
      chatId: string;
      subagent: PiSubagentTask;
      at: number;
    }
  | {
      type: "subagent.updated";
      chatId: string;
      subagent: PiSubagentTask;
      at: number;
    }
  | {
      type: "subagent.completed";
      chatId: string;
      subagent: PiSubagentTask;
      at: number;
    }
  | { type: "keepalive"; ts: number };
export function encodePiActivityEvent(event: PiActivityEvent): string {
  return `${JSON.stringify(event)}\n`;
}
export function parsePiActivityChunk(chunk: string): PiActivityEvent[] {
  return chunk
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => JSON.parse(x) as PiActivityEvent);
}

export type PiRepository = {
  id: string;
  label: string;
  path: string;
  gitRoot?: string;
  branch?: string;
  sessionCount: number;
  lastActive: number;
};
export type PiRepositoriesResult = { repositories: PiRepository[] };
export type PiModel = {
  provider: string;
  id: string;
  name?: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
};
export type PiModelOptions = {
  providers: Array<{
    slug: string;
    name: string;
    isCurrent: boolean;
    models: PiModel[];
  }>;
  model: string;
  provider: string;
};
export type PiModelSwitchResult = {
  provider: string;
  model: string;
  scope: "session";
};

export type PiTranscriptionCapabilities = PaperclipTranscriptionCapabilities;
export type PiTranscriptionChunkRequest = PaperclipTranscriptionChunkRequest;
export type PiTranscriptionChunkResult = PaperclipTranscriptionChunkResult;
export type PiTranscriptionLanguage = HermesTranscriptionLanguage;
export type PiTranscribeAudioRequest = Omit<
  PaperclipTranscribeAudioRequest,
  "language"
> & { language?: PiTranscriptionLanguage };
export type PiTranscribeAudioResult = PaperclipTranscribeAudioResult;
export type PiTranscribeAudioErrorCode = PaperclipTranscribeAudioErrorCode;

export type PiConversationRef = { chatId: string; title?: string };
export type PiHandoffMessageRef = {
  ordinal: number;
  role: "user" | "assistant";
  digest: string;
};
export type PiHandoffMessage = PiHandoffMessageRef & { text: string };
export type PiHandoffDestination =
  | {
      kind: "new";
      cwd: string;
      title?: string;
      provider?: string;
      model?: string;
    }
  | { kind: "existing"; chatId: string; title?: string };
export type PiHandoffPreviewInput = {
  source: PiConversationRef;
  mode: "selected" | "full";
  selected?: PiHandoffMessageRef[];
  destination: PiHandoffDestination;
  instructions: string;
};
export type PiHandoffPreview = {
  schemaVersion: 1;
  source: PiConversationRef;
  destination: PiHandoffDestination;
  mode: "selected" | "full";
  messages: PiHandoffMessage[];
  instructions: string;
  envelope: string;
  byteCount: number;
  previewDigest: string;
};
export type PiHandoffStatus =
  "accepted" | "running" | "completed" | "failed" | "interrupted";
export type PiHandoffRecord = {
  schemaVersion: 1;
  requestId: string;
  artifactId: string;
  source: PiConversationRef;
  destination: PiHandoffDestination;
  destinationChatId?: string;
  mode: "selected" | "full";
  messageCount: number;
  instructions: string;
  previewDigest: string;
  status: PiHandoffStatus;
  responseText?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
};
export type PiHandoffSendInput = PiHandoffPreviewInput & {
  requestId: string;
  previewDigest: string;
};
export type PiHandoffSendResult = PiSendResult & {
  requestId: string;
  artifactId: string;
  status: PiHandoffStatus;
};

// ---------------------------------------------------------------------------
// Gitea bridge — ContextVM tools that proxy a self-hosted Gitea instance's
// REST API. The bridge holds the Gitea token; clients speak only ContextVM
// and never see the Gitea port or any credentials.
// ---------------------------------------------------------------------------

// User & orgs
export const GITEA_USER_TOOL_NAME = "gitea.user";
export const GITEA_ORGS_LIST_TOOL_NAME = "gitea.orgs.list";
export const GITEA_ORGS_REPOS_TOOL_NAME = "gitea.orgs.repos";

// Repos
export const GITEA_REPOS_LIST_TOOL_NAME = "gitea.repos.list";
export const GITEA_REPOS_GET_TOOL_NAME = "gitea.repos.get";
export const GITEA_REPOS_BRANCHES_TOOL_NAME = "gitea.repos.branches";

// Tags
export const GITEA_REPOS_TAGS_TOOL_NAME = "gitea.repos.tags";

// Milestones
export const GITEA_MILESTONES_LIST_TOOL_NAME = "gitea.milestones.list";

// Issues
export const GITEA_ISSUES_LIST_TOOL_NAME = "gitea.issues.list";
export const GITEA_ISSUES_GET_TOOL_NAME = "gitea.issues.get";
export const GITEA_ISSUES_CREATE_TOOL_NAME = "gitea.issues.create";
export const GITEA_ISSUES_COMMENTS_TOOL_NAME = "gitea.issues.comments";
export const GITEA_ISSUES_COMMENT_ADD_TOOL_NAME = "gitea.issues.comment.add";
export const GITEA_ISSUES_LABELS_TOOL_NAME = "gitea.issues.labels";

// Pull requests
export const GITEA_PULLS_LIST_TOOL_NAME = "gitea.pulls.list";
export const GITEA_PULLS_GET_TOOL_NAME = "gitea.pulls.get";
export const GITEA_PULLS_FILES_TOOL_NAME = "gitea.pulls.files";
export const GITEA_PULLS_MERGE_TOOL_NAME = "gitea.pulls.merge";
export const GITEA_PULLS_CLOSE_TOOL_NAME = "gitea.pulls.close";

// Commits & compare
export const GITEA_COMMITS_LIST_TOOL_NAME = "gitea.commits.list";
export const GITEA_COMMITS_COMPARE_TOOL_NAME = "gitea.commits.compare";

// File content
export const GITEA_FILE_GET_TOOL_NAME = "gitea.file.get";

// Releases
export const GITEA_RELEASES_LIST_TOOL_NAME = "gitea.releases.list";
export const GITEA_RELEASES_CREATE_TOOL_NAME = "gitea.releases.create";

// --- Types ---

export type GiteaUser = {
  login: string;
  id: number;
  fullName?: string;
  email?: string;
  avatarUrl?: string;
};

export type GiteaRepo = {
  id: number;
  name: string;
  fullName: string;
  description?: string;
  private: boolean;
  defaultBranch: string;
  starsCount: number;
  forksCount: number;
  openIssuesCount: number;
  htmlUrl: string;
  cloneUrl: string;
  updatedAt: string;
};

export type GiteaBranch = {
  name: string;
  commitSha: string;
  commitMessage: string;
  protected: boolean;
};

export type GiteaIssue = {
  id: number;
  number: number;
  title: string;
  body: string;
  state: string; // "open" | "closed"
  labels: string[];
  assignees: string[];
  author: string;
  createdAt: string;
  updatedAt: string;
  commentsCount: number;
  htmlUrl: string;
  isPullRequest: boolean;
};

export type GiteaComment = {
  id: number;
  body: string;
  author: string;
  createdAt: string;
  updatedAt: string;
};

export type GiteaLabel = {
  id: number;
  name: string;
  color: string;
  description?: string;
};

export type GiteaPullRequest = {
  id: number;
  number: number;
  title: string;
  body: string;
  state: string;
  mergeable: boolean;
  merged: boolean;
  headBranch: string;
  baseBranch: string;
  author: string;
  additions: number;
  deletions: number;
  changedFilesCount: number;
  commitsBehind: number;
  commitsAhead: number;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
};

export type GiteaPullFile = {
  filename: string;
  status: string; // added, modified, deleted, renamed
  additions: number;
  deletions: number;
  changes: number;
};

export type GiteaCommit = {
  sha: string;
  message: string;
  author: string;
  authorEmail: string;
  date: string;
};

export type GiteaCompare = {
  aheadBy: number;
  behindBy: number;
  totalCommits: number;
  commits: GiteaCommit[];
};

export type GiteaFile = {
  path: string;
  content: string;
  encoding: string; // "base64" or "utf-8"
  branch: string;
  size: number;
  sha: string;
};

export type GiteaRelease = {
  id: number;
  tagName: string;
  title: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  author: string;
  createdAt: string;
  htmlUrl: string;
  assets: Array<{
    id: number;
    name: string;
    downloadUrl: string;
    size: number;
  }>;
};

export type GiteaOrg = {
  id: number;
  name: string;
  fullName?: string;
  description?: string;
  avatarUrl?: string;
};

export type GiteaTag = {
  name: string;
  commitSha: string;
  message?: string;
};

export type GiteaMilestone = {
  id: number;
  title: string;
  description: string;
  state: string;
  openIssues: number;
  closedIssues: number;
  dueOn?: string;
  createdAt: string;
  updatedAt: string;
};

// ---------------------------------------------------------------------------
// GitHub bridge — ContextVM tools that proxy the `gh` CLI.
// The bridge runs `gh` on the host; clients speak only ContextVM and never
// see GitHub credentials or the gh binary.
// ---------------------------------------------------------------------------

// User & orgs
export const GITHUB_USER_TOOL_NAME = "github.user";
export const GITHUB_ORGS_LIST_TOOL_NAME = "github.orgs.list";
export const GITHUB_ORGS_REPOS_TOOL_NAME = "github.orgs.repos";
export const GITHUB_REPOS_LIST_TOOL_NAME = "github.repos.list";
export const GITHUB_REPO_GET_TOOL_NAME = "github.repos.get";

// Branches
export const GITHUB_BRANCHES_TOOL_NAME = "github.repos.branches";

// Tags
export const GITHUB_REPOS_TAGS_TOOL_NAME = "github.repos.tags";

// Milestones
export const GITHUB_MILESTONES_LIST_TOOL_NAME = "github.milestones.list";

// Issues
export const GITHUB_ISSUES_LIST_TOOL_NAME = "github.issues.list";
export const GITHUB_ISSUE_GET_TOOL_NAME = "github.issues.get";
export const GITHUB_ISSUE_CREATE_TOOL_NAME = "github.issues.create";
export const GITHUB_ISSUE_COMMENTS_TOOL_NAME = "github.issues.comments";
export const GITHUB_ISSUE_COMMENT_ADD_TOOL_NAME = "github.issues.comment.add";

// Pull requests
export const GITHUB_PRS_LIST_TOOL_NAME = "github.prs.list";
export const GITHUB_PR_GET_TOOL_NAME = "github.prs.get";
export const GITHUB_PR_FILES_TOOL_NAME = "github.prs.files";
export const GITHUB_PR_MERGE_TOOL_NAME = "github.prs.merge";
export const GITHUB_PR_CLOSE_TOOL_NAME = "github.prs.close";
export const GITHUB_PR_REVIEW_TOOL_NAME = "github.prs.review";
export const GITHUB_PR_REVIEWS_LIST_TOOL_NAME = "github.prs.reviews.list";
export const GITHUB_PR_CHECKS_TOOL_NAME = "github.prs.checks";

// Commits & compare
export const GITHUB_COMMITS_LIST_TOOL_NAME = "github.commits.list";
export const GITHUB_COMMITS_COMPARE_TOOL_NAME = "github.commits.compare";

// File content
export const GITHUB_FILE_GET_TOOL_NAME = "github.file.get";

// Releases
export const GITHUB_RELEASES_LIST_TOOL_NAME = "github.releases.list";

// Actions / workflows
export const GITHUB_WORKFLOWS_LIST_TOOL_NAME = "github.workflows.list";
export const GITHUB_RUNS_LIST_TOOL_NAME = "github.runs.list";

// --- Types ---

export type GithubUser = {
  login: string;
  id: number;
  name?: string;
  email?: string;
  avatarUrl?: string;
  bio?: string;
  company?: string;
  publicRepos?: number;
  followers?: number;
  following?: number;
};

export type GithubOrg = {
  id: number;
  login: string;
  name?: string;
  description?: string;
  avatarUrl?: string;
  url?: string;
};

export type GithubTag = {
  name: string;
  commitSha: string;
};

export type GithubMilestone = {
  id: number;
  number: number;
  title: string;
  description: string;
  state: string;
  openIssues: number;
  closedIssues: number;
  dueOn?: string;
  createdAt: string;
  updatedAt: string;
};

export type GithubRepo = {
  id: number;
  name: string;
  fullName: string;
  description?: string;
  private: boolean;
  defaultBranch: string;
  starsCount: number;
  forksCount: number;
  openIssuesCount: number;
  htmlUrl: string;
  cloneUrl: string;
  updatedAt: string;
  language?: string;
  archived: boolean;
  fork: boolean;
};

export type GithubBranch = {
  name: string;
  commitSha: string;
  protected: boolean;
};

export type GithubIssue = {
  id: number;
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
  assignees: string[];
  author: string;
  createdAt: string;
  updatedAt: string;
  commentsCount: number;
  htmlUrl: string;
};

export type GithubComment = {
  id: number;
  body: string;
  author: string;
  createdAt: string;
};

export type GithubPullRequest = {
  id: number;
  number: number;
  title: string;
  body: string;
  state: string;
  mergeable: boolean;
  merged: boolean;
  draft: boolean;
  headBranch: string;
  baseBranch: string;
  author: string;
  additions: number;
  deletions: number;
  changedFilesCount: number;
  commitsAhead: number;
  commitsBehind: number;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
  reviewDecision?: string;
};

export type GithubPullFile = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
};

export type GithubCommit = {
  sha: string;
  message: string;
  author: string;
  authorEmail: string;
  date: string;
};

export type GithubCompare = {
  aheadBy: number;
  behindBy: number;
  totalCommits: number;
  commits: GithubCommit[];
};

export type GithubFile = {
  path: string;
  content: string;
  encoding: string;
  branch: string;
  size: number;
  sha: string;
};

export type GithubRelease = {
  id: number;
  tagName: string;
  title: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  author: string;
  createdAt: string;
  htmlUrl: string;
  assets: Array<{
    id: number;
    name: string;
    size: number;
    downloadUrl: string;
  }>;
};

export type GithubReview = {
  id: number;
  author: string;
  state: string;
  body: string;
  submittedAt: string;
};

export type GithubCheckRun = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
  startedAt: string;
  completedAt: string | null;
};

export type GithubWorkflow = {
  id: number;
  name: string;
  path: string;
  state: string;
};

export type GithubRun = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  branch: string;
  event: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
};

// ---------------------------------------------------------------------------
// Nostr Vault — encrypted, scoped access to a bridge-custodied NIP-60 account.
// Sensitive bearer material is intentionally absent from all read contracts.
// ---------------------------------------------------------------------------
export const VAULT_PAIR_REQUEST_TOOL_NAME = "vault.pair.request";
export const VAULT_PAIR_STATUS_TOOL_NAME = "vault.pair.status";
export const VAULT_STATUS_TOOL_NAME = "vault.status";
export const VAULT_WALLET_BALANCE_TOOL_NAME = "vault.wallet.balance";
export const VAULT_WALLET_MINTS_TOOL_NAME = "vault.wallet.mints";
export const VAULT_WALLET_HISTORY_TOOL_NAME = "vault.wallet.history";
export const VAULT_WALLET_SYNC_TOOL_NAME = "vault.wallet.sync";
export const VAULT_WALLET_RECEIVE_TOOL_NAME = "vault.wallet.receive";
export const VAULT_WALLET_SEND_TOOL_NAME = "vault.wallet.send";

export const VAULT_SCOPE_VALUES = [
  "wallet.read",
  "wallet.receive",
  "wallet.spend",
] as const;
export type VaultScope = (typeof VAULT_SCOPE_VALUES)[number];
export type VaultPairRequestInput = {
  label: string;
  requestedScopes: VaultScope[];
  deviceNonce: string;
};
export type VaultPairRequestResult = {
  requestId: string;
  verificationCode: string;
  status: "pending" | "approved" | "rejected" | "expired" | "revoked";
  requestedScopes: VaultScope[];
  createdAt: number;
  expiresAt: number;
};
export type VaultPairStatusInput = { requestId: string };
export type VaultPairStatusResult = VaultPairRequestResult & {
  grantedScopes?: VaultScope[];
};
export type VaultSyncState =
  | "locked"
  | "no-account"
  | "syncing"
  | "ready"
  | "no-wallet"
  | "degraded"
  | "error";
export type VaultStatus = {
  prototype: true;
  audited: false;
  account?: { id: string; npub: string; label: string };
  wallet: {
    state: VaultSyncState;
    lastSyncAt?: number;
    eventCount: number;
    error?: string;
    mutationsEnabled: boolean;
  };
};
export type VaultWalletBalance = {
  totalSats: number;
  byMint: Array<{ mint: string; sats: number }>;
  tokenCount: number;
  asOf?: number;
};
export type VaultWalletMint = { url: string; balanceSats: number };
export type VaultWalletHistoryEntry = {
  id: string;
  direction: "in" | "out" | "unknown";
  amountSats?: number;
  createdAt: number;
};
export type VaultRelayStatus = {
  url?: string;
  state: "disabled" | "connecting" | "healthy" | "error";
  lastConnectAt?: number;
  lastEoseAt?: number;
  lastEventAt?: number;
  lastError?: string;
};
export type VaultWalletReceiveInput = { token: string };
export type VaultWalletReceiveResult = {
  amountSats: number;
  feeSats: number;
  mint: string;
};
export type VaultWalletSendInput = { amountSats: number; mint?: string };
export type VaultWalletSendResult = {
  token: string;
  amountSats: number;
  feeSats: number;
  changeSats: number;
  mint: string;
};

// ─────────────────────────────────────────────────────────────────────────
// Routstr CLI (routstrcli) — multi-node operations for routstr-core nodes.
// Reproduces the full `routstr` CLI command tree as ContextVM tools under
// the `routstrcli.` namespace (also the master-bridge routing prefix/id).
// ─────────────────────────────────────────────────────────────────────────

// Multi-node registry management (API key = node token differentiator; the
// active node is toggled via select).
export const ROUTSTRCLI_NODES_LIST_TOOL_NAME = "routstrcli.nodes.list";
export const ROUTSTRCLI_NODES_SHOW_TOOL_NAME = "routstrcli.nodes.show";
export const ROUTSTRCLI_NODES_ADD_TOOL_NAME = "routstrcli.nodes.add";
export const ROUTSTRCLI_NODES_REMOVE_TOOL_NAME = "routstrcli.nodes.remove";
export const ROUTSTRCLI_NODES_SELECT_TOOL_NAME = "routstrcli.nodes.select";

// CLI commands (mirror `routstr <cmd>`; each accepts an optional `node` id
// to override the active node — the bridge-side equivalent of `-n`).
export const ROUTSTRCLI_STATUS_TOOL_NAME = "routstrcli.status";
export const ROUTSTRCLI_CONFIG_SHOW_TOOL_NAME = "routstrcli.config.show";
export const ROUTSTRCLI_CONFIG_GET_TOOL_NAME = "routstrcli.config.get";
export const ROUTSTRCLI_CONFIG_SET_TOOL_NAME = "routstrcli.config.set";
export const ROUTSTRCLI_MODELS_LIST_TOOL_NAME = "routstrcli.models.list";
export const ROUTSTRCLI_PROVIDERS_LIST_TOOL_NAME = "routstrcli.providers.list";
export const ROUTSTRCLI_PROVIDERS_ADD_TOOL_NAME = "routstrcli.providers.add";
export const ROUTSTRCLI_PROVIDERS_REMOVE_TOOL_NAME =
  "routstrcli.providers.remove";
export const ROUTSTRCLI_PROVIDERS_TEST_TOOL_NAME = "routstrcli.providers.test";
export const ROUTSTRCLI_PROVIDERS_SHOW_TOOL_NAME = "routstrcli.providers.show";
export const ROUTSTRCLI_PROVIDERS_UPDATE_TOOL_NAME =
  "routstrcli.providers.update";
export const ROUTSTRCLI_PROVIDERS_ENABLE_TOOL_NAME =
  "routstrcli.providers.enable";
export const ROUTSTRCLI_PROVIDERS_DISABLE_TOOL_NAME =
  "routstrcli.providers.disable";
export const ROUTSTRCLI_PROVIDER_MODELS_LIST_TOOL_NAME =
  "routstrcli.providers.models.list";
export const ROUTSTRCLI_PROVIDER_MODELS_SHOW_TOOL_NAME =
  "routstrcli.providers.models.show";
export const ROUTSTRCLI_PROVIDER_MODELS_UPDATE_TOOL_NAME =
  "routstrcli.providers.models.update";
export const ROUTSTRCLI_INSTRUCT_TOOL_NAME = "routstrcli.instruct";
export const ROUTSTRCLI_SCHEMA_TOOL_NAME = "routstrcli.schema";
export const ROUTSTRCLI_MONITOR_TOOL_NAME = "routstrcli.monitor";

// Node log inspection (admin-only — mirrors `routstr` admin log endpoints).
export const ROUTSTRCLI_LOGS_LIST_TOOL_NAME = "routstrcli.logs.list";
export const ROUTSTRCLI_LOGS_DATES_TOOL_NAME = "routstrcli.logs.dates";

// Node wallet balance (admin-only — mirrors `routstr` admin balances).
export const ROUTSTRCLI_BALANCE_TOOL_NAME = "routstrcli.balance";

// Present in the CLI source but DISABLED upstream (wallet/serve need cashu /
// server wiring that isn't ready). Exposed so every CLI command is reachable;
// they return `{ disabled: true, reason }`.
export const ROUTSTRCLI_WALLET_BALANCE_TOOL_NAME = "routstrcli.wallet.balance";
export const ROUTSTRCLI_WALLET_SEND_TOOL_NAME = "routstrcli.wallet.send";
export const ROUTSTRCLI_WALLET_RECEIVE_TOOL_NAME = "routstrcli.wallet.receive";
export const ROUTSTRCLI_SERVE_TOOL_NAME = "routstrcli.serve";

export type RoutstrCliNode = {
  /** Unique slug, also the master-bridge alias segment. */
  id: string;
  name?: string;
  /** Node base URL, e.g. http://localhost:8011 */
  nodeUrl: string;
  /** Admin / CLI token — the credential that differentiates one node from another. */
  token?: string;
  enabled?: boolean;
};

export type RoutstrCliNodeDetail = RoutstrCliNode & {
  active: boolean;
};

export type RoutstrCliNodesListResult = {
  activeId: string | null;
  nodes: RoutstrCliNodeDetail[];
};

export type RoutstrCliNodeInfo = {
  name: string;
  description: string;
  version: string;
  npub: string;
  mints: string[];
  http_url: string;
  onion_url: string;
  child_key_cost_msats: number;
};

export type RoutstrCliModel = {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: Record<string, unknown>;
  sats_pricing?: Record<string, unknown> | null;
  enabled?: boolean;
  upstream_provider_id?: number | string | null;
  owned_by?: string;
};

export type RoutstrCliProvider = {
  id?: number | string;
  slug?: string | null;
  provider_type?: string;
  base_url?: string;
  url?: string;
  enabled?: boolean;
  provider_fee?: number;
  model_count?: number;
  api_key?: string;
  api_version?: string | null;
  provider_settings?: Record<string, unknown> | null;
};

export type RoutstrCliAdminModel = {
  id: string;
  name: string;
  description: string;
  created: number;
  context_length: number;
  architecture: Record<string, unknown>;
  pricing: Record<string, unknown>;
  per_request_limits: Record<string, unknown> | null;
  top_provider: Record<string, unknown> | null;
  upstream_provider_id: number | null;
  canonical_slug: string | null;
  alias_ids: string[] | null;
  enabled: boolean;
  forwarded_model_id: string | null;
  sats_pricing?: Record<string, unknown> | null;
};

export type RoutstrCliProviderModelsResult = {
  provider: RoutstrCliProvider;
  db_models: RoutstrCliAdminModel[];
  remote_models: RoutstrCliAdminModel[];
};

export type RoutstrCliInstructResult = {
  instruction: string;
  node_url: string;
  name: string;
  description: string;
  mints: string[];
};

export type RoutstrCliMonitorResult = {
  node: RoutstrCliNodeInfo | null;
  nodeUrl: string;
  modelsTotal: number;
  providersTotal: number;
  providersAdmin: boolean;
  fetchedAt: number;
};

export type RoutstrCliLogLevel =
  "DEBUG" | "INFO" | "TRACE" | "WARNING" | "ERROR" | "CRITICAL";

export type RoutstrCliLogEntry = {
  asctime?: string;
  name?: string;
  levelname?: string;
  message?: string;
  pathname?: string;
  lineno?: number;
  version?: string;
  request_id?: string;
  status_code?: number;
  method?: string;
  path?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  token_cost?: number;
  charged_amount?: number;
  max_cost_for_model?: number;
  error_type?: string;
  [key: string]: unknown;
};

export type RoutstrCliLogsListResult = {
  logs: RoutstrCliLogEntry[];
  total: number;
  date?: string | null;
  level?: string | null;
  request_id?: string | null;
  search?: string | null;
  status_codes?: string | null;
  methods?: string | null;
  endpoints?: string | null;
  limit: number;
  requiresAdmin?: boolean;
};

export type RoutstrCliLogDatesResult = {
  dates: string[];
};

export type RoutstrCliBalanceItem = {
  mint_url?: string;
  unit?: string;
  wallet_balance?: number;
  user_balance?: number;
  owner_balance?: number;
  error?: string;
  error_code?: string;
  retry_after_seconds?: number;
};

export type RoutstrCliBalanceResult = {
  balances: RoutstrCliBalanceItem[];
  requiresAdmin?: boolean;
};

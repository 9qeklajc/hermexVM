import { Client } from "@contextvm/mcp-sdk/client/index.js";
import type { RequestOptions } from "@contextvm/mcp-sdk/shared/protocol.js";
import {
  ApplesauceRelayPool,
  callToolStream,
  EncryptionMode,
  NostrClientTransport,
  PrivateKeySigner,
} from "@contextvm/sdk";
import {
  PAPERCLIP_AGENTS_CONTROL_TOOL_NAME,
  PAPERCLIP_AGENTS_GET_TOOL_NAME,
  PAPERCLIP_AGENTS_LIST_TOOL_NAME,
  PAPERCLIP_AGENTS_WAKE_TOOL_NAME,
  PAPERCLIP_APPROVAL_COMMENTS_TOOL_NAME,
  PAPERCLIP_APPROVALS_DECIDE_TOOL_NAME,
  PAPERCLIP_APPROVALS_GET_TOOL_NAME,
  PAPERCLIP_APPROVALS_LIST_TOOL_NAME,
  PAPERCLIP_COMPANIES_LIST_TOOL_NAME,
  PAPERCLIP_COMPANIES_STATS_TOOL_NAME,
  PAPERCLIP_EVENTS_STREAM_TOOL_NAME,
  PAPERCLIP_ISSUE_ACTIVITY_TOOL_NAME,
  PAPERCLIP_ISSUE_APPROVALS_TOOL_NAME,
  PAPERCLIP_ISSUE_ATTACHMENT_DELETE_TOOL_NAME,
  PAPERCLIP_ISSUE_ATTACHMENTS_TOOL_NAME,
  PAPERCLIP_ISSUE_COMMENT_DELETE_TOOL_NAME,
  PAPERCLIP_ISSUE_COMMENT_TOOL_NAME,
  PAPERCLIP_ISSUE_COST_TOOL_NAME,
  PAPERCLIP_ISSUE_CREATE_TOOL_NAME,
  PAPERCLIP_ISSUE_COMMENTS_TOOL_NAME,
  PAPERCLIP_ISSUE_DOCUMENT_GET_TOOL_NAME,
  PAPERCLIP_ISSUE_DOCUMENTS_TOOL_NAME,
  PAPERCLIP_ISSUE_INTERACTION_DECIDE_TOOL_NAME,
  PAPERCLIP_ISSUE_INTERACTIONS_TOOL_NAME,
  PAPERCLIP_ISSUE_RUNS_TOOL_NAME,
  PAPERCLIP_ISSUE_UPDATE_TOOL_NAME,
  PAPERCLIP_ISSUE_WORK_PRODUCTS_TOOL_NAME,
  PAPERCLIP_ISSUES_GET_TOOL_NAME,
  PAPERCLIP_ISSUES_LIST_TOOL_NAME,
  PAPERCLIP_RUN_EVENTS_TOOL_NAME,
  PAPERCLIP_RUN_LOG_TOOL_NAME,
  PAPERCLIP_RUNS_CANCEL_TOOL_NAME,
  PAPERCLIP_RUNS_GET_TOOL_NAME,
  PAPERCLIP_RUNS_LIST_TOOL_NAME,
  PAPERCLIP_RUNS_LIVE_TOOL_NAME,
  PAPERCLIP_TRANSCRIBE_AUDIO_TOOL_NAME,
  PAPERCLIP_TRANSCRIPTION_CANCEL_TOOL_NAME,
  PAPERCLIP_TRANSCRIPTION_CAPABILITIES_TOOL_NAME,
  PAPERCLIP_TRANSCRIPTION_CHUNK_TOOL_NAME,
  parsePaperclipChunk,
  type PaperclipLiveEvent,
  type PaperclipTranscribeAudioErrorCode,
  type PaperclipTranscribeAudioResult,
  type PaperclipTranscriptionCapabilities,
  type PaperclipTranscriptionChunkResult,
  type PaperclipTranscriptionLanguage,
} from "@contexcgi/protocol";
import { normalizePrivateKey, normalizePublicKey } from "./index.js";
import type {
  ActivityEvent,
  Agent,
  AgentDetail,
  AgentWakeupResponse,
  Approval,
  ApprovalComment,
  ApprovalStatus,
  Company,
  CompanyStats,
  HeartbeatRun,
  HeartbeatRunEvent,
  Issue,
  IssueAttachment,
  IssueComment,
  IssueCostSummary,
  IssueDocument,
  IssueDocumentSummary,
  IssueWorkProduct,
  IssueInteraction,
  IssuePriority,
  IssueStatus,
  IssueUpdate,
  RunLogChunk,
} from "./paperclip-types.js";

export type PaperclipOpsClientConfig = {
  privateKey: string;
  serverPubkey: string;
  relays?: string[];
  discoveryRelays?: string[];
  fallbackRelays?: string[];
  encryption?: EncryptionMode;
};

export type CompanyEventStream = {
  events: AsyncIterable<PaperclipLiveEvent>;
  done: Promise<void>;
  abort(reason?: string): Promise<void>;
};

/** A structured, retryable-aware failure from `paperclip.transcription.transcribe`. */
export class PaperclipTranscriptionError extends Error {
  constructor(
    readonly code: PaperclipTranscribeAudioErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "PaperclipTranscriptionError";
  }
}

// whisper.cpp on a phone-class or small-server CPU can take much longer than
// the MCP SDK's 60s default request timeout to transcribe up to 60s of audio,
// especially once CEP-22 oversized-transfer round trips are included. Set
// comfortably above the bridge's own transcription budget (default 180s /
// PAPERCLIP_TRANSCRIPTION_TIMEOUT_MS) so the client never gives up moments
// before the bridge would have replied.
const TRANSCRIBE_REQUEST_TIMEOUT_MS = 240_000;

// Each chunk call is its own small, independently-encrypted MCP message, kept
// well under NIP-44's 65535-byte plaintext ceiling once JSON/MCP framing
// overhead is included (24000 bytes + a few hundred bytes of framing).
const TRANSCRIBE_CHUNK_SIZE = 24_000;

function generateUploadId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * ContextVM client for a Paperclip bridge. Speaks MCP-over-Nostr only; the
 * bridge holds the Paperclip board API key. Method names mirror the operator
 * surface: companies, agents, runs (with live streaming), proposals, issues.
 */
export class PaperclipOpsClient {
  private readonly mcpClient: Client;
  private readonly transport: NostrClientTransport;

  constructor(config: PaperclipOpsClientConfig) {
    // The bridge is addressed by pubkey, so no public discovery is needed.
    // Pin discovery + fallback to the configured relays (not the SDK's public
    // defaults like relay.damus.io, which stall/503 in a browser WebView).
    // Some relays (e.g. nostr.chaima.info) never answer the pool's liveness
    // ping (a `limit:0` REQ) with an EOSE, and others are borderline (~19s).
    // The default 20s ping timeout then tears down and rebuilds the whole pool
    // every ~2min, dropping in-flight responses and killing live streams. We
    // don't need that health check — push the ping frequency effectively to
    // "never" so a quirky relay can't destabilise a working connection.
    const relays =
      config.relays ?? config.discoveryRelays ?? config.fallbackRelays ?? [];
    const relayPool = new ApplesauceRelayPool(relays, {
      pingFrequencyMs: 2_147_400_000,
    });
    this.transport = new NostrClientTransport({
      signer: new PrivateKeySigner(normalizePrivateKey(config.privateKey)),
      relayHandler: relayPool,
      // Discovery is DISABLED (empty list). The bridge's relays are known/fixed,
      // so there's no need to fetch its kind-10002 relay list — and that fetch
      // waits for an EOSE that nostr.chaima.info never sends, stalling every
      // connect ~10s. With no discovery relays the client uses the configured
      // relays directly. See fallbackOperationalRelayUrls below.
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
      // Explicit CEP-22 config matching the bridge's server-side thresholds
      // (see apps/paperclip-bridge/src/bridge.ts), for any tool call whose
      // reply legitimately exceeds one relay event. Voice recordings do NOT
      // rely on this: @contextvm/sdk 0.11.8's oversized-transfer sender
      // measures a message's size by first NIP-44-encrypting the *whole*
      // plaintext, which throws once the plaintext itself exceeds the
      // NIP-44 65535-byte ceiling — before any fragmentation can happen. So
      // recordings are uploaded as many small `chunk` calls instead (see
      // transcribeAudio below), each already under that ceiling.
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

    // Clock-skew guard. The SDK subscribes for the bridge's replies with
    // `since: floor(Date.now()/1000)` taken from THIS device's clock, while the
    // bridge stamps its encrypted reply with ITS clock. A relay only delivers an
    // event when `created_at >= since`, so if the phone's clock runs even ~1s
    // ahead of the bridge, every reply is silently filtered out — the request is
    // received but the response never arrives and connect() hangs. Rolling the
    // subscription's `since` back by a generous band tolerates a fast client
    // clock (and any relay delivery delay) without meaningfully widening replay.
    const SINCE_GUARD_SECONDS = 3600; // tolerate up to ~1h of client-ahead skew
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
      name: "paperclip-ops-client",
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
    // Do NOT inject onprogress here: with the patched @contextvm/sdk 0.11.8 a
    // progressToken makes the bridge create an open-stream writer for the
    // request, and handleResponse then HOLDS the response instead of sending
    // it — the client times out silently and its transport tears down with
    // MCP error -32000. Pass options straight through (see skill pitfall 12).
    const result = await this.mcpClient.callTool(
      { name, arguments: args },
      undefined,
      options,
    );
    return readStructured<T>(result);
  }

  private async callList<T>(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<T[]> {
    const payload = await this.call<{ items: T[] }>(name, args);
    return payload.items ?? [];
  }

  // -- companies -----------------------------------------------------------
  listCompanies(): Promise<Company[]> {
    return this.callList<Company>(PAPERCLIP_COMPANIES_LIST_TOOL_NAME);
  }

  companyStats(): Promise<CompanyStats> {
    return this.call<CompanyStats>(PAPERCLIP_COMPANIES_STATS_TOOL_NAME);
  }

  // -- agents --------------------------------------------------------------
  listAgents(companyId: string): Promise<Agent[]> {
    return this.callList<Agent>(PAPERCLIP_AGENTS_LIST_TOOL_NAME, { companyId });
  }

  getAgent(agentId: string): Promise<AgentDetail> {
    return this.call<AgentDetail>(PAPERCLIP_AGENTS_GET_TOOL_NAME, { agentId });
  }

  wakeAgent(
    agentId: string,
    reason: string | null,
  ): Promise<AgentWakeupResponse> {
    return this.call<AgentWakeupResponse>(PAPERCLIP_AGENTS_WAKE_TOOL_NAME, {
      agentId,
      reason,
    });
  }

  pauseAgent(agentId: string): Promise<Agent> {
    return this.call<Agent>(PAPERCLIP_AGENTS_CONTROL_TOOL_NAME, {
      agentId,
      action: "pause",
    });
  }

  resumeAgent(agentId: string): Promise<Agent> {
    return this.call<Agent>(PAPERCLIP_AGENTS_CONTROL_TOOL_NAME, {
      agentId,
      action: "resume",
    });
  }

  clearAgentError(agentId: string): Promise<Agent> {
    return this.call<Agent>(PAPERCLIP_AGENTS_CONTROL_TOOL_NAME, {
      agentId,
      action: "clear-error",
    });
  }

  // -- runs ----------------------------------------------------------------
  listRuns(
    companyId: string,
    agentId?: string,
    limit = 30,
  ): Promise<HeartbeatRun[]> {
    return this.callList<HeartbeatRun>(PAPERCLIP_RUNS_LIST_TOOL_NAME, {
      companyId,
      agentId,
      limit,
    });
  }

  liveRuns(companyId: string): Promise<HeartbeatRun[]> {
    return this.callList<HeartbeatRun>(PAPERCLIP_RUNS_LIVE_TOOL_NAME, {
      companyId,
    });
  }

  getRun(runId: string): Promise<HeartbeatRun> {
    return this.call<HeartbeatRun>(PAPERCLIP_RUNS_GET_TOOL_NAME, { runId });
  }

  cancelRun(runId: string): Promise<HeartbeatRun> {
    return this.call<HeartbeatRun>(PAPERCLIP_RUNS_CANCEL_TOOL_NAME, { runId });
  }

  runEvents(
    runId: string,
    afterSeq = 0,
    limit = 500,
  ): Promise<HeartbeatRunEvent[]> {
    return this.callList<HeartbeatRunEvent>(PAPERCLIP_RUN_EVENTS_TOOL_NAME, {
      runId,
      afterSeq,
      limit,
    });
  }

  runLog(runId: string, offset = 0, limitBytes = 65536): Promise<RunLogChunk> {
    return this.call<RunLogChunk>(PAPERCLIP_RUN_LOG_TOOL_NAME, {
      runId,
      offset,
      limitBytes,
    });
  }

  // -- approvals -----------------------------------------------------------
  listApprovals(
    companyId: string,
    status?: ApprovalStatus | string,
  ): Promise<Approval[]> {
    return this.callList<Approval>(PAPERCLIP_APPROVALS_LIST_TOOL_NAME, {
      companyId,
      status,
    });
  }

  getApproval(approvalId: string): Promise<Approval> {
    return this.call<Approval>(PAPERCLIP_APPROVALS_GET_TOOL_NAME, {
      approvalId,
    });
  }

  approvalComments(approvalId: string): Promise<ApprovalComment[]> {
    return this.callList<ApprovalComment>(
      PAPERCLIP_APPROVAL_COMMENTS_TOOL_NAME,
      { approvalId },
    );
  }

  approve(approvalId: string, decisionNote?: string): Promise<Approval> {
    return this.call<Approval>(PAPERCLIP_APPROVALS_DECIDE_TOOL_NAME, {
      approvalId,
      action: "approve",
      decisionNote,
    });
  }

  reject(approvalId: string, decisionNote?: string): Promise<Approval> {
    return this.call<Approval>(PAPERCLIP_APPROVALS_DECIDE_TOOL_NAME, {
      approvalId,
      action: "reject",
      decisionNote,
    });
  }

  requestRevision(
    approvalId: string,
    decisionNote?: string,
  ): Promise<Approval> {
    return this.call<Approval>(PAPERCLIP_APPROVALS_DECIDE_TOOL_NAME, {
      approvalId,
      action: "request-revision",
      decisionNote,
    });
  }

  // -- issues --------------------------------------------------------------
  listIssues(companyId: string, limit = 20, offset = 0): Promise<Issue[]> {
    return this.callList<Issue>(PAPERCLIP_ISSUES_LIST_TOOL_NAME, {
      companyId,
      limit,
      offset,
    });
  }

  /** Sub-issues (children) of an issue. */
  childIssues(
    companyId: string,
    parentId: string,
    limit = 50,
  ): Promise<Issue[]> {
    return this.callList<Issue>(PAPERCLIP_ISSUES_LIST_TOOL_NAME, {
      companyId,
      parentId,
      limit,
    });
  }

  issueActivity(issueId: string, limit = 200): Promise<ActivityEvent[]> {
    return this.callList<ActivityEvent>(PAPERCLIP_ISSUE_ACTIVITY_TOOL_NAME, {
      issueId,
      limit,
    });
  }

  issueRuns(issueId: string): Promise<HeartbeatRun[]> {
    return this.callList<HeartbeatRun>(PAPERCLIP_ISSUE_RUNS_TOOL_NAME, {
      issueId,
    });
  }

  getIssue(issueId: string): Promise<Issue> {
    return this.call<Issue>(PAPERCLIP_ISSUES_GET_TOOL_NAME, { issueId });
  }

  createIssue(
    companyId: string,
    input: {
      title: string;
      description?: string;
      status?: IssueStatus;
      priority?: IssuePriority;
      assigneeAgentId?: string;
      parentId?: string;
    },
  ): Promise<Issue> {
    return this.call<Issue>(PAPERCLIP_ISSUE_CREATE_TOOL_NAME, {
      companyId,
      ...input,
    });
  }

  issueComments(issueId: string): Promise<IssueComment[]> {
    return this.callList<IssueComment>(PAPERCLIP_ISSUE_COMMENTS_TOOL_NAME, {
      issueId,
    });
  }

  addIssueComment(
    issueId: string,
    body: string,
    opts?: { resume?: boolean; interrupt?: boolean },
  ): Promise<IssueComment> {
    return this.call<IssueComment>(PAPERCLIP_ISSUE_COMMENT_TOOL_NAME, {
      issueId,
      body,
      resume: opts?.resume,
      interrupt: opts?.interrupt,
    });
  }

  updateIssue(issueId: string, patch: IssueUpdate): Promise<Issue> {
    return this.call<Issue>(PAPERCLIP_ISSUE_UPDATE_TOOL_NAME, {
      issueId,
      ...patch,
    });
  }

  issueInteractions(issueId: string): Promise<IssueInteraction[]> {
    return this.callList<IssueInteraction>(
      PAPERCLIP_ISSUE_INTERACTIONS_TOOL_NAME,
      { issueId },
    );
  }

  acceptInteraction(
    issueId: string,
    interactionId: string,
    opts?: { selectedOptionIds?: string[]; selectedClientKeys?: string[] },
  ): Promise<IssueInteraction> {
    return this.call<IssueInteraction>(
      PAPERCLIP_ISSUE_INTERACTION_DECIDE_TOOL_NAME,
      {
        issueId,
        interactionId,
        action: "accept",
        selectedOptionIds: opts?.selectedOptionIds,
        selectedClientKeys: opts?.selectedClientKeys,
      },
    );
  }

  rejectInteraction(
    issueId: string,
    interactionId: string,
    reason?: string,
  ): Promise<IssueInteraction> {
    return this.call<IssueInteraction>(
      PAPERCLIP_ISSUE_INTERACTION_DECIDE_TOOL_NAME,
      {
        issueId,
        interactionId,
        action: "reject",
        reason,
      },
    );
  }

  respondInteraction(
    issueId: string,
    interactionId: string,
    answers: Array<Record<string, unknown>>,
    summaryMarkdown?: string,
  ): Promise<IssueInteraction> {
    return this.call<IssueInteraction>(
      PAPERCLIP_ISSUE_INTERACTION_DECIDE_TOOL_NAME,
      {
        issueId,
        interactionId,
        action: "respond",
        answers,
        summaryMarkdown,
      },
    );
  }

  issueApprovals(issueId: string): Promise<Approval[]> {
    return this.callList<Approval>(PAPERCLIP_ISSUE_APPROVALS_TOOL_NAME, {
      issueId,
    });
  }

  issueAttachments(issueId: string): Promise<IssueAttachment[]> {
    return this.callList<IssueAttachment>(
      PAPERCLIP_ISSUE_ATTACHMENTS_TOOL_NAME,
      { issueId },
    );
  }

  deleteIssueAttachment(attachmentId: string): Promise<{ ok: boolean }> {
    return this.call<{ ok: boolean }>(
      PAPERCLIP_ISSUE_ATTACHMENT_DELETE_TOOL_NAME,
      { attachmentId },
    );
  }

  issueWorkProducts(issueId: string): Promise<IssueWorkProduct[]> {
    return this.callList<IssueWorkProduct>(
      PAPERCLIP_ISSUE_WORK_PRODUCTS_TOOL_NAME,
      { issueId },
    );
  }

  issueCostSummary(issueId: string): Promise<IssueCostSummary> {
    return this.call<IssueCostSummary>(PAPERCLIP_ISSUE_COST_TOOL_NAME, {
      issueId,
    });
  }

  issueDocuments(issueId: string): Promise<IssueDocumentSummary[]> {
    return this.callList<IssueDocumentSummary>(
      PAPERCLIP_ISSUE_DOCUMENTS_TOOL_NAME,
      { issueId },
    );
  }

  issueDocument(issueId: string, key: string): Promise<IssueDocument> {
    return this.call<IssueDocument>(PAPERCLIP_ISSUE_DOCUMENT_GET_TOOL_NAME, {
      issueId,
      key,
    });
  }

  deleteIssueComment(
    issueId: string,
    commentId: string,
    mode?: "cancel",
  ): Promise<IssueComment> {
    return this.call<IssueComment>(PAPERCLIP_ISSUE_COMMENT_DELETE_TOOL_NAME, {
      issueId,
      commentId,
      mode,
    });
  }

  // -- voice transcription (local whisper.cpp on the bridge) ---------------
  transcriptionCapabilities(): Promise<PaperclipTranscriptionCapabilities> {
    return this.call<PaperclipTranscriptionCapabilities>(
      PAPERCLIP_TRANSCRIPTION_CAPABILITIES_TOOL_NAME,
    );
  }

  /**
   * Uploads a recording as many small chunk calls, then finalizes it by
   * uploadId. Resolves with the transcript, or rejects with a
   * `PaperclipTranscriptionError` carrying a stable `code` and whether the
   * failure is worth retrying. On any failure or abort, best-effort cancels
   * the upload so the bridge doesn't hold buffered chunks until they expire.
   */
  async transcribeAudio(
    input: {
      contentBase64: string;
      mimeType: string;
      language?: PaperclipTranscriptionLanguage;
      durationMs?: number;
    },
    opts: { signal?: AbortSignal } = {},
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
        const chunkResult = await this.call<PaperclipTranscriptionChunkResult>(
          PAPERCLIP_TRANSCRIPTION_CHUNK_TOOL_NAME,
          { uploadId, index, totalChunks, contentBase64 },
          { timeout: TRANSCRIBE_REQUEST_TIMEOUT_MS, signal: opts.signal },
        );
        if (chunkResult.status === "error") {
          throw new PaperclipTranscriptionError(
            chunkResult.code,
            chunkResult.message,
            chunkResult.retryable,
          );
        }
      }

      const result = await this.call<PaperclipTranscribeAudioResult>(
        PAPERCLIP_TRANSCRIBE_AUDIO_TOOL_NAME,
        {
          uploadId,
          mimeType: input.mimeType,
          language: input.language ?? "auto",
          durationMs: input.durationMs,
        },
        { timeout: TRANSCRIBE_REQUEST_TIMEOUT_MS, signal: opts.signal },
      );
      if (result.status === "error") {
        throw new PaperclipTranscriptionError(
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
      void this.call(PAPERCLIP_TRANSCRIPTION_CANCEL_TOOL_NAME, {
        uploadId,
      }).catch(() => undefined);
      throw cause;
    }
  }

  // -- live events (CEP-41 stream) -----------------------------------------
  async streamCompanyEvents(companyId: string): Promise<CompanyEventStream> {
    const call = await callToolStream<unknown>({
      client: this.mcpClient,
      transport: this.transport,
      name: PAPERCLIP_EVENTS_STREAM_TOOL_NAME,
      arguments: { companyId },
    });
    return {
      events: readPaperclipEvents(call.stream),
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

async function* readPaperclipEvents(
  stream: AsyncIterable<{ value: string }>,
): AsyncIterable<PaperclipLiveEvent> {
  for await (const chunk of stream) {
    yield* parsePaperclipChunk(chunk.value);
  }
}

function readStructured<T>(value: unknown): T {
  if (isObject(value) && isObject(value.structuredContent)) {
    return value.structuredContent as T;
  }
  // Error results (isError: true) from the bridge may not include
  // structuredContent — the MCP SDK's createToolError() only sets content.
  // Surface the error text instead of throwing a confusing
  // "did not include structuredContent" message.
  if (isObject(value) && value.isError) {
    const content = value.content;
    if (Array.isArray(content) && content.length > 0) {
      const first = content[0] as Record<string, unknown>;
      if (typeof first.text === "string") {
        throw new Error(first.text);
      }
    }
    throw new Error("Paperclip bridge returned an error result");
  }
  throw new Error(
    "Paperclip bridge tool result did not include structuredContent",
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export type { PaperclipLiveEvent } from "@contexcgi/protocol";
export * from "./paperclip-types.js";

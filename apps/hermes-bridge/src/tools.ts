import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
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
  HERMES_PROJECTS_LIST_TOOL_NAME,
  HERMES_SESSION_CWD_SET_TOOL_NAME,
  HERMES_SKILLS_LIST_TOOL_NAME,
  HERMES_TRANSCRIBE_AUDIO_TOOL_NAME,
  HERMES_TRANSCRIBE_FILE_TOOL_NAME,
  HERMES_TRANSCRIPTION_CANCEL_TOOL_NAME,
  HERMES_TRANSCRIPTION_CAPABILITIES_TOOL_NAME,
  HERMES_TRANSCRIPTION_CHUNK_TOOL_NAME,
  encodeHermesActivityEvent,
  encodeHermesChatEvent,
  type HermesActivityEvent,
  type HermesChatEvent,
  type HermesChatMessage,
  type HermesChatSummary,
  type HermesHandoffPreviewInput,
  type HermesHandoffRecord,
  type HermesHandoffSendInput,
  type HermesModelOptions,
  type HermesModelProvider,
  type HermesModelSwitchResult,
  type HermesProject,
  type HermesProjectLane,
  type HermesProjectRepo,
  type HermesProjectsResult,
  type HermesSetCwdResult,
  type HermesSetTitleResult,
  type HermesSkillsResult,
} from "@contexcgi/protocol";
import type { GatewayEventFrame, HermesGateway } from "./gateway.js";
import { ActivityTracker } from "./activity.js";
import {
  agentExists,
  listHermesAgents,
  listProfileSkills,
  profileParam,
} from "./profiles.js";
import { fetchCustomProviderModels } from "./custom-providers.js";
import type { WhisperTranscriptionService } from "./transcription.js";
import { transcribeVoiceFile, type VoiceFileSource } from "./transcription.js";
import type { ChunkedUploadBuffer } from "./upload-buffer.js";
import { HandoffStore } from "./handoff-store.js";
import { TurnReservations } from "./turn-reservations.js";
import {
  HandoffValidationError,
  createHandoffPreview,
  handoffMessageDigest,
} from "./handoff.js";

export type HermesToolsConfig = {
  hermesHome: string;
  /** Ceiling on one streamed turn before the bridge gives up (safety net). */
  turnTimeoutMs?: number;
  /** Keepalive cadence on quiet streams (CEP-41 idle timeout is 10min). */
  keepaliveMs?: number;
  /**
   * Hard ceiling on one `hermes.events.stream` subscription. The SDK abort
   * signal does not always fire when a client vanishes (the server-side relay
   * connection stays open, so `isActive()` stays true and keepalive writes
   * keep succeeding into the void). Without a bound, an app that auto-reopens
   * its activity stream leaks one listener per reconnect until the
   * `ActivityTracker` MAX_LISTENERS cap — after which new clients can't
   * subscribe and, under the keepalive-publish flood, can't even initialize.
   * The chat app reopens the stream automatically, so capping lifetime reaps
   * stale listeners without user-visible impact.
   */
  maxStreamLifetimeMs?: number;
  handoffStore: HandoffStore;
  /**
   * File-transfer registry (contexcgi.fileTransfer.*). When present, voice
   * recordings can be uploaded through the resumable, checksum-verified
   * transfer package and transcribed by file id — the preferred path over the
   * legacy in-memory chunk buffer.
   */
  fileTransferRegistry?: VoiceFileSource;
};

/** Build the gateway create payload so cwd is applied before agent creation. */
export function gatewaySessionCreateParams(agentId: string, cwd?: string) {
  return {
    profile: profileParam(agentId),
    cols: 100,
    source: "contextvm",
    ...(cwd ? { cwd } : {}),
  };
}

type StreamSink = {
  isActive(): boolean;
  write(data: string): Promise<void>;
  close(): Promise<void>;
};

// --- gateway wire shapes (subset the bridge reads) --------------------------

type SessionListResponse = {
  sessions?: Array<{
    id?: string;
    title?: string;
    preview?: string;
    started_at?: number;
    message_count?: number;
    source?: string;
  }>;
};

type SessionCreateResponse = { session_id?: string };

type SessionResumeResponse = {
  session_id?: string;
  running?: boolean;
  messages?: TranscriptMessage[];
  /** Effective conversation context returned by current tui_gateway versions. */
  info?: {
    model?: string;
    provider?: string;
    cwd?: string;
  };
  /** Snapshot of the in-flight turn (user prompt + assistant text so far). */
  inflight?: { user?: string; assistant?: string } | null;
};

type SessionActiveListResponse = {
  sessions?: Array<{ id?: string; session_key?: string }>;
};

type TranscriptMessage = {
  role?: string;
  text?: string;
  name?: string;
};

const cut = (value: unknown, max = 400): string | undefined => {
  if (typeof value !== "string") return undefined;
  return value.length > max ? `${value.slice(0, max)}…` : value;
};

const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/**
 * Live attachment bookkeeping: durable chat id (Hermes session key) → live
 * tui_gateway session id. Cleared wholesale when the gateway child dies.
 */
export class LiveSessions {
  private readonly bySidKey = new Map<string, string>();

  key(agentId: string, chatId: string): string {
    return `${agentId}\u0000${chatId}`;
  }

  get(agentId: string, chatId: string): string | undefined {
    return this.bySidKey.get(this.key(agentId, chatId));
  }

  set(agentId: string, chatId: string, sid: string): void {
    this.bySidKey.set(this.key(agentId, chatId), sid);
  }

  clear(): void {
    this.bySidKey.clear();
  }
}

/** Wrap any structured payload as a ContextVM CallToolResult the client reads. */
function ok(data: unknown, summary: string): CallToolResult {
  return {
    content: [{ type: "text", text: summary }],
    structuredContent: data as Record<string, unknown>,
  };
}

function okList(items: unknown[], summary: string): CallToolResult {
  return ok({ items }, summary);
}

function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** First 8 chars of a client pubkey for readable, non-spammy attribution. */
function shortPk(pk: unknown): string {
  return typeof pk === "string" && pk.length >= 8 ? pk.slice(0, 8) : "anon";
}

function briefArgs(args: unknown): string {
  try {
    const json = JSON.stringify(args ?? {});
    return json.length > 200 ? `${json.slice(0, 200)}…` : json;
  } catch {
    return "<unserializable>";
  }
}

/**
 * Wrap every tool handler with entry/exit/error logging so the bridge console
 * shows exactly which client called which tool, with args, timing, and result
 * or failure. Patches registerTool once so individual tools stay untouched.
 */
function instrumentToolLogging(server: McpServer): void {
  const original = server.registerTool.bind(server) as (
    name: string,
    config: unknown,
    handler: (args: unknown, extra: unknown) => unknown,
  ) => unknown;
  (server as unknown as { registerTool: unknown }).registerTool = (
    name: string,
    config: unknown,
    handler: (args: unknown, extra: unknown) => unknown,
  ) =>
    original(name, config, async (args: unknown, extra: unknown) => {
      const started = Date.now();
      const client = shortPk(
        (extra as { _meta?: { clientPubkey?: unknown } })?._meta?.clientPubkey,
      );
      console.log(
        `[bridge] → ${name} client=${client} args=${briefArgs(args)}`,
      );
      try {
        const result = (await handler(args, extra)) as CallToolResult;
        console.log(
          `[bridge] ✓ ${name} ${Date.now() - started}ms client=${client}${result.isError ? " isError=true" : ""}`,
        );
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[bridge] ✗ ${name} ${Date.now() - started}ms client=${client} error=${message}`,
        );
        throw err;
      }
    });
}

function mapTranscript(
  messages: TranscriptMessage[] | undefined,
): HermesChatMessage[] {
  const mapped: HermesChatMessage[] = [];
  for (const [ordinal, message] of (messages ?? []).entries()) {
    const role = message.role;
    if (
      role !== "user" &&
      role !== "assistant" &&
      role !== "system" &&
      role !== "tool"
    ) {
      continue;
    }
    const text = str(message.text) ?? "";
    if (!text) continue;
    mapped.push({
      role,
      text,
      ordinal,
      ...(role === "user" || role === "assistant"
        ? { digest: handoffMessageDigest(role, text) }
        : {}),
      ...(str(message.name) ? { name: message.name } : {}),
    });
  }
  return mapped;
}

/**
 * NIP-44 caps a message's plaintext at 65535 bytes, and the server transport
 * encrypts the *whole* reply before publishing — so an oversized transcript is
 * not fragmented, it is dropped with "invalid plaintext size" and the client
 * simply waits until it times out. A cron conversation whose single assistant
 * message is ~56 KB reproduced this on every open.
 *
 * These budgets leave generous room for the MCP/JSON-RPC framing and the rest
 * of the result envelope that share the same 65535-byte plaintext.
 */
const HISTORY_BUDGET_BYTES = 40_000;
const MESSAGE_TEXT_MAX_BYTES = 12_000;
const INFLIGHT_TEXT_MAX_BYTES = 8_000;
const CLIP_MARKER = "\n\n[… truncated to fit one ContextVM message …]";

/** Clip to at most `maxBytes` UTF-8 bytes without splitting a codepoint. */
export function clipToBytes(
  text: string,
  maxBytes: number,
): { text: string; clipped: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, clipped: false };
  let end = maxBytes;
  // Walk back off any continuation bytes (10xxxxxx) so the cut lands on a
  // codepoint boundary rather than producing U+FFFD.
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  return { text: buf.subarray(0, end).toString("utf8"), clipped: true };
}

/**
 * Fit a transcript into one ContextVM reply, keeping the newest messages —
 * what a chat view actually renders first — and reporting what was dropped.
 */
export function fitHistory(messages: HermesChatMessage[]): {
  messages: HermesChatMessage[];
  omitted: number;
} {
  const kept: HermesChatMessage[] = [];
  let used = 0;
  let omitted = 0;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const original = messages[i]!;
    const { text, clipped } = clipToBytes(
      original.text,
      MESSAGE_TEXT_MAX_BYTES,
    );
    const message: HermesChatMessage = clipped
      ? { ...original, text: `${text}${CLIP_MARKER}`, truncated: true }
      : original;
    const size = Buffer.byteLength(JSON.stringify(message), "utf8");
    // Always keep at least the newest message: it is already clipped to
    // MESSAGE_TEXT_MAX_BYTES, so it cannot overflow the reply on its own.
    if (kept.length > 0 && used + size > HISTORY_BUDGET_BYTES) {
      omitted = i + 1;
      break;
    }
    kept.push(message);
    used += size;
  }

  kept.reverse();
  return { messages: kept, omitted };
}

function getCep41Stream(meta: unknown): StreamSink | undefined {
  if (!meta || typeof meta !== "object" || !("stream" in meta))
    return undefined;
  const stream = (meta as { stream?: unknown }).stream;
  if (!stream || typeof stream !== "object") return undefined;
  const candidate = stream as {
    readonly isActive?: boolean;
    write?: (data: string) => unknown;
    close?: () => unknown;
  };
  if (
    typeof candidate.write !== "function" ||
    typeof candidate.close !== "function"
  ) {
    return undefined;
  }
  const write = candidate.write.bind(candidate);
  const close = candidate.close.bind(candidate);
  const isActive = () => candidate.isActive !== false;
  return {
    isActive,
    write: async (data: string) => {
      if (!isActive()) throw new Error("response stream is no longer active");
      await write(data);
      if (!isActive()) throw new Error("response stream closed during write");
    },
    close: async () => {
      await close();
    },
  };
}

/** Map one tui_gateway event onto the wire event a chat client renders. */
export function mapGatewayEvent(
  frame: GatewayEventFrame,
): HermesChatEvent | null {
  const payload = frame.payload ?? {};
  switch (frame.type) {
    case "message.delta": {
      const text = str(payload.text);
      return text ? { type: "message.delta", text } : null;
    }
    case "thinking.delta":
    case "reasoning.delta":
      // Full reasoning content — the app renders it in a collapsible block.
      return { type: "thinking.delta", text: cut(payload.text, 4000) };
    case "status.update": {
      const text = str(payload.text) ?? str(payload.kind);
      return text ? { type: "status", text } : null;
    }
    case "message.interim": {
      const text = str(payload.text);
      return text ? { type: "message.interim", text } : null;
    }
    case "tool.start":
      return {
        type: "tool.start",
        toolId: str(payload.tool_id) ?? "tool",
        name: str(payload.name),
        // The executed command / tool arguments, shown verbatim in the app.
        argsText: cut(payload.args_text, 4000),
      };
    case "tool.progress":
      return {
        type: "tool.progress",
        name: str(payload.name),
        preview: cut(payload.preview, 1000),
      };
    case "tool.complete":
      return {
        type: "tool.complete",
        toolId: str(payload.tool_id) ?? "tool",
        name: str(payload.name),
        // Prefer the full result text over the one-line summary; each CEP-41
        // frame is its own encrypted event, so 8KB stays well under NIP-44's
        // 64KB ceiling.
        summary: cut(payload.result_text ?? payload.summary, 8000),
        error: cut(payload.error, 2000),
        durationSeconds:
          typeof payload.duration_s === "number"
            ? payload.duration_s
            : undefined,
      };
    case "approval.request":
      return {
        type: "approval.request",
        command: str(payload.command) ?? "(unknown command)",
        description: cut(payload.description, 600),
        choices: Array.isArray(payload.choices)
          ? payload.choices.filter((c): c is string => typeof c === "string")
          : undefined,
      };
    case "clarify.request": {
      const question = cut(str(payload.question), 4000);
      if (!question) return null;
      const requestId = str(payload.request_id) ?? "";
      if (!requestId) return null;
      return {
        type: "clarify.request",
        question,
        requestId,
        choices: Array.isArray(payload.choices)
          ? payload.choices.filter((c): c is string => typeof c === "string")
          : undefined,
      };
    }
    case "message.complete": {
      const failure =
        str(payload.failure_reason) ??
        (str(payload.status) === "error"
          ? (str(payload.error) ?? "turn failed")
          : undefined);
      return {
        type: "message.complete",
        text: str(payload.text) ?? "",
        ...(failure ? { failureReason: failure } : {}),
      };
    }
    default:
      return null;
  }
}

function requireClientKey(extra: { _meta?: unknown }): string | null {
  const meta = extra._meta as { clientPubkey?: unknown } | undefined;
  return typeof meta?.clientPubkey === "string" && meta.clientPubkey.length > 0
    ? meta.clientPubkey
    : null;
}

function missingClientKeyResult(): CallToolResult {
  const failure = {
    status: "error" as const,
    code: "UNSUPPORTED" as const,
    message: "Client identity is required for voice uploads.",
    retryable: false,
  };
  return {
    content: [{ type: "text", text: failure.message }],
    structuredContent: failure,
    isError: true,
  };
}

export function registerHermesTools(
  server: McpServer,
  gateway: HermesGateway,
  config: HermesToolsConfig,
  transcription: WhisperTranscriptionService,
  uploadBuffer: ChunkedUploadBuffer,
): void {
  instrumentToolLogging(server);
  const live = new LiveSessions();
  const turnTimeoutMs = config.turnTimeoutMs ?? 30 * 60_000;
  const keepaliveMs = config.keepaliveMs ?? 25_000;
  const maxStreamLifetimeMs = config.maxStreamLifetimeMs ?? 60 * 60_000;
  const tracker = new ActivityTracker();
  const handoffStore = config.handoffStore;
  const reservations = new TurnReservations();
  const releaseBySid = new Map<string, () => void>();
  const handoffBySid = new Map<string, string>();
  const handoffTerminalWrites = new Map<string, Promise<void>>();
  const trackHandoffTerminalWrite = (
    requestId: string,
    write: Promise<void>,
  ): Promise<void> => {
    const tracked = write.finally(() => {
      if (handoffTerminalWrites.get(requestId) === tracked) {
        handoffTerminalWrites.delete(requestId);
      }
    });
    handoffTerminalWrites.set(requestId, tracked);
    void tracked.catch(() => undefined);
    return tracked;
  };
  const updateHandoff = async (
    requestId: string,
    patch: Partial<HermesHandoffRecord>,
  ): Promise<void> => {
    const current = await handoffStore.get(requestId);
    if (!current) return;
    if (
      current.status === "completed" ||
      current.status === "failed" ||
      current.status === "interrupted"
    )
      return;
    await handoffStore.put({
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
  };
  // Which (agent, chat) each live gateway session is running a turn for. Turn
  // completion is detected HERE (not in the sender's stream pump) so activity
  // subscribers hear about it even when the sender disconnected mid-turn.
  const turnBySid = new Map<string, { agentId: string; chatId: string }>();

  gateway.onEvent((frame) => {
    if (frame.type === "gateway.exited") {
      live.clear();
      turnBySid.clear();
      reservations.clear();
      releaseBySid.clear();
      for (const requestId of handoffBySid.values()) {
        const write = updateHandoff(requestId, {
          status: "interrupted",
          error: "hermes gateway restarted",
        });
        trackHandoffTerminalWrite(requestId, write);
      }
      handoffBySid.clear();
      tracker.failAll("hermes gateway restarted");
      return;
    }
    if (frame.type !== "message.complete" || !frame.session_id) return;
    const turn = turnBySid.get(frame.session_id);
    if (!turn) return;
    turnBySid.delete(frame.session_id);
    releaseBySid.get(frame.session_id)?.();
    releaseBySid.delete(frame.session_id);
    const payload = frame.payload ?? {};
    const failure =
      str(payload.failure_reason) ??
      (str(payload.status) === "error"
        ? (str(payload.error) ?? "turn failed")
        : undefined);
    const handoffRequestId = handoffBySid.get(frame.session_id);
    if (handoffRequestId) {
      handoffBySid.delete(frame.session_id);
      const write = updateHandoff(handoffRequestId, {
        status: failure ? "failed" : "completed",
        responseText: str(payload.text) ?? "",
        ...(failure ? { error: failure } : {}),
      });
      trackHandoffTerminalWrite(handoffRequestId, write);
    }
    tracker.complete(turn.agentId, turn.chatId, {
      preview: cut(payload.text, 160),
      ...(failure ? { failureReason: failure } : {}),
    });
  });

  /** Attach a durable chat to a live gateway session, resuming if needed. */
  const attach = async (
    agentId: string,
    chatId: string,
  ): Promise<{
    sid: string;
    messages?: TranscriptMessage[];
    running?: boolean;
  }> => {
    const existing = live.get(agentId, chatId);
    if (existing) return { sid: existing, running: turnBySid.has(existing) };
    const resumed = await gateway.request<SessionResumeResponse>(
      "session.resume",
      {
        session_id: chatId,
        profile: profileParam(agentId),
        cols: 100,
      },
    );
    const sid = str(resumed.session_id);
    if (!sid) throw new Error("hermes gateway resume returned no session id");
    live.set(agentId, chatId, sid);
    return {
      sid,
      messages: resumed.messages,
      running: Boolean(resumed.running),
    };
  };

  /** Create a brand-new conversation and learn its durable session key. */
  const createChat = async (
    agentId: string,
    cwd?: string,
  ): Promise<{ sid: string; chatId: string }> => {
    const created = await gateway.request<SessionCreateResponse>(
      "session.create",
      gatewaySessionCreateParams(agentId, cwd),
    );
    const sid = str(created.session_id);
    if (!sid) throw new Error("hermes gateway create returned no session id");
    // session.create returns a transient live SID. Never expose or persist it
    // as a chat id: wait briefly for Hermes to assign the durable session key,
    // and fail before prompt submission if it never appears.
    let chatId: string | undefined;
    for (let attempt = 0; attempt < 20 && !chatId; attempt += 1) {
      const active = await gateway.request<SessionActiveListResponse>(
        "session.active_list",
      );
      const entry = (active.sessions ?? []).find(
        (session) => session.id === sid,
      );
      chatId = str(entry?.session_key);
      if (!chatId) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!chatId) {
      throw new Error("new conversation did not receive a durable session key");
    }
    live.set(agentId, chatId, sid);
    return { sid, chatId };
  };

  const requireAgent = (agentId: string): CallToolResult | null =>
    agentExists(config.hermesHome, agentId)
      ? null
      : fail(`unknown agent profile: ${agentId}`);

  // -- agents ---------------------------------------------------------------
  server.registerTool(
    HERMES_AGENTS_LIST_TOOL_NAME,
    {
      title: "List Hermes agent profiles",
      description:
        "Lists every Hermes agent profile on this host (the default HERMES_HOME plus named profiles), with description, soul excerpt, and configured model.",
      inputSchema: {},
    },
    async () => ok({ agents: listHermesAgents(config.hermesHome) }, "agents"),
  );

  // -- conversations ----------------------------------------------------------
  server.registerTool(
    HERMES_CHATS_LIST_TOOL_NAME,
    {
      title: "List an agent's conversations",
      description:
        "Lists persisted Hermes conversations for one agent profile, newest first — including chats started from other surfaces (TUI, Telegram, …).",
      inputSchema: {
        agentId: z.string().min(1),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ agentId, limit }) => {
      const missing = requireAgent(agentId);
      if (missing) return missing;
      const response = await gateway.request<SessionListResponse>(
        "session.list",
        {
          profile: profileParam(agentId),
          limit: limit ?? 50,
        },
      );
      const chats: HermesChatSummary[] = (response.sessions ?? []).map(
        (session) => ({
          id: str(session.id) ?? "",
          agentId,
          title: str(session.title) ?? "",
          preview: str(session.preview) ?? "",
          startedAt:
            typeof session.started_at === "number" ? session.started_at : 0,
          messageCount:
            typeof session.message_count === "number"
              ? session.message_count
              : 0,
          source: str(session.source) ?? "",
        }),
      );
      return okList(chats, "chats");
    },
  );

  server.registerTool(
    HERMES_CHATS_DELETE_TOOL_NAME,
    {
      title: "Delete a conversation",
      inputSchema: { agentId: z.string().min(1), chatId: z.string().min(1) },
    },
    async ({ agentId, chatId }) => {
      const missing = requireAgent(agentId);
      if (missing) return missing;
      await gateway.request("session.delete", {
        session_id: chatId,
        profile: profileParam(agentId),
      });
      return ok({ deleted: chatId }, "deleted");
    },
  );

  server.registerTool(
    HERMES_CHAT_HISTORY_TOOL_NAME,
    {
      title: "Read a conversation transcript",
      description:
        "Returns the message history of one conversation, attaching it to a live Hermes session so the next send is instant.",
      inputSchema: { agentId: z.string().min(1), chatId: z.string().min(1) },
    },
    async ({ agentId, chatId }) => {
      const missing = requireAgent(agentId);
      if (missing) return missing;
      // Always resume (even when already attached): the resume payload is the
      // one call that returns transcript + running flag + the in-flight turn
      // snapshot, so a reopened chat can render a turn it isn't streaming.
      const resumed = await gateway.request<SessionResumeResponse>(
        "session.resume",
        {
          session_id: chatId,
          profile: profileParam(agentId),
          cols: 100,
        },
      );
      const sid = str(resumed.session_id);
      if (sid) live.set(agentId, chatId, sid);
      const { messages, omitted } = fitHistory(mapTranscript(resumed.messages));
      const context = resumed.info
        ? {
            ...(str(resumed.info.model) ? { model: resumed.info.model } : {}),
            ...(str(resumed.info.provider)
              ? { provider: resumed.info.provider }
              : {}),
            ...(str(resumed.info.cwd) ? { cwd: resumed.info.cwd } : {}),
          }
        : undefined;
      const running =
        Boolean(resumed.running) || Boolean(sid && turnBySid.has(sid));
      // The in-flight snapshot shares the same 65535-byte plaintext, and a long
      // running turn's assistant text grows without bound, so clip it too.
      const inflightUser = str(resumed.inflight?.user);
      const inflightAssistant = str(resumed.inflight?.assistant);
      const inflight = resumed.inflight
        ? {
            ...(inflightUser
              ? {
                  user: clipToBytes(inflightUser, INFLIGHT_TEXT_MAX_BYTES).text,
                }
              : {}),
            ...(inflightAssistant
              ? {
                  assistant: clipToBytes(
                    inflightAssistant,
                    INFLIGHT_TEXT_MAX_BYTES,
                  ).text,
                }
              : {}),
          }
        : undefined;
      return ok(
        {
          agentId,
          chatId,
          messages,
          ...(context && Object.keys(context).length ? { context } : {}),
          running,
          ...(running && inflight && Object.keys(inflight).length
            ? { inflight }
            : {}),
          ...(omitted ? { truncated: { omittedMessages: omitted } } : {}),
        },
        `history ${messages.length}${omitted ? ` (+${omitted} older omitted)` : ""}${running ? " (turn running)" : ""}`,
      );
    },
  );

  // -- durable cross-agent handoffs -------------------------------------------
  const messageRefSchema = z.object({
    ordinal: z.number().int().min(0),
    role: z.enum(["user", "assistant"]),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  });
  const destinationSchema = z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("new"),
      agentId: z.string().min(1),
      title: z.string().min(1).max(200),
      cwd: z.string().min(1).max(4096).optional(),
    }),
    z.object({
      kind: z.literal("existing"),
      agentId: z.string().min(1),
      chatId: z.string().min(1),
      title: z.string().max(200).optional(),
    }),
  ]);
  const previewSchema = {
    source: z.object({
      agentId: z.string().min(1),
      chatId: z.string().min(1),
      title: z.string().max(200).optional(),
    }),
    mode: z.enum(["selected", "full"]),
    selected: z.array(messageRefSchema).max(500).optional(),
    destination: destinationSchema,
    instructions: z.string().min(1).max(16_000),
  };

  const loadHandoffPreview = async (input: HermesHandoffPreviewInput) => {
    const missingSource = requireAgent(input.source.agentId);
    if (missingSource)
      throw new Error(`unknown source agent: ${input.source.agentId}`);
    const missingDestination = requireAgent(input.destination.agentId);
    if (missingDestination)
      throw new Error(
        `unknown destination agent: ${input.destination.agentId}`,
      );
    if (input.destination.agentId === input.source.agentId)
      throw new Error(
        "cross-agent handoffs require a different destination agent",
      );
    const resumed = await gateway.request<SessionResumeResponse>(
      "session.resume",
      {
        session_id: input.source.chatId,
        profile: profileParam(input.source.agentId),
        cols: 100,
      },
    );
    const sid = str(resumed.session_id);
    if (sid) live.set(input.source.agentId, input.source.chatId, sid);
    return createHandoffPreview(input, mapTranscript(resumed.messages));
  };

  server.registerTool(
    HERMES_HANDOFF_PREVIEW_TOOL_NAME,
    {
      title: "Preview a cross-agent handoff",
      description:
        "Canonicalizes an immutable visible user/assistant snapshot and returns the exact destination prompt, byte count, and confirmation digest.",
      inputSchema: previewSchema,
    },
    async (args): Promise<CallToolResult> => {
      try {
        const preview = await loadHandoffPreview(
          args as HermesHandoffPreviewInput,
        );
        return ok(preview, `handoff-preview ${preview.byteCount} bytes`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code =
          error instanceof HandoffValidationError
            ? error.code
            : "INVALID_HANDOFF";
        return {
          ...ok({ status: "error", code, message }, message),
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    HERMES_HANDOFFS_LIST_TOOL_NAME,
    {
      title: "List cross-agent handoffs",
      inputSchema: {
        agentId: z.string().min(1).optional(),
        chatId: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ agentId, chatId, limit }) =>
      okList(await handoffStore.list({ agentId, chatId, limit }), "handoffs"),
  );

  server.registerTool(
    HERMES_HANDOFF_GET_TOOL_NAME,
    {
      title: "Get a cross-agent handoff",
      inputSchema: { requestId: z.string().min(8).max(128) },
    },
    async ({ requestId }) => {
      const record = await handoffStore.get(requestId);
      return record ? ok(record, "handoff") : fail("handoff not found");
    },
  );

  server.registerTool(
    HERMES_HANDOFF_SEND_TOOL_NAME,
    {
      title: "Deliver a confirmed cross-agent handoff",
      description:
        "Revalidates and persists a confirmed immutable snapshot, then streams the destination Hermes turn.",
      inputSchema: {
        ...previewSchema,
        requestId: z.string().uuid(),
        previewDigest: z.string().regex(/^[a-f0-9]{64}$/),
      },
    },
    async (rawArgs, extra): Promise<CallToolResult> => {
      const args = rawArgs as HermesHandoffSendInput;
      const stream = getCep41Stream(extra._meta);
      if (!stream)
        return fail(
          "hermes.handoffs.send requires ContextVM CEP-41 stream support",
        );

      const prior = await handoffStore.get(args.requestId);
      if (prior) {
        await stream.close();
        if (prior.previewDigest !== args.previewDigest) {
          return fail("requestId was already used for a different handoff");
        }
        return ok(
          {
            requestId: prior.requestId,
            artifactId: prior.artifactId,
            agentId: prior.destination.agentId,
            chatId:
              prior.destinationChatId ??
              (prior.destination.kind === "existing"
                ? prior.destination.chatId
                : ""),
            text: prior.responseText ?? "",
            interrupted: prior.status === "interrupted",
            status: prior.status,
          },
          `handoff-${prior.status}`,
        );
      }

      const claimed = await handoffStore.claim(args.requestId);
      if (!claimed) {
        await stream.close();
        const concurrent = await handoffStore.get(args.requestId);
        return concurrent
          ? ok(
              {
                requestId: concurrent.requestId,
                artifactId: concurrent.artifactId,
                agentId: concurrent.destination.agentId,
                chatId:
                  concurrent.destinationChatId ??
                  (concurrent.destination.kind === "existing"
                    ? concurrent.destination.chatId
                    : ""),
                text: concurrent.responseText ?? "",
                interrupted: concurrent.status === "interrupted",
                status: concurrent.status,
              },
              `handoff-${concurrent.status}`,
            )
          : fail(
              "handoff request is already being prepared; retry with the same requestId",
            );
      }

      let preview;
      try {
        preview = await loadHandoffPreview(args);
      } catch (error) {
        await handoffStore.releaseClaim(args.requestId);
        await stream.close();
        return fail(error instanceof Error ? error.message : String(error));
      }
      if (preview.previewDigest !== args.previewDigest) {
        await handoffStore.releaseClaim(args.requestId);
        await stream.close();
        return fail(
          "source or handoff fields changed after preview; preview again",
        );
      }
      let artifact;
      try {
        artifact = await handoffStore.createArtifact(preview);
      } catch (error) {
        await handoffStore.releaseClaim(args.requestId);
        await stream.close();
        throw error;
      }
      const now = new Date().toISOString();
      let record: HermesHandoffRecord = {
        schemaVersion: 1,
        requestId: args.requestId,
        artifactId: artifact.artifactId,
        source: preview.source,
        destination: preview.destination,
        mode: preview.mode,
        messageCount: preview.messages.length,
        instructions: preview.instructions,
        previewDigest: preview.previewDigest,
        status: "accepted",
        createdAt: now,
        updatedAt: now,
      };
      try {
        await handoffStore.put(record);
      } catch (error) {
        await stream.close().catch(() => undefined);
        throw error;
      } finally {
        await handoffStore.releaseClaim(args.requestId);
      }

      let sid: string;
      let destinationChatId: string;
      let created: boolean;
      let releaseReservation: (() => void) | undefined;
      try {
        if (preview.destination.kind === "existing") {
          const resumed = await gateway.request<SessionResumeResponse>(
            "session.resume",
            {
              session_id: preview.destination.chatId,
              profile: profileParam(preview.destination.agentId),
              cols: 100,
            },
          );
          sid = str(resumed.session_id) ?? "";
          if (!sid)
            throw new Error("destination conversation could not be resumed");
          if (resumed.running || turnBySid.has(sid)) {
            throw new Error(
              "destination conversation already has a running turn",
            );
          }
          destinationChatId = preview.destination.chatId;
          // No await is permitted between learning the durable destination and
          // this synchronous reservation: competing sends serialize here.
          releaseReservation = reservations.reserve(
            preview.destination.agentId,
            destinationChatId,
            args.requestId,
          );
          created = false;
          live.set(preview.destination.agentId, destinationChatId, sid);
          record = {
            ...record,
            destinationChatId,
            updatedAt: new Date().toISOString(),
          };
          await handoffStore.put(record);
        } else {
          const destination = await createChat(
            preview.destination.agentId,
            preview.destination.cwd,
          );
          sid = destination.sid;
          destinationChatId = destination.chatId;
          releaseReservation = reservations.reserve(
            preview.destination.agentId,
            destinationChatId,
            args.requestId,
          );
          created = true;
          record = {
            ...record,
            destinationChatId,
            updatedAt: new Date().toISOString(),
          };
          await handoffStore.put(record);
          await gateway.request("session.title", {
            session_id: sid,
            title: preview.destination.title,
          });
        }
        record = {
          ...record,
          destinationChatId,
          status: "running",
          updatedAt: new Date().toISOString(),
        };
        await handoffStore.put(record);
      } catch (error) {
        releaseReservation?.();
        record = {
          ...record,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          updatedAt: new Date().toISOString(),
        };
        await handoffStore.put(record);
        await stream.close();
        return fail(record.error ?? "handoff failed");
      }

      const write = (event: HermesChatEvent) =>
        stream.write(encodeHermesChatEvent(event));
      try {
        await write({
          type: "chat.started",
          agentId: preview.destination.agentId,
          chatId: destinationChatId,
          created,
        });
      } catch (error) {
        releaseReservation();
        record = {
          ...record,
          status: "failed",
          error:
            error instanceof Error
              ? error.message
              : "failed to start handoff stream",
          updatedAt: new Date().toISOString(),
        };
        await handoffStore.put(record);
        await stream.close().catch(() => undefined);
        return fail(record.error ?? "failed to start handoff stream");
      }
      tracker.start(preview.destination.agentId, destinationChatId);
      turnBySid.set(sid, {
        agentId: preview.destination.agentId,
        chatId: destinationChatId,
      });
      releaseBySid.set(sid, releaseReservation);
      handoffBySid.set(sid, args.requestId);

      let finalText = "";
      let interrupted = false;
      await new Promise<void>((resolve) => {
        let done = false;
        let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
        const finishAfter = async (persistence?: Promise<void>) => {
          if (done) return;
          done = true;
          unsubscribe();
          clearTimeout(deadline);
          if (keepaliveTimer) clearInterval(keepaliveTimer);
          extra.signal?.removeEventListener("abort", onAbort);
          try {
            if (persistence) await persistence;
          } finally {
            resolve();
          }
        };
        const detach = () => {
          // Losing the client stream must not terminalize work that Hermes is
          // still running. The global gateway listener owns durable completion.
          interrupted = true;
          void finishAfter();
        };
        const onAbort = detach;
        const unsubscribe = gateway.onEvent((frame) => {
          // gateway.exited has no relevant SID. Handle it first and await the
          // global lifecycle owner's durable interrupted transition.
          if (frame.type === "gateway.exited") {
            interrupted = true;
            const persistence =
              handoffTerminalWrites.get(args.requestId) ??
              updateHandoff(args.requestId, {
                status: "interrupted",
                error: "hermes gateway restarted",
              });
            void write({
              type: "error",
              message: "hermes gateway restarted mid-handoff",
            })
              .catch(() => undefined)
              .finally(() => finishAfter(persistence));
            return;
          }
          if (frame.session_id !== sid) return;
          const mapped = mapGatewayEvent(frame);
          if (!mapped) return;
          const written = write(mapped);
          if (mapped.type === "message.complete") {
            finalText = mapped.text;
            const persistence =
              handoffTerminalWrites.get(args.requestId) ?? Promise.resolve();
            void written
              .catch(() => {
                interrupted = true;
              })
              .finally(() => finishAfter(persistence));
            return;
          }
          void written.catch(detach);
        });
        keepaliveTimer = setInterval(() => {
          if (!stream.isActive()) {
            detach();
            return;
          }
          void write({ type: "keepalive", ts: Date.now() }).catch(detach);
        }, keepaliveMs);
        const deadline = setTimeout(detach, turnTimeoutMs);
        if (extra.signal) {
          if (extra.signal.aborted) return onAbort();
          extra.signal.addEventListener("abort", onAbort, { once: true });
        }
        gateway
          .request("prompt.submit", { session_id: sid, text: preview.envelope })
          .catch((error: unknown) => {
            const message =
              error instanceof Error ? error.message : String(error);
            turnBySid.delete(sid);
            handoffBySid.delete(sid);
            releaseBySid.get(sid)?.();
            releaseBySid.delete(sid);
            tracker.complete(preview.destination.agentId, destinationChatId, {
              failureReason: message,
            });
            const persistence = updateHandoff(args.requestId, {
              status: "failed",
              error: message,
            });
            trackHandoffTerminalWrite(args.requestId, persistence);
            void write({ type: "error", message })
              .catch(() => undefined)
              .finally(() => finishAfter(persistence));
          });
      });
      await stream.close();
      const saved = await handoffStore.get(args.requestId);
      return ok(
        {
          requestId: args.requestId,
          artifactId: artifact.artifactId,
          agentId: preview.destination.agentId,
          chatId: destinationChatId,
          text: finalText,
          interrupted,
          status: saved?.status ?? (interrupted ? "interrupted" : "completed"),
        },
        "handoff-complete",
      );
    },
  );

  // -- live chat turn (CEP-41 stream) -----------------------------------------
  server.registerTool(
    HERMES_CHAT_SEND_TOOL_NAME,
    {
      title: "Send a message and stream the turn",
      description:
        "Sends one user message to a Hermes agent and streams the whole turn (thinking, tool calls, response deltas) as JSONL over the ContextVM CEP-41 stream. Omit chatId to start a new conversation; the chat.started frame echoes the durable chat id. Pass model (and optionally provider) to pin this conversation's model for the turn — applied to the exact gateway session before submit, so even the first message of a new conversation runs on the chosen model.",
      inputSchema: {
        agentId: z.string().min(1),
        chatId: z.string().min(1).optional(),
        text: z.string().min(1).max(64_000),
        cwd: z.string().min(1).max(4096).optional(),
        /** Pin the conversation model for this turn (session-scoped). */
        model: z.string().min(1).optional(),
        /** Optional provider slug for the model switch. */
        provider: z.string().min(1).optional(),
      },
    },
    async ({ agentId, chatId, text, cwd, model, provider }, extra): Promise<CallToolResult> => {
      const missing = requireAgent(agentId);
      if (missing) return missing;
      const stream = getCep41Stream(extra._meta);
      if (!stream) {
        return fail(
          "hermes.chat.send requires ContextVM CEP-41 stream support",
        );
      }

      let sid: string;
      let durableChatId: string;
      let created = false;
      let releaseReservation: (() => void) | undefined;
      try {
        if (chatId) {
          const attached = await attach(agentId, chatId);
          sid = attached.sid;
          durableChatId = chatId;
          if (attached.running || turnBySid.has(sid)) {
            throw new Error(
              "destination conversation already has a running turn",
            );
          }
          releaseReservation = reservations.reserve(
            agentId,
            durableChatId,
            `chat:${sid}`,
          );
          if (cwd) {
            await gateway.request("session.cwd.set", { session_id: sid, cwd });
          }
        } else {
          ({ sid, chatId: durableChatId } = await createChat(agentId, cwd));
          releaseReservation = reservations.reserve(
            agentId,
            durableChatId,
            `chat:${sid}`,
          );
          created = true;
        }

        // Enforce a model override on the EXACT session that will run this
        // turn, before submit. This is what makes a "switch model" stick even
        // on a brand-new conversation's first message — the old path relied on
        // a separate hermes.model.switch RPC and the live-session cache, which
        // is empty before the first send, so the first request fell back to the
        // profile default while the UI already showed the picked model.
        // Fail-closed: if the switch can't be applied, refuse the turn rather
        // than silently serving the default model.
        if (model) {
          const modelInput = [
            model,
            ...(provider ? ["--provider", provider] : []),
            "--session",
          ].join(" ");
          await gateway.request("config.set", {
            session_id: sid,
            key: "model",
            value: modelInput,
          });
        }
      } catch (error) {
        releaseReservation?.();
        await stream.close();
        return fail(error instanceof Error ? error.message : String(error));
      }

      const write = (event: HermesChatEvent) =>
        stream.write(encodeHermesChatEvent(event));
      try {
        await write({
          type: "chat.started",
          agentId,
          chatId: durableChatId,
          created,
        });
      } catch (error) {
        releaseReservation?.();
        await stream.close().catch(() => undefined);
        return fail(error instanceof Error ? error.message : String(error));
      }

      let finalText = "";
      let interrupted = false;
      let lastWrite = Date.now();

      const turn = new Promise<void>((resolve) => {
        let done = false;
        let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
        let deadline: ReturnType<typeof setTimeout> | null = null;
        const finish = () => {
          if (done) return;
          done = true;
          unsubscribe();
          if (keepaliveTimer) clearInterval(keepaliveTimer);
          if (deadline) clearTimeout(deadline);
          extra.signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          // The client walked away mid-turn; the agent keeps working and the
          // transcript stays recoverable via hermes.chats.history.
          interrupted = true;
          finish();
        };
        const unsubscribe = gateway.onEvent((frame) => {
          if (frame.type === "gateway.exited") {
            void write({
              type: "error",
              message: "hermes gateway restarted mid-turn",
            }).catch(() => undefined);
            finish();
            return;
          }
          if (frame.session_id !== sid) return;
          const mapped = mapGatewayEvent(frame);
          if (!mapped) return;
          lastWrite = Date.now();
          void write(mapped).catch(() => {
            // Stream gone (client offline past the grace period) — stop pumping.
            interrupted = true;
            finish();
          });
          if (mapped.type === "message.complete") {
            finalText = mapped.text;
            finish();
          }
        });
        keepaliveTimer = setInterval(() => {
          if (Date.now() - lastWrite >= keepaliveMs) {
            lastWrite = Date.now();
            void write({ type: "keepalive", ts: Date.now() }).catch(() => {
              interrupted = true;
              finish();
            });
          }
        }, keepaliveMs);
        deadline = setTimeout(() => {
          void write({
            type: "error",
            message: `turn exceeded ${Math.round(turnTimeoutMs / 60_000)}min — detaching (the agent may still finish; check history)`,
          }).catch(() => undefined);
          finish();
        }, turnTimeoutMs);
        if (extra.signal) {
          if (extra.signal.aborted) return onAbort();
          extra.signal.addEventListener("abort", onAbort, { once: true });
        }

        // Announce the turn app-wide before submitting; the global
        // message.complete watcher (above) retires it, so the announcement
        // outlives this stream if the sender disconnects mid-turn.
        turnBySid.set(sid, { agentId, chatId: durableChatId });
        releaseBySid.set(sid, releaseReservation);
        tracker.start(agentId, durableChatId);
        gateway
          .request("prompt.submit", { session_id: sid, text })
          .catch(async (err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            turnBySid.delete(sid);
            releaseBySid.get(sid)?.();
            releaseBySid.delete(sid);
            tracker.complete(agentId, durableChatId, {
              failureReason: message,
            });
            await write({ type: "error", message }).catch(() => undefined);
            finish();
          });
      });

      await turn;
      await stream.close();
      return ok(
        { agentId, chatId: durableChatId, text: finalText, interrupted },
        "turn-complete",
      );
    },
  );

  // Re-attach to a RUNNING turn (started by any client, or one this client
  // abandoned by navigating away) and stream its remaining frames. Combine
  // with hermes.chats.history's `inflight` snapshot for the part already
  // generated. Closes immediately with running:false when nothing is running.
  server.registerTool(
    HERMES_CHAT_WATCH_TOOL_NAME,
    {
      title: "Watch a conversation's running turn",
      description:
        "Streams the rest of a currently-running turn for one conversation (thinking, tool calls, response " +
        "deltas) over the CEP-41 stream, without sending anything. Returns running:false right away when the " +
        "conversation has no turn in flight.",
      inputSchema: { agentId: z.string().min(1), chatId: z.string().min(1) },
    },
    async ({ agentId, chatId }, extra): Promise<CallToolResult> => {
      const missing = requireAgent(agentId);
      if (missing) return missing;
      const stream = getCep41Stream(extra._meta);
      if (!stream) {
        return fail(
          "hermes.chat.watch requires ContextVM CEP-41 stream support",
        );
      }
      const sid = live.get(agentId, chatId);
      if (!sid || !turnBySid.has(sid)) {
        await stream.close();
        return ok(
          { agentId, chatId, running: false, text: "", interrupted: false },
          "no-turn-running",
        );
      }

      const write = (event: HermesChatEvent) =>
        stream.write(encodeHermesChatEvent(event));
      await write({ type: "chat.started", agentId, chatId, created: false });

      let finalText = "";
      let interrupted = false;
      let lastWrite = Date.now();
      await new Promise<void>((resolve) => {
        let done = false;
        let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
        let deadline: ReturnType<typeof setTimeout> | null = null;
        const finish = () => {
          if (done) return;
          done = true;
          unsubscribe();
          if (keepaliveTimer) clearInterval(keepaliveTimer);
          if (deadline) clearTimeout(deadline);
          extra.signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          interrupted = true;
          finish();
        };
        const unsubscribe = gateway.onEvent((frame) => {
          if (frame.type === "gateway.exited") {
            void write({
              type: "error",
              message: "hermes gateway restarted mid-turn",
            }).catch(() => undefined);
            finish();
            return;
          }
          if (frame.session_id !== sid) return;
          const mapped = mapGatewayEvent(frame);
          if (!mapped) return;
          lastWrite = Date.now();
          void write(mapped).catch(() => {
            interrupted = true;
            finish();
          });
          if (mapped.type === "message.complete") {
            finalText = mapped.text;
            finish();
          }
        });
        keepaliveTimer = setInterval(() => {
          if (Date.now() - lastWrite >= keepaliveMs) {
            lastWrite = Date.now();
            void write({ type: "keepalive", ts: Date.now() }).catch(() => {
              interrupted = true;
              finish();
            });
          }
        }, keepaliveMs);
        deadline = setTimeout(finish, turnTimeoutMs);
        if (extra.signal) {
          if (extra.signal.aborted) return onAbort();
          extra.signal.addEventListener("abort", onAbort, { once: true });
        }
        // The turn may have completed between the check above and subscribing.
        if (!turnBySid.has(sid)) finish();
      });

      await stream.close();
      return ok(
        { agentId, chatId, running: true, text: finalText, interrupted },
        "watch-complete",
      );
    },
  );

  server.registerTool(
    HERMES_CHAT_INTERRUPT_TOOL_NAME,
    {
      title: "Interrupt the current turn",
      inputSchema: { agentId: z.string().min(1), chatId: z.string().min(1) },
    },
    async ({ agentId, chatId }) => {
      const missing = requireAgent(agentId);
      if (missing) return missing;
      const sid = live.get(agentId, chatId);
      if (!sid) return fail("no live turn for this chat");
      await gateway.request("session.interrupt", { session_id: sid });
      return ok({ agentId, chatId, interrupted: true }, "interrupted");
    },
  );

  server.registerTool(
    HERMES_CHAT_APPROVE_TOOL_NAME,
    {
      title: "Answer a pending command approval",
      inputSchema: {
        agentId: z.string().min(1),
        chatId: z.string().min(1),
        choice: z.enum(["once", "session", "always", "deny"]),
      },
    },
    async ({ agentId, chatId, choice }) => {
      const missing = requireAgent(agentId);
      if (missing) return missing;
      const sid = live.get(agentId, chatId);
      if (!sid) return fail("no live turn for this chat");
      await gateway.request("approval.respond", { session_id: sid, choice });
      return ok({ agentId, chatId, choice }, "approval-answered");
    },
  );

  server.registerTool(
    HERMES_CHAT_CLARIFY_ANSWER_TOOL_NAME,
    {
      title: "Answer a pending clarifying question",
      description:
        "Submits an answer to a clarifying question the agent asked mid-turn (a choice from the question's `choices` or free text), unblocking the parked turn. The `requestId` comes from the `clarify.request` stream event.",
      inputSchema: {
        agentId: z.string().min(1),
        chatId: z.string().min(1),
        requestId: z.string().min(1),
        answer: z.string().min(1),
      },
    },
    async ({ agentId, chatId, requestId, answer }) => {
      const missing = requireAgent(agentId);
      if (missing) return missing;
      const sid = live.get(agentId, chatId);
      if (!sid) return fail("no live turn for this chat");
      await gateway.request("clarify.respond", {
        session_id: sid,
        request_id: requestId,
        answer,
      });
      return ok({ agentId, chatId, answer }, "clarify-answered");
    },
  );

  // -- conversation title -----------------------------------------------------
  // Proxies tui_gateway session.title. Setting a title before the first send
  // names a new conversation up front; reading it fetches the current title.
  server.registerTool(
    HERMES_CHAT_SET_TITLE_TOOL_NAME,
    {
      title: "Set or read a conversation title",
      description:
        "Sets the human-facing title of one conversation when `title` is provided, or reads the current title when it is omitted. Setting a title before the first send names a new conversation up front instead of waiting for the auto-generated one.",
      inputSchema: {
        agentId: z.string().min(1),
        chatId: z.string().min(1),
        title: z.string().min(1).max(200).optional(),
      },
    },
    async ({ agentId, chatId, title }): Promise<CallToolResult> => {
      const missing = requireAgent(agentId);
      if (missing) return missing;
      // Attach the chat to a live gateway session so the title lands on the
      // right row even before the first message is sent.
      const sid =
        live.get(agentId, chatId) ?? (await attach(agentId, chatId)).sid;
      const response = await gateway.request<{
        title?: string;
        session_key?: string;
        pending?: boolean;
      }>("session.title", {
        session_id: sid,
        ...(title ? { title } : {}),
      });
      const result: HermesSetTitleResult = {
        agentId,
        chatId,
        title: str(response.title) ?? title ?? "",
        pending: Boolean(response.pending),
      };
      return ok(result, title ? "title-set" : "title-read");
    },
  );

  // -- model picker -----------------------------------------------------------
  // Proxies tui_gateway model.options. The app renders the payload as a modal
  // listing every available model grouped by provider, mirroring the Hermes
  // TUI/desktop picker. Selecting a model calls hermes.model.switch.

  /** Map one tui_gateway provider row to the wire shape the app renders. */
  function mapProviderRow(row: Record<string, unknown>): HermesModelProvider {
    const models = Array.isArray(row.models)
      ? row.models.filter((m): m is string => typeof m === "string")
      : [];
    const capabilitiesRaw = row.capabilities;
    const capabilities =
      capabilitiesRaw && typeof capabilitiesRaw === "object"
        ? Object.fromEntries(
            Object.entries(capabilitiesRaw as Record<string, unknown>)
              .filter(([, v]) => v && typeof v === "object")
              .map(([k, v]) => [
                k,
                {
                  fast: Boolean((v as Record<string, unknown>)?.fast),
                  reasoning: Boolean((v as Record<string, unknown>)?.reasoning),
                },
              ]),
          )
        : undefined;
    return {
      slug: str(row.slug) ?? "",
      name: str(row.name) ?? str(row.slug) ?? "",
      isCurrent: Boolean(row.is_current),
      authenticated:
        typeof row.authenticated === "boolean" ? row.authenticated : undefined,
      models,
      totalModels:
        typeof row.total_models === "number" ? row.total_models : models.length,
      isUserDefined: Boolean(row.is_user_defined),
      ...(capabilities ? { capabilities } : {}),
    };
  }

  server.registerTool(
    HERMES_MODELS_LIST_TOOL_NAME,
    {
      title: "List available models grouped by provider",
      description:
        "Returns every model available to this Hermes profile, grouped by provider — the same payload the Hermes TUI/desktop model picker renders. Use hermes.model.switch to pin one for the next request.",
      inputSchema: {
        agentId: z.string().min(1),
        chatId: z.string().min(1).optional(),
        refresh: z.boolean().optional(),
        includeUnconfigured: z.boolean().optional(),
      },
    },
    async ({
      agentId,
      chatId,
      refresh,
      includeUnconfigured,
    }): Promise<CallToolResult> => {
      const missing = requireAgent(agentId);
      if (missing) return missing;
      // Prefer a live session's model context so the picker reflects the
      // conversation's current provider/model, not just disk config.
      const sid = chatId ? live.get(agentId, chatId) : undefined;
      const response = await gateway.request<{
        providers?: unknown[];
        model?: string;
        provider?: string;
      }>("model.options", {
        ...(sid ? { session_id: sid } : {}),
        explicit_only: true,
        include_unconfigured: Boolean(includeUnconfigured),
        refresh: Boolean(refresh),
      });
      // The gateway only returns the single configured model per custom
      // provider. Probe each custom endpoint's /v1/models to discover the full
      // catalog (Routstr: 20, BitRouter: 17, ...) so the picker shows every
      // available model, not just the configured default.
      const customModels = await fetchCustomProviderModels(config.hermesHome);
      const providers = (response.providers ?? [])
        .filter((p): p is Record<string, unknown> =>
          Boolean(p && typeof p === "object"),
        )
        .map((row) => {
          const mapped = mapProviderRow(row);
          // Merge probed models for custom providers (slug starts with "custom:").
          // The gateway's row carries only the configured default model.
          if (mapped.slug.startsWith("custom:") && mapped.models.length <= 1) {
            const probed = customModels.get(mapped.name);
            if (probed && probed.models.length > mapped.models.length) {
              return {
                ...mapped,
                models: probed.models,
                totalModels: probed.models.length,
              };
            }
          }
          return mapped;
        });
      const payload: HermesModelOptions = {
        providers,
        model: str(response.model) ?? "",
        provider: str(response.provider) ?? "",
      };
      return ok(payload, `models ${providers.length} providers`);
    },
  );

  server.registerTool(
    HERMES_MODEL_SWITCH_TOOL_NAME,
    {
      title: "Switch the conversation's model",
      description:
        "Pins a new model (and optionally provider) for the next request in this conversation — session-scoped by default, so other conversations keep their own model. The switch takes effect on the next prompt.submit and does not mutate global config unless `global` is true.",
      inputSchema: {
        agentId: z.string().min(1),
        chatId: z.string().min(1),
        model: z.string().min(1),
        provider: z.string().min(1).optional(),
        /** True to persist the switch globally (across all conversations). */
        global: z.boolean().optional(),
      },
    },
    async ({
      agentId,
      chatId,
      model,
      provider,
      global: globalFlag,
    }): Promise<CallToolResult> => {
      const missing = requireAgent(agentId);
      if (missing) return missing;
      const sid =
        live.get(agentId, chatId) ?? (await attach(agentId, chatId)).sid;
      // Build the /model input the tui_gateway config.set handler parses.
      // "model --provider slug --session" pins it to this conversation only.
      const modelInput = [
        model,
        ...(provider ? ["--provider", provider] : []),
        ...(globalFlag ? ["--global"] : ["--session"]),
      ].join(" ");
      const response = await gateway.request<{
        value?: string;
        warning?: string;
        confirm_required?: boolean;
        confirm_message?: string;
        scope?: string;
      }>("config.set", {
        session_id: sid,
        key: "model",
        value: modelInput,
      });
      const result: HermesModelSwitchResult = {
        value: str(response.value) ?? model,
        scope: str(response.scope) ?? "session",
        ...(str(response.warning) ? { warning: response.warning } : {}),
        ...(response.confirm_required
          ? {
              confirmRequired: true,
              confirmMessage:
                str(response.confirm_message) ?? "Confirm model switch",
            }
          : {}),
      };
      return ok(result, "model-switched");
    },
  );

  // -- projects ---------------------------------------------------------------
  // Proxies tui_gateway projects.tree. Lists every project the agent has ever
  // worked in — explicit (user-created) and auto-discovered from session cwd
  // history + git probing. The app renders this as a picker so the user can
  // pin a project's cwd onto the current conversation without re-typing it.
  function mapLane(row: Record<string, unknown>): HermesProjectLane {
    return {
      id: str(row.id) ?? "",
      label: str(row.label) ?? "",
      path: str(row.path) ?? "",
      isMain: Boolean(row.isMain),
      ...(typeof row.isKanban === "boolean" ? { isKanban: row.isKanban } : {}),
    };
  }

  function mapRepo(row: Record<string, unknown>): HermesProjectRepo {
    const lanesRaw = Array.isArray(row.groups) ? row.groups : [];
    const lanes = lanesRaw
      .filter((lane): lane is Record<string, unknown> =>
        Boolean(lane && typeof lane === "object"),
      )
      .map(mapLane);
    return {
      id: str(row.id) ?? "",
      label: str(row.label) ?? "",
      path: str(row.path) ?? "",
      sessionCount:
        typeof row.sessionCount === "number"
          ? row.sessionCount
          : typeof (row as { session_count?: unknown }).session_count ===
              "number"
            ? (row as { session_count: number }).session_count
            : 0,
      lanes,
    };
  }

  function mapProject(row: Record<string, unknown>): HermesProject {
    const reposRaw = Array.isArray(row.repos) ? row.repos : [];
    const repos = reposRaw
      .filter((repo): repo is Record<string, unknown> =>
        Boolean(repo && typeof repo === "object"),
      )
      .map(mapRepo);
    const color = str(row.color);
    const icon = str(row.icon);
    return {
      id: str(row.id) ?? "",
      label: str(row.label) ?? "",
      path: str(row.path) ?? "",
      ...(color ? { color } : {}),
      ...(icon ? { icon } : {}),
      isAuto: Boolean(row.isAuto),
      sessionCount:
        typeof row.sessionCount === "number"
          ? row.sessionCount
          : typeof (row as { session_count?: unknown }).session_count ===
              "number"
            ? (row as { session_count: number }).session_count
            : 0,
      lastActive:
        typeof row.lastActive === "number"
          ? row.lastActive
          : typeof (row as { last_active?: unknown }).last_active === "number"
            ? (row as { last_active: number }).last_active * 1000
            : 0,
      repos,
    };
  }

  server.registerTool(
    HERMES_PROJECTS_LIST_TOOL_NAME,
    {
      title: "List projects the agent has worked in",
      description:
        "Lists every project (explicit + auto-discovered from session cwd history) the agent has run in, grouped by repo and git lane. Use hermes.session.cwd.set to pin one onto a conversation so the agent works in that project without being told each time.",
      inputSchema: {
        agentId: z.string().min(1),
      },
    },
    async ({ agentId }): Promise<CallToolResult> => {
      const missing = requireAgent(agentId);
      if (missing) return missing;
      const response = await gateway.request<{
        projects?: unknown[];
        active_id?: string;
      }>("projects.tree", {
        preview_limit: 3,
        session_limit: 2000,
      });
      const projects = (response.projects ?? [])
        .filter((p): p is Record<string, unknown> =>
          Boolean(p && typeof p === "object"),
        )
        .map(mapProject);
      const result: HermesProjectsResult = {
        agentId,
        projects,
        activeId: str(response.active_id) ?? null,
      };
      return ok(result, `projects ${projects.length}`);
    },
  );

  // -- session cwd set --------------------------------------------------------
  // Proxies tui_gateway session.cwd.set. Pins a working directory onto the
  // conversation so the agent operates there (tools run with that cwd, the
  // project's AGENTS.md is injected, etc.) without the user restating it.
  server.registerTool(
    HERMES_SESSION_CWD_SET_TOOL_NAME,
    {
      title: "Set the conversation's working directory",
      description:
        "Pins a working directory (project root) onto the conversation. The agent's terminal, file, and search tools will operate in that directory for the rest of the conversation, so you don't need to tell it which project to work in each time.",
      inputSchema: {
        agentId: z.string().min(1),
        chatId: z.string().min(1),
        cwd: z.string().min(1),
      },
    },
    async ({ agentId, chatId, cwd }): Promise<CallToolResult> => {
      const missing = requireAgent(agentId);
      if (missing) return missing;
      const sid =
        live.get(agentId, chatId) ?? (await attach(agentId, chatId)).sid;
      const response = await gateway.request<{
        cwd?: string;
        branch?: string;
        project?: string;
      }>("session.cwd.set", {
        session_id: sid,
        cwd,
      });
      const result: HermesSetCwdResult = {
        agentId,
        chatId,
        cwd: str(response.cwd) ?? cwd,
        ...(str(response.branch) ? { branch: response.branch } : {}),
        ...(str(response.project) ? { project: response.project } : {}),
      };
      return ok(result, "cwd-set");
    },
  );

  // -- skills ------------------------------------------------------------------
  // Scans the profile's skills/ directory directly (no gateway round-trip) and
  // returns every installed skill with name, description, and category. The app
  // renders this as a picker so the user can see what the agent can do and ask
  // targeted questions instead of guessing.
  server.registerTool(
    HERMES_SKILLS_LIST_TOOL_NAME,
    {
      title: "List the agent's installed skills",
      description:
        "Lists every skill installed for a Hermes profile — name, description, and category — " +
        "scanned directly from the profile's skills/ directory. Lets the user see what the agent " +
        "can do and ask targeted questions instead of guessing.",
      inputSchema: {
        agentId: z.string().min(1),
      },
    },
    async ({ agentId }): Promise<CallToolResult> => {
      const missing = requireAgent(agentId);
      if (missing) return missing;
      // Resolve the profile home: default → hermesHome, named → profiles/<id>.
      const home =
        agentId === "default"
          ? config.hermesHome
          : join(config.hermesHome, "profiles", agentId);
      const skills = listProfileSkills(home);
      const result: HermesSkillsResult = { agentId, skills };
      return ok(result, `skills ${skills.length}`);
    },
  );

  // -- voice transcription (local whisper.cpp — no cloud service) ------------
  // Identical protocol to the Paperclip bridge: a recording is uploaded as many
  // small `chunk` calls (each already small enough to avoid the CEP-22 sender
  // throwing on plaintexts past NIP-44's 65535-byte ceiling), then finalized by
  // uploadId. Schema bounds are generous outer guards — the upload buffer and
  // Whisper service enforce the real, tighter limits.
  const MAX_CHUNK_BASE64_CHARS = 28_000;
  const MAX_CHUNKS_SCHEMA_BOUND = 2_000;

  server.registerTool(
    HERMES_TRANSCRIPTION_CAPABILITIES_TOOL_NAME,
    {
      title: "Voice transcription capabilities",
      description:
        "Whether this bridge can transcribe voice recordings locally right now, and the recording limits to respect.",
      inputSchema: {},
    },
    async () =>
      ok(await transcription.capabilities(), "transcription-capabilities"),
  );

  server.registerTool(
    HERMES_TRANSCRIPTION_CHUNK_TOOL_NAME,
    {
      title: "Upload a voice recording chunk",
      description:
        "Uploads one small base64 slice of a voice recording (index 0..totalChunks-1, all under the same " +
        "uploadId). Send every chunk, then call hermes.transcription.transcribe with the same uploadId " +
        "to finalize, or hermes.transcription.cancel to discard it.",
      inputSchema: {
        uploadId: z.string().min(1).max(128),
        index: z.number().int().nonnegative(),
        totalChunks: z.number().int().positive().max(MAX_CHUNKS_SCHEMA_BOUND),
        contentBase64: z.string().min(1).max(MAX_CHUNK_BASE64_CHARS),
      },
    },
    async ({ uploadId, index, totalChunks, contentBase64 }, extra) => {
      const clientKey = requireClientKey(extra);
      if (!clientKey) return missingClientKeyResult();
      const result = uploadBuffer.addChunk(clientKey, {
        uploadId,
        index,
        totalChunks,
        contentBase64,
      });
      if (result.status === "error") {
        return {
          content: [{ type: "text", text: result.message }],
          structuredContent: result as unknown as Record<string, unknown>,
          isError: true,
        };
      }
      return ok(result, "chunk-received");
    },
  );

  server.registerTool(
    HERMES_TRANSCRIBE_AUDIO_TOOL_NAME,
    {
      title: "Finalize and transcribe a voice recording",
      description:
        "Finalizes a fully chunk-uploaded recording (by uploadId) and transcribes it locally with whisper.cpp — " +
        "no cloud speech-to-text service is used. No audio travels in this call itself; it only references chunks " +
        "already uploaded via hermes.transcription.chunk over this same ContextVM/Nostr connection.",
      inputSchema: {
        uploadId: z.string().min(1).max(128),
        mimeType: z.string().min(1).max(100),
        durationMs: z.number().nonnegative().max(120_000).optional(),
        // Whisper always transcribes (never translates); this only pins the
        // spoken language when auto-detection gets a short clip wrong.
        language: z
          .enum(["auto", "en", "de", "fr", "ar", "es", "it"])
          .optional(),
      },
    },
    async ({ uploadId, mimeType, durationMs, language }, extra) => {
      const clientKey = requireClientKey(extra);
      if (!clientKey) return missingClientKeyResult();
      const assembled = uploadBuffer.consumeForFinalize(clientKey, uploadId);
      if (assembled.status === "error") {
        return {
          content: [{ type: "text", text: assembled.message }],
          structuredContent: assembled as unknown as Record<string, unknown>,
          isError: true,
        };
      }
      const result = await transcription.transcribe(
        {
          contentBase64: assembled.contentBase64,
          mimeType,
          durationMs,
          language,
        },
        { signal: extra.signal },
      );
      if (result.status === "error") {
        return {
          content: [{ type: "text", text: result.message }],
          structuredContent: result as unknown as Record<string, unknown>,
          isError: true,
        };
      }
      return ok(result, "transcribed");
    },
  );

  // Preferred voice path: the client uploads the recording through the
  // resumable, sha256-verified contexcgi.fileTransfer.upload.* tools (every
  // chunk retried on transient transport loss), then references it by id.
  // The legacy hermes.transcription.chunk + transcribe pair above stays for
  // older clients; new clients fall back to it automatically when this tool
  // is absent.
  server.registerTool(
    HERMES_TRANSCRIBE_FILE_TOOL_NAME,
    {
      title: "Transcribe an uploaded voice file",
      description:
        "Transcribes a voice recording previously uploaded through the resumable contexcgi.fileTransfer.upload.* tools " +
        "(sha256-verified) with local whisper.cpp — no cloud speech-to-text. Preferred over the legacy " +
        "hermes.transcription.chunk + hermes.transcription.transcribe pair: the transfer path is resumable and retries " +
        "safely per chunk. The temporary file is deleted once the outcome is terminal.",
      inputSchema: {
        id: z.string().min(1).max(512),
        mimeType: z.string().min(1).max(100),
        durationMs: z.number().nonnegative().max(120_000).optional(),
        language: z
          .enum(["auto", "en", "de", "fr", "ar", "es", "it"])
          .optional(),
      },
    },
    async ({ id, mimeType, durationMs, language }, extra) => {
      const clientKey = requireClientKey(extra);
      if (!clientKey) return missingClientKeyResult();
      if (!config.fileTransferRegistry) {
        return fail(
          "Voice transcription via file transfer is not enabled on this bridge.",
        );
      }
      const result = await transcribeVoiceFile(
        config.fileTransferRegistry,
        transcription,
        { id, mimeType, durationMs, language, clientKey },
        { signal: extra.signal },
      );
      if (result.status === "error") {
        return {
          content: [{ type: "text", text: result.message }],
          structuredContent: result as unknown as Record<string, unknown>,
          isError: true,
        };
      }
      return ok(result, "transcribed");
    },
  );

  server.registerTool(
    HERMES_TRANSCRIPTION_CANCEL_TOOL_NAME,
    {
      title: "Cancel a voice recording upload",
      description:
        "Discards any buffered chunks for an uploadId. Always succeeds, even if the upload is unknown, expired, " +
        "or already finalized — cancel is a best-effort cleanup hint, not a request that can fail.",
      inputSchema: { uploadId: z.string().min(1).max(128) },
    },
    async ({ uploadId }, extra) => {
      const clientKey = requireClientKey(extra);
      if (clientKey) uploadBuffer.cancel(clientKey, uploadId);
      return ok({ status: "ok" }, "cancelled");
    },
  );

  // -- app-wide activity (CEP-41 open-ended stream) ---------------------------
  server.registerTool(
    HERMES_EVENTS_STREAM_TOOL_NAME,
    {
      title: "Stream turn activity across all conversations",
      description:
        "Opens a long-lived JSONL stream of turn activity for every agent/conversation served by this bridge: " +
        "an activity.snapshot of currently-running turns, then turn.started / turn.completed (with a reply " +
        "preview) as they happen. Lets an app show live working indicators and notify on replies it didn't " +
        "stream itself.",
      inputSchema: {},
    },
    async (_args, extra): Promise<CallToolResult> => {
      const stream = getCep41Stream(extra._meta);
      if (!stream) {
        return fail(
          "hermes.events.stream requires ContextVM CEP-41 stream support",
        );
      }
      const write = (event: HermesActivityEvent) =>
        stream.write(encodeHermesActivityEvent(event));

      let emitted = 0;
      await write(tracker.snapshot());
      await new Promise<void>((resolve) => {
        let done = false;
        let lastWrite = Date.now();
        const finish = () => {
          if (done) return;
          done = true;
          unsubscribe();
          clearInterval(keepalive);
          clearTimeout(maxLifetime);
          extra.signal?.removeEventListener("abort", finish);
          resolve();
        };
        const unsubscribe = tracker.subscribe((event) => {
          lastWrite = Date.now();
          emitted += 1;
          void write(event).catch(() => finish());
        });
        const keepalive = setInterval(() => {
          if (Date.now() - lastWrite >= keepaliveMs) {
            lastWrite = Date.now();
            void write({ type: "keepalive", ts: Date.now() }).catch(() =>
              finish(),
            );
          }
        }, keepaliveMs);
        // Safety net: reap this subscription even if the client vanished
        // without triggering the abort signal (see maxStreamLifetimeMs above).
        const maxLifetime = setTimeout(finish, maxStreamLifetimeMs);
        if (extra.signal) {
          if (extra.signal.aborted) return finish();
          extra.signal.addEventListener("abort", finish, { once: true });
        }
      });
      await stream.close();
      return ok({ events: emitted, closed: true }, "events-stream-closed");
    },
  );
}

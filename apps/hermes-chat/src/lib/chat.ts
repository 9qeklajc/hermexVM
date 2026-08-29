import {
  isHermesAutoContinueNote,
  type HermesChatEvent,
  type HermesChatMessage,
} from "./api";

/** One rendered row in the conversation. */
export type ChatItem =
  | {
      kind: "user";
      id: string;
      text: string;
      ordinal?: number;
      digest?: string;
    }
  /** The agent's reasoning, streamed verbatim into a collapsible block. */
  | { kind: "thinking"; id: string; text: string; streaming: boolean }
  | {
      kind: "assistant";
      id: string;
      text: string;
      streaming: boolean;
      failed?: string;
      ordinal?: number;
      digest?: string;
    }
  | {
      kind: "tool";
      id: string;
      toolId: string;
      name?: string;
      /** The executed command / tool arguments, verbatim. */
      argsText?: string;
      /** Live output preview while the tool is still running. */
      preview?: string;
      /** Full result text once done. */
      summary?: string;
      error?: string;
      done: boolean;
    }
  | {
      kind: "approval";
      id: string;
      command: string;
      description?: string;
      choices: string[];
      resolved?: string;
    }
  | {
      kind: "clarify";
      id: string;
      question: string;
      requestId: string;
      choices: string[];
      resolved?: string;
    }
  | { kind: "error"; id: string; text: string };

export type ChatViewState = {
  items: ChatItem[];
  /** Transient one-line activity ("thinking…", tool status) under the last bubble. */
  activity: string | null;
  /** True while a turn is running (send disabled, stop enabled). */
  running: boolean;
};

let seq = 0;
const nextId = () => `i${++seq}`;

export const emptyChat = (): ChatViewState => ({
  items: [],
  activity: null,
  running: false,
});

type ChatScrollMetrics = Pick<
  HTMLElement,
  "scrollTop" | "scrollHeight" | "clientHeight"
>;

export function isNearChatBottom(
  metrics: ChatScrollMetrics,
  threshold = 80,
): boolean {
  return (
    metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop <= threshold
  );
}

export function shouldFollowChatBottom(
  wasFollowing: boolean,
  previousScrollTop: number,
  metrics: ChatScrollMetrics,
): boolean {
  if (metrics.scrollTop < previousScrollTop) return false;
  return wasFollowing || isNearChatBottom(metrics);
}

export function fromHistory(messages: HermesChatMessage[]): ChatViewState {
  const items: ChatItem[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      if (isHermesAutoContinueNote(message.text)) continue;
      items.push({
        kind: "user",
        id: nextId(),
        text: message.text,
        ordinal: message.ordinal,
        digest: message.digest,
      });
    } else if (message.role === "assistant") {
      items.push({
        kind: "assistant",
        id: nextId(),
        text: message.text,
        streaming: false,
        ordinal: message.ordinal,
        digest: message.digest,
      });
    } else if (message.role === "tool") {
      items.push({
        kind: "tool",
        id: nextId(),
        toolId: nextId(),
        name: message.name,
        summary:
          message.text.length > 4000
            ? `${message.text.slice(0, 4000)}…`
            : message.text,
        done: true,
      });
    }
    // system rows are prompt plumbing — not rendered in a chat UI
  }
  return { items, activity: null, running: false };
}

/**
 * Seed a freshly-loaded transcript with the turn that is running RIGHT NOW
 * (reopened chat / turn started elsewhere): the in-flight user message plus a
 * streaming bubble holding whatever the agent already generated. The watch
 * stream then keeps appending to that same bubble.
 */
export function withInflightTurn(
  state: ChatViewState,
  inflight: { user?: string; assistant?: string } | undefined,
): ChatViewState {
  const items = [...state.items];
  const lastUser = [...items].reverse().find((item) => item.kind === "user");
  if (
    inflight?.user &&
    !isHermesAutoContinueNote(inflight.user) &&
    lastUser?.text !== inflight.user
  ) {
    items.push({ kind: "user", id: nextId(), text: inflight.user });
  }
  if (inflight?.assistant) {
    items.push({
      kind: "assistant",
      id: nextId(),
      text: inflight.assistant,
      streaming: true,
    });
  }
  return {
    items,
    activity: inflight?.assistant ? null : "working…",
    running: true,
  };
}

export function withUserMessage(
  state: ChatViewState,
  text: string,
): ChatViewState {
  return {
    items: [...state.items, { kind: "user", id: nextId(), text }],
    activity: "sending…",
    running: true,
  };
}

/** Index of the in-progress assistant bubble, wherever it sits (tool rows may
 * have been appended after it mid-turn). */
function streamingIndex(items: ChatItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind === "assistant" && item.streaming) return i;
  }
  return -1;
}

/** Close the open thinking block (any non-thinking content ends the run).
 * Always returns a fresh array so callers can mutate it safely. */
function finalizeThinking(items: ChatItem[]): ChatItem[] {
  const last = items[items.length - 1];
  if (last?.kind === "thinking" && last.streaming) {
    return [...items.slice(0, -1), { ...last, streaming: false }];
  }
  return [...items];
}

/** Pure reducer: fold one stream frame into the rendered conversation. */
export function applyEvent(
  state: ChatViewState,
  event: HermesChatEvent,
): ChatViewState {
  const items = [...state.items];

  switch (event.type) {
    case "chat.started":
      return { ...state, activity: "connected — waiting for the agent…" };

    case "thinking.delta": {
      const text = event.text ?? "";
      const last = items[items.length - 1];
      if (last?.kind === "thinking" && last.streaming) {
        items[items.length - 1] = { ...last, text: last.text + text };
      } else if (text.trim()) {
        items.push({ kind: "thinking", id: nextId(), text, streaming: true });
      }
      return { items, activity: "thinking…", running: true };
    }

    case "status": {
      return { ...state, activity: event.text };
    }

    case "message.delta": {
      const settled = finalizeThinking(items);
      const at = streamingIndex(settled);
      if (at >= 0) {
        const bubble = settled[at] as ChatItem & { kind: "assistant" };
        settled[at] = { ...bubble, text: bubble.text + event.text };
      } else {
        settled.push({
          kind: "assistant",
          id: nextId(),
          text: event.text,
          streaming: true,
        });
      }
      return { items: settled, activity: null, running: true };
    }

    case "message.interim": {
      // A mid-turn assistant message (e.g. before tool use) — finalize it.
      const at = streamingIndex(items);
      if (at >= 0) {
        const bubble = items[at] as ChatItem & { kind: "assistant" };
        items[at] = {
          ...bubble,
          text: event.text || bubble.text,
          streaming: false,
        };
      } else {
        items.push({
          kind: "assistant",
          id: nextId(),
          text: event.text,
          streaming: false,
        });
      }
      return { items, activity: state.activity, running: true };
    }

    case "tool.start": {
      const settled = finalizeThinking(items);
      settled.push({
        kind: "tool",
        id: nextId(),
        toolId: event.toolId,
        name: event.name,
        argsText: event.argsText,
        done: false,
      });
      return { items: settled, activity: null, running: true };
    }

    case "tool.progress": {
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        if (item?.kind === "tool" && !item.done) {
          items[i] = { ...item, preview: event.preview ?? item.preview };
          return {
            items,
            activity: event.name ? `${event.name}…` : state.activity,
            running: true,
          };
        }
      }
      return { ...state, running: true };
    }

    case "tool.complete": {
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        if (
          item?.kind === "tool" &&
          item.toolId === event.toolId &&
          !item.done
        ) {
          items[i] = {
            ...item,
            name: item.name ?? event.name,
            summary: event.summary,
            error: event.error,
            done: true,
          };
          return { items, activity: state.activity, running: true };
        }
      }
      // completion for a tool we never saw start — render it standalone
      items.push({
        kind: "tool",
        id: nextId(),
        toolId: event.toolId,
        name: event.name,
        summary: event.summary,
        error: event.error,
        done: true,
      });
      return { items, activity: state.activity, running: true };
    }

    case "approval.request":
      items.push({
        kind: "approval",
        id: nextId(),
        command: event.command,
        description: event.description,
        choices: event.choices ?? ["once", "session", "deny"],
      });
      return { items, activity: "waiting for your approval", running: true };

    case "clarify.request":
      items.push({
        kind: "clarify",
        id: nextId(),
        question: event.question,
        requestId: event.requestId,
        choices: event.choices ?? [],
      });
      return { items, activity: "waiting for your answer", running: true };

    case "message.complete": {
      const settled = finalizeThinking(items);
      const at = streamingIndex(settled);
      if (at >= 0) {
        const bubble = settled[at] as ChatItem & { kind: "assistant" };
        settled[at] = {
          ...bubble,
          // The terminal frame carries the authoritative full text.
          text: event.text || bubble.text,
          streaming: false,
          ...(event.failureReason ? { failed: event.failureReason } : {}),
        };
      } else if (event.text) {
        settled.push({
          kind: "assistant",
          id: nextId(),
          text: event.text,
          streaming: false,
          ...(event.failureReason ? { failed: event.failureReason } : {}),
        });
      }
      return { items: settled, activity: null, running: false };
    }

    case "error":
      items.push({ kind: "error", id: nextId(), text: event.message });
      return { items, activity: null, running: false };

    case "keepalive":
      return state;
  }
}

export function markApprovalResolved(
  state: ChatViewState,
  id: string,
  choice: string,
): ChatViewState {
  return {
    ...state,
    items: state.items.map((item) =>
      item.kind === "approval" && item.id === id
        ? { ...item, resolved: choice }
        : item,
    ),
    activity: null,
  };
}

export function markClarifyResolved(
  state: ChatViewState,
  id: string,
  answer: string,
): ChatViewState {
  return {
    ...state,
    items: state.items.map((item) =>
      item.kind === "clarify" && item.id === id
        ? { ...item, resolved: answer }
        : item,
    ),
    activity: null,
  };
}

// -- small formatting helpers -------------------------------------------------

export type ReplyTarget = { author: string; text: string };

/** Encode Telegram-style reply context into the next user prompt. */
export function formatReplyMessage(
  target: ReplyTarget,
  message: string,
): string {
  const quote = target.text
    .trim()
    .slice(0, 4000)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `Replying to ${target.author}:\n${quote}\n\n${message.trim()}`;
}

export function parseReplyMessage(text: string): {
  author: string;
  quote: string;
  message: string;
} | null {
  const lines = text.split("\n");
  const header = lines[0]?.match(/^Replying to (.+):$/);
  if (!header?.[1]) return null;
  const separator = lines.findIndex((line, index) => index > 0 && line === "");
  if (separator < 2) return null;
  const quoted = lines.slice(1, separator);
  if (quoted.some((line) => !line.startsWith("> "))) return null;
  return {
    author: header[1],
    quote: quoted.map((line) => line.slice(2)).join("\n"),
    message: lines.slice(separator + 1).join("\n"),
  };
}

export function formatChatTime(epochSeconds: number): string {
  if (!epochSeconds) return "";
  const date = new Date(epochSeconds * 1000);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  const days = (now.getTime() - date.getTime()) / 86_400_000;
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: "short" });
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Same display-name rule as the bridge: root profile → "Hermes". */
export function displayAgentName(agentId: string): string {
  if (agentId === "default") return "Hermes";
  return agentId.charAt(0).toUpperCase() + agentId.slice(1);
}

/** "telegram" → "via Telegram" badge text; our own chats get none. */
export function sourceBadge(source: string): string | null {
  const normalized = source.trim().toLowerCase();
  if (!normalized || normalized === "contextvm" || normalized === "gateway")
    return null;
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

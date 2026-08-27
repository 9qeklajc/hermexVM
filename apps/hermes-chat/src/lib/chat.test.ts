import { describe, expect, it } from "vitest";
import {
  applyEvent,
  emptyChat,
  formatChatTime,
  formatReplyMessage,
  fromHistory,
  isNearChatBottom,
  markApprovalResolved,
  markClarifyResolved,
  parseReplyMessage,
  shouldFollowChatBottom,
  sourceBadge,
  withInflightTurn,
  withUserMessage,
  type ChatViewState,
} from "./chat";
import type { HermesChatEvent } from "./api";

function run(events: HermesChatEvent[], start?: ChatViewState): ChatViewState {
  return events.reduce(applyEvent, start ?? withUserMessage(emptyChat(), "hi"));
}

describe("chat scrolling", () => {
  it("follows streaming updates only while the viewport remains near the bottom", () => {
    expect(
      isNearChatBottom({
        scrollTop: 900,
        scrollHeight: 1200,
        clientHeight: 250,
      }),
    ).toBe(true);
    expect(
      isNearChatBottom({
        scrollTop: 500,
        scrollHeight: 1200,
        clientHeight: 250,
      }),
    ).toBe(false);
  });

  it("stops following on any deliberate upward scroll, even near the bottom", () => {
    expect(
      shouldFollowChatBottom(true, 900, {
        scrollTop: 899,
        scrollHeight: 1200,
        clientHeight: 250,
      }),
    ).toBe(false);
    expect(
      shouldFollowChatBottom(false, 500, {
        scrollTop: 700,
        scrollHeight: 1200,
        clientHeight: 250,
      }),
    ).toBe(false);
    expect(
      shouldFollowChatBottom(false, 700, {
        scrollTop: 950,
        scrollHeight: 1200,
        clientHeight: 250,
      }),
    ).toBe(true);
  });
});

describe("chat stream reducer", () => {
  it("accumulates deltas into one streaming bubble and finalizes on complete", () => {
    const state = run([
      { type: "chat.started", agentId: "coder", chatId: "c1", created: true },
      { type: "message.delta", text: "Hel" },
      { type: "message.delta", text: "lo!" },
      { type: "message.complete", text: "Hello!" },
    ]);
    const bubble = state.items[state.items.length - 1];
    expect(bubble).toMatchObject({
      kind: "assistant",
      text: "Hello!",
      streaming: false,
    });
    expect(state.running).toBe(false);
    expect(state.activity).toBeNull();
  });

  it("keeps the user bubble first and shows activity while thinking", () => {
    const state = run([{ type: "thinking.delta" }]);
    expect(state.items[0]).toMatchObject({ kind: "user", text: "hi" });
    expect(state.activity).toBe("thinking…");
    expect(state.running).toBe(true);
  });

  it("pairs tool.start with tool.complete by toolId", () => {
    const state = run([
      { type: "tool.start", toolId: "t1", name: "terminal", argsText: "ls" },
      { type: "message.delta", text: "Working…" },
      { type: "tool.complete", toolId: "t1", summary: "3 files" },
      { type: "message.complete", text: "Done" },
    ]);
    const tool = state.items.find((item) => item.kind === "tool");
    expect(tool).toMatchObject({
      name: "terminal",
      summary: "3 files",
      done: true,
    });
  });

  it("carries turn failures onto the bubble", () => {
    const state = run([
      { type: "message.delta", text: "partial" },
      {
        type: "message.complete",
        text: "partial",
        failureReason: "provider exploded",
      },
    ]);
    const bubble = state.items[state.items.length - 1];
    expect(bubble).toMatchObject({
      kind: "assistant",
      failed: "provider exploded",
    });
    expect(state.running).toBe(false);
  });

  it("renders approval requests and resolves them in place", () => {
    let state = run([
      {
        type: "approval.request",
        command: "rm -rf build",
        choices: ["once", "deny"],
      },
    ]);
    const approval = state.items.find((item) => item.kind === "approval");
    expect(approval).toMatchObject({
      command: "rm -rf build",
      choices: ["once", "deny"],
    });
    state = markApprovalResolved(state, approval!.id, "once");
    expect(state.items.find((item) => item.kind === "approval")).toMatchObject({
      resolved: "once",
    });
  });

  it("renders clarify requests with choices and resolves them in place", () => {
    let state = run([
      {
        type: "clarify.request",
        question: "open-source + make-money or closed-source product?",
        choices: ["open-source", "closed-source"],
        requestId: "req-1",
      },
    ]);
    const clarify = state.items.find((item) => item.kind === "clarify");
    expect(clarify).toMatchObject({
      question: "open-source + make-money or closed-source product?",
      choices: ["open-source", "closed-source"],
      requestId: "req-1",
    });
    expect(state.running).toBe(true);
    state = markClarifyResolved(state, clarify!.id, "open-source");
    expect(state.items.find((item) => item.kind === "clarify")).toMatchObject({
      resolved: "open-source",
    });
    // The turn stays running — the agent continues after the answer.
    expect(state.running).toBe(true);
    expect(state.activity).toBeNull();
  });

  it("renders clarify requests without choices (free-text)", () => {
    let state = run([
      {
        type: "clarify.request",
        question: "What should we name the release?",
        requestId: "req-2",
      },
    ]);
    const clarify = state.items.find((item) => item.kind === "clarify");
    expect(clarify).toMatchObject({
      question: "What should we name the release?",
      choices: [],
      requestId: "req-2",
    });
    state = markClarifyResolved(state, clarify!.id, "v0.1.0");
    expect(state.items.find((item) => item.kind === "clarify")).toMatchObject({
      resolved: "v0.1.0",
    });
  });

  it("maps history rows, dropping system plumbing", () => {
    const state = fromHistory([
      { role: "system", text: "internal" },
      { role: "user", text: "q" },
      { role: "assistant", text: "a" },
      { role: "tool", text: "output", name: "terminal" },
    ]);
    expect(state.items.map((item) => item.kind)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
  });

  it("ignores keepalives", () => {
    const before = withUserMessage(emptyChat(), "hi");
    expect(applyEvent(before, { type: "keepalive", ts: 1 })).toBe(before);
  });
});

describe("formatting helpers", () => {
  it("formats a selected message as agent-visible reply context", () => {
    expect(
      formatReplyMessage(
        { author: "Hermes", text: "First line\nSecond line" },
        "Please expand this.",
      ),
    ).toBe(
      "Replying to Hermes:\n> First line\n> Second line\n\nPlease expand this.",
    );
    expect(
      parseReplyMessage(
        "Replying to Hermes:\n> First line\n> Second line\n\nPlease expand this.",
      ),
    ).toEqual({
      author: "Hermes",
      quote: "First line\nSecond line",
      message: "Please expand this.",
    });
  });

  it("leaves ordinary messages untouched", () => {
    expect(parseReplyMessage("ordinary message")).toBeNull();
  });

  it("formats times and hides badges for native chats", () => {
    expect(formatChatTime(0)).toBe("");
    expect(sourceBadge("contextvm")).toBeNull();
    expect(sourceBadge("telegram")).toBe("Telegram");
  });
});

describe("mid-turn tool interleaving", () => {
  it("keeps one bubble accumulating across tool rows", () => {
    const state = run([
      { type: "message.delta", text: "Hello " },
      { type: "tool.start", toolId: "t1", name: "terminal" },
      { type: "tool.complete", toolId: "t1", summary: "hi" },
      { type: "message.delta", text: "world" },
      { type: "message.complete", text: "Hello world" },
    ]);
    const bubbles = state.items.filter((item) => item.kind === "assistant");
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]).toMatchObject({ text: "Hello world", streaming: false });
  });
});

describe("withInflightTurn", () => {
  it("seeds the running turn's user message and partial reply", () => {
    const base = fromHistory([
      { role: "user", text: "old q" },
      { role: "assistant", text: "old a" },
    ]);
    const state = withInflightTurn(base, { user: "new q", assistant: "par" });
    expect(state.running).toBe(true);
    const kinds = state.items.map((item) => item.kind);
    expect(kinds).toEqual(["user", "assistant", "user", "assistant"]);
    const bubble = state.items[state.items.length - 1];
    expect(bubble).toMatchObject({ text: "par", streaming: true });
    // Watch deltas continue the same bubble…
    const next = applyEvent(state, { type: "message.delta", text: "tial" });
    expect(next.items[next.items.length - 1]).toMatchObject({
      text: "partial",
    });
    // …and the terminal frame replaces it with the authoritative full text.
    const done = applyEvent(next, {
      type: "message.complete",
      text: "partial reply",
    });
    expect(done.items[done.items.length - 1]).toMatchObject({
      text: "partial reply",
      streaming: false,
    });
    expect(done.running).toBe(false);
  });

  it("does not duplicate the user message when history already holds it", () => {
    const base = fromHistory([{ role: "user", text: "same q" }]);
    const state = withInflightTurn(base, { user: "same q" });
    expect(state.items.filter((item) => item.kind === "user")).toHaveLength(1);
    expect(state.activity).toBe("working…");
  });
});

describe("thinking + tool detail", () => {
  it("accumulates reasoning into one collapsible block, then finalizes it", () => {
    const state = run([
      { type: "thinking.delta", text: "Let me " },
      { type: "thinking.delta", text: "check the files." },
      { type: "message.delta", text: "Done." },
      { type: "message.complete", text: "Done." },
    ]);
    const thinking = state.items.filter((item) => item.kind === "thinking");
    expect(thinking).toHaveLength(1);
    expect(thinking[0]).toMatchObject({
      text: "Let me check the files.",
      streaming: false,
    });
  });

  it("carries the executed command and live output on the tool card", () => {
    const state = run([
      {
        type: "tool.start",
        toolId: "t1",
        name: "terminal",
        argsText: "ls -la /tmp",
      },
      { type: "tool.progress", name: "terminal", preview: "file1\nfile2" },
      { type: "tool.complete", toolId: "t1", summary: "file1\nfile2\nfile3" },
      { type: "message.complete", text: "done" },
    ]);
    const tool = state.items.find((item) => item.kind === "tool");
    expect(tool).toMatchObject({
      name: "terminal",
      argsText: "ls -la /tmp",
      summary: "file1\nfile2\nfile3",
      done: true,
    });
  });

  it("shows live progress on the still-running tool", () => {
    const state = run([
      { type: "tool.start", toolId: "t1", name: "build", argsText: "make" },
      { type: "tool.progress", name: "build", preview: "compiling…" },
    ]);
    const tool = state.items.find((item) => item.kind === "tool");
    expect(tool).toMatchObject({ preview: "compiling…", done: false });
  });
});

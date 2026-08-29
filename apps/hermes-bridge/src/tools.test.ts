import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HermesChatEventDecoder, utf8ByteLength } from "@contexcgi/protocol";
import {
  clipToBytes,
  createHermesEventWriter,
  fitHistory,
  gatewaySessionCreateParams,
  mapGatewayEvent,
  paginateSkills,
} from "./tools.js";
import { listHermesAgents, profileParam } from "./profiles.js";

describe("createHermesEventWriter", () => {
  it("serializes concurrent writes and bounds a long terminal response", async () => {
    const frames: string[] = [];
    const write = createHermesEventWriter({
      isActive: () => true,
      write: async (frame) => {
        await Promise.resolve();
        frames.push(frame);
      },
      close: async () => undefined,
    });
    const longText = "assistant 🙂 response\n".repeat(8_000);

    await Promise.all([
      write({ type: "message.complete", text: longText }),
      write({ type: "status", text: "after-terminal" }),
    ]);

    expect(frames.length).toBeGreaterThan(2);
    expect(frames.every((frame) => utf8ByteLength(frame) <= 24_000)).toBe(true);
    const decoder = new HermesChatEventDecoder();
    expect(frames.flatMap((frame) => decoder.push(frame))).toEqual([
      { type: "message.complete", text: longText },
      { type: "status", text: "after-terminal" },
    ]);
  });
});

describe("gatewaySessionCreateParams", () => {
  it("passes a selected project cwd into session creation before the first turn", () => {
    expect(gatewaySessionCreateParams("coder", "/work/project")).toEqual({
      profile: "coder",
      cols: 100,
      source: "contextvm",
      cwd: "/work/project",
    });
  });

  it("omits cwd and the default profile when neither was selected", () => {
    expect(gatewaySessionCreateParams("default")).toEqual({
      profile: undefined,
      cols: 100,
      source: "contextvm",
    });
  });
});

describe("paginateSkills", () => {
  it("returns a bounded page and a cursor until the final page", () => {
    const skills = Array.from({ length: 5 }, (_, index) => ({
      name: `skill-${index}`,
      description: "description",
      category: "test",
      path: `skill-${index}/SKILL.md`,
    }));

    expect(paginateSkills(skills, 1, 2)).toEqual({
      skills: skills.slice(1, 3),
      nextOffset: 3,
      totalSkills: 5,
    });
    expect(paginateSkills(skills, 3, 2)).toEqual({
      skills: skills.slice(3),
      totalSkills: 5,
    });
  });
});

describe("mapGatewayEvent", () => {
  it("maps streaming deltas and terminal completion", () => {
    expect(
      mapGatewayEvent({
        type: "message.delta",
        session_id: "s",
        payload: { text: "hi" },
      }),
    ).toEqual({ type: "message.delta", text: "hi" });
    expect(
      mapGatewayEvent({
        type: "message.complete",
        session_id: "s",
        payload: { text: "done", usage: { calls: 1 } },
      }),
    ).toEqual({ type: "message.complete", text: "done" });
  });

  it("carries turn failures on the terminal frame", () => {
    expect(
      mapGatewayEvent({
        type: "message.complete",
        session_id: "s",
        payload: { text: "Error: boom", status: "error", error: "boom" },
      }),
    ).toEqual({
      type: "message.complete",
      text: "Error: boom",
      failureReason: "boom",
    });
  });

  it("maps tool frames with ids, names, and truncated output", () => {
    expect(
      mapGatewayEvent({
        type: "tool.start",
        session_id: "s",
        payload: { tool_id: "t9", name: "terminal", args_text: "ls -la" },
      }),
    ).toEqual({
      type: "tool.start",
      toolId: "t9",
      name: "terminal",
      argsText: "ls -la",
    });
    const complete = mapGatewayEvent({
      type: "tool.complete",
      session_id: "s",
      payload: {
        tool_id: "t9",
        name: "terminal",
        // Full result text is forwarded (the app shows it), capped at ~8KB so
        // each encrypted CEP-41 frame stays under NIP-44's 64KB ceiling.
        result_text: "x".repeat(20000),
        duration_s: 1.5,
      },
    });
    expect(complete).toMatchObject({
      type: "tool.complete",
      toolId: "t9",
      durationSeconds: 1.5,
    });
    if (complete?.type === "tool.complete") {
      expect(complete.summary?.length).toBeLessThanOrEqual(8001);
      expect(complete.summary?.length).toBeGreaterThan(4000);
    }
  });

  it("forwards live tool progress previews", () => {
    expect(
      mapGatewayEvent({
        type: "tool.progress",
        session_id: "s",
        payload: { name: "terminal", preview: "compiling…" },
      }),
    ).toEqual({
      type: "tool.progress",
      name: "terminal",
      preview: "compiling…",
    });
  });

  it("maps approval requests with their choices", () => {
    expect(
      mapGatewayEvent({
        type: "approval.request",
        session_id: "s",
        payload: { command: "rm -rf build", choices: ["once", "deny"] },
      }),
    ).toEqual({
      type: "approval.request",
      command: "rm -rf build",
      description: undefined,
      choices: ["once", "deny"],
    });
  });

  it("maps clarify requests with question, choices, and request_id", () => {
    expect(
      mapGatewayEvent({
        type: "clarify.request",
        session_id: "s",
        payload: {
          question: "open or closed source?",
          choices: ["open", "closed"],
          request_id: "req-1",
        },
      }),
    ).toEqual({
      type: "clarify.request",
      question: "open or closed source?",
      choices: ["open", "closed"],
      requestId: "req-1",
    });
  });

  it("maps clarify requests without choices", () => {
    expect(
      mapGatewayEvent({
        type: "clarify.request",
        session_id: "s",
        payload: { question: "name?", request_id: "req-2" },
      }),
    ).toEqual({
      type: "clarify.request",
      question: "name?",
      choices: undefined,
      requestId: "req-2",
    });
  });

  it("drops clarify requests missing question or request_id", () => {
    expect(
      mapGatewayEvent({
        type: "clarify.request",
        session_id: "s",
        payload: { request_id: "req-3" },
      }),
    ).toBeNull();
    expect(
      mapGatewayEvent({
        type: "clarify.request",
        session_id: "s",
        payload: { question: "hi" },
      }),
    ).toBeNull();
  });

  it("ignores frames a chat client does not render", () => {
    expect(
      mapGatewayEvent({ type: "session.info", session_id: "s", payload: {} }),
    ).toBeNull();
    expect(
      mapGatewayEvent({ type: "pet.info", session_id: "s", payload: {} }),
    ).toBeNull();
  });
});

describe("listHermesAgents", () => {
  let home: string;

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("lists the default profile plus named profiles with metadata", () => {
    home = mkdtempSync(join(tmpdir(), "hermes-home-"));
    writeFileSync(
      join(home, "SOUL.md"),
      "# Soul\n\nYou are Hermes, swift messenger.\n\nMore.\n",
    );
    writeFileSync(join(home, "config.yaml"), "model:\n  default: glm-5.2\n");
    const coder = join(home, "profiles", "coder");
    mkdirSync(coder, { recursive: true });
    writeFileSync(
      join(coder, "config.yaml"),
      "model:\n  default: claude-opus-4-8\n",
    );
    writeFileSync(
      join(coder, "profile.yaml"),
      'description: "Writes the code."\n',
    );
    writeFileSync(join(coder, "SOUL.md"), "You write excellent code.\n");

    const agents = listHermesAgents(home);
    expect(agents.map((agent) => agent.id)).toEqual(["default", "coder"]);
    expect(agents[0]).toMatchObject({
      name: "Hermes",
      isDefault: true,
      model: "glm-5.2",
      soulExcerpt: "Soul",
    });
    expect(agents[1]).toMatchObject({
      name: "Coder",
      isDefault: false,
      model: "claude-opus-4-8",
      description: "Writes the code.",
      soulExcerpt: "You write excellent code.",
    });
  });

  it("survives a home with no profiles directory and no metadata", () => {
    home = mkdtempSync(join(tmpdir(), "hermes-home-"));
    const agents = listHermesAgents(home);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ id: "default", description: "" });
  });
});

describe("profileParam", () => {
  it("omits the default profile and passes named ones through", () => {
    expect(profileParam("default")).toBeUndefined();
    expect(profileParam("coder")).toBe("coder");
  });
});

describe("clipToBytes", () => {
  it("leaves text that already fits untouched", () => {
    expect(clipToBytes("hello", 64)).toEqual({ text: "hello", clipped: false });
  });

  it("never splits a multi-byte codepoint", () => {
    // "é" is 2 bytes, so a 3-byte budget must drop the second one whole.
    const { text, clipped } = clipToBytes("éé", 3);
    expect(clipped).toBe(true);
    expect(text).toBe("é");
    expect(text).not.toContain("�");
  });

  it("clips to the byte budget, not the character count", () => {
    const { text } = clipToBytes("あ".repeat(100), 30);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(30);
  });
});

describe("fitHistory", () => {
  const msg = (text: string, ordinal: number) => ({
    role: "assistant" as const,
    text,
    ordinal,
  });

  it("passes a small transcript through unchanged", () => {
    const messages = [msg("one", 0), msg("two", 1)];
    expect(fitHistory(messages)).toEqual({ messages, omitted: 0 });
  });

  it("clips a single oversized message instead of dropping the reply", () => {
    // The nostr-issue-monitor cron conversation: one ~56 KB assistant message
    // that pushed the whole reply past NIP-44's 65535-byte ceiling, so the
    // transport dropped it and the app timed out on every open.
    const { messages, omitted } = fitHistory([msg("x".repeat(56_000), 0)]);
    expect(messages).toHaveLength(1);
    expect(omitted).toBe(0);
    expect(messages[0]!.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(messages), "utf8")).toBeLessThan(
      65_535,
    );
  });

  it("keeps the newest messages and reports how many were dropped", () => {
    const messages = Array.from({ length: 40 }, (_, i) =>
      msg(`${i}:${"y".repeat(5_000)}`, i),
    );
    const fitted = fitHistory(messages);
    expect(fitted.omitted).toBeGreaterThan(0);
    expect(fitted.messages.length + fitted.omitted).toBe(messages.length);
    // Newest survives, oldest is the one dropped, order stays chronological.
    expect(fitted.messages.at(-1)!.ordinal).toBe(39);
    expect(fitted.messages[0]!.ordinal).toBeGreaterThan(0);
    expect(
      Buffer.byteLength(JSON.stringify(fitted.messages), "utf8"),
    ).toBeLessThan(65_535);
  });

  it("clips an enormous newest message rather than dropping its neighbours", () => {
    // Per-message clipping runs before the budget is charged, so one huge
    // message costs only MESSAGE_TEXT_MAX_BYTES and older context survives.
    const messages = [msg("old", 0), msg("z".repeat(200_000), 1)];
    const fitted = fitHistory(messages);
    expect(fitted.omitted).toBe(0);
    expect(fitted.messages.map((m) => m.ordinal)).toEqual([0, 1]);
    expect(fitted.messages[0]!.text).toBe("old");
    expect(fitted.messages[1]!.truncated).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify(fitted.messages), "utf8"),
    ).toBeLessThan(65_535);
  });
});

import { describe, expect, it } from "vitest";
import {
  encodePiActivityEvent,
  encodePiChatEvent,
  parsePiActivityChunk,
  parsePiChatChunk,
  PI_CHAT_INTERRUPT_TOOL_NAME,
  PI_CHAT_WATCH_TOOL_NAME,
  PI_EVENTS_STREAM_TOOL_NAME,
  PI_HANDOFF_SEND_TOOL_NAME,
  PI_MODELS_LIST_TOOL_NAME,
  PI_REPOSITORIES_LIST_TOOL_NAME,
  PI_TRANSCRIBE_AUDIO_TOOL_NAME,
} from "./index.js";
describe("Pi protocol", () => {
  it("keeps the independent pi tool namespace stable", () => {
    expect([
      PI_CHAT_WATCH_TOOL_NAME,
      PI_CHAT_INTERRUPT_TOOL_NAME,
      PI_EVENTS_STREAM_TOOL_NAME,
      PI_REPOSITORIES_LIST_TOOL_NAME,
      PI_MODELS_LIST_TOOL_NAME,
      PI_TRANSCRIBE_AUDIO_TOOL_NAME,
      PI_HANDOFF_SEND_TOOL_NAME,
    ]).toEqual([
      "pi.chat.watch",
      "pi.chat.interrupt",
      "pi.events.stream",
      "pi.repositories.list",
      "pi.models.list",
      "pi.transcription.transcribe",
      "pi.handoffs.send",
    ]);
  });
  it("round trips chat and activity JSONL", () => {
    expect(
      parsePiChatChunk(
        encodePiChatEvent({ type: "message.delta", text: "hello\u2028world" }),
      ),
    ).toEqual([{ type: "message.delta", text: "hello\u2028world" }]);
    expect(
      parsePiChatChunk(
        encodePiChatEvent({
          type: "subagent.progress",
          subagents: [
            {
              id: "x#scout#0",
              agent: "scout",
              task: "recon",
              status: "running",
              startedAt: 1,
            },
          ],
        }),
      ),
    ).toEqual([
      {
        type: "subagent.progress",
        subagents: [
          {
            id: "x#scout#0",
            agent: "scout",
            task: "recon",
            status: "running",
            startedAt: 1,
          },
        ],
      },
    ]);
    expect(
      parsePiActivityChunk(
        encodePiActivityEvent({
          type: "turn.moved",
          fromChatId: "pending:chat",
          toChatId: "chat",
          at: 4,
        }),
      ),
    ).toEqual([
      {
        type: "turn.moved",
        fromChatId: "pending:chat",
        toChatId: "chat",
        at: 4,
      },
    ]);
    expect(
      parsePiActivityChunk(
        encodePiActivityEvent({
          type: "subagent.started",
          chatId: "chat",
          subagent: {
            id: "chat#scout#0",
            agent: "scout",
            task: "recon",
            status: "running",
            startedAt: 5,
          },
          at: 5,
        }),
      ),
    ).toEqual([
      {
        type: "subagent.started",
        chatId: "chat",
        subagent: {
          id: "chat#scout#0",
          agent: "scout",
          task: "recon",
          status: "running",
          startedAt: 5,
        },
        at: 5,
      },
    ]);
  });
});

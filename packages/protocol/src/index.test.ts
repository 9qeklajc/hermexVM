import { describe, expect, it } from "vitest";
import {
  encodeHermesChatEvent,
  encodeStreamEvent,
  HERMES_AGENTS_LIST_TOOL_NAME,
  HERMES_CHAT_HISTORY_TOOL_NAME,
  HERMES_CHAT_INTERRUPT_TOOL_NAME,
  HERMES_CHAT_SEND_TOOL_NAME,
  HERMES_CHAT_CLARIFY_ANSWER_TOOL_NAME,
  HERMES_CHATS_DELETE_TOOL_NAME,
  HERMES_CHATS_LIST_TOOL_NAME,
  HERMES_HANDOFF_GET_TOOL_NAME,
  HERMES_HANDOFF_PREVIEW_TOOL_NAME,
  HERMES_HANDOFF_SEND_TOOL_NAME,
  HERMES_HANDOFFS_LIST_TOOL_NAME,
  parseHermesChatChunk,
  type HermesTranscribeAudioRequest,
  parseStreamChunk,
  parseQuranVerseRef,
  quranVerseRef,
  QURAN_AUDIO_RECITERS_LIST_TOOL_NAME,
  QURAN_AUDIO_SURAH_GET_TOOL_NAME,
  PAPERCLIP_TRANSCRIBE_AUDIO_TOOL_NAME,
  PAPERCLIP_TRANSCRIPTION_CANCEL_TOOL_NAME,
  PAPERCLIP_TRANSCRIPTION_CAPABILITIES_TOOL_NAME,
  PAPERCLIP_TRANSCRIPTION_CHUNK_TOOL_NAME,
  type PaperclipTranscribeAudioResult,
} from "./index.js";

describe("protocol stream codec", () => {
  it("round-trips JSONL conversation stream events", () => {
    const encoded = encodeStreamEvent({
      type: "assistant.delta",
      discussionId: "discussion-1",
      runId: "run-1",
      agentId: "pi-agent",
      text: "hello",
    });

    expect(parseStreamChunk(encoded)).toEqual([
      {
        type: "assistant.delta",
        discussionId: "discussion-1",
        runId: "run-1",
        agentId: "pi-agent",
        text: "hello",
      },
    ]);
  });
});

describe("voice transcription tool names and result shape", () => {
  it("uses stable, namespaced tool names", () => {
    expect(PAPERCLIP_TRANSCRIPTION_CAPABILITIES_TOOL_NAME).toBe(
      "paperclip.transcription.capabilities",
    );
    expect(PAPERCLIP_TRANSCRIPTION_CHUNK_TOOL_NAME).toBe(
      "paperclip.transcription.chunk",
    );
    expect(PAPERCLIP_TRANSCRIBE_AUDIO_TOOL_NAME).toBe(
      "paperclip.transcription.transcribe",
    );
    expect(PAPERCLIP_TRANSCRIPTION_CANCEL_TOOL_NAME).toBe(
      "paperclip.transcription.cancel",
    );
  });

  it("discriminates success and failure by status", () => {
    const success: PaperclipTranscribeAudioResult = {
      status: "ok",
      transcript: "hello there",
      durationSeconds: 2.5,
    };
    const failure: PaperclipTranscribeAudioResult = {
      status: "error",
      code: "TOO_LONG",
      message: "Recording is longer than the 60s limit.",
      retryable: false,
    };

    expect(success.status).toBe("ok");
    expect(failure.status).toBe("error");
    if (failure.status === "error") {
      expect(failure.retryable).toBe(false);
    }
  });
});

describe("hermes transcription language contract", () => {
  it("keeps Hermes' wider language set independent from Paperclip", () => {
    const request: HermesTranscribeAudioRequest = {
      uploadId: "upload-fr",
      mimeType: "audio/webm",
      language: "fr",
    };
    expect(request.language).toBe("fr");
  });
});

describe("hermes chat stream codec", () => {
  it("round-trips JSONL hermes chat events", () => {
    const frames = [
      encodeHermesChatEvent({
        type: "chat.started",
        agentId: "coder",
        chatId: "20260726_101500_ab12cd",
        created: true,
      }),
      encodeHermesChatEvent({ type: "message.delta", text: "Hello " }),
      encodeHermesChatEvent({ type: "message.complete", text: "Hello there!" }),
    ].join("");

    expect(parseHermesChatChunk(frames)).toEqual([
      {
        type: "chat.started",
        agentId: "coder",
        chatId: "20260726_101500_ab12cd",
        created: true,
      },
      { type: "message.delta", text: "Hello " },
      { type: "message.complete", text: "Hello there!" },
    ]);
  });

  it("uses stable, namespaced hermes tool names", () => {
    expect(HERMES_AGENTS_LIST_TOOL_NAME).toBe("hermes.agents.list");
    expect(HERMES_CHATS_LIST_TOOL_NAME).toBe("hermes.chats.list");
    expect(HERMES_CHATS_DELETE_TOOL_NAME).toBe("hermes.chats.delete");
    expect(HERMES_CHAT_HISTORY_TOOL_NAME).toBe("hermes.chats.history");
    expect(HERMES_CHAT_SEND_TOOL_NAME).toBe("hermes.chat.send");
    expect(HERMES_CHAT_INTERRUPT_TOOL_NAME).toBe("hermes.chat.interrupt");
    expect(HERMES_CHAT_CLARIFY_ANSWER_TOOL_NAME).toBe(
      "hermes.chat.clarify.answer",
    );
    expect(HERMES_HANDOFF_PREVIEW_TOOL_NAME).toBe("hermes.handoffs.preview");
    expect(HERMES_HANDOFF_SEND_TOOL_NAME).toBe("hermes.handoffs.send");
    expect(HERMES_HANDOFFS_LIST_TOOL_NAME).toBe("hermes.handoffs.list");
    expect(HERMES_HANDOFF_GET_TOOL_NAME).toBe("hermes.handoffs.get");
  });
});

describe("quran audio contract", () => {
  it("uses stable, namespaced tool names", () => {
    expect(QURAN_AUDIO_RECITERS_LIST_TOOL_NAME).toBe(
      "quran.audio.reciters.list",
    );
    expect(QURAN_AUDIO_SURAH_GET_TOOL_NAME).toBe("quran.audio.surah.get");
  });
});

describe("quran verse refs", () => {
  it("round-trips quran:// refs", () => {
    const ref = quranVerseRef("quran-uthmani", 2, 255);
    expect(ref).toBe("quran://quran-uthmani/2/255");
    expect(parseQuranVerseRef(ref)).toEqual({
      edition: "quran-uthmani",
      surah: 2,
      ayah: 255,
    });
  });

  it("rejects malformed refs", () => {
    expect(parseQuranVerseRef("https://example.com/2/255")).toBeNull();
    expect(parseQuranVerseRef("quran://quran-uthmani/0/1")).toBeNull();
    expect(parseQuranVerseRef("quran://quran-uthmani/115/1")).toBeNull();
    expect(parseQuranVerseRef("quran://quran-uthmani/2/0")).toBeNull();
    expect(parseQuranVerseRef("quran://quran-uthmani/2")).toBeNull();
  });
});

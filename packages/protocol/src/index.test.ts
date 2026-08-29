import { describe, expect, it } from "vitest";
import {
  BatchedJsonlDecoder,
  CONTEXTVM_OVERSIZED_TEXT_TRANSFER,
  encodeBatchedJsonl,
  encodeHermesChatEvent,
  encodeHermesChatEventFrames,
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
  MAX_BATCHED_TEXT_BYTES,
  isHermesAutoContinueNote,
  isVisibleHermesHandoffMessage,
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

describe("Hermes recovery notes", () => {
  it("identifies only the synthetic interrupted-turn prefix", () => {
    expect(
      isHermesAutoContinueNote(
        "  [System note: Your previous turn was interrupted mid-run — recovering.]",
      ),
    ).toBe(true);
    expect(isHermesAutoContinueNote("A normal user message")).toBe(false);
    expect(isHermesAutoContinueNote(undefined)).toBe(false);
  });

  it("excludes recovery plumbing from visible handoff rows", () => {
    expect(
      isVisibleHermesHandoffMessage({
        role: "user",
        text: "[System note: Your previous turn was interrupted mid-run — recovering.]",
      }),
    ).toBe(false);
    expect(
      isVisibleHermesHandoffMessage({ role: "user", text: "Question" }),
    ).toBe(true);
    expect(
      isVisibleHermesHandoffMessage({ role: "assistant", text: "Answer" }),
    ).toBe(true);
    expect(
      isVisibleHermesHandoffMessage({ role: "system", text: "internal" }),
    ).toBe(false);
  });
});

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

describe("batched JSONL codec", () => {
  it("splits and reassembles oversized UTF-8 values across bounded frames", () => {
    const value = {
      type: "message.complete",
      text: "🙂 long response\n".repeat(8_000),
    };
    const frames = encodeBatchedJsonl(value, { maxFrameBytes: 4_096 });
    const decoder = new BatchedJsonlDecoder<typeof value>();

    expect(frames.length).toBeGreaterThan(1);
    expect(
      frames.every(
        (frame) => new TextEncoder().encode(frame).byteLength <= 4_096,
      ),
    ).toBe(true);
    expect(frames.flatMap((frame) => decoder.push(frame))).toEqual([value]);
  });

  it("accepts out-of-order and duplicate batch frames idempotently", () => {
    const value = { text: "x".repeat(50_000) };
    const frames = encodeBatchedJsonl(value, { maxFrameBytes: 2_048 });
    const decoder = new BatchedJsonlDecoder<typeof value>();
    const reordered = [frames.at(-1)!, ...frames.slice(0, -1)];

    expect(
      [...reordered, reordered[0]!].flatMap((frame) => decoder.push(frame)),
    ).toEqual([value]);
  });

  it("shares CEP-22 limits that cover worst-case JSON escaping", () => {
    expect(CONTEXTVM_OVERSIZED_TEXT_TRANSFER).toMatchObject({
      enabled: true,
      thresholdBytes: 48_000,
      chunkSizeBytes: 48_000,
    });
    const escapedSampleBytes = new TextEncoder().encode(
      JSON.stringify({ text: "\0".repeat(10_000) }),
    ).byteLength;
    const worstCaseEstimate =
      (escapedSampleBytes / 10_000) * MAX_BATCHED_TEXT_BYTES;
    expect(
      CONTEXTVM_OVERSIZED_TEXT_TRANSFER.policy.maxTransferBytes,
    ).toBeGreaterThan(worstCaseEstimate);
  });

  it("rejects oversized lines, ids, chunk counts, and aggregate pending data", () => {
    expect(() =>
      new BatchedJsonlDecoder({ maxLineBytes: 64 }).push("x".repeat(65)),
    ).toThrow(/line exceeds/);

    const marker = "contexcgi.jsonl.batch.v1";
    expect(() =>
      new BatchedJsonlDecoder({ maxBatchIdLength: 4 }).push(
        `${JSON.stringify({ $batch: marker, id: "too-long", index: 0, total: 1, data: "" })}\n`,
      ),
    ).toThrow(/id exceeds/);
    expect(() =>
      new BatchedJsonlDecoder({ maxBatchChunks: 2 }).push(
        `${JSON.stringify({ $batch: marker, id: "ok", index: 0, total: 3, data: "" })}\n`,
      ),
    ).toThrow(/chunk count exceeds/);

    const firstA = encodeBatchedJsonl(
      { text: "a".repeat(2_000) },
      { maxFrameBytes: 512 },
    )[0]!;
    const firstB = encodeBatchedJsonl(
      { text: "b".repeat(2_000) },
      { maxFrameBytes: 512 },
    )[0]!;
    const firstPartBytes = atob(
      (JSON.parse(firstA) as { data: string }).data,
    ).length;
    const bounded = new BatchedJsonlDecoder({
      maxPendingBytes: firstPartBytes,
    });
    expect(bounded.push(firstA)).toEqual([]);
    expect(() => bounded.push(firstB)).toThrow(/Pending batched JSONL data/);
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

  it("batches a long terminal response and reconstructs it incrementally", () => {
    const event = {
      type: "message.complete" as const,
      text: "A🙂B".repeat(30_000),
    };
    const frames = encodeHermesChatEventFrames(event, {
      maxFrameBytes: 8_192,
    });
    const decoder = new BatchedJsonlDecoder<typeof event>();

    expect(frames.length).toBeGreaterThan(1);
    expect(frames.flatMap((frame) => decoder.push(frame))).toEqual([event]);
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

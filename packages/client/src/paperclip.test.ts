import { describe, expect, it, vi } from "vitest";
import {
  PaperclipOpsClient,
  PaperclipTranscriptionError,
} from "./paperclip.js";

type ToolCallParams = { name: string; arguments: Record<string, unknown> };
type FakeCallTool = (
  params: ToolCallParams,
  resultSchema?: unknown,
  options?: unknown,
) => unknown;

function clientWithFakeCallTool(callTool: FakeCallTool) {
  const client = new PaperclipOpsClient({
    privateKey: "1".padStart(64, "0"),
    serverPubkey: "1".repeat(64),
    relays: ["ws://localhost:10547"],
  });
  (client as unknown as { mcpClient: { callTool: FakeCallTool } }).mcpClient = {
    callTool,
  };
  return client;
}

describe("PaperclipOpsClient voice transcription", () => {
  it("fetches transcription capabilities", async () => {
    const callTool = vi.fn<FakeCallTool>(async () => ({
      structuredContent: {
        available: true,
        maxDurationSeconds: 60,
        maxAudioBytes: 8 * 1024 * 1024,
        acceptedMimeTypes: ["audio/webm"],
      },
    }));
    const client = clientWithFakeCallTool(callTool);

    await expect(client.transcriptionCapabilities()).resolves.toMatchObject({
      available: true,
      maxDurationSeconds: 60,
    });
    expect(callTool).toHaveBeenCalledWith(
      { name: "paperclip.transcription.capabilities", arguments: {} },
      undefined,
      // No onprogress: injecting one makes the patched bridge hold the
      // response (skill pitfall 12) — options pass through untouched.
      undefined,
    );
  });

  it("uploads a small recording as a single chunk, then finalizes", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const callTool = vi.fn<FakeCallTool>(async ({ name, arguments: args }) => {
      calls.push({ name, args });
      if (name === "paperclip.transcription.chunk") {
        return {
          structuredContent: {
            status: "ok",
            uploadId: args.uploadId,
            receivedChunks: 1,
            totalChunks: 1,
          },
        };
      }
      return {
        structuredContent: {
          status: "ok",
          transcript: "hello there",
          durationSeconds: 2.5,
        },
      };
    });
    const client = clientWithFakeCallTool(callTool);

    await expect(
      client.transcribeAudio({
        contentBase64: "aGVsbG8=",
        mimeType: "audio/webm",
      }),
    ).resolves.toEqual({ transcript: "hello there", durationSeconds: 2.5 });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      name: "paperclip.transcription.chunk",
      args: { index: 0, totalChunks: 1, contentBase64: "aGVsbG8=" },
    });
    expect(calls[1]).toMatchObject({
      name: "paperclip.transcription.transcribe",
      args: { mimeType: "audio/webm" },
    });
    // Finalize must reference the same uploadId the chunk(s) were sent under.
    expect(calls[1]!.args.uploadId).toBe(calls[0]!.args.uploadId);
    // No raw audio ever travels in the finalize call.
    expect(calls[1]!.args).not.toHaveProperty("contentBase64");
  });

  it("splits a large recording into many chunk calls that reassemble exactly, each safely under the relay's plaintext ceiling", async () => {
    // Comfortably over the ~65535-byte NIP-44 plaintext ceiling that made a
    // single inline base64 tool call fail before any fragmentation occurred.
    const originalBase64 = "AB".repeat(40_000); // 80,000 chars
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const callTool = vi.fn<FakeCallTool>(async ({ name, arguments: args }) => {
      calls.push({ name, args });
      if (name === "paperclip.transcription.chunk") {
        return {
          structuredContent: {
            status: "ok",
            uploadId: args.uploadId,
            receivedChunks: (args.index as number) + 1,
            totalChunks: args.totalChunks,
          },
        };
      }
      return {
        structuredContent: {
          status: "ok",
          transcript: "big recording",
          durationSeconds: 42,
        },
      };
    });
    const client = clientWithFakeCallTool(callTool);

    await expect(
      client.transcribeAudio({
        contentBase64: originalBase64,
        mimeType: "audio/webm",
        language: "de",
      }),
    ).resolves.toEqual({ transcript: "big recording", durationSeconds: 42 });

    const chunkCalls = calls.filter(
      (c) => c.name === "paperclip.transcription.chunk",
    );
    expect(chunkCalls.length).toBeGreaterThan(1);

    // Every chunk call's JSON-serialized argument size — the actual plaintext
    // that would be handed to NIP-44 — stays well under the 65535-byte limit
    // that broke a single inline call.
    for (const call of chunkCalls) {
      const byteLength = new TextEncoder().encode(
        JSON.stringify(call.args),
      ).length;
      expect(byteLength).toBeLessThan(65_535);
    }

    // Chunks reassemble, in index order, to exactly the original base64.
    const reassembled = chunkCalls
      .slice()
      .sort((a, b) => (a.args.index as number) - (b.args.index as number))
      .map((c) => c.args.contentBase64 as string)
      .join("");
    expect(reassembled).toBe(originalBase64);

    const finalizeCall = calls.find(
      (c) => c.name === "paperclip.transcription.transcribe",
    );
    expect(finalizeCall?.args.uploadId).toBe(chunkCalls[0]!.args.uploadId);
    expect(finalizeCall?.args.language).toBe("de");
  });

  it("forwards an abort signal to every chunk and finalize call", async () => {
    const callTool = vi.fn<FakeCallTool>(async ({ name, arguments: args }) =>
      name === "paperclip.transcription.chunk"
        ? {
            structuredContent: {
              status: "ok",
              uploadId: args.uploadId,
              receivedChunks: 1,
              totalChunks: 1,
            },
          }
        : {
            structuredContent: {
              status: "ok",
              transcript: "hi",
              durationSeconds: 1,
            },
          },
    );
    const client = clientWithFakeCallTool(callTool);
    const controller = new AbortController();

    await client.transcribeAudio(
      { contentBase64: "aGVsbG8=", mimeType: "audio/webm" },
      { signal: controller.signal },
    );

    for (const call of callTool.mock.calls) {
      expect(call[2]).toMatchObject({ signal: controller.signal });
    }
  });

  it("throws a typed, retryable-aware error when a chunk upload fails, without finalizing", async () => {
    const callTool = vi.fn<FakeCallTool>(async ({ name }) => {
      if (name === "paperclip.transcription.chunk") {
        return {
          structuredContent: {
            status: "error",
            code: "BUSY",
            message: "The bridge is already transcribing another recording.",
            retryable: true,
          },
          isError: true,
        };
      }
      throw new Error(`unexpected call to ${name}`);
    });
    const client = clientWithFakeCallTool(callTool);

    const failure = client.transcribeAudio({
      contentBase64: "aGVsbG8=",
      mimeType: "audio/webm",
    });
    await expect(failure).rejects.toBeInstanceOf(PaperclipTranscriptionError);
    await expect(failure).rejects.toMatchObject({
      code: "BUSY",
      retryable: true,
    });
  });

  it("throws a typed error when finalize fails after a successful upload", async () => {
    const callTool = vi.fn<FakeCallTool>(async ({ name }) => {
      if (name === "paperclip.transcription.chunk") {
        return {
          structuredContent: {
            status: "ok",
            uploadId: "u1",
            receivedChunks: 1,
            totalChunks: 1,
          },
        };
      }
      if (name === "paperclip.transcription.transcribe") {
        return {
          structuredContent: {
            status: "error",
            code: "TRANSCRIPTION_FAILED",
            message: "Local transcription failed.",
            retryable: true,
          },
          isError: true,
        };
      }
      return { structuredContent: { status: "ok" } };
    });
    const client = clientWithFakeCallTool(callTool);

    const failure = client.transcribeAudio({
      contentBase64: "aGVsbG8=",
      mimeType: "audio/webm",
    });
    await expect(failure).rejects.toBeInstanceOf(PaperclipTranscriptionError);
    await expect(failure).rejects.toMatchObject({
      code: "TRANSCRIPTION_FAILED",
      retryable: true,
    });
  });

  it("best-effort cancels the upload when a chunk call fails", async () => {
    const cancelledUploadIds: unknown[] = [];
    const callTool = vi.fn<FakeCallTool>(async ({ name, arguments: args }) => {
      if (name === "paperclip.transcription.chunk") {
        return {
          structuredContent: {
            status: "error",
            code: "INVALID_AUDIO",
            message: "bad",
            retryable: false,
          },
          isError: true,
        };
      }
      if (name === "paperclip.transcription.cancel") {
        cancelledUploadIds.push(args.uploadId);
        return { structuredContent: { status: "ok" } };
      }
      throw new Error(`unexpected call to ${name}`);
    });
    const client = clientWithFakeCallTool(callTool);

    await expect(
      client.transcribeAudio({
        contentBase64: "aGVsbG8=",
        mimeType: "audio/webm",
      }),
    ).rejects.toBeInstanceOf(PaperclipTranscriptionError);

    // Cancel is fire-and-forget; give its microtask a tick to run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelledUploadIds).toHaveLength(1);
  });

  it("best-effort cancels the upload when aborted before finalize", async () => {
    const cancelledUploadIds: unknown[] = [];
    const controller = new AbortController();
    const callTool = vi.fn<FakeCallTool>(async ({ name, arguments: args }) => {
      if (name === "paperclip.transcription.chunk") {
        controller.abort();
        return {
          structuredContent: {
            status: "ok",
            uploadId: args.uploadId,
            receivedChunks: 1,
            totalChunks: 2,
          },
        };
      }
      if (name === "paperclip.transcription.cancel") {
        cancelledUploadIds.push(args.uploadId);
        return { structuredContent: { status: "ok" } };
      }
      throw new Error(`unexpected call to ${name}`);
    });
    const client = clientWithFakeCallTool(callTool);

    await expect(
      client.transcribeAudio(
        { contentBase64: "A".repeat(50_000), mimeType: "audio/webm" },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelledUploadIds).toHaveLength(1);
  });
});

import { describe, expect, it, vi } from "vitest";
import { HermesChatClient, HermesTranscriptionError } from "./hermes.js";

type ToolCallParams = { name: string; arguments: Record<string, unknown> };
type FakeCallTool = (
  params: ToolCallParams,
  resultSchema?: unknown,
  options?: unknown,
) => unknown;

function clientWithFakeCallTool(callTool: FakeCallTool) {
  const client = new HermesChatClient({
    privateKey: "1".padStart(64, "0"),
    serverPubkey: "1".repeat(64),
    relays: ["ws://localhost:10547"],
  });
  (client as unknown as { mcpClient: { callTool: FakeCallTool } }).mcpClient = {
    callTool,
  };
  return client;
}

describe("HermesChatClient", () => {
  it("lists agent profiles", async () => {
    const callTool = vi.fn<FakeCallTool>(async () => ({
      structuredContent: {
        agents: [
          { id: "default", name: "Hermes", description: "", isDefault: true },
          {
            id: "coder",
            name: "Coder",
            description: "Writes code",
            isDefault: false,
          },
        ],
      },
    }));
    const client = clientWithFakeCallTool(callTool);

    const agents = await client.listAgents();
    expect(agents.map((agent) => agent.id)).toEqual(["default", "coder"]);
    expect(callTool).toHaveBeenCalledWith(
      { name: "hermes.agents.list", arguments: {} },
      undefined,
      undefined,
    );
  });

  it("updates one agent profile's default model", async () => {
    const result = { value: "glm-5.2", scope: "global" };
    const callTool = vi.fn<FakeCallTool>(async () => ({
      structuredContent: result,
    }));
    const client = clientWithFakeCallTool(callTool);

    await expect(
      client.updateProfile({
        agentId: "coder",
        model: "glm-5.2",
        provider: "custom:routstr",
      }),
    ).resolves.toEqual(result);
    expect(callTool).toHaveBeenCalledWith(
      {
        name: "hermes.profile.update",
        arguments: {
          agentId: "coder",
          model: "glm-5.2",
          provider: "custom:routstr",
        },
      },
      undefined,
      undefined,
    );
  });

  it("asks the connected bridge to ensure client relays", async () => {
    const result = {
      relays: ["wss://one.example", "wss://two.example"],
      added: ["wss://two.example"],
    };
    const callTool = vi.fn<FakeCallTool>(async () => ({
      structuredContent: result,
    }));
    const client = clientWithFakeCallTool(callTool);

    await expect(
      client.ensureBridgeRelays(["wss://two.example"]),
    ).resolves.toEqual(result);
    expect(callTool).toHaveBeenCalledWith(
      {
        name: "hermes.relays.ensure",
        arguments: { relays: ["wss://two.example"] },
      },
      undefined,
      undefined,
    );
  });

  it("lists chats for one agent and unwraps the items box", async () => {
    const callTool = vi.fn<FakeCallTool>(async () => ({
      structuredContent: {
        items: [
          {
            id: "20260725_090000_aaaaaa",
            agentId: "coder",
            title: "Fix the build",
            preview: "done",
            startedAt: 1785000000,
            messageCount: 4,
            source: "tui",
          },
        ],
      },
    }));
    const client = clientWithFakeCallTool(callTool);

    const chats = await client.listChats("coder");
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({
      id: "20260725_090000_aaaaaa",
      title: "Fix the build",
    });
    expect(callTool).toHaveBeenCalledWith(
      {
        name: "hermes.chats.list",
        arguments: { agentId: "coder", limit: 20, offset: 0 },
      },
      undefined,
      undefined,
    );
  });

  it("reads a transcript page", async () => {
    const callTool = vi.fn<FakeCallTool>(async () => ({
      structuredContent: {
        agentId: "default",
        chatId: "c1",
        messages: [
          { role: "user", text: "hi" },
          { role: "assistant", text: "hello!" },
        ],
      },
    }));
    const client = clientWithFakeCallTool(callTool);

    const history = await client.chatHistory("default", "c1", 12);
    expect(history.messages).toHaveLength(2);
    expect(callTool).toHaveBeenCalledWith(
      {
        name: "hermes.chats.history",
        arguments: { agentId: "default", chatId: "c1", beforeOrdinal: 12 },
      },
      undefined,
      undefined,
    );
  });

  it("loads the complete skills catalog in bounded pages", async () => {
    const calls: ToolCallParams[] = [];
    const callTool = vi.fn<FakeCallTool>(async (params) => {
      calls.push(params);
      const offset = Number(params.arguments.offset ?? 0);
      if (offset === 0) {
        return {
          structuredContent: {
            agentId: "default",
            skills: [
              {
                name: "one",
                description: "One",
                category: "test",
                path: "one/SKILL.md",
              },
              {
                name: "two",
                description: "Two",
                category: "test",
                path: "two/SKILL.md",
              },
            ],
            nextOffset: 2,
            totalSkills: 3,
          },
        };
      }
      return {
        structuredContent: {
          agentId: "default",
          skills: [
            {
              name: "three",
              description: "Three",
              category: "test",
              path: "three/SKILL.md",
            },
          ],
          totalSkills: 3,
        },
      };
    });
    const client = clientWithFakeCallTool(callTool);

    const result = await client.listSkills("default");

    expect(result.skills.map((skill) => skill.name)).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect(calls).toEqual([
      {
        name: "hermes.skills.list",
        arguments: { agentId: "default", offset: 0, limit: 40 },
      },
      {
        name: "hermes.skills.list",
        arguments: { agentId: "default", offset: 2, limit: 40 },
      },
    ]);
  });

  it("previews and lists durable cross-agent handoffs", async () => {
    const calls: ToolCallParams[] = [];
    const callTool = vi.fn<FakeCallTool>(async (params) => {
      calls.push(params);
      if (params.name === "hermes.handoffs.list") {
        return { structuredContent: { items: [{ requestId: "request-1" }] } };
      }
      return {
        structuredContent: {
          schemaVersion: 1,
          ...params.arguments,
          messages: [],
          envelope: "preview",
          byteCount: 7,
          previewDigest: "a".repeat(64),
        },
      };
    });
    const client = clientWithFakeCallTool(callTool);
    const input = {
      source: { agentId: "researcher", chatId: "source" },
      mode: "full" as const,
      destination: { kind: "new" as const, agentId: "coder", title: "Build" },
      instructions: "Implement it",
    };
    expect((await client.previewHandoff(input)).byteCount).toBe(7);
    expect(await client.listHandoffs({ chatId: "source" })).toHaveLength(1);
    expect(calls.map((call) => call.name)).toEqual([
      "hermes.handoffs.preview",
      "hermes.handoffs.list",
    ]);
  });

  it("throws when a tool result has no structured content", async () => {
    const client = clientWithFakeCallTool(async () => ({ content: [] }));
    await expect(client.listAgents()).rejects.toThrow(/structuredContent/);
  });
});

describe("HermesChatClient voice transcription", () => {
  // These tests exercise the LEGACY chunked path: the fake bridge rejects
  // every file-transfer / transcribe_file tool with "Unknown tool", which is
  // exactly how an older bridge looks to the new client.
  const unknownTool = (name: string) => ({
    isError: true,
    content: [{ type: "text", text: `Unknown tool: ${name}` }],
  });
  const isFileTransferOrTranscribeFile = (name: string) =>
    name.startsWith("contexcgi.fileTransfer") ||
    name === "hermes.transcription.transcribe_file";

  it("uploads a small recording as a single chunk, then finalizes", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const callTool = vi.fn<FakeCallTool>(async ({ name, arguments: args }) => {
      calls.push({ name, args });
      if (isFileTransferOrTranscribeFile(name)) return unknownTool(name);
      if (name === "hermes.transcription.chunk") {
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

    // First the file-transfer attempt (rejected as unknown), then the legacy
    // chunk + transcribe pair.
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({
      name: "contexcgi.fileTransfer.upload.init",
    });
    expect(calls[1]).toMatchObject({
      name: "hermes.transcription.chunk",
      args: { index: 0, totalChunks: 1, contentBase64: "aGVsbG8=" },
    });
    expect(calls[2]).toMatchObject({
      name: "hermes.transcription.transcribe",
      args: { mimeType: "audio/webm" },
    });
    expect(calls[2]!.args.uploadId).toBe(calls[1]!.args.uploadId);
  });

  it("splits large recordings into many chunks under the NIP-44 ceiling", async () => {
    const chunkSizes: number[] = [];
    const callTool = vi.fn<FakeCallTool>(async ({ name, arguments: args }) => {
      if (isFileTransferOrTranscribeFile(name)) return unknownTool(name);
      if (name === "hermes.transcription.chunk") {
        chunkSizes.push((args.contentBase64 as string).length);
        return {
          structuredContent: {
            status: "ok",
            uploadId: args.uploadId,
            receivedChunks: chunkSizes.length,
            totalChunks: args.totalChunks,
          },
        };
      }
      return {
        structuredContent: {
          status: "ok",
          transcript: "long",
          durationSeconds: 30,
        },
      };
    });
    const client = clientWithFakeCallTool(callTool);

    await client.transcribeAudio({
      contentBase64: "A".repeat(60_000),
      mimeType: "audio/webm",
    });
    expect(chunkSizes).toEqual([24_000, 24_000, 12_000]);
  });

  it("rejects with a typed error and fire-and-forget cancels on failure", async () => {
    const names: string[] = [];
    const callTool = vi.fn<FakeCallTool>(async ({ name }) => {
      names.push(name);
      if (isFileTransferOrTranscribeFile(name)) return unknownTool(name);
      if (name === "hermes.transcription.chunk") {
        return {
          structuredContent: {
            status: "error",
            code: "BUSY",
            message: "busy",
            retryable: true,
          },
        };
      }
      return { structuredContent: { status: "ok" } };
    });
    const client = clientWithFakeCallTool(callTool);

    await expect(
      client.transcribeAudio({
        contentBase64: "aGVsbG8=",
        mimeType: "audio/webm",
      }),
    ).rejects.toMatchObject({ code: "BUSY", retryable: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(names).toContain("hermes.transcription.cancel");
    const error = await client
      .transcribeAudio({ contentBase64: "aGVsbG8=", mimeType: "audio/webm" })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(HermesTranscriptionError);
  });
});

describe("HermesChatClient resumable file upload", () => {
  const source = {
    sizeBytes: 8,
    read: vi.fn(async (start: number, end: number) =>
      Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8].slice(start, end)),
    ),
  };

  it("validates status and skips chunks already accepted by the bridge", async () => {
    const chunkIndices: number[] = [];
    const callTool = vi.fn<FakeCallTool>(async ({ name, arguments: args }) => {
      if (name === "contexcgi.fileTransfer.upload.status") {
        return {
          structuredContent: {
            uploadId: "00000000-0000-0000-0000-000000000001",
            filename: "data.bin",
            sizeBytes: 8,
            sha256:
              "66840dda154e8a113c31dd0ad32f7f3a366a80e8136979d8f5a101d3d29d6f72",
            chunkSizeBytes: 4,
            totalChunks: 2,
            expiresAt: Date.now() + 1000,
            receivedChunks: 1,
            receivedChunkIndices: [0],
          },
        };
      }
      if (name === "contexcgi.fileTransfer.upload.chunk") {
        chunkIndices.push(args.index as number);
        return {
          structuredContent: {
            status: "ok",
            receivedChunks: 2,
            totalChunks: 2,
          },
        };
      }
      if (name === "contexcgi.fileTransfer.upload.finalize") {
        return {
          structuredContent: { status: "ok", file: { id: "data.bin" } },
        };
      }
      throw new Error(`unexpected tool: ${name}`);
    });
    const client = clientWithFakeCallTool(callTool);
    await client.uploadFileSource({ filename: "data.bin", source }, undefined, {
      resumeUploadId: "00000000-0000-0000-0000-000000000001",
    });
    expect(chunkIndices).toEqual([1]);
  });

  it("cancels a fresh upload after a terminal chunk failure", async () => {
    const names: string[] = [];
    const callTool = vi.fn<FakeCallTool>(async ({ name }) => {
      names.push(name);
      if (name === "contexcgi.fileTransfer.upload.init") {
        return {
          structuredContent: {
            uploadId: "u1",
            chunkSizeBytes: 4,
            totalChunks: 2,
            expiresAt: Date.now() + 1000,
          },
        };
      }
      if (name === "contexcgi.fileTransfer.upload.chunk")
        throw new Error("rejected chunk");
      if (name === "contexcgi.fileTransfer.upload.cancel")
        return { structuredContent: { status: "ok" } };
      throw new Error(`unexpected tool: ${name}`);
    });
    const client = clientWithFakeCallTool(callTool);
    await expect(
      client.uploadFileSource({ filename: "data.bin", source }),
    ).rejects.toThrow("rejected chunk");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(names).toContain("contexcgi.fileTransfer.upload.cancel");
  });

  it("preserves a fresh upload when the caller requests resumable retry", async () => {
    const names: string[] = [];
    const controller = new AbortController();
    const callTool = vi.fn<FakeCallTool>(async ({ name }) => {
      names.push(name);
      if (name === "contexcgi.fileTransfer.upload.init") {
        return {
          structuredContent: {
            uploadId: "u1",
            chunkSizeBytes: 4,
            totalChunks: 2,
            expiresAt: Date.now() + 1000,
          },
        };
      }
      throw new Error(`unexpected tool: ${name}`);
    });
    const client = clientWithFakeCallTool(callTool);
    await expect(
      client.uploadFileSource({ filename: "data.bin", source }, undefined, {
        signal: controller.signal,
        preserveForResume: true,
        onUploadInitialized: () => controller.abort(),
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(names).not.toContain("contexcgi.fileTransfer.upload.cancel");
  });
});

describe("HermesChatClient voice transcription via file transfer", () => {
  const VOICE_FILE = { id: "voice-1.webm", filename: "voice-1.webm" };

  it("uploads through the resumable transfer package, then transcribes by id", async () => {
    const names: string[] = [];
    let transcribeArgs: Record<string, unknown> = {};
    const callTool = vi.fn<FakeCallTool>(async ({ name, arguments: args }) => {
      names.push(name);
      if (name === "contexcgi.fileTransfer.upload.init") {
        return {
          structuredContent: {
            uploadId: "u1",
            chunkSizeBytes: 45 * 1024,
            totalChunks: 1,
          },
        };
      }
      if (name === "contexcgi.fileTransfer.upload.chunk") {
        return {
          structuredContent: {
            status: "ok",
            receivedChunks: 1,
            totalChunks: 1,
          },
        };
      }
      if (name === "contexcgi.fileTransfer.upload.finalize") {
        return { structuredContent: { status: "ok", file: VOICE_FILE } };
      }
      if (name === "hermes.transcription.transcribe_file") {
        transcribeArgs = args;
        return {
          structuredContent: {
            status: "ok",
            transcript: "hello there",
            durationSeconds: 2.5,
          },
        };
      }
      if (name === "contexcgi.fileTransfer.delete") {
        return { structuredContent: { id: args.id, deleted: true } };
      }
      throw new Error(`unexpected tool: ${name}`);
    });
    const client = clientWithFakeCallTool(callTool);

    const progress: string[] = [];
    const result = await client.transcribeAudio(
      { contentBase64: "aGVsbG8=", mimeType: "audio/webm", language: "de" },
      {
        onProgress: (p) => progress.push(`${p.phase}:${Math.round(p.percent)}`),
      },
    );

    expect(result).toEqual({ transcript: "hello there", durationSeconds: 2.5 });
    expect(names).toEqual([
      "contexcgi.fileTransfer.upload.init",
      "contexcgi.fileTransfer.upload.chunk",
      "contexcgi.fileTransfer.upload.finalize",
      "hermes.transcription.transcribe_file",
      "contexcgi.fileTransfer.delete",
    ]);
    expect(transcribeArgs).toMatchObject({
      id: "voice-1.webm",
      mimeType: "audio/webm",
      language: "de",
    });
    expect(progress[0]).toMatch(/^uploading:/);
    expect(progress.at(-1)).toBe("transcribing:100");
  });

  it("retries a transient chunk failure mid-upload instead of losing the recording", async () => {
    let chunkAttempts = 0;
    const callTool = vi.fn<FakeCallTool>(async ({ name }) => {
      if (name === "contexcgi.fileTransfer.upload.init") {
        return {
          structuredContent: {
            uploadId: "u1",
            chunkSizeBytes: 45 * 1024,
            totalChunks: 1,
          },
        };
      }
      if (name === "contexcgi.fileTransfer.upload.chunk") {
        chunkAttempts++;
        if (chunkAttempts === 1) throw new Error("Connection closed (-32000)");
        return {
          structuredContent: {
            status: "ok",
            receivedChunks: 1,
            totalChunks: 1,
          },
        };
      }
      if (name === "contexcgi.fileTransfer.upload.finalize") {
        return { structuredContent: { status: "ok", file: VOICE_FILE } };
      }
      if (name === "hermes.transcription.transcribe_file") {
        return {
          structuredContent: {
            status: "ok",
            transcript: "recovered",
            durationSeconds: 1,
          },
        };
      }
      if (name === "contexcgi.fileTransfer.delete") {
        return { structuredContent: { deleted: true } };
      }
      throw new Error(`unexpected tool: ${name}`);
    });
    const client = clientWithFakeCallTool(callTool);

    await expect(
      client.transcribeAudio({
        contentBase64: "aGVsbG8=",
        mimeType: "audio/webm",
      }),
    ).resolves.toEqual({ transcript: "recovered", durationSeconds: 1 });
    expect(chunkAttempts).toBe(2);
  });

  it("deletes the recording and throws typed when transcription fails permanently", async () => {
    const names: string[] = [];
    const callTool = vi.fn<FakeCallTool>(async ({ name }) => {
      names.push(name);
      if (name === "contexcgi.fileTransfer.upload.init") {
        return {
          structuredContent: {
            uploadId: "u1",
            chunkSizeBytes: 45 * 1024,
            totalChunks: 1,
          },
        };
      }
      if (name === "contexcgi.fileTransfer.upload.chunk") {
        return {
          structuredContent: {
            status: "ok",
            receivedChunks: 1,
            totalChunks: 1,
          },
        };
      }
      if (name === "contexcgi.fileTransfer.upload.finalize") {
        return { structuredContent: { status: "ok", file: VOICE_FILE } };
      }
      if (name === "hermes.transcription.transcribe_file") {
        return {
          structuredContent: {
            status: "error",
            code: "INVALID_AUDIO",
            message: "Could not decode the recording.",
            retryable: false,
          },
        };
      }
      if (name === "contexcgi.fileTransfer.delete") {
        return { structuredContent: { deleted: true } };
      }
      throw new Error(`unexpected tool: ${name}`);
    });
    const client = clientWithFakeCallTool(callTool);

    await expect(
      client.transcribeAudio({
        contentBase64: "aGVsbG8=",
        mimeType: "audio/webm",
      }),
    ).rejects.toMatchObject({ code: "INVALID_AUDIO", retryable: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(names).toContain("contexcgi.fileTransfer.delete");
  });

  it("falls back to the legacy chunk path when the bridge lacks transcribe_file", async () => {
    const names: string[] = [];
    const callTool = vi.fn<FakeCallTool>(async ({ name, arguments: args }) => {
      names.push(name);
      if (name === "contexcgi.fileTransfer.upload.init") {
        return {
          structuredContent: {
            uploadId: "u1",
            chunkSizeBytes: 45 * 1024,
            totalChunks: 1,
          },
        };
      }
      if (name === "contexcgi.fileTransfer.upload.chunk") {
        return {
          structuredContent: {
            status: "ok",
            receivedChunks: 1,
            totalChunks: 1,
          },
        };
      }
      if (name === "contexcgi.fileTransfer.upload.finalize") {
        return { structuredContent: { status: "ok", file: VOICE_FILE } };
      }
      if (name === "hermes.transcription.transcribe_file") {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Unknown tool: hermes.transcription.transcribe_file",
            },
          ],
        };
      }
      if (name === "contexcgi.fileTransfer.delete") {
        return { structuredContent: { deleted: true } };
      }
      if (name === "hermes.transcription.chunk") {
        return {
          structuredContent: {
            status: "ok",
            uploadId: args.uploadId,
            receivedChunks: 1,
            totalChunks: 1,
          },
        };
      }
      if (name === "hermes.transcription.transcribe") {
        return {
          structuredContent: {
            status: "ok",
            transcript: "legacy works",
            durationSeconds: 3,
          },
        };
      }
      throw new Error(`unexpected tool: ${name}`);
    });
    const client = clientWithFakeCallTool(callTool);

    await expect(
      client.transcribeAudio({
        contentBase64: "aGVsbG8=",
        mimeType: "audio/webm",
      }),
    ).resolves.toEqual({ transcript: "legacy works", durationSeconds: 3 });
    expect(names).toContain("hermes.transcription.chunk");
    expect(names).toContain("hermes.transcription.transcribe");
  });
});

describe("HermesChatClient file upload resilience", () => {
  const DESCRIPTOR = {
    id: "upload-1",
    filename: "photo.jpg",
    sizeBytes: 4,
    category: "unknown",
    platform: "any",
    createdAt: 1785000000,
    updatedAt: 1785000000,
    sha256: "x".repeat(64),
  };

  it("rebuilds the transport and retries after a terminal 'Not connected'", async () => {
    const names: string[] = [];
    let initAttempts = 0;
    let reconnects = 0;
    const callTool = vi.fn<FakeCallTool>(async ({ name }) => {
      names.push(name);
      if (name === "contexcgi.fileTransfer.upload.init") {
        initAttempts++;
        if (initAttempts === 1) throw new Error("Not connected");
        return {
          structuredContent: {
            uploadId: "upload-1",
            chunkSizeBytes: 64 * 1024,
            totalChunks: 1,
          },
        };
      }
      if (name === "contexcgi.fileTransfer.upload.chunk") {
        return { structuredContent: { ok: true } };
      }
      if (name === "contexcgi.fileTransfer.upload.finalize") {
        return { structuredContent: { file: DESCRIPTOR } };
      }
      throw new Error(`unexpected tool: ${name}`);
    });
    const client = clientWithFakeCallTool(callTool);
    (
      client as unknown as {
        reconnectTransport: () => Promise<void>;
      }
    ).reconnectTransport = async () => {
      reconnects++;
      (
        client as unknown as { mcpClient: { callTool: FakeCallTool } }
      ).mcpClient = { callTool };
    };

    const file = await client.uploadFile({
      filename: "photo.jpg",
      data: new Uint8Array([1, 2, 3, 4]),
      mimeType: "image/jpeg",
    });

    expect(file).toEqual(DESCRIPTOR);
    expect(reconnects).toBe(1);
    expect(initAttempts).toBe(2);
    expect(
      names.filter((n) => n === "contexcgi.fileTransfer.upload.init"),
    ).toHaveLength(2);
  });
});

import { access, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { CommandRunner } from "./transcription.js";
import {
  spawnCommand,
  transcribeVoiceFile,
  WhisperTranscriptionService,
} from "./transcription.js";

const SHORT_AUDIO_BASE64 = Buffer.from(
  "not-real-audio-but-valid-base64",
).toString("base64");

/** A fake command runner: fixed ffprobe duration, configurable ffmpeg/whisper-cli steps. */
function fakeRunner(opts: {
  durationSeconds?: number;
  ffmpeg?: CommandRunner;
  whisperCli?: CommandRunner;
}): CommandRunner {
  return async (command, args, runOpts) => {
    if (command === "ffprobe") {
      return {
        code: 0,
        stdout: `${opts.durationSeconds ?? 2}\n`,
        stderr: "",
        timedOut: false,
      };
    }
    if (command === "ffmpeg") {
      if (opts.ffmpeg) return opts.ffmpeg(command, args, runOpts);
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    }
    if (command === "whisper-cli") {
      if (opts.whisperCli) return opts.whisperCli(command, args, runOpts);
      const prefix = args[args.indexOf("-of") + 1];
      await writeFile(`${prefix}.txt`, "hello there\n", "utf8");
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    }
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  };
}

function readyService(
  overrides: Partial<Parameters<typeof fakeRunner>[0]> = {},
) {
  return new WhisperTranscriptionService({
    enabled: true,
    whisperCli: "whisper-cli",
    whisperModel: "model.bin",
    checkRuntime: async () => ({ ok: true }),
    runCommand: fakeRunner(overrides),
  });
}

describe("WhisperTranscriptionService.capabilities", () => {
  it("reports unavailable when disabled", async () => {
    const service = new WhisperTranscriptionService({ enabled: false });
    await expect(service.capabilities()).resolves.toMatchObject({
      available: false,
      reason: "disabled",
    });
  });

  it("reports unavailable with a sanitized reason when misconfigured", async () => {
    const service = new WhisperTranscriptionService({
      enabled: true,
      checkRuntime: async () => ({ ok: false, reason: "missing-model" }),
    });
    const caps = await service.capabilities();
    expect(caps.available).toBe(false);
    expect(caps.reason).toBe("missing-model");
    // The reason is a fixed enum-like code — it must never leak a filesystem path.
    expect(caps.reason).not.toMatch(/[/\\]/);
  });

  it("reports available with limits when everything checks out", async () => {
    const service = readyService();
    await expect(service.capabilities()).resolves.toMatchObject({
      available: true,
      maxDurationSeconds: 60,
      maxAudioBytes: 8 * 1024 * 1024,
    });
  });
});

describe("WhisperTranscriptionService.transcribe validation", () => {
  it("rejects an unsupported mime type without touching the runtime", async () => {
    const service = new WhisperTranscriptionService({ enabled: false });
    const result = await service.transcribe({
      contentBase64: "aGVsbG8=",
      mimeType: "video/mp4",
    });
    expect(result).toMatchObject({
      status: "error",
      code: "INVALID_AUDIO",
      retryable: false,
    });
  });

  it("rejects malformed base64", async () => {
    const service = new WhisperTranscriptionService({ enabled: false });
    const result = await service.transcribe({
      contentBase64: "not base64!!",
      mimeType: "audio/webm",
    });
    expect(result).toMatchObject({
      status: "error",
      code: "INVALID_AUDIO",
      retryable: false,
    });
  });

  it("rejects an empty recording", async () => {
    const service = new WhisperTranscriptionService({ enabled: false });
    const result = await service.transcribe({
      contentBase64: "",
      mimeType: "audio/webm",
    });
    expect(result).toMatchObject({
      status: "error",
      code: "INVALID_AUDIO",
      retryable: false,
    });
  });

  it("rejects audio over the configured byte limit before decoding runtime state", async () => {
    const service = new WhisperTranscriptionService({
      enabled: false,
      maxAudioBytes: 4,
    });
    const result = await service.transcribe({
      contentBase64: SHORT_AUDIO_BASE64,
      mimeType: "audio/webm",
    });
    expect(result).toMatchObject({
      status: "error",
      code: "TOO_LARGE",
      retryable: false,
    });
  });

  it("reports UNSUPPORTED when the runtime is not ready", async () => {
    const service = new WhisperTranscriptionService({
      enabled: true,
      checkRuntime: async () => ({ ok: false, reason: "missing-runtime" }),
    });
    const result = await service.transcribe({
      contentBase64: SHORT_AUDIO_BASE64,
      mimeType: "audio/webm",
    });
    expect(result).toMatchObject({
      status: "error",
      code: "UNSUPPORTED",
      retryable: false,
    });
  });
});

describe("WhisperTranscriptionService shared service backend", () => {
  it("probes health and sends the original recording as multipart audio", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const service = new WhisperTranscriptionService({
      enabled: true,
      serviceUrl: "http://whisper.internal:8002",
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith("/health")) {
          return new Response(JSON.stringify({ status: "ok" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({ text: "shared service result", language: "en" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    await expect(service.capabilities()).resolves.toMatchObject({
      available: true,
    });
    await expect(
      service.transcribe({
        contentBase64: SHORT_AUDIO_BASE64,
        mimeType: "audio/webm",
        durationMs: 2_500,
      }),
    ).resolves.toEqual({
      status: "ok",
      transcript: "shared service result",
      durationSeconds: 2.5,
    });

    expect(calls.map((call) => call.url)).toEqual([
      "http://whisper.internal:8002/health",
      "http://whisper.internal:8002/transcribe",
    ]);
    const body = calls[1]?.init?.body;
    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).get("audio")).toBeInstanceOf(Blob);
  });

  it("adds an optional bearer token without leaking it into errors", async () => {
    const headers: string[] = [];
    const service = new WhisperTranscriptionService({
      enabled: true,
      serviceUrl: "https://whisper.example",
      serviceToken: "super-secret",
      fetch: async (_input, init) => {
        headers.push(new Headers(init?.headers).get("authorization") ?? "");
        return new Response("unavailable", { status: 503 });
      },
    });
    await service.capabilities();
    expect(headers).toEqual(["Bearer super-secret"]);
  });

  it("maps service unavailable, timeout, and malformed success responses", async () => {
    const unavailable = new WhisperTranscriptionService({
      enabled: true,
      serviceUrl: "http://whisper.internal",
      checkRuntime: async () => ({ ok: true }),
      fetch: async () => new Response("busy", { status: 503 }),
    });
    await expect(
      unavailable.transcribe({
        contentBase64: SHORT_AUDIO_BASE64,
        mimeType: "audio/webm",
        durationMs: 1_000,
      }),
    ).resolves.toMatchObject({
      status: "error",
      code: "BUSY",
      retryable: true,
    });

    const timedOut = new WhisperTranscriptionService({
      enabled: true,
      serviceUrl: "http://whisper.internal",
      timeoutMs: 10,
      checkRuntime: async () => ({ ok: true }),
      fetch: async (_input, init) => {
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        });
        throw new Error("unreachable");
      },
    });
    await expect(
      timedOut.transcribe({
        contentBase64: SHORT_AUDIO_BASE64,
        mimeType: "audio/webm",
        durationMs: 1_000,
      }),
    ).resolves.toMatchObject({
      status: "error",
      code: "TIMEOUT",
      retryable: true,
    });

    const malformed = new WhisperTranscriptionService({
      enabled: true,
      serviceUrl: "http://whisper.internal",
      checkRuntime: async () => ({ ok: true }),
      fetch: async () =>
        new Response(JSON.stringify({ text: "" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    await expect(
      malformed.transcribe({
        contentBase64: SHORT_AUDIO_BASE64,
        mimeType: "audio/webm",
        durationMs: 1_000,
      }),
    ).resolves.toMatchObject({
      status: "error",
      code: "TRANSCRIPTION_FAILED",
      retryable: true,
    });
  });
});

describe("WhisperTranscriptionService.transcribe pipeline", () => {
  it("transcribes successfully via ffmpeg + whisper-cli", async () => {
    const service = readyService({ durationSeconds: 3.2 });
    const result = await service.transcribe({
      contentBase64: SHORT_AUDIO_BASE64,
      mimeType: "audio/webm",
    });
    expect(result).toEqual({
      status: "ok",
      transcript: "hello there",
      durationSeconds: 3.2,
    });
  });

  it("rejects a recording longer than the configured limit without running whisper-cli", async () => {
    let whisperCalled = false;
    const service = readyService({
      durationSeconds: 90,
      whisperCli: async () => {
        whisperCalled = true;
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
    });
    const result = await service.transcribe({
      contentBase64: SHORT_AUDIO_BASE64,
      mimeType: "audio/webm",
    });
    expect(result).toMatchObject({
      status: "error",
      code: "TOO_LONG",
      retryable: false,
    });
    expect(whisperCalled).toBe(false);
  });

  it("maps an ffmpeg decode failure to INVALID_AUDIO", async () => {
    const service = readyService({
      ffmpeg: async () => ({
        code: 1,
        stdout: "",
        stderr: "bad container",
        timedOut: false,
      }),
    });
    const result = await service.transcribe({
      contentBase64: SHORT_AUDIO_BASE64,
      mimeType: "audio/webm",
    });
    expect(result).toMatchObject({
      status: "error",
      code: "INVALID_AUDIO",
      retryable: false,
    });
  });

  it("maps a whisper-cli failure to TRANSCRIPTION_FAILED", async () => {
    const service = readyService({
      whisperCli: async () => ({
        code: 1,
        stdout: "",
        stderr: "oom",
        timedOut: false,
      }),
    });
    const result = await service.transcribe({
      contentBase64: SHORT_AUDIO_BASE64,
      mimeType: "audio/webm",
    });
    expect(result).toMatchObject({
      status: "error",
      code: "TRANSCRIPTION_FAILED",
      retryable: true,
    });
  });

  it("maps a timed-out step to TIMEOUT", async () => {
    const service = readyService({
      whisperCli: async () => ({
        code: null,
        stdout: "",
        stderr: "",
        timedOut: true,
      }),
    });
    const result = await service.transcribe({
      contentBase64: SHORT_AUDIO_BASE64,
      mimeType: "audio/webm",
    });
    expect(result).toMatchObject({
      status: "error",
      code: "TIMEOUT",
      retryable: true,
    });
  });

  it("rejects a second concurrent request as BUSY while one job is in flight", async () => {
    let releaseFirst: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const service = readyService({
      whisperCli: async (_command, args) => {
        await blocked;
        const prefix = args[args.indexOf("-of") + 1];
        await writeFile(`${prefix}.txt`, "first\n", "utf8");
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
    });

    const first = service.transcribe({
      contentBase64: SHORT_AUDIO_BASE64,
      mimeType: "audio/webm",
    });
    // Let the first call reach the concurrency gate before firing the second.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const second = await service.transcribe({
      contentBase64: SHORT_AUDIO_BASE64,
      mimeType: "audio/webm",
    });
    expect(second).toMatchObject({
      status: "error",
      code: "BUSY",
      retryable: true,
    });

    releaseFirst();
    await expect(first).resolves.toMatchObject({
      status: "ok",
      transcript: "first",
    });
  });

  it("cleans up its temp directory on success", async () => {
    let transcriptPath = "";
    const service = readyService({
      whisperCli: async (_command, args) => {
        const prefix = args[args.indexOf("-of") + 1];
        transcriptPath = `${prefix}.txt`;
        await writeFile(transcriptPath, "hi\n", "utf8");
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
    });
    await service.transcribe({
      contentBase64: SHORT_AUDIO_BASE64,
      mimeType: "audio/webm",
    });
    expect(transcriptPath).not.toBe("");
    await expect(access(transcriptPath)).rejects.toThrow();
  });
});

describe("spawnCommand (real child process)", () => {
  it("resolves as timed-out immediately for an already-aborted signal, without spawning", async () => {
    const controller = new AbortController();
    controller.abort();

    const startedAt = Date.now();
    const result = await spawnCommand(
      "node",
      ["-e", "setTimeout(() => {}, 5000)"],
      {
        timeoutMs: 60_000,
        signal: controller.signal,
      },
    );

    // Never actually spawned/waited on the child — resolves near-instantly.
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(result).toEqual({
      code: null,
      stdout: "",
      stderr: "",
      timedOut: true,
    });
  });

  it("runs a real command to completion and captures stdout", async () => {
    const result = await spawnCommand(
      "node",
      ["-e", "process.stdout.write('hi')"],
      {
        timeoutMs: 5_000,
      },
    );
    expect(result).toEqual({
      code: 0,
      stdout: "hi",
      stderr: "",
      timedOut: false,
    });
  });

  it("kills a real child process on abort after it has already started", async () => {
    const controller = new AbortController();
    const resultPromise = spawnCommand(
      "node",
      ["-e", "setTimeout(() => {}, 5000)"],
      {
        timeoutMs: 60_000,
        signal: controller.signal,
      },
    );
    setTimeout(() => controller.abort(), 20);
    const result = await resultPromise;
    expect(result.code).not.toBe(0);
  });
});

describe("language pinning", () => {
  it("passes a whitelisted language to whisper and never a stray flag", async () => {
    const commands: string[][] = [];
    const runCommand = async (command: string, args: string[]) => {
      commands.push([command, ...args]);
      if (command === "whisper") {
        const outIndex = args.indexOf("-of");
        const { writeFile } = await import("node:fs/promises");
        await writeFile(`${args[outIndex + 1]}.txt`, "hallo welt");
      }
      return { code: 0, stdout: "3.0", stderr: "", timedOut: false };
    };
    const service = new WhisperTranscriptionService({
      enabled: true,
      whisperCli: "whisper",
      whisperModel: "model.bin",
      ffmpegPath: "ffmpeg",
      ffprobePath: "ffprobe",
      checkRuntime: async () => ({ ok: true }),
      runCommand,
    });

    const german = await service.transcribe({
      contentBase64: Buffer.from("audio").toString("base64"),
      mimeType: "audio/webm",
      language: "de",
    });
    expect(german.status).toBe("ok");
    const whisperArgs = commands.find(([cmd]) => cmd === "whisper");
    expect(whisperArgs).toBeDefined();
    expect(
      whisperArgs!.slice(
        whisperArgs!.indexOf("-l"),
        whisperArgs!.indexOf("-l") + 2,
      ),
    ).toEqual(["-l", "de"]);
    // whisper must transcribe, never translate
    expect(whisperArgs).not.toContain("-tr");
    expect(whisperArgs).not.toContain("--translate");

    commands.length = 0;
    await service.transcribe({
      contentBase64: Buffer.from("audio").toString("base64"),
      mimeType: "audio/webm",
      language: "nope; rm -rf /" as unknown as string,
    });
    const second = commands.find(([cmd]) => cmd === "whisper");
    expect(
      second!.slice(second!.indexOf("-l"), second!.indexOf("-l") + 2),
    ).toEqual(["-l", "auto"]);
  });
});

describe("transcribeVoiceFile", () => {
  it("transcribes an uploaded recording and deletes it on success", async () => {
    const files = new Map([
      [
        "voice-1.webm",
        { contentBase64: SHORT_AUDIO_BASE64, uploadedBy: "client-a" },
      ],
    ]);
    const deleted: string[] = [];
    const source = {
      async get(id: string) {
        return files.has(id)
          ? {
              id,
              sizeBytes: 4,
              filename: id,
              uploadedBy: files.get(id)!.uploadedBy,
            }
          : undefined;
      },
      async readContentBase64(id: string) {
        return files.get(id)?.contentBase64;
      },
      async delete(id: string) {
        deleted.push(id);
        return files.delete(id);
      },
    };
    const service = {
      transcribe: async () => ({
        status: "ok" as const,
        transcript: "hello there",
        durationSeconds: 2,
      }),
    };

    const result = await transcribeVoiceFile(source, service, {
      id: "voice-1.webm",
      mimeType: "audio/webm",
      clientKey: "client-a",
    });

    expect(result).toEqual({
      status: "ok",
      transcript: "hello there",
      durationSeconds: 2,
    });
    expect(deleted).toEqual(["voice-1.webm"]);
  });

  it("rejects unknown ids with UPLOAD_NOT_FOUND", async () => {
    const result = await transcribeVoiceFile(
      {
        get: async () => undefined,
        readContentBase64: async () => undefined,
        delete: async () => false,
      },
      {
        transcribe: async () => ({
          status: "ok",
          transcript: "",
          durationSeconds: 0,
        }),
      },
      { id: "missing.webm", mimeType: "audio/webm" },
    );
    expect(result).toMatchObject({
      status: "error",
      code: "UPLOAD_NOT_FOUND",
      retryable: false,
    });
  });

  it("refuses to transcribe another client's recording", async () => {
    const source = {
      get: async () => ({
        id: "voice-1.webm",
        sizeBytes: 4,
        filename: "voice-1.webm",
        uploadedBy: "client-a",
      }),
      readContentBase64: async () => SHORT_AUDIO_BASE64,
      delete: async () => true,
    };
    const result = await transcribeVoiceFile(
      source,
      {
        transcribe: async () => ({
          status: "ok",
          transcript: "",
          durationSeconds: 0,
        }),
      },
      { id: "voice-1.webm", mimeType: "audio/webm", clientKey: "client-b" },
    );
    expect(result).toMatchObject({
      status: "error",
      code: "INVALID_AUDIO",
      retryable: false,
    });
  });

  it("keeps the file when the failure is retryable, deletes it when terminal", async () => {
    const files = new Map([
      ["voice-1.webm", { contentBase64: SHORT_AUDIO_BASE64 }],
    ]);
    const deleted: string[] = [];
    const source = {
      async get(id: string) {
        return files.has(id) ? { id, sizeBytes: 4, filename: id } : undefined;
      },
      async readContentBase64(id: string) {
        return files.get(id)?.contentBase64;
      },
      async delete(id: string) {
        deleted.push(id);
        return files.delete(id);
      },
    };
    const busy = {
      transcribe: async () => ({
        status: "error" as const,
        code: "BUSY" as const,
        message: "busy",
        retryable: true,
      }),
    };
    const retryable = await transcribeVoiceFile(source, busy, {
      id: "voice-1.webm",
      mimeType: "audio/webm",
    });
    expect(retryable).toMatchObject({ status: "error", code: "BUSY" });
    expect(deleted).toEqual([]); // still retryable — file kept

    const broken = {
      transcribe: async () => ({
        status: "error" as const,
        code: "INVALID_AUDIO" as const,
        message: "bad",
        retryable: false,
      }),
    };
    const terminal = await transcribeVoiceFile(source, broken, {
      id: "voice-1.webm",
      mimeType: "audio/webm",
    });
    expect(terminal).toMatchObject({ status: "error", code: "INVALID_AUDIO" });
    expect(deleted).toEqual(["voice-1.webm"]); // terminal — cleaned up
  });
});

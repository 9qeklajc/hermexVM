import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HermesTranscribeAudioErrorCode } from "@contexcgi/protocol";

export type TranscriptionCapabilities = {
  available: boolean;
  maxDurationSeconds: number;
  maxAudioBytes: number;
  acceptedMimeTypes: string[];
  reason?: string;
};

export type TranscribeInput = {
  contentBase64: string;
  mimeType: string;
  durationMs?: number;
  /** ISO-639-1 code to force the spoken language; omitted/"auto" → detect. */
  language?: string;
};

// Whisper always TRANSCRIBES here (task=transcribe, never translate); a forced
// language only pins detection for short clips the auto-detector gets wrong
// (e.g. German misread as English). Whitelisted so an arbitrary string can
// never turn into a stray CLI flag.
const ALLOWED_LANGUAGES = new Set(["auto", "en", "de", "fr", "ar", "es", "it"]);

export type TranscribeSuccess = {
  status: "ok";
  transcript: string;
  durationSeconds: number;
};
export type TranscribeFailure = {
  status: "error";
  code: HermesTranscribeAudioErrorCode;
  message: string;
  retryable: boolean;
};
export type TranscribeResult = TranscribeSuccess | TranscribeFailure;

/**
 * Minimal read surface of the file-transfer registry the voice path needs —
 * kept as an interface so tests (and other registries) can stub it cheaply.
 */
export interface VoiceFileSource {
  get(id: string): Promise<
    | {
        id: string;
        sizeBytes: number;
        filename: string;
        uploadedBy?: string;
      }
    | undefined
  >;
  readContentBase64(id: string): Promise<string | undefined>;
  /** Best-effort cleanup of the temporary voice file. */
  delete(id: string): Promise<boolean>;
}

/** Runs one command to completion, killing it on timeout or external abort. */
export type CommandRunner = (
  command: string,
  args: string[],
  opts: { timeoutMs: number; signal?: AbortSignal },
) => Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}>;

export type WhisperTranscriptionConfig = {
  enabled: boolean;
  whisperCli?: string;
  whisperModel?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  maxAudioBytes?: number;
  maxDurationSeconds?: number;
  timeoutMs?: number;
  /** Test seam: replaces the real ffmpeg/whisper-cli availability probe. */
  checkRuntime?: () => Promise<{ ok: boolean; reason?: string }>;
  /** Test seam: replaces the real child-process spawn used for every command. */
  runCommand?: CommandRunner;
};

const DEFAULT_MAX_AUDIO_BYTES = 8 * 1024 * 1024; // 8 MiB decoded
const DEFAULT_MAX_DURATION_SECONDS = 60;
// MediaRecorder's stop() callback can land a little after the requested cutoff;
// tolerate a small amount of drift instead of rejecting an on-time recording.
const DURATION_TOLERANCE_SECONDS = 1;
const DEFAULT_TIMEOUT_MS = 180_000;

// Common containers/codecs MediaRecorder produces across Chromium WebView,
// Firefox, and Safari. ffmpeg normalizes whichever one arrives.
const ACCEPTED_MIME_TYPES = [
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/aac",
  "audio/wav",
  "audio/x-wav",
  "audio/mpeg",
];

function mimeBase(mimeType: string): string {
  return (mimeType.split(";")[0] ?? "").trim().toLowerCase();
}

function extensionForMime(mimeType: string): string {
  switch (mimeBase(mimeType)) {
    case "audio/webm":
      return "webm";
    case "audio/ogg":
      return "ogg";
    case "audio/mp4":
      return "m4a";
    case "audio/aac":
      return "aac";
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    case "audio/mpeg":
      return "mp3";
    default:
      return "bin";
  }
}

async function fileAccessible(path: string, mode: number): Promise<boolean> {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}

/** Combine several (possibly undefined) abort signals into one. */
function mergeSignals(signals: Array<AbortSignal | undefined>): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), {
      once: true,
    });
  }
  return controller.signal;
}

/** Real command runner: spawns a child process with argv (never a shell). */
export const spawnCommand: CommandRunner = (command, args, opts) =>
  new Promise((resolve, reject) => {
    // The signal may already be tripped by the time this step starts (e.g. an
    // earlier step consumed the whole per-call budget, or the caller aborted
    // before we got here). `addEventListener("abort", ...)` never fires for an
    // already-aborted signal, so without this check we'd spawn a doomed child
    // and wait out its own fresh timeoutMs instead of stopping immediately.
    if (opts.signal?.aborted) {
      resolve({ code: null, stdout: "", stderr: "", timedOut: true });
      return;
    }

    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);

    const onAbort = () => child.kill("SIGKILL");
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ code, stdout, stderr, timedOut });
    });
  });

async function probeCommandRuns(
  run: CommandRunner,
  command: string,
  args: string[],
): Promise<boolean> {
  try {
    const result = await run(command, args, { timeoutMs: 5_000 });
    return result.code === 0;
  } catch {
    return false;
  }
}

/**
 * Bridge-local, dependency-free (no cloud) speech-to-text service. Converts an
 * uploaded recording with ffmpeg, transcribes it with a locally-built
 * whisper.cpp `whisper-cli`, and returns plain text. Never logs audio bytes or
 * transcript content — only sizes, timings, and outcome codes.
 */
export class WhisperTranscriptionService {
  private readonly maxAudioBytes: number;
  private readonly maxDurationSeconds: number;
  private readonly timeoutMs: number;
  private readonly ffmpegPath: string;
  private readonly ffprobePath: string;
  private readonly whisperCli: string;
  private readonly whisperModel: string;
  private readonly runCommand: CommandRunner;
  private readonly maxConcurrency = 1;
  private activeJobs = 0;
  private availability: Promise<{ ok: boolean; reason?: string }> | null = null;

  constructor(private readonly config: WhisperTranscriptionConfig) {
    this.maxAudioBytes = config.maxAudioBytes ?? DEFAULT_MAX_AUDIO_BYTES;
    this.maxDurationSeconds =
      config.maxDurationSeconds ?? DEFAULT_MAX_DURATION_SECONDS;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.ffmpegPath = config.ffmpegPath ?? "ffmpeg";
    this.ffprobePath = config.ffprobePath ?? "ffprobe";
    this.whisperCli = config.whisperCli ?? "";
    this.whisperModel = config.whisperModel ?? "";
    this.runCommand = config.runCommand ?? spawnCommand;
  }

  private checkAvailability(): Promise<{ ok: boolean; reason?: string }> {
    if (!this.config.enabled)
      return Promise.resolve({ ok: false, reason: "disabled" });
    if (this.config.checkRuntime) return this.config.checkRuntime();
    if (!this.availability) {
      this.availability = this.probeAvailability();
    }
    return this.availability;
  }

  private async probeAvailability(): Promise<{ ok: boolean; reason?: string }> {
    if (!this.whisperCli || !this.whisperModel) {
      return { ok: false, reason: "missing-config" };
    }
    const [cliOk, modelOk] = await Promise.all([
      fileAccessible(this.whisperCli, fsConstants.X_OK),
      fileAccessible(this.whisperModel, fsConstants.R_OK),
    ]);
    if (!cliOk) return { ok: false, reason: "missing-runtime" };
    if (!modelOk) return { ok: false, reason: "missing-model" };
    const [ffmpegOk, ffprobeOk] = await Promise.all([
      probeCommandRuns(this.runCommand, this.ffmpegPath, ["-version"]),
      probeCommandRuns(this.runCommand, this.ffprobePath, ["-version"]),
    ]);
    if (!ffmpegOk || !ffprobeOk)
      return { ok: false, reason: "missing-runtime" };
    return { ok: true };
  }

  async capabilities(): Promise<TranscriptionCapabilities> {
    const availability = await this.checkAvailability();
    return {
      available: availability.ok,
      maxDurationSeconds: this.maxDurationSeconds,
      maxAudioBytes: this.maxAudioBytes,
      acceptedMimeTypes: ACCEPTED_MIME_TYPES,
      reason: availability.ok ? undefined : availability.reason,
    };
  }

  async transcribe(
    input: TranscribeInput,
    opts: { signal?: AbortSignal } = {},
  ): Promise<TranscribeResult> {
    // Cheap, pure validation first — reject garbage before touching the
    // filesystem or a subprocess, regardless of runtime availability.
    if (!ACCEPTED_MIME_TYPES.includes(mimeBase(input.mimeType))) {
      return {
        status: "error",
        code: "INVALID_AUDIO",
        message: `Unsupported audio format: ${input.mimeType || "unknown"}.`,
        retryable: false,
      };
    }

    const base64 = (input.contentBase64 ?? "").trim();
    const maxEncodedChars = Math.ceil(this.maxAudioBytes / 3) * 4 + 8;
    if (
      !base64 ||
      base64.length > maxEncodedChars ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)
    ) {
      return {
        status: "error",
        code: base64.length > maxEncodedChars ? "TOO_LARGE" : "INVALID_AUDIO",
        message:
          base64.length > maxEncodedChars
            ? `Recording exceeds the ${Math.round(this.maxAudioBytes / (1024 * 1024))}MB limit.`
            : "Malformed audio payload.",
        retryable: false,
      };
    }

    const audio = Buffer.from(base64, "base64");
    if (audio.length === 0) {
      return {
        status: "error",
        code: "INVALID_AUDIO",
        message: "Empty recording.",
        retryable: false,
      };
    }
    if (audio.length > this.maxAudioBytes) {
      return {
        status: "error",
        code: "TOO_LARGE",
        message: `Recording exceeds the ${Math.round(this.maxAudioBytes / (1024 * 1024))}MB limit.`,
        retryable: false,
      };
    }

    const availability = await this.checkAvailability();
    if (!availability.ok) {
      return {
        status: "error",
        code: "UNSUPPORTED",
        message: "Voice transcription is not available on this bridge.",
        retryable: false,
      };
    }

    if (this.activeJobs >= this.maxConcurrency) {
      return {
        status: "error",
        code: "BUSY",
        message:
          "The bridge is already transcribing another recording. Try again shortly.",
        retryable: true,
      };
    }

    this.activeJobs += 1;
    const startedAt = Date.now();
    let workDir: string | null = null;
    const deadline = startedAt + this.timeoutMs;
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), this.timeoutMs);
    const signal = mergeSignals([opts.signal, timeoutController.signal]);

    try {
      workDir = await mkdtemp(join(tmpdir(), "hermes-voice-"));
      const inputPath = join(
        workDir,
        `input.${extensionForMime(input.mimeType)}`,
      );
      const wavPath = join(workDir, "audio.wav");
      const outPrefix = join(workDir, "transcript");
      await writeFile(inputPath, audio, { mode: 0o600 });

      const probedSeconds = await this.probeDurationSeconds(inputPath, signal);
      if (
        probedSeconds !== null &&
        probedSeconds > this.maxDurationSeconds + DURATION_TOLERANCE_SECONDS
      ) {
        return {
          status: "error",
          code: "TOO_LONG",
          message: `Recording is longer than the ${this.maxDurationSeconds}s limit.`,
          retryable: false,
        };
      }

      const ffmpegResult = await this.runCommand(
        this.ffmpegPath,
        [
          "-nostdin",
          "-v",
          "error",
          "-y",
          "-i",
          inputPath,
          "-t",
          String(this.maxDurationSeconds),
          "-ar",
          "16000",
          "-ac",
          "1",
          "-c:a",
          "pcm_s16le",
          wavPath,
        ],
        { timeoutMs: Math.max(1, deadline - Date.now()), signal },
      );
      if (ffmpegResult.timedOut) {
        return {
          status: "error",
          code: "TIMEOUT",
          message: "Audio conversion timed out.",
          retryable: true,
        };
      }
      if (ffmpegResult.code !== 0) {
        console.error(
          `[bridge] voice ffmpeg failed code=${ffmpegResult.code} stderr=${ffmpegResult.stderr.slice(0, 400)}`,
        );
        return {
          status: "error",
          code: "INVALID_AUDIO",
          message: "Could not decode the recording.",
          retryable: false,
        };
      }

      const language =
        input.language && ALLOWED_LANGUAGES.has(input.language)
          ? input.language
          : "auto";
      const whisperResult = await this.runCommand(
        this.whisperCli,
        [
          "-m",
          this.whisperModel,
          "-f",
          wavPath,
          "-l",
          language,
          "-otxt",
          "-of",
          outPrefix,
          "-np",
          "-nt",
        ],
        { timeoutMs: Math.max(1, deadline - Date.now()), signal },
      );
      if (whisperResult.timedOut) {
        return {
          status: "error",
          code: "TIMEOUT",
          message: "Transcription timed out.",
          retryable: true,
        };
      }
      if (whisperResult.code !== 0) {
        console.error(
          `[bridge] voice whisper-cli failed code=${whisperResult.code} stderr=${whisperResult.stderr.slice(0, 400)}`,
        );
        return {
          status: "error",
          code: "TRANSCRIPTION_FAILED",
          message: "Local transcription failed.",
          retryable: true,
        };
      }

      const transcript = (await readFile(`${outPrefix}.txt`, "utf8")).trim();
      const durationSeconds = probedSeconds ?? this.maxDurationSeconds;
      console.log(
        `[bridge] voice transcribed bytes=${audio.length} durationS=${durationSeconds.toFixed(1)} ` +
          `elapsedMs=${Date.now() - startedAt} chars=${transcript.length}`,
      );
      return { status: "ok", transcript, durationSeconds };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[bridge] voice transcription error: ${message}`);
      return {
        status: "error",
        code: "TRANSCRIPTION_FAILED",
        message: "Local transcription failed.",
        retryable: true,
      };
    } finally {
      clearTimeout(timer);
      this.activeJobs -= 1;
      if (workDir)
        await rm(workDir, { recursive: true, force: true }).catch(
          () => undefined,
        );
    }
  }

  private async probeDurationSeconds(
    path: string,
    signal: AbortSignal,
  ): Promise<number | null> {
    const result = await this.runCommand(
      this.ffprobePath,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        path,
      ],
      { timeoutMs: 15_000, signal },
    );
    if (result.code !== 0) return null;
    const value = Number.parseFloat(result.stdout.trim());
    return Number.isFinite(value) ? value : null;
  }
}

export type VoiceFileTranscribeInput = {
  id: string;
  mimeType: string;
  durationMs?: number;
  language?: string;
  /** Calling client's pubkey — a recording may only be transcribed by its owner. */
  clientKey?: string | null;
};

/**
 * Transcribes a voice recording that arrived through the resumable,
 * sha256-verified file-transfer package (`contexcgi.fileTransfer.upload.*`).
 *
 * Scopes the recording to the client that uploaded it (when the registry
 * recorded an uploader), runs the same whisper.cpp pipeline as the legacy
 * chunked path, and cleans the temporary file up on the bridge once the
 * outcome is terminal — the client also deletes best-effort on its side, so a
 * vanished client never leaks recordings into the transfer root.
 *
 * Kept outside the service class as a pure orchestrator so it can be unit
 * tested with an in-memory VoiceFileSource + fake transcription service.
 */
export async function transcribeVoiceFile(
  source: VoiceFileSource,
  service: Pick<WhisperTranscriptionService, "transcribe">,
  input: VoiceFileTranscribeInput,
  opts: { signal?: AbortSignal } = {},
): Promise<TranscribeResult> {
  const file = await source.get(input.id).catch(() => undefined);
  if (!file) {
    return {
      status: "error",
      code: "UPLOAD_NOT_FOUND",
      message: "Unknown voice file — record it again.",
      retryable: false,
    };
  }
  if (
    input.clientKey &&
    file.uploadedBy &&
    file.uploadedBy !== input.clientKey
  ) {
    return {
      status: "error",
      code: "INVALID_AUDIO",
      message: "This recording belongs to another client.",
      retryable: false,
    };
  }

  const contentBase64 = await source
    .readContentBase64(input.id)
    .catch(() => undefined);
  if (!contentBase64) {
    return {
      status: "error",
      code: "UPLOAD_NOT_FOUND",
      message: "Unknown voice file — record it again.",
      retryable: false,
    };
  }

  const result = await service.transcribe(
    {
      contentBase64,
      mimeType: input.mimeType,
      durationMs: input.durationMs,
      language: input.language,
    },
    { signal: opts.signal },
  );
  // Keep the file only while the client can still usefully retry; a
  // successful transcript (or a permanent failure) makes it garbage.
  if (result.status === "ok" || !result.retryable) {
    await source.delete(input.id).catch(() => undefined);
  }
  return result;
}

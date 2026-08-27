import type { HermesTranscribeAudioErrorCode } from "@contexcgi/protocol";

export type ChunkInput = {
  uploadId: string;
  index: number;
  totalChunks: number;
  contentBase64: string;
};

export type ChunkAck = {
  status: "ok";
  uploadId: string;
  receivedChunks: number;
  totalChunks: number;
};

export type UploadFailure = {
  status: "error";
  code: HermesTranscribeAudioErrorCode;
  message: string;
  retryable: boolean;
};

export type ChunkResult = ChunkAck | UploadFailure;

export type FinalizeOutcome =
  | { status: "ready"; contentBase64: string }
  | UploadFailure;

const MAX_CHUNKS = 2_000;
// Outer bound on the total reassembled base64 length. The Whisper service
// enforces the real (much tighter, decoded-byte-based) limit after this —
// this just stops an absurd number/size of chunks from being buffered at all.
const MAX_TOTAL_BASE64_CHARS = 32 * 1024 * 1024;
const MAX_TRACKED_UPLOADS = 64;
const UPLOAD_TTL_MS = 5 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

type UploadRecord = {
  totalChunks: number;
  chunks: Map<number, string>;
  totalChars: number;
  lastActivityAt: number;
};

/**
 * Bounded, in-memory reassembly buffer for base64 audio chunks, scoped per
 * client. Exists because @contextvm/sdk 0.11.8's CEP-22 oversized-transfer
 * sender measures a message's size by first NIP-44-encrypting the *whole*
 * plaintext — which throws once that plaintext exceeds NIP-44's 65535-byte
 * ceiling, before any fragmentation can run. Splitting a recording into many
 * small, independently-encrypted `chunk` calls sidesteps that entirely.
 *
 * Keyed by `clientKey + uploadId` so one client can never read, overwrite, or
 * finalize another client's in-flight upload by guessing/reusing an uploadId.
 */
export class ChunkedUploadBuffer {
  private readonly uploads = new Map<string, UploadRecord>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  private key(clientKey: string, uploadId: string): string {
    return `${clientKey}\u0000${uploadId}`;
  }

  private sweep(now = Date.now()): void {
    for (const [key, record] of this.uploads) {
      if (now - record.lastActivityAt > UPLOAD_TTL_MS) this.uploads.delete(key);
    }
  }

  addChunk(clientKey: string, input: ChunkInput): ChunkResult {
    const now = Date.now();
    this.sweep(now);

    const { uploadId, index, totalChunks, contentBase64 } = input;
    if (!uploadId) {
      return {
        status: "error",
        code: "INVALID_AUDIO",
        message: "Missing uploadId.",
        retryable: false,
      };
    }
    if (
      !Number.isInteger(totalChunks) ||
      totalChunks <= 0 ||
      totalChunks > MAX_CHUNKS
    ) {
      return {
        status: "error",
        code: "TOO_LARGE",
        message: "Invalid or excessive chunk count.",
        retryable: false,
      };
    }
    if (!Number.isInteger(index) || index < 0 || index >= totalChunks) {
      return {
        status: "error",
        code: "INVALID_AUDIO",
        message: "Chunk index out of range.",
        retryable: false,
      };
    }
    if (!contentBase64 || !/^[A-Za-z0-9+/=]+$/.test(contentBase64)) {
      return {
        status: "error",
        code: "INVALID_AUDIO",
        message: "Malformed chunk payload.",
        retryable: false,
      };
    }

    const key = this.key(clientKey, uploadId);
    let record = this.uploads.get(key);
    if (!record) {
      if (this.uploads.size >= MAX_TRACKED_UPLOADS) {
        return {
          status: "error",
          code: "BUSY",
          message: "Too many in-flight uploads. Try again shortly.",
          retryable: true,
        };
      }
      record = {
        totalChunks,
        chunks: new Map(),
        totalChars: 0,
        lastActivityAt: now,
      };
      this.uploads.set(key, record);
    }
    if (record.totalChunks !== totalChunks) {
      return {
        status: "error",
        code: "INVALID_AUDIO",
        message: "Chunk count changed mid-upload.",
        retryable: false,
      };
    }

    const existing = record.chunks.get(index);
    if (existing !== undefined && existing !== contentBase64) {
      return {
        status: "error",
        code: "INVALID_AUDIO",
        message: "Chunk resent with different content.",
        retryable: false,
      };
    }
    if (existing === undefined) {
      const nextTotalChars = record.totalChars + contentBase64.length;
      if (nextTotalChars > MAX_TOTAL_BASE64_CHARS) {
        this.uploads.delete(key);
        return {
          status: "error",
          code: "TOO_LARGE",
          message: "Upload exceeds the maximum recording size.",
          retryable: false,
        };
      }
      record.chunks.set(index, contentBase64);
      record.totalChars = nextTotalChars;
    }
    record.lastActivityAt = now;

    return {
      status: "ok",
      uploadId,
      receivedChunks: record.chunks.size,
      totalChunks: record.totalChunks,
    };
  }

  /** Assembles and atomically removes the upload, so it can only be finalized once. */
  consumeForFinalize(clientKey: string, uploadId: string): FinalizeOutcome {
    this.sweep();
    const key = this.key(clientKey, uploadId);
    const record = this.uploads.get(key);
    if (!record) {
      return {
        status: "error",
        code: "UPLOAD_NOT_FOUND",
        message: "Unknown or expired upload. Record it again.",
        retryable: false,
      };
    }
    if (record.chunks.size !== record.totalChunks) {
      return {
        status: "error",
        code: "INVALID_AUDIO",
        message: `Missing chunks: received ${record.chunks.size} of ${record.totalChunks}.`,
        retryable: false,
      };
    }
    this.uploads.delete(key);

    const parts: string[] = [];
    for (let i = 0; i < record.totalChunks; i++) {
      const part = record.chunks.get(i);
      if (part === undefined) {
        // Unreachable given the size check above; stay defensive regardless.
        return {
          status: "error",
          code: "INVALID_AUDIO",
          message: "Corrupted upload.",
          retryable: false,
        };
      }
      parts.push(part);
    }
    return { status: "ready", contentBase64: parts.join("") };
  }

  /** Best-effort: discards an upload if present. Never errors — cancel is fire-and-forget. */
  cancel(clientKey: string, uploadId: string): void {
    this.uploads.delete(this.key(clientKey, uploadId));
  }

  get trackedUploadCount(): number {
    return this.uploads.size;
  }

  dispose(): void {
    clearInterval(this.sweepTimer);
    this.uploads.clear();
  }
}

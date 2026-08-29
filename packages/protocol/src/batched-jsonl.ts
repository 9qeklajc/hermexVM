const BATCH_MARKER = "contexcgi.jsonl.batch.v1";

/**
 * Shared CEP-22 settings for text-heavy ContextVM clients and bridges.
 * Requests/replies above the NIP-44-safe threshold are fragmented by the SDK.
 */
export const CONTEXTVM_OVERSIZED_TEXT_TRANSFER = {
  enabled: true,
  thresholdBytes: 48_000,
  chunkSizeBytes: 48_000,
  policy: {
    // JSON escaping can expand one UTF-8 text byte to six wire bytes (for
    // example NUL becomes "\\u0000"), so 8 MiB prompts need a 64 MiB cap.
    maxTransferBytes: 64 * 1024 * 1024,
    maxTransferChunks: 10_000,
  },
} as const;

/** Maximum UTF-8 bytes accepted for one user-authored text value. */
export const MAX_BATCHED_TEXT_BYTES = 8 * 1024 * 1024;
/** Conservative payload size for one CEP-41 stream notification. */
export const DEFAULT_JSONL_FRAME_BYTES = 24_000;

export type BatchedJsonlOptions = {
  maxFrameBytes?: number;
};

type BatchEnvelope = {
  $batch: typeof BATCH_MARKER;
  id: string;
  index: number;
  total: number;
  data: string;
};

type PendingBatch = {
  total: number;
  parts: Map<number, Uint8Array>;
  bytes: number;
};

let nextBatchId = 0;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

/**
 * Encode a JSON value as one or more independently bounded JSONL frames.
 * Oversized values use a generic envelope so any app can share this codec.
 */
export function encodeBatchedJsonl(
  value: unknown,
  options: BatchedJsonlOptions = {},
): string[] {
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_JSONL_FRAME_BYTES;
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 512) {
    throw new Error("maxFrameBytes must be an integer of at least 512 bytes");
  }

  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("Value is not JSON serializable");
  const direct = `${json}\n`;
  if (utf8ByteLength(direct) <= maxFrameBytes) return [direct];

  const bytes = textEncoder.encode(json);
  const id = `${Date.now().toString(36)}-${(nextBatchId++).toString(36)}`;
  // Base64 expands by 4/3. Reserve ample room for the JSON envelope, ids,
  // counters, quoting and the trailing newline, then verify every frame below.
  let rawChunkBytes = Math.max(1, Math.floor(((maxFrameBytes - 256) * 3) / 4));

  while (rawChunkBytes > 0) {
    const total = Math.ceil(bytes.byteLength / rawChunkBytes);
    const frames: string[] = [];
    for (let index = 0; index < total; index++) {
      const data = bytesToBase64(
        bytes.subarray(
          index * rawChunkBytes,
          Math.min((index + 1) * rawChunkBytes, bytes.byteLength),
        ),
      );
      const envelope: BatchEnvelope = {
        $batch: BATCH_MARKER,
        id,
        index,
        total,
        data,
      };
      frames.push(`${JSON.stringify(envelope)}\n`);
    }
    if (frames.every((frame) => utf8ByteLength(frame) <= maxFrameBytes)) {
      return frames;
    }
    rawChunkBytes -= Math.max(1, Math.ceil(rawChunkBytes / 16));
  }

  throw new Error("Unable to fit batched JSONL envelope within maxFrameBytes");
}

/** Stateful decoder for ordinary and batched JSONL values. */
export class BatchedJsonlDecoder<T = unknown> {
  private lineBuffer = "";
  private readonly pending = new Map<string, PendingBatch>();
  private readonly completed = new Set<string>();
  private pendingBytes = 0;

  constructor(
    private readonly limits: {
      maxValueBytes?: number;
      maxPendingBytes?: number;
      maxPendingBatches?: number;
      maxBatchChunks?: number;
      maxLineBytes?: number;
      maxBatchIdLength?: number;
      maxCompletedIds?: number;
    } = {},
  ) {}

  push(chunk: string): T[] {
    this.lineBuffer += chunk;
    const lines = this.lineBuffer.split("\n");
    this.lineBuffer = lines.pop() ?? "";
    const maxLineBytes = this.limits.maxLineBytes ?? 64 * 1024;
    if (utf8ByteLength(this.lineBuffer) > maxLineBytes) {
      this.lineBuffer = "";
      throw new Error("Batched JSONL line exceeds byte limit");
    }
    const values: T[] = [];
    for (const rawLine of lines) {
      if (utf8ByteLength(rawLine) > maxLineBytes) {
        throw new Error("Batched JSONL line exceeds byte limit");
      }
      const line = rawLine.trim();
      if (!line) continue;
      const parsed = JSON.parse(line) as unknown;
      if (hasBatchMarker(parsed) && !isBatchEnvelope(parsed)) {
        throw new Error("Malformed batched JSONL envelope");
      }
      if (!isBatchEnvelope(parsed)) {
        values.push(parsed as T);
        continue;
      }
      const completed = this.acceptBatchFrame(parsed);
      if (completed !== undefined) values.push(completed as T);
    }
    return values;
  }

  private acceptBatchFrame(envelope: BatchEnvelope): unknown | undefined {
    if (this.completed.has(envelope.id)) return undefined;
    if (envelope.id.length > (this.limits.maxBatchIdLength ?? 128)) {
      throw new Error("Batched JSONL id exceeds length limit");
    }
    if (envelope.total > (this.limits.maxBatchChunks ?? 10_000)) {
      throw new Error("Batched JSONL chunk count exceeds limit");
    }
    const maxPendingBatches = this.limits.maxPendingBatches ?? 8;
    let batch = this.pending.get(envelope.id);
    if (!batch) {
      if (this.pending.size >= maxPendingBatches) {
        throw new Error("Too many pending batched JSONL values");
      }
      batch = { total: envelope.total, parts: new Map(), bytes: 0 };
      this.pending.set(envelope.id, batch);
    } else if (batch.total !== envelope.total) {
      this.discardBatch(envelope.id, batch);
      throw new Error("Batched JSONL total changed mid-transfer");
    }

    if (!batch.parts.has(envelope.index)) {
      const bytes = base64ToBytes(envelope.data);
      const maxValueBytes = this.limits.maxValueBytes ?? 64 * 1024 * 1024;
      const maxPendingBytes = this.limits.maxPendingBytes ?? 64 * 1024 * 1024;
      if (batch.bytes + bytes.byteLength > maxValueBytes) {
        this.discardBatch(envelope.id, batch);
        throw new Error("Batched JSONL value exceeds byte limit");
      }
      if (this.pendingBytes + bytes.byteLength > maxPendingBytes) {
        this.discardBatch(envelope.id, batch);
        throw new Error("Pending batched JSONL data exceeds byte limit");
      }
      batch.parts.set(envelope.index, bytes);
      batch.bytes += bytes.byteLength;
      this.pendingBytes += bytes.byteLength;
    }
    if (batch.parts.size !== batch.total) return undefined;

    const combined = new Uint8Array(batch.bytes);
    let offset = 0;
    for (let index = 0; index < batch.total; index++) {
      const part = batch.parts.get(index);
      if (!part) return undefined;
      combined.set(part, offset);
      offset += part.byteLength;
    }
    this.discardBatch(envelope.id, batch);
    this.rememberCompleted(envelope.id);
    return JSON.parse(textDecoder.decode(combined)) as unknown;
  }

  private discardBatch(id: string, batch: PendingBatch): void {
    if (!this.pending.delete(id)) return;
    this.pendingBytes = Math.max(0, this.pendingBytes - batch.bytes);
  }

  private rememberCompleted(id: string): void {
    this.completed.add(id);
    const maxCompletedIds = this.limits.maxCompletedIds ?? 1_024;
    if (this.completed.size > maxCompletedIds) {
      const oldest = this.completed.values().next().value;
      if (typeof oldest === "string") this.completed.delete(oldest);
    }
  }
}

function hasBatchMarker(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).$batch === BATCH_MARKER
  );
}

function isBatchEnvelope(value: unknown): value is BatchEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.$batch === BATCH_MARKER &&
    typeof record.id === "string" &&
    record.id.length > 0 &&
    Number.isSafeInteger(record.index) &&
    (record.index as number) >= 0 &&
    Number.isSafeInteger(record.total) &&
    (record.total as number) > 0 &&
    (record.index as number) < (record.total as number) &&
    typeof record.data === "string"
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.byteLength; index++) {
    binary += String.fromCharCode(bytes[index]!);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

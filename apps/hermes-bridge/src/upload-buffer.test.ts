import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChunkedUploadBuffer } from "./upload-buffer.js";

describe("ChunkedUploadBuffer", () => {
  let buffer: ChunkedUploadBuffer;

  beforeEach(() => {
    buffer = new ChunkedUploadBuffer();
  });

  afterEach(() => {
    buffer.dispose();
    vi.useRealTimers();
  });

  it("reassembles chunks received in order", () => {
    buffer.addChunk("client-a", {
      uploadId: "u1",
      index: 0,
      totalChunks: 2,
      contentBase64: "AAAA",
    });
    buffer.addChunk("client-a", {
      uploadId: "u1",
      index: 1,
      totalChunks: 2,
      contentBase64: "BBBB",
    });

    expect(buffer.consumeForFinalize("client-a", "u1")).toEqual({
      status: "ready",
      contentBase64: "AAAABBBB",
    });
  });

  it("reassembles chunks received out of order, in index order", () => {
    buffer.addChunk("client-a", {
      uploadId: "u1",
      index: 2,
      totalChunks: 3,
      contentBase64: "CCCC",
    });
    buffer.addChunk("client-a", {
      uploadId: "u1",
      index: 0,
      totalChunks: 3,
      contentBase64: "AAAA",
    });
    buffer.addChunk("client-a", {
      uploadId: "u1",
      index: 1,
      totalChunks: 3,
      contentBase64: "BBBB",
    });

    expect(buffer.consumeForFinalize("client-a", "u1")).toEqual({
      status: "ready",
      contentBase64: "AAAABBBBCCCC",
    });
  });

  it("reassembles a large (>65535-char) upload split into many chunks exactly", () => {
    const original = Array.from({ length: 5 }, (_, i) =>
      String(i).repeat(20_000),
    ).join("");
    const chunkSize = 24_000;
    const totalChunks = Math.ceil(original.length / chunkSize);
    for (let index = 0; index < totalChunks; index++) {
      const contentBase64 = original.slice(
        index * chunkSize,
        (index + 1) * chunkSize,
      );
      const result = buffer.addChunk("client-a", {
        uploadId: "big",
        index,
        totalChunks,
        contentBase64,
      });
      expect(result.status).toBe("ok");
    }
    expect(buffer.consumeForFinalize("client-a", "big")).toEqual({
      status: "ready",
      contentBase64: original,
    });
  });

  it("is idempotent when the same chunk is resent with identical content", () => {
    buffer.addChunk("client-a", {
      uploadId: "u1",
      index: 0,
      totalChunks: 2,
      contentBase64: "AAAA",
    });
    const second = buffer.addChunk("client-a", {
      uploadId: "u1",
      index: 0,
      totalChunks: 2,
      contentBase64: "AAAA",
    });
    expect(second).toMatchObject({
      status: "ok",
      receivedChunks: 1,
      totalChunks: 2,
    });
  });

  it("rejects a resent chunk whose content differs from what was already stored", () => {
    buffer.addChunk("client-a", {
      uploadId: "u1",
      index: 0,
      totalChunks: 2,
      contentBase64: "AAAA",
    });
    const result = buffer.addChunk("client-a", {
      uploadId: "u1",
      index: 0,
      totalChunks: 2,
      contentBase64: "ZZZZ",
    });
    expect(result).toMatchObject({
      status: "error",
      code: "INVALID_AUDIO",
      retryable: false,
    });
  });

  it("rejects a chunk whose totalChunks disagrees with the upload's established value", () => {
    buffer.addChunk("client-a", {
      uploadId: "u1",
      index: 0,
      totalChunks: 2,
      contentBase64: "AAAA",
    });
    const result = buffer.addChunk("client-a", {
      uploadId: "u1",
      index: 1,
      totalChunks: 3,
      contentBase64: "BBBB",
    });
    expect(result).toMatchObject({
      status: "error",
      code: "INVALID_AUDIO",
      retryable: false,
    });
  });

  it.each([
    ["negative", -1],
    ["non-integer", 1.5],
    ["equal to totalChunks", 2],
    ["far beyond totalChunks", 99],
  ])("rejects an out-of-range index (%s)", (_label, index) => {
    const result = buffer.addChunk("client-a", {
      uploadId: "u1",
      index,
      totalChunks: 2,
      contentBase64: "AAAA",
    });
    expect(result).toMatchObject({
      status: "error",
      code: "INVALID_AUDIO",
      retryable: false,
    });
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["non-integer", 1.5],
    ["beyond the hard cap", 100_000],
  ])("rejects an invalid totalChunks (%s)", (_label, totalChunks) => {
    const result = buffer.addChunk("client-a", {
      uploadId: "u1",
      index: 0,
      totalChunks,
      contentBase64: "AAAA",
    });
    expect(result).toMatchObject({
      status: "error",
      code: "TOO_LARGE",
      retryable: false,
    });
  });

  it("rejects a chunk with characters outside the base64 alphabet", () => {
    const result = buffer.addChunk("client-a", {
      uploadId: "u1",
      index: 0,
      totalChunks: 1,
      contentBase64: "not base64!!",
    });
    expect(result).toMatchObject({
      status: "error",
      code: "INVALID_AUDIO",
      retryable: false,
    });
  });

  it("rejects an empty uploadId", () => {
    const result = buffer.addChunk("client-a", {
      uploadId: "",
      index: 0,
      totalChunks: 1,
      contentBase64: "AAAA",
    });
    expect(result).toMatchObject({
      status: "error",
      code: "INVALID_AUDIO",
      retryable: false,
    });
  });

  it("rejects and discards an upload once its reassembled size would exceed the cap", () => {
    const big = "A".repeat(20 * 1024 * 1024);
    const first = buffer.addChunk("client-a", {
      uploadId: "huge",
      index: 0,
      totalChunks: 2,
      contentBase64: big,
    });
    expect(first.status).toBe("ok");
    const second = buffer.addChunk("client-a", {
      uploadId: "huge",
      index: 1,
      totalChunks: 2,
      contentBase64: big,
    });
    expect(second).toMatchObject({
      status: "error",
      code: "TOO_LARGE",
      retryable: false,
    });

    // The oversized upload is gone entirely, not left half-buffered.
    const finalize = buffer.consumeForFinalize("client-a", "huge");
    expect(finalize).toMatchObject({
      status: "error",
      code: "UPLOAD_NOT_FOUND",
    });
  });

  it("reports missing chunks at finalize instead of assembling a partial result", () => {
    buffer.addChunk("client-a", {
      uploadId: "u1",
      index: 0,
      totalChunks: 2,
      contentBase64: "AAAA",
    });
    const result = buffer.consumeForFinalize("client-a", "u1");
    expect(result).toMatchObject({
      status: "error",
      code: "INVALID_AUDIO",
      retryable: false,
    });
    expect((result as { message: string }).message).toContain("1 of 2");
  });

  it("reports UPLOAD_NOT_FOUND for an unknown uploadId", () => {
    const result = buffer.consumeForFinalize("client-a", "does-not-exist");
    expect(result).toMatchObject({
      status: "error",
      code: "UPLOAD_NOT_FOUND",
      retryable: false,
    });
  });

  it("consumes an upload exactly once — a second finalize reports it unknown", () => {
    buffer.addChunk("client-a", {
      uploadId: "u1",
      index: 0,
      totalChunks: 1,
      contentBase64: "AAAA",
    });
    expect(buffer.consumeForFinalize("client-a", "u1").status).toBe("ready");
    expect(buffer.consumeForFinalize("client-a", "u1")).toMatchObject({
      status: "error",
      code: "UPLOAD_NOT_FOUND",
    });
  });

  it("cancel discards an upload; cancelling an unknown uploadId is a harmless no-op", () => {
    buffer.addChunk("client-a", {
      uploadId: "u1",
      index: 0,
      totalChunks: 1,
      contentBase64: "AAAA",
    });
    expect(() => buffer.cancel("client-a", "does-not-exist")).not.toThrow();
    buffer.cancel("client-a", "u1");
    expect(buffer.consumeForFinalize("client-a", "u1")).toMatchObject({
      status: "error",
      code: "UPLOAD_NOT_FOUND",
    });
  });

  it("scopes uploads per client — the same uploadId from two clients is two independent uploads", () => {
    buffer.addChunk("client-a", {
      uploadId: "shared",
      index: 0,
      totalChunks: 1,
      contentBase64: "AAAA",
    });
    buffer.addChunk("client-b", {
      uploadId: "shared",
      index: 0,
      totalChunks: 1,
      contentBase64: "ZZZZ",
    });

    expect(buffer.consumeForFinalize("client-a", "shared")).toEqual({
      status: "ready",
      contentBase64: "AAAA",
    });
    expect(buffer.consumeForFinalize("client-b", "shared")).toEqual({
      status: "ready",
      contentBase64: "ZZZZ",
    });
  });

  it("expires an upload after the TTL and frees its slot", () => {
    vi.useFakeTimers();
    try {
      buffer = new ChunkedUploadBuffer();
      buffer.addChunk("client-a", {
        uploadId: "stale",
        index: 0,
        totalChunks: 2,
        contentBase64: "AAAA",
      });
      expect(buffer.trackedUploadCount).toBe(1);

      vi.advanceTimersByTime(6 * 60 * 1000); // past the ~5 minute TTL
      // Lazy sweep runs on the next operation.
      const result = buffer.consumeForFinalize("client-a", "stale");

      expect(result).toMatchObject({
        status: "error",
        code: "UPLOAD_NOT_FOUND",
      });
      expect(buffer.trackedUploadCount).toBe(0);
    } finally {
      buffer.dispose();
    }
  });

  it("rejects a brand-new upload once the tracked-upload cap is reached, without disturbing in-progress ones", () => {
    let ok = 0;
    for (let i = 0; i < 64; i++) {
      const result = buffer.addChunk("client-a", {
        uploadId: `upload-${i}`,
        index: 0,
        totalChunks: 2,
        contentBase64: "AAAA",
      });
      if (result.status === "ok") ok += 1;
    }
    expect(ok).toBe(64);

    const overflow = buffer.addChunk("client-a", {
      uploadId: "one-too-many",
      index: 0,
      totalChunks: 1,
      contentBase64: "AAAA",
    });
    expect(overflow).toMatchObject({
      status: "error",
      code: "BUSY",
      retryable: true,
    });

    // Continuing an already-tracked upload (not creating a new one) still works at capacity.
    const continued = buffer.addChunk("client-a", {
      uploadId: "upload-0",
      index: 1,
      totalChunks: 2,
      contentBase64: "BBBB",
    });
    expect(continued).toMatchObject({ status: "ok", receivedChunks: 2 });
  });

  it("dispose() clears all buffered uploads and stops the sweep timer", () => {
    buffer.addChunk("client-a", {
      uploadId: "u1",
      index: 0,
      totalChunks: 1,
      contentBase64: "AAAA",
    });
    expect(buffer.trackedUploadCount).toBe(1);
    buffer.dispose();
    expect(buffer.trackedUploadCount).toBe(0);
  });
});

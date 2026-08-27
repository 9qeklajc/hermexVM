import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileTransferRegistry,
  DEFAULT_CHUNK_BYTES,
} from "./file-transfer-registry.js";

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

describe("FileTransferRegistry", () => {
  it("lists files with manifest metadata, category, and sha256 digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "contexcgi-ft-"));
    try {
      const bytes = Buffer.from("fake apk content for transfer");
      const path = join(root, "android", "agent.apk");
      await mkdir(join(root, "android"));
      await writeFile(path, bytes);
      const arrivedAt = (await stat(path)).birthtime.toISOString();
      await utimes(
        path,
        new Date("2000-01-01T00:00:00.000Z"),
        new Date("2000-01-01T00:00:00.000Z"),
      );
      await writeFile(
        `${path}.json`,
        JSON.stringify({
          name: "Agent App",
          version: "1.2.3",
          platform: "android",
          architecture: "arm64-v8a",
          channel: "beta",
          description: "Mobile agent app",
        }),
      );

      const files = await new FileTransferRegistry({ root }).list({
        category: "apk",
        platform: "android",
        channel: "beta",
      });

      expect(files).toEqual([
        expect.objectContaining({
          id: "android/agent.apk",
          name: "Agent App",
          version: "1.2.3",
          platform: "android",
          architecture: "arm64-v8a",
          channel: "beta",
          filename: "agent.apk",
          sizeBytes: bytes.length,
          sha256: sha256(bytes),
          mimeType: "application/vnd.android.package-archive",
          category: "apk",
          createdAt: arrivedAt,
        }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("supports an application-specific filename policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "contexcgi-ft-"));
    try {
      await writeFile(join(root, ".bashrc"), Buffer.from("export TEST=1\n"));
      const defaultRegistry = new FileTransferRegistry({ root });
      expect(await defaultRegistry.get(".bashrc")).toBeUndefined();
      const browserRegistry = new FileTransferRegistry({
        root,
        acceptFilename: () => true,
      });
      expect((await browserRegistry.get(".bashrc"))?.filename).toBe(".bashrc");
      expect(
        (await browserRegistry.list()).map((file) => file.filename),
      ).toEqual([".bashrc"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("invalidates the cached digest when a file changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "contexcgi-ft-"));
    try {
      const path = join(root, "changing.bin");
      const original = Buffer.from("original");
      const replacement = Buffer.from("replacement content");
      await writeFile(path, original);
      const registry = new FileTransferRegistry({ root });

      expect((await registry.get("changing.bin"))?.sha256).toBe(
        sha256(original),
      );
      await writeFile(path, replacement);
      expect((await registry.get("changing.bin"))?.sha256).toBe(
        sha256(replacement),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("infers category for archive, image, video, and document files", async () => {
    const root = await mkdtemp(join(tmpdir(), "contexcgi-ft-"));
    try {
      const cases: Array<{ name: string; category: string }> = [
        { name: "release.zip", category: "archive" },
        { name: "photo.jpg", category: "image" },
        { name: "clip.mp4", category: "video" },
        { name: "manual.pdf", category: "document" },
        { name: "notes.md", category: "document" },
        { name: "tune.mp3", category: "audio" },
        { name: "payload.bin", category: "binary" },
      ];
      for (const c of cases) {
        await writeFile(join(root, c.name), Buffer.from(c.name));
      }
      const files = await new FileTransferRegistry({ root }).list();
      const byName = new Map(files.map((f) => [f.filename, f]));
      for (const c of cases) {
        expect(byName.get(c.name)?.category).toBe(c.category);
      }
      expect(byName.get("notes.md")?.mimeType).toBe("text/markdown");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects file ids that escape the configured root", async () => {
    const root = await mkdtemp(join(tmpdir(), "contexcgi-ft-"));
    try {
      const registry = new FileTransferRegistry({ root });
      await expect(registry.get("../secret.apk")).rejects.toThrow(
        "escapes root",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not list or read files through symlinks outside the root", async () => {
    const root = await mkdtemp(join(tmpdir(), "contexcgi-ft-root-"));
    const outside = await mkdtemp(join(tmpdir(), "contexcgi-ft-outside-"));
    try {
      const secret = Buffer.from("not shared");
      await writeFile(join(outside, "secret.bin"), secret);
      await symlink(join(outside, "secret.bin"), join(root, "escape.bin"));
      await symlink(outside, join(root, "escape-dir"));

      const registry = new FileTransferRegistry({ root });
      expect(await registry.list()).toEqual([]);
      await expect(registry.get("escape.bin")).rejects.toThrow(
        "resolves outside root",
      );
      await expect(
        registry.readRangeBase64({
          id: "escape-dir/secret.bin",
          offsetBytes: 0,
          lengthBytes: secret.length,
        }),
      ).rejects.toThrow("resolves outside root");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("reads a byte range as base64", async () => {
    const root = await mkdtemp(join(tmpdir(), "contexcgi-ft-"));
    try {
      const bytes = Buffer.from("0123456789abcdef");
      await writeFile(join(root, "data.bin"), bytes);
      const registry = new FileTransferRegistry({ root });
      const result = await registry.readRangeBase64({
        id: "data.bin",
        offsetBytes: 4,
        lengthBytes: 8,
      });
      expect(result).toBe(bytes.subarray(4, 12).toString("base64"));
      await expect(
        registry.readRangeBase64({
          id: "data.bin",
          offsetBytes: bytes.length + 1,
          lengthBytes: 1,
        }),
      ).rejects.toThrow("offset exceeds file size");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("deletes a file and its manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "contexcgi-ft-"));
    try {
      const bytes = Buffer.from("delete me");
      const path = join(root, "target.apk");
      await writeFile(path, bytes);
      await writeFile(`${path}.json`, "{}");
      const registry = new FileTransferRegistry({ root });
      const deleted = await registry.delete("target.apk");
      expect(deleted).toBe(true);
      await expect(stat(path)).rejects.toThrow();
      await expect(stat(`${path}.json`)).rejects.toThrow();
      expect(await registry.delete("target.apk")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uploads a file in chunks, finalizes, and verifies the sha256", async () => {
    const root = await mkdtemp(join(tmpdir(), "contexcgi-ft-"));
    try {
      const registry = new FileTransferRegistry({ root });
      const payload = Buffer.from(
        "ContextVM file transfer chunked upload test payload!",
      );
      const sha = sha256(payload);
      const init = await registry.initUpload({
        filename: "upload.bin",
        sizeBytes: payload.byteLength,
        sha256: sha,
        manifest: { platform: "linux", category: "binary" },
      });
      const chunkSize = init.chunkSizeBytes;
      const total = init.totalChunks;
      let received = 0;
      for (let i = 0; i < total; i++) {
        const slice = payload.subarray(
          i * chunkSize,
          Math.min((i + 1) * chunkSize, payload.byteLength),
        );
        const ack = await registry.uploadChunk({
          uploadId: init.uploadId,
          index: i,
          totalChunks: total,
          contentBase64: slice.toString("base64"),
        });
        received = ack.receivedChunks;
      }
      expect(received).toBe(total);
      const file = await registry.finalizeUpload(init.uploadId);
      expect(file.filename).toBe("upload.bin");
      expect(file.sizeBytes).toBe(payload.byteLength);
      expect(file.sha256).toBe(sha);
      expect(file.platform).toBe("linux");
      expect(file.category).toBe("binary");
      // persisted file matches
      const onDisk = await readFile(join(root, "upload.bin"));
      expect(onDisk.equals(payload)).toBe(true);
      // manifest persisted
      const manifest = JSON.parse(
        await readFile(join(root, "upload.bin.json"), "utf8"),
      ) as { platform: string };
      expect(manifest.platform).toBe("linux");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an upload when the size exceeds the limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "contexcgi-ft-"));
    try {
      const registry = new FileTransferRegistry({
        root,
        maxFileBytes: 16,
      });
      await expect(
        registry.initUpload({
          filename: "big.bin",
          sizeBytes: 1024,
          sha256: "a".repeat(64),
        }),
      ).rejects.toThrow(/exceeds limit/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an upload finalize when checksum mismatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "contexcgi-ft-"));
    try {
      const registry = new FileTransferRegistry({
        root,
        chunkBytes: 8,
      });
      const payload = Buffer.from("mismatch payload here");
      const init = await registry.initUpload({
        filename: "bad.bin",
        sizeBytes: payload.byteLength,
        sha256: "0".repeat(64), // wrong sha
      });
      const total = init.totalChunks;
      for (let i = 0; i < total; i++) {
        await registry.uploadChunk({
          uploadId: init.uploadId,
          index: i,
          totalChunks: total,
          contentBase64: payload
            .subarray(
              i * init.chunkSizeBytes,
              Math.min((i + 1) * init.chunkSizeBytes, payload.byteLength),
            )
            .toString("base64"),
        });
      }
      await expect(registry.finalizeUpload(init.uploadId)).rejects.toThrow(
        /checksum mismatch/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects finalize when chunks are incomplete", async () => {
    const root = await mkdtemp(join(tmpdir(), "contexcgi-ft-"));
    try {
      const registry = new FileTransferRegistry({
        root,
        chunkBytes: 4,
      });
      const payload = Buffer.from("incomplete");
      const init = await registry.initUpload({
        filename: "partial.bin",
        sizeBytes: payload.byteLength,
        sha256: sha256(payload),
      });
      // send only first chunk
      await registry.uploadChunk({
        uploadId: init.uploadId,
        index: 0,
        totalChunks: init.totalChunks,
        contentBase64: payload.subarray(0, 4).toString("base64"),
      });
      await expect(registry.finalizeUpload(init.uploadId)).rejects.toThrow(
        /incomplete/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects chunks with wrong size", async () => {
    const root = await mkdtemp(join(tmpdir(), "contexcgi-ft-"));
    try {
      const registry = new FileTransferRegistry({
        root,
        chunkBytes: DEFAULT_CHUNK_BYTES,
      });
      const payload = Buffer.alloc(DEFAULT_CHUNK_BYTES * 2, 0x42);
      const init = await registry.initUpload({
        filename: "sized.bin",
        sizeBytes: payload.byteLength,
        sha256: sha256(payload),
      });
      await expect(
        registry.uploadChunk({
          uploadId: init.uploadId,
          index: 0,
          totalChunks: init.totalChunks,
          contentBase64: Buffer.alloc(10).toString("base64"),
        }),
      ).rejects.toThrow(/size/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("handles duplicate chunk uploads idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "contexcgi-ft-"));
    try {
      const registry = new FileTransferRegistry({
        root,
        chunkBytes: 4,
      });
      const payload = Buffer.from("duplicate test");
      const init = await registry.initUpload({
        filename: "dup.bin",
        sizeBytes: payload.byteLength,
        sha256: sha256(payload),
      });
      const total = init.totalChunks;
      for (let i = 0; i < total; i++) {
        await registry.uploadChunk({
          uploadId: init.uploadId,
          index: i,
          totalChunks: total,
          contentBase64: payload
            .subarray(
              i * init.chunkSizeBytes,
              Math.min((i + 1) * init.chunkSizeBytes, payload.byteLength),
            )
            .toString("base64"),
        });
      }
      // resend a chunk
      const ack = await registry.uploadChunk({
        uploadId: init.uploadId,
        index: 0,
        totalChunks: total,
        contentBase64: payload.subarray(0, 4).toString("base64"),
      });
      expect(ack.receivedChunks).toBe(total);
      const file = await registry.finalizeUpload(init.uploadId);
      expect(file.sha256).toBe(sha256(payload));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts concurrent duplicate chunks idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "contexcgi-ft-"));
    try {
      const registry = new FileTransferRegistry({ root, chunkBytes: 4 });
      const payload = Buffer.from("race");
      const init = await registry.initUpload({
        filename: "race.bin",
        sizeBytes: payload.byteLength,
        sha256: sha256(payload),
      });
      const chunk = {
        uploadId: init.uploadId,
        index: 0,
        totalChunks: 1,
        contentBase64: payload.toString("base64"),
      };
      await expect(
        Promise.all([registry.uploadChunk(chunk), registry.uploadChunk(chunk)]),
      ).resolves.toHaveLength(2);
      await expect(
        registry.finalizeUpload(init.uploadId),
      ).resolves.toMatchObject({ sha256: sha256(payload) });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("supports out-of-order chunk uploads", async () => {
    const root = await mkdtemp(join(tmpdir(), "contexcgi-ft-"));
    try {
      const registry = new FileTransferRegistry({
        root,
        chunkBytes: 4,
      });
      const payload = Buffer.from("outoforder test data!!!");
      const init = await registry.initUpload({
        filename: "ooo.bin",
        sizeBytes: payload.byteLength,
        sha256: sha256(payload),
      });
      const total = init.totalChunks;
      const indices = Array.from({ length: total }, (_, i) => i).reverse();
      for (const i of indices) {
        await registry.uploadChunk({
          uploadId: init.uploadId,
          index: i,
          totalChunks: total,
          contentBase64: payload
            .subarray(
              i * init.chunkSizeBytes,
              Math.min((i + 1) * init.chunkSizeBytes, payload.byteLength),
            )
            .toString("base64"),
        });
      }
      const file = await registry.finalizeUpload(init.uploadId);
      expect(file.sha256).toBe(sha256(payload));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("makes retried init and finalize idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "contexcgi-ft-"));
    try {
      const registry = new FileTransferRegistry({ root, chunkBytes: 4 });
      const payload = Buffer.from("idempotent");
      const request = {
        requestId: "00000000-0000-4000-8000-000000000001",
        filename: "idempotent.bin",
        sizeBytes: payload.byteLength,
        sha256: sha256(payload),
      };
      const first = await registry.initUpload(request, "client-a");
      const retried = await registry.initUpload(request, "client-a");
      expect(retried.uploadId).toBe(first.uploadId);
      for (let index = 0; index < first.totalChunks; index++) {
        await registry.uploadChunk(
          {
            uploadId: first.uploadId,
            index,
            totalChunks: first.totalChunks,
            contentBase64: payload
              .subarray(index * 4, Math.min((index + 1) * 4, payload.length))
              .toString("base64"),
          },
          "client-a",
        );
      }
      const file = await registry.finalizeUpload(first.uploadId, "client-a");
      const reconstructed = new FileTransferRegistry({ root, chunkBytes: 4 });
      await expect(
        reconstructed.finalizeUpload(first.uploadId, "client-a"),
      ).resolves.toEqual(file);
      await expect(
        reconstructed.finalizeUpload(first.uploadId, "client-b"),
      ).rejects.toThrow(/another client/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enforces pending upload count and staged-byte quotas", async () => {
    const root = await mkdtemp(join(tmpdir(), "contexcgi-ft-"));
    try {
      const registry = new FileTransferRegistry({
        root,
        maxPendingUploads: 1,
        maxStagedBytes: 8,
      });
      await registry.initUpload({
        filename: "one.bin",
        sizeBytes: 8,
        sha256: "a".repeat(64),
      });
      await expect(
        registry.initUpload({
          filename: "two.bin",
          sizeBytes: 1,
          sha256: "b".repeat(64),
        }),
      ).rejects.toThrow(/pending uploads|staged-byte limit/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects direct status, chunk, and finalize calls after expiry", async () => {
    const root = await mkdtemp(join(tmpdir(), "contexcgi-ft-"));
    try {
      const registry = new FileTransferRegistry({ root, uploadTimeoutMs: 1 });
      const payload = Buffer.from("expired");
      const init = await registry.initUpload({
        filename: "expired.bin",
        sizeBytes: payload.byteLength,
        sha256: sha256(payload),
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await expect(registry.uploadStatus(init.uploadId)).rejects.toThrow(
        /not found/,
      );
      await expect(
        registry.uploadChunk({
          uploadId: init.uploadId,
          index: 0,
          totalChunks: init.totalChunks,
          contentBase64: payload.toString("base64"),
        }),
      ).rejects.toThrow(/not found/);
      await expect(registry.finalizeUpload(init.uploadId)).rejects.toThrow(
        /not found/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers durable chunks after reconstruction and scopes them to the owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "contexcgi-ft-"));
    try {
      const payload = Buffer.from("durable resume");
      const first = new FileTransferRegistry({ root, chunkBytes: 4 });
      const init = await first.initUpload(
        {
          filename: "resume.bin",
          sizeBytes: payload.byteLength,
          sha256: sha256(payload),
        },
        "client-a",
      );
      await first.uploadChunk(
        {
          uploadId: init.uploadId,
          index: 0,
          totalChunks: init.totalChunks,
          contentBase64: payload.subarray(0, 4).toString("base64"),
        },
        "client-a",
      );

      const recovered = new FileTransferRegistry({ root, chunkBytes: 4 });
      await expect(
        recovered.uploadStatus(init.uploadId, "client-b"),
      ).rejects.toThrow(/another client/);
      await expect(recovered.uploadStatus(init.uploadId)).rejects.toThrow(
        /another client/,
      );
      await expect(
        recovered.uploadStatus(init.uploadId, "client-a"),
      ).resolves.toMatchObject({
        filename: "resume.bin",
        sizeBytes: payload.byteLength,
        sha256: sha256(payload),
        receivedChunkIndices: [0],
      });
      for (let index = 1; index < init.totalChunks; index++) {
        await recovered.uploadChunk(
          {
            uploadId: init.uploadId,
            index,
            totalChunks: init.totalChunks,
            contentBase64: payload
              .subarray(
                index * 4,
                Math.min((index + 1) * 4, payload.byteLength),
              )
              .toString("base64"),
          },
          "client-a",
        );
      }
      await expect(
        recovered.finalizeUpload(init.uploadId, "client-a"),
      ).resolves.toMatchObject({
        filename: "resume.bin",
        uploadedBy: "client-a",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("evicts expired pending uploads", async () => {
    const root = await mkdtemp(join(tmpdir(), "contexcgi-ft-"));
    try {
      const registry = new FileTransferRegistry({
        root,
        uploadTimeoutMs: 1,
      });
      const payload = Buffer.from("expires");
      const init = await registry.initUpload({
        filename: "e.bin",
        sizeBytes: payload.byteLength,
        sha256: sha256(payload),
      });
      // force expiry
      await new Promise((r) => setTimeout(r, 10));
      // listing triggers eviction
      await registry.list();
      expect(await registry.pendingUploadCount()).toBe(0);
      // finalize on evicted upload fails
      await expect(registry.finalizeUpload(init.uploadId)).rejects.toThrow(
        /not found/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function mkdir(dir: string): Promise<void> {
  const { mkdir: md } = await import("node:fs/promises");
  await md(dir, { recursive: true });
}

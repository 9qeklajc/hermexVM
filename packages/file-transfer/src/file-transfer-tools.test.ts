import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
  FILE_TRANSFER_DELETE_TOOL_NAME,
  FILE_TRANSFER_DOWNLOAD_RANGE_TOOL_NAME,
  FILE_TRANSFER_DOWNLOAD_STREAM_TOOL_NAME,
  FILE_TRANSFER_DOWNLOAD_TOOL_NAME,
  FILE_TRANSFER_GET_TOOL_NAME,
  FILE_TRANSFER_LIST_TOOL_NAME,
  FILE_TRANSFER_UPLOAD_CANCEL_TOOL_NAME,
  FILE_TRANSFER_UPLOAD_CHUNK_TOOL_NAME,
  FILE_TRANSFER_UPLOAD_FINALIZE_TOOL_NAME,
  FILE_TRANSFER_UPLOAD_INIT_TOOL_NAME,
  FILE_TRANSFER_UPLOAD_STATUS_TOOL_NAME,
} from "@contexcgi/protocol";
import { FileTransferRegistry } from "./file-transfer-registry.js";
import { registerFileTransferTools } from "./file-transfer-tools.js";

type ToolHandler = (
  args: Record<string, unknown>,
  extra?: { _meta?: Record<string, unknown> },
) => Promise<CallToolResult>;

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

describe("registerFileTransferTools", () => {
  it("registers list, get, download, stream, and range tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "contexcgi-ft-tools-"));
    try {
      const bytes = Buffer.from("file over nostr");
      await writeFile(join(root, "agent.apk"), bytes);
      await writeFile(
        join(root, "agent.apk.json"),
        JSON.stringify({ name: "Agent APK", version: "2.0.0" }),
      );
      const handlers = new Map<string, ToolHandler>();
      const server = {
        registerTool(
          name: string,
          _definition: unknown,
          handler: ToolHandler,
        ): void {
          handlers.set(name, handler);
        },
      };

      registerFileTransferTools({
        server: server as never,
        registry: new FileTransferRegistry({ root }),
      });

      const list = await handlers.get(FILE_TRANSFER_LIST_TOOL_NAME)?.({
        category: "apk",
      });
      expect(list).toMatchObject({
        structuredContent: {
          files: [expect.objectContaining({ id: "agent.apk" })],
        },
      });

      const get = await handlers.get(FILE_TRANSFER_GET_TOOL_NAME)?.({
        id: "agent.apk",
      });
      expect(get).toMatchObject({
        structuredContent: {
          file: expect.objectContaining({ name: "Agent APK" }),
        },
      });

      // range download
      const range = await handlers.get(
        FILE_TRANSFER_DOWNLOAD_RANGE_TOOL_NAME,
      )?.({
        id: "agent.apk",
        offsetBytes: 0,
        lengthBytes: 16,
      });
      expect(range).toMatchObject({
        structuredContent: {
          file: expect.objectContaining({ filename: "agent.apk" }),
          encoding: "base64",
          contentBase64: bytes.subarray(0, 16).toString("base64"),
          sha256: sha256(bytes),
        },
      });

      // stream download
      const streamedChunks: string[] = [];
      const streamDownload = await handlers.get(
        FILE_TRANSFER_DOWNLOAD_STREAM_TOOL_NAME,
      )?.(
        { id: "agent.apk" },
        {
          _meta: {
            stream: {
              write: (data: string) => streamedChunks.push(data),
              close: () => undefined,
            },
          },
        },
      );
      expect(streamedChunks.join("")).toBe(bytes.toString("base64"));
      expect(streamDownload).toMatchObject({
        structuredContent: {
          file: expect.objectContaining({ filename: "agent.apk" }),
          encoding: "base64",
          streamed: true,
          sha256: sha256(bytes),
        },
      });

      // full download
      const download = await handlers.get(FILE_TRANSFER_DOWNLOAD_TOOL_NAME)?.({
        id: "agent.apk",
      });
      expect(download).toMatchObject({
        structuredContent: {
          file: expect.objectContaining({ filename: "agent.apk" }),
          encoding: "base64",
          contentBase64: bytes.toString("base64"),
          sha256: sha256(bytes),
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("supports chunked upload via init → chunk → finalize", async () => {
    const root = await mkdtemp(join(tmpdir(), "contexcgi-ft-tools-"));
    try {
      const handlers = new Map<string, ToolHandler>();
      const server = {
        registerTool(
          name: string,
          _definition: unknown,
          handler: ToolHandler,
        ): void {
          handlers.set(name, handler);
        },
      };
      const registry = new FileTransferRegistry({
        root,
        chunkBytes: 8,
      });
      registerFileTransferTools({
        server: server as never,
        registry,
      });

      const payload = Buffer.from("chunked upload integration test payload!");
      const sha = sha256(payload);

      const requestId = "00000000-0000-4000-8000-000000000002";
      const init = await handlers.get(FILE_TRANSFER_UPLOAD_INIT_TOOL_NAME)?.({
        requestId,
        filename: "upload.bin",
        sizeBytes: payload.byteLength,
        sha256: sha,
        platform: "linux",
        category: "binary",
      });
      expect(init).toMatchObject({
        structuredContent: {
          uploadId: requestId,
          chunkSizeBytes: 8,
          totalChunks: Math.ceil(payload.byteLength / 8),
        },
      });
      const uploadId = (init?.structuredContent as { uploadId: string })
        .uploadId;
      const totalChunks = (init?.structuredContent as { totalChunks: number })
        .totalChunks;
      const chunkSize = (init?.structuredContent as { chunkSizeBytes: number })
        .chunkSizeBytes;

      for (let i = 0; i < totalChunks; i++) {
        const slice = payload.subarray(
          i * chunkSize,
          Math.min((i + 1) * chunkSize, payload.byteLength),
        );
        const ack = await handlers.get(FILE_TRANSFER_UPLOAD_CHUNK_TOOL_NAME)?.({
          uploadId,
          index: i,
          totalChunks,
          contentBase64: slice.toString("base64"),
        });
        expect(ack).toMatchObject({
          structuredContent: {
            status: "ok",
            receivedChunks: i + 1,
            totalChunks,
          },
        });
      }

      const status = await handlers.get(
        FILE_TRANSFER_UPLOAD_STATUS_TOOL_NAME,
      )?.({ uploadId });
      expect(status).toMatchObject({
        structuredContent: {
          receivedChunks: totalChunks,
          receivedChunkIndices: Array.from(
            { length: totalChunks },
            (_, i) => i,
          ),
        },
      });

      const finalize = await handlers.get(
        FILE_TRANSFER_UPLOAD_FINALIZE_TOOL_NAME,
      )?.({ uploadId });
      expect(finalize).toMatchObject({
        structuredContent: {
          status: "ok",
          file: expect.objectContaining({
            filename: "upload.bin",
            sizeBytes: payload.byteLength,
            sha256: sha,
            platform: "linux",
            category: "binary",
          }),
        },
      });
      const finalizeRetry = await handlers.get(
        FILE_TRANSFER_UPLOAD_FINALIZE_TOOL_NAME,
      )?.({ uploadId });
      expect(finalizeRetry?.structuredContent).toEqual(
        finalize?.structuredContent,
      );

      // cancel an unknown upload is a no-op success
      const cancel = await handlers.get(
        FILE_TRANSFER_UPLOAD_CANCEL_TOOL_NAME,
      )?.({
        uploadId: "never-existed",
      });
      expect(cancel).toMatchObject({
        structuredContent: { status: "ok" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("delete tool removes a file", async () => {
    const root = await mkdtemp(join(tmpdir(), "contexcgi-ft-tools-"));
    try {
      const bytes = Buffer.from("to delete");
      await writeFile(join(root, "del.apk"), bytes);
      const handlers = new Map<string, ToolHandler>();
      const server = {
        registerTool(
          name: string,
          _definition: unknown,
          handler: ToolHandler,
        ): void {
          handlers.set(name, handler);
        },
      };
      registerFileTransferTools({
        server: server as never,
        registry: new FileTransferRegistry({ root }),
      });
      const result = await handlers.get(FILE_TRANSFER_DELETE_TOOL_NAME)?.({
        id: "del.apk",
      });
      expect(result).toMatchObject({
        structuredContent: { id: "del.apk", deleted: true },
      });
      const second = await handlers.get(FILE_TRANSFER_DELETE_TOOL_NAME)?.({
        id: "del.apk",
      });
      expect(second).toMatchObject({
        structuredContent: { id: "del.apk", deleted: false },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("omits every mutation tool in read-only mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "contexcgi-ft-tools-"));
    try {
      const handlers = new Map<string, ToolHandler>();
      const server = {
        registerTool(
          name: string,
          _definition: unknown,
          handler: ToolHandler,
        ): void {
          handlers.set(name, handler);
        },
      };
      registerFileTransferTools({
        server: server as never,
        registry: new FileTransferRegistry({ root }),
        readOnly: true,
      });

      expect([...handlers.keys()].sort()).toEqual(
        [
          FILE_TRANSFER_LIST_TOOL_NAME,
          FILE_TRANSFER_GET_TOOL_NAME,
          FILE_TRANSFER_DOWNLOAD_TOOL_NAME,
          FILE_TRANSFER_DOWNLOAD_STREAM_TOOL_NAME,
          FILE_TRANSFER_DOWNLOAD_RANGE_TOOL_NAME,
        ].sort(),
      );
      expect(handlers.has(FILE_TRANSFER_DELETE_TOOL_NAME)).toBe(false);
      expect(handlers.has(FILE_TRANSFER_UPLOAD_INIT_TOOL_NAME)).toBe(false);
      expect(handlers.has(FILE_TRANSFER_UPLOAD_STATUS_TOOL_NAME)).toBe(false);
      expect(handlers.has(FILE_TRANSFER_UPLOAD_CHUNK_TOOL_NAME)).toBe(false);
      expect(handlers.has(FILE_TRANSFER_UPLOAD_FINALIZE_TOOL_NAME)).toBe(false);
      expect(handlers.has(FILE_TRANSFER_UPLOAD_CANCEL_TOOL_NAME)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns isError when file not found", async () => {
    const root = await mkdtemp(join(tmpdir(), "contexcgi-ft-tools-"));
    try {
      const handlers = new Map<string, ToolHandler>();
      const server = {
        registerTool(
          name: string,
          _definition: unknown,
          handler: ToolHandler,
        ): void {
          handlers.set(name, handler);
        },
      };
      registerFileTransferTools({
        server: server as never,
        registry: new FileTransferRegistry({ root }),
      });
      const result = await handlers.get(FILE_TRANSFER_GET_TOOL_NAME)?.({
        id: "nope.apk",
      });
      expect(result?.isError).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
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
import type { FileTransferRegistry } from "./file-transfer-registry.js";

const fileCategorySchema = z.enum([
  "binary",
  "apk",
  "archive",
  "image",
  "video",
  "audio",
  "document",
  "other",
]);

const binaryPlatformSchema = z.enum([
  "android",
  "linux",
  "darwin",
  "windows",
  "unknown",
]);

const listFilesSchema = z.object({
  category: fileCategorySchema.optional(),
  platform: binaryPlatformSchema.optional(),
  architecture: z.string().optional(),
  channel: z.string().optional(),
  limit: z.number().int().positive().max(10000).optional(),
});

const getFileSchema = z.object({ id: z.string().min(1) });

const downloadFileSchema = z.object({
  id: z.string().min(1),
  encoding: z.literal("base64").optional(),
});

const downloadFileRangeSchema = z.object({
  id: z.string().min(1),
  offsetBytes: z.number().int().min(0),
  lengthBytes: z
    .number()
    .int()
    .positive()
    .max(48 * 1024),
  encoding: z.literal("base64").optional(),
});

const deleteFileSchema = z.object({ id: z.string().min(1) });

const uploadInitSchema = z.object({
  requestId: z.string().uuid().optional(),
  filename: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
  mimeType: z.string().optional(),
  category: fileCategorySchema.optional(),
  platform: binaryPlatformSchema.optional(),
  architecture: z.string().optional(),
  channel: z.string().optional(),
  version: z.string().optional(),
  description: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const uploadChunkSchema = z.object({
  uploadId: z.string().min(1),
  index: z.number().int().min(0),
  totalChunks: z.number().int().positive(),
  contentBase64: z.string().min(1),
});

const uploadStatusSchema = z.object({ uploadId: z.string().min(1) });
const uploadFinalizeSchema = z.object({ uploadId: z.string().min(1) });
const uploadCancelSchema = z.object({ uploadId: z.string().min(1) });

const FILE_STREAM_CHUNK_BYTES = 40 * 1024;

type StreamSink = {
  write(data: string): Promise<void>;
  close(): Promise<void>;
};

export function registerFileTransferTools(input: {
  server: McpServer;
  registry: FileTransferRegistry;
  /** Optional client-pubkey extractor (set by the transport when injectClientPubkey is on). */
  getClientPubkey?: (extra: {
    _meta?: Record<string, unknown>;
  }) => string | undefined;
  /** Register only list/get/download tools. Defaults to false for backwards compatibility. */
  readOnly?: boolean;
}): void {
  input.server.registerTool(
    FILE_TRANSFER_LIST_TOOL_NAME,
    {
      title: "List transferable files",
      description:
        "Returns files this ContextVM host can transfer over Nostr — binaries, APKs, archives, images, documents.",
      inputSchema: listFilesSchema,
    },
    async (args): Promise<CallToolResult> => {
      const files = await input.registry.list(args);
      return {
        content: [{ type: "text", text: JSON.stringify(files) }],
        structuredContent: { files },
      };
    },
  );

  input.server.registerTool(
    FILE_TRANSFER_GET_TOOL_NAME,
    {
      title: "Get file metadata",
      description:
        "Returns metadata for one transferable file without downloading it.",
      inputSchema: getFileSchema,
    },
    async (args): Promise<CallToolResult> => {
      const file = await input.registry.get(args.id);
      if (!file) return fileNotFound(args.id);
      return {
        content: [{ type: "text", text: JSON.stringify(file) }],
        structuredContent: { file },
      };
    },
  );

  input.server.registerTool(
    FILE_TRANSFER_DOWNLOAD_RANGE_TOOL_NAME,
    {
      title: "Download file byte range",
      description:
        "Downloads one bounded byte range of a file as base64. Call repeatedly for reliable progress and retries over public relays.",
      inputSchema: downloadFileRangeSchema,
    },
    async (args): Promise<CallToolResult> => {
      const file = await input.registry.get(args.id);
      if (!file) return fileNotFound(args.id);
      const contentBase64 = await input.registry.readRangeBase64(args);
      if (contentBase64 === undefined) return fileNotFound(args.id);
      const lengthBytes = Math.max(
        0,
        Math.min(args.lengthBytes, file.sizeBytes - args.offsetBytes),
      );
      return {
        content: [
          {
            type: "text",
            text: `Downloaded ${file.filename} bytes ${args.offsetBytes}-${
              args.offsetBytes + lengthBytes - 1
            } as base64`,
          },
        ],
        structuredContent: {
          file,
          encoding: "base64",
          offsetBytes: args.offsetBytes,
          lengthBytes,
          contentBase64,
          sha256: file.sha256,
        },
      };
    },
  );

  input.server.registerTool(
    FILE_TRANSFER_DOWNLOAD_STREAM_TOOL_NAME,
    {
      title: "Stream file download",
      description:
        "Streams one file as base64 chunks over ContextVM CEP-41 so clients can show download progress.",
      inputSchema: downloadFileSchema,
    },
    async (args, extra): Promise<CallToolResult> => {
      const file = await input.registry.get(args.id);
      if (!file) return fileNotFound(args.id);
      const stream = getCep41Stream(extra._meta);
      if (!stream) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "File stream download requires ContextVM CEP-41 stream support",
            },
          ],
        };
      }
      await writeFileBase64Stream(input.registry, file.id, stream);
      return {
        content: [
          {
            type: "text",
            text: `Streamed ${file.filename} (${file.sizeBytes} bytes) as base64`,
          },
        ],
        structuredContent: {
          file,
          encoding: "base64",
          streamed: true,
          sha256: file.sha256,
        },
      };
    },
  );

  input.server.registerTool(
    FILE_TRANSFER_DOWNLOAD_TOOL_NAME,
    {
      title: "Download file",
      description:
        "Downloads one file as base64. ContextVM CEP-22 chunks large encrypted responses automatically.",
      inputSchema: downloadFileSchema,
    },
    async (args): Promise<CallToolResult> => {
      const file = await input.registry.get(args.id);
      if (!file) return fileNotFound(args.id);
      const contentBase64 = await input.registry.readContentBase64(args.id);
      if (!contentBase64) return fileNotFound(args.id);
      return {
        content: [
          {
            type: "text",
            text: `Downloaded ${file.filename} (${file.sizeBytes} bytes) as base64`,
          },
        ],
        structuredContent: {
          file,
          encoding: "base64",
          contentBase64,
          sha256: file.sha256,
        },
      };
    },
  );

  if (input.readOnly) return;

  input.server.registerTool(
    FILE_TRANSFER_DELETE_TOOL_NAME,
    {
      title: "Delete transferable file",
      description:
        "Deletes one file from the ContextVM host. Returns whether a file was removed.",
      inputSchema: deleteFileSchema,
    },
    async (args): Promise<CallToolResult> => {
      const deleted = await input.registry.delete(args.id);
      return {
        content: [{ type: "text", text: `Deleted ${args.id}: ${deleted}` }],
        structuredContent: { id: args.id, deleted },
      };
    },
  );

  input.server.registerTool(
    FILE_TRANSFER_UPLOAD_INIT_TOOL_NAME,
    {
      title: "Initialize file upload",
      description:
        "Begins a resumable chunked file upload. The server reserves a slot and returns an uploadId, chunk size, and total chunk count.",
      inputSchema: uploadInitSchema,
    },
    async (args, extra): Promise<CallToolResult> => {
      try {
        const init = await input.registry.initUpload(
          {
            requestId: args.requestId,
            filename: args.filename,
            sizeBytes: args.sizeBytes,
            sha256: args.sha256,
            manifest: {
              name: args.filename.replace(/\.[^/.]+$/, ""),
              version: args.version,
              platform: args.platform,
              architecture: args.architecture,
              channel: args.channel,
              mimeType: args.mimeType,
              category: args.category,
              description: args.description,
              metadata: args.metadata,
            },
          },
          input.getClientPubkey?.(extra ?? {}),
        );
        return {
          content: [
            { type: "text", text: `Upload initialized: ${init.uploadId}` },
          ],
          structuredContent: init,
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: "text", text: `Upload init failed: ${messageOf(error)}` },
          ],
        };
      }
    },
  );

  input.server.registerTool(
    FILE_TRANSFER_UPLOAD_STATUS_TOOL_NAME,
    {
      title: "Get upload status",
      description:
        "Returns durable upload metadata and accepted chunk indices so an interrupted upload can resume.",
      inputSchema: uploadStatusSchema,
    },
    async (args, extra): Promise<CallToolResult> => {
      try {
        const status = await input.registry.uploadStatus(
          args.uploadId,
          input.getClientPubkey?.(extra ?? {}),
        );
        return {
          content: [
            {
              type: "text",
              text: `Upload status: ${status.receivedChunks}/${status.totalChunks}`,
            },
          ],
          structuredContent: status,
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: "text", text: `Upload status failed: ${messageOf(error)}` },
          ],
        };
      }
    },
  );

  input.server.registerTool(
    FILE_TRANSFER_UPLOAD_CHUNK_TOOL_NAME,
    {
      title: "Upload file chunk",
      description:
        "Uploads one base64 chunk of a resumable file upload. Chunks are order-independent; duplicate indices are ignored.",
      inputSchema: uploadChunkSchema,
    },
    async (args, extra): Promise<CallToolResult> => {
      try {
        const ack = await input.registry.uploadChunk(
          {
            uploadId: args.uploadId,
            index: args.index,
            totalChunks: args.totalChunks,
            contentBase64: args.contentBase64,
          },
          input.getClientPubkey?.(extra ?? {}),
        );
        return {
          content: [
            {
              type: "text",
              text: `Chunk ${args.index} received (${ack.receivedChunks}/${ack.totalChunks})`,
            },
          ],
          structuredContent: {
            status: "ok",
            uploadId: args.uploadId,
            receivedChunks: ack.receivedChunks,
            totalChunks: ack.totalChunks,
          },
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: "text", text: `Chunk upload failed: ${messageOf(error)}` },
          ],
        };
      }
    },
  );

  input.server.registerTool(
    FILE_TRANSFER_UPLOAD_FINALIZE_TOOL_NAME,
    {
      title: "Finalize file upload",
      description:
        "Assembles a fully-uploaded file, verifies its sha256, persists it to disk, and returns the resulting descriptor.",
      inputSchema: uploadFinalizeSchema,
    },
    async (args, extra): Promise<CallToolResult> => {
      try {
        const clientKey = input.getClientPubkey?.(extra ?? {});
        const file = await input.registry.finalizeUpload(
          args.uploadId,
          clientKey,
        );
        return {
          content: [
            { type: "text", text: `Upload finalized: ${file.filename}` },
          ],
          structuredContent: { status: "ok", file },
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Upload finalize failed: ${messageOf(error)}`,
            },
          ],
        };
      }
    },
  );

  input.server.registerTool(
    FILE_TRANSFER_UPLOAD_CANCEL_TOOL_NAME,
    {
      title: "Cancel file upload",
      description:
        "Cancels a pending resumable upload and discards received chunks.",
      inputSchema: uploadCancelSchema,
    },
    async (args, extra): Promise<CallToolResult> => {
      await input.registry.cancelUpload(
        args.uploadId,
        input.getClientPubkey?.(extra ?? {}),
      );
      return {
        content: [{ type: "text", text: `Upload cancelled: ${args.uploadId}` }],
        structuredContent: { status: "ok" },
      };
    },
  );
}

async function writeFileBase64Stream(
  registry: FileTransferRegistry,
  id: string,
  stream: StreamSink,
): Promise<void> {
  try {
    const file = await registry.createReadStream(id, FILE_STREAM_CHUNK_BYTES);
    for await (const chunk of file) {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      await stream.write(bytes.toString("base64"));
    }
  } finally {
    await stream.close();
  }
}

function getCep41Stream(meta: unknown): StreamSink | undefined {
  if (
    !meta ||
    typeof meta !== "object" ||
    !(meta as { stream?: unknown }).stream
  ) {
    return undefined;
  }
  const stream = (meta as { stream?: unknown }).stream;
  if (!stream || typeof stream !== "object") return undefined;
  const candidate = stream as {
    write?: (data: string) => unknown;
    close?: () => unknown;
  };
  if (
    typeof candidate.write !== "function" ||
    typeof candidate.close !== "function"
  ) {
    return undefined;
  }
  const write = candidate.write.bind(candidate);
  const close = candidate.close.bind(candidate);
  return {
    write: async (data: string) => {
      await write(data);
    },
    close: async () => {
      await close();
    },
  };
}

function fileNotFound(id: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: `File not found: ${id}` }],
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

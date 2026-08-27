import { describe, expect, it, vi } from "vitest";
import type { FileTransferDescriptor } from "@contexcgi/protocol";
import { ContexcgiClient } from "./index.js";

const file: FileTransferDescriptor = {
  id: "folder/data.bin",
  name: "data",
  filename: "data.bin",
  sizeBytes: 5,
  sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  mimeType: "application/octet-stream",
  category: "binary",
  platform: "unknown",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function clientWith(payload: unknown): ContexcgiClient {
  const client = new ContexcgiClient({
    privateKey: "1".padStart(64, "0"),
    serverPubkey: "1".repeat(64),
    relays: ["ws://localhost:10547"],
  });
  const callTool = vi.fn(async () => ({ structuredContent: payload }));
  (
    client as unknown as { mcpClient: { callTool: typeof callTool } }
  ).mcpClient = {
    callTool,
  };
  return client;
}

describe("downloadFileRangeChunk", () => {
  it("returns one validated chunk without accumulating earlier ranges", async () => {
    const client = clientWith({
      file,
      encoding: "base64",
      offsetBytes: 1,
      lengthBytes: 2,
      contentBase64: "ZWw=",
      sha256: file.sha256,
    });

    await expect(
      client.downloadFileRangeChunk(file.id, 1, 2, file),
    ).resolves.toEqual({
      file,
      offsetBytes: 1,
      lengthBytes: 2,
      bytes: new Uint8Array([101, 108]),
    });
  });

  it("rejects inconsistent range and descriptor metadata", async () => {
    const client = clientWith({
      file: { ...file, sizeBytes: 6 },
      encoding: "base64",
      offsetBytes: 2,
      lengthBytes: 2,
      contentBase64: "bGw=",
      sha256: file.sha256,
    });

    await expect(
      client.downloadFileRangeChunk(file.id, 1, 2, file),
    ).rejects.toThrow(/identity\/offset mismatch|changed during/);
  });

  it("rejects decoded lengths that do not match the response", async () => {
    const client = clientWith({
      file,
      encoding: "base64",
      offsetBytes: 0,
      lengthBytes: 3,
      contentBase64: "aGU=",
      sha256: file.sha256,
    });

    await expect(
      client.downloadFileRangeChunk(file.id, 0, 3, file),
    ).rejects.toThrow(/length mismatch/);
  });
});

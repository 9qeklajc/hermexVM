import { describe, expect, it, vi } from "vitest";
import {
  MYLOCK_TEXT_GET_TOOL_NAME,
  MYLOCK_TEXT_LIST_TOOL_NAME,
  type MylockTextDescriptor,
} from "@contexcgi/protocol";
import { ContexcgiClient } from "./index.js";

const descriptor: MylockTextDescriptor = {
  id: "notes/example.txt",
  name: "example",
  sizeBytes: 12,
  updatedAt: "2026-01-01T00:00:00.000Z",
  tooLarge: false,
};

function clientWith(payloads: Record<string, unknown>): {
  client: ContexcgiClient;
  callTool: ReturnType<typeof vi.fn>;
} {
  const client = new ContexcgiClient({
    privateKey: "1".padStart(64, "0"),
    serverPubkey: "1".repeat(64),
    relays: ["ws://localhost:10547"],
  });
  const callTool = vi.fn(async (request: { name: string }) => ({
    structuredContent: payloads[request.name],
  }));
  (
    client as unknown as { mcpClient: { callTool: typeof callTool } }
  ).mcpClient = {
    callTool,
  };
  return { client, callTool };
}

describe("MyLock shared text client", () => {
  it("lists shared text through the typed tool", async () => {
    const { client, callTool } = clientWith({
      [MYLOCK_TEXT_LIST_TOOL_NAME]: { texts: [descriptor] },
    });
    await expect(client.listSharedTexts({ limit: 20 })).resolves.toEqual([
      descriptor,
    ]);
    expect(callTool).toHaveBeenCalledWith({
      name: MYLOCK_TEXT_LIST_TOOL_NAME,
      arguments: { limit: 20 },
    });
  });

  it("surfaces structured shared-text errors", async () => {
    const { client } = clientWith({
      [MYLOCK_TEXT_GET_TOOL_NAME]: {
        error: { message: "Shared text changed while being read" },
      },
    });
    await expect(client.getSharedText(descriptor.id)).rejects.toThrow(
      "changed while being read",
    );
  });

  it("gets exact shared text content through the typed tool", async () => {
    const content = "first\r\nsecond";
    const { client, callTool } = clientWith({
      [MYLOCK_TEXT_GET_TOOL_NAME]: { text: descriptor, content },
    });
    await expect(client.getSharedText(descriptor.id)).resolves.toEqual({
      text: descriptor,
      content,
    });
    expect(callTool).toHaveBeenCalledWith({
      name: MYLOCK_TEXT_GET_TOOL_NAME,
      arguments: { id: descriptor.id },
    });
  });
});

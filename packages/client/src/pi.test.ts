import { describe, expect, it, vi } from "vitest";
import { PiChatClient } from "./pi.js";

type FakeCallTool = (...args: unknown[]) => unknown;

function clientWithFakeCallTool(callTool: FakeCallTool): PiChatClient {
  const client = new PiChatClient({
    privateKey: "1".padStart(64, "0"),
    serverPubkey: "1".repeat(64),
    relays: ["ws://localhost:10547"],
  });
  (client as unknown as { mcpClient: { callTool: FakeCallTool } }).mcpClient = {
    callTool,
  };
  return client;
}

describe("PiChatClient", () => {
  it("uses the dedicated Pi list contract and caps the fast path at 100", async () => {
    const callTool = vi.fn<FakeCallTool>(async () => ({
      structuredContent: { items: [{ id: "chat-1", title: "hello" }] },
    }));
    const client = clientWithFakeCallTool(callTool);

    await expect(client.listChats(500)).resolves.toEqual([
      { id: "chat-1", title: "hello" },
    ]);
    expect(callTool).toHaveBeenCalledWith(
      { name: "pi.chats.list", arguments: { limit: 100 } },
      undefined,
      undefined,
    );
  });

  it("creates, reads, and deletes without Hermes agent arguments", async () => {
    const calls: Array<{ name: string; arguments: unknown }> = [];
    const callTool = vi.fn<FakeCallTool>(async (request: unknown) => {
      const typed = request as { name: string; arguments: unknown };
      calls.push(typed);
      if (typed.name === "pi.chats.create") {
        return { structuredContent: { chatId: "pending:abc" } };
      }
      if (typed.name === "pi.chats.history") {
        return { structuredContent: { chatId: "chat-1", messages: [] } };
      }
      return { structuredContent: { deleted: "chat-1" } };
    });
    const client = clientWithFakeCallTool(callTool);

    await client.createChat("/tmp/project");
    await client.chatHistory("chat-1");
    await client.deleteChat("chat-1");

    expect(calls).toEqual([
      { name: "pi.chats.create", arguments: { cwd: "/tmp/project" } },
      { name: "pi.chats.history", arguments: { chatId: "chat-1" } },
      { name: "pi.chats.delete", arguments: { chatId: "chat-1" } },
    ]);
  });

  it("uses Pi-only repository, model, interrupt, and forwarding contracts", async () => {
    const calls: Array<{ name: string; arguments: unknown }> = [];
    const callTool = vi.fn<FakeCallTool>(async (request: unknown) => {
      const typed = request as { name: string; arguments: unknown };
      calls.push(typed);
      if (typed.name === "pi.repositories.list")
        return {
          structuredContent: { repositories: [{ id: "r", path: "/repo" }] },
        };
      if (typed.name === "pi.models.list")
        return {
          structuredContent: { providers: [], provider: "p", model: "m" },
        };
      if (typed.name === "pi.model.switch")
        return {
          structuredContent: { provider: "p", model: "m", scope: "session" },
        };
      if (typed.name === "pi.chat.interrupt")
        return { structuredContent: { chatId: "chat", interrupted: true } };
      return { structuredContent: { schemaVersion: 1, previewDigest: "d" } };
    });
    const client = clientWithFakeCallTool(callTool);
    await client.listRepositories();
    await client.listModels({ chatId: "chat" });
    await client.switchModel({ chatId: "chat", provider: "p", model: "m" });
    await client.interrupt("chat");
    await client.previewHandoff({
      source: { chatId: "chat" },
      mode: "full",
      destination: { kind: "existing", chatId: "dest" },
      instructions: "continue",
    });
    expect(calls.map((call) => call.name)).toEqual([
      "pi.repositories.list",
      "pi.models.list",
      "pi.model.switch",
      "pi.chat.interrupt",
      "pi.handoffs.preview",
    ]);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { HermesChatClient } from "./hermes.js";

async function connectedClient(replyToPing: boolean) {
  const client = new HermesChatClient({
    privateKey: "1".padStart(64, "0"),
    serverPubkey: "1".repeat(64),
    relays: ["ws://localhost:10547"],
  });
  // Keep the real MCP request/timeout machinery; replace only the wire.
  const transport: Transport = {
    start: async () => {},
    close: async () => {},
    send: vi.fn(async (message) => {
      if (!("method" in message) || !("id" in message)) return;
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: "2025-03-26",
              capabilities: {},
              serverInfo: { name: "test", version: "1" },
            }
          : message.method === "ping" && replyToPing
            ? {}
            : null;
      if (result) {
        await Promise.resolve();
        transport.onmessage?.({ jsonrpc: "2.0", id: message.id, result });
      }
    }),
  };
  await (client as unknown as { mcpClient: Client }).mcpClient.connect(
    transport,
  );
  return { client, transport };
}

afterEach(() => vi.useRealTimers());

describe("HermesChatClient.ping", () => {
  it("validates an existing session without reconnecting or closing it", async () => {
    const { client, transport } = await connectedClient(true);
    await expect(client.ping()).resolves.toBeUndefined();
    expect(transport.send).toHaveBeenCalledWith(
      expect.objectContaining({ method: "ping" }),
      expect.anything(),
    );
    await client.close();
  });

  it("bounds a silent dead connection to 2000ms without retries", async () => {
    vi.useFakeTimers();
    const { client, transport } = await connectedClient(false);
    const result = expect(client.ping()).rejects.toThrow("Request timed out");
    await vi.advanceTimersByTimeAsync(2000);
    await result;
    const pingCalls = vi
      .mocked(transport.send)
      .mock.calls.filter(
        ([message]) => "method" in message && message.method === "ping",
      );
    expect(pingCalls).toHaveLength(1);
    await client.close();
  });

  it("cancels the pending check when the app backgrounds again", async () => {
    const { client } = await connectedClient(false);
    const controller = new AbortController();
    const result = expect(client.ping(controller.signal)).rejects.toThrow();
    controller.abort();
    await result;
    await client.close();
  });
});

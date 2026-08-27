import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GatewayRpcError,
  HermesGateway,
  type GatewayEventFrame,
} from "./gateway.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, "..", "test-fixtures", "fake-gateway.mjs");

const fakeCommand = { command: process.execPath, args: [FAKE] };

let gateway: HermesGateway | null = null;

afterEach(async () => {
  await gateway?.stop();
  gateway = null;
});

describe("HermesGateway", () => {
  it("spawns lazily, waits for gateway.ready, and correlates responses", async () => {
    gateway = new HermesGateway({ command: fakeCommand });
    const created = await gateway.request<{ session_id: string }>(
      "session.create",
      {},
    );
    expect(created.session_id).toBe("live1");
    const second = await gateway.request<{ session_id: string }>(
      "session.create",
      {},
    );
    expect(second.session_id).toBe("live2");
  });

  it("maps JSON-RPC errors to GatewayRpcError", async () => {
    gateway = new HermesGateway({ command: fakeCommand });
    await expect(
      gateway.request("session.resume", { session_id: "missing" }),
    ).rejects.toThrowError(GatewayRpcError);
    await expect(
      gateway.request("session.resume", { session_id: "missing" }),
    ).rejects.toThrowError(/session not found/);
  });

  it("fans out events emitted after prompt.submit", async () => {
    gateway = new HermesGateway({ command: fakeCommand });
    const events: GatewayEventFrame[] = [];
    gateway.onEvent((frame) => events.push(frame));
    const created = await gateway.request<{ session_id: string }>(
      "session.create",
      {},
    );
    await gateway.request("prompt.submit", {
      session_id: created.session_id,
      text: "hi",
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const types = events
      .filter((frame) => frame.session_id === created.session_id)
      .map((frame) => frame.type);
    expect(types).toContain("message.delta");
    expect(types[types.length - 1]).toBe("message.complete");
  });

  it("rejects in-flight requests when the child dies and respawns on demand", async () => {
    gateway = new HermesGateway({ command: fakeCommand });
    await gateway.request("session.create", {});
    // Kill the child behind the gateway's back.
    const proc = (gateway as unknown as { proc: { kill(sig: string): void } })
      .proc;
    const exited = new Promise<void>((resolve) => {
      const off = gateway!.onEvent((frame) => {
        if (frame.type === "gateway.exited") {
          off();
          resolve();
        }
      });
    });
    proc.kill("SIGKILL");
    await exited;
    // Next request transparently respawns a fresh child.
    const created = await gateway.request<{ session_id: string }>(
      "session.create",
      {},
    );
    expect(created.session_id).toBe("live1");
  });
});

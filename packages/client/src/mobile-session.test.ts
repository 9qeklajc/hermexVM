import { describe, expect, it } from "vitest";
import {
  connectionGate,
  isConnectionPending,
  restoreConnectionConfig,
  type ContextVmConnectionConfig,
} from "./mobile-session.js";

const fallback: ContextVmConnectionConfig = {
  privateKey: "fallback-key",
  serverPubkey: "fallback-server",
  relays: ["wss://fallback.example"],
};

const saved: ContextVmConnectionConfig = {
  privateKey: "saved-key",
  serverPubkey: "saved-server",
  relays: ["wss://saved.example"],
};

describe("restoreConnectionConfig", () => {
  it("restores a valid saved connection instead of replacing it with defaults", () => {
    expect(restoreConnectionConfig(JSON.stringify(saved), fallback)).toEqual(
      saved,
    );
  });

  it.each([null, "not-json", "{}", '{"privateKey":"only-one-field"}'])(
    "falls back safely for absent or invalid saved data: %s",
    (value) => {
      expect(restoreConnectionConfig(value, fallback)).toEqual(fallback);
    },
  );
});

describe("connectionGate", () => {
  it("never routes a saved session to login during unlock recovery", () => {
    expect(
      connectionGate({
        ready: true,
        hasConfig: true,
        hasClient: false,
        status: "connecting",
      }),
    ).toBe("reconnecting");
    expect(
      connectionGate({
        ready: true,
        hasConfig: true,
        hasClient: false,
        status: "error",
      }),
    ).toBe("recovery");
  });

  it("routes to login only after config is explicitly absent", () => {
    expect(
      connectionGate({
        ready: true,
        hasConfig: false,
        hasClient: false,
        status: "idle",
      }),
    ).toBe("login");
  });
});

describe("isConnectionPending", () => {
  it("waits while stored state loads or a configured session reconnects", () => {
    expect(
      isConnectionPending({
        ready: false,
        hasConfig: false,
        hasClient: false,
        status: "idle",
      }),
    ).toBe(true);
    expect(
      isConnectionPending({
        ready: true,
        hasConfig: true,
        hasClient: false,
        status: "connecting",
      }),
    ).toBe(true);
  });

  it("does not hide the login screen when disconnected or when reconnect failed", () => {
    expect(
      isConnectionPending({
        ready: true,
        hasConfig: false,
        hasClient: false,
        status: "idle",
      }),
    ).toBe(false);
    expect(
      isConnectionPending({
        ready: true,
        hasConfig: true,
        hasClient: false,
        status: "error",
      }),
    ).toBe(false);
  });
});

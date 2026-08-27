import { describe, expect, it } from "vitest";
import {
  loadBridgeRuntimeConfig,
  parseRelayUrls,
  parseStrictBoolean,
} from "./config.js";

const BASE_ENV: NodeJS.ProcessEnv = {
  HERMES_BRIDGE_PRIVATE_KEY: "1".repeat(64),
  HERMES_BRIDGE_RELAYS: "wss://relay.contextvm.org",
  CONTEXCGI_ALLOWED_NPUBS: "2".repeat(64),
  HERMES_HOME: "/tmp/hermes",
};

describe("bridge runtime configuration", () => {
  it("loads a private, encrypted, allowlisted bridge by default", () => {
    const config = loadBridgeRuntimeConfig(BASE_ENV);
    expect(config.requireEncryption).toBe(true);
    expect(config.public).toBe(false);
    expect(config.allowedPublicKeys).toEqual(["2".repeat(64)]);
    expect(config.relays).toEqual(["wss://relay.contextvm.org"]);
  });

  it.each([
    [
      "missing private key",
      { ...BASE_ENV, HERMES_BRIDGE_PRIVATE_KEY: undefined },
    ],
    ["missing relays", { ...BASE_ENV, HERMES_BRIDGE_RELAYS: undefined }],
    ["missing allowlist", { ...BASE_ENV, CONTEXCGI_ALLOWED_NPUBS: undefined }],
    ["empty allowlist", { ...BASE_ENV, CONTEXCGI_ALLOWED_NPUBS: " ,  " }],
  ])("fails closed for %s", (_label, env) => {
    expect(() => loadBridgeRuntimeConfig(env)).toThrow();
  });

  it("rejects malformed and non-WebSocket relay URLs", () => {
    expect(() => parseRelayUrls("not-a-url")).toThrow(/invalid relay URL/);
    expect(() => parseRelayUrls("https://relay.example")).toThrow(/ws:\/\//);
  });

  it("parses booleans strictly instead of silently accepting typos", () => {
    expect(parseStrictBoolean({ FLAG: "true" }, "FLAG", false)).toBe(true);
    expect(parseStrictBoolean({ FLAG: "false" }, "FLAG", true)).toBe(false);
    expect(() => parseStrictBoolean({ FLAG: "yes" }, "FLAG", false)).toThrow(
      "FLAG must be true or false",
    );
  });

  it("selects a shared Whisper service without requiring a local model", () => {
    const config = loadBridgeRuntimeConfig({
      ...BASE_ENV,
      HERMES_WHISPER_ENABLED: "true",
      HERMES_WHISPER_SERVICE_URL: "http://100.90.84.147:8002/",
      HERMES_WHISPER_SERVICE_TOKEN: "optional-token",
    });
    expect(config.transcription).toMatchObject({
      enabled: true,
      serviceUrl: "http://100.90.84.147:8002",
      serviceToken: "optional-token",
    });
    expect(config.transcription.whisperCli).toBeUndefined();
  });

  it("rejects invalid or ambiguous shared-service configuration", () => {
    expect(() =>
      loadBridgeRuntimeConfig({
        ...BASE_ENV,
        HERMES_WHISPER_SERVICE_URL: "ftp://whisper.internal",
      }),
    ).toThrow(/http:\/\//);
    expect(() =>
      loadBridgeRuntimeConfig({
        ...BASE_ENV,
        HERMES_WHISPER_SERVICE_URL: "http://whisper.internal",
        HERMES_WHISPER_CLI: "/usr/bin/whisper-cli",
      }),
    ).toThrow(/either/);
    expect(() =>
      loadBridgeRuntimeConfig({
        ...BASE_ENV,
        HERMES_WHISPER_SERVICE_TOKEN: "orphan-token",
      }),
    ).toThrow(/requires/);
  });

  it("wires bounded Whisper policy from env", () => {
    const config = loadBridgeRuntimeConfig({
      ...BASE_ENV,
      HERMES_WHISPER_ENABLED: "true",
      HERMES_TRANSCRIPTION_MAX_BYTES: "1048576",
      HERMES_TRANSCRIPTION_MAX_DURATION_SECONDS: "30",
      HERMES_TRANSCRIPTION_TIMEOUT_MS: "120000",
    });
    expect(config.transcription).toMatchObject({
      enabled: true,
      maxAudioBytes: 1_048_576,
      maxDurationSeconds: 30,
      timeoutMs: 120_000,
    });
  });
});

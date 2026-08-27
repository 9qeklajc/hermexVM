import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseBridgeAllowlist } from "@contexcgi/bridge-auth";
import type { WhisperTranscriptionConfig } from "./transcription.js";

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

function requireBridgePrivateKey(env: NodeJS.ProcessEnv): string {
  const inline = env.HERMES_BRIDGE_PRIVATE_KEY?.trim();
  const file = env.HERMES_BRIDGE_PRIVATE_KEY_FILE?.trim();
  if (inline && file) {
    throw new Error(
      "Set only one of HERMES_BRIDGE_PRIVATE_KEY or HERMES_BRIDGE_PRIVATE_KEY_FILE",
    );
  }
  if (inline) return inline;
  if (file) {
    const value = readFileSync(file, "utf8").trim();
    if (!value) throw new Error("HERMES_BRIDGE_PRIVATE_KEY_FILE is empty");
    return value;
  }
  throw new Error(
    "Missing required env var HERMES_BRIDGE_PRIVATE_KEY or HERMES_BRIDGE_PRIVATE_KEY_FILE",
  );
}

export function parseStrictBoolean(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean,
): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true or false`);
}

export function clampedEnvNumber(
  env: NodeJS.ProcessEnv,
  name: string,
  min: number,
  max: number,
): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  if (value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

function optionalHttpUrl(
  raw: string | undefined,
  name: string,
): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid http:// or https:// URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must use http:// or https://`);
  }
  return value.replace(/\/+$/, "");
}

export function parseRelayUrls(raw: string): string[] {
  const relays = raw
    .split(/[\s,]+/)
    .map((relay) => relay.trim())
    .filter(Boolean);
  if (!relays.length)
    throw new Error("HERMES_BRIDGE_RELAYS must contain at least one relay URL");
  for (const relay of relays) {
    let url: URL;
    try {
      url = new URL(relay);
    } catch {
      throw new Error("HERMES_BRIDGE_RELAYS contains an invalid relay URL");
    }
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      throw new Error("HERMES_BRIDGE_RELAYS entries must use ws:// or wss://");
    }
  }
  return [...new Set(relays)];
}

export function loadBridgeRuntimeConfig(env: NodeJS.ProcessEnv = process.env) {
  const hermesHome = env.HERMES_HOME?.trim() || join(homedir(), ".hermes");
  const agentRoot =
    env.HERMES_AGENT_ROOT?.trim() || join(hermesHome, "hermes-agent");
  const dataRoot =
    env.HERMES_BRIDGE_DATA_ROOT?.trim() ||
    join(homedir(), ".hermes-bridge", "data");
  const fileTransferRoot =
    env.HERMES_BRIDGE_FILE_TRANSFER_ROOT?.trim() ||
    join(homedir(), ".hermes-bridge", "files");

  const serviceUrl = optionalHttpUrl(
    env.HERMES_WHISPER_SERVICE_URL,
    "HERMES_WHISPER_SERVICE_URL",
  );
  const whisperCli = env.HERMES_WHISPER_CLI?.trim() || undefined;
  const whisperModel = env.HERMES_WHISPER_MODEL?.trim() || undefined;
  if (serviceUrl && (whisperCli || whisperModel)) {
    throw new Error(
      "Use either HERMES_WHISPER_SERVICE_URL or local HERMES_WHISPER_CLI/HERMES_WHISPER_MODEL, not both",
    );
  }
  if (env.HERMES_WHISPER_SERVICE_TOKEN?.trim() && !serviceUrl) {
    throw new Error(
      "HERMES_WHISPER_SERVICE_TOKEN requires HERMES_WHISPER_SERVICE_URL",
    );
  }

  const transcription: WhisperTranscriptionConfig = {
    enabled: parseStrictBoolean(env, "HERMES_WHISPER_ENABLED", false),
    serviceUrl,
    serviceToken: env.HERMES_WHISPER_SERVICE_TOKEN?.trim() || undefined,
    whisperCli,
    whisperModel,
    ffmpegPath: env.HERMES_FFMPEG?.trim() || undefined,
    ffprobePath: env.HERMES_FFPROBE?.trim() || undefined,
    maxAudioBytes: clampedEnvNumber(
      env,
      "HERMES_TRANSCRIPTION_MAX_BYTES",
      64 * 1024,
      8 * 1024 * 1024,
    ),
    maxDurationSeconds: clampedEnvNumber(
      env,
      "HERMES_TRANSCRIPTION_MAX_DURATION_SECONDS",
      1,
      60,
    ),
    timeoutMs: clampedEnvNumber(
      env,
      "HERMES_TRANSCRIPTION_TIMEOUT_MS",
      15_000,
      300_000,
    ),
  };

  return {
    privateKey: requireBridgePrivateKey(env),
    relays: parseRelayUrls(requireEnv(env, "HERMES_BRIDGE_RELAYS")),
    hermesHome,
    agentRoot,
    dataRoot,
    fileTransferRoot,
    public: parseStrictBoolean(env, "HERMES_BRIDGE_PUBLIC", false),
    requireEncryption: parseStrictBoolean(
      env,
      "HERMES_BRIDGE_REQUIRE_ENCRYPTION",
      true,
    ),
    allowedPublicKeys: parseBridgeAllowlist(env.CONTEXCGI_ALLOWED_NPUBS),
    transcription,
  };
}

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { parseBridgeAllowlist } from "@contexcgi/bridge-auth";
import { join } from "node:path";
import { startHermesBridge } from "./bridge.js";
import { npubEncode } from "./npub.js";
import { listHermesAgents } from "./profiles.js";
import type { WhisperTranscriptionConfig } from "./transcription.js";

/**
 * Parses a positive-integer env var and clamps it into [min, max], warning
 * (not crashing) on anything invalid or out of range so a typo'd or hostile
 * value can't push voice transcription past its safe resource limits.
 */
function clampedEnvNumber(
  name: string,
  min: number,
  max: number,
): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    console.warn(
      `[bridge] ignoring invalid ${name}=${JSON.stringify(raw)} (must be a positive integer)`,
    );
    return undefined;
  }
  if (value < min || value > max) {
    const clamped = Math.min(max, Math.max(min, value));
    console.warn(
      `[bridge] clamping ${name}=${value} to ${clamped} (allowed range ${min}-${max})`,
    );
    return clamped;
  }
  return value;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var ${name}`);
    process.exit(1);
  }
  return value;
}

// A long-running bridge must survive transient relay hiccups. The SDK's
// open-stream writer can reject a publish deep in a fire-and-forget path;
// log it and keep serving instead of crashing the process.
process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  console.warn("[bridge] unhandled rejection (continuing):", message);
});
process.on("uncaughtException", (error) => {
  console.warn("[bridge] uncaught exception (continuing):", error.message);
});

async function main(): Promise<void> {
  const privateKey = requireEnv("HERMES_BRIDGE_PRIVATE_KEY");
  const relays = (
    process.env.HERMES_BRIDGE_RELAYS ??
    "wss://relay.contextvm.org,wss://relay.otrta.me,wss://relay.ordoplay.com"
  )
    .split(",")
    .map((relay) => relay.trim())
    .filter(Boolean);
  const hermesHome = process.env.HERMES_HOME ?? join(homedir(), ".hermes");
  const agentRoot =
    process.env.HERMES_AGENT_ROOT ?? join(hermesHome, "hermes-agent");
  const dataRoot =
    process.env.HERMES_BRIDGE_DATA_ROOT ??
    join(homedir(), ".hermes-bridge", "data");

  // File transfer root: when set, the bridge registers contexcgi.fileTransfer.*
  // tools so the app can upload arbitrary files. Defaults to a shared directory
  // under the data root so the agent can read them.
  const fileTransferRoot =
    process.env.HERMES_BRIDGE_FILE_TRANSFER_ROOT ??
    join(homedir(), ".hermes-bridge", "files");

  if (!existsSync(join(agentRoot, "tui_gateway"))) {
    console.error(
      `Hermes install not found at ${agentRoot} (set HERMES_AGENT_ROOT to the hermes-agent checkout).`,
    );
    process.exit(1);
  }

  const transcription: WhisperTranscriptionConfig = {
    enabled: process.env.HERMES_WHISPER_ENABLED === "true",
    whisperCli: process.env.HERMES_WHISPER_CLI,
    whisperModel: process.env.HERMES_WHISPER_MODEL,
    ffmpegPath: process.env.HERMES_FFMPEG,
    ffprobePath: process.env.HERMES_FFPROBE,
    // Env can only lower these, never raise them past the service's own safe
    // defaults (8MiB / 5min) — a misconfigured or hostile value can't turn
    // into unbounded memory/CPU use per recording.
    maxAudioBytes: clampedEnvNumber(
      "HERMES_TRANSCRIPTION_MAX_BYTES",
      64 * 1024,
      8 * 1024 * 1024,
    ),
    timeoutMs: clampedEnvNumber(
      "HERMES_TRANSCRIPTION_TIMEOUT_MS",
      15_000,
      300_000,
    ),
  };

  const bridge = await startHermesBridge({
    privateKey,
    relays,
    agentRoot,
    hermesHome,
    dataRoot,
    fileTransferRoot,
    public: process.env.HERMES_BRIDGE_PUBLIC === "true",
    requireEncryption: process.env.HERMES_BRIDGE_REQUIRE_ENCRYPTION === "true",
    allowedPublicKeys: parseBridgeAllowlist(
      process.env.CONTEXCGI_ALLOWED_NPUBS,
    ),
    transcription,
  });
  const agents = listHermesAgents(hermesHome);
  const voiceCapabilities = await bridge.transcription.capabilities();

  console.log("");
  console.log(
    "═══════════════════════════════════════════════════════════════",
  );
  console.log("  Hermes bridge ONLINE");
  console.log(`  pubkey (hex):  ${bridge.publicKey}`);
  console.log(`  pubkey (npub): ${npubEncode(bridge.publicKey)}`);
  console.log(`  relays:        ${relays.join(", ")}`);
  console.log(`  hermes home:   ${hermesHome}`);
  console.log(`  agent root:    ${agentRoot}`);
  console.log(`  data root:     ${dataRoot}`);
  console.log(`  file transfer: ${fileTransferRoot}`);
  console.log(
    `  agents:        ${agents.map((agent) => `${agent.name}${agent.isDefault ? " (default)" : ""}`).join(", ")}`,
  );
  console.log(
    `  voice:         ${voiceCapabilities.available ? "ready (local whisper.cpp)" : `unavailable (${voiceCapabilities.reason ?? "disabled"})`}`,
  );
  console.log(
    "  Paste EITHER pubkey form into the app's Bridge public key field.",
  );
  console.log("  Waiting for clients — every tool call is logged below.");
  console.log(
    "═══════════════════════════════════════════════════════════════",
  );
  console.log("");

  // Periodic heartbeat so a hung/blocked bridge is obvious in the log (the line
  // simply stops appearing). Cheap and quiet.
  const startedAt = Date.now();
  setInterval(() => {
    const uptimeMin = Math.floor((Date.now() - startedAt) / 60000);
    const rssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
    console.log(`[bridge] heartbeat uptime=${uptimeMin}m rss=${rssMb}MB`);
  }, 60000).unref();

  const shutdown = async () => {
    console.log("\nShutting down bridge…");
    await bridge.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("Bridge failed to start:", error);
  process.exit(1);
});

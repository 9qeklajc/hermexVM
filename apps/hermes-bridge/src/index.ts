import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { startHermesBridge } from "./bridge.js";
import { loadBridgeRuntimeConfig } from "./config.js";
import { npubEncode } from "./npub.js";
import { listHermesAgents } from "./profiles.js";

loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

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
  const config = loadBridgeRuntimeConfig();
  const { hermesHome, agentRoot, dataRoot, fileTransferRoot } = config;

  if (!existsSync(join(agentRoot, "tui_gateway"))) {
    console.error(
      `Hermes install not found at ${agentRoot} (set HERMES_AGENT_ROOT to the hermes-agent checkout).`,
    );
    process.exit(1);
  }

  const bridge = await startHermesBridge(config);
  const agents = listHermesAgents(hermesHome);
  const voiceCapabilities = await bridge.transcription.capabilities();

  console.log("");
  console.log(
    "═══════════════════════════════════════════════════════════════",
  );
  console.log("  Hermes bridge ONLINE");
  console.log(`  pubkey (hex):  ${bridge.publicKey}`);
  console.log(`  pubkey (npub): ${npubEncode(bridge.publicKey)}`);
  console.log(`  relays:        ${bridge.relays.join(", ")}`);
  console.log(`  hermes home:   ${hermesHome}`);
  console.log(`  agent root:    ${agentRoot}`);
  console.log(`  data root:     ${dataRoot}`);
  console.log(`  file transfer: ${fileTransferRoot}`);
  console.log(
    `  agents:        ${agents.map((agent) => `${agent.name}${agent.isDefault ? " (default)" : ""}`).join(", ")}`,
  );
  const voiceBackend = config.transcription.serviceUrl
    ? "shared Whisper service"
    : "local whisper.cpp";
  console.log(
    `  voice:         ${voiceCapabilities.available ? `ready (${voiceBackend})` : `unavailable (${voiceCapabilities.reason ?? "disabled"})`}`,
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

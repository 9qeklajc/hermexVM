/**
 * Dev helper: run a local relay (nak) + hermes-bridge fronting the FAKE
 * tui_gateway fixture, and print the bridge pubkey. Point the hermexVM app
 * (pnpm --filter @contexcgi/hermes-chat dev) at it to develop the UI without a
 * Hermes install or LLM spend.
 *
 *   HERMES_FAKE_CLIENT_KEY=<hex-or-nsec> pnpm tsx scripts/dev-hermes-fake-stack.ts
 *   # relay defaults to ws://127.0.0.1:10553
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";
import { startHermesBridge } from "../apps/hermes-bridge/src/bridge.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_GATEWAY = join(
  here,
  "..",
  "apps",
  "hermes-bridge",
  "test-fixtures",
  "fake-gateway.mjs",
);
const PORT = Number(process.env.HERMES_FAKE_RELAY_PORT ?? 10553);

function fakeHermesHome(): string {
  const home = mkdtempSync(join(tmpdir(), "hermes-fake-home-"));
  writeFileSync(
    join(home, "SOUL.md"),
    "You are Hermes, swift messenger of the gods.\n",
  );
  writeFileSync(join(home, "config.yaml"), "model:\n  default: glm-5.2\n");
  const coder = join(home, "profiles", "coder");
  mkdirSync(coder, { recursive: true });
  writeFileSync(
    join(coder, "profile.yaml"),
    'description: "Writes the code."\n',
  );
  writeFileSync(
    join(coder, "config.yaml"),
    "model:\n  default: claude-opus-4-8\n",
  );
  writeFileSync(join(coder, "SOUL.md"), "You write excellent code.\n");
  return home;
}

async function main(): Promise<void> {
  // nak's in-memory relay rejects publishes under concurrent CEP-41 load
  // (see AGENTS.md §10) — pass HERMES_FAKE_RELAYS to use real relays when a
  // test holds several live streams at once.
  const relays = (process.env.HERMES_FAKE_RELAYS ?? "")
    .split(",")
    .map((relay) => relay.trim())
    .filter(Boolean);
  const relayUrl = relays[0] ?? `ws://127.0.0.1:${PORT}`;
  if (relays.length === 0) {
    spawn("nak", ["serve", "--hostname", "127.0.0.1", "--port", String(PORT)], {
      stdio: "ignore",
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 800));

  const clientPrivateKey = process.env.HERMES_FAKE_CLIENT_KEY;
  if (!clientPrivateKey) {
    throw new Error(
      "HERMES_FAKE_CLIENT_KEY is required so the fake bridge can authorize the app",
    );
  }
  const decodedClientKey = clientPrivateKey.startsWith("nsec1")
    ? nip19.decode(clientPrivateKey)
    : null;
  const clientSecret =
    decodedClientKey?.type === "nsec"
      ? decodedClientKey.data
      : Uint8Array.from(Buffer.from(clientPrivateKey, "hex"));

  const bridge = await startHermesBridge({
    privateKey:
      process.env.HERMES_FAKE_BRIDGE_KEY ?? bytesToHex(generateSecretKey()),
    relays: relays.length ? relays : [relayUrl],
    agentRoot: "/unused-with-fake-gateway",
    hermesHome: fakeHermesHome(),
    allowedPublicKeys: [getPublicKey(clientSecret)],
    gatewayCommand: { command: process.execPath, args: [FAKE_GATEWAY] },
  });

  console.log("");
  console.log("Fake Hermes stack running:");
  console.log(
    `  relay:          ${relays.length ? relays.join(", ") : relayUrl}`,
  );
  console.log(`  bridge pubkey:  ${bridge.publicKey}`);
  console.log("  Paste both into the hermexVM connect screen.");
  console.log("");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

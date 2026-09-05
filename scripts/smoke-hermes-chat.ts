/**
 * End-to-end smoke for the Hermes chat stack, fully self-contained:
 * local relay (nak) + hermes-bridge fronting the fake tui_gateway fixture +
 * HermesChatClient. Verifies agent listing, a streamed turn (deltas → tool
 * frames → completion), transcript reads, and chat listing — all over
 * ContextVM/Nostr.
 *
 *   pnpm smoke:hermes            # spawns nak on a fresh local port
 *   HERMES_SMOKE_RELAY=ws://...  # use an already-running relay instead
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";
import { startHermesBridge } from "../apps/hermes-bridge/src/bridge.js";
import { HermesChatClient } from "../packages/client/src/index.js";
import type {
  HermesActivityEvent,
  HermesChatEvent,
} from "../packages/protocol/src/index.js";

// Deliberately aborting a CEP-41 stream rejects an internal SDK promise with
// OpenStreamAbortError — benign teardown noise (see AGENTS.md §10), same guard
// the app installs in main.tsx.
process.on("unhandledRejection", (reason) => {
  if (
    (reason as { name?: string } | undefined)?.name === "OpenStreamAbortError"
  )
    return;
  throw reason;
});

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_GATEWAY = join(
  here,
  "..",
  "apps",
  "hermes-bridge",
  "test-fixtures",
  "fake-gateway.mjs",
);
const RELAY_PORT = 32_000 + (process.pid % 20_000);

function fail(message: string): never {
  throw new Error(`smoke failed: ${message}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

async function waitForRelay(url: string, timeoutMs = 15_000): Promise<void> {
  const { connect } = await import("node:net");
  const { hostname, port } = new URL(url.replace(/^ws/, "http"));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: hostname, port: Number(port) }, () => {
        socket.end();
        resolve(true);
      });
      socket.setTimeout(1_000, () => {
        socket.destroy();
        resolve(false);
      });
      socket.on("error", () => resolve(false));
    });
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail(`relay ${url} did not come up`);
}

function fakeHermesFixture(): {
  root: string;
  hermesHome: string;
  dataRoot: string;
} {
  const root = mkdtempSync(join(tmpdir(), "hermes-smoke-fixture-"));
  const home = join(root, "hermes-home");
  const dataRoot = join(root, "bridge-data");
  mkdirSync(home, { recursive: true });
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
  return { root, hermesHome: home, dataRoot };
}

async function main(): Promise<void> {
  let relayProc: ChildProcess | null = null;
  let relayUrl = process.env.HERMES_SMOKE_RELAY ?? "";
  if (!relayUrl) {
    relayUrl = `ws://127.0.0.1:${RELAY_PORT}`;
    relayProc = spawn(
      "nak",
      ["serve", "--hostname", "127.0.0.1", "--port", String(RELAY_PORT)],
      {
        stdio: "ignore",
      },
    );
  }
  const fixture = fakeHermesFixture();
  const { hermesHome, dataRoot } = fixture;

  const cleanup = async () => {
    relayProc?.kill("SIGTERM");
    rmSync(fixture.root, { recursive: true, force: true });
  };

  try {
    await waitForRelay(relayUrl);
    console.log(`relay ready at ${relayUrl}`);

    const clientKey = generateSecretKey();
    const watcherKey = generateSecretKey();
    const bridge = await startHermesBridge({
      privateKey: bytesToHex(generateSecretKey()),
      relays: [relayUrl],
      agentRoot: "/unused-in-smoke",
      hermesHome,
      dataRoot,
      allowedPublicKeys: [getPublicKey(clientKey), getPublicKey(watcherKey)],
      gatewayCommand: { command: process.execPath, args: [FAKE_GATEWAY] },
    });
    console.log(`bridge online ${bridge.publicKey.slice(0, 12)}…`);

    const client = new HermesChatClient({
      privateKey: bytesToHex(clientKey),
      serverPubkey: bridge.publicKey,
      relays: [relayUrl],
    });
    await client.connect();
    await client.ping();
    console.log(`client connected ${getPublicKey(clientKey).slice(0, 12)}…`);

    // 1. Agent profiles
    const agents = await client.listAgents();
    assert(
      agents.length === 2,
      `expected 2 Hermes agents, got ${agents.length}`,
    );
    assert(
      agents[0]!.id === "default" && agents[0]!.isDefault,
      "default agent first",
    );
    assert(
      agents[1]!.id === "coder" && agents[1]!.model === "claude-opus-4-8",
      "coder agent",
    );
    console.log(`✓ agents: ${agents.map((agent) => agent.name).join(", ")}`);

    const profileUpdate = await client.updateProfile({
      agentId: "coder",
      model: "deepseek-v4-pro",
      provider: "routstr",
    });
    assert(profileUpdate.scope === "global", "profile model update is global");
    console.log("✓ profile default model update");

    // 2. A second "watcher" device subscribes to app-wide activity BEFORE the
    // turn starts — it must see turn.started + turn.completed with a preview.
    const watcher = new HermesChatClient({
      privateKey: bytesToHex(watcherKey),
      serverPubkey: bridge.publicKey,
      relays: [relayUrl],
    });
    await watcher.connect();
    const activityStream = await watcher.streamActivity();
    const activityEvents: HermesActivityEvent[] = [];
    const activityPump = (async () => {
      for await (const event of activityStream.events) {
        if (event.type !== "keepalive") activityEvents.push(event);
        if (event.type === "turn.completed") break;
      }
    })();

    // 3. New conversation with a live streamed turn. A model override is
    // passed on the FIRST message of a brand-new chat — the case that used to
    // silently fall back to the profile default. It must be pinned on the
    // gateway session before the turn starts.
    const selectedCwd = "/tmp/hermes-project";
    const overrideModel = "deepseek-v4-pro";
    const turn = await client.sendMessage({
      agentId: "coder",
      text: "hello over nostr",
      cwd: selectedCwd,
      model: overrideModel,
      provider: "routstr",
    });
    const events: HermesChatEvent[] = [];
    for await (const event of turn.events) {
      if (event.type !== "keepalive") events.push(event);
    }
    const result = await turn.result;
    const started = events[0];
    assert(
      started?.type === "chat.started" && started.created,
      "first frame is chat.started",
    );
    const chatId = started.chatId;
    assert(/^20260726_/.test(chatId), `durable chat id, got ${chatId}`);
    const deltas = events
      .filter((event) => event.type === "message.delta")
      .map((event) => (event as { text: string }).text)
      .join("");
    assert(
      deltas === "Hello world",
      `streamed deltas, got ${JSON.stringify(deltas)}`,
    );
    assert(
      events.some((event) => event.type === "tool.start") &&
        events.some((event) => event.type === "tool.complete"),
      "tool frames streamed",
    );
    const firstTool = events.find((event) => event.type === "tool.start");
    assert(
      firstTool?.type === "tool.start" &&
        firstTool.argsText === `cwd=${selectedCwd} model=${overrideModel}`,
      "model override + selected project cwd reached the gateway before its first tool call",
    );
    const terminal = events[events.length - 1];
    assert(
      terminal?.type === "message.complete" && terminal.text === "Hello world",
      "terminal message.complete",
    );
    assert(
      result.chatId === chatId && result.text === "Hello world",
      "final result matches",
    );
    console.log(
      `✓ streamed turn (${events.length} frames) chat=${chatId}, cwd=${selectedCwd}`,
    );

    // The watcher saw the whole turn lifecycle without streaming it itself.
    await Promise.race([
      activityPump,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("activity events not received")),
          15_000,
        ),
      ),
    ]);
    const snapshot = activityEvents[0];
    assert(
      snapshot?.type === "activity.snapshot",
      "activity stream opens with a snapshot",
    );
    const startedEvent = activityEvents.find(
      (event) => event.type === "turn.started",
    );
    assert(
      startedEvent?.type === "turn.started" &&
        startedEvent.agentId === "coder" &&
        startedEvent.chatId === chatId,
      "watcher saw turn.started for the right chat",
    );
    const completedEvent = activityEvents.find(
      (event) => event.type === "turn.completed",
    );
    assert(
      completedEvent?.type === "turn.completed" &&
        completedEvent.chatId === chatId &&
        completedEvent.preview === "Hello world",
      "watcher saw turn.completed with the reply preview",
    );
    await activityStream.abort("done");
    await watcher.close();
    console.log(
      "✓ watcher device saw turn.started + turn.completed with preview",
    );

    // 3. Follow-up into the same conversation (uses the cached live session)
    const followUp = await client.sendMessage({
      agentId: "coder",
      chatId,
      text: "again",
    });
    let followDeltas = "";
    for await (const event of followUp.events) {
      if (event.type === "message.delta") followDeltas += event.text;
    }
    assert(followDeltas === "Hello world", "follow-up streamed");
    await followUp.result;
    console.log("✓ follow-up turn on the same chat");

    // 4. Transcript + chat listing
    const history = await client.chatHistory("coder", "20260725_090000_aaaaaa");
    assert(history.messages.length === 2, "history read");
    assert(
      history.context?.model === "claude-opus-4-8" &&
        history.context.provider === "anthropic" &&
        history.context.cwd === "/tmp/hermes-existing-project",
      "history restores active model and project context",
    );
    const chats = await client.listChats("coder");
    assert(
      chats.length === 1 && chats[0]!.source === "telegram",
      "chats listed",
    );
    console.log("✓ history + chat list");

    // 5. A handoff may target another conversation under the same profile.
    const sameAgentPreview = await client.previewHandoff({
      source: { agentId: "coder", chatId, title: "Source" },
      mode: "full",
      destination: {
        kind: "existing",
        agentId: "coder",
        chatId: "20260725_090000_aaaaaa",
        title: "Existing coder chat",
      },
      instructions: "Continue this context in the existing conversation.",
    });
    assert(
      sameAgentPreview.destination.kind === "existing" &&
        sameAgentPreview.destination.agentId === "coder" &&
        sameAgentPreview.destination.chatId === "20260725_090000_aaaaaa",
      "same-agent handoff preview accepted a different conversation",
    );
    console.log("✓ same-agent handoff to a different conversation");

    // 6. Canonical cross-agent handoff into a new destination conversation.
    const handoffPreview = await client.previewHandoff({
      source: { agentId: "coder", chatId, title: "Source" },
      mode: "full",
      destination: { kind: "new", agentId: "default", title: "Handoff target" },
      instructions: "Summarize the transferred context.",
    });
    assert(
      handoffPreview.messages.length > 0,
      "handoff snapshot has visible messages",
    );
    const handoffRequestId = crypto.randomUUID();
    const handoffInput = {
      source: handoffPreview.source,
      mode: handoffPreview.mode,
      destination: handoffPreview.destination,
      instructions: handoffPreview.instructions,
      requestId: handoffRequestId,
      previewDigest: handoffPreview.previewDigest,
    };
    const handoffTurn = await client.sendHandoff(handoffInput);
    let destinationChatId = "";
    for await (const event of handoffTurn.events) {
      if (event.type === "chat.started") destinationChatId = event.chatId;
    }
    const handoffResult = await handoffTurn.result;
    assert(
      destinationChatId && handoffResult.chatId === destinationChatId,
      "handoff delivered to durable destination chat",
    );
    const replay = await client.sendHandoff(handoffInput);
    let replayEvents = 0;
    for await (const event of replay.events) {
      if (event.type !== "keepalive") replayEvents += 1;
    }
    const replayResult = await replay.result;
    const links = await client.listHandoffs({ chatId });
    assert(
      replayEvents === 0 &&
        replayResult.chatId === destinationChatId &&
        links.length === 1 &&
        links[0]!.requestId === handoffRequestId &&
        links[0]!.status === "completed" &&
        links[0]!.destinationChatId === destinationChatId,
      `same request replayed one durable handoff (events=${replayEvents}, records=${links.length})`,
    );
    console.log(`✓ idempotent cross-agent handoff chat=${destinationChatId}`);

    await client.close();
    await bridge.close();
    console.log(
      "\nSMOKE OK — agents, streaming turn, follow-up, history, list all pass",
    );
  } finally {
    await cleanup();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

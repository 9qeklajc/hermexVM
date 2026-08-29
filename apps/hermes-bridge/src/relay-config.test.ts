import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  RelayConfiguration,
  loadPersistedRelays,
  mergeRelayUrls,
  type HotRelayPool,
} from "./relay-config.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

function fakePool(initial: string[]): HotRelayPool {
  const relays = [...initial];
  return {
    getRelayUrls: () => [...relays],
    ensureRelayUrls: async (requested) => {
      const added = requested.filter((relay) => !relays.includes(relay));
      relays.push(...added);
      return added;
    },
  };
}

describe("bridge relay configuration", () => {
  it("adds only missing relays and persists the effective union", async () => {
    const root = await mkdtemp(join(tmpdir(), "hermes-relays-"));
    cleanup.push(root);
    const path = join(root, "relays.json");
    const configuration = new RelayConfiguration(
      fakePool(["wss://one.example"]),
      path,
    );

    const result = await configuration.ensure([
      "wss://one.example",
      "wss://two.example",
    ]);

    expect(result).toEqual({
      relays: ["wss://one.example", "wss://two.example"],
      added: ["wss://two.example"],
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(result.relays);
    expect(await loadPersistedRelays(path)).toEqual(result.relays);
  });

  it("rejects invalid relay URLs before changing the pool", async () => {
    const root = await mkdtemp(join(tmpdir(), "hermes-relays-"));
    cleanup.push(root);
    const pool = fakePool(["wss://one.example"]);
    const configuration = new RelayConfiguration(
      pool,
      join(root, "relays.json"),
    );

    await expect(
      configuration.ensure(["https://not-a-relay.example"]),
    ).rejects.toThrow(/ws:\/\//);
    expect(pool.getRelayUrls()).toEqual(["wss://one.example"]);
  });

  it("merges environment and persisted relays without removing either", () => {
    expect(
      mergeRelayUrls(
        ["wss://one.example", "wss://shared.example"],
        ["wss://shared.example", "wss://two.example"],
      ),
    ).toEqual([
      "wss://one.example",
      "wss://shared.example",
      "wss://two.example",
    ]);
  });
});

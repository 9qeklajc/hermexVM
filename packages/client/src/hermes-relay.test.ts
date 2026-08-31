import { describe, expect, it, vi } from "vitest";

const relayPoolOptions = vi.hoisted(() => vi.fn());

vi.mock("@contextvm/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@contextvm/sdk")>();
  return {
    ...actual,
    ApplesauceRelayPool: class extends actual.ApplesauceRelayPool {
      constructor(
        ...args: ConstructorParameters<typeof actual.ApplesauceRelayPool>
      ) {
        relayPoolOptions(args[1]);
        super(...args);
      }
    },
  };
});

import { HermesChatClient } from "./hermes.js";

describe("HermesChatClient relay posture", () => {
  it("effectively disables destructive limit:0 relay probes", () => {
    new HermesChatClient({
      privateKey: "1".padStart(64, "0"),
      serverPubkey: "1".repeat(64),
      relays: ["ws://localhost:10547"],
    });

    expect(relayPoolOptions).toHaveBeenCalledOnce();
    expect(relayPoolOptions).toHaveBeenCalledWith({
      pingFrequencyMs: 2_147_400_000,
    });
    expect(relayPoolOptions.mock.calls[0]?.[0]).not.toHaveProperty(
      "pingTimeoutMs",
    );
  });
});

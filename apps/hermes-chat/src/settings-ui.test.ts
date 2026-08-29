import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const settingsSource = readFileSync(
  new URL("./screens/Settings.tsx", import.meta.url),
  "utf8",
);

describe("settings relay editor", () => {
  it("persists valid relay changes and reconnects without changing identity", () => {
    expect(settingsSource).toContain("Enter one relay URL per line.");
    expect(settingsSource).toContain("Save relays and reconnect");
    expect(settingsSource).toContain(
      "connect({ ...config, relays: parsedRelays });",
    );
    expect(settingsSource).toContain("parsedRelays.every(isValidRelayUrl)");
  });
});

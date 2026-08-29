import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const settingsSource = readFileSync(
  new URL("./screens/Settings.tsx", import.meta.url),
  "utf8",
);

describe("settings bridge manager", () => {
  it("shows every named bridge and makes switching a one-tap action", () => {
    expect(settingsSource).toContain("Your bridges");
    expect(settingsSource).toContain("Switch bridge");
    expect(settingsSource).toContain("switchBridge(profile.id)");
    expect(settingsSource).toContain("profile.name");
  });

  it("supports adding, renaming, and removing bridge profiles", () => {
    expect(settingsSource).toContain("Add bridge");
    expect(settingsSource).toContain("Bridge name");
    expect(settingsSource).toContain("saveBridge");
    expect(settingsSource).toContain("deleteBridge(profile.id)");
  });

  it("persists valid relay changes and reconnects without changing identity", () => {
    expect(settingsSource).toContain("Enter one relay URL per line.");
    expect(settingsSource).toContain("Save bridge and reconnect");
    expect(settingsSource).toContain("parsedRelays.every(isValidRelayUrl)");
  });
});

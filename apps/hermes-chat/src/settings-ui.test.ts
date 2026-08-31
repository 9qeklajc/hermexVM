import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const settingsSource = readFileSync(
  new URL("./screens/Settings.tsx", import.meta.url),
  "utf8",
);
const viteConfigSource = readFileSync(
  new URL("../vite.config.ts", import.meta.url),
  "utf8",
);

describe("settings bridge manager", () => {
  it("shows every named bridge and makes switching a one-tap action", () => {
    expect(settingsSource).toContain("Your bridges");
    expect(settingsSource).toContain("Switch bridge");
    expect(settingsSource).toContain("switchBridge(profile.id)");
    expect(settingsSource).toContain("profile.name");
    expect(settingsSource).toContain("profile.config.relays.map");
    expect(settingsSource).toContain("bridge-profile-relay-item");
  });

  it("supports adding, renaming, and removing bridge profiles", () => {
    expect(settingsSource).toContain("Add bridge");
    expect(settingsSource).toContain("Bridge name");
    expect(settingsSource).toContain("saveBridge");
    expect(settingsSource).toContain("deleteBridge(profile.id)");
  });

  it("hot-adds valid relays on the bridge before saving and reconnecting", () => {
    expect(settingsSource).toContain("Enter one relay URL per line.");
    expect(settingsSource).toContain("Save bridge and reconnect");
    expect(settingsSource).toContain("parsedRelays.every(isValidRelayUrl)");
    expect(settingsSource).toContain("await updateBridge");
    expect(settingsSource).toContain("Updating bridge relays…");
    expect(settingsSource).toContain("setSaveError");
  });

  it("shows the build version at the bottom of Settings", () => {
    expect(settingsSource).toContain('className="settings-version"');
    expect(settingsSource).toContain("hermexVM v{__APP_VERSION__}");
    expect(viteConfigSource).toContain(
      "__APP_VERSION__: JSON.stringify(appPackage.version)",
    );
  });
});

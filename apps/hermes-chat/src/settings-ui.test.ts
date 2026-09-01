import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const settingsSource = readFileSync(
  new URL("./screens/Settings.tsx", import.meta.url),
  "utf8",
);
const relayEditorSource = readFileSync(
  new URL("./components/RelayEditor.tsx", import.meta.url),
  "utf8",
);
const storeSource = readFileSync(
  new URL("./lib/store.tsx", import.meta.url),
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
    expect(settingsSource).toContain("<RelayEditor");
    expect(relayEditorSource).toContain("Enter one relay URL per line.");
    expect(settingsSource).toContain("Save bridge and reconnect");
    expect(settingsSource).toContain("parsedRelays.every(isValidRelayUrl)");
    expect(settingsSource).toContain("await updateBridge");
    expect(settingsSource).toContain("Updating bridge relays…");
    expect(settingsSource).toContain("setSaveError");
  });

  it("persists corrected relays even when the broken connection has no client", () => {
    expect(storeSource).toContain("if (activeClient)");
    expect(storeSource).toContain(
      "await activeClient.ensureBridgeRelays(next.relays)",
    );
    expect(storeSource).not.toContain(
      "Connect to the bridge before changing its relay list.",
    );
  });

  it("shows the build version at the bottom of Settings", () => {
    expect(settingsSource).toContain('className="settings-version"');
    expect(settingsSource).toContain("hermexVM v{__APP_VERSION__}");
    expect(viteConfigSource).toContain(
      "__APP_VERSION__: JSON.stringify(appPackage.version)",
    );
  });
});

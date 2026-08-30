import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const agentsSource = readFileSync(
  new URL("./screens/Agents.tsx", import.meta.url),
  "utf8",
);
const profileSettingsSource = readFileSync(
  new URL("./screens/ProfileSettings.tsx", import.meta.url),
  "utf8",
);

describe("agent profile settings", () => {
  it("opens settings for an individual profile without replacing row navigation", () => {
    expect(agentsSource).toContain("Settings for ${agent.name}");
    expect(agentsSource).toContain('kind: "profile-settings"');
    expect(agentsSource).toContain('kind: "chats"');
  });

  it("reuses the conversation model picker and stages selection until save", () => {
    expect(profileSettingsSource).toContain("<ModelPicker");
    expect(profileSettingsSource).toContain("client.listModels({ agentId })");
    expect(profileSettingsSource).toContain("setDirty(true)");
    expect(profileSettingsSource).toContain("Save profile");
  });

  it("persists the selected model to the profile", () => {
    expect(profileSettingsSource).toContain("client.updateProfile");
    expect(profileSettingsSource).toContain("agentId,");
    expect(profileSettingsSource).toContain("model,");
  });
});

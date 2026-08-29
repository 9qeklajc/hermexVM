import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const connectSource = readFileSync(
  new URL("./screens/Connect.tsx", import.meta.url),
  "utf8",
);
const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("connect screen layout contract", () => {
  it("collects a custom bridge name for the first saved profile", () => {
    expect(connectSource).toContain("Bridge name");
    expect(connectSource).toContain("connect(next, bridgeName)");
  });

  it("wraps the generated client npub instead of overflowing the screen", () => {
    expect(connectSource).toContain(
      'className="connect-hint connect-client-npub"',
    );
    expect(styles).toMatch(
      /\.connect-client-npub code\s*{[^}]*max-width: 100%;[^}]*overflow-wrap: anywhere;/s,
    );
  });
});

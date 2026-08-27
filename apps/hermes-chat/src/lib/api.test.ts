import { describe, expect, it } from "vitest";
import { clientNpubFromPrivateKey } from "./api";

describe("client identity", () => {
  it("derives a public npub without exposing the client secret", () => {
    const secret = "1".repeat(64);
    const npub = clientNpubFromPrivateKey(secret);
    expect(npub).toMatch(/^npub1/);
    expect(npub).not.toContain(secret);
  });

  it("rejects malformed client keys", () => {
    expect(clientNpubFromPrivateKey("")).toBeNull();
    expect(clientNpubFromPrivateKey("not-a-key")).toBeNull();
  });
});

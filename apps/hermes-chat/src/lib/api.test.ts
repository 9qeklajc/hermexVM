import { nip19 } from "nostr-tools";
import { describe, expect, it } from "vitest";
import {
  clientNpubFromPrivateKey,
  clientNsecFromPrivateKey,
  npubFromPublicKey,
} from "./api";

describe("client identity", () => {
  it("derives a public npub without exposing the client secret", () => {
    const secret = "1".repeat(64);
    const npub = clientNpubFromPrivateKey(secret);
    expect(npub).toMatch(/^npub1/);
    expect(npub).not.toContain(secret);
  });

  it("normalizes hex and nsec client secrets", () => {
    const secret = "1".repeat(64);
    const nsec = clientNsecFromPrivateKey(secret);
    expect(nsec).toMatch(/^nsec1/);
    expect(clientNsecFromPrivateKey(nsec ?? "")).toBe(nsec);
    expect(clientNpubFromPrivateKey(nsec ?? "")).toBe(
      clientNpubFromPrivateKey(secret),
    );
  });

  it("normalizes bridge hex, npub, and nprofile public keys", () => {
    const pubkey = "2".repeat(64);
    const npub = nip19.npubEncode(pubkey);
    const nprofile = nip19.nprofileEncode({ pubkey, relays: [] });
    expect(npubFromPublicKey(pubkey)).toBe(npub);
    expect(npubFromPublicKey(npub)).toBe(npub);
    expect(npubFromPublicKey(nprofile)).toBe(npub);
  });

  it("rejects malformed client and public keys", () => {
    expect(clientNpubFromPrivateKey("")).toBeNull();
    expect(clientNpubFromPrivateKey("not-a-key")).toBeNull();
    expect(clientNsecFromPrivateKey("not-a-key")).toBeNull();
    expect(npubFromPublicKey("not-a-key")).toBeNull();
  });
});

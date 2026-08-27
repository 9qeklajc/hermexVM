import { describe, expect, it } from "vitest";
import {
  BRIDGE_ALLOWLIST_ENV,
  parseBridgeAllowlist,
  requireAllowedPublicKeys,
} from "./index.js";

const HEX = "1".repeat(64);
const NPUB = "npub1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygse4sl3h";

describe("bridge client allowlist", () => {
  it("accepts npub and hex entries, normalizes, and removes duplicates", () => {
    expect(parseBridgeAllowlist(`${NPUB}, ${HEX.toUpperCase()}`)).toEqual([
      HEX,
    ]);
  });

  it("fails closed when the shared allowlist is absent or empty", () => {
    expect(() => parseBridgeAllowlist(undefined)).toThrow(
      `${BRIDGE_ALLOWLIST_ENV} must contain at least one authorized client npub or 64-character hex public key`,
    );
    expect(() => parseBridgeAllowlist(" , \n \t ")).toThrow(/at least one/);
    expect(() => requireAllowedPublicKeys([])).toThrow(/at least one/);
  });

  it("rejects invalid NIP-19 types and mixed valid/invalid lists", () => {
    expect(() =>
      parseBridgeAllowlist(`nprofile1qqsp${"q".repeat(20)}`),
    ).toThrow();
    expect(() => parseBridgeAllowlist(`${HEX},not-a-pubkey`)).toThrow(
      `${BRIDGE_ALLOWLIST_ENV} entry 2 must be an npub or 64-character hex public key`,
    );
  });

  it("rejects secrets and malformed entries without echoing their value", () => {
    const secret =
      "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsmhltgl";
    expect(() => parseBridgeAllowlist(secret)).toThrow(
      `${BRIDGE_ALLOWLIST_ENV} entry 1 must be an npub or 64-character hex public key`,
    );
    try {
      parseBridgeAllowlist(secret);
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});

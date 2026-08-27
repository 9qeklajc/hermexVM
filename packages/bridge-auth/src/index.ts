import { nip19 } from "nostr-tools";

export const BRIDGE_ALLOWLIST_ENV = "CONTEXCGI_ALLOWED_NPUBS";

const HEX_PUBLIC_KEY = /^[0-9a-f]{64}$/i;

function normalizePublicKey(value: string, index: number): string {
  const trimmed = value.trim();
  if (HEX_PUBLIC_KEY.test(trimmed)) return trimmed.toLowerCase();

  try {
    const decoded = nip19.decode(trimmed);
    if (
      decoded.type === "npub" &&
      typeof decoded.data === "string" &&
      HEX_PUBLIC_KEY.test(decoded.data)
    ) {
      return decoded.data.toLowerCase();
    }
  } catch {
    // Report a value-free error below so accidental secret input is not logged.
  }

  throw new Error(
    `${BRIDGE_ALLOWLIST_ENV} entry ${index + 1} must be an npub or 64-character hex public key`,
  );
}

/** Normalize and validate an already-split bridge client allowlist. */
export function requireAllowedPublicKeys(
  values: readonly string[] | undefined,
): string[] {
  if (!values?.length) {
    throw new Error(
      `${BRIDGE_ALLOWLIST_ENV} must contain at least one authorized client npub`,
    );
  }
  return [...new Set(values.map(normalizePublicKey))];
}

/** Parse the shared comma/whitespace-separated allowlist used by every bridge. */
export function parseBridgeAllowlist(raw: string | undefined): string[] {
  const values = raw?.split(/[\s,]+/).filter(Boolean);
  return requireAllowedPublicKeys(values);
}

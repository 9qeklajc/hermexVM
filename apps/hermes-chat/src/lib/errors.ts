/**
 * True when `cause` is a *transient transport-level* failure — the ContextVM
 * /Nostr connection being closed, not yet established, or caught mid-reconnect
 * (background→foreground hot-swap, relay drop, explicit reconnect). The store
 * auto-reconnects and re-fetches on the new client, so these must never be
 * shown to the user as a permanent error. Use this to guard every visible
 * screen/load error surface; surface application-level failures only.
 */
export function isTransientTransportError(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  const msg = cause.message;
  return (
    msg.includes("Connection closed") ||
    msg.includes("-32000") ||
    msg.includes("Not connected") ||
    msg.includes("Request timed out")
  );
}

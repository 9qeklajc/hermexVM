import { useEffect, useState } from "react";
import { DEFAULT_RELAYS, parseRelays, type HermesConfig } from "../lib/api";
import { useConnectionState } from "../lib/store";
import { HermesMark } from "../components/ui";

function randomHexKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function ConnectScreen() {
  const { connect, status, error, config } = useConnectionState();
  const [relays, setRelays] = useState(
    config?.relays?.length
      ? config.relays.join(", ")
      : DEFAULT_RELAYS.join(", "),
  );
  const [serverPubkey, setServerPubkey] = useState(config?.serverPubkey ?? "");
  const [privateKey, setPrivateKey] = useState(config?.privateKey ?? "");

  // Persisted credentials load asynchronously on first mount; re-seed the form
  // from them (e.g. after a failed auto-connect) so nothing has to be re-typed.
  useEffect(() => {
    if (!config) return;
    if (config.serverPubkey) setServerPubkey(config.serverPubkey);
    if (config.privateKey) setPrivateKey(config.privateKey);
    if (config.relays?.length) setRelays(config.relays.join(", "));
  }, [config]);

  const busy = status === "connecting";

  const submit = () => {
    const next: HermesConfig = {
      privateKey: privateKey.trim() || randomHexKey(),
      serverPubkey: serverPubkey.trim(),
      relays: parseRelays(relays),
    };
    setPrivateKey(next.privateKey);
    connect(next);
  };

  return (
    <div className="connect-screen">
      <div className="connect-hero">
        <div className="connect-logo">
          <HermesMark size={64} />
        </div>
        <h1>hermexVM</h1>
        <p>Message your Hermes agents over ContextVM — no Telegram required.</p>
      </div>
      <div className="connect-form">
        <label>
          <span>Bridge public key</span>
          <input
            type="text"
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="npub… / nprofile… / hex"
            value={serverPubkey}
            onChange={(event) => setServerPubkey(event.target.value)}
          />
        </label>
        <label>
          <span>Relays</span>
          <input
            type="text"
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="wss://relay.example, ws://…"
            value={relays}
            onChange={(event) => setRelays(event.target.value)}
          />
        </label>
        <label>
          <span>Your client key</span>
          <div className="input-row">
            <input
              type="text"
              autoCapitalize="off"
              autoCorrect="off"
              placeholder="hex / nsec (blank = generate)"
              value={privateKey}
              onChange={(event) => setPrivateKey(event.target.value)}
            />
            <button
              type="button"
              className="button secondary compact"
              onClick={() => setPrivateKey(randomHexKey())}
            >
              Generate
            </button>
          </div>
        </label>
        {status === "error" && error ? (
          <div className="form-error" style={{ whiteSpace: "pre-wrap" }}>
            {error}
          </div>
        ) : null}
        <button
          className="button primary"
          disabled={
            busy || !serverPubkey.trim() || parseRelays(relays).length === 0
          }
          onClick={submit}
        >
          {busy ? "Connecting…" : "Connect"}
        </button>
        <p className="connect-hint">
          The hermes-bridge runs next to your Hermes install and prints its
          public key on startup — paste it here. Your client key is a Nostr
          identity stored only on this device.
        </p>
      </div>
    </div>
  );
}

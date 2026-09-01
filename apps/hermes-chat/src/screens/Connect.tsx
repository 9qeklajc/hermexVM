import { useEffect, useState } from "react";
import {
  DEFAULT_RELAYS,
  DEFAULT_SERVER_PUBKEY,
  clientNpubFromPrivateKey,
  isValidRelayUrl,
  parseRelays,
  type HermesConfig,
} from "../lib/api";
import { useConnectionState } from "../lib/store";
import { RelayEditor } from "../components/RelayEditor";
import { HermesMark } from "../components/ui";

function randomHexKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function ConnectScreen() {
  const { connect, status, error, config } = useConnectionState();
  const [bridgeName, setBridgeName] = useState("My bridge");
  const [relays, setRelays] = useState(
    config?.relays?.length
      ? config.relays.join("\n")
      : DEFAULT_RELAYS.join("\n"),
  );
  const [serverPubkey, setServerPubkey] = useState(
    config?.serverPubkey ?? DEFAULT_SERVER_PUBKEY,
  );
  const [privateKey, setPrivateKey] = useState(
    config?.privateKey ?? randomHexKey(),
  );

  // Persisted credentials load asynchronously on first mount; re-seed the form
  // from them (e.g. after a failed auto-connect) so nothing has to be re-typed.
  useEffect(() => {
    if (!config) return;
    if (config.serverPubkey) setServerPubkey(config.serverPubkey);
    if (config.privateKey) setPrivateKey(config.privateKey);
    if (config.relays?.length) setRelays(config.relays.join("\n"));
  }, [config]);

  const busy = status === "connecting";
  const clientNpub = clientNpubFromPrivateKey(privateKey);
  const parsedRelays = parseRelays(relays);
  const relaysValid =
    parsedRelays.length > 0 && parsedRelays.every(isValidRelayUrl);

  const submit = () => {
    const next: HermesConfig = {
      privateKey: privateKey.trim() || randomHexKey(),
      serverPubkey: serverPubkey.trim(),
      relays: parsedRelays,
    };
    setPrivateKey(next.privateKey);
    void connect(next, bridgeName);
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
          <span>Bridge name</span>
          <input
            type="text"
            placeholder="Home, Work, Server…"
            value={bridgeName}
            onChange={(event) => setBridgeName(event.target.value)}
          />
        </label>
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
        <RelayEditor
          value={relays}
          valid={relaysValid}
          onChange={setRelays}
          rows={Math.max(3, parsedRelays.length)}
        />
        <label>
          <span>Your client key</span>
          <div className="input-row">
            <input
              type="password"
              autoCapitalize="off"
              autoCorrect="off"
              placeholder="hex / nsec"
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
        <div className="connect-hint connect-client-npub">
          <strong>Client npub to whitelist:</strong>
          <code>{clientNpub ?? "Generate or enter a valid client key"}</code>
          {clientNpub ? (
            <button
              type="button"
              className="button secondary compact"
              onClick={() => void navigator.clipboard.writeText(clientNpub)}
            >
              Copy npub
            </button>
          ) : null}
        </div>
        {status === "error" && error ? (
          <div className="form-error" style={{ whiteSpace: "pre-wrap" }}>
            {error}
          </div>
        ) : null}
        <button
          className="button primary"
          disabled={
            busy ||
            !bridgeName.trim() ||
            !clientNpub ||
            !serverPubkey.trim() ||
            !relaysValid
          }
          onClick={submit}
        >
          {busy ? "Connecting…" : "Connect"}
        </button>
        <p className="connect-hint">
          The hermes-bridge runs next to your Hermes install and prints its
          public key on startup — paste it here. Add the client npub shown above
          to CONTEXCGI_ALLOWED_NPUBS before starting the bridge. Never copy the
          client secret into the bridge environment.
        </p>
      </div>
    </div>
  );
}

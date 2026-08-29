import { useMemo, useState } from "react";
import {
  clientNpubFromPrivateKey,
  clientNsecFromPrivateKey,
  isValidRelayUrl,
  npubFromPublicKey,
  parseRelays,
} from "../lib/api";
import { useConnectionState, useNav } from "../lib/store";
import { TopBar } from "../components/ui";

export function SettingsScreen() {
  const { config, connect, disconnect } = useConnectionState();
  const nav = useNav();
  const currentNsec = config
    ? (clientNsecFromPrivateKey(config.privateKey) ?? "")
    : "";
  const [nsec, setNsec] = useState(currentNsec);
  const [relays, setRelays] = useState(config?.relays.join("\n") ?? "");
  const [revealed, setRevealed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const clientNpub = useMemo(() => clientNpubFromPrivateKey(nsec), [nsec]);
  const bridgeNpub = config ? npubFromPublicKey(config.serverPubkey) : null;
  const canonicalNsec = clientNsecFromPrivateKey(nsec);
  const identityChanged =
    canonicalNsec !== null && canonicalNsec !== currentNsec;
  const parsedRelays = parseRelays(relays);
  const relaysValid =
    parsedRelays.length > 0 && parsedRelays.every(isValidRelayUrl);
  const relaysChanged =
    relaysValid &&
    (parsedRelays.length !== config?.relays.length ||
      parsedRelays.some((relay, index) => relay !== config?.relays[index]));

  if (!config) return null;

  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(`${label} copied`);
    } catch {
      setNotice(`Couldn't copy ${label.toLowerCase()}`);
    }
  };

  const saveIdentity = () => {
    if (!canonicalNsec || !identityChanged) return;
    nav.pop();
    connect({ ...config, privateKey: canonicalNsec });
  };

  const saveRelays = () => {
    if (!relaysChanged) return;
    nav.pop();
    connect({ ...config, relays: parsedRelays });
  };

  return (
    <div className="screen settings-screen">
      <TopBar title="Settings" back />
      <div className="settings-content">
        <section className="settings-section">
          <div className="settings-section-heading">
            <h2>Client identity</h2>
            <p>This identity authenticates this device with your bridge.</p>
          </div>

          <div className="identity-field">
            <span className="identity-label">Client npub</span>
            <code>{clientNpub ?? "Enter a valid nsec below"}</code>
            {clientNpub ? (
              <button
                type="button"
                className="button secondary compact"
                onClick={() => void copy("Client npub", clientNpub)}
              >
                Copy npub
              </button>
            ) : null}
          </div>

          <label className="identity-field identity-secret">
            <span className="identity-label">Client nsec</span>
            <div className="identity-input-row">
              <input
                type={revealed ? "text" : "password"}
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
                value={nsec}
                onChange={(event) => {
                  setNsec(event.target.value.trim());
                  setNotice(null);
                }}
                aria-invalid={!canonicalNsec}
              />
              <button
                type="button"
                className="button secondary compact"
                onClick={() => setRevealed((value) => !value)}
              >
                {revealed ? "Hide" : "Reveal"}
              </button>
            </div>
            <span className="secret-warning">
              Never share this secret. Reveal it before copying so secret access
              is always explicit.
            </span>
            {revealed && canonicalNsec ? (
              <button
                type="button"
                className="button secondary compact identity-copy-secret"
                onClick={() => void copy("Client nsec", canonicalNsec)}
              >
                Copy nsec
              </button>
            ) : null}
          </label>

          {!canonicalNsec ? (
            <div className="form-error">Enter a valid nsec secret key.</div>
          ) : null}
          <button
            type="button"
            className="button primary"
            disabled={!identityChanged}
            onClick={saveIdentity}
          >
            Save identity
          </button>
          <p className="settings-note">
            Changing the nsec also changes the client npub. Add the new npub to
            the bridge allowlist before saving or this device may lose access.
          </p>
        </section>

        <section className="settings-section">
          <div className="settings-section-heading">
            <h2>Bridge</h2>
            <p>Public connection details for the currently connected bridge.</p>
          </div>
          <div className="identity-field">
            <span className="identity-label">Bridge npub</span>
            <code>{bridgeNpub ?? config.serverPubkey}</code>
            <button
              type="button"
              className="button secondary compact"
              onClick={() =>
                void copy("Bridge npub", bridgeNpub ?? config.serverPubkey)
              }
            >
              Copy npub
            </button>
          </div>
          <label className="identity-field relay-editor">
            <span className="identity-label">Relays</span>
            <span className="field-help">Enter one relay URL per line.</span>
            <textarea
              rows={Math.max(3, parsedRelays.length)}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={relays}
              onChange={(event) => {
                setRelays(event.target.value);
                setNotice(null);
              }}
              aria-invalid={!relaysValid}
              placeholder={"wss://relay.example\nwss://another-relay.example"}
            />
          </label>
          {!relaysValid ? (
            <div className="form-error">
              Enter at least one valid ws:// or wss:// relay URL.
            </div>
          ) : null}
          <button
            type="button"
            className="button primary"
            disabled={!relaysChanged}
            onClick={saveRelays}
          >
            Save relays and reconnect
          </button>
          <p className="settings-note">
            Saving immediately reconnects the app through this relay list. Your
            identity and bridge npub stay unchanged.
          </p>
        </section>

        {notice ? (
          <div className="settings-notice" role="status">
            {notice}
          </div>
        ) : null}
        <button type="button" className="button danger" onClick={disconnect}>
          Disconnect this device
        </button>
      </div>
    </div>
  );
}

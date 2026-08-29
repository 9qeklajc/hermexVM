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
  const {
    config,
    bridges,
    activeBridgeId,
    activeBridgeName,
    updateBridge,
    addBridge,
    switchBridge,
    deleteBridge,
    disconnect,
  } = useConnectionState();
  const nav = useNav();
  const currentNsec = config
    ? (clientNsecFromPrivateKey(config.privateKey) ?? "")
    : "";
  const [name, setName] = useState(activeBridgeName ?? "My bridge");
  const [serverPubkey, setServerPubkey] = useState(config?.serverPubkey ?? "");
  const [nsec, setNsec] = useState(currentNsec);
  const [relays, setRelays] = useState(config?.relays.join("\n") ?? "");
  const [revealed, setRevealed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newServerPubkey, setNewServerPubkey] = useState("");
  const [newRelays, setNewRelays] = useState(config?.relays.join("\n") ?? "");

  const clientNpub = useMemo(() => clientNpubFromPrivateKey(nsec), [nsec]);
  const bridgeNpub = serverPubkey ? npubFromPublicKey(serverPubkey) : null;
  const canonicalNsec = clientNsecFromPrivateKey(nsec);
  const parsedRelays = parseRelays(relays);
  const relaysValid =
    parsedRelays.length > 0 && parsedRelays.every(isValidRelayUrl);
  const parsedNewRelays = parseRelays(newRelays);
  const newBridgeValid =
    newName.trim().length > 0 &&
    newServerPubkey.trim().length > 0 &&
    parsedNewRelays.length > 0 &&
    parsedNewRelays.every(isValidRelayUrl);

  if (!config || !activeBridgeId) return null;

  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(`${label} copied`);
    } catch {
      setNotice(`Couldn't copy ${label.toLowerCase()}`);
    }
  };

  const saveBridge = async () => {
    if (
      !name.trim() ||
      !serverPubkey.trim() ||
      !canonicalNsec ||
      !relaysValid ||
      saving
    ) {
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await updateBridge(activeBridgeId, name, {
        privateKey: canonicalNsec,
        serverPubkey: serverPubkey.trim(),
        relays: parsedRelays,
      });
      nav.pop();
    } catch (cause) {
      setSaveError(
        cause instanceof Error
          ? cause.message
          : "Couldn't update the bridge relay list.",
      );
    } finally {
      setSaving(false);
    }
  };

  const createBridge = () => {
    if (!newBridgeValid) return;
    addBridge(newName, {
      privateKey: config.privateKey,
      serverPubkey: newServerPubkey.trim(),
      relays: parsedNewRelays,
    });
  };

  return (
    <div className="screen settings-screen">
      <TopBar title="Settings" subtitle={activeBridgeName ?? undefined} back />
      <div className="settings-content">
        <section className="settings-section">
          <div className="settings-section-heading settings-heading-row">
            <div>
              <h2>Your bridges</h2>
              <p>Tap once to move this app to another Hermes bridge.</p>
            </div>
            <button
              type="button"
              className="button secondary compact"
              onClick={() => setAdding((value) => !value)}
            >
              {adding ? "Cancel" : "Add bridge"}
            </button>
          </div>

          <div className="bridge-profile-list">
            {bridges.map((profile) => {
              const active = profile.id === activeBridgeId;
              return (
                <div
                  className={`bridge-profile ${active ? "active" : ""}`}
                  key={profile.id}
                >
                  <button
                    type="button"
                    className="bridge-profile-main"
                    disabled={active}
                    onClick={() => switchBridge(profile.id)}
                    aria-label={
                      active
                        ? `${profile.name}, active`
                        : `Switch bridge to ${profile.name}`
                    }
                  >
                    <span className="bridge-profile-name">{profile.name}</span>
                    <span className="bridge-profile-relay">
                      {profile.config.relays.map((relay) => (
                        <span className="bridge-profile-relay-item" key={relay}>
                          {relay.replace(/^wss?:\/\//, "")}
                        </span>
                      ))}
                    </span>
                    <span className="bridge-profile-status">
                      {active ? "Connected" : "Switch bridge"}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="bridge-profile-delete"
                    aria-label={`Remove ${profile.name}`}
                    onClick={() => deleteBridge(profile.id)}
                  >
                    Remove
                  </button>
                </div>
              );
            })}
          </div>

          {adding ? (
            <div className="bridge-add-form">
              <label>
                <span>Bridge name</span>
                <input
                  autoFocus
                  value={newName}
                  placeholder="Work, Home, VPS…"
                  onChange={(event) => setNewName(event.target.value)}
                />
              </label>
              <label>
                <span>Bridge public key</span>
                <input
                  autoCapitalize="off"
                  autoCorrect="off"
                  value={newServerPubkey}
                  placeholder="npub… / nprofile… / hex"
                  onChange={(event) => setNewServerPubkey(event.target.value)}
                />
              </label>
              <label>
                <span>Relays</span>
                <textarea
                  rows={3}
                  value={newRelays}
                  placeholder={
                    "wss://relay.example\nwss://another-relay.example"
                  }
                  onChange={(event) => setNewRelays(event.target.value)}
                />
              </label>
              <button
                type="button"
                className="button primary"
                disabled={!newBridgeValid}
                onClick={createBridge}
              >
                Add and connect
              </button>
              <p className="settings-note">
                The new bridge reuses this device&apos;s client identity, so
                whitelist the client npub below on that bridge first.
              </p>
            </div>
          ) : null}
        </section>

        <section className="settings-section">
          <div className="settings-section-heading">
            <h2>Edit active bridge</h2>
            <p>Rename it or update its connection details.</p>
          </div>
          <label className="identity-field">
            <span className="identity-label">Bridge name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="identity-field">
            <span className="identity-label">Bridge public key</span>
            <input
              autoCapitalize="off"
              autoCorrect="off"
              value={serverPubkey}
              onChange={(event) => setServerPubkey(event.target.value)}
            />
            <code>{bridgeNpub ?? serverPubkey}</code>
            <button
              type="button"
              className="button secondary compact"
              onClick={() =>
                void copy("Bridge npub", bridgeNpub ?? serverPubkey)
              }
            >
              Copy npub
            </button>
          </label>
          <label className="identity-field relay-editor">
            <span className="identity-label">Relays</span>
            <span className="field-help">Enter one relay URL per line.</span>
            <textarea
              rows={Math.max(3, parsedRelays.length)}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={relays}
              onChange={(event) => setRelays(event.target.value)}
              aria-invalid={!relaysValid}
              placeholder={"wss://relay.example\nwss://another-relay.example"}
            />
          </label>
          {!relaysValid ? (
            <div className="form-error">
              Enter at least one valid ws:// or wss:// relay URL.
            </div>
          ) : null}
        </section>

        <section className="settings-section">
          <div className="settings-section-heading">
            <h2>Client identity</h2>
            <p>
              This identity authenticates this device with the active bridge.
            </p>
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
                onChange={(event) => setNsec(event.target.value.trim())}
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
              Never share this secret. Changing it also changes the client npub.
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
            disabled={
              saving ||
              !name.trim() ||
              !serverPubkey.trim() ||
              !canonicalNsec ||
              !relaysValid
            }
            onClick={() => void saveBridge()}
          >
            {saving ? "Updating bridge relays…" : "Save bridge and reconnect"}
          </button>
          {saveError ? (
            <div className="form-error" role="alert">
              {saveError}
            </div>
          ) : null}
        </section>

        {notice ? (
          <div className="settings-notice" role="status">
            {notice}
          </div>
        ) : null}
        <button type="button" className="button danger" onClick={disconnect}>
          Remove all bridges from this device
        </button>
      </div>
    </div>
  );
}

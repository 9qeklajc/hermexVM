# hermexVM bridge

The bridge exposes local Hermes Agent profiles and conversations as private ContextVM tools over Nostr. It launches Hermes `tui_gateway` through the configured Hermes virtual environment.

Use the complete operator guide in [`../../README.md`](../../README.md). It covers bridge-key generation, finding the bridge `npub`, obtaining the app/client `npub`, mandatory allowlisting, relays, encryption, and whisper.cpp voice setup.

## Required runtime configuration

The bridge automatically loads the repository-root `.env`.

- `HERMES_BRIDGE_PRIVATE_KEY_FILE` or `HERMES_BRIDGE_PRIVATE_KEY` — bridge secret; set exactly one.
- `HERMES_BRIDGE_RELAYS` — one or more comma/space-separated `ws://` or `wss://` relay URLs.
- `CONTEXCGI_ALLOWED_NPUBS` — mandatory comma/space-separated client `npub`s or hex pubkeys.

The allowlist fails closed and is passed to the ContextVM transport as `allowedPublicKeys`. A missing, empty, secret, or malformed entry prevents startup.

See [`.env.example`](../../.env.example) for Hermes paths, encryption/public settings, file storage, a shared `HERMES_WHISPER_SERVICE_URL` (with optional bearer token), local whisper.cpp fallback paths, and bounded transcription policy.

## Start

```bash
pnpm bridge:start
```

Startup prints the bridge's public key in hex and `npub` forms. It never prints the bridge secret.

## Development

```bash
pnpm --filter @contexcgi/hermes-bridge test:run
pnpm --filter @contexcgi/hermes-bridge check-types
pnpm --filter @contexcgi/hermes-bridge build
```

The fake gateway fixture is `test-fixtures/fake-gateway.mjs`; from the repository root, `pnpm smoke` validates the full app-client/bridge flow without a Hermes installation.

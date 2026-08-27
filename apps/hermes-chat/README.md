# hermexVM app

React + Vite + Capacitor client for the standalone hermexVM bridge.

The full setup guide is in [`../../README.md`](../../README.md), including bridge identity, client `npub` allowlisting, relays, whisper.cpp voice transcription, and Android builds.

## First run

A fresh install has no embedded bridge or client secret. The Connect screen generates a unique client key and displays the corresponding **Client npub to whitelist**. Add that public identity to the bridge's `CONTEXCGI_ALLOWED_NPUBS`, restart the bridge, then connect with the bridge's printed `npub` and the same relay list.

The successful connection is stored on-device with Capacitor Preferences. Use **Edit connection settings** after a failed connection; use **Generate** to rotate the client identity, then update the bridge whitelist.

## Development

```bash
pnpm app:dev
pnpm --filter @contexcgi/hermes-chat test:run
pnpm app:build
```

Non-secret prefills may be configured in the repository-root `.env`:

```dotenv
VITE_HERMEX_DEFAULT_SERVER_PUBKEY=npub1bridge...
VITE_HERMEX_DEFAULT_RELAYS=wss://relay.contextvm.org
VITE_DEV_HOST=0.0.0.0
VITE_DEV_PORT=5176
```

Never add a client private key to a `VITE_*` variable; it would be bundled publicly.

## Android

- App ID: `ai.hermex.vm`
- Label: `hermexVM`
- minSdk: 23
- targetSdk: 35

```bash
pnpm app:apk
```

Gradle output: `android/app/build/outputs/apk/debug/app-debug.apk`.

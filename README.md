# hermexVM

A standalone repository for the hermexVM Android/web client and its local ContextVM-to-Hermes bridge.

The source was extracted from the ContexCGI monorepo without removing or modifying the original copy. The workspace keeps the required shared packages locally so it can build independently.

## Architecture

```text
hermexVM Android app ── ContextVM over Nostr ──▶ Hermes bridge ── JSON-RPC stdio ──▶ Hermes Agent tui_gateway
```

- `apps/hermes-chat` — React + Vite + Capacitor app, branded **hermexVM**.
- `apps/hermes-bridge` — Node bridge that runs beside a Hermes Agent installation.
- `packages/` — the exact local ContextVM dependency closure required by the app and bridge.
- `scripts/` — fake-stack development runner and end-to-end smoke test.

Android identity: `ai.hermex.vm`.

## Requirements

- Node.js 18+
- pnpm 9
- For Android: JDK 21 and Android SDK 35
- For a real bridge: a Hermes Agent checkout/install and a Nostr relay

## Install and verify

```bash
pnpm install
pnpm check-types
pnpm test:run
pnpm build
```

## Run the bridge

```bash
export HERMES_BRIDGE_PRIVATE_KEY=<hex-or-nsec>
export CONTEXCGI_ALLOWED_NPUBS=<authorized-client-npub>
export HERMES_BRIDGE_RELAYS=wss://relay.contextvm.org
# Optional overrides:
# export HERMES_HOME=$HOME/.hermes
# export HERMES_AGENT_ROOT=$HERMES_HOME/hermes-agent

pnpm bridge:start
```

See `apps/hermes-bridge/README.md` for all bridge, handoff, voice, and file-transfer settings.

## Run the app

```bash
pnpm app:dev
```

The dev server listens on `http://localhost:5176`.

## Fake stack and smoke test

```bash
pnpm fake-stack
# or run the self-contained smoke test:
pnpm smoke
```

These use `apps/hermes-bridge/test-fixtures/fake-gateway.mjs`, so no Hermes installation or model spend is required.

## Build the Android APK

```bash
export JAVA_HOME=/path/to/jdk-21
export ANDROID_HOME=/path/to/android-sdk
export PATH="$JAVA_HOME/bin:$PATH"

echo "sdk.dir=$ANDROID_HOME" > apps/hermes-chat/android/local.properties
pnpm app:apk
```

Output: `apps/hermes-chat/android/app/build/outputs/apk/debug/app-debug.apk`.
The repository artifact is `apps/hermes-chat/hermexvm-debug.apk`.

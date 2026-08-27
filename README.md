# hermexVM

hermexVM is a self-contained Android/web client plus a private ContextVM bridge for a local [Hermes Agent](https://hermes-agent.nousresearch.com) installation.

```text
hermexVM app ── encrypted ContextVM over Nostr ──▶ Hermes bridge ── JSON-RPC stdio ──▶ Hermes tui_gateway
```

The bridge runs beside Hermes, holds the bridge identity, and accepts calls only from explicitly allowlisted client `npub`s. The Android app generates a unique client identity on first setup; no client secret is shipped in source or in the APK.

## Repository layout

- `apps/hermes-chat` — React, Vite, and Capacitor app branded **hermexVM** (`ai.hermex.vm`).
- `apps/hermes-bridge` — local Node.js bridge to Hermes `tui_gateway`.
- `packages/` — local ContextVM protocol, client, authentication, relay, and file-transfer packages.
- `scripts/` — fake Hermes stack and end-to-end smoke test.

## Requirements

- Node.js 18+
- pnpm 9
- `nak` for Nostr key generation
- A Hermes Agent checkout with:
  - `$HERMES_AGENT_ROOT/tui_gateway`
  - `$HERMES_AGENT_ROOT/venv/bin/python`
- A reachable Nostr relay
- For Android builds: JDK 21 and Android SDK 35
- For voice transcription: `ffmpeg`, `ffprobe`, and a local whisper.cpp model

## Install and verify

```bash
git clone http://localhost:3000/OWNER/hermexVM.git
cd hermexVM
pnpm install --frozen-lockfile
pnpm check-types
pnpm test:run
pnpm build
```

For a self-contained test that does not need Hermes or model inference:

```bash
pnpm smoke
# Or keep the fake stack running for app development:
pnpm fake-stack
```

## 1. Create the local environment file

The bridge automatically loads the repository-root `.env`. Vite also reads this same file for non-secret app build defaults.

```bash
cp .env.example .env
chmod 600 .env
```

Never commit `.env`. Never place a client or bridge secret in a `VITE_*` variable: Vite values are public and bundled into the web app/APK.

## 2. Generate a persistent bridge identity

Generate the key directly into an owner-readable file so it is not printed or stored in Git:

```bash
install -d -m 700 "$HOME/.hermes-bridge"
umask 077
if [ ! -s "$HOME/.hermes-bridge/bridge.sec" ]; then
  nak key generate > "$HOME/.hermes-bridge/bridge.sec"
fi
chmod 600 "$HOME/.hermes-bridge/bridge.sec"
```

Set its absolute path in `.env`:

```dotenv
HERMES_BRIDGE_PRIVATE_KEY_FILE=/home/you/.hermes-bridge/bridge.sec
```

Use either `HERMES_BRIDGE_PRIVATE_KEY_FILE` or `HERMES_BRIDGE_PRIVATE_KEY`, never both. The file option is recommended.

### Find the bridge `npub` before startup

This command reads the secret file without displaying the secret and prints only its public `npub`:

```bash
node --input-type=module <<'NODE'
import { readFileSync } from "node:fs";
import { getPublicKey, nip19 } from "nostr-tools";
import { hexToBytes } from "nostr-tools/utils";

const path = `${process.env.HOME}/.hermes-bridge/bridge.sec`;
const secret = hexToBytes(readFileSync(path, "utf8").trim());
console.log(nip19.npubEncode(getPublicKey(secret)));
NODE
```

A successful bridge startup also prints both its hex pubkey and `npub`. Paste either public form into the app; never paste the bridge secret into the app.

## 3. Get the app/client `npub`

The bridge whitelist needs the app's public identity before it will accept that device. This release intentionally discards connection state from the earlier build that shipped a shared identity, so upgraded installations also return to setup once.

1. Open the APK or run `pnpm app:dev` and visit `http://localhost:5176`.
2. The first-run Connect screen generates a unique client key.
3. Copy **Client npub to whitelist**.
4. Keep the client secret on the device. Do not copy it into `.env`.

Tap **Generate** to rotate the client identity. If the connection is misconfigured, use **Edit connection settings** on the recovery screen.

## 4. Configure the mandatory client whitelist

Put the copied client `npub` in `.env`:

```dotenv
CONTEXCGI_ALLOWED_NPUBS=npub1your_authorized_device_here
```

Authorize multiple devices with commas or spaces:

```dotenv
CONTEXCGI_ALLOWED_NPUBS=npub1phone...,npub1tablet... 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

Accepted entries are `npub`s or 64-character hex public keys. `nsec`, malformed, empty, or missing values are rejected. The bridge fails closed at startup, normalizes the allowlist, and passes it to the ContextVM transport as `allowedPublicKeys`; non-allowlisted callers cannot initialize or call tools.

If a client secret was exposed, do not whitelist its public key. Generate a new client identity and replace the old whitelist entry.

## 5. Configure Hermes, relays, and encryption

Edit `.env` with absolute paths for your machine:

```dotenv
HERMES_BRIDGE_RELAYS=wss://relay.contextvm.org
HERMES_BRIDGE_PUBLIC=false
HERMES_BRIDGE_REQUIRE_ENCRYPTION=true

HERMES_HOME=/home/you/.hermes
HERMES_AGENT_ROOT=/home/you/.hermes/hermes-agent
HERMES_BRIDGE_DATA_ROOT=/home/you/.hermes-bridge/data
HERMES_BRIDGE_FILE_TRANSFER_ROOT=/home/you/.hermes-bridge/files
```

Use the same relay list in the app. The bridge requires at least one valid `ws://` or `wss://` relay. Encryption defaults to required and public announcements default to disabled.

Check the Hermes gateway before startup:

```bash
test -e "$HOME/.hermes/hermes-agent/tui_gateway"
test -x "$HOME/.hermes/hermes-agent/venv/bin/python"
```

## 6. Start the bridge

```bash
pnpm bridge:start
```

Successful startup prints:

```text
Hermes bridge ONLINE
pubkey (hex):  ...
pubkey (npub): npub1...
relays:        ...
voice:         ready (local whisper.cpp) | unavailable (...)
```

Paste the printed bridge `npub` and exact relay list into the app, confirm the displayed client `npub` is in `CONTEXCGI_ALLOWED_NPUBS`, then tap **Connect**.

## Voice recordings with local whisper.cpp

The app records at most 60 seconds, uploads the audio to the bridge, and inserts the transcript into the editable message draft. Audio is not sent to a cloud transcription service.

### Install build dependencies

Debian/Ubuntu:

```bash
sudo apt-get update
sudo apt-get install -y ffmpeg git cmake build-essential
```

### Build whisper.cpp and download a multilingual model

```bash
mkdir -p "$HOME/.local/src"
git clone --depth 1 --branch v1.9.1 \
  https://github.com/ggml-org/whisper.cpp.git \
  "$HOME/.local/src/whisper.cpp"
cmake -S "$HOME/.local/src/whisper.cpp" \
      -B "$HOME/.local/src/whisper.cpp/build" \
      -DWHISPER_BUILD_EXAMPLES=ON
cmake --build "$HOME/.local/src/whisper.cpp/build" -j"$(nproc)"
bash "$HOME/.local/src/whisper.cpp/models/download-ggml-model.sh" base
```

The `base` model is multilingual. Do not use an `.en` model if you need German or other non-English languages.

### Validate whisper.cpp

```bash
ffmpeg -version
ffprobe -version
test -x "$HOME/.local/src/whisper.cpp/build/bin/whisper-cli"
test -r "$HOME/.local/src/whisper.cpp/models/ggml-base.bin"

"$HOME/.local/src/whisper.cpp/build/bin/whisper-cli" \
  -m "$HOME/.local/src/whisper.cpp/models/ggml-base.bin" \
  -f "$HOME/.local/src/whisper.cpp/samples/jfk.wav" \
  -otxt -of /tmp/hermexvm-whisper-test -np -nt
test -s /tmp/hermexvm-whisper-test.txt
rm -f /tmp/hermexvm-whisper-test.txt
```

### Enable voice in `.env`

Use absolute paths:

```dotenv
HERMES_WHISPER_ENABLED=true
HERMES_WHISPER_CLI=/home/you/.local/src/whisper.cpp/build/bin/whisper-cli
HERMES_WHISPER_MODEL=/home/you/.local/src/whisper.cpp/models/ggml-base.bin
HERMES_FFMPEG=/usr/bin/ffmpeg
HERMES_FFPROBE=/usr/bin/ffprobe
HERMES_TRANSCRIPTION_MAX_BYTES=8388608
HERMES_TRANSCRIPTION_MAX_DURATION_SECONDS=60
HERMES_TRANSCRIPTION_TIMEOUT_MS=180000
```

Restart the bridge and require `voice: ready (local whisper.cpp)` in its startup output. If it reports unavailable, verify the executable/model paths, execute/read permissions, and `ffmpeg`/`ffprobe`. On Android, also grant microphone and notification permissions.

Safety bounds are strict: 64 KiB–8 MiB audio, 1–60 seconds, and a 15–300 second processing timeout. Invalid values stop bridge startup rather than silently weakening policy.

## App build-time defaults

These `.env` values are optional and non-secret. They make a deployment-specific build prefill the Connect screen:

```dotenv
VITE_HERMEX_DEFAULT_SERVER_PUBKEY=npub1bridge...
VITE_HERMEX_DEFAULT_RELAYS=wss://relay.contextvm.org
VITE_DEV_HOST=0.0.0.0
VITE_DEV_PORT=5176
```

No client private key build variable exists by design.

## Build the Android APK

```bash
export JAVA_HOME=/path/to/jdk-21
export ANDROID_HOME=/path/to/android-sdk
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
printf 'sdk.dir=%s\n' "$ANDROID_HOME" \
  > apps/hermes-chat/android/local.properties
pnpm app:apk
```

Outputs:

- Gradle: `apps/hermes-chat/android/app/build/outputs/apk/debug/app-debug.apk`
- Checked-in artifact: `apps/hermes-chat/hermexvm-debug.apk`

Install with:

```bash
adb install -r apps/hermes-chat/hermexvm-debug.apk
```

## Troubleshooting

- **Bridge refuses startup:** fill `HERMES_BRIDGE_PRIVATE_KEY_FILE`, `HERMES_BRIDGE_RELAYS`, and `CONTEXCGI_ALLOWED_NPUBS`; booleans must be exactly `true` or `false`.
- **App times out:** verify bridge and app use the same relays and that the app's displayed client `npub` is allowlisted.
- **Unauthorized client:** replace the whitelist entry with the exact client `npub` shown on that device and restart the bridge.
- **Need to change settings:** use **Edit connection settings**; generating a new key requires updating the whitelist.
- **Voice unavailable:** verify paths and restart until the bridge prints `voice: ready (local whisper.cpp)`.
- **Hermes not found:** set `HERMES_AGENT_ROOT` to the checkout containing `tui_gateway` and executable `venv/bin/python`.

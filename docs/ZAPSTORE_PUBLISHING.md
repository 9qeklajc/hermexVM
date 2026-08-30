# Publish hermexVM to Zapstore

This runbook publishes the Android app in `apps/hermes-chat` to Zapstore using the official [`zsp`](https://github.com/zapstore/zsp) CLI.

For background, requirements, caveats, and sources, see [`research/zapstore-publishing.md`](research/zapstore-publishing.md).

## Prerequisites

Do not publish until all items are complete:

- [ ] The project has an owner-approved license.
- [ ] The source repository is available at a stable public HTTPS URL.
- [ ] A permanent Android production signing key has been selected and backed up.
- [ ] The expected signing-certificate SHA-256 is documented and verified.
- [ ] A stable Nostr publisher identity has been selected.
- [ ] The publisher secret is stored outside the repository.
- [ ] Store description, icon, screenshots, and release notes are ready.
- [ ] `versionCode` is greater than every previously distributed version.
- [ ] The exact source commit is tagged or otherwise recorded.

Never commit:

- Android keystores or signing-property files;
- keystore passwords;
- Nostr `nsec` values;
- NIP-46 bunker secrets;
- CI secrets.

## 1. Install `zsp`

Install a pinned binary from the [official releases](https://github.com/zapstore/zsp/releases), or install the current source version:

```bash
go install github.com/zapstore/zsp@latest
zsp --version
```

Pin and checksum a specific release before using this in CI.

## 2. Create the listing assets

Create screenshots under:

```text
apps/hermes-chat/store/zapstore/screenshots/
```

Recommended screenshots:

1. connection setup;
2. chats;
3. agent controls;
4. profile/settings;
5. file or voice-message workflow.

The existing store-icon source is:

```text
apps/hermes-chat/public/app-icon.png
```

Add release notes to `CHANGELOG.md`.

## 3. Create `zapstore.yaml`

Create `zapstore.yaml` at the repository root:

```yaml
repository: https://github.com/OWNER/hermexVM
release_source: ./apps/hermes-chat/android/app/build/outputs/apk/release/app-release.apk

name: hermexVM
summary: Securely control a remote Hermes agent from Android over Nostr

description: |
  hermexVM is an Android client for connecting to a self-hosted Hermes bridge
  over encrypted Nostr transport. It provides chats, agent controls, file
  transfer, voice messages, and connection/profile management.

  A separately deployed and configured Hermes bridge is required.

tags:
  - nostr
  - ai
  - productivity
  - developer-tools

license: REPLACE_WITH_APPROVED_SPDX_ID
website: https://PUBLIC-WEBSITE.example
icon: ./apps/hermes-chat/public/app-icon.png

images:
  - ./apps/hermes-chat/store/zapstore/screenshots/01-connect.png
  - ./apps/hermes-chat/store/zapstore/screenshots/02-chats.png
  - ./apps/hermes-chat/store/zapstore/screenshots/03-agent.png
  - ./apps/hermes-chat/store/zapstore/screenshots/04-settings.png

release_notes: ./CHANGELOG.md
```

Replace every placeholder before publishing.

Only add `supported_nips` after confirming which NIPs the app itself implements.

## 4. Run project verification

```bash
pnpm check
pnpm smoke
```

Do not continue if either command fails.

## 5. Build the release-signed APK

```bash
: "${JAVA_HOME:?Set JAVA_HOME to a JDK 21 installation}"
: "${ANDROID_HOME:?Set ANDROID_HOME to the Android SDK}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"
: "${HERMEXVM_SIGNING_PROPERTIES:?Set HERMEXVM_SIGNING_PROPERTIES to the release signing properties file}"

pnpm app:apk:release
```

Expected artifact:

```text
apps/hermes-chat/android/app/build/outputs/apk/release/app-release.apk
```

Do not publish `app-debug.apk`.

## 6. Verify the APK

```bash
APK=apps/hermes-chat/android/app/build/outputs/apk/release/app-release.apk
APKSIGNER="$ANDROID_HOME/build-tools/35.0.0/apksigner"

"$APKSIGNER" verify --verbose --print-certs "$APK"
sha256sum "$APK"
zsp apk --extract "$APK"
```

Confirm:

- package ID is `ai.hermex.vm`;
- version name and code are correct;
- version code increased since the previous release;
- certificate SHA-256 matches the permanent production certificate;
- minimum and target SDK values are expected;
- the APK architecture/platform information is correct.

The certificate observed during the 2026-08-29 audit was:

```text
510d78c4ea01e335d86509280d2b473a2745717ff5869f64ea47407278537427
```

Do not rely on this value until the repository owner confirms that its key is the intended permanent production key.

## 7. Validate without publishing

```bash
zsp publish --check zapstore.yaml
```

The command should exit successfully and report `ai.hermex.vm`.

For the first release, use the interactive wizard and inspect its preview:

```bash
SIGN_WITH=browser zsp publish --wizard
```

Stop before approval if any package, certificate, version, URL, screenshot, or event data is wrong.

## 8. Publish the first release

Browser signing is recommended for the first release:

```bash
SIGN_WITH=browser \
RELAY_URLS=wss://relay.zapstore.dev \
BLOSSOM_URL=https://cdn.zapstore.dev \
zsp publish zapstore.yaml
```

Approve the events only after reviewing the preview.

For later protected automation, prefer a NIP-46 signer:

```bash
SIGN_WITH="$ZAPSTORE_BUNKER_URL" \
RELAY_URLS=wss://relay.zapstore.dev \
BLOSSOM_URL=https://cdn.zapstore.dev \
zsp publish -y --channel main --commit "$RELEASE_COMMIT" zapstore.yaml
```

Avoid passing a raw `nsec` unless no safer signing method is available.

## 9. Verify the published release

After publishing:

- [ ] Confirm the app appears under the intended publisher npub.
- [ ] Verify name, description, icon, screenshots, license, and source URL.
- [ ] Verify package ID, version, APK hash, and signing certificate.
- [ ] Install from Zapstore on a clean Android device.
- [ ] Test connection setup and core app workflows.
- [ ] Publish a higher-version test update signed by the same Android key.
- [ ] Confirm Android accepts the update without uninstalling the previous version.
- [ ] Record the event IDs/naddrs and release details.

Archive the following without secrets:

- zsp version;
- source commit/tag;
- APK SHA-256;
- signing-certificate SHA-256;
- package ID;
- version name and version code;
- Zapstore event IDs/naddrs;
- publication and verification logs.

## Publishing updates

For every update:

1. keep `applicationId` as `ai.hermex.vm`;
2. use the same production Android signing key;
3. increase `versionCode`;
4. update `versionName` and `CHANGELOG.md`;
5. tag the exact source commit;
6. rebuild and rerun all verification steps;
7. publish with the same Nostr publisher identity and channel;
8. test an in-place upgrade from the previous Zapstore version.

`zsp --overwrite-release` bypasses its unchanged-release cache. Use it only to correct publication mechanics after reviewing the generated events; it does not replace normal Android versioning.

## Important caveats

- zsp currently publishes APKs; do not assume AAB support unless the installed release documents it.
- zsp describes its event model as NIP-82 compliant, but NIP-82 is not currently listed as an accepted canonical NIP. Let zsp construct the events.
- Nostr deletion requests and Blossom deletion do not guarantee global erasure. Treat published APKs and metadata as permanent.
- Relay publication and Blossom upload are separate operations. Verify both succeeded.
- Permissionless publication does not guarantee search prominence or curation.
- Before every release, inspect the pinned version's local help:

```bash
zsp publish --help
zsp identity --help
```

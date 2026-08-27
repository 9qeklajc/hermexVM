# hermexVM

A Telegram-style Android/web app for talking to your local
[Hermes Agent](https://hermes-agent.nousresearch.com) profiles — over
**ContextVM (MCP over Nostr)** instead of Telegram.

```
hermexVM app ──ContextVM/Nostr──▶ hermes-bridge ──stdio JSON-RPC──▶ hermes tui_gateway
   (Android)     ◀── CEP-41 stream ──  (same host as      (spawned child, serves
                                        the Hermes install) every profile)
```

- **Agents screen** — every Hermes profile on the bridge host (the default
  `~/.hermes` plus named profiles), with description, soul excerpt, and model.
- **Conversations** — each agent's persisted Hermes sessions, including chats
  started from other surfaces (Telegram, TUI, cron), newest first.
- **Live chat** — one `hermes.chat.send` tool call per message; the whole turn
  (thinking, tool calls, response deltas) streams back as JSONL over a CEP-41
  open stream. Mid-turn command approvals surface as tappable cards.
- **Voice messages** — the composer mic records up to 60s, uploads the audio
  as small encrypted chunks, and the bridge transcribes it locally with
  whisper.cpp (no cloud STT); the transcript lands in the draft, still
  editable before sending.
- **Linked conversations** — long-press a completed user/assistant message and
  choose **Send to…** to hand selected messages or the full visible transcript
  to another Hermes profile. Choose a new or idle existing conversation,
  review the exact canonical prompt and UTF-8 byte count, then confirm. The
  bridge persists immutable artifacts plus delivery history so incoming and
  outgoing links survive devices and app reinstalls.
- **Live activity + notifications** — a long-lived `hermes.events.stream`
  tells every device which agents/conversations are working right now
  (pulsing indicators on the agents and conversation lists, "working…" in the
  chat header), and a native notification fires when a reply lands in a chat
  you aren't looking at. Transcripts auto-refresh when a turn finishes
  elsewhere.

## Run it

1. Start the bridge next to your Hermes install (see `apps/hermes-bridge`):

   ```bash
   export HERMES_BRIDGE_PRIVATE_KEY=$(nak key generate)
   export HERMES_BRIDGE_RELAYS=wss://relay.contextvm.org
   pnpm --filter @contexcgi/hermes-bridge build
   pnpm --filter @contexcgi/hermes-bridge start   # prints its public key
   ```

2. Dev server: `pnpm --filter @contexcgi/hermes-chat dev` → http://localhost:5176
   (or install `hermexvm-debug.apk` on a phone).

3. On the connect screen paste the bridge public key + relays; tap Generate for
   a device key (stored only on-device via Capacitor Preferences).

No Hermes install handy? `pnpm tsx scripts/dev-hermes-fake-stack.ts` runs a
local relay + bridge backed by a canned fake gateway.

> **Large transcript note:** Hermes calls currently avoid MCP progress tokens because
> ContextVM SDK 0.11.8 can lose small direct responses when a token is present.
> Normal chat remains reliable; very large transcripts still need server-side
> pagination before CEP-22 response fragmentation can be re-enabled safely.

## Build the APK

Same flow as the Paperclip app (see AGENTS.md §5): build `protocol → client →
hermes-chat`, then `pnpm --filter @contexcgi/hermes-chat android:sync` and
`./gradlew assembleDebug` in `apps/hermes-chat/android`. App id
`ai.hermex.vm`, label **hermexVM**, minSdk 23. A prebuilt debug APK is
checked in at `hermexvm-debug.apk`.

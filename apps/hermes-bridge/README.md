# Hermes bridge

The Hermes bridge exposes local Hermes profiles and durable conversations as
ContextVM tools. It owns the Nostr key and spawns Hermes' `tui_gateway` child;
clients never access Hermes files directly.

## Linked conversations / cross-agent handoffs

`hermes.handoffs.preview` creates the canonical preview for a handoff. Only
visible user and assistant messages are eligible; system prompts, tool output,
thinking, and approvals are excluded. `hermes.handoffs.send` revalidates the
source snapshot before any destination side effect, persists it, then delivers
and streams the destination turn. Existing destinations with a running turn are
rejected. Reciprocal handoffs are allowed; `hermes.handoffs.list` is the
chronological source of graph edges.

Handoff metadata is stored in a bridge-owned sidecar and never written to
Hermes' `state.db`:

```text
$HERMES_BRIDGE_DATA_ROOT/handoffs/artifacts/<sha256>.json
$HERMES_BRIDGE_DATA_ROOT/handoffs/deliveries/<request-id>.json
```

Artifacts are immutable and content-addressed. Delivery files carry mutable
accepted/running/completed/failed/interrupted status and are atomically
replaced. A request UUID is an idempotency key. If the bridge restarts while a
delivery is running, it deterministically marks that delivery interrupted
because the owned gateway child also restarted.

## Environment

| Variable                           | Default                     | Meaning                                                                          |
| ---------------------------------- | --------------------------- | -------------------------------------------------------------------------------- |
| `HERMES_BRIDGE_PRIVATE_KEY`        | required                    | Bridge Nostr secret key.                                                         |
| `CONTEXCGI_ALLOWED_NPUBS`          | required                    | Comma/space-separated authorized client npubs; startup fails closed when absent. |
| `HERMES_BRIDGE_RELAYS`             | `wss://relay.contextvm.org` | Comma-separated relays.                                                          |
| `HERMES_HOME`                      | `~/.hermes`                 | Hermes home and default profile.                                                 |
| `HERMES_AGENT_ROOT`                | `$HERMES_HOME/hermes-agent` | Hermes checkout.                                                                 |
| `HERMES_BRIDGE_DATA_ROOT`          | `~/.hermes-bridge/data`     | Bridge-owned handoff sidecar root.                                               |
| `HERMES_BRIDGE_PUBLIC`             | `false`                     | Announce the server.                                                             |
| `HERMES_BRIDGE_REQUIRE_ENCRYPTION` | `false`                     | Require encrypted ContextVM calls.                                               |

Voice-related variables are documented in the repository `AGENTS.md`. Private
bridges neither announce themselves nor publish relay-list metadata. The shared
allowlist accepts `npub` or 64-character hex public keys and is enforced in
addition to transport encryption.

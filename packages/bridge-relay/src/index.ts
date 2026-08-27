import { ApplesauceRelayPool } from "@contextvm/sdk";
import type { ApplesauceRelayPoolOptions } from "@contextvm/sdk";

/**
 * The SDK pool's liveness ping only checks *connected* relays, and
 * applesauce-relay's per-relay reconnect can stall permanently (e.g. after a
 * clean server-side close or a refused dial). A bridge can therefore degrade
 * to a single connected relay and stay there forever while every liveness
 * check passes — observed in production: mylock at 1/5 and quran at 1/5
 * relays for ~36h with healthy-looking heartbeats.
 *
 * This subclass adds a watchdog that rebuilds the pool when it stays
 * partially disconnected, with hysteresis (N consecutive degraded checks)
 * and a cooldown so a permanently-dead relay causes at most one rebuild per
 * cooldown window instead of the every-2-minutes churn that broke live
 * streams before (see the nostr.chaima.info incident).
 */

const DEGRADED_CHECK_INTERVAL_MS = 60_000;
const DEGRADED_CHECKS_BEFORE_REBUILD = 3;
const REBUILD_COOLDOWN_MS = 10 * 60_000;
const HEARTBEAT_EVERY_N_CHECKS = 30;

/** The private SDK internals the watchdog reads. Kept to the minimum and
 * accessed defensively so an SDK upgrade degrades to a no-op, not a crash. */
type PoolInternals = {
  relays?: Array<{ url?: string; connected?: boolean }>;
  subscriptions?: Map<unknown, unknown>;
  rebuildInFlight?: Promise<void>;
  rebuild?: (reason: string) => void;
};

export class ResilientRelayPool extends ApplesauceRelayPool {
  private watchdogTimer?: ReturnType<typeof setInterval>;
  private degradedChecks = 0;
  private lastWatchdogRebuildAt = 0;
  private checksSinceHeartbeat = 0;
  private warnedInternalsMismatch = false;

  constructor(relayUrls: string[], opts?: ApplesauceRelayPoolOptions) {
    super(relayUrls, opts);
    this.watchdogTimer = setInterval(
      () => this.checkDegraded(),
      DEGRADED_CHECK_INTERVAL_MS,
    );
    this.watchdogTimer.unref?.();
  }

  override async disconnect(): Promise<void> {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
    await super.disconnect();
  }

  private internals(): PoolInternals | undefined {
    const pool = this as unknown as PoolInternals;
    if (!Array.isArray(pool.relays) || typeof pool.rebuild !== "function") {
      if (!this.warnedInternalsMismatch) {
        this.warnedInternalsMismatch = true;
        console.error(
          "[relay-watchdog] @contextvm/sdk internals changed shape; watchdog disabled",
        );
      }
      return undefined;
    }
    return pool;
  }

  private checkDegraded(): void {
    const pool = this.internals();
    if (!pool) return;

    const configured = this.getRelayUrls().length;
    const connected = (pool.relays ?? []).filter((r) => r.connected).length;

    this.checksSinceHeartbeat += 1;
    if (this.checksSinceHeartbeat >= HEARTBEAT_EVERY_N_CHECKS) {
      this.checksSinceHeartbeat = 0;
      console.log(`[relay-watchdog] connected ${connected}/${configured}`);
    }

    // Idle pools legitimately close sockets after keepAlive; only guard pools
    // with live subscriptions, mirroring the SDK's own liveness gate.
    if (!pool.subscriptions?.size) {
      this.degradedChecks = 0;
      return;
    }
    if (connected >= configured || pool.rebuildInFlight) {
      this.degradedChecks = 0;
      return;
    }

    this.degradedChecks += 1;
    if (this.degradedChecks < DEGRADED_CHECKS_BEFORE_REBUILD) return;

    const sinceLast = Date.now() - this.lastWatchdogRebuildAt;
    if (sinceLast < REBUILD_COOLDOWN_MS) return;

    const disconnected = (pool.relays ?? [])
      .filter((r) => !r.connected)
      .map((r) => r.url)
      .join(", ");
    console.log(
      `[relay-watchdog] ${connected}/${configured} relays connected for ${this.degradedChecks} checks (down: ${disconnected}); rebuilding pool`,
    );
    this.degradedChecks = 0;
    this.lastWatchdogRebuildAt = Date.now();
    pool.rebuild?.("watchdog-degraded");
  }
}

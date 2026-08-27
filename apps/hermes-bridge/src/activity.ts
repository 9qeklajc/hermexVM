import type {
  HermesActiveTurn,
  HermesActivityEvent,
} from "@contexcgi/protocol";

export type ActivityListener = (event: HermesActivityEvent) => void;

/**
 * Tracks which conversations are running a turn right now and fans every
 * change out to the open `hermes.events.stream` subscribers. Turn lifetime is
 * driven by the gateway's own events (see tools.ts), NOT by the sender's
 * CEP-41 stream — a client that walks away mid-turn still produces a
 * `turn.completed` for every other device.
 */
export class ActivityTracker {
  private readonly running = new Map<string, HermesActiveTurn>();
  private readonly listeners = new Set<ActivityListener>();
  private static readonly MAX_LISTENERS = 20;

  private key(agentId: string, chatId: string): string {
    return `${agentId}\u0000${chatId}`;
  }

  private emit(event: HermesActivityEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // one broken subscriber must not break the rest
      }
    }
  }

  subscribe(listener: ActivityListener): () => void {
    if (this.listeners.size >= ActivityTracker.MAX_LISTENERS) {
      console.warn(
        `[hermes-bridge] activity.subscribe rejected — already ${this.listeners.size} listeners (possible leak)`,
      );
      return () => {};
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): HermesActivityEvent {
    return { type: "activity.snapshot", turns: [...this.running.values()] };
  }

  start(agentId: string, chatId: string): void {
    const at = Date.now();
    this.running.set(this.key(agentId, chatId), {
      agentId,
      chatId,
      startedAt: at,
    });
    this.emit({ type: "turn.started", agentId, chatId, at });
  }

  complete(
    agentId: string,
    chatId: string,
    outcome: { preview?: string; failureReason?: string } = {},
  ): void {
    // Idempotent: a duplicate completion (e.g. timeout fallback after the real
    // terminal frame) must not announce a phantom turn.
    if (!this.running.delete(this.key(agentId, chatId))) return;
    this.emit({
      type: "turn.completed",
      agentId,
      chatId,
      at: Date.now(),
      ...(outcome.preview ? { preview: outcome.preview } : {}),
      ...(outcome.failureReason
        ? { failureReason: outcome.failureReason }
        : {}),
    });
  }

  /** Gateway child died: every in-flight turn is gone. */
  failAll(reason: string): void {
    for (const turn of [...this.running.values()]) {
      this.complete(turn.agentId, turn.chatId, { failureReason: reason });
    }
  }

  get activeCount(): number {
    return this.running.size;
  }
}

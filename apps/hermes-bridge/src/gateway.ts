import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

/**
 * How the bridge launches Hermes's tui_gateway JSON-RPC child. Defaults are
 * derived from the Hermes install root; tests inject a fake command.
 */
export type GatewayCommand = {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
};

export type GatewayEventFrame = {
  type: string;
  session_id?: string;
  payload?: Record<string, unknown>;
};

export type GatewayConfig = {
  command: GatewayCommand;
  /** Max wait for the child's `gateway.ready` event. */
  readyTimeoutMs?: number;
  /** Default per-request timeout. */
  requestTimeoutMs?: number;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class GatewayRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "GatewayRpcError";
  }
}

/**
 * Owns one long-lived `python -m tui_gateway.entry` child and multiplexes
 * newline-delimited JSON-RPC over its stdio: requests get correlated replies,
 * `event` notifications fan out to subscribers. The child is spawned lazily on
 * the first request and respawned (again lazily) after a crash; in-flight
 * requests fail fast when the child dies so callers never hang.
 */
export class HermesGateway {
  private readonly config: GatewayConfig;
  private proc: ChildProcess | null = null;
  private stdoutRl: Interface | null = null;
  private stderrRl: Interface | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly eventListeners = new Set<
    (event: GatewayEventFrame) => void
  >();
  private stopped = false;

  constructor(config: GatewayConfig) {
    this.config = config;
  }

  onEvent(listener: (event: GatewayEventFrame) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  async request<T>(
    method: string,
    params: Record<string, unknown> = {},
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.stopped) throw new Error("gateway stopped");
    await this.ensureStarted();
    const proc = this.proc;
    if (!proc?.stdin?.writable)
      throw new Error("hermes gateway is not running");
    const id = this.nextId++;
    const timeoutMs = opts.timeoutMs ?? this.config.requestTimeoutMs ?? 120_000;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`hermes gateway request timed out: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
    });
    proc.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
    );
    return (await result) as T;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.teardown(new Error("gateway stopped"));
  }

  private ensureStarted(): Promise<void> {
    if (!this.ready) {
      this.ready = this.start();
      // A failed start must not poison every later request — clear so the
      // next call retries the spawn.
      this.ready.catch(() => {
        this.ready = null;
      });
    }
    return this.ready;
  }

  private start(): Promise<void> {
    const { command } = this.config;
    const readyTimeoutMs = this.config.readyTimeoutMs ?? 60_000;
    console.log(
      `[hermes] spawning gateway: ${command.command} ${command.args.join(" ")}`,
    );
    const proc = spawn(command.command, command.args, {
      cwd: command.cwd,
      env: { ...process.env, ...command.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;

    return new Promise<void>((resolve, reject) => {
      let readySeen = false;
      const readyTimer = setTimeout(() => {
        if (!readySeen) {
          reject(new Error("hermes gateway did not become ready in time"));
          this.teardown(new Error("gateway start timeout"));
        }
      }, readyTimeoutMs);
      readyTimer.unref?.();

      this.stdoutRl = createInterface({ input: proc.stdout! });
      this.stdoutRl.on("line", (raw) => {
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          console.warn(
            `[hermes] malformed gateway frame: ${raw.slice(0, 160)}`,
          );
          return;
        }
        if (frame.method === "event") {
          const params = (frame.params ?? {}) as GatewayEventFrame;
          if (params.type === "gateway.ready" && !readySeen) {
            readySeen = true;
            clearTimeout(readyTimer);
            console.log("[hermes] gateway ready");
            resolve();
          }
          for (const listener of [...this.eventListeners]) {
            try {
              listener(params);
            } catch (err) {
              console.warn(`[hermes] event listener failed: ${String(err)}`);
            }
          }
          return;
        }
        const id = typeof frame.id === "number" ? frame.id : null;
        if (id === null) return;
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        clearTimeout(entry.timer);
        const error = frame.error as
          | { code?: number; message?: string }
          | undefined;
        if (error) {
          entry.reject(
            new GatewayRpcError(
              error.code ?? 0,
              error.message ?? "gateway error",
            ),
          );
        } else {
          entry.resolve(frame.result);
        }
      });

      this.stderrRl = createInterface({ input: proc.stderr! });
      this.stderrRl.on("line", (line) => {
        const trimmed = line.trim();
        if (trimmed) console.warn(`[hermes-gw] ${trimmed.slice(0, 300)}`);
      });

      proc.on("error", (err) => {
        clearTimeout(readyTimer);
        reject(err);
        this.teardown(err);
      });
      proc.on("exit", (code, signal) => {
        clearTimeout(readyTimer);
        const err = new Error(
          `hermes gateway exited (code=${code ?? "null"} signal=${signal ?? "null"})`,
        );
        if (!readySeen) reject(err);
        this.teardown(err);
      });
    });
  }

  private teardown(error: Error): void {
    const proc = this.proc;
    this.proc = null;
    this.ready = null;
    this.stdoutRl?.close();
    this.stderrRl?.close();
    this.stdoutRl = null;
    this.stderrRl = null;
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      try {
        proc.kill("SIGTERM");
      } catch {
        // already gone
      }
    }
    for (const [id, entry] of [...this.pending]) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    if (!this.stopped) {
      console.warn(
        `[hermes] gateway down (${error.message}) — will respawn on next request`,
      );
      // Let stream pumps know their live session is gone.
      for (const listener of [...this.eventListeners]) {
        try {
          listener({ type: "gateway.exited" });
        } catch {
          // listener cleanup races are fine
        }
      }
    }
  }
}

/** Standard launch command for a real Hermes install. */
export function hermesGatewayCommand(
  agentRoot: string,
  hermesHome?: string,
): GatewayCommand {
  const env: Record<string, string> = {
    PYTHONPATH: agentRoot,
    HERMES_PYTHON_SRC_ROOT: agentRoot,
    // The bridge fronts remote clients; never block a turn on a TTY prompt.
    HERMES_ACCEPT_HOOKS: "1",
  };
  if (hermesHome) env.HERMES_HOME = hermesHome;
  return {
    command: `${agentRoot}/venv/bin/python`,
    args: ["-m", "tui_gateway.entry"],
    cwd: agentRoot,
    env,
  };
}

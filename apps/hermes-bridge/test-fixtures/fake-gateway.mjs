// Minimal stand-in for Hermes's `python -m tui_gateway.entry` child: speaks the
// same newline-delimited JSON-RPC dialect over stdio so bridge tests run
// without a Hermes install. Emits `gateway.ready`, answers the session RPCs the
// bridge uses, and streams a canned turn on `prompt.submit`.
import { createInterface } from "node:readline";

const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const event = (type, sid, payload) =>
  send({
    jsonrpc: "2.0",
    method: "event",
    params: { type, session_id: sid, ...(payload ? { payload } : {}) },
  });
const ok = (id, result) => send({ jsonrpc: "2.0", id, result });
const err = (id, code, message) =>
  send({ jsonrpc: "2.0", id, error: { code, message } });

let liveCounter = 0;
const sessionKeys = new Map(); // sid -> session_key
const sidByKey = new Map(); // session_key -> sid (real gateway reuses live sessions)
const runningTurns = new Map(); // sid -> { user, assistant }
const sessionCwds = new Map(); // sid -> selected project cwd
const sessionModels = new Map(); // sid -> { model, provider } recorded via config.set

event("gateway.ready", "");

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params = {} } = frame;
  switch (method) {
    case "session.create": {
      const sid = `live${++liveCounter}`;
      sessionKeys.set(sid, `20260726_10000${liveCounter}_abcdef`);
      if (params.cwd) sessionCwds.set(sid, params.cwd);
      ok(id, { session_id: sid });
      return;
    }
    case "session.active_list":
      ok(id, {
        sessions: [...sessionKeys].map(([sid, key]) => ({
          id: sid,
          session_key: key,
        })),
      });
      return;
    case "session.resume": {
      if (params.session_id === "missing") {
        err(id, 4007, "session not found");
        return;
      }
      // Reuse the live session for a known key, like the real gateway does.
      let sid = sidByKey.get(params.session_id);
      if (!sid) {
        sid = `live${++liveCounter}`;
        sessionKeys.set(sid, params.session_id);
        sidByKey.set(params.session_id, sid);
      }
      const turn = runningTurns.get(sid);
      ok(id, {
        session_id: sid,
        running: Boolean(turn),
        inflight: turn ? { user: turn.user, assistant: turn.assistant } : null,
        info: {
          model: "claude-opus-4-8",
          provider: "anthropic",
          cwd: sessionCwds.get(sid) ?? "/tmp/hermes-existing-project",
        },
        messages: [
          { role: "user", text: "earlier question" },
          { role: "assistant", text: "earlier answer" },
        ],
      });
      return;
    }
    case "session.list":
      ok(id, {
        sessions: [
          {
            id: "20260725_090000_aaaaaa",
            title: `Chat with ${params.profile ?? "default"}`,
            preview: "earlier answer",
            started_at: 1785000000,
            message_count: 4,
            source: "telegram",
          },
        ],
      });
      return;
    case "session.history":
      ok(id, {
        messages: [
          { role: "user", text: "earlier question" },
          { role: "assistant", text: "earlier answer" },
        ],
      });
      return;
    case "session.title":
      ok(id, {
        title: params.title ?? "Fake conversation",
        session_key: sessionKeys.get(params.session_id),
        pending: false,
      });
      return;
    case "session.delete":
      ok(id, { deleted: params.session_id });
      return;
    case "session.interrupt":
      ok(id, { ok: true });
      return;
    case "session.cwd.set":
      sessionCwds.set(params.session_id, params.cwd);
      ok(id, { cwd: params.cwd });
      return;
    case "config.set": {
      // The bridge pins a conversation model via `config.set {key:"model"}`.
      // value = "<model> [--provider <slug>] [--flags…]" — record the resolved
      // pair per session so tests can assert the switch reached the gateway.
      const sid = params.session_id;
      if (params.key === "model") {
        const raw = String(params.value || "").trim();
        const m = raw.match(/^(\S+)(?:\s+--provider\s+(\S+))?/);
        sessionModels.set(sid, {
          model: m?.[1] || raw,
          provider: m?.[2] || "",
        });
      }
      ok(id, {
        key: params.key,
        value: params.value,
        scope: String(params.value || "").includes("--global")
          ? "global"
          : "session",
      });
      return;
    }
    case "approval.respond":
      ok(id, { resolved: true });
      return;
    case "prompt.submit": {
      const sid = params.session_id;
      if (params.text === "FAIL") {
        err(id, 5000, "provider exploded");
        return;
      }
      ok(id, { ok: true });
      // Surface the session model (when one was switched) so tests can
      // confirm a model override reached the gateway before the turn started.
      const model = sessionModels.get(sid)?.model || "";
      // FAKE_TURN_MS stretches the turn so UI tests can observe the
      // in-progress ("working…") state; tests default to near-instant.
      const turnMs = Number(process.env.FAKE_TURN_MS || 20);
      // Token-guard the timers: a previous turn's completion timer on the
      // same reused sid must not clobber or complete THIS turn.
      const token = Symbol("turn");
      runningTurns.set(sid, { user: params.text, assistant: "", token });
      setTimeout(
        () => {
          event("message.start", sid);
          // Reasoning stream (rendered in a collapsible thinking block).
          event("reasoning.delta", sid, { text: "Let me check what files " });
          event("reasoning.delta", sid, { text: "are in /tmp first." });
          event("status.update", sid, { text: "thinking about it" });
          // Tool call with the executed command + live streamed output.
          event("tool.start", sid, {
            tool_id: "t1",
            name: "terminal",
            args_text:
              `cwd=${sessionCwds.get(sid) ?? ""}` +
              (model ? ` model=${model}` : ""),
          });
          event("tool.progress", sid, {
            name: "terminal",
            preview: "total 12\ndrwxr-xr-x  3 admin admin",
          });
          event("tool.complete", sid, {
            tool_id: "t1",
            name: "terminal",
            result_text:
              "total 12\ndrwxr-xr-x  3 admin admin 4096 file1\n-rw-r--r--  1 admin admin  220 file2",
            summary: "2 entries",
            duration_s: 0.2,
          });
          event("message.delta", sid, { text: "Hello " });
          event("message.delta", sid, { text: "world" });
          const turn = runningTurns.get(sid);
          if (turn && turn.token === token) turn.assistant = "Hello world";
        },
        Math.min(20, turnMs),
      );
      setTimeout(() => {
        if (runningTurns.get(sid)?.token !== token) return;
        runningTurns.delete(sid);
        event("message.complete", sid, {
          text: "Hello world",
          usage: { calls: 1 },
        });
      }, turnMs);
      return;
    }
    default:
      err(id ?? 0, 4000, `unknown method ${method}`);
  }
});

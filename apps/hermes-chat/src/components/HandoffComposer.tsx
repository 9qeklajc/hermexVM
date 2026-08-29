import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isVisibleHermesHandoffMessage,
  type HermesAgentProfile,
  type HermesChatMessage,
  type HermesChatSummary,
  type HermesHandoffPreview,
  type HermesHandoffRecord,
} from "../lib/api";
import { activityKey, useActivity, useConnection } from "../lib/store";

export type HandoffSeed = {
  role: "user" | "assistant";
  text: string;
  ordinal?: number;
  digest?: string;
  /** Stable visible occurrence fallback for rows created during a live turn. */
  occurrence?: number;
};

export function HandoffComposer({
  source,
  seed,
  onClose,
  onDelivered,
  onNavigate,
}: {
  source: { agentId: string; chatId: string; title?: string };
  seed: HandoffSeed;
  onClose: () => void;
  onDelivered: (agentId: string, chatId: string, title?: string) => void;
  onNavigate: (agentId: string, chatId: string, title?: string) => void;
}) {
  const { client } = useConnection();
  const activity = useActivity();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const mainLoadGeneration = useRef(0);
  const chatsGeneration = useRef(0);
  const previewGeneration = useRef(0);
  const transcriptSignature = useRef("");
  const [agents, setAgents] = useState<HermesAgentProfile[]>([]);
  const [messages, setMessages] = useState<HermesChatMessage[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [mode, setMode] = useState<"selected" | "full">("selected");
  const [agentId, setAgentId] = useState("");
  const [kind, setKind] = useState<"new" | "existing">("new");
  const [title, setTitle] = useState("");
  const [chats, setChats] = useState<HermesChatSummary[]>([]);
  const [existingChatId, setExistingChatId] = useState("");
  const [instructions, setInstructions] = useState("");
  const [preview, setPreview] = useState<HermesHandoffPreview | null>(null);
  const [history, setHistory] = useState<HermesHandoffRecord[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [terminalRetry, setTerminalRetry] = useState(false);

  const invalidatePreview = useCallback(() => {
    previewGeneration.current += 1;
    setPreview(null);
    setRequestId(null);
    setTerminalRetry(false);
  }, []);

  useEffect(() => {
    const generation = ++mainLoadGeneration.current;
    setBusy(true);
    Promise.all([
      client.listAgents(),
      client.chatHistory(source.agentId, source.chatId),
      client.listHandoffs({ chatId: source.chatId, limit: 20 }),
    ])
      .then(([profiles, transcript, links]) => {
        if (generation !== mainLoadGeneration.current) return;
        const choices = profiles.filter(
          (profile) => profile.id !== source.agentId,
        );
        setAgents(choices);
        setHistory(links);
        const visible = transcript.messages.filter(
          isVisibleHermesHandoffMessage,
        );
        const signature = JSON.stringify(
          visible.map((message) => [
            message.ordinal,
            message.role,
            message.digest,
          ]),
        );
        if (
          transcriptSignature.current &&
          transcriptSignature.current !== signature
        ) {
          invalidatePreview();
        }
        transcriptSignature.current = signature;
        setMessages(visible);
        const exact = visible.find(
          (message) =>
            seed.ordinal !== undefined &&
            message.ordinal === seed.ordinal &&
            message.role === seed.role &&
            message.digest === seed.digest,
        );
        const sameText = visible.filter(
          (message) => message.role === seed.role && message.text === seed.text,
        );
        const matching = exact ?? sameText[seed.occurrence ?? 0];
        setSelected((current) => {
          const valid = new Set(
            visible
              .filter(
                (message) =>
                  message.ordinal !== undefined && current.has(message.ordinal),
              )
              .map((message) => message.ordinal!),
          );
          if (valid.size) return valid;
          return matching?.ordinal === undefined
            ? valid
            : new Set([matching.ordinal]);
        });
        setAgentId((current) =>
          choices.some((profile) => profile.id === current)
            ? current
            : (choices[0]?.id ?? ""),
        );
      })
      .catch((cause: unknown) => {
        if (generation === mainLoadGeneration.current)
          setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (generation === mainLoadGeneration.current) setBusy(false);
      });
    return () => {
      mainLoadGeneration.current += 1;
    };
  }, [
    client,
    invalidatePreview,
    seed.digest,
    seed.occurrence,
    seed.ordinal,
    seed.role,
    seed.text,
    source.agentId,
    source.chatId,
  ]);

  useEffect(() => {
    const generation = ++chatsGeneration.current;
    if (!agentId || kind !== "existing") return;
    client
      .listChats(agentId, 100)
      .then((items) => {
        if (generation !== chatsGeneration.current) return;
        const choices = items.filter(
          (chat) => !(agentId === source.agentId && chat.id === source.chatId),
        );
        setChats(choices);
        setExistingChatId((current) =>
          choices.some((chat) => chat.id === current)
            ? current
            : (choices[0]?.id ?? ""),
        );
      })
      .catch((cause: unknown) => {
        if (generation === chatsGeneration.current)
          setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [agentId, client, kind, source.agentId, source.chatId]);

  const visible = useMemo(
    () =>
      messages.filter(
        (
          message,
        ): message is HermesChatMessage & {
          role: "user" | "assistant";
          ordinal: number;
          digest: string;
        } =>
          (message.role === "user" || message.role === "assistant") &&
          message.ordinal !== undefined &&
          Boolean(message.digest),
      ),
    [messages],
  );

  const destination = () => {
    if (kind === "new") {
      return { kind: "new" as const, agentId, title: title.trim() };
    }
    const chat = chats.find((item) => item.id === existingChatId);
    return {
      kind: "existing" as const,
      agentId,
      chatId: existingChatId,
      title: chat?.title,
    };
  };

  const input = () => ({
    source,
    mode,
    ...(mode === "selected"
      ? {
          selected: visible
            .filter((message) => selected.has(message.ordinal))
            .map((message) => ({
              ordinal: message.ordinal,
              role: message.role,
              digest: message.digest,
            })),
        }
      : {}),
    destination: destination(),
    instructions: instructions.trim(),
  });

  const requestPreview = async () => {
    const generation = ++previewGeneration.current;
    setError(null);
    setBusy(true);
    try {
      const nextPreview = await client.previewHandoff(input());
      if (generation !== previewGeneration.current) return;
      setPreview(nextPreview);
      setRequestId(crypto.randomUUID());
      setTerminalRetry(false);
    } catch (cause) {
      if (generation === previewGeneration.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation === previewGeneration.current) setBusy(false);
    }
  };

  const confirm = async () => {
    if (!preview || !requestId) return;
    setError(null);
    setBusy(true);
    try {
      const turn = await client.sendHandoff({
        ...input(),
        requestId,
        previewDigest: preview.previewDigest,
      });
      // Keep this composer (and its idempotency key) mounted until the bridge
      // returns a durable result. Navigating on the first chat.started frame
      // would lose recovery state if the stream failed later.
      for await (const event of turn.events) {
        // Destination progress is reflected by the global activity stream;
        // retain a streamed error while awaiting the durable final result.
        if (event.type === "error") setError(event.message);
      }
      const result = await turn.result;
      if (
        result.chatId &&
        (result.status === "running" || result.status === "completed")
      ) {
        onDelivered(result.agentId, result.chatId, preview.destination.title);
        return;
      }
      setBusy(false);
      if (result.status === "failed" || result.status === "interrupted") {
        setTerminalRetry(true);
        setError(
          `Delivery ${result.status}. Start a new delivery to try again without duplicating this request.`,
        );
      } else {
        setError(
          `Delivery is ${result.status}; retry will reuse the same request.`,
        );
      }
    } catch (cause) {
      // Keep requestId across transport/stream failures. Confirming again is a
      // durable replay, never a second destination delivery.
      setBusy(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const deliveryLocked = busy && Boolean(preview && requestId);
  const deliveryLockedRef = useRef(deliveryLocked);
  deliveryLockedRef.current = deliveryLocked;

  useEffect(() => {
    const previous = document.activeElement;
    window.setTimeout(() => dialogRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !deliveryLockedRef.current) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [onClose]);

  const activeExisting =
    kind === "existing" &&
    Boolean(existingChatId) &&
    activity.running.has(activityKey(agentId, existingChatId));
  const readyForPreview =
    agentId &&
    instructions.trim() &&
    !activeExisting &&
    (kind === "new" ? title.trim() : existingChatId) &&
    (mode === "full" || selected.size > 0);

  return (
    <div
      className="modal-backdrop"
      onClick={deliveryLocked ? undefined : onClose}
    >
      <div
        ref={dialogRef}
        className="handoff-composer"
        role="dialog"
        aria-modal="true"
        aria-label="Send context to another agent"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="handoff-head">
          <strong>Send to another agent</strong>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Close"
            disabled={deliveryLocked}
          >
            ×
          </button>
        </div>
        {error ? <div className="screen-error">{error}</div> : null}
        <div className="handoff-tabs">
          <button
            className={mode === "selected" ? "active" : ""}
            onClick={() => {
              setMode("selected");
              invalidatePreview();
            }}
          >
            Selected
          </button>
          <button
            className={mode === "full" ? "active" : ""}
            onClick={() => {
              setMode("full");
              invalidatePreview();
            }}
          >
            Full transcript
          </button>
        </div>
        {mode === "selected" ? (
          <div className="handoff-messages">
            {visible.map((message) => (
              <label key={`${message.ordinal}:${message.digest}`}>
                <input
                  type="checkbox"
                  checked={selected.has(message.ordinal)}
                  onChange={() => {
                    invalidatePreview();
                    setSelected((current) => {
                      const next = new Set(current);
                      if (next.has(message.ordinal))
                        next.delete(message.ordinal);
                      else next.add(message.ordinal);
                      return next;
                    });
                  }}
                />
                <span>
                  <strong>
                    {message.role === "user" ? "You" : source.agentId}
                  </strong>{" "}
                  {message.text}
                </span>
              </label>
            ))}
          </div>
        ) : (
          <p className="handoff-note">
            Includes {visible.length} visible user/assistant messages. Tools,
            system prompts, thinking, and approvals are excluded.
          </p>
        )}
        <label className="handoff-field">
          Destination agent
          <select
            value={agentId}
            onChange={(event) => {
              setAgentId(event.target.value);
              invalidatePreview();
            }}
          >
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </label>
        <div className="handoff-tabs">
          <button
            className={kind === "new" ? "active" : ""}
            onClick={() => {
              setKind("new");
              invalidatePreview();
            }}
          >
            New conversation
          </button>
          <button
            className={kind === "existing" ? "active" : ""}
            onClick={() => {
              setKind("existing");
              invalidatePreview();
            }}
          >
            Existing
          </button>
        </div>
        {kind === "new" ? (
          <label className="handoff-field">
            Title
            <input
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                invalidatePreview();
              }}
              placeholder="Conversation title"
            />
          </label>
        ) : (
          <label className="handoff-field">
            Conversation
            <select
              value={existingChatId}
              onChange={(event) => {
                setExistingChatId(event.target.value);
                invalidatePreview();
              }}
            >
              {chats.map((chat) => {
                const active = activity.running.has(
                  activityKey(agentId, chat.id),
                );
                return (
                  <option key={chat.id} value={chat.id} disabled={active}>
                    {chat.title || chat.preview || "Untitled"}
                    {active ? " (working)" : ""}
                  </option>
                );
              })}
            </select>
          </label>
        )}
        <label className="handoff-field">
          Instructions
          <textarea
            value={instructions}
            onChange={(event) => {
              setInstructions(event.target.value);
              invalidatePreview();
            }}
            placeholder="What should the destination agent do?"
          />
        </label>
        {preview ? (
          <div className="handoff-preview">
            <strong>
              Exact destination prompt · {preview.byteCount.toLocaleString()}{" "}
              UTF-8 bytes
            </strong>
            <pre>{preview.envelope}</pre>
            <button
              className="button primary"
              disabled={busy}
              onClick={() => void confirm()}
            >
              {busy
                ? "Sending…"
                : terminalRetry
                  ? "Check same delivery"
                  : "Confirm and send"}
            </button>
            {terminalRetry ? (
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => {
                  setRequestId(crypto.randomUUID());
                  setTerminalRetry(false);
                  setError(null);
                }}
              >
                Start new delivery
              </button>
            ) : null}
          </div>
        ) : (
          <button
            className="button primary"
            disabled={!readyForPreview || busy}
            onClick={() => void requestPreview()}
          >
            {busy ? "Loading…" : "Preview handoff"}
          </button>
        )}
        {history.length ? (
          <div className="handoff-history">
            <strong>Linked conversations</strong>
            {history.map((record) => {
              const recordedDestinationChatId =
                record.destinationChatId ??
                (record.destination.kind === "existing"
                  ? record.destination.chatId
                  : "");
              const incoming =
                record.destination.agentId === source.agentId &&
                recordedDestinationChatId === source.chatId;
              const agent = incoming
                ? record.source.agentId
                : record.destination.agentId;
              const chatId = incoming
                ? record.source.chatId
                : recordedDestinationChatId;
              return (
                <button
                  key={record.requestId}
                  disabled={!chatId}
                  onClick={() =>
                    chatId &&
                    onNavigate(
                      agent,
                      chatId,
                      incoming ? record.source.title : record.destination.title,
                    )
                  }
                >
                  {incoming ? "From" : "To"} {agent} · {record.status}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

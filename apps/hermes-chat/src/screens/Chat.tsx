import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type {
  HermesChatHistoryResult,
  HermesChatMessage,
  HermesChatTurn,
  HermesModelOptions,
  HermesSendResult,
  FileTransferDescriptor,
  HermesSkill,
} from "../lib/api";
import {
  applyEvent,
  emptyChat,
  displayAgentName,
  formatReplyMessage,
  fromHistory,
  markApprovalResolved,
  markClarifyResolved,
  parseReplyMessage,
  shouldFollowChatBottom,
  withInflightTurn,
  withUserMessage,
  type ChatItem,
  type ChatViewState,
  type ReplyTarget,
} from "../lib/chat";
import { appendTranscript } from "../lib/voice";
import {
  activityKey,
  useActivity,
  useConnection,
  useConnectionState,
  useNav,
} from "../lib/store";
import { isTransientTransportError } from "../lib/errors";
import {
  awaitResultWithin,
  consumeEventsWithStallWatch,
  type StreamWatchOutcome,
} from "../lib/stream";
import { Markdown } from "../components/Markdown";
import { ModelPicker } from "../components/ModelPicker";
import { ProjectPicker } from "../components/ProjectPicker";
import { SkillPicker } from "../components/SkillPicker";
import { Avatar, Spinner, TopBar } from "../components/ui";
import { VoiceRecorder } from "../components/VoiceRecorder";
import { FileUploader } from "../components/FileUploader";
import { AttachmentChips } from "../components/AttachmentChips";
import {
  HandoffComposer,
  type HandoffSeed,
} from "../components/HandoffComposer";
import { bindVisualViewportTop } from "../visual-viewport";

type SelectableMessage = Extract<ChatItem, { kind: "user" | "assistant" }>;

/**
 * The bridge writes a keepalive frame at least every ~25s on a quiet turn, so
 * a live stream silent for 75s (three missed cadences) is dead, not thinking.
 * Waiting it out is what froze the conversation screen until the user left
 * and re-entered; instead we abort and re-attach.
 */
const TURN_STREAM_STALL_MS = 75_000;

/**
 * While the chat is believed running but neither a local send stream nor a
 * watch loop is attached, this slow poll is the only thing that can still
 * move the state forward. One small history RPC per interval, only in that
 * stuck state and only while the app is visible — no polling when idle,
 * streaming, or hidden, so it cannot exhaust the bridge, relays, or battery.
 */
const STUCK_POLL_MS = 30_000;
/** A closed/stalled transport must never leave the stream result pending. */
const STREAM_RESULT_WAIT_MS = 5_000;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function mergeHistoryPages(
  current: HermesChatMessage[],
  incoming: HermesChatMessage[],
): HermesChatMessage[] {
  const byOrdinal = new Map<number, HermesChatMessage>();
  for (const message of [...current, ...incoming]) {
    if (message.ordinal !== undefined) byOrdinal.set(message.ordinal, message);
  }
  // Bridge history rows always carry ordinals. Falling back to the incoming
  // page avoids duplicating legacy rows if an older bridge omitted them.
  if (byOrdinal.size === 0) return incoming;
  return [...byOrdinal.values()].sort(
    (left, right) => left.ordinal! - right.ordinal!,
  );
}

export function ChatScreen({
  agentId,
  agentName,
  chatId: initialChatId,
  title,
}: {
  agentId: string;
  agentName: string;
  chatId: string | null;
  title?: string;
}) {
  const { client, waitForClient } = useConnection();
  const { resumedAt } = useConnectionState();
  const activity = useActivity();
  const nav = useNav();
  const [chat, setChat] = useState<ChatViewState | null>(
    initialChatId ? null : emptyChat(),
  );
  const [input, setInput] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  // Title input for new conversations — empty means the user hasn't named it
  // yet. Once the first message is sent, the chatId is known and the title
  // (if set) is persisted via hermes.chat.title.
  const [titleDraft, setTitleDraft] = useState("");
  const [titleSaved, setTitleSaved] = useState(false);
  const chatIdRef = useRef<string | null>(initialChatId);
  // Route promotion (null -> durable id after first chat.started) must update
  // notification identity without reloading/clobbering the live transcript.
  const promotedChatIdRef = useRef<string | null>(null);
  const turnRef = useRef<HermesChatTurn | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const runningRef = useRef(false);
  const watchRef = useRef<{ abort: (reason?: string) => Promise<void> } | null>(
    null,
  );
  const watchingRef = useRef(false);
  // Generation token for the live watch loop: bumped whenever the watch is
  // superseded (client hot-swap), so a stale loop never clobbers state that
  // a newer loop owns.
  const watchGenerationRef = useRef(0);
  const handledCompletionSeqRef = useRef(0);
  const lastLocalTurnEndedAtRef = useRef(0);
  // Set on unmount so a late reconcile/watch promise never starts a new
  // stream or sets state after the screen is gone (a post-cleanup attach
  // would leak the stream).
  const disposedRef = useRef(false);
  // A model selected before the first prompt cannot be persisted yet because
  // the conversation has no durable chat id/session. Keep only that case
  // pending and enforce it inside the first send. Existing conversations are
  // switched immediately through hermes.model.switch so navigation, reconnect,
  // or Android process recreation cannot lose the selection.
  const [pendingModel, setPendingModel] = useState<{
    model: string;
    provider: string;
  } | null>(null);
  // The model the bridge reports as active right now (from the last picker
  // open or the agent profile). Shown as a chip in the top bar.
  const [activeModel, setActiveModel] = useState<string>("");
  const [activeProvider, setActiveProvider] = useState<string>("");
  const [showModelPicker, setShowModelPicker] = useState(false);

  // Project picker: lets the user pin a working directory (project root) onto
  // this conversation so the agent operates there without being told each
  // time. The pinned cwd is applied via client.setCwd after the chat exists.
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  // Skills picker: lets the user browse every skill installed on the agent's
  // profile and insert a prompt hint into the composer, so they can ask a
  // targeted question without guessing what the agent can do.
  const [showSkillPicker, setShowSkillPicker] = useState(false);
  // The cwd currently pinned on this conversation (from setCwd or read from
  // the session info). Shown as a chip in the top bar.
  const [pinnedCwd, setPinnedCwd] = useState<string | null>(null);
  // Pending cwd: chosen before the first send (chat doesn't exist yet), then
  // applied once the chatId is known. Same stash pattern as pendingModel.
  const [pendingCwd, setPendingCwd] = useState<string | null>(null);
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null);
  // Bumped when a local turn stream stalls, so the effect below re-attaches
  // to the (possibly still running) turn on the bridge.
  const [reattachTick, setReattachTick] = useState(0);
  const [selectedMessage, setSelectedMessage] =
    useState<SelectableMessage | null>(null);
  const [handoffSeed, setHandoffSeed] = useState<HandoffSeed | null>(null);
  // Files uploaded through the composer but not sent yet. Rendered as
  // removable chips above the input (WhatsApp/Signal style); the wire text is
  // only composed at send time so the draft stays clean for a message.
  const [attachments, setAttachments] = useState<FileTransferDescriptor[]>([]);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const [visualViewportTop, setVisualViewportTop] = useState(0);
  const historyMessagesRef = useRef<HermesChatMessage[]>([]);
  const historyKeyRef = useRef<string | null>(null);
  const historyCursorRef = useRef<number | undefined>(undefined);
  const historyLoadingRef = useRef(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const pendingPrependScrollRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);

  useEffect(() => {
    historyMessagesRef.current = [];
    historyKeyRef.current = null;
    historyCursorRef.current = undefined;
    pendingPrependScrollRef.current = null;
  }, [agentId, initialChatId]);

  const applyHistory = useCallback(
    (history: HermesChatHistoryResult, older = false) => {
      const key = `${agentId}\u0000${history.chatId}`;
      const sameConversation = historyKeyRef.current === key;
      const messages = sameConversation
        ? mergeHistoryPages(historyMessagesRef.current, history.messages)
        : history.messages;
      historyKeyRef.current = key;
      historyMessagesRef.current = messages;
      if (older || !sameConversation) {
        historyCursorRef.current = history.nextBeforeOrdinal;
      }

      setChat((current) => {
        const settled = fromHistory(messages);
        if (older) {
          return {
            ...settled,
            running: current?.running ?? false,
            activity: current?.activity ?? null,
          };
        }
        return history.running
          ? withInflightTurn(settled, history.inflight)
          : settled;
      });
    },
    [agentId],
  );

  // Android WebView may pan its visual viewport to keep the focused composer
  // above the IME. In that state a CSS-fixed header at layout-viewport top:0
  // is still above the visible screen. Track both viewport scroll and resize
  // so the model/project controls follow the actually visible top edge.
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    return bindVisualViewportTop(viewport, setVisualViewportTop);
  }, []);

  // A controlled textarea does not grow with its content on its own. Resize
  // after each draft update, capped by the CSS four-row max-height; beyond
  // that cap the textarea scrolls internally.
  useLayoutEffect(() => {
    const textarea = composerRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const maxHeight = Number.parseFloat(getComputedStyle(textarea).maxHeight);
    const nextHeight = Number.isFinite(maxHeight)
      ? Math.min(textarea.scrollHeight, maxHeight)
      : textarea.scrollHeight;
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY =
      textarea.scrollHeight > nextHeight ? "auto" : "hidden";
  }, [input]);

  // Re-attach to a turn that is running RIGHT NOW: stream its remaining
  // frames into the same reducer the sender uses. Turn state stays live even
  // though this device never sent the message (or navigated away mid-turn).
  // A silent stream (no frame — not even a keepalive — for
  // TURN_STREAM_STALL_MS) or a transient error no longer strands the screen:
  // the loop asks the bridge whether the turn is still running and re-attaches
  // until it settles, instead of freezing until the user leaves and returns.
  const attachLive = useCallback(
    async (chatId: string) => {
      if (disposedRef.current || watchingRef.current || runningRef.current)
        return;
      watchingRef.current = true;
      const generation = ++watchGenerationRef.current;
      try {
        for (let attempt = 0; attempt < 8; attempt++) {
          // Superseded — or unmounted mid-loop.
          if (disposedRef.current || watchGenerationRef.current !== generation)
            return;
          const watch = await client
            .watchTurn(agentId, chatId)
            .catch(() => null);
          if (!watch) {
            await sleep(3000);
            continue;
          }
          watchRef.current = watch;
          const outcome = await consumeEventsWithStallWatch(
            watch.events,
            (event) =>
              setChat((current) => applyEvent(current ?? emptyChat(), event)),
            { stallMs: TURN_STREAM_STALL_MS },
          );
          watchRef.current = null;
          let result: (HermesSendResult & { running: boolean }) | null = null;
          if (outcome === "done") {
            result = await awaitResultWithin(
              watch.result,
              STREAM_RESULT_WAIT_MS,
            );
          } else {
            // Detach this dead client stream (does NOT interrupt the agent).
            // Awaiting its result after a stall could hang forever and prevent
            // the history check / re-attach loop below from ever running.
            void watch.abort(`watch stream ${outcome}`);
          }
          // Nothing was in flight after all — settle from the transcript.
          if (result && !result.running) {
            const history = await client
              .chatHistory(agentId, chatId)
              .catch(() => null);
            if (history) applyHistory(history);
            return;
          }
          // Streamed the turn through to its terminal frame — settle from
          // history for the authoritative text.
          if (outcome === "done" && result && !result.interrupted) {
            const history = await client
              .chatHistory(agentId, chatId)
              .catch(() => null);
            if (history) applyHistory(history);
            return;
          }
          // Interrupted, stalled, or errored — the turn may still be running
          // on the bridge. Check, then re-attach after a short pause.
          const history = await client
            .chatHistory(agentId, chatId)
            .catch(() => null);
          if (!history) {
            await sleep(3000);
            continue;
          }
          applyHistory(history);
          if (!history.running) return;
          await sleep(3000);
        }
      } finally {
        if (watchGenerationRef.current === generation) {
          watchRef.current = null;
          watchingRef.current = false;
          setChat((current) =>
            current?.running
              ? { ...current, running: false, activity: null }
              : current,
          );
        }
      }
    },
    [client, agentId, applyHistory],
  );

  /**
   * Fetch the authoritative transcript from the bridge and reconcile the
   * screen: settle from history when no turn is running (also heals a
   * completion missed while disconnected), or seed the in-flight snapshot
   * and re-attach live when one still is. Bounded retries absorb the
   * transient transport errors that are common right after a mobile
   * reconnect — previously a single swallowed failure froze the
   * conversation until the user left and re-entered the screen. Never
   * clobbers a healthy local send stream or an already-live watch loop.
   */
  const reconcile = useCallback(
    async (options?: { retries?: number; surfaceErrors?: boolean }) => {
      const chatId = chatIdRef.current;
      if (!chatId || disposedRef.current) return;
      if (runningRef.current) return; // a live send stream owns the state
      const retries = options?.retries ?? 2;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const history = await client.chatHistory(agentId, chatId);
          if (disposedRef.current) return;
          setLoadError(null); // a previous failure just healed
          setActiveModel(history.context?.model ?? "");
          setActiveProvider(history.context?.provider ?? "");
          setPinnedCwd(history.context?.cwd ?? null);
          applyHistory(history);
          if (history.running && !watchingRef.current) {
            void attachLive(chatId);
          }
          return;
        } catch (cause) {
          if (disposedRef.current) return;
          if (!isTransientTransportError(cause)) {
            if (options?.surfaceErrors) {
              setLoadError(
                cause instanceof Error ? cause.message : String(cause),
              );
            }
            return;
          }
          if (attempt === retries) return;
          await sleep(1000 * (attempt + 1) * (attempt + 1)); // 1s, 4s, 9s…
        }
      }
    },
    [client, agentId, applyHistory, attachLive],
  );

  // The store hot-swaps clients on background→foreground reconnects. Any
  // live turn/watch stream still bound to the retired client is dead weight:
  // its iterator can hang forever, wedging runningRef/watchingRef true and
  // freezing the composer until the user leaves the screen. Abort both
  // immediately and let the load/activity effects re-attach on the fresh
  // client. (Declared BEFORE the load effect so the refs are already reset
  // when that effect's attachLive call runs on the same commit.)
  const activeClientRef = useRef(client);
  useEffect(() => {
    if (activeClientRef.current === client) return;
    const previous = activeClientRef.current;
    activeClientRef.current = client;
    if (!previous) return;
    if (runningRef.current || watchingRef.current) {
      void turnRef.current?.abort("client swapped");
      void watchRef.current?.abort("client swapped");
      turnRef.current = null;
      watchRef.current = null;
      runningRef.current = false;
      watchingRef.current = false;
      watchGenerationRef.current += 1; // supersede any live watch loop
    }
  }, [client]);

  // Single revalidation path for the open conversation. It runs on mount,
  // on client hot-swap (reconcile's identity changes with the client), on
  // every background→foreground transition (resumedAt), and on every
  // activity-stream (re)open (snapshotSeq — the bridge's ground truth just
  // refreshed). Together these guarantee the screen can never sit on a stale
  // transcript after a suspend/resume round trip, without any polling while
  // idle.
  const snapshotSeq = activity.snapshotSeq;
  useEffect(() => {
    if (!initialChatId && !chatIdRef.current) return;
    if (initialChatId && promotedChatIdRef.current === initialChatId) {
      promotedChatIdRef.current = null;
      return;
    }
    void reconcile({ retries: 3, surfaceErrors: true });
  }, [reconcile, initialChatId, resumedAt, snapshotSeq]);

  // A turn started elsewhere while this chat is open and idle — pick it up
  // live instead of waiting for the completion notification.
  useEffect(() => {
    const chatId = chatIdRef.current;
    if (!chatId) return;
    if (!activity.running.has(activityKey(agentId, chatId))) return;
    if (runningRef.current || watchingRef.current) return;
    void reconcile({ retries: 2 });
  }, [activity.running, agentId, reconcile]);

  // A local turn stream stalled (silent past the keepalive cadence) — the
  // turn may still be running on the bridge. Poll a few times: resume live
  // streaming if it is, otherwise settle the transcript from history (also
  // heals a terminal frame lost to the stall).
  useEffect(() => {
    if (!reattachTick) return;
    const check = () => {
      if (runningRef.current || watchingRef.current) return;
      void reconcile({ retries: 0 });
    };
    check();
    const t1 = setTimeout(check, 4000);
    const t2 = setTimeout(check, 12000);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [reattachTick, reconcile]);

  // Stop listening (not the agent) when leaving the screen.
  useEffect(() => {
    // React StrictMode runs an extra setup→cleanup→setup cycle in development;
    // reset here so its simulated cleanup does not permanently disable the
    // live screen.
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      void turnRef.current?.abort("left chat screen");
      void watchRef.current?.abort("left chat screen");
    };
  }, []);

  // A turn for THIS conversation completed. The bridge reports completion
  // over the activity stream independent of our local send/watch stream, so
  // this also recovers the case where a local stream stalled (lost its
  // terminal frame / the relay dropped it) but the agent actually finished —
  // the only other way out of that was leaving and re-entering the screen.
  useEffect(() => {
    const completed = activity.lastCompleted;
    if (!completed || completed.seq <= handledCompletionSeqRef.current) return;
    handledCompletionSeqRef.current = completed.seq;
    if (completed.agentId !== agentId || completed.chatId !== chatIdRef.current)
      return;
    const endedLocallyJustNow =
      Date.now() - lastLocalTurnEndedAtRef.current < 5000;
    // If we still believe a turn is live, the bridge has now told us it is
    // done — release the stuck local loop and the frozen "working" state.
    if (runningRef.current || watchingRef.current) {
      void turnRef.current?.abort("turn completed externally");
      void watchRef.current?.abort("turn completed externally");
      runningRef.current = false;
      watchingRef.current = false;
    }
    // A just-finished local stream already settled the transcript; don't
    // clobber it. Otherwise pull the fresh one.
    if (endedLocallyJustNow) return;
    setChat((current) =>
      current?.running
        ? { ...current, running: false, activity: null }
        : current,
    );
    client
      .chatHistory(agentId, completed.chatId)
      .then((history) => applyHistory(history))
      .catch(() => undefined);
  }, [activity.lastCompleted, agentId, applyHistory, client]);

  // Last-resort heartbeat: while the chat is believed running but NEITHER a
  // local send stream NOR a watch loop is live (both died, or their recovery
  // attempts ran out), nothing else can move the state forward — reconcile
  // on a slow interval. Skipped entirely while idle, streaming, or hidden.
  const chatRunning = chat?.running ?? false;
  const bridgeSaysRunning = Boolean(
    chatIdRef.current &&
    activity.running.has(activityKey(agentId, chatIdRef.current)),
  );
  useEffect(() => {
    if (!chatRunning && !bridgeSaysRunning) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (runningRef.current || watchingRef.current) return;
      void reconcile({ retries: 1 });
    }, STUCK_POLL_MS);
    return () => clearInterval(timer);
  }, [chatRunning, bridgeSaysRunning, reconcile]);

  useEffect(() => {
    followBottomRef.current = true;
    lastScrollTopRef.current = 0;
  }, [agentId, initialChatId]);

  const loadOlder = useCallback(async () => {
    const chatId = chatIdRef.current;
    const beforeOrdinal = historyCursorRef.current;
    if (
      !chatId ||
      beforeOrdinal === undefined ||
      historyLoadingRef.current ||
      runningRef.current ||
      watchingRef.current
    ) {
      return;
    }
    const el = scrollRef.current;
    if (!el) return;

    historyLoadingRef.current = true;
    setLoadingOlder(true);
    followBottomRef.current = false;
    pendingPrependScrollRef.current = {
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
    };
    try {
      const history = await client.chatHistory(agentId, chatId, beforeOrdinal);
      setLoadError(null);
      applyHistory(history, true);
    } catch (cause) {
      pendingPrependScrollRef.current = null;
      if (!isTransientTransportError(cause)) {
        setLoadError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      historyLoadingRef.current = false;
      setLoadingOlder(false);
    }
  }, [agentId, applyHistory, client]);

  // Prepending an older page increases scrollHeight. Offset scrollTop by the
  // same delta so the message the user was reading stays under their finger.
  useLayoutEffect(() => {
    const pending = pendingPrependScrollRef.current;
    const el = scrollRef.current;
    if (!pending || !el) return;
    pendingPrependScrollRef.current = null;
    el.scrollTop = pending.scrollTop + (el.scrollHeight - pending.scrollHeight);
    lastScrollTopRef.current = el.scrollTop;
  }, [chat?.items]);

  // Follow streamed frames only while the user remains near the bottom. Once
  // they scroll up, preserve that reading position until they return.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && followBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      lastScrollTopRef.current = el.scrollTop;
    }
  }, [chat?.items, chat?.activity]);

  const send = useCallback(async () => {
    const typed = input.trim();
    if ((!typed && attachments.length === 0) || runningRef.current) return;
    // Compose the wire text: optional file references + the typed message.
    const fileRefs = attachments.map((file) => {
      const absolutePath =
        (file.metadata?.absolutePath as string | undefined) ?? file.id;
      return `[file: ${file.filename} (${file.sizeBytes} bytes) at ${absolutePath}]`;
    });
    const text = typed ? [...fileRefs, typed].join("\n") : fileRefs.join("\n");
    const promptText = replyTarget
      ? formatReplyMessage(replyTarget, text)
      : text;
    setInput("");
    setAttachments([]);
    setReplyTarget(null);
    runningRef.current = true;
    followBottomRef.current = true;
    setChat((current) => withUserMessage(current ?? emptyChat(), promptText));

    // If the user typed a title for this new conversation, persist it now
    // that we're about to create the chat (and thus have a chatId). The
    // title is set before the first prompt so it names the conversation up
    // front instead of waiting for the auto-generated one.
    const pendingTitle =
      !initialChatId && !chatIdRef.current && titleDraft.trim()
        ? titleDraft.trim()
        : null;

    try {
      // Enforce a pending model switch INSIDE the message request itself. The
      // bridge applies it to the exact gateway session that runs this turn, so
      // it holds even for a brand-new conversation's first message (no durable
      // chatId exists yet, so a separate switchModel RPC can't be targeted).
      // This replaces the old "fire switchModel first" path, which silently
      // let that first request run on the profile default while the top-bar
      // chip already showed the picked model.
      const sendModel = pendingModel;

      // sendMessage can throw -32000 (ConnectionClosed) when the relay drops
      // mid-handshake during a hot-swap reconnect. The turn may have started
      // on the bridge — the activity stream re-attaches on reconnect. Don't
      // surface a false "turn failed" error for a transient transport loss.
      let turn: Awaited<ReturnType<typeof client.sendMessage>>;
      try {
        turn = await client.sendMessage({
          agentId,
          chatId: chatIdRef.current ?? undefined,
          text: promptText,
          ...(pendingCwd ? { cwd: pendingCwd } : {}),
          ...(sendModel
            ? {
                model: sendModel.model,
                ...(sendModel.provider ? { provider: sendModel.provider } : {}),
              }
            : {}),
        });
        // The model override rode on the send RPC (applied on the bridge's
        // session), so the pending switch is fulfilled — release it so it
        // doesn't keep firing on every later message.
        if (sendModel) setPendingModel(null);
      } catch (cause) {
        // Transient relay/transport loss — not a real turn failure.
        if (isTransientTransportError(cause)) return;
        throw cause;
      }
      turnRef.current = turn;
      let resolvedChatId = "";
      let streamOutcome: StreamWatchOutcome = "error";
      streamOutcome = await consumeEventsWithStallWatch(
        turn.events,
        (event) => {
          if (event.type === "chat.started") {
            chatIdRef.current = event.chatId;
            resolvedChatId = event.chatId;
            if (!initialChatId) {
              promotedChatIdRef.current = event.chatId;
              nav.replaceTop({
                kind: "chat",
                agentId,
                agentName,
                chatId: event.chatId,
                title: titleDraft.trim() || title || "Conversation",
              });
            }
            if (pendingCwd) {
              setPinnedCwd(pendingCwd);
              setPendingCwd(null);
            }
          }
          setChat((current) => applyEvent(current ?? emptyChat(), event));
        },
        { stallMs: TURN_STREAM_STALL_MS },
      );
      let sendResult: HermesSendResult | null = null;
      if (streamOutcome === "done") {
        sendResult = await awaitResultWithin(
          turn.result,
          STREAM_RESULT_WAIT_MS,
        );
      } else {
        // Detach the dead client stream (does NOT interrupt the agent). Never
        // await its result after a stall: that promise can remain pending on a
        // half-open WebSocket and keep runningRef true forever.
        void turn.abort(`send stream ${streamOutcome}`);
      }
      // Only a turn whose terminal frame we actually received counts as
      // "settled locally" — the completion effect uses that to skip its own
      // history reload, so an aborted or stalled stream must not claim it.
      if (streamOutcome === "done" && sendResult && !sendResult.interrupted) {
        lastLocalTurnEndedAtRef.current = Date.now();
      }
      // A stalled or errored stream may still have a live turn on the bridge.
      // Recover from history instead of freezing until the user leaves and
      // re-enters the screen.
      if (
        (streamOutcome === "stalled" || streamOutcome === "error") &&
        chatIdRef.current
      ) {
        setReattachTick((value) => value + 1);
      }

      // Persist the title now that the chat exists, if the user set one and
      // the turn created a new conversation.
      if (pendingTitle && resolvedChatId) {
        void client
          .setChatTitle(agentId, resolvedChatId, pendingTitle)
          .then(() => setTitleSaved(true))
          .catch(() => undefined);
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // A transient transport drop is not a turn failure — the turn keeps
      // running on the bridge and the activity stream re-attaches on
      // reconnect. Don't inject a scary error row for it.
      if (isTransientTransportError(cause)) return;
      setChat((current) =>
        applyEvent(current ?? emptyChat(), { type: "error", message }),
      );
    } finally {
      turnRef.current = null;
      runningRef.current = false;
      // The stream can end without a terminal frame (abort/relay loss) — never
      // leave the composer stuck in "running". But when a watch re-attach
      // already took over (client swap / stall recovery), leave its live
      // running state alone — its next frame re-asserts it anyway.
      if (!watchingRef.current) {
        setChat((current) =>
          current?.running
            ? { ...current, running: false, activity: null }
            : current,
        );
      }
    }
  }, [
    client,
    agentId,
    input,
    attachments,
    initialChatId,
    titleDraft,
    pendingModel,
    pendingCwd,
    replyTarget,
    nav,
    agentName,
    title,
  ]);

  const stop = useCallback(() => {
    if (chatIdRef.current) {
      void client.interrupt(agentId, chatIdRef.current).catch(() => undefined);
    }
  }, [client, agentId]);

  const answerApproval = useCallback(
    (item: ChatItem & { kind: "approval" }, choice: string) => {
      if (!chatIdRef.current) return;
      const allowed = ["once", "session", "always", "deny"].includes(choice)
        ? (choice as "once" | "session" | "always" | "deny")
        : "deny";
      void client
        .approve(agentId, chatIdRef.current, allowed)
        .then(() =>
          setChat((current) =>
            current ? markApprovalResolved(current, item.id, choice) : current,
          ),
        )
        .catch(() => undefined);
    },
    [client, agentId],
  );

  const answerClarify = useCallback(
    (item: ChatItem & { kind: "clarify" }, answer: string) => {
      if (!chatIdRef.current) return;
      const trimmed = answer.trim();
      if (!trimmed) return;
      void client
        .answerClarify(agentId, chatIdRef.current, item.requestId, trimmed)
        .then(() =>
          setChat((current) =>
            current ? markClarifyResolved(current, item.id, trimmed) : current,
          ),
        )
        .catch(() => undefined);
    },
    [client, agentId],
  );

  // Load the model picker payload from the bridge.
  const loadModels = useCallback(async (): Promise<HermesModelOptions> => {
    const options = await client.listModels({
      agentId,
      ...(chatIdRef.current ? { chatId: chatIdRef.current } : {}),
    });
    if (options.model) setActiveModel((current) => current || options.model);
    if (options.provider)
      setActiveProvider((current) => current || options.provider);
    return options;
  }, [client, agentId]);

  // A new conversation has no history payload to hydrate its effective model.
  // Load the profile default immediately so its context chip is visible before
  // the user opens the picker or sends the first message.
  useEffect(() => {
    if (initialChatId) return;
    void loadModels().catch(() => undefined);
  }, [initialChatId, loadModels]);

  // Existing conversations have a durable gateway session, so apply the switch
  // immediately. This survives every later lifecycle boundary (navigation,
  // relay reconnect, app backgrounding, Android process recreation) and takes
  // effect on the next prompt even when the current turn is still running.
  // A brand-new unsent conversation has no session yet; retain the selection
  // and enforce it atomically inside its first hermes.chat.send instead.
  const handleModelSelect = useCallback(
    async (model: string, provider: string) => {
      const chatId = chatIdRef.current;
      if (chatId) {
        const result = await client.switchModel({
          agentId,
          chatId,
          model,
          ...(provider ? { provider } : {}),
        });
        if (result.confirmRequired) {
          throw new Error(
            result.confirmMessage ?? "The model switch requires confirmation.",
          );
        }
        setPendingModel(null);
      } else {
        setPendingModel({ model, provider });
      }
      setActiveModel(model);
      setActiveProvider(provider);
    },
    [client, agentId],
  );

  // Called when the user selects a project in the picker. For an existing
  // chat, the cwd is applied immediately. For a new (unsent) chat, we stash
  // it and apply on the first send — the bridge needs a chatId to set the cwd.
  const handleProjectSelect = useCallback(
    async (cwd: string) => {
      const chatId = chatIdRef.current;
      if (chatId) {
        const result = await client.setCwd({ agentId, chatId, cwd });
        setPinnedCwd(result.cwd);
        setPendingCwd(null);
      } else {
        setPendingCwd(cwd);
      }
    },
    [client, agentId],
  );

  // Called when the user selects a skill in the picker. Inserts a prompt hint
  // into the composer so the user can ask a targeted question — e.g.
  // "Use the github-pr-workflow skill to …" — without guessing what the agent
  // can do. The hint is appended to any existing draft text.
  const handleSkillSelect = useCallback((skill: HermesSkill) => {
    const hint = `Use the "${skill.name}" skill to …`;
    setInput((current) => {
      const trimmed = current.replace(/\s+$/, "");
      if (!trimmed) return hint;
      return `${trimmed}\n${hint}`;
    });
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }, []);

  const openPicker = useCallback((picker: "model" | "project" | "skills") => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    if (picker === "model") setShowModelPicker(true);
    else if (picker === "project") setShowProjectPicker(true);
    else setShowSkillPicker(true);
  }, []);

  const replyToSelected = useCallback(() => {
    if (!selectedMessage) return;
    setReplyTarget({
      author: selectedMessage.kind === "user" ? "You" : agentName,
      text: selectedMessage.text,
    });
    setSelectedMessage(null);
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }, [selectedMessage, agentName]);

  const handoffSelected = useCallback(() => {
    if (!selectedMessage || !chatIdRef.current) return;
    const sameText = (chat?.items ?? []).filter(
      (item) =>
        item.kind === selectedMessage.kind &&
        item.text === selectedMessage.text,
    );
    const occurrence = Math.max(0, sameText.indexOf(selectedMessage));
    setHandoffSeed({
      role: selectedMessage.kind,
      text: selectedMessage.text,
      ordinal: selectedMessage.ordinal,
      digest: selectedMessage.digest,
      occurrence,
    });
    setSelectedMessage(null);
  }, [chat?.items, selectedMessage]);

  const copySelected = useCallback(async () => {
    if (!selectedMessage) return;
    await copyText(selectedMessage.text).catch(() => undefined);
    setSelectedMessage(null);
  }, [selectedMessage]);

  // A file was uploaded through the ContextVM file transfer package. Instead of
  // dumping a path reference into the textarea, keep it as a pending attachment
  // chip; the path reference is composed into the wire text only at send time.
  const handleFileUploaded = useCallback((file: FileTransferDescriptor) => {
    setAttachments((current) => [...current, file]);
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }, []);

  const removeAttachment = useCallback((index: number) => {
    setAttachments((current) => current.filter((_, i) => i !== index));
  }, []);

  const navigateToHandoff = useCallback(
    (
      destinationAgentId: string,
      destinationChatId: string,
      destinationTitle: string | undefined,
      fallbackTitle: string,
    ) => {
      setHandoffSeed(null);
      nav.push({
        kind: "chat",
        agentId: destinationAgentId,
        agentName: displayAgentName(destinationAgentId),
        chatId: destinationChatId,
        title: destinationTitle || fallbackTitle,
      });
    },
    [nav],
  );

  const running = chat?.running ?? false;
  // "Working" can also come from a turn we aren't streaming ourselves (another
  // device, or this chat was opened mid-turn).
  const workingExternally =
    !running &&
    chatIdRef.current !== null &&
    activity.running.has(activityKey(agentId, chatIdRef.current));

  // The model chip in the top bar: pending > active > none.
  const modelChip = pendingModel?.model || activeModel || "";

  // The project chip in the top bar: pending > pinned > none.
  // Shows the basename of the pinned project path so it fits in the top bar.
  const cwdChip = (() => {
    const cwd = pendingCwd || pinnedCwd;
    if (!cwd) return "";
    const parts = cwd.replace(/\/+$/, "").split("/");
    return parts[parts.length - 1] || cwd;
  })();

  return (
    <div
      className="screen chat-screen"
      style={
        {
          "--chat-visual-viewport-top": `${visualViewportTop}px`,
        } as CSSProperties
      }
    >
      <TopBar
        back
        title={title || agentName}
        subtitle={
          running ? (
            <span className="typing">{chat?.activity ?? "working…"}</span>
          ) : workingExternally ? (
            <span className="typing">working…</span>
          ) : (
            agentName
          )
        }
        leading={<Avatar name={agentName} size={34} />}
        trailing={
          <div className="topbar-actions">
            <button
              type="button"
              className="icon-button"
              onClick={() => openPicker("project")}
              aria-label="Set project"
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              </svg>
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={() => openPicker("skills")}
              aria-label="Browse skills"
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 2 2 7l10 5 10-5-10-5z" />
                <path d="m2 17 10 5 10-5" />
                <path d="m2 12 10 5 10-5" />
              </svg>
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={() => openPicker("model")}
              aria-label="Switch model"
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="3" y="6" width="18" height="12" rx="2" />
                <path d="M7 12h.01M12 12h.01M17 12h.01" />
              </svg>
            </button>
          </div>
        }
      />
      {modelChip || cwdChip ? (
        <div className="chat-context-chips" aria-label="Conversation context">
          {modelChip ? (
            <button
              type="button"
              className="model-pill"
              onClick={() => openPicker("model")}
            >
              {pendingModel ? "pending: " : ""}
              {modelChip}
            </button>
          ) : null}
          {cwdChip ? (
            <button
              type="button"
              className="model-pill"
              onClick={() => openPicker("project")}
            >
              {pendingCwd ? "pending: " : ""}
              {cwdChip}
            </button>
          ) : null}
        </div>
      ) : null}
      {loadError ? (
        <div className="screen-error">{loadError}</div>
      ) : chat === null ? (
        <Spinner />
      ) : (
        <>
          {!initialChatId && !chatIdRef.current ? (
            <div className="title-bar">
              <input
                className="title-input"
                type="text"
                placeholder="Conversation title (optional)"
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                disabled={titleSaved}
              />
            </div>
          ) : null}
          <div
            className="chat-scroll"
            ref={scrollRef}
            onScroll={(event) => {
              const el = event.currentTarget;
              followBottomRef.current = shouldFollowChatBottom(
                followBottomRef.current,
                lastScrollTopRef.current,
                el,
              );
              lastScrollTopRef.current = el.scrollTop;
              if (el.scrollTop <= 40) void loadOlder();
            }}
          >
            <div className="chat-items">
              {loadingOlder ? (
                <div className="pagination-status">Loading older…</div>
              ) : null}
              {chat.items.map((item) => (
                <ChatRow
                  key={item.id}
                  item={item}
                  onApprove={answerApproval}
                  onClarify={answerClarify}
                  onSelectMessage={setSelectedMessage}
                />
              ))}
              {chat.activity ? (
                <div className="activity-row">
                  <span className="typing-dots">
                    <i />
                    <i />
                    <i />
                  </span>
                  {chat.activity}
                </div>
              ) : null}
            </div>
          </div>
        </>
      )}
      {replyTarget ? (
        <div className="reply-preview">
          <div className="reply-preview__body">
            <strong>Reply to {replyTarget.author}</strong>
            <span>{replyTarget.text}</span>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Cancel reply"
            onClick={() => setReplyTarget(null)}
          >
            ×
          </button>
        </div>
      ) : null}
      <AttachmentChips files={attachments} onRemove={removeAttachment} />
      <div className="composer">
        <div className="composer-field">
          <textarea
            ref={composerRef}
            rows={1}
            enterKeyHint="enter"
            placeholder={`Message ${agentName}…`}
            value={input}
            onChange={(event) => setInput(event.target.value)}
          />
          <FileUploader
            client={client}
            waitForClient={waitForClient}
            onUploaded={handleFileUploaded}
            disabled={running}
          />
          <VoiceRecorder
            client={client}
            onTranscript={(transcript) =>
              setInput((current) => appendTranscript(current, transcript))
            }
          />
        </div>
        {running ? (
          <button
            type="button"
            className="send-button stop"
            onClick={stop}
            aria-label="Stop"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          </button>
        ) : (
          <button
            type="button"
            className="send-button"
            onClick={() => void send()}
            disabled={!input.trim() && attachments.length === 0}
            aria-label="Send"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3.4 20.4 22 12 3.4 3.6 3.4 10l13 2-13 2z" />
            </svg>
          </button>
        )}
      </div>
      {selectedMessage ? (
        <div
          className="modal-backdrop"
          onClick={() => setSelectedMessage(null)}
        >
          <div
            className="message-actions"
            role="dialog"
            aria-modal="true"
            aria-label="Message actions"
            onClick={(event) => event.stopPropagation()}
          >
            <button type="button" onClick={replyToSelected}>
              Reply
            </button>
            {chatIdRef.current ? (
              <button type="button" onClick={handoffSelected}>
                Send to…
              </button>
            ) : null}
            <button type="button" onClick={() => void copySelected()}>
              Copy
            </button>
          </div>
        </div>
      ) : null}
      {handoffSeed && chatIdRef.current ? (
        <HandoffComposer
          source={{ agentId, chatId: chatIdRef.current, title }}
          seed={handoffSeed}
          onClose={() => setHandoffSeed(null)}
          onDelivered={(agent, chatId, destinationTitle) =>
            navigateToHandoff(agent, chatId, destinationTitle, "Handoff")
          }
          onNavigate={(agent, chatId, destinationTitle) =>
            navigateToHandoff(agent, chatId, destinationTitle, "Conversation")
          }
        />
      ) : null}
      {showModelPicker ? (
        <ModelPicker
          agentId={agentId}
          chatId={chatIdRef.current}
          currentModel={activeModel}
          currentProvider={activeProvider}
          load={loadModels}
          onSelect={handleModelSelect}
          onClose={() => setShowModelPicker(false)}
        />
      ) : null}
      {showProjectPicker ? (
        <ProjectPicker
          agentId={agentId}
          currentCwd={pendingCwd || pinnedCwd}
          onSelect={handleProjectSelect}
          onClose={() => setShowProjectPicker(false)}
        />
      ) : null}
      {showSkillPicker ? (
        <SkillPicker
          load={() => client.listSkills(agentId)}
          onSelect={handleSkillSelect}
          onClose={() => setShowSkillPicker(false)}
        />
      ) : null}
    </div>
  );
}

function ChatRow({
  item,
  onApprove,
  onClarify,
  onSelectMessage,
}: {
  item: ChatItem;
  onApprove: (item: ChatItem & { kind: "approval" }, choice: string) => void;
  onClarify: (item: ChatItem & { kind: "clarify" }, answer: string) => void;
  onSelectMessage: (item: SelectableMessage) => void;
}) {
  const selectable =
    item.kind === "user" || (item.kind === "assistant" && !item.streaming);
  const pressHandlers = useLongPress(() => {
    if (item.kind === "user" || item.kind === "assistant") {
      onSelectMessage(item);
    }
  }, selectable);
  const excerpt =
    item.kind === "user" || item.kind === "assistant"
      ? item.text.replace(/\s+/g, " ").trim().slice(0, 80)
      : "";
  const selectableProps = selectable
    ? {
        role: "button" as const,
        tabIndex: 0,
        "aria-label": `${
          item.kind === "user" ? "You" : "Assistant"
        }: ${excerpt}. Open message actions`,
        onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          if (item.kind === "user" || item.kind === "assistant")
            onSelectMessage(item);
        },
      }
    : {};

  switch (item.kind) {
    case "user": {
      const reply = parseReplyMessage(item.text);
      return (
        <div
          className="bubble-row user message-pressable"
          {...pressHandlers}
          {...selectableProps}
        >
          <div className="bubble user">
            {reply ? (
              <div className="sent-reply">
                <strong>{reply.author}</strong>
                <span>{reply.quote}</span>
              </div>
            ) : null}
            <span className="bubble-copy">{reply?.message ?? item.text}</span>
            <span className="message-status" aria-label="Sending">
              <span aria-hidden>🕓</span>
            </span>
          </div>
        </div>
      );
    }
    case "thinking":
      return <ThinkingBlock text={item.text} streaming={item.streaming} />;
    case "assistant":
      return (
        <div
          className="bubble-row assistant message-pressable"
          {...pressHandlers}
          {...selectableProps}
        >
          <div
            className={`bubble assistant${item.streaming ? " streaming" : ""}${item.failed ? " failed" : ""}`}
          >
            <Markdown text={item.text} />
            {item.streaming ? <span className="cursor" /> : null}
            {item.failed ? (
              <div className="bubble-error">turn failed: {item.failed}</div>
            ) : null}
          </div>
        </div>
      );
    case "tool":
      return <ToolCard item={item} />;
    case "approval":
      return (
        <div className="approval-card">
          <div className="approval-title">Command approval requested</div>
          <code className="approval-command">{item.command}</code>
          {item.description ? (
            <div className="approval-desc">{item.description}</div>
          ) : null}
          {item.resolved ? (
            <div className="approval-resolved">answered: {item.resolved}</div>
          ) : (
            <div className="approval-actions">
              {item.choices.map((choice) => (
                <button
                  key={choice}
                  type="button"
                  className={`button compact ${choice === "deny" ? "danger" : "secondary"}`}
                  onClick={() => onApprove(item, choice)}
                >
                  {choice}
                </button>
              ))}
            </div>
          )}
        </div>
      );
    case "clarify":
      return <ClarifyCard item={item} onClarify={onClarify} />;
    case "error":
      return <div className="chat-error">{item.text}</div>;
  }
}

function ClarifyCard({
  item,
  onClarify,
}: {
  item: ChatItem & { kind: "clarify" };
  onClarify: (item: ChatItem & { kind: "clarify" }, answer: string) => void;
}) {
  const [draft, setDraft] = useState("");

  // When the agent offered choices, show them as buttons; otherwise show a
  // text input so the user can type a free-form answer.
  const hasChoices = item.choices.length > 0;

  const submit = (answer: string) => {
    if (!answer.trim()) return;
    onClarify(item, answer);
    setDraft("");
  };

  return (
    <div className="clarify-card">
      <div className="clarify-title">Agent is asking</div>
      <div className="clarify-question">{item.question}</div>
      {item.resolved ? (
        <div className="clarify-resolved">answered: {item.resolved}</div>
      ) : hasChoices ? (
        <div className="clarify-actions">
          {item.choices.map((choice) => (
            <button
              key={choice}
              type="button"
              className="button compact secondary"
              onClick={() => submit(choice)}
            >
              {choice}
            </button>
          ))}
        </div>
      ) : (
        <form
          className="clarify-form"
          onSubmit={(e) => {
            e.preventDefault();
            submit(draft);
          }}
        >
          <input
            className="clarify-input"
            value={draft}
            placeholder="Type your answer…"
            onChange={(e) => setDraft(e.target.value)}
          />
          <button
            type="submit"
            className="button compact primary"
            disabled={!draft.trim()}
          >
            Send
          </button>
        </form>
      )}
    </div>
  );
}

function ThinkingBlock({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  // Auto-expanded while streaming so you watch the reasoning arrive; collapses
  // to a one-line summary once the block is done (tap to reopen).
  const [open, setOpen] = useState(true);
  const expanded = streaming || open;
  return (
    <div className={`think-block${streaming ? " streaming" : ""}`}>
      <button
        type="button"
        className="think-head"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="think-spark" aria-hidden>
          ✦
        </span>
        <span className="think-label">
          {streaming ? "Thinking…" : "Thought process"}
        </span>
        <span className="think-toggle">{expanded ? "hide" : "show"}</span>
      </button>
      {expanded ? <div className="think-body">{text}</div> : null}
    </div>
  );
}

function useLongPress(action: () => void, enabled: boolean) {
  const actionRef = useRef(action);
  actionRef.current = action;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const triggeredAtRef = useRef(0);

  const cancel = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    startRef.current = null;
  }, []);

  useEffect(() => cancel, [cancel]);

  const trigger = () => {
    const now = Date.now();
    if (now - triggeredAtRef.current < 700) return;
    triggeredAtRef.current = now;
    actionRef.current();
  };

  const begin = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!enabled || (event.pointerType === "mouse" && event.button !== 0))
      return;
    cancel();
    startRef.current = { x: event.clientX, y: event.clientY };
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      navigator.vibrate?.(20);
      trigger();
    }, 550);
  };

  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = startRef.current;
    if (
      start &&
      Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10
    ) {
      cancel();
    }
  };

  const context = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!enabled) return;
    event.preventDefault();
    cancel();
    trigger();
  };

  return {
    onPointerDown: begin,
    onPointerMove: move,
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onContextMenu: context,
  };
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const fallback = document.createElement("textarea");
  fallback.value = text;
  fallback.style.position = "fixed";
  fallback.style.opacity = "0";
  document.body.appendChild(fallback);
  fallback.select();
  document.execCommand("copy");
  fallback.remove();
}

function ToolCard({ item }: { item: ChatItem & { kind: "tool" } }) {
  const [open, setOpen] = useState(false);
  const hasDetail = Boolean(item.argsText || item.summary || item.error);
  const status = item.done ? (item.error ? "error" : "done") : "running";
  return (
    <div className={`tool-card ${status}`}>
      <button
        type="button"
        className="tool-card-head"
        onClick={() => hasDetail && setOpen((value) => !value)}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
        <span className="tool-name">{item.name ?? "tool"}</span>
        {!item.done ? (
          <span className="tool-state">running…</span>
        ) : item.error ? (
          <span className="tool-state err">failed</span>
        ) : (
          <span className="tool-state ok">done</span>
        )}
        {hasDetail ? (
          <span className="tool-expand">{open ? "▾" : "▸"}</span>
        ) : null}
      </button>
      {item.argsText ? (
        <pre className="tool-cmd">
          <code>{item.argsText}</code>
        </pre>
      ) : null}
      {/* Live output while running (always shown); full output when expanded. */}
      {!item.done && item.preview ? (
        <pre className="tool-output live">
          <code>{item.preview}</code>
        </pre>
      ) : null}
      {open && item.done && (item.summary || item.error) ? (
        <pre className={`tool-output${item.error ? " err" : ""}`}>
          <code>{item.error ?? item.summary}</code>
        </pre>
      ) : null}
    </div>
  );
}

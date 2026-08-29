import { useCallback, useEffect, useRef, useState } from "react";
import type { HermesChatSummary } from "../lib/api";
import { formatChatTime, sourceBadge } from "../lib/chat";
import { activityKey, useActivity, useConnection, useNav } from "../lib/store";
import { isTransientTransportError } from "../lib/errors";
import {
  Avatar,
  EmptyState,
  Spinner,
  TopBar,
  WorkingDot,
} from "../components/ui";

const CHAT_PAGE_SIZE = 20;

export function mergeChatPages<T extends { id: string }>(
  current: T[],
  page: T[],
  placement: "front" | "back",
): T[] {
  const pageIds = new Set(page.map((item) => item.id));
  const remaining = current.filter((item) => !pageIds.has(item.id));
  return placement === "front"
    ? [...page, ...remaining]
    : [...remaining, ...page];
}

export function ChatsScreen({
  agentId,
  agentName,
}: {
  agentId: string;
  agentName: string;
}) {
  const { client } = useConnection();
  const nav = useNav();
  const activity = useActivity();
  const [chats, setChats] = useState<HermesChatSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);

  const mergePage = useCallback(
    (page: HermesChatSummary[], placement: "front" | "back" = "front") => {
      setChats((current) =>
        current ? mergeChatPages(current, page, placement) : page,
      );
    },
    [],
  );

  const reload = useCallback(() => {
    client
      .listChats(agentId, CHAT_PAGE_SIZE, 0)
      .then((page) => {
        setError(null);
        setHasMore(page.length === CHAT_PAGE_SIZE);
        mergePage(page);
      })
      .catch((cause: unknown) => {
        // Don't flash a permanent error for a transient transport drop during
        // a reconnect/background-return — the store reconnects and re-fetches.
        if (isTransientTransportError(cause)) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [client, agentId, mergePage]);

  const loadMore = useCallback(() => {
    if (!chats || !hasMore || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    client
      .listChats(agentId, CHAT_PAGE_SIZE, chats.length)
      .then((page) => {
        setHasMore(page.length === CHAT_PAGE_SIZE);
        mergePage(page, "back");
      })
      .catch((cause: unknown) => {
        if (!isTransientTransportError(cause)) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      });
  }, [agentId, chats, client, hasMore, mergePage]);

  useEffect(() => {
    setChats(null);
    setError(null);
    setHasMore(true);
  }, [agentId]);

  useEffect(() => {
    reload();
  }, [reload]);

  // A turn for this agent just finished (possibly triggered from another
  // device/screen) — refresh so the preview and ordering stay current.
  useEffect(() => {
    if (activity.lastCompleted?.agentId === agentId) reload();
  }, [activity.lastCompleted, agentId, reload]);

  // A turn STARTED for this agent — refresh so a brand-new conversation
  // appears in the list immediately, wearing its working indicator.
  const runningForAgent = [...activity.running].filter((key) =>
    key.startsWith(`${agentId}\u0000`),
  ).length;
  useEffect(() => {
    if (runningForAgent > 0) reload();
  }, [runningForAgent, reload]);

  const openChat = (chat: HermesChatSummary) => {
    nav.push({
      kind: "chat",
      agentId,
      agentName,
      chatId: chat.id,
      title: chat.title || chat.preview || "Conversation",
    });
  };

  return (
    <div className="screen">
      <TopBar
        back
        title={agentName}
        subtitle={
          chats
            ? `${chats.length}${hasMore ? "+" : ""} conversation${chats.length === 1 ? "" : "s"}`
            : "…"
        }
        leading={<Avatar name={agentName} size={34} />}
      />
      {error ? (
        <div className="screen-error">{error}</div>
      ) : chats === null ? (
        <Spinner />
      ) : chats.length === 0 ? (
        <EmptyState
          title="No conversations yet"
          hint="Start the first one below."
        />
      ) : (
        <div
          className="list"
          onScroll={(event) => {
            const el = event.currentTarget;
            if (el.scrollHeight - el.clientHeight - el.scrollTop <= 120) {
              loadMore();
            }
          }}
        >
          {chats.map((chat) => {
            const badge = sourceBadge(chat.source);
            const working = activity.running.has(activityKey(agentId, chat.id));
            return (
              <button
                key={chat.id}
                type="button"
                className="row"
                onClick={() => openChat(chat)}
              >
                <div className="row-body">
                  <div className="row-top">
                    <span className="row-title">
                      {chat.title || "Untitled"}
                    </span>
                    {working ? <WorkingDot /> : null}
                    <span className="row-time">
                      {formatChatTime(chat.startedAt)}
                    </span>
                  </div>
                  <div className="row-preview">
                    {working ? (
                      <span className="working-text">working on a reply…</span>
                    ) : (
                      chat.preview || "…"
                    )}
                  </div>
                  <div className="row-meta">
                    {badge ? (
                      <span className="chip subtle">{badge}</span>
                    ) : null}
                    <span className="row-count">
                      {chat.messageCount} messages
                    </span>
                  </div>
                </div>
              </button>
            );
          })}
          {loadingMore ? (
            <div className="pagination-status">Loading more…</div>
          ) : null}
        </div>
      )}
      <button
        type="button"
        className="fab"
        aria-label="New conversation"
        onClick={() =>
          nav.push({
            kind: "chat",
            agentId,
            agentName,
            chatId: null,
            title: "New conversation",
          })
        }
      >
        <svg
          width="26"
          height="26"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
      </button>
    </div>
  );
}

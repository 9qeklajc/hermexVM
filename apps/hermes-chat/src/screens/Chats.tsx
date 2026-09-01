import { useEffect, useMemo } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import type { HermesChatSummary } from "../lib/api";
import { formatChatTime, sourceBadge } from "../lib/chat";
import {
  activityKey,
  useActivity,
  useConnectionState,
  useNav,
} from "../lib/store";
import { queryKeys, visibleQueryError } from "../lib/query";
import { canFetchNextPage, canUseRetainedTransport } from "../lib/mobile-state";
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
  const { activeBridgeId, client, transportReplacing } = useConnectionState();
  const nav = useNav();
  const activity = useActivity();
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => queryKeys.chats(activeBridgeId ?? "unconfigured", agentId),
    [activeBridgeId, agentId],
  );
  const chatsQuery = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => {
      if (!client) throw new Error("Bridge is reconnecting");
      return client.listChats(agentId, CHAT_PAGE_SIZE, pageParam);
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, pages) =>
      lastPage.length === CHAT_PAGE_SIZE
        ? pages.reduce((count, page) => count + page.length, 0)
        : undefined,
    enabled: Boolean(
      activeBridgeId &&
      canUseRetainedTransport(Boolean(client), transportReplacing),
    ),
  });
  const chats = chatsQuery.data
    ? chatsQuery.data.pages.reduce<HermesChatSummary[]>(
        (all, page) => mergeChatPages(all, page, "back"),
        [],
      )
    : null;
  const hasMore = chatsQuery.hasNextPage;
  const loadingMore = chatsQuery.isFetchingNextPage;
  const canMutate = canUseRetainedTransport(
    Boolean(client),
    transportReplacing,
  );
  const error = visibleQueryError(chats !== null, chatsQuery.error);
  const loadMore = () => {
    if (canFetchNextPage(canMutate, hasMore, loadingMore)) {
      void chatsQuery.fetchNextPage();
    }
  };

  // A fresh transport may have replaced a stale background socket while this
  // screen stayed mounted. Revalidate through Query so concurrent focus,
  // reconnect, and activity triggers still collapse into one request.
  useEffect(() => {
    if (activeBridgeId && canMutate) {
      void queryClient.invalidateQueries({ queryKey });
    }
  }, [activeBridgeId, canMutate, queryClient, queryKey]);

  // A turn for this agent just finished (possibly triggered from another
  // device/screen) — refresh so the preview and ordering stay current.
  useEffect(() => {
    if (canMutate && activity.lastCompleted?.agentId === agentId) {
      void queryClient.invalidateQueries({ queryKey });
    }
  }, [activity.lastCompleted, agentId, canMutate, queryClient, queryKey]);

  // A turn STARTED for this agent — refresh so a brand-new conversation
  // appears in the list immediately, wearing its working indicator.
  const runningForAgent = [...activity.running].filter((key) =>
    key.startsWith(`${agentId}\u0000`),
  ).length;
  useEffect(() => {
    if (canMutate && runningForAgent > 0) {
      void queryClient.invalidateQueries({ queryKey });
    }
  }, [canMutate, queryClient, queryKey, runningForAgent]);

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
        disabled={!canMutate}
        onClick={() => {
          if (!canMutate) return;
          nav.push({
            kind: "chat",
            agentId,
            agentName,
            chatId: null,
            title: "New conversation",
          });
        }}
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

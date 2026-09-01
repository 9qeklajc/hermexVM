import { describe, expect, it } from "vitest";
import {
  beginAuthoritativeHistory,
  beginOlderHistory,
  canFetchNextPage,
  canUseRetainedTransport,
  createHistoryLoadState,
  finishHistoryLoad,
  isCurrentAuthoritativeHistory,
  isCurrentHistoryPage,
  isCurrentOlderHistory,
  isCurrentTransport,
  shouldRunActivityStream,
} from "./mobile-state";

describe("mobile transport state", () => {
  it("keeps cached browsing available without treating a retained client as writable", () => {
    expect(canUseRetainedTransport(true, false)).toBe(true);
    expect(canUseRetainedTransport(true, true)).toBe(false);
    expect(canUseRetainedTransport(false, false)).toBe(false);
  });

  it("suspends the activity stream while the retained transport is being replaced", () => {
    expect(shouldRunActivityStream(true, false)).toBe(true);
    expect(shouldRunActivityStream(true, true)).toBe(false);
    expect(shouldRunActivityStream(false, false)).toBe(false);
  });

  it("rejects a retained client synchronously at the replacement boundary", () => {
    const client = {};
    expect(isCurrentTransport(client, client, false)).toBe(true);
    expect(isCurrentTransport(client, client, true)).toBe(false);
    expect(isCurrentTransport(client, {}, false)).toBe(false);
  });

  it("denies manual infinite pagination while replacement is pending", () => {
    expect(canFetchNextPage(true, true, false)).toBe(true);
    expect(canFetchNextPage(false, true, false)).toBe(false);
    expect(canFetchNextPage(true, false, false)).toBe(false);
    expect(canFetchNextPage(true, true, true)).toBe(false);
  });

  it("invalidates an older page when authoritative history starts", () => {
    const older = beginOlderHistory(createHistoryLoadState());
    expect(older).not.toBeNull();
    expect(isCurrentOlderHistory(older!.state, older!.ticket)).toBe(true);

    const authoritative = beginAuthoritativeHistory(older!.state);
    expect(
      isCurrentOlderHistory(authoritative.state, older!.ticket),
    ).toBe(false);
    expect(authoritative.state.olderPending).toBe(false);
    expect(
      isCurrentAuthoritativeHistory(
        authoritative.state,
        authoritative.ticket,
      ),
    ).toBe(true);

    const afterStaleCleanup = finishHistoryLoad(
      authoritative.state,
      older!.ticket,
    );
    expect(afterStaleCleanup).toEqual(authoritative.state);
    expect(
      finishHistoryLoad(afterStaleCleanup, authoritative.ticket)
        .authoritativePending,
    ).toBe(false);
  });

  it("denies older pagination while authoritative history is pending", () => {
    const first = beginAuthoritativeHistory(createHistoryLoadState());
    expect(beginOlderHistory(first.state)).toBeNull();

    const second = beginAuthoritativeHistory(first.state);
    const afterFirstCleanup = finishHistoryLoad(second.state, first.ticket);
    expect(afterFirstCleanup.authoritativePending).toBe(true);
    expect(
      isCurrentAuthoritativeHistory(afterFirstCleanup, second.ticket),
    ).toBe(true);
  });

  it("accepts older history only from the current client and history epoch", () => {
    const client = {};
    const current = {
      requestClient: client,
      currentClient: client,
      requestEpoch: 4,
      currentEpoch: 4,
      requestChatId: "chat-1",
      currentChatId: "chat-1",
      transportReplacing: false,
      disposed: false,
    };

    expect(isCurrentHistoryPage(current)).toBe(true);
    expect(isCurrentHistoryPage({ ...current, currentClient: {} })).toBe(false);
    expect(isCurrentHistoryPage({ ...current, currentEpoch: 5 })).toBe(false);
    expect(isCurrentHistoryPage({ ...current, transportReplacing: true })).toBe(
      false,
    );
    expect(isCurrentHistoryPage({ ...current, disposed: true })).toBe(false);
    expect(isCurrentHistoryPage({ ...current, currentChatId: "chat-2" })).toBe(
      false,
    );
  });
});

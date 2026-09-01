export function canUseRetainedTransport(
  hasClient: boolean,
  transportReplacing: boolean,
): boolean {
  return hasClient && !transportReplacing;
}

export function shouldRunActivityStream(
  hasClient: boolean,
  transportReplacing: boolean,
): boolean {
  return canUseRetainedTransport(hasClient, transportReplacing);
}

export function isCurrentTransport<T>(
  candidate: T,
  current: T | null,
  transportReplacing: boolean,
): boolean {
  return candidate === current && !transportReplacing;
}

export type HistoryLoadState = {
  epoch: number;
  authoritativePending: boolean;
  olderRequestId: number;
  olderPending: boolean;
};

export type HistoryLoadTicket = {
  kind: "authoritative" | "older";
  epoch: number;
  requestId: number;
};

export function createHistoryLoadState(): HistoryLoadState {
  return {
    epoch: 0,
    authoritativePending: false,
    olderRequestId: 0,
    olderPending: false,
  };
}

export function beginAuthoritativeHistory(state: HistoryLoadState): {
  state: HistoryLoadState;
  ticket: HistoryLoadTicket;
} {
  const epoch = state.epoch + 1;
  const olderRequestId = state.olderRequestId + 1;
  return {
    state: {
      epoch,
      authoritativePending: true,
      olderRequestId,
      olderPending: false,
    },
    ticket: { kind: "authoritative", epoch, requestId: olderRequestId },
  };
}

export function beginOlderHistory(state: HistoryLoadState): {
  state: HistoryLoadState;
  ticket: HistoryLoadTicket;
} | null {
  if (state.authoritativePending || state.olderPending) return null;
  const requestId = state.olderRequestId + 1;
  return {
    state: { ...state, olderRequestId: requestId, olderPending: true },
    ticket: { kind: "older", epoch: state.epoch, requestId },
  };
}

export function finishHistoryLoad(
  state: HistoryLoadState,
  ticket: HistoryLoadTicket,
): HistoryLoadState {
  if (ticket.kind === "authoritative") {
    return ticket.epoch === state.epoch
      ? { ...state, authoritativePending: false }
      : state;
  }
  return ticket.epoch === state.epoch &&
    ticket.requestId === state.olderRequestId
    ? { ...state, olderPending: false }
    : state;
}

export function isCurrentAuthoritativeHistory(
  state: HistoryLoadState,
  ticket: HistoryLoadTicket,
): boolean {
  return (
    ticket.kind === "authoritative" &&
    ticket.epoch === state.epoch &&
    state.authoritativePending
  );
}

export function isCurrentOlderHistory(
  state: HistoryLoadState,
  ticket: HistoryLoadTicket,
): boolean {
  return (
    ticket.kind === "older" &&
    ticket.epoch === state.epoch &&
    ticket.requestId === state.olderRequestId &&
    state.olderPending &&
    !state.authoritativePending
  );
}

export function canFetchNextPage(
  canUseTransport: boolean,
  hasNextPage: boolean,
  isFetchingNextPage: boolean,
): boolean {
  return canUseTransport && hasNextPage && !isFetchingNextPage;
}

export function isCurrentHistoryPage<T>({
  requestClient,
  currentClient,
  requestEpoch,
  currentEpoch,
  requestChatId,
  currentChatId,
  transportReplacing,
  disposed,
}: {
  requestClient: T;
  currentClient: T;
  requestEpoch: number;
  currentEpoch: number;
  requestChatId: string;
  currentChatId: string | null;
  transportReplacing: boolean;
  disposed: boolean;
}): boolean {
  return (
    !disposed &&
    !transportReplacing &&
    requestClient === currentClient &&
    requestEpoch === currentEpoch &&
    requestChatId === currentChatId
  );
}

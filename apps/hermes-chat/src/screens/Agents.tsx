import { useEffect, useState } from "react";
import type { HermesAgentProfile } from "../lib/api";
import {
  useActivity,
  useConnection,
  useConnectionState,
  useNav,
} from "../lib/store";
import { isTransientTransportError } from "../lib/errors";
import {
  Avatar,
  EmptyState,
  HermesMark,
  Spinner,
  TopBar,
  WorkingDot,
} from "../components/ui";

export function AgentsScreen() {
  const { client } = useConnection();
  const { disconnect } = useConnectionState();
  const nav = useNav();
  const activity = useActivity();
  const [agents, setAgents] = useState<HermesAgentProfile[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .listAgents()
      .then((list) => {
        if (!cancelled) setAgents(list);
      })
      .catch((cause: unknown) => {
        // A transient transport drop during a reconnect must not flash a
        // permanent error box — the store reconnects and this effect re-runs.
        if (!cancelled && !isTransientTransportError(cause))
          setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  return (
    <div className="screen">
      <TopBar
        title="Hermes"
        leading={
          <div className="topbar-logo">
            <HermesMark size={28} />
          </div>
        }
        trailing={
          <button
            type="button"
            className="icon-button"
            onClick={disconnect}
            aria-label="Disconnect"
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
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <path d="m16 17 5-5-5-5" />
              <path d="M21 12H9" />
            </svg>
          </button>
        }
      />
      {error ? (
        <div className="screen-error">{error}</div>
      ) : agents === null ? (
        <Spinner />
      ) : agents.length === 0 ? (
        <EmptyState
          title="No agents found"
          hint="The bridge found no Hermes profiles on its host."
        />
      ) : (
        <div className="list">
          {agents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              className="row"
              onClick={() =>
                nav.push({
                  kind: "chats",
                  agentId: agent.id,
                  agentName: agent.name,
                })
              }
            >
              <Avatar name={agent.name} />
              <div className="row-body">
                <div className="row-top">
                  <span className="row-title">{agent.name}</span>
                  {agent.isDefault ? (
                    <span className="chip subtle">default</span>
                  ) : null}
                  {activity.runningAgents.has(agent.id) ? <WorkingDot /> : null}
                </div>
                <div className="row-preview">
                  {activity.runningAgents.has(agent.id) ? (
                    <span className="working-text">working on a reply…</span>
                  ) : (
                    agent.description ||
                    agent.soulExcerpt ||
                    "Hermes agent profile"
                  )}
                </div>
              </div>
              {agent.model ? (
                <span className="chip model">{agent.model}</span>
              ) : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

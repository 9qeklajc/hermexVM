import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useActivity, useConnectionState, useNav } from "../lib/store";
import { queryKeys, visibleQueryError } from "../lib/query";
import { canUseRetainedTransport } from "../lib/mobile-state";
import {
  Avatar,
  EmptyState,
  HermesMark,
  Spinner,
  TopBar,
  WorkingDot,
} from "../components/ui";

export function AgentsScreen() {
  const { activeBridgeId, activeBridgeName, client, transportReplacing } =
    useConnectionState();
  const nav = useNav();
  const activity = useActivity();
  const queryClient = useQueryClient();
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents(activeBridgeId ?? "unconfigured"),
    queryFn: () => {
      if (!client) throw new Error("Bridge is reconnecting");
      return client.listAgents();
    },
    enabled: Boolean(
      activeBridgeId &&
      canUseRetainedTransport(Boolean(client), transportReplacing),
    ),
  });
  useEffect(() => {
    if (
      activeBridgeId &&
      canUseRetainedTransport(Boolean(client), transportReplacing)
    ) {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.agents(activeBridgeId),
      });
    }
  }, [activeBridgeId, client, queryClient, transportReplacing]);

  const agents = agentsQuery.data ?? null;
  const canMutate = canUseRetainedTransport(
    Boolean(client),
    transportReplacing,
  );
  const error = visibleQueryError(agents !== null, agentsQuery.error);

  return (
    <div className="screen">
      <TopBar
        title="Hermes"
        subtitle={activeBridgeName ?? undefined}
        leading={
          <div className="topbar-logo">
            <HermesMark size={28} />
          </div>
        }
        trailing={
          <button
            type="button"
            className="icon-button"
            onClick={() => nav.push({ kind: "settings" })}
            aria-label="Settings"
          >
            <svg
              width="21"
              height="21"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
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
            <div className="agent-row" key={agent.id}>
              <button
                type="button"
                className="row agent-row-main"
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
                    {activity.runningAgents.has(agent.id) ? (
                      <WorkingDot />
                    ) : null}
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
              <button
                type="button"
                className="icon-button agent-settings-button"
                aria-label={`Settings for ${agent.name}`}
                disabled={!canMutate}
                onClick={() => {
                  if (!canMutate) return;
                  nav.push({
                    kind: "profile-settings",
                    agentId: agent.id,
                    agentName: agent.name,
                    ...(agent.model ? { currentModel: agent.model } : {}),
                  });
                }}
              >
                <svg
                  width="19"
                  height="19"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

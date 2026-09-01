import {
  AppProvider,
  useConnectionState,
  useNav,
  type Screen,
} from "./lib/store";
import { ConnectScreen } from "./screens/Connect";
import { AgentsScreen } from "./screens/Agents";
import { ChatsScreen } from "./screens/Chats";
import { CachedChatScreen, ChatScreen } from "./screens/Chat";
import { SettingsScreen } from "./screens/Settings";
import { ProfileSettingsScreen } from "./screens/ProfileSettings";
import { Spinner } from "./components/ui";
import { connectionGate } from "@contexcgi/client";

function renderScreen(screen: Screen, hasClient: boolean) {
  switch (screen.kind) {
    case "connect":
      return <ConnectScreen />;
    case "agents":
      return <AgentsScreen />;
    case "settings":
      return <SettingsScreen />;
    case "profile-settings":
      return (
        <ProfileSettingsScreen
          agentId={screen.agentId}
          agentName={screen.agentName}
          currentModel={screen.currentModel}
        />
      );
    case "chats":
      return (
        <ChatsScreen agentId={screen.agentId} agentName={screen.agentName} />
      );
    case "chat":
      return !hasClient && screen.chatId ? (
        <CachedChatScreen
          agentId={screen.agentId}
          agentName={screen.agentName}
          chatId={screen.chatId}
          title={screen.title}
        />
      ) : (
        <ChatScreen
          agentId={screen.agentId}
          agentName={screen.agentName}
          chatId={screen.chatId}
          title={screen.title}
        />
      );
  }
}

function Shell() {
  const nav = useNav();
  const {
    ready,
    config,
    client,
    status,
    transportReplacing,
    error,
    reconnect,
    disconnect,
    bridges,
    activeBridgeId,
    activeBridgeName,
    switchBridge,
  } = useConnectionState();
  const gate = connectionGate({
    ready,
    hasConfig: Boolean(config),
    hasClient: Boolean(client),
    status,
  });
  if (gate === "loading") {
    return (
      <div className="app app--loading">
        <Spinner />
      </div>
    );
  }
  if (gate === "recovery") {
    return (
      <div className="app">
        <div className="connect-screen">
          <div className="connect-form">
            <h2>{activeBridgeName ?? "Bridge"} is offline</h2>
            <div className="form-error" style={{ whiteSpace: "pre-wrap" }}>
              {error ?? "Connection interrupted. Your session is saved."}
            </div>
            <button className="button primary" onClick={reconnect}>
              Retry connection
            </button>
            {bridges.length > 1 ? (
              <div className="recovery-bridges">
                <span>Or switch bridge</span>
                {bridges
                  .filter((bridge) => bridge.id !== activeBridgeId)
                  .map((bridge) => (
                    <button
                      type="button"
                      className="button secondary"
                      key={bridge.id}
                      onClick={() => switchBridge(bridge.id)}
                    >
                      Connect to {bridge.name}
                    </button>
                  ))}
              </div>
            ) : null}
            <button
              className="button secondary"
              onClick={() => void disconnect()}
            >
              Remove saved bridges
            </button>
          </div>
        </div>
      </div>
    );
  }
  const top = nav.stack[nav.stack.length - 1] ?? { kind: "connect" as const };
  if (client && config && top.kind === "connect") {
    return (
      <div className="app app--loading">
        <Spinner />
      </div>
    );
  }
  const screen =
    config || top.kind === "connect" ? top : { kind: "connect" as const };
  return (
    <div className="app" key={`${screen.kind}:${nav.stack.length}`}>
      {(gate === "reconnecting" || transportReplacing) &&
      screen.kind !== "chat" ? (
        <div className="connection-banner">Reconnecting in the background…</div>
      ) : null}
      {renderScreen(screen, Boolean(client))}
    </div>
  );
}

export function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}

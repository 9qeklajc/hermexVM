import {
  AppProvider,
  useConnectionState,
  useNav,
  type Screen,
} from "./lib/store";
import { ConnectScreen } from "./screens/Connect";
import { AgentsScreen } from "./screens/Agents";
import { ChatsScreen } from "./screens/Chats";
import { ChatScreen } from "./screens/Chat";
import { SettingsScreen } from "./screens/Settings";
import { Spinner } from "./components/ui";
import { connectionGate } from "@contexcgi/client";

function renderScreen(screen: Screen) {
  switch (screen.kind) {
    case "connect":
      return <ConnectScreen />;
    case "agents":
      return <AgentsScreen />;
    case "settings":
      return <SettingsScreen />;
    case "chats":
      return (
        <ChatsScreen agentId={screen.agentId} agentName={screen.agentName} />
      );
    case "chat":
      return (
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
  const { ready, config, client, status, error, reconnect, disconnect } =
    useConnectionState();
  const gate = connectionGate({
    ready,
    hasConfig: Boolean(config),
    hasClient: Boolean(client),
    status,
  });
  if (gate === "loading" || gate === "reconnecting") {
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
            <div className="form-error" style={{ whiteSpace: "pre-wrap" }}>
              {error ?? "Connection interrupted. Your session is saved."}
            </div>
            <button className="button primary" onClick={reconnect}>
              Retry connection
            </button>
            <button className="button secondary" onClick={disconnect}>
              Edit connection settings
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
    client || top.kind === "connect" ? top : { kind: "connect" as const };
  return (
    <div className="app" key={`${screen.kind}:${nav.stack.length}`}>
      {renderScreen(screen)}
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

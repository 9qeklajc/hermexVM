import { useCallback, useState } from "react";
import type { HermesModelOptions } from "../lib/api";
import { ModelPicker } from "../components/ModelPicker";
import { TopBar } from "../components/ui";
import { useConnection, useNav } from "../lib/store";

export function ProfileSettingsScreen({
  agentId,
  agentName,
  currentModel,
}: {
  agentId: string;
  agentName: string;
  currentModel?: string;
}) {
  const { client } = useConnection();
  const nav = useNav();
  const [model, setModel] = useState(currentModel ?? "");
  const [provider, setProvider] = useState("");
  const [dirty, setDirty] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const loadModels = useCallback(async (): Promise<HermesModelOptions> => {
    return client.listModels({ agentId });
  }, [client, agentId]);

  const save = async () => {
    if (!model || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const input = {
        agentId,
        model,
        ...(provider ? { provider } : {}),
      };
      let result = await client.updateProfile(input);
      if (result.confirmRequired) {
        const confirmed = window.confirm(
          result.confirmMessage ?? "Confirm the model change.",
        );
        if (!confirmed) return;
        result = await client.updateProfile({
          ...input,
          confirmExpensiveModel: true,
        });
      }
      if (result.confirmRequired) {
        setSaveError(result.confirmMessage ?? "The model change wasn't saved.");
        return;
      }
      nav.pop();
    } catch (cause) {
      setSaveError(
        cause instanceof Error
          ? cause.message
          : "Couldn't update the profile default model.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="screen settings-screen">
      <TopBar title="Profile settings" subtitle={agentName} back />
      <div className="settings-content">
        <section className="settings-section">
          <div className="settings-section-heading">
            <h2>Default model</h2>
            <p>Used by new conversations for this profile.</p>
          </div>
          <button
            type="button"
            className="profile-model-select"
            onClick={() => setShowModelPicker(true)}
          >
            <span className="identity-label">Model</span>
            <span className="profile-model-value">
              {model || "Choose a model"}
            </span>
            <span className="profile-model-chevron">›</span>
          </button>
          <button
            type="button"
            className="button primary"
            disabled={!model || !dirty || saving}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save profile"}
          </button>
          {saveError ? (
            <div className="form-error" role="alert">
              {saveError}
            </div>
          ) : null}
        </section>
      </div>
      {showModelPicker ? (
        <ModelPicker
          agentId={agentId}
          chatId={null}
          currentModel={model}
          currentProvider={provider}
          load={loadModels}
          onSelect={async (nextModel, nextProvider) => {
            setModel(nextModel);
            setProvider(nextProvider);
            setDirty(true);
          }}
          onClose={() => setShowModelPicker(false)}
        />
      ) : null}
    </div>
  );
}

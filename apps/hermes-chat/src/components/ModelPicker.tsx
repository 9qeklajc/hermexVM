import { useCallback, useEffect, useMemo, useState } from "react";
import type { HermesModelOptions, HermesModelProvider } from "../lib/api";
import { Spinner } from "./ui";

/**
 * A bottom-sheet modal listing every available model grouped by provider,
 * mirroring the Hermes TUI/desktop model picker. Each provider group is
 * collapsible (tap the header) so a provider with 36 models doesn't dominate
 * the screen. Selecting a model calls `onSelect` with the model id and its
 * provider slug — the parent applies it immediately when the conversation has
 * a durable session, or atomically with the first send for a new conversation.
 */
export function ModelPicker({
  agentId,
  chatId,
  currentModel,
  currentProvider,
  load,
  onSelect,
  onClose,
}: {
  agentId: string;
  chatId: string | null;
  /** The model active right now (from session.info or the last switch). */
  currentModel: string;
  /** The provider active right now. */
  currentProvider: string;
  /** Load the model options payload from the bridge. */
  load: () => Promise<HermesModelOptions>;
  /** Called with the chosen model + provider slug. */
  onSelect: (model: string, provider: string) => Promise<void>;
  onClose: () => void;
}) {
  const [options, setOptions] = useState<HermesModelOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [switching, setSwitching] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  // Collapsed provider slugs. By default the current provider is expanded and
  // all others are collapsed — so a provider with 36 models doesn't flood the
  // sheet on open. Searching auto-expands all groups.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Unused props are part of the stable call signature — the bridge load fn
  // already closes over agentId/chatId, but parents pass them for clarity.
  void agentId;
  void chatId;

  const reload = useCallback(() => {
    setError(null);
    load()
      .then((payload) => {
        setOptions(payload);
        // Collapse every provider except the current one on first load.
        const currentSlug = payload.providers.find((p) => p.isCurrent)?.slug;
        setCollapsed(
          new Set(
            payload.providers
              .filter((p) => p.slug !== currentSlug)
              .map((p) => p.slug),
          ),
        );
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
  }, [load]);

  useEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    reload();
  }, [reload]);

  const filtered = useMemo<HermesModelProvider[]>(() => {
    if (!options) return [];
    const q = query.trim().toLowerCase();
    if (!q) return options.providers;
    return options.providers
      .map((provider) => {
        const models = provider.models.filter((m: string) =>
          m.toLowerCase().includes(q),
        );
        if (models.length === 0 && !provider.name.toLowerCase().includes(q))
          return null;
        return { ...provider, models, totalModels: models.length };
      })
      .filter(
        (p: HermesModelProvider | null): p is HermesModelProvider => p !== null,
      );
  }, [options, query]);

  const activeModel = currentModel || options?.model || "";
  const activeProvider = currentProvider || options?.provider || "";

  const toggleProvider = (slug: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  const choose = async (model: string, provider: string) => {
    if (switching) return;
    setSwitching(`${provider}/${model}`);
    setSwitchError(null);
    try {
      await onSelect(model, provider);
      onClose();
    } catch (cause) {
      setSwitchError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSwitching(null);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-sheet model-picker"
        role="dialog"
        aria-label="Switch model"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-handle" />
        <div className="modal-header">
          <h2>Switch model</h2>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close"
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
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
        <div className="model-picker-search">
          <input
            type="search"
            placeholder="Search models or providers…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="model-picker-body">
          {error ? (
            <div className="screen-error">{error}</div>
          ) : options === null ? (
            <Spinner />
          ) : filtered.length === 0 ? (
            <div className="empty-state">
              <p className="empty-title">No models found</p>
              <p className="empty-hint">
                {query
                  ? "Try a different search."
                  : "No providers are configured on this Hermes profile."}
              </p>
            </div>
          ) : (
            filtered.map((provider: HermesModelProvider) => {
              const providerActive =
                provider.isCurrent ||
                (activeProvider &&
                  provider.slug.toLowerCase() === activeProvider.toLowerCase());
              // When searching, never collapse — the user wants to see matches.
              const isCollapsed = !query && collapsed.has(provider.slug);
              return (
                <div key={provider.slug} className="provider-group">
                  <button
                    type="button"
                    className="provider-head"
                    onClick={() => toggleProvider(provider.slug)}
                    aria-expanded={!isCollapsed}
                  >
                    <span className="provider-name">{provider.name}</span>
                    {providerActive ? (
                      <span className="chip subtle">current</span>
                    ) : null}
                    {!provider.authenticated ? (
                      <span className="chip subtle">not connected</span>
                    ) : null}
                    <span className="provider-count">
                      {provider.models.length} model
                      {provider.models.length === 1 ? "" : "s"}
                    </span>
                    <span className="provider-chevron">
                      {isCollapsed ? "▸" : "▾"}
                    </span>
                  </button>
                  {!isCollapsed ? (
                    <div className="provider-models">
                      {provider.models.map((model: string) => {
                        const isActive =
                          providerActive &&
                          model.toLowerCase() === activeModel.toLowerCase();
                        const switchKey = `${provider.slug}/${model}`;
                        const isSwitching = switching === switchKey;
                        return (
                          <button
                            key={model}
                            type="button"
                            className={`model-row${isActive ? " active" : ""}`}
                            onClick={() => choose(model, provider.slug)}
                            disabled={Boolean(switching)}
                          >
                            <span className="model-name">{model}</span>
                            {isActive ? (
                              <svg
                                className="model-check"
                                width="16"
                                height="16"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <path d="M20 6 9 17l-5-5" />
                              </svg>
                            ) : isSwitching ? (
                              <span className="voice-spinner" />
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
        {switchError ? (
          <div className="model-picker-error">{switchError}</div>
        ) : null}
      </div>
    </div>
  );
}

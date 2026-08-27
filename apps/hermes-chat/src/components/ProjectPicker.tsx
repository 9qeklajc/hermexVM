import { useCallback, useEffect, useMemo, useState } from "react";
import type { HermesProject, HermesProjectsResult } from "../lib/api";
import { useConnection } from "../lib/store";
import { Spinner } from "./ui";

/**
 * A bottom-sheet modal listing every project the agent has worked in, so the
 * user can pin one as the conversation's working directory. Each project shows
 * its session count and last-active time; repos (git roots) are collapsible.
 * Selecting a project calls `onSelect` with the project's primary path — the
 * parent applies it via `client.setCwd`, and the agent then operates in that
 * project for the rest of the conversation without being told each time.
 */
export function ProjectPicker({
  agentId,
  currentCwd,
  onSelect,
  onClose,
}: {
  agentId: string;
  /** The cwd already pinned on this conversation, when known. */
  currentCwd: string | null;
  /** Called with the chosen project's path. */
  onSelect: (path: string) => Promise<void>;
  onClose: () => void;
}) {
  const { client } = useConnection();
  const [result, setResult] = useState<HermesProjectsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [applying, setApplying] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  // Collapsed project ids — by default all expanded since there are usually
  // few projects. Searching auto-expands all.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const reload = useCallback(() => {
    setError(null);
    client
      .listProjects(agentId)
      .then((payload) => {
        setResult(payload);
        // Sort: explicit projects first (isAuto=false), then by lastActive desc
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
  }, [client, agentId]);

  useEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    reload();
  }, [reload]);

  const sorted = useMemo<HermesProject[]>(() => {
    if (!result) return [];
    return [...result.projects].sort((a, b) => {
      // Explicit (non-auto) projects first
      if (a.isAuto !== b.isAuto) return a.isAuto ? 1 : -1;
      // Then by most recent activity
      return b.lastActive - a.lastActive;
    });
  }, [result]);

  const filtered = useMemo<HermesProject[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((project) => {
      if (
        project.label.toLowerCase().includes(q) ||
        project.path.toLowerCase().includes(q)
      )
        return true;
      return project.repos.some(
        (repo) =>
          repo.label.toLowerCase().includes(q) ||
          repo.path.toLowerCase().includes(q),
      );
    });
  }, [sorted, query]);

  const toggleProject = (id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const choose = async (path: string) => {
    if (applying) return;
    setApplying(path);
    setApplyError(null);
    try {
      await onSelect(path);
      onClose();
    } catch (cause) {
      setApplyError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setApplying(null);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-sheet model-picker"
        role="dialog"
        aria-label="Set project"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-handle" />
        <div className="modal-header">
          <h2>Set project</h2>
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
            placeholder="Search projects or paths…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="model-picker-body">
          {error ? (
            <div className="screen-error">{error}</div>
          ) : result === null ? (
            <Spinner />
          ) : filtered.length === 0 ? (
            <div className="empty-state">
              <p className="empty-title">No projects found</p>
              <p className="empty-hint">
                {query
                  ? "Try a different search."
                  : "Start a conversation in a project directory and it will appear here."}
              </p>
            </div>
          ) : (
            filtered.map((project) => {
              const isCollapsed = !query && collapsed.has(project.id);
              const isActive =
                currentCwd !== null &&
                (currentCwd === project.path ||
                  currentCwd.startsWith(project.path + "/"));
              return (
                <div key={project.id} className="provider-group">
                  <button
                    type="button"
                    className="provider-head"
                    onClick={() => toggleProject(project.id)}
                    aria-expanded={!isCollapsed}
                  >
                    <span className="provider-name">{project.label}</span>
                    {isActive ? (
                      <span className="chip subtle">current</span>
                    ) : null}
                    {project.isAuto ? (
                      <span className="chip subtle">auto</span>
                    ) : null}
                    <span className="provider-count">
                      {project.sessionCount} session
                      {project.sessionCount === 1 ? "" : "s"}
                    </span>
                    <span className="provider-chevron">
                      {isCollapsed ? "▸" : "▾"}
                    </span>
                  </button>
                  <div className="provider-path">{project.path}</div>
                  {!isCollapsed ? (
                    <div className="provider-models">
                      {/* "Open here" row — pins the project root as the cwd. */}
                      <button
                        type="button"
                        className={`model-row${isActive ? " active" : ""}`}
                        onClick={() => choose(project.path)}
                        disabled={Boolean(applying)}
                      >
                        <span className="model-name">Open {project.label}</span>
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
                        ) : applying === project.path ? (
                          <span className="voice-spinner" />
                        ) : null}
                      </button>
                      {/* Individual repo lanes — pin a specific worktree/branch. */}
                      {project.repos
                        .filter(
                          (repo) =>
                            repo.path !== project.path &&
                            repo.path !== currentCwd,
                        )
                        .map((repo) => (
                          <button
                            key={repo.id}
                            type="button"
                            className={`model-row${currentCwd === repo.path ? " active" : ""}`}
                            onClick={() => choose(repo.path)}
                            disabled={Boolean(applying)}
                          >
                            <span className="model-name">
                              {repo.lanes.length > 1
                                ? `${repo.label}`
                                : repo.label}
                            </span>
                            <span className="provider-count">
                              {repo.sessionCount}
                            </span>
                          </button>
                        ))}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
        {applyError ? (
          <div className="model-picker-error">{applyError}</div>
        ) : null}
      </div>
    </div>
  );
}

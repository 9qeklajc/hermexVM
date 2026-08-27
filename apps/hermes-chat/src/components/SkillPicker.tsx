import { useCallback, useEffect, useMemo, useState } from "react";
import type { HermesSkill } from "../lib/api";
import { Spinner } from "./ui";

/**
 * A bottom-sheet modal listing every skill installed for the current agent
 * profile, grouped by category. Tapping a skill calls `onSelect` with the
 * skill name + description — the parent inserts a prompt hint into the
 * composer so the user can ask a targeted question without guessing what the
 * agent can do.
 *
 * Mirrors the ModelPicker / ProjectPicker pattern: the parent passes a `load`
 * fn that calls the bridge, and an `onSelect` callback.
 */
export function SkillPicker({
  load,
  onSelect,
  onClose,
}: {
  /** Load the skills payload from the bridge. */
  load: () => Promise<{ skills: HermesSkill[] }>;
  /** Called with the chosen skill. */
  onSelect: (skill: HermesSkill) => void;
  onClose: () => void;
}) {
  const [skills, setSkills] = useState<HermesSkill[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Collapsed categories. By default all categories are expanded — skills are
  // small enough. Searching auto-expands all groups.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const reload = useCallback(() => {
    setError(null);
    load()
      .then((payload) => setSkills(payload.skills ?? []))
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
  }, [load]);

  useEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    reload();
  }, [reload]);

  // Group skills by category, preserving the sort order from the bridge.
  const grouped = useMemo(() => {
    if (!skills) return [] as Array<{ category: string; items: HermesSkill[] }>;
    const q = query.trim().toLowerCase();
    const filtered = q
      ? skills.filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            s.description.toLowerCase().includes(q) ||
            s.category.toLowerCase().includes(q),
        )
      : skills;
    const map = new Map<string, HermesSkill[]>();
    for (const skill of filtered) {
      const arr = map.get(skill.category);
      if (arr) arr.push(skill);
      else map.set(skill.category, [skill]);
    }
    return [...map.entries()].map(([category, items]) => ({
      category,
      items,
    }));
  }, [skills, query]);

  const toggleCategory = (category: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  };

  const choose = (skill: HermesSkill) => {
    onSelect(skill);
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-sheet model-picker"
        role="dialog"
        aria-label="Skills"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-handle" />
        <div className="modal-header">
          <h2>Skills</h2>
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
            placeholder="Search skills…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="model-picker-body">
          {error ? (
            <div className="screen-error">{error}</div>
          ) : skills === null ? (
            <Spinner />
          ) : grouped.length === 0 ? (
            <div className="empty-state">
              <p className="empty-title">No skills found</p>
              <p className="empty-hint">
                {query
                  ? "Try a different search."
                  : "No skills are installed on this Hermes profile."}
              </p>
            </div>
          ) : (
            grouped.map(({ category, items }) => {
              const isCollapsed = !query && collapsed.has(category);
              return (
                <div key={category} className="provider-group">
                  <button
                    type="button"
                    className="provider-head"
                    onClick={() => toggleCategory(category)}
                    aria-expanded={!isCollapsed}
                  >
                    <span className="provider-name">{category}</span>
                    <span className="provider-count">
                      {items.length} skill{items.length === 1 ? "" : "s"}
                    </span>
                    <span className="provider-chevron">
                      {isCollapsed ? "▸" : "▾"}
                    </span>
                  </button>
                  {!isCollapsed ? (
                    <div className="provider-models">
                      {items.map((skill) => (
                        <button
                          key={skill.name}
                          type="button"
                          className="skill-row"
                          onClick={() => choose(skill)}
                        >
                          <div className="skill-row-main">
                            <span className="skill-name">{skill.name}</span>
                            {skill.description ? (
                              <span className="skill-desc">
                                {skill.description}
                              </span>
                            ) : null}
                          </div>
                          <svg
                            className="skill-arrow"
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="m9 18 6-6-6-6" />
                          </svg>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

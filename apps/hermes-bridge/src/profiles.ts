import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import type { HermesAgentProfile, HermesSkill } from "@contexcgi/protocol";

const SOUL_EXCERPT_CHARS = 280;

// Directories under <home>/profiles/ that are not user profiles: "default" is
// the reserved alias for the root HERMES_HOME (hermes bootstrap can leave an
// empty stub behind) and "pairing" is a per-platform pairing store.
const RESERVED_PROFILE_NAMES = new Set(["default", "pairing"]);

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null;

function readYaml(path: string): Rec {
  try {
    const parsed = parseYaml(readFileSync(path, "utf8")) as unknown;
    return isRec(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** The profile's configured default model, e.g. "claude-opus-4-8". */
function readModel(home: string): string | undefined {
  const config = readYaml(join(home, "config.yaml"));
  const model = config.model;
  if (typeof model === "string" && model.trim()) return model.trim();
  if (
    isRec(model) &&
    typeof model.default === "string" &&
    model.default.trim()
  ) {
    return model.default.trim();
  }
  return undefined;
}

function readDescription(home: string): string {
  const meta = readYaml(join(home, "profile.yaml"));
  return typeof meta.description === "string" ? meta.description.trim() : "";
}

/** First paragraph of SOUL.md, trimmed to a card-sized excerpt. */
function readSoulExcerpt(home: string): string | undefined {
  const soul = readText(join(home, "SOUL.md"));
  if (!soul) return undefined;
  const paragraph = soul
    .split(/\n\s*\n/)
    .map((block) =>
      block
        .replace(/^#+\s*/gm, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .find(Boolean);
  if (!paragraph) return undefined;
  return paragraph.length > SOUL_EXCERPT_CHARS
    ? `${paragraph.slice(0, SOUL_EXCERPT_CHARS)}…`
    : paragraph;
}

function displayName(id: string): string {
  if (id === "default") return "Hermes";
  return id.charAt(0).toUpperCase() + id.slice(1);
}

function profileEntry(
  id: string,
  home: string,
  isDefault: boolean,
): HermesAgentProfile {
  return {
    id,
    name: displayName(id),
    description: readDescription(home),
    soulExcerpt: readSoulExcerpt(home),
    model: readModel(home),
    isDefault,
  };
}

/**
 * Enumerate the Hermes agent profiles on this host, mirroring
 * `hermes profile list`: the root HERMES_HOME is the "default" profile and
 * every directory under `<home>/profiles/` is a named one.
 */
export function listHermesAgents(hermesHome: string): HermesAgentProfile[] {
  const agents: HermesAgentProfile[] = [
    profileEntry("default", hermesHome, true),
  ];
  const profilesDir = join(hermesHome, "profiles");
  let names: string[] = [];
  try {
    names = readdirSync(profilesDir).filter((name) => {
      if (name.startsWith(".") || RESERVED_PROFILE_NAMES.has(name))
        return false;
      const home = join(profilesDir, name);
      try {
        if (!statSync(home).isDirectory()) return false;
      } catch {
        return false;
      }
      // Only dirs that actually look like a profile — skips stray bookkeeping
      // directories hermes tools drop under profiles/.
      return ["config.yaml", "state.db", "SOUL.md"].some((marker) =>
        existsSync(join(home, marker)),
      );
    });
  } catch {
    // no named profiles — default only
  }
  for (const name of names.sort()) {
    agents.push(profileEntry(name, join(profilesDir, name), false));
  }
  return agents;
}

/** Map an agent id to the tui_gateway `profile` param (default → omitted). */
export function profileParam(agentId: string): string | undefined {
  return agentId === "default" ? undefined : agentId;
}

/** True when the agent id names a profile that exists on this host. */
export function agentExists(hermesHome: string, agentId: string): boolean {
  return listHermesAgents(hermesHome).some((agent) => agent.id === agentId);
}

// ---------------------------------------------------------------------------
// Skill discovery — scan a profile's skills/ directory for SKILL.md files,
// parse YAML frontmatter for name + description, and infer the category from
// the path relative to the skills root. Mirrors what the Hermes TUI shows in
// its skill picker, but without a gateway round-trip: the bridge reads disk.
// ---------------------------------------------------------------------------

const MAX_SKILL_DESCRIPTION_LENGTH = 300;

/** Directories that never contain skills (mirrors skills_tool._EXCLUDED_SKILL_DIRS). */
const EXCLUDED_SKILL_DIRS = new Set([".git", "node_modules", "__pycache__"]);

/** Reserved directory names under skills/ that are not categories. */
const RESERVED_SKILL_DIRS = new Set([
  "assets",
  "references",
  "templates",
  "scripts",
]);

type ParsedFrontmatter = {
  name?: string;
  description?: string;
  category?: string;
};

/**
 * Parse YAML frontmatter from the first chunk of a SKILL.md file. Stops at the
 * closing `---` line; if no frontmatter is found, returns an empty object.
 */
function parseSkillFrontmatter(content: string): ParsedFrontmatter {
  const m = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!m || m[1] === undefined) return {};
  try {
    const parsed = parseYaml(m[1]) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const rec = parsed as Record<string, unknown>;
      return {
        name: typeof rec.name === "string" ? rec.name : undefined,
        description:
          typeof rec.description === "string" ? rec.description : undefined,
        category: typeof rec.category === "string" ? rec.category : undefined,
      };
    }
  } catch {
    // malformed frontmatter — fall through to empty
  }
  return {};
}

/**
 * Infer the skill category from the path relative to the skills root.
 *
 * - A top-level skill (e.g. `skills/nostr-projects/SKILL.md`) → "general".
 * - A nested skill (e.g. `skills/github/github-pr-workflow/SKILL.md`) → "github".
 * - If the SKILL.md frontmatter declares `category`, that wins.
 * - Reserved directory names (assets, references, templates, scripts) are skipped.
 */
function inferCategory(relPath: string): string {
  const parts = relPath.split("/");
  // parts: [ "skills", <maybe-category>, ..., "SKILL.md" ]
  // The category is the first segment after "skills" when there's nesting
  // beyond a single level. A direct child (skills/<name>/SKILL.md) has no
  // category dir → "general".
  if (parts.length <= 3) return "general";
  const candidate = parts[1];
  if (!candidate || RESERVED_SKILL_DIRS.has(candidate)) return "general";
  return candidate;
}

/**
 * Recursively walk a directory and yield every SKILL.md path found.
 * Skips excluded directory names. Bounded by a max depth to avoid pathological
 * directory structures.
 */
function* findSkillMdFiles(dir: string, depth = 0): Generator<string> {
  if (depth > 8) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (EXCLUDED_SKILL_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      yield* findSkillMdFiles(full, depth + 1);
    } else if (entry === "SKILL.md" || entry === "skill.md") {
      yield full;
    }
  }
}

/**
 * Scan a profile's skills/ directory and return one HermesSkill per SKILL.md
 * found, with name, description, category, and path relative to the skills root.
 *
 * If the skills directory doesn't exist, returns an empty array — skills are
 * optional, and a profile without any is still valid.
 */
export function listProfileSkills(profileHome: string): HermesSkill[] {
  const skillsDir = join(profileHome, "skills");
  if (!existsSync(skillsDir)) return [];

  const skills: HermesSkill[] = [];
  const seenNames = new Set<string>();

  for (const skillMd of findSkillMdFiles(skillsDir)) {
    // Skip files inside excluded dirs (double-check via path parts).
    if (skillMd.split("/").some((part) => EXCLUDED_SKILL_DIRS.has(part)))
      continue;

    let content: string;
    try {
      // Read only the first 4KB — frontmatter is always at the top.
      content = readFileSync(skillMd, "utf8").slice(0, 4000);
    } catch {
      continue;
    }

    const fm = parseSkillFrontmatter(content);
    const parts = skillMd.split("/");
    const dirName = parts[parts.length - 2] ?? "";
    const name = (fm.name || dirName).slice(0, 64);
    if (!name || seenNames.has(name)) continue;
    seenNames.add(name);

    let description = fm.description ?? "";
    // If no frontmatter description, try the first non-empty, non-heading line
    // of the body (same fallback as _find_all_skills in skills_tool.py).
    if (!description) {
      const body = content.replace(/^---[\s\S]*?\n---\s*\n/, "");
      for (const line of body.split("\n")) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) {
          description = trimmed;
          break;
        }
      }
    }
    if (description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
      description = `${description.slice(0, MAX_SKILL_DESCRIPTION_LENGTH - 3)}...`;
    }

    const relPath = relative(skillsDir, skillMd);
    const category = fm.category || inferCategory(`skills/${relPath}`);

    skills.push({ name, description, category, path: relPath });
  }

  // Stable ordering: category then name (matches _sort_skills in skills_tool).
  skills.sort((a, b) =>
    a.category === b.category
      ? a.name.localeCompare(b.name)
      : a.category.localeCompare(b.category),
  );
  return skills;
}

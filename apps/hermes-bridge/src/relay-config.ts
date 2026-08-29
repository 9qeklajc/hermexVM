import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseRelayUrls } from "./config.js";

export type HotRelayPool = {
  getRelayUrls(): string[];
  ensureRelayUrls(relays: string[]): Promise<string[]>;
};

export async function loadPersistedRelays(path: string): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      !Array.isArray(parsed) ||
      !parsed.every((item) => typeof item === "string")
    ) {
      throw new Error("persisted relay list must be an array of strings");
    }
    return parsed.length ? parseRelayUrls(parsed.join(",")) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function mergeRelayUrls(...sets: string[][]): string[] {
  return [...new Set(sets.flat())];
}

export class RelayConfiguration {
  constructor(
    private readonly pool: HotRelayPool,
    private readonly path: string,
  ) {}

  async ensure(
    relays: string[],
  ): Promise<{ relays: string[]; added: string[] }> {
    const requested = parseRelayUrls(relays.join(","));
    const added = await this.pool.ensureRelayUrls(requested);
    const current = this.pool.getRelayUrls();
    if (added.length) await this.persist(current);
    return { relays: current, added };
  }

  private async persist(relays: string[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(relays, null, 2)}\n`, "utf8");
    await rename(temporary, this.path);
  }
}

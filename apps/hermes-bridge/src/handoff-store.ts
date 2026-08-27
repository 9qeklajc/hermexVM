import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import type {
  HermesHandoffPreview,
  HermesHandoffRecord,
  HermesHandoffStatus,
} from "@contexcgi/protocol";

export type StoredHandoffArtifact = {
  schemaVersion: 1;
  artifactId: string;
  createdAt: string;
  preview: HermesHandoffPreview;
};

const TERMINAL = new Set<HermesHandoffStatus>([
  "completed",
  "failed",
  "interrupted",
]);

function safeId(value: string, name: string): string {
  if (!/^[a-zA-Z0-9-]{8,128}$/.test(value)) {
    throw new Error(`invalid ${name}`);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPreview(value: unknown): value is HermesHandoffPreview {
  if (!isObject(value)) return false;
  return (
    value.schemaVersion === 1 &&
    isObject(value.source) &&
    typeof value.source.agentId === "string" &&
    typeof value.source.chatId === "string" &&
    isObject(value.destination) &&
    (value.destination.kind === "new" ||
      value.destination.kind === "existing") &&
    (value.mode === "selected" || value.mode === "full") &&
    Array.isArray(value.messages) &&
    typeof value.instructions === "string" &&
    typeof value.envelope === "string" &&
    typeof value.byteCount === "number" &&
    typeof value.previewDigest === "string"
  );
}

function isArtifact(value: unknown): value is StoredHandoffArtifact {
  return (
    isObject(value) &&
    value.schemaVersion === 1 &&
    typeof value.artifactId === "string" &&
    typeof value.createdAt === "string" &&
    isPreview(value.preview) &&
    value.artifactId === value.preview.previewDigest
  );
}

function isRecord(value: unknown): value is HermesHandoffRecord {
  if (!isObject(value)) return false;
  return (
    value.schemaVersion === 1 &&
    typeof value.requestId === "string" &&
    typeof value.artifactId === "string" &&
    isObject(value.source) &&
    typeof value.source.agentId === "string" &&
    typeof value.source.chatId === "string" &&
    isObject(value.destination) &&
    (value.destination.kind === "new" ||
      value.destination.kind === "existing") &&
    (value.mode === "selected" || value.mode === "full") &&
    typeof value.messageCount === "number" &&
    typeof value.instructions === "string" &&
    typeof value.previewDigest === "string" &&
    ["accepted", "running", "completed", "failed", "interrupted"].includes(
      String(value.status),
    ) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

export class HandoffStore {
  private readonly handoffsDir: string;
  private readonly artifactsDir: string;
  private readonly deliveriesDir: string;

  constructor(readonly root: string) {
    this.handoffsDir = join(root, "handoffs");
    this.artifactsDir = join(this.handoffsDir, "artifacts");
    this.deliveriesDir = join(this.handoffsDir, "deliveries");
  }

  async init(): Promise<void> {
    await mkdir(this.artifactsDir, { recursive: true, mode: 0o700 });
    await mkdir(this.deliveriesDir, { recursive: true, mode: 0o700 });
    await Promise.all(
      [this.root, this.handoffsDir, this.artifactsDir, this.deliveriesDir].map(
        (path) => chmod(path, 0o700),
      ),
    );
  }

  /** Recover after a process crash before any tools become callable. */
  async recoverStartup(
    reason = "bridge restarted before the handoff reached a terminal result",
  ): Promise<number> {
    await this.init();
    const names = await readdir(this.deliveriesDir);
    await Promise.all(
      names
        .filter((name) => name.startsWith(".") && name.endsWith(".lock"))
        .map((name) =>
          unlink(join(this.deliveriesDir, name)).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
            },
          ),
        ),
    );

    const records = await this.listAll();
    let recovered = 0;
    for (const record of records) {
      if (TERMINAL.has(record.status)) continue;
      await this.put({
        ...record,
        status: "interrupted",
        error: reason,
        updatedAt: new Date().toISOString(),
      });
      recovered += 1;
    }
    return recovered;
  }

  async createArtifact(
    preview: HermesHandoffPreview,
  ): Promise<StoredHandoffArtifact> {
    await this.init();
    if (!isPreview(preview)) throw new Error("invalid handoff preview schema");
    const artifact: StoredHandoffArtifact = {
      schemaVersion: 1,
      artifactId: preview.previewDigest,
      createdAt: new Date().toISOString(),
      preview,
    };
    const path = join(
      this.artifactsDir,
      `${safeId(artifact.artifactId, "artifact id")}.json`,
    );
    const temp = join(
      this.artifactsDir,
      `.${artifact.artifactId}.${randomUUID()}.tmp`,
    );
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      // link() publishes the fully-fsynced temp inode and fails if the
      // content-addressed target already exists; it never exposes a partial file.
      await link(temp, path);
      await this.syncDirectory(this.artifactsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await this.getArtifact(artifact.artifactId);
      if (
        !existing ||
        JSON.stringify(existing.preview) !== JSON.stringify(preview)
      ) {
        throw new Error(
          "handoff artifact collision or corrupt existing artifact",
        );
      }
      return existing;
    } finally {
      await unlink(temp).catch(() => undefined);
    }
    return artifact;
  }

  async getArtifact(artifactId: string): Promise<StoredHandoffArtifact | null> {
    await this.init();
    const path = join(
      this.artifactsDir,
      `${safeId(artifactId, "artifact id")}.json`,
    );
    try {
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!isArtifact(value)) {
        await this.quarantine(path);
        return null;
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (error instanceof SyntaxError) {
        await this.quarantine(path);
        return null;
      }
      throw error;
    }
  }

  async claim(requestId: string): Promise<boolean> {
    await this.init();
    const lock = join(
      this.deliveriesDir,
      `.${safeId(requestId, "request id")}.lock`,
    );
    const handle = await open(lock, "wx", 0o600).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST") return null;
        throw error;
      },
    );
    if (!handle) return false;
    await handle.close();
    return true;
  }

  async releaseClaim(requestId: string): Promise<void> {
    await unlink(
      join(this.deliveriesDir, `.${safeId(requestId, "request id")}.lock`),
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  async get(requestId: string): Promise<HermesHandoffRecord | null> {
    await this.init();
    const path = join(
      this.deliveriesDir,
      `${safeId(requestId, "request id")}.json`,
    );
    try {
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!isRecord(value) || value.requestId !== requestId) {
        await this.quarantine(path);
        return null;
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (error instanceof SyntaxError) {
        await this.quarantine(path);
        return null;
      }
      throw error;
    }
  }

  async put(record: HermesHandoffRecord): Promise<void> {
    await this.init();
    if (!isRecord(record)) throw new Error("invalid handoff record schema");
    safeId(record.requestId, "request id");
    const path = join(this.deliveriesDir, `${record.requestId}.json`);
    const temp = join(
      this.deliveriesDir,
      `.${record.requestId}.${randomUUID()}.tmp`,
    );
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temp, path);
      await this.syncDirectory(this.deliveriesDir);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  }

  async list(
    filter: {
      agentId?: string;
      chatId?: string;
      limit?: number;
    } = {},
  ): Promise<HermesHandoffRecord[]> {
    const records = await this.listAll();
    return records
      .filter((record) => {
        if (
          filter.agentId &&
          record.source.agentId !== filter.agentId &&
          record.destination.agentId !== filter.agentId
        )
          return false;
        if (
          filter.chatId &&
          record.source.chatId !== filter.chatId &&
          record.destinationChatId !== filter.chatId &&
          !(
            record.destination.kind === "existing" &&
            record.destination.chatId === filter.chatId
          )
        )
          return false;
        return true;
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.min(filter.limit ?? 100, 200));
  }

  private async listAll(): Promise<HermesHandoffRecord[]> {
    await this.init();
    const names = (await readdir(this.deliveriesDir)).filter((name) =>
      name.endsWith(".json"),
    );
    const records: HermesHandoffRecord[] = [];
    for (const name of names) {
      const path = join(this.deliveriesDir, name);
      try {
        const value: unknown = JSON.parse(await readFile(path, "utf8"));
        if (!isRecord(value)) {
          await this.quarantine(path);
          continue;
        }
        records.push(value);
      } catch (error) {
        if (error instanceof SyntaxError) {
          await this.quarantine(path);
          continue;
        }
        throw error;
      }
    }
    return records;
  }

  private async syncDirectory(path: string): Promise<void> {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async quarantine(path: string): Promise<void> {
    await rename(path, `${path}.corrupt-${Date.now()}-${randomUUID()}`).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
  }
}

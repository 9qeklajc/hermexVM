import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  type ReadStream,
  type Stats,
} from "node:fs";
import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import type {
  BinaryPlatform,
  FileTransferCategory,
  FileTransferDescriptor,
  FileTransferUploadId,
  ListFileTransfersRequest,
} from "@contexcgi/protocol";

export type FileTransferManifest = Partial<
  Pick<
    FileTransferDescriptor,
    | "name"
    | "version"
    | "platform"
    | "architecture"
    | "channel"
    | "mimeType"
    | "category"
    | "description"
    | "metadata"
  >
>;

type PendingUpload = {
  uploadId: FileTransferUploadId;
  filename: string;
  sizeBytes: number;
  sha256: string;
  manifest: FileTransferManifest;
  chunkSizeBytes: number;
  totalChunks: number;
  received: Set<number>;
  expiresAt: number;
  uploadedBy?: string;
};

type PersistedPendingUpload = Omit<PendingUpload, "received">;

type CompletedUpload = {
  uploadId: FileTransferUploadId;
  file: FileTransferDescriptor;
  uploadedBy?: string;
  expiresAt: number;
};

const DEFAULT_VERSION = "0.0.0";
const UPLOAD_STAGING_DIRECTORY = ".contexcgi-uploads";
const FILE_EXTENSIONS = new Set([
  ".apk",
  ".aab",
  ".ipa",
  ".dmg",
  ".exe",
  ".msi",
  ".deb",
  ".rpm",
  ".appimage",
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
  ".pdf",
  ".md",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".epub",
  ".mobi",
  ".azw3",
  ".mp4",
  ".mkv",
  ".avi",
  ".mov",
  ".webm",
  ".mp3",
  ".flac",
  ".wav",
  ".ogg",
  ".opus",
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".bmp",
  ".webp",
  ".svg",
  ".bin",
  ".iso",
  ".img",
  ".tar.gz",
  // --- common text / code formats so files-bridge users can download them ---
  ".txt",
  ".log",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".csv",
  ".tsv",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".cs",
  ".php",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".sql",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".less",
  ".xml",
  ".diff",
  ".patch",
  ".tex",
  ".rtf",
  ".ipynb",
]);

/** Dotfiles (no real extension) that are useful to browse/download. */
const ACCEPTED_DOTFILES = new Set([
  ".gitignore",
  ".dockerignore",
  ".npmignore",
  ".env",
  ".editorconfig",
  ".eslintrc",
  ".prettierrc",
  ".gitattributes",
]);

/** Per-upload size guard (default 256 MiB). */
export const DEFAULT_MAX_FILE_BYTES = 256 * 1024 * 1024;
/**
 * Per-upload chunk ceiling. Keep the complete tools/call JSON within the
 * legacy voice uploader's proven-safe 24 KB frame size; @contextvm/sdk 0.11.x
 * encrypts the whole request before CEP-22 fragmentation and otherwise fails
 * locally before the chunk reaches the bridge.
 */
export const DEFAULT_CHUNK_BYTES = 16 * 1024;
/** Uploads must be finalized within this window (default 15 min). */
export const DEFAULT_UPLOAD_TIMEOUT_MS = 15 * 60 * 1000;
/** Aggregate durable-upload guards prevent authorized clients from filling disk. */
export const DEFAULT_MAX_PENDING_UPLOADS = 32;
export const DEFAULT_MAX_STAGED_BYTES = 512 * 1024 * 1024;

export class FileTransferRegistry {
  private readonly root: string;
  private readonly maxFileBytes: number;
  private readonly chunkBytes: number;
  private readonly uploadTimeoutMs: number;
  private readonly maxPendingUploads: number;
  private readonly maxStagedBytes: number;
  private readonly acceptFilename: (filename: string) => boolean;
  private readonly pending = new Map<FileTransferUploadId, PendingUpload>();
  private readonly digestCache = new Map<
    string,
    {
      size: number;
      mtimeMs: number;
      ctimeMs: number;
      ino: number;
      sha256: string;
    }
  >();

  constructor(input: {
    root: string;
    maxFileBytes?: number;
    chunkBytes?: number;
    uploadTimeoutMs?: number;
    maxPendingUploads?: number;
    maxStagedBytes?: number;
    acceptFilename?: (filename: string) => boolean;
  }) {
    this.root = resolve(input.root);
    this.maxFileBytes = input.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.chunkBytes = input.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    this.uploadTimeoutMs = input.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
    this.maxPendingUploads =
      input.maxPendingUploads ?? DEFAULT_MAX_PENDING_UPLOADS;
    this.maxStagedBytes = input.maxStagedBytes ?? DEFAULT_MAX_STAGED_BYTES;
    this.acceptFilename = input.acceptFilename ?? isAcceptedFilename;
  }

  async list(
    input: ListFileTransfersRequest = {},
  ): Promise<FileTransferDescriptor[]> {
    await mkdir(this.root, { recursive: true });
    await this.evictExpiredUploads();
    const files = await this.findFiles(this.root);
    const descriptors = await Promise.all(
      files.map((file) => this.describeFile(file)),
    );
    return descriptors
      .filter((file) =>
        input.category ? file.category === input.category : true,
      )
      .filter((file) =>
        input.platform ? file.platform === input.platform : true,
      )
      .filter((file) =>
        input.architecture ? file.architecture === input.architecture : true,
      )
      .filter((file) => (input.channel ? file.channel === input.channel : true))
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, input.limit ?? Number.MAX_SAFE_INTEGER);
  }

  async get(id: string): Promise<FileTransferDescriptor | undefined> {
    const requestedPath = this.resolvePath(id);
    const path = await this.resolveExistingPath(id);
    if (!path) return undefined;
    const stats = await stat(path);
    if (!stats.isFile() || !this.acceptFilename(path)) return undefined;
    const requestedId = relative(this.root, requestedPath).split(sep).join("/");
    return this.describeFile(path, requestedId);
  }

  async readContentBase64(id: string): Promise<string | undefined> {
    const file = await this.get(id);
    if (!file) return undefined;
    const path = await this.resolveExistingPath(file.id);
    if (!path) return undefined;
    return readFile(path, "base64");
  }

  async readRangeBase64(input: {
    id: string;
    offsetBytes: number;
    lengthBytes: number;
  }): Promise<string | undefined> {
    const file = await this.get(input.id);
    if (!file) return undefined;
    if (input.offsetBytes < 0 || input.lengthBytes < 0) {
      throw new Error("Invalid file range");
    }
    if (input.offsetBytes > file.sizeBytes) {
      throw new Error("File range offset exceeds file size");
    }
    const path = await this.resolveExistingPath(file.id);
    if (!path) return undefined;
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(
        Math.min(input.lengthBytes, file.sizeBytes - input.offsetBytes),
      );
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.byteLength,
        input.offsetBytes,
      );
      return buffer.subarray(0, bytesRead).toString("base64");
    } finally {
      await handle.close();
    }
  }

  async createReadStream(
    id: string,
    highWaterMark: number,
  ): Promise<ReadStream> {
    const file = await this.get(id);
    if (!file) throw new Error(`File not found: ${id}`);
    const path = await this.resolveExistingPath(file.id);
    if (!path) throw new Error(`File not found: ${id}`);
    return createReadStream(path, { highWaterMark });
  }

  async delete(id: string): Promise<boolean> {
    const file = await this.get(id);
    if (!file) return false;
    const path = await this.resolveExistingPath(file.id);
    if (!path) return false;
    await rm(path, { force: true });
    await rm(`${path}.json`, { force: true });
    return true;
  }

  /** Begin a durable resumable upload and reserve its staging directory. */
  async initUpload(
    input: {
      requestId?: string;
      filename: string;
      sizeBytes: number;
      sha256: string;
      manifest?: FileTransferManifest;
    },
    uploadedBy?: string,
  ): Promise<{
    uploadId: FileTransferUploadId;
    chunkSizeBytes: number;
    totalChunks: number;
    expiresAt: number;
  }> {
    if (input.sizeBytes <= 0) throw new Error("File size must be positive");
    if (input.sizeBytes > this.maxFileBytes) {
      throw new Error(
        `File size ${input.sizeBytes} exceeds limit ${this.maxFileBytes}`,
      );
    }
    if (!input.sha256 || !/^[0-9a-fA-F]{64}$/.test(input.sha256)) {
      throw new Error("sha256 must be a 64-char hex string");
    }
    await this.evictExpiredUploads();
    if (input.requestId && !isUploadId(input.requestId)) {
      throw new Error("requestId must be a UUID");
    }
    if (input.requestId) {
      const existing = await this.loadPending(input.requestId);
      if (existing) {
        this.assertOwner(existing, uploadedBy);
        if (
          existing.filename !== input.filename ||
          existing.sizeBytes !== input.sizeBytes ||
          existing.sha256 !== input.sha256.toLowerCase()
        ) {
          throw new Error(
            "Upload requestId was reused with different file metadata",
          );
        }
        return this.publicUploadState(existing);
      }
      const completed = await this.loadCompleted(input.requestId);
      if (completed) {
        this.assertCompletedOwner(completed, uploadedBy);
        throw new Error("Upload request already completed");
      }
    }
    const reservedBytes = [...this.pending.values()].reduce(
      (total, upload) => total + upload.sizeBytes,
      0,
    );
    if (this.pending.size >= this.maxPendingUploads) {
      throw new Error("Too many pending uploads");
    }
    if (reservedBytes + input.sizeBytes > this.maxStagedBytes) {
      throw new Error("Pending uploads exceed the staged-byte limit");
    }
    const uploadId = (input.requestId ?? randomUUID()) as FileTransferUploadId;
    const pending: PendingUpload = {
      uploadId,
      filename: input.filename,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256.toLowerCase(),
      manifest: input.manifest ?? {},
      chunkSizeBytes: this.chunkBytes,
      totalChunks: Math.ceil(input.sizeBytes / this.chunkBytes),
      received: new Set(),
      expiresAt: Date.now() + this.uploadTimeoutMs,
      uploadedBy,
    };
    await mkdir(this.uploadDirectory(uploadId), { recursive: true });
    await this.persistPending(pending);
    this.pending.set(uploadId, pending);
    return this.publicUploadState(pending);
  }

  async uploadStatus(uploadId: FileTransferUploadId, clientKey?: string) {
    const pending = await this.requirePending(uploadId, clientKey);
    return {
      ...this.publicUploadState(pending),
      filename: pending.filename,
      sizeBytes: pending.sizeBytes,
      sha256: pending.sha256,
      receivedChunks: pending.received.size,
      receivedChunkIndices: [...pending.received].sort((a, b) => a - b),
    };
  }

  /** Persist one bounded chunk. Duplicate indices are idempotent. */
  async uploadChunk(
    input: {
      uploadId: FileTransferUploadId;
      index: number;
      totalChunks: number;
      contentBase64: string;
    },
    clientKey?: string,
  ): Promise<{ receivedChunks: number; totalChunks: number }> {
    const pending = await this.requirePending(input.uploadId, clientKey);
    if (pending.totalChunks !== input.totalChunks) {
      throw new Error("totalChunks mismatch");
    }
    if (input.index < 0 || input.index >= pending.totalChunks) {
      throw new Error(`Chunk index out of range: ${input.index}`);
    }
    if (pending.received.has(input.index)) {
      return {
        receivedChunks: pending.received.size,
        totalChunks: pending.totalChunks,
      };
    }
    const bytes = Buffer.from(input.contentBase64, "base64");
    const expectedLen = Math.min(
      pending.chunkSizeBytes,
      pending.sizeBytes - input.index * pending.chunkSizeBytes,
    );
    if (bytes.byteLength !== expectedLen) {
      throw new Error(
        `Chunk ${input.index} size ${bytes.byteLength} != expected ${expectedLen}`,
      );
    }
    const path = this.chunkPath(input.uploadId, input.index);
    const tmpPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmpPath, bytes);
    try {
      // link() publishes without replacing an already accepted concurrent
      // duplicate. The chunk becomes visible atomically on every platform.
      await link(tmpPath, path);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    } finally {
      await rm(tmpPath, { force: true });
    }
    pending.received.add(input.index);
    return {
      receivedChunks: pending.received.size,
      totalChunks: pending.totalChunks,
    };
  }

  /** Stream staged chunks to disk, verify sha256, and atomically publish. */
  async finalizeUpload(
    uploadId: FileTransferUploadId,
    clientKey?: string,
  ): Promise<FileTransferDescriptor> {
    const pending = await this.loadPending(uploadId);
    if (!pending) {
      const completed = await this.loadCompleted(uploadId);
      if (!completed) throw new Error(`Upload not found: ${uploadId}`);
      this.assertCompletedOwner(completed, clientKey);
      return completed.file;
    }
    this.assertOwner(pending, clientKey);
    if (pending.received.size !== pending.totalChunks) {
      throw new Error(
        `Upload incomplete: ${pending.received.size}/${pending.totalChunks} chunks`,
      );
    }
    await mkdir(this.root, { recursive: true });
    const safeName = sanitizeFilename(pending.filename);
    const id = await uniqueId(this.root, safeName);
    const finalPath = this.resolvePath(id);
    const tmpPath = `${finalPath}.part.${uploadId}`;
    const stream = createWriteStream(tmpPath);
    const hash = createHash("sha256");
    let written = 0;
    try {
      for (let index = 0; index < pending.totalChunks; index++) {
        const bytes = await readFile(this.chunkPath(uploadId, index));
        hash.update(bytes);
        written += bytes.byteLength;
        await new Promise<void>((resolveWrite, reject) => {
          stream.write(bytes, (error) =>
            error ? reject(error) : resolveWrite(),
          );
        });
      }
      await new Promise<void>((resolveEnd, reject) => {
        stream.end((error?: Error | null) =>
          error ? reject(error) : resolveEnd(),
        );
      });
      const sha = hash.digest("hex");
      if (written !== pending.sizeBytes || sha !== pending.sha256) {
        await rm(tmpPath, { force: true });
        await this.cancelUpload(uploadId, clientKey);
        throw new Error(`Uploaded file checksum mismatch (got ${sha})`);
      }
      await rename(tmpPath, finalPath);
    } catch (error) {
      stream.destroy();
      await rm(tmpPath, { force: true });
      throw error;
    }
    const manifestWithUploader: FileTransferManifest = {
      ...pending.manifest,
      metadata: {
        ...(pending.manifest.metadata ?? {}),
        ...(pending.uploadedBy ? { uploadedBy: pending.uploadedBy } : {}),
        uploadId,
        absolutePath: finalPath,
      },
    };
    await writeFile(
      `${finalPath}.json`,
      JSON.stringify(manifestWithUploader, null, 2),
    );
    const file = await this.describeFile(finalPath);
    await this.persistCompleted({
      uploadId,
      file,
      uploadedBy: pending.uploadedBy,
      expiresAt: Date.now() + this.uploadTimeoutMs,
    });
    await this.discardUpload(uploadId);
    return file;
  }

  async cancelUpload(
    uploadId: FileTransferUploadId,
    clientKey?: string,
  ): Promise<void> {
    // Preserve the historical idempotent no-op for unknown/legacy ids.
    if (!isUploadId(uploadId)) return;
    const pending = await this.loadPending(uploadId);
    if (pending) this.assertOwner(pending, clientKey);
    await this.discardUpload(uploadId);
  }

  async pendingUploadCount(): Promise<number> {
    await this.evictExpiredUploads();
    await this.loadAllPending();
    return this.pending.size;
  }

  private publicUploadState(pending: PendingUpload) {
    return {
      uploadId: pending.uploadId,
      chunkSizeBytes: pending.chunkSizeBytes,
      totalChunks: pending.totalChunks,
      expiresAt: pending.expiresAt,
    };
  }

  private uploadRoot(): string {
    return join(this.root, UPLOAD_STAGING_DIRECTORY);
  }

  private uploadDirectory(uploadId: string): string {
    if (!isUploadId(uploadId)) throw new Error("Invalid upload id");
    return join(this.uploadRoot(), uploadId);
  }

  private chunkPath(uploadId: string, index: number): string {
    return join(this.uploadDirectory(uploadId), `${index}.chunk`);
  }

  private completedPath(uploadId: string): string {
    if (!isUploadId(uploadId)) throw new Error("Invalid upload id");
    return join(this.uploadRoot(), "completed", `${uploadId}.json`);
  }

  private async persistPending(pending: PendingUpload): Promise<void> {
    const persisted: PersistedPendingUpload = {
      uploadId: pending.uploadId,
      filename: pending.filename,
      sizeBytes: pending.sizeBytes,
      sha256: pending.sha256,
      manifest: pending.manifest,
      chunkSizeBytes: pending.chunkSizeBytes,
      totalChunks: pending.totalChunks,
      expiresAt: pending.expiresAt,
      uploadedBy: pending.uploadedBy,
    };
    const path = join(this.uploadDirectory(pending.uploadId), "upload.json");
    await writeJsonAtomic(path, persisted);
  }

  private async persistCompleted(completed: CompletedUpload): Promise<void> {
    const path = this.completedPath(completed.uploadId);
    await mkdir(join(this.uploadRoot(), "completed"), { recursive: true });
    await writeJsonAtomic(path, completed);
  }

  private async loadCompleted(
    uploadId: string,
  ): Promise<CompletedUpload | undefined> {
    if (!isUploadId(uploadId)) return undefined;
    const path = this.completedPath(uploadId);
    const raw = await readFile(path, "utf8").catch((error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!raw) return undefined;
    try {
      const completed = JSON.parse(raw) as CompletedUpload;
      if (completed.expiresAt <= Date.now()) {
        await rm(path, { force: true });
        return undefined;
      }
      return completed;
    } catch {
      await rm(path, { force: true });
      return undefined;
    }
  }

  private async loadPending(
    uploadId: string,
  ): Promise<PendingUpload | undefined> {
    const cached = this.pending.get(uploadId);
    if (cached) {
      if (cached.expiresAt > Date.now()) return cached;
      await this.discardUpload(uploadId);
      return undefined;
    }
    const directory = this.uploadDirectory(uploadId);
    const raw = await readFile(join(directory, "upload.json"), "utf8").catch(
      (error: unknown) => {
        if (isNodeError(error) && error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (!raw) return undefined;
    let persisted: PersistedPendingUpload;
    try {
      persisted = JSON.parse(raw) as PersistedPendingUpload;
    } catch {
      await rm(directory, { recursive: true, force: true });
      return undefined;
    }
    const received = new Set(
      (await readdir(directory))
        .map((name) => /^(\d+)\.chunk$/.exec(name)?.[1])
        .filter((value): value is string => value !== undefined)
        .map(Number),
    );
    const pending: PendingUpload = { ...persisted, received };
    if (pending.expiresAt <= Date.now()) {
      await rm(directory, { recursive: true, force: true });
      return undefined;
    }
    this.pending.set(uploadId, pending);
    return pending;
  }

  private async requirePending(
    uploadId: string,
    clientKey?: string,
  ): Promise<PendingUpload> {
    const pending = await this.loadPending(uploadId);
    if (!pending) throw new Error(`Upload not found: ${uploadId}`);
    this.assertOwner(pending, clientKey);
    return pending;
  }

  private assertOwner(pending: PendingUpload, clientKey?: string): void {
    if (pending.uploadedBy && pending.uploadedBy !== clientKey) {
      throw new Error("Upload belongs to another client");
    }
  }

  private assertCompletedOwner(
    completed: CompletedUpload,
    clientKey?: string,
  ): void {
    if (completed.uploadedBy && completed.uploadedBy !== clientKey) {
      throw new Error("Upload belongs to another client");
    }
  }

  private async discardUpload(uploadId: string): Promise<void> {
    this.pending.delete(uploadId);
    await rm(this.uploadDirectory(uploadId), { recursive: true, force: true });
  }

  private async loadAllPending(): Promise<void> {
    const ids = await readdir(this.uploadRoot()).catch((error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    });
    await Promise.all(
      ids.map((id) => this.loadPending(id).catch(() => undefined)),
    );
  }

  private async evictExpiredUploads(): Promise<void> {
    await this.loadAllPending();
    const now = Date.now();
    await Promise.all(
      [...this.pending].map(async ([id, pending]) => {
        if (pending.expiresAt <= now) await this.discardUpload(id);
      }),
    );
    const completedDirectory = join(this.uploadRoot(), "completed");
    const completedNames = await readdir(completedDirectory).catch(
      (error: unknown) => {
        if (isNodeError(error) && error.code === "ENOENT") return [];
        throw error;
      },
    );
    await Promise.all(
      completedNames.map(async (name) => {
        const match = /^([0-9a-f-]{36})\.json$/i.exec(name);
        if (match?.[1]) await this.loadCompleted(match[1]);
      }),
    );
  }

  private async findFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = join(dir, entry.name);
        if (entryPath === this.uploadRoot()) return [];
        if (entry.isDirectory()) return this.findFiles(entryPath);
        if (entry.name.endsWith(".part")) return [];
        if (entry.name.endsWith(".json")) return [];
        if (!this.acceptFilename(entry.name)) return [];
        if (entry.isFile()) return [entryPath];
        // Never traverse or list symlinks. Direct lookups independently resolve
        // real paths and enforce root containment below.
        return [];
      }),
    );
    return nested.flat();
  }

  private async describeFile(
    path: string,
    idOverride?: string,
  ): Promise<FileTransferDescriptor> {
    const [stats, manifest] = await Promise.all([
      stat(path),
      readManifest(path),
    ]);
    const sha256 = await this.sha256ForFile(path, stats);
    const filename = basename(path);
    const id = idOverride ?? relative(this.root, path).split(sep).join("/");
    const platform = manifest.platform ?? inferPlatform(filename);
    const category = manifest.category ?? inferCategory(filename);
    return {
      id,
      name: manifest.name ?? filename.replace(extname(filename), ""),
      version: manifest.version ?? DEFAULT_VERSION,
      platform,
      architecture: manifest.architecture,
      channel: manifest.channel ?? "stable",
      filename,
      sizeBytes: stats.size,
      sha256,
      mimeType: manifest.mimeType ?? inferMimeType(filename),
      category,
      createdAt: (stats.birthtimeMs > 0
        ? stats.birthtime
        : stats.ctime
      ).toISOString(),
      updatedAt: stats.mtime.toISOString(),
      description: manifest.description,
      uploadedBy:
        typeof manifest.metadata?.uploadedBy === "string"
          ? (manifest.metadata.uploadedBy as string)
          : undefined,
      metadata: manifest.metadata,
    };
  }

  private async sha256ForFile(path: string, stats: Stats): Promise<string> {
    const cached = this.digestCache.get(path);
    if (
      cached?.size === stats.size &&
      cached.mtimeMs === stats.mtimeMs &&
      cached.ctimeMs === stats.ctimeMs &&
      cached.ino === stats.ino
    ) {
      return cached.sha256;
    }
    const sha256 = await sha256File(path);
    this.digestCache.set(path, {
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      ctimeMs: stats.ctimeMs,
      ino: stats.ino,
      sha256,
    });
    return sha256;
  }

  private resolvePath(id: string): string {
    if (!id || id.includes("\0")) throw new Error("Invalid file id");
    const path = resolve(this.root, id);
    if (path !== this.root && !path.startsWith(`${this.root}${sep}`)) {
      throw new Error("File id escapes root");
    }
    return path;
  }

  private async resolveExistingPath(id: string): Promise<string | undefined> {
    const candidate = this.resolvePath(id);
    const paths = await Promise.all([
      realpath(this.root),
      realpath(candidate),
    ]).catch((error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!paths) return undefined;
    const [realRoot, realCandidate] = paths;
    if (
      realCandidate !== realRoot &&
      !realCandidate.startsWith(`${realRoot}${sep}`)
    ) {
      throw new Error("File id resolves outside root");
    }
    return realCandidate;
  }
}

async function readManifest(path: string): Promise<FileTransferManifest> {
  const raw = await readFile(`${path}.json`, "utf8").catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!raw) return {};
  return JSON.parse(raw) as FileTransferManifest;
}

function isAcceptedFilename(filename: string): boolean {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".tar.gz")) return true;
  if (ACCEPTED_DOTFILES.has(basename(lower))) return true;
  return FILE_EXTENSIONS.has(extname(lower));
}

function inferPlatform(filename: string): BinaryPlatform {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".apk") || lower.endsWith(".aab")) return "android";
  if (lower.endsWith(".dmg") || lower.endsWith(".ipa")) return "darwin";
  if (lower.endsWith(".exe") || lower.endsWith(".msi")) return "windows";
  if (
    lower.endsWith(".deb") ||
    lower.endsWith(".rpm") ||
    lower.endsWith(".appimage")
  ) {
    return "linux";
  }
  return "unknown";
}

function inferCategory(filename: string): FileTransferCategory {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".apk") || lower.endsWith(".aab")) return "apk";
  if (
    lower.endsWith(".exe") ||
    lower.endsWith(".msi") ||
    lower.endsWith(".dmg") ||
    lower.endsWith(".deb") ||
    lower.endsWith(".rpm") ||
    lower.endsWith(".appimage") ||
    lower.endsWith(".bin") ||
    lower.endsWith(".iso") ||
    lower.endsWith(".img")
  ) {
    return "binary";
  }
  if (
    lower.endsWith(".zip") ||
    lower.endsWith(".tar") ||
    lower.endsWith(".gz") ||
    lower.endsWith(".bz2") ||
    lower.endsWith(".xz") ||
    lower.endsWith(".7z") ||
    lower.endsWith(".rar") ||
    lower.endsWith(".tar.gz")
  ) {
    return "archive";
  }
  if (
    lower.endsWith(".pdf") ||
    lower.endsWith(".md") ||
    lower.endsWith(".doc") ||
    lower.endsWith(".docx") ||
    lower.endsWith(".xls") ||
    lower.endsWith(".xlsx") ||
    lower.endsWith(".ppt") ||
    lower.endsWith(".pptx") ||
    lower.endsWith(".epub") ||
    lower.endsWith(".mobi") ||
    lower.endsWith(".azw3")
  ) {
    return "document";
  }
  if (
    lower.endsWith(".mp4") ||
    lower.endsWith(".mkv") ||
    lower.endsWith(".avi") ||
    lower.endsWith(".mov") ||
    lower.endsWith(".webm")
  ) {
    return "video";
  }
  if (
    lower.endsWith(".mp3") ||
    lower.endsWith(".flac") ||
    lower.endsWith(".wav") ||
    lower.endsWith(".ogg") ||
    lower.endsWith(".opus")
  ) {
    return "audio";
  }
  if (
    lower.endsWith(".jpg") ||
    lower.endsWith(".jpeg") ||
    lower.endsWith(".png") ||
    lower.endsWith(".gif") ||
    lower.endsWith(".bmp") ||
    lower.endsWith(".webp") ||
    lower.endsWith(".svg")
  ) {
    return "image";
  }
  return "other";
}

function inferMimeType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".apk") || lower.endsWith(".aab")) {
    return "application/vnd.android.package-archive";
  }
  if (lower.endsWith(".zip")) return "application/zip";
  if (lower.endsWith(".tar.gz")) return "application/gzip";
  if (lower.endsWith(".gz")) return "application/gzip";
  if (lower.endsWith(".dmg")) return "application/x-apple-diskimage";
  if (lower.endsWith(".exe"))
    return "application/vnd.microsoft.portable-executable";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

function isUploadId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmpPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, JSON.stringify(value));
  try {
    await rename(tmpPath, path);
  } finally {
    await rm(tmpPath, { force: true });
  }
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function sanitizeFilename(filename: string): string {
  const trimmed = filename.replace(/[\\/]+/g, "_").trim();
  const base = trimmed || "upload";
  return base;
}

async function uniqueId(root: string, filename: string): Promise<string> {
  const candidate = filename;
  const path = join(root, candidate);
  const exists = await stat(path).then(
    () => true,
    () => false,
  );
  if (!exists) return candidate;
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : "";
  for (let i = 1; i < 1000; i++) {
    const alt = `${stem}-${Date.now()}-${i}${ext}`;
    if (
      !(await stat(join(root, alt)).then(
        () => true,
        () => false,
      ))
    ) {
      return alt;
    }
  }
  return `${stem}-${randomUUID()}${ext}`;
}

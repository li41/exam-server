import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { once } from "node:events";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type {
  FileMetadata,
  UploadProgress,
  UploadSession,
} from "@server-foundation/api-contracts";
import {
  ChecksumMismatchError,
  ConflictError,
  NotFoundError,
  PayloadTooLargeError,
  UploadExpiredError,
} from "@server-foundation/domain";
import type {
  BlobStorage,
  FileAccessScope,
  FileMetadataStore,
  UploadInput,
} from "@server-foundation/domain";

type SessionState = "pending" | "completed" | "cancelled";

type SessionDocument = {
  sessionId: string;
  fileId: string;
  ownerId: string;
  tenantId: string;
  originalName: string;
  displayName: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  expiresAt: string;
  createdAt: string;
  bytesReceived: number;
  state: SessionState;
};

export type LocalFileStorageOptions = {
  maxBytes?: number;
  sessionTtlSeconds?: number;
  allowedMimeTypes?: ReadonlySet<string>;
};

const defaultMaxBytes = 50 * 1024 * 1024;
const defaultSessionTtlSeconds = 60 * 60;

const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

const isPrivileged = (scope: FileAccessScope): boolean =>
  scope.roles.includes("owner") || scope.roles.includes("admin");

const assertSafeName = (name: string): void => {
  if (!name.trim() || /[\0/\\]/.test(name)) {
    throw new ConflictError("File names must not contain path separators.");
  }
};

const assertAccess = (
  ownerId: string,
  tenantId: string,
  scope: FileAccessScope,
): void => {
  if (
    scope.tenantId !== tenantId ||
    (scope.userId !== ownerId && !isPrivileged(scope))
  ) {
    throw new NotFoundError("file", "requested");
  }
};

const parseJson = <T>(value: string, description: string): T => {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`Invalid ${description} document.`);
  }
};

export class LocalFileStorage implements BlobStorage {
  private readonly root: string;
  private readonly maxBytes: number;
  private readonly sessionTtlSeconds: number;
  private readonly allowedMimeTypes?: ReadonlySet<string>;
  private readonly metadataStore?: FileMetadataStore;
  private directoriesReady: Promise<void> | undefined;
  private cleanupInFlight: Promise<number> | undefined;

  constructor(
    root: string,
    options: LocalFileStorageOptions = {},
    metadataStore?: FileMetadataStore,
  ) {
    this.root = resolve(root);
    this.maxBytes = options.maxBytes ?? defaultMaxBytes;
    this.sessionTtlSeconds =
      options.sessionTtlSeconds ?? defaultSessionTtlSeconds;
    this.allowedMimeTypes = options.allowedMimeTypes;
    this.metadataStore = metadataStore;
  }

  async initialize(): Promise<void> {
    await this.ensureDirectories();
  }

  async initiateUpload(input: UploadInput): Promise<UploadSession> {
    await this.ensureDirectories();
    if (input.sizeBytes > this.maxBytes) throw new PayloadTooLargeError();
    assertSafeName(input.originalName);
    assertSafeName(input.displayName);
    if (!/^[\w.+-]+\/[\w.+-]+$/.test(input.mimeType)) {
      throw new ConflictError("The MIME type is invalid.");
    }
    if (this.allowedMimeTypes && !this.allowedMimeTypes.has(input.mimeType)) {
      throw new ConflictError("The MIME type is not allowed.");
    }

    const now = new Date();
    const session: SessionDocument = {
      sessionId: randomUUID(),
      fileId: randomUUID(),
      ownerId: input.ownerId,
      tenantId: input.tenantId,
      originalName: input.originalName,
      displayName: input.displayName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      checksum: input.checksum.toLowerCase(),
      expiresAt: new Date(
        now.getTime() + this.sessionTtlSeconds * 1000,
      ).toISOString(),
      createdAt: now.toISOString(),
      bytesReceived: 0,
      state: "pending",
    };
    const pendingMetadata: FileMetadata = {
      fileId: session.fileId,
      ownerId: session.ownerId,
      tenantId: session.tenantId,
      originalName: session.originalName,
      displayName: session.displayName,
      mimeType: session.mimeType,
      sizeBytes: session.sizeBytes,
      checksum: session.checksum,
      status: "pending",
      createdAt: session.createdAt,
      deletedAt: null,
    };
    await this.metadataStore?.createPending(pendingMetadata);
    try {
      await this.writeJson(this.sessionPath(session.sessionId), session);
    } catch (error) {
      if (this.metadataStore) {
        await this.metadataStore
          .markDeleted(session.fileId)
          .catch(() => undefined);
      }
      throw error;
    }
    return {
      sessionId: session.sessionId,
      fileId: session.fileId,
      expiresAt: session.expiresAt,
      resumable: false,
    };
  }

  async writeUpload(
    sessionId: string,
    body: ReadableStream<Uint8Array>,
    scope: FileAccessScope,
  ): Promise<UploadProgress> {
    const session = await this.readSession(sessionId);
    this.assertSessionAccess(session, scope);
    if (session.state === "completed") {
      return { bytesReceived: session.bytesReceived, complete: true };
    }
    if (session.state === "cancelled")
      throw new NotFoundError("upload", sessionId);
    this.assertNotExpired(session);

    const temporaryPath = this.temporaryPath(session.sessionId);
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });

    const output = createWriteStream(temporaryPath, {
      flags: "w",
      mode: 0o600,
    });
    let bytesReceived = 0;
    try {
      const input = Readable.fromWeb(
        body as unknown as NodeReadableStream<any>,
      );
      for await (const chunk of input) {
        const buffer = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk as Uint8Array);
        bytesReceived += buffer.byteLength;
        if (
          bytesReceived > session.sizeBytes ||
          bytesReceived > this.maxBytes
        ) {
          throw new PayloadTooLargeError();
        }
        if (!output.write(buffer)) await once(output, "drain");
      }
      output.end();
      await finished(output);
    } catch (error) {
      output.destroy();
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }

    session.bytesReceived = bytesReceived;
    await this.writeJson(this.sessionPath(session.sessionId), session);
    return {
      bytesReceived,
      complete: bytesReceived === session.sizeBytes,
    };
  }

  async completeUpload(
    sessionId: string,
    scope: FileAccessScope,
  ): Promise<FileMetadata> {
    const session = await this.readSession(sessionId);
    this.assertSessionAccess(session, scope);
    if (session.state === "completed") return this.readMetadata(session.fileId);
    if (session.state === "cancelled")
      throw new NotFoundError("upload", sessionId);
    this.assertNotExpired(session);
    if (session.bytesReceived !== session.sizeBytes) {
      throw new ConflictError("The upload is incomplete.");
    }

    const temporaryPath = this.temporaryPath(session.sessionId);
    const actualChecksum = await this.checksum(temporaryPath);
    if (actualChecksum !== session.checksum) {
      session.bytesReceived = 0;
      await this.writeJson(this.sessionPath(session.sessionId), session);
      await unlink(temporaryPath).catch(() => undefined);
      throw new ChecksumMismatchError();
    }

    const metadata: FileMetadata = {
      fileId: session.fileId,
      ownerId: session.ownerId,
      tenantId: session.tenantId,
      originalName: session.originalName,
      displayName: session.displayName,
      mimeType: session.mimeType,
      sizeBytes: session.sizeBytes,
      checksum: session.checksum,
      status: "ready",
      createdAt: session.createdAt,
      deletedAt: null,
    };
    await rename(temporaryPath, this.filePath(session.fileId));
    if (this.metadataStore) {
      await this.metadataStore.markReady(session.fileId);
    } else {
      await this.writeJson(this.metadataPath(session.fileId), metadata);
    }
    session.state = "completed";
    await this.writeJson(this.sessionPath(session.sessionId), session);
    return metadata;
  }

  async cancelUpload(sessionId: string, scope: FileAccessScope): Promise<void> {
    const session = await this.readSession(sessionId);
    this.assertSessionAccess(session, scope);
    if (session.state === "completed") return;
    await unlink(this.temporaryPath(session.sessionId)).catch(
      (error: unknown) => {
        if (!isMissing(error)) throw error;
      },
    );
    await this.metadataStore?.markDeleted(session.fileId);
    session.state = "cancelled";
    session.bytesReceived = 0;
    await this.writeJson(this.sessionPath(session.sessionId), session);
  }

  async getMetadata(
    fileId: string,
    scope: FileAccessScope,
  ): Promise<FileMetadata> {
    const metadata = await this.readMetadataIfExists(fileId);
    if (!metadata) throw new NotFoundError("file", "requested");
    assertAccess(metadata.ownerId, metadata.tenantId, scope);
    return metadata;
  }

  async getDownload(
    fileId: string,
    scope: FileAccessScope,
  ): Promise<{
    stream: ReadableStream<Uint8Array>;
    contentLength: number;
    mimeType: string;
    fileName: string;
  }> {
    const metadata = await this.readMetadata(fileId);
    assertAccess(metadata.ownerId, metadata.tenantId, scope);
    if (metadata.status !== "ready") throw new NotFoundError("file", fileId);
    const file = createReadStream(this.filePath(fileId));
    return {
      stream: Readable.toWeb(file) as unknown as ReadableStream<Uint8Array>,
      contentLength: metadata.sizeBytes,
      mimeType: metadata.mimeType,
      fileName: metadata.displayName,
    };
  }

  async delete(fileId: string, scope: FileAccessScope): Promise<void> {
    const metadata = await this.readMetadata(fileId);
    assertAccess(metadata.ownerId, metadata.tenantId, scope);
    if (metadata.status === "deleted") return;
    await unlink(this.filePath(fileId)).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
    if (this.metadataStore) {
      await this.metadataStore.markDeleted(fileId);
    } else {
      metadata.status = "deleted";
      metadata.deletedAt = new Date().toISOString();
      await this.writeJson(this.metadataPath(fileId), metadata);
    }
  }

  async cleanupExpired(now = new Date()): Promise<number> {
    if (this.cleanupInFlight) return this.cleanupInFlight;
    const operation = this.runCleanupExpired(now);
    this.cleanupInFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.cleanupInFlight === operation) this.cleanupInFlight = undefined;
    }
  }

  private async runCleanupExpired(now: Date): Promise<number> {
    await this.ensureDirectories();
    let cleaned = 0;
    const errors: Error[] = [];
    for (const name of await readdir(this.sessionsDirectory())) {
      if (!name.endsWith(".json")) continue;
      let session: SessionDocument;
      try {
        session = parseJson<SessionDocument>(
          await readFile(join(this.sessionsDirectory(), name), "utf8"),
          "upload session",
        );
      } catch (error) {
        if (isMissing(error)) continue;
        errors.push(
          new Error(`Could not read upload session ${name}.`, { cause: error }),
        );
        continue;
      }
      if (session.state !== "pending" || new Date(session.expiresAt) > now) {
        continue;
      }
      try {
        cleaned += await this.cleanupExpiredSession(session);
      } catch (error) {
        errors.push(
          new Error(`Could not clean up upload session ${session.sessionId}.`, {
            cause: error,
          }),
        );
      }
    }
    try {
      cleaned += await this.cleanupOrphanedTemporaryFiles(now);
      cleaned += await this.cleanupDeletedFiles();
    } catch (error) {
      errors.push(
        new Error("Could not clean up orphaned file content.", {
          cause: error,
        }),
      );
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `File cleanup completed with ${errors.length} error(s).`,
      );
    }
    return cleaned;
  }

  private async cleanupExpiredSession(
    session: SessionDocument,
  ): Promise<number> {
    const expiresAt = new Date(session.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) {
      throw new Error(
        `Upload session ${session.sessionId} has an invalid expiry.`,
      );
    }

    const metadata = await this.readMetadataIfExists(session.fileId);
    const finalPath = this.filePath(session.fileId);
    const finalFileExists = await this.pathExists(finalPath);

    if (finalFileExists && metadata?.status !== "deleted") {
      const actualChecksum = await this.checksum(finalPath);
      if (actualChecksum === session.checksum) {
        if (metadata?.status === "pending") {
          await this.metadataStore?.markReady(session.fileId);
          if (!this.metadataStore) {
            metadata.status = "ready";
            await this.writeJson(this.metadataPath(session.fileId), metadata);
          }
        } else if (!metadata && this.metadataStore) {
          throw new Error(
            `File metadata for ${session.fileId} is missing while content exists.`,
          );
        } else if (!metadata) {
          await this.writeJson(
            this.metadataPath(session.fileId),
            this.metadataFromSession(session, "ready"),
          );
        }

        session.state = "completed";
        session.bytesReceived = session.sizeBytes;
        await this.writeJson(this.sessionPath(session.sessionId), session);
        await this.removeTemporaryFile(session.sessionId);
        await this.removeSession(session.sessionId);
        return 1;
      }
    }

    if (finalFileExists) await this.removeFileIfPresent(finalPath);
    await this.removeTemporaryFile(session.sessionId);
    await this.markMetadataDeleted(metadata, session.fileId);
    session.state = "cancelled";
    session.bytesReceived = 0;
    await this.writeJson(this.sessionPath(session.sessionId), session);
    await this.removeSession(session.sessionId);
    return 1;
  }

  private async cleanupOrphanedTemporaryFiles(now: Date): Promise<number> {
    const cutoff = now.getTime() - this.sessionTtlSeconds * 1000;
    let cleaned = 0;
    for (const name of await readdir(join(this.root, "uploads"))) {
      if (!name.endsWith(".part")) continue;
      const path = join(this.root, "uploads", name);
      const sessionId = name.slice(0, -".part".length);
      let sessionText: string;
      try {
        sessionText = await readFile(this.sessionPath(sessionId), "utf8");
      } catch (error) {
        if (!isMissing(error)) throw error;
        const fileStat = await stat(path);
        if (fileStat.mtimeMs > cutoff) continue;
        await this.removeFileIfPresent(path);
        cleaned += 1;
        continue;
      }

      const session = parseJson<SessionDocument>(sessionText, "upload session");
      if (session.state === "pending") continue;
      await this.removeFileIfPresent(path);
      cleaned += 1;
    }
    return cleaned;
  }

  private async cleanupDeletedFiles(): Promise<number> {
    let cleaned = 0;
    for (const name of await readdir(join(this.root, "files"))) {
      const metadata = await this.readMetadataIfExists(name);
      if (metadata?.status !== "deleted") continue;
      await this.removeFileIfPresent(this.filePath(name));
      cleaned += 1;
    }
    return cleaned;
  }

  private async ensureDirectories(): Promise<void> {
    this.directoriesReady ??= Promise.all(
      ["sessions", "uploads", "files", "metadata"].map((directory) =>
        mkdir(join(this.root, directory), { recursive: true, mode: 0o700 }),
      ),
    ).then(() => undefined);
    await this.directoriesReady;
  }

  private sessionsDirectory(): string {
    return join(this.root, "sessions");
  }

  private sessionPath(sessionId: string): string {
    return join(this.sessionsDirectory(), `${sessionId}.json`);
  }

  private temporaryPath(sessionId: string): string {
    return join(this.root, "uploads", `${sessionId}.part`);
  }

  private filePath(fileId: string): string {
    return join(this.root, "files", fileId);
  }

  private metadataPath(fileId: string): string {
    return join(this.root, "metadata", `${fileId}.json`);
  }

  private async readSession(sessionId: string): Promise<SessionDocument> {
    await this.ensureDirectories();
    try {
      return parseJson<SessionDocument>(
        await readFile(this.sessionPath(sessionId), "utf8"),
        "upload session",
      );
    } catch (error) {
      if (isMissing(error)) throw new NotFoundError("upload", sessionId);
      throw error;
    }
  }

  private async readMetadata(fileId: string): Promise<FileMetadata> {
    await this.ensureDirectories();
    const metadata = await this.readMetadataIfExists(fileId);
    if (metadata) return metadata;
    throw new NotFoundError("file", fileId);
  }

  private async readMetadataIfExists(
    fileId: string,
  ): Promise<FileMetadata | null> {
    await this.ensureDirectories();
    if (this.metadataStore) return this.metadataStore.get(fileId);
    try {
      return parseJson<FileMetadata>(
        await readFile(this.metadataPath(fileId), "utf8"),
        "file metadata",
      );
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  private metadataFromSession(
    session: SessionDocument,
    status: FileMetadata["status"],
  ): FileMetadata {
    return {
      fileId: session.fileId,
      ownerId: session.ownerId,
      tenantId: session.tenantId,
      originalName: session.originalName,
      displayName: session.displayName,
      mimeType: session.mimeType,
      sizeBytes: session.sizeBytes,
      checksum: session.checksum,
      status,
      createdAt: session.createdAt,
      deletedAt: null,
    };
  }

  private async markMetadataDeleted(
    metadata: FileMetadata | null,
    fileId: string,
  ): Promise<void> {
    if (!metadata || metadata.status === "deleted") return;
    if (this.metadataStore) {
      await this.metadataStore.markDeleted(fileId);
      return;
    }
    metadata.status = "deleted";
    metadata.deletedAt = new Date().toISOString();
    await this.writeJson(this.metadataPath(fileId), metadata);
  }

  private async removeTemporaryFile(sessionId: string): Promise<void> {
    await this.removeFileIfPresent(this.temporaryPath(sessionId));
  }

  private async removeSession(sessionId: string): Promise<void> {
    await this.removeFileIfPresent(this.sessionPath(sessionId));
  }

  private async removeFileIfPresent(path: string): Promise<void> {
    await unlink(path).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(value), {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  }

  private assertSessionAccess(
    session: SessionDocument,
    scope: FileAccessScope,
  ): void {
    assertAccess(session.ownerId, session.tenantId, scope);
  }

  private assertNotExpired(session: SessionDocument): void {
    if (new Date(session.expiresAt) <= new Date()) {
      throw new UploadExpiredError();
    }
  }

  private async checksum(path: string): Promise<string> {
    try {
      const hash = createHash("sha256");
      const input = createReadStream(path);
      for await (const chunk of input) hash.update(chunk);
      return hash.digest("hex");
    } catch (error) {
      if (isMissing(error))
        throw new ConflictError("The upload content is missing.");
      throw error;
    }
  }
}

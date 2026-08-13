import { createHash } from "node:crypto";
import { access, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileMetadata } from "@server-foundation/api-contracts";
import type { FileMetadataStore } from "@server-foundation/domain";
import { LocalFileStorage, startFileCleanupJob } from "../src/index.js";

const scope = {
  userId: "user-a",
  tenantId: "tenant-a",
  roles: ["member"],
};

const checksum = (content: Uint8Array): string =>
  createHash("sha256").update(content).digest("hex");

const inputFor = (content: Uint8Array) => ({
  ownerId: scope.userId,
  tenantId: scope.tenantId,
  originalName: "report.txt",
  displayName: "報告.txt",
  mimeType: "text/plain",
  sizeBytes: content.byteLength,
  checksum: checksum(content),
});

class MemoryMetadataStore implements FileMetadataStore {
  private readonly records = new Map<string, FileMetadata>();

  async createPending(metadata: FileMetadata): Promise<void> {
    this.records.set(metadata.fileId, { ...metadata });
  }

  async get(fileId: string): Promise<FileMetadata | null> {
    return this.records.get(fileId) ?? null;
  }

  async markReady(fileId: string): Promise<void> {
    const metadata = this.records.get(fileId);
    if (metadata) metadata.status = "ready";
  }

  async markDeleted(fileId: string): Promise<void> {
    const metadata = this.records.get(fileId);
    if (metadata) {
      metadata.status = "deleted";
      metadata.deletedAt = new Date().toISOString();
    }
  }
}

describe("LocalFileStorage", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true })),
    );
  });

  it("completes, downloads, and deletes a private file", async () => {
    const root = await mkdtemp(join(tmpdir(), "server-foundation-files-"));
    roots.push(root);
    const storage = new LocalFileStorage(root);
    const content = new TextEncoder().encode("private content");
    const session = await storage.initiateUpload(inputFor(content));

    await expect(
      storage.writeUpload(
        session.sessionId,
        new Response(content).body!,
        scope,
      ),
    ).resolves.toEqual({ bytesReceived: content.byteLength, complete: true });
    const metadata = await storage.completeUpload(session.sessionId, scope);
    expect(metadata).toMatchObject({
      fileId: session.fileId,
      ownerId: "user-a",
      tenantId: "tenant-a",
      status: "ready",
    });

    const download = await storage.getDownload(session.fileId, scope);
    await expect(new Response(download.stream).text()).resolves.toBe(
      "private content",
    );
    await expect(
      storage.getDownload(session.fileId, {
        userId: "user-b",
        tenantId: "tenant-b",
        roles: ["member"],
      }),
    ).rejects.toMatchObject({ code: "not_found" });

    await storage.delete(session.fileId, scope);
    await expect(
      storage.getDownload(session.fileId, scope),
    ).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("rejects a bad checksum and allows retrying the pending session", async () => {
    const root = await mkdtemp(join(tmpdir(), "server-foundation-files-"));
    roots.push(root);
    const storage = new LocalFileStorage(root);
    const content = new TextEncoder().encode("expected content");
    const session = await storage.initiateUpload(inputFor(content));

    await storage.writeUpload(
      session.sessionId,
      new Response(new TextEncoder().encode("wrong content!!!")).body!,
      scope,
    );
    await expect(
      storage.completeUpload(session.sessionId, scope),
    ).rejects.toMatchObject({ code: "checksum_mismatch" });

    await storage.writeUpload(
      session.sessionId,
      new Response(content).body!,
      scope,
    );
    await expect(
      storage.completeUpload(session.sessionId, scope),
    ).resolves.toMatchObject({ status: "ready", checksum: checksum(content) });
  });

  it("enforces the configured size and expiry boundaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "server-foundation-files-"));
    roots.push(root);
    const content = new TextEncoder().encode("too large");
    const storage = new LocalFileStorage(root, { maxBytes: 2 });
    await expect(
      storage.initiateUpload(inputFor(content)),
    ).rejects.toMatchObject({
      code: "payload_too_large",
    });

    const expiring = new LocalFileStorage(root, { sessionTtlSeconds: 0 });
    const session = await expiring.initiateUpload(
      inputFor(new Uint8Array([1])),
    );
    await expect(
      expiring.writeUpload(
        session.sessionId,
        new Response(new Uint8Array([1])).body!,
        scope,
      ),
    ).rejects.toMatchObject({ code: "upload_expired" });
  });

  it("uses the supplied metadata store instead of filesystem metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "server-foundation-files-"));
    roots.push(root);
    const metadataStore = new MemoryMetadataStore();
    const storage = new LocalFileStorage(root, {}, metadataStore);
    const content = new TextEncoder().encode("database metadata");
    const session = await storage.initiateUpload(inputFor(content));

    await storage.writeUpload(
      session.sessionId,
      new Response(content).body!,
      scope,
    );
    await storage.completeUpload(session.sessionId, scope);
    await expect(metadataStore.get(session.fileId)).resolves.toMatchObject({
      status: "ready",
    });
  });

  it("cleans expired sessions and marks their metadata deleted", async () => {
    const root = await mkdtemp(join(tmpdir(), "server-foundation-files-"));
    roots.push(root);
    const metadataStore = new MemoryMetadataStore();
    const storage = new LocalFileStorage(
      root,
      { sessionTtlSeconds: 60 },
      metadataStore,
    );
    const content = new TextEncoder().encode("abandoned upload");
    const session = await storage.initiateUpload(inputFor(content));
    await storage.writeUpload(
      session.sessionId,
      new Response(content).body!,
      scope,
    );

    await expect(
      storage.cleanupExpired(new Date(Date.now() + 61_000)),
    ).resolves.toBe(1);
    await expect(metadataStore.get(session.fileId)).resolves.toMatchObject({
      status: "deleted",
    });
    await expect(
      access(join(root, "uploads", `${session.sessionId}.part`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      storage.cleanupExpired(new Date(Date.now() + 61_000)),
    ).resolves.toBe(0);
  });

  it("repairs a finalized file when cleanup finds a pending session", async () => {
    const root = await mkdtemp(join(tmpdir(), "server-foundation-files-"));
    roots.push(root);
    const metadataStore = new MemoryMetadataStore();
    const storage = new LocalFileStorage(
      root,
      { sessionTtlSeconds: 60 },
      metadataStore,
    );
    const content = new TextEncoder().encode("finalized before session state");
    const session = await storage.initiateUpload(inputFor(content));
    await writeFile(join(root, "files", session.fileId), content, {
      mode: 0o600,
    });

    await expect(
      storage.cleanupExpired(new Date(Date.now() + 61_000)),
    ).resolves.toBe(1);
    await expect(metadataStore.get(session.fileId)).resolves.toMatchObject({
      status: "ready",
    });
    const download = await storage.getDownload(session.fileId, scope);
    await expect(new Response(download.stream).text()).resolves.toBe(
      "finalized before session state",
    );
  });

  it("removes old temporary files without a session document", async () => {
    const root = await mkdtemp(join(tmpdir(), "server-foundation-files-"));
    roots.push(root);
    const storage = new LocalFileStorage(root, { sessionTtlSeconds: 60 });
    await storage.initialize();
    const orphanPath = join(root, "uploads", "orphan-session.part");
    await writeFile(orphanPath, "orphan", { mode: 0o600 });
    const old = new Date(Date.now() - 61_000);
    await utimes(orphanPath, old, old);

    await expect(storage.cleanupExpired()).resolves.toBe(1);
    await expect(access(orphanPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("runs cleanup immediately and stops future scheduled runs", async () => {
    vi.useFakeTimers();
    try {
      const cleanupExpired = vi.fn().mockResolvedValue(0);
      const job = startFileCleanupJob({ cleanupExpired }, { intervalMs: 100 });
      await vi.advanceTimersByTimeAsync(0);
      expect(cleanupExpired).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(100);
      expect(cleanupExpired).toHaveBeenCalledTimes(2);

      await job.stop();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(cleanupExpired).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MySqlFileMetadataStore,
  createMySqlPool,
  runMigrations,
} from "@server-foundation/mysql-adapter";
import { LocalFileStorage } from "@server-foundation/local-fs-storage";
import { createInMemoryItemRepository } from "@server-foundation/testing";
import { createApp } from "../src/app.js";

const connectionString = process.env.MYSQL_TEST_URL;
const suite = connectionString ? describe : describe.skip;

suite("files API with MySQL metadata", () => {
  const pool = createMySqlPool(connectionString as string);
  const metadataStore = new MySqlFileMetadataStore(pool);
  let root: string;
  let storage: LocalFileStorage;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    await runMigrations(pool);
    await pool.execute("DELETE FROM files");
    root = await mkdtemp(join(tmpdir(), "server-foundation-api-files-db-"));
    storage = new LocalFileStorage(root, {}, metadataStore);
    app = createApp({
      itemRepository: createInMemoryItemRepository(),
      blobStorage: storage,
      allowUnauthenticatedItems: true,
    });
  });

  afterAll(async () => {
    await pool.end();
    await rm(root, { recursive: true });
  });

  it("keeps content private while metadata transitions in MySQL", async () => {
    const content = new TextEncoder().encode("database-backed metadata");
    const checksum = createHash("sha256").update(content).digest("hex");
    const sessionResponse = await app.request("/api/files/upload-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        originalName: "db.txt",
        displayName: "資料.txt",
        mimeType: "text/plain",
        sizeBytes: content.byteLength,
        checksum,
      }),
    });
    expect(sessionResponse.status).toBe(201);
    const session = await sessionResponse.json();

    await app.request(
      `/api/files/upload-sessions/${session.sessionId}/content`,
      {
        method: "PUT",
        body: content,
      },
    );
    const completeResponse = await app.request(
      `/api/files/upload-sessions/${session.sessionId}/complete`,
      { method: "POST" },
    );
    expect(completeResponse.status).toBe(201);
    const metadata = await completeResponse.json();
    await expect(metadataStore.get(metadata.fileId)).resolves.toMatchObject({
      status: "ready",
      tenantId: "local-development-tenant",
    });

    const downloadResponse = await app.request(
      `/api/files/${metadata.fileId}/download`,
    );
    await expect(downloadResponse.text()).resolves.toBe(
      "database-backed metadata",
    );

    expect(
      (
        await app.request(`/api/files/${metadata.fileId}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    await expect(metadataStore.get(metadata.fileId)).resolves.toMatchObject({
      status: "deleted",
    });
  });

  it("cleans an expired upload session and its MySQL metadata", async () => {
    const content = new TextEncoder().encode("abandoned database upload");
    const checksum = createHash("sha256").update(content).digest("hex");
    const sessionResponse = await app.request("/api/files/upload-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        originalName: "abandoned.txt",
        displayName: "中斷.txt",
        mimeType: "text/plain",
        sizeBytes: content.byteLength,
        checksum,
      }),
    });
    expect(sessionResponse.status).toBe(201);
    const session = await sessionResponse.json();

    const writeResponse = await app.request(
      `/api/files/upload-sessions/${session.sessionId}/content`,
      {
        method: "PUT",
        body: content,
      },
    );
    expect(writeResponse.status).toBe(200);

    await expect(metadataStore.get(session.fileId)).resolves.toMatchObject({
      status: "pending",
    });
    await expect(
      storage.cleanupExpired(new Date(Date.now() + 4 * 60 * 60 * 1000)),
    ).resolves.toBe(1);
    await expect(metadataStore.get(session.fileId)).resolves.toMatchObject({
      status: "deleted",
    });
  });
});

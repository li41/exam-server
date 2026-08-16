import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FileMetadata } from "@server-foundation/api-contracts";
import {
  createMySqlPool,
  MySqlFileMetadataStore,
  runMigrations,
} from "../src/index.js";

const connectionString = process.env.MYSQL_TEST_URL;
if (!connectionString) {
  throw new Error("MYSQL_TEST_URL is required for the MySQL integration test.");
}

const pool = createMySqlPool(connectionString);
const store = new MySqlFileMetadataStore(pool);
const fileId = "file-metadata-integration";

describe("MySqlFileMetadataStore", () => {
  beforeAll(async () => {
    await runMigrations(pool);
    await pool.execute("DELETE FROM files WHERE file_id = ?", [fileId]);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("tracks pending, ready, and deleted metadata states", async () => {
    const metadata: FileMetadata = {
      fileId,
      ownerId: "owner-integration",
      tenantId: "tenant-integration",
      originalName: "report.txt",
      displayName: "報告.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
      checksum: "a".repeat(64),
      status: "pending",
      createdAt: new Date().toISOString(),
      deletedAt: null,
    };

    await store.createPending(metadata);
    await expect(store.get(metadata.fileId)).resolves.toMatchObject({
      status: "pending",
      tenantId: metadata.tenantId,
    });

    await store.markReady(metadata.fileId);
    await expect(store.get(metadata.fileId)).resolves.toMatchObject({
      status: "ready",
      deletedAt: null,
    });

    await store.markDeleted(metadata.fileId);
    await expect(store.get(metadata.fileId)).resolves.toMatchObject({
      status: "deleted",
      deletedAt: expect.any(String),
    });
  });
});

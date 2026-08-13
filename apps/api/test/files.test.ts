import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApiErrorResponseSchema } from "@server-foundation/api-contracts";
import { LocalFileStorage } from "@server-foundation/local-fs-storage";
import { createInMemoryItemRepository } from "@server-foundation/testing";
import { createApp } from "../src/app.js";

describe("files API", () => {
  it("uploads, downloads, and deletes through the private storage port", async () => {
    const root = await mkdtemp(join(tmpdir(), "server-foundation-api-files-"));
    try {
      const storage = new LocalFileStorage(root);
      const app = createApp({
        itemRepository: createInMemoryItemRepository(),
        blobStorage: storage,
        allowUnauthenticatedItems: true,
      });
      const content = new TextEncoder().encode("API private file");
      const checksum = createHash("sha256").update(content).digest("hex");

      const sessionResponse = await app.request("/api/files/upload-sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          originalName: "note.txt",
          displayName: "筆記.txt",
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
          headers: { "content-type": "text/plain" },
          body: content,
        },
      );
      expect(writeResponse.status).toBe(200);
      expect(await writeResponse.json()).toMatchObject({
        bytesReceived: content.byteLength,
        complete: true,
      });

      const completeResponse = await app.request(
        `/api/files/upload-sessions/${session.sessionId}/complete`,
        { method: "POST" },
      );
      expect(completeResponse.status).toBe(201);
      const metadata = await completeResponse.json();

      const downloadResponse = await app.request(
        `/api/files/${metadata.fileId}/download`,
      );
      expect(downloadResponse.status).toBe(200);
      expect(downloadResponse.headers.get("accept-ranges")).toBe("none");
      await expect(downloadResponse.text()).resolves.toBe("API private file");

      const deleteResponse = await app.request(
        `/api/files/${metadata.fileId}`,
        {
          method: "DELETE",
        },
      );
      expect(deleteResponse.status).toBe(204);
      expect(
        (await app.request(`/api/files/${metadata.fileId}/download`)).status,
      ).toBe(404);
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it("returns checksum failures using the shared API error contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "server-foundation-api-files-"));
    try {
      const storage = new LocalFileStorage(root);
      const app = createApp({
        itemRepository: createInMemoryItemRepository(),
        blobStorage: storage,
        allowUnauthenticatedItems: true,
      });
      const content = new TextEncoder().encode("actual content");
      const wrongChecksum = createHash("sha256")
        .update("different content")
        .digest("hex");

      const sessionResponse = await app.request("/api/files/upload-sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          originalName: "note.txt",
          displayName: "note.txt",
          mimeType: "text/plain",
          sizeBytes: content.byteLength,
          checksum: wrongChecksum,
        }),
      });
      const session = await sessionResponse.json();

      const writeResponse = await app.request(
        `/api/files/upload-sessions/${session.sessionId}/content`,
        {
          method: "PUT",
          headers: { "content-type": "text/plain" },
          body: content,
        },
      );
      expect(writeResponse.status).toBe(200);

      const completeResponse = await app.request(
        `/api/files/upload-sessions/${session.sessionId}/complete`,
        { method: "POST" },
      );
      expect(completeResponse.status).toBe(422);
      expect(
        ApiErrorResponseSchema.parse(await completeResponse.json()),
      ).toMatchObject({
        error: { code: "checksum_mismatch" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

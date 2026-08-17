import { AffairDeletionService } from "@server-foundation/domain";
import {
  createInMemoryAffairRepository,
  createInMemoryItemRepository,
  InMemoryAffairDeletionRepository,
} from "@server-foundation/testing";
import { describe, expect, it } from "vitest";
import { mountAffairRoutes } from "../src/affair-routes.js";
import { createApp } from "../src/app.js";

const localTenantId = "local-development-tenant";
const affairId = "affair-delete-test";
const version = 3;

const createDeleteApp = () => {
  const deletionRepository = new InMemoryAffairDeletionRepository([
    { id: affairId, tenantId: localTenantId, version },
  ]);
  const app = createApp({
    itemRepository: createInMemoryItemRepository(),
    allowUnauthenticatedItems: true,
  });
  mountAffairRoutes(app, {
    repository: createInMemoryAffairRepository(),
    deletionRepository,
    allowUnauthenticated: true,
  });
  return { app, deletionRepository };
};

const deleteAffair = (app: ReturnType<typeof createDeleteApp>["app"]) =>
  app.request(`/api/v1/affairs/${affairId}?version=${version}`, {
    method: "DELETE",
  });

const blockerCases = [
  {
    kind: "schools" as const,
    count: 3,
    message: "此試務資料下有 3 所學校帳號，請先刪除學校帳號後再刪除",
  },
  {
    kind: "submissions" as const,
    count: 5,
    message:
      "此試務資料下有 5 筆填報資料，請先到各收集方式的「資料檢視」頁刪除後再刪除試務",
  },
  {
    kind: "receipts" as const,
    count: 2,
    message:
      "此試務資料下有 2 筆領據（含身分證與銀行帳號），請先到領據頁面刪除後再刪除試務",
  },
  {
    kind: "collections" as const,
    count: 4,
    message: "此試務資料下有 4 個收集方式，請先刪除收集方式後再刪除",
  },
] as const;

describe("affair delete rules", () => {
  for (const testCase of blockerCases) {
    it(`blocks on ${testCase.kind} with the PHP message`, async () => {
      const { app, deletionRepository } = createDeleteApp();
      deletionRepository.setBlocker(testCase.kind, testCase.count);

      const response = await deleteAffair(app);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          code: "validation_error",
          message: testCase.message,
        },
      });
      expect(deletionRepository.hasAffair(affairId, localTenantId)).toBe(true);
    });
  }

  it("returns only the first PHP-ordered blocker", async () => {
    const { app, deletionRepository } = createDeleteApp();
    deletionRepository.setBlocker("collections", 4);
    deletionRepository.setBlocker("receipts", 2);
    deletionRepository.setBlocker("submissions", 5);
    deletionRepository.setBlocker("schools", 3);

    const response = await deleteAffair(app);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        message: blockerCases[0].message,
      },
    });
  });

  it("deletes when all four blocker counts are zero", async () => {
    const { app, deletionRepository } = createDeleteApp();
    const response = await deleteAffair(app);

    expect(response.status).toBe(204);
    expect(deletionRepository.hasAffair(affairId, localTenantId)).toBe(false);
  });

  it("does not let another tenant delete the affair", async () => {
    const repository = new InMemoryAffairDeletionRepository([
      { id: affairId, tenantId: "tenant-a", version },
    ]);
    const service = new AffairDeletionService(repository);

    await expect(
      service.deleteAffair(affairId, version, {
        tenantId: "tenant-b",
        actorUserId: "user-b",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(repository.hasAffair(affairId, "tenant-a")).toBe(true);
  });
});

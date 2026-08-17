import {
  InMemoryAffairDeletionRepository,
  createInMemoryAffairRepository,
  createInMemoryItemRepository,
} from "@server-foundation/testing";
import { describe, expect, it } from "vitest";
import { mountAffairRoutes } from "../src/affair-routes.js";
import { createApp } from "../src/app.js";

const LOCAL_TENANT = "local-development-tenant";
const AFFAIR_ID = "65000000-0000-4000-8000-000000000001";

const createTestApp = (
  deletionRepository = new InMemoryAffairDeletionRepository([
    { id: AFFAIR_ID, tenantId: LOCAL_TENANT, version: 1 },
  ]),
) => {
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

describe("affair delete PHP blocker parity", () => {
  it.each([
    [
      "schools",
      2,
      "此試務資料下有 2 所學校帳號，請先刪除學校帳號後再刪除",
    ],
    [
      "submissions",
      3,
      "此試務資料下有 3 筆填報資料，請先到各收集方式的「資料檢視」頁刪除後再刪除試務",
    ],
    [
      "receipts",
      4,
      "此試務資料下有 4 筆領據（含身分證與銀行帳號），請先到領據頁面刪除後再刪除試務",
    ],
    [
      "collections",
      5,
      "此試務資料下有 5 個收集方式，請先刪除收集方式後再刪除",
    ],
  ] as const)("returns the PHP %s blocker message", async (kind, count, message) => {
    const deletionRepository = new InMemoryAffairDeletionRepository([
      { id: AFFAIR_ID, tenantId: LOCAL_TENANT, version: 1 },
    ]);
    deletionRepository.setBlocker(kind, count);
    const { app } = createTestApp(deletionRepository);

    const response = await app.request(
      `/api/v1/affairs/${AFFAIR_ID}?version=1`,
      { method: "DELETE" },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "validation_error", message },
    });
    expect(deletionRepository.hasAffair(AFFAIR_ID, LOCAL_TENANT)).toBe(true);
  });

  it("uses PHP first-blocker order instead of aggregating", async () => {
    const deletionRepository = new InMemoryAffairDeletionRepository([
      { id: AFFAIR_ID, tenantId: LOCAL_TENANT, version: 1 },
    ]);
    deletionRepository.setBlocker("collections", 9);
    deletionRepository.setBlocker("receipts", 8);
    deletionRepository.setBlocker("submissions", 7);
    deletionRepository.setBlocker("schools", 6);
    const { app } = createTestApp(deletionRepository);

    const response = await app.request(
      `/api/v1/affairs/${AFFAIR_ID}?version=1`,
      { method: "DELETE" },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "validation_error",
        message:
          "此試務資料下有 6 所學校帳號，請先刪除學校帳號後再刪除",
      },
    });
  });

  it("hard-deletes only when no blocker exists", async () => {
    const { app, deletionRepository } = createTestApp();

    const response = await app.request(
      `/api/v1/affairs/${AFFAIR_ID}?version=1`,
      { method: "DELETE" },
    );

    expect(response.status).toBe(204);
    expect(deletionRepository.hasAffair(AFFAIR_ID, LOCAL_TENANT)).toBe(false);
  });

  it("does not widen a delete into another tenant", async () => {
    const otherTenant = "65000000-0000-4000-8000-000000000099";
    const deletionRepository = new InMemoryAffairDeletionRepository([
      { id: AFFAIR_ID, tenantId: otherTenant, version: 1 },
    ]);
    const { app } = createTestApp(deletionRepository);

    const response = await app.request(
      `/api/v1/affairs/${AFFAIR_ID}?version=1`,
      { method: "DELETE" },
    );

    expect(response.status).toBe(404);
    expect(deletionRepository.hasAffair(AFFAIR_ID, otherTenant)).toBe(true);
  });
});

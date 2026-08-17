import {
  COMPANY_MEMBER_ADMIN_PERMISSIONS,
  COMPANY_MEMBER_NO_PERMISSIONS,
} from "@server-foundation/domain";
import {
  companyMemberFixture,
  createInMemoryCompanyMemberRepository,
  createInMemoryItemRepository,
} from "@server-foundation/testing";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { mountCompanyMemberRoutes } from "../src/company-member-routes.js";

const actorPermissions = {
  ...COMPANY_MEMBER_NO_PERMISSIONS,
  members: true,
};

const createTestApp = (
  actorOverrides: Parameters<typeof companyMemberFixture>[0] = {},
) => {
  const repository = createInMemoryCompanyMemberRepository([
    companyMemberFixture({
      id: "actor",
      userId: "local-development-user",
      isAdmin: true,
      permissions: { ...COMPANY_MEMBER_ADMIN_PERMISSIONS },
      ...actorOverrides,
    }),
    companyMemberFixture({
      id: "other-admin",
      userId: "other-admin-user",
      isAdmin: true,
      permissions: { ...COMPANY_MEMBER_ADMIN_PERMISSIONS },
    }),
  ]);
  const app = createApp({
    itemRepository: createInMemoryItemRepository(),
    allowUnauthenticatedItems: true,
  });
  mountCompanyMemberRoutes(app, {
    repository,
    allowUnauthenticated: true,
  });
  return app;
};

const jsonPost = (app: ReturnType<typeof createTestApp>, body: unknown) =>
  app.request("/api/v1/company-members", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("company member permission contract", () => {
  it("requires exactly the 13 PHP permission keys and normalizes the exclusive question pair", async () => {
    const app = createTestApp();
    const permissions = {
      ...COMPANY_MEMBER_NO_PERMISSIONS,
      questions_all: true,
      questions_own: true,
      members: true,
    };
    const response = await jsonPost(app, {
      userId: "new-user",
      permissions,
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      userId: "new-user",
      permissions: {
        questions_all: true,
        questions_own: false,
        members: true,
      },
    });

    const missing = { ...permissions } as Record<string, boolean>;
    delete missing.site;
    const missingResponse = await jsonPost(app, {
      userId: "missing-key-user",
      permissions: missing,
    });
    expect(missingResponse.status).toBe(400);

    const extraResponse = await jsonPost(app, {
      userId: "extra-key-user",
      permissions: { ...permissions, invented_permission: true },
    });
    expect(extraResponse.status).toBe(400);
  });

  it("stores the PHP administrator permission map regardless of submitted granular flags", async () => {
    const app = createTestApp();
    const response = await jsonPost(app, {
      userId: "new-admin",
      isAdmin: true,
      permissions: { ...COMPANY_MEMBER_NO_PERMISSIONS },
    });
    expect(response.status).toBe(201);
    expect((await response.json()).permissions).toEqual(
      COMPANY_MEMBER_ADMIN_PERMISSIONS,
    );
  });
});

describe("company member caller boundary", () => {
  it("rejects a disabled administrator before the PHP-style admin shortcut", async () => {
    const app = createTestApp({ status: "disabled" });
    expect((await app.request("/api/v1/company-members")).status).toBe(403);
  });

  it("preserves the PHP quirk where an active pending administrator passes the permission gate", async () => {
    const app = createTestApp({ reviewStatus: "pending" });
    expect((await app.request("/api/v1/company-members")).status).toBe(200);
  });

  it("rejects an active pending non-admin even when the members flag is true", async () => {
    const app = createTestApp({
      isAdmin: false,
      reviewStatus: "pending",
      permissions: actorPermissions,
    });
    expect((await app.request("/api/v1/company-members")).status).toBe(403);
  });

  it("allows an active approved non-admin with the members flag", async () => {
    const app = createTestApp({
      isAdmin: false,
      reviewStatus: "approved",
      permissions: actorPermissions,
    });
    expect((await app.request("/api/v1/company-members")).status).toBe(200);
  });
});

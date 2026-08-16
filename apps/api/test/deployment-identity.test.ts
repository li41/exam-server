import { describe, expect, it } from "vitest";
import { createInMemoryItemRepository } from "@server-foundation/testing";
import { createApp } from "../src/app.js";
import { mountDeploymentIdentityRoutes } from "../src/deployment-identity-routes.js";

const tenantUuid = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

const createTestApp = () => {
  const app = createApp({
    itemRepository: createInMemoryItemRepository(),
    allowUnauthenticatedItems: true,
  });
  mountDeploymentIdentityRoutes(app, tenantUuid);
  return app;
};

describe("deployment tenant identity API", () => {
  it("exposes only the tenant UUID without authentication", async () => {
    const response = await createTestApp().request(
      "/api/v1/deployment/tenant",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tenantUuid });
    expect(response.headers.get("x-api-version")).toBe("v1");
  });

  it("keeps the existing legacy API prefix compatible", async () => {
    const response = await createTestApp().request("/api/deployment/tenant");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tenantUuid });
    expect(response.headers.get("x-api-legacy-route")).toBe("true");
  });
});

import {
  createInMemoryAffairConfigurationRepository,
  createInMemoryAffairRepository,
  createInMemoryAffairSubmissionRepository,
  createInMemoryItemRepository,
} from "@server-foundation/testing";
import { describe, expect, it } from "vitest";
import { mountAffairConfigurationRoutes } from "../src/affair-configuration-routes.js";
import { mountAffairRoutes } from "../src/affair-routes.js";
import { mountAffairSubmissionRoutes } from "../src/affair-submission-routes.js";
import { createApp } from "../src/app.js";

const setup = () => {
  const affairs = createInMemoryAffairRepository();
  const configurations = createInMemoryAffairConfigurationRepository(affairs);
  const submissions = createInMemoryAffairSubmissionRepository(configurations);
  const app = createApp({
    itemRepository: createInMemoryItemRepository(),
    allowUnauthenticatedItems: true,
  });
  mountAffairRoutes(app, { repository: affairs, allowUnauthenticated: true });
  mountAffairConfigurationRoutes(app, {
    repository: configurations,
    allowUnauthenticated: true,
  });
  mountAffairSubmissionRoutes(app, {
    repository: submissions,
    affairRepository: affairs,
    configurationRepository: configurations,
    allowUnauthenticated: true,
  });
  return app;
};

const json = (
  app: ReturnType<typeof setup>,
  method: "POST" | "PUT",
  path: string,
  body: unknown,
) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("affair C-wave PHP submit ordering", () => {
  it("keeps an invalid submitted payload while leaving status and version unchanged", async () => {
    const app = setup();
    const affair = await (
      await json(app, "POST", "/api/v1/affairs", { name: "ordering" })
    ).json();
    const field = await (
      await json(app, "POST", "/api/v1/affair-fields", {
        name: "人數",
        dataType: "number",
        validation: { min: 1, max: 3 },
      })
    ).json();
    const collection = await (
      await json(app, "POST", "/api/v1/affair-collections", {
        affairId: affair.id,
        name: "form",
        type: "form",
        target: "school",
      })
    ).json();
    await json(
      app,
      "PUT",
      `/api/v1/affair-collections/${collection.id}/bindings`,
      { bindings: [{ fieldId: field.id, isRequired: true }] },
    );
    const school = await (
      await json(app, "POST", "/api/v1/affair-schools", {
        affairId: affair.id,
        city: "臺北市",
        schoolLevel: 1,
        schoolCode: "P001",
        schoolName: "順序測試校",
      })
    ).json();
    const ensured = await (
      await json(app, "POST", "/api/v1/affair-submissions/ensure", {
        affairId: affair.id,
        collectionId: collection.id,
        submitterType: "school",
        schoolId: school.id,
      })
    ).json();

    const invalid = await json(
      app,
      "POST",
      `/api/v1/affair-submissions/${ensured.item.id}/submit`,
      {
        version: 1,
        payload: {
          kind: "form",
          fields: [{ fieldId: field.id, value: "9" }],
        },
      },
    );
    expect(invalid.status).toBe(400);

    const afterFailure = await app.request(
      `/api/v1/affair-submissions/${ensured.item.id}`,
    );
    expect(await afterFailure.json()).toMatchObject({
      status: "draft",
      version: 1,
      payload: {
        kind: "form",
        fields: [{ fieldId: field.id, value: "9" }],
      },
    });

    const corrected = await json(
      app,
      "POST",
      `/api/v1/affair-submissions/${ensured.item.id}/submit`,
      {
        version: 1,
        payload: {
          kind: "form",
          fields: [{ fieldId: field.id, value: "2" }],
        },
      },
    );
    expect(corrected.status).toBe(200);
    expect(await corrected.json()).toMatchObject({
      status: "submitted",
      version: 2,
      payload: {
        kind: "form",
        fields: [{ fieldId: field.id, value: "2" }],
      },
    });
  });
});

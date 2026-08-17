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

const createTestApp = () => {
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

const jsonRequest = (
  app: ReturnType<typeof createTestApp>,
  method: "POST" | "PUT",
  path: string,
  body: unknown,
) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("affair C-wave batch return", () => {
  it("returns only submitted rows and skips draft rows", async () => {
    const app = createTestApp();
    const affair = await (
      await jsonRequest(app, "POST", "/api/v1/affairs", { name: "batch" })
    ).json();
    const field = await (
      await jsonRequest(app, "POST", "/api/v1/affair-fields", {
        name: "填報值",
      })
    ).json();
    const collection = await (
      await jsonRequest(app, "POST", "/api/v1/affair-collections", {
        affairId: affair.id,
        name: "表單",
        type: "form",
        target: "school",
      })
    ).json();
    await jsonRequest(
      app,
      "PUT",
      `/api/v1/affair-collections/${collection.id}/bindings`,
      { bindings: [{ fieldId: field.id }] },
    );

    const submissionItems: Array<{ id: string; version: number }> = [];
    for (const code of ["A101", "A102", "A103"]) {
      const school = await (
        await jsonRequest(app, "POST", "/api/v1/affair-schools", {
          affairId: affair.id,
          city: "臺北市",
          schoolLevel: 1,
          schoolCode: code,
          schoolName: `學校 ${code}`,
        })
      ).json();
      const ensured = await (
        await jsonRequest(
          app,
          "POST",
          "/api/v1/affair-submissions/ensure",
          {
            affairId: affair.id,
            collectionId: collection.id,
            submitterType: "school",
            schoolId: school.id,
          },
        )
      ).json();
      submissionItems.push({
        id: ensured.item.id,
        version: ensured.item.version,
      });
    }

    for (const item of submissionItems.slice(0, 2)) {
      const submitted = await jsonRequest(
        app,
        "POST",
        `/api/v1/affair-submissions/${item.id}/submit`,
        {
          version: item.version,
          payload: {
            kind: "form",
            fields: [{ fieldId: field.id, value: "ok" }],
          },
        },
      );
      expect(submitted.status).toBe(200);
      item.version = (await submitted.json()).version;
    }

    const batch = await jsonRequest(
      app,
      "POST",
      "/api/v1/affair-submissions/batch-return",
      {
        items: submissionItems,
        reason: "統一退回",
      },
    );
    expect(batch.status).toBe(200);
    expect(await batch.json()).toEqual({ returned: 2, skipped: 1 });

    for (const item of submissionItems.slice(0, 2)) {
      const response = await app.request(`/api/v1/affair-submissions/${item.id}`);
      expect(await response.json()).toMatchObject({
        status: "returned",
        returnReason: "統一退回",
      });
    }
    const draftResponse = await app.request(
      `/api/v1/affair-submissions/${submissionItems[2]?.id}`,
    );
    expect(await draftResponse.json()).toMatchObject({ status: "draft" });
  });
});

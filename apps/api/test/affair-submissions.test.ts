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
  method: "POST" | "PUT" | "PATCH",
  path: string,
  body: unknown,
) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const createAffair = async (app: ReturnType<typeof createTestApp>) =>
  (
    await jsonRequest(app, "POST", "/api/v1/affairs", {
      name: "C-wave affair",
    })
  ).json();

const createField = async (
  app: ReturnType<typeof createTestApp>,
  name: string,
  extra: Record<string, unknown> = {},
) =>
  (
    await jsonRequest(app, "POST", "/api/v1/affair-fields", {
      name,
      ...extra,
    })
  ).json();

const createCollection = async (
  app: ReturnType<typeof createTestApp>,
  affairId: string,
  type: "form" | "excel",
  target: "school" | "city",
) =>
  (
    await jsonRequest(app, "POST", "/api/v1/affair-collections", {
      affairId,
      name: `${type}-${target}`,
      type,
      target,
    })
  ).json();

describe("affair C-wave submission API", () => {
  it("preserves PHP form upsert semantics and the draft/submitted/returned state machine", async () => {
    const app = createTestApp();
    const affair = await createAffair(app);
    const field = await createField(app, "班級數", {
      dataType: "number",
      validation: { min: 1, max: 10 },
    });
    const collection = await createCollection(app, affair.id, "form", "school");
    await jsonRequest(
      app,
      "PUT",
      `/api/v1/affair-collections/${collection.id}/bindings`,
      { bindings: [{ fieldId: field.id, isRequired: true }] },
    );
    const school = await (
      await jsonRequest(app, "POST", "/api/v1/affair-schools", {
        affairId: affair.id,
        city: "臺北市",
        schoolLevel: 1,
        schoolCode: "A001",
        schoolName: "測試國小",
      })
    ).json();

    const ensuredResponse = await jsonRequest(
      app,
      "POST",
      "/api/v1/affair-submissions/ensure",
      {
        affairId: affair.id,
        collectionId: collection.id,
        submitterType: "school",
        schoolId: school.id,
      },
    );
    expect(ensuredResponse.status).toBe(201);
    const ensured = await ensuredResponse.json();
    expect(ensured.item).toMatchObject({
      submitterType: "school",
      schoolId: school.id,
      cityId: null,
      accountType: "SC",
      status: "draft",
      version: 1,
    });

    const ensuredAgain = await jsonRequest(
      app,
      "POST",
      "/api/v1/affair-submissions/ensure",
      {
        affairId: affair.id,
        collectionId: collection.id,
        submitterType: "school",
        schoolId: school.id,
      },
    );
    expect(ensuredAgain.status).toBe(200);
    expect((await ensuredAgain.json()).item.id).toBe(ensured.item.id);

    const saved = await jsonRequest(
      app,
      "PUT",
      `/api/v1/affair-submissions/${ensured.item.id}/draft`,
      {
        version: 1,
        payload: {
          kind: "form",
          fields: [{ fieldId: field.id, value: "5" }],
        },
      },
    );
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ status: "draft", version: 2 });

    // PHP form batchSave only upserts supplied keys. Omitted values remain stored,
    // so the already-saved required field still satisfies final validation.
    const submitted = await jsonRequest(
      app,
      "POST",
      `/api/v1/affair-submissions/${ensured.item.id}/submit`,
      { version: 2, payload: { kind: "form", fields: [] } },
    );
    expect(submitted.status).toBe(200);
    const submittedBody = await submitted.json();
    expect(submittedBody).toMatchObject({ status: "submitted", version: 3 });

    const cannotEditSubmitted = await jsonRequest(
      app,
      "PUT",
      `/api/v1/affair-submissions/${ensured.item.id}/draft`,
      {
        version: 3,
        payload: {
          kind: "form",
          fields: [{ fieldId: field.id, value: "6" }],
        },
      },
    );
    expect(cannotEditSubmitted.status).toBe(400);

    const returned = await jsonRequest(
      app,
      "POST",
      `/api/v1/affair-submissions/${ensured.item.id}/return`,
      { version: 3, reason: "補件" },
    );
    expect(returned.status).toBe(200);
    const returnedBody = await returned.json();
    expect(returnedBody).toMatchObject({
      status: "returned",
      returnReason: "補件",
      version: 4,
    });
    expect(returnedBody.returnedAt).toBeTruthy();

    const savedAfterReturn = await jsonRequest(
      app,
      "PUT",
      `/api/v1/affair-submissions/${ensured.item.id}/draft`,
      {
        version: 4,
        payload: {
          kind: "form",
          fields: [{ fieldId: field.id, value: "7" }],
        },
      },
    );
    expect(savedAfterReturn.status).toBe(200);
    expect(await savedAfterReturn.json()).toMatchObject({
      status: "draft",
      returnReason: "補件",
      version: 5,
    });
  });

  it("allows returned data to be resubmitted directly and rejects invalid final values", async () => {
    const app = createTestApp();
    const affair = await createAffair(app);
    const field = await createField(app, "人數", {
      dataType: "number",
      validation: { min: 1, max: 3 },
    });
    const collection = await createCollection(app, affair.id, "form", "school");
    await jsonRequest(
      app,
      "PUT",
      `/api/v1/affair-collections/${collection.id}/bindings`,
      { bindings: [{ fieldId: field.id, isRequired: true }] },
    );
    const school = await (
      await jsonRequest(app, "POST", "/api/v1/affair-schools", {
        affairId: affair.id,
        city: "臺北市",
        schoolLevel: 2,
        schoolCode: "B002",
        schoolName: "測試國中",
      })
    ).json();
    const submission = (
      await (
        await jsonRequest(app, "POST", "/api/v1/affair-submissions/ensure", {
          affairId: affair.id,
          collectionId: collection.id,
          submitterType: "school",
          schoolId: school.id,
        })
      ).json()
    ).item;

    const invalid = await jsonRequest(
      app,
      "POST",
      `/api/v1/affair-submissions/${submission.id}/submit`,
      {
        version: 1,
        payload: {
          kind: "form",
          fields: [{ fieldId: field.id, value: "9" }],
        },
      },
    );
    expect(invalid.status).toBe(400);

    const firstSubmit = await jsonRequest(
      app,
      "POST",
      `/api/v1/affair-submissions/${submission.id}/submit`,
      {
        version: 1,
        payload: {
          kind: "form",
          fields: [{ fieldId: field.id, value: "2" }],
        },
      },
    );
    expect(firstSubmit.status).toBe(200);

    const returned = await jsonRequest(
      app,
      "POST",
      `/api/v1/affair-submissions/${submission.id}/return`,
      { version: 2, reason: null },
    );
    expect(returned.status).toBe(200);

    const resubmitted = await jsonRequest(
      app,
      "POST",
      `/api/v1/affair-submissions/${submission.id}/submit`,
      { version: 3, payload: { kind: "form", fields: [] } },
    );
    expect(resubmitted.status).toBe(200);
    expect(await resubmitted.json()).toMatchObject({
      status: "submitted",
      version: 4,
    });
  });

  it("keeps excel repeated rows separate and rejects unknown row keys", async () => {
    const app = createTestApp();
    const affair = await createAffair(app);
    const field = await createField(app, "學校代碼");
    const collection = await createCollection(app, affair.id, "excel", "city");
    await jsonRequest(
      app,
      "PUT",
      `/api/v1/affair-collections/${collection.id}/bindings`,
      { bindings: [{ fieldId: field.id, isRequired: true }] },
    );
    const initialized = await jsonRequest(
      app,
      "POST",
      "/api/v1/affair-cities/initialize",
      {},
    );
    const city = (await initialized.json()).items[0];
    const submission = (
      await (
        await jsonRequest(app, "POST", "/api/v1/affair-submissions/ensure", {
          affairId: affair.id,
          collectionId: collection.id,
          submitterType: "city",
          cityId: city.id,
        })
      ).json()
    ).item;

    const extraWrapperKey = await jsonRequest(
      app,
      "POST",
      `/api/v1/affair-submissions/${submission.id}/submit`,
      {
        version: 1,
        payload: {
          kind: "excel",
          rows: [{ values: { [field.id]: "001" }, surprise: true }],
        },
      },
    );
    expect(extraWrapperKey.status).toBe(400);

    const unboundField = await jsonRequest(
      app,
      "POST",
      `/api/v1/affair-submissions/${submission.id}/submit`,
      {
        version: 1,
        payload: {
          kind: "excel",
          rows: [{ values: { [field.id]: "001", foreign: "x" } }],
        },
      },
    );
    expect(unboundField.status).toBe(400);

    const emptyRows = await jsonRequest(
      app,
      "POST",
      `/api/v1/affair-submissions/${submission.id}/submit`,
      { version: 1, payload: { kind: "excel", rows: [] } },
    );
    expect(emptyRows.status).toBe(400);

    const submitted = await jsonRequest(
      app,
      "POST",
      `/api/v1/affair-submissions/${submission.id}/submit`,
      {
        version: 1,
        payload: {
          kind: "excel",
          rows: [
            { values: { [field.id]: "001" } },
            { values: { [field.id]: "002" } },
          ],
        },
      },
    );
    expect(submitted.status).toBe(200);
    const body = await submitted.json();
    expect(body.payload).toMatchObject({
      kind: "excel",
      rows: [
        { values: { [field.id]: "001" }, sortOrder: 0 },
        { values: { [field.id]: "002" }, sortOrder: 1 },
      ],
    });
  });
});

import {
  AffairConfigurationService,
  AffairService,
} from "@server-foundation/domain";
import {
  createInMemoryAffairConfigurationRepository,
  createInMemoryAffairRepository,
  createInMemoryItemRepository,
} from "@server-foundation/testing";
import { describe, expect, it } from "vitest";
import { mountAffairConfigurationRoutes } from "../src/affair-configuration-routes.js";
import { mountAffairRoutes } from "../src/affair-routes.js";
import { createApp } from "../src/app.js";

const createTestApp = () => {
  const affairs = createInMemoryAffairRepository();
  const configurations = createInMemoryAffairConfigurationRepository(affairs);
  const app = createApp({
    itemRepository: createInMemoryItemRepository(),
    allowUnauthenticatedItems: true,
  });
  mountAffairRoutes(app, { repository: affairs, allowUnauthenticated: true });
  mountAffairConfigurationRoutes(app, {
    repository: configurations,
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

const createAffair = async (app: ReturnType<typeof createTestApp>) => {
  const response = await jsonRequest(app, "POST", "/api/v1/affairs", {
    name: "B-wave affair",
  });
  expect(response.status).toBe(201);
  return response.json();
};

describe("affair B-wave API", () => {
  it("keeps collection types, strict JSON contracts, and shared form/excel bindings", async () => {
    const app = createTestApp();
    const affair = await createAffair(app);

    const fieldResponse = await jsonRequest(
      app,
      "POST",
      "/api/v1/affair-fields",
      {
        name: "班級數",
        dataType: "number",
        validation: { min: 0, max: 99, min_length: 1 },
      },
    );
    expect(fieldResponse.status).toBe(201);
    const field = await fieldResponse.json();

    const unknownValidationKey = await jsonRequest(
      app,
      "POST",
      "/api/v1/affair-fields",
      {
        name: "不合法欄位",
        validation: { min: 0, surprise: true },
      },
    );
    expect(unknownValidationKey.status).toBe(400);

    const selectWithoutOptions = await jsonRequest(
      app,
      "POST",
      "/api/v1/affair-fields",
      { name: "選項欄", dataType: "select" },
    );
    expect(selectWithoutOptions.status).toBe(400);

    const formResponse = await jsonRequest(
      app,
      "POST",
      "/api/v1/affair-collections",
      {
        affairId: affair.id,
        name: "表單收集",
        type: "form",
        target: "school",
      },
    );
    expect(formResponse.status).toBe(201);
    const form = await formResponse.json();

    const bindingResponse = await jsonRequest(
      app,
      "PUT",
      `/api/v1/affair-collections/${form.id}/bindings`,
      {
        bindings: [{ fieldId: field.id, isRequired: true }],
        layout: "班級數：{1:4}",
      },
    );
    expect(bindingResponse.status).toBe(200);
    expect(await bindingResponse.json()).toMatchObject([
      { fieldId: field.id, isRequired: true, sortOrder: 0 },
    ]);

    const refreshedForm = await app.request(
      `/api/v1/affair-collections/${form.id}`,
    );
    expect(await refreshedForm.json()).toMatchObject({
      settings: { layout: "班級數：{1:4}" },
    });

    const firstReceipt = await jsonRequest(
      app,
      "POST",
      "/api/v1/affair-collections",
      {
        affairId: affair.id,
        name: "學校領據",
        type: "receipt",
        target: "school",
      },
    );
    expect(firstReceipt.status).toBe(201);

    const duplicateReceipt = await jsonRequest(
      app,
      "POST",
      "/api/v1/affair-collections",
      {
        affairId: affair.id,
        name: "第二份學校領據",
        type: "receipt",
        target: "school",
      },
    );
    expect(duplicateReceipt.status).toBe(409);
  });

  it("keeps form and excel reference data separate with different key semantics", async () => {
    const app = createTestApp();
    const affair = await createAffair(app);
    const field = await (
      await jsonRequest(app, "POST", "/api/v1/affair-fields", {
        name: "學校代碼",
      })
    ).json();

    const form = await (
      await jsonRequest(app, "POST", "/api/v1/affair-collections", {
        affairId: affair.id,
        name: "表單",
        type: "form",
      })
    ).json();
    const excel = await (
      await jsonRequest(app, "POST", "/api/v1/affair-collections", {
        affairId: affair.id,
        name: "Excel",
        type: "excel",
      })
    ).json();

    await jsonRequest(
      app,
      "PUT",
      `/api/v1/affair-collections/${excel.id}/bindings`,
      { bindings: [{ fieldId: field.id }] },
    );

    const formRows = await jsonRequest(
      app,
      "PUT",
      `/api/v1/affair-collections/${form.id}/reference-data`,
      { rows: [{ 學校代碼: "001" }] },
    );
    expect(formRows.status).toBe(200);
    expect(await formRows.json()).toMatchObject([
      { rowData: { 學校代碼: "001" } },
    ]);

    const excelRows = await jsonRequest(
      app,
      "PUT",
      `/api/v1/affair-collections/${excel.id}/reference-data`,
      { rows: [{ [field.id]: "001" }] },
    );
    expect(excelRows.status).toBe(200);
    expect(await excelRows.json()).toMatchObject([
      { rowData: { [field.id]: "001" } },
    ]);

    const wrongExcelKeys = await jsonRequest(
      app,
      "PUT",
      `/api/v1/affair-collections/${excel.id}/reference-data`,
      { rows: [{ 學校代碼: "001" }] },
    );
    expect(wrongExcelKeys.status).toBe(400);
  });
});

describe("affair B-wave tenant boundary", () => {
  it("rejects binding a tenant-A collection to a tenant-B field", async () => {
    const affairs = createInMemoryAffairRepository();
    const affairService = new AffairService(affairs);
    const configurations = createInMemoryAffairConfigurationRepository(affairs);
    const service = new AffairConfigurationService(configurations);
    const tenantA = { tenantId: "tenant-a", actorUserId: "user-a" };
    const tenantB = { tenantId: "tenant-b", actorUserId: "user-b" };

    const affair = await affairService.createAffair(
      {
        name: "tenant A affair",
        description: null,
        status: "enabled",
        cityLoginStart: null,
        cityLoginEnd: null,
        schoolLoginStart: null,
        schoolLoginEnd: null,
        feeCityContact: 0,
        feeSchoolContact: 0,
        feeTeacherSetup: 0,
        feeTeacherMonitor1: 0,
        feeTeacherMonitor2: 0,
        feeTeacherMonitor3: 0,
        transportReceiptSchool: false,
        transportReceiptCity: false,
        briefingRegions: null,
        receiptYear: null,
        receiptNote: null,
        receiptPrintSchool: false,
        receiptPrintCity: false,
      },
      tenantA,
    );
    const collection = await service.createCollection(
      {
        affairId: affair.id,
        name: "A form",
        type: "form",
        target: "school",
        status: "enabled",
      },
      tenantA,
    );
    const foreignField = await service.createField(
      {
        name: "B-only field",
        description: null,
        dataType: "text",
        isRequired: false,
        validation: null,
        selectOptions: null,
        sortOrder: 0,
      },
      tenantB,
    );

    await expect(
      service.replaceBindings(
        collection.id,
        { bindings: [{ fieldId: foreignField.id, isRequired: false }] },
        tenantA,
      ),
    ).rejects.toMatchObject({ code: "not_found" });

    const localField = await service.createField(
      {
        name: "A field",
        description: null,
        dataType: "text",
        isRequired: false,
        validation: null,
        selectOptions: null,
        sortOrder: 0,
      },
      tenantA,
    );
    await expect(
      service.replaceBindings(
        collection.id,
        { bindings: [{ fieldId: localField.id, isRequired: false }] },
        tenantA,
      ),
    ).resolves.toMatchObject([{ fieldId: localField.id }]);
  });
});

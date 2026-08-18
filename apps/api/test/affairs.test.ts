import { AffairService } from "@server-foundation/domain";
import {
  createInMemoryAffairRepository,
  createInMemoryItemRepository,
} from "@server-foundation/testing";
import { describe, expect, it } from "vitest";
import { mountAffairRoutes } from "../src/affair-routes.js";
import { createApp } from "../src/app.js";

const createTestApp = () => {
  const affairs = createInMemoryAffairRepository();
  const app = createApp({
    itemRepository: createInMemoryItemRepository(),
    allowUnauthenticatedItems: true,
  });
  mountAffairRoutes(app, { repository: affairs, allowUnauthenticated: true });
  return app;
};

const jsonPost = (
  app: ReturnType<typeof createTestApp>,
  path: string,
  body: unknown,
) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("affair A-wave API", () => {
  it("creates affairs, initializes the PHP 22-city set, and keeps omitted PATCH fields", async () => {
    const app = createTestApp();
    const createdResponse = await jsonPost(app, "/api/v1/affairs", {
      name: "115 年試務",
      description: "initial",
      feeCityContact: 1200,
    });
    expect(createdResponse.status).toBe(201);
    const affair = await createdResponse.json();
    expect(affair).toMatchObject({
      name: "115 年試務",
      description: "initial",
      feeCityContact: 1200,
      status: "enabled",
      version: 1,
    });

    const patch = await app.request(`/api/v1/affairs/${affair.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "只改名稱", version: affair.version }),
    });
    expect(patch.status).toBe(200);
    expect(await patch.json()).toMatchObject({
      name: "只改名稱",
      description: "initial",
      feeCityContact: 1200,
      version: 2,
    });

    const initialized = await jsonPost(
      app,
      "/api/v1/affair-cities/initialize",
      {},
    );
    expect(initialized.status).toBe(201);
    const cityResult = await initialized.json();
    expect(cityResult.created).toBe(22);
    expect(cityResult.items).toHaveLength(22);
    expect(cityResult.items[0]).toMatchObject({
      cityCode: "01",
      cityName: "臺北市",
      account: "EDU01",
      password: "EDU01",
    });

    const initializedAgain = await jsonPost(
      app,
      "/api/v1/affair-cities/initialize",
      {},
    );
    expect((await initializedAgain.json()).created).toBe(0);
  });

  it("enforces PHP school validation and unique code+level inside one affair", async () => {
    const app = createTestApp();
    const affair = await (
      await jsonPost(app, "/api/v1/affairs", { name: "A" })
    ).json();

    const school = await jsonPost(app, "/api/v1/affair-schools", {
      affairId: affair.id,
      city: "臺北市",
      schoolLevel: 1,
      schoolCode: "001",
      schoolName: "測試國小",
      testClasses: 2,
      testSessions: 3,
      receiptCode: "123",
    });
    expect(school.status).toBe(201);
    expect(await school.json()).toMatchObject({
      schoolCode: "001",
      schoolLevel: 1,
      password: "001",
    });

    const duplicate = await jsonPost(app, "/api/v1/affair-schools", {
      affairId: affair.id,
      city: "臺北市",
      schoolLevel: 1,
      schoolCode: "001",
      schoolName: "另一校名",
    });
    expect(duplicate.status).toBe(409);

    const invalidReceipt = await jsonPost(app, "/api/v1/affair-schools", {
      affairId: affair.id,
      city: "臺北市",
      schoolLevel: 2,
      schoolCode: "002",
      schoolName: "測試國中",
      receiptCode: "12",
    });
    expect(invalidReceipt.status).toBe(400);
  });
});

describe("affair repository tenant boundary", () => {
  it("does not expose affair or school rows to another tenant", async () => {
    const repository = createInMemoryAffairRepository();
    const service = new AffairService(repository);
    const tenantA = { tenantId: "tenant-a", actorUserId: "user-a" };
    const tenantB = { tenantId: "tenant-b", actorUserId: "user-b" };
    const affair = await service.createAffair(
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
    await service.createSchool(
      {
        affairId: affair.id,
        city: "臺北市",
        schoolLevel: 1,
        schoolCode: "A001",
        schoolName: "A 校",
        testClasses: 1,
        testSessions: 1,
        receiptCode: null,
        briefingOptions: null,
        password: null,
        status: "enabled",
      },
      tenantA,
    );

    await expect(service.getAffair(affair.id, tenantB)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      service.listSchools({ affairId: affair.id, limit: 50 }, tenantB),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

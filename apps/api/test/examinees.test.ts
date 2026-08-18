import {
  createInMemoryExamineeRepository,
  createInMemoryItemRepository,
  createInMemoryQuestionBankRepository,
} from "@server-foundation/testing";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { mountQuestionBankRoutes } from "../src/question-bank-routes.js";

const createTestApp = () => {
  const examinees = createInMemoryExamineeRepository();
  const app = createApp({
    itemRepository: createInMemoryItemRepository(),
    allowUnauthenticatedItems: true,
  });
  mountQuestionBankRoutes(app, {
    repository: createInMemoryQuestionBankRepository(),
    examineeRepository: examinees,
    allowUnauthenticated: true,
  });
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

describe("examinee group API", () => {
  it("enforces the PHP two-level rule", async () => {
    const app = createTestApp();
    const rootResponse = await jsonPost(app, "/api/v1/examinee-groups", {
      name: "一年級",
      proctorPassword: "proctor-one",
    });
    expect(rootResponse.status).toBe(201);
    const root = await rootResponse.json();

    const childResponse = await jsonPost(app, "/api/v1/examinee-groups", {
      parentId: root.id,
      name: "一班",
    });
    expect(childResponse.status).toBe(201);
    const child = await childResponse.json();

    const grandchildResponse = await jsonPost(app, "/api/v1/examinee-groups", {
      parentId: child.id,
      name: "第三層",
    });
    expect(grandchildResponse.status).toBe(400);
    expect(await grandchildResponse.json()).toMatchObject({
      error: {
        code: "validation_error",
        message: "Examinee groups support at most two levels.",
      },
    });
  });

  it("soft-deletes a group and child while making affected examinees ungrouped", async () => {
    const app = createTestApp();
    const root = await (
      await jsonPost(app, "/api/v1/examinee-groups", { name: "Root" })
    ).json();
    const child = await (
      await jsonPost(app, "/api/v1/examinee-groups", {
        parentId: root.id,
        name: "Child",
      })
    ).json();
    const examinee = await (
      await jsonPost(app, "/api/v1/examinees", {
        groupId: child.id,
        identifier: "S001",
        code: "printable-secret",
        name: "王小明",
      })
    ).json();

    const deletion = await app.request(
      `/api/v1/examinee-groups/${root.id}?version=${root.version}`,
      { method: "DELETE" },
    );
    expect(deletion.status).toBe(204);

    expect(
      (await app.request(`/api/v1/examinee-groups/${child.id}`)).status,
    ).toBe(404);
    const readExaminee = await app.request(`/api/v1/examinees/${examinee.id}`);
    expect(readExaminee.status).toBe(200);
    expect(await readExaminee.json()).toMatchObject({
      id: examinee.id,
      groupId: null,
      version: 2,
    });
  });
});

describe("examinee API", () => {
  it("keeps code readable, preserves omitted PATCH fields, and looks up by identifier", async () => {
    const app = createTestApp();
    const createResponse = await jsonPost(app, "/api/v1/examinees", {
      identifier: "EMP-100",
      code: "desk-card-100",
      name: "受測者 A",
      note: "initial",
    });
    expect(createResponse.status).toBe(201);
    const examinee = await createResponse.json();
    expect(examinee).toMatchObject({
      identifier: "EMP-100",
      code: "desk-card-100",
      status: "enabled",
      version: 1,
    });

    const patchResponse = await app.request(
      `/api/v1/examinees/${examinee.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "只改姓名", version: examinee.version }),
      },
    );
    expect(patchResponse.status).toBe(200);
    expect(await patchResponse.json()).toMatchObject({
      name: "只改姓名",
      identifier: "EMP-100",
      code: "desk-card-100",
      note: "initial",
      status: "enabled",
      version: 2,
    });

    const lookup = await app.request("/api/v1/examinees/by-identifier/EMP-100");
    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toMatchObject({
      id: examinee.id,
      code: "desk-card-100",
    });
  });

  it("rejects duplicate identifier or password inside one tenant", async () => {
    const app = createTestApp();
    expect(
      (
        await jsonPost(app, "/api/v1/examinees", {
          identifier: "DUP-1",
          code: "same-code",
          name: "First",
        })
      ).status,
    ).toBe(201);

    const duplicateIdentifier = await jsonPost(app, "/api/v1/examinees", {
      identifier: "DUP-1",
      code: "other-code",
      name: "Second",
    });
    expect(duplicateIdentifier.status).toBe(409);

    const duplicateCode = await jsonPost(app, "/api/v1/examinees", {
      identifier: "DUP-2",
      code: "same-code",
      name: "Third",
    });
    expect(duplicateCode.status).toBe(409);
  });
});

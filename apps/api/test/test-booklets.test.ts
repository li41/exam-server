import {
  createInMemoryItemRepository,
  createInMemoryQuestionBankRepository,
  createInMemoryQuestionStructureRepository,
  createInMemoryTestBookletRepository,
} from "@server-foundation/testing";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { mountQuestionBankRoutes } from "../src/question-bank-routes.js";

const createTestApp = () => {
  const questions = createInMemoryQuestionBankRepository();
  const structures = createInMemoryQuestionStructureRepository(questions);
  const booklets = createInMemoryTestBookletRepository(questions, structures);
  const app = createApp({
    itemRepository: createInMemoryItemRepository(),
    allowUnauthenticatedItems: true,
  });
  mountQuestionBankRoutes(app, {
    repository: questions,
    structureRepository: structures,
    bookletRepository: booklets,
    allowUnauthenticated: true,
  });
  return app;
};

const createGroup = async (
  app: ReturnType<typeof createTestApp>,
  code: string,
) => {
  const response = await app.request("/api/v1/question-groups", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name: `${code} 區塊`, items: [] }),
  });
  expect(response.status).toBe(201);
  return response.json();
};

describe("test booklet API", () => {
  it("stores ordered PHP-style group blocks, preserves PATCH fields, duplicates, and exposes unavailable groups", async () => {
    const app = createTestApp();
    const groupA = await createGroup(app, "BG-A");
    const groupB = await createGroup(app, "BG-B");

    const createResponse = await app.request("/api/v1/test-booklets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: "BOOK-001",
        name: "正式題本",
        subjectId: "legacy-subject-7",
        groupIds: [groupB.id, groupA.id],
      }),
    });
    expect(createResponse.status).toBe(201);
    const booklet = await createResponse.json();
    expect(booklet).toMatchObject({
      code: "BOOK-001",
      name: "正式題本",
      subjectId: "legacy-subject-7",
      status: "enabled",
      version: 1,
      items: [
        { groupId: groupB.id, position: 0, available: true },
        { groupId: groupA.id, position: 1, available: true },
      ],
    });

    const patchResponse = await app.request(`/api/v1/test-booklets/${booklet.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "只改題本名稱", version: booklet.version }),
    });
    expect(patchResponse.status).toBe(200);
    const patched = await patchResponse.json();
    expect(patched).toMatchObject({
      name: "只改題本名稱",
      subjectId: "legacy-subject-7",
      status: "enabled",
      items: booklet.items,
      version: 2,
    });

    const duplicateResponse = await app.request(
      `/api/v1/test-booklets/${booklet.id}/duplicate`,
      { method: "POST" },
    );
    expect(duplicateResponse.status).toBe(201);
    const duplicate = await duplicateResponse.json();
    expect(duplicate).toMatchObject({
      subjectId: "legacy-subject-7",
      status: "disabled",
      items: booklet.items,
      version: 1,
    });
    expect(duplicate.id).not.toBe(booklet.id);
    expect(duplicate.code).not.toBe(booklet.code);

    const deleteGroup = await app.request(
      `/api/v1/question-groups/${groupB.id}?version=${groupB.version}`,
      { method: "DELETE" },
    );
    expect(deleteGroup.status).toBe(204);

    const readAfterDelete = await app.request(`/api/v1/test-booklets/${booklet.id}`);
    expect(readAfterDelete.status).toBe(200);
    expect(await readAfterDelete.json()).toMatchObject({
      items: [
        { groupId: groupB.id, available: false },
        { groupId: groupA.id, available: true },
      ],
    });
  });

  it("rejects missing group and category references with explicit validation errors", async () => {
    const app = createTestApp();
    const missingGroup = await app.request("/api/v1/test-booklets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: "BOOK-MISSING-GROUP",
        name: "錯誤題本",
        groupIds: ["missing-group"],
      }),
    });
    expect(missingGroup.status).toBe(400);
    expect(await missingGroup.json()).toMatchObject({
      error: {
        code: "validation_error",
        message: 'Test booklet groupId "missing-group" does not exist.',
      },
    });

    const missingCategory = await app.request("/api/v1/test-booklets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: "BOOK-MISSING-CAT",
        name: "錯誤科目",
        categoryId: "missing-category",
      }),
    });
    expect(missingCategory.status).toBe(400);
    expect(await missingCategory.json()).toMatchObject({
      error: {
        code: "validation_error",
        message: 'Test booklet categoryId "missing-category" does not exist.',
      },
    });
  });
});

import type { CreateQuestionInput } from "@server-foundation/api-contracts";
import type { BlobStorage } from "@server-foundation/domain";
import {
  createInMemoryItemRepository,
  createInMemoryQuestionBankRepository,
} from "@server-foundation/testing";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { QuestionAwareBlobStorage } from "../src/question-aware-blob-storage.js";
import { mountQuestionBankRoutes } from "../src/question-bank-routes.js";

const createTestApp = () => {
  const questionBank = createInMemoryQuestionBankRepository();
  const app = createApp({
    itemRepository: createInMemoryItemRepository(),
    allowUnauthenticatedItems: true,
  });
  mountQuestionBankRoutes(app, {
    repository: questionBank,
    allowUnauthenticated: true,
  });
  return app;
};

const singleChoice = (
  overrides: Partial<CreateQuestionInput> = {},
): CreateQuestionInput => ({
  code: "Q-001",
  type: "single_choice",
  difficulty: 3,
  stem: "2 + 2 = ?",
  options: [
    { id: "a", text: "3" },
    { id: "b", text: "4" },
  ],
  answer: { value: "b" },
  explanation: "四。",
  aiRubric: null,
  points: 1,
  tags: ["數學"],
  status: "enabled",
  media: [],
  ...overrides,
});

describe("question bank API", () => {
  it("creates a two-level category and filters questions by the parent", async () => {
    const app = createTestApp();
    const parentResponse = await app.request("/api/question-categories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "數學", parentId: null, sortOrder: 1 }),
    });
    expect(parentResponse.status).toBe(201);
    const parent = await parentResponse.json();

    const childResponse = await app.request("/api/question-categories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "代數",
        parentId: parent.id,
        sortOrder: 1,
      }),
    });
    expect(childResponse.status).toBe(201);
    const child = await childResponse.json();

    const createResponse = await app.request("/api/questions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(singleChoice({ categoryId: child.id })),
    });
    expect(createResponse.status).toBe(201);
    const question = await createResponse.json();
    expect(question).toMatchObject({
      code: "Q-001",
      categoryId: child.id,
      createdBy: "local-development-user",
      version: 1,
      tenantId: "local-development-tenant",
    });

    const listResponse = await app.request(
      `/api/questions?categoryId=${encodeURIComponent(parent.id)}&limit=20`,
    );
    expect(listResponse.status).toBe(200);
    const page = await listResponse.json();
    expect(page.items.map((entry: { id: string }) => entry.id)).toEqual([
      question.id,
    ]);
  });

  it("applies the PHP single-choice validation rule", async () => {
    const app = createTestApp();
    const response = await app.request("/api/questions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(singleChoice({ answer: { value: "missing" } })),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "validation_error" },
    });
  });

  it("PATCH 只送部分欄位時,沒送的欄位保持原值(不被預設值清掉)", async () => {
    // ⚠️ 這條守的是 zod 的一個陷阱：`.partial()` **不會拿掉內層的 `.default()`**。
    //    若可寫欄位的基底帶預設值，PATCH 只送 `{ stem, version }` 也會把
    //    tags 清成 []、status 重設成 enabled、points 重設成 1 —— 而且**不報錯**。
    //    2026-08-15 這個缺陷真的存在過；當時唯一露出來的症狀是 options 被清成 null
    //    後撞到「選項至少兩個」的驗證而回 400。那是**運氣**：
    //    tags / status / points 沒有驗證擋，會靜默被清掉。
    const app = createTestApp();
    const createdResponse = await app.request("/api/questions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        singleChoice({
          tags: ["數學", "四則運算"],
          status: "disabled",
          points: 7.5,
          explanation: "原本的解析",
        }),
      ),
    });
    const created = await createdResponse.json();

    const patched = await app.request(`/api/questions/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stem: "只改題幹", version: created.version }),
    });
    expect(patched.status).toBe(200);

    const after = await patched.json();
    expect(after.stem).toBe("只改題幹");
    expect(after.tags).toEqual(["數學", "四則運算"]);
    expect(after.status).toBe("disabled");
    expect(after.points).toBe(7.5);
    expect(after.explanation).toBe("原本的解析");
    expect(after.options).toEqual(created.options);
    expect(after.answer).toEqual(created.answer);
  });

  it("keeps optimistic versioning and rejects a stale update", async () => {
    const app = createTestApp();
    const createdResponse = await app.request("/api/questions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(singleChoice()),
    });
    const created = await createdResponse.json();

    const updateResponse = await app.request(`/api/questions/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stem: "更新題幹", version: created.version }),
    });
    expect(updateResponse.status).toBe(200);
    expect(await updateResponse.json()).toMatchObject({
      stem: "更新題幹",
      version: 2,
    });

    const staleResponse = await app.request(`/api/questions/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stem: "過期更新", version: created.version }),
    });
    expect(staleResponse.status).toBe(409);
  });

  it("stores existing file ids as question media without creating upload APIs", async () => {
    const app = createTestApp();
    const response = await app.request("/api/questions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        singleChoice({
          code: "Q-MEDIA",
          media: [
            {
              fileId: "existing-file-id",
              role: "stem",
              optionId: null,
              position: 0,
            },
          ],
        }),
      ),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      media: [
        { fileId: "existing-file-id", role: "stem", available: true },
      ],
    });
  });

  it("lists active questions that reference a file before deletion", async () => {
    const app = createTestApp();
    await app.request("/api/questions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        singleChoice({
          code: "Q-MEDIA-REF",
          media: [
            {
              fileId: "file-to-check",
              role: "stem",
              optionId: null,
              position: 0,
            },
          ],
        }),
      ),
    });
    await app.request("/api/questions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(singleChoice({ code: "Q-WITHOUT-MEDIA" })),
    });

    const response = await app.request(
      "/api/questions?fileId=file-to-check&limit=20",
    );
    expect(response.status).toBe(200);
    const page = await response.json();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ code: "Q-MEDIA-REF" });
  });

  it("soft-deletes questions and permits reusing their company-scoped code", async () => {
    const app = createTestApp();
    const firstResponse = await app.request("/api/questions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(singleChoice()),
    });
    const first = await firstResponse.json();

    const deleteResponse = await app.request(
      `/api/questions/${first.id}?version=${first.version}`,
      { method: "DELETE" },
    );
    expect(deleteResponse.status).toBe(204);
    expect((await app.request(`/api/questions/${first.id}`)).status).toBe(404);

    const reused = await app.request("/api/questions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(singleChoice()),
    });
    expect(reused.status).toBe(201);
  });

  it("prevents a third category level", async () => {
    const app = createTestApp();
    const root = await (
      await app.request("/api/question-categories", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "根", parentId: null }),
      })
    ).json();
    const child = await (
      await app.request("/api/question-categories", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "子", parentId: root.id }),
      })
    ).json();

    const response = await app.request("/api/question-categories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "孫", parentId: child.id }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "validation_error" },
    });
  });

  it("blocks deleting a file while an active question references it", async () => {
    const repository = createInMemoryQuestionBankRepository();
    const scope = {
      tenantId: "company-opaque",
      actorUserId: "user-1",
    };
    await repository.createQuestion(
      singleChoice({
        code: "Q-FILE-GUARD",
        media: [
          {
            fileId: "file-guard",
            role: "stem",
            optionId: null,
            position: 0,
          },
        ],
      }),
      scope,
    );
    let deleted = false;
    const inner = {
      delete: async () => {
        deleted = true;
      },
    } as unknown as BlobStorage;
    const storage = new QuestionAwareBlobStorage(inner, repository);

    await expect(
      storage.delete("file-guard", {
        userId: "user-1",
        tenantId: "company-opaque",
        roles: ["member"],
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining(
        "/api/v1/questions?fileId=file-guard",
      ),
    });
    expect(deleted).toBe(false);
  });
});

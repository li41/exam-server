import type { CreateQuestionInput } from "@server-foundation/api-contracts";
import {
  createInMemoryItemRepository,
  createInMemoryQuestionBankRepository,
  createInMemoryQuestionStructureRepository,
} from "@server-foundation/testing";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { mountQuestionBankRoutes } from "../src/question-bank-routes.js";

const singleChoice = (
  code: string,
  overrides: Partial<CreateQuestionInput> = {},
): CreateQuestionInput => ({
  code,
  type: "single_choice",
  difficulty: 3,
  stem: `${code}: 2 + 2 = ?`,
  options: [
    { id: "a", text: "3" },
    { id: "b", text: "4" },
  ],
  answer: { value: "b" },
  explanation: null,
  aiRubric: null,
  points: 1,
  tags: ["structure-test"],
  status: "enabled",
  media: [],
  ...overrides,
});

const createTestApp = () => {
  const questions = createInMemoryQuestionBankRepository();
  const structures = createInMemoryQuestionStructureRepository(questions);
  const app = createApp({
    itemRepository: createInMemoryItemRepository(),
    allowUnauthenticatedItems: true,
  });
  mountQuestionBankRoutes(app, {
    repository: questions,
    structureRepository: structures,
    allowUnauthenticated: true,
  });
  return app;
};

const createQuestion = async (app: ReturnType<typeof createTestApp>, code: string) => {
  const response = await app.request("/api/v1/questions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(singleChoice(code)),
  });
  expect(response.status).toBe(201);
  return response.json();
};

describe("question cluster API", () => {
  it("stores ordered child questions, preserves omitted PATCH fields, and exposes orphaned relations", async () => {
    const app = createTestApp();
    const question = await createQuestion(app, "CL-Q1");

    const createResponse = await app.request("/api/v1/question-clusters", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: "CL-001",
        name: "閱讀題組",
        stem: "共同閱讀素材",
        questionIds: [question.id],
      }),
    });
    expect(createResponse.status).toBe(201);
    const cluster = await createResponse.json();
    expect(cluster).toMatchObject({
      code: "CL-001",
      name: "閱讀題組",
      stem: "共同閱讀素材",
      version: 1,
      items: [{ questionId: question.id, position: 0, available: true }],
    });

    const patchResponse = await app.request(
      `/api/v1/question-clusters/${cluster.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "只改名稱", version: cluster.version }),
      },
    );
    expect(patchResponse.status).toBe(200);
    const patched = await patchResponse.json();
    expect(patched).toMatchObject({
      name: "只改名稱",
      stem: "共同閱讀素材",
      status: "enabled",
      items: [{ questionId: question.id, available: true }],
      version: 2,
    });

    const deleteQuestion = await app.request(
      `/api/v1/questions/${question.id}?version=${question.version}`,
      { method: "DELETE" },
    );
    expect(deleteQuestion.status).toBe(204);

    const readAfterQuestionDelete = await app.request(
      `/api/v1/question-clusters/${cluster.id}`,
    );
    expect(readAfterQuestionDelete.status).toBe(200);
    expect(await readAfterQuestionDelete.json()).toMatchObject({
      items: [{ questionId: question.id, available: false }],
    });
  });

  it("rejects a missing child question", async () => {
    const app = createTestApp();
    const response = await app.request("/api/v1/question-clusters", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: "CL-MISSING",
        name: "錯誤題組",
        stem: "共同素材",
        questionIds: ["missing-question"],
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "validation_error",
        message: expect.stringContaining("missing-question"),
      },
    });
  });
});

describe("question group API", () => {
  it("mixes standalone questions and clusters while blocking PHP duplicate-content conflicts", async () => {
    const app = createTestApp();
    const clusterQuestion = await createQuestion(app, "GR-Q1");
    const standaloneQuestion = await createQuestion(app, "GR-Q2");

    const clusterResponse = await app.request("/api/v1/question-clusters", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: "CL-GROUP",
        name: "群組內題組",
        stem: "共同素材",
        questionIds: [clusterQuestion.id],
      }),
    });
    const cluster = await clusterResponse.json();

    const conflictResponse = await app.request("/api/v1/question-groups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: "GR-CONFLICT",
        name: "重複內容",
        items: [
          { itemType: "cluster", clusterId: cluster.id },
          { itemType: "question", questionId: clusterQuestion.id },
        ],
      }),
    });
    expect(conflictResponse.status).toBe(409);

    const createResponse = await app.request("/api/v1/question-groups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: "GR-001",
        name: "正式區塊",
        flowMode: "shuffle",
        items: [
          { itemType: "cluster", clusterId: cluster.id },
          { itemType: "question", questionId: standaloneQuestion.id },
        ],
      }),
    });
    expect(createResponse.status).toBe(201);
    const group = await createResponse.json();
    expect(group).toMatchObject({
      flowMode: "shuffle",
      items: [
        {
          itemType: "cluster",
          clusterId: cluster.id,
          position: 0,
          available: true,
        },
        {
          itemType: "question",
          questionId: standaloneQuestion.id,
          position: 1,
          available: true,
        },
      ],
    });

    const patchResponse = await app.request(`/api/v1/question-groups/${group.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "只改區塊名稱", version: group.version }),
    });
    expect(patchResponse.status).toBe(200);
    expect(await patchResponse.json()).toMatchObject({
      name: "只改區塊名稱",
      flowMode: "shuffle",
      items: group.items,
      version: 2,
    });

    const deleteClusterWhileReferenced = await app.request(
      `/api/v1/question-clusters/${cluster.id}?version=${cluster.version}`,
      { method: "DELETE" },
    );
    expect(deleteClusterWhileReferenced.status).toBe(409);
  });

  it("filters groups by flow mode", async () => {
    const app = createTestApp();
    for (const [code, flowMode] of [
      ["GR-NORMAL", "normal"],
      ["GR-SKIP", "skip"],
    ] as const) {
      const response = await app.request("/api/v1/question-groups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, name: code, flowMode }),
      });
      expect(response.status).toBe(201);
    }

    const response = await app.request(
      "/api/v1/question-groups?flowMode=skip&limit=20",
    );
    expect(response.status).toBe(200);
    const page = await response.json();
    expect(page.items.map((item: { code: string }) => item.code)).toEqual([
      "GR-SKIP",
    ]);
  });
});

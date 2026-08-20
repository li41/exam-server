import type { CreateQuestionInput } from "@server-foundation/api-contracts";
import {
  QuestionListResponseSchema,
  QuestionStatsResponseSchema,
  QuestionTypeSchema,
} from "@server-foundation/api-contracts";
import type { QuestionBankScope } from "@server-foundation/domain";
import { questionStatsFromCounts } from "@server-foundation/domain";
import {
  createInMemoryItemRepository,
  createInMemoryQuestionBankRepository,
} from "@server-foundation/testing";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { mountQuestionBankRoutes } from "../src/question-bank-routes.js";

/**
 * `allowUnauthenticated: true` 時 route 用的是 `localDevelopmentIdentity`
 * （`src/question-bank-routes.ts:98-103`）⇒ 這兩個常數必須與它一致，
 * 否則 seed 進去的題目會落在別的 tenant 而查不到。
 */
const DEV_TENANT = "local-development-tenant";
const DEV_USER = "local-development-user";
const OTHER_USER = "another-user";

const createTestContext = () => {
  const repository = createInMemoryQuestionBankRepository();
  const app = createApp({
    itemRepository: createInMemoryItemRepository(),
    allowUnauthenticatedItems: true,
  });
  mountQuestionBankRoutes(app, { repository, allowUnauthenticated: true });
  return { app, repository };
};

const question = (
  overrides: Partial<CreateQuestionInput> = {},
): CreateQuestionInput => ({
  code: "Q-001",
  categoryId: null,
  type: "single_choice",
  difficulty: 3,
  stem: "2 + 2 = ?",
  options: [
    { id: "a", text: "3" },
    { id: "b", text: "4" },
  ],
  answer: { value: "b" },
  explanation: null,
  aiRubric: null,
  points: 1,
  tags: [],
  status: "enabled",
  media: [],
  ...overrides,
});

const scopeOf = (actorUserId: string): QuestionBankScope => ({
  tenantId: DEV_TENANT,
  actorUserId,
});

describe("題庫統計端點", () => {
  it("GET /questions/stats 不會被 /questions/:id 吃掉", async () => {
    const { app } = createTestContext();

    const stats = await app.request("/api/v1/questions/stats");
    expect(stats.status).toBe(200);
    expect(
      QuestionStatsResponseSchema.safeParse(await stats.json()).success,
    ).toBe(true);

    // 反向對照：真的不存在的 id 才是 404 ⇒ 上面那個 200 不是「什麼都回 200」。
    const missing = await app.request("/api/v1/questions/not-a-real-id");
    expect(missing.status).toBe(404);
  });

  it("空題庫時十四種題型全部回 0，⛔ 不是空物件", async () => {
    const { app } = createTestContext();

    const response = await app.request("/api/v1/questions/stats");
    const body = await response.json();

    expect(body.total).toBe(0);
    expect(Object.keys(body.byType).sort()).toEqual(
      [...QuestionTypeSchema.options].sort(),
    );
    expect(Object.values(body.byType).every((count) => count === 0)).toBe(true);
  });

  it("逐題型計數與總數一致，且總數等於逐型之和", async () => {
    const { app, repository } = createTestContext();
    await repository.createQuestion(
      question({ code: "Q-1", type: "single_choice" }),
      scopeOf(DEV_USER),
    );
    await repository.createQuestion(
      question({ code: "Q-2", type: "single_choice" }),
      scopeOf(DEV_USER),
    );
    await repository.createQuestion(
      question({
        code: "Q-3",
        type: "true_false",
        options: null,
        answer: { value: true },
      }),
      scopeOf(DEV_USER),
    );

    const body = await (await app.request("/api/v1/questions/stats")).json();

    expect(body.byType.single_choice).toBe(2);
    expect(body.byType.true_false).toBe(1);
    expect(body.byType.matching).toBe(0);
    expect(body.total).toBe(3);
    expect(
      Object.values(body.byType).reduce(
        (sum: number, count) => sum + Number(count),
        0,
      ),
    ).toBe(body.total);
  });

  it("createdBy 會收窄統計，且與清單的總筆數對得上", async () => {
    const { app, repository } = createTestContext();
    await repository.createQuestion(
      question({ code: "MINE-1" }),
      scopeOf(DEV_USER),
    );
    await repository.createQuestion(
      question({ code: "MINE-2" }),
      scopeOf(DEV_USER),
    );
    await repository.createQuestion(
      question({ code: "THEIRS-1" }),
      scopeOf(OTHER_USER),
    );

    const all = await (await app.request("/api/v1/questions/stats")).json();
    expect(all.total).toBe(3);

    const mine = await (
      await app.request(`/api/v1/questions/stats?createdBy=${DEV_USER}`)
    ).json();
    expect(mine.total).toBe(2);
    expect(mine.byType.single_choice).toBe(2);

    const theirs = await (
      await app.request(`/api/v1/questions/stats?createdBy=${OTHER_USER}`)
    ).json();
    expect(theirs.total).toBe(1);

    // 🔴 這是「我只看得到 3 題但統計說 500 題」那個缺陷的守門：
    //    同一組收窄條件下，統計的 total 必須等於清單的 page.total。
    const listed = await (
      await app.request(`/api/v1/questions?createdBy=${DEV_USER}`)
    ).json();
    expect(listed.page.total).toBe(mine.total);
  });

  it("統計⛔不吃題型篩選（否則其他題型會被歸零）", async () => {
    const { app, repository } = createTestContext();
    await repository.createQuestion(
      question({ code: "Q-1", type: "single_choice" }),
      scopeOf(DEV_USER),
    );
    await repository.createQuestion(
      question({
        code: "Q-2",
        type: "true_false",
        options: null,
        answer: { value: true },
      }),
      scopeOf(DEV_USER),
    );

    const body = await (
      await app.request("/api/v1/questions/stats?type=single_choice")
    ).json();

    expect(body.total).toBe(2);
    expect(body.byType.true_false).toBe(1);
  });
});

describe("questionStatsFromCounts（兩個 repository 共用的零填）", () => {
  it("十四型齊全，缺的填 0", () => {
    const stats = questionStatsFromCounts([
      { type: "matching", count: 2 },
      { type: "sorting", count: 1 },
    ]);
    expect(Object.keys(stats.byType).sort()).toEqual(
      [...QuestionTypeSchema.options].sort(),
    );
    expect(stats.byType.matching).toBe(2);
    expect(stats.byType.single_choice).toBe(0);
    expect(stats.total).toBe(3);
  });

  it("繞過契約寫進去的未知題型：計入 total、不計入 byType", () => {
    // ⚠️ 這是**刻意**的取捨，不是漏寫：`questions.type` 是 VARCHAR 沒有 CHECK，
    //    寧可讓總數是對的、那一列在逐型分佈裡看不到，
    //    ⛔ 也不要把使用者真的擁有的題目從總數裡吞掉。
    const stats = questionStatsFromCounts([
      { type: "single_choice", count: 1 },
      { type: "not_a_real_type", count: 5 },
    ]);
    expect(stats.total).toBe(6);
    expect(stats.byType.single_choice).toBe(1);
    expect(Object.keys(stats.byType)).not.toContain("not_a_real_type");
  });
});

describe("題目清單的總筆數", () => {
  it("page.total 是套完篩選但不套分頁的筆數，翻頁時不變", async () => {
    const { app, repository } = createTestContext();
    for (const code of ["Q-1", "Q-2", "Q-3"]) {
      await repository.createQuestion(question({ code }), scopeOf(DEV_USER));
    }

    const firstResponse = await app.request("/api/v1/questions?limit=1");
    const first = await firstResponse.json();
    expect(QuestionListResponseSchema.safeParse(first).success).toBe(true);
    expect(first.items).toHaveLength(1);
    expect(first.page.total).toBe(3);
    expect(first.page.nextCursor).not.toBeNull();

    const second = await (
      await app.request(
        `/api/v1/questions?limit=1&cursor=${encodeURIComponent(first.page.nextCursor)}`,
      )
    ).json();
    expect(second.items).toHaveLength(1);
    expect(second.page.total).toBe(3);
  });

  it("page.total 跟著篩選收窄", async () => {
    const { app, repository } = createTestContext();
    await repository.createQuestion(
      question({ code: "Q-1", type: "single_choice" }),
      scopeOf(DEV_USER),
    );
    await repository.createQuestion(
      question({
        code: "Q-2",
        type: "true_false",
        options: null,
        answer: { value: true },
      }),
      scopeOf(DEV_USER),
    );

    const filtered = await (
      await app.request("/api/v1/questions?type=true_false")
    ).json();
    expect(filtered.items).toHaveLength(1);
    expect(filtered.page.total).toBe(1);

    const unfiltered = await (await app.request("/api/v1/questions")).json();
    expect(unfiltered.page.total).toBe(2);
  });
});

import {
  QUESTIONS_ALL_ROLE,
  QUESTIONS_OWN_ROLE,
  unnarrowedQuestionScope,
  visibleQuestionOwnerIdFor,
} from "@server-foundation/domain";
import {
  createInMemoryQuestionBankRepository,
  createInMemoryQuestionImportRepository,
} from "@server-foundation/testing";
import { describe, expect, it } from "vitest";

/**
 * 「角色 → 題庫可見範圍」的對照表本身（`#101`）。
 *
 * ⚠️ 這一支**不是**鑑別力證據：它 import 的常數在改動前的樹上不存在，
 * 所以放到舊樹上會整支載不起來——那比「行為錯誤被抓到」弱一級。
 * 行為面的鑑別力在 `question-bank-owner-scope.test.ts`（那一支刻意用字面值、
 * 在舊樹上載得起來）。這一支守的是**判準本身**不被靜默改寫。
 */
describe("角色 → 可見範圍的對照表", () => {
  const owner = (roles: string[]) =>
    visibleQuestionOwnerIdFor({ userId: "u-1", roles });

  it("`questions_own` ⇒ 只看自己", () => {
    expect(owner([QUESTIONS_OWN_ROLE])).toBe("u-1");
  });

  it("`questions_all` ⇒ 看全部", () => {
    expect(owner([QUESTIONS_ALL_ROLE])).toBe(null);
  });

  it("兩個都有 ⇒ 看全部（`questions_all` 勝，與 PHP `canViewAllQuestions()` 同）", () => {
    expect(owner([QUESTIONS_OWN_ROLE, QUESTIONS_ALL_ROLE])).toBe(null);
    // ⚠️ 順序反過來也要一樣，⛔ 不可以變成「陣列裡誰在前面誰贏」。
    expect(owner([QUESTIONS_ALL_ROLE, QUESTIONS_OWN_ROLE])).toBe(null);
  });

  it("🔴 兩個都沒有 ⇒ 看全部（既有帳號的預設，⛔ 不是只看自己、也⛔不是拒絕）", () => {
    expect(owner(["developer"])).toBe(null);
    expect(owner(["owner", "member"])).toBe(null);
    expect(owner([])).toBe(null);
  });

  it("其他角色名不會誤觸收窄", () => {
    // ⚠️ 逐字比對，⛔ 不是前綴／子字串比對。
    expect(owner(["questions_ownx"])).toBe(null);
    expect(owner(["xquestions_own"])).toBe(null);
    expect(owner(["QUESTIONS_OWN"])).toBe(null);
  });

  it("角色名與 PHP 逐字同名（`CompanyMember::PERM_QUESTIONS_*`）", () => {
    expect(QUESTIONS_ALL_ROLE).toBe("questions_all");
    expect(QUESTIONS_OWN_ROLE).toBe("questions_own");
  });

  it("`unnarrowedQuestionScope()` 只補上 `null`，⛔ 不動 tenant 與 actor", () => {
    expect(
      unnarrowedQuestionScope({ tenantId: "t-1", actorUserId: "u-9" }),
    ).toEqual({
      tenantId: "t-1",
      actorUserId: "u-9",
      visibleQuestionOwnerId: null,
    });
  });
});

describe("⛔ 刻意不收窄：匯入的 code 唯一性檢查", () => {
  it("看得到別人已經佔用的題目 code（題目 code 在租戶內唯一）", async () => {
    const questions = createInMemoryQuestionBankRepository();
    const imports = createInMemoryQuestionImportRepository(questions);
    const tenantId = "import-tenant";
    await questions.createQuestion(
      {
        code: "DUP-1",
        categoryId: null,
        type: "true_false",
        difficulty: 1,
        stem: "同事的題目",
        options: null,
        answer: { value: true },
        explanation: null,
        aiRubric: null,
        points: 1,
        tags: [],
        status: "enabled",
        media: [],
      },
      { tenantId, actorUserId: "colleague" },
    );

    // 🔴 匯入的人是別人，但那個 code **已經被佔用** ⇒ 必須被判定為既存。
    //    收窄若誤套在這裡，他會看不到 ⇒ 撞資料庫的 duplicate error。
    expect(
      await imports.findExistingQuestionCodes(["DUP-1"], {
        tenantId,
        actorUserId: "importer",
      }),
    ).toEqual(["DUP-1"]);
  });
});

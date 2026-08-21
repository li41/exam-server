import type {
  AuthIdentity,
  CreateQuestionInput,
} from "@server-foundation/api-contracts";
import type {
  AuthenticationService,
  BlobStorage,
} from "@server-foundation/domain";
import { UnauthorizedError } from "@server-foundation/domain";
import {
  createInMemoryItemRepository,
  createInMemoryQuestionBankRepository,
} from "@server-foundation/testing";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { QuestionAwareBlobStorage } from "../src/question-aware-blob-storage.js";
import { mountQuestionBankRoutes } from "../src/question-bank-routes.js";

/**
 * 題庫的擁有者收窄（`#101`，主公 2026-08-21 裁示走丙：權限由院內自管）。
 *
 * 🔴 這一整支的驗收判準是**鑑別力**：整支原封不動放到改動前的樹上必須紅。
 * ⇒ 所以每一案斷言的都是**行為**（HTTP 狀態碼、看得到幾筆、統計幾筆、
 *   資料有沒有真的被改掉），⛔ 沒有一案是靠「某個新常數／新欄位不存在」才紅的。
 *
 * ⚠️ 收窄是**選擇性加上去**的：`roles` 不含 `questions_own` 的帳號（今天所有帳號）
 * 行為與收窄前完全相同。第 5、6 案就是防止有人把它做成「一律只看自己」。
 */
/**
 * 🔴 這兩個角色名在這支檔案裡是**逐字字面值**，⛔ 刻意不從 domain import 常數。
 * 兩個理由：
 * 1. 它們是**對外的授權契約**（與 PHP `CompanyMember::PERM_QUESTIONS_*` 逐字同名）
 *    ——常數改名時這支要紅，⛔ 不該跟著一起改名而靜默通過。
 * 2. 這支檔案因此**在改動前的樹上也載得起來** ⇒ 鑑別力驗證時紅的是行為
 *    （404／筆數／統計），⛔ 不是「新常數不存在所以整支爆掉」。
 *    常數本身與對照表在 `question-visibility.test.ts`。
 */
const ROLE_QUESTIONS_OWN = "questions_own";
const ROLE_QUESTIONS_ALL = "questions_all";

const TENANT = "owner-scope-tenant";
const OTHER_TENANT = "owner-scope-other-tenant";

const OWN_ONLY = "user-own-only";
const VIEW_ALL = "user-view-all";
const LEGACY = "user-legacy-no-question-roles";
const COLLEAGUE = "user-colleague";

const identityOf = (userId: string, roles: string[]): AuthIdentity => ({
  userId,
  email: `${userId}@example.invalid`,
  tenantId: TENANT,
  roles,
});

const IDENTITIES: Record<string, AuthIdentity> = {
  // 被收窄的帳號：只看自己建立的題目。
  "token-own": identityOf(OWN_ONLY, [ROLE_QUESTIONS_OWN]),
  // 明確授予「可看全部」。
  "token-all": identityOf(VIEW_ALL, [ROLE_QUESTIONS_ALL]),
  // 🔴 既有帳號：兩個題庫角色都沒有 ⇒ 必須維持「看得到全部」。
  //    這是「migration 之後現存帳號行為與今天完全相同」那一案的身分。
  "token-legacy": identityOf(LEGACY, ["developer"]),
  // 同事，用來製造「別人建立的題目」。
  "token-colleague": identityOf(COLLEAGUE, ["developer"]),
  // 另一個租戶，用來確認 tenant 那一層沒有被本輪改動弄鬆。
  "token-other-tenant": {
    ...identityOf("user-other-tenant", [ROLE_QUESTIONS_ALL]),
    tenantId: OTHER_TENANT,
  },
};

const notUsed = (): never => {
  throw new Error("這支測試只用 authenticate()。");
};

const authenticationService: AuthenticationService = {
  authenticate: async (accessToken: string) => {
    const identity = IDENTITIES[accessToken];
    if (!identity) throw new UnauthorizedError();
    return identity;
  },
  login: notUsed,
  refresh: notUsed,
  logout: notUsed,
};

const createTestContext = () => {
  const repository = createInMemoryQuestionBankRepository();
  const app = createApp({
    itemRepository: createInMemoryItemRepository(),
    allowUnauthenticatedItems: true,
  });
  mountQuestionBankRoutes(app, { repository, authenticationService });
  const as = (token: string, path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        authorization: `Bearer ${token}`,
      },
    });
  const json = async (token: string, path: string, init?: RequestInit) => {
    const response = await as(token, path, init);
    return { status: response.status, body: await response.json() };
  };
  return { app, repository, as, json };
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

/** 種一顆「別人建立的」題目。⚠️ 建立走 repository，不走 HTTP，因為建立不收窄。 */
const seed = async (
  repository: ReturnType<typeof createInMemoryQuestionBankRepository>,
  actorUserId: string,
  overrides: Partial<CreateQuestionInput> = {},
  tenantId = TENANT,
) =>
  repository.createQuestion(question(overrides), {
    tenantId,
    actorUserId,
  });

describe("題庫擁有者收窄：只看自己建的", () => {
  it("案 1：清單看不到別人建立的題目，`page.total` 也一起收窄", async () => {
    const { repository, json } = createTestContext();
    await seed(repository, OWN_ONLY, { code: "MINE-1" });
    await seed(repository, OWN_ONLY, { code: "MINE-2" });
    await seed(repository, COLLEAGUE, { code: "THEIRS-1" });
    await seed(repository, COLLEAGUE, { code: "THEIRS-2" });
    await seed(repository, COLLEAGUE, { code: "THEIRS-3" });

    const { status, body } = await json("token-own", "/api/v1/questions");

    expect(status).toBe(200);
    expect(
      body.items.map((item: { code: string }) => item.code).sort(),
    ).toEqual(["MINE-1", "MINE-2"]);
    // 🔴 `total` 必須一起收窄：「我只看得到 2 筆但總數說 5 筆」比沒有總數更糟。
    expect(body.page.total).toBe(2);
  });

  it("案 2：直接帶別人的 id 讀不到（404，⛔ 不是 200）", async () => {
    const { repository, json, as } = createTestContext();
    const theirs = await seed(repository, COLLEAGUE, { code: "THEIRS-1" });
    const mine = await seed(repository, OWN_ONLY, { code: "MINE-1" });

    const blocked = await as("token-own", `/api/v1/questions/${theirs.id}`);
    expect(blocked.status).toBe(404);

    // 反向對照：同一條路徑讀自己的題目是 200
    // ⇒ 上面那個 404 不是「這條路由壞了」。
    const own = await json("token-own", `/api/v1/questions/${mine.id}`);
    expect(own.status).toBe(200);
    expect(own.body.code).toBe("MINE-1");
  });

  it("案 3：改不了也刪不了別人的題目，而且資料真的沒被動到", async () => {
    const { repository, as, json } = createTestContext();
    const theirs = await seed(repository, COLLEAGUE, { code: "THEIRS-1" });

    const patched = await as("token-own", `/api/v1/questions/${theirs.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: theirs.version,
        stem: "被別人改掉的題幹",
      }),
    });
    expect(patched.status).toBe(404);

    const deleted = await as(
      "token-own",
      `/api/v1/questions/${theirs.id}?version=${theirs.version}`,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(404);

    // 🔴 光看狀態碼不夠：用「可看全部」的身分回頭確認那一筆**原封不動**還在。
    const survivor = await json("token-all", `/api/v1/questions/${theirs.id}`);
    expect(survivor.status).toBe(200);
    expect(survivor.body.stem).toBe("2 + 2 = ?");
    expect(survivor.body.version).toBe(theirs.version);
    expect(survivor.body.deletedAt).toBe(null);
  });

  it("案 3b：拿別人的 id 配錯的 version，回 404 ⛔ 不是 409（409 等於承認那個 id 存在）", async () => {
    const { repository, as } = createTestContext();
    const theirs = await seed(repository, COLLEAGUE, { code: "THEIRS-1" });

    const patched = await as("token-own", `/api/v1/questions/${theirs.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: theirs.version + 99, stem: "亂改" }),
    });
    expect(patched.status).toBe(404);

    // 反向對照：**自己的**題目配錯的 version 才該是 409
    // ⇒ 證明 404 是收窄造成的，不是「這條路徑一律回 404」。
    const mine = await seed(repository, OWN_ONLY, { code: "MINE-1" });
    const conflict = await as("token-own", `/api/v1/questions/${mine.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: mine.version + 99, stem: "亂改" }),
    });
    expect(conflict.status).toBe(409);
  });

  it("案 4：統計只算自己的，而且與清單的 `total` 對得上", async () => {
    const { repository, json } = createTestContext();
    await seed(repository, OWN_ONLY, { code: "MINE-1", type: "true_false" });
    await seed(repository, OWN_ONLY, { code: "MINE-2" });
    await seed(repository, COLLEAGUE, { code: "THEIRS-1" });
    await seed(repository, COLLEAGUE, { code: "THEIRS-2", type: "true_false" });

    const stats = await json("token-own", "/api/v1/questions/stats");
    const list = await json("token-own", "/api/v1/questions");

    expect(stats.status).toBe(200);
    expect(stats.body.total).toBe(2);
    expect(stats.body.byType.single_choice).toBe(1);
    expect(stats.body.byType.true_false).toBe(1);
    // 🔴 統計與清單必須同一個母體。
    expect(stats.body.total).toBe(list.body.page.total);
  });

  it("案 4b：`?createdBy=` 那個查詢參數繞不過收窄", async () => {
    const { repository, json } = createTestContext();
    await seed(repository, COLLEAGUE, { code: "THEIRS-1" });
    await seed(repository, OWN_ONLY, { code: "MINE-1" });

    const list = await json(
      "token-own",
      `/api/v1/questions?createdBy=${COLLEAGUE}`,
    );
    const stats = await json(
      "token-own",
      `/api/v1/questions/stats?createdBy=${COLLEAGUE}`,
    );

    expect(list.body.items).toEqual([]);
    expect(list.body.page.total).toBe(0);
    expect(stats.body.total).toBe(0);
  });

  it("案 5（正向對照）：`questions_all` 的帳號照舊看得到全部", async () => {
    const { repository, json, as } = createTestContext();
    const theirs = await seed(repository, COLLEAGUE, { code: "THEIRS-1" });
    await seed(repository, VIEW_ALL, { code: "MINE-1" });

    const list = await json("token-all", "/api/v1/questions");
    expect(list.body.items.length).toBe(2);
    expect(list.body.page.total).toBe(2);

    const stats = await json("token-all", "/api/v1/questions/stats");
    expect(stats.body.total).toBe(2);

    const single = await as("token-all", `/api/v1/questions/${theirs.id}`);
    expect(single.status).toBe(200);

    // 而且真的改得動別人的題目（＝⛔ 沒有被順手改成「一律只看自己」）。
    const patched = await as("token-all", `/api/v1/questions/${theirs.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: theirs.version, stem: "同事改過的" }),
    });
    expect(patched.status).toBe(200);
  });

  it("案 6（migration 安全）：沒有設定過題庫權限的既有帳號，行為與今天相同", async () => {
    const { repository, json, as } = createTestContext();
    const theirs = await seed(repository, COLLEAGUE, { code: "THEIRS-1" });
    await seed(repository, LEGACY, { code: "MINE-1" });

    // `roles: ["developer"]` ——今天實際部署的樣子，兩個題庫角色都沒有。
    const list = await json("token-legacy", "/api/v1/questions");
    expect(list.body.items.length).toBe(2);
    expect(list.body.page.total).toBe(2);

    const stats = await json("token-legacy", "/api/v1/questions/stats");
    expect(stats.body.total).toBe(2);

    const single = await as("token-legacy", `/api/v1/questions/${theirs.id}`);
    expect(single.status).toBe(200);

    const deleted = await as(
      "token-legacy",
      `/api/v1/questions/${theirs.id}?version=${theirs.version}`,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(204);
  });

  it("案 7：收窄不影響自己新建的題目——建完立刻看得到、也讀得回來", async () => {
    const { as, json } = createTestContext();

    const created = await as("token-own", "/api/v1/questions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(question({ code: "NEW-1" })),
    });
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.createdBy).toBe(OWN_ONLY);

    const single = await json("token-own", `/api/v1/questions/${body.id}`);
    expect(single.status).toBe(200);

    const list = await json("token-own", "/api/v1/questions");
    expect(list.body.page.total).toBe(1);
  });

  it("案 8：租戶隔離仍然在收窄之外獨立成立", async () => {
    const { repository, json, as } = createTestContext();
    const foreign = await seed(
      repository,
      "user-other-tenant",
      { code: "FOREIGN-1" },
      OTHER_TENANT,
    );
    await seed(repository, COLLEAGUE, { code: "THEIRS-1" });

    // 「可看全部」也只在自己的租戶內看得到全部。
    const list = await json("token-all", "/api/v1/questions");
    expect(list.body.items.map((item: { code: string }) => item.code)).toEqual([
      "THEIRS-1",
    ]);
    const single = await as("token-all", `/api/v1/questions/${foreign.id}`);
    expect(single.status).toBe(404);
  });
});

describe("repository 層的縱深防禦（⛔ 不倚賴 service 先讀過一次）", () => {
  /**
   * 🔴 這一組是補 M7 那個第一輪假綠的：`QuestionBankService.updateQuestion()`
   * 會先 `getQuestion()`，所以走 HTTP 時**永遠**在讀那一步就 404 了
   * ⇒ 只測 route 的話，repository 自己的 `UPDATE … AND created_by = ?`
   *   整條拿掉也不會有任何測試變紅。
   * repository 是公開的 port（整合測試與未來的呼叫端會直接打），
   * 所以這裡直接打 repository。
   */
  const ownScope = {
    tenantId: TENANT,
    actorUserId: OWN_ONLY,
    visibleQuestionOwnerId: OWN_ONLY,
  };
  const viewAllScope = {
    tenantId: TENANT,
    actorUserId: OWN_ONLY,
    visibleQuestionOwnerId: null,
  };

  it("直接打 repository 也改不動、刪不掉別人的題目（not_found）", async () => {
    const repository = createInMemoryQuestionBankRepository();
    const theirs = await seed(repository, COLLEAGUE, { code: "THEIRS-1" });

    await expect(
      repository.updateQuestion(
        theirs.id,
        { version: theirs.version, stem: "亂改" },
        ownScope,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      repository.softDeleteQuestion(theirs.id, theirs.version, ownScope),
    ).rejects.toMatchObject({ code: "not_found" });

    const survivor = await repository.getQuestion(theirs.id, viewAllScope);
    expect(survivor?.version).toBe(theirs.version);
    expect(survivor?.stem).toBe("2 + 2 = ?");
    expect(survivor?.deletedAt).toBe(null);
  });

  it("反向對照：不收窄的 scope 改得動、刪得掉同一筆", async () => {
    const repository = createInMemoryQuestionBankRepository();
    const theirs = await seed(repository, COLLEAGUE, { code: "THEIRS-1" });

    const updated = await repository.updateQuestion(
      theirs.id,
      { version: theirs.version, stem: "同事改過的" },
      viewAllScope,
    );
    expect(updated.stem).toBe("同事改過的");
    await repository.softDeleteQuestion(
      theirs.id,
      updated.version,
      viewAllScope,
    );
    expect(await repository.getQuestion(theirs.id, viewAllScope)).toBe(null);
  });
});

describe("⛔ 不得過度收窄的兩處", () => {
  it("『只看自己』的人不得刪掉別人題目正在引用的檔案", async () => {
    const repository = createInMemoryQuestionBankRepository();
    await repository.createQuestion(
      question({
        code: "THEIRS-MEDIA",
        media: [
          { fileId: "file-shared", role: "stem", optionId: null, position: 0 },
        ],
      }),
      { tenantId: TENANT, actorUserId: COLLEAGUE },
    );

    let deleted = false;
    const inner = {
      delete: async () => {
        deleted = true;
      },
    } as unknown as BlobStorage;
    const storage = new QuestionAwareBlobStorage(inner, repository);

    // 🔴 收窄若不小心套進 `isFileReferenced()`，這裡會變成「查不到引用 ⇒ 放它刪掉」，
    //    然後把同事題目的圖弄壞。
    await expect(
      storage.delete("file-shared", {
        userId: OWN_ONLY,
        tenantId: TENANT,
        roles: [ROLE_QUESTIONS_OWN],
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(deleted).toBe(false);
  });

  it("『只看自己』的人不得刪掉別人題目正在使用的分類", async () => {
    const repository = createInMemoryQuestionBankRepository();
    const colleagueScope = { tenantId: TENANT, actorUserId: COLLEAGUE };
    const category = await repository.createCategory(
      { name: "共用分類", parentId: null, sortOrder: 1 },
      colleagueScope,
    );
    await repository.createQuestion(
      question({ code: "THEIRS-CAT", categoryId: category.id }),
      colleagueScope,
    );

    await expect(
      repository.softDeleteCategory(category.id, category.version, {
        tenantId: TENANT,
        actorUserId: OWN_ONLY,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});

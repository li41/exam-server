import type {
  CreateQuestionCategoryInput,
  CreateQuestionInput,
  Question,
  QuestionCategory,
  QuestionCategoryListQuery,
  QuestionListQuery,
  QuestionPage,
  QuestionStats,
  QuestionStatsQuery,
  UpdateQuestionCategoryInput,
  UpdateQuestionInput,
} from "@server-foundation/api-contracts";

/**
 * ⚠️ 名字寫著 question bank，實際上是這個 repo **通用的**「租戶＋操作者」scope：
 * 試務（`affair-*`）、考生（`examinee-*`）、題組／題本／匯入的 port 都 import 它。
 * ⇒ ⛔ 不要把題庫專屬的欄位加到這個型別上，那會讓試務那一族被迫談題目可見範圍。
 *
 * `tenantId` 是租戶隔離鍵（`#101` ⛔ 沒有動它）；`actorUserId` 是寫 `createdBy`
 * （稽核欄位）的人。
 *
 * 題目的**擁有者收窄**在下面的 `QuestionOwnerScope`。
 */
export type QuestionBankScope = {
  tenantId: string;
  actorUserId: string;
};

/**
 * 題目（questions）專用：`QuestionBankScope` 再加一格**擁有者收窄**。
 * 主公 2026-08-21 裁示「走丙：權限由院內自管」之後加的（單號 `#101`；
 * 前一輪的稽核是 `doc/question-bank-authz-gap-audit.md`，判準與理由在
 * `doc/question-bank-owner-scope.md`）。
 *
 * - `visibleQuestionOwnerId === null` ＝ 看得到本租戶全部題目。
 *   **今天所有既有帳號都是這個值** ⇒ 升級後行為與升級前一致。
 * - 字串 ＝ 只看得到 `created_by` 等於它的題目。
 *
 * 唯一的產生處是 `visibleQuestionOwnerIdFor()`（`use-cases/question-visibility.ts`），
 * 那支同時是「角色 → 可見範圍」的唯一對照表。
 * ⛔ 不要在個別 route 或 repository 裡各自再判斷一次角色。
 *
 * 🔴 這一格**刻意是必填**：呼叫端如果忘記傳，型別會當場擋下來，
 * ⛔ 不會默默地看到全部。⛔ 不要改成 optional、⛔ 不要在 repository 裡給預設值。
 *
 * ⚠️ 誠實邊界：只有下面標成吃 `QuestionOwnerScope` 的方法真的收窄。
 * question-clusters／question-groups／test-booklets／question-import 這幾族
 * 今天**完全不收窄**（它們吃的是 `QuestionBankScope`，連這一格都拿不到）
 * —— 逐條登記在 `doc/question-bank-owner-scope.md`。
 * ⇒ ⛔ 不要因為題目收窄了就以為「只看自己建的」對題組／題本也成立。
 */
export type QuestionOwnerScope = QuestionBankScope & {
  visibleQuestionOwnerId: string | null;
};

export interface QuestionBankRepository {
  listQuestions(
    query: QuestionListQuery,
    scope: QuestionOwnerScope,
  ): Promise<QuestionPage>;
  questionStats(
    query: QuestionStatsQuery,
    scope: QuestionOwnerScope,
  ): Promise<QuestionStats>;
  getQuestion(id: string, scope: QuestionOwnerScope): Promise<Question | null>;
  /**
   * ⚠️ 這一支吃的是**不含收窄**的 `QuestionBankScope`，⛔ 不是漏寫：
   * 新建的題目 `created_by` 一律是 `actorUserId`（自己），
   * 「只看自己」的人本來就看得到自己新建的東西 ⇒ 收窄在這裡沒有意義。
   */
  createQuestion(
    input: CreateQuestionInput,
    scope: QuestionBankScope,
  ): Promise<Question>;
  updateQuestion(
    id: string,
    input: UpdateQuestionInput,
    scope: QuestionOwnerScope,
  ): Promise<Question>;
  softDeleteQuestion(
    id: string,
    version: number,
    scope: QuestionOwnerScope,
  ): Promise<void>;

  listCategories(
    query: QuestionCategoryListQuery,
    scope: QuestionBankScope,
  ): Promise<QuestionCategory[]>;
  getCategory(
    id: string,
    scope: QuestionBankScope,
  ): Promise<QuestionCategory | null>;
  createCategory(
    input: CreateQuestionCategoryInput,
    scope: QuestionBankScope,
  ): Promise<QuestionCategory>;
  updateCategory(
    id: string,
    input: UpdateQuestionCategoryInput,
    scope: QuestionBankScope,
  ): Promise<QuestionCategory>;
  softDeleteCategory(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<void>;

  /**
   * 🔴 這一支**刻意不吃** `visibleQuestionOwnerId`，⛔ 不要「順手補齊」。
   *
   * 它回答的是「這個檔案還有題目在引用嗎」，用途是擋掉會把別人題目的圖弄壞的刪檔
   * （`apps/api/src/question-aware-blob-storage.ts`）。一旦收窄，
   * 「只看自己」的使用者就會得到 `false` ⇒ **刪掉別人題目正在用的檔案**。
   * ⇒ 收窄可見範圍是為了少看到東西，不是為了多刪得掉東西。
   */
  isFileReferenced(fileId: string, scope: QuestionBankScope): Promise<boolean>;
}

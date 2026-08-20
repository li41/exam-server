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
 * ⚠️ 這個 scope **今天沒有「可見範圍」這一格**：`tenantId` 是隔離鍵，
 * `actorUserId` 只用來寫 `createdBy`（稽核欄位）。
 * 也就是說同租戶任何已登入者都看得到彼此的題目——這是**登記過的刻意設計**，
 * 見 `doc/question-bank-php-mapping.md:46`，以及本輪的稽核
 * `doc/question-bank-authz-gap-audit.md`（PHP 那側有 `questions_own` 收窄，院內這側沒有）。
 * ⇒ 若日後裁定要補上擁有者收窄，正確做法是在**這個型別**加一格
 * （例如 `visibleQuestionOwnerId: string | null`），統計與列表就會一起吃到；
 * ⛔ 不要在個別 route 各自補判斷。
 */
export type QuestionBankScope = {
  tenantId: string;
  actorUserId: string;
};

export interface QuestionBankRepository {
  listQuestions(
    query: QuestionListQuery,
    scope: QuestionBankScope,
  ): Promise<QuestionPage>;
  questionStats(
    query: QuestionStatsQuery,
    scope: QuestionBankScope,
  ): Promise<QuestionStats>;
  getQuestion(id: string, scope: QuestionBankScope): Promise<Question | null>;
  createQuestion(
    input: CreateQuestionInput,
    scope: QuestionBankScope,
  ): Promise<Question>;
  updateQuestion(
    id: string,
    input: UpdateQuestionInput,
    scope: QuestionBankScope,
  ): Promise<Question>;
  softDeleteQuestion(
    id: string,
    version: number,
    scope: QuestionBankScope,
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

  isFileReferenced(fileId: string, scope: QuestionBankScope): Promise<boolean>;
}

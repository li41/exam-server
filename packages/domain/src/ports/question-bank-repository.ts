import type {
  CreateQuestionCategoryInput,
  CreateQuestionInput,
  Page,
  Question,
  QuestionCategory,
  QuestionCategoryListQuery,
  QuestionListQuery,
  UpdateQuestionCategoryInput,
  UpdateQuestionInput,
} from "@server-foundation/api-contracts";

export type QuestionBankScope = {
  tenantId: string;
  actorUserId: string;
};

export interface QuestionBankRepository {
  listQuestions(
    query: QuestionListQuery,
    scope: QuestionBankScope,
  ): Promise<Page<Question>>;
  getQuestion(
    id: string,
    scope: QuestionBankScope,
  ): Promise<Question | null>;
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

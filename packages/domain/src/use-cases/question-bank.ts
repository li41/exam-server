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
import { DomainError, NotFoundError } from "../errors.js";
import type {
  QuestionBankRepository,
  QuestionBankScope,
} from "../ports/question-bank-repository.js";

type JsonObject = Record<string, unknown>;

const jsonObject = (value: unknown): JsonObject | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;

const optionRows = (value: unknown): JsonObject[] | null =>
  Array.isArray(value) && value.every((entry) => jsonObject(entry) !== null)
    ? (value as JsonObject[])
    : null;

// ⚠️ 型別註記要寫在**變數**上，不能只寫在箭頭的回傳位置。
//    TS 的「呼叫 never 函式之後即收窄」只認變數的顯式型別；
//    寫成 `const f = (x): never => …` 時，`if (!a) f(…)` 之後 `a` 仍是可能為 null。
//    2026-08-15 這裡因此紅了六處，而且 domain 編不過會讓下游全部
//    報「找不到匯出」——症狀在別的套件，病灶在這一行。
const validationError: (message: string) => never = (message: string) => {
  throw new DomainError("validation_error", message);
};

const validateChoiceOptions = (options: unknown): JsonObject[] => {
  const rows = optionRows(options);
  if (!rows || rows.length < 2) {
    return validationError("Choice questions require at least two options.");
  }
  const ids = new Set<string>();
  for (const option of rows) {
    const id = option.id;
    const text = option.text;
    if (typeof id !== "string" || !id.trim()) {
      return validationError("Every choice option requires a non-empty id.");
    }
    if (typeof text !== "string" || !text.trim()) {
      return validationError("Every choice option requires non-empty text.");
    }
    if (ids.has(id))
      return validationError("Choice option ids must be unique.");
    ids.add(id);
  }
  return rows;
};

export const validateKnownQuestionShape = (
  question: Pick<Question, "type" | "options" | "answer">,
): void => {
  const answer = jsonObject(question.answer);
  if (!answer) validationError("Question answer must be a JSON object.");

  if (question.type === "true_false") {
    const value = answer.value;
    if (typeof value !== "boolean" && value !== "true" && value !== "false") {
      validationError(
        "true_false answer.value must be boolean true/false or the strings 'true'/'false'.",
      );
    }
    return;
  }

  if (question.type === "single_choice") {
    const options = validateChoiceOptions(question.options);
    const ids = new Set(options.map((option) => String(option.id)));
    if (typeof answer.value !== "string" || !ids.has(answer.value)) {
      validationError(
        "single_choice answer.value must reference an option id.",
      );
    }
    return;
  }

  if (question.type === "multiple_choice") {
    const options = validateChoiceOptions(question.options);
    const ids = new Set(options.map((option) => String(option.id)));
    if (
      !Array.isArray(answer.values) ||
      answer.values.length < 1 ||
      !answer.values.every(
        (value) => typeof value === "string" && ids.has(value),
      )
    ) {
      validationError(
        "multiple_choice answer.values must contain at least one valid option id.",
      );
    }
  }
};

export class QuestionBankService {
  constructor(private readonly repository: QuestionBankRepository) {}

  listQuestions(
    query: QuestionListQuery,
    scope: QuestionBankScope,
  ): Promise<Page<Question>> {
    return this.repository.listQuestions(query, scope);
  }

  async getQuestion(id: string, scope: QuestionBankScope): Promise<Question> {
    const question = await this.repository.getQuestion(id, scope);
    if (!question) throw new NotFoundError("question", id);
    return question;
  }

  createQuestion(
    input: CreateQuestionInput,
    scope: QuestionBankScope,
  ): Promise<Question> {
    validateKnownQuestionShape({
      type: input.type,
      options: input.options,
      answer: input.answer,
    });
    return this.repository.createQuestion(input, scope);
  }

  async updateQuestion(
    id: string,
    input: UpdateQuestionInput,
    scope: QuestionBankScope,
  ): Promise<Question> {
    const current = await this.getQuestion(id, scope);
    validateKnownQuestionShape({
      type: input.type ?? current.type,
      options: input.options === undefined ? current.options : input.options,
      answer: input.answer === undefined ? current.answer : input.answer,
    });
    return this.repository.updateQuestion(id, input, scope);
  }

  async softDeleteQuestion(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<void> {
    await this.getQuestion(id, scope);
    await this.repository.softDeleteQuestion(id, version, scope);
  }

  listCategories(
    query: QuestionCategoryListQuery,
    scope: QuestionBankScope,
  ): Promise<QuestionCategory[]> {
    return this.repository.listCategories(query, scope);
  }

  async getCategory(
    id: string,
    scope: QuestionBankScope,
  ): Promise<QuestionCategory> {
    const category = await this.repository.getCategory(id, scope);
    if (!category) throw new NotFoundError("question category", id);
    return category;
  }

  createCategory(
    input: CreateQuestionCategoryInput,
    scope: QuestionBankScope,
  ): Promise<QuestionCategory> {
    return this.repository.createCategory(input, scope);
  }

  async updateCategory(
    id: string,
    input: UpdateQuestionCategoryInput,
    scope: QuestionBankScope,
  ): Promise<QuestionCategory> {
    await this.getCategory(id, scope);
    return this.repository.updateCategory(id, input, scope);
  }

  async softDeleteCategory(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<void> {
    await this.getCategory(id, scope);
    await this.repository.softDeleteCategory(id, version, scope);
  }
}

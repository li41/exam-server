import type {
  CreateQuestionInput,
  QuestionCategory,
} from "@server-foundation/api-contracts";
import type { QuestionBankScope } from "./question-bank-repository.js";

export interface QuestionImportRepository {
  listCategories(scope: QuestionBankScope): Promise<QuestionCategory[]>;
  findExistingQuestionCodes(
    codes: string[],
    scope: QuestionBankScope,
  ): Promise<string[]>;
  createQuestions(
    inputs: CreateQuestionInput[],
    scope: QuestionBankScope,
  ): Promise<number>;
}

import type { CreateQuestionInput } from "@server-foundation/api-contracts";
import type { QuestionImportRepository } from "../ports/question-import-repository.js";
import type { QuestionBankScope } from "../ports/question-bank-repository.js";
import { validateKnownQuestionShape } from "./question-bank.js";

export class QuestionImportService {
  constructor(private readonly repository: QuestionImportRepository) {}

  listCategories(scope: QuestionBankScope) {
    return this.repository.listCategories(scope);
  }

  findExistingQuestionCodes(codes: string[], scope: QuestionBankScope) {
    return this.repository.findExistingQuestionCodes(codes, scope);
  }

  importQuestions(inputs: CreateQuestionInput[], scope: QuestionBankScope) {
    for (const input of inputs) {
      validateKnownQuestionShape({
        type: input.type,
        stem: input.stem,
        options: input.options,
        answer: input.answer,
      });
    }
    return this.repository.createQuestions(inputs, scope);
  }
}

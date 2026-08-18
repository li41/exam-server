import type {
  CreateTestBookletInput,
  Page,
  TestBooklet,
  TestBookletListQuery,
  UpdateTestBookletInput,
} from "@server-foundation/api-contracts";
import type { QuestionBankScope } from "./question-bank-repository.js";

export interface TestBookletRepository {
  listBooklets(
    query: TestBookletListQuery,
    scope: QuestionBankScope,
  ): Promise<Page<TestBooklet>>;
  getBooklet(id: string, scope: QuestionBankScope): Promise<TestBooklet | null>;
  createBooklet(
    input: CreateTestBookletInput,
    scope: QuestionBankScope,
  ): Promise<TestBooklet>;
  updateBooklet(
    id: string,
    input: UpdateTestBookletInput,
    scope: QuestionBankScope,
  ): Promise<TestBooklet>;
  softDeleteBooklet(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<void>;
  duplicateBooklet(id: string, scope: QuestionBankScope): Promise<TestBooklet>;
}

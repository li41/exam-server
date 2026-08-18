import type {
  CreateTestBookletInput,
  Page,
  TestBooklet,
  TestBookletListQuery,
  UpdateTestBookletInput,
} from "@server-foundation/api-contracts";
import { NotFoundError } from "../errors.js";
import type { QuestionBankScope } from "../ports/question-bank-repository.js";
import type { TestBookletRepository } from "../ports/test-booklet-repository.js";

export class TestBookletService {
  constructor(private readonly repository: TestBookletRepository) {}

  listBooklets(
    query: TestBookletListQuery,
    scope: QuestionBankScope,
  ): Promise<Page<TestBooklet>> {
    return this.repository.listBooklets(query, scope);
  }

  async getBooklet(id: string, scope: QuestionBankScope): Promise<TestBooklet> {
    const booklet = await this.repository.getBooklet(id, scope);
    if (!booklet) throw new NotFoundError("test booklet", id);
    return booklet;
  }

  createBooklet(
    input: CreateTestBookletInput,
    scope: QuestionBankScope,
  ): Promise<TestBooklet> {
    return this.repository.createBooklet(input, scope);
  }

  async updateBooklet(
    id: string,
    input: UpdateTestBookletInput,
    scope: QuestionBankScope,
  ): Promise<TestBooklet> {
    await this.getBooklet(id, scope);
    return this.repository.updateBooklet(id, input, scope);
  }

  async softDeleteBooklet(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<void> {
    await this.getBooklet(id, scope);
    await this.repository.softDeleteBooklet(id, version, scope);
  }

  async duplicateBooklet(
    id: string,
    scope: QuestionBankScope,
  ): Promise<TestBooklet> {
    await this.getBooklet(id, scope);
    return this.repository.duplicateBooklet(id, scope);
  }
}

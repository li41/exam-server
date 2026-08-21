import type { CreateQuestionInput } from "@server-foundation/api-contracts";
import {
  DomainError,
  unnarrowedQuestionScope,
} from "@server-foundation/domain";
import type {
  QuestionBankRepository,
  QuestionBankScope,
  QuestionImportRepository,
} from "@server-foundation/domain";

export class InMemoryQuestionImportRepository implements QuestionImportRepository {
  constructor(private readonly questions: QuestionBankRepository) {}

  listCategories(scope: QuestionBankScope) {
    return this.questions.listCategories({}, scope);
  }

  async findExistingQuestionCodes(
    codes: string[],
    scope: QuestionBankScope,
  ): Promise<string[]> {
    const wanted = new Set(codes);
    const found = new Set<string>();
    let cursor: string | undefined;
    do {
      // ⛔ 刻意不收窄（`unnarrowedQuestionScope`）：題目 code 的唯一性是
      //    **租戶層**的。收窄的話「只看自己」的人匯入時看不到別人已經佔用的 code，
      //    於是走到資料庫的 duplicate error ⇒ 訊息更難懂，而且一樣擋不住。
      const page = await this.questions.listQuestions(
        { limit: 100, cursor },
        unnarrowedQuestionScope(scope),
      );
      for (const question of page.items) {
        if (wanted.has(question.code)) found.add(question.code);
      }
      cursor = page.page.nextCursor ?? undefined;
    } while (cursor);
    return [...found];
  }

  async createQuestions(
    inputs: CreateQuestionInput[],
    scope: QuestionBankScope,
  ): Promise<number> {
    for (const input of inputs) {
      const media = input.media[0];
      if (media) {
        throw new DomainError(
          "validation_error",
          `Question media fileId "${media.fileId}" does not exist.`,
        );
      }
    }
    for (const input of inputs) {
      await this.questions.createQuestion(input, scope);
    }
    return inputs.length;
  }
}

export const createInMemoryQuestionImportRepository = (
  questions: QuestionBankRepository,
) => new InMemoryQuestionImportRepository(questions);

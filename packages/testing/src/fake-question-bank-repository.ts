import type {
  CreateQuestionCategoryInput,
  CreateQuestionInput,
  Page,
  Question,
  QuestionCategory,
  QuestionCategoryListQuery,
  QuestionListQuery,
  QuestionMedia,
  QuestionMediaResult,
  UpdateQuestionCategoryInput,
  UpdateQuestionInput,
} from "@server-foundation/api-contracts";
import {
  ConflictError,
  DomainError,
  InvalidCursorError,
  NotFoundError,
} from "@server-foundation/domain";
import type {
  QuestionBankRepository,
  QuestionBankScope,
} from "@server-foundation/domain";

const encodeCursor = (offset: number) => btoa(String(offset));

const decodeCursor = (cursor: string | undefined): number => {
  if (!cursor) return 0;
  try {
    const offset = Number.parseInt(atob(cursor), 10);
    if (Number.isInteger(offset) && offset >= 0) return offset;
  } catch {
    // Fall through to the domain error below.
  }
  throw new InvalidCursorError();
};

const readableMedia = (media: QuestionMedia[]): QuestionMediaResult[] =>
  media.map((entry) => ({
    ...structuredClone(entry),
    available: true,
  }));

export class InMemoryQuestionBankRepository implements QuestionBankRepository {
  private readonly questions: Question[] = [];
  private readonly categories: QuestionCategory[] = [];
  private nextQuestionId = 1;
  private nextCategoryId = 1;

  async listQuestions(
    query: QuestionListQuery,
    scope: QuestionBankScope,
  ): Promise<Page<Question>> {
    const search = query.search?.toLocaleLowerCase();
    const categoryIds = query.categoryId
      ? new Set([
          query.categoryId,
          ...this.categories
            .filter(
              (category) =>
                category.tenantId === scope.tenantId &&
                !category.deletedAt &&
                category.parentId === query.categoryId,
            )
            .map((category) => category.id),
        ])
      : null;
    const visible = this.questions.filter((question) => {
      if (question.deletedAt || question.tenantId !== scope.tenantId)
        return false;
      if (query.createdBy && question.createdBy !== query.createdBy)
        return false;
      if (query.type && question.type !== query.type) return false;
      if (
        categoryIds &&
        (!question.categoryId || !categoryIds.has(question.categoryId))
      ) {
        return false;
      }
      if (
        query.difficulty !== undefined &&
        question.difficulty !== query.difficulty
      ) {
        return false;
      }
      if (query.status && question.status !== query.status) return false;
      if (
        query.fileId &&
        !question.media.some((media) => media.fileId === query.fileId)
      ) {
        return false;
      }
      if (!search) return true;
      return (
        question.stem.toLocaleLowerCase().includes(search) ||
        question.code.toLocaleLowerCase().includes(search) ||
        question.tags.some((tag) => tag.toLocaleLowerCase().includes(search))
      );
    });
    const offset = decodeCursor(query.cursor);
    const items = visible.slice(offset, offset + query.limit);
    const nextOffset = offset + items.length;
    return {
      items: structuredClone(items),
      page: {
        nextCursor:
          nextOffset < visible.length ? encodeCursor(nextOffset) : null,
      },
    };
  }

  async getQuestion(
    id: string,
    scope: QuestionBankScope,
  ): Promise<Question | null> {
    const question = this.questions.find(
      (candidate) =>
        candidate.id === id &&
        candidate.tenantId === scope.tenantId &&
        !candidate.deletedAt,
    );
    return question ? structuredClone(question) : null;
  }

  async createQuestion(
    input: CreateQuestionInput,
    scope: QuestionBankScope,
  ): Promise<Question> {
    this.assertUniqueCode(input.code, scope);
    this.assertCategory(input.categoryId ?? null, scope);
    const now = new Date().toISOString();
    const question: Question = {
      id: `question-${this.nextQuestionId++}`,
      tenantId: scope.tenantId,
      code: input.code,
      categoryId: input.categoryId ?? null,
      createdBy: scope.actorUserId,
      type: input.type,
      difficulty: input.difficulty,
      stem: input.stem,
      options: structuredClone(input.options),
      answer: structuredClone(input.answer),
      explanation: input.explanation,
      aiRubric: structuredClone(input.aiRubric),
      points: input.points,
      tags: [...input.tags],
      status: input.status,
      usageCount: 0,
      version: 1,
      media: readableMedia(input.media),
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.questions.unshift(question);
    return structuredClone(question);
  }

  async updateQuestion(
    id: string,
    input: UpdateQuestionInput,
    scope: QuestionBankScope,
  ): Promise<Question> {
    const question = this.requiredQuestion(id, scope);
    if (question.version !== input.version) {
      throw new ConflictError(
        `Question ${id} has changed; reload before updating.`,
      );
    }
    if (input.code !== undefined && input.code !== question.code) {
      this.assertUniqueCode(input.code, scope, id);
      question.code = input.code;
    }
    if (input.categoryId !== undefined) {
      this.assertCategory(input.categoryId, scope);
      question.categoryId = input.categoryId;
    }
    if (input.type !== undefined) question.type = input.type;
    if (input.difficulty !== undefined) question.difficulty = input.difficulty;
    if (input.stem !== undefined) question.stem = input.stem;
    if (input.options !== undefined)
      question.options = structuredClone(input.options);
    if (input.answer !== undefined)
      question.answer = structuredClone(input.answer);
    if (input.explanation !== undefined)
      question.explanation = input.explanation;
    if (input.aiRubric !== undefined)
      question.aiRubric = structuredClone(input.aiRubric);
    if (input.points !== undefined) question.points = input.points;
    if (input.tags !== undefined) question.tags = [...input.tags];
    if (input.status !== undefined) question.status = input.status;
    if (input.media !== undefined) question.media = readableMedia(input.media);
    question.version += 1;
    question.updatedAt = new Date().toISOString();
    return structuredClone(question);
  }

  async softDeleteQuestion(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<void> {
    const question = this.requiredQuestion(id, scope);
    if (question.version !== version) {
      throw new ConflictError(
        `Question ${id} has changed; reload before deleting.`,
      );
    }
    question.version += 1;
    question.updatedAt = new Date().toISOString();
    question.deletedAt = question.updatedAt;
  }

  async listCategories(
    query: QuestionCategoryListQuery,
    scope: QuestionBankScope,
  ): Promise<QuestionCategory[]> {
    return this.categories
      .filter(
        (category) =>
          category.tenantId === scope.tenantId &&
          !category.deletedAt &&
          (query.parentId === undefined ||
            category.parentId === query.parentId),
      )
      .sort(
        (left, right) =>
          Number(left.parentId !== null) - Number(right.parentId !== null) ||
          left.sortOrder - right.sortOrder ||
          left.name.localeCompare(right.name),
      )
      .map((category) => structuredClone(category));
  }

  async getCategory(
    id: string,
    scope: QuestionBankScope,
  ): Promise<QuestionCategory | null> {
    const category = this.categories.find(
      (candidate) =>
        candidate.id === id &&
        candidate.tenantId === scope.tenantId &&
        !candidate.deletedAt,
    );
    return category ? structuredClone(category) : null;
  }

  async createCategory(
    input: CreateQuestionCategoryInput,
    scope: QuestionBankScope,
  ): Promise<QuestionCategory> {
    this.assertParent(input.parentId, scope);
    const now = new Date().toISOString();
    const category: QuestionCategory = {
      id: `category-${this.nextCategoryId++}`,
      tenantId: scope.tenantId,
      parentId: input.parentId,
      name: input.name,
      sortOrder: input.sortOrder,
      version: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.categories.push(category);
    return structuredClone(category);
  }

  async updateCategory(
    id: string,
    input: UpdateQuestionCategoryInput,
    scope: QuestionBankScope,
  ): Promise<QuestionCategory> {
    const category = this.requiredCategory(id, scope);
    if (category.version !== input.version) {
      throw new ConflictError(
        `Question category ${id} has changed; reload before updating.`,
      );
    }
    if (input.parentId === id) {
      throw new DomainError(
        "validation_error",
        "A category cannot parent itself.",
      );
    }
    this.assertParent(input.parentId, scope);
    if (
      input.parentId !== null &&
      this.categories.some(
        (candidate) =>
          candidate.tenantId === scope.tenantId &&
          candidate.parentId === id &&
          !candidate.deletedAt,
      )
    ) {
      throw new DomainError(
        "validation_error",
        "A parent category with children cannot become a child category.",
      );
    }
    category.parentId = input.parentId;
    category.name = input.name;
    category.sortOrder = input.sortOrder;
    category.version += 1;
    category.updatedAt = new Date().toISOString();
    return structuredClone(category);
  }

  async softDeleteCategory(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<void> {
    const category = this.requiredCategory(id, scope);
    if (category.version !== version) {
      throw new ConflictError(
        `Question category ${id} has changed; reload before deleting.`,
      );
    }
    const hasQuestion = this.questions.some(
      (question) =>
        question.tenantId === scope.tenantId &&
        question.categoryId === id &&
        !question.deletedAt,
    );
    const hasChild = this.categories.some(
      (candidate) =>
        candidate.tenantId === scope.tenantId &&
        candidate.parentId === id &&
        !candidate.deletedAt,
    );
    if (hasQuestion || hasChild) {
      throw new ConflictError(
        "Category is still referenced by active questions or child categories.",
      );
    }
    category.version += 1;
    category.updatedAt = new Date().toISOString();
    category.deletedAt = category.updatedAt;
  }

  async isFileReferenced(
    fileId: string,
    scope: QuestionBankScope,
  ): Promise<boolean> {
    return this.questions.some(
      (question) =>
        question.tenantId === scope.tenantId &&
        !question.deletedAt &&
        question.media.some((media) => media.fileId === fileId),
    );
  }

  private requiredQuestion(id: string, scope: QuestionBankScope): Question {
    const question = this.questions.find(
      (candidate) =>
        candidate.id === id &&
        candidate.tenantId === scope.tenantId &&
        !candidate.deletedAt,
    );
    if (!question) throw new NotFoundError("question", id);
    return question;
  }

  private requiredCategory(
    id: string,
    scope: QuestionBankScope,
  ): QuestionCategory {
    const category = this.categories.find(
      (candidate) =>
        candidate.id === id &&
        candidate.tenantId === scope.tenantId &&
        !candidate.deletedAt,
    );
    if (!category) throw new NotFoundError("question category", id);
    return category;
  }

  private assertUniqueCode(
    code: string,
    scope: QuestionBankScope,
    excludeId?: string,
  ): void {
    if (
      this.questions.some(
        (question) =>
          question.id !== excludeId &&
          question.tenantId === scope.tenantId &&
          question.code === code &&
          !question.deletedAt,
      )
    ) {
      throw new ConflictError(
        `Question code ${code} already exists in this tenant.`,
      );
    }
  }

  private assertCategory(
    categoryId: string | null,
    scope: QuestionBankScope,
  ): void {
    if (categoryId === null) return;
    this.requiredCategory(categoryId, scope);
  }

  private assertParent(
    parentId: string | null,
    scope: QuestionBankScope,
  ): void {
    if (parentId === null) return;
    const parent = this.requiredCategory(parentId, scope);
    if (parent.parentId !== null) {
      throw new DomainError(
        "validation_error",
        "Question categories support at most two levels.",
      );
    }
  }
}

export const createInMemoryQuestionBankRepository = () =>
  new InMemoryQuestionBankRepository();

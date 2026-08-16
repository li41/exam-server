import type {
  CreateTestBookletInput,
  Page,
  TestBooklet,
  TestBookletListQuery,
  UpdateTestBookletInput,
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
  QuestionStructureRepository,
  TestBookletRepository,
} from "@server-foundation/domain";

type StoredBooklet = Omit<TestBooklet, "items"> & { groupIds: string[] };

const encodeCursor = (offset: number) => btoa(String(offset));
const decodeCursor = (cursor: string | undefined): number => {
  if (!cursor) return 0;
  try {
    const offset = Number.parseInt(atob(cursor), 10);
    if (Number.isInteger(offset) && offset >= 0) return offset;
  } catch {
    // Fall through.
  }
  throw new InvalidCursorError();
};

const validationError = (message: string): never => {
  throw new DomainError("validation_error", message);
};

export class InMemoryTestBookletRepository implements TestBookletRepository {
  private readonly booklets: StoredBooklet[] = [];
  private nextId = 1;

  constructor(
    private readonly questions: QuestionBankRepository,
    private readonly structures: QuestionStructureRepository,
  ) {}

  async listBooklets(
    query: TestBookletListQuery,
    scope: QuestionBankScope,
  ): Promise<Page<TestBooklet>> {
    const search = query.search?.toLocaleLowerCase();
    const visible = this.booklets.filter((booklet) => {
      if (booklet.deletedAt || booklet.tenantId !== scope.tenantId) return false;
      if (query.createdBy && booklet.createdBy !== query.createdBy) return false;
      if (query.status && booklet.status !== query.status) return false;
      if (query.subjectId && booklet.subjectId !== query.subjectId) return false;
      if (query.categoryId && booklet.categoryId !== query.categoryId) return false;
      if (!search) return true;
      return [booklet.code, booklet.name, booklet.description ?? ""].some((value) =>
        value.toLocaleLowerCase().includes(search),
      );
    });
    const offset = decodeCursor(query.cursor);
    const rows = visible.slice(offset, offset + query.limit);
    return {
      items: await Promise.all(rows.map((row) => this.toBooklet(row, scope))),
      page: {
        nextCursor:
          offset + rows.length < visible.length
            ? encodeCursor(offset + rows.length)
            : null,
      },
    };
  }

  async getBooklet(
    id: string,
    scope: QuestionBankScope,
  ): Promise<TestBooklet | null> {
    const booklet = this.booklets.find(
      (candidate) =>
        candidate.id === id &&
        candidate.tenantId === scope.tenantId &&
        !candidate.deletedAt,
    );
    return booklet ? this.toBooklet(booklet, scope) : null;
  }

  async createBooklet(
    input: CreateTestBookletInput,
    scope: QuestionBankScope,
  ): Promise<TestBooklet> {
    this.assertUniqueCode(input.code, scope);
    await this.assertCategory(input.categoryId, scope);
    await this.assertGroups(input.groupIds, scope);
    const now = new Date().toISOString();
    const booklet: StoredBooklet = {
      id: `booklet-${this.nextId++}`,
      tenantId: scope.tenantId,
      createdBy: scope.actorUserId,
      subjectId: input.subjectId,
      categoryId: input.categoryId,
      code: input.code,
      name: input.name,
      description: input.description,
      status: input.status,
      version: 1,
      groupIds: [...input.groupIds],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.booklets.unshift(booklet);
    return this.toBooklet(booklet, scope);
  }

  async updateBooklet(
    id: string,
    input: UpdateTestBookletInput,
    scope: QuestionBankScope,
  ): Promise<TestBooklet> {
    const booklet = this.required(id, scope);
    if (booklet.version !== input.version) {
      throw new ConflictError(`Test booklet ${id} has changed; reload before updating.`);
    }
    if (input.code !== undefined && input.code !== booklet.code) {
      this.assertUniqueCode(input.code, scope, id);
      booklet.code = input.code;
    }
    if (input.categoryId !== undefined) {
      await this.assertCategory(input.categoryId, scope);
      booklet.categoryId = input.categoryId;
    }
    if (input.groupIds !== undefined) {
      await this.assertGroups(input.groupIds, scope);
      booklet.groupIds = [...input.groupIds];
    }
    if (input.subjectId !== undefined) booklet.subjectId = input.subjectId;
    if (input.name !== undefined) booklet.name = input.name;
    if (input.description !== undefined) booklet.description = input.description;
    if (input.status !== undefined) booklet.status = input.status;
    booklet.version += 1;
    booklet.updatedAt = new Date().toISOString();
    return this.toBooklet(booklet, scope);
  }

  async softDeleteBooklet(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<void> {
    const booklet = this.required(id, scope);
    if (booklet.version !== version) {
      throw new ConflictError(`Test booklet ${id} has changed; reload before deleting.`);
    }
    booklet.version += 1;
    booklet.updatedAt = new Date().toISOString();
    booklet.deletedAt = booklet.updatedAt;
  }

  async duplicateBooklet(
    id: string,
    scope: QuestionBankScope,
  ): Promise<TestBooklet> {
    const source = this.required(id, scope);
    await this.assertGroups(source.groupIds, scope);
    const newId = `booklet-${this.nextId++}`;
    const suffix = `-copy-${newId.replace("booklet-", "")}`;
    const code = `${source.code.slice(0, 50 - suffix.length)}${suffix}`;
    this.assertUniqueCode(code, scope);
    const now = new Date().toISOString();
    const copy: StoredBooklet = {
      ...structuredClone(source),
      id: newId,
      createdBy: scope.actorUserId,
      code,
      name: `${source.name.slice(0, 193)} (copy)`,
      status: "disabled",
      version: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      groupIds: [...source.groupIds],
    };
    this.booklets.unshift(copy);
    return this.toBooklet(copy, scope);
  }

  private required(id: string, scope: QuestionBankScope): StoredBooklet {
    const booklet = this.booklets.find(
      (candidate) =>
        candidate.id === id &&
        candidate.tenantId === scope.tenantId &&
        !candidate.deletedAt,
    );
    if (!booklet) throw new NotFoundError("test booklet", id);
    return booklet;
  }

  private assertUniqueCode(
    code: string,
    scope: QuestionBankScope,
    excludeId?: string,
  ): void {
    const exists = this.booklets.some(
      (booklet) =>
        booklet.id !== excludeId &&
        booklet.tenantId === scope.tenantId &&
        !booklet.deletedAt &&
        booklet.code === code,
    );
    if (exists) {
      throw new ConflictError(`Test booklet code ${code} already exists in this tenant.`);
    }
  }

  private async assertCategory(
    categoryId: string | null,
    scope: QuestionBankScope,
  ): Promise<void> {
    if (categoryId === null) return;
    if (!(await this.questions.getCategory(categoryId, scope))) {
      validationError(`Test booklet categoryId "${categoryId}" does not exist.`);
    }
  }

  private async assertGroups(
    groupIds: string[],
    scope: QuestionBankScope,
  ): Promise<void> {
    for (const groupId of groupIds) {
      if (!(await this.structures.getGroup(groupId, scope))) {
        validationError(`Test booklet groupId "${groupId}" does not exist.`);
      }
    }
  }

  private async toBooklet(
    booklet: StoredBooklet,
    scope: QuestionBankScope,
  ): Promise<TestBooklet> {
    return {
      ...booklet,
      items: await Promise.all(
        booklet.groupIds.map(async (groupId, position) => ({
          groupId,
          position,
          available: Boolean(await this.structures.getGroup(groupId, scope)),
        })),
      ),
    };
  }
}

export const createInMemoryTestBookletRepository = (
  questions: QuestionBankRepository,
  structures: QuestionStructureRepository,
): TestBookletRepository => new InMemoryTestBookletRepository(questions, structures);

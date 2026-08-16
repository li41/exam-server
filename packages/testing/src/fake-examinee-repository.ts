import type {
  CreateExamineeGroupInput,
  CreateExamineeInput,
  Examinee,
  ExamineeGroup,
  ExamineeGroupListQuery,
  ExamineeListQuery,
  Page,
  UpdateExamineeGroupInput,
  UpdateExamineeInput,
} from "@server-foundation/api-contracts";
import {
  ConflictError,
  DomainError,
  InvalidCursorError,
  NotFoundError,
} from "@server-foundation/domain";
import type {
  ExamineeRepository,
  QuestionBankScope,
} from "@server-foundation/domain";

const encodeCursor = (offset: number): string => btoa(String(offset));
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

export class InMemoryExamineeRepository implements ExamineeRepository {
  private readonly groups: ExamineeGroup[] = [];
  private readonly examinees: Examinee[] = [];
  private nextGroupId = 1;
  private nextExamineeId = 1;

  async listGroups(
    query: ExamineeGroupListQuery,
    scope: QuestionBankScope,
  ): Promise<ExamineeGroup[]> {
    const search = query.search?.toLocaleLowerCase();
    return this.groups
      .filter(
        (group) =>
          group.tenantId === scope.tenantId &&
          !group.deletedAt &&
          (!search || group.name.toLocaleLowerCase().includes(search)),
      )
      .sort((left, right) => {
        if (left.parentId === null && right.parentId !== null) return -1;
        if (left.parentId !== null && right.parentId === null) return 1;
        const parent = (left.parentId ?? left.id).localeCompare(
          right.parentId ?? right.id,
        );
        return (
          parent ||
          left.sortOrder - right.sortOrder ||
          left.id.localeCompare(right.id)
        );
      })
      .map((group) => structuredClone(group));
  }

  getGroup(
    id: string,
    scope: QuestionBankScope,
  ): Promise<ExamineeGroup | null> {
    const group = this.groups.find(
      (candidate) =>
        candidate.id === id &&
        candidate.tenantId === scope.tenantId &&
        !candidate.deletedAt,
    );
    return Promise.resolve(group ? structuredClone(group) : null);
  }

  async createGroup(
    input: CreateExamineeGroupInput,
    scope: QuestionBankScope,
  ): Promise<ExamineeGroup> {
    if (input.parentId !== null) {
      const parent = this.requiredGroupOrValidation(
        input.parentId,
        scope,
        "parentId",
      );
      if (parent.parentId !== null) {
        validationError("Examinee groups support at most two levels.");
      }
    }
    this.assertUniqueGroupName(input.name, input.parentId, scope);
    const now = new Date().toISOString();
    const group: ExamineeGroup = {
      id: `examinee-group-${this.nextGroupId++}`,
      tenantId: scope.tenantId,
      parentId: input.parentId,
      name: input.name,
      proctorPassword: input.proctorPassword,
      sortOrder: input.sortOrder,
      version: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.groups.push(group);
    return structuredClone(group);
  }

  async updateGroup(
    id: string,
    input: UpdateExamineeGroupInput,
    scope: QuestionBankScope,
  ): Promise<ExamineeGroup> {
    const group = this.requiredGroup(id, scope);
    if (group.version !== input.version) {
      throw new ConflictError(
        `Examinee group ${id} has changed; reload before updating.`,
      );
    }
    if (input.name !== undefined && input.name !== group.name) {
      this.assertUniqueGroupName(input.name, group.parentId, scope, id);
      group.name = input.name;
    }
    if (input.proctorPassword !== undefined) {
      group.proctorPassword = input.proctorPassword;
    }
    if (input.sortOrder !== undefined) group.sortOrder = input.sortOrder;
    group.version += 1;
    group.updatedAt = new Date().toISOString();
    return structuredClone(group);
  }

  async softDeleteGroup(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<void> {
    const group = this.requiredGroup(id, scope);
    if (group.version !== version) {
      throw new ConflictError(
        `Examinee group ${id} has changed; reload before deleting.`,
      );
    }
    const now = new Date().toISOString();
    const removedIds = new Set([
      id,
      ...this.groups
        .filter(
          (candidate) =>
            candidate.tenantId === scope.tenantId &&
            !candidate.deletedAt &&
            candidate.parentId === id,
        )
        .map((candidate) => candidate.id),
    ]);
    for (const candidate of this.groups) {
      if (
        candidate.tenantId === scope.tenantId &&
        !candidate.deletedAt &&
        removedIds.has(candidate.id)
      ) {
        candidate.version += 1;
        candidate.updatedAt = now;
        candidate.deletedAt = now;
      }
    }
    for (const examinee of this.examinees) {
      if (
        examinee.tenantId === scope.tenantId &&
        !examinee.deletedAt &&
        examinee.groupId !== null &&
        removedIds.has(examinee.groupId)
      ) {
        examinee.groupId = null;
        examinee.version += 1;
        examinee.updatedAt = now;
      }
    }
  }

  async listExaminees(
    query: ExamineeListQuery,
    scope: QuestionBankScope,
  ): Promise<Page<Examinee>> {
    const search = query.search?.toLocaleLowerCase();
    const groupIds = query.groupId
      ? new Set([
          query.groupId,
          ...this.groups
            .filter(
              (group) =>
                group.tenantId === scope.tenantId &&
                !group.deletedAt &&
                group.parentId === query.groupId,
            )
            .map((group) => group.id),
        ])
      : null;
    const visible = this.examinees
      .filter((examinee) => {
        if (examinee.tenantId !== scope.tenantId || examinee.deletedAt)
          return false;
        if (query.createdBy && examinee.createdBy !== query.createdBy)
          return false;
        if (query.status && examinee.status !== query.status) return false;
        if (groupIds && (!examinee.groupId || !groupIds.has(examinee.groupId)))
          return false;
        if (!search) return true;
        return [examinee.name, examinee.identifier, examinee.note ?? ""].some(
          (value) => value.toLocaleLowerCase().includes(search),
        );
      })
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) ||
          right.id.localeCompare(left.id),
      );
    const offset = decodeCursor(query.cursor);
    const rows = visible.slice(offset, offset + query.limit);
    const nextOffset = offset + rows.length;
    return {
      items: structuredClone(rows),
      page: {
        nextCursor:
          nextOffset < visible.length ? encodeCursor(nextOffset) : null,
      },
    };
  }

  getExaminee(id: string, scope: QuestionBankScope): Promise<Examinee | null> {
    const examinee = this.examinees.find(
      (candidate) =>
        candidate.id === id &&
        candidate.tenantId === scope.tenantId &&
        !candidate.deletedAt,
    );
    return Promise.resolve(examinee ? structuredClone(examinee) : null);
  }

  findExamineeByIdentifier(
    identifier: string,
    scope: QuestionBankScope,
  ): Promise<Examinee | null> {
    const examinee = this.examinees.find(
      (candidate) =>
        candidate.tenantId === scope.tenantId &&
        !candidate.deletedAt &&
        candidate.identifier === identifier,
    );
    return Promise.resolve(examinee ? structuredClone(examinee) : null);
  }

  async createExaminee(
    input: CreateExamineeInput,
    scope: QuestionBankScope,
  ): Promise<Examinee> {
    this.assertGroupForExaminee(input.groupId, scope);
    this.assertUniqueExaminee(input.identifier, input.code, scope);
    const now = new Date().toISOString();
    const examinee: Examinee = {
      id: `examinee-${this.nextExamineeId++}`,
      tenantId: scope.tenantId,
      groupId: input.groupId,
      createdBy: scope.actorUserId,
      code: input.code,
      identifier: input.identifier,
      name: input.name,
      note: input.note,
      status: input.status,
      version: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.examinees.push(examinee);
    return structuredClone(examinee);
  }

  async updateExaminee(
    id: string,
    input: UpdateExamineeInput,
    scope: QuestionBankScope,
  ): Promise<Examinee> {
    const examinee = this.requiredExaminee(id, scope);
    if (examinee.version !== input.version) {
      throw new ConflictError(
        `Examinee ${id} has changed; reload before updating.`,
      );
    }
    if (input.groupId !== undefined) {
      this.assertGroupForExaminee(input.groupId, scope);
    }
    const identifier = input.identifier ?? examinee.identifier;
    const code = input.code ?? examinee.code;
    this.assertUniqueExaminee(identifier, code, scope, id);
    if (input.groupId !== undefined) examinee.groupId = input.groupId;
    if (input.code !== undefined) examinee.code = input.code;
    if (input.identifier !== undefined) examinee.identifier = input.identifier;
    if (input.name !== undefined) examinee.name = input.name;
    if (input.note !== undefined) examinee.note = input.note;
    if (input.status !== undefined) examinee.status = input.status;
    examinee.version += 1;
    examinee.updatedAt = new Date().toISOString();
    return structuredClone(examinee);
  }

  async softDeleteExaminee(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<void> {
    const examinee = this.requiredExaminee(id, scope);
    if (examinee.version !== version) {
      throw new ConflictError(
        `Examinee ${id} has changed; reload before deleting.`,
      );
    }
    examinee.version += 1;
    examinee.updatedAt = new Date().toISOString();
    examinee.deletedAt = examinee.updatedAt;
  }

  private requiredGroup(id: string, scope: QuestionBankScope): ExamineeGroup {
    const group = this.groups.find(
      (candidate) =>
        candidate.id === id &&
        candidate.tenantId === scope.tenantId &&
        !candidate.deletedAt,
    );
    if (!group) throw new NotFoundError("examinee group", id);
    return group;
  }

  private requiredGroupOrValidation(
    id: string,
    scope: QuestionBankScope,
    field: "parentId" | "groupId",
  ): ExamineeGroup {
    const group = this.groups.find(
      (candidate) =>
        candidate.id === id &&
        candidate.tenantId === scope.tenantId &&
        !candidate.deletedAt,
    );
    if (!group) {
      validationError(`Examinee group ${field} "${id}" does not exist.`);
    }
    return group;
  }

  private requiredExaminee(id: string, scope: QuestionBankScope): Examinee {
    const examinee = this.examinees.find(
      (candidate) =>
        candidate.id === id &&
        candidate.tenantId === scope.tenantId &&
        !candidate.deletedAt,
    );
    if (!examinee) throw new NotFoundError("examinee", id);
    return examinee;
  }

  private assertGroupForExaminee(
    groupId: string | null,
    scope: QuestionBankScope,
  ): void {
    if (groupId === null) return;
    this.requiredGroupOrValidation(groupId, scope, "groupId");
  }

  private assertUniqueGroupName(
    name: string,
    parentId: string | null,
    scope: QuestionBankScope,
    excludeId?: string,
  ): void {
    const duplicate = this.groups.some(
      (group) =>
        group.id !== excludeId &&
        group.tenantId === scope.tenantId &&
        !group.deletedAt &&
        group.parentId === parentId &&
        group.name === name,
    );
    if (duplicate) {
      throw new ConflictError(
        "An examinee group with the same name already exists at this level.",
      );
    }
  }

  private assertUniqueExaminee(
    identifier: string,
    code: string,
    scope: QuestionBankScope,
    excludeId?: string,
  ): void {
    const duplicate = this.examinees.some(
      (examinee) =>
        examinee.id !== excludeId &&
        examinee.tenantId === scope.tenantId &&
        !examinee.deletedAt &&
        (examinee.identifier === identifier || examinee.code === code),
    );
    if (duplicate) {
      throw new ConflictError(
        "Examinee identifier or password already exists in this tenant.",
      );
    }
  }
}

export const createInMemoryExamineeRepository = (): ExamineeRepository =>
  new InMemoryExamineeRepository();

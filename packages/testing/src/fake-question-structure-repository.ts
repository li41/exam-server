import type {
  CreateQuestionClusterInput,
  CreateQuestionGroupInput,
  Page,
  QuestionCluster,
  QuestionClusterListQuery,
  QuestionGroup,
  QuestionGroupItemInput,
  QuestionGroupListQuery,
  UpdateQuestionClusterInput,
  UpdateQuestionGroupInput,
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
} from "@server-foundation/domain";

type StoredCluster = Omit<QuestionCluster, "items"> & { questionIds: string[] };
type StoredGroup = Omit<QuestionGroup, "items"> & {
  itemRefs: QuestionGroupItemInput[];
};

const encodeCursor = (offset: number) => btoa(String(offset));

const decodeCursor = (cursor: string | undefined): number => {
  if (!cursor) return 0;
  try {
    const offset = Number.parseInt(atob(cursor), 10);
    if (Number.isInteger(offset) && offset >= 0) return offset;
  } catch {
    // Fall through to the shared cursor error.
  }
  throw new InvalidCursorError();
};

const validationError = (message: string): never => {
  throw new DomainError("validation_error", message);
};

export class InMemoryQuestionStructureRepository implements QuestionStructureRepository {
  private readonly clusters: StoredCluster[] = [];
  private readonly groups: StoredGroup[] = [];
  private nextClusterId = 1;
  private nextGroupId = 1;

  constructor(private readonly questions: QuestionBankRepository) {}

  async listClusters(
    query: QuestionClusterListQuery,
    scope: QuestionBankScope,
  ): Promise<Page<QuestionCluster>> {
    const search = query.search?.toLocaleLowerCase();
    const visible = this.clusters.filter((cluster) => {
      if (cluster.deletedAt || cluster.tenantId !== scope.tenantId)
        return false;
      if (query.createdBy && cluster.createdBy !== query.createdBy)
        return false;
      if (query.status && cluster.status !== query.status) return false;
      if (!search) return true;
      return [
        cluster.code,
        cluster.name,
        cluster.stem,
        cluster.description ?? "",
      ].some((value) => value.toLocaleLowerCase().includes(search));
    });
    const offset = decodeCursor(query.cursor);
    const rows = visible.slice(offset, offset + query.limit);
    const items = await Promise.all(
      rows.map((row) => this.toCluster(row, scope)),
    );
    const nextOffset = offset + rows.length;
    return {
      items,
      page: {
        nextCursor:
          nextOffset < visible.length ? encodeCursor(nextOffset) : null,
      },
    };
  }

  async getCluster(
    id: string,
    scope: QuestionBankScope,
  ): Promise<QuestionCluster | null> {
    const cluster = this.clusters.find(
      (candidate) =>
        candidate.id === id &&
        candidate.tenantId === scope.tenantId &&
        !candidate.deletedAt,
    );
    return cluster ? this.toCluster(cluster, scope) : null;
  }

  async createCluster(
    input: CreateQuestionClusterInput,
    scope: QuestionBankScope,
  ): Promise<QuestionCluster> {
    this.assertUniqueClusterCode(input.code, scope);
    await this.assertQuestions(input.questionIds, scope, "cluster");
    const now = new Date().toISOString();
    const cluster: StoredCluster = {
      id: `cluster-${this.nextClusterId++}`,
      tenantId: scope.tenantId,
      createdBy: scope.actorUserId,
      code: input.code,
      name: input.name,
      stem: input.stem,
      stemFileId: input.stemFileId,
      description: input.description,
      status: input.status,
      usageCount: 0,
      version: 1,
      questionIds: [...input.questionIds],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.clusters.unshift(cluster);
    return this.toCluster(cluster, scope);
  }

  async updateCluster(
    id: string,
    input: UpdateQuestionClusterInput,
    scope: QuestionBankScope,
  ): Promise<QuestionCluster> {
    const cluster = this.requiredCluster(id, scope);
    if (cluster.version !== input.version) {
      throw new ConflictError(
        `Question cluster ${id} has changed; reload before updating.`,
      );
    }
    if (input.code !== undefined && input.code !== cluster.code) {
      this.assertUniqueClusterCode(input.code, scope, id);
      cluster.code = input.code;
    }
    if (input.questionIds !== undefined) {
      await this.assertQuestions(input.questionIds, scope, "cluster");
      cluster.questionIds = [...input.questionIds];
    }
    if (input.name !== undefined) cluster.name = input.name;
    if (input.stem !== undefined) cluster.stem = input.stem;
    if (input.stemFileId !== undefined) cluster.stemFileId = input.stemFileId;
    if (input.description !== undefined)
      cluster.description = input.description;
    if (input.status !== undefined) cluster.status = input.status;
    cluster.version += 1;
    cluster.updatedAt = new Date().toISOString();
    return this.toCluster(cluster, scope);
  }

  async softDeleteCluster(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<void> {
    const cluster = this.requiredCluster(id, scope);
    if (cluster.version !== version) {
      throw new ConflictError(
        `Question cluster ${id} has changed; reload before deleting.`,
      );
    }
    const referenced = this.groups.some(
      (group) =>
        group.tenantId === scope.tenantId &&
        !group.deletedAt &&
        group.itemRefs.some(
          (item) => item.itemType === "cluster" && item.clusterId === id,
        ),
    );
    if (referenced) {
      throw new ConflictError(
        "Question cluster is still referenced by an active question group.",
      );
    }
    cluster.version += 1;
    cluster.updatedAt = new Date().toISOString();
    cluster.deletedAt = cluster.updatedAt;
  }

  async listGroups(
    query: QuestionGroupListQuery,
    scope: QuestionBankScope,
  ): Promise<Page<QuestionGroup>> {
    const search = query.search?.toLocaleLowerCase();
    const visible = this.groups.filter((group) => {
      if (group.deletedAt || group.tenantId !== scope.tenantId) return false;
      if (query.createdBy && group.createdBy !== query.createdBy) return false;
      if (query.status && group.status !== query.status) return false;
      if (query.subjectId && group.subjectId !== query.subjectId) return false;
      if (query.flowMode && group.flowMode !== query.flowMode) return false;
      if (!search) return true;
      return [group.code, group.name, group.description ?? ""].some((value) =>
        value.toLocaleLowerCase().includes(search),
      );
    });
    const offset = decodeCursor(query.cursor);
    const rows = visible.slice(offset, offset + query.limit);
    const items = await Promise.all(
      rows.map((row) => this.toGroup(row, scope)),
    );
    const nextOffset = offset + rows.length;
    return {
      items,
      page: {
        nextCursor:
          nextOffset < visible.length ? encodeCursor(nextOffset) : null,
      },
    };
  }

  async getGroup(
    id: string,
    scope: QuestionBankScope,
  ): Promise<QuestionGroup | null> {
    const group = this.groups.find(
      (candidate) =>
        candidate.id === id &&
        candidate.tenantId === scope.tenantId &&
        !candidate.deletedAt,
    );
    return group ? this.toGroup(group, scope) : null;
  }

  async createGroup(
    input: CreateQuestionGroupInput,
    scope: QuestionBankScope,
  ): Promise<QuestionGroup> {
    this.assertUniqueGroupCode(input.code, scope);
    await this.assertSubject(input.subjectId, scope);
    await this.assertGroupItems(input.items, scope);
    const now = new Date().toISOString();
    const group: StoredGroup = {
      id: `group-${this.nextGroupId++}`,
      tenantId: scope.tenantId,
      createdBy: scope.actorUserId,
      code: input.code,
      name: input.name,
      description: input.description,
      subjectId: input.subjectId,
      flowMode: input.flowMode,
      status: input.status,
      usageCount: 0,
      version: 1,
      itemRefs: structuredClone(input.items),
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.groups.unshift(group);
    return this.toGroup(group, scope);
  }

  async updateGroup(
    id: string,
    input: UpdateQuestionGroupInput,
    scope: QuestionBankScope,
  ): Promise<QuestionGroup> {
    const group = this.requiredGroup(id, scope);
    if (group.version !== input.version) {
      throw new ConflictError(
        `Question group ${id} has changed; reload before updating.`,
      );
    }
    if (input.code !== undefined && input.code !== group.code) {
      this.assertUniqueGroupCode(input.code, scope, id);
      group.code = input.code;
    }
    if (input.subjectId !== undefined) {
      await this.assertSubject(input.subjectId, scope);
      group.subjectId = input.subjectId;
    }
    if (input.items !== undefined) {
      await this.assertGroupItems(input.items, scope);
      group.itemRefs = structuredClone(input.items);
    }
    if (input.name !== undefined) group.name = input.name;
    if (input.description !== undefined) group.description = input.description;
    if (input.flowMode !== undefined) group.flowMode = input.flowMode;
    if (input.status !== undefined) group.status = input.status;
    group.version += 1;
    group.updatedAt = new Date().toISOString();
    return this.toGroup(group, scope);
  }

  async softDeleteGroup(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<void> {
    const group = this.requiredGroup(id, scope);
    if (group.version !== version) {
      throw new ConflictError(
        `Question group ${id} has changed; reload before deleting.`,
      );
    }
    group.version += 1;
    group.updatedAt = new Date().toISOString();
    group.deletedAt = group.updatedAt;
  }

  async isFileReferenced(
    fileId: string,
    scope: QuestionBankScope,
  ): Promise<boolean> {
    return this.clusters.some(
      (cluster) =>
        cluster.tenantId === scope.tenantId &&
        !cluster.deletedAt &&
        cluster.stemFileId === fileId,
    );
  }

  private async toCluster(
    cluster: StoredCluster,
    scope: QuestionBankScope,
  ): Promise<QuestionCluster> {
    const items = await Promise.all(
      cluster.questionIds.map(async (questionId, position) => ({
        questionId,
        position,
        available:
          (await this.questions.getQuestion(questionId, scope)) !== null,
      })),
    );
    const { questionIds: _questionIds, ...metadata } = cluster;
    return structuredClone({ ...metadata, items });
  }

  private async toGroup(
    group: StoredGroup,
    scope: QuestionBankScope,
  ): Promise<QuestionGroup> {
    const items = await Promise.all(
      group.itemRefs.map(async (item, position) => {
        if (item.itemType === "question") {
          return {
            ...item,
            position,
            available:
              (await this.questions.getQuestion(item.questionId, scope)) !==
              null,
          } as const;
        }
        return {
          ...item,
          position,
          available: this.findCluster(item.clusterId, scope) !== undefined,
        } as const;
      }),
    );
    const { itemRefs: _itemRefs, ...metadata } = group;
    return structuredClone({ ...metadata, items });
  }

  private requiredCluster(id: string, scope: QuestionBankScope): StoredCluster {
    const cluster = this.findCluster(id, scope);
    if (!cluster) throw new NotFoundError("question cluster", id);
    return cluster;
  }

  private findCluster(
    id: string,
    scope: QuestionBankScope,
  ): StoredCluster | undefined {
    return this.clusters.find(
      (candidate) =>
        candidate.id === id &&
        candidate.tenantId === scope.tenantId &&
        !candidate.deletedAt,
    );
  }

  private requiredGroup(id: string, scope: QuestionBankScope): StoredGroup {
    const group = this.groups.find(
      (candidate) =>
        candidate.id === id &&
        candidate.tenantId === scope.tenantId &&
        !candidate.deletedAt,
    );
    if (!group) throw new NotFoundError("question group", id);
    return group;
  }

  private assertUniqueClusterCode(
    code: string,
    scope: QuestionBankScope,
    excludeId?: string,
  ): void {
    if (
      this.clusters.some(
        (cluster) =>
          cluster.id !== excludeId &&
          cluster.tenantId === scope.tenantId &&
          !cluster.deletedAt &&
          cluster.code === code,
      )
    ) {
      throw new ConflictError(
        `Question cluster code ${code} already exists in this tenant.`,
      );
    }
  }

  private assertUniqueGroupCode(
    code: string,
    scope: QuestionBankScope,
    excludeId?: string,
  ): void {
    if (
      this.groups.some(
        (group) =>
          group.id !== excludeId &&
          group.tenantId === scope.tenantId &&
          !group.deletedAt &&
          group.code === code,
      )
    ) {
      throw new ConflictError(
        `Question group code ${code} already exists in this tenant.`,
      );
    }
  }

  private async assertQuestions(
    questionIds: string[],
    scope: QuestionBankScope,
    owner: "cluster" | "group",
  ): Promise<void> {
    for (const questionId of questionIds) {
      if (!(await this.questions.getQuestion(questionId, scope))) {
        validationError(
          `Question ${owner} questionId "${questionId}" does not exist.`,
        );
      }
    }
  }

  private async assertSubject(
    subjectId: string | null,
    scope: QuestionBankScope,
  ): Promise<void> {
    if (subjectId === null) return;
    if (!(await this.questions.getCategory(subjectId, scope))) {
      validationError(
        `Question group subjectId "${subjectId}" does not exist.`,
      );
    }
  }

  private async assertGroupItems(
    items: QuestionGroupItemInput[],
    scope: QuestionBankScope,
  ): Promise<void> {
    const directQuestionIds = items
      .filter((item) => item.itemType === "question")
      .map((item) => item.questionId);
    await this.assertQuestions(directQuestionIds, scope, "group");

    const clusterQuestionIds = new Set<string>();
    for (const item of items) {
      if (item.itemType !== "cluster") continue;
      const cluster = this.findCluster(item.clusterId, scope);
      if (!cluster) {
        throw new DomainError(
          "validation_error",
          `Question group clusterId "${item.clusterId}" does not exist.`,
        );
      }
      for (const questionId of cluster.questionIds) {
        clusterQuestionIds.add(questionId);
      }
    }

    for (const questionId of directQuestionIds) {
      if (clusterQuestionIds.has(questionId)) {
        throw new ConflictError(
          `Question ${questionId} is already included through a selected cluster.`,
        );
      }
    }
  }
}

export const createInMemoryQuestionStructureRepository = (
  questions: QuestionBankRepository,
) => new InMemoryQuestionStructureRepository(questions);

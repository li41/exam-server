import type {
  AffairSubmission,
  AffairSubmissionDetail,
  AffairSubmissionListQuery,
  AffairSubmissionPayload,
  EnsureAffairSubmissionInput,
  Page,
  SaveAffairSubmissionInput,
} from "@server-foundation/api-contracts";
import {
  ConflictError,
  DomainError,
  NotFoundError,
} from "@server-foundation/domain";
import type {
  AffairConfigurationRepository,
  AffairSubmissionRepository,
  QuestionBankScope,
} from "@server-foundation/domain";

type StoredSubmission = AffairSubmission & { payload: AffairSubmissionPayload };

const randomUUID = (): string => globalThis.crypto.randomUUID();
const now = (): string => new Date().toISOString();
const copy = (item: StoredSubmission): AffairSubmissionDetail =>
  structuredClone(item) as AffairSubmissionDetail;

class InMemoryAffairSubmissionRepository implements AffairSubmissionRepository {
  private readonly items: StoredSubmission[] = [];

  constructor(private readonly configurations: AffairConfigurationRepository) {}

  async listSubmissions(
    query: AffairSubmissionListQuery,
    scope: QuestionBankScope,
  ): Promise<Page<AffairSubmission>> {
    const items = this.items
      .filter(
        (item) =>
          item.tenantId === scope.tenantId &&
          item.collectionId === query.collectionId &&
          (!query.status || item.status === query.status) &&
          (!query.submitterType || item.submitterType === query.submitterType),
      )
      .sort((a, b) =>
        b.updatedAt === a.updatedAt
          ? b.id.localeCompare(a.id)
          : b.updatedAt.localeCompare(a.updatedAt),
      )
      .slice(0, query.limit)
      .map(({ payload: _payload, ...item }) => structuredClone(item));
    return { items, page: { nextCursor: null } };
  }

  async getSubmission(
    id: string,
    scope: QuestionBankScope,
  ): Promise<AffairSubmissionDetail | null> {
    const item = this.items.find(
      (candidate) =>
        candidate.id === id && candidate.tenantId === scope.tenantId,
    );
    return item ? copy(item) : null;
  }

  async ensureSubmission(
    input: EnsureAffairSubmissionInput,
    scope: QuestionBankScope,
  ): Promise<{ created: boolean; item: AffairSubmission }> {
    const existing = this.items.find(
      (candidate) =>
        candidate.tenantId === scope.tenantId &&
        candidate.affairId === input.affairId &&
        candidate.collectionId === input.collectionId &&
        (input.submitterType === "school"
          ? candidate.schoolId === input.schoolId
          : candidate.cityId === input.cityId),
    );
    if (existing) {
      const { payload: _payload, ...item } = existing;
      return { created: false, item: structuredClone(item) };
    }

    const collection = await this.configurations.getCollection(
      input.collectionId,
      scope,
    );
    if (!collection)
      throw new NotFoundError("affair collection", input.collectionId);
    if (collection.type === "receipt") {
      throw new DomainError(
        "validation_error",
        "Receipt collections do not use C-wave submissions.",
      );
    }

    const timestamp = now();
    const stored: StoredSubmission = {
      id: randomUUID(),
      tenantId: scope.tenantId,
      affairId: input.affairId,
      collectionId: input.collectionId,
      submitterType: input.submitterType,
      schoolId: input.submitterType === "school" ? input.schoolId : null,
      cityId: input.submitterType === "city" ? input.cityId : null,
      accountType: input.accountType,
      status: "draft",
      returnReason: null,
      returnedAt: null,
      submittedAt: null,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      payload:
        collection.type === "form"
          ? { kind: "form", fields: [] }
          : { kind: "excel", rows: [] },
    };
    this.items.push(stored);
    const { payload: _payload, ...item } = stored;
    return { created: true, item: structuredClone(item) };
  }

  async saveDraft(
    id: string,
    input: SaveAffairSubmissionInput,
    scope: QuestionBankScope,
  ): Promise<AffairSubmissionDetail> {
    const item = this.require(id, scope);
    this.assertVersion(item, input.version);
    if (item.status === "submitted") {
      throw new DomainError(
        "validation_error",
        "Submitted data cannot be modified.",
      );
    }
    this.writePayload(item, input);
    if (item.status === "returned") item.status = "draft";
    item.version++;
    item.updatedAt = now();
    return copy(item);
  }

  async stageSubmitPayload(
    id: string,
    input: SaveAffairSubmissionInput,
    scope: QuestionBankScope,
  ): Promise<AffairSubmissionDetail> {
    const item = this.require(id, scope);
    this.assertVersion(item, input.version);
    if (item.status === "submitted") {
      throw new DomainError(
        "validation_error",
        "The submission was already submitted.",
      );
    }
    this.writePayload(item, input);
    item.updatedAt = now();
    return copy(item);
  }

  async submit(
    id: string,
    input: SaveAffairSubmissionInput,
    scope: QuestionBankScope,
  ): Promise<AffairSubmissionDetail> {
    const item = this.require(id, scope);
    this.assertVersion(item, input.version);
    if (item.status === "submitted") {
      throw new DomainError(
        "validation_error",
        "The submission was already submitted.",
      );
    }
    this.writePayload(item, input);
    const timestamp = now();
    item.status = "submitted";
    item.accountType = item.submitterType === "school" ? "SC" : "EDU";
    item.submittedAt = timestamp;
    item.version++;
    item.updatedAt = timestamp;
    return copy(item);
  }

  async returnSubmission(
    id: string,
    version: number,
    reason: string | null,
    scope: QuestionBankScope,
  ): Promise<AffairSubmissionDetail> {
    const item = this.require(id, scope);
    this.assertVersion(item, version);
    if (item.status !== "submitted") {
      throw new DomainError(
        "validation_error",
        "Only submitted data can be returned.",
      );
    }
    const timestamp = now();
    item.status = "returned";
    item.returnReason = reason?.trim() || null;
    item.returnedAt = timestamp;
    item.version++;
    item.updatedAt = timestamp;
    return copy(item);
  }

  async deleteSubmission(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<void> {
    const index = this.items.findIndex(
      (item) => item.id === id && item.tenantId === scope.tenantId,
    );
    if (index < 0) throw new NotFoundError("affair submission", id);
    const item = this.items[index] as StoredSubmission;
    this.assertVersion(item, version);
    this.items.splice(index, 1);
  }

  private require(id: string, scope: QuestionBankScope): StoredSubmission {
    const item = this.items.find(
      (candidate) =>
        candidate.id === id && candidate.tenantId === scope.tenantId,
    );
    if (!item) throw new NotFoundError("affair submission", id);
    return item;
  }

  private assertVersion(item: StoredSubmission, version: number): void {
    if (item.version !== version) {
      throw new ConflictError(
        "affair submission was modified by another request.",
      );
    }
  }

  private writePayload(
    item: StoredSubmission,
    input: SaveAffairSubmissionInput,
  ): void {
    if (item.payload.kind === "form" && input.payload.kind === "form") {
      const values = new Map(
        item.payload.fields.map((field) => [field.fieldId, field.value]),
      );
      for (const field of input.payload.fields) {
        values.set(field.fieldId, field.value);
      }
      item.payload = {
        kind: "form",
        fields: Array.from(values, ([fieldId, value]) => ({ fieldId, value })),
      };
      return;
    }
    if (item.payload.kind === "excel" && input.payload.kind === "excel") {
      const timestamp = now();
      item.payload = {
        kind: "excel",
        rows: input.payload.rows.map((row, sortOrder) => ({
          id: randomUUID(),
          submissionId: item.id,
          values: structuredClone(row.values),
          sortOrder,
          createdAt: timestamp,
        })),
      };
      return;
    }
    throw new DomainError(
      "validation_error",
      "Submission payload kind does not match the collection type.",
    );
  }
}

export const createInMemoryAffairSubmissionRepository = (
  configurations: AffairConfigurationRepository,
): AffairSubmissionRepository =>
  new InMemoryAffairSubmissionRepository(configurations);

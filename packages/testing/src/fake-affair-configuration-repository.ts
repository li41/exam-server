import type {
  AffairCollection,
  AffairCollectionBinding,
  AffairCollectionListQuery,
  AffairExcelField,
  AffairReferenceDataRow,
  CreateAffairCollectionInput,
  CreateAffairExcelFieldInput,
  ReplaceAffairCollectionBindingsInput,
  ReplaceAffairReferenceDataInput,
  UpdateAffairCollectionInput,
  UpdateAffairExcelFieldInput,
} from "@server-foundation/api-contracts";
import {
  ConflictError,
  DomainError,
  NotFoundError,
} from "@server-foundation/domain";
import type {
  AffairConfigurationRepository,
  AffairRepository,
  QuestionBankScope,
} from "@server-foundation/domain";

type StoredBinding = Omit<AffairCollectionBinding, "field">;

const randomUUID = (): string => globalThis.crypto.randomUUID();
const now = (): string => new Date().toISOString();

export class InMemoryAffairConfigurationRepository
  implements AffairConfigurationRepository
{
  private readonly collections: AffairCollection[] = [];
  private readonly fields: AffairExcelField[] = [];
  private readonly bindings: StoredBinding[] = [];
  private readonly formReferenceData: AffairReferenceDataRow[] = [];
  private readonly excelReferenceData: AffairReferenceDataRow[] = [];

  constructor(private readonly affairs: AffairRepository) {}

  async listCollections(
    query: AffairCollectionListQuery,
    scope: QuestionBankScope,
  ): Promise<AffairCollection[]> {
    await this.assertAffair(query.affairId, scope);
    return this.collections
      .filter(
        (item) =>
          item.tenantId === scope.tenantId &&
          item.affairId === query.affairId &&
          (!query.type || item.type === query.type) &&
          (!query.target || item.target === query.target) &&
          (!query.status || item.status === query.status),
      )
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
  }

  async getCollection(
    id: string,
    scope: QuestionBankScope,
  ): Promise<AffairCollection | null> {
    return (
      this.collections.find(
        (item) => item.id === id && item.tenantId === scope.tenantId,
      ) ?? null
    );
  }

  async createCollection(
    input: CreateAffairCollectionInput,
    scope: QuestionBankScope,
  ): Promise<AffairCollection> {
    await this.assertAffair(input.affairId, scope);
    if (
      input.type === "receipt" &&
      this.collections.some(
        (item) =>
          item.tenantId === scope.tenantId &&
          item.affairId === input.affairId &&
          item.type === "receipt" &&
          item.target === input.target,
      )
    ) {
      throw new ConflictError(
        `A receipt collection for target ${input.target} already exists in this affair.`,
      );
    }
    const sortOrder =
      Math.max(
        -1,
        ...this.collections
          .filter(
            (item) =>
              item.tenantId === scope.tenantId &&
              item.affairId === input.affairId,
          )
          .map((item) => item.sortOrder),
      ) + 1;
    const timestamp = now();
    const collection: AffairCollection = {
      id: randomUUID(),
      tenantId: scope.tenantId,
      affairId: input.affairId,
      name: input.name,
      type: input.type,
      target: input.target,
      sortOrder,
      status: input.status,
      settings: null,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.collections.push(collection);
    return collection;
  }

  async updateCollection(
    id: string,
    input: UpdateAffairCollectionInput,
    scope: QuestionBankScope,
  ): Promise<AffairCollection> {
    const index = this.collections.findIndex(
      (item) => item.id === id && item.tenantId === scope.tenantId,
    );
    if (index < 0) throw new NotFoundError("affair collection", id);
    const current = this.collections[index] as AffairCollection;
    if (current.version !== input.version) {
      throw new ConflictError(
        "affair collection was modified by another request.",
      );
    }
    const target = input.target ?? current.target;
    if (
      current.type === "receipt" &&
      target !== current.target &&
      this.collections.some(
        (item, candidateIndex) =>
          candidateIndex !== index &&
          item.tenantId === scope.tenantId &&
          item.affairId === current.affairId &&
          item.type === "receipt" &&
          item.target === target,
      )
    ) {
      throw new ConflictError(
        `A receipt collection for target ${target} already exists in this affair.`,
      );
    }
    const { version: _version, ...changes } = input;
    const updated: AffairCollection = {
      ...current,
      ...changes,
      version: current.version + 1,
      updatedAt: now(),
    };
    this.collections[index] = updated;
    return updated;
  }

  async listFields(scope: QuestionBankScope): Promise<AffairExcelField[]> {
    return this.fields
      .filter((item) => item.tenantId === scope.tenantId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
  }

  async getField(
    id: string,
    scope: QuestionBankScope,
  ): Promise<AffairExcelField | null> {
    return (
      this.fields.find(
        (item) => item.id === id && item.tenantId === scope.tenantId,
      ) ?? null
    );
  }

  async createField(
    input: CreateAffairExcelFieldInput,
    scope: QuestionBankScope,
  ): Promise<AffairExcelField> {
    if (
      this.fields.some(
        (item) =>
          item.tenantId === scope.tenantId && item.name === input.name,
      )
    ) {
      throw new ConflictError(
        "An affair field with the same name already exists in this tenant.",
      );
    }
    const sortOrder =
      Math.max(
        -1,
        ...this.fields
          .filter((item) => item.tenantId === scope.tenantId)
          .map((item) => item.sortOrder),
      ) + 1;
    const timestamp = now();
    const field: AffairExcelField = {
      id: randomUUID(),
      tenantId: scope.tenantId,
      name: input.name,
      description: input.description,
      dataType: input.dataType,
      isRequired: input.isRequired,
      validation: input.validation,
      selectOptions: input.selectOptions,
      sortOrder,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.fields.push(field);
    return field;
  }

  async updateField(
    id: string,
    input: UpdateAffairExcelFieldInput,
    scope: QuestionBankScope,
  ): Promise<AffairExcelField> {
    const index = this.fields.findIndex(
      (item) => item.id === id && item.tenantId === scope.tenantId,
    );
    if (index < 0) throw new NotFoundError("affair excel field", id);
    const current = this.fields[index] as AffairExcelField;
    if (current.version !== input.version) {
      throw new ConflictError(
        "affair excel field was modified by another request.",
      );
    }
    const name = input.name ?? current.name;
    if (
      this.fields.some(
        (item, candidateIndex) =>
          candidateIndex !== index &&
          item.tenantId === scope.tenantId &&
          item.name === name,
      )
    ) {
      throw new ConflictError(
        "An affair field with the same name already exists in this tenant.",
      );
    }
    const { version: _version, ...changes } = input;
    const updated: AffairExcelField = {
      ...current,
      ...changes,
      version: current.version + 1,
      updatedAt: now(),
    };
    this.fields[index] = updated;
    return updated;
  }

  async deleteField(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<void> {
    const index = this.fields.findIndex(
      (item) => item.id === id && item.tenantId === scope.tenantId,
    );
    if (index < 0) throw new NotFoundError("affair excel field", id);
    const current = this.fields[index] as AffairExcelField;
    if (current.version !== version) {
      throw new ConflictError(
        "affair excel field was modified by another request.",
      );
    }
    const count = this.bindings.filter(
      (binding) =>
        binding.tenantId === scope.tenantId && binding.fieldId === id,
    ).length;
    if (count > 0) {
      throw new ConflictError(
        `This field is used by ${count} collection(s); remove the bindings first.`,
      );
    }
    this.fields.splice(index, 1);
  }

  async listBindings(
    collectionId: string,
    scope: QuestionBankScope,
  ): Promise<AffairCollectionBinding[]> {
    await this.requireCollection(collectionId, scope);
    return this.bindings
      .filter(
        (binding) =>
          binding.tenantId === scope.tenantId &&
          binding.collectionId === collectionId,
      )
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
      .map((binding) => {
        const field = this.fields.find(
          (candidate) =>
            candidate.id === binding.fieldId &&
            candidate.tenantId === scope.tenantId,
        );
        if (!field) {
          throw new Error("Affair binding points to a missing tenant field.");
        }
        return { ...binding, field };
      });
  }

  async replaceBindings(
    collectionId: string,
    input: ReplaceAffairCollectionBindingsInput,
    scope: QuestionBankScope,
  ): Promise<AffairCollectionBinding[]> {
    const collection = await this.requireCollection(collectionId, scope);
    if (collection.type !== "form" && collection.type !== "excel") {
      throw new DomainError(
        "validation_error",
        "Only form and excel collections support field bindings.",
      );
    }
    const seen = new Set<string>();
    for (const binding of input.bindings) {
      if (seen.has(binding.fieldId)) {
        throw new DomainError(
          "validation_error",
          "A field cannot be bound to the same collection more than once.",
        );
      }
      seen.add(binding.fieldId);
      if (!(await this.getField(binding.fieldId, scope))) {
        throw new NotFoundError("affair excel field", binding.fieldId);
      }
    }
    for (let index = this.bindings.length - 1; index >= 0; index--) {
      const binding = this.bindings[index];
      if (
        binding?.tenantId === scope.tenantId &&
        binding.collectionId === collectionId
      ) {
        this.bindings.splice(index, 1);
      }
    }
    input.bindings.forEach((binding, sortOrder) => {
      this.bindings.push({
        id: randomUUID(),
        tenantId: scope.tenantId,
        collectionId,
        fieldId: binding.fieldId,
        isRequired: binding.isRequired,
        sortOrder,
      });
    });
    if (collection.type === "form" && input.layout !== undefined) {
      const index = this.collections.findIndex(
        (item) => item.id === collection.id && item.tenantId === scope.tenantId,
      );
      this.collections[index] = {
        ...collection,
        settings: { layout: input.layout },
        version: collection.version + 1,
        updatedAt: now(),
      };
    }
    return this.listBindings(collectionId, scope);
  }

  async listReferenceData(
    collectionId: string,
    scope: QuestionBankScope,
  ): Promise<AffairReferenceDataRow[]> {
    const collection = await this.requireCollection(collectionId, scope);
    const rows = this.referenceRows(collection.type);
    return rows
      .filter(
        (row) =>
          row.tenantId === scope.tenantId &&
          row.collectionId === collectionId,
      )
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
  }

  async replaceReferenceData(
    collectionId: string,
    input: ReplaceAffairReferenceDataInput,
    scope: QuestionBankScope,
  ): Promise<AffairReferenceDataRow[]> {
    const collection = await this.requireCollection(collectionId, scope);
    const rows = this.referenceRows(collection.type);
    if (collection.type === "excel" && input.rows.length > 0) {
      const bound = new Set(
        (await this.listBindings(collectionId, scope)).map(
          (binding) => binding.fieldId,
        ),
      );
      if (bound.size === 0) {
        throw new DomainError(
          "validation_error",
          "Excel reference data requires field bindings before rows can be stored.",
        );
      }
      for (const row of input.rows) {
        const keys = Object.keys(row);
        if (
          keys.length !== bound.size ||
          keys.some((key) => !bound.has(key))
        ) {
          throw new DomainError(
            "validation_error",
            "Excel reference-data keys must exactly match the bound field ids.",
          );
        }
      }
    }
    for (let index = rows.length - 1; index >= 0; index--) {
      const row = rows[index];
      if (
        row?.tenantId === scope.tenantId && row.collectionId === collectionId
      ) {
        rows.splice(index, 1);
      }
    }
    input.rows.forEach((rowData, sortOrder) => {
      rows.push({
        id: randomUUID(),
        tenantId: scope.tenantId,
        collectionId,
        rowData,
        sortOrder,
        createdAt: now(),
      });
    });
    return this.listReferenceData(collectionId, scope);
  }

  private async assertAffair(
    affairId: string,
    scope: QuestionBankScope,
  ): Promise<void> {
    if (!(await this.affairs.getAffair(affairId, scope))) {
      throw new NotFoundError("affair", affairId);
    }
  }

  private async requireCollection(
    id: string,
    scope: QuestionBankScope,
  ): Promise<AffairCollection> {
    const collection = await this.getCollection(id, scope);
    if (!collection) throw new NotFoundError("affair collection", id);
    if (collection.type !== "form" && collection.type !== "excel") {
      throw new DomainError(
        "validation_error",
        "Only form and excel collections support configuration data.",
      );
    }
    return collection;
  }

  private referenceRows(
    type: AffairCollection["type"],
  ): AffairReferenceDataRow[] {
    if (type === "form") return this.formReferenceData;
    if (type === "excel") return this.excelReferenceData;
    throw new DomainError(
      "validation_error",
      "Only form and excel collections support reference data.",
    );
  }
}

export const createInMemoryAffairConfigurationRepository = (
  affairs: AffairRepository,
): AffairConfigurationRepository =>
  new InMemoryAffairConfigurationRepository(affairs);
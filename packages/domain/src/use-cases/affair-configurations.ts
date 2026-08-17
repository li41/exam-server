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
import { DomainError, NotFoundError } from "../errors.js";
import type { AffairConfigurationRepository } from "../ports/affair-configuration-repository.js";
import type { QuestionBankScope } from "../ports/question-bank-repository.js";

const validateFieldConfiguration = (value: {
  dataType: AffairExcelField["dataType"];
  selectOptions: AffairExcelField["selectOptions"];
}): void => {
  if (
    value.dataType === "select" &&
    (!value.selectOptions || value.selectOptions.length === 0)
  ) {
    throw new DomainError(
      "validation_error",
      "Select fields require at least one option.",
    );
  }
  if (value.dataType !== "select" && value.selectOptions !== null) {
    throw new DomainError(
      "validation_error",
      "Only select fields may define selectOptions.",
    );
  }
};

export class AffairConfigurationService {
  constructor(private readonly repository: AffairConfigurationRepository) {}

  listCollections(
    query: AffairCollectionListQuery,
    scope: QuestionBankScope,
  ): Promise<AffairCollection[]> {
    return this.repository.listCollections(query, scope);
  }

  async getCollection(
    id: string,
    scope: QuestionBankScope,
  ): Promise<AffairCollection> {
    const collection = await this.repository.getCollection(id, scope);
    if (!collection) throw new NotFoundError("affair collection", id);
    return collection;
  }

  createCollection(
    input: CreateAffairCollectionInput,
    scope: QuestionBankScope,
  ): Promise<AffairCollection> {
    return this.repository.createCollection(input, scope);
  }

  async updateCollection(
    id: string,
    input: UpdateAffairCollectionInput,
    scope: QuestionBankScope,
  ): Promise<AffairCollection> {
    await this.getCollection(id, scope);
    return this.repository.updateCollection(id, input, scope);
  }

  listFields(scope: QuestionBankScope): Promise<AffairExcelField[]> {
    return this.repository.listFields(scope);
  }

  async getField(id: string, scope: QuestionBankScope): Promise<AffairExcelField> {
    const field = await this.repository.getField(id, scope);
    if (!field) throw new NotFoundError("affair excel field", id);
    return field;
  }

  createField(
    input: CreateAffairExcelFieldInput,
    scope: QuestionBankScope,
  ): Promise<AffairExcelField> {
    validateFieldConfiguration(input);
    return this.repository.createField(input, scope);
  }

  async updateField(
    id: string,
    input: UpdateAffairExcelFieldInput,
    scope: QuestionBankScope,
  ): Promise<AffairExcelField> {
    const current = await this.getField(id, scope);
    validateFieldConfiguration({
      dataType: input.dataType ?? current.dataType,
      selectOptions:
        input.selectOptions === undefined
          ? current.selectOptions
          : input.selectOptions,
    });
    return this.repository.updateField(id, input, scope);
  }

  async deleteField(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<void> {
    await this.getField(id, scope);
    await this.repository.deleteField(id, version, scope);
  }

  async listBindings(
    collectionId: string,
    scope: QuestionBankScope,
  ): Promise<AffairCollectionBinding[]> {
    await this.getCollection(collectionId, scope);
    return this.repository.listBindings(collectionId, scope);
  }

  async replaceBindings(
    collectionId: string,
    input: ReplaceAffairCollectionBindingsInput,
    scope: QuestionBankScope,
  ): Promise<AffairCollectionBinding[]> {
    const collection = await this.getCollection(collectionId, scope);
    if (collection.type !== "form" && collection.type !== "excel") {
      throw new DomainError(
        "validation_error",
        "Only form and excel collections support field bindings.",
      );
    }
    if (collection.type !== "form" && input.layout !== undefined) {
      throw new DomainError(
        "validation_error",
        "Only form collections may define a layout.",
      );
    }
    const ids = input.bindings.map((binding) => binding.fieldId);
    if (new Set(ids).size !== ids.length) {
      throw new DomainError(
        "validation_error",
        "A field cannot be bound to the same collection more than once.",
      );
    }
    return this.repository.replaceBindings(collectionId, input, scope);
  }

  async listReferenceData(
    collectionId: string,
    scope: QuestionBankScope,
  ): Promise<AffairReferenceDataRow[]> {
    const collection = await this.getCollection(collectionId, scope);
    if (collection.type !== "form" && collection.type !== "excel") {
      throw new DomainError(
        "validation_error",
        "Only form and excel collections support reference data.",
      );
    }
    return this.repository.listReferenceData(collectionId, scope);
  }

  async replaceReferenceData(
    collectionId: string,
    input: ReplaceAffairReferenceDataInput,
    scope: QuestionBankScope,
  ): Promise<AffairReferenceDataRow[]> {
    const collection = await this.getCollection(collectionId, scope);
    if (collection.type !== "form" && collection.type !== "excel") {
      throw new DomainError(
        "validation_error",
        "Only form and excel collections support reference data.",
      );
    }
    return this.repository.replaceReferenceData(collectionId, input, scope);
  }
}

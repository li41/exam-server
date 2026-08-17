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
import type { QuestionBankScope } from "./question-bank-repository.js";

export interface AffairConfigurationRepository {
  listCollections(
    query: AffairCollectionListQuery,
    scope: QuestionBankScope,
  ): Promise<AffairCollection[]>;
  getCollection(
    id: string,
    scope: QuestionBankScope,
  ): Promise<AffairCollection | null>;
  createCollection(
    input: CreateAffairCollectionInput,
    scope: QuestionBankScope,
  ): Promise<AffairCollection>;
  updateCollection(
    id: string,
    input: UpdateAffairCollectionInput,
    scope: QuestionBankScope,
  ): Promise<AffairCollection>;

  listFields(scope: QuestionBankScope): Promise<AffairExcelField[]>;
  getField(id: string, scope: QuestionBankScope): Promise<AffairExcelField | null>;
  createField(
    input: CreateAffairExcelFieldInput,
    scope: QuestionBankScope,
  ): Promise<AffairExcelField>;
  updateField(
    id: string,
    input: UpdateAffairExcelFieldInput,
    scope: QuestionBankScope,
  ): Promise<AffairExcelField>;
  deleteField(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<void>;

  listBindings(
    collectionId: string,
    scope: QuestionBankScope,
  ): Promise<AffairCollectionBinding[]>;
  replaceBindings(
    collectionId: string,
    input: ReplaceAffairCollectionBindingsInput,
    scope: QuestionBankScope,
  ): Promise<AffairCollectionBinding[]>;

  listReferenceData(
    collectionId: string,
    scope: QuestionBankScope,
  ): Promise<AffairReferenceDataRow[]>;
  replaceReferenceData(
    collectionId: string,
    input: ReplaceAffairReferenceDataInput,
    scope: QuestionBankScope,
  ): Promise<AffairReferenceDataRow[]>;
}

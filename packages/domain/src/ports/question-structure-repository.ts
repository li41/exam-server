import type {
  CreateQuestionClusterInput,
  CreateQuestionGroupInput,
  Page,
  QuestionCluster,
  QuestionClusterListQuery,
  QuestionGroup,
  QuestionGroupListQuery,
  UpdateQuestionClusterInput,
  UpdateQuestionGroupInput,
} from "@server-foundation/api-contracts";
import type { QuestionBankScope } from "./question-bank-repository.js";

export interface QuestionStructureRepository {
  listClusters(
    query: QuestionClusterListQuery,
    scope: QuestionBankScope,
  ): Promise<Page<QuestionCluster>>;
  getCluster(
    id: string,
    scope: QuestionBankScope,
  ): Promise<QuestionCluster | null>;
  createCluster(
    input: CreateQuestionClusterInput,
    scope: QuestionBankScope,
  ): Promise<QuestionCluster>;
  updateCluster(
    id: string,
    input: UpdateQuestionClusterInput,
    scope: QuestionBankScope,
  ): Promise<QuestionCluster>;
  softDeleteCluster(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<void>;

  listGroups(
    query: QuestionGroupListQuery,
    scope: QuestionBankScope,
  ): Promise<Page<QuestionGroup>>;
  getGroup(id: string, scope: QuestionBankScope): Promise<QuestionGroup | null>;
  createGroup(
    input: CreateQuestionGroupInput,
    scope: QuestionBankScope,
  ): Promise<QuestionGroup>;
  updateGroup(
    id: string,
    input: UpdateQuestionGroupInput,
    scope: QuestionBankScope,
  ): Promise<QuestionGroup>;
  softDeleteGroup(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<void>;

  isFileReferenced(fileId: string, scope: QuestionBankScope): Promise<boolean>;
}

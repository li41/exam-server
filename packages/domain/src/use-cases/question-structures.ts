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
import { NotFoundError } from "../errors.js";
import type { QuestionBankScope } from "../ports/question-bank-repository.js";
import type { QuestionStructureRepository } from "../ports/question-structure-repository.js";

export class QuestionStructureService {
  constructor(private readonly repository: QuestionStructureRepository) {}

  listClusters(
    query: QuestionClusterListQuery,
    scope: QuestionBankScope,
  ): Promise<Page<QuestionCluster>> {
    return this.repository.listClusters(query, scope);
  }

  async getCluster(
    id: string,
    scope: QuestionBankScope,
  ): Promise<QuestionCluster> {
    const cluster = await this.repository.getCluster(id, scope);
    if (!cluster) throw new NotFoundError("question cluster", id);
    return cluster;
  }

  createCluster(
    input: CreateQuestionClusterInput,
    scope: QuestionBankScope,
  ): Promise<QuestionCluster> {
    return this.repository.createCluster(input, scope);
  }

  async updateCluster(
    id: string,
    input: UpdateQuestionClusterInput,
    scope: QuestionBankScope,
  ): Promise<QuestionCluster> {
    await this.getCluster(id, scope);
    return this.repository.updateCluster(id, input, scope);
  }

  async softDeleteCluster(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<void> {
    await this.getCluster(id, scope);
    await this.repository.softDeleteCluster(id, version, scope);
  }

  listGroups(
    query: QuestionGroupListQuery,
    scope: QuestionBankScope,
  ): Promise<Page<QuestionGroup>> {
    return this.repository.listGroups(query, scope);
  }

  async getGroup(id: string, scope: QuestionBankScope): Promise<QuestionGroup> {
    const group = await this.repository.getGroup(id, scope);
    if (!group) throw new NotFoundError("question group", id);
    return group;
  }

  createGroup(
    input: CreateQuestionGroupInput,
    scope: QuestionBankScope,
  ): Promise<QuestionGroup> {
    return this.repository.createGroup(input, scope);
  }

  async updateGroup(
    id: string,
    input: UpdateQuestionGroupInput,
    scope: QuestionBankScope,
  ): Promise<QuestionGroup> {
    await this.getGroup(id, scope);
    return this.repository.updateGroup(id, input, scope);
  }

  async softDeleteGroup(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<void> {
    await this.getGroup(id, scope);
    await this.repository.softDeleteGroup(id, version, scope);
  }
}

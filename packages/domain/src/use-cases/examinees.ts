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
import { NotFoundError } from "../errors.js";
import type {
  ExamineeImportRecord,
  ExamineeImportWriteResult,
  ExamineeRepository,
} from "../ports/examinee-repository.js";
import type { QuestionBankScope } from "../ports/question-bank-repository.js";

export class ExamineeService {
  constructor(private readonly repository: ExamineeRepository) {}

  listGroups(
    query: ExamineeGroupListQuery,
    scope: QuestionBankScope,
  ): Promise<ExamineeGroup[]> {
    return this.repository.listGroups(query, scope);
  }

  async getGroup(id: string, scope: QuestionBankScope): Promise<ExamineeGroup> {
    const group = await this.repository.getGroup(id, scope);
    if (!group) throw new NotFoundError("examinee group", id);
    return group;
  }

  createGroup(
    input: CreateExamineeGroupInput,
    scope: QuestionBankScope,
  ): Promise<ExamineeGroup> {
    return this.repository.createGroup(input, scope);
  }

  async updateGroup(
    id: string,
    input: UpdateExamineeGroupInput,
    scope: QuestionBankScope,
  ): Promise<ExamineeGroup> {
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

  listExaminees(
    query: ExamineeListQuery,
    scope: QuestionBankScope,
  ): Promise<Page<Examinee>> {
    return this.repository.listExaminees(query, scope);
  }

  async getExaminee(id: string, scope: QuestionBankScope): Promise<Examinee> {
    const examinee = await this.repository.getExaminee(id, scope);
    if (!examinee) throw new NotFoundError("examinee", id);
    return examinee;
  }

  async findExamineeByIdentifier(
    identifier: string,
    scope: QuestionBankScope,
  ): Promise<Examinee> {
    const examinee = await this.repository.findExamineeByIdentifier(
      identifier,
      scope,
    );
    if (!examinee) throw new NotFoundError("examinee identifier", identifier);
    return examinee;
  }

  createExaminee(
    input: CreateExamineeInput,
    scope: QuestionBankScope,
  ): Promise<Examinee> {
    return this.repository.createExaminee(input, scope);
  }

  async updateExaminee(
    id: string,
    input: UpdateExamineeInput,
    scope: QuestionBankScope,
  ): Promise<Examinee> {
    await this.getExaminee(id, scope);
    return this.repository.updateExaminee(id, input, scope);
  }

  importExaminees(
    records: ExamineeImportRecord[],
    scope: QuestionBankScope,
  ): Promise<ExamineeImportWriteResult> {
    return this.repository.importExaminees(records, scope);
  }

  async softDeleteExaminee(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<void> {
    await this.getExaminee(id, scope);
    await this.repository.softDeleteExaminee(id, version, scope);
  }
}

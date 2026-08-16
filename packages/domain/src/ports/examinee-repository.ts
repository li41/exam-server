import type {
  CreateExamineeGroupInput,
  CreateExamineeInput,
  Examinee,
  ExamineeGroup,
  ExamineeGroupListQuery,
  ExamineeListQuery,
  ExamineeImportIssue,
  Page,
  UpdateExamineeGroupInput,
  UpdateExamineeInput,
} from "@server-foundation/api-contracts";
import type { QuestionBankScope } from "./question-bank-repository.js";

export type ExamineeImportRecord = {
  sheet: string;
  row: number;
  input: CreateExamineeInput;
};

export type ExamineeImportWriteResult = {
  imported: number;
  updated: number;
  errors: ExamineeImportIssue[];
};

export interface ExamineeRepository {
  listGroups(
    query: ExamineeGroupListQuery,
    scope: QuestionBankScope,
  ): Promise<ExamineeGroup[]>;
  getGroup(id: string, scope: QuestionBankScope): Promise<ExamineeGroup | null>;
  createGroup(
    input: CreateExamineeGroupInput,
    scope: QuestionBankScope,
  ): Promise<ExamineeGroup>;
  updateGroup(
    id: string,
    input: UpdateExamineeGroupInput,
    scope: QuestionBankScope,
  ): Promise<ExamineeGroup>;
  softDeleteGroup(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<void>;

  listExaminees(
    query: ExamineeListQuery,
    scope: QuestionBankScope,
  ): Promise<Page<Examinee>>;
  getExaminee(id: string, scope: QuestionBankScope): Promise<Examinee | null>;
  findExamineeByIdentifier(
    identifier: string,
    scope: QuestionBankScope,
  ): Promise<Examinee | null>;
  createExaminee(
    input: CreateExamineeInput,
    scope: QuestionBankScope,
  ): Promise<Examinee>;
  updateExaminee(
    id: string,
    input: UpdateExamineeInput,
    scope: QuestionBankScope,
  ): Promise<Examinee>;
  importExaminees(
    records: ExamineeImportRecord[],
    scope: QuestionBankScope,
  ): Promise<ExamineeImportWriteResult>;
  softDeleteExaminee(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<void>;
}

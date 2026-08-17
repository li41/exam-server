import type {
  AffairSubmission,
  AffairSubmissionDetail,
  AffairSubmissionListQuery,
  EnsureAffairSubmissionInput,
  Page,
  SaveAffairSubmissionInput,
} from "@server-foundation/api-contracts";
import type { QuestionBankScope } from "./question-bank-repository.js";

export interface AffairSubmissionRepository {
  listSubmissions(
    query: AffairSubmissionListQuery,
    scope: QuestionBankScope,
  ): Promise<Page<AffairSubmission>>;
  getSubmission(
    id: string,
    scope: QuestionBankScope,
  ): Promise<AffairSubmissionDetail | null>;
  ensureSubmission(
    input: EnsureAffairSubmissionInput,
    scope: QuestionBankScope,
  ): Promise<{ created: boolean; item: AffairSubmission }>;
  saveDraft(
    id: string,
    input: SaveAffairSubmissionInput,
    scope: QuestionBankScope,
  ): Promise<AffairSubmissionDetail>;
  submit(
    id: string,
    input: SaveAffairSubmissionInput,
    scope: QuestionBankScope,
  ): Promise<AffairSubmissionDetail>;
  returnSubmission(
    id: string,
    version: number,
    reason: string | null,
    scope: QuestionBankScope,
  ): Promise<AffairSubmissionDetail>;
  deleteSubmission(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<void>;
}

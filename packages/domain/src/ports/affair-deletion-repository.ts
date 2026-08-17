import type { QuestionBankScope } from "./question-bank-repository.js";

export type AffairDeleteBlockerKind =
  | "schools"
  | "submissions"
  | "receipts"
  | "collections";

export type AffairDeleteBlocker = {
  kind: AffairDeleteBlockerKind;
  count: number;
};

export interface AffairDeletionRepository {
  /**
   * Delete an affair only when the first PHP-ordered blocker is absent.
   *
   * Implementations must keep blocker inspection and parent deletion inside the
   * same concurrency boundary. `null` means the affair was deleted; otherwise
   * the returned blocker is the first one in PHP order.
   */
  deleteAffair(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<AffairDeleteBlocker | null>;
}

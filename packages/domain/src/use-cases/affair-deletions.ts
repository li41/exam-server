import { DomainError } from "../errors.js";
import type {
  AffairDeleteBlocker,
  AffairDeletionRepository,
} from "../ports/affair-deletion-repository.js";
import type { QuestionBankScope } from "../ports/question-bank-repository.js";

const blockerMessage = (blocker: AffairDeleteBlocker): string => {
  switch (blocker.kind) {
    case "schools":
      return `此試務資料下有 ${blocker.count} 所學校帳號，請先刪除學校帳號後再刪除`;
    case "submissions":
      return `此試務資料下有 ${blocker.count} 筆填報資料，請先到各收集方式的「資料檢視」頁刪除後再刪除試務`;
    case "receipts":
      return `此試務資料下有 ${blocker.count} 筆領據（含身分證與銀行帳號），請先到領據頁面刪除後再刪除試務`;
    case "collections":
      return `此試務資料下有 ${blocker.count} 個收集方式，請先刪除收集方式後再刪除`;
  }
};

export class AffairDeletionService {
  constructor(private readonly repository: AffairDeletionRepository) {}

  async deleteAffair(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<void> {
    const blocker = await this.repository.deleteAffair(id, version, scope);
    if (blocker) {
      throw new DomainError("validation_error", blockerMessage(blocker));
    }
  }
}

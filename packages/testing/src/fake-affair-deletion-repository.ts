import { ConflictError, NotFoundError } from "@server-foundation/domain";
import type {
  AffairDeleteBlocker,
  AffairDeleteBlockerKind,
  AffairDeletionRepository,
  QuestionBankScope,
} from "@server-foundation/domain";

export type InMemoryAffairDeletionRecord = {
  id: string;
  tenantId: string;
  version: number;
};

export class InMemoryAffairDeletionRepository
  implements AffairDeletionRepository
{
  private readonly affairs = new Map<string, InMemoryAffairDeletionRecord>();
  private readonly blockers = new Map<AffairDeleteBlockerKind, number>();

  constructor(initial: readonly InMemoryAffairDeletionRecord[] = []) {
    for (const affair of initial) this.affairs.set(affair.id, { ...affair });
  }

  setBlocker(kind: AffairDeleteBlockerKind, count: number): void {
    this.blockers.set(kind, Math.max(0, Math.trunc(count)));
  }

  hasAffair(id: string, tenantId: string): boolean {
    const affair = this.affairs.get(id);
    return affair?.tenantId === tenantId;
  }

  async deleteAffair(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<AffairDeleteBlocker | null> {
    const affair = this.affairs.get(id);
    if (!affair || affair.tenantId !== scope.tenantId) {
      throw new NotFoundError("affair", id);
    }
    if (affair.version !== version) {
      throw new ConflictError("affair was modified by another request.");
    }

    for (const kind of [
      "schools",
      "submissions",
      "receipts",
      "collections",
    ] as const) {
      const count = this.blockers.get(kind) ?? 0;
      if (count > 0) return { kind, count };
    }

    this.affairs.delete(id);
    return null;
  }
}

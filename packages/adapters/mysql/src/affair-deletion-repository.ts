import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { ConflictError, NotFoundError } from "@server-foundation/domain";
import type {
  AffairDeleteBlocker,
  AffairDeleteBlockerKind,
  AffairDeletionRepository,
  QuestionBankScope,
} from "@server-foundation/domain";
import { withTransaction } from "./transaction.js";

type VersionRow = RowDataPacket & { version: number };
type CountRow = RowDataPacket & { cnt: number | string };

const blockerChecks: ReadonlyArray<{
  kind: AffairDeleteBlockerKind;
  table: string;
}> = [
  { kind: "schools", table: "affair_schools" },
  { kind: "submissions", table: "affair_submissions" },
  { kind: "receipts", table: "affair_receipts" },
  { kind: "collections", table: "affair_collections" },
];

const mysqlCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;

export class MySqlAffairDeletionRepository
  implements AffairDeletionRepository
{
  constructor(private readonly pool: Pool) {}

  async deleteAffair(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<AffairDeleteBlocker | null> {
    try {
      return await withTransaction(this.pool, async (connection) => {
        // InnoDB locking read: under READ COMMITTED and REPEATABLE READ this
        // takes an exclusive record lock on the tenant-qualified parent row.
        // Child inserts that enforce the existing affair FK need a compatible
        // parent-record lock for their FK check, so they wait until this
        // transaction commits or rolls back instead of slipping between the
        // blocker check and DELETE.
        const [affairRows] = await connection.execute<VersionRow[]>(
          "SELECT version FROM affairs WHERE id = ? AND tenant_id = ? FOR UPDATE",
          [id, scope.tenantId],
        );
        const affair = affairRows[0];
        if (!affair) throw new NotFoundError("affair", id);
        if (Number(affair.version) !== version) {
          throw new ConflictError("affair was modified by another request.");
        }

        // PHP behavior is first-blocker-wins, in this exact order. Do not
        // aggregate counts or reorder these checks.
        for (const check of blockerChecks) {
          const [rows] = await connection.execute<CountRow[]>(
            `SELECT COUNT(*) AS cnt FROM ${check.table} WHERE tenant_id = ? AND affair_id = ?`,
            [scope.tenantId, id],
          );
          const count = Number(rows[0]?.cnt ?? 0);
          if (count > 0) return { kind: check.kind, count };
        }

        const [result] = await connection.execute<ResultSetHeader>(
          "DELETE FROM affairs WHERE id = ? AND tenant_id = ? AND version = ?",
          [id, scope.tenantId, version],
        );
        if (result.affectedRows !== 1) {
          throw new Error("Affair delete did not affect the locked parent row.");
        }
        return null;
      });
    } catch (error) {
      // Existing ON DELETE RESTRICT FKs remain the final integrity boundary.
      // This should only be reachable for an unmodeled/new child relation or
      // an out-of-band write that bypassed the normal lock ordering.
      if (mysqlCode(error) === "ER_ROW_IS_REFERENCED_2") {
        throw new ConflictError(
          "Affair gained dependent data during deletion; retry after removing it.",
        );
      }
      throw error;
    }
  }
}

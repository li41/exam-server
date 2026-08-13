import { createHash } from "node:crypto";
import type {
  IdempotencyReservation,
  IdempotencyStore,
  IdempotencyStoredResponse,
} from "@server-foundation/domain";
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import { withTransaction } from "./transaction.js";

type IdempotencyRow = RowDataPacket & {
  request_hash: string;
  state: "pending" | "completed";
  response_status: number | null;
  response_body: string | null;
  response_content_type: string | null;
  expires_at: Date | string | null;
};

const recordKey = (scope: string, key: string): string =>
  createHash("sha256").update(scope).update("\0").update(key).digest("hex");

const asDate = (value: Date | string | null): Date | null => {
  if (value === null) return null;
  if (value instanceof Date) return value;
  const normalized = /[zZ]|[+-]\d\d:?\d\d$/.test(value)
    ? value.replace(" ", "T")
    : `${value.replace(" ", "T")}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    throw new Error("MySQL returned an invalid idempotency expiry timestamp.");
  }
  return date;
};

const selectForUpdate = async (
  connection: PoolConnection,
  key: string,
): Promise<IdempotencyRow | undefined> => {
  const [rows] = await connection.execute<IdempotencyRow[]>(
    `SELECT request_hash, state, response_status, response_body,
            response_content_type, expires_at
       FROM idempotency_records
      WHERE record_key = ?
      LIMIT 1
      FOR UPDATE`,
    [key],
  );
  return rows[0];
};

const insertPending = async (
  connection: PoolConnection,
  key: string,
  requestHash: string,
): Promise<void> => {
  const now = new Date();
  await connection.execute(
    `INSERT INTO idempotency_records
      (record_key, request_hash, state, response_status, response_body,
       response_content_type, expires_at, created_at, updated_at)
     VALUES (?, ?, 'pending', NULL, NULL, NULL, NULL, ?, ?)`,
    [key, requestHash, now, now],
  );
};

export class MySqlIdempotencyStore implements IdempotencyStore {
  constructor(private readonly pool: Pool) {}

  async reserve(
    scope: string,
    key: string,
    requestHash: string,
    _ttlSeconds: number,
  ): Promise<IdempotencyReservation> {
    const id = recordKey(scope, key);
    return withTransaction(this.pool, async (connection) => {
      const existing = await selectForUpdate(connection, id);
      if (!existing) {
        await insertPending(connection, id, requestHash);
        return { state: "acquired" };
      }

      if (existing.request_hash !== requestHash) {
        return { state: "conflict" };
      }

      if (existing.state === "completed") {
        const expiresAt = asDate(existing.expires_at);
        if (expiresAt && expiresAt.getTime() <= Date.now()) {
          await connection.execute(
            "DELETE FROM idempotency_records WHERE record_key = ?",
            [id],
          );
          await insertPending(connection, id, requestHash);
          return { state: "acquired" };
        }
        if (
          existing.response_status === null ||
          existing.response_body === null
        ) {
          throw new Error(
            "Completed idempotency record is missing its response.",
          );
        }
        return {
          state: "completed",
          response: {
            status: existing.response_status,
            body: existing.response_body,
            ...(existing.response_content_type
              ? { contentType: existing.response_content_type }
              : {}),
          },
        };
      }

      // Pending records intentionally do not expire or reopen automatically.
      // A process crash after a side effect but before response persistence must
      // fail closed rather than allow the same mutation to execute again.
      return { state: "pending" };
    });
  }

  async complete(
    scope: string,
    key: string,
    requestHash: string,
    response: IdempotencyStoredResponse,
    ttlSeconds: number,
  ): Promise<void> {
    const id = recordKey(scope, key);
    await withTransaction(this.pool, async (connection) => {
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
      const [result] = await connection.execute<ResultSetHeader>(
        `UPDATE idempotency_records
            SET state = 'completed', response_status = ?, response_body = ?,
                response_content_type = ?, expires_at = ?, updated_at = ?
          WHERE record_key = ? AND request_hash = ? AND state = 'pending'`,
        [
          response.status,
          response.body,
          response.contentType ?? null,
          expiresAt,
          new Date(),
          id,
          requestHash,
        ],
      );
      if (result.affectedRows !== 1) {
        throw new Error(
          "Idempotency completion could not update the reserved record.",
        );
      }
    });
  }

  async release(
    _scope: string,
    _key: string,
    _requestHash: string,
  ): Promise<void> {
    // Deliberately fail closed. The application cannot prove that a mutation
    // produced no side effect merely because the request ended with an error.
    // Keeping the pending reservation prevents an ambiguous retry from
    // executing the mutation a second time. Clients should use a new key only
    // after they know the previous attempt had no externally visible effect.
  }
}

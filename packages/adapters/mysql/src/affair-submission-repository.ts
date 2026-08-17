import { randomUUID } from "node:crypto";
import type {
  AffairSubmission,
  AffairSubmissionDetail,
  AffairSubmissionListQuery,
  AffairSubmissionPayload,
  AffairSubmissionRow,
  EnsureAffairSubmissionInput,
  Page,
  SaveAffairSubmissionInput,
} from "@server-foundation/api-contracts";
import {
  ConflictError,
  DomainError,
  InvalidCursorError,
  NotFoundError,
} from "@server-foundation/domain";
import type {
  AffairSubmissionRepository,
  QuestionBankScope,
} from "@server-foundation/domain";
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import { decodeItemCursor, encodeItemCursor } from "./cursor.js";
import { withTransaction } from "./transaction.js";

type SubmissionDbRow = RowDataPacket & {
  id: string;
  tenant_id: string;
  affair_id: string;
  collection_id: string;
  submitter_type: AffairSubmission["submitterType"];
  school_id: string | null;
  city_id: string | null;
  account_type: AffairSubmission["accountType"];
  status: AffairSubmission["status"];
  return_reason: string | null;
  returned_at: Date | string | null;
  submitted_at: Date | string | null;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
  collection_type?: "form" | "excel" | "receipt";
};

type DataDbRow = RowDataPacket & {
  field_id: string;
  value: string | null;
};

type RepeatedRowDbRow = RowDataPacket & {
  id: string;
  submission_id: string;
  row_data: unknown;
  sort_order: number;
  created_at: Date | string;
};

type VersionDbRow = RowDataPacket & { version: number };
type IdDbRow = RowDataPacket & { id: string };
type SqlValue = string | number | Date | null;

const columns = `
  s.id, s.tenant_id, s.affair_id, s.collection_id, s.submitter_type,
  s.school_id, s.city_id, s.account_type, s.status, s.return_reason,
  s.returned_at, s.submitted_at, s.version, s.created_at, s.updated_at`;

const toIso = (value: Date | string | null): string | null => {
  if (value === null) return null;
  const date =
    value instanceof Date
      ? value
      : new Date(
          /[zZ]|[+-]\d\d:?\d\d$/.test(value)
            ? value.replace(" ", "T")
            : `${value.replace(" ", "T")}Z`,
        );
  if (Number.isNaN(date.getTime())) {
    throw new Error("MySQL returned an invalid affair submission date.");
  }
  return date.toISOString();
};

const parseRowValues = (value: unknown): Record<string, string> => {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new Error("MySQL returned invalid affair submission row JSON.");
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("MySQL returned an invalid affair submission row shape.");
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(parsed)) {
    if (!key || typeof item !== "string") {
      throw new Error("MySQL returned an invalid affair submission row value.");
    }
    result[key] = item;
  }
  return result;
};

const isDuplicate = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ER_DUP_ENTRY";

export class MySqlAffairSubmissionRepository
  implements AffairSubmissionRepository
{
  constructor(private readonly pool: Pool) {}

  async listSubmissions(
    query: AffairSubmissionListQuery,
    scope: QuestionBankScope,
  ): Promise<Page<AffairSubmission>> {
    const predicates = ["s.tenant_id = ?", "s.collection_id = ?"];
    const params: SqlValue[] = [scope.tenantId, query.collectionId];
    if (query.status) {
      predicates.push("s.status = ?");
      params.push(query.status);
    }
    if (query.submitterType) {
      predicates.push("s.submitter_type = ?");
      params.push(query.submitterType);
    }
    if (query.cursor) {
      const cursor = decodeItemCursor(query.cursor);
      if (!cursor) throw new InvalidCursorError();
      predicates.push(
        "(s.updated_at < ? OR (s.updated_at = ? AND s.id < ?))",
      );
      params.push(
        new Date(cursor.updatedAt),
        new Date(cursor.updatedAt),
        cursor.id,
      );
    }
    const [rows] = await this.pool.execute<SubmissionDbRow[]>(
      `SELECT ${columns}
       FROM affair_submissions s
       WHERE ${predicates.join(" AND ")}
       ORDER BY s.updated_at DESC, s.id DESC
       LIMIT ?`,
      [...params, query.limit + 1],
    );
    const hasNext = rows.length > query.limit;
    const visible = rows.slice(0, query.limit);
    const last = visible.at(-1);
    return {
      items: visible.map((row) => this.toSubmission(row)),
      page: {
        nextCursor:
          hasNext && last
            ? encodeItemCursor({
                updatedAt: toIso(last.updated_at) as string,
                id: last.id,
              })
            : null,
      },
    };
  }

  async getSubmission(
    id: string,
    scope: QuestionBankScope,
  ): Promise<AffairSubmissionDetail | null> {
    const [rows] = await this.pool.execute<SubmissionDbRow[]>(
      `SELECT ${columns}, c.type AS collection_type
       FROM affair_submissions s
       JOIN affair_collections c
         ON c.id = s.collection_id AND c.tenant_id = s.tenant_id
       WHERE s.id = ? AND s.tenant_id = ?
       LIMIT 1`,
      [id, scope.tenantId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      ...this.toSubmission(row),
      payload: await this.loadPayload(row, scope),
    };
  }

  async ensureSubmission(
    input: EnsureAffairSubmissionInput,
    scope: QuestionBankScope,
  ): Promise<{ created: boolean; item: AffairSubmission }> {
    await this.assertParents(input, scope);
    const existing = await this.findByOwner(input, scope);
    if (existing) return { created: false, item: existing };

    const id = randomUUID();
    const timestamp = new Date();
    try {
      await this.pool.execute(
        `INSERT INTO affair_submissions (
          id, tenant_id, affair_id, collection_id, submitter_type,
          school_id, city_id, account_type, status, return_reason,
          returned_at, submitted_at, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', NULL, NULL, NULL, 1, ?, ?)`,
        [
          id,
          scope.tenantId,
          input.affairId,
          input.collectionId,
          input.submitterType,
          input.submitterType === "school" ? input.schoolId : null,
          input.submitterType === "city" ? input.cityId : null,
          input.accountType,
          timestamp,
          timestamp,
        ],
      );
    } catch (error) {
      if (isDuplicate(error)) {
        const concurrent = await this.findByOwner(input, scope);
        if (concurrent) return { created: false, item: concurrent };
      }
      throw error;
    }

    const detail = await this.requireSubmission(id, scope);
    const { payload: _payload, ...item } = detail;
    return { created: true, item };
  }

  async saveDraft(
    id: string,
    input: SaveAffairSubmissionInput,
    scope: QuestionBankScope,
  ): Promise<AffairSubmissionDetail> {
    await withTransaction(this.pool, async (connection) => {
      const current = await this.lockSubmission(connection, id, scope);
      this.assertVersion(current, input.version, "affair submission");
      if (current.status === "submitted") {
        throw new DomainError(
          "validation_error",
          "Submitted data cannot be modified.",
        );
      }
      await this.writePayload(connection, current, input, scope);
      const status = current.status === "returned" ? "draft" : current.status;
      await connection.execute(
        `UPDATE affair_submissions
         SET status = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND version = ?`,
        [status, new Date(), id, scope.tenantId, input.version],
      );
    });
    return this.requireSubmission(id, scope);
  }

  async stageSubmitPayload(
    id: string,
    input: SaveAffairSubmissionInput,
    scope: QuestionBankScope,
  ): Promise<AffairSubmissionDetail> {
    await withTransaction(this.pool, async (connection) => {
      const current = await this.lockSubmission(connection, id, scope);
      this.assertVersion(current, input.version, "affair submission");
      if (current.status === "submitted") {
        throw new DomainError(
          "validation_error",
          "The submission was already submitted.",
        );
      }
      await this.writePayload(connection, current, input, scope);
      await connection.execute(
        `UPDATE affair_submissions
         SET updated_at = ?
         WHERE id = ? AND tenant_id = ? AND version = ?`,
        [new Date(), id, scope.tenantId, input.version],
      );
    });
    return this.requireSubmission(id, scope);
  }

  async submit(
    id: string,
    input: SaveAffairSubmissionInput,
    scope: QuestionBankScope,
  ): Promise<AffairSubmissionDetail> {
    await withTransaction(this.pool, async (connection) => {
      const current = await this.lockSubmission(connection, id, scope);
      this.assertVersion(current, input.version, "affair submission");
      if (current.status === "submitted") {
        throw new DomainError(
          "validation_error",
          "The submission was already submitted.",
        );
      }
      await this.writePayload(connection, current, input, scope);
      const timestamp = new Date();
      await connection.execute(
        `UPDATE affair_submissions
         SET status = 'submitted',
             account_type = CASE
               WHEN submitter_type = 'school' THEN 'SC'
               ELSE 'EDU'
             END,
             submitted_at = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND version = ?`,
        [timestamp, timestamp, id, scope.tenantId, input.version],
      );
    });
    return this.requireSubmission(id, scope);
  }

  async returnSubmission(
    id: string,
    version: number,
    reason: string | null,
    scope: QuestionBankScope,
  ): Promise<AffairSubmissionDetail> {
    const timestamp = new Date();
    const normalizedReason = reason?.trim() || null;
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE affair_submissions
       SET status = 'returned', return_reason = ?, returned_at = ?,
           version = version + 1, updated_at = ?
       WHERE id = ? AND tenant_id = ? AND version = ? AND status = 'submitted'`,
      [normalizedReason, timestamp, timestamp, id, scope.tenantId, version],
    );
    if (result.affectedRows === 0) {
      const current = await this.getSubmission(id, scope);
      if (!current) throw new NotFoundError("affair submission", id);
      if (current.version !== version) {
        throw new ConflictError(
          "affair submission was modified by another request.",
        );
      }
      if (current.status !== "submitted") {
        throw new DomainError(
          "validation_error",
          "Only submitted data can be returned.",
        );
      }
      throw new Error("Affair submission return did not affect the expected row.");
    }
    return this.requireSubmission(id, scope);
  }

  async deleteSubmission(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<void> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `DELETE FROM affair_submissions
       WHERE id = ? AND tenant_id = ? AND version = ?`,
      [id, scope.tenantId, version],
    );
    if (result.affectedRows === 0) {
      await this.throwVersionFailure(id, version, scope);
    }
  }

  private async loadPayload(
    row: SubmissionDbRow,
    scope: QuestionBankScope,
  ): Promise<AffairSubmissionPayload> {
    if (row.collection_type === "form") {
      const [rows] = await this.pool.execute<DataDbRow[]>(
        `SELECT field_id, value
         FROM affair_submission_data
         WHERE tenant_id = ? AND submission_id = ?
         ORDER BY field_id`,
        [scope.tenantId, row.id],
      );
      return {
        kind: "form",
        fields: rows.map((item) => ({
          fieldId: item.field_id,
          value: item.value ?? "",
        })),
      };
    }
    if (row.collection_type === "excel") {
      const [rows] = await this.pool.execute<RepeatedRowDbRow[]>(
        `SELECT id, submission_id, row_data, sort_order, created_at
         FROM affair_submission_rows
         WHERE tenant_id = ? AND submission_id = ?
         ORDER BY sort_order, id`,
        [scope.tenantId, row.id],
      );
      return {
        kind: "excel",
        rows: rows.map((item) => this.toRepeatedRow(item)),
      };
    }
    throw new Error("Receipt collections cannot contain C-wave submissions.");
  }

  private async assertParents(
    input: EnsureAffairSubmissionInput,
    scope: QuestionBankScope,
  ): Promise<void> {
    const [collections] = await this.pool.execute<RowDataPacket[]>(
      `SELECT id
       FROM affair_collections
       WHERE id = ? AND tenant_id = ? AND affair_id = ?
         AND target = ? AND type <> 'receipt'
       LIMIT 1`,
      [
        input.collectionId,
        scope.tenantId,
        input.affairId,
        input.submitterType,
      ],
    );
    if (!collections[0]) {
      throw new NotFoundError("affair collection", input.collectionId);
    }

    if (input.submitterType === "school") {
      const [owners] = await this.pool.execute<RowDataPacket[]>(
        `SELECT id FROM affair_schools
         WHERE id = ? AND tenant_id = ? AND affair_id = ? LIMIT 1`,
        [input.schoolId, scope.tenantId, input.affairId],
      );
      if (!owners[0]) throw new NotFoundError("affair school", input.schoolId);
      return;
    }

    const [owners] = await this.pool.execute<RowDataPacket[]>(
      `SELECT id FROM affair_cities
       WHERE id = ? AND tenant_id = ? LIMIT 1`,
      [input.cityId, scope.tenantId],
    );
    if (!owners[0]) throw new NotFoundError("affair city", input.cityId);
  }

  private async findByOwner(
    input: EnsureAffairSubmissionInput,
    scope: QuestionBankScope,
  ): Promise<AffairSubmission | null> {
    const ownerColumn =
      input.submitterType === "school" ? "school_id" : "city_id";
    const ownerId =
      input.submitterType === "school" ? input.schoolId : input.cityId;
    const [rows] = await this.pool.execute<SubmissionDbRow[]>(
      `SELECT ${columns}
       FROM affair_submissions s
       WHERE s.tenant_id = ? AND s.affair_id = ? AND s.collection_id = ?
         AND s.${ownerColumn} = ?
       LIMIT 1`,
      [scope.tenantId, input.affairId, input.collectionId, ownerId],
    );
    return rows[0] ? this.toSubmission(rows[0]) : null;
  }

  private async lockSubmission(
    connection: PoolConnection,
    id: string,
    scope: QuestionBankScope,
  ): Promise<SubmissionDbRow> {
    const [rows] = await connection.execute<SubmissionDbRow[]>(
      `SELECT ${columns}, c.type AS collection_type
       FROM affair_submissions s
       JOIN affair_collections c
         ON c.id = s.collection_id AND c.tenant_id = s.tenant_id
       WHERE s.id = ? AND s.tenant_id = ?
       LIMIT 1 FOR UPDATE`,
      [id, scope.tenantId],
    );
    if (!rows[0]) throw new NotFoundError("affair submission", id);
    return rows[0];
  }

  private async writePayload(
    connection: PoolConnection,
    current: SubmissionDbRow,
    input: SaveAffairSubmissionInput,
    scope: QuestionBankScope,
  ): Promise<void> {
    if (current.collection_type === "form" && input.payload.kind === "form") {
      await this.assertBoundFieldIds(
        connection,
        current.collection_id,
        input.payload.fields.map((field) => field.fieldId),
        scope,
      );
      for (const field of input.payload.fields) {
        await connection.execute(
          `INSERT INTO affair_submission_data (
            id, tenant_id, submission_id, field_id, value
          ) VALUES (?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE value = VALUES(value)`,
          [randomUUID(), scope.tenantId, current.id, field.fieldId, field.value],
        );
      }
      return;
    }

    if (current.collection_type === "excel" && input.payload.kind === "excel") {
      const fieldIds = Array.from(
        new Set(input.payload.rows.flatMap((row) => Object.keys(row.values))),
      );
      await this.assertBoundFieldIds(
        connection,
        current.collection_id,
        fieldIds,
        scope,
      );
      await connection.execute(
        `DELETE FROM affair_submission_rows
         WHERE tenant_id = ? AND submission_id = ?`,
        [scope.tenantId, current.id],
      );
      const timestamp = new Date();
      for (const [index, row] of input.payload.rows.entries()) {
        await connection.execute(
          `INSERT INTO affair_submission_rows (
            id, tenant_id, submission_id, row_data, sort_order, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
          [
            randomUUID(),
            scope.tenantId,
            current.id,
            JSON.stringify(row.values),
            index,
            timestamp,
          ],
        );
      }
      return;
    }

    throw new DomainError(
      "validation_error",
      "Submission payload kind does not match the collection type.",
    );
  }

  private async assertBoundFieldIds(
    connection: PoolConnection,
    collectionId: string,
    fieldIds: string[],
    scope: QuestionBankScope,
  ): Promise<void> {
    if (fieldIds.length === 0) return;
    const uniqueIds = Array.from(new Set(fieldIds));
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const [rows] = await connection.execute<IdDbRow[]>(
      `SELECT field_id AS id
       FROM affair_excel_field_bindings
       WHERE tenant_id = ? AND collection_id = ?
         AND field_id IN (${placeholders})`,
      [scope.tenantId, collectionId, ...uniqueIds],
    );
    if (rows.length !== uniqueIds.length) {
      throw new DomainError(
        "validation_error",
        "Submission payload references an unbound or cross-tenant field.",
      );
    }
  }

  private assertVersion(
    current: SubmissionDbRow,
    version: number,
    resource: string,
  ): void {
    if (Number(current.version) !== version) {
      throw new ConflictError(`${resource} was modified by another request.`);
    }
  }

  private async throwVersionFailure(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<never> {
    const [rows] = await this.pool.execute<VersionDbRow[]>(
      `SELECT version FROM affair_submissions
       WHERE id = ? AND tenant_id = ? LIMIT 1`,
      [id, scope.tenantId],
    );
    if (!rows[0]) throw new NotFoundError("affair submission", id);
    if (Number(rows[0].version) !== version) {
      throw new ConflictError(
        "affair submission was modified by another request.",
      );
    }
    throw new Error("Affair submission operation did not affect the expected row.");
  }

  private async requireSubmission(
    id: string,
    scope: QuestionBankScope,
  ): Promise<AffairSubmissionDetail> {
    const item = await this.getSubmission(id, scope);
    if (!item) throw new NotFoundError("affair submission", id);
    return item;
  }

  private toSubmission(row: SubmissionDbRow): AffairSubmission {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      affairId: row.affair_id,
      collectionId: row.collection_id,
      submitterType: row.submitter_type,
      schoolId: row.school_id,
      cityId: row.city_id,
      accountType: row.account_type,
      status: row.status,
      returnReason: row.return_reason,
      returnedAt: toIso(row.returned_at),
      submittedAt: toIso(row.submitted_at),
      version: Number(row.version),
      createdAt: toIso(row.created_at) as string,
      updatedAt: toIso(row.updated_at) as string,
    };
  }

  private toRepeatedRow(row: RepeatedRowDbRow): AffairSubmissionRow {
    return {
      id: row.id,
      submissionId: row.submission_id,
      values: parseRowValues(row.row_data),
      sortOrder: Number(row.sort_order),
      createdAt: toIso(row.created_at) as string,
    };
  }
}

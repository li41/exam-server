import { randomUUID } from "node:crypto";
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
import {
  ConflictError,
  DomainError,
  InvalidCursorError,
  NotFoundError,
} from "@server-foundation/domain";
import type {
  ExamineeRepository,
  QuestionBankScope,
} from "@server-foundation/domain";
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import { decodeItemCursor, encodeItemCursor } from "./cursor.js";
import type { ExamineeCredentialProtector } from "./examinee-credential-protector.js";
import { withTransaction } from "./transaction.js";

type Executor = Pick<PoolConnection, "execute">;
type SqlParam = string | number | Date | null;

type GroupRow = RowDataPacket & {
  id: string;
  tenant_id: string;
  parent_id: string | null;
  name: string;
  proctor_password_ciphertext: string | null;
  sort_order: number;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
  deleted_at: Date | string | null;
};

type ExamineeRow = RowDataPacket & {
  id: string;
  tenant_id: string;
  group_id: string | null;
  created_by: string;
  code_ciphertext: string;
  identifier: string;
  name: string;
  note: string | null;
  status: Examinee["status"];
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
  deleted_at: Date | string | null;
};

type ExistingRow = RowDataPacket & {
  id: string;
  version: number;
  deleted_at: Date | string | null;
};
type ParentRow = RowDataPacket & { id: string; parent_id: string | null };
type IdRow = RowDataPacket & { id: string };

const groupColumns = `
  g.id, g.tenant_id, g.parent_id, g.name, g.proctor_password_ciphertext,
  g.sort_order, g.version, g.created_at, g.updated_at, g.deleted_at`;

const examineeColumns = `
  e.id, e.tenant_id, e.group_id, e.created_by, e.code_ciphertext,
  e.identifier, e.name, e.note, e.status, e.version,
  e.created_at, e.updated_at, e.deleted_at`;

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
    throw new Error("MySQL returned an invalid examinee date.");
  }
  return date.toISOString();
};

const toMySqlDateTime = (value: Date): string =>
  value.toISOString().slice(0, 23).replace("T", " ");

const escapeLike = (value: string): string =>
  value.replace(/[!%_]/g, (character) => `!${character}`);

const isDuplicateEntry = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ER_DUP_ENTRY";

const validationError = (message: string): never => {
  throw new DomainError("validation_error", message);
};

export class MySqlExamineeRepository implements ExamineeRepository {
  constructor(
    private readonly pool: Pool,
    private readonly credentials: ExamineeCredentialProtector,
  ) {}

  async listGroups(
    query: ExamineeGroupListQuery,
    scope: QuestionBankScope,
  ): Promise<ExamineeGroup[]> {
    const predicates = ["g.tenant_id = ?", "g.deleted_at IS NULL"];
    const parameters: string[] = [scope.tenantId];
    const search = query.search?.trim();
    if (search) {
      predicates.push("g.name LIKE ? ESCAPE '!'");
      parameters.push(`%${escapeLike(search)}%`);
    }
    const [rows] = await this.pool.execute<GroupRow[]>(
      `SELECT ${groupColumns}
       FROM examinee_groups g
       WHERE ${predicates.join(" AND ")}
       ORDER BY
         CASE WHEN g.parent_id IS NULL THEN 0 ELSE 1 END,
         COALESCE(g.parent_id, g.id), g.sort_order, g.id`,
      parameters,
    );
    return rows.map((row) => this.toGroup(row));
  }

  getGroup(
    id: string,
    scope: QuestionBankScope,
  ): Promise<ExamineeGroup | null> {
    return this.getGroupWith(this.pool, id, scope);
  }

  async createGroup(
    input: CreateExamineeGroupInput,
    scope: QuestionBankScope,
  ): Promise<ExamineeGroup> {
    const id = randomUUID();
    const now = new Date();
    try {
      await withTransaction(this.pool, async (connection) => {
        await this.assertParent(connection, input.parentId, scope);
        await connection.execute(
          `INSERT INTO examinee_groups (
            id, tenant_id, parent_id, name, proctor_password_ciphertext,
            sort_order, version, created_at, updated_at, deleted_at
          ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
          [
            id,
            scope.tenantId,
            input.parentId,
            input.name,
            input.proctorPassword === null
              ? null
              : this.credentials.protect(input.proctorPassword),
            input.sortOrder,
            now,
            now,
          ],
        );
      });
    } catch (error) {
      if (isDuplicateEntry(error)) {
        throw new ConflictError(
          "An examinee group with the same name already exists at this level.",
        );
      }
      throw error;
    }
    const group = await this.getGroup(id, scope);
    if (!group)
      throw new Error("Examinee group insert succeeded but could not be read.");
    return group;
  }

  async updateGroup(
    id: string,
    input: UpdateExamineeGroupInput,
    scope: QuestionBankScope,
  ): Promise<ExamineeGroup> {
    const updates: string[] = [];
    const values: SqlParam[] = [];
    const put = (column: string, value: SqlParam): void => {
      updates.push(`${column} = ?`);
      values.push(value);
    };
    if (input.name !== undefined) put("name", input.name);
    if (input.sortOrder !== undefined) put("sort_order", input.sortOrder);
    if (input.proctorPassword !== undefined) {
      put(
        "proctor_password_ciphertext",
        input.proctorPassword === null
          ? null
          : this.credentials.protect(input.proctorPassword),
      );
    }
    const now = new Date();
    try {
      const [result] = await this.pool.execute<ResultSetHeader>(
        `UPDATE examinee_groups
         SET ${updates.length > 0 ? `${updates.join(", ")}, ` : ""}version = version + 1, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND version = ?`,
        [...values, now, id, scope.tenantId, input.version],
      );
      if (result.affectedRows === 0) {
        await this.throwGroupUpdateFailure(this.pool, id, input.version, scope);
      }
    } catch (error) {
      if (isDuplicateEntry(error)) {
        throw new ConflictError(
          "An examinee group with the same name already exists at this level.",
        );
      }
      throw error;
    }
    const group = await this.getGroup(id, scope);
    if (!group) throw new NotFoundError("examinee group", id);
    return group;
  }

  async softDeleteGroup(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<void> {
    const now = new Date();
    await withTransaction(this.pool, async (connection) => {
      const [targets] = await connection.execute<ExistingRow[]>(
        `SELECT id, version, deleted_at
         FROM examinee_groups
         WHERE id = ? AND tenant_id = ?
         LIMIT 1 FOR UPDATE`,
        [id, scope.tenantId],
      );
      const target = targets[0];
      if (!target || target.deleted_at) {
        throw new NotFoundError("examinee group", id);
      }
      if (Number(target.version) !== version) {
        throw new ConflictError(
          `Examinee group ${id} has changed; reload before deleting.`,
        );
      }

      const [children] = await connection.execute<IdRow[]>(
        `SELECT id FROM examinee_groups
         WHERE tenant_id = ? AND parent_id = ? AND deleted_at IS NULL
         FOR UPDATE`,
        [scope.tenantId, id],
      );
      const groupIds = [id, ...children.map((row) => row.id)];
      const placeholders = groupIds.map(() => "?").join(", ");

      await connection.execute(
        `UPDATE examinees
         SET group_id = NULL, version = version + 1, updated_at = ?
         WHERE tenant_id = ? AND deleted_at IS NULL
           AND group_id IN (${placeholders})`,
        [now, scope.tenantId, ...groupIds],
      );
      await connection.execute(
        `UPDATE examinee_groups
         SET version = version + 1, updated_at = ?, deleted_at = ?
         WHERE tenant_id = ? AND deleted_at IS NULL
           AND id IN (${placeholders})`,
        [now, now, scope.tenantId, ...groupIds],
      );
    });
  }

  async listExaminees(
    query: ExamineeListQuery,
    scope: QuestionBankScope,
  ): Promise<Page<Examinee>> {
    const predicates = ["e.tenant_id = ?", "e.deleted_at IS NULL"];
    const parameters: Array<string | number> = [scope.tenantId];
    const search = query.search?.trim();
    const limit = Math.min(Math.max(Math.trunc(query.limit), 1), 100);

    if (query.createdBy) {
      predicates.push("e.created_by = ?");
      parameters.push(query.createdBy);
    }
    if (query.status) {
      predicates.push("e.status = ?");
      parameters.push(query.status);
    }
    if (query.groupId) {
      predicates.push(
        `(e.group_id = ? OR e.group_id IN (
          SELECT eg.id FROM examinee_groups eg
          WHERE eg.tenant_id = ? AND eg.parent_id = ? AND eg.deleted_at IS NULL
        ))`,
      );
      parameters.push(query.groupId, scope.tenantId, query.groupId);
    }
    if (search) {
      const like = `%${escapeLike(search)}%`;
      predicates.push(
        "(e.name LIKE ? ESCAPE '!' OR e.identifier LIKE ? ESCAPE '!' OR e.note LIKE ? ESCAPE '!')",
      );
      parameters.push(like, like, like);
    }
    if (query.cursor) {
      const cursor = decodeItemCursor(query.cursor);
      if (!cursor) throw new InvalidCursorError();
      const cursorTime = new Date(cursor.updatedAt);
      if (Number.isNaN(cursorTime.getTime())) throw new InvalidCursorError();
      const mysqlCursorTime = toMySqlDateTime(cursorTime);
      predicates.push("(e.updated_at < ? OR (e.updated_at = ? AND e.id < ?))");
      parameters.push(mysqlCursorTime, mysqlCursorTime, cursor.id);
    }

    const [rows] = await this.pool.execute<ExamineeRow[]>(
      `SELECT ${examineeColumns}
       FROM examinees e
       WHERE ${predicates.join(" AND ")}
       ORDER BY e.updated_at DESC, e.id DESC
       LIMIT ${limit + 1}`,
      parameters,
    );
    const hasMore = rows.length > limit;
    const visibleRows = hasMore ? rows.slice(0, limit) : rows;
    const last = visibleRows.at(-1);
    return {
      items: visibleRows.map((row) => this.toExaminee(row)),
      page: {
        nextCursor:
          hasMore && last
            ? encodeItemCursor({
                updatedAt: toIso(last.updated_at) ?? "",
                id: last.id,
              })
            : null,
      },
    };
  }

  getExaminee(id: string, scope: QuestionBankScope): Promise<Examinee | null> {
    return this.getExamineeWith(this.pool, id, scope);
  }

  async findExamineeByIdentifier(
    identifier: string,
    scope: QuestionBankScope,
  ): Promise<Examinee | null> {
    const [rows] = await this.pool.execute<ExamineeRow[]>(
      `SELECT ${examineeColumns}
       FROM examinees e
       WHERE e.tenant_id = ? AND e.identifier = ? AND e.deleted_at IS NULL
       LIMIT 1`,
      [scope.tenantId, identifier],
    );
    return rows[0] ? this.toExaminee(rows[0]) : null;
  }

  async createExaminee(
    input: CreateExamineeInput,
    scope: QuestionBankScope,
  ): Promise<Examinee> {
    const id = randomUUID();
    const now = new Date();
    try {
      await withTransaction(this.pool, async (connection) => {
        await this.assertGroup(connection, input.groupId, scope);
        await connection.execute(
          `INSERT INTO examinees (
            id, tenant_id, group_id, created_by, code_ciphertext, code_digest,
            identifier, name, note, status, version, created_at, updated_at, deleted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
          [
            id,
            scope.tenantId,
            input.groupId,
            scope.actorUserId,
            this.credentials.protect(input.code),
            this.credentials.digest(input.code),
            input.identifier,
            input.name,
            input.note,
            input.status,
            now,
            now,
          ],
        );
      });
    } catch (error) {
      if (isDuplicateEntry(error)) {
        throw new ConflictError(
          "Examinee identifier or password already exists in this tenant.",
        );
      }
      throw error;
    }
    const examinee = await this.getExaminee(id, scope);
    if (!examinee)
      throw new Error("Examinee insert succeeded but could not be read.");
    return examinee;
  }

  async updateExaminee(
    id: string,
    input: UpdateExamineeInput,
    scope: QuestionBankScope,
  ): Promise<Examinee> {
    const updates: string[] = [];
    const values: SqlParam[] = [];
    const put = (column: string, value: SqlParam): void => {
      updates.push(`${column} = ?`);
      values.push(value);
    };
    if (input.groupId !== undefined) put("group_id", input.groupId);
    if (input.identifier !== undefined) put("identifier", input.identifier);
    if (input.name !== undefined) put("name", input.name);
    if (input.note !== undefined) put("note", input.note);
    if (input.status !== undefined) put("status", input.status);
    if (input.code !== undefined) {
      put("code_ciphertext", this.credentials.protect(input.code));
      put("code_digest", this.credentials.digest(input.code));
    }

    const now = new Date();
    try {
      await withTransaction(this.pool, async (connection) => {
        if (input.groupId !== undefined) {
          await this.assertGroup(connection, input.groupId, scope);
        }
        const [result] = await connection.execute<ResultSetHeader>(
          `UPDATE examinees
           SET ${updates.length > 0 ? `${updates.join(", ")}, ` : ""}version = version + 1, updated_at = ?
           WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND version = ?`,
          [...values, now, id, scope.tenantId, input.version],
        );
        if (result.affectedRows === 0) {
          await this.throwExamineeUpdateFailure(
            connection,
            id,
            input.version,
            scope,
          );
        }
      });
    } catch (error) {
      if (isDuplicateEntry(error)) {
        throw new ConflictError(
          "Examinee identifier or password already exists in this tenant.",
        );
      }
      throw error;
    }
    const examinee = await this.getExaminee(id, scope);
    if (!examinee) throw new NotFoundError("examinee", id);
    return examinee;
  }

  async softDeleteExaminee(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<void> {
    const now = new Date();
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE examinees
       SET version = version + 1, updated_at = ?, deleted_at = ?
       WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND version = ?`,
      [now, now, id, scope.tenantId, version],
    );
    if (result.affectedRows === 0) {
      await this.throwExamineeUpdateFailure(this.pool, id, version, scope);
    }
  }

  private async getGroupWith(
    executor: Executor,
    id: string,
    scope: QuestionBankScope,
  ): Promise<ExamineeGroup | null> {
    const [rows] = await executor.execute<GroupRow[]>(
      `SELECT ${groupColumns}
       FROM examinee_groups g
       WHERE g.id = ? AND g.tenant_id = ? AND g.deleted_at IS NULL
       LIMIT 1`,
      [id, scope.tenantId],
    );
    return rows[0] ? this.toGroup(rows[0]) : null;
  }

  private async getExamineeWith(
    executor: Executor,
    id: string,
    scope: QuestionBankScope,
  ): Promise<Examinee | null> {
    const [rows] = await executor.execute<ExamineeRow[]>(
      `SELECT ${examineeColumns}
       FROM examinees e
       WHERE e.id = ? AND e.tenant_id = ? AND e.deleted_at IS NULL
       LIMIT 1`,
      [id, scope.tenantId],
    );
    return rows[0] ? this.toExaminee(rows[0]) : null;
  }

  private async assertParent(
    executor: Executor,
    parentId: string | null,
    scope: QuestionBankScope,
  ): Promise<void> {
    if (parentId === null) return;
    const [rows] = await executor.execute<ParentRow[]>(
      `SELECT id, parent_id FROM examinee_groups
       WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
       LIMIT 1`,
      [parentId, scope.tenantId],
    );
    const parent = rows[0];
    if (!parent) {
      validationError(`Examinee group parentId "${parentId}" does not exist.`);
    }
    if (parent.parent_id !== null) {
      validationError("Examinee groups support at most two levels.");
    }
  }

  private async assertGroup(
    executor: Executor,
    groupId: string | null,
    scope: QuestionBankScope,
  ): Promise<void> {
    if (groupId === null) return;
    const [rows] = await executor.execute<IdRow[]>(
      `SELECT id FROM examinee_groups
       WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
       LIMIT 1`,
      [groupId, scope.tenantId],
    );
    if (!rows[0]) {
      validationError(`Examinee groupId "${groupId}" does not exist.`);
    }
  }

  private async throwGroupUpdateFailure(
    executor: Executor,
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<never> {
    const [rows] = await executor.execute<ExistingRow[]>(
      `SELECT id, version, deleted_at FROM examinee_groups
       WHERE id = ? AND tenant_id = ? LIMIT 1`,
      [id, scope.tenantId],
    );
    const row = rows[0];
    if (!row || row.deleted_at) throw new NotFoundError("examinee group", id);
    if (Number(row.version) !== version) {
      throw new ConflictError(
        `Examinee group ${id} has changed; reload before updating.`,
      );
    }
    throw new ConflictError(`Examinee group ${id} could not be updated.`);
  }

  private async throwExamineeUpdateFailure(
    executor: Executor,
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<never> {
    const [rows] = await executor.execute<ExistingRow[]>(
      `SELECT id, version, deleted_at FROM examinees
       WHERE id = ? AND tenant_id = ? LIMIT 1`,
      [id, scope.tenantId],
    );
    const row = rows[0];
    if (!row || row.deleted_at) throw new NotFoundError("examinee", id);
    if (Number(row.version) !== version) {
      throw new ConflictError(
        `Examinee ${id} has changed; reload before updating.`,
      );
    }
    throw new ConflictError(`Examinee ${id} could not be updated.`);
  }

  private toGroup(row: GroupRow): ExamineeGroup {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      parentId: row.parent_id,
      name: row.name,
      proctorPassword:
        row.proctor_password_ciphertext === null
          ? null
          : this.credentials.unprotect(row.proctor_password_ciphertext),
      sortOrder: Number(row.sort_order),
      version: Number(row.version),
      createdAt: toIso(row.created_at) ?? "",
      updatedAt: toIso(row.updated_at) ?? "",
      deletedAt: toIso(row.deleted_at),
    };
  }

  private toExaminee(row: ExamineeRow): Examinee {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      groupId: row.group_id,
      createdBy: row.created_by,
      code: this.credentials.unprotect(row.code_ciphertext),
      identifier: row.identifier,
      name: row.name,
      note: row.note,
      status: row.status,
      version: Number(row.version),
      createdAt: toIso(row.created_at) ?? "",
      updatedAt: toIso(row.updated_at) ?? "",
      deletedAt: toIso(row.deleted_at),
    };
  }
}

import { randomUUID } from "node:crypto";
import type {
  CreateTestBookletInput,
  Page,
  TestBooklet,
  TestBookletListQuery,
  UpdateTestBookletInput,
} from "@server-foundation/api-contracts";
import {
  ConflictError,
  DomainError,
  InvalidCursorError,
  NotFoundError,
} from "@server-foundation/domain";
import type {
  QuestionBankScope,
  TestBookletRepository,
} from "@server-foundation/domain";
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import { decodeItemCursor, encodeItemCursor } from "./cursor.js";
import { withTransaction } from "./transaction.js";

type Executor = Pick<PoolConnection, "execute">;
type SqlParam = string | number | boolean | Date | null;

type BookletRow = RowDataPacket & {
  id: string;
  tenant_id: string;
  created_by: string;
  subject_id: string | null;
  category_id: string | null;
  code: string;
  name: string;
  description: string | null;
  status: TestBooklet["status"];
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
  deleted_at: Date | string | null;
};

type BookletItemRow = RowDataPacket & {
  booklet_id: string;
  group_id: string;
  position: number;
  item_available: number | string;
};

type ExistingRow = RowDataPacket & {
  id: string;
  version: number;
  deleted_at: Date | string | null;
};
type IdRow = RowDataPacket & { id: string };

type GroupIdRow = RowDataPacket & { group_id: string };

const bookletColumns = `
  b.id, b.tenant_id, b.created_by, b.subject_id, b.category_id,
  b.code, b.name, b.description, b.status, b.version,
  b.created_at, b.updated_at, b.deleted_at`;

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
    throw new Error("MySQL returned an invalid test booklet date.");
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

const toBooklet = (
  row: BookletRow,
  items: TestBooklet["items"] = [],
): TestBooklet => ({
  id: row.id,
  tenantId: row.tenant_id,
  createdBy: row.created_by,
  subjectId: row.subject_id,
  categoryId: row.category_id,
  code: row.code,
  name: row.name,
  description: row.description,
  status: row.status,
  version: row.version,
  items,
  createdAt: toIso(row.created_at) ?? "",
  updatedAt: toIso(row.updated_at) ?? "",
  deletedAt: toIso(row.deleted_at),
});

const itemMapFor = async (
  executor: Executor,
  bookletIds: string[],
  tenantId: string,
): Promise<Map<string, TestBooklet["items"]>> => {
  const result = new Map<string, TestBooklet["items"]>();
  if (bookletIds.length === 0) return result;
  const placeholders = bookletIds.map(() => "?").join(", ");
  const [rawRows] = await executor.execute(
    `SELECT bi.booklet_id, bi.group_id, bi.position,
            CASE WHEN g.id IS NOT NULL AND g.deleted_at IS NULL THEN 1 ELSE 0 END AS item_available
     FROM test_booklet_items bi
     LEFT JOIN question_groups g
       ON g.id = bi.group_id AND g.tenant_id = ?
     WHERE bi.tenant_id = ? AND bi.booklet_id IN (${placeholders})
     ORDER BY bi.booklet_id, bi.position, bi.id`,
    [tenantId, tenantId, ...bookletIds],
  );
  for (const row of rawRows as BookletItemRow[]) {
    const items = result.get(row.booklet_id) ?? [];
    items.push({
      groupId: row.group_id,
      position: row.position,
      available: Number(row.item_available) === 1,
    });
    result.set(row.booklet_id, items);
  }
  return result;
};

export class MySqlTestBookletRepository implements TestBookletRepository {
  constructor(private readonly pool: Pool) {}

  async listBooklets(
    query: TestBookletListQuery,
    scope: QuestionBankScope,
  ): Promise<Page<TestBooklet>> {
    const predicates = ["b.tenant_id = ?", "b.deleted_at IS NULL"];
    const parameters: Array<string | number> = [scope.tenantId];
    const search = query.search?.trim();
    const limit = Math.min(Math.max(Math.trunc(query.limit), 1), 100);

    if (query.createdBy) {
      predicates.push("b.created_by = ?");
      parameters.push(query.createdBy);
    }
    if (query.status) {
      predicates.push("b.status = ?");
      parameters.push(query.status);
    }
    if (query.subjectId) {
      predicates.push("b.subject_id = ?");
      parameters.push(query.subjectId);
    }
    if (query.categoryId) {
      predicates.push("b.category_id = ?");
      parameters.push(query.categoryId);
    }
    if (search) {
      const like = `%${escapeLike(search)}%`;
      predicates.push(
        "(b.code LIKE ? ESCAPE '!' OR b.name LIKE ? ESCAPE '!' OR b.description LIKE ? ESCAPE '!')",
      );
      parameters.push(like, like, like);
    }
    if (query.cursor) {
      const cursor = decodeItemCursor(query.cursor);
      if (!cursor) throw new InvalidCursorError();
      const cursorTime = new Date(cursor.updatedAt);
      if (Number.isNaN(cursorTime.getTime())) throw new InvalidCursorError();
      const mysqlCursorTime = toMySqlDateTime(cursorTime);
      predicates.push("(b.updated_at < ? OR (b.updated_at = ? AND b.id < ?))");
      parameters.push(mysqlCursorTime, mysqlCursorTime, cursor.id);
    }

    const [rows] = await this.pool.execute<BookletRow[]>(
      `SELECT ${bookletColumns}
       FROM test_booklets b
       WHERE ${predicates.join(" AND ")}
       ORDER BY b.updated_at DESC, b.id DESC
       LIMIT ${limit + 1}`,
      parameters,
    );
    const hasMore = rows.length > limit;
    const visibleRows = hasMore ? rows.slice(0, limit) : rows;
    const itemMap = await itemMapFor(
      this.pool,
      visibleRows.map((row) => row.id),
      scope.tenantId,
    );
    const last = visibleRows.at(-1);
    return {
      items: visibleRows.map((row) =>
        toBooklet(row, itemMap.get(row.id) ?? []),
      ),
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

  getBooklet(
    id: string,
    scope: QuestionBankScope,
  ): Promise<TestBooklet | null> {
    return this.getBookletWith(this.pool, id, scope);
  }

  async createBooklet(
    input: CreateTestBookletInput,
    scope: QuestionBankScope,
  ): Promise<TestBooklet> {
    const id = randomUUID();
    const now = new Date();
    try {
      await withTransaction(this.pool, async (connection) => {
        await this.assertCategory(connection, input.categoryId, scope);
        await this.assertGroups(connection, input.groupIds, scope);
        await connection.execute(
          `INSERT INTO test_booklets (
            id, tenant_id, created_by, subject_id, category_id, code, name,
            description, status, version, created_at, updated_at, deleted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
          [
            id,
            scope.tenantId,
            scope.actorUserId,
            input.subjectId,
            input.categoryId,
            input.code,
            input.name,
            input.description,
            input.status,
            now,
            now,
          ],
        );
        await this.replaceItems(connection, id, input.groupIds, scope, now);
      });
    } catch (error) {
      if (isDuplicateEntry(error)) {
        throw new ConflictError(
          `Test booklet code ${input.code} already exists in this tenant.`,
        );
      }
      throw error;
    }
    const booklet = await this.getBooklet(id, scope);
    if (!booklet)
      throw new Error("Test booklet insert succeeded but could not be read.");
    return booklet;
  }

  async updateBooklet(
    id: string,
    input: UpdateTestBookletInput,
    scope: QuestionBankScope,
  ): Promise<TestBooklet> {
    const updates: string[] = [];
    const values: SqlParam[] = [];
    const put = (column: string, value: SqlParam): void => {
      updates.push(`${column} = ?`);
      values.push(value);
    };

    if (input.subjectId !== undefined) put("subject_id", input.subjectId);
    if (input.categoryId !== undefined) put("category_id", input.categoryId);
    if (input.code !== undefined) put("code", input.code);
    if (input.name !== undefined) put("name", input.name);
    if (input.description !== undefined) put("description", input.description);
    if (input.status !== undefined) put("status", input.status);

    const now = new Date();
    try {
      await withTransaction(this.pool, async (connection) => {
        if (input.categoryId !== undefined) {
          await this.assertCategory(connection, input.categoryId, scope);
        }
        if (input.groupIds !== undefined) {
          await this.assertGroups(connection, input.groupIds, scope);
        }
        const [result] = await connection.execute<ResultSetHeader>(
          `UPDATE test_booklets
           SET ${updates.length > 0 ? `${updates.join(", ")}, ` : ""}version = version + 1, updated_at = ?
           WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND version = ?`,
          [...values, now, id, scope.tenantId, input.version],
        );
        if (result.affectedRows === 0) {
          await this.throwUpdateFailure(connection, id, input.version, scope);
        }
        if (input.groupIds !== undefined) {
          await this.replaceItems(connection, id, input.groupIds, scope, now);
        }
      });
    } catch (error) {
      if (isDuplicateEntry(error)) {
        throw new ConflictError(
          "Test booklet code already exists in this tenant.",
        );
      }
      throw error;
    }
    const booklet = await this.getBooklet(id, scope);
    if (!booklet) throw new NotFoundError("test booklet", id);
    return booklet;
  }

  async softDeleteBooklet(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<void> {
    const now = new Date();
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE test_booklets
       SET version = version + 1, updated_at = ?, deleted_at = ?
       WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND version = ?`,
      [now, now, id, scope.tenantId, version],
    );
    if (result.affectedRows === 0) {
      await this.throwUpdateFailure(this.pool, id, version, scope);
    }
  }

  async duplicateBooklet(
    id: string,
    scope: QuestionBankScope,
  ): Promise<TestBooklet> {
    const newId = randomUUID();
    const suffix = `-copy-${newId.slice(0, 8)}`;
    const now = new Date();

    await withTransaction(this.pool, async (connection) => {
      const [rows] = await connection.execute<BookletRow[]>(
        `SELECT ${bookletColumns}
         FROM test_booklets b
         WHERE b.id = ? AND b.tenant_id = ? AND b.deleted_at IS NULL
         LIMIT 1`,
        [id, scope.tenantId],
      );
      const source = rows[0];
      if (!source) throw new NotFoundError("test booklet", id);

      const [itemRows] = await connection.execute<GroupIdRow[]>(
        `SELECT group_id
         FROM test_booklet_items
         WHERE tenant_id = ? AND booklet_id = ?
         ORDER BY position, id`,
        [scope.tenantId, id],
      );
      const groupIds = itemRows.map((row) => row.group_id);
      await this.assertGroups(connection, groupIds, scope);

      const code = `${source.code.slice(0, 50 - suffix.length)}${suffix}`;
      const name = `${source.name.slice(0, 193)} (copy)`;
      try {
        await connection.execute(
          `INSERT INTO test_booklets (
            id, tenant_id, created_by, subject_id, category_id, code, name,
            description, status, version, created_at, updated_at, deleted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'disabled', 1, ?, ?, NULL)`,
          [
            newId,
            scope.tenantId,
            scope.actorUserId,
            source.subject_id,
            source.category_id,
            code,
            name,
            source.description,
            now,
            now,
          ],
        );
      } catch (error) {
        if (isDuplicateEntry(error)) {
          throw new ConflictError(
            "Could not allocate a unique code for the test booklet copy.",
          );
        }
        throw error;
      }
      await this.replaceItems(connection, newId, groupIds, scope, now);
    });

    const copy = await this.getBooklet(newId, scope);
    if (!copy)
      throw new Error("Test booklet copy succeeded but could not be read.");
    return copy;
  }

  private async getBookletWith(
    executor: Executor,
    id: string,
    scope: QuestionBankScope,
  ): Promise<TestBooklet | null> {
    const [rows] = await executor.execute<BookletRow[]>(
      `SELECT ${bookletColumns}
       FROM test_booklets b
       WHERE b.id = ? AND b.tenant_id = ? AND b.deleted_at IS NULL
       LIMIT 1`,
      [id, scope.tenantId],
    );
    const row = rows[0];
    if (!row) return null;
    const items = await itemMapFor(executor, [id], scope.tenantId);
    return toBooklet(row, items.get(id) ?? []);
  }

  private async assertCategory(
    executor: Executor,
    categoryId: string | null,
    scope: QuestionBankScope,
  ): Promise<void> {
    if (categoryId === null) return;
    const [rows] = await executor.execute<IdRow[]>(
      `SELECT id FROM question_categories
       WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
       LIMIT 1`,
      [categoryId, scope.tenantId],
    );
    if (rows.length === 0) {
      validationError(
        `Test booklet categoryId "${categoryId}" does not exist.`,
      );
    }
  }

  private async assertGroups(
    executor: Executor,
    groupIds: string[],
    scope: QuestionBankScope,
  ): Promise<void> {
    if (groupIds.length === 0) return;
    const placeholders = groupIds.map(() => "?").join(", ");
    const [rows] = await executor.execute<IdRow[]>(
      `SELECT id FROM question_groups
       WHERE tenant_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`,
      [scope.tenantId, ...groupIds],
    );
    const found = new Set(rows.map((row) => row.id));
    const missing = groupIds.find((groupId) => !found.has(groupId));
    if (missing) {
      validationError(`Test booklet groupId "${missing}" does not exist.`);
    }
  }

  private async replaceItems(
    connection: PoolConnection,
    bookletId: string,
    groupIds: string[],
    scope: QuestionBankScope,
    now: Date,
  ): Promise<void> {
    await connection.execute(
      "DELETE FROM test_booklet_items WHERE tenant_id = ? AND booklet_id = ?",
      [scope.tenantId, bookletId],
    );
    for (const [position, groupId] of groupIds.entries()) {
      await connection.execute(
        `INSERT INTO test_booklet_items (
          id, tenant_id, booklet_id, group_id, position, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        [randomUUID(), scope.tenantId, bookletId, groupId, position, now],
      );
    }
  }

  private async throwUpdateFailure(
    executor: Executor,
    id: string,
    expectedVersion: number,
    scope: QuestionBankScope,
  ): Promise<never> {
    const [rows] = await executor.execute<ExistingRow[]>(
      `SELECT id, version, deleted_at
       FROM test_booklets
       WHERE id = ? AND tenant_id = ?
       LIMIT 1`,
      [id, scope.tenantId],
    );
    const row = rows[0];
    if (!row || row.deleted_at) throw new NotFoundError("test booklet", id);
    throw new ConflictError(
      `Test booklet ${id} has changed; expected version ${expectedVersion}, current version is ${row.version}.`,
    );
  }
}

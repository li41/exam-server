import { randomUUID } from "node:crypto";
import type {
  CreateItemInput,
  Item,
  ItemListQuery,
  Page,
  UpdateItemInput,
} from "@server-foundation/api-contracts";
import {
  ConflictError,
  InvalidCursorError,
  NotFoundError,
} from "@server-foundation/domain";
import type { ItemRepository, ItemScope } from "@server-foundation/domain";
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { decodeItemCursor, encodeItemCursor } from "./cursor.js";

type ItemRow = RowDataPacket & {
  id: string;
  tenant_id: string | null;
  title: string;
  status: "draft" | "ready";
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
  deleted_at: Date | string | null;
};

type ExistingItemRow = RowDataPacket & {
  id: string;
  deleted_at: Date | string | null;
};

const itemColumns =
  "id, tenant_id, title, status, version, created_at, updated_at, deleted_at";

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
  if (Number.isNaN(date.getTime()))
    throw new Error("MySQL returned an invalid date.");
  return date.toISOString();
};

const toItem = (row: ItemRow): Item => ({
  id: row.id,
  tenantId: row.tenant_id ?? "",
  title: row.title,
  status: row.status,
  version: row.version,
  createdAt: toIso(row.created_at) ?? "",
  updatedAt: toIso(row.updated_at) ?? "",
  deletedAt: toIso(row.deleted_at),
});

const toMySqlDateTime = (value: Date): string =>
  value.toISOString().slice(0, 23).replace("T", " ");

const escapeLike = (value: string): string =>
  value.replace(/[!%_]/g, (character) => `!${character}`);

export class MySqlItemRepository implements ItemRepository {
  constructor(private readonly pool: Pool) {}

  async list(query: ItemListQuery, scope: ItemScope): Promise<Page<Item>> {
    const predicates = ["tenant_id = ?", "deleted_at IS NULL"];
    const parameters: Array<string | number> = [scope.tenantId];
    const search = query.search?.trim();
    const limit = Math.min(Math.max(Math.trunc(query.limit), 1), 100);

    if (search) {
      predicates.push("title LIKE ? ESCAPE '!'");
      parameters.push(`%${escapeLike(search)}%`);
    }

    if (query.cursor) {
      const cursor = decodeItemCursor(query.cursor);
      if (!cursor) throw new InvalidCursorError();
      const cursorTime = new Date(cursor.updatedAt);
      if (Number.isNaN(cursorTime.getTime())) throw new InvalidCursorError();
      const mysqlCursorTime = toMySqlDateTime(cursorTime);
      predicates.push("(updated_at < ? OR (updated_at = ? AND id < ?))");
      parameters.push(mysqlCursorTime, mysqlCursorTime, cursor.id);
    }

    const [rows] = await this.pool.execute<ItemRow[]>(
      `SELECT ${itemColumns}
       FROM items
       WHERE ${predicates.join(" AND ")}
       ORDER BY updated_at DESC, id DESC
       LIMIT ${limit + 1}`,
      parameters,
    );

    const hasMore = rows.length > limit;
    const visibleRows = hasMore ? rows.slice(0, limit) : rows;
    const last = visibleRows.at(-1);

    return {
      items: visibleRows.map(toItem),
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

  async get(id: string, scope: ItemScope): Promise<Item | null> {
    const [rows] = await this.pool.execute<ItemRow[]>(
      `SELECT ${itemColumns}
       FROM items
       WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
       LIMIT 1`,
      [id, scope.tenantId],
    );
    const row = rows[0];
    return row ? toItem(row) : null;
  }

  async create(input: CreateItemInput, scope: ItemScope): Promise<Item> {
    const id = randomUUID();
    const now = new Date();
    await this.pool.execute(
      `INSERT INTO items
        (id, tenant_id, title, status, version, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, 'draft', 1, ?, ?, NULL)`,
      [id, scope.tenantId, input.title, now, now],
    );
    const item = await this.get(id, scope);
    if (!item)
      throw new Error(
        "MySQL item insert succeeded but the item could not be read.",
      );
    return item;
  }

  async update(
    id: string,
    input: UpdateItemInput,
    scope: ItemScope,
  ): Promise<Item> {
    const now = new Date();
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE items
       SET title = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND version = ?`,
      [input.title, now, id, scope.tenantId, input.version],
    );

    if (result.affectedRows === 0)
      await this.throwUpdateFailure(id, input.version, scope);
    const item = await this.get(id, scope);
    if (!item) throw new NotFoundError("item", id);
    return item;
  }

  async softDelete(
    id: string,
    version: number,
    scope: ItemScope,
  ): Promise<void> {
    const now = new Date();
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE items
       SET version = version + 1, updated_at = ?, deleted_at = ?
       WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND version = ?`,
      [now, now, id, scope.tenantId, version],
    );

    if (result.affectedRows === 0)
      await this.throwUpdateFailure(id, version, scope);
  }

  private async throwUpdateFailure(
    id: string,
    version: number,
    scope: ItemScope,
  ): Promise<never> {
    const [rows] = await this.pool.execute<ExistingItemRow[]>(
      "SELECT id, deleted_at FROM items WHERE id = ? AND tenant_id = ? LIMIT 1",
      [id, scope.tenantId],
    );
    const row = rows[0];
    if (!row || row.deleted_at !== null) throw new NotFoundError("item", id);
    throw new ConflictError(
      `Item ${id} has changed; expected version ${version}.`,
    );
  }
}

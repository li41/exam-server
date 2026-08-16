import { randomUUID } from "node:crypto";
import type {
  CreateQuestionClusterInput,
  CreateQuestionGroupInput,
  Page,
  QuestionCluster,
  QuestionClusterListQuery,
  QuestionGroup,
  QuestionGroupItemInput,
  QuestionGroupListQuery,
  UpdateQuestionClusterInput,
  UpdateQuestionGroupInput,
} from "@server-foundation/api-contracts";
import {
  ConflictError,
  DomainError,
  InvalidCursorError,
  NotFoundError,
} from "@server-foundation/domain";
import type {
  QuestionBankScope,
  QuestionStructureRepository,
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

type ClusterRow = RowDataPacket & {
  id: string;
  tenant_id: string;
  created_by: string;
  code: string;
  name: string;
  stem: string;
  stem_file_id: string | null;
  description: string | null;
  status: QuestionCluster["status"];
  usage_count: number;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
  deleted_at: Date | string | null;
};

type ClusterItemRow = RowDataPacket & {
  cluster_id: string;
  question_id: string;
  position: number;
  item_available: number | string;
};

type GroupRow = RowDataPacket & {
  id: string;
  tenant_id: string;
  created_by: string;
  code: string;
  name: string;
  description: string | null;
  subject_id: string | null;
  flow_mode: QuestionGroup["flowMode"];
  status: QuestionGroup["status"];
  usage_count: number;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
  deleted_at: Date | string | null;
};

type GroupItemRow = RowDataPacket & {
  group_id: string;
  item_type: "question" | "cluster";
  question_id: string | null;
  cluster_id: string | null;
  position: number;
  item_available: number | string;
};

type ExistingRow = RowDataPacket & {
  id: string;
  version: number;
  deleted_at: Date | string | null;
};

type IdRow = RowDataPacket & { id: string };
type ClusterQuestionRow = RowDataPacket & {
  question_id: string;
  cluster_id: string;
};
type CountRow = RowDataPacket & { count: number };

const clusterColumns = `
  c.id, c.tenant_id, c.created_by, c.code, c.name, c.stem,
  c.stem_file_id, c.description, c.status, c.usage_count, c.version,
  c.created_at, c.updated_at, c.deleted_at`;

const groupColumns = `
  g.id, g.tenant_id, g.created_by, g.code, g.name, g.description,
  g.subject_id, g.flow_mode, g.status, g.usage_count, g.version,
  g.created_at, g.updated_at, g.deleted_at`;

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
    throw new Error("MySQL returned an invalid question structure date.");
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

const clusterItemMapFor = async (
  executor: Executor,
  ids: string[],
  tenantId: string,
): Promise<Map<string, QuestionCluster["items"]>> => {
  const result = new Map<string, QuestionCluster["items"]>();
  if (ids.length === 0) return result;
  const placeholders = ids.map(() => "?").join(", ");
  const [rawRows] = await executor.execute(
    `SELECT ci.cluster_id, ci.question_id, ci.position,
            CASE WHEN q.id IS NOT NULL AND q.deleted_at IS NULL THEN 1 ELSE 0 END AS item_available
     FROM question_cluster_items ci
     LEFT JOIN questions q
       ON q.id = ci.question_id AND q.tenant_id = ?
     WHERE ci.tenant_id = ? AND ci.cluster_id IN (${placeholders})
     ORDER BY ci.cluster_id, ci.position, ci.id`,
    [tenantId, tenantId, ...ids],
  );
  for (const row of rawRows as ClusterItemRow[]) {
    const items = result.get(row.cluster_id) ?? [];
    items.push({
      questionId: row.question_id,
      position: row.position,
      available: Number(row.item_available) === 1,
    });
    result.set(row.cluster_id, items);
  }
  return result;
};

const groupItemMapFor = async (
  executor: Executor,
  ids: string[],
  tenantId: string,
): Promise<Map<string, QuestionGroup["items"]>> => {
  const result = new Map<string, QuestionGroup["items"]>();
  if (ids.length === 0) return result;
  const placeholders = ids.map(() => "?").join(", ");
  const [rawRows] = await executor.execute(
    `SELECT gi.group_id, gi.item_type, gi.question_id, gi.cluster_id, gi.position,
            CASE
              WHEN gi.item_type = 'question' AND q.id IS NOT NULL AND q.deleted_at IS NULL THEN 1
              WHEN gi.item_type = 'cluster' AND c.id IS NOT NULL AND c.deleted_at IS NULL THEN 1
              ELSE 0
            END AS item_available
     FROM question_group_items gi
     LEFT JOIN questions q
       ON gi.item_type = 'question' AND q.id = gi.question_id AND q.tenant_id = ?
     LEFT JOIN question_clusters c
       ON gi.item_type = 'cluster' AND c.id = gi.cluster_id AND c.tenant_id = ?
     WHERE gi.tenant_id = ? AND gi.group_id IN (${placeholders})
     ORDER BY gi.group_id, gi.position, gi.id`,
    [tenantId, tenantId, tenantId, ...ids],
  );
  for (const row of rawRows as GroupItemRow[]) {
    const items = result.get(row.group_id) ?? [];
    if (row.item_type === "question" && row.question_id) {
      items.push({
        itemType: "question",
        questionId: row.question_id,
        position: row.position,
        available: Number(row.item_available) === 1,
      });
    } else if (row.item_type === "cluster" && row.cluster_id) {
      items.push({
        itemType: "cluster",
        clusterId: row.cluster_id,
        position: row.position,
        available: Number(row.item_available) === 1,
      });
    }
    result.set(row.group_id, items);
  }
  return result;
};

const toCluster = (
  row: ClusterRow,
  items: QuestionCluster["items"] = [],
): QuestionCluster => ({
  id: row.id,
  tenantId: row.tenant_id,
  createdBy: row.created_by,
  code: row.code,
  name: row.name,
  stem: row.stem,
  stemFileId: row.stem_file_id,
  description: row.description,
  status: row.status,
  usageCount: row.usage_count,
  version: row.version,
  items,
  createdAt: toIso(row.created_at) ?? "",
  updatedAt: toIso(row.updated_at) ?? "",
  deletedAt: toIso(row.deleted_at),
});

const toGroup = (
  row: GroupRow,
  items: QuestionGroup["items"] = [],
): QuestionGroup => ({
  id: row.id,
  tenantId: row.tenant_id,
  createdBy: row.created_by,
  code: row.code,
  name: row.name,
  description: row.description,
  subjectId: row.subject_id,
  flowMode: row.flow_mode,
  status: row.status,
  usageCount: row.usage_count,
  version: row.version,
  items,
  createdAt: toIso(row.created_at) ?? "",
  updatedAt: toIso(row.updated_at) ?? "",
  deletedAt: toIso(row.deleted_at),
});

export class MySqlQuestionStructureRepository
  implements QuestionStructureRepository
{
  constructor(private readonly pool: Pool) {}

  async listClusters(
    query: QuestionClusterListQuery,
    scope: QuestionBankScope,
  ): Promise<Page<QuestionCluster>> {
    const predicates = ["c.tenant_id = ?", "c.deleted_at IS NULL"];
    const parameters: Array<string | number> = [scope.tenantId];
    const search = query.search?.trim();
    const limit = Math.min(Math.max(Math.trunc(query.limit), 1), 100);

    if (query.createdBy) {
      predicates.push("c.created_by = ?");
      parameters.push(query.createdBy);
    }
    if (query.status) {
      predicates.push("c.status = ?");
      parameters.push(query.status);
    }
    if (search) {
      const like = `%${escapeLike(search)}%`;
      predicates.push(
        "(c.code LIKE ? ESCAPE '!' OR c.name LIKE ? ESCAPE '!' OR c.stem LIKE ? ESCAPE '!' OR c.description LIKE ? ESCAPE '!')",
      );
      parameters.push(like, like, like, like);
    }
    if (query.cursor) {
      const cursor = decodeItemCursor(query.cursor);
      if (!cursor) throw new InvalidCursorError();
      const cursorTime = new Date(cursor.updatedAt);
      if (Number.isNaN(cursorTime.getTime())) throw new InvalidCursorError();
      const mysqlCursorTime = toMySqlDateTime(cursorTime);
      predicates.push("(c.updated_at < ? OR (c.updated_at = ? AND c.id < ?))");
      parameters.push(mysqlCursorTime, mysqlCursorTime, cursor.id);
    }

    const [rows] = await this.pool.execute<ClusterRow[]>(
      `SELECT ${clusterColumns}
       FROM question_clusters c
       WHERE ${predicates.join(" AND ")}
       ORDER BY c.updated_at DESC, c.id DESC
       LIMIT ${limit + 1}`,
      parameters,
    );
    const hasMore = rows.length > limit;
    const visibleRows = hasMore ? rows.slice(0, limit) : rows;
    const itemMap = await clusterItemMapFor(
      this.pool,
      visibleRows.map((row) => row.id),
      scope.tenantId,
    );
    const last = visibleRows.at(-1);
    return {
      items: visibleRows.map((row) => toCluster(row, itemMap.get(row.id) ?? [])),
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

  async getCluster(
    id: string,
    scope: QuestionBankScope,
  ): Promise<QuestionCluster | null> {
    return this.getClusterWith(this.pool, id, scope);
  }

  async createCluster(
    input: CreateQuestionClusterInput,
    scope: QuestionBankScope,
  ): Promise<QuestionCluster> {
    const id = randomUUID();
    const now = new Date();
    try {
      await withTransaction(this.pool, async (connection) => {
        await this.assertFile(connection, input.stemFileId, scope);
        await this.assertQuestions(connection, input.questionIds, scope, "cluster");
        await connection.execute(
          `INSERT INTO question_clusters (
            id, tenant_id, created_by, code, name, stem, stem_file_id,
            description, status, usage_count, version, created_at, updated_at, deleted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, NULL)`,
          [
            id,
            scope.tenantId,
            scope.actorUserId,
            input.code,
            input.name,
            input.stem,
            input.stemFileId,
            input.description,
            input.status,
            now,
            now,
          ],
        );
        await this.replaceClusterItems(
          connection,
          id,
          input.questionIds,
          scope,
          now,
        );
      });
    } catch (error) {
      if (isDuplicateEntry(error)) {
        throw new ConflictError(
          `Question cluster code ${input.code} already exists in this tenant.`,
        );
      }
      throw error;
    }
    const cluster = await this.getCluster(id, scope);
    if (!cluster) {
      throw new Error("Question cluster insert succeeded but could not be read.");
    }
    return cluster;
  }

  async updateCluster(
    id: string,
    input: UpdateQuestionClusterInput,
    scope: QuestionBankScope,
  ): Promise<QuestionCluster> {
    const updates: string[] = [];
    const values: SqlParam[] = [];
    const put = (column: string, value: SqlParam): void => {
      updates.push(`${column} = ?`);
      values.push(value);
    };

    if (input.code !== undefined) put("code", input.code);
    if (input.name !== undefined) put("name", input.name);
    if (input.stem !== undefined) put("stem", input.stem);
    if (input.stemFileId !== undefined) put("stem_file_id", input.stemFileId);
    if (input.description !== undefined) put("description", input.description);
    if (input.status !== undefined) put("status", input.status);

    const now = new Date();
    try {
      await withTransaction(this.pool, async (connection) => {
        if (input.stemFileId !== undefined) {
          await this.assertFile(connection, input.stemFileId, scope);
        }
        if (input.questionIds !== undefined) {
          await this.assertQuestions(
            connection,
            input.questionIds,
            scope,
            "cluster",
          );
        }
        const [result] = await connection.execute<ResultSetHeader>(
          `UPDATE question_clusters
           SET ${updates.length > 0 ? `${updates.join(", ")}, ` : ""}version = version + 1, updated_at = ?
           WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND version = ?`,
          [...values, now, id, scope.tenantId, input.version],
        );
        if (result.affectedRows === 0) {
          await this.throwClusterUpdateFailure(
            connection,
            id,
            input.version,
            scope,
          );
        }
        if (input.questionIds !== undefined) {
          await this.replaceClusterItems(
            connection,
            id,
            input.questionIds,
            scope,
            now,
          );
        }
      });
    } catch (error) {
      if (isDuplicateEntry(error)) {
        throw new ConflictError(
          "Question cluster code already exists in this tenant.",
        );
      }
      throw error;
    }
    const cluster = await this.getCluster(id, scope);
    if (!cluster) throw new NotFoundError("question cluster", id);
    return cluster;
  }

  async softDeleteCluster(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<void> {
    const now = new Date();
    await withTransaction(this.pool, async (connection) => {
      const [references] = await connection.execute<CountRow[]>(
        `SELECT COUNT(*) AS count
         FROM question_group_items gi
         INNER JOIN question_groups g ON g.id = gi.group_id
         WHERE gi.tenant_id = ? AND gi.item_type = 'cluster' AND gi.cluster_id = ?
           AND g.tenant_id = ? AND g.deleted_at IS NULL`,
        [scope.tenantId, id, scope.tenantId],
      );
      if (Number(references[0]?.count ?? 0) > 0) {
        throw new ConflictError(
          "Question cluster is still referenced by an active question group.",
        );
      }
      const [result] = await connection.execute<ResultSetHeader>(
        `UPDATE question_clusters
         SET version = version + 1, updated_at = ?, deleted_at = ?
         WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND version = ?`,
        [now, now, id, scope.tenantId, version],
      );
      if (result.affectedRows === 0) {
        await this.throwClusterUpdateFailure(connection, id, version, scope);
      }
    });
  }

  async listGroups(
    query: QuestionGroupListQuery,
    scope: QuestionBankScope,
  ): Promise<Page<QuestionGroup>> {
    const predicates = ["g.tenant_id = ?", "g.deleted_at IS NULL"];
    const parameters: Array<string | number> = [scope.tenantId];
    const search = query.search?.trim();
    const limit = Math.min(Math.max(Math.trunc(query.limit), 1), 100);

    if (query.createdBy) {
      predicates.push("g.created_by = ?");
      parameters.push(query.createdBy);
    }
    if (query.status) {
      predicates.push("g.status = ?");
      parameters.push(query.status);
    }
    if (query.subjectId) {
      predicates.push("g.subject_id = ?");
      parameters.push(query.subjectId);
    }
    if (query.flowMode) {
      predicates.push("g.flow_mode = ?");
      parameters.push(query.flowMode);
    }
    if (search) {
      const like = `%${escapeLike(search)}%`;
      predicates.push(
        "(g.code LIKE ? ESCAPE '!' OR g.name LIKE ? ESCAPE '!' OR g.description LIKE ? ESCAPE '!')",
      );
      parameters.push(like, like, like);
    }
    if (query.cursor) {
      const cursor = decodeItemCursor(query.cursor);
      if (!cursor) throw new InvalidCursorError();
      const cursorTime = new Date(cursor.updatedAt);
      if (Number.isNaN(cursorTime.getTime())) throw new InvalidCursorError();
      const mysqlCursorTime = toMySqlDateTime(cursorTime);
      predicates.push("(g.updated_at < ? OR (g.updated_at = ? AND g.id < ?))");
      parameters.push(mysqlCursorTime, mysqlCursorTime, cursor.id);
    }

    const [rows] = await this.pool.execute<GroupRow[]>(
      `SELECT ${groupColumns}
       FROM question_groups g
       WHERE ${predicates.join(" AND ")}
       ORDER BY g.updated_at DESC, g.id DESC
       LIMIT ${limit + 1}`,
      parameters,
    );
    const hasMore = rows.length > limit;
    const visibleRows = hasMore ? rows.slice(0, limit) : rows;
    const itemMap = await groupItemMapFor(
      this.pool,
      visibleRows.map((row) => row.id),
      scope.tenantId,
    );
    const last = visibleRows.at(-1);
    return {
      items: visibleRows.map((row) => toGroup(row, itemMap.get(row.id) ?? [])),
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

  async getGroup(
    id: string,
    scope: QuestionBankScope,
  ): Promise<QuestionGroup | null> {
    return this.getGroupWith(this.pool, id, scope);
  }

  async createGroup(
    input: CreateQuestionGroupInput,
    scope: QuestionBankScope,
  ): Promise<QuestionGroup> {
    const id = randomUUID();
    const now = new Date();
    try {
      await withTransaction(this.pool, async (connection) => {
        await this.assertSubject(connection, input.subjectId, scope);
        await this.assertGroupItems(connection, input.items, scope);
        await connection.execute(
          `INSERT INTO question_groups (
            id, tenant_id, created_by, code, name, description, subject_id,
            flow_mode, status, usage_count, version, created_at, updated_at, deleted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, NULL)`,
          [
            id,
            scope.tenantId,
            scope.actorUserId,
            input.code,
            input.name,
            input.description,
            input.subjectId,
            input.flowMode,
            input.status,
            now,
            now,
          ],
        );
        await this.replaceGroupItems(connection, id, input.items, scope, now);
      });
    } catch (error) {
      if (isDuplicateEntry(error)) {
        throw new ConflictError(
          `Question group code ${input.code} already exists in this tenant.`,
        );
      }
      throw error;
    }
    const group = await this.getGroup(id, scope);
    if (!group) {
      throw new Error("Question group insert succeeded but could not be read.");
    }
    return group;
  }

  async updateGroup(
    id: string,
    input: UpdateQuestionGroupInput,
    scope: QuestionBankScope,
  ): Promise<QuestionGroup> {
    const updates: string[] = [];
    const values: SqlParam[] = [];
    const put = (column: string, value: SqlParam): void => {
      updates.push(`${column} = ?`);
      values.push(value);
    };

    if (input.code !== undefined) put("code", input.code);
    if (input.name !== undefined) put("name", input.name);
    if (input.description !== undefined) put("description", input.description);
    if (input.subjectId !== undefined) put("subject_id", input.subjectId);
    if (input.flowMode !== undefined) put("flow_mode", input.flowMode);
    if (input.status !== undefined) put("status", input.status);

    const now = new Date();
    try {
      await withTransaction(this.pool, async (connection) => {
        if (input.subjectId !== undefined) {
          await this.assertSubject(connection, input.subjectId, scope);
        }
        if (input.items !== undefined) {
          await this.assertGroupItems(connection, input.items, scope);
        }
        const [result] = await connection.execute<ResultSetHeader>(
          `UPDATE question_groups
           SET ${updates.length > 0 ? `${updates.join(", ")}, ` : ""}version = version + 1, updated_at = ?
           WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND version = ?`,
          [...values, now, id, scope.tenantId, input.version],
        );
        if (result.affectedRows === 0) {
          await this.throwGroupUpdateFailure(connection, id, input.version, scope);
        }
        if (input.items !== undefined) {
          await this.replaceGroupItems(connection, id, input.items, scope, now);
        }
      });
    } catch (error) {
      if (isDuplicateEntry(error)) {
        throw new ConflictError(
          "Question group code already exists in this tenant.",
        );
      }
      throw error;
    }
    const group = await this.getGroup(id, scope);
    if (!group) throw new NotFoundError("question group", id);
    return group;
  }

  async softDeleteGroup(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<void> {
    const now = new Date();
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE question_groups
       SET version = version + 1, updated_at = ?, deleted_at = ?
       WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND version = ?`,
      [now, now, id, scope.tenantId, version],
    );
    if (result.affectedRows === 0) {
      await this.throwGroupUpdateFailure(this.pool, id, version, scope);
    }
  }

  async isFileReferenced(
    fileId: string,
    scope: QuestionBankScope,
  ): Promise<boolean> {
    const [rows] = await this.pool.execute<CountRow[]>(
      `SELECT COUNT(*) AS count
       FROM question_clusters
       WHERE tenant_id = ? AND stem_file_id = ? AND deleted_at IS NULL`,
      [scope.tenantId, fileId],
    );
    return Number(rows[0]?.count ?? 0) > 0;
  }

  private async getClusterWith(
    executor: Executor,
    id: string,
    scope: QuestionBankScope,
  ): Promise<QuestionCluster | null> {
    const [rows] = await executor.execute<ClusterRow[]>(
      `SELECT ${clusterColumns}
       FROM question_clusters c
       WHERE c.id = ? AND c.tenant_id = ? AND c.deleted_at IS NULL
       LIMIT 1`,
      [id, scope.tenantId],
    );
    const row = rows[0];
    if (!row) return null;
    const itemMap = await clusterItemMapFor(executor, [row.id], scope.tenantId);
    return toCluster(row, itemMap.get(row.id) ?? []);
  }

  private async getGroupWith(
    executor: Executor,
    id: string,
    scope: QuestionBankScope,
  ): Promise<QuestionGroup | null> {
    const [rows] = await executor.execute<GroupRow[]>(
      `SELECT ${groupColumns}
       FROM question_groups g
       WHERE g.id = ? AND g.tenant_id = ? AND g.deleted_at IS NULL
       LIMIT 1`,
      [id, scope.tenantId],
    );
    const row = rows[0];
    if (!row) return null;
    const itemMap = await groupItemMapFor(executor, [row.id], scope.tenantId);
    return toGroup(row, itemMap.get(row.id) ?? []);
  }

  private async assertFile(
    executor: Executor,
    fileId: string | null,
    scope: QuestionBankScope,
  ): Promise<void> {
    if (fileId === null) return;
    const [rows] = await executor.execute<IdRow[]>(
      `SELECT file_id AS id
       FROM files
       WHERE file_id = ? AND tenant_id = ? AND status = 'ready' AND deleted_at IS NULL
       LIMIT 1`,
      [fileId, scope.tenantId],
    );
    if (!rows[0]) {
      validationError(`Question cluster stemFileId "${fileId}" does not exist.`);
    }
  }

  private async assertQuestions(
    executor: Executor,
    questionIds: string[],
    scope: QuestionBankScope,
    owner: "cluster" | "group",
  ): Promise<void> {
    if (questionIds.length === 0) return;
    const placeholders = questionIds.map(() => "?").join(", ");
    const [rows] = await executor.execute<IdRow[]>(
      `SELECT id FROM questions
       WHERE tenant_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`,
      [scope.tenantId, ...questionIds],
    );
    const found = new Set(rows.map((row) => row.id));
    for (const questionId of questionIds) {
      if (!found.has(questionId)) {
        validationError(
          `Question ${owner} questionId "${questionId}" does not exist.`,
        );
      }
    }
  }

  private async assertClusters(
    executor: Executor,
    clusterIds: string[],
    scope: QuestionBankScope,
  ): Promise<void> {
    if (clusterIds.length === 0) return;
    const placeholders = clusterIds.map(() => "?").join(", ");
    const [rows] = await executor.execute<IdRow[]>(
      `SELECT id FROM question_clusters
       WHERE tenant_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`,
      [scope.tenantId, ...clusterIds],
    );
    const found = new Set(rows.map((row) => row.id));
    for (const clusterId of clusterIds) {
      if (!found.has(clusterId)) {
        validationError(`Question group clusterId "${clusterId}" does not exist.`);
      }
    }
  }

  private async assertSubject(
    executor: Executor,
    subjectId: string | null,
    scope: QuestionBankScope,
  ): Promise<void> {
    if (subjectId === null) return;
    const [rows] = await executor.execute<IdRow[]>(
      `SELECT id FROM question_categories
       WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL LIMIT 1`,
      [subjectId, scope.tenantId],
    );
    if (!rows[0]) {
      validationError(`Question group subjectId "${subjectId}" does not exist.`);
    }
  }

  private async assertGroupItems(
    executor: Executor,
    items: QuestionGroupItemInput[],
    scope: QuestionBankScope,
  ): Promise<void> {
    const directQuestionIds = items
      .filter((item) => item.itemType === "question")
      .map((item) => item.questionId);
    const clusterIds = items
      .filter((item) => item.itemType === "cluster")
      .map((item) => item.clusterId);

    await this.assertQuestions(executor, directQuestionIds, scope, "group");
    await this.assertClusters(executor, clusterIds, scope);
    if (directQuestionIds.length === 0 || clusterIds.length === 0) return;

    const placeholders = clusterIds.map(() => "?").join(", ");
    const [rows] = await executor.execute<ClusterQuestionRow[]>(
      `SELECT ci.question_id, ci.cluster_id
       FROM question_cluster_items ci
       INNER JOIN question_clusters c ON c.id = ci.cluster_id
       WHERE ci.tenant_id = ? AND c.tenant_id = ? AND c.deleted_at IS NULL
         AND ci.cluster_id IN (${placeholders})`,
      [scope.tenantId, scope.tenantId, ...clusterIds],
    );
    const clusterQuestions = new Set(rows.map((row) => row.question_id));
    for (const questionId of directQuestionIds) {
      if (clusterQuestions.has(questionId)) {
        throw new ConflictError(
          `Question ${questionId} is already included through a selected cluster.`,
        );
      }
    }
  }

  private async replaceClusterItems(
    connection: PoolConnection,
    clusterId: string,
    questionIds: string[],
    scope: QuestionBankScope,
    now: Date,
  ): Promise<void> {
    await connection.execute(
      "DELETE FROM question_cluster_items WHERE cluster_id = ? AND tenant_id = ?",
      [clusterId, scope.tenantId],
    );
    for (const [position, questionId] of questionIds.entries()) {
      await connection.execute(
        `INSERT INTO question_cluster_items
          (id, tenant_id, cluster_id, question_id, position, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [randomUUID(), scope.tenantId, clusterId, questionId, position, now],
      );
    }
  }

  private async replaceGroupItems(
    connection: PoolConnection,
    groupId: string,
    items: QuestionGroupItemInput[],
    scope: QuestionBankScope,
    now: Date,
  ): Promise<void> {
    await connection.execute(
      "DELETE FROM question_group_items WHERE group_id = ? AND tenant_id = ?",
      [groupId, scope.tenantId],
    );
    for (const [position, item] of items.entries()) {
      await connection.execute(
        `INSERT INTO question_group_items
          (id, tenant_id, group_id, item_type, question_id, cluster_id, position, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          scope.tenantId,
          groupId,
          item.itemType,
          item.itemType === "question" ? item.questionId : null,
          item.itemType === "cluster" ? item.clusterId : null,
          position,
          now,
        ],
      );
    }
  }

  private async throwClusterUpdateFailure(
    executor: Executor,
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<never> {
    const [rows] = await executor.execute<ExistingRow[]>(
      `SELECT id, version, deleted_at FROM question_clusters
       WHERE id = ? AND tenant_id = ? LIMIT 1`,
      [id, scope.tenantId],
    );
    const row = rows[0];
    if (!row || row.deleted_at !== null) {
      throw new NotFoundError("question cluster", id);
    }
    throw new ConflictError(
      `Question cluster ${id} has changed; expected version ${version}.`,
    );
  }

  private async throwGroupUpdateFailure(
    executor: Executor,
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<never> {
    const [rows] = await executor.execute<ExistingRow[]>(
      `SELECT id, version, deleted_at FROM question_groups
       WHERE id = ? AND tenant_id = ? LIMIT 1`,
      [id, scope.tenantId],
    );
    const row = rows[0];
    if (!row || row.deleted_at !== null) {
      throw new NotFoundError("question group", id);
    }
    throw new ConflictError(
      `Question group ${id} has changed; expected version ${version}.`,
    );
  }
}

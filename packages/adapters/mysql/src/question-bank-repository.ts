import { randomUUID } from "node:crypto";
import type {
  CreateQuestionCategoryInput,
  CreateQuestionInput,
  Page,
  Question,
  QuestionCategory,
  QuestionCategoryListQuery,
  QuestionListQuery,
  QuestionMedia,
  UpdateQuestionCategoryInput,
  UpdateQuestionInput,
} from "@server-foundation/api-contracts";
import {
  ConflictError,
  DomainError,
  InvalidCursorError,
  NotFoundError,
} from "@server-foundation/domain";
import type {
  QuestionBankRepository,
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

type Executor = Pick<PoolConnection, "execute">;

type QuestionRow = RowDataPacket & {
  id: string;
  tenant_id: string;
  code: string;
  category_id: string | null;
  created_by: string;
  type: Question["type"];
  difficulty: number;
  stem: string;
  options: unknown;
  answer: unknown;
  explanation: string | null;
  ai_rubric: unknown;
  points: string | number;
  tags: unknown;
  status: Question["status"];
  usage_count: number;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
  deleted_at: Date | string | null;
};

type MediaRow = RowDataPacket & {
  question_id: string;
  file_id: string;
  role: QuestionMedia["role"];
  option_id: string | null;
  position: number;
};

type CategoryRow = RowDataPacket & {
  id: string;
  tenant_id: string;
  parent_id: string | null;
  name: string;
  sort_order: number;
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

type FileRow = RowDataPacket & {
  file_id: string;
};

type CountRow = RowDataPacket & {
  count: number;
};

const questionColumns = `
  q.id, q.tenant_id, q.code, q.category_id, q.created_by, q.type,
  q.difficulty, q.stem, q.options, q.answer, q.explanation, q.ai_rubric,
  q.points, q.tags, q.status, q.usage_count, q.version,
  q.created_at, q.updated_at, q.deleted_at`;

const categoryColumns =
  "id, tenant_id, parent_id, name, sort_order, version, created_at, updated_at, deleted_at";

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
    throw new Error("MySQL returned an invalid date.");
  }
  return date.toISOString();
};

const parseJson = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("MySQL returned invalid JSON.");
  }
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

const unavailableMedia = (): never => {
  throw new DomainError(
    "validation_error",
    "Question media contains a file that is unavailable to this tenant.",
  );
};

const toMedia = (row: MediaRow): QuestionMedia => ({
  fileId: row.file_id,
  role: row.role,
  optionId: row.option_id,
  position: row.position,
});

const toCategory = (row: CategoryRow): QuestionCategory => ({
  id: row.id,
  tenantId: row.tenant_id,
  parentId: row.parent_id,
  name: row.name,
  sortOrder: row.sort_order,
  version: row.version,
  createdAt: toIso(row.created_at) ?? "",
  updatedAt: toIso(row.updated_at) ?? "",
  deletedAt: toIso(row.deleted_at),
});

const toQuestion = (
  row: QuestionRow,
  media: QuestionMedia[] = [],
): Question => ({
  id: row.id,
  tenantId: row.tenant_id,
  code: row.code,
  categoryId: row.category_id,
  createdBy: row.created_by,
  type: row.type,
  difficulty: row.difficulty,
  stem: row.stem,
  options: parseJson(row.options) as Question["options"],
  answer: parseJson(row.answer) as Question["answer"],
  explanation: row.explanation,
  aiRubric: parseJson(row.ai_rubric) as Question["aiRubric"],
  points: Number(row.points),
  tags: (parseJson(row.tags) ?? []) as string[],
  status: row.status,
  usageCount: row.usage_count,
  version: row.version,
  media,
  createdAt: toIso(row.created_at) ?? "",
  updatedAt: toIso(row.updated_at) ?? "",
  deletedAt: toIso(row.deleted_at),
});

const mediaMapFor = async (
  executor: Executor,
  ids: string[],
  tenantId: string,
): Promise<Map<string, QuestionMedia[]>> => {
  const result = new Map<string, QuestionMedia[]>();
  if (ids.length === 0) return result;
  const placeholders = ids.map(() => "?").join(", ");
  const [rawRows] = await executor.execute(
    `SELECT question_id, file_id, role, option_id, position
     FROM question_files
     WHERE tenant_id = ? AND question_id IN (${placeholders})
     ORDER BY question_id, role, position, id`,
    [tenantId, ...ids],
  );
  const rows = rawRows as MediaRow[];
  for (const row of rows) {
    const media = result.get(row.question_id) ?? [];
    media.push(toMedia(row));
    result.set(row.question_id, media);
  }
  return result;
};

export class MySqlQuestionBankRepository implements QuestionBankRepository {
  constructor(private readonly pool: Pool) {}

  async listQuestions(
    query: QuestionListQuery,
    scope: QuestionBankScope,
  ): Promise<Page<Question>> {
    const predicates = ["q.tenant_id = ?", "q.deleted_at IS NULL"];
    const parameters: Array<string | number> = [scope.tenantId];
    const search = query.search?.trim();
    const limit = Math.min(Math.max(Math.trunc(query.limit), 1), 100);

    if (query.createdBy) {
      predicates.push("q.created_by = ?");
      parameters.push(query.createdBy);
    }
    if (query.type) {
      predicates.push("q.type = ?");
      parameters.push(query.type);
    }
    if (query.categoryId) {
      predicates.push(`(
        q.category_id = ? OR q.category_id IN (
          SELECT child.id FROM question_categories child
          WHERE child.tenant_id = ? AND child.parent_id = ? AND child.deleted_at IS NULL
        )
      )`);
      parameters.push(query.categoryId, scope.tenantId, query.categoryId);
    }
    if (query.difficulty !== undefined) {
      predicates.push("q.difficulty = ?");
      parameters.push(query.difficulty);
    }
    if (query.status) {
      predicates.push("q.status = ?");
      parameters.push(query.status);
    }
    if (search) {
      const like = `%${escapeLike(search)}%`;
      predicates.push(
        "(q.stem LIKE ? ESCAPE '!' OR q.code LIKE ? ESCAPE '!' OR CAST(q.tags AS CHAR) LIKE ? ESCAPE '!')",
      );
      parameters.push(like, like, like);
    }
    if (query.cursor) {
      const cursor = decodeItemCursor(query.cursor);
      if (!cursor) throw new InvalidCursorError();
      const cursorTime = new Date(cursor.updatedAt);
      if (Number.isNaN(cursorTime.getTime())) throw new InvalidCursorError();
      const mysqlCursorTime = toMySqlDateTime(cursorTime);
      predicates.push("(q.updated_at < ? OR (q.updated_at = ? AND q.id < ?))");
      parameters.push(mysqlCursorTime, mysqlCursorTime, cursor.id);
    }

    const [rows] = await this.pool.execute<QuestionRow[]>(
      `SELECT ${questionColumns}
       FROM questions q
       WHERE ${predicates.join(" AND ")}
       ORDER BY q.updated_at DESC, q.id DESC
       LIMIT ${limit + 1}`,
      parameters,
    );
    const hasMore = rows.length > limit;
    const visibleRows = hasMore ? rows.slice(0, limit) : rows;
    const media = await mediaMapFor(
      this.pool,
      visibleRows.map((row) => row.id),
      scope.tenantId,
    );
    const last = visibleRows.at(-1);
    return {
      items: visibleRows.map((row) => toQuestion(row, media.get(row.id) ?? [])),
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

  async getQuestion(
    id: string,
    scope: QuestionBankScope,
  ): Promise<Question | null> {
    return this.getQuestionWith(this.pool, id, scope);
  }

  async createQuestion(
    input: CreateQuestionInput,
    scope: QuestionBankScope,
  ): Promise<Question> {
    const id = randomUUID();
    const now = new Date();
    try {
      await withTransaction(this.pool, async (connection) => {
        await this.assertCategory(connection, input.categoryId ?? null, scope);
        await this.assertMediaFiles(connection, input.media, scope);
        await connection.execute(
          `INSERT INTO questions (
            id, tenant_id, code, category_id, created_by, type, difficulty,
            stem, options, answer, explanation, ai_rubric, points, tags,
            status, usage_count, version, created_at, updated_at, deleted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, NULL)`,
          [
            id,
            scope.tenantId,
            input.code,
            input.categoryId ?? null,
            scope.actorUserId,
            input.type,
            input.difficulty,
            input.stem,
            input.options === null ? null : JSON.stringify(input.options),
            JSON.stringify(input.answer),
            input.explanation,
            input.aiRubric === null ? null : JSON.stringify(input.aiRubric),
            input.points,
            JSON.stringify(input.tags),
            input.status,
            now,
            now,
          ],
        );
        await this.replaceMedia(connection, id, input.media, scope, now);
      });
    } catch (error) {
      if (isDuplicateEntry(error)) {
        throw new ConflictError(
          `Question code ${input.code} already exists in this tenant.`,
        );
      }
      throw error;
    }
    const question = await this.getQuestion(id, scope);
    if (!question) throw new Error("Question insert succeeded but could not be read.");
    return question;
  }

  async updateQuestion(
    id: string,
    input: UpdateQuestionInput,
    scope: QuestionBankScope,
  ): Promise<Question> {
    const updates: string[] = [];
    const values: unknown[] = [];
    const put = (column: string, value: unknown): void => {
      updates.push(`${column} = ?`);
      values.push(value);
    };

    if (input.code !== undefined) put("code", input.code);
    if (input.categoryId !== undefined) put("category_id", input.categoryId);
    if (input.type !== undefined) put("type", input.type);
    if (input.difficulty !== undefined) put("difficulty", input.difficulty);
    if (input.stem !== undefined) put("stem", input.stem);
    if (input.options !== undefined) {
      put("options", input.options === null ? null : JSON.stringify(input.options));
    }
    if (input.answer !== undefined) put("answer", JSON.stringify(input.answer));
    if (input.explanation !== undefined) put("explanation", input.explanation);
    if (input.aiRubric !== undefined) {
      put("ai_rubric", input.aiRubric === null ? null : JSON.stringify(input.aiRubric));
    }
    if (input.points !== undefined) put("points", input.points);
    if (input.tags !== undefined) put("tags", JSON.stringify(input.tags));
    if (input.status !== undefined) put("status", input.status);

    const now = new Date();
    try {
      await withTransaction(this.pool, async (connection) => {
        if (input.categoryId !== undefined) {
          await this.assertCategory(connection, input.categoryId, scope);
        }
        if (input.media !== undefined) {
          await this.assertMediaFiles(connection, input.media, scope);
        }
        const [result] = await connection.execute<ResultSetHeader>(
          `UPDATE questions
           SET ${updates.length > 0 ? `${updates.join(", ")}, ` : ""}version = version + 1, updated_at = ?
           WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND version = ?`,
          [...values, now, id, scope.tenantId, input.version],
        );
        if (result.affectedRows === 0) {
          await this.throwQuestionUpdateFailure(connection, id, input.version, scope);
        }
        if (input.media !== undefined) {
          await this.replaceMedia(connection, id, input.media, scope, now);
        }
      });
    } catch (error) {
      if (isDuplicateEntry(error)) {
        throw new ConflictError("Question code already exists in this tenant.");
      }
      throw error;
    }
    const question = await this.getQuestion(id, scope);
    if (!question) throw new NotFoundError("question", id);
    return question;
  }

  async softDeleteQuestion(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<void> {
    const now = new Date();
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE questions
       SET version = version + 1, updated_at = ?, deleted_at = ?
       WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND version = ?`,
      [now, now, id, scope.tenantId, version],
    );
    if (result.affectedRows === 0) {
      await this.throwQuestionUpdateFailure(this.pool, id, version, scope);
    }
  }

  async listCategories(
    query: QuestionCategoryListQuery,
    scope: QuestionBankScope,
  ): Promise<QuestionCategory[]> {
    const predicates = ["tenant_id = ?", "deleted_at IS NULL"];
    const values: Array<string | null> = [scope.tenantId];
    if (query.parentId !== undefined) {
      predicates.push("parent_id = ?");
      values.push(query.parentId);
    }
    const [rows] = await this.pool.execute<CategoryRow[]>(
      `SELECT ${categoryColumns}
       FROM question_categories
       WHERE ${predicates.join(" AND ")}
       ORDER BY parent_id IS NOT NULL, sort_order, name, id`,
      values,
    );
    return rows.map(toCategory);
  }

  async getCategory(
    id: string,
    scope: QuestionBankScope,
  ): Promise<QuestionCategory | null> {
    const [rows] = await this.pool.execute<CategoryRow[]>(
      `SELECT ${categoryColumns}
       FROM question_categories
       WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
       LIMIT 1`,
      [id, scope.tenantId],
    );
    return rows[0] ? toCategory(rows[0]) : null;
  }

  async createCategory(
    input: CreateQuestionCategoryInput,
    scope: QuestionBankScope,
  ): Promise<QuestionCategory> {
    const id = randomUUID();
    const now = new Date();
    await withTransaction(this.pool, async (connection) => {
      await this.assertCategoryParent(connection, input.parentId, scope);
      await connection.execute(
        `INSERT INTO question_categories
          (id, tenant_id, parent_id, name, sort_order, version, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
        [
          id,
          scope.tenantId,
          input.parentId,
          input.name,
          input.sortOrder,
          now,
          now,
        ],
      );
    });
    const category = await this.getCategory(id, scope);
    if (!category) throw new Error("Category insert succeeded but could not be read.");
    return category;
  }

  async updateCategory(
    id: string,
    input: UpdateQuestionCategoryInput,
    scope: QuestionBankScope,
  ): Promise<QuestionCategory> {
    const now = new Date();
    await withTransaction(this.pool, async (connection) => {
      if (input.parentId === id) {
        throw new DomainError("validation_error", "A category cannot parent itself.");
      }
      await this.assertCategoryParent(connection, input.parentId, scope);
      if (input.parentId !== null) {
        const [children] = await connection.execute<CountRow[]>(
          `SELECT COUNT(*) AS count FROM question_categories
           WHERE tenant_id = ? AND parent_id = ? AND deleted_at IS NULL`,
          [scope.tenantId, id],
        );
        if (Number(children[0]?.count ?? 0) > 0) {
          throw new DomainError(
            "validation_error",
            "A parent category with children cannot become a child category.",
          );
        }
      }
      const [result] = await connection.execute<ResultSetHeader>(
        `UPDATE question_categories
         SET parent_id = ?, name = ?, sort_order = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND version = ?`,
        [
          input.parentId,
          input.name,
          input.sortOrder,
          now,
          id,
          scope.tenantId,
          input.version,
        ],
      );
      if (result.affectedRows === 0) {
        await this.throwCategoryUpdateFailure(connection, id, input.version, scope);
      }
    });
    const category = await this.getCategory(id, scope);
    if (!category) throw new NotFoundError("question category", id);
    return category;
  }

  async softDeleteCategory(
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<void> {
    const now = new Date();
    await withTransaction(this.pool, async (connection) => {
      const [references] = await connection.execute<CountRow[]>(
        `SELECT COUNT(*) AS count FROM questions
         WHERE tenant_id = ? AND category_id = ? AND deleted_at IS NULL`,
        [scope.tenantId, id],
      );
      const [children] = await connection.execute<CountRow[]>(
        `SELECT COUNT(*) AS count FROM question_categories
         WHERE tenant_id = ? AND parent_id = ? AND deleted_at IS NULL`,
        [scope.tenantId, id],
      );
      if (
        Number(references[0]?.count ?? 0) > 0 ||
        Number(children[0]?.count ?? 0) > 0
      ) {
        throw new ConflictError(
          "Category is still referenced by active questions or child categories.",
        );
      }
      const [result] = await connection.execute<ResultSetHeader>(
        `UPDATE question_categories
         SET version = version + 1, updated_at = ?, deleted_at = ?
         WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND version = ?`,
        [now, now, id, scope.tenantId, version],
      );
      if (result.affectedRows === 0) {
        await this.throwCategoryUpdateFailure(connection, id, version, scope);
      }
    });
  }

  async isFileReferenced(
    fileId: string,
    scope: QuestionBankScope,
  ): Promise<boolean> {
    const [rows] = await this.pool.execute<CountRow[]>(
      `SELECT COUNT(*) AS count
       FROM question_files qf
       INNER JOIN questions q ON q.id = qf.question_id
       WHERE qf.tenant_id = ? AND qf.file_id = ?
         AND q.tenant_id = ? AND q.deleted_at IS NULL`,
      [scope.tenantId, fileId, scope.tenantId],
    );
    return Number(rows[0]?.count ?? 0) > 0;
  }

  private async getQuestionWith(
    executor: Executor,
    id: string,
    scope: QuestionBankScope,
  ): Promise<Question | null> {
    const [rawRows] = await executor.execute(
      `SELECT ${questionColumns}
       FROM questions q
       WHERE q.id = ? AND q.tenant_id = ? AND q.deleted_at IS NULL
       LIMIT 1`,
      [id, scope.tenantId],
    );
    const rows = rawRows as QuestionRow[];
    const row = rows[0];
    if (!row) return null;
    const media = await mediaMapFor(executor, [row.id], scope.tenantId);
    return toQuestion(row, media.get(row.id) ?? []);
  }

  private async assertCategory(
    executor: Executor,
    categoryId: string | null,
    scope: QuestionBankScope,
  ): Promise<void> {
    if (categoryId === null) return;
    const [rawRows] = await executor.execute(
      `SELECT ${categoryColumns}
       FROM question_categories
       WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
       LIMIT 1`,
      [categoryId, scope.tenantId],
    );
    const rows = rawRows as CategoryRow[];
    if (!rows[0]) {
      throw new DomainError(
        "validation_error",
        "Question category is unavailable to this tenant.",
      );
    }
  }

  private async assertCategoryParent(
    executor: Executor,
    parentId: string | null,
    scope: QuestionBankScope,
  ): Promise<void> {
    if (parentId === null) return;
    const [rawRows] = await executor.execute(
      `SELECT ${categoryColumns}
       FROM question_categories
       WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
       LIMIT 1`,
      [parentId, scope.tenantId],
    );
    const rows = rawRows as CategoryRow[];
    const parent = rows[0];
    if (!parent) {
      throw new DomainError(
        "validation_error",
        "Parent category is unavailable to this tenant.",
      );
    }
    if (parent.parent_id !== null) {
      throw new DomainError(
        "validation_error",
        "Question categories support at most two levels.",
      );
    }
  }

  private async assertMediaFiles(
    executor: Executor,
    media: QuestionMedia[],
    scope: QuestionBankScope,
  ): Promise<void> {
    const ids = [...new Set(media.map((entry) => entry.fileId))];
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(", ");
    const [rawRows] = await executor.execute(
      `SELECT file_id FROM files
       WHERE tenant_id = ? AND status = 'ready' AND deleted_at IS NULL
         AND file_id IN (${placeholders})`,
      [scope.tenantId, ...ids],
    );
    const rows = rawRows as FileRow[];
    if (rows.length !== ids.length) unavailableMedia();
  }

  private async replaceMedia(
    connection: PoolConnection,
    questionId: string,
    media: QuestionMedia[],
    scope: QuestionBankScope,
    now: Date,
  ): Promise<void> {
    await connection.execute(
      "DELETE FROM question_files WHERE question_id = ? AND tenant_id = ?",
      [questionId, scope.tenantId],
    );
    for (const entry of media) {
      await connection.execute(
        `INSERT INTO question_files
          (id, tenant_id, question_id, file_id, role, option_id, position, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          scope.tenantId,
          questionId,
          entry.fileId,
          entry.role,
          entry.optionId,
          entry.position,
          now,
        ],
      );
    }
  }

  private async throwQuestionUpdateFailure(
    executor: Executor,
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<never> {
    const [rawRows] = await executor.execute(
      `SELECT id, version, deleted_at FROM questions
       WHERE id = ? AND tenant_id = ? LIMIT 1`,
      [id, scope.tenantId],
    );
    const rows = rawRows as ExistingRow[];
    const row = rows[0];
    if (!row || row.deleted_at !== null) throw new NotFoundError("question", id);
    throw new ConflictError(
      `Question ${id} has changed; expected version ${version}.`,
    );
  }

  private async throwCategoryUpdateFailure(
    executor: Executor,
    id: string,
    version: number,
    scope: QuestionBankScope,
  ): Promise<never> {
    const [rawRows] = await executor.execute(
      `SELECT id, version, deleted_at FROM question_categories
       WHERE id = ? AND tenant_id = ? LIMIT 1`,
      [id, scope.tenantId],
    );
    const rows = rawRows as ExistingRow[];
    const row = rows[0];
    if (!row || row.deleted_at !== null) {
      throw new NotFoundError("question category", id);
    }
    throw new ConflictError(
      `Question category ${id} has changed; expected version ${version}.`,
    );
  }
}

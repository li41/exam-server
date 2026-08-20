import { randomUUID } from "node:crypto";
import type {
  CreateQuestionCategoryInput,
  CreateQuestionInput,
  Question,
  QuestionCategory,
  QuestionCategoryListQuery,
  QuestionListQuery,
  QuestionMedia,
  QuestionMediaResult,
  QuestionPage,
  QuestionStats,
  QuestionStatsQuery,
  UpdateQuestionCategoryInput,
  UpdateQuestionInput,
} from "@server-foundation/api-contracts";
import {
  ConflictError,
  DomainError,
  InvalidCursorError,
  NotFoundError,
  questionStatsFromCounts,
  unnarrowedQuestionScope,
} from "@server-foundation/domain";
import type {
  QuestionBankRepository,
  QuestionBankScope,
  QuestionOwnerScope,
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
  created_by_name: string | null;
};

type MediaRow = RowDataPacket & {
  question_id: string;
  file_id: string;
  role: QuestionMedia["role"];
  option_id: string | null;
  position: number;
  file_available: number | string;
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

type TypeCountRow = RowDataPacket & {
  type: string;
  count: number;
};

const questionColumns = `
  q.id, q.tenant_id, q.code, q.category_id, q.created_by, q.type,
  q.difficulty, q.stem, q.options, q.answer, q.explanation, q.ai_rubric,
  q.points, q.tags, q.status, q.usage_count, q.version,
  q.created_at, q.updated_at, q.deleted_at,
  creator.display_name AS created_by_name`;

/**
 * 建立者姓名（`#98` A-6）。與 PHP 同形：`LEFT JOIN users ON users.id = q.created_by`
 * （`exam.tw/src/Models/Question.php:899-906`）。
 *
 * ⚠️ 一定是 `LEFT`：`questions.created_by` **沒有外鍵**指向 `users`
 * （見 `006_question_bank.sql`），帳號被刪或跨 tenant 的舊資料都可能對不到人。
 * `INNER JOIN` 會讓那些題目**整筆從清單消失** ⇒ 那比少一個姓名嚴重得多。
 */
const questionCreatorJoin = `LEFT JOIN users creator ON creator.id = q.created_by`;

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

const unavailableMedia = (fileId: string): never => {
  throw new DomainError(
    "validation_error",
    `Question media fileId "${fileId}" does not exist.`,
  );
};

const toMedia = (row: MediaRow): QuestionMediaResult => ({
  fileId: row.file_id,
  role: row.role,
  optionId: row.option_id,
  position: row.position,
  available: Number(row.file_available) === 1,
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
  media: QuestionMediaResult[] = [],
): Question => ({
  id: row.id,
  tenantId: row.tenant_id,
  code: row.code,
  categoryId: row.category_id,
  createdBy: row.created_by,
  createdByName: row.created_by_name,
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
): Promise<Map<string, QuestionMediaResult[]>> => {
  const result = new Map<string, QuestionMediaResult[]>();
  if (ids.length === 0) return result;
  const placeholders = ids.map(() => "?").join(", ");
  const [rawRows] = await executor.execute(
    `SELECT qf.question_id, qf.file_id, qf.role, qf.option_id, qf.position,
            CASE
              WHEN f.file_id IS NOT NULL AND f.status = 'ready' AND f.deleted_at IS NULL
              THEN 1 ELSE 0
            END AS file_available
     FROM question_files qf
     LEFT JOIN files f
       ON f.file_id = qf.file_id AND f.tenant_id = qf.tenant_id
     WHERE qf.tenant_id = ? AND qf.question_id IN (${placeholders})
     ORDER BY qf.question_id, qf.role, qf.position, qf.id`,
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

/** mysql2 佔位參數接受的純量。 */
type SqlParam = string | number | boolean | Date | null;

/**
 * 擁有者收窄（`QuestionOwnerScope.visibleQuestionOwnerId`）的 SQL 形狀。
 *
 * 與 `exam-control/src/db/question-clusters.ts:215` 同形：條件永遠加上去，
 * `null` 時靠 `? IS NULL` 讓整條為真 ⇒ ⛔ 不必在每個呼叫點寫兩條 SQL。
 * ⚠️ 兩個 `?` 要餵**同一個值**，所以搭配 `ownerParameters()` 一起用。
 *
 * ⛔ 不要改寫成「`null` 時就不 push 這個 predicate」：那會讓「看全部」與「只看自己」
 * 走兩條不同的 SQL，其中一條沒被測到時是靜默的。
 */
const ownerPredicate = (column: string): string =>
  `(? IS NULL OR ${column} = ?)`;

const ownerParameters = (
  scope: QuestionOwnerScope,
): [string | null, string | null] => [
  scope.visibleQuestionOwnerId,
  scope.visibleQuestionOwnerId,
];

export class MySqlQuestionBankRepository implements QuestionBankRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * 列表與「總筆數」共用的**同一組** WHERE 條件（不含 cursor）。
   *
   * ⚠️ 抽成一支的理由：`total` 一旦和列表用不同的條件算，
   * 畫面就會出現「列出 3 筆但總數說 500」——那比沒有總數更糟。
   * ⇒ 這裡回傳的 predicates 同時餵給 `SELECT` 與 `COUNT(*)`。
   */
  private questionFilterPredicates(
    query: QuestionListQuery,
    scope: QuestionOwnerScope,
  ): { predicates: string[]; parameters: Array<string | number | null> } {
    const predicates = [
      "q.tenant_id = ?",
      "q.deleted_at IS NULL",
      // 擁有者收窄與 tenant 一樣，是**基礎條件**而不是選用篩選 ⇒ 放在最前面，
      // 而且因為它在 `questionFilterPredicates()` 裡，列表與 `COUNT(*)` 一定同時吃到。
      ownerPredicate("q.created_by"),
    ];
    const parameters: Array<string | number | null> = [
      scope.tenantId,
      ...ownerParameters(scope),
    ];
    const search = query.search?.trim();

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
    if (query.fileId) {
      predicates.push(`EXISTS (
        SELECT 1 FROM question_files qf
        WHERE qf.question_id = q.id
          AND qf.tenant_id = q.tenant_id
          AND qf.file_id = ?
      )`);
      parameters.push(query.fileId);
    }
    if (search) {
      const like = `%${escapeLike(search)}%`;
      predicates.push(
        "(q.stem LIKE ? ESCAPE '!' OR q.code LIKE ? ESCAPE '!' OR CAST(q.tags AS CHAR) LIKE ? ESCAPE '!')",
      );
      parameters.push(like, like, like);
    }
    return { predicates, parameters };
  }

  async listQuestions(
    query: QuestionListQuery,
    scope: QuestionOwnerScope,
  ): Promise<QuestionPage> {
    const limit = Math.min(Math.max(Math.trunc(query.limit), 1), 100);
    const { predicates: filterPredicates, parameters: filterParameters } =
      this.questionFilterPredicates(query, scope);
    const predicates = [...filterPredicates];
    const parameters = [...filterParameters];

    if (query.cursor) {
      const cursor = decodeItemCursor(query.cursor);
      if (!cursor) throw new InvalidCursorError();
      const cursorTime = new Date(cursor.updatedAt);
      if (Number.isNaN(cursorTime.getTime())) throw new InvalidCursorError();
      const mysqlCursorTime = toMySqlDateTime(cursorTime);
      predicates.push("(q.updated_at < ? OR (q.updated_at = ? AND q.id < ?))");
      parameters.push(mysqlCursorTime, mysqlCursorTime, cursor.id);
    }

    // ⚠️ `total` 用的是**不含 cursor**的條件：它要回答「這組篩選共有幾筆」，
    //    ⛔ 不是「游標之後還剩幾筆」。對照 PHP `Question.php:891-895`。
    const [totalRows] = await this.pool.execute<CountRow[]>(
      `SELECT COUNT(*) AS count
       FROM questions q
       WHERE ${filterPredicates.join(" AND ")}`,
      filterParameters,
    );
    const total = Number(totalRows[0]?.count ?? 0);

    const [rows] = await this.pool.execute<QuestionRow[]>(
      `SELECT ${questionColumns}
       FROM questions q
       ${questionCreatorJoin}
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
        total,
      },
    };
  }

  async questionStats(
    query: QuestionStatsQuery,
    scope: QuestionOwnerScope,
  ): Promise<QuestionStats> {
    // ⚠️ 統計必須套**同一個**收窄：「我只看得到 3 題但統計說 500 題」
    //    比沒有統計更糟。對照 PHP `Question::getTypeStats()`
    //    （`exam.tw/src/Models/Question.php:926-936` 的 `$onlyMine`）。
    const predicates = [
      "tenant_id = ?",
      "deleted_at IS NULL",
      ownerPredicate("created_by"),
    ];
    const parameters: Array<string | number | null> = [
      scope.tenantId,
      ...ownerParameters(scope),
    ];
    if (query.createdBy) {
      predicates.push("created_by = ?");
      parameters.push(query.createdBy);
    }
    const [rows] = await this.pool.execute<TypeCountRow[]>(
      `SELECT type, COUNT(*) AS count
       FROM questions
       WHERE ${predicates.join(" AND ")}
       GROUP BY type`,
      parameters,
    );
    return questionStatsFromCounts(
      rows.map((row) => ({ type: row.type, count: Number(row.count) })),
    );
  }

  async getQuestion(
    id: string,
    scope: QuestionOwnerScope,
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
    // ⛔ 刻意不收窄：這是**建立後的 read-back**，那一列的 `created_by`
    //    就是 `scope.actorUserId` 自己 ⇒ 收窄在這裡只可能造成
    //    「建立成功卻讀不回來」。
    const question = await this.getQuestion(id, unnarrowedQuestionScope(scope));
    if (!question)
      throw new Error("Question insert succeeded but could not be read.");
    return question;
  }

  async updateQuestion(
    id: string,
    input: UpdateQuestionInput,
    scope: QuestionOwnerScope,
  ): Promise<Question> {
    const updates: string[] = [];
    // ⚠️ 不能用 `unknown[]` —— mysql2 的 `execute(sql, values)` overload 不接受它，
    //    會退到最後一個 overload（吃 QueryOptions）然後報「string 不能當 QueryOptions」。
    //    症狀出現在 execute 那一行，病灶在這個宣告。
    const values: SqlParam[] = [];
    const put = (column: string, value: SqlParam): void => {
      updates.push(`${column} = ?`);
      values.push(value);
    };

    if (input.code !== undefined) put("code", input.code);
    if (input.categoryId !== undefined) put("category_id", input.categoryId);
    if (input.type !== undefined) put("type", input.type);
    if (input.difficulty !== undefined) put("difficulty", input.difficulty);
    if (input.stem !== undefined) put("stem", input.stem);
    if (input.options !== undefined) {
      put(
        "options",
        input.options === null ? null : JSON.stringify(input.options),
      );
    }
    if (input.answer !== undefined) put("answer", JSON.stringify(input.answer));
    if (input.explanation !== undefined) put("explanation", input.explanation);
    if (input.aiRubric !== undefined) {
      put(
        "ai_rubric",
        input.aiRubric === null ? null : JSON.stringify(input.aiRubric),
      );
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
          // 寫入端自己也帶收窄，⛔ 不倚賴 service 先呼叫過 `getQuestion()`：
          // repository 是公開的 port，整合測試與未來的呼叫端會直接打這一支。
          `UPDATE questions
           SET ${updates.length > 0 ? `${updates.join(", ")}, ` : ""}version = version + 1, updated_at = ?
           WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND version = ?
             AND ${ownerPredicate("created_by")}`,
          [
            ...values,
            now,
            id,
            scope.tenantId,
            input.version,
            ...ownerParameters(scope),
          ],
        );
        if (result.affectedRows === 0) {
          await this.throwQuestionUpdateFailure(
            connection,
            id,
            input.version,
            scope,
          );
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
    scope: QuestionOwnerScope,
  ): Promise<void> {
    const now = new Date();
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE questions
       SET version = version + 1, updated_at = ?, deleted_at = ?
       WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND version = ?
         AND ${ownerPredicate("created_by")}`,
      [now, now, id, scope.tenantId, version, ...ownerParameters(scope)],
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
    if (!category)
      throw new Error("Category insert succeeded but could not be read.");
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
        throw new DomainError(
          "validation_error",
          "A category cannot parent itself.",
        );
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
        await this.throwCategoryUpdateFailure(
          connection,
          id,
          input.version,
          scope,
        );
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
      // 🔴 這個「還有題目在用嗎」⛔ 刻意不吃 `visibleQuestionOwnerId`：
      //    收窄的話，「只看自己」的人會刪掉別人題目正在用的分類。
      //    ⇒ 與 `isFileReferenced()` 同一個判準（見 port 的註解）。
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
    // ⛔ 這一條刻意不加 `ownerPredicate` —— 理由寫在 port 的 `isFileReferenced` 註解。
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
    scope: QuestionOwnerScope,
  ): Promise<Question | null> {
    const [rawRows] = await executor.execute(
      // 物件級守門：帶著別人的 id 直接讀，這一條要回 `null`
      // ⇒ service 轉成 `NotFoundError` ⇒ 404，⛔ 不是 200、也⛔不是 403
      //   （403 會洩漏「這個 id 存在」）。
      `SELECT ${questionColumns}
       FROM questions q
       ${questionCreatorJoin}
       WHERE q.id = ? AND q.tenant_id = ? AND q.deleted_at IS NULL
         AND ${ownerPredicate("q.created_by")}
       LIMIT 1`,
      [id, scope.tenantId, ...ownerParameters(scope)],
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
    const availableIds = new Set(rows.map((row) => row.file_id));
    const unavailableId = ids.find((fileId) => !availableIds.has(fileId));
    if (unavailableId) unavailableMedia(unavailableId);
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
    scope: QuestionOwnerScope,
  ): Promise<never> {
    // 🔴 這一支是「改／刪影響 0 列」時判斷要回 404 還是 409 的地方 ⇒
    //    **它也必須帶收窄**。否則「只看自己」的人拿別人的 id ＋ 隨便一個 version
    //    會得到 409「版本不符」——那等於承認「這個 id 存在」，
    //    ⇒ 是個可以逐一試出他人題目 id 的洩漏。收窄之後一律是 404。
    const [rawRows] = await executor.execute(
      `SELECT id, version, deleted_at FROM questions
       WHERE id = ? AND tenant_id = ? AND ${ownerPredicate("created_by")}
       LIMIT 1`,
      [id, scope.tenantId, ...ownerParameters(scope)],
    );
    const rows = rawRows as ExistingRow[];
    const row = rows[0];
    if (!row || row.deleted_at !== null)
      throw new NotFoundError("question", id);
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

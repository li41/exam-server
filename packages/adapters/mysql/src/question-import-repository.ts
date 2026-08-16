import { randomUUID } from "node:crypto";
import type {
  CreateQuestionInput,
  QuestionCategory,
  QuestionMedia,
} from "@server-foundation/api-contracts";
import { ConflictError, DomainError } from "@server-foundation/domain";
import type {
  QuestionBankScope,
  QuestionImportRepository,
} from "@server-foundation/domain";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { withTransaction } from "./transaction.js";

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

type CodeRow = RowDataPacket & { code: string };
type FileRow = RowDataPacket & { file_id: string };

type Executor = Pick<PoolConnection, "execute">;

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

export class MySqlQuestionImportRepository implements QuestionImportRepository {
  constructor(private readonly pool: Pool) {}

  async listCategories(scope: QuestionBankScope): Promise<QuestionCategory[]> {
    const [rows] = await this.pool.execute<CategoryRow[]>(
      `SELECT id, tenant_id, parent_id, name, sort_order, version,
              created_at, updated_at, deleted_at
       FROM question_categories
       WHERE tenant_id = ? AND deleted_at IS NULL
       ORDER BY parent_id IS NOT NULL, sort_order, name, id`,
      [scope.tenantId],
    );
    return rows.map(toCategory);
  }

  async findExistingQuestionCodes(
    codes: string[],
    scope: QuestionBankScope,
  ): Promise<string[]> {
    const unique = [...new Set(codes)];
    const existing = new Set<string>();
    for (let offset = 0; offset < unique.length; offset += 500) {
      const chunk = unique.slice(offset, offset + 500);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(", ");
      const [rows] = await this.pool.execute<CodeRow[]>(
        `SELECT code FROM questions
         WHERE tenant_id = ? AND deleted_at IS NULL
           AND code IN (${placeholders})`,
        [scope.tenantId, ...chunk],
      );
      for (const row of rows) existing.add(row.code);
    }
    return [...existing];
  }

  async createQuestions(
    inputs: CreateQuestionInput[],
    scope: QuestionBankScope,
  ): Promise<number> {
    if (inputs.length === 0) return 0;
    try {
      await withTransaction(this.pool, async (connection) => {
        for (const input of inputs) {
          await this.assertCategory(
            connection,
            input.categoryId ?? null,
            scope,
          );
          await this.assertMediaFiles(connection, input.media, scope);
        }

        const now = new Date();
        for (const input of inputs) {
          const questionId = randomUUID();
          await connection.execute(
            `INSERT INTO questions (
              id, tenant_id, code, category_id, created_by, type, difficulty,
              stem, options, answer, explanation, ai_rubric, points, tags,
              status, usage_count, version, created_at, updated_at, deleted_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, NULL)`,
            [
              questionId,
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
          await this.insertMedia(
            connection,
            questionId,
            input.media,
            scope,
            now,
          );
        }
      });
    } catch (error) {
      if (isDuplicateEntry(error)) {
        throw new ConflictError("Question code already exists in this tenant.");
      }
      throw error;
    }
    return inputs.length;
  }

  private async assertCategory(
    executor: Executor,
    categoryId: string | null,
    scope: QuestionBankScope,
  ): Promise<void> {
    if (categoryId === null) return;
    const [rows] = await executor.execute<RowDataPacket[]>(
      `SELECT id FROM question_categories
       WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
       LIMIT 1`,
      [categoryId, scope.tenantId],
    );
    if (!rows[0]) {
      throw new DomainError(
        "validation_error",
        "Question category is unavailable to this tenant.",
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
    const [rows] = await executor.execute<FileRow[]>(
      `SELECT file_id FROM files
       WHERE tenant_id = ? AND status = 'ready' AND deleted_at IS NULL
         AND file_id IN (${placeholders})`,
      [scope.tenantId, ...ids],
    );
    const available = new Set(rows.map((row) => row.file_id));
    const unavailable = ids.find((id) => !available.has(id));
    if (unavailable) unavailableMedia(unavailable);
  }

  private async insertMedia(
    connection: PoolConnection,
    questionId: string,
    media: QuestionMedia[],
    scope: QuestionBankScope,
    now: Date,
  ): Promise<void> {
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
}

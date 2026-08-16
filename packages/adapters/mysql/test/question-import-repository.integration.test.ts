import { ConflictError } from "@server-foundation/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createMySqlPool,
  MySqlQuestionBankRepository,
  MySqlQuestionImportRepository,
  runMigrations,
} from "../src/index.js";

const connectionString = process.env.MYSQL_TEST_URL;
if (!connectionString) {
  throw new Error("MYSQL_TEST_URL is required for the MySQL integration test.");
}

const pool = createMySqlPool(connectionString);
const imports = new MySqlQuestionImportRepository(pool);
const questions = new MySqlQuestionBankRepository(pool);
const scope = {
  tenantId: "question-import-integration-tenant",
  actorUserId: "00000000-0000-4000-8000-000000000044",
};

const input = (code: string) => ({
  code,
  categoryId: null,
  type: "true_false" as const,
  difficulty: 3,
  stem: `題目 ${code}`,
  options: null,
  answer: { value: true },
  explanation: null,
  aiRubric: null,
  points: 1,
  tags: ["import"],
  status: "enabled" as const,
  media: [],
});

const cleanup = async () => {
  await pool.execute("DELETE FROM question_files WHERE tenant_id = ?", [
    scope.tenantId,
  ]);
  await pool.execute("DELETE FROM questions WHERE tenant_id = ?", [
    scope.tenantId,
  ]);
};

const insertReadyFile = async (fileId: string, tenantId: string) => {
  await pool.execute("DELETE FROM files WHERE file_id = ?", [fileId]);
  await pool.execute(
    `INSERT INTO files
      (file_id, owner_id, tenant_id, original_name, display_name, mime_type,
       size_bytes, checksum, status, created_at, deleted_at)
     VALUES (?, ?, ?, 'import.png', 'Import', 'image/png', 1, ?, 'ready', ?, NULL)`,
    [
      fileId,
      scope.actorUserId,
      tenantId,
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      new Date(),
    ],
  );
};

const rejectedMediaMessage = async (code: string, fileId: string) => {
  try {
    await imports.createQuestions(
      [
        {
          ...input(code),
          media: [
            { fileId, role: "stem" as const, optionId: null, position: 0 },
          ],
        },
      ],
      scope,
    );
  } catch (error) {
    expect(error).toMatchObject({ code: "validation_error" });
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected import media validation to reject the file.");
};

describe("MySqlQuestionImportRepository", () => {
  beforeAll(async () => {
    await runMigrations(pool);
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("writes a valid batch in one transaction", async () => {
    await expect(
      imports.createQuestions([input("IMPORT-TX-1"), input("IMPORT-TX-2")], scope),
    ).resolves.toBe(2);
    await expect(
      imports.findExistingQuestionCodes(
        ["IMPORT-TX-1", "IMPORT-TX-2", "NOT-THERE"],
        scope,
      ),
    ).resolves.toEqual(expect.arrayContaining(["IMPORT-TX-1", "IMPORT-TX-2"]));
  });

  it("rolls the whole batch back when a later insert conflicts", async () => {
    await questions.createQuestion(input("IMPORT-EXISTING"), scope);
    await expect(
      imports.createQuestions(
        [input("IMPORT-MUST-ROLLBACK"), input("IMPORT-EXISTING")],
        scope,
      ),
    ).rejects.toBeInstanceOf(ConflictError);

    const [rows] = await pool.execute<
      Array<{ count: number } & import("mysql2/promise").RowDataPacket>
    >(
      `SELECT COUNT(*) AS count FROM questions
       WHERE tenant_id = ? AND code = ? AND deleted_at IS NULL`,
      [scope.tenantId, "IMPORT-MUST-ROLLBACK"],
    );
    expect(Number(rows[0]?.count ?? 0)).toBe(0);
  });

  it("keeps #41 missing and cross-tenant media failures indistinguishable", async () => {
    const fileId = "00000000-0000-4000-8000-000000000144";
    await pool.execute("DELETE FROM files WHERE file_id = ?", [fileId]);
    const missing = await rejectedMediaMessage("IMPORT-MISSING-FILE", fileId);
    expect(missing).toBe(
      `Question media fileId "${fileId}" does not exist.`,
    );

    await insertReadyFile(fileId, "other-import-tenant");
    const crossTenant = await rejectedMediaMessage(
      "IMPORT-CROSS-TENANT-FILE",
      fileId,
    );
    expect(crossTenant).toBe(missing);
  });
});

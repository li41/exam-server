import { ConflictError } from "@server-foundation/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createMySqlPool,
  MySqlQuestionBankRepository,
  runMigrations,
} from "../src/index.js";

const connectionString = process.env.MYSQL_TEST_URL;
if (!connectionString) {
  throw new Error("MYSQL_TEST_URL is required for the MySQL integration test.");
}

const pool = createMySqlPool(connectionString);
const repository = new MySqlQuestionBankRepository(pool);
const scope = {
  tenantId: "company-opaque-integration",
  actorUserId: "00000000-0000-4000-8000-000000000001",
};

const questionInput = (code: string, categoryId: string | null = null) => ({
  code,
  categoryId,
  type: "single_choice" as const,
  difficulty: 3,
  stem: `題目 ${code}`,
  options: [
    { id: "a", text: "A" },
    { id: "b", text: "B" },
  ],
  answer: { value: "a" },
  explanation: null,
  aiRubric: null,
  points: 1,
  tags: ["integration"],
  status: "enabled" as const,
  media: [],
});

const insertReadyFile = async (fileId: string, tenantId = scope.tenantId) => {
  await pool.execute("DELETE FROM files WHERE file_id = ?", [fileId]);
  await pool.execute(
    `INSERT INTO files
      (file_id, owner_id, tenant_id, original_name, display_name, mime_type,
       size_bytes, checksum, status, created_at, deleted_at)
     VALUES (?, ?, ?, 'stem.png', 'Stem', 'image/png', 1, ?, 'ready', ?, NULL)`,
    [
      fileId,
      scope.actorUserId,
      tenantId,
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      new Date(),
    ],
  );
};

const rejectedMediaMessage = async (
  code: string,
  fileId: string,
): Promise<string> => {
  try {
    await repository.createQuestion(
      {
        ...questionInput(code),
        media: [{ fileId, role: "stem" as const, optionId: null, position: 0 }],
      },
      scope,
    );
  } catch (error) {
    expect(error).toMatchObject({ code: "validation_error" });
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected invalid question media to be rejected.");
};

describe("MySqlQuestionBankRepository", () => {
  beforeAll(async () => {
    await runMigrations(pool);
    await pool.execute("DELETE FROM question_files");
    await pool.execute("DELETE FROM questions");
    await pool.execute("DELETE FROM question_categories");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("supports category filters, cursor pagination, versions and code reuse", async () => {
    const root = await repository.createCategory(
      { name: "數學", parentId: null, sortOrder: 1 },
      scope,
    );
    const child = await repository.createCategory(
      { name: "代數", parentId: root.id, sortOrder: 1 },
      scope,
    );
    const first = await repository.createQuestion(
      questionInput("QB-001", child.id),
      scope,
    );
    await repository.createQuestion(questionInput("QB-002", child.id), scope);

    const page = await repository.listQuestions(
      { limit: 1, categoryId: root.id },
      scope,
    );
    expect(page.items).toHaveLength(1);
    expect(page.page.nextCursor).toEqual(expect.any(String));

    const updated = await repository.updateQuestion(
      first.id,
      { stem: "新版題幹", version: first.version },
      scope,
    );
    expect(updated.version).toBe(first.version + 1);
    await expect(
      repository.updateQuestion(
        first.id,
        { stem: "過期", version: first.version },
        scope,
      ),
    ).rejects.toBeInstanceOf(ConflictError);

    await repository.softDeleteQuestion(first.id, updated.version, scope);
    await expect(
      repository.createQuestion(questionInput("QB-001", child.id), scope),
    ).resolves.toMatchObject({ code: "QB-001" });
  });

  it("links only existing ready files from the same opaque tenant", async () => {
    const fileId = "00000000-0000-4000-8000-000000000099";
    await insertReadyFile(fileId);

    const created = await repository.createQuestion(
      {
        ...questionInput("QB-MEDIA"),
        media: [{ fileId, role: "stem", optionId: null, position: 0 }],
      },
      scope,
    );
    expect(created.media).toEqual([
      {
        fileId,
        role: "stem",
        optionId: null,
        position: 0,
        available: true,
      },
    ]);
    expect(await repository.isFileReferenced(fileId, scope)).toBe(true);

    const references = await repository.listQuestions(
      { limit: 20, fileId },
      scope,
    );
    expect(references.items.map((question) => question.id)).toContain(
      created.id,
    );
  });

  it("rejects missing and cross-tenant file ids without leaking their existence", async () => {
    const fileId = "00000000-0000-4000-8000-000000000098";
    await pool.execute("DELETE FROM files WHERE file_id = ?", [fileId]);

    const missingMessage = await rejectedMediaMessage(
      "QB-MISSING-MEDIA",
      fileId,
    );
    expect(missingMessage).toBe(
      `Question media fileId "${fileId}" does not exist.`,
    );

    await insertReadyFile(fileId, "different-company-opaque");
    const crossTenantMessage = await rejectedMediaMessage(
      "QB-CROSS-TENANT-MEDIA",
      fileId,
    );
    expect(crossTenantMessage).toBe(missingMessage);
  });

  it("distinguishes no media from an orphaned media reference on reads", async () => {
    const fileId = "00000000-0000-4000-8000-000000000097";
    await insertReadyFile(fileId);
    const withMedia = await repository.createQuestion(
      {
        ...questionInput("QB-ORPHAN-MEDIA"),
        media: [{ fileId, role: "stem", optionId: null, position: 0 }],
      },
      scope,
    );
    const withoutMedia = await repository.createQuestion(
      questionInput("QB-NO-MEDIA"),
      scope,
    );

    await pool.execute(
      "UPDATE files SET status = 'deleted', deleted_at = ? WHERE file_id = ?",
      [new Date(), fileId],
    );

    const orphaned = await repository.getQuestion(withMedia.id, scope);
    const empty = await repository.getQuestion(withoutMedia.id, scope);
    expect(orphaned?.media).toEqual([
      {
        fileId,
        role: "stem",
        optionId: null,
        position: 0,
        available: false,
      },
    ]);
    expect(empty?.media).toEqual([]);
  });
});

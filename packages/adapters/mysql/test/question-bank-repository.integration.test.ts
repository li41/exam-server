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
    await pool.execute("DELETE FROM files WHERE file_id = ?", [fileId]);
    await pool.execute(
      `INSERT INTO files
        (file_id, owner_id, tenant_id, original_name, display_name, mime_type,
         size_bytes, checksum, status, created_at, deleted_at)
       VALUES (?, ?, ?, 'stem.png', 'Stem', 'image/png', 1, ?, 'ready', ?, NULL)`,
      [
        fileId,
        scope.actorUserId,
        scope.tenantId,
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        new Date(),
      ],
    );

    const created = await repository.createQuestion(
      {
        ...questionInput("QB-MEDIA"),
        media: [{ fileId, role: "stem", optionId: null, position: 0 }],
      },
      scope,
    );
    expect(created.media).toEqual([
      { fileId, role: "stem", optionId: null, position: 0 },
    ]);
    expect(await repository.isFileReferenced(fileId, scope)).toBe(true);
  });
});

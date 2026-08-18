import { DomainError } from "@server-foundation/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createMySqlPool,
  MySqlQuestionBankRepository,
  MySqlQuestionStructureRepository,
  MySqlTestBookletRepository,
  runMigrations,
} from "../src/index.js";

const connectionString = process.env.MYSQL_TEST_URL;
if (!connectionString) {
  throw new Error("MYSQL_TEST_URL is required for the MySQL integration test.");
}

const pool = createMySqlPool(connectionString);
const questions = new MySqlQuestionBankRepository(pool);
const structures = new MySqlQuestionStructureRepository(pool);
const booklets = new MySqlTestBookletRepository(pool);
const scope = {
  tenantId: "45000000-0000-4000-8000-000000000001",
  actorUserId: "45000000-0000-4000-8000-000000000002",
};
const otherScope = {
  tenantId: "45000000-0000-4000-8000-000000000099",
  actorUserId: "45000000-0000-4000-8000-000000000098",
};

const groupInput = (code: string) => ({
  code,
  name: `區塊 ${code}`,
  description: null,
  subjectId: null,
  flowMode: "normal" as const,
  status: "enabled" as const,
  items: [],
});

const cleanupTestBookletFixtures = async (): Promise<void> => {
  await pool.execute("DELETE FROM test_booklets WHERE tenant_id IN (?, ?)", [
    scope.tenantId,
    otherScope.tenantId,
  ]);
  await pool.execute("DELETE FROM question_groups WHERE tenant_id IN (?, ?)", [
    scope.tenantId,
    otherScope.tenantId,
  ]);
  await pool.execute(
    "DELETE FROM question_categories WHERE tenant_id IN (?, ?) AND parent_id IS NOT NULL",
    [scope.tenantId, otherScope.tenantId],
  );
  await pool.execute(
    "DELETE FROM question_categories WHERE tenant_id IN (?, ?) AND parent_id IS NULL",
    [scope.tenantId, otherScope.tenantId],
  );
};

describe("MySqlTestBookletRepository", () => {
  beforeAll(async () => {
    await runMigrations(pool);
    await cleanupTestBookletFixtures();
  });

  afterAll(async () => {
    await cleanupTestBookletFixtures();
    await pool.end();
  });

  it("stores ordered same-tenant groups and preserves unavailable relations after soft delete", async () => {
    const category = await questions.createCategory(
      { parentId: null, name: "BOOKLET-CATEGORY", sortOrder: 0 },
      scope,
    );
    const groupA = await structures.createGroup(groupInput("BOOK-G-A"), scope);
    const groupB = await structures.createGroup(groupInput("BOOK-G-B"), scope);

    const booklet = await booklets.createBooklet(
      {
        subjectId: "php-exam-subject-12",
        categoryId: category.id,
        code: "BOOK-INT-001",
        name: "整合測試題本",
        description: "PHP 題本只由 ordered question_groups 組成",
        status: "enabled",
        groupIds: [groupB.id, groupA.id],
      },
      scope,
    );
    expect(booklet.items).toEqual([
      { groupId: groupB.id, position: 0, available: true },
      { groupId: groupA.id, position: 1, available: true },
    ]);

    await structures.softDeleteGroup(groupB.id, groupB.version, scope);
    await expect(booklets.getBooklet(booklet.id, scope)).resolves.toMatchObject(
      {
        items: [
          { groupId: groupB.id, available: false },
          { groupId: groupA.id, available: true },
        ],
      },
    );
  });

  it("makes cross-tenant and nonexistent group references indistinguishable", async () => {
    const foreignGroup = await structures.createGroup(
      groupInput("BOOK-FOREIGN-G"),
      otherScope,
    );

    const crossTenantError = await booklets
      .createBooklet(
        {
          subjectId: null,
          categoryId: null,
          code: "BOOK-CROSS-G",
          name: "跨租戶引用",
          description: null,
          status: "enabled",
          groupIds: [foreignGroup.id],
        },
        scope,
      )
      .catch((error: unknown) => error);
    expect(crossTenantError).toBeInstanceOf(DomainError);
    expect(crossTenantError).toMatchObject({
      code: "validation_error",
      message: `Test booklet groupId "${foreignGroup.id}" does not exist.`,
    });

    await pool.execute("DELETE FROM question_groups WHERE id = ?", [
      foreignGroup.id,
    ]);

    const missingError = await booklets
      .createBooklet(
        {
          subjectId: null,
          categoryId: null,
          code: "BOOK-MISSING-G",
          name: "不存在引用",
          description: null,
          status: "enabled",
          groupIds: [foreignGroup.id],
        },
        scope,
      )
      .catch((error: unknown) => error);
    expect(missingError).toBeInstanceOf(DomainError);
    expect((missingError as DomainError).message).toBe(
      (crossTenantError as DomainError).message,
    );
  });

  it("rejects cross-tenant question categories while allowing opaque PHP subject metadata", async () => {
    const foreignCategory = await questions.createCategory(
      { parentId: null, name: "FOREIGN-BOOKLET-CAT", sortOrder: 0 },
      otherScope,
    );
    await expect(
      booklets.createBooklet(
        {
          subjectId: "exam-subject-not-yet-owned-by-server",
          categoryId: foreignCategory.id,
          code: "BOOK-CROSS-CAT",
          name: "跨租戶科目",
          description: null,
          status: "enabled",
          groupIds: [],
        },
        scope,
      ),
    ).rejects.toMatchObject({
      code: "validation_error",
      message: `Test booklet categoryId "${foreignCategory.id}" does not exist.`,
    });
  });
});
